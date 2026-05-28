package com.example.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.FileOutputStream;

/**
 * AnkiBridge — talks to AnkiDroid via its official ContentProvider API
 * (`content://com.ichi2.anki.flashcards`). Replaces the AnkiConnect-over-HTTP
 * path that depended on the unofficial AnkiConnect Android sideload (which
 * Google Play Protect periodically removes).
 *
 * Runtime permission flow:
 *   - The permission "com.ichi2.anki.permission.READ_WRITE_DATABASE" is a
 *     dangerous permission declared by AnkiDroid itself. Declaring it in
 *     OUR manifest is necessary but NOT sufficient — Android requires an
 *     explicit runtime request, otherwise queries throw SecurityException.
 *   - JS calls `requestPermission()` first; this method triggers Capacitor's
 *     standard requestPermissionForAlias flow which surfaces the system
 *     dialog. After grant, all subsequent provider calls succeed silently.
 *
 * addNote accepts an array of audio attachments so both sentence audio and
 * term audio land on the same note in one insert.
 */
@CapacitorPlugin(
    name = "AnkiBridge",
    permissions = {
        @Permission(
            alias = "ankidroid",
            strings = { "com.ichi2.anki.permission.READ_WRITE_DATABASE" }
        )
    }
)
public class AnkiBridgePlugin extends Plugin {

    private static final String TAG = "AnkiBridge";
    private static final String ANKI_PERM = "com.ichi2.anki.permission.READ_WRITE_DATABASE";

    private static final String AUTHORITY = "com.ichi2.anki.flashcards";
    private static final Uri    BASE_URI  = Uri.parse("content://" + AUTHORITY);
    private static final Uri    NOTES_URI = Uri.withAppendedPath(BASE_URI, "notes");
    private static final Uri    MODELS_URI = Uri.withAppendedPath(BASE_URI, "models");
    private static final Uri    DECKS_URI  = Uri.withAppendedPath(BASE_URI, "decks");
    private static final Uri    MEDIA_URI  = Uri.withAppendedPath(BASE_URI, "media");

    // AnkiDroid uses 0x1F (Information Separator One) on the wire.
    private static final String FIELD_SEPARATOR = "\u001f";

    // ---- permission --------------------------------------------------------

    private boolean hasAnkiPermission() {
        return getContext().checkSelfPermission(ANKI_PERM) ==
                PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Explicit permission request. JS should call this once on startup (or
     * before the first addNote). Surfaces the system "Allow this app to
     * access AnkiDroid's data?" dialog.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (hasAnkiPermission()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("ankidroid", call, "ankiPermCallback");
    }

    @PermissionCallback
    private void ankiPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = getPermissionState("ankidroid") == PermissionState.GRANTED;
        ret.put("granted", granted);
        if (!granted) ret.put("reason", "Permission denied");
        call.resolve(ret);
    }

    // ---- isAvailable -------------------------------------------------------

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        if (!hasAnkiPermission()) {
            ret.put("available", true);
            ret.put("needsPermission", true);
            call.resolve(ret);
            return;
        }
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
            ret.put("available", true);
            ret.put("needsPermission", true);
        } catch (Exception e) {
            ret.put("available", false);
            ret.put("error", e.getMessage());
        }
        call.resolve(ret);
    }

    // ---- deckNames ---------------------------------------------------------

    @PluginMethod
    public void deckNames(PluginCall call) {
        if (!hasAnkiPermission()) {
            call.reject("AnkiDroid permission not granted. Call requestPermission() first.");
            return;
        }
        try {
            Cursor c = getContext().getContentResolver().query(DECKS_URI, null, null, null, null);
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

    // ---- modelNames --------------------------------------------------------

    @PluginMethod
    public void modelNames(PluginCall call) {
        if (!hasAnkiPermission()) {
            call.reject("AnkiDroid permission not granted. Call requestPermission() first.");
            return;
        }
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI, null, null, null, null);
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

    // ---- modelFieldNames ---------------------------------------------------

    @PluginMethod
    public void modelFieldNames(PluginCall call) {
        if (!hasAnkiPermission()) {
            call.reject("AnkiDroid permission not granted. Call requestPermission() first.");
            return;
        }
        String modelName = call.getString("modelName");
        if (modelName == null) { call.reject("modelName required"); return; }
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI, null, null, null, null);
            if (c == null) { call.reject("Model query returned null"); return; }
            int nameCol   = c.getColumnIndex("name");
            int fieldsCol = c.getColumnIndex("field_names");
            JSArray arr = new JSArray();
            while (c.moveToNext()) {
                if (nameCol >= 0 && fieldsCol >= 0 &&
                    modelName.equals(c.getString(nameCol))) {
                    String csv = c.getString(fieldsCol);
                    if (csv != null) {
                        for (String f : csv.split(FIELD_SEPARATOR)) arr.put(f);
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

    // ---- addNote -----------------------------------------------------------

    /**
     * Insert a note. Accepts an array of audio attachments so sentence-audio
     * + term-audio can land on the same note in a single insert.
     *
     * JS shape:
     *   {
     *     deckName: "...",
     *     modelName: "...",
     *     fields: { "Term": "...", "Image": "", "Sentence Audio": "" },
     *     tags: ["..."],
     *     audio:   [{ filename, dataBase64, field }, ...] | null,
     *     picture: [{ filename, dataBase64, field }, ...] | null
     *   }
     */
    @PluginMethod
    public void addNote(PluginCall call) {
        if (!hasAnkiPermission()) {
            call.reject("AnkiDroid permission not granted. Call requestPermission() first.");
            return;
        }
        String deckName  = call.getString("deckName");
        String modelName = call.getString("modelName");
        JSObject fields  = call.getObject("fields", new JSObject());
        JSArray tags     = call.getArray("tags", new JSArray());

        // Accept either an array OR a single object for backward compatibility.
        JSArray audioArr   = call.getArray("audio");
        JSArray pictureArr = call.getArray("picture");
        if (audioArr == null) {
            JSObject single = call.getObject("audio");
            if (single != null) {
                audioArr = new JSArray();
                audioArr.put(single);
            }
        }
        if (pictureArr == null) {
            JSObject single = call.getObject("picture");
            if (single != null) {
                pictureArr = new JSArray();
                pictureArr.put(single);
            }
        }

        if (deckName == null || modelName == null) {
            call.reject("deckName and modelName required");
            return;
        }
        try {
            long deckId  = lookupDeckId(deckName);
            long modelId = lookupModelId(modelName);
            if (deckId < 0)  { call.reject("Deck not found: " + deckName);   return; }
            if (modelId < 0) { call.reject("Model not found: " + modelName); return; }

            String[] fieldOrder = lookupModelFieldOrder(modelName);
            if (fieldOrder == null || fieldOrder.length == 0) {
                call.reject("Could not determine field order for model " + modelName);
                return;
            }

            // Store each media attachment via the Media provider and remember
            // (field name -> reference token) so we can splice into flds.
            java.util.Map<String, StringBuilder> fieldAppends = new java.util.HashMap<>();
            JSArray audioResultNames = new JSArray();
            JSArray pictureResultNames = new JSArray();

            if (audioArr != null) {
                for (int i = 0; i < audioArr.length(); i++) {
                    JSObject a = JSObject.fromJSONObject(audioArr.getJSONObject(i));
                    String filename = a.getString("filename");
                    String b64      = a.getString("dataBase64");
                    String srcPath  = a.getString("srcPath");
                    String field    = a.getString("field");
                    if (field == null) continue;
                    byte[] bytes = mediaBytes(b64, srcPath);
                    if (bytes == null) continue;
                    String stored = storeMediaBytes(filename, bytes);
                    audioResultNames.put(stored);
                    String token = "[sound:" + stored + "]";
                    fieldAppends.computeIfAbsent(field, k -> new StringBuilder())
                                .append(fieldAppends.get(field).length() > 0 ? " " : "")
                                .append(token);
                }
            }
            if (pictureArr != null) {
                for (int i = 0; i < pictureArr.length(); i++) {
                    JSObject p = JSObject.fromJSONObject(pictureArr.getJSONObject(i));
                    String filename = p.getString("filename");
                    String b64      = p.getString("dataBase64");
                    String srcPath  = p.getString("srcPath");
                    String field    = p.getString("field");
                    if (field == null) continue;
                    byte[] bytes = mediaBytes(b64, srcPath);
                    if (bytes == null) continue;
                    String stored = storeMediaBytes(filename, bytes);
                    pictureResultNames.put(stored);
                    String token = "<img src=\"" + stored + "\">";
                    fieldAppends.computeIfAbsent(field, k -> new StringBuilder())
                                .append(fieldAppends.get(field).length() > 0 ? " " : "")
                                .append(token);
                }
            }

            // Build the 0x1F-joined fields string in MODEL order.
            StringBuilder flds = new StringBuilder();
            for (int i = 0; i < fieldOrder.length; i++) {
                if (i > 0) flds.append(FIELD_SEPARATOR);
                String fieldName = fieldOrder[i];
                String value = fields.has(fieldName) ? fields.getString(fieldName) : "";
                if (value == null) value = "";

                StringBuilder appendTok = fieldAppends.get(fieldName);
                if (appendTok != null && appendTok.length() > 0) {
                    if (!value.isEmpty()) value += " ";
                    value += appendTok.toString();
                }
                flds.append(value);
            }

            StringBuilder tagsBuf = new StringBuilder();
            for (int i = 0; i < tags.length(); i++) {
                if (i > 0) tagsBuf.append(" ");
                tagsBuf.append(tags.getString(i));
            }

            // Notes table has no deck_id column — adding it makes AnkiDroid
            // silently reject the insert. The note lands in the default deck;
            // we move its cards to the target deck below via the dedicated
            // notes/{id}/cards endpoint (same pattern Manatan uses).
            ContentValues values = new ContentValues();
            values.put("mid", modelId);
            values.put("flds", flds.toString());
            values.put("tags", tagsBuf.toString());

            Uri inserted = getContext().getContentResolver().insert(NOTES_URI, values);
            if (inserted == null) {
                call.reject("addNote: insert returned null (duplicate or denied)");
                return;
            }
            long noteId = -1;
            try { noteId = Long.parseLong(inserted.getLastPathSegment()); } catch (Exception ignored) {}

            // Move every card of this note into the target deck.
            if (noteId > 0 && deckId > 0) {
                moveCardsToDeck(noteId, deckId);
            }

            JSObject ret = new JSObject();
            ret.put("noteId", noteId);
            ret.put("audioFilenames", audioResultNames);
            ret.put("pictureFilenames", pictureResultNames);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "addNote failed", e);
            call.reject("addNote failed: " + e.getMessage());
        }
    }

    // ---- helpers -----------------------------------------------------------

    private long lookupDeckId(String deckName) {
        try {
            Cursor c = getContext().getContentResolver().query(DECKS_URI, null, null, null, null);
            if (c == null) return -1;
            int idCol = c.getColumnIndex("deck_id");
            int nameCol = c.getColumnIndex("deck_name");
            while (c.moveToNext()) {
                if (nameCol >= 0 && idCol >= 0 && deckName.equals(c.getString(nameCol))) {
                    long id = c.getLong(idCol); c.close(); return id;
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupDeckId: " + e.getMessage()); }
        return -1;
    }

    private long lookupModelId(String modelName) {
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI, null, null, null, null);
            if (c == null) return -1;
            int idCol = c.getColumnIndex("_id");
            int nameCol = c.getColumnIndex("name");
            while (c.moveToNext()) {
                if (nameCol >= 0 && idCol >= 0 && modelName.equals(c.getString(nameCol))) {
                    long id = c.getLong(idCol); c.close(); return id;
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupModelId: " + e.getMessage()); }
        return -1;
    }

    private String[] lookupModelFieldOrder(String modelName) {
        try {
            Cursor c = getContext().getContentResolver().query(MODELS_URI, null, null, null, null);
            if (c == null) return null;
            int nameCol = c.getColumnIndex("name");
            int fieldsCol = c.getColumnIndex("field_names");
            while (c.moveToNext()) {
                if (nameCol >= 0 && fieldsCol >= 0 && modelName.equals(c.getString(nameCol))) {
                    String csv = c.getString(fieldsCol); c.close();
                    if (csv == null) return new String[0];
                    return csv.split(FIELD_SEPARATOR);
                }
            }
            c.close();
        } catch (Exception e) { Log.w(TAG, "lookupModelFieldOrder: " + e.getMessage()); }
        return null;
    }

    /**
     * Move every card of `noteId` into `deckId`. AnkiDroid's notes provider
     * doesn't accept a deck_id at insert time; you have to set it per card
     * after the fact via notes/{noteId}/cards. Same flow Manatan uses.
     */
    private void moveCardsToDeck(long noteId, long deckId) {
        Uri cardsUri = Uri.withAppendedPath(NOTES_URI, noteId + "/cards");
        try (Cursor c = getContext().getContentResolver().query(cardsUri,
                new String[]{"ord", "deck_id"}, null, null, null)) {
            if (c == null) {
                Log.w(TAG, "moveCardsToDeck: cards cursor null for note " + noteId);
                return;
            }
            while (c.moveToNext()) {
                int ord = c.getInt(0);
                long currentDeckId = c.getLong(1);
                if (currentDeckId != deckId) {
                    Uri cardUri = Uri.withAppendedPath(cardsUri, String.valueOf(ord));
                    ContentValues v = new ContentValues();
                    v.put("deck_id", deckId);
                    int rows = getContext().getContentResolver()
                                           .update(cardUri, v, null, null);
                    Log.d(TAG, "moveCardsToDeck: card ord=" + ord + " -> deck "
                            + deckId + " (rows=" + rows + ")");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "moveCardsToDeck failed: " + e.getMessage(), e);
        }
    }

    /**
     * Write base64 bytes through the Media provider. Two important details
     * (learned from the first attempt failing silently):
     *   1) AnkiDroid can't read `file://` URIs from another app's cache dir
     *      on modern Android due to FILE_URI exposure restrictions. We must
     *      go through a content:// URI (FileProvider).
     *   2) The FileProvider URI must also be explicitly granted to
     *      com.ichi2.anki via grantUriPermission, otherwise the insert
     *      will fail with a permission denial when AnkiDroid tries to read
     *      the bytes.
     */
    /**
     * Resolve the media bytes from either a base64 string OR an on-disk path.
     * The JS side prefers `srcPath` on iOS (skips a base64 round-trip through
     * WKWebView that was returning empty data URIs for tmp/ files). Android's
     * cacheFileToDataUri works fine so the JS still sends dataBase64 here,
     * but we accept srcPath too for forward-compat + symmetry with iOS.
     */
    private byte[] mediaBytes(String base64, String srcPath) {
        try {
            if (base64 != null && !base64.isEmpty()) {
                return Base64.decode(base64, Base64.DEFAULT);
            }
            if (srcPath != null && !srcPath.isEmpty()) {
                java.io.File src = new java.io.File(srcPath);
                if (!src.exists() || !src.canRead()) return null;
                java.io.FileInputStream in = new java.io.FileInputStream(src);
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
                return out.toByteArray();
            }
        } catch (Exception e) {
            Log.e(TAG, "mediaBytes failed: " + e.getMessage(), e);
        }
        return null;
    }

    /// Write raw bytes through the Media provider. Shared by base64 and
    /// srcPath paths so we don't duplicate the FileProvider + permission
    /// dance.
    private String storeMediaBytes(String suggestedName, byte[] data) throws Exception {
        java.io.File cacheDir = getContext().getCacheDir();
        String safeSuggested = (suggestedName == null) ? "media" : suggestedName;
        java.io.File tmp = new java.io.File(cacheDir,
                "anki_outbound_" + System.currentTimeMillis() + "_" + safeSuggested);
        FileOutputStream fos = new FileOutputStream(tmp);
        fos.write(data);
        fos.close();

        Uri shareUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                tmp);
        getContext().grantUriPermission("com.ichi2.anki",
                shareUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION);

        ContentValues v = new ContentValues();
        v.put("file_uri", shareUri.toString());
        if (suggestedName != null) {
            String bare = suggestedName.replaceAll("\\.[^.]*$", "");
            v.put("preferred_name", bare);
        }

        Uri result = getContext().getContentResolver().insert(MEDIA_URI, v);
        if (result == null) {
            tmp.delete();
            throw new Exception("Media insert returned null — does the field exist in your model?");
        }
        String last = result.getLastPathSegment();
        tmp.delete();
        return last;
    }

    private String storeMediaBase64(String suggestedName, String base64) throws Exception {
        byte[] data = Base64.decode(base64, Base64.DEFAULT);
        java.io.File cacheDir = getContext().getCacheDir();
        String safeSuggested = (suggestedName == null) ? "media" : suggestedName;
        java.io.File tmp = new java.io.File(cacheDir,
                "anki_outbound_" + System.currentTimeMillis() + "_" + safeSuggested);
        FileOutputStream fos = new FileOutputStream(tmp);
        fos.write(data);
        fos.close();

        Uri shareUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                tmp);
        getContext().grantUriPermission("com.ichi2.anki",
                shareUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION);

        ContentValues v = new ContentValues();
        v.put("file_uri", shareUri.toString());
        // AnkiDroid strips the extension internally then re-applies one based
        // on MIME type. Pass the bare name so the suffix isn't duplicated.
        if (suggestedName != null) {
            String bare = suggestedName.replaceAll("\\.[^.]*$", "");
            v.put("preferred_name", bare);
        }

        Uri result = getContext().getContentResolver().insert(MEDIA_URI, v);
        if (result == null) {
            tmp.delete();
            throw new Exception("Media insert returned null — does the field exist in your model?");
        }
        // The provider returns content://...media/<finalName>. Take just the
        // last segment as the filename for the [sound:...] / <img src=...>
        // token in the note's flds.
        String finalName = new java.io.File(result.getPath()).getName();
        tmp.delete();
        return finalName;
    }
}
