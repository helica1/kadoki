package com.example.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * AnkiBridge — talks to AnkiDroid via its official ContentProvider API
 * (`content://com.ichi2.anki.flashcards`). Replaces the AnkiConnect-over-HTTP
 * path that depended on the unofficial AnkiConnect Android sideload (which
 * Google Play Protect periodically removes).
 *
 * Mirrors the verbs the JS layer was using against AnkiConnect:
 *   - getVersion           → echoes a fake "6" so the JS handshake passes
 *   - deckNames            → query Decks provider
 *   - modelNames           → query Models provider
 *   - modelFieldNames      → query Models provider, parse field_names CSV
 *   - addNote              → insert into Notes provider; for media, write to
 *                            the app cache + insert via Media provider
 *
 * On first call the system shows a one-time "Allow this app to access
 * AnkiDroid's data?" dialog. After that it's invisible.
 *
 * See Manatan's AnkiBridge.java for a more comprehensive reference (it
 * implements full AnkiConnect emulation including an HTTP server; we only
 * need the verbs the app actually uses).
 */
@CapacitorPlugin(name = "AnkiBridge")
public class AnkiBridgePlugin extends Plugin {

    private static final String TAG = "AnkiBridge";

    private static final String AUTHORITY     = "com.ichi2.anki.flashcards";
    private static final Uri    BASE_URI      = Uri.parse("content://" + AUTHORITY);
    private static final Uri    NOTES_URI     = Uri.withAppendedPath(BASE_URI, "notes");
    private static final Uri    MODELS_URI    = Uri.withAppendedPath(BASE_URI, "models");
    private static final Uri    DECKS_URI     = Uri.withAppendedPath(BASE_URI, "decks");
    private static final Uri    MEDIA_URI     = Uri.withAppendedPath(BASE_URI, "media");

    // AnkiDroid uses 0x1F as the field separator on the wire.
    private static final String FIELD_SEPARATOR = "\u001f";

    // ---- isAvailable --------------------------------------------------------

    /** Returns whether AnkiDroid is installed and its provider responds. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Cursor c = getContext().getContentResolver().query(DECKS_URI,
                    null, null, null, null);
            if (c != null) {
                c.close();
                ret.put("available", true);
            } else {
                ret.put("available", false);
            }
        } catch (SecurityException se) {
            // Permission not granted yet — provider exists but locked.
            ret.put("available", true);
            ret.put("needsPermission", true);
        } catch (Exception e) {
            ret.put("available", false);
            ret.put("error", e.getMessage());
        }
        call.resolve(ret);
    }

    // ---- deckNames ----------------------------------------------------------

    @PluginMethod
    public void deckNames(PluginCall call) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            Cursor c = cr.query(DECKS_URI, null, null, null, null);
            if (c == null) { call.reject("Deck query returned null"); return; }
            JSArray arr = new JSArray();
            int nameCol = c.getColumnIndex("deck_name");
            while (c.moveToNext()) {
                if (nameCol >= 0) arr.put(c.getString(nameCol));
            }
            c.close();
            JSObject ret = new JSObject();
            ret.put("decks", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("deckNames failed: " + e.getMessage());
        }
    }

    // ---- modelNames ---------------------------------------------------------

    @PluginMethod
    public void modelNames(PluginCall call) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            Cursor c = cr.query(MODELS_URI, null, null, null, null);
            if (c == null) { call.reject("Model query returned null"); return; }
            JSArray arr = new JSArray();
            int nameCol = c.getColumnIndex("name");
            while (c.moveToNext()) {
                if (nameCol >= 0) arr.put(c.getString(nameCol));
            }
            c.close();
            JSObject ret = new JSObject();
            ret.put("models", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("modelNames failed: " + e.getMessage());
        }
    }

    // ---- modelFieldNames ----------------------------------------------------

    @PluginMethod
    public void modelFieldNames(PluginCall call) {
        String modelName = call.getString("modelName");
        if (modelName == null) { call.reject("modelName required"); return; }
        try {
            ContentResolver cr = getContext().getContentResolver();
            Cursor c = cr.query(MODELS_URI, null, null, null, null);
            if (c == null) { call.reject("Model query returned null"); return; }
            int nameCol   = c.getColumnIndex("name");
            int fieldsCol = c.getColumnIndex("field_names");
            JSArray arr = new JSArray();
            while (c.moveToNext()) {
                if (nameCol >= 0 && fieldsCol >= 0 &&
                    modelName.equals(c.getString(nameCol))) {
                    String csv = c.getString(fieldsCol);
                    if (csv != null) {
                        for (String f : csv.split(FIELD_SEPARATOR)) {
                            arr.put(f);
                        }
                    }
                    break;
                }
            }
            c.close();
            JSObject ret = new JSObject();
            ret.put("fields", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("modelFieldNames failed: " + e.getMessage());
        }
    }

    // ---- addNote ------------------------------------------------------------

    /**
     * Insert a new note. Expected JS shape:
     *   {
     *     deckName: "...",
     *     modelName: "...",
     *     fields: { "Term": "...", "Image": "", "Sentence Audio": "" },
     *     tags: ["android"],
     *     audio: { filename: "...", dataBase64: "...", field: "Sentence Audio" } | null,
     *     picture: { filename: "...", dataBase64: "...", field: "Image" } | null
     *   }
     */
    @PluginMethod
    public void addNote(PluginCall call) {
        String deckName  = call.getString("deckName");
        String modelName = call.getString("modelName");
        JSObject fields  = call.getObject("fields", new JSObject());
        JSArray tags     = call.getArray("tags", new JSArray());
        JSObject audio   = call.getObject("audio");      // may be null
        JSObject picture = call.getObject("picture");    // may be null

        if (deckName == null || modelName == null) {
            call.reject("deckName and modelName required");
            return;
        }
        try {
            // Resolve deck + model IDs by name.
            long deckId  = lookupDeckId(deckName);
            long modelId = lookupModelId(modelName);
            if (deckId < 0)  { call.reject("Deck not found: " + deckName);   return; }
            if (modelId < 0) { call.reject("Model not found: " + modelName); return; }

            // Field ordering: the provider's `flds` column is a 0x1F-separated
            // string of values in MODEL ORDER. We need to look up the model's
            // field list to map { name → index }.
            String[] fieldOrder = lookupModelFieldOrder(modelName);
            if (fieldOrder == null || fieldOrder.length == 0) {
                call.reject("Could not determine field order for model " + modelName);
                return;
            }

            // First write any media files to AnkiDroid's collection.media via
            // the Media provider. AnkiDroid returns the final filename it
            // chose (collision-resolved); we substitute [sound:...] / <img>
            // references into the matching field.
            String audioRef   = null;
            String pictureRef = null;
            if (audio != null && audio.has("dataBase64")) {
                audioRef = storeMediaBase64(audio.getString("filename"),
                                            audio.getString("dataBase64"));
            }
            if (picture != null && picture.has("dataBase64")) {
                pictureRef = storeMediaBase64(picture.getString("filename"),
                                              picture.getString("dataBase64"));
            }

            // Build the 0x1F-joined fields string in MODEL order.
            StringBuilder flds = new StringBuilder();
            for (int i = 0; i < fieldOrder.length; i++) {
                if (i > 0) flds.append(FIELD_SEPARATOR);
                String fieldName = fieldOrder[i];
                String value = fields.has(fieldName) ? fields.getString(fieldName) : "";

                // Append media refs to the user-targeted field.
                if (audioRef != null && audio != null && fieldName.equals(audio.getString("field"))) {
                    if (value == null) value = "";
                    if (!value.isEmpty()) value += " ";
                    value += "[sound:" + audioRef + "]";
                }
                if (pictureRef != null && picture != null && fieldName.equals(picture.getString("field"))) {
                    if (value == null) value = "";
                    if (!value.isEmpty()) value += " ";
                    value += "<img src=\"" + pictureRef + "\">";
                }
                flds.append(value == null ? "" : value);
            }

            // Build tags string (space-separated per AnkiDroid spec).
            StringBuilder tagsBuf = new StringBuilder();
            for (int i = 0; i < tags.length(); i++) {
                if (i > 0) tagsBuf.append(" ");
                tagsBuf.append(tags.getString(i));
            }

            ContentValues values = new ContentValues();
            values.put("mid", modelId);
            values.put("flds", flds.toString());
            values.put("tags", tagsBuf.toString());
            values.put("deck_id", deckId);

            Uri inserted = getContext().getContentResolver().insert(NOTES_URI, values);
            if (inserted == null) {
                call.reject("addNote: insert returned null (duplicate or permission denied?)");
                return;
            }
            long noteId = -1;
            try { noteId = Long.parseLong(inserted.getLastPathSegment()); } catch (Exception ignored) {}

            JSObject ret = new JSObject();
            ret.put("noteId", noteId);
            if (audioRef   != null) ret.put("audioFilename",   audioRef);
            if (pictureRef != null) ret.put("pictureFilename", pictureRef);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "addNote failed", e);
            call.reject("addNote failed: " + e.getMessage());
        }
    }

    // ---- helpers ------------------------------------------------------------

    private long lookupDeckId(String deckName) {
        try {
            Cursor c = getContext().getContentResolver().query(DECKS_URI,
                    null, null, null, null);
            if (c == null) return -1;
            int idCol   = c.getColumnIndex("deck_id");
            int nameCol = c.getColumnIndex("deck_name");
            while (c.moveToNext()) {
                if (nameCol >= 0 && idCol >= 0 &&
                    deckName.equals(c.getString(nameCol))) {
                    long id = c.getLong(idCol);
                    c.close();
                    return id;
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupDeckId: " + e.getMessage()); }
        return -1;
    }

    private long lookupModelId(String modelName) {
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI,
                    null, null, null, null);
            if (c == null) return -1;
            int idCol   = c.getColumnIndex("_id");
            int nameCol = c.getColumnIndex("name");
            while (c.moveToNext()) {
                if (nameCol >= 0 && idCol >= 0 &&
                    modelName.equals(c.getString(nameCol))) {
                    long id = c.getLong(idCol);
                    c.close();
                    return id;
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupModelId: " + e.getMessage()); }
        return -1;
    }

    private String[] lookupModelFieldOrder(String modelName) {
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI,
                    null, null, null, null);
            if (c == null) return null;
            int nameCol   = c.getColumnIndex("name");
            int fieldsCol = c.getColumnIndex("field_names");
            while (c.moveToNext()) {
                if (nameCol >= 0 && fieldsCol >= 0 &&
                    modelName.equals(c.getString(nameCol))) {
                    String csv = c.getString(fieldsCol);
                    c.close();
                    if (csv == null) return new String[0];
                    return csv.split(FIELD_SEPARATOR);
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupModelFieldOrder: " + e.getMessage()); }
        return null;
    }

    /**
     * Write base64 audio/image bytes through the Media provider. AnkiDroid
     * copies the file into its collection.media and returns the (possibly
     * disambiguated) final filename. We embed that name in the note field
     * as [sound:foo.mp3] or <img src="foo.jpg">.
     */
    private String storeMediaBase64(String suggestedName, String base64) throws Exception {
        // Decode bytes.
        byte[] data = Base64.decode(base64, Base64.DEFAULT);
        // Write to a temp file in our cache dir so we have a URI to hand to
        // AnkiDroid's Media provider.
        java.io.File cacheDir = getContext().getCacheDir();
        java.io.File tmp = new java.io.File(cacheDir,
                "anki_outbound_" + System.currentTimeMillis() + "_" +
                (suggestedName == null ? "media" : suggestedName));
        FileOutputStream fos = new FileOutputStream(tmp);
        fos.write(data);
        fos.close();

        Uri fileUri = Uri.fromFile(tmp);
        ContentValues v = new ContentValues();
        v.put("file_uri", fileUri.toString());
        if (suggestedName != null) v.put("preferred_name", suggestedName);

        Uri result = getContext().getContentResolver().insert(MEDIA_URI, v);
        if (result == null) {
            tmp.delete();
            throw new Exception("Media insert returned null");
        }
        String finalName = result.getLastPathSegment();
        // Best-effort cleanup; the file was already copied into the
        // AnkiDroid collection.media folder.
        tmp.delete();
        return finalName;
    }
}
