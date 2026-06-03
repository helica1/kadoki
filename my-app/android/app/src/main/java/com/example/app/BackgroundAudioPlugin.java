package com.example.app;

import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

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
    private boolean polling = false;

    private final BackgroundAudioService.OnStateChangeListener stateListener =
        new BackgroundAudioService.OnStateChangeListener() {
            @Override public void onPlayingStateChanged(boolean playing) {
                JSObject d = new JSObject();
                d.put("playing", playing);
                notifyListeners("state", d);
                if (playing) startPositionPoll();
                else stopPositionPoll();
            }
            @Override public void onPositionUpdate(int positionMs, int durationMs) {
                emitPosition(positionMs, durationMs);
            }
            @Override public void onEnded() {
                stopPositionPoll();
                notifyListeners("ended", new JSObject());
            }
            @Override public void onError(String message) {
                JSObject d = new JSObject();
                d.put("message", message != null ? message : "unknown");
                notifyListeners("error", d);
            }
            @Override public void onRemoteCommand(String action) {
                // Lock-screen / media-button transport. JS listens for
                // {action:"play"} to force AUDIO mode, "nextCue"/"prevCue" to
                // jump by subtitle. Matches the iOS "remoteCommand" event.
                JSObject d = new JSObject();
                d.put("action", action);
                notifyListeners("remoteCommand", d);
            }
        };

    @Override
    public void load() {
        // Service might not yet exist; attach listener whenever we touch it.
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
                emitPosition(s.getPositionMs(), s.getDurationMs());
                // Tight cue tracking: 150 ms granularity feels instant for
                // sentence-level highlighting. Trade-off is bridge traffic,
                // which is negligible for ~6 events/sec of two small ints.
                mainHandler.postDelayed(this, 150);
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
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.seekToMs(ms, fadeMs != null ? fadeMs : 0);
        call.resolve();
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Float rate = call.getFloat("rate", 1.0f);
        BackgroundAudioService s = BackgroundAudioService.getInstance();
        if (s != null) s.setRate(rate);
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
        } else {
            ret.put("playing", s.isCurrentlyPlaying());
            ret.put("positionMs", Math.max(0, s.getPositionMs()));
            ret.put("durationMs", Math.max(0, s.getDurationMs()));
            ret.put("ready", s.isReady());
        }
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
