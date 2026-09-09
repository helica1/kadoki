package com.example.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.RectF;
import android.util.Log;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.C;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * Android twin of KadokiVideoIOSHost: a TextureView UNDER the (transparent)
 * WebView, placed at the rect the web layer sends (CSS px in the WebView),
 * rendering the service's ExoPlayer video track. The web page turns its own
 * background transparent in cinema mode (theme.css kadoki-video-title), so
 * the picture shows through exactly where the page leaves room.
 *
 * Battery: the video TRACK is disabled whenever the surface is hidden or the
 * activity is paused (audio keeps playing), so background listening never
 * decodes frames.
 */
final class KadokiVideoAndroidHost {
    private static final String TAG = "KadokiVideoHost";
    private static final KadokiVideoAndroidHost INSTANCE = new KadokiVideoAndroidHost();
    static KadokiVideoAndroidHost shared() { return INSTANCE; }

    private WebView webView;
    private FrameLayout container;      // sits below the WebView
    private TextureView textureView;
    private ExoPlayer player;
    private boolean installed = false;
    private boolean chromeOn = false;
    private boolean visible = false;
    private boolean paused = false;     // activity paused → surface detached
    private int savedWebBg = Color.WHITE;
    private float radiusPx = 0;
    private final RectF lastCss = new RectF();

    private KadokiVideoAndroidHost() {}

    /** UI thread. */
    void install(Activity activity, WebView wv) {
        if (installed || activity == null || wv == null) return;
        ViewGroup parent = (ViewGroup) wv.getParent();
        if (parent == null) return;
        webView = wv;
        container = new FrameLayout(activity);
        container.setBackgroundColor(Color.TRANSPARENT);
        container.setVisibility(View.GONE);
        container.setClickable(false);
        textureView = new TextureView(activity);
        textureView.setOpaque(false);
        container.addView(textureView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        int idx = parent.indexOfChild(wv);
        parent.addView(container, Math.max(0, idx), new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        installed = true;
        Log.d(TAG, "installed under WebView (parent " + parent.getClass().getSimpleName() + ")");
    }

    /** UI thread. Adopt the player that renders the video. */
    void adopt(ExoPlayer p) {
        if (player == p) return;
        if (player != null && textureView != null) { try { player.clearVideoTextureView(textureView); } catch (Exception ignored) {} }
        player = p;
        if (p != null && textureView != null && visible && !paused) attachSurface(true);
    }

    void clear() {
        adopt(null);
        visible = false;
        if (container != null) container.setVisibility(View.GONE);
        applyChrome(false);
    }

    private void attachSurface(boolean on) {
        ExoPlayer p = player;
        if (p == null || textureView == null) return;
        try {
            if (on) p.setVideoTextureView(textureView); else p.clearVideoTextureView(textureView);
            p.setTrackSelectionParameters(p.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, !on).build());
        } catch (Exception e) { Log.w(TAG, "attachSurface failed", e); }
    }

    /**
     * UI thread. Rect in CSS px relative to the WebView. Returns the contained
     * (aspect-fit) picture rect in CSS px.
     */
    RectF update(Activity activity, RectF cssRect, boolean vis, boolean cinema, boolean landscape) {
        if (!installed && activity != null && webView != null) install(activity, webView);
        if (!installed) return containedFrame(cssRect);
        float d = webView.getResources().getDisplayMetrics().density;
        lastCss.set(cssRect);
        if (vis) {
            int[] loc = new int[2]; webView.getLocationInWindow(loc);
            int[] ploc = new int[2]; ((View) container.getParent()).getLocationInWindow(ploc);
            int left = Math.round((loc[0] - ploc[0]) + cssRect.left * d);
            int top = Math.round((loc[1] - ploc[1]) + cssRect.top * d);
            int w = Math.max(1, Math.round(cssRect.width() * d));
            int h = Math.max(1, Math.round(cssRect.height() * d));
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) container.getLayoutParams();
            ViewGroup.LayoutParams base = container.getLayoutParams();
            if (base instanceof FrameLayout.LayoutParams) {
                lp = (FrameLayout.LayoutParams) base;
            } else {
                lp = new FrameLayout.LayoutParams(w, h);
            }
            if (lp.width != w || lp.height != h || lp.leftMargin != left || lp.topMargin != top) {
                lp.width = w; lp.height = h; lp.leftMargin = left; lp.topMargin = top;
                container.setLayoutParams(lp);
            }
            final float r = landscape ? 0 : 14 * d;
            if (r != radiusPx) {
                radiusPx = r;
                container.setOutlineProvider(new ViewOutlineProvider() {
                    @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), r); }
                });
                container.setClipToOutline(r > 0);
            }
        }
        boolean was = visible;
        visible = vis;
        container.setVisibility(vis ? View.VISIBLE : View.GONE);
        if (vis != was || vis) attachSurface(vis && !paused);
        applyChrome(cinema);
        return containedFrame(cssRect);
    }

    private RectF containedFrame(RectF frame) {
        float pw = 16, ph = 9;
        ExoPlayer p = player;
        if (p != null) {
            try { VideoSize vs = p.getVideoSize(); if (vs != null && vs.width > 0 && vs.height > 0) { pw = vs.width; ph = vs.height * vs.pixelWidthHeightRatio; } }
            catch (Exception ignored) {}
        }
        float s = Math.min(frame.width() / pw, frame.height() / ph);
        float w = pw * s, h = ph * s;
        float cx = frame.centerX(), cy = frame.centerY();
        return new RectF(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    }

    private void applyChrome(boolean on) {
        if (chromeOn == on || webView == null) return;
        chromeOn = on;
        View parent = (View) webView.getParent();
        if (on) {
            try { savedWebBg = webView.getSolidColor(); } catch (Exception ignored) {}
            webView.setBackgroundColor(Color.TRANSPARENT);
            if (parent != null) parent.setBackgroundColor(Color.BLACK);
        } else {
            webView.setBackgroundColor(Color.BLACK);
            if (parent != null) parent.setBackgroundColor(Color.BLACK);
        }
    }

    /** Activity paused: detach so no frames decode while the screen is off/away. */
    void onPause() { paused = true; attachSurface(false); }
    void onResume() { paused = false; if (visible) attachSurface(true); }
}
