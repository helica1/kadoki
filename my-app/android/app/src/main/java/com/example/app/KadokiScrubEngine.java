package com.example.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Turntable-style drag scrub for Android — the port of KadokiScrubEngine
 * (BackgroundAudioPlugin.swift): a decoded float-PCM window around the anchor
 * is read by a render thread at a fractional position that advances by a
 * signed velocity every sample (4-point Hermite), chasing the finger's target
 * with platter inertia; speed-dependent ducking + low-pass tame fast passes;
 * jumps fade out → move → fade in. Output goes to a float AudioTrack.
 *
 * Decoding uses MediaExtractor/MediaCodec at the file's native rate (the
 * whisper PcmWindowReader resamples to 16 kHz mono, which is no good for
 * playback), via PcmWindowReader's demuxer so odd containers behave the same.
 */
final class KadokiScrubEngine {
    private static final String TAG = "KadokiScrub";
    // First seed is SMALL (±1.2 s ≈ 150 ms of AAC decode on a phone) so sound
    // starts almost at once; the window then grows in the background. ±3 s
    // took 450-700 ms — several hundred ms of silence at every scrub start.
    private static final double PRIME_SEC = 1.2;
    private static final double[] GROW_SEC = { 3, 12, 40, 80 };
    private static final double TAU_SEC = 0.032;
    private static final double MAX_SPEED = 8.0;
    private static final double SNAP_SEC = 0.7;
    private static final double GAIN_RAMP_SEC = 0.012;
    private static final int FRAMES_PER_WRITE = 256;
    // Scrub audio pitched DOWN two octaves (Sonic pitch shift at speed 1×) so
    // the doubled travel per swipe keeps the effect without the squeal.
    private static final float SCRUB_PITCH = 0.5f;   // one octave
    private long pitchH = 0;
    private float[] pitchOut = null;
    // Output queue after the pitch stage (Sonic emits in bursts) + session gain
    // applied on the ACTUAL output so end() silences it at once (see iOS).
    private static final int FIFO_CAP = 16384;
    private float[] pitchFifo = null;
    private int fifoHead = 0, fifoCount = 0;
    private boolean fifoPrimed = false;
    private float masterGain = 0f;
    private int fifoFade = 0, fifoFadeTotal = 1;
    private float pitchSpeed = 1f;

    final String path;
    private final Context ctx;
    private int sampleRate = 44100;
    private int channels = 2;
    private long totalFrames = 0;

    private final Object lock = new Object();
    private float[] bufL = new float[0], bufR = new float[0];
    private long winStart = 0;
    private double pos = 0, target = 0, vel = 0;
    private float gain = 0, gainTarget = 0, vGain = 1, lpL = 0, lpR = 0;
    private boolean snapPending = false, snapArmed = false;
    private int decodeGen = 0;
    private volatile boolean decodeBusy = false;
    private long lastEnsureAt = 0;
    private final ExecutorService decodeQ = Executors.newSingleThreadExecutor();

    private AudioTrack track;
    private Thread renderThread;
    private volatile boolean running = false;
    private float[] outBuf;
    // Persistent decoder (decode thread only): opening a demuxer + creating
    // and configuring a MediaCodec per window cost 400-1000 ms on a Galaxy
    // Fold — the whole "audio lags the finger" on Android. Keep both open and
    // seek/flush between windows instead.
    private PcmWindowReader.Demuxer dEx = null;
    private MediaCodec dCodec = null;
    private int dTrack = -1;
    private int dCh = 2, dSr = 44100;

    KadokiScrubEngine(Context ctx, String path) {
        this.ctx = ctx.getApplicationContext();
        this.path = path;
        probeFormat();
    }

    private void probeFormat() {
        try {
            PcmWindowReader.Demuxer ex = PcmWindowReader.openDemuxer(ctx, path);
            try {
                int t = PcmWindowReader.findAudioTrack(ex);
                if (t >= 0) {
                    MediaFormat f = ex.getTrackFormat(t);
                    try { sampleRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE); } catch (Exception ignored) {}
                    try { channels = Math.min(2, Math.max(1, f.getInteger(MediaFormat.KEY_CHANNEL_COUNT))); } catch (Exception ignored) {}
                    try { totalFrames = (long) (f.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0 * sampleRate); } catch (Exception ignored) {}
                }
            } finally { ex.release(); }
        } catch (Exception e) { Log.w(TAG, "probe failed", e); }
        if (totalFrames <= 0) totalFrames = Long.MAX_VALUE / 4;
    }

    double currentMs() { synchronized (lock) { return pos / sampleRate * 1000.0; } }

    private boolean isWarm(long frame) {
        if (!running) return false;
        long ws, len;
        synchronized (lock) { ws = winStart; len = bufL.length; }
        long m = (long) (0.9 * sampleRate);   // < PRIME_SEC, else a fresh seed never counts as warm
        return frame - m >= ws && frame + m <= ws + len;
    }

    // ---- rolling warm window (playback follow) ----
    // Called ~every 600 ms by the plugin's position poll while the UI is
    // visible and audio plays: keeps [pos-3 s, pos+8 s] decoded so a scrub
    // starts with sound at once (a cold seed costs ~500 ms of MediaCodec
    // seek+decode on a phone — "silent for several hundred ms"). Forward
    // growth appends 8 s chunks; the window is trimmed to ~60 s behind.
    private static final double FOLLOW_AHEAD_SEC = 8.0, FOLLOW_BACK_SEC = 3.0, FOLLOW_CHUNK_SEC = 8.0, FOLLOW_MAX_BACK_SEC = 60.0;
    private long followLastAt = 0;
    void follow(double ms) {
        if (decodeBusy) return;
        long now = System.currentTimeMillis();
        if (now - followLastAt < 400) return;
        followLastAt = now;
        final long f = clampFrame(ms);
        long ws, len; final int gen;
        synchronized (lock) { ws = winStart; len = bufL.length; gen = decodeGen; }
        boolean inside = len > 0 && f >= ws && f < ws + len;
        if (inside && ws + len - f >= (long) (FOLLOW_AHEAD_SEC * sampleRate)) return;
        final boolean ins = inside;
        decodeQ.execute(() -> {
            if (ins) growTo(Math.max(0, f - (long) (FOLLOW_BACK_SEC * sampleRate)), Math.min(totalFrames, f + (long) ((FOLLOW_AHEAD_SEC + FOLLOW_CHUNK_SEC) * sampleRate)), gen, true);
            else loadWindow(f, FOLLOW_BACK_SEC + 1.0, gen);
        });
    }

    /** Extend the window to cover [wantStart, wantEnd); optionally drop audio further than FOLLOW_MAX_BACK_SEC behind wantStart. Decode thread only. */
    private boolean growTo(long wantStart, long wantEnd, int gen, boolean trimBack) {
        decodeBusy = true;
        try {
            float[] curL, curR; long ws;
            synchronized (lock) { if (gen != decodeGen) return false; curL = bufL; curR = bufR; ws = winStart; }
            long curEnd = ws + curL.length;
            float[][] back = wantStart < ws ? decode(wantStart, ws) : null;
            float[][] fwd = wantEnd > curEnd ? decode(curEnd, wantEnd) : null;
            if (back == null && fwd == null) return true;
            int bl = back != null ? back[0].length : 0, fl = fwd != null ? fwd[0].length : 0;
            long newStart = ws - bl;
            int dropFront = 0;
            if (trimBack) {
                long keepFrom = wantStart - (long) (FOLLOW_MAX_BACK_SEC * sampleRate);
                if (keepFrom > newStart) dropFront = (int) Math.min(bl + curL.length, keepFrom - newStart);
            }
            int n = bl + curL.length + fl - dropFront;
            float[] nl = new float[n], nr = new float[n];
            int o = 0, skip = dropFront;
            if (bl > 0) { int take = Math.max(0, bl - skip); System.arraycopy(back[0], bl - take, nl, 0, take); System.arraycopy(back[1], bl - take, nr, 0, take); o = take; skip = Math.max(0, skip - bl); }
            { int take = curL.length - skip; System.arraycopy(curL, skip, nl, o, take); System.arraycopy(curR, skip, nr, o, take); o += take; }
            if (fl > 0) { System.arraycopy(fwd[0], 0, nl, o, fl); System.arraycopy(fwd[1], 0, nr, o, fl); }
            synchronized (lock) {
                boolean same = gen == decodeGen && winStart == ws && bufL.length == curL.length;
                if (same) { bufL = nl; bufR = nr; winStart = newStart + dropFront; }
                return same;
            }
        } finally { decodeBusy = false; }
    }

    boolean prime(double ms) {
        long anchor = clampFrame(ms);
        if (isWarm(anchor)) { synchronized (lock) { gainTarget = 0; decodeGen++; } return true; }
        return start(anchor, false);
    }

    private boolean everBegan = false;
    boolean begin(double ms) {
        everBegan = true;
        long anchor = clampFrame(ms);
        if (isWarm(anchor)) {
            final int gen;
            synchronized (lock) {
                pos = anchor; target = anchor; vel = 0; gain = 0; gainTarget = 0; snapPending = false;
                decodeGen++; gen = decodeGen;
            }
            decodeQ.execute(() -> { for (double h : GROW_SEC) if (!grow(h, gen)) break; });
            return true;
        }
        return start(anchor, true);
    }

    private long clampFrame(double ms) {
        return (long) Math.max(0, Math.min((double) totalFrames, ms / 1000.0 * sampleRate));
    }

    private boolean start(long anchor, boolean grow) {
        final int gen;
        synchronized (lock) {
            pos = anchor; target = anchor; vel = 0; gain = 0; gainTarget = 0; snapPending = false;
            lpL = 0; lpR = 0; vGain = 1; snapArmed = false;
            decodeGen++; gen = decodeGen;
        }
        if (!ensureTrack()) return false;
        // Seed decode is ASYNC: the render loop plays silence (gain 0) until
        // the window lands, then the first target fades the audio in — no
        // caller ever waits on MediaCodec.
        final boolean growAfter = grow;
        decodeQ.execute(() -> {
            long t0 = System.currentTimeMillis();
            loadWindow(anchor, PRIME_SEC, gen);
            Log.d(TAG, "prime window " + (System.currentTimeMillis() - t0) + " ms");
            if (growAfter) { for (double h : GROW_SEC) if (!grow(h, gen)) break; }
        });
        return true;
    }

    void setTarget(double ms, boolean snap) {
        double f = Math.max(0, Math.min((double) totalFrames, ms / 1000.0 * sampleRate));
        long ws, len; final int gen;
        synchronized (lock) {
            target = f;
            if (snap) snapPending = true;
            gainTarget = 1f;
            ws = winStart; len = bufL.length; gen = decodeGen;
        }
        double margin = 2.0 * sampleRate;
        long now = System.currentTimeMillis();
        if ((f < ws + margin || f > ws + len - margin) && !decodeBusy && now - lastEnsureAt > 60) {
            lastEnsureAt = now;
            final boolean inside = f >= ws && f < ws + len;
            final long ff = (long) f;
            decodeQ.execute(() -> {
                if (inside) { grow(GROW_SEC[GROW_SEC.length - 1], gen); }
                else { loadWindow(ff, PRIME_SEC, gen); for (double h : GROW_SEC) if (!grow(h, gen)) break; }
            });
        }
    }

    void end() {
        final int endGen;
        synchronized (lock) { gainTarget = 0; decodeGen++; endGen = decodeGen; }
        // Stay running (silent) a while so consecutive swipes reuse the track.
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            synchronized (lock) { if (decodeGen != endGen) return; }
            stopTrack();
            everBegan = false;
            synchronized (lock) { bufL = new float[0]; bufR = new float[0]; }
        }, everBegan ? 6000 : 1200);
    }

    void release() {
        stopTrack();
        decodeQ.execute(this::closeDecoder);
        decodeQ.shutdown();
    }

    private void closeDecoder() {
        if (dCodec != null) { try { dCodec.stop(); } catch (Exception ignored) {} try { dCodec.release(); } catch (Exception ignored) {} dCodec = null; }
        if (dEx != null) { dEx.release(); dEx = null; }
        dTrack = -1;
    }

    /** Decode thread only. Opens the demuxer + codec once; later windows just seek + flush. */
    private boolean ensureDecoder() {
        if (dCodec != null && dEx != null) return true;
        closeDecoder();
        try {
            long t0 = System.currentTimeMillis();
            dEx = PcmWindowReader.openDemuxer(ctx, path);
            dTrack = PcmWindowReader.findAudioTrack(dEx);
            if (dTrack < 0) { closeDecoder(); return false; }
            dEx.selectTrack(dTrack);
            MediaFormat fmt = dEx.getTrackFormat(dTrack);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            dCodec = MediaCodec.createDecoderByType(mime);
            dCodec.configure(fmt, null, null, 0);
            dCodec.start();
            dCh = channels; dSr = sampleRate;
            Log.d(TAG, "decoder open " + (System.currentTimeMillis() - t0) + " ms (" + mime + ")");
            return true;
        } catch (Exception e) { Log.w(TAG, "decoder open failed", e); closeDecoder(); return false; }
    }

    // ---- AudioTrack + render thread ----

    private boolean ensureTrack() {
        if (running) return true;
        try {
            int minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT);
            int bufBytes = Math.max(minBuf, FRAMES_PER_WRITE * 2 * 4 * 2);
            Log.d(TAG, "AudioTrack minBuf=" + (minBuf / 8) + " frames, using " + (bufBytes / 8) + " frames (" + Math.round(bufBytes / 8.0 * 1000 / sampleRate) + " ms)");
            track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                .setBufferSizeInBytes(bufBytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .build();
            track.play();
        } catch (Exception e) { Log.e(TAG, "AudioTrack failed", e); track = null; return false; }
        outBuf = new float[FRAMES_PER_WRITE * 2];
        pitchOut = new float[4096 * 2];
        if (pitchH == 0 && SpeedyNative.load()) {
            try {
                pitchH = SpeedyNative.create((int) sampleRate, 2);
                if (pitchH != 0) { SpeedyNative.setSpeed(pitchH, 1f); SpeedyNative.setPitch(pitchH, SCRUB_PITCH); }
            } catch (Throwable t) { pitchH = 0; }
        }
        running = true;
        renderThread = new Thread(this::renderLoop, "kadoki-scrub-render");
        renderThread.setPriority(Thread.MAX_PRIORITY);
        renderThread.start();
        return true;
    }

    private void stopTrack() {
        running = false;
        Thread t = renderThread; renderThread = null;
        if (t != null) { try { t.join(300); } catch (InterruptedException ignored) {} }
        AudioTrack tr = track; track = null;
        if (tr != null) { try { tr.pause(); tr.flush(); tr.release(); } catch (Exception ignored) {} }
        if (pitchH != 0) { try { SpeedyNative.destroy(pitchH); } catch (Throwable ignored) {} pitchH = 0; }
    }

    private void renderLoop() {
        while (running) {
            AudioTrack tr = track;
            if (tr == null) break;
            render(outBuf, FRAMES_PER_WRITE);
            float[] w = outBuf;
            float gTi; synchronized (lock) { gTi = gainTarget; }
            if (gTi <= 0f && masterGain <= 0.0005f) {   // idle: nothing audible → skip the pitch stage
                if (fifoPrimed || fifoCount > 0) { fifoPrimed = false; fifoCount = 0; fifoHead = 0; }
                java.util.Arrays.fill(outBuf, 0f);
                try { tr.write(outBuf, 0, FRAMES_PER_WRITE * 2, AudioTrack.WRITE_BLOCKING); } catch (Exception e) { break; }
                continue;
            }
            if (pitchH != 0) {
                try {
                    if (pitchFifo == null) pitchFifo = new float[FIFO_CAP * 2];
                    SpeedyNative.writeFloat(pitchH, outBuf, FRAMES_PER_WRITE);
                    for (int it = 0; it < 8; it++) {
                        int avail = SpeedyNative.available(pitchH), room = FIFO_CAP - fifoCount;
                        if (avail <= 0 || room <= 0) break;
                        int want = Math.min(avail, Math.min(room, pitchOut.length / 2));
                        int got = SpeedyNative.readFloat(pitchH, pitchOut, want);
                        if (got <= 0) break;
                        int wi = (fifoHead + fifoCount) % FIFO_CAP;
                        for (int i = 0; i < got; i++) { pitchFifo[2 * wi] = pitchOut[2 * i]; pitchFifo[2 * wi + 1] = pitchOut[2 * i + 1]; if (++wi == FIFO_CAP) wi = 0; }
                        fifoCount += got;
                    }
                    int setpoint = FRAMES_PER_WRITE + 2048, dev = fifoCount - setpoint;
                    float wantSpd = dev > 1024 ? 1.03f : (dev < -1024 ? 0.97f : 1f);
                    if (wantSpd != pitchSpeed) { pitchSpeed = wantSpd; SpeedyNative.setSpeed(pitchH, wantSpd); }
                    if (fifoCount > FIFO_CAP - 2048) { int drop = fifoCount - setpoint; fifoHead = (fifoHead + drop) % FIFO_CAP; fifoCount -= drop; }
                    if (!fifoPrimed && fifoCount >= setpoint) { fifoPrimed = true; fifoFadeTotal = Math.max(1, (int) (0.008 * sampleRate)); fifoFade = fifoFadeTotal; }
                    if (fifoPrimed && fifoCount >= FRAMES_PER_WRITE) {
                        int h = fifoHead;
                        for (int i = 0; i < FRAMES_PER_WRITE; i++) {
                            float k = 1f;
                            if (fifoFade > 0) { k = 1f - (float) fifoFade / (float) fifoFadeTotal; fifoFade--; }
                            pitchOut[2 * i] = pitchFifo[2 * h] * k; pitchOut[2 * i + 1] = pitchFifo[2 * h + 1] * k;
                            if (++h == FIFO_CAP) h = 0;
                        }
                        fifoHead = h; fifoCount -= FRAMES_PER_WRITE;
                    } else {
                        fifoPrimed = false;
                        java.util.Arrays.fill(pitchOut, 0, FRAMES_PER_WRITE * 2, 0f);
                    }
                    w = pitchOut;
                } catch (Throwable ignored) { w = outBuf; }
            }
            // Session gain on the actual output (begin → 1, end/prime → 0).
            float gT; synchronized (lock) { gT = gainTarget; }
            float gStep = (float) (1.0 / (GAIN_RAMP_SEC * sampleRate)), mg = masterGain;
            for (int i = 0; i < FRAMES_PER_WRITE; i++) {
                if (mg < gT) mg = Math.min(gT, mg + gStep); else if (mg > gT) mg = Math.max(gT, mg - gStep);
                w[2 * i] *= mg; w[2 * i + 1] *= mg;
            }
            masterGain = mg;
            try { tr.write(w, 0, FRAMES_PER_WRITE * 2, AudioTrack.WRITE_BLOCKING); }
            catch (Exception e) { break; }
        }
    }

    private void render(float[] out, int count) {
        float[] l, r; long ws; double tgt; boolean snap; float gT;
        synchronized (lock) {
            l = bufL; r = bufR; ws = winStart; tgt = target; gT = gainTarget;
            snap = snapPending; snapPending = false;
        }
        int len = l.length;
        float g = gain;
        if (snap || Math.abs(tgt - pos) > SNAP_SEC * sampleRate) snapArmed = true;
        double desired = (tgt - pos) / (TAU_SEC * sampleRate);
        if (desired > MAX_SPEED) desired = MAX_SPEED; else if (desired < -MAX_SPEED) desired = -MAX_SPEED;
        if (Math.abs(tgt - pos) < 0.75) desired = 0;
        double v0 = vel, dv = (desired - v0) / count;
        float gStep = (float) (1.0 / (GAIN_RAMP_SEC * sampleRate));
        double sp = Math.abs(desired);
        float vgTarget = sp <= 1.5 ? 1f : (float) Math.max(0.2, 1.0 - (sp - 1.5) / 5.5);
        float vg0 = vGain, dvg = (vgTarget - vg0) / count;
        double fc = Math.min(18000.0, Math.max(3000.0, 12000.0 / Math.max(1.0, sp * 0.5)));   // lighter: the pitch drop tames the harshness
        float a = (float) (1.0 - Math.exp(-2.0 * Math.PI * fc / sampleRate));
        float yl = lpL, yr = lpR;
        double wsD = ws;
        for (int i = 0; i < count; i++) {
            if (snapArmed && g <= 0.0005f) { pos = tgt; vel = 0; snapArmed = false; }
            else { vel = v0 + dv * (i + 1); pos += vel; }
            float sl = 0, sr = 0;
            double rel = pos - wsD;
            boolean avail = len >= 4 && rel >= 1 && rel < len - 2;
            if (avail) {
                int i0 = (int) rel;
                float f = (float) (rel - i0);
                sl = hermite(l[i0 - 1], l[i0], l[i0 + 1], l[i0 + 2], f);
                sr = hermite(r[i0 - 1], r[i0], r[i0 + 1], r[i0 + 2], f);
            }
            yl += a * (sl - yl);
            yr += a * (sr - yr);
            float wantG = (snapArmed || !avail) ? 0f : 1f;   // session gain is applied post-pitch (masterGain)
            if (g < wantG) g = Math.min(wantG, g + gStep); else if (g > wantG) g = Math.max(wantG, g - gStep);
            float vg = vg0 + dvg * (i + 1);
            out[2 * i] = yl * g * vg;
            out[2 * i + 1] = yr * g * vg;
        }
        lpL = yl; lpR = yr; vGain = vgTarget; gain = g;
        if (pos < 0) { pos = 0; vel = 0; }
        if (pos > totalFrames) { pos = totalFrames; vel = 0; }
    }

    private static float hermite(float xm1, float x0, float x1, float x2, float t) {
        float c = (x1 - xm1) * 0.5f, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5f, b = w + a;
        return ((((a * t) - b) * t + c) * t + x0);
    }

    // ---- decode ----

    private void loadWindow(long center, double halfSec, int gen) {
        decodeBusy = true;
        try {
            long half = (long) (halfSec * sampleRate);
            long start = Math.max(0, center - half), end = Math.min(totalFrames, center + half);
            float[][] pcm = decode(start, end);
            if (pcm == null) return;
            synchronized (lock) { if (gen == decodeGen) { bufL = pcm[0]; bufR = pcm[1]; winStart = start; } }
        } finally { decodeBusy = false; }
    }

    private boolean grow(double halfSec, int gen) {
        decodeBusy = true;
        try {
            float[] curL, curR; long ws, p;
            synchronized (lock) { if (gen != decodeGen) return false; curL = bufL; curR = bufR; ws = winStart; p = (long) pos; }
            long half = (long) (halfSec * sampleRate);
            long wantStart = Math.max(0, p - half), wantEnd = Math.min(totalFrames, p + half);
            long curEnd = ws + curL.length;
            float[][] back = wantStart < ws ? decode(wantStart, ws) : null;
            float[][] fwd = wantEnd > curEnd ? decode(curEnd, wantEnd) : null;
            if (back == null && fwd == null) return true;
            int n = (back != null ? back[0].length : 0) + curL.length + (fwd != null ? fwd[0].length : 0);
            float[] nl = new float[n], nr = new float[n];
            int o = 0; long newStart = ws;
            if (back != null) { System.arraycopy(back[0], 0, nl, 0, back[0].length); System.arraycopy(back[1], 0, nr, 0, back[1].length); o = back[0].length; newStart = ws - back[0].length; }
            System.arraycopy(curL, 0, nl, o, curL.length); System.arraycopy(curR, 0, nr, o, curR.length); o += curL.length;
            if (fwd != null) { System.arraycopy(fwd[0], 0, nl, o, fwd[0].length); System.arraycopy(fwd[1], 0, nr, o, fwd[1].length); }
            synchronized (lock) {
                boolean same = gen == decodeGen && winStart == ws && bufL.length == curL.length;
                if (same) { bufL = nl; bufR = nr; winStart = newStart; }
                return same;
            }
        } finally { decodeBusy = false; }
    }

    /** Decode [startFrame, endFrame) to two float channels at the native rate. Decode thread only. */
    private float[][] decode(long startFrame, long endFrame) {
        if (endFrame <= startFrame) return null;
        if (!ensureDecoder()) return null;
        long startUs = (long) (startFrame * 1_000_000.0 / sampleRate);
        long endUs = (long) (endFrame * 1_000_000.0 / sampleRate);
        int cap = (int) Math.min(Integer.MAX_VALUE / 8, endFrame - startFrame + 4096);
        float[] L = new float[cap], R = new float[cap];
        int n = 0;
        PcmWindowReader.Demuxer ex = dEx; MediaCodec codec = dCodec;
        try {
            long t0 = System.currentTimeMillis();
            codec.flush();
            ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            int ch = dCh, sr = dSr;
            boolean inputDone = false, outputDone = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int idle = 0;
            while (!outputDone) {
                if (!inputDone) {
                    int inIdx = codec.dequeueInputBuffer(PcmWindowReader.TIMEOUT_US);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIdx);
                        int size = inBuf != null ? ex.readSampleData(inBuf, 0) : -1;
                        long st = ex.getSampleTime();
                        if (size < 0 || st > endUs) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIdx, 0, size, st, 0);
                            ex.advance();
                        }
                    }
                }
                int outIdx = codec.dequeueOutputBuffer(info, PcmWindowReader.TIMEOUT_US);
                if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    try { sr = of.getInteger(MediaFormat.KEY_SAMPLE_RATE); } catch (Exception ignored) {}
                    try { ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT); } catch (Exception ignored) {}
                    dCh = ch; dSr = sr;
                    continue;
                }
                if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) { if (inputDone && ++idle > 50) outputDone = true; continue; }
                if (outIdx < 0) continue;
                idle = 0;
                ByteBuffer ob = codec.getOutputBuffer(outIdx);
                if (ob != null && info.size > 0) {
                    ob.position(info.offset); ob.limit(info.offset + info.size);
                    ByteBuffer le = ob.order(ByteOrder.LITTLE_ENDIAN);
                    int frames = info.size / 2 / ch;
                    long bufStartUs = info.presentationTimeUs;
                    double usPerFrame = 1_000_000.0 / sr;
                    for (int f = 0; f < frames; f++) {
                        long tUs = bufStartUs + (long) (f * usPerFrame);
                        float s0 = le.getShort() / 32768f;
                        float s1 = ch > 1 ? le.getShort() / 32768f : s0;
                        for (int c = 2; c < ch; c++) le.getShort();
                        if (tUs < startUs || tUs >= endUs) continue;
                        if (n < cap) { L[n] = s0; R[n] = s1; n++; }
                    }
                }
                codec.releaseOutputBuffer(outIdx, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                if (n >= cap) outputDone = true;
            }
            // EOS was queued: the codec must be flushed before the next window
            // (done at the top of the next decode()).
            Log.d(TAG, "decode " + Math.round((endFrame - startFrame) * 1000.0 / sampleRate) + " ms of audio in " + (System.currentTimeMillis() - t0) + " ms");
        } catch (Exception e) {
            Log.w(TAG, "decode failed @" + startFrame + " — reopening decoder", e);
            closeDecoder();
            return null;
        }
        if (n == 0) return null;
        float[] l2 = new float[n], r2 = new float[n];
        System.arraycopy(L, 0, l2, 0, n); System.arraycopy(R, 0, r2, 0, n);
        return new float[][] { l2, r2 };
    }
}
