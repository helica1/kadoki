package com.example.app;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import java.io.FileOutputStream;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.MediaExtractorCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * AudioSlicer — fast on-device audio slicing + waveform extraction using
 * Android's MediaExtractor + MediaCodec. No FFmpeg, no re-encoding for the
 * slice path (passthrough mux).
 *
 * Demuxing goes through a small {@link Demuxer} abstraction: the platform
 * android.media.MediaExtractor is tried FIRST (the proven path — unchanged
 * behavior for mp3/standard files), and only if it can't parse the container
 * (e.g. some Audible-style .m4b that Stagefright rejects, the same files the
 * ExoPlayer playback migration fixed) do we fall back to Media3's
 * MediaExtractorCompat, which uses Media3's own pure-Java MP4 extractor. This
 * keeps the working Anki-export slice path untouched and only routes the
 * problem files through the new demuxer.
 *
 * JS API:
 *   slice({ srcPath, startMs, endMs })
 *     → { path: string, sizeBytes: number }
 *     Writes a new M4A in the app's cache dir containing samples from
 *     [startMs, endMs]. Uses passthrough mux — no quality loss, very fast.
 *
 *   getWaveform({ srcPath, startMs, endMs, samples })
 *     → { samples: number[], durationMs: number }
 *     Decodes PCM in the [startMs, endMs] range, downsamples to `samples`
 *     average-amplitude points in [0..1]. Suitable for canvas rendering.
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "AudioSlicer")
public class AudioSlicerPlugin extends Plugin {

    private static final String TAG = "AudioSlicer";
    private static final int TIMEOUT_US = 10000;

    private static String normalizePath(String p) {
        if (p == null) return null;
        return p.startsWith("file://") ? p.substring("file://".length()) : p;
    }

    private static long longArg(PluginCall call, String name) {
        // call.getLong(...) silently returns the default for some JSON-Number
        // shapes (observed: startMs/endMs from JS arriving as 0 even though
        // the methodData clearly has 368915 etc.). getDouble is reliable.
        Double d = call.getDouble(name);
        if (d == null) return 0L;
        return d.longValue();
    }

    // ----- Demuxer abstraction (platform first, Media3 fallback) -----

    /**
     * The slice/waveform loops use only this subset of the demuxer API, so the
     * exact same loop runs whether backed by the platform MediaExtractor or
     * Media3's MediaExtractorCompat. Method order/semantics mirror
     * android.media.MediaExtractor.
     */
    private interface Demuxer {
        int getTrackCount();
        MediaFormat getTrackFormat(int i);
        void selectTrack(int i);
        void seekTo(long timeUs, int mode);
        long getSampleTime();
        int getSampleFlags();
        int readSampleData(ByteBuffer buffer, int offset);
        boolean advance();
        void release();
    }

    /** Platform demuxer — 1:1 delegation, so the proven path is unchanged. */
    private static final class NativeDemuxer implements Demuxer {
        private final MediaExtractor ex = new MediaExtractor();
        NativeDemuxer(String srcPath) throws Exception { ex.setDataSource(srcPath); }
        public int getTrackCount() { return ex.getTrackCount(); }
        public MediaFormat getTrackFormat(int i) { return ex.getTrackFormat(i); }
        public void selectTrack(int i) { ex.selectTrack(i); }
        public void seekTo(long t, int m) { ex.seekTo(t, m); }
        public long getSampleTime() { return ex.getSampleTime(); }
        public int getSampleFlags() { return ex.getSampleFlags(); }
        public int readSampleData(ByteBuffer b, int o) { return ex.readSampleData(b, o); }
        public boolean advance() { return ex.advance(); }
        public void release() { try { ex.release(); } catch (Exception ignored) {} }
    }

    /**
     * Media3 fallback demuxer — used ONLY when the platform extractor can't
     * parse the file. MediaExtractorCompat (media3 1.4.x, @UnstableApi) uses
     * Media3's own MP4 extractor, which reads the m4b files Stagefright rejects.
     * NOTE: at 1.4.x the only setDataSource overload is (Uri, long offset), so
     * we wrap the local path in a file:// Uri.
     */
    @OptIn(markerClass = UnstableApi.class)
    private static final class Media3Demuxer implements Demuxer {
        private final MediaExtractorCompat ex;
        Media3Demuxer(android.content.Context ctx, String srcPath) throws Exception {
            ex = new MediaExtractorCompat(ctx);
            ex.setDataSource(Uri.fromFile(new File(srcPath)), 0L);
        }
        public int getTrackCount() { return ex.getTrackCount(); }
        public MediaFormat getTrackFormat(int i) { return ex.getTrackFormat(i); }
        public void selectTrack(int i) { ex.selectTrack(i); }
        public void seekTo(long t, int m) { ex.seekTo(t, m); }
        public long getSampleTime() { return ex.getSampleTime(); }
        public int getSampleFlags() { return ex.getSampleFlags(); }
        public int readSampleData(ByteBuffer b, int o) { return ex.readSampleData(b, o); }
        public boolean advance() { return ex.advance(); }
        public void release() { try { ex.release(); } catch (Exception ignored) {} }
    }

    /**
     * Open the platform demuxer; if it can't parse the container (or has no
     * audio track), fall back to Media3's. Returns a Demuxer with NO track
     * selected. The returned demuxer's findAudioTrack() is guaranteed >= 0.
     */
    private Demuxer openDemuxer(String srcPath) throws Exception {
        // Try the platform extractor first (proven path). Release it on ANY
        // failure — including findAudioTrack() THROWING mid-introspection on a
        // half-parsed container, not just returning -1 — before falling back, so
        // we never leak a native MediaExtractor handle on the fallback hot path.
        try {
            NativeDemuxer d = null;
            try {
                d = new NativeDemuxer(srcPath);
                if (findAudioTrack(d) < 0) throw new Exception("no audio track (native)");
                Demuxer ok = d; d = null; return ok;   // transfer ownership to caller
            } finally {
                if (d != null) d.release();
            }
        } catch (Throwable nativeFail) {
            Log.w(TAG, "platform MediaExtractor failed (" + nativeFail.getMessage()
                + "); falling back to Media3 MediaExtractorCompat for " + srcPath);
        }
        // Media3 fallback — same release-on-any-failure guard. A throw here
        // propagates out of openDemuxer (the public method rejects the call).
        Media3Demuxer d = null;
        try {
            d = new Media3Demuxer(getContext(), srcPath);
            if (findAudioTrack(d) < 0) throw new Exception("no audio track (media3 fallback)");
            Demuxer ok = d; d = null; return ok;
        } finally {
            if (d != null) d.release();
        }
    }

    /**
     * Probe whether the PLATFORM android.media.MediaExtractor can parse this
     * container AND exposes an audio track. Mirrors openDemuxer's native branch
     * but NEVER falls back to Media3 — a false return means "this file only
     * works via the Media3 fallback", i.e. the re-encode path. Releases the
     * probe extractor on every path so no native handle leaks.
     */
    private boolean canPlatformParse(String srcPath) {
        NativeDemuxer d = null;
        try {
            d = new NativeDemuxer(srcPath);
            return findAudioTrack(d) >= 0;
        } catch (Throwable t) {
            return false;
        } finally {
            if (d != null) d.release();
        }
    }

    @PluginMethod
    public void slice(PluginCall call) {
        String srcPath = normalizePath(call.getString("srcPath"));
        long startMs = longArg(call, "startMs");
        long endMs = longArg(call, "endMs");
        if (srcPath == null || endMs <= startMs) {
            call.reject("srcPath required and endMs > startMs");
            return;
        }
        try {
            // Decide the route up front: (a) the audio MIME and (b) whether the
            // PLATFORM extractor can parse this container. canPlatformParse()
            // probes with a bare NativeDemuxer; a false return means the file
            // only works via the Media3 fallback (the silent-passthrough .m4b),
            // which must be RE-ENCODED, not raw-copied.
            boolean platformOk = canPlatformParse(srcPath);

            Demuxer probe = openDemuxer(srcPath);
            String mime;
            try {
                int t = findAudioTrack(probe);
                if (t < 0) throw new Exception("no audio track in " + srcPath);
                mime = probe.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
            } finally {
                probe.release();
            }
            Log.d(TAG, "slice: mime=" + mime + " platformParse=" + platformOk);
            String outName, outMime;
            File outFile;
            if (mime != null && mime.equalsIgnoreCase("audio/mpeg")) {
                // MP3: raw-frame copy (native, unchanged).
                outName = "slice_" + System.currentTimeMillis() + ".mp3";
                outFile = new File(getContext().getCacheDir(), outName);
                sliceMp3Frames(srcPath, startMs * 1000, endMs * 1000, outFile.getAbsolutePath());
                outMime = "audio/mpeg";
            } else if (platformOk) {
                // Platform extractor can parse it → proven passthrough mux,
                // BYTE-IDENTICAL to the existing working path (mp4/aac/etc.).
                outName = "slice_" + System.currentTimeMillis() + ".m4a";
                outFile = new File(getContext().getCacheDir(), outName);
                sliceRange(srcPath, startMs * 1000, endMs * 1000, outFile.getAbsolutePath());
                outMime = "audio/mp4";
            } else {
                // ONLY the Media3-fallback m4b case: passthrough plays SILENT in
                // Anki, so DECODE→RE-ENCODE to a clean AAC .m4a.
                outName = "slice_" + System.currentTimeMillis() + ".m4a";
                outFile = new File(getContext().getCacheDir(), outName);
                sliceReencode(srcPath, startMs * 1000, endMs * 1000, outFile.getAbsolutePath());
                outMime = "audio/mp4";
            }
            JSObject ret = new JSObject();
            ret.put("path", outFile.getAbsolutePath());
            ret.put("sizeBytes", outFile.length());
            ret.put("mime", outMime);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "slice failed", e);
            call.reject("slice failed: " + e.getMessage());
        }
    }

    /**
     * MP3-specific slice: copy MP3 frames in [startUs, endUs] directly to
     * a new .mp3 file. No muxer needed — each MP3 frame is self-contained,
     * so concatenating raw extracted samples yields a playable MP3.
     */
    private void sliceMp3Frames(String srcPath, long startUs, long endUs, String outPath) throws Exception {
        Demuxer extractor = openDemuxer(srcPath);
        FileOutputStream out = null;
        try {
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            out = new FileOutputStream(outPath);
            ByteBuffer buf = ByteBuffer.allocate(256 * 1024);
            byte[] tmp = new byte[256 * 1024];
            long written = 0;
            while (true) {
                long sampleTime = extractor.getSampleTime();
                if (sampleTime < 0) break;
                if (sampleTime > endUs) break;
                int size = extractor.readSampleData(buf, 0);
                if (size <= 0) break;
                if (size > tmp.length) tmp = new byte[size];
                buf.position(0);
                buf.get(tmp, 0, size);
                out.write(tmp, 0, size);
                written += size;
                if (!extractor.advance()) break;
            }
            Log.d(TAG, "sliceMp3Frames wrote " + written + " bytes to " + outPath);
        } finally {
            if (out != null) try { out.close(); } catch (Exception ignored) {}
            extractor.release();
        }
    }

    @PluginMethod
    public void getWaveform(PluginCall call) {
        String srcPath = normalizePath(call.getString("srcPath"));
        long startMs = longArg(call, "startMs");
        long endMs = longArg(call, "endMs");
        int samples = call.getInt("samples", 200);
        // Log on every call so we can confirm the plugin is reachable even
        // if the decode loop itself never runs.
        Log.d(TAG, "getWaveform called: src=" + srcPath + " start=" + startMs + " end=" + endMs + " samples=" + samples);
        if (srcPath == null || endMs <= startMs) {
            call.reject("srcPath required and endMs > startMs");
            return;
        }
        try {
            float[] waveform = decodeWaveform(srcPath, startMs * 1000, endMs * 1000, samples);
            JSONArray arr = new JSONArray();
            for (float v : waveform) arr.put(v);
            JSObject ret = new JSObject();
            ret.put("samples", arr);
            ret.put("durationMs", endMs - startMs);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "getWaveform failed", e);
            call.reject("getWaveform failed: " + e.getMessage());
        }
    }

    // ----- Internals -----

    /** Find the first audio track in the source. */
    private static int findAudioTrack(Demuxer ex) {
        for (int i = 0; i < ex.getTrackCount(); i++) {
            MediaFormat f = ex.getTrackFormat(i);
            String mime = f.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) return i;
        }
        return -1;
    }

    /**
     * Ensure an AAC MediaFormat carries a usable "csd-0" (the AAC
     * AudioSpecificConfig) before it is handed to MediaMuxer.addTrack().
     *
     * The platform android.media.MediaExtractor always exposes csd-0, so the
     * proven NATIVE slice path is a strict no-op here (output stays byte-for-byte
     * identical). But Media3's MediaExtractorCompat can leave initializationData
     * empty for some Audible-style .m4b AAC tracks → no csd-0 → MediaMuxer writes
     * an esds with an empty DecoderSpecificInfo and AnkiDroid's AAC decoder
     * outputs SILENCE. Synthesize the 2-byte AAC-LC AudioSpecificConfig from
     * sample-rate + channel-count so the muxed esds is valid. Keys off the
     * ABSENCE of csd-0, not which demuxer produced the format.
     */
    private static void ensureAacCsd(MediaFormat fmt) {
        if (fmt == null) return;
        String mime = fmt.getString(MediaFormat.KEY_MIME);
        if (mime == null) return;
        // MIMETYPE_AUDIO_AAC == "audio/mp4a-latm".
        if (!mime.equalsIgnoreCase(MediaFormat.MIMETYPE_AUDIO_AAC)
                && !mime.equalsIgnoreCase("audio/aac")) {
            return;
        }
        // Already have a non-empty csd-0 (native path / complete format) → keep as-is.
        if (fmt.containsKey("csd-0")) {
            ByteBuffer existing = fmt.getByteBuffer("csd-0");
            if (existing != null && existing.remaining() > 0) return;
        }
        int sampleRate = 0, channelCount = 0;
        try { sampleRate   = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);   } catch (Exception ignored) {}
        try { channelCount = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
        if (sampleRate <= 0 || channelCount <= 0) {
            Log.w(TAG, "ensureAacCsd: missing csd-0 and no sample-rate/channel-count ("
                + sampleRate + "/" + channelCount + ") -> cannot synthesize AAC ASC");
            return;
        }
        int freqIdx = aacFreqIndex(sampleRate);
        if (freqIdx < 0) {
            Log.w(TAG, "ensureAacCsd: unsupported sampleRate " + sampleRate + " -> cannot synthesize AAC ASC");
            return;
        }
        // AudioSpecificConfig (ISO/IEC 14496-3) for AAC-LC, 2 bytes:
        //   audioObjectType=2 (5b) | samplingFreqIndex (4b) | channelConfig (4b) | 000 (3b)
        //   → (2<<11) | (freqIdx<<7) | (chan<<3).  e.g. 44100/stereo → 0x1210.
        int asc = (2 << 11) | (freqIdx << 7) | ((channelCount & 0x0F) << 3);
        byte[] csd = new byte[] { (byte) ((asc >> 8) & 0xFF), (byte) (asc & 0xFF) };
        fmt.setByteBuffer("csd-0", ByteBuffer.wrap(csd));
        Log.d(TAG, "ensureAacCsd: synthesized AAC-LC csd-0 sr=" + sampleRate
            + " ch=" + channelCount + " freqIdx=" + freqIdx);
    }

    /** ISO/IEC 14496-3 sampling-frequency index; -1 if unsupported. */
    private static int aacFreqIndex(int sampleRate) {
        switch (sampleRate) {
            case 96000: return 0;  case 88200: return 1;  case 64000: return 2;
            case 48000: return 3;  case 44100: return 4;  case 32000: return 5;
            case 24000: return 6;  case 22050: return 7;  case 16000: return 8;
            case 12000: return 9;  case 11025: return 10; case 8000:  return 11;
            case 7350:  return 12;
            default:    return -1;
        }
    }

    /** Passthrough mux of samples in [startUs, endUs] to outPath. */
    private void sliceRange(String srcPath, long startUs, long endUs, String outPath) throws Exception {
        Demuxer extractor = openDemuxer(srcPath);
        MediaMuxer muxer = null;
        try {
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat fmt = extractor.getTrackFormat(track);
            muxer = new MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            // Patch a missing AAC csd-0 (AudioSpecificConfig). No-op when csd-0 is
            // already present (the native MediaExtractor path), so it only affects
            // the Media3 fallback, which can omit csd-0 for some m4b tracks →
            // otherwise the muxed .m4a plays SILENT in Anki (config-less esds).
            ensureAacCsd(fmt);
            int outTrack = muxer.addTrack(fmt);
            muxer.start();

            // Seek to nearest sync sample at/before startUs.
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            int bufSize = 256 * 1024;
            try {
                bufSize = fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE);
            } catch (Exception ignored) {}
            ByteBuffer buf = ByteBuffer.allocate(Math.max(256 * 1024, bufSize));
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

            long firstTimeUs = -1;
            while (true) {
                long sampleTime = extractor.getSampleTime();
                if (sampleTime < 0) break;            // EOS
                if (sampleTime > endUs) break;
                int size = extractor.readSampleData(buf, 0);
                if (size <= 0) break;
                if (firstTimeUs < 0) firstTimeUs = sampleTime;
                info.offset = 0;
                info.size = size;
                info.presentationTimeUs = sampleTime - firstTimeUs;
                // Translate the extractor's sample flags to MediaCodec buffer
                // flags for the muxer. We only forward the key-frame bit
                // (SAMPLE_FLAG_SYNC → BUFFER_FLAG_KEY_FRAME); never forward
                // SAMPLE_FLAG_ENCRYPTED, which is not a valid muxer buffer flag.
                // For audio every frame is independently decodable, so this is
                // equivalent to the old raw passthrough for the native path.
                info.flags = ((extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0)
                    ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                muxer.writeSampleData(outTrack, buf, info);
                if (!extractor.advance()) break;
            }
        } finally {
            // Split stop() and release(): a degenerate range (start beyond EOS →
            // zero samples written) makes MediaMuxer.stop() throw, which would
            // otherwise skip release() and leak the native muxer + output fd.
            try { if (muxer != null) muxer.stop(); } catch (Exception ignored) {}
            try { if (muxer != null) muxer.release(); } catch (Exception ignored) {}
            extractor.release();
        }
    }

    /**
     * Decode audio in [startUs, endUs] to PCM, downsample to `outSamples`
     * peak-amplitude points in [0..1].
     *
     * Algorithm: for each decoded PCM frame, compute its absolute time
     * (decoder gives buffer presentationTimeUs; per-frame time = that +
     * frameIndex / sampleRate). Map time → bucket via
     *   bucket = (frameTimeUs - startUs) * outSamples / (endUs - startUs)
     * Take the peak |sample| across channels per frame; keep the max in
     * each bucket. Skip frames outside [startUs, endUs].
     */
    private float[] decodeWaveform(String srcPath, long startUs, long endUs, int outSamples) throws Exception {
        if (outSamples <= 0) outSamples = 200;
        Log.d(TAG, "decodeWaveform: src=" + srcPath + " range=" + (startUs / 1000) + ".." + (endUs / 1000) + "ms target=" + outSamples);

        Demuxer extractor = openDemuxer(srcPath);
        MediaCodec codec = null;
        try {
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat fmt = extractor.getTrackFormat(track);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            Log.d(TAG, "track=" + track + " mime=" + mime + " fmt=" + fmt);
            if (mime == null) throw new Exception("audio track has no MIME");
            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            float[] buckets = new float[outSamples];
            final long totalSpanUs = Math.max(1, endUs - startUs);

            int sampleRate = 0, channels = 0;
            try { sampleRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE); } catch (Exception ignored) {}
            try { channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
            // Fallback if extractor didn't expose these — decoder output format
            // will normally update them via INFO_OUTPUT_FORMAT_CHANGED. If even
            // that fails, default to common values so we still produce a curve.
            if (sampleRate <= 0) sampleRate = 44100;
            if (channels <= 0) channels = 1;
            Log.d(TAG, "initial sampleRate=" + sampleRate + " channels=" + channels);

            boolean inputDone = false, outputDone = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

            while (!outputDone) {
                if (!inputDone) {
                    int inIdx = codec.dequeueInputBuffer(TIMEOUT_US);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIdx);
                        int size = inBuf != null ? extractor.readSampleData(inBuf, 0) : -1;
                        long sampleTime = extractor.getSampleTime();
                        if (size < 0 || sampleTime > endUs) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIdx, 0, size, sampleTime, 0);
                            extractor.advance();
                        }
                    }
                }
                int outIdx = codec.dequeueOutputBuffer(info, TIMEOUT_US);
                if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat outFmt = codec.getOutputFormat();
                    try { sampleRate = outFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE); } catch (Exception ignored) {}
                    try { channels = outFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
                    continue;
                }
                if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    if (inputDone) outputDone = true;
                    continue;
                }
                if (outIdx < 0) continue;

                ByteBuffer outBuf = codec.getOutputBuffer(outIdx);
                if (outBuf != null && info.size > 0 && sampleRate > 0 && channels > 0) {
                    outBuf.position(info.offset);
                    outBuf.limit(info.offset + info.size);
                    ByteBuffer le = outBuf.order(ByteOrder.LITTLE_ENDIAN);
                    int nFrames = info.size / 2 / channels;
                    long bufStartUs = info.presentationTimeUs;
                    // microseconds per frame
                    double usPerFrame = 1_000_000.0 / sampleRate;
                    for (int f = 0; f < nFrames; f++) {
                        int peak = 0;
                        for (int c = 0; c < channels; c++) {
                            int s = Math.abs((int) le.getShort());
                            if (s > peak) peak = s;
                        }
                        long t = bufStartUs + (long) (f * usPerFrame);
                        if (t < startUs || t > endUs) continue;
                        int b = (int) (((t - startUs) * outSamples) / totalSpanUs);
                        if (b < 0) b = 0;
                        if (b >= outSamples) b = outSamples - 1;
                        float v = peak / 32768.0f;
                        if (v > buckets[b]) buckets[b] = v;
                    }
                }
                codec.releaseOutputBuffer(outIdx, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
            }
            // Diagnostic: how many buckets ended up non-zero.
            int nz = 0;
            float peak = 0f;
            for (float v : buckets) { if (v > 0) nz++; if (v > peak) peak = v; }
            Log.d(TAG, "decoded: " + nz + "/" + outSamples + " non-zero buckets, peak=" + peak);
            return buckets;
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) {}
            extractor.release();
        }
    }

    /**
     * Transcode (re-encode) the audio in [startUs, endUs] to a fresh AAC-LC
     * .m4a. Used ONLY for files that need the Media3 demuxer fallback (the
     * Audible-style .m4b that Stagefright rejects): for those the passthrough
     * mux in {@link #sliceRange} produces an .m4a that plays SILENT in Anki, so
     * we DECODE to PCM and RE-ENCODE to a clean AAC stream whose csd-0 comes
     * straight from the encoder's output format.
     *
     * Single-threaded, single-loop design (no re-entrant draining):
     *   (A) feed decoder input  (bounded by endUs)
     *   (B) drain ONE decoder output -> trim to [startUs,endUs] -> stash PCM
     *   (C) push stashed PCM into encoder input (non-blocking)
     *   (D) drain ONE encoder output -> MUXER (muxer created lazily HERE from
     *       the encoder's INFO_OUTPUT_FORMAT_CHANGED, which carries csd-0)
     * Output presentation times come from a SINGLE running PCM-frame counter,
     * so they are monotonic + contiguous regardless of decoder-PTS jitter.
     */
    private void sliceReencode(String srcPath, long startUs, long endUs, String outPath) throws Exception {
        Demuxer extractor = openDemuxer(srcPath);
        MediaCodec decoder = null;
        MediaCodec encoder = null;
        MediaMuxer muxer = null;
        try {
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat srcFmt = extractor.getTrackFormat(track);
            String srcMime = srcFmt.getString(MediaFormat.KEY_MIME);
            if (srcMime == null) throw new Exception("audio track has no MIME");
            Log.d(TAG, "sliceReencode: srcMime=" + srcMime + " range="
                + (startUs / 1000) + ".." + (endUs / 1000) + "ms");

            decoder = MediaCodec.createDecoderByType(srcMime);
            decoder.configure(srcFmt, null, null, 0);
            decoder.start();

            int sampleRate = 0, channels = 0;
            try { sampleRate = srcFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);   } catch (Exception ignored) {}
            try { channels   = srcFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}

            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            int outTrack = -1;
            boolean muxerStarted = false;

            boolean extractorDone   = false;
            boolean decoderDone     = false;
            boolean encoderEosQueued = false;
            boolean encoderDone     = false;

            MediaCodec.BufferInfo decInfo = new MediaCodec.BufferInfo();
            MediaCodec.BufferInfo encInfo = new MediaCodec.BufferInfo();

            byte[] pendingPcm = null;
            int pendingOff = 0;
            int pendingLen = 0;
            long outFrames = 0;

            while (!encoderDone) {
                // (A) Feed compressed samples into the DECODER.
                if (!extractorDone) {
                    int inIdx = decoder.dequeueInputBuffer(TIMEOUT_US);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                        int size = inBuf != null ? extractor.readSampleData(inBuf, 0) : -1;
                        long sampleTime = extractor.getSampleTime();
                        if (size < 0 || sampleTime > endUs) {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            extractorDone = true;
                        } else {
                            decoder.queueInputBuffer(inIdx, 0, size, sampleTime, 0);
                            extractor.advance();
                        }
                    }
                }

                // (B) Drain ONE decoder output buffer (only when no PCM queued).
                if (!decoderDone && pendingPcm == null) {
                    int outIdx = decoder.dequeueOutputBuffer(decInfo, TIMEOUT_US);
                    if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        MediaFormat decOut = decoder.getOutputFormat();
                        try { sampleRate = decOut.getInteger(MediaFormat.KEY_SAMPLE_RATE);   } catch (Exception ignored) {}
                        try { channels   = decOut.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
                        if (sampleRate <= 0) sampleRate = 44100;
                        if (channels   <= 0) channels   = 2;
                        Log.d(TAG, "sliceReencode: PCM sampleRate=" + sampleRate + " channels=" + channels);
                        encoder = ensureEncoder(encoder, sampleRate, channels);
                    } else if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        // nothing right now
                    } else if (outIdx >= 0) {
                        boolean decEos = (decInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                        if (encoder == null && sampleRate > 0 && channels > 0) {
                            encoder = ensureEncoder(null, sampleRate, channels);
                        }
                        if (decInfo.size > 0 && encoder != null && sampleRate > 0 && channels > 0) {
                            ByteBuffer decBuf = decoder.getOutputBuffer(outIdx);
                            if (decBuf != null) {
                                int bytesPerFrame = 2 * channels;      // 16-bit PCM
                                double usPerFrame = 1_000_000.0 / sampleRate;
                                long bufStartUs = decInfo.presentationTimeUs;
                                int totalFrames = decInfo.size / bytesPerFrame;
                                int firstFrame = 0, lastFrame = totalFrames; // exclusive
                                for (int f = 0; f < totalFrames; f++) {
                                    long t = bufStartUs + (long) (f * usPerFrame);
                                    if (t < startUs) { firstFrame = f + 1; continue; }
                                    if (t > endUs)   { lastFrame = f; break; }
                                }
                                if (lastFrame > firstFrame) {
                                    int byteOff = decInfo.offset + firstFrame * bytesPerFrame;
                                    int byteLen = (lastFrame - firstFrame) * bytesPerFrame;
                                    pendingPcm = new byte[byteLen];
                                    decBuf.position(byteOff);
                                    decBuf.get(pendingPcm, 0, byteLen);
                                    pendingOff = 0;
                                    pendingLen = byteLen;
                                }
                            }
                        }
                        decoder.releaseOutputBuffer(outIdx, false);
                        if (decEos) decoderDone = true;
                    }
                }

                // (C) Push pending PCM into the encoder input, non-blocking.
                if (encoder != null && pendingPcm != null) {
                    int bytesPerFrame = 2 * channels;
                    while (pendingOff < pendingLen) {
                        int inIdx = encoder.dequeueInputBuffer(TIMEOUT_US);
                        if (inIdx < 0) break; // input full; drain output, retry next loop
                        ByteBuffer encIn = encoder.getInputBuffer(inIdx);
                        if (encIn == null) { encoder.queueInputBuffer(inIdx, 0, 0, 0, 0); continue; }
                        encIn.clear();
                        int chunk = Math.min(encIn.remaining(), pendingLen - pendingOff);
                        chunk -= (chunk % bytesPerFrame); // whole-frame alignment
                        if (chunk <= 0) { encoder.queueInputBuffer(inIdx, 0, 0, 0, 0); break; }
                        long ptUs = (long) (outFrames * 1_000_000.0 / sampleRate);
                        encIn.put(pendingPcm, pendingOff, chunk);
                        encoder.queueInputBuffer(inIdx, 0, chunk, ptUs, 0);
                        pendingOff += chunk;
                        outFrames  += chunk / bytesPerFrame;
                    }
                    if (pendingOff >= pendingLen) { pendingPcm = null; pendingOff = pendingLen = 0; }
                }

                // EOS propagation: only once ALL pending PCM is drained AND the
                // decoder is done (queued opportunistically, retried next loop).
                if (decoderDone && pendingPcm == null && !encoderEosQueued) {
                    if (encoder != null) {
                        int encIn = encoder.dequeueInputBuffer(TIMEOUT_US);
                        if (encIn >= 0) {
                            encoder.queueInputBuffer(encIn, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            encoderEosQueued = true;
                        }
                    } else {
                        encoderDone = true; // no PCM ever decoded -> nothing to encode
                    }
                }

                // (D) Drain ONE encoder output buffer -> MUXER (created lazily here).
                if (encoder != null) {
                    int encOut = encoder.dequeueOutputBuffer(encInfo, TIMEOUT_US);
                    if (encOut == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        MediaFormat encFmtOut = encoder.getOutputFormat();
                        muxer = new MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                        outTrack = muxer.addTrack(encFmtOut);
                        muxer.start();
                        muxerStarted = true;
                    } else if (encOut == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        // nothing right now
                    } else if (encOut >= 0) {
                        ByteBuffer encBuf = encoder.getOutputBuffer(encOut);
                        if ((encInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            encInfo.size = 0; // csd already in the track via addTrack(format)
                        }
                        if (encInfo.size > 0 && encBuf != null && muxerStarted) {
                            encBuf.position(encInfo.offset);
                            encBuf.limit(encInfo.offset + encInfo.size);
                            muxer.writeSampleData(outTrack, encBuf, encInfo);
                        }
                        boolean encEos = (encInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                        encoder.releaseOutputBuffer(encOut, false);
                        if (encEos) encoderDone = true;
                    }
                }

                // Safety: decoder finished, no PCM at all -> stop spinning.
                if (decoderDone && encoder == null && pendingPcm == null) encoderDone = true;
            }
            Log.d(TAG, "sliceReencode: done -> " + outPath + " (muxerStarted=" + muxerStarted + ")");
        } finally {
            try { if (muxer != null) muxer.stop();    } catch (Exception ignored) {}
            try { if (muxer != null) muxer.release(); } catch (Exception ignored) {}
            try { if (encoder != null) { encoder.stop(); encoder.release(); } } catch (Exception ignored) {}
            try { if (decoder != null) { decoder.stop(); decoder.release(); } } catch (Exception ignored) {}
            extractor.release();
        }
    }

    /**
     * Lazily create + start an AAC-LC encoder for the given PCM format. If one
     * already exists it is returned unchanged. csd-0 is produced by the encoder
     * and read from its output format at muxing time.
     */
    private MediaCodec ensureEncoder(MediaCodec existing, int sampleRate, int channels) throws Exception {
        if (existing != null) return existing;
        MediaFormat encFmt = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels);
        encFmt.setInteger(MediaFormat.KEY_AAC_PROFILE,
            android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        encFmt.setInteger(MediaFormat.KEY_BIT_RATE, 128000);
        encFmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024);
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        enc.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        enc.start();
        return enc;
    }
}
