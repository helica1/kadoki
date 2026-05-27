package com.example.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

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
                    String field    = a.getString("field");
                    if (b64 == null || field == null) continue;
                    String stored = storeMediaBase64(filename, b64);
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
                    String field    = p.getString("field");
                    if (b64 == null || field == null) continue;
                    String stored = storeMediaBase64(filename, b64);
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

            ContentValues values = new ContentValues();
            values.put("mid", modelId);
            values.put("flds", flds.toString());
            values.put("tags", tagsBuf.toString());
            values.put("deck_id", deckId);

            Uri inserted = getContext().getContentResolver().insert(NOTES_URI, values);
            if (inserted == null) {
                call.reject("addNote: insert returned null (duplicate or denied)");
                return;
            }
            long noteId = -1;
            try { noteId = Long.parseLong(inserted.getLastPathSegment()); } catch (Exception ignored) {}

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

    private String storeMediaBase64(String suggestedName, String base64) throws Exception {
        byte[] data = Base64.decode(base64, Base64.DEFAULT);
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
        tmp.delete();
        return finalName;
    }
}
