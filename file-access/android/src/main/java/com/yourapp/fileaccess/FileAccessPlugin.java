package com.yourapp.fileaccess;

import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.List;

@CapacitorPlugin(name = "FileAccess")
public class FileAccessPlugin extends Plugin {

    @PluginMethod
    public void takePersistableUriPermission(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("URI is required");
            return;
        }

        try {
            Uri uri = Uri.parse(uriString);
            getContext().getContentResolver().takePersistableUriPermission(
                uri, 
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to take persistent permission: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getPersistedUriPermissions(PluginCall call) {
        try {
            List<UriPermission> permissions = getContext().getContentResolver().getPersistedUriPermissions();
            JSArray uriArray = new JSArray();
            
            for (UriPermission permission : permissions) {
                if (permission.isReadPermission()) {
                    uriArray.put(permission.getUri().toString());
                }
            }
            
            JSObject result = new JSObject();
            result.put("uris", uriArray);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to get persisted permissions: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readFileFromUri(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("URI is required");
            return;
        }

        try {
            Uri uri = Uri.parse(uriString);
            InputStream inputStream = getContext().getContentResolver().openInputStream(uri);
            
            if (inputStream == null) {
                call.reject("Could not open input stream");
                return;
            }

            // Read file to byte array
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] data = new byte[1024];
            int nRead;
            while ((nRead = inputStream.read(data, 0, data.length)) != -1) {
                buffer.write(data, 0, nRead);
            }
            inputStream.close();

            // Convert to base64
            String base64Data = Base64.encodeToString(buffer.toByteArray(), Base64.DEFAULT);
            
            // Get filename
            String fileName = getFileName(uri);
            
            JSObject result = new JSObject();
            result.put("data", base64Data);
            result.put("name", fileName);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to read file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void checkUriPermission(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("URI is required");
            return;
        }

        try {
            Uri uri = Uri.parse(uriString);
            int permission = getContext().checkUriPermission(
                uri, 
                android.os.Process.myPid(), 
                android.os.Process.myUid(), 
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            
            JSObject result = new JSObject();
            result.put("hasPermission", permission == android.content.pm.PackageManager.PERMISSION_GRANTED);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to check permission: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pickFileWithUri(PluginCall call) {
        // Optional kind: "epub" (deck/EPUB defaults), "audio" (audiobooks/MP3s),
        // "any" (no filter). Accept BOTH "kind" (Android convention) and "type"
        // (iOS convention, which several JS callers — e.g. the audio-archive
        // importer — pass). Without the "type" fallback, {type:'any'} fell
        // through to the "epub" MIME filter here and .tar/.tar.xz archives were
        // grayed out in the picker. Defaults to "epub" for backwards compat.
        String kind = call.getString("kind");
        if (kind == null) kind = call.getString("type", "epub");

        // Always use ACTION_OPEN_DOCUMENT with setType("*/*") + EXTRA_MIME_TYPES
        // for filtering. This pattern keeps folder navigation visible in
        // Internal Storage; using setType("audio/*") directly was causing some
        // Android 14+ DocumentsUI versions to show a blank file browser.
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        String[] mimeTypes;
        if ("audio".equals(kind)) {
            mimeTypes = new String[] { "audio/*" };
        } else if ("any".equals(kind)) {
            mimeTypes = null;
        } else {
            // epub / deck default
            mimeTypes = new String[] {
                "application/zip",
                "application/octet-stream",
                "application/x-anki-deck",
                "application/vnd.anki",
                "application/epub+zip"
            };
        }
        if (mimeTypes != null) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // PERSISTABLE is needed for EPUB (reading mode reopens across sessions);
        // for audio it's harmless to request (granted only if provider supports).
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        startActivityForResult(call, intent, "filePickerResult");
    }

    @PluginMethod
    public void materializeToCache(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("URI is required");
            return;
        }

        try {
            Uri uri = Uri.parse(uriString);

            File cacheDir = new File(getContext().getCacheDir(), "decks");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            String cacheFileName = "deck_" + Integer.toHexString(uriString.hashCode()) + ".apkg";
            File cacheFile = new File(cacheDir, cacheFileName);

            long sourceSize = -1;
            Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null);
            if (cursor != null) {
                try {
                    if (cursor.moveToFirst()) {
                        int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (sizeIndex >= 0) {
                            sourceSize = cursor.getLong(sizeIndex);
                        }
                    }
                } finally {
                    cursor.close();
                }
            }

            if (cacheFile.exists() && sourceSize > 0 && cacheFile.length() == sourceSize) {
                JSObject result = new JSObject();
                result.put("path", cacheFile.getAbsolutePath());
                result.put("size", cacheFile.length());
                result.put("cached", true);
                call.resolve(result);
                return;
            }

            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) {
                call.reject("Could not open input stream");
                return;
            }
            FileOutputStream out = new FileOutputStream(cacheFile);
            try {
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    out.write(buffer, 0, n);
                }
                out.flush();
            } finally {
                try { in.close(); } catch (Exception ignored) {}
                try { out.close(); } catch (Exception ignored) {}
            }

            JSObject result = new JSObject();
            result.put("path", cacheFile.getAbsolutePath());
            result.put("size", cacheFile.length());
            result.put("cached", false);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to materialize: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void filePickerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() == android.app.Activity.RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) {
                // Try to upgrade to persistable permission — works for
                // ACTION_OPEN_DOCUMENT URIs, fails (SecurityException) for
                // ACTION_GET_CONTENT URIs. The latter are still valid for an
                // immediate read in this same flow, so don't fail the call.
                try {
                    getContext().getContentResolver().takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                } catch (Exception persistEx) {
                    // expected for content:// URIs from ACTION_GET_CONTENT
                }

                try {
                    String fileName = getFileName(uri);
                    JSObject ret = new JSObject();
                    ret.put("uri", uri.toString());
                    ret.put("name", fileName);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Failed to process selected file: " + e.getMessage());
                }
            } else {
                call.reject("No file selected");
            }
        } else {
            call.reject("File selection cancelled");
        }
    }

    private String getFileName(Uri uri) {
        String fileName = "unknown";
        Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null);
        if (cursor != null && cursor.moveToFirst()) {
            int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            if (nameIndex >= 0) {
                fileName = cursor.getString(nameIndex);
            }
            cursor.close();
        }
        return fileName;
    }
}