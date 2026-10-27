package com.example.app;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * AutoTranscribe (Android) — whisper.cpp counterpart of the iOS
 * AutoTranscribePlugin (SpeechAnalyzer). Speaks the exact same JS contract:
 *
 *   checkAvailability() → { supported, installed }
 *   ensureAssets()      → downloads the ggml model (assetProgress events)
 *   start({jobId, srcPath, startMs, targetMs, aheadMs}) → { started, durationMs }
 *   setTarget({jobId, targetMs}) / stop({jobId})
 *   getChapters({srcPath}) → { chapters: [] }   (m4b chapter parse: not yet)
 *
 * Events: "cues" { jobId, cues:[{startMs,endMs,text,w?}], fedThroughMs },
 *         "done" { jobId, reason: eof|stopped|error, error?, fedThroughMs },
 *         "assetProgress" { fraction }.
 *
 * Cue times are ABSOLUTE file ms; `w` is a flat [utf16Off, utf16Len,
 * absStartMs, absEndMs] quad list per recognizer token run — identical to the
 * iOS emission, so karaoke, auto-align and the watch bundle work unchanged.
 *
 * Engine: 30 s decode windows (PcmWindowReader) → whisper_full with token
 * timestamps. Window continuation drops the last (possibly cut) segment and
 * restarts at its start time, so cue boundaries never straddle a window edge.
 * One job at a time; a lookahead job idles once fedThroughMs is aheadMs past
 * targetMs — same pacing rule as iOS.
 */
@CapacitorPlugin(name = "AutoTranscribe")
public class AutoTranscribePlugin extends Plugin {

    private static final String TAG = "AutoTranscribe";

    // Default model: whisper small (quantized q5_1) — the quality floor for
    // Japanese. ~181 MB download, fetched in-app on demand, never shipped.
    private static final String MODEL_URL =
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin";
    private static final String MODEL_FILE = "ggml-small-q5_1.bin";
    private static final long MODEL_MIN_BYTES = 10L * 1024 * 1024;

    private static final long WINDOW_MS = 30_000;

    // Segmentation — mirrors iOS AutoTranscribePlugin.swift exactly.
    private static final double GAP_SPLIT_SEC = 0.75;
    private static final int SOFT_MAX_CHARS = 42;
    private static final int HARD_MAX_CHARS = 84;
    private static final String SENTENCE_ENDERS = "。！？!?…」』";
    private static final int MIN_CUE_DUR_MS = 300;

    private static WhisperEngine engine;           // model kept loaded across jobs
    private static final Object engineLock = new Object();

    private volatile Job currentJob;
    private final Object jobLock = new Object();

    private volatile boolean downloading = false;

    // ------------------------------------------------------------------
    // Plugin methods
    // ------------------------------------------------------------------

    // Engine: Android's own on-device recognizer (SystemSpeechEngine) when
    // Android 14+ can time words and Google's Japanese pack is (or can be)
    // installed — real word timestamps at 10× real time; whisper otherwise.
    @PluginMethod
    public void checkAvailability(PluginCall call) {
        new Thread(() -> {
            JSObject ret = new JSObject();
            String sys = SystemSpeechEngine.languageStatus(getContext());
            if (!"none".equals(sys)) {
                ret.put("supported", true);
                ret.put("installed", "installed".equals(sys));
                ret.put("engine", "android");
                ret.put("sizeMB", 52);
            } else {
                ret.put("supported", WhisperEngine.isLibAvailable());
                ret.put("installed", findModel() != null);
                ret.put("engine", "whisper");
                ret.put("sizeMB", 190);
            }
            call.resolve(ret);
        }, "speech-avail").start();
    }

    @PluginMethod
    public void ensureAssets(PluginCall call) {
        if (SystemSpeechEngine.usable(getContext())) {
            new Thread(() -> {
                String st = SystemSpeechEngine.languageStatus(getContext());
                if ("installed".equals(st)) { resolveInstalled(call); return; }
                if ("supported".equals(st)) {
                    // The system shows its own download consent; wait for it.
                    SystemSpeechEngine.requestDownload(getContext());
                    long until = System.currentTimeMillis() + 10 * 60_000;
                    while (System.currentTimeMillis() < until) {
                        try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
                        if ("installed".equals(SystemSpeechEngine.languageStatus(getContext()))) { resolveInstalled(call); return; }
                    }
                    call.reject("Japanese speech pack was not installed");
                    return;
                }
                startWhisperDownload(call);   // recognizer can't do Japanese: whisper
            }, "speech-assets").start();
            return;
        }
        startWhisperDownload(call);
    }

    private void startWhisperDownload(PluginCall call) {
        if (!WhisperEngine.isLibAvailable()) {
            call.reject("Transcription not supported on this device");
            return;
        }
        if (findModel() != null) {
            JSObject ret = new JSObject();
            ret.put("installed", true);
            call.resolve(ret);
            return;
        }
        new Thread(() -> {
            // Single-flight: a concurrent caller waits for the running download.
            synchronized (AutoTranscribePlugin.class) {
                if (findModel() != null) { resolveInstalled(call); return; }
                downloading = true;
                try {
                    downloadModel();
                    resolveInstalled(call);
                } catch (Exception e) {
                    Log.e(TAG, "model download failed", e);
                    call.reject("Speech model download failed: " + e.getMessage());
                } finally {
                    downloading = false;
                }
            }
        }, "whisper-model-dl").start();
    }

    private void resolveInstalled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("installed", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String jobId = call.getString("jobId");
        String srcPath = stripFileScheme(call.getString("srcPath"));
        if (jobId == null || jobId.isEmpty() || srcPath == null || srcPath.isEmpty()) {
            call.reject("jobId and srcPath required");
            return;
        }
        if (!new File(srcPath).exists()) {
            call.reject("Audio file not found: " + srcPath);
            return;
        }
        File model = findModel();
        boolean system = SystemSpeechEngine.usable(getContext());
        if (model == null && !system) {
            call.reject("Speech model not installed");
            return;
        }
        long startMs = dblArg(call, "startMs", 0);
        long targetMs = dblArg(call, "targetMs", startMs);
        long aheadMs = dblArg(call, "aheadMs", 600_000);

        stopCurrentJob(null);

        long durationMs = PcmWindowReader.probeDurationMs(getContext(), srcPath);

        Job job = new Job(jobId, srcPath, model, startMs, targetMs, aheadMs, durationMs);
        synchronized (jobLock) { currentJob = job; }
        job.thread.start();

        JSObject ret = new JSObject();
        ret.put("started", true);
        ret.put("durationMs", (double) durationMs);
        call.resolve(ret);
    }

    @PluginMethod
    public void setTarget(PluginCall call) {
        String jobId = call.getString("jobId");
        long targetMs = dblArg(call, "targetMs", 0);
        Job j = currentJob;
        if (j != null && (jobId == null || j.id.equals(jobId))) {
            j.targetMs = targetMs;
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCurrentJob(call.getString("jobId"));
        call.resolve();
    }

    @PluginMethod
    public void getChapters(PluginCall call) {
        // m4b chapter atoms are not parsed on Android yet; an empty list is a
        // normal result for the JS side.
        JSObject ret = new JSObject();
        ret.put("chapters", new JSONArray());
        call.resolve(ret);
    }

    // ------------------------------------------------------------------
    // Job lifecycle
    // ------------------------------------------------------------------

    private void stopCurrentJob(String onlyId) {
        Job j;
        synchronized (jobLock) {
            j = currentJob;
            if (j == null) return;
            if (onlyId != null && !j.id.equals(onlyId)) return;
            currentJob = null;
        }
        j.cancelled = true;
        WhisperEngine e = engine;
        if (e != null) e.abort();
        SystemSpeechEngine se = j.system;
        if (se != null) se.abort();
    }

    /** Clear the job slot if it still holds this job (mirrors iOS clearJob). */
    private void clearJob(Job job) {
        synchronized (jobLock) {
            if (currentJob == job) currentJob = null;
        }
    }

    private final class Job {
        final String id;
        final String srcPath;
        final File model;
        final long startMs;
        volatile long targetMs;
        final long aheadMs;
        final long durationMs;
        volatile boolean cancelled = false;
        volatile long fedThroughMs;
        volatile SystemSpeechEngine system;   // set when this job runs on Android's recognizer
        final Thread thread;

        Job(String id, String srcPath, File model, long startMs, long targetMs,
            long aheadMs, long durationMs) {
            this.id = id;
            this.srcPath = srcPath;
            this.model = model;
            this.startMs = startMs;
            this.targetMs = targetMs;
            this.aheadMs = aheadMs;
            this.durationMs = durationMs;
            this.fedThroughMs = startMs;
            this.thread = new Thread(this::run, "whisper-job-" + id);
        }

        void run() {
            String error = null;
            try {
                WhisperEngine eng = null;
                if ("installed".equals(SystemSpeechEngine.languageStatus(getContext()))) {
                    system = new SystemSpeechEngine();
                    Log.i(TAG, "engine: Android on-device recognizer");
                } else {
                    if (model == null) { error = "Speech model not installed"; return; }
                    eng = obtainEngine(model);
                    if (eng == null) { error = "Speech model failed to load"; return; }
                    Log.i(TAG, "engine: whisper");
                }
                final long windowMs = system != null ? 60_000 : WINDOW_MS;

                int nThreads = Math.max(2, Math.min(6,
                        Runtime.getRuntime().availableProcessors() - 2));
                long windowStart = startMs;
                int emptyWindows = 0;

                while (!cancelled) {
                    // Pacing: a lookahead job idles once it is aheadMs ahead of
                    // the playhead target; backfill (frontier < target) runs
                    // at full speed automatically.
                    if (aheadMs > 0 && fedThroughMs > targetMs + aheadMs) {
                        try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
                        continue;
                    }

                    // Built-in engine: a short first window so the first
                    // subtitles land ~1.5 s after the job starts.
                    long thisWindow = (system != null && windowStart == startMs) ? 15_000 : windowMs;
                    PcmWindowReader.Window win =
                            PcmWindowReader.readWindow(getContext(), srcPath, windowStart, thisWindow);
                    if (cancelled) return;
                    long decodedMs = win.pcm.length * 1000L / PcmWindowReader.WHISPER_RATE;
                    if (win.pcm.length < PcmWindowReader.WHISPER_RATE) {
                        if (win.eof) {
                            // <1 s of audio left — genuine end of file.
                            fedThroughMs = windowStart + decodedMs;
                            return; // reason stays "eof"
                        }
                        // Undecodable region mid-file: MUST NOT report "eof"
                        // (JS marks the remainder covered). Skip forward; give
                        // up with an error if it never recovers.
                        if (++emptyWindows >= 10) {
                            error = "Audio undecodable at " + windowStart + "ms";
                            return;
                        }
                        windowStart += windowMs;
                        fedThroughMs = windowStart;
                        continue;
                    }
                    emptyWindows = 0;

                    long t0 = System.currentTimeMillis();
                    List<WhisperEngine.Segment> segs = system != null
                            ? system.transcribe(getContext(), win.pcm)
                            : eng.transcribe(win.pcm, nThreads);
                    if (cancelled) return; // aborted
                    if (segs == null) {
                        if (system == null) return;   // whisper abort
                        // A recognizer hiccup on one window: retry it once, then skip ahead.
                        segs = system.transcribe(getContext(), win.pcm);
                        if (cancelled) return;
                        if (segs == null) { error = "Speech recognizer failed at " + windowStart + "ms"; return; }
                    }
                    Log.i(TAG, "window " + windowStart + "ms (" + decodedMs + "ms audio) → "
                            + segs.size() + " segs in " + (System.currentTimeMillis() - t0) + "ms");

                    // Continuation: drop the last (possibly mid-sentence) segment
                    // and restart at its start, unless the file ended here.
                    long nextStart;
                    List<WhisperEngine.Segment> keep = segs;
                    if (!win.eof && segs.size() > 1) {
                        WhisperEngine.Segment last = segs.get(segs.size() - 1);
                        keep = segs.subList(0, segs.size() - 1);
                        nextStart = windowStart + last.t0Cs * 10;
                        // Restart where that phrase's VOICE begins: a word time
                        // that lands after the true onset clips the opening
                        // syllables and garbles the phrase (郵便局 → 複合).
                        WhisperEngine.Segment prev = keep.get(keep.size() - 1);
                        nextStart = voiceOnsetBefore(win.pcm, windowStart, nextStart, windowStart + prev.t1Cs * 10);
                    } else {
                        nextStart = windowStart + decodedMs;
                    }
                    // Stall guard: always advance at least 2 s.
                    if (nextStart < windowStart + 2000) nextStart = windowStart + decodedMs;

                    List<Cue> cueList = segmentToCues(keep, windowStart);
                    refineCueBounds(cueList, win.pcm, windowStart);
                    layoutWordsByVoice(cueList, win.pcm, windowStart);
                    JSONArray cues = serializeCues(cueList);
                    fedThroughMs = nextStart;
                    if (cues.length() > 0) emitCues(id, cues, fedThroughMs);

                    if (win.eof) return; // "eof"
                    windowStart = nextStart;
                }
            } catch (Exception e) {
                Log.e(TAG, "job " + id + " failed", e);
                error = e.getMessage() != null ? e.getMessage() : e.toString();
            } finally {
                boolean wasCancelled = cancelled;
                clearJob(this);
                String reason = error != null ? "error" : (wasCancelled ? "stopped" : "eof");
                emitDone(id, reason, error, fedThroughMs);
            }
        }
    }

    private static WhisperEngine obtainEngine(File model) {
        synchronized (engineLock) {
            if (engine != null && engine.isReady()) return engine;
            WhisperEngine e = new WhisperEngine();
            if (!e.init(model.getAbsolutePath())) return null;
            engine = e;
            return e;
        }
    }

    // ------------------------------------------------------------------
    // Segmentation — port of iOS segmentResult()
    // ------------------------------------------------------------------

    private static final class Cue {
        long s, e;
        String text;
        final List<long[]> w = new ArrayList<>();
    }

    /**
     * Convert whisper segments (token pieces with window-relative centisecond
     * times) into cue objects with absolute ms and UTF-16 `w` quads, applying
     * the same split rules as iOS: gap > 0.75 s, hard cap 84 chars, soft cap
     * 42 chars ending at a JP sentence ender, 300 ms minimum duration.
     */
    private List<Cue> segmentToCues(List<WhisperEngine.Segment> segs, long baseMs) {
        List<Cue> out = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        List<long[]> words = new ArrayList<>();
        double cueStartMs = 0, lastEndMs = -1;

        for (WhisperEngine.Segment seg : segs) {
            for (WhisperEngine.Piece p : seg.pieces) {
                if (p.text.isEmpty()) continue;
                double s = baseMs + p.t0Cs * 10.0;
                double e = baseMs + p.t1Cs * 10.0;
                if (text.length() > 0) {
                    double gap = lastEndMs >= 0 ? (s - lastEndMs) / 1000.0 : 0;
                    char lastCh = text.charAt(text.length() - 1);
                    boolean shouldSplit =
                            gap > GAP_SPLIT_SEC ||
                            text.length() >= HARD_MAX_CHARS ||
                            (text.length() >= SOFT_MAX_CHARS && SENTENCE_ENDERS.indexOf(lastCh) >= 0);
                    if (shouldSplit) {
                        appendCue(out, text, words, cueStartMs, lastEndMs);
                        text.setLength(0);
                        words.clear();
                    }
                }
                if (text.length() == 0) cueStartMs = s;
                words.add(new long[]{ text.length(), p.text.length(),
                        Math.round(s), Math.round(e) });
                text.append(p.text);
                lastEndMs = e;
            }
        }
        appendCue(out, text, words, cueStartMs, lastEndMs);
        return out;
    }

    /** Trim, rebase word offsets past the trim, enforce min duration, collect. */
    private void appendCue(List<Cue> out, StringBuilder textB, List<long[]> words,
                           double startMs, double endMs) {
        String raw = textB.toString();
        int lead = 0, tail = raw.length();
        while (lead < tail && Character.isWhitespace(raw.charAt(lead))) lead++;
        while (tail > lead && Character.isWhitespace(raw.charAt(tail - 1))) tail--;
        String text = raw.substring(lead, tail);
        if (text.isEmpty()) return;

        Cue cue = new Cue();
        cue.text = text;
        cue.s = Math.round(startMs);
        cue.e = Math.max(Math.round(endMs), cue.s + MIN_CUE_DUR_MS);

        int tlen = text.length();
        for (long[] q : words) {
            long off = q[0] - lead;
            long len = q[1];
            if (off < 0) { len += off; off = 0; }       // token partly inside the trim
            if (off >= tlen || len <= 0) continue;
            if (off + len > tlen) len = tlen - off;
            cue.w.add(new long[]{ off, len, q[2], q[3] });
        }
        out.add(cue);
    }

    /**
     * Energy-based cue boundary refinement (lab-tuned on real audiobook audio):
     * whisper's token timestamps start cues up to ~1 s late (clipped first
     * word in the Anki slice) and end them with ~1-1.7 s of trailing silence.
     * Using the decode window's own PCM: snap each start back to the onset of
     * its speech run (or forward out of leading silence) minus a 120 ms head
     * margin, and trim/extend the end to last speech plus a 180 ms tail
     * margin. Lab result: start error p90 430→20 ms, trailing silence
     * median 870→180 ms. Word quads are untouched (absolute times; the JS
     * normalizer clamps them into the refined cue).
     */
    private static void refineCueBounds(List<Cue> cues, float[] pcm, long baseMs) {
        final int HOP = PcmWindowReader.WHISPER_RATE / 100;   // 10 ms
        int m = pcm.length / HOP;
        if (m < 10 || cues.isEmpty()) return;
        float[] env = new float[m];
        for (int i = 0; i < m; i++) {
            double acc = 0;
            int off = i * HOP;
            for (int k = 0; k < HOP; k++) { float v = pcm[off + k]; acc += v * v; }
            env[i] = (float) Math.sqrt(acc / HOP);
        }
        float[] sorted = env.clone();
        java.util.Arrays.sort(sorted);
        float thr = Math.max(sorted[(int) (m * 0.95)] * 0.10f, 0.002f);
        long wendMs = baseMs + pcm.length * 1000L / PcmWindowReader.WHISPER_RATE;

        long prevEnd = baseMs;
        for (int k = 0; k < cues.size(); k++) {
            Cue c = cues.get(k);
            // START: back to the onset of the containing speech run, or
            // forward out of leading silence. ≤1.5 s walk, never past the
            // previous cue's refined end.
            int i = clampIdx((c.s - baseMs) / 10, m);
            int lo = (int) Math.max((prevEnd - baseMs) / 10, Math.max(0, i - 150));
            if (env[i] > thr) {
                while (i > lo && env[i - 1] > thr) i--;
            } else {
                int hi = clampIdx((c.e - baseMs) / 10, m);
                while (i < hi && env[i] <= thr) i++;
            }
            long ns = Math.max(prevEnd, baseMs + i * 10L - 120);
            if (ns < c.e) c.s = ns;
            // END: trim trailing silence back to last speech, or extend
            // through speech the tokens cut short (≤1 s, never into the next
            // cue).
            int j = clampIdx((c.e - baseMs) / 10, m);
            long nxtS = (k + 1 < cues.size()) ? cues.get(k + 1).s : wendMs;
            int hi = (int) Math.min(Math.min((nxtS - baseMs) / 10, m - 1), j + 100);
            if (env[j] > thr) {
                while (j < hi && env[j + 1] > thr) j++;
            } else {
                int lo2 = clampIdx((c.s - baseMs) / 10, m);
                while (j > lo2 && env[j] <= thr) j--;
            }
            c.e = Math.min(Math.max(c.s + MIN_CUE_DUR_MS, baseMs + j * 10L + 180), nxtS);
            if (c.e <= c.s) c.e = Math.min(c.s + MIN_CUE_DUR_MS, wendMs);
            prevEnd = c.e;
        }
    }

    /**
     * Word timing from the audio itself (measured 2026-10-26: both whisper's
     * DTW stamps and the on-device recognizer's word times sit ±0.3-0.4 s off
     * the voice, so the karaoke lurched). Within each (energy-refined) cue,
     * the spoken characters are spread across the frames where the narrator
     * is actually voicing, skipping the silences; each word's start/end is
     * where its characters fall. The recognizer still decides which
     * characters form a word — just not when they are spoken. Punctuation
     * and spaces take no time.
     */
    private static void layoutWordsByVoice(List<Cue> cues, float[] pcm, long baseMs) {
        final int HOP = PcmWindowReader.WHISPER_RATE / 100;   // 10 ms
        int m = pcm.length / HOP;
        if (m < 10 || cues.isEmpty()) return;
        float[] env = new float[m];
        for (int i = 0; i < m; i++) {
            double acc = 0;
            int off = i * HOP;
            for (int k = 0; k < HOP; k++) { float v = pcm[off + k]; acc += v * v; }
            env[i] = (float) Math.sqrt(acc / HOP);
        }
        float[] sorted = env.clone();
        java.util.Arrays.sort(sorted);
        float thr = Math.max(sorted[(int) (m * 0.95)] * 0.10f, 0.002f);
        for (Cue c : cues) {
            if (c.w.isEmpty() || c.text == null) continue;
            int i0 = clampIdx((c.s - baseMs) / 10, m), i1 = clampIdx((c.e - baseMs) / 10, m);
            if (i1 - i0 < 5) continue;
            // cumulative voiced frames across the cue
            int[] cum = new int[i1 - i0 + 1];
            for (int i = i0; i < i1; i++) cum[i - i0 + 1] = cum[i - i0] + (env[i] > thr ? 1 : 0);
            int voiced = cum[cum.length - 1];
            if (voiced < 5) continue;
            // cumulative spoken characters across the text
            String t = c.text;
            int n = t.length();
            int[] cw = new int[n + 1];
            for (int k = 0; k < n; k++) cw[k + 1] = cw[k] + (isSpoken(t.charAt(k)) ? 1 : 0);
            int spoken = cw[n];
            if (spoken == 0) continue;
            // Anchors (spoken-char index → voiced-frame count): the cue's ends,
            // plus every word whose recognizer time falls within 450 ms of a
            // real speech onset — that word starts where its voice starts.
            // Characters between anchors spread over the voiced frames there.
            java.util.List<int[]> anchors = new java.util.ArrayList<>();
            anchors.add(new int[]{ 0, 0 });
            int lastFrame = 0;
            for (long[] q : c.w) {
                int off = (int) Math.max(0, Math.min(n, q[0]));
                int ch = cw[off];
                if (ch <= anchors.get(anchors.size() - 1)[0] || ch >= spoken) continue;
                int fr = (int) ((q[2] - baseMs) / 10) - i0;   // recognizer time, frame in cue
                int best = -1;
                for (int f = Math.max(lastFrame + 1, fr - 45); f <= Math.min(i1 - i0 - 1, fr + 45); f++) {
                    boolean onset = env[i0 + f] > thr && (f == 0 || env[i0 + f - 1] <= thr);
                    if (onset && (best < 0 || Math.abs(f - fr) < Math.abs(best - fr))) best = f;
                }
                if (best > 0) { anchors.add(new int[]{ ch, cum[best] }); lastFrame = best; }
            }
            anchors.add(new int[]{ spoken, voiced });
            for (long[] q : c.w) {
                int off = (int) Math.max(0, Math.min(n, q[0]));
                int end = (int) Math.max(off, Math.min(n, q[0] + q[1]));
                q[2] = frameMs(cum, voicedAt(anchors, cw[off]), i0, baseMs, true);
                q[3] = Math.max(q[2], frameMs(cum, voicedAt(anchors, cw[end]), i0, baseMs, false));
            }
        }
    }

    /** Voiced-frame position of spoken char `ch`, linear between the anchors around it. */
    private static double voicedAt(java.util.List<int[]> anchors, int ch) {
        for (int k = 1; k < anchors.size(); k++) {
            int[] a = anchors.get(k - 1), b = anchors.get(k);
            if (ch <= b[0]) {
                if (b[0] == a[0]) return b[1];
                return a[1] + (double) (ch - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
            }
        }
        return anchors.get(anchors.size() - 1)[1];
    }

    /**
     * Time (ms) where the cumulative voiced-frame count reaches `target`. A
     * word START lands on the next voiced frame (after any silence, where the
     * voice resumes); an END lands right after the last voiced frame.
     */
    private static long frameMs(int[] cum, double target, int i0, long baseMs, boolean start) {
        int lo = 0, hi = cum.length - 1;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (start ? cum[mid] <= target : cum[mid] < target) lo = mid + 1; else hi = mid;
        }
        int idx = start ? Math.max(0, lo - 1) : lo;
        return baseMs + (long) (i0 + idx) * 10;
    }

    private static boolean isSpoken(char ch) {
        if (Character.isWhitespace(ch)) return false;
        return "。、，．,.!?！？「」『』（）()…―・ー〜~\"'“”‘’:;：；".indexOf(ch) < 0 || ch == 'ー';
    }

    /** Walk back from `ms` to the start of the speech run it sits in (≤ 1.5 s, never before `floorMs`). */
    private static long voiceOnsetBefore(float[] pcm, long baseMs, long ms, long floorMs) {
        final int HOP = PcmWindowReader.WHISPER_RATE / 100;
        int m = pcm.length / HOP;
        if (m < 10) return ms;
        float[] env = new float[m];
        for (int i = 0; i < m; i++) {
            double acc = 0;
            int off = i * HOP;
            for (int k = 0; k < HOP; k++) { float v = pcm[off + k]; acc += v * v; }
            env[i] = (float) Math.sqrt(acc / HOP);
        }
        float[] sorted = env.clone();
        java.util.Arrays.sort(sorted);
        float thr = Math.max(sorted[(int) (m * 0.95)] * 0.10f, 0.002f);
        int i = clampIdx((ms - baseMs) / 10, m);
        int lo = (int) Math.max(Math.max(0, i - 150), (floorMs - baseMs) / 10);
        // Step back over any silence just before the stamp, then to the run's start.
        while (i > lo && env[i] <= thr && env[i - 1] <= thr) i--;
        while (i > lo && env[i - 1] > thr) i--;
        return Math.max(floorMs, baseMs + i * 10L - 120);
    }

    private static int clampIdx(long v, int m) {
        if (v < 0) return 0;
        if (v >= m) return m - 1;
        return (int) v;
    }

    private static JSONArray serializeCues(List<Cue> cues) throws Exception {
        JSONArray out = new JSONArray();
        for (Cue c : cues) {
            JSONObject o = new JSONObject();
            o.put("startMs", c.s);
            o.put("endMs", c.e);
            o.put("text", c.text);
            if (!c.w.isEmpty()) {
                JSONArray w = new JSONArray();
                for (long[] q : c.w) { w.put(q[0]); w.put(q[1]); w.put(q[2]); w.put(q[3]); }
                o.put("w", w);
            }
            out.put(o);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    private void emitCues(String jobId, JSONArray cues, long fedThroughMs) {
        JSObject d = new JSObject();
        d.put("jobId", jobId);
        d.put("cues", cues);
        d.put("fedThroughMs", (double) fedThroughMs);
        notifyListeners("cues", d);
    }

    private void emitDone(String jobId, String reason, String error, long fedThroughMs) {
        JSObject d = new JSObject();
        d.put("jobId", jobId);
        d.put("reason", reason);
        if (error != null) d.put("error", error);
        d.put("fedThroughMs", (double) fedThroughMs);
        notifyListeners("done", d);
    }

    private void emitAssetProgress(double fraction) {
        JSObject d = new JSObject();
        d.put("fraction", fraction);
        notifyListeners("assetProgress", d);
    }

    // ------------------------------------------------------------------
    // Model download
    // ------------------------------------------------------------------

    private File modelDir() {
        File d = new File(getContext().getFilesDir(), "whisper");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Installed model: the default file, or any user-provided ggml-*.bin. */
    private File findModel() {
        File def = new File(modelDir(), MODEL_FILE);
        if (def.exists() && def.length() > MODEL_MIN_BYTES) return def;
        File[] files = modelDir().listFiles();
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                if (n.startsWith("ggml-") && n.endsWith(".bin") && f.length() > MODEL_MIN_BYTES) {
                    return f;
                }
            }
        }
        return null;
    }

    /** Blocking download with resume (.part + Range) and progress events. */
    private void downloadModel() throws Exception {
        File dest = new File(modelDir(), MODEL_FILE);
        File part = new File(modelDir(), MODEL_FILE + ".part");
        long have = part.exists() ? part.length() : 0;

        HttpURLConnection conn = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-");
        int code = conn.getResponseCode();
        boolean append = (code == 206);
        if (code != 200 && code != 206) throw new Exception("HTTP " + code);
        if (!append) have = 0;

        long remaining = conn.getContentLengthLong();
        long total = remaining > 0 ? remaining + have : -1;

        try (InputStream in = conn.getInputStream();
             FileOutputStream fos = new FileOutputStream(part, append)) {
            byte[] buf = new byte[256 * 1024];
            long got = have;
            long lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (total > 0 && now - lastEmit > 250) {
                    lastEmit = now;
                    emitAssetProgress(Math.min(0.999, (double) got / total));
                }
            }
            fos.getFD().sync();
        } finally {
            conn.disconnect();
        }

        if (total > 0 && part.length() != total) {
            throw new Exception("download incomplete (" + part.length() + "/" + total + ")");
        }
        if (!part.renameTo(dest)) throw new Exception("could not finalize model file");
        emitAssetProgress(1.0);
        Log.i(TAG, "model installed: " + dest.getAbsolutePath() + " (" + dest.length() + " bytes)");
    }

    // ------------------------------------------------------------------
    // Utils
    // ------------------------------------------------------------------

    private static String stripFileScheme(String p) {
        if (p == null) return null;
        return p.startsWith("file://") ? p.substring("file://".length()) : p;
    }

    private static long dblArg(PluginCall call, String name, long def) {
        Double d = call.getDouble(name);
        if (d == null) return def;
        return d.longValue();
    }
}
