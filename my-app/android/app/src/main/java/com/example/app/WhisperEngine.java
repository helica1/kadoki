package com.example.app;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Thin Java wrapper over libwhisperjni (whisper.cpp).
 *
 * Whisper's BPE tokens routinely split Japanese text MID-UTF-8-CHARACTER, so
 * raw token bytes cannot be decoded one token at a time. transcribe() merges
 * consecutive token bytes until they form valid UTF-8 and emits each valid
 * run as a Piece carrying the time range of the tokens it swallowed —
 * exactly the (text, timeRange) run shape the iOS segmentation consumes.
 *
 * All times are centiseconds RELATIVE to the PCM window handed to
 * transcribe(); the caller rebases to absolute file ms.
 */
final class WhisperEngine {

    private static final String TAG = "WhisperEngine";

    static final class Piece {
        final String text;
        final long t0Cs;
        final long t1Cs;
        Piece(String text, long t0Cs, long t1Cs) { this.text = text; this.t0Cs = t0Cs; this.t1Cs = t1Cs; }
    }

    /** One whisper segment: its time range plus the merged token pieces. */
    static final class Segment {
        final long t0Cs;
        final long t1Cs;
        final List<Piece> pieces;
        Segment(long t0Cs, long t1Cs, List<Piece> pieces) { this.t0Cs = t0Cs; this.t1Cs = t1Cs; this.pieces = pieces; }
    }

    private static boolean libOk;
    static {
        try {
            System.loadLibrary("whisperjni");
            libOk = true;
        } catch (Throwable t) {
            // Non-arm64 device or packaging problem — AutoTranscribe reports
            // supported:false and the feature stays hidden, same as old iOS.
            Log.w(TAG, "libwhisperjni unavailable: " + t);
            libOk = false;
        }
    }

    static boolean isLibAvailable() { return libOk; }

    private long handle;

    /** Blocking model load (several seconds for small-q5). */
    synchronized boolean init(String modelPath) {
        if (!libOk) return false;
        if (handle != 0) return true;
        handle = nInit(modelPath);
        return handle != 0;
    }

    synchronized boolean isReady() { return handle != 0; }

    synchronized void release() {
        if (handle != 0) { nFree(handle); handle = 0; }
    }

    /** Thread-safe: flips the abort flag read by the running nFull(). */
    void abort() {
        long h = handle;
        if (h != 0) nAbort(h);
    }

    /**
     * Blocking transcription of a 16 kHz mono float window.
     * Returns null on abort, empty list on silence, throws on engine error.
     */
    synchronized List<Segment> transcribe(float[] pcm, int nThreads) throws Exception {
        if (handle == 0) throw new Exception("whisper engine not initialized");
        int rc = nFull(handle, pcm, nThreads);
        if (rc == -100) return null; // aborted
        if (rc != 0) throw new Exception("whisper_full failed rc=" + rc);

        List<Segment> out = new ArrayList<>();
        int nSeg = nSegCount(handle);
        for (int i = 0; i < nSeg; i++) {
            List<Piece> pieces = new ArrayList<>();
            int nTok = nTokCount(handle, i);
            ByteArrayOutputStream pending = new ByteArrayOutputStream();
            long pendT0 = -1, pendT1 = -1;
            for (int j = 0; j < nTok; j++) {
                byte[] b = nTokBytes(handle, i, j);
                if (b == null || b.length == 0) continue; // special token
                if (pending.size() == 0) pendT0 = nTokT0(handle, i, j);
                pendT1 = nTokT1(handle, i, j);
                pending.write(b, 0, b.length);
                String decoded = strictUtf8(pending.toByteArray());
                if (decoded != null) {
                    if (!decoded.isEmpty()) pieces.add(new Piece(decoded, pendT0, pendT1));
                    pending.reset();
                }
            }
            // Trailing bytes that never became valid UTF-8 (truncated char at
            // the model's output edge) — decode leniently rather than drop time.
            if (pending.size() > 0) {
                String lenient = new String(pending.toByteArray(), StandardCharsets.UTF_8)
                        .replace("�", "");
                if (!lenient.isEmpty()) pieces.add(new Piece(lenient, pendT0, pendT1));
            }
            out.add(new Segment(nSegT0(handle, i), nSegT1(handle, i), pieces));
        }
        return out;
    }

    /** Strict UTF-8 decode: null if the bytes are not a complete valid sequence. */
    private static String strictUtf8(byte[] bytes) {
        CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        CharBuffer cb = CharBuffer.allocate(bytes.length + 4);
        CoderResult r = dec.decode(ByteBuffer.wrap(bytes), cb, true);
        if (r.isError()) return null;
        r = dec.flush(cb);
        if (r.isError()) return null;
        cb.flip();
        return cb.toString();
    }

    // --- native ---
    private static native long nInit(String modelPath);
    private static native void nFree(long h);
    private static native void nAbort(long h);
    private static native int nFull(long h, float[] pcm, int nThreads);
    private static native int nSegCount(long h);
    private static native long nSegT0(long h, int i);
    private static native long nSegT1(long h, int i);
    private static native int nTokCount(long h, int i);
    private static native byte[] nTokBytes(long h, int i, int j);
    private static native long nTokT0(long h, int i, int j);
    private static native long nTokT1(long h, int i, int j);
}
