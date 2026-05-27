package com.example.app;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.util.Base64;
import android.util.Log;

import java.io.FileOutputStream;

import androidx.annotation.NonNull;

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
            // Detect source MIME first; MP3 needs raw-frame copy (MediaMuxer
            // for MP4 container can't accept MP3 frames — throws
            // "Failed to add the track to the muxer").
            MediaExtractor probe = new MediaExtractor();
            String mime;
            try {
                probe.setDataSource(srcPath);
                int t = findAudioTrack(probe);
                if (t < 0) throw new Exception("no audio track in " + srcPath);
                mime = probe.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
            } finally {
                try { probe.release(); } catch (Exception ignored) {}
            }
            Log.d(TAG, "slice: mime=" + mime);
            String outName, outMime;
            File outFile;
            if (mime != null && mime.equalsIgnoreCase("audio/mpeg")) {
                outName = "slice_" + System.currentTimeMillis() + ".mp3";
                outFile = new File(getContext().getCacheDir(), outName);
                sliceMp3Frames(srcPath, startMs * 1000, endMs * 1000, outFile.getAbsolutePath());
                outMime = "audio/mpeg";
            } else {
                outName = "slice_" + System.currentTimeMillis() + ".m4a";
                outFile = new File(getContext().getCacheDir(), outName);
                sliceRange(srcPath, startMs * 1000, endMs * 1000, outFile.getAbsolutePath());
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
    private static void sliceMp3Frames(String srcPath, long startUs, long endUs, String outPath) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        FileOutputStream out = null;
        try {
            extractor.setDataSource(srcPath);
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
            try { extractor.release(); } catch (Exception ignored) {}
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
    private static int findAudioTrack(MediaExtractor ex) {
        for (int i = 0; i < ex.getTrackCount(); i++) {
            MediaFormat f = ex.getTrackFormat(i);
            String mime = f.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) return i;
        }
        return -1;
    }

    /** Passthrough mux of samples in [startUs, endUs] to outPath. */
    private static void sliceRange(String srcPath, long startUs, long endUs, String outPath) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaMuxer muxer = null;
        try {
            extractor.setDataSource(srcPath);
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat fmt = extractor.getTrackFormat(track);
            muxer = new MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
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
                info.flags = extractor.getSampleFlags();
                muxer.writeSampleData(outTrack, buf, info);
                if (!extractor.advance()) break;
            }
        } finally {
            try { if (muxer != null) { muxer.stop(); muxer.release(); } } catch (Exception ignored) {}
            try { extractor.release(); } catch (Exception ignored) {}
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
    private static float[] decodeWaveform(String srcPath, long startUs, long endUs, int outSamples) throws Exception {
        if (outSamples <= 0) outSamples = 200;
        Log.d(TAG, "decodeWaveform: src=" + srcPath + " range=" + (startUs / 1000) + ".." + (endUs / 1000) + "ms target=" + outSamples);

        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try {
            extractor.setDataSource(srcPath);
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat fmt = extractor.getTrackFormat(track);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            Log.d(TAG, "track=" + track + " mime=" + mime + " fmt=" + fmt);
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
            try { extractor.release(); } catch (Exception ignored) {}
        }
    }
}
