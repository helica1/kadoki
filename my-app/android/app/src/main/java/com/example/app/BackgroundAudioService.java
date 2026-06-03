package com.example.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.ComponentName;
import android.media.AudioAttributes;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.net.Uri;
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

/**
 * Foreground service that runs MediaPlayer so audio keeps playing while the
 * WebView/Activity is paused (screen off, app backgrounded).
 *
 * Driven by Intents for play/pause/resume/stop (so JS can fire-and-forget
 * via startForegroundService) and by direct method calls on a static instance
 * accessor for synchronous operations (getPosition/getDuration/seek/setRate).
 *
 * Plugin can register an OnStateChangeListener to receive position polling
 * events for forwarding to JS via notifyListeners.
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

    private MediaPlayer player;
    private boolean prepared = false;
    private float pendingRate = 1.0f;
    private int pendingStartMs = 0;
    private OnStateChangeListener listener;

    private MediaSessionCompat mediaSession;
    private String metaTitle = "Anki Deck Reader";
    private String metaSubtitle = "";
    private android.graphics.Bitmap metaArt;   // lock-screen cover art (persists across cue updates)

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureNotificationChannel();
        ensureMediaSession();
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
            pendingStartMs = intent.getIntExtra(EXTRA_START_MS, 0);
            float rate = intent.getFloatExtra(EXTRA_RATE, 1.0f);
            if (rate > 0) pendingRate = rate;
            startPlayback(url);
        } else if (ACTION_PAUSE.equals(action)) {
            tryRun(() -> {
                if (player != null && player.isPlaying()) {
                    int fadeMs = intent.getIntExtra(EXTRA_FADE_MS, DEFAULT_FADE_MS);
                    fadeOutThenPause(fadeMs);
                }
            });
            updateNotification("Paused");
            updatePlaybackState();
        } else if (ACTION_RESUME.equals(action)) {
            tryRun(() -> {
                if (player != null && prepared) {
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

    private void startPlayback(String url) {
        stopPlayback();
        if (url == null || url.isEmpty()) {
            Log.w(TAG, "no url; nothing to play");
            return;
        }
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            player.setDataSource(getApplicationContext(), Uri.parse(url));
            player.setOnPreparedListener(mp -> {
                prepared = true;
                Log.d(TAG, "prepared; dur=" + mp.getDuration() + " startMs=" + pendingStartMs);
                if (pendingStartMs > 0) mp.seekTo(pendingStartMs);
                applyRate(pendingRate);
                // First play: only fade in if DEFAULT_FADE_MS > 0.
                // With the current default of 0, just start at full
                // volume. The audio buffer was empty so there's no
                // amplitude discontinuity to click on.
                if (DEFAULT_FADE_MS > 0) {
                    try { mp.setVolume(0f, 0f); } catch (Exception ignored) {}
                    mp.start();
                    rampVolume(mp, 0f, 1f, DEFAULT_FADE_MS);
                } else {
                    mp.start();
                }
                updateNotification("Playing");
                updatePlaybackState();
                if (listener != null) {
                    listener.onPlayingStateChanged(true);
                    listener.onPositionUpdate(mp.getCurrentPosition(), mp.getDuration());
                }
            });
            player.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "MediaPlayer error what=" + what + " extra=" + extra);
                if (listener != null) listener.onError("MediaPlayer error " + what + "/" + extra);
                return true;
            });
            player.setOnCompletionListener(mp -> {
                Log.d(TAG, "completion");
                if (listener != null) listener.onEnded();
            });
            player.prepareAsync();
        } catch (Exception e) {
            Log.e(TAG, "startPlayback failed", e);
            if (listener != null) listener.onError(e.getMessage());
        }
    }

    private void applyRate(float rate) {
        if (player == null || !prepared) { pendingRate = rate; return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return; // API 23+
        try {
            boolean wasPlaying = player.isPlaying();
            PlaybackParams pp = player.getPlaybackParams();
            pp.setSpeed(rate);
            player.setPlaybackParams(pp);
            // On some devices setPlaybackParams while paused auto-starts; pause again.
            if (!wasPlaying) player.pause();
        } catch (Exception e) {
            Log.w(TAG, "applyRate failed", e);
        }
    }

    private void stopPlayback() {
        prepared = false;
        cancelFade();
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
            if (listener != null) listener.onPlayingStateChanged(false);
        }
    }

    // ---- Volume ramp helpers (P2 roadmap) ----
    //
    // MediaPlayer.setVolume is instant — no native fade like iOS
    // AVAudioPlayer.setVolume(_:fadeDuration:). We schedule a sequence
    // of setVolume calls via a main-thread Handler to approximate a
    // linear ramp over `durationMs`. Step granularity is FADE_STEP_MS
    // (~10 ms) which is smooth enough for the 50 ms default without
    // being CPU-heavy.
    //
    // Outstanding ramps are cancelled if a new ramp / pause / stop
    // arrives so we never have two ramps fighting over the same
    // setVolume.
    private final Handler fadeHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPauseAfterFade = null;

    private void cancelFade() {
        fadeHandler.removeCallbacksAndMessages(null);
        pendingPauseAfterFade = null;
    }

    private void rampVolume(MediaPlayer mp, float from, float to, int durationMs) {
        cancelFade();
        if (mp == null) return;
        if (durationMs <= 0) {
            try { mp.setVolume(to, to); } catch (Exception ignored) {}
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
            final MediaPlayer target = mp;
            fadeHandler.postDelayed(() -> {
                float v = from + (to - from) * ((float) step / (float) total);
                try { target.setVolume(v, v); } catch (Exception ignored) {}
            }, (long) step * stepIntervalMs);
        }
    }

    private void fadeOutThenPause(int fadeMs) {
        if (player == null) return;
        if (fadeMs <= 0) {
            // No fade — set volume to 0 first so pause doesn't click on
            // a non-zero waveform, then pause, then restore for the
            // next play.
            try {
                player.setVolume(0f, 0f);
                player.pause();
                player.setVolume(1f, 1f);
                if (listener != null) listener.onPlayingStateChanged(false);
            } catch (Exception ignored) {}
            return;
        }
        final MediaPlayer mp = player;
        rampVolume(mp, 1f, 0f, fadeMs);
        // Schedule the actual pause AFTER the ramp completes.
        // Belt-and-suspenders: also set volume to 0 inside the runnable
        // so if the ramp didn't quite finish before this fires (handler
        // ordering across same-tick callbacks isn't guaranteed), pause
        // still happens at zero amplitude.
        pendingPauseAfterFade = () -> {
            try {
                try { mp.setVolume(0f, 0f); } catch (Exception ignored) {}
                if (mp.isPlaying()) mp.pause();
                try { mp.setVolume(1f, 1f); } catch (Exception ignored) {} // reset for next play
                if (listener != null) listener.onPlayingStateChanged(false);
            } catch (Exception ignored) {}
            pendingPauseAfterFade = null;
        };
        fadeHandler.postDelayed(pendingPauseAfterFade, fadeMs);
    }

    private void fadeInOnResume(int fadeMs) {
        if (player == null) return;
        if (fadeMs <= 0) {
            // No fade — just start at full volume. (Volume was reset
            // to 1 inside the pause runnable, so we don't need to
            // reset here.)
            try { player.start(); } catch (Exception ignored) {}
            if (listener != null) listener.onPlayingStateChanged(true);
            return;
        }
        try { player.setVolume(0f, 0f); } catch (Exception ignored) {}
        try { player.start(); } catch (Exception ignored) {}
        if (listener != null) listener.onPlayingStateChanged(true);
        rampVolume(player, 0f, 1f, fadeMs);
    }

    // ----- Public API for direct calls from BackgroundAudioPlugin -----

    public void setListener(OnStateChangeListener l) {
        this.listener = l;
        // Catch-up: if MediaPlayer is already prepared when a listener attaches
        // late (race between play() startService and ensureListener), replay
        // the current state so the plugin starts its position poll. Without
        // this, prepared-before-listener loses the state event forever.
        if (l != null && prepared && player != null) {
            try {
                boolean playing = player.isPlaying();
                l.onPlayingStateChanged(playing);
                l.onPositionUpdate(player.getCurrentPosition(), player.getDuration());
            } catch (Exception ignored) {}
        }
    }

    public boolean isReady() { return prepared && player != null; }

    public boolean isCurrentlyPlaying() {
        try { return player != null && player.isPlaying(); } catch (Exception e) { return false; }
    }

    public int getPositionMs() {
        try { return player != null && prepared ? player.getCurrentPosition() : -1; }
        catch (Exception e) { return -1; }
    }

    public int getDurationMs() {
        try { return player != null && prepared ? player.getDuration() : -1; }
        catch (Exception e) { return -1; }
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
        tryRun(() -> {
            if (player == null || !prepared) return;
            boolean playing = false;
            try { playing = player.isPlaying(); } catch (Exception ignored) {}
            if (playing && fadeMs > 0) {
                final MediaPlayer mp = player;
                final int target = ms;
                final int f = fadeMs;
                rampVolume(mp, 1f, 0f, f);
                fadeHandler.postDelayed(() -> {
                    try {
                        mp.setVolume(0f, 0f);      // ensure silence even if the ramp didn't quite finish
                        mp.seekTo(target);         // land the seek while muted
                        rampVolume(mp, 0f, 1f, f); // fade back in
                    } catch (Exception ignored) {}
                }, f);
            } else {
                player.seekTo(ms);
            }
        });
    }

    public void setRate(float rate) {
        if (rate <= 0) return;
        pendingRate = rate;
        applyRate(rate);
    }

    public void setMetadata(String title, String subtitle) {
        setMetadata(title, subtitle, null); // keep existing artwork
    }

    // artwork: a data-URI ("data:image/...;base64,XXXX") or raw base64. null =
    // leave the current cover art untouched (per-cue subtitle updates pass
    // null); "" = clear it. Cover art is set once on audio-mode entry and
    // persists across the per-cue subtitle updates.
    public void setMetadata(String title, String subtitle, String artwork) {
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
                if (player != null && prepared) {
                    player.start();
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
                if (player != null && player.isPlaying()) {
                    player.pause();
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

    @Override
    public void onDestroy() {
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
