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
import android.os.IBinder;
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

    public interface OnStateChangeListener {
        void onPlayingStateChanged(boolean playing);
        void onPositionUpdate(int positionMs, int durationMs);
        void onEnded();
        void onError(String message);
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
                    player.pause();
                    if (listener != null) listener.onPlayingStateChanged(false);
                }
            });
            updateNotification("Paused");
            updatePlaybackState();
        } else if (ACTION_RESUME.equals(action)) {
            tryRun(() -> {
                if (player != null && prepared) {
                    player.start();
                    if (listener != null) listener.onPlayingStateChanged(true);
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
                mp.start();
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
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
            if (listener != null) listener.onPlayingStateChanged(false);
        }
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
        tryRun(() -> { if (player != null && prepared) player.seekTo(ms); });
    }

    public void setRate(float rate) {
        if (rate <= 0) return;
        pendingRate = rate;
        applyRate(rate);
    }

    public void setMetadata(String title, String subtitle) {
        if (title != null && !title.isEmpty()) metaTitle = title;
        if (subtitle != null) metaSubtitle = subtitle;
        if (mediaSession != null) {
            MediaMetadataCompat md = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, metaSubtitle != null && !metaSubtitle.isEmpty() ? metaSubtitle : metaTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, metaTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, metaSubtitle != null && !metaSubtitle.isEmpty() ? metaSubtitle : metaTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, metaTitle)
                .build();
            mediaSession.setMetadata(md);
            updatePlaybackState();
        }
        updateNotification(metaSubtitle != null && !metaSubtitle.isEmpty() ? metaSubtitle : metaTitle);
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
