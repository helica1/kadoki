package androidx.media3.extractor.mp3;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.util.Log;
import androidx.media3.extractor.MpegAudioUtil;
import androidx.media3.extractor.SeekPoint;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * KADOKI: exact seeking for VBR MP3. The file's frame headers are scanned once
 * (header-only, ~1-2 s for a 450 MB audiobook) and every STRIDE-th frame's
 * byte offset is kept, so a seek lands on a real frame whose time is its true
 * frame count — the same time continuous playback reaches. Indexes are cached
 * in memory (a few files) and on disk under the app cache dir, keyed by the
 * source's identity and length.
 */
public final class ExactMp3Seeker implements Seeker {
    private static final String TAG = "ExactMp3Seeker";
    private static final int STRIDE = 32;              // frames per index entry (~0.8 s)
    private static final int MAGIC = 0x4B4D5049;       // "KMPI"
    private static final int VERSION = 1;
    private static final int HEADER_MASK = 0xFFFE0C00;  // sync, version, layer, sample rate

    /** Where the bytes come from (a file or a content: URI) and a stable identity for the cache. */
    public interface Source {
        String key();
        InputStream open() throws IOException;
    }

    private final long dataStart, dataEnd, totalFrames;
    private final int sampleRate, samplesPerFrame;
    private final long[] offsets;   // offsets[k] = byte of frame k * STRIDE

    private ExactMp3Seeker(long dataStart, long dataEnd, long totalFrames, int sampleRate, int samplesPerFrame, long[] offsets) {
        this.dataStart = dataStart;
        this.dataEnd = dataEnd;
        this.totalFrames = totalFrames;
        this.sampleRate = sampleRate;
        this.samplesPerFrame = samplesPerFrame;
        this.offsets = offsets;
    }

    private static final Map<String, ExactMp3Seeker> mem = new LinkedHashMap<String, ExactMp3Seeker>(4, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, ExactMp3Seeker> e) { return size() > 4; }
    };

    /**
     * The index for {@code src} whose first audio frame is at {@code dataStart}.
     * Null if the stream can't be scanned (the caller keeps its own seeker).
     * Blocks while building; concurrent callers for one file share the build.
     */
    @Nullable
    public static synchronized ExactMp3Seeker forStream(Source src, long dataStart, long length) {
        String key = src.key() + "|" + length + "|" + dataStart;
        ExactMp3Seeker s = mem.get(key);
        if (s != null) return s;
        File f = cacheFile(key);
        s = f != null ? readCache(f) : null;
        if (s == null) {
            long t0 = System.currentTimeMillis();
            try (InputStream in = src.open()) {
                s = scan(in, dataStart);
            } catch (Throwable e) {
                Log.w(TAG, "index scan failed: " + e);
                return null;
            }
            if (s == null) return null;
            Log.i(TAG, "indexed " + s.totalFrames + " frames in " + (System.currentTimeMillis() - t0) + " ms");
            if (f != null) writeCache(f, s);
        }
        mem.put(key, s);
        return s;
    }

    @Nullable
    private static ExactMp3Seeker scan(InputStream raw, long dataStart) throws IOException {
        InputStream in = new BufferedInputStream(raw, 1 << 20);
        long skipped = 0;
        while (skipped < dataStart) {
            long k = in.skip(dataStart - skipped);
            if (k <= 0) { if (in.read() < 0) return null; k = 1; }
            skipped += k;
        }
        MpegAudioUtil.Header h = new MpegAudioUtil.Header();
        long[] offs = new long[1 << 14];
        int n = 0;
        long pos = dataStart, frames = 0, end = dataStart;
        int ref = 0, sr = 0, spf = 0;
        byte[] skipBuf = new byte[8192];
        int b0 = in.read(), b1 = in.read(), b2 = in.read(), b3 = in.read();
        while (b3 >= 0) {
            int hdr = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
            boolean ok = (hdr & 0xFFE00000) == 0xFFE00000 && h.setForHeaderData(hdr)
                    && (ref == 0 || (hdr & HEADER_MASK) == (ref & HEADER_MASK));
            if (!ok) {
                // Lost sync (junk, a trailing tag): slide one byte, uncounted — as the extractor does.
                b0 = b1; b1 = b2; b2 = b3; b3 = in.read(); pos++;
                continue;
            }
            if (ref == 0) { ref = hdr; sr = h.sampleRate; spf = h.samplesPerFrame; }
            if (frames % STRIDE == 0) {
                if (n == offs.length) { long[] g = new long[n * 2]; System.arraycopy(offs, 0, g, 0, n); offs = g; }
                offs[n++] = pos;
            }
            frames++;
            end = pos + h.frameSize;
            long left = h.frameSize - 4;
            while (left > 0) {
                int r = in.read(skipBuf, 0, (int) Math.min(skipBuf.length, left));
                if (r < 0) break;
                left -= r;
            }
            pos = end;
            b0 = in.read(); b1 = in.read(); b2 = in.read(); b3 = in.read();
        }
        if (frames < STRIDE || sr <= 0) return null;
        long[] o = new long[n];
        System.arraycopy(offs, 0, o, 0, n);
        return new ExactMp3Seeker(dataStart, end, frames, sr, spf, o);
    }

    private long timeOfFrame(long frame) {
        return frame * samplesPerFrame * C.MICROS_PER_SECOND / sampleRate;
    }

    @Override public boolean isSeekable() { return true; }

    @Override public long getDurationUs() { return timeOfFrame(totalFrames); }

    @Override
    public SeekPoints getSeekPoints(long timeUs) {
        long frame = Math.max(0, timeUs) * sampleRate / ((long) samplesPerFrame * C.MICROS_PER_SECOND);
        int k = (int) Math.min(offsets.length - 1, frame / STRIDE);
        SeekPoint p = new SeekPoint(timeOfFrame((long) k * STRIDE), offsets[k]);
        if (p.timeUs >= timeUs || k + 1 >= offsets.length) return new SeekPoints(p);
        return new SeekPoints(p, new SeekPoint(timeOfFrame((long) (k + 1) * STRIDE), offsets[k + 1]));
    }

    @Override
    public long getTimeUs(long position) {
        int lo = 0, hi = offsets.length - 1;
        while (lo < hi) {
            int mid = (lo + hi + 1) >>> 1;
            if (offsets[mid] <= position) lo = mid; else hi = mid - 1;
        }
        long base = (long) lo * STRIDE;
        long off = offsets[lo];
        if (position <= off) return timeOfFrame(base);
        // Between index entries (not a position we hand out): interpolate.
        long next = lo + 1 < offsets.length ? offsets[lo + 1] : dataEnd;
        long span = Math.max(1, next - off);
        long frames = lo + 1 < offsets.length ? STRIDE : (totalFrames - base);
        return timeOfFrame(base) + (position - off) * timeOfFrame(frames) / span;
    }

    @Override public long getDataEndPosition() { return dataEnd; }

    @Override
    public int getAverageBitrate() {
        long us = getDurationUs();
        return us > 0 ? (int) ((dataEnd - dataStart) * 8L * C.MICROS_PER_SECOND / us) : C.RATE_UNSET_INT;
    }

    // ── disk cache ──

    @Nullable
    private static File cacheFile(String key) {
        try {
            String tmp = System.getProperty("java.io.tmpdir");
            if (tmp == null) return null;
            File dir = new File(tmp, "mp3idx");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            return new File(dir, Integer.toHexString(key.hashCode()) + "_" + Integer.toHexString(key.length()) + ".idx");
        } catch (Throwable e) { return null; }
    }

    @Nullable
    private static ExactMp3Seeker readCache(File f) {
        if (!f.isFile()) return null;
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(f), 1 << 16))) {
            if (in.readInt() != MAGIC || in.readInt() != VERSION) return null;
            long ds = in.readLong(), de = in.readLong(), tf = in.readLong();
            int sr = in.readInt(), spf = in.readInt(), n = in.readInt();
            if (n <= 0 || sr <= 0 || spf <= 0) return null;
            long[] o = new long[n];
            for (int i = 0; i < n; i++) o[i] = in.readLong();
            return new ExactMp3Seeker(ds, de, tf, sr, spf, o);
        } catch (Throwable e) { return null; }
    }

    private static void writeCache(File f, ExactMp3Seeker s) {
        File tmp = new File(f.getPath() + ".tmp");
        try (DataOutputStream out = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16))) {
            out.writeInt(MAGIC); out.writeInt(VERSION);
            out.writeLong(s.dataStart); out.writeLong(s.dataEnd); out.writeLong(s.totalFrames);
            out.writeInt(s.sampleRate); out.writeInt(s.samplesPerFrame); out.writeInt(s.offsets.length);
            for (long v : s.offsets) out.writeLong(v);
        } catch (Throwable e) { tmp.delete(); return; }
        if (!tmp.renameTo(f)) tmp.delete();
    }
}
