package com.example.app;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;

import androidx.core.widget.NestedScrollView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.divider.MaterialDivider;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native Material 3 chrome for the web interface on Android (the counterpart
 * of iOS NativeChrome.swift):
 *  - showMenu: the hamburger menu as a Material bottom sheet — a compact top
 *    row (Library / Stats / Preferences), pinned titles with their covers,
 *    then the sections; groups (Print, Sync) expand in place. Resolves
 *    {id} of the picked row, or {} when dismissed.
 *  - showSheet: a chooser (libSheet: Move, tab chooser, Print / Sync choices)
 *    as a Material bottom sheet list. Resolves {index} (-1 = dismissed).
 * Rows come from the same web model the iOS menu uses (native-menu.js), so
 * every pick runs the web code unchanged.
 */
@CapacitorPlugin(name = "KadokiChrome")
public class KadokiChromePlugin extends Plugin {

    private static final int ON_SURFACE = 0xFFE6E0E9;
    private static final int ON_SURFACE_VAR = 0xFFCAC4D0;
    private static final int SURFACE = 0xFF1D1B20;
    private static final int DANGER = 0xFFF2B8B5;

    private BottomSheetDialog open;

    @PluginMethod
    public void showMenu(PluginCall call) {
        JSArray rows = call.getArray("rows");
        JSObject anchor = call.getObject("anchor");
        getActivity().runOnUiThread(() -> {
            try { presentMenu(call, rows == null ? new JSONArray() : rows, anchor); }
            catch (Exception e) { call.reject("menu failed: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void showSheet(PluginCall call) {
        String title = call.getString("title", "");
        JSArray options = call.getArray("options");
        String cancel = call.getString("cancel", null);
        getActivity().runOnUiThread(() -> {
            try { presentSheet(call, title, options == null ? new JSONArray() : options, cancel); }
            catch (Exception e) { call.reject("sheet failed: " + e.getMessage()); }
        });
    }

    // ── menu ────────────────────────────────────────────────────────────────

    private PopupWindow openMenu;

    /** The menu as a dropdown under the hamburger: a rounded Material surface,
     *  full height down to the bottom of the screen, growing from the button's
     *  corner. A popup stays inside the activity window, so the hidden system
     *  bars stay hidden (a dialog brought the clock back and shifted the page). */
    private void presentMenu(PluginCall call, JSONArray rows, JSObject anchor) throws Exception {
        if (openMenu != null) { try { openMenu.dismiss(); } catch (Exception ignored) {} }
        Context ctx = getActivity();
        final String[] picked = { null };
        final PopupWindow[] self = { null };

        LinearLayout col = new LinearLayout(ctx);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(0, dp(8), 0, dp(8));
        LinearLayout top = new LinearLayout(ctx);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setPadding(dp(8), 0, dp(8), dp(8));
        LinearLayout list = new LinearLayout(ctx);
        list.setOrientation(LinearLayout.VERTICAL);
        boolean pendingDivider = false;
        Pick pick = id -> { picked[0] = id; if (self[0] != null) self[0].dismiss(); };
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.getJSONObject(i);
            if (r.optBoolean("divider")) { pendingDivider = list.getChildCount() > 0; continue; }
            if (r.optBoolean("top")) {
                top.addView(topButton(ctx, r, () -> pick.run(r.optString("id"))),
                    new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                continue;
            }
            if (pendingDivider) { list.addView(divider(ctx)); pendingDivider = false; }
            addRow(ctx, list, r, false, pick);
        }
        if (top.getChildCount() > 0) { col.addView(top); col.addView(divider(ctx)); }
        col.addView(list);
        NestedScrollView scroll = new NestedScrollView(ctx);
        scroll.addView(col);

        FrameLayout card = new FrameLayout(ctx);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF2B2930);
        bg.setCornerRadius(dp(16));
        card.setBackground(bg);
        card.setElevation(dp(8));
        card.setClipToOutline(true);
        card.addView(scroll);

        // Where: under the hamburger (anchor in CSS px = dp in the web view).
        View web = getBridge().getWebView();
        int[] loc = new int[2];
        web.getLocationInWindow(loc);
        float d = getContext().getResources().getDisplayMetrics().density;
        int winW = web.getRootView().getWidth(), winH = web.getRootView().getHeight();
        int right = winW - dp(8), topY = dp(64);
        if (anchor != null) {
            double ax = anchor.optDouble("x", 0), ay = anchor.optDouble("y", 0);
            double aw = anchor.optDouble("w", 0), ah = anchor.optDouble("h", 0);
            right = Math.min(winW - dp(8), loc[0] + (int) Math.round((ax + aw) * d));
            topY = loc[1] + (int) Math.round((ay + ah) * d) + dp(6);
        }
        int width = Math.min(dp(340), winW - dp(24));
        // As tall as its rows, scrolling only when that would run off-screen.
        int maxH = Math.max(dp(240), winH - topY - dp(12));
        card.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                     View.MeasureSpec.makeMeasureSpec(maxH, View.MeasureSpec.AT_MOST));
        int height = Math.min(maxH, card.getMeasuredHeight());

        PopupWindow pw = new PopupWindow(card, width, height, true);
        self[0] = pw;
        pw.setOutsideTouchable(true);
        pw.setElevation(dp(8));
        pw.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        pw.setAnimationStyle(0);
        pw.setOnDismissListener(() -> {
            if (openMenu == pw) openMenu = null;
            JSObject res = new JSObject();
            if (picked[0] != null) res.put("id", picked[0]);
            call.resolve(res);
        });
        openMenu = pw;
        pw.showAtLocation(web, Gravity.TOP | Gravity.START, right - width, topY);
        // Grow from the top-right corner, like a menu.
        card.setPivotX(width);
        card.setPivotY(0);
        card.setScaleX(0.6f); card.setScaleY(0.4f); card.setAlpha(0f);
        card.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(220)
            .setInterpolator(new android.view.animation.DecelerateInterpolator(2f)).start();
    }

    private interface Pick { void run(String id); }

    private void addRow(Context ctx, LinearLayout parent, JSONObject r, boolean indent, Pick pick) {
        JSONArray kids = r.optJSONArray("children");
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56));
        row.setPadding(dp(indent ? 40 : 12), dp(6), dp(20), dp(6));
        row.setBackgroundResource(rippleRes(ctx));
        row.setClickable(true);

        // Checkmark column (the open title), as on iOS.
        TextView check = text(ctx, r.optBoolean("checked") ? "✓" : "", 16, ON_SURFACE, true);
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(dp(18), ViewGroup.LayoutParams.WRAP_CONTENT);
        cl.setMarginEnd(dp(8));
        row.addView(check, cl);
        Bitmap cover = decodeDataUri(r.optString("image", ""));
        android.graphics.drawable.Drawable icon = cover == null ? symbol(ctx, r.optString("icon", "")) : null;
        if (icon != null) {
            ImageView iv = new ImageView(ctx);
            iv.setImageDrawable(icon);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(22), dp(22));
            lp.setMarginEnd(dp(18));
            row.addView(iv, lp);
        }
        if (cover != null) {
            ImageView iv = new ImageView(ctx);
            iv.setImageBitmap(cover);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            GradientDrawable clip = new GradientDrawable();
            clip.setCornerRadius(dp(4));
            iv.setBackground(clip);
            iv.setClipToOutline(true);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(34), dp(48));
            lp.setMarginEnd(dp(16));
            row.addView(iv, lp);
        }
        LinearLayout texts = new LinearLayout(ctx);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView label = text(ctx, r.optString("label"), 16, ON_SURFACE, false);
        texts.addView(label);
        String sub = r.optString("subtitle", "");
        if (!sub.isEmpty()) texts.addView(text(ctx, sub, 13, ON_SURFACE_VAR, false));
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        String badge = r.optString("badge", "");
        if (!badge.isEmpty()) {
            TextView b = text(ctx, badge, 12, Color.WHITE, true);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xFFB3261E);
            bg.setCornerRadius(dp(10));
            b.setBackground(bg);
            b.setPadding(dp(7), dp(1), dp(7), dp(1));
            row.addView(b);
        }
        parent.addView(row);

        if (kids != null && kids.length() > 0) {
            TextView chev = text(ctx, "›", 22, ON_SURFACE_VAR, false);
            row.addView(chev);
            LinearLayout sub2 = new LinearLayout(ctx);
            sub2.setOrientation(LinearLayout.VERTICAL);
            sub2.setVisibility(View.GONE);
            for (int k = 0; k < kids.length(); k++) {
                JSONObject c = kids.optJSONObject(k);
                if (c != null) addRow(ctx, sub2, c, true, pick);
            }
            parent.addView(sub2);
            row.setOnClickListener(v -> {
                boolean show = sub2.getVisibility() != View.VISIBLE;
                sub2.setVisibility(show ? View.VISIBLE : View.GONE);
                chev.animate().rotation(show ? 90 : 0).setDuration(180).start();
            });
        } else {
            String id = r.optString("id");
            row.setOnClickListener(v -> pick.run(id));
        }
    }

    private View topButton(Context ctx, JSONObject r, Runnable onTap) {
        String label = r.optString("label");
        if (label.endsWith("…")) label = label.substring(0, label.length() - 1);
        LinearLayout cell = new LinearLayout(ctx);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setPadding(dp(4), dp(10), dp(4), dp(10));
        cell.setBackgroundResource(rippleRes(ctx));
        cell.setClickable(true);
        cell.setOnClickListener(v -> onTap.run());
        android.graphics.drawable.Drawable icon = symbol(ctx, r.optString("icon", ""));
        if (icon != null) {
            ImageView iv = new ImageView(ctx);
            iv.setImageDrawable(icon);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(24), dp(24));
            lp.bottomMargin = dp(6);
            cell.addView(iv, lp);
        }
        TextView t = text(ctx, label, 13, ON_SURFACE, false);
        t.setGravity(Gravity.CENTER);
        t.setMaxLines(1);
        cell.addView(t);
        return cell;
    }

    /** The Material Symbol bundled for an SF Symbol name (res/drawable/kmi_*). */
    private android.graphics.drawable.Drawable symbol(Context ctx, String sf) {
        if (sf == null || sf.isEmpty()) return null;
        int id = ctx.getResources().getIdentifier("kmi_" + sf.replace('.', '_'), "drawable", ctx.getPackageName());
        if (id == 0) return null;
        android.graphics.drawable.Drawable d = ctx.getDrawable(id);
        if (d == null) return null;
        d = d.mutate();
        d.setTint(ON_SURFACE);
        return d;
    }

    // ── chooser sheet ───────────────────────────────────────────────────────

    private void presentSheet(PluginCall call, String title, JSONArray options, String cancel) throws Exception {
        if (open != null) { try { open.dismiss(); } catch (Exception ignored) {} }
        Context ctx = getActivity();
        BottomSheetDialog dlg = new BottomSheetDialog(ctx);
        final int[] picked = { -1 };
        LinearLayout col = new LinearLayout(ctx);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(0, dp(4), 0, dp(16));
        if (title != null && !title.isEmpty()) {
            TextView h = text(ctx, title, 14, ON_SURFACE_VAR, true);
            h.setPadding(dp(24), dp(4), dp(24), dp(12));
            col.addView(h);
        }
        for (int i = 0; i < options.length(); i++) {
            JSONObject o = options.getJSONObject(i);
            final int index = i;
            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(dp(56));
            row.setPadding(dp(24), dp(8), dp(24), dp(8));
            row.setBackgroundResource(rippleRes(ctx));
            row.setClickable(true);
            boolean danger = o.optBoolean("destructive");
            row.addView(text(ctx, o.optString("label"), 16, danger ? DANGER : ON_SURFACE, false));
            String sub = o.optString("sub", "");
            if (!sub.isEmpty()) row.addView(text(ctx, sub, 13, ON_SURFACE_VAR, false));
            row.setOnClickListener(v -> { picked[0] = index; dlg.dismiss(); });
            col.addView(row);
        }
        NestedScrollView scroll = new NestedScrollView(ctx);
        scroll.addView(col);
        dlg.setContentView(scroll);
        dlg.setOnDismissListener(d -> {
            if (open == dlg) open = null;
            JSObject res = new JSObject();
            res.put("index", picked[0]);
            call.resolve(res);
        });
        open = dlg;
        dlg.show();
        keepBarsHidden(dlg);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** A dialog window brings the system bars back; the app runs immersive. */
    private void keepBarsHidden(android.app.Dialog dlg) {
        try {
            android.view.Window w = dlg.getWindow();
            if (w == null) return;
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(w, false);
            androidx.core.view.WindowInsetsControllerCompat c =
                new androidx.core.view.WindowInsetsControllerCompat(w, w.getDecorView());
            c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
            c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } catch (Exception ignored) {}
    }

    /** Open tall: the whole menu visible without a first drag. */
    private void expandFully(BottomSheetDialog dlg) {
        dlg.setOnShowListener(d -> {
            View sheet = dlg.findViewById(com.google.android.material.R.id.design_bottom_sheet);
            if (sheet == null) return;
            BottomSheetBehavior<View> b = BottomSheetBehavior.from(sheet);
            b.setSkipCollapsed(true);
            b.setState(BottomSheetBehavior.STATE_EXPANDED);
        });
    }

    private TextView text(Context ctx, String s, int sp, int color, boolean medium) {
        TextView t = new TextView(ctx);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (medium) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private View divider(Context ctx) {
        MaterialDivider d = new MaterialDivider(ctx);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        lp.setMargins(0, dp(8), 0, dp(8));
        d.setLayoutParams(lp);
        d.setDividerColor(0xFF49454F);
        return d;
    }

    private int rippleRes(Context ctx) {
        TypedValue tv = new TypedValue();
        ctx.getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
        return tv.resourceId;
    }

    private Bitmap decodeDataUri(String uri) {
        if (uri == null || uri.isEmpty()) return null;
        int comma = uri.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] b = Base64.decode(uri.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(b, 0, b.length);
        } catch (Exception e) { return null; }
    }

    private int dp(int v) {
        return Math.round(v * getContext().getResources().getDisplayMetrics().density);
    }
}
