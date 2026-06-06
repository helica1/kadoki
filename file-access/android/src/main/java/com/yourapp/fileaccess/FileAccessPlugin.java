package com.yourapp.fileaccess;

import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
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
                "application/epub+zip",
                "text/plain"   // .txt plain-text books
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

    // Media extensions we surface from a folder scan. Lowercase, no dot.
    private static final String[] MEDIA_EXTS = {
        "epub", "txt",
        "mp3", "m4a", "m4b", "ogg", "oga", "opus", "wav", "flac", "aac",
        "srt", "vtt", "ass"
    };
    private static final int MAX_TREE_DEPTH = 12;

    // Let the user pick a whole folder (ACTION_OPEN_DOCUMENT_TREE). We take a
    // persistable grant on the TREE — every child document URI we return below
    // is then readable (and materializeToCache-able) across sessions off that
    // single grant. Returns { rootUri, rootName, files:[{uri,name,dir,relPath,ext}] }.
    @PluginMethod
    public void pickFolderTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPickerResult");
    }

    @ActivityCallback
    private void folderPickerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        Uri treeUri = (data != null) ? data.getData() : null;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || treeUri == null) {
            // Match the iOS contract: resolve with {cancelled:true} rather than
            // rejecting, so a user backing out isn't surfaced as an error.
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        // Persist the tree grant so the child URIs survive app restarts.
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception persistEx) {
            // best-effort; children are still readable for this session
        }

        final String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        if (rootDocId == null) {
            call.reject("Could not read the selected folder (no tree document id)");
            return;
        }
        // A large/deep tree means many ContentResolver queries; run off the
        // main thread so a big library can't ANR the picker callback. JSON
        // result + notifyListeners are safe to deliver from a worker thread.
        new Thread(() -> {
            try {
                JSArray files = new JSArray();
                int[] counter = new int[]{0};
                enumerateTree(treeUri, rootDocId, "", files, counter, 0);

                String rootName = queryDisplayName(treeUri, rootDocId);
                JSObject ret = new JSObject();
                ret.put("rootUri", treeUri.toString());
                ret.put("rootName", rootName != null ? rootName : "folder");
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Folder scan failed: " + e.getMessage());
            }
        }, "folder-scan").start();
    }

    // Recursively walk a document tree via the (fast, dependency-free)
    // DocumentsContract child-documents query. Each media file becomes a
    // {uri,name,dir,relPath,ext} entry; `uri` is a tree-scoped document URI
    // that openInputStream / materializeToCache accept unchanged.
    private void enumerateTree(Uri treeUri, String parentDocId, String relDir,
                               JSArray files, int[] counter, int depth) {
        if (depth > MAX_TREE_DEPTH) return;
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(childrenUri, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            }, null, null, null);
            if (c == null) return;
            // Resolve columns by NAME, not positional index — some providers
            // return them in a different order than requested.
            int idIdx   = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
            if (idIdx < 0 || nameIdx < 0 || mimeIdx < 0) return;
            while (c.moveToNext()) {
                String docId = c.getString(idIdx);
                String name = c.getString(nameIdx);
                String mime = c.getString(mimeIdx);
                if (docId == null || name == null) continue;
                boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                if (isDir) {
                    String childRel = relDir.isEmpty() ? name : relDir + "/" + name;
                    enumerateTree(treeUri, docId, childRel, files, counter, depth + 1);
                    continue;
                }
                String ext = extensionOf(name);
                if (ext == null || !isMediaExt(ext)) continue;
                Uri childDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                JSObject f = new JSObject();
                f.put("uri", childDocUri.toString());
                f.put("name", name);
                f.put("dir", relDir);
                f.put("relPath", relDir.isEmpty() ? name : relDir + "/" + name);
                f.put("ext", ext);
                files.put(f);
                counter[0]++;
                if (counter[0] % 10 == 0) {
                    JSObject p = new JSObject();
                    p.put("count", counter[0]);
                    notifyListeners("folderScanProgress", p);
                }
            }
        } catch (Exception e) {
            // Skip unreadable subtrees rather than aborting the whole scan,
            // but log so a partial result isn't mistaken for an empty folder.
            android.util.Log.w("FileAccess", "folder subtree scan skipped: " + e.getMessage());
        } finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return null;
        return name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
    }

    private static boolean isMediaExt(String ext) {
        for (String m : MEDIA_EXTS) {
            if (m.equals(ext)) return true;
        }
        return false;
    }

    private String queryDisplayName(Uri treeUri, String docId) {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(
                docUri, new String[]{ DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            // fall through
        } finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }
        return null;
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