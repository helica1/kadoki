package com.example.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognitionPart;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Android's own on-device recognizer as a transcription engine (Android 14+).
 * Measured on a Galaxy Z Fold7 (2026-10-26) against whisper on the same
 * Japanese audiobook passage: real per-word timestamps (whisper DTW stamped
 * ~21 % of tokens zero-length), equal text quality, and 10× real time with no
 * loss (20× drops words, unthrottled returns nothing). Needs Google's
 * on-device Japanese pack (~52 MB, a one-time system download prompt).
 *
 * A decoded window (16 kHz mono) is streamed into a segmented session
 * (EXTRA_AUDIO_SOURCE) at FEED_PACE × real time; each pause-delimited result
 * becomes a WhisperEngine.Segment whose pieces are the recognized words —
 * the same shape whisper produces, so AutoTranscribePlugin's segmentation,
 * energy refinement and window continuation run unchanged. Part timestamps
 * are audio time from the window start.
 */
final class SystemSpeechEngine {
    private static final String TAG = "SystemSpeech";
    static final String LANG = "ja-JP";
    static final double FEED_PACE = 10.0;
    private static final String ENDERS = "。！？!?…」』、";

    private static final Handler main = new Handler(Looper.getMainLooper());

    /** Recognizer present and able to time words (no language check). */
    static boolean usable(Context ctx) {
        return Build.VERSION.SDK_INT >= 34 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
    }

    /** "installed" | "supported" (pack downloadable) | "none". Blocks ≤ 4 s; call off the main thread. */
    static String languageStatus(Context ctx) {
        if (!usable(ctx)) return "none";
        final String[] out = { "none" };
        final CountDownLatch done = new CountDownLatch(1);
        main.post(() -> {
            try {
                SpeechRecognizer sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANG);
                sr.checkRecognitionSupport(i, ctx.getMainExecutor(), new RecognitionSupportCallback() {
                    @Override public void onSupportResult(RecognitionSupport s) {
                        if (s.getInstalledOnDeviceLanguages().contains(LANG)) out[0] = "installed";
                        else if (s.getSupportedOnDeviceLanguages().contains(LANG) || s.getPendingOnDeviceLanguages().contains(LANG)) out[0] = "supported";
                        sr.destroy();
                        done.countDown();
                    }
                    @Override public void onError(int e) { sr.destroy(); done.countDown(); }
                });
            } catch (Throwable t) { done.countDown(); }
        });
        try { done.await(4, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        return out[0];
    }

    /** Ask the system to download the Japanese pack (it shows its own consent dialog). */
    static void requestDownload(Context ctx) {
        main.post(() -> {
            try {
                SpeechRecognizer sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANG);
                sr.triggerModelDownload(i);
                main.postDelayed(sr::destroy, 3000);
            } catch (Throwable t) { Log.w(TAG, "download request failed", t); }
        });
    }

    private volatile SpeechRecognizer active;
    private volatile CountDownLatch activeDone;
    private volatile boolean aborted;

    void abort() {
        aborted = true;
        SpeechRecognizer sr = active;
        if (sr != null) main.post(() -> { try { sr.cancel(); sr.destroy(); } catch (Exception ignored) {} });
        // cancel() fires no callback, so release the window's wait here —
        // otherwise a stop stalls until the timeout (~20-40 s).
        CountDownLatch d = activeDone;
        if (d != null) d.countDown();
    }

    /**
     * Transcribe one window. Returns null when aborted or the recognizer
     * failed (the caller treats it like a failed window). Blocks the calling
     * (job) thread; recognizer calls are marshalled to the main thread.
     */
    List<WhisperEngine.Segment> transcribe(Context ctx, float[] pcm) {
        final int n = pcm.length;
        final byte[] pcm16 = new byte[n * 2];
        for (int i = 0; i < n; i++) {
            int v = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767f)));
            pcm16[i * 2] = (byte) (v & 0xff);
            pcm16[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
        }
        final long audioMs = n * 1000L / PcmWindowReader.WHISPER_RATE;
        final List<List<long[]>> segTimes = new ArrayList<>();
        final List<List<String>> segTexts = new ArrayList<>();
        final CountDownLatch done = new CountDownLatch(1);
        activeDone = done;
        aborted = false;
        final int[] error = { 0 };
        final ParcelFileDescriptor[] pipe;
        try { pipe = ParcelFileDescriptor.createPipe(); } catch (Exception e) { return null; }

        main.post(() -> {
            try {
                SpeechRecognizer sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
                active = sr;
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANG);
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, PcmWindowReader.WHISPER_RATE);
                i.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
                i.putExtra(RecognizerIntent.EXTRA_REQUEST_WORD_TIMING, true);
                sr.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle b) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float v) {}
                    @Override public void onBufferReceived(byte[] b) {}
                    @Override public void onEndOfSpeech() {}
                    @Override public void onError(int e) {
                        // NO_MATCH on a silent window is an empty result, not a failure.
                        if (e != SpeechRecognizer.ERROR_NO_MATCH) error[0] = e;
                        done.countDown();
                    }
                    @Override public void onResults(Bundle b) { collect(b, segTexts, segTimes); done.countDown(); }
                    @Override public void onPartialResults(Bundle b) {}
                    @Override public void onEvent(int t, Bundle b) {}
                    @Override public void onSegmentResults(Bundle b) { collect(b, segTexts, segTimes); }
                    @Override public void onEndOfSegmentedSession() { done.countDown(); }
                });
                sr.startListening(i);
            } catch (Throwable t) {
                Log.e(TAG, "start failed", t);
                error[0] = -1;
                done.countDown();
            }
        });

        // Feed at FEED_PACE × real time (faster loses words), then close.
        try (FileOutputStream fo = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
            long t0 = System.currentTimeMillis();
            final int chunk = 3200;   // 100 ms
            for (int off = 0; off < pcm16.length; off += chunk) {
                if (done.getCount() == 0) break;
                fo.write(pcm16, off, Math.min(chunk, pcm16.length - off));
                long due = t0 + (long) ((off / 32.0) / FEED_PACE);
                long wait = due - System.currentTimeMillis();
                if (wait > 0) Thread.sleep(wait);
            }
        } catch (Exception e) {
            Log.w(TAG, "feed: " + e.getMessage());
        }
        try {
            done.await((long) (audioMs / FEED_PACE) * 3 + 20000, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {}
        final SpeechRecognizer sr = active;
        active = null;
        main.post(() -> { try { if (sr != null) sr.destroy(); } catch (Exception ignored) {} });
        try { pipe[0].close(); } catch (Exception ignored) {}
        activeDone = null;
        if (aborted) return null;
        if (error[0] != 0) { Log.w(TAG, "recognizer error " + error[0]); return null; }

        // Words → pieces. A word ends where the next starts; a phrase's last
        // word gets ~120 ms per character, capped before the next phrase (the
        // plugin's energy refinement trims cue ends to the real speech).
        List<WhisperEngine.Segment> out = new ArrayList<>();
        for (int s = 0; s < segTexts.size(); s++) {
            List<String> words = segTexts.get(s);
            List<long[]> times = segTimes.get(s);
            if (words.isEmpty()) continue;
            long nextSegStart = audioMs;
            for (int s2 = s + 1; s2 < segTimes.size(); s2++) {
                if (!segTimes.get(s2).isEmpty()) { nextSegStart = segTimes.get(s2).get(0)[0]; break; }
            }
            List<WhisperEngine.Piece> pieces = new ArrayList<>();
            for (int k = 0; k < words.size(); k++) {
                long st = times.get(k)[0];
                long en = k + 1 < words.size() ? times.get(k + 1)[0]
                        : Math.min(nextSegStart - 50, st + 120L * Math.max(1, words.get(k).length()));
                if (en < st) en = st;
                String text = words.get(k);
                // Pause-delimited phrase: the recognizer gives no punctuation.
                // A short pause before the next phrase reads as a comma, a
                // longer one (or the window end) as a full stop — so cue
                // splitting and the generated book see real boundaries.
                if (k == words.size() - 1 && ENDERS.indexOf(text.charAt(text.length() - 1)) < 0) {
                    boolean last = s == segTexts.size() - 1 || nextSegStart >= audioMs;
                    text = text + (!last && nextSegStart - st < 1400 ? "、" : "。");
                }
                pieces.add(new WhisperEngine.Piece(text, st / 10, en / 10));
            }
            out.add(new WhisperEngine.Segment(pieces.get(0).t0Cs, pieces.get(pieces.size() - 1).t1Cs, pieces));
        }
        return out;
    }

    private static void collect(Bundle b, List<List<String>> texts, List<List<long[]>> times) {
        List<String> words = new ArrayList<>();
        List<long[]> ts = new ArrayList<>();
        ArrayList<RecognitionPart> parts = b.getParcelableArrayList(SpeechRecognizer.RECOGNITION_PARTS, RecognitionPart.class);
        if (parts != null) {
            for (RecognitionPart p : parts) {
                String t = p.getFormattedText() != null && !p.getFormattedText().isEmpty() ? p.getFormattedText() : p.getRawText();
                if (t == null || t.trim().isEmpty()) continue;
                words.add(t.trim());
                ts.add(new long[]{ p.getTimestampMillis() });
            }
        }
        if (!words.isEmpty()) { texts.add(words); times.add(ts); }
    }
}
