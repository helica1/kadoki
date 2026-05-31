package com.example.app;

import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * ArchiveExtractor — Android port of the iOS ArchiveExtractorPlugin.
 *
 * Streams a .tar OR .tar.gz/.tgz into the app's external files dir under
 * <destSubdir>/ so the bundled 2.3 GB yomichan-audio archive doesn't have to
 * ship in the APK. The user points at the archive in-app (Preferences → Audio
 * archive → Import); we extract it once.
 *
 * Improvement over iOS (which is .tar only — user must `xz -d` first): we
 * sniff the gzip magic (1f 8b) and transparently gunzip, so .tar.gz / .tgz
 * work directly.
 *
 * Destination: getExternalFilesDir(null)/<destSubdir> — this is Capacitor's
 * Directory.EXTERNAL, needs NO storage permission, has room for multi-GB, and
 * is exactly where local-audio.js resolves the base via
 * Filesystem.getUri({directory:'EXTERNAL', path:'yomichan-audio'}). The
 * returned destDir is also stored in Preferences (YOMICHAN_AUDIO_DIR) as a
 * fallback.
 *
 * JS API (matches iOS):
 *   extractTar({ srcPath?, srcUri?, destSubdir?, deleteSrcOnSuccess? })
 *     → { ok, bytesIn, bytesOut, fileCount, destDir }
 *   Events: "progress" { bytesIn, bytesOut, fileCount, totalIn, pct }
 */
@CapacitorPlugin(name = "ArchiveExtractor")
public class ArchiveExtractorPlugin extends Plugin {

    private static final String TAG = "ArchiveExtractor";
    private static final int BODY_CHUNK = 256 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void extractTar(PluginCall call) {
        final String srcPath = call.getString("srcPath");
        final String srcUri  = call.getString("srcUri");
        if ((srcPath == null || srcPath.isEmpty()) && (srcUri == null || srcUri.isEmpty())) {
            call.reject("srcPath or srcUri required");
            return;
        }
        final String destSubdir = call.getString("destSubdir", "yomichan-audio");
        final boolean deleteSrc = Boolean.TRUE.equals(call.getBoolean("deleteSrcOnSuccess", false));

        worker.execute(() -> {
            InputStream rawIn = null;
            try {
                File ext = getContext().getExternalFilesDir(null);
                if (ext == null) { call.reject("External storage unavailable"); return; }
                File destDir = new File(ext, destSubdir);
                if (!destDir.exists() && !destDir.mkdirs() && !destDir.exists()) {
                    call.reject("Could not create destination dir"); return;
                }

                long totalIn = 0;
                File srcFile = null;
                if (srcPath != null && !srcPath.isEmpty()) {
                    String p = srcPath.startsWith("file://") ? Uri.parse(srcPath).getPath() : srcPath;
                    srcFile = new File(p);
                    totalIn = srcFile.length();
                    rawIn = new FileInputStream(srcFile);
                } else {
                    Uri u = Uri.parse(srcUri);
                    totalIn = querySize(u);
                    rawIn = getContext().getContentResolver().openInputStream(u);
                    if (rawIn == null) throw new IOException("Could not open srcUri");
                }

                Log.d(TAG, "extract start totalIn=" + totalIn + " dest=" + destDir.getAbsolutePath());
                // Count COMPRESSED bytes consumed so progress is accurate for
                // .tar.gz/.tar.xz (the decompressed byte count would shoot past
                // 100% of the compressed file size).
                CountingInputStream counting = new CountingInputStream(rawIn);
                Result r = streamExtract(counting, destDir, totalIn);

                if (deleteSrc && srcFile != null) { try { srcFile.delete(); } catch (Exception ignore) {} }

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("bytesIn", r.bytesIn);
                ret.put("bytesOut", r.bytesOut);
                ret.put("fileCount", r.fileCount);
                ret.put("destDir", destDir.getAbsolutePath());
                Log.d(TAG, "extract done files=" + r.fileCount + " bytesOut=" + r.bytesOut);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "extract failed", e);
                call.reject("Extract failed: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            } finally {
                if (rawIn != null) { try { rawIn.close(); } catch (Exception ignore) {} }
            }
        });
    }

    // ---- streaming pipeline ----

    private static class Result { long bytesIn, bytesOut; int fileCount; }

    /**
     * Sniff the magic bytes and transparently decompress:
     *   1f 8b              → gzip (.tar.gz / .tgz)
     *   fd 37 7a 58 5a 00  → xz   (.tar.xz)   [via org.tukaani.xz]
     *   else               → plain .tar
     */
    private InputStream openMaybeDecompress(InputStream in) throws IOException {
        PushbackInputStream pb = new PushbackInputStream(new BufferedInputStream(in, BODY_CHUNK), 6);
        byte[] sig = new byte[6];
        int n = 0;
        while (n < 6) {
            int g = pb.read(sig, n, 6 - n);
            if (g < 0) break;
            n += g;
        }
        if (n > 0) pb.unread(sig, 0, n);
        if (n >= 2 && (sig[0] & 0xff) == 0x1f && (sig[1] & 0xff) == 0x8b) {
            return new GZIPInputStream(pb, BODY_CHUNK);              // .tar.gz / .tgz
        }
        if (n >= 6 && (sig[0] & 0xff) == 0xFD && (sig[1] & 0xff) == 0x37
                   && (sig[2] & 0xff) == 0x7A && (sig[3] & 0xff) == 0x58
                   && (sig[4] & 0xff) == 0x5A && (sig[5] & 0xff) == 0x00) {
            return new org.tukaani.xz.XZInputStream(pb);             // .tar.xz
        }
        return pb;                                                  // plain .tar
    }

    private Result streamExtract(CountingInputStream rawCounting, File destDir, long totalIn) throws IOException {
        Result res = new Result();
        InputStream in = openMaybeDecompress(rawCounting);
        byte[] header = new byte[512];
        byte[] buf = new byte[BODY_CHUNK];
        long lastProgress = 0;
        // ~every 1% of the compressed input (or 8 MB), whichever's coarser.
        long progressEvery = Math.max(8_000_000L, totalIn / 100);

        while (true) {
            if (!readFully(in, header, 512)) break;       // clean EOF
            res.bytesIn += 512;
            if (isAllZero(header)) break;                 // end-of-archive marker block

            String name = parseName(header);
            long size = parseOctal(header, 124, 12);
            int type = header[156] & 0xff;
            // Path-traversal guard (matches tar(1) default + the iOS port).
            if (name == null || name.isEmpty() || name.contains("..") || name.startsWith("/")) {
                throw new IOException("Unsafe/malformed tar entry at byte " + res.bytesIn);
            }
            long padding = (512 - (size % 512)) % 512;

            OutputStream out = null;
            if (type == '5') {                            // directory
                new File(destDir, name).mkdirs();
            } else if (type == '0' || type == 0) {        // regular file ('0' or NUL)
                File outFile = new File(destDir, name);
                File parent = outFile.getParentFile();
                if (parent != null) parent.mkdirs();
                out = new FileOutputStream(outFile);
                res.fileCount++;
            }                                             // else: skip other entry types' bodies

            long remaining = size;
            try {
                while (remaining > 0) {
                    int want = (int) Math.min(buf.length, remaining);
                    int got = in.read(buf, 0, want);
                    if (got < 0) throw new IOException("Unexpected EOF inside entry " + name);
                    if (out != null) { out.write(buf, 0, got); res.bytesOut += got; }
                    remaining -= got;
                    res.bytesIn += got;
                    if (rawCounting.count - lastProgress >= progressEvery) {
                        lastProgress = rawCounting.count;
                        emitProgress(res, rawCounting.count, totalIn);
                    }
                }
                if (out != null) out.flush();
            } finally {
                // Always close the entry file, even if the read throws partway —
                // otherwise a mid-entry failure leaks the file descriptor.
                if (out != null) { try { out.close(); } catch (Exception ignore) {} }
            }
            skipFully(in, padding);
            res.bytesIn += padding;
        }
        emitProgress(res, rawCounting.count, totalIn);
        return res;
    }

    private void emitProgress(Result res, long rawConsumed, long totalIn) {
        JSObject d = new JSObject();
        d.put("bytesIn", res.bytesIn);          // decompressed bytes read (informational)
        d.put("bytesOut", res.bytesOut);
        d.put("fileCount", res.fileCount);
        d.put("totalIn", totalIn);
        // pct from COMPRESSED bytes consumed vs the (compressed) source size, so
        // .tar.gz/.tar.xz don't shoot past 100%.
        d.put("pct", totalIn > 0 ? Math.min(1.0, (double) rawConsumed / (double) totalIn) : 0.0);
        notifyListeners("progress", d);
    }

    /** Counts bytes pulled from the underlying (compressed) source, for progress. */
    private static final class CountingInputStream extends java.io.FilterInputStream {
        long count = 0;
        CountingInputStream(InputStream in) { super(in); }
        @Override public int read() throws IOException {
            int b = super.read();
            if (b >= 0) count++;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) count += n;
            return n;
        }
        @Override public long skip(long n) throws IOException {
            long s = super.skip(n);
            if (s > 0) count += s;
            return s;
        }
    }

    // ---- helpers ----

    private long querySize(Uri u) {
        try (Cursor c = getContext().getContentResolver().query(u, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx);
            }
        } catch (Exception ignore) {}
        return 0;
    }

    /** Fill b[0..len) fully; false if EOF before any/all bytes (treated as end). */
    private static boolean readFully(InputStream in, byte[] b, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int got = in.read(b, off, len - off);
            if (got < 0) return false;
            off += got;
        }
        return true;
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) {
                if (in.read() < 0) return;  // EOF
                n -= 1;
            } else {
                n -= s;
            }
        }
    }

    private static boolean isAllZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    private static String parseName(byte[] h) {
        String name = cstr(h, 0, 100);
        String prefix = cstr(h, 345, 155);   // USTAR long-name prefix
        return prefix.isEmpty() ? name : (prefix + "/" + name);
    }

    private static String cstr(byte[] h, int off, int len) {
        int end = off, max = off + len;
        while (end < max && h[end] != 0) end++;
        return new String(h, off, end - off, StandardCharsets.UTF_8);
    }

    private static long parseOctal(byte[] h, int off, int len) {
        long val = 0;
        int i = off, max = off + len;
        while (i < max && (h[i] == ' ' || h[i] == 0)) i++;          // leading pad
        while (i < max && h[i] >= '0' && h[i] <= '7') {
            val = (val << 3) + (h[i] - '0');
            i++;
        }
        return val;
    }
}
