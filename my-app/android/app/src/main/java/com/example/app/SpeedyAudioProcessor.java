package com.example.app;

import android.util.Log;

import androidx.media3.common.C;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.AudioProcessorChain;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * ExoPlayer audio processor that runs 16-bit PCM through the native
 * Speedy/Sonic stream (speedy_jni.cpp). Replaces ExoPlayer's own Java Sonic
 * for playback-speed changes (same algorithm family), and adds Google
 * Speedy's nonlinear (MACH1-style) compression when {@link #setNonlinear}
 * is on — vowels/pauses are compressed harder than consonant transitions
 * while the requested AVERAGE speed is held.
 *
 * Position mapping: the sink asks {@link Chain#getMediaDuration(long)} to
 * turn played-out time since the last speed checkpoint back into media time.
 * Sonic's built-in processor scales by the cumulative byte ratio; with
 * nonlinear speed that is off by up to the local deviation, so this one keeps
 * per-drain markers (output bytes → input bytes) and interpolates — the same
 * trick the iOS engine uses — so the reader follow stays on the spoken word.
 */
final class SpeedyAudioProcessor implements AudioProcessor {
    private static final String TAG = "SpeedyAP";
    // Speedy buffers ~14 × 10 ms analysis frames before Sonic sees them.
    private static final double SPEEDY_LATENCY_SEC = 0.14;

    private long h = 0;
    private AudioFormat pendingIn = AudioFormat.NOT_SET;
    private AudioFormat inFmt = AudioFormat.NOT_SET;
    private AudioFormat outFmt = AudioFormat.NOT_SET;
    private boolean pendingReconfigure = false;
    private volatile float speed = 1f;
    private volatile boolean nonlinear = false;
    private boolean appliedNonlinear = false;
    private float appliedSpeed = 1f;
    private boolean inputEnded = false;
    private ByteBuffer outputBuffer = EMPTY_BUFFER;
    private short[] tmpIn = new short[4096];
    private short[] tmpOut = new short[8192];
    private long inputBytes = 0, outputBytes = 0;
    // Post-flush fade-in (frames left / total): a seek lands mid-waveform and
    // the sink's 10-step volume ramp is a zipper — ramp the samples instead.
    private int fadeLeft = 0, fadeTotal = 0;
    // Markers: cumulative output bytes → cumulative input bytes (latency-adjusted).
    private long[] mkOut = new long[2048], mkIn = new long[2048];
    private int mkCount = 0;
    // Speed-change checkpoint (see Chain.applyPlaybackParameters).
    private long chkOutBytes = 0, chkInBytes = 0;

    void setSpeed(float s) { speed = s; }
    void setNonlinear(boolean on) { nonlinear = on; }
    boolean isNonlinear() { return nonlinear; }
    float getSpeed() { return speed; }

    @Override public AudioFormat configure(AudioFormat inputAudioFormat) throws UnhandledAudioFormatException {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) throw new UnhandledAudioFormatException(inputAudioFormat);
        pendingIn = inputAudioFormat;
        pendingReconfigure = true;
        return inputAudioFormat;   // same rate / channels / 16-bit out
    }

    @Override public boolean isActive() {
        return pendingIn.sampleRate != AudioFormat.NOT_SET.sampleRate && SpeedyNative.load();
    }

    @Override public void queueInput(ByteBuffer input) {
        if (h == 0) return;
        applyPendingParams();
        int bytes = input.remaining();
        if (bytes <= 0) return;
        int frames = bytes / inFmt.bytesPerFrame;
        int samples = frames * inFmt.channelCount;
        if (tmpIn.length < samples) tmpIn = new short[Math.max(samples, tmpIn.length * 2)];
        ByteBuffer le = input.order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < samples; i++) tmpIn[i] = le.getShort();
        input.position(input.position()); // consumed via getShort
        SpeedyNative.writeShort(h, tmpIn, frames);
        inputBytes += (long) frames * inFmt.bytesPerFrame;
        drain();
    }

    // Live speed override (rate ramp after a scrub/back-swipe): Sonic's speed
    // is changed IN the running stream. Going through ExoPlayer's playback
    // parameters instead drained the sink and rebuilt this stream at every
    // 80 ms ramp step — a click per step ("clicks as it speeds up").
    private volatile float liveSpeed = 0f;   // 0 = follow the declared parameters
    void setLiveSpeed(float s) { liveSpeed = s > 0 ? s : 0f; }

    private void applyPendingParams() {
        float s = liveSpeed > 0f ? liveSpeed : speed;
        if (s != appliedSpeed) { SpeedyNative.setSpeed(h, s); appliedSpeed = s; }
        boolean nl = nonlinear;
        if (nl != appliedNonlinear) { SpeedyNative.setNonlinear(h, nl); appliedNonlinear = nl; }
    }

    private void drain() {
        int avail = SpeedyNative.available(h);
        if (avail <= 0) return;
        int maxFrames = Math.min(avail, 65536);
        int needed = maxFrames * inFmt.channelCount;
        if (tmpOut.length < needed) tmpOut = new short[needed];
        int got = SpeedyNative.readShort(h, tmpOut, maxFrames);
        if (got <= 0) return;
        int outBytes = got * outFmt.bytesPerFrame;
        if (outputBuffer.capacity() < outBytes || outputBuffer == EMPTY_BUFFER) {
            outputBuffer = ByteBuffer.allocateDirect(Math.max(outBytes, 8192)).order(ByteOrder.LITTLE_ENDIAN);
        } else {
            outputBuffer.clear();
        }
        int samples = got * outFmt.channelCount;
        if (fadeLeft > 0) {
            int chn = Math.max(1, outFmt.channelCount);
            for (int i = 0; i < samples; i++) {
                if (fadeLeft > 0) {
                    float g = 1f - (float) fadeLeft / (float) fadeTotal;
                    outputBuffer.putShort((short) (tmpOut[i] * g));
                    if ((i % chn) == chn - 1) fadeLeft--;
                } else outputBuffer.putShort(tmpOut[i]);
            }
        } else {
            for (int i = 0; i < samples; i++) outputBuffer.putShort(tmpOut[i]);
        }
        outputBuffer.flip();
        outputBytes += outBytes;
        long lat = appliedNonlinear && !inputEnded ? (long) (SPEEDY_LATENCY_SEC * inFmt.sampleRate) * inFmt.bytesPerFrame : 0;
        addMarker(outputBytes, Math.max(0, inputBytes - lat));
    }

    private void addMarker(long out, long in) {
        if (mkCount == mkOut.length) {
            // Keep the newest half.
            int keep = mkCount / 2;
            System.arraycopy(mkOut, mkCount - keep, mkOut, 0, keep);
            System.arraycopy(mkIn, mkCount - keep, mkIn, 0, keep);
            mkCount = keep;
        }
        mkOut[mkCount] = out; mkIn[mkCount] = in; mkCount++;
    }

    /** Cumulative input bytes that correspond to cumulative output byte position `out`. */
    private long inputAt(long out) {
        if (mkCount == 0) return (long) (out * appliedSpeed);
        if (out <= mkOut[0]) {
            return mkOut[0] > 0 ? (long) ((double) mkIn[0] * out / mkOut[0]) : 0;
        }
        for (int i = 1; i < mkCount; i++) {
            if (out <= mkOut[i]) {
                long o0 = mkOut[i - 1], o1 = mkOut[i], i0 = mkIn[i - 1], i1 = mkIn[i];
                if (o1 <= o0) return i1;
                return i0 + (long) ((double) (i1 - i0) * (out - o0) / (o1 - o0));
            }
        }
        // Beyond the newest marker: extrapolate at the current speed.
        return mkIn[mkCount - 1] + (long) ((out - mkOut[mkCount - 1]) * appliedSpeed);
    }

    /** Called by the chain when playback parameters change: new checkpoint. */
    void onSpeedCheckpoint(float newSpeed) {
        chkOutBytes = outputBytes;
        chkInBytes = inputAt(chkOutBytes);
        speed = newSpeed;
    }

    long getMediaDurationUs(long playoutDurationUs) {
        if (outFmt.sampleRate <= 0 || inFmt.sampleRate <= 0) return (long) (playoutDurationUs * speed);
        long playoutBytes = (long) (playoutDurationUs / 1_000_000.0 * outFmt.sampleRate) * outFmt.bytesPerFrame;
        long inB = inputAt(chkOutBytes + playoutBytes) - chkInBytes;
        double frames = (double) inB / inFmt.bytesPerFrame;
        return (long) (frames / inFmt.sampleRate * 1_000_000.0);
    }

    @Override public void queueEndOfStream() {
        inputEnded = true;
        if (h != 0) { SpeedyNative.flush(h); drain(); }
    }

    @Override public ByteBuffer getOutput() {
        ByteBuffer b = outputBuffer;
        outputBuffer = EMPTY_BUFFER;
        return b;
    }

    @Override public boolean isEnded() {
        return inputEnded && outputBuffer == EMPTY_BUFFER && (h == 0 || SpeedyNative.available(h) == 0);
    }

    @Override public void flush() {
        outputBuffer = EMPTY_BUFFER;
        inputEnded = false;
        fadeTotal = (int) (0.03 * Math.max(8000, inFmt.sampleRate > 0 ? inFmt.sampleRate : pendingIn.sampleRate));
        fadeLeft = fadeTotal;
        inputBytes = 0; outputBytes = 0; mkCount = 0; chkOutBytes = 0; chkInBytes = 0;
        if (pendingReconfigure || h == 0) {
            inFmt = pendingIn; outFmt = pendingIn;
            pendingReconfigure = false;
            if (h != 0) { SpeedyNative.destroy(h); h = 0; }
            if (inFmt.sampleRate > 0 && SpeedyNative.load()) {
                h = SpeedyNative.create(inFmt.sampleRate, inFmt.channelCount);
                Log.d(TAG, "stream " + inFmt.sampleRate + "Hz x" + inFmt.channelCount + " h=" + h);
            }
        } else {
            // A seek: a fresh stream is the only clean state (Sonic keeps a
            // partial pitch period; Speedy keeps ~140 ms of analysis frames).
            SpeedyNative.destroy(h);
            h = SpeedyNative.create(inFmt.sampleRate, inFmt.channelCount);
        }
        appliedSpeed = 1f; appliedNonlinear = false;
        if (h != 0) applyPendingParams();
    }

    @Override public void reset() {
        flush();
        if (h != 0) { SpeedyNative.destroy(h); h = 0; }
        pendingIn = AudioFormat.NOT_SET; inFmt = AudioFormat.NOT_SET; outFmt = AudioFormat.NOT_SET;
    }

    /** The audio-processor chain ExoPlayer's DefaultAudioSink drives. */
    static final class Chain implements AudioProcessorChain {
        final SpeedyAudioProcessor speedy = new SpeedyAudioProcessor();
        @Override public AudioProcessor[] getAudioProcessors() { return new AudioProcessor[] { speedy }; }
        @Override public PlaybackParameters applyPlaybackParameters(PlaybackParameters p) {
            speedy.onSpeedCheckpoint(p.speed);
            return new PlaybackParameters(p.speed, 1f);   // pitch is preserved by Sonic
        }
        @Override public boolean applySkipSilenceEnabled(boolean b) { return false; }
        @Override public long getMediaDuration(long playoutDurationUs) { return speedy.getMediaDurationUs(playoutDurationUs); }
        /** Ramp helper: instantaneous speed inside the running stream (0 = declared parameters). Position mapping stays marker-based, so the playhead stays honest. */
        public void setLiveSpeed(float s) { speedy.setLiveSpeed(s); }
        @Override public long getSkippedOutputFrameCount() { return 0; }
    }
}
