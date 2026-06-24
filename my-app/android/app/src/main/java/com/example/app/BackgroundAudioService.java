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
        // Native chapter-repeat: idx >= 0 means we just paused at the end of
        // chapter idx to announce + rewind; idx == -1 means the announce/rewind
        // cycle is over (resumed) so JS can clear any "repeating chapter N" UI.
        void onChapterRepeat(int idx);
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

    // Transient audio-focus suppression (phone call, navigation prompt — and,
    // because we declare CONTENT_TYPE_SPEECH, even "duckable" notification
    // dings): ExoPlayer keeps playWhenReady=true but silences playback, then
    // silently AUTO-RESUMES on focus regain — even minutes later with the app
    // backgrounded. That was the reported runaway: a phone call "paused" the
    // book, the call ended while minimized, ExoPlayer resumed into idle
    // earbuds, and the position (and the durable saves) ran forward for the
    // whole background span. We mirror suppression as a visible pause
    // (lock screen, notification state, JS) and arm a deadline: a short loss
    // auto-resumes seamlessly, anything longer than SUPPRESSION_GRACE_MS is
    // converted into a REAL pause so playback never resumes behind the
    // user's back. Volatile: read by isCurrentlyPlaying() off-thread.
    private static final long SUPPRESSION_GRACE_MS = 60_000;
    private volatile boolean suppressed = false;

    // ----- Native chapter-repeat -----
    //
    // Implemented entirely in the service so it works while backgrounded /
    // screen-off (the foreground mediaPlayback service keeps the main looper
    // alive — proven by durableSaveTick). On each forward crossing into a new
    // chapter we pause, speak the chapter's announcement via TTS, rewind to the
    // chapter start, and resume. A failsafe ALWAYS resumes so the book can
    // never be left paused (see doChapterRepeat / finishRepeat).
    public static final class Chapter {
        public final int idx; public final long startMs; public final long endMs; public final String announce;
        public Chapter(int idx, long startMs, long endMs, String announce) { this.idx=idx; this.startMs=startMs; this.endMs=endMs; this.announce=announce; }
    }
    private volatile boolean repeatEnabled = false;
    private volatile Chapter[] chapters = null;
    private int repeatLastPosMs = -1;
    private int repeatLastChapIdx = -1;
    private int repeatInPass = -1;
    private final java.util.HashSet<Integer> repeatedChapters = new java.util.HashSet<>();   // array positions whose ONE repeat is done — never repeat again (skip-back safe)
    private boolean repeatBusy = false;
    private long repeatSeekGuardUntil = 0;
    private long repeatUtterToken = 0;
    private int repeatPendingTarget = -1;
    private static final int REPEAT_TICK_MS = 700;
    private static final long ANNOUNCE_FAILSAFE_MS = 4500;
    private android.speech.tts.TextToSpeech tts = null;
    private volatile boolean ttsReady = false;

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
        String action = intent != null ? intent.getAction() : null;
        Log.d(TAG, "onStartCommand action=" + action);
        // We were started via startForegroundService (the plugin), so we MUST call
        // startForeground within 5s or Android crashes us — promote here for every
        // action EXCEPT STOP. STOP tears the service down itself; promoting first
        // would, on a BACKGROUND notification-swipe (getService delivery), throw
        // and leave a stuck non-foreground ongoing notification (the reported bug).
        if (!ACTION_STOP.equals(action)) {
            startInForeground(metaSubtitle.isEmpty() ? metaTitle : metaSubtitle);
        }
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
                // Also take the pause path while SUPPRESSED (phone call):
                // isPlaying() is false then, but playWhenReady is still true and
                // would silently auto-resume after the call — an explicit pause
                // must actually land (fadeOutThenPause clears playWhenReady).
                if (exo != null && (exo.isPlaying() || suppressed)) {
                    int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
                    fadeOutThenPause(fadeMs);
                }
            });
            showPausedNotification("Paused");
            updatePlaybackState();
            saveLastPositionNow();   // durably snapshot place on every pause
        } else if (ACTION_RESUME.equals(action)) {
            if (exo == null || currentUrl == null) {
                // Nothing loaded: the service was re-created EMPTY (paused
                // notification dismissed → stopSelf, or process recycled) or
                // the player ERRORED (onPlayerError clears currentUrl).
                // Promoting here pinned a non-dismissible "Playing" 0:00
                // notification with no audio. Satisfy the FGS-start contract
                // briefly, then tear down — the JS side detects not-ready and
                // falls back to a fresh bg.play() at the saved position.
                // NOTE: exo != null && !prepared (a play() still buffering)
                // deliberately does NOT take this path — tearing down a
                // mid-prepare playback would kill audio that's about to start;
                // the no-op resume below keeps the old semantics there.
                try {
                    Notification n = buildNotification("", false);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                    } else {
                        startForeground(NOTIFICATION_ID, n);
                    }
                } catch (Exception ignored) {}
                stopForeground(true);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIFICATION_ID);
                stopSelf();
                return START_NOT_STICKY;
            }
            tryRun(() -> {
                if (prepared) {
                    int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
                    fadeInOnResume(fadeMs);
                }
                // !prepared: play() is mid-prepare; playWhenReady is already
                // true, onFirstReady will start it — nothing to do.
            });
            startInForeground("Playing");
            updatePlaybackState();
        } else if (ACTION_STOP.equals(action)) {
            // Briefly enter foreground to satisfy the startForegroundService 5s
            // contract, then fully tear down + REMOVE the notification. try/catch
            // covers the notification-swipe deleteIntent (getService delivery),
            // where startForeground from the background can throw — we stop anyway.
            try {
                Notification n = buildNotification("", false);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                } else {
                    startForeground(NOTIFICATION_ID, n);
                }
            } catch (Exception ignored) {}
            saveLastPositionNow();      // persist BEFORE stopPlayback wipes currentUrl
            stopPlayback();
            stopForeground(true);       // STOP_FOREGROUND_REMOVE
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
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
                // Last-chapter repeat: the final chapter has no "next" to cross INTO, so
                // detectChapterCrossing never fires for it — trigger its one repeat here
                // at EOF. Mark it done first so the SECOND end finishes normally.
                // (ExoPlayer callbacks arrive on the main looper == playerHandler thread,
                // so calling doChapterRepeat directly honors the single-thread invariant.)
                // Gate on >=2 chapters (matches the crossing detector + TTS arm; a
                // 1-chapter "book" would replay the whole thing silently).
                Chapter[] chs = chapters;
                if (repeatEnabled && !repeatBusy && chs != null && chs.length >= 2) {
                    int lastPos = chs.length - 1;
                    if (chs[lastPos] != null && !repeatedChapters.contains(lastPos)) {
                        repeatedChapters.add(lastPos);
                        emitChapterRepeat(lastPos);
                        doChapterRepeat(chs[lastPos]);
                        return;
                    }
                }
                Log.d(TAG, "completion");
                endOfBook();
            }
        }
        @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            // ExoPlayer now self-pauses on permanent audio-focus loss (another
            // app takes over) and on becoming-noisy (BT/headphone disconnect) —
            // see setAudioAttributes/setHandleAudioBecomingNoisy in
            // startPlayback. Mirror those into the service state exactly like
            // an explicit pause; otherwise the notification stays "Playing",
            // JS keeps _bgPlaying=true, and the playhead silently runs away.
            if (!playWhenReady &&
                (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS ||
                 reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY)) {
                Log.d(TAG, "self-pause (focus/noisy) reason=" + reason);
                // Abort any in-flight fade ramp: a fade-in racing this pause
                // would keep ramping volume on a paused player and leave it
                // at the wrong level for the next resume.
                cancelFade();
                clearSuppression();   // a permanent loss supersedes a transient one
                wantPlaying = false;
                saveLastPositionNow();
                updatePlaybackState();
                showPausedNotification("Paused");
                if (listener != null) listener.onPlayingStateChanged(false);
            }
        }
        @Override public void onPlaybackSuppressionReasonChanged(int reason) {
            if (reason == Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS) {
                // Sound just went silent but the transport still intends to
                // play (and will auto-resume). Mirror as PAUSED everywhere the
                // user can see, and arm the hard-pause deadline. Keep the
                // service FOREGROUND: an auto-resume inside the grace window
                // must remain a legal foreground playback.
                if (!wantPlaying || suppressed) return;
                if (pendingPauseAfterFade != null) {
                    // An EXPLICIT pause is mid-fade. It must win over the
                    // suppression mirror: land it now instead of letting the
                    // cancelFade below delete it (which would leave
                    // playWhenReady=true and auto-resume against the user's
                    // pause when the focus loss ends within the grace window).
                    Runnable pp = pendingPauseAfterFade;
                    cancelFade();
                    pp.run();
                    return;
                }
                Log.d(TAG, "suppressed (transient focus loss); grace=" + SUPPRESSION_GRACE_MS + "ms");
                suppressed = true;
                cancelFade();          // a ramp racing the silence would mis-set volume
                saveLastPositionNow();
                updatePlaybackState(); // lock screen → PAUSED (isCurrentlyPlaying is false now)
                if (listener != null) listener.onPlayingStateChanged(false);
                playerHandler.removeCallbacks(suppressionHardPause);
                playerHandler.postDelayed(suppressionHardPause, SUPPRESSION_GRACE_MS);
            } else if (reason == Player.PLAYBACK_SUPPRESSION_REASON_NONE) {
                playerHandler.removeCallbacks(suppressionHardPause);
                if (!suppressed) return;
                suppressed = false;
                // Focus came back within the grace window → ExoPlayer
                // auto-resumed. Re-publish the playing state (restarts the
                // plugin's position poll, re-pins the notification).
                ExoPlayer p = exo;
                boolean resumes = false;
                try { resumes = p != null && p.getPlayWhenReady() && wantPlaying; } catch (Exception ignored) {}
                if (resumes) {
                    Log.d(TAG, "suppression lifted within grace — auto-resumed");
                    // The suppression-start cancelFade may have killed a ramp
                    // mid-flight; make sure the resume isn't stuck quiet.
                    try { p.setVolume(1f); } catch (Exception ignored) {}
                    updatePlaybackState();
                    startInForeground("Playing");
                    if (listener != null) {
                        listener.onPlayingStateChanged(true);
                        listener.onPositionUpdate(getPositionMs(), getDurationMs());
                    }
                }
            }
        }
        @Override public void onPlayerError(PlaybackException error) {
            Log.e(TAG, "ExoPlayer error code=" + error.errorCode + " (" + error.getErrorCodeName() + ")", error);
            clearSuppression();
            wantPlaying = false;
            // Reset the load state so the next play() takes the FULL
            // startPlayback rebuild — the same-url fast path on an errored
            // (IDLE) player ran replayLoaded without prepare(), leaving
            // playback dead with a frozen playhead until a title switch.
            prepared = false;
            currentUrl = null;
            if (listener != null) {
                listener.onError("ExoPlayer error " + error.errorCode + "/" + error.getErrorCodeName());
                // Playback is dead — tell JS explicitly. onPlayerError doesn't go
                // through any pause path, so without this window._bgPlaying stayed
                // stale-true and the next card tap issued a bg.seek into a dead
                // player (silence) instead of a fresh bg.play.
                listener.onPlayingStateChanged(false);
            }
            updatePlaybackState(); // don't leave the lock screen stuck on STATE_PLAYING
            // Demote so a playback error doesn't leave a pinned, non-dismissible
            // notification with no audio (the reported stuck-notification bug on the
            // error path). wantPlaying is false above, so this actually demotes.
            showPausedNotification("Stopped");
        }
    };

    // Deadline armed at suppression start: still silent after the grace window
    // (an answered call, not a ding) → convert the pending auto-resume into a
    // REAL pause. Runs on playerHandler (main looper = the player thread).
    private final Runnable suppressionHardPause = new Runnable() {
        @Override public void run() {
            if (!suppressed || !wantPlaying) return;
            Log.d(TAG, "transient focus loss outlived grace — converting to hard pause");
            // Order matters: drop the flag BEFORE setPlayWhenReady(false) so the
            // resulting onPlaybackSuppressionReasonChanged(NONE) callback no-ops
            // instead of announcing a resume.
            suppressed = false;
            wantPlaying = false;
            ExoPlayer p = exo;
            if (p != null) {
                try { p.setPlayWhenReady(false); } catch (Exception ignored) {}
                // The suppression-entry cancelFade may have killed a volume
                // ramp mid-step (e.g. a fade-seek's restore); reset to full so
                // the post-call resume isn't near-silent. Mirrors the reset
                // every other pause path does.
                try { p.setVolume(1f); } catch (Exception ignored) {}
            }
            saveLastPositionNow();
            updatePlaybackState();
            showPausedNotification("Paused");
            if (listener != null) listener.onPlayingStateChanged(false);
        }
    };

    // Forget any transient-suppression state: an explicit pause/stop/play or a
    // player error supersedes the pending auto-resume bookkeeping.
    private void clearSuppression() {
        suppressed = false;
        playerHandler.removeCallbacks(suppressionHardPause);
    }

    // Re-derive suppression from the LIVE player after a (re)start lands. A
    // transient focus loss during the prepare/BUFFERING window (a call arriving
    // while the moov of a big .m4b parses) fires the suppression event while
    // wantPlaying is still false, so the listener gate drops it — without this
    // check, onFirstReady would then announce "playing" on a silently
    // suppressed player with no grace deadline (the original runaway, confined
    // to the prepare window). Main looper only. Returns true when the mirror
    // engaged (callers should announce paused instead of playing).
    private boolean mirrorSuppressionIfActive(ExoPlayer p) {
        try {
            if (p != null && p.getPlaybackSuppressionReason()
                    == Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS) {
                if (!suppressed) {
                    Log.d(TAG, "suppressed at start (focus lost during prepare); grace armed");
                    suppressed = true;
                    saveLastPositionNow();
                    playerHandler.removeCallbacks(suppressionHardPause);
                    playerHandler.postDelayed(suppressionHardPause, SUPPRESSION_GRACE_MS);
                }
                return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

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
            // handleAudioFocus=true: ExoPlayer requests audio focus and
            // self-pauses on permanent loss (and ducks/suppresses during a
            // phone call, resuming after). Without it a call never paused
            // playback — the position ran away FORWARD and the never-regress
            // furthest mark durably committed it. The self-pause is mirrored
            // into service/JS state in onPlayWhenReadyChanged above.
            p.setAudioAttributes(attrs, true);
            // Pause when the audio route becomes noisy (Bluetooth/headphone
            // disconnect) instead of blasting the speaker + running away.
            p.setHandleAudioBecomingNoisy(true);
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
        // A call may have arrived DURING the prepare — the suppression event
        // fired before wantPlaying was true and was dropped. Re-derive it so
        // we never announce "playing" on a silently suppressed player.
        boolean sup = mirrorSuppressionIfActive(p);
        startInForeground(sup ? "Paused" : "Playing"); // stay foreground either way: auto-resume must stay legal
        updatePlaybackState();
        if (listener != null) {
            listener.onPlayingStateChanged(!sup);
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
        clearSuppression();
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
        // Fresh explicit play: forget any pending suppression bookkeeping.
        // If the player is in fact still suppressed (call ongoing), the
        // mirrorSuppressionIfActive check at the end of this method re-reads
        // the live reason and re-engages the mirror with a fresh deadline.
        clearSuppression();
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
        // Same prepare-window rule as onFirstReady: if focus is currently held
        // by a call, the player is suppressed right now — mirror it instead of
        // announcing a playing state that has no sound behind it.
        boolean sup = mirrorSuppressionIfActive(p);
        startInForeground(sup ? "Paused" : "Playing");
        updatePlaybackState();
        if (listener != null) {
            listener.onPlayingStateChanged(!sup);
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
        clearSuppression();   // explicit pause supersedes any pending auto-resume
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
            showPausedNotification("Paused");
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
                // Unconditional: while focus-suppressed isPlaying() is false but
                // playWhenReady is still true — the old isPlaying() gate skipped
                // the pause and the player auto-resumed after the call anyway.
                // pause() on an already-paused player is a no-op.
                mp.pause();
                try { mp.setVolume(1f); } catch (Exception ignored) {} // reset for next play
                wantPlaying = false;
                if (listener != null) listener.onPlayingStateChanged(false);
            } catch (Exception ignored) {}
            // The state published in onStartCommand ran while wantPlaying was
            // still true (fade in flight); correct the lock screen to PAUSED now.
            updatePlaybackState();
            showPausedNotification("Paused");
            pendingPauseAfterFade = null;
        };
        fadeHandler.postDelayed(pendingPauseAfterFade, fadeMs);
    }

    private void fadeInOnResume(int fadeMs) {
        final ExoPlayer mp = exo;
        if (mp == null) return;
        if (suppressed) {
            // Resume requested DURING a transient focus loss (call still
            // active): sound can't start until focus returns, but the user has
            // explicitly said "keep going" — disarm the hard-pause deadline so
            // the auto-resume fires whenever the call ends, and let the
            // suppression-NONE mirror announce the playing state then.
            playerHandler.removeCallbacks(suppressionHardPause);
            wantPlaying = true;
            try { mp.play(); } catch (Exception ignored) {}
            return;
        }
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
                // isCurrentlyPlaying (not raw wantPlaying): during transient
                // focus suppression the mirror reports paused — the catch-up
                // replay must match it, not announce a silent "playing".
                l.onPlayingStateChanged(isCurrentlyPlaying());
                l.onPositionUpdate(getPositionMs(), getDurationMs());
            } catch (Exception ignored) {}
        }
    }

    public boolean isReady() { return prepared && exo != null; }

    // "Playing" as the user perceives it: transport intends to play AND sound
    // is actually coming out. During transient focus suppression (phone call)
    // wantPlaying stays true but we report paused — lock screen, position
    // poll, and JS all show the truth instead of a silent "Playing".
    public boolean isCurrentlyPlaying() { return wantPlaying && !suppressed; }

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
        runOnPlayer(() -> {
        // An external seek invalidates the chapter-crossing baseline; arm a
        // brief guard so the detection tick re-baselines instead of mistaking
        // the jump for a natural forward crossing.
        repeatSeekGuardUntil = android.os.SystemClock.uptimeMillis() + 1000; repeatLastPosMs = -1; repeatLastChapIdx = -1;
        tryRun(() -> {
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
        });
        });
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

    // ----- Native chapter-repeat implementation -----

    // Self-reposting detection tick (runs on the player/main looper while
    // enabled, like durableSaveTick — alive screen-off under the FGS).
    private final Runnable repeatTick = new Runnable() {
        @Override public void run() {
            try { detectChapterCrossing(); } catch (Exception e) { Log.e(TAG, "repeatTick", e); }
            if (repeatEnabled) playerHandler.postDelayed(this, REPEAT_TICK_MS);
        }
    };

    private void detectChapterCrossing() {
        if (!repeatEnabled || repeatBusy) return;
        Chapter[] chs = chapters;
        if (chs == null || chs.length < 2) return;
        ExoPlayer p = exo;
        if (p == null || !prepared || !wantPlaying || suppressed) return;
        int pos = getPositionMs();
        int curIdx = chapterIndexForMs(pos, chs);
        int prevMs = repeatLastPosMs, prevIdx = repeatLastChapIdx;
        repeatLastPosMs = pos; repeatLastChapIdx = curIdx;
        if (android.os.SystemClock.uptimeMillis() < repeatSeekGuardUntil) return;
        if (prevMs < 0 || prevIdx < 0 || curIdx < 0) return;
        int delta = pos - prevMs;
        if (!(delta > 0 && delta < 3000)) return;
        if (curIdx != prevIdx + 1) return;
        // The repeat pass for prevIdx just ended -> mark it done so it never repeats
        // again (e.g. if the user later scrubs back into it), then advance.
        if (repeatInPass == prevIdx) { repeatedChapters.add(prevIdx); repeatInPass = -1; emitChapterRepeat(-1); return; }
        // Already repeated once this session -> don't repeat again (skip-back safe).
        if (repeatedChapters.contains(prevIdx)) return;
        Chapter ended = chs[prevIdx];
        if (ended != null) { repeatInPass = prevIdx; emitChapterRepeat(prevIdx); doChapterRepeat(ended); }
    }

    private int chapterIndexForMs(int ms, Chapter[] chs) {
        int best = -1;
        for (int i = 0; i < chs.length; i++) { Chapter c = chs[i]; if (c == null) continue; if (ms >= c.startMs && ms <= c.endMs) return i; if (c.startMs <= ms) best = i; }
        return best;
    }

    // Pause -> speak -> (later) seek -> resume. Pause EXPLICITLY (a USER_REQUEST
    // pause, not the focus-suppression mirror) so onPlayWhenReadyChanged's
    // focus/noisy gate ignores it. NEVER leaves the book paused: a failsafe
    // postDelayed funnels to finishRepeat, as do onDone/onError.
    private void doChapterRepeat(Chapter ch) {
        if (repeatBusy) return;
        repeatBusy = true;
        final long token = ++repeatUtterToken;
        repeatPendingTarget = (int) Math.max(0, ch.startMs);
        final String announce = ch.announce;
        cancelFade();
        ExoPlayer p = exo;
        if (p != null) { try { p.setVolume(1f); p.pause(); } catch (Exception ignored) {} }
        playerHandler.postDelayed(() -> finishRepeat(token), ANNOUNCE_FAILSAFE_MS);
        if (ttsReady && tts != null && announce != null && !announce.isEmpty()) {
            try {
                android.os.Bundle b = new android.os.Bundle();
                b.putFloat(android.speech.tts.TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
                int r = tts.speak(announce, android.speech.tts.TextToSpeech.QUEUE_FLUSH, b, "kadoki-cr-" + token);
                if (r != android.speech.tts.TextToSpeech.SUCCESS) playerHandler.postDelayed(() -> finishRepeat(token), 250);
            } catch (Exception e) { playerHandler.postDelayed(() -> finishRepeat(token), 250); }
        } else {
            playerHandler.postDelayed(() -> finishRepeat(token), 250);
        }
    }

    private void finishRepeat(long token) {
        if (token != repeatUtterToken || !repeatBusy) return;
        repeatBusy = false;
        int target = repeatPendingTarget; repeatPendingTarget = -1;
        ExoPlayer p = exo;
        if (p == null || !prepared) return;
        try {
            if (repeatEnabled && target >= 0) {
                p.seekTo(target); cachedPositionMs = target;
                repeatSeekGuardUntil = android.os.SystemClock.uptimeMillis() + 1200;
                repeatLastPosMs = -1; repeatLastChapIdx = -1;
            }
            resumeInPlace();
        } catch (Exception e) { Log.e(TAG, "finishRepeat", e); try { p.play(); wantPlaying = true; } catch (Exception ignored) {} }
    }

    // Natural end-of-book: emit ended + make the notification dismissible. Extracted
    // so both STATE_ENDED and a repeat-cancel-at-EOF finish the book cleanly (a bare
    // play()/resumeInPlace() at STATE_ENDED is a no-op that strands wantPlaying=true).
    private void endOfBook() {
        wantPlaying = false;
        if (listener != null) listener.onEnded();
        updatePlaybackState();
        showPausedNotification("Finished");
    }

    private void resumeInPlace() {
        ExoPlayer p = exo;
        if (p == null || !prepared) return;
        try { p.setVolume(1f); p.play(); } catch (Exception ignored) {}
        wantPlaying = true;
        saveLastPositionNow();
        updatePlaybackState();
        startInForeground("Playing");
        if (listener != null) { listener.onPlayingStateChanged(true); listener.onPositionUpdate(getPositionMs(), getDurationMs()); }
    }

    // Lazy TTS init (ja voice). UtteranceProgressListener marshals to playerHandler.
    // NOTE: android.media.AudioAttributes is FULLY QUALIFIED — the service imports
    // androidx.media3.common.AudioAttributes, so a bare AudioAttributes is the wrong type.
    private void ensureTts() {
        if (tts != null) return;
        try {
            tts = new android.speech.tts.TextToSpeech(getApplicationContext(), status -> {
                if (status == android.speech.tts.TextToSpeech.SUCCESS && tts != null) {
                    try {
                        tts.setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build());
                        int lr = tts.setLanguage(java.util.Locale.JAPANESE);
                        ttsReady = !(lr == android.speech.tts.TextToSpeech.LANG_MISSING_DATA || lr == android.speech.tts.TextToSpeech.LANG_NOT_SUPPORTED);
                    } catch (Exception e) { ttsReady = false; }
                } else { ttsReady = false; }
            });
            tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { onAnnounceFinished(id); }
                @Override public void onError(String id) { onAnnounceFinished(id); }
                @Override public void onError(String id, int code) { onAnnounceFinished(id); }
            });
        } catch (Exception e) { Log.e(TAG, "ensureTts", e); tts = null; ttsReady = false; }
    }

    private void onAnnounceFinished(String utteranceId) {
        long token = -1;
        try { if (utteranceId != null && utteranceId.startsWith("kadoki-cr-")) token = Long.parseLong(utteranceId.substring(10)); } catch (Exception ignored) {}
        final long t = token;
        playerHandler.post(() -> finishRepeat(t));
    }

    // ----- Public chapter-repeat API (called from BackgroundAudioPlugin) -----

    public void setChapterRepeat(boolean enabled, Chapter[] chs) {
        runOnPlayer(() -> {
            boolean wasOn = repeatEnabled;
            int oldCount = (chapters != null) ? chapters.length : 0;
            repeatEnabled = enabled; chapters = chs;
            repeatLastPosMs = -1; repeatLastChapIdx = -1;
            // Fresh arm (off->on) or a re-segment (chapter count changed) restarts the
            // "once each" budget. A benign re-send with the SAME chapters (e.g. the
            // kai:ai-data map refresh that fires while listening) preserves what's done.
            int newCount = (chs != null) ? chs.length : 0;
            if (enabled && (!wasOn || newCount != oldCount)) repeatedChapters.clear();
            if (enabled && chs != null && chs.length >= 2) {
                ensureTts();
                playerHandler.removeCallbacks(repeatTick); playerHandler.postDelayed(repeatTick, REPEAT_TICK_MS);
            } else {
                playerHandler.removeCallbacks(repeatTick);
                if (repeatBusy) {
                    ++repeatUtterToken; repeatBusy = false;
                    try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
                    // If we paused for the final chapter's EOF announce, the player is at
                    // STATE_ENDED — resumeInPlace() would be a no-op that strands it
                    // "playing". End the book cleanly instead.
                    ExoPlayer pp = exo;
                    if (pp != null && pp.getPlaybackState() == Player.STATE_ENDED) endOfBook();
                    else resumeInPlace();
                }
                repeatInPass = -1; emitChapterRepeat(-1);
            }
        });
    }

    public void skipToNextChapter() {
        runOnPlayer(() -> {
            Chapter[] chs = chapters; int from = repeatInPass;
            ++repeatUtterToken; repeatBusy = false; repeatInPass = -1;
            try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
            emitChapterRepeat(-1);
            ExoPlayer p = exo;
            if (p == null || !prepared) return;
            if (from < 0) from = chapterIndexForMs(getPositionMs(), chs);   // robust if no active pass
            // We're leaving this chapter (mid-repeat or not) -> mark it done so
            // re-entering it later won't repeat it again.
            if (from >= 0) repeatedChapters.add(from);
            if (chs != null && from >= 0 && (from + 1) < chs.length && chs[from + 1] != null) {
                int target = (int) Math.max(0, chs[from + 1].startMs);
                try { p.seekTo(target); cachedPositionMs = target; repeatSeekGuardUntil = android.os.SystemClock.uptimeMillis() + 1200; repeatLastPosMs = -1; repeatLastChapIdx = -1; } catch (Exception ignored) {}
            }
            resumeInPlace();
        });
    }

    private void emitChapterRepeat(int idx) { if (listener != null) listener.onChapterRepeat(idx); }

    // ----- MediaSession + lock screen -----

    private void ensureMediaSession() {
        if (mediaSession != null) return;
        mediaSession = new MediaSessionCompat(this, "DeckReaderAudio");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() {
                if (exo != null && prepared) {
                    if (suppressed) {
                        // Play pressed during a call: honor the intent (resume
                        // when focus returns, no hard-pause deadline) but don't
                        // claim "playing" while the sound is still suppressed —
                        // the suppression-NONE mirror announces it then.
                        playerHandler.removeCallbacks(suppressionHardPause);
                        wantPlaying = true;
                        exo.play();
                    } else {
                        exo.play();
                        wantPlaying = true;
                        startInForeground("Playing");   // re-pin the notification while playing
                        if (listener != null) listener.onPlayingStateChanged(true);
                        updatePlaybackState();
                    }
                }
                // Tell JS this play came from the lock screen / media controls
                // so it forces AUDIO mode (audiobook + audio timer), never
                // card/reader. Fire even if the player wasn't ready yet — JS
                // will switch to audio mode and (re)start playback there.
                if (listener != null) listener.onRemoteCommand("play");
            }
            @Override public void onPause() {
                // Same suppressed-pause rule as ACTION_PAUSE: a lock-screen pause
                // during a phone call must clear playWhenReady or the player
                // auto-resumes when the call ends despite the user's pause.
                if (exo != null && (exo.isPlaying() || suppressed)) {
                    clearSuppression();
                    exo.pause();
                    wantPlaying = false;
                    if (listener != null) listener.onPlayingStateChanged(false);
                    updatePlaybackState();
                }
                saveLastPositionNow();              // persist before the demote makes us reapable
                showPausedNotification("Paused");   // make the notification swipe-dismissible
            }
            @Override public void onSeekTo(long pos) {
                seekToMs((int) pos);
                updatePlaybackState();
                // Durably persist a lock-screen scrub — while PAUSED nothing
                // else saves it (the heartbeat only runs while playing), and
                // the demoted paused service is reapable: an LMK kill reverted
                // the scrub to the pre-scrub position. Delayed so the
                // marshalled (and possibly fade-deferred) seek has landed.
                playerHandler.postDelayed(() -> saveLastPositionNow(), 600);
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
                saveLastPositionNow();   // before stopPlayback wipes currentUrl (ACTION_STOP already does this)
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

    // Promote to a foreground service with a PINNED (ongoing, non-dismissible)
    // notification — used while PLAYING. The system forces a foreground service's
    // notification ongoing, so this is what keeps it non-swipeable during playback.
    private void startInForeground(String text) {
        Notification n = buildNotification(text, true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) { // 34
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            // startForeground can throw if invoked from the background on Android
            // 12+ (rare — promotion happens on user-initiated play). Fall back to a
            // NON-ongoing (dismissible) notification — an ongoing one here would be
            // stuck (not backed by a foreground service), the reported bug class.
            Log.e(TAG, "startForeground", e);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text, false));
        }
    }

    // Passive notification refresh (e.g. the subtitle changed) — keep the CURRENT
    // dismiss state: pinned while playing, swipe-dismissible while paused.
    private void updateNotification(String text) {
        if (wantPlaying) startInForeground(text);
        else showPausedNotification(text);
    }

    // Demote from foreground so the (non-ongoing) notification becomes SWIPE-
    // DISMISSIBLE — used while PAUSED / ENDED. The notification stays visible (with
    // controls); swiping it away fires ACTION_STOP (setDeleteIntent) → stop + clear.
    // We only ever demote when NOT actively playing, so the OS can't kill audio
    // mid-playback; place is already saved, so a later kill is harmless.
    private void showPausedNotification(String text) {
        // Only DEMOTE when not actively playing — never drop foreground while audio
        // is still playing. (Called from ACTION_PAUSE before the fade-out pause
        // actually lands, where wantPlaying is briefly still true; the fade
        // completion re-calls this with wantPlaying=false to perform the demote.)
        if (!wantPlaying) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(Service.STOP_FOREGROUND_DETACH);
                } else {
                    stopForeground(false);
                }
            } catch (Exception ignored) {}
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text, false));
    }

    private Notification buildNotification(String text) { return buildNotification(text, true); }
    private Notification buildNotification(String text, boolean ongoing) {
        Intent openApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentPi = openApp != null
            ? PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : null;
        // Swipe-to-dismiss → stop. A non-ongoing (paused/ended) notification can be
        // swiped away; that fires ACTION_STOP, which stops playback and clears it.
        // Harmless while ongoing (it can't be swiped then).
        PendingIntent stopPi = PendingIntent.getService(this, 1,
            new Intent(this, BackgroundAudioService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Display the current sentence (subtitle) as the title on lock screen
        // when set, with the book/app name as the secondary line.
        String displayTitle = (metaSubtitle != null && !metaSubtitle.isEmpty()) ? metaSubtitle : metaTitle;
        String displayText = (metaSubtitle != null && !metaSubtitle.isEmpty()) ? metaTitle : text;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(displayTitle)
            .setContentText(displayText)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(ongoing)
            .setDeleteIntent(stopPi)
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
        playerHandler.removeCallbacks(repeatTick);
        if (tts != null) { try { tts.stop(); } catch (Exception ignored) {} try { tts.shutdown(); } catch (Exception ignored) {} tts = null; }
        stopPlayback();
        // Remove the notification on teardown — a service destroyed while DEMOTED
        // (paused) won't auto-clear its detached notification, which would leave it
        // posted with no backing service.
        try {
            stopForeground(true);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        } catch (Exception ignored) {}
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
