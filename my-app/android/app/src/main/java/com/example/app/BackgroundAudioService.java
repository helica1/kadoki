package com.example.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.ComponentName;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * Foreground service that runs Media3 ExoPlayer so audio keeps playing while the
 * WebView/Activity is paused (screen off, app backgrounded).
 *
 * Driven by Intents for play/pause/resume/stop (so JS can fire-and-forget
 * via startForegroundService) and by direct method calls on a static instance
 * accessor for synchronous operations (getPosition/getDuration/seek/setRate).
 *
 * Plugin can register an OnStateChangeListener to receive position polling
 * events for forwarding to JS via notifyListeners.
 *
 * ExoPlayer (unlike the old MediaPlayer) is single-threaded: it MUST be created
 * and accessed on ONE Looper thread. We build and touch it only on the MAIN
 * looper. The Intent handlers (onStartCommand), MediaSession callbacks, and the
 * fade Handler all run on the main looper already; the few direct calls that can
 * arrive on a Capacitor plugin worker thread (seek/setRate) are marshalled there
 * via runOnPlayer(), and the cross-thread getters (position/duration/playing)
 * are served from volatile caches kept fresh by the main-looper position poll.
 * Migrated from android.media.MediaPlayer, whose native Stagefright MP4 parser
 * rejected some valid Audible-style .m4b files (error 1/-2147483648) that
 * ExoPlayer's own extractor reads fine.
 */
public class BackgroundAudioService extends Service {

    private static final String TAG = "BgAudio";
    public static final String CHANNEL_ID = "deck_reader_audio";
    public static final int NOTIFICATION_ID = 1437;

    public static final String ACTION_PLAY = "com.example.app.action.PLAY";
    public static final String ACTION_PAUSE = "com.example.app.action.PAUSE";
    public static final String ACTION_RESUME = "com.example.app.action.RESUME";
    public static final String ACTION_STOP = "com.example.app.action.STOP";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_START_MS = "startMs";
    public static final String EXTRA_RATE = "rate";
    public static final String EXTRA_FADE_MS = "fadeMs";

    // Default fade duration for play / pause / resume. 20 ms — long
    // enough to fully mask the amplitude-discontinuity click (5 ms
    // collapsed to a single hard step here, which still clicked), yet
    // below a perceptible delay. Also governs the dictionary
    // pause/resume (it calls pause()/resume() with no fadeMs). iOS uses
    // the same default via BackgroundAudioPlugin.swift's defaultFadeMs.
    private static final int DEFAULT_FADE_MS = 20;
    // Volume ramp max step granularity (kept for reference). rampVolume
    // targets ~2 ms per step (capped at 12 steps) so the ramp ALWAYS
    // fits inside durationMs: 20 ms = ~10 steps, 5 ms = ~2 steps.
    private static final int FADE_MAX_STEP_MS = 10;

    public interface OnStateChangeListener {
        void onPlayingStateChanged(boolean playing);
        void onPositionUpdate(int positionMs, int durationMs);
        void onEnded();
        void onError(String message);
        // Lock-screen / media-button transport commands the user pressed.
        // action ∈ {"play", "nextCue", "prevCue"}. JS uses "play" to force
        // AUDIO mode (so lock-screen play always starts the audiobook + audio
        // timer, never card/reader), and nextCue/prevCue to jump by subtitle.
        void onRemoteCommand(String action);
    }

    private static BackgroundAudioService instance;
    public static BackgroundAudioService getInstance() { return instance; }

    // Player + state. `exo`, `prepared`, `wantPlaying`, and the position/
    // duration caches are read from other threads (plugin getState, isReady),
    // so they are volatile. Methods are only ever INVOKED on `exo` from the
    // main looper.
    private volatile ExoPlayer exo;
    private volatile boolean prepared = false;
    // Our transport intent (playing vs paused), mirroring what the old
    // player.isPlaying() conveyed at the points the listener fired. Stays true
    // through a fade-out until the pause actually lands, false on pause/stop/
    // end — and never dips on a transient rebuffer (unlike ExoPlayer.isPlaying).
    private volatile boolean wantPlaying = false;
    private volatile int cachedPositionMs = -1;
    private volatile int cachedDurationMs = -1;
    private volatile float pendingRate = 1.0f;
    private volatile int pendingStartMs = 0;
    private volatile OnStateChangeListener listener;
    // URL currently loaded into `exo` (the media item we prepared). Lets a
    // repeated ACTION_PLAY with the SAME url skip the expensive
    // release+rebuild+prepare (parsing the moov of an 877 MB .m4b can take
    // seconds, and it used to run on EVERY bg.play). Set when we set the media
    // item, cleared by stopPlayback. Only read/written on the main looper
    // (onStartCommand / startPlayback / stopPlayback all run there).
    private String currentUrl = null;

    private MediaSessionCompat mediaSession;
    // Metadata fields: written via setMetadata (marshalled to the main looper)
    // and read by buildNotification/onStartCommand on the main looper; volatile
    // is defense-in-depth against any future non-marshalled access.
    private volatile String metaTitle = "Anki Deck Reader";
    private volatile String metaSubtitle = "";
    private volatile android.graphics.Bitmap metaArt;   // lock-screen cover art (persists across cue updates)

    // Durable position store (BookPlayer-style "the player layer owns the save").
    // The SERVICE persists {url, ms} to its own SharedPreferences from this
    // process ~every 5s while playing + on pause/background/kill, INDEPENDENT of
    // the WebView. So even when iOS suspends the WebView or Android LMK reaps it
    // mid-listen (the JS saver freezes there), the saved position keeps tracking
    // the real playhead and a cold restart resumes within seconds of the true
    // spot. JS reads it back via getLastSavedPosition() as a forward-only floor.
    private static final String POS_PREFS = "kadoki_audio_pos";
    private static final String POS_KEY_URL = "lastUrl";
    private static final String POS_KEY_MS = "lastMs";

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureNotificationChannel();
        ensureMediaSession();
        playerHandler.postDelayed(durableSaveTick, 5000);
    }

    // ~5s durable-save heartbeat (main looper = the player thread, so reading
    // the live position is safe). Saves only while playing; runs for the life of
    // the service. Worst-case loss on a hard crash is ~5s (vs the JS saver's 30s
    // and its freeze during background).
    private final Runnable durableSaveTick = new Runnable() {
        @Override public void run() {
            if (wantPlaying) saveLastPositionNow();
            playerHandler.postDelayed(this, 5000);
        }
    };

    // Persist the live playhead now. Callable from any thread (reads volatile
    // currentUrl + the position cache). apply() is async, so this is cheap.
    public void saveLastPositionNow() {
        try {
            String url = currentUrl;
            int ms = getPositionMs();
            if (url == null || ms < 0) return;
            getSharedPreferences(POS_PREFS, Context.MODE_PRIVATE).edit()
                .putString(POS_KEY_URL, url).putInt(POS_KEY_MS, ms).apply();
        } catch (Exception ignored) {}
    }

    // Last durably-saved url — STATIC so JS can read it even when no service
    // instance exists (cold boot after a kill). "" when none.
    public static String readSavedUrl(Context ctx) {
        try { return ctx.getSharedPreferences(POS_PREFS, Context.MODE_PRIVATE).getString(POS_KEY_URL, ""); }
        catch (Exception e) { return ""; }
    }
    public static int readSavedMs(Context ctx) {
        try { return ctx.getSharedPreferences(POS_PREFS, Context.MODE_PRIVATE).getInt(POS_KEY_MS, -1); }
        catch (Exception e) { return -1; }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Safety: we were started via startForegroundService, so we MUST call
        // startForeground within 5 seconds or Android will crash us. Get into
        // foreground immediately, then process the action (including STOP,
        // which itself calls stopForeground afterwards).
        startInForeground(metaSubtitle.isEmpty() ? metaTitle : metaSubtitle);

        String action = intent != null ? intent.getAction() : null;
        Log.d(TAG, "onStartCommand action=" + action);
        if (ACTION_PLAY.equals(action)) {
            String url = intent.getStringExtra(EXTRA_URL);
            int startMs = intent.getIntExtra(EXTRA_START_MS, 0);
            float rate = intent.getFloatExtra(EXTRA_RATE, 1.0f);
            int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
            pendingStartMs = startMs;
            if (rate > 0) pendingRate = rate;
            // SAME-url fast path: the file is already loaded & prepared into
            // `exo`. A repeated bg.play (card replay / re-entering audio mode /
            // PLAY toggle) is then just a seek+play, not a multi-second moov
            // re-parse. Only a genuinely DIFFERENT url (or nothing loaded yet)
            // falls through to the full startPlayback() rebuild.
            if (url != null && url.equals(currentUrl) && exo != null && prepared) {
                Log.d(TAG, "ACTION_PLAY same-url fast path startMs=" + startMs);
                replayLoaded(startMs, fadeMs);
            } else {
                startPlayback(url);
            }
        } else if (ACTION_PAUSE.equals(action)) {
            tryRun(() -> {
                if (exo != null && exo.isPlaying()) {
                    int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
                    fadeOutThenPause(fadeMs);
                }
            });
            updateNotification("Paused");
            updatePlaybackState();
            saveLastPositionNow();   // durably snapshot place on every pause
        } else if (ACTION_RESUME.equals(action)) {
            tryRun(() -> {
                if (exo != null && prepared) {
                    int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
                    fadeInOnResume(fadeMs);
                }
            });
            updateNotification("Playing");
            updatePlaybackState();
        } else if (ACTION_STOP.equals(action)) {
            stopPlayback();
            stopForeground(true);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    // Runs r on the player's (main) looper. Direct API calls from the Capacitor
    // plugin worker thread (seek/setRate/setMetadata) hop here so they never
    // touch ExoPlayer / MediaSession off-thread (which throws / races).
    // IMPORTANT: marshals on playerHandler, NOT fadeHandler — cancelFade()
    // blanket-clears fadeHandler, which would silently drop a queued
    // seek/setRate command body before it ran.
    private void runOnPlayer(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else playerHandler.post(r);
    }

    private final Player.Listener playerListener = new Player.Listener() {
        @Override public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) {
                if (!prepared) onFirstReady();
            } else if (state == Player.STATE_ENDED) {
                Log.d(TAG, "completion");
                wantPlaying = false;
                if (listener != null) listener.onEnded();
                updatePlaybackState();
            }
        }
        @Override public void onPlayerError(PlaybackException error) {
            Log.e(TAG, "ExoPlayer error code=" + error.errorCode + " (" + error.getErrorCodeName() + ")", error);
            wantPlaying = false;
            if (listener != null) {
                listener.onError("ExoPlayer error " + error.errorCode + "/" + error.getErrorCodeName());
            }
            updatePlaybackState(); // don't leave the lock screen stuck on STATE_PLAYING
        }
    };

    private void startPlayback(String url) {
        stopPlayback();
        if (url == null || url.isEmpty()) {
            Log.w(TAG, "no url; nothing to play");
            return;
        }
        try {
            ExoPlayer p = new ExoPlayer.Builder(getApplicationContext()).build();
            exo = p;
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .build();
            // handleAudioFocus=false matches the old MediaPlayer (which never
            // requested focus); the app drives its own pause logic.
            p.setAudioAttributes(attrs, false);
            // Hold a partial wake lock while playing so screen-off CPU sleep
            // can't stall background playback (WAKE_LOCK is granted in the
            // manifest). The old MediaPlayer relied solely on the foreground
            // service; this is strictly more robust.
            p.setWakeMode(C.WAKE_MODE_LOCAL);
            p.addListener(playerListener);
            p.setPlaybackParameters(new PlaybackParameters(pendingRate > 0 ? pendingRate : 1.0f));
            // Start muted when we intend to fade in (see onFirstReady); the
            // audio buffer is empty at first play so there's no click, but the
            // ramp gives the same gentle onset as iOS.
            p.setVolume(DEFAULT_FADE_MS > 0 ? 0f : 1f);
            p.setMediaItem(MediaItem.fromUri(url));
            currentUrl = url; // remember what we loaded for the same-url fast path
            if (pendingStartMs > 0) p.seekTo(pendingStartMs);
            p.setPlayWhenReady(true);
            p.prepare();
        } catch (Exception e) {
            Log.e(TAG, "startPlayback failed", e);
            stopPlayback(); // release the partially-built player + its wake lock
            if (listener != null) listener.onError(e.getMessage());
        }
    }

    // First time the player reaches READY for this media item: mirror the old
    // onPrepared sequence (apply rate, fade in, fire listener + notification).
    private void onFirstReady() {
        ExoPlayer p = exo;
        if (p == null) return;
        prepared = true;
        long d = p.getDuration();
        cachedDurationMs = (d == C.TIME_UNSET || d < 0) ? -1 : (int) d;
        cachedPositionMs = (int) Math.max(0, p.getCurrentPosition());
        Log.d(TAG, "prepared; dur=" + cachedDurationMs + " startMs=" + pendingStartMs);
        applyRate(pendingRate);
        // playWhenReady was set, so playback has begun (muted if fading).
        if (DEFAULT_FADE_MS > 0) {
            rampVolume(0f, 1f, DEFAULT_FADE_MS);
        } else {
            try { p.setVolume(1f); } catch (Exception ignored) {}
        }
        wantPlaying = true;
        updateNotification("Playing");
        updatePlaybackState();
        if (listener != null) {
            listener.onPlayingStateChanged(true);
            listener.onPositionUpdate(cachedPositionMs, cachedDurationMs);
        }
    }

    private void applyRate(float rate) {
        if (rate <= 0) return;
        pendingRate = rate;
        ExoPlayer p = exo;
        if (p == null) return;
        try {
            p.setPlaybackParameters(new PlaybackParameters(rate));
        } catch (Exception e) {
            Log.w(TAG, "applyRate failed", e);
        }
    }

    private void stopPlayback() {
        prepared = false;
        wantPlaying = false;
        currentUrl = null; // nothing loaded → next ACTION_PLAY must rebuild
        cancelFade();
        ExoPlayer p = exo;
        if (p != null) {
            exo = null;
            try { p.removeListener(playerListener); } catch (Exception ignored) {}
            try { p.stop(); } catch (Exception ignored) {}
            try { p.release(); } catch (Exception ignored) {}
            cachedPositionMs = -1;
            cachedDurationMs = -1;
            if (listener != null) listener.onPlayingStateChanged(false);
        }
    }

    // SAME-url fast path body: the player already has this file loaded &
    // prepared, so re-prepare nothing — just (re)apply the rate, jump the
    // playhead, and play with the same gentle fade-in onset as a fresh start.
    // Runs on the main (player) looper via onStartCommand. Mirrors the
    // fade/listener/notification side effects of the onFirstReady path so the
    // lock screen + JS see a consistent "playing from startMs" state.
    //
    // CORRECTNESS: this is the click-free seek+play used for card replay,
    // re-entering audio mode, and the SRT-card PLAY toggle. It honors startMs
    // exactly (always seekTo(startMs), even far jumps), so a card swipe that
    // lands on a distant cue still seeks — never reloads. It does NOT decide
    // whether to seek vs. plain-resume; callers that want a plain resume (no
    // position jump) already use ACTION_RESUME / bg.resume() instead of
    // bg.play(), and live scrub drags use seek(). bg.play() always means
    // "(re)start from this startMs", which is exactly what this delivers.
    private void replayLoaded(int startMs, int fadeMs) {
        final ExoPlayer p = exo;
        if (p == null || !prepared) { startPlayback(currentUrl); return; }
        cancelFade(); // drop any in-flight pause-after-fade / volume ramp
        applyRate(pendingRate);
        try {
            p.seekTo(Math.max(0, startMs));
            cachedPositionMs = Math.max(0, startMs);
            // Fade in from silence so the (re)start onset matches a fresh play
            // and never clicks on a non-zero waveform left by a prior pause.
            if (fadeMs > 0) {
                try { p.setVolume(0f); } catch (Exception ignored) {}
                p.play();
                rampVolume(0f, 1f, fadeMs);
            } else {
                try { p.setVolume(1f); } catch (Exception ignored) {}
                p.play();
            }
            wantPlaying = true;
        } catch (Exception e) {
            Log.w(TAG, "replayLoaded failed; falling back to full rebuild", e);
            startPlayback(currentUrl);
            return;
        }
        updateNotification("Playing");
        updatePlaybackState();
        if (listener != null) {
            listener.onPlayingStateChanged(true);
            listener.onPositionUpdate(cachedPositionMs, getDurationMs());
        }
    }

    // ---- Volume ramp helpers ----
    //
    // ExoPlayer.setVolume is instant — no native fade like iOS
    // AVAudioPlayer.setVolume(_:fadeDuration:). We schedule a sequence
    // of setVolume calls via a main-thread Handler to approximate a
    // linear ramp over `durationMs`. All ramp steps run on the main
    // looper, which is also the player thread, so they touch ExoPlayer
    // safely.
    //
    // Outstanding ramps are cancelled if a new ramp / pause / stop
    // arrives so we never have two ramps fighting over the same
    // setVolume.
    private final Handler fadeHandler = new Handler(Looper.getMainLooper());
    // Separate main-looper channel for marshalling off-thread command bodies
    // (seek/setRate/setMetadata). Kept distinct from fadeHandler so that
    // cancelFade()'s removeCallbacksAndMessages(null) — which clears volume
    // ramps and the pending pause — can never purge a queued command.
    private final Handler playerHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPauseAfterFade = null;

    private void cancelFade() {
        fadeHandler.removeCallbacksAndMessages(null);
        pendingPauseAfterFade = null;
    }

    private void rampVolume(float from, float to, int durationMs) {
        cancelFade();
        final ExoPlayer target = exo;
        if (target == null) return;
        if (durationMs <= 0) {
            try { target.setVolume(to); } catch (Exception ignored) {}
            return;
        }
        // Step count adapts to fit inside durationMs so a 5 ms fade
        // actually delivers volume changes within those 5 ms, not at
        // 10 ms+ as the old fixed FADE_STEP_MS grid would have done.
        int steps = Math.max(1, Math.min(12, durationMs / 2));
        if (steps > durationMs) steps = durationMs; // at most one step per ms
        int stepIntervalMs = Math.max(1, durationMs / steps);
        for (int i = 1; i <= steps; i++) {
            final int step = i;
            final int total = steps;
            fadeHandler.postDelayed(() -> {
                float v = from + (to - from) * ((float) step / (float) total);
                try { target.setVolume(v); } catch (Exception ignored) {}
            }, (long) step * stepIntervalMs);
        }
    }

    private void fadeOutThenPause(int fadeMs) {
        final ExoPlayer mp = exo;
        if (mp == null) return;
        if (fadeMs <= 0) {
            // No fade — set volume to 0 first so pause doesn't click on
            // a non-zero waveform, then pause, then restore for the
            // next play.
            try {
                mp.setVolume(0f);
                mp.pause();
                mp.setVolume(1f);
                wantPlaying = false;
                if (listener != null) listener.onPlayingStateChanged(false);
            } catch (Exception ignored) {}
            // Publish the paused transport state now that wantPlaying is false
            // (the synchronous update in onStartCommand ran while still playing).
            updatePlaybackState();
            updateNotification("Paused");
            return;
        }
        rampVolume(1f, 0f, fadeMs);
        // Schedule the actual pause AFTER the ramp completes.
        // Belt-and-suspenders: also set volume to 0 inside the runnable
        // so if the ramp didn't quite finish before this fires (handler
        // ordering across same-tick callbacks isn't guaranteed), pause
        // still happens at zero amplitude.
        pendingPauseAfterFade = () -> {
            try {
                try { mp.setVolume(0f); } catch (Exception ignored) {}
                if (mp.isPlaying()) mp.pause();
                try { mp.setVolume(1f); } catch (Exception ignored) {} // reset for next play
                wantPlaying = false;
                if (listener != null) listener.onPlayingStateChanged(false);
            } catch (Exception ignored) {}
            // The state published in onStartCommand ran while wantPlaying was
            // still true (fade in flight); correct the lock screen to PAUSED now.
            updatePlaybackState();
            updateNotification("Paused");
            pendingPauseAfterFade = null;
        };
        fadeHandler.postDelayed(pendingPauseAfterFade, fadeMs);
    }

    private void fadeInOnResume(int fadeMs) {
        final ExoPlayer mp = exo;
        if (mp == null) return;
        if (fadeMs <= 0) {
            // No fade — just start at full volume. (Volume was reset
            // to 1 inside the pause runnable, so we don't need to
            // reset here.)
            try { mp.play(); } catch (Exception ignored) {}
            wantPlaying = true;
            if (listener != null) listener.onPlayingStateChanged(true);
            return;
        }
        try { mp.setVolume(0f); } catch (Exception ignored) {}
        try { mp.play(); } catch (Exception ignored) {}
        wantPlaying = true;
        if (listener != null) listener.onPlayingStateChanged(true);
        rampVolume(0f, 1f, fadeMs);
    }

    // ----- Public API for direct calls from BackgroundAudioPlugin -----

    public void setListener(OnStateChangeListener l) {
        this.listener = l;
        // Catch-up: if the player is already prepared when a listener attaches
        // late (race between play() startService and ensureListener), replay
        // the current state so the plugin starts its position poll. Without
        // this, prepared-before-listener loses the state event forever.
        // setListener is invoked on the main looper (scheduleEnsureListener
        // posts to the main Handler), so reading the player live is safe.
        if (l != null && prepared) {
            try {
                l.onPlayingStateChanged(wantPlaying);
                l.onPositionUpdate(getPositionMs(), getDurationMs());
            } catch (Exception ignored) {}
        }
    }

    public boolean isReady() { return prepared && exo != null; }

    public boolean isCurrentlyPlaying() { return wantPlaying; }

    // The url currently loaded — exposed via getState so JS can confirm "same
    // audio" before adopting the native playhead as truth on resume.
    public String getCurrentUrl() { return currentUrl; }

    public int getPositionMs() {
        // Refresh the cache when called on the player (main) looper — the
        // plugin's 150 ms position poll runs there, keeping it fresh. Off-thread
        // callers (getState) get the most recent cached value.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            ExoPlayer p = exo;
            if (p != null && prepared) {
                try { cachedPositionMs = (int) Math.max(0, p.getCurrentPosition()); } catch (Exception ignored) {}
            }
        }
        return prepared ? cachedPositionMs : -1;
    }

    public int getDurationMs() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            ExoPlayer p = exo;
            if (p != null && prepared) {
                try {
                    long d = p.getDuration();
                    cachedDurationMs = (d == C.TIME_UNSET || d < 0) ? -1 : (int) d;
                } catch (Exception ignored) {}
            }
        }
        return prepared ? cachedDurationMs : -1;
    }

    public void seekToMs(int ms) {
        seekToMs(ms, 0);
    }

    // Opt-in CLICK-FREE seek: callers that pass fadeMs > 0 (subtitle swipes,
    // lock-screen prev/next) get a brief volume dip — ramp out, jump the playhead
    // while silent, ramp back in — to mask the amplitude-discontinuity click an
    // abrupt seekTo makes mid-playback. fadeMs == 0 (or while paused → nothing
    // audible) seeks immediately, so continuous scrub-bar dragging stays instant.
    // Mirrors the iOS fade and reuses the same fadeHandler/rampVolume the play/
    // pause fades use. A racing pause/play/seek cancels via cancelFade — the seek
    // may then be dropped, but consecutive swipes recompute the target so the end
    // position is still right, and whatever cancelled it restores the volume.
    public void seekToMs(int ms, int fadeMs) {
        runOnPlayer(() -> tryRun(() -> {
            final ExoPlayer mp = exo;
            if (mp == null || !prepared) return;
            boolean playing = false;
            try { playing = mp.isPlaying(); } catch (Exception ignored) {}
            if (playing && fadeMs > 0) {
                final int target = ms;
                final int f = fadeMs;
                rampVolume(1f, 0f, f);
                fadeHandler.postDelayed(() -> {
                    try {
                        mp.setVolume(0f);          // ensure silence even if the ramp didn't quite finish
                        mp.seekTo(target);         // land the seek while muted
                        cachedPositionMs = target;
                        // Only fade back in if this is still the active player and
                        // we still intend to play; otherwise a pause that landed
                        // during the seek would get un-muted. Restore volume to 1
                        // for the next play either way.
                        if (exo == mp && wantPlaying) {
                            rampVolume(0f, 1f, f); // fade back in
                        } else {
                            mp.setVolume(1f);
                        }
                    } catch (Exception ignored) {}
                }, f);
            } else {
                mp.seekTo(ms);
                cachedPositionMs = ms;
            }
        }));
    }

    public void setRate(float rate) {
        if (rate <= 0) return;
        runOnPlayer(() -> applyRate(rate));
    }

    public void setMetadata(String title, String subtitle) {
        setMetadata(title, subtitle, null); // keep existing artwork
    }

    // artwork: a data-URI ("data:image/...;base64,XXXX") or raw base64. null =
    // leave the current cover art untouched (per-cue subtitle updates pass
    // null); "" = clear it. Cover art is set once on audio-mode entry and
    // persists across the per-cue subtitle updates.
    public void setMetadata(String title, String subtitle, String artwork) {
        // Called directly from the Capacitor plugin worker thread. Marshal onto
        // the main looper where mediaSession lives (MediaSessionCompat is not
        // documented thread-safe, and onDestroy releases it on the main thread).
        runOnPlayer(() -> {
            if (title != null && !title.isEmpty()) metaTitle = title;
            if (subtitle != null) metaSubtitle = subtitle;
            if (artwork != null) metaArt = artwork.isEmpty() ? null : decodeArtwork(artwork);
            String display = (metaSubtitle != null && !metaSubtitle.isEmpty()) ? metaSubtitle : metaTitle;
            if (mediaSession != null) {
                MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, display)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, metaTitle)
                    .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, display)
                    .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, metaTitle);
                if (metaArt != null) {
                    b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, metaArt);
                    b.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, metaArt);
                }
                mediaSession.setMetadata(b.build());
                updatePlaybackState();
            }
            updateNotification(display);
        });
    }

    private android.graphics.Bitmap decodeArtwork(String s) {
        if (s == null || s.isEmpty()) return null;
        String b64 = s;
        int comma = s.indexOf(',');
        if (s.startsWith("data:") && comma >= 0) b64 = s.substring(comma + 1);
        try {
            byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            Log.w(TAG, "decodeArtwork failed", e);
            return null; // keep whatever art we had
        }
    }

    // ----- MediaSession + lock screen -----

    private void ensureMediaSession() {
        if (mediaSession != null) return;
        mediaSession = new MediaSessionCompat(this, "DeckReaderAudio");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() {
                if (exo != null && prepared) {
                    exo.play();
                    wantPlaying = true;
                    if (listener != null) listener.onPlayingStateChanged(true);
                    updatePlaybackState();
                }
                // Tell JS this play came from the lock screen / media controls
                // so it forces AUDIO mode (audiobook + audio timer), never
                // card/reader. Fire even if the player wasn't ready yet — JS
                // will switch to audio mode and (re)start playback there.
                if (listener != null) listener.onRemoteCommand("play");
            }
            @Override public void onPause() {
                if (exo != null && exo.isPlaying()) {
                    exo.pause();
                    wantPlaying = false;
                    if (listener != null) listener.onPlayingStateChanged(false);
                    updatePlaybackState();
                }
            }
            @Override public void onSeekTo(long pos) {
                seekToMs((int) pos);
                updatePlaybackState();
            }
            // ⏮ / ⏭ jump by SUBTITLE CUE. JS owns cue boundaries, so we just
            // notify it (mirrors the iOS nextTrack/previousTrack handlers).
            @Override public void onSkipToNext() {
                if (listener != null) listener.onRemoteCommand("nextCue");
            }
            @Override public void onSkipToPrevious() {
                if (listener != null) listener.onRemoteCommand("prevCue");
            }
            @Override public void onStop() {
                stopPlayback();
                stopForeground(true);
                stopSelf();
            }
        });
        mediaSession.setActive(true);
        // Initial metadata.
        setMetadata(metaTitle, metaSubtitle);
    }

    private void updatePlaybackState() {
        if (mediaSession == null) return;
        int state = isCurrentlyPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        long pos = Math.max(0, getPositionMs());
        PlaybackStateCompat ps = new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SEEK_TO
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_STOP)
            .setState(state, pos, pendingRate)
            .build();
        mediaSession.setPlaybackState(ps);
    }

    // ----- Notification + lifecycle -----

    private void startInForeground(String text) {
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) { // 34
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private Notification buildNotification(String text) {
        Intent openApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentPi = openApp != null
            ? PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : null;
        // Display the current sentence (subtitle) as the title on lock screen
        // when set, with the book/app name as the secondary line.
        String displayTitle = (metaSubtitle != null && !metaSubtitle.isEmpty()) ? metaSubtitle : metaTitle;
        String displayText = (metaSubtitle != null && !metaSubtitle.isEmpty()) ? metaTitle : text;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(displayTitle)
            .setContentText(displayText)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        if (metaArt != null) b.setLargeIcon(metaArt); // lock-screen cover art
        if (mediaSession != null) {
            b.setStyle(new MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView());
        }
        if (contentPi != null) b.setContentIntent(contentPi);
        return b.build();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Audio playback", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Background audio for shadowing and audiobook listening");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private void tryRun(Runnable r) {
        try { r.run(); } catch (Exception e) { Log.e(TAG, "tryRun", e); }
    }

    // User swiped the app away from Recents — persist place before the system
    // tears us down (the WebView/JS saver may already be gone).
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        saveLastPositionNow();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        saveLastPositionNow();                       // final durable snapshot
        playerHandler.removeCallbacks(durableSaveTick);
        stopPlayback();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
