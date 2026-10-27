package com.example.app;

import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.graphics.RectF;
import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin bridging the BackgroundAudioService.
 *
 * JS API:
 *   play({ url, startMs?, rate? })   start playback
 *   pause(), resume(), stop()
 *   seek({ ms })                      seek to position
 *   setRate({ rate })                 0.5–3.0 playback speed
 *   getState()                        { playing, positionMs, durationMs }
 *
 * Events (addListener):
 *   'position'   { positionMs, durationMs, playing }  every ~500ms while playing
 *   'state'      { playing }
 *   'ended'      {}
 *   'error'      { message }
 */
@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable positionPoll;
    private int followTick = 0;   // scrub-engine warm window: every 4th poll (~600 ms)
    private boolean polling = false;
    // Foreground/visible state. The 150ms position poll only needs to be tight
    // while the UI is visible (smooth subtitle highlighting). Backgrounded /
    // screen-off, JS can't show anything, so we slow the JS-facing emit to ~1s —
    // the biggest battery win for the "screen off, listening for hours" case.
    // The lock screen is driven by the MediaSession PlaybackState, not this poll.
    private volatile boolean uiVisible = true;
    private int pollIntervalMs() { return uiVisible ? 150 : 1000; }

    private final BackgroundAudioService.OnStateChangeListener stateListener =
        new BackgroundAudioService.OnStateChangeListener() {
            @Override public void onPlayingStateChanged(boolean playing) {
                JSObject d = new JSObject();
                d.put("playing", playing);
                d.put("ts", System.currentTimeMillis());
                notifyListeners("state", d);
                if (playing) startPositionPoll();
                else stopPositionPoll();
            }
            @Override public void onPositionUpdate(int positionMs, int durationMs) {
                emitPosition(positionMs, durationMs);
            }
            @Override public void onEnded() {
                stopPositionPoll();
                JSObject d = new JSObject();
                d.put("ts", System.currentTimeMillis());
                notifyListeners("ended", d);
            }
            @Override public void onError(String message) {
                JSObject d = new JSObject();
                d.put("message", message != null ? message : "unknown");
                // ts lets JS tell a live error from one that queued while the
                // WebView was suspended and replayed minutes later (the stale
                // case must not auto-restart playback at a frozen position).
                d.put("ts", System.currentTimeMillis());
                notifyListeners("error", d);
            }
            @Override public void onRemoteCommand(String action) {
                // Lock-screen / media-button transport. JS listens for
                // {action:"play"} to force AUDIO mode, "nextCue"/"prevCue" to
                // jump by subtitle. Matches the iOS "remoteCommand" event.
                // ts: JS drops commands that queued while the WebView was
                // suspended and replayed stale on foreground (iOS already
                // stamps this; the JS guard was dead code on Android without it).
                JSObject d = new JSObject();
                d.put("action", action);
                d.put("ts", System.currentTimeMillis());
                notifyListeners("remoteCommand", d);
            }
            @Override public void onChapterRepeat(int idx) {
                JSObject d = new JSObject();
                d.put("idx", idx);
                d.put("ts", System.currentTimeMillis());
                notifyListeners("chapterRepeat", d);
            }
        };

    @Override
    public void load() {
        // Service might not yet exist; attach listener whenever we touch it.
    }

    // App came to the foreground → tighten the position poll for smooth UI.
    @Override
    public void handleOnResume() {
        try { KadokiVideoAndroidHost.shared().onResume(); } catch (Exception ignored) {}
        uiVisible = true;
        super.handleOnResume();
    }

    // App backgrounded / screen off → slow the position poll to save battery.
    // Also flush a durable position snapshot so a background kill keeps place.
    @Override
    public void handleOnPause() {
        try { KadokiVideoAndroidHost.shared().onPause(); } catch (Exception ignored) {}
        uiVisible = false;
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.saveLastPositionNow();
        super.handleOnPause();
    }

    private void ensureListener() {
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.setListener(stateListener);
    }

    // Retry-attach: service can come up on any tick after startService(); a
    // single postDelayed(..., 100) used to lose the prepared event for cached
    // MP3s that finished preparing inside those 100 ms. Tight retry until the
    // service instance exists (capped so we never spin forever).
    private void scheduleEnsureListener() {
        final int[] tries = { 0 };
        final Runnable r = new Runnable() {
            @Override public void run() {
                BackgroundAudioService s = BackgroundAudioService.getInstance();
                if (s != null) {
                    s.setListener(stateListener);
                    return;
                }
                tries[0]++;
                if (tries[0] < 40) mainHandler.postDelayed(this, 50);
            }
        };
        mainHandler.post(r);
    }

    private void emitPosition(int positionMs, int durationMs) {
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        JSObject d = new JSObject();
        d.put("positionMs", positionMs);
        d.put("durationMs", durationMs);
        d.put("playing", s != null && s.isCurrentlyPlaying());
        // Emit-time stamp so JS can drop events that queued in the bridge while
        // the WebView was suspended and replay in a burst on foreground (the
        // rapid card-scroll bug after a phone call).
        d.put("ts", System.currentTimeMillis());
        notifyListeners("position", d);
    }

    private void startPositionPoll() {
        if (polling) return;
        polling = true;
        positionPoll = new Runnable() {
            @Override public void run() {
                BackgroundAudioService s = BackgroundAudioService.getInstance();
                if (s == null || !s.isCurrentlyPlaying()) {
                    polling = false;
                    return;
                }
                int posNow = s.getPositionMs();
                emitPosition(posNow, s.getDurationMs());
                if (uiVisible && (++followTick % 4) == 0) { try { s.scrubFollow(posNow); } catch (Exception ignored) {} }
                // Tight (150ms) while the UI is visible for instant subtitle
                // highlighting; slow (~1s) when backgrounded/screen-off where
                // nobody sees it — see pollIntervalMs / uiVisible.
                mainHandler.postDelayed(this, pollIntervalMs());
            }
        };
        mainHandler.post(positionPoll);
    }

    private void stopPositionPoll() {
        polling = false;
        if (positionPoll != null) mainHandler.removeCallbacks(positionPoll);
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        // Read as Double then truncate. call.getInt silently returns the
        // default for fractional Numbers (observed: 411000.19 → 0).
        Double startD = call.getDouble("startMs");
        int startMs = (startD != null) ? startD.intValue() : 0;
        Float rate = call.getFloat("rate", 1.0f);
        // Optional fade override — defaults applied service-side.
        Integer fadeMsOverride = call.getInt("fadeMs");
        Intent i = new Intent(getContext(), BackgroundAudioService.class);
        i.setAction(BackgroundAudioService.ACTION_PLAY);
        i.putExtra(BackgroundAudioService.EXTRA_URL, url);
        i.putExtra(BackgroundAudioService.EXTRA_START_MS, startMs);
        i.putExtra(BackgroundAudioService.EXTRA_RATE, rate);
        if (fadeMsOverride != null) i.putExtra(BackgroundAudioService.EXTRA_FADE_MS, fadeMsOverride);
        startServiceCompat(i);
        // Service.onCreate sets the instance; tight retry-attach because cached
        // MP3s prepare in <100 ms and would otherwise drop the playing-state
        // event before the listener attached.
        scheduleEnsureListener();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        Integer fadeMsOverride = call.getInt("fadeMs");
        Intent i = new Intent(getContext(), BackgroundAudioService.class);
        i.setAction(BackgroundAudioService.ACTION_PAUSE);
        if (fadeMsOverride != null) i.putExtra(BackgroundAudioService.EXTRA_FADE_MS, fadeMsOverride);
        startServiceCompat(i);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        Integer fadeMsOverride = call.getInt("fadeMs");
        Intent i = new Intent(getContext(), BackgroundAudioService.class);
        i.setAction(BackgroundAudioService.ACTION_RESUME);
        if (fadeMsOverride != null) i.putExtra(BackgroundAudioService.EXTRA_FADE_MS, fadeMsOverride);
        startServiceCompat(i);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // No-op if the service isn't running — avoids spinning up just to stop
        // (which historically tripped the foreground 5s rule).
        if (BackgroundAudioService.getInstance() != null) {
            send(BackgroundAudioService.ACTION_STOP);
        }
        stopPositionPoll();
        call.resolve();
    }

    @PluginMethod
    public void setMetadata(PluginCall call) {
        String title = call.getString("title");
        String subtitle = call.getString("subtitle");
        // artwork (data-URI or base64) is optional; null when not provided so
        // the per-cue subtitle updates don't clobber the cover art set once on
        // audio-mode entry.
        String artwork = call.getString("artwork");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.setMetadata(title, subtitle, artwork);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double msD = call.getDouble("ms");
        int ms = (msD != null) ? msD.intValue() : 0;
        // Optional fade for a click-free seek (subtitle swipes / lock-screen
        // prev-next pass fadeMs); absent → instant seek (e.g. scrub-bar drag).
        Integer fadeMs = call.getInt("fadeMs");
        Double ramp = call.getDouble("rampFrom");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.seekToMsRamp(ms, fadeMs != null ? fadeMs : 0, ramp != null ? ramp.floatValue() : 0f);
        call.resolve();
    }

    // Drag scrub (reader): turntable engine in BackgroundAudioService. Direct
    // service calls (like seek), not intents — latency matters.
    @PluginMethod
    public void scrubPrime(PluginCall call) {
        Double msD = call.getDouble("ms");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        JSObject r = new JSObject();
        r.put("ok", s != null && s.scrubPrime(msD != null ? msD.longValue() : -1));
        call.resolve(r);
    }

    @PluginMethod
    public void scrubBegin(PluginCall call) {
        Double msD = call.getDouble("ms");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        JSObject r = new JSObject();
        if (s == null) { r.put("ok", false); call.resolve(r); return; }
        int pos = s.getPositionMs();
        boolean was = s.isCurrentlyPlaying();
        boolean engine = s.scrubBegin(msD != null ? msD.longValue() : -1);
        r.put("ok", true);
        r.put("engine", engine);
        r.put("wasPlaying", was);
        r.put("positionMs", pos);
        r.put("durationMs", s.getDurationMs());
        call.resolve(r);
    }

    @PluginMethod
    public void scrub(PluginCall call) {
        Double msD = call.getDouble("ms");
        Boolean snap = call.getBoolean("snap");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null && msD != null) s.scrubTarget(msD.longValue(), snap != null && snap);
        call.resolve();
    }

    @PluginMethod
    public void scrubEnd(PluginCall call) {
        Double msD = call.getDouble("ms");
        Boolean resume = call.getBoolean("resume");
        Double ramp = call.getDouble("rampFrom");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.scrubEnd(msD != null ? msD.longValue() : -1, resume != null && resume, ramp != null ? ramp.floatValue() : 0f);
        JSObject r = new JSObject();
        r.put("ok", s != null);
        call.resolve(r);
    }

    // ---- Video Titles: native picture under the transparent WebView ----
    // Same contract as the iOS plugin: JS sends the anchor rect (CSS px) +
    // visibility; native places the surface and answers with the contained
    // picture rect so JS can pin the subtitle under it.
    @PluginMethod
    public void videoSurface(PluginCall call) {
        final boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", false));
        final boolean cinema = Boolean.TRUE.equals(call.getBoolean("cinema", visible));
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        Double x = call.getDouble("x"), y = call.getDouble("y"), w = call.getDouble("w"), h = call.getDouble("h");
        final RectF rect = new RectF(
            x != null ? x.floatValue() : 0f, y != null ? y.floatValue() : 0f,
            (x != null ? x.floatValue() : 0f) + (w != null ? w.floatValue() : 0f),
            (y != null ? y.floatValue() : 0f) + (h != null ? h.floatValue() : 0f));
        final BackgroundAudioService s = BackgroundAudioService.getInstance();
        final boolean active = s != null && s.isVideoLoaded();
        if (getActivity() == null) { JSObject r0 = new JSObject(); r0.put("active", false); call.resolve(r0); return; }
        getActivity().runOnUiThread(() -> {
            KadokiVideoAndroidHost host = KadokiVideoAndroidHost.shared();
            try {
                host.install(getActivity(), getBridge().getWebView());
                if (s != null && active) host.adopt(s.getExo()); else host.adopt(null);
                RectF f = host.update(getActivity(), rect, visible && active, cinema && active, landscape);
                JSObject r = new JSObject();
                r.put("active", active);
                r.put("frameX", (double) f.left); r.put("frameY", (double) f.top);
                r.put("frameW", (double) f.width()); r.put("frameH", (double) f.height());
                r.put("subPlacement", "below");
                r.put("subSize", 24);
                call.resolve(r);
            } catch (Exception e) {
                JSObject r = new JSObject(); r.put("active", false); r.put("error", String.valueOf(e.getMessage()));
                call.resolve(r);
            }
        });
    }

    @PluginMethod
    public void videoSubs(PluginCall call) { call.resolve(); }   // native subtitle mirror is visionOS-only

    @PluginMethod
    public void tpState(PluginCall call) { call.resolve(); }     // transport ornament is visionOS-only

    /** Full audio duration without loading the player (reader's uncovered-region estimate). */
    @PluginMethod
    public void probeDuration(PluginCall call) {
        final String raw = call.getString("path");
        if (raw == null || raw.isEmpty()) { JSObject r = new JSObject(); r.put("durationMs", 0); call.resolve(r); return; }
        final String path = raw.startsWith("file://") ? raw.substring(7) : raw;
        new Thread(() -> {
            long ms = 0;
            try { ms = PcmWindowReader.probeDurationMs(getContext(), path); } catch (Throwable ignored) {}
            JSObject r = new JSObject();
            r.put("durationMs", (double) Math.max(0, ms));
            call.resolve(r);
        }, "kadoki-probe-dur").start();
    }

    /** Embedded cover picture of an audio file (ID3 APIC / MP4 covr / FLAC / OGG) as base64. */
    @PluginMethod
    public void audioCover(PluginCall call) {
        final String raw = call.getString("path");
        if (raw == null || raw.isEmpty()) { call.resolve(new JSObject()); return; }
        final String path = raw.startsWith("file://") ? raw.substring(7) : raw;
        new Thread(() -> {
            JSObject res = new JSObject();
            android.media.MediaMetadataRetriever mmr = new android.media.MediaMetadataRetriever();
            try {
                if (path.startsWith("content://")) mmr.setDataSource(getContext(), android.net.Uri.parse(path));
                else mmr.setDataSource(path);
                byte[] pic = mmr.getEmbeddedPicture();
                if (pic != null && pic.length > 0) {
                    boolean png = pic.length > 4 && (pic[0] & 0xFF) == 0x89 && pic[1] == 'P' && pic[2] == 'N' && pic[3] == 'G';
                    res.put("data", android.util.Base64.encodeToString(pic, android.util.Base64.NO_WRAP));
                    res.put("mime", png ? "image/png" : "image/jpeg");
                }
            } catch (Throwable ignored) {
            } finally { try { mmr.release(); } catch (Throwable ignored) {} }
            call.resolve(res);
        }, "kadoki-audio-cover").start();
    }

    /** Charging / thermal / battery-saver state for the transcriber's power policy. */
    @PluginMethod
    public void powerState(PluginCall call) {
        JSObject r = new JSObject();
        boolean charging = false; double level = -1;
        try {
            android.content.Intent b = getContext().registerReceiver(null,
                new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                int status = b.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1);
                charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                        || status == android.os.BatteryManager.BATTERY_STATUS_FULL;
                int lvl = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1);
                if (lvl >= 0 && scale > 0) level = (double) lvl / (double) scale;
            }
        } catch (Throwable ignored) {}
        String thermal = "nominal";
        boolean lowPower = false;
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            if (pm != null) {
                lowPower = pm.isPowerSaveMode();
                if (android.os.Build.VERSION.SDK_INT >= 29) {
                    int s = pm.getCurrentThermalStatus();
                    // Android's MODERATE is routine on a warm phone that is
                    // charging (Samsung) — it is "fair", not "serious" (which
                    // parked transcription with no subtitles at all).
                    if (s >= android.os.PowerManager.THERMAL_STATUS_CRITICAL) thermal = "critical";
                    else if (s >= android.os.PowerManager.THERMAL_STATUS_SEVERE) thermal = "serious";
                    else if (s >= android.os.PowerManager.THERMAL_STATUS_LIGHT) thermal = "fair";
                }
            }
        } catch (Throwable ignored) {}
        r.put("charging", charging); r.put("level", level); r.put("thermal", thermal); r.put("lowPower", lowPower);
        call.resolve(r);
    }

    @PluginMethod
    public void deviceModel(PluginCall call) {
        JSObject r = new JSObject();
        r.put("model", Build.MODEL);
        r.put("hwProduct", Build.PRODUCT);
        r.put("productName", "Android");
        r.put("visionClass", false);
        boolean dbg = false;
        try { dbg = (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0; } catch (Throwable ignored) {}
        r.put("debugBuild", dbg);
        r.put("simDemo", false);
        boolean phone = true;
        try {
            Configuration c = getContext().getResources().getConfiguration();
            phone = c.smallestScreenWidthDp < 600;
        } catch (Exception ignored) {}
        r.put("phone", phone);
        call.resolve(r);
    }

    // Read-mode speech engine switch. Android always plays through the
    // Speedy/Sonic chain; `nonlinear` (Speedy) is gated to read mode by JS.
    @PluginMethod
    public void setEngine(PluginCall call) {
        Boolean nl = call.getBoolean("nonlinear");
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null && nl != null) s.setNonlinear(nl);
        JSObject r = new JSObject();
        r.put("engine", "chain");
        r.put("nonlinear", nl != null && nl);
        r.put("switched", false);
        r.put("active", s != null ? "chain" : "none");
        call.resolve(r);
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Float rate = call.getFloat("rate", 1.0f);
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.setRate(rate);
        call.resolve();
    }

    // Display-only: keep the screen on while reading (keep-awake.js owns the
    // on/off policy + inactivity timer). Window flag auto-clears when the
    // activity isn't foreground, so the device sleeps normally afterward.
    // No audio/playback/position side effects.
    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean on = call.getBoolean("on", false);
        if (getActivity() == null) { call.resolve(); return; }
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (on) {
                        getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Exception ignored) {}
            }
        });
        call.resolve();
    }

    // Native chapter-repeat: pause + TTS announce + rewind at each chapter
    // boundary, running inside the foreground audio service so it works while
    // backgrounded / screen-off. chapters = [{idx, startMs, endMs, announce}].
    @PluginMethod
    public void setChapterRepeat(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        com.getcapacitor.JSArray arr = call.getArray("chapters");
        java.util.List<BackgroundAudioService.Chapter> list = new java.util.ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                try {
                    org.json.JSONObject o = arr.getJSONObject(i);
                    int idx = o.optInt("idx", i);
                    long s = (long) o.optDouble("startMs", -1);
                    long e = (long) o.optDouble("endMs", -1);
                    String announce = o.optString("announce", "");
                    if (s >= 0 && e >= s) list.add(new BackgroundAudioService.Chapter(idx, s, e, announce));
                } catch (Exception ignored) {}
            }
        }
        BackgroundAudioService.Chapter[] chs = list.toArray(new BackgroundAudioService.Chapter[0]);
        BackgroundAudioService svc = BackgroundAudioService.getInstance();
        if (svc != null) svc.setChapterRepeat(enabled, chs);
        // Make sure the service's state listener is attached so 'chapterRepeat'
        // events are delivered to JS (mirrors play()'s retry-attach).
        scheduleEnsureListener();
        call.resolve();
    }

    @PluginMethod
    public void skipToNextChapter(PluginCall call) {
        BackgroundAudioService svc = BackgroundAudioService.getInstance();
        if (svc != null) svc.skipToNextChapter();
        scheduleEnsureListener();
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        JSObject ret = new JSObject();
        if (s == null) {
            ret.put("playing", false);
            ret.put("positionMs", 0);
            ret.put("durationMs", 0);
            ret.put("ready", false);
            ret.put("url", "");
        } else {
            ret.put("playing", s.isCurrentlyPlaying());
            ret.put("positionMs", Math.max(0, s.getPositionMs()));
            ret.put("durationMs", Math.max(0, s.getDurationMs()));
            ret.put("ready", s.isReady());
            ret.put("url", s.getCurrentUrl() != null ? s.getCurrentUrl() : "");
        }
        call.resolve(ret);
    }

    // The last position the SERVICE durably saved (url + ms), readable even when
    // no service instance exists (cold boot after a background kill). JS uses it
    // as a forward-only, url-matched floor on restore so a reaped WebView never
    // resumes behind the real playhead. { url, positionMs, hasSaved }.
    @PluginMethod
    public void getLastSavedPosition(PluginCall call) {
        JSObject ret = new JSObject();
        String url = BackgroundAudioService.readSavedUrl(getContext());
        int ms = BackgroundAudioService.readSavedMs(getContext());
        ret.put("url", url != null ? url : "");
        ret.put("positionMs", Math.max(0, ms));
        ret.put("hasSaved", ms >= 0 && url != null && !url.isEmpty());
        // Wall-clock of the save (0 = unknown/older build) — JS stamps recovered
        // History entries with the true end-of-session time.
        ret.put("ts", BackgroundAudioService.readSavedTs(getContext()));
        call.resolve(ret);
    }

    private void send(String action) {
        Intent i = new Intent(getContext(), BackgroundAudioService.class);
        i.setAction(action);
        startServiceCompat(i);
    }

    private void startServiceCompat(Intent i) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopPositionPoll();
        super.handleOnDestroy();
    }
}
