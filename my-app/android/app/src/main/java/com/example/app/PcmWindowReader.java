package com.example.app;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.MediaExtractorCompat;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Decodes one absolute time window of an audio file to 16 kHz mono float PCM
 * for whisper. Same demux strategy AudioSlicer proved on Audible .m4b:
 * platform MediaExtractor first, Media3 MediaExtractorCompat fallback.
 *
 * Stateless per call — AutoTranscribe re-opens per ~30 s window. Decode of a
 * 30 s AAC window is well under a second; whisper dominates by an order of
 * magnitude, so the reopen cost is irrelevant and the code stays simple.
 */
@OptIn(markerClass = UnstableApi.class)
final class PcmWindowReader {

    private static final String TAG = "PcmWindowReader";
    private static final int TIMEOUT_US = 10000;
    static final int WHISPER_RATE = 16000;

    static final class Window {
        final float[] pcm;      // 16 kHz mono, exactly the in-range samples
        final boolean eof;      // true if the file ended inside this window
        Window(float[] pcm, boolean eof) { this.pcm = pcm; this.eof = eof; }
    }

    // ----- demuxer abstraction (mirrors AudioSlicerPlugin) -----

    private interface Demuxer {
        int getTrackCount();
        MediaFormat getTrackFormat(int i);
        void selectTrack(int i);
        void seekTo(long timeUs, int mode);
        long getSampleTime();
        int readSampleData(ByteBuffer buffer, int offset);
        boolean advance();
        void release();
    }

    private static final class NativeDemuxer implements Demuxer {
        private final MediaExtractor ex = new MediaExtractor();
        NativeDemuxer(String srcPath) throws Exception { ex.setDataSource(srcPath); }
        public int getTrackCount() { return ex.getTrackCount(); }
        public MediaFormat getTrackFormat(int i) { return ex.getTrackFormat(i); }
        public void selectTrack(int i) { ex.selectTrack(i); }
        public void seekTo(long t, int m) { ex.seekTo(t, m); }
        public long getSampleTime() { return ex.getSampleTime(); }
        public int readSampleData(ByteBuffer b, int o) { return ex.readSampleData(b, o); }
        public boolean advance() { return ex.advance(); }
        public void release() { try { ex.release(); } catch (Exception ignored) {} }
    }

    private static final class Media3Demuxer implements Demuxer {
        private final MediaExtractorCompat ex;
        Media3Demuxer(Context ctx, String srcPath) throws Exception {
            ex = new MediaExtractorCompat(ctx);
            ex.setDataSource(Uri.fromFile(new File(srcPath)), 0L);
        }
        public int getTrackCount() { return ex.getTrackCount(); }
        public MediaFormat getTrackFormat(int i) { return ex.getTrackFormat(i); }
        public void selectTrack(int i) { ex.selectTrack(i); }
        public void seekTo(long t, int m) { ex.seekTo(t, m); }
        public long getSampleTime() { return ex.getSampleTime(); }
        public int readSampleData(ByteBuffer b, int o) { return ex.readSampleData(b, o); }
        public boolean advance() { return ex.advance(); }
        public void release() { try { ex.release(); } catch (Exception ignored) {} }
    }

    private static int findAudioTrack(Demuxer ex) {
        try {
            for (int i = 0; i < ex.getTrackCount(); i++) {
                String mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) return i;
            }
        } catch (Exception ignored) {}
        return -1;
    }

    private static Demuxer openDemuxer(Context appCtx, String srcPath) throws Exception {
        try {
            NativeDemuxer d = null;
            try {
                d = new NativeDemuxer(srcPath);
                if (findAudioTrack(d) < 0) throw new Exception("no audio track (native)");
                Demuxer ok = d; d = null; return ok;
            } finally {
                if (d != null) d.release();
            }
        } catch (Throwable nativeFail) {
            Log.w(TAG, "platform MediaExtractor failed (" + nativeFail.getMessage()
                    + "); Media3 fallback for " + srcPath);
        }
        Media3Demuxer d = null;
        try {
            d = new Media3Demuxer(appCtx, srcPath);
            if (findAudioTrack(d) < 0) throw new Exception("no audio track (media3 fallback)");
            Demuxer ok = d; d = null; return ok;
        } finally {
            if (d != null) d.release();
        }
    }

    /**
     * Duration in ms via the audio track format, with a MediaMetadataRetriever
     * fallback (0 only if both fail). A 0 duration never finalizes the SRT on
     * the JS side, so this probe matters.
     */
    static long probeDurationMs(Context appCtx, String srcPath) {
        Demuxer d = null;
        try {
            d = openDemuxer(appCtx, srcPath);
            int t = findAudioTrack(d);
            if (t >= 0) {
                MediaFormat f = d.getTrackFormat(t);
                long us = f.containsKey(MediaFormat.KEY_DURATION) ? f.getLong(MediaFormat.KEY_DURATION) : 0;
                if (us > 0) return us / 1000;
            }
        } catch (Exception ignored) {
        } finally {
            if (d != null) d.release();
        }
        android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
        try {
            r.setDataSource(srcPath);
            String ms = r.extractMetadata(
                    android.media.MediaMetadataRetriever.METADATA_KEY_DURATION);
            return ms != null ? Math.max(0, Long.parseLong(ms)) : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            try { r.release(); } catch (Exception ignored) {}
        }
    }

    /**
     * Decode [fromMs, fromMs+windowMs) to 16 kHz mono float.
     * eof=true when the stream ended before the window filled.
     */
    static Window readWindow(Context appCtx, String srcPath, long fromMs, long windowMs) throws Exception {
        long startUs = fromMs * 1000;
        long endUs = (fromMs + windowMs) * 1000;
        Demuxer extractor = openDemuxer(appCtx, srcPath);
        MediaCodec codec = null;
        try {
            int track = findAudioTrack(extractor);
            if (track < 0) throw new Exception("no audio track in " + srcPath);
            extractor.selectTrack(track);
            MediaFormat fmt = extractor.getTrackFormat(track);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime == null) throw new Exception("audio track has no MIME");
            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            int sampleRate = 0, channels = 0;
            try { sampleRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE); } catch (Exception ignored) {}
            try { channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
            if (sampleRate <= 0) sampleRate = 44100;
            if (channels <= 0) channels = 1;

            int outCap = (int) (windowMs * WHISPER_RATE / 1000) + 64;
            float[] out = new float[outCap];
            int outLen = 0;
            // Linear-resampler cursor: absolute source-sample position of the
            // NEXT output sample, advanced by srcRate/16000 per output sample.
            double step = 0;
            double nextSrcPos = 0;      // in source frames since first in-range frame
            long framesSeen = 0;        // in-range mono frames consumed so far
            float prevSample = 0f;      // last frame of the previous buffer (for interp)
            boolean sawInRange = false;
            boolean inputDone = false, outputDone = false, hitEnd = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

            while (!outputDone) {
                if (!inputDone) {
                    int inIdx = codec.dequeueInputBuffer(TIMEOUT_US);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIdx);
                        int size = inBuf != null ? extractor.readSampleData(inBuf, 0) : -1;
                        long sampleTime = extractor.getSampleTime();
                        if (size < 0 || sampleTime > endUs) {
                            if (size >= 0) hitEnd = true; // window boundary, not file end
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
                    if (step == 0) step = (double) sampleRate / WHISPER_RATE;
                    outBuf.position(info.offset);
                    outBuf.limit(info.offset + info.size);
                    ByteBuffer le = outBuf.order(ByteOrder.LITTLE_ENDIAN);
                    int nFrames = info.size / 2 / channels;
                    long bufStartUs = info.presentationTimeUs;
                    double usPerFrame = 1_000_000.0 / sampleRate;
                    for (int f = 0; f < nFrames; f++) {
                        int acc = 0;
                        for (int c = 0; c < channels; c++) acc += le.getShort();
                        float mono = (acc / (float) channels) / 32768.0f;
                        long tUs = bufStartUs + (long) (f * usPerFrame);
                        if (tUs < startUs || tUs >= endUs) continue;
                        sawInRange = true;
                        // Emit every output sample whose source position falls
                        // within (framesSeen-1, framesSeen].
                        while (nextSrcPos <= framesSeen && outLen < outCap) {
                            float v;
                            if (framesSeen == 0) {
                                v = mono;
                            } else {
                                double frac = nextSrcPos - (framesSeen - 1);
                                v = (float) (prevSample + (mono - prevSample) * frac);
                            }
                            out[outLen++] = v;
                            nextSrcPos += step;
                        }
                        prevSample = mono;
                        framesSeen++;
                    }
                }
                codec.releaseOutputBuffer(outIdx, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                if (outLen >= outCap) { outputDone = true; }
            }

            boolean eof = !hitEnd; // stream ended before we crossed endUs
            float[] pcm = new float[outLen];
            System.arraycopy(out, 0, pcm, 0, outLen);
            if (!sawInRange && !eof) {
                // Decoder produced nothing inside the window (corrupt region?)
                // — report as EOF-equivalent so the job doesn't spin.
                Log.w(TAG, "readWindow: no in-range PCM at " + fromMs + "ms");
            }
            return new Window(pcm, eof);
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) {}
            extractor.release();
        }
    }
}
