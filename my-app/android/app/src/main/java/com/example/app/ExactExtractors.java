package com.example.app;

import android.content.Context;
import android.net.Uri;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.MediaExtractorCompat;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.extractor.mp3.ExactMp3Seeker;
import androidx.media3.extractor.mp3.KadokiMp3Extractor;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Map;

/**
 * Media3's default extractors with MP3 swapped for KadokiMp3Extractor, which
 * seeks VBR files by an exact frame index (see ExactMp3Seeker). Used by the
 * player AND by every random-access reader (transcription windows, slices,
 * waveform), so a time means the same audio everywhere.
 */
@OptIn(markerClass = UnstableApi.class)
final class ExactExtractors implements ExtractorsFactory {
    private final Context ctx;
    private final DefaultExtractorsFactory base = new DefaultExtractorsFactory();
    private final Uri fixedUri;   // MediaExtractorCompat asks without a URI

    ExactExtractors(Context ctx) { this(ctx, null); }

    ExactExtractors(Context ctx, Uri fixedUri) { this.ctx = ctx.getApplicationContext(); this.fixedUri = fixedUri; }

    @Override
    public Extractor[] createExtractors() {
        return fixedUri != null ? createExtractors(fixedUri, java.util.Collections.emptyMap()) : base.createExtractors();
    }

    @Override
    public Extractor[] createExtractors(Uri uri, Map<String, List<String>> headers) {
        Extractor[] ex = base.createExtractors(uri, headers);
        // The defaults come wrapped (subtitle transcoding), so rather than swap
        // the stock MP3 extractor, put ours first for an MP3 source: it sniffs
        // first and wins.
        ExactMp3Seeker.Source src = looksMp3(uri) ? sourceFor(uri) : null;
        if (src == null) return ex;
        Extractor[] out = new Extractor[ex.length + 1];
        out[0] = new KadokiMp3Extractor(src);
        System.arraycopy(ex, 0, out, 1, ex.length);
        return out;
    }

    private static boolean looksMp3(Uri uri) {
        if (uri == null) return false;
        if ("file".equals(uri.getScheme()) || uri.getScheme() == null) return isMp3(uri.getPath());
        String p = uri.getPath();
        return p != null && p.toLowerCase(java.util.Locale.ROOT).endsWith(".mp3");
    }

    private ExactMp3Seeker.Source sourceFor(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if (scheme == null || "file".equals(scheme)) {
            final String path = uri.getPath();
            if (path == null) return null;
            return new ExactMp3Seeker.Source() {
                public String key() { File f = new File(path); return path + "|" + f.lastModified(); }
                public InputStream open() throws IOException { return new FileInputStream(path); }
            };
        }
        if ("content".equals(scheme)) {
            return new ExactMp3Seeker.Source() {
                public String key() { return uri.toString(); }
                public InputStream open() throws IOException {
                    InputStream in = ctx.getContentResolver().openInputStream(uri);
                    if (in == null) throw new IOException("no stream for " + uri);
                    return in;
                }
            };
        }
        return null;   // http(s): no exact index (would download the whole file)
    }

    /** A MediaExtractorCompat that seeks MP3 exactly (other formats as Media3 does). */
    static MediaExtractorCompat extractor(Context ctx, String path) {
        return new MediaExtractorCompat(new ExactExtractors(ctx, Uri.fromFile(new File(path))),
            new DefaultDataSource.Factory(ctx.getApplicationContext()));
    }

    /** True when the file is MP3 (by extension, then by header). */
    static boolean isMp3(String path) {
        if (path == null) return false;
        String p = path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".mp3")) return true;
        if (p.endsWith(".m4a") || p.endsWith(".m4b") || p.endsWith(".mp4") || p.endsWith(".aac")
                || p.endsWith(".flac") || p.endsWith(".ogg") || p.endsWith(".opus") || p.endsWith(".wav")) return false;
        try (InputStream in = new FileInputStream(path)) {
            byte[] b = new byte[3];
            if (in.read(b) != 3) return false;
            return (b[0] == 'I' && b[1] == 'D' && b[2] == '3') || ((b[0] & 0xFF) == 0xFF && (b[1] & 0xE0) == 0xE0);
        } catch (Exception e) { return false; }
    }
}
