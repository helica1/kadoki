package com.example.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PdfExport — render an HTML document with the WebView (the real renderer, so
 * vertical-rl + <ruby> lay out correctly) and hand it to Android's PrintManager.
 *
 * Android's print framework does NOT allow generating a PDF file silently (the
 * LayoutResultCallback / WriteResultCallback constructors are package-private),
 * so the supported path is the system print dialog — which offers "Save as PDF"
 * (→ Files, then email) alongside any real printers. iOS uses a direct share
 * sheet instead; that platform difference is forced by Android's API. Either
 * way this replaces window.print(), which is a no-op in a Capacitor WebView.
 */
@CapacitorPlugin(name = "PdfExport")
public class PdfExportPlugin extends Plugin {

    // Held so the offscreen WebView isn't garbage-collected while PrintManager
    // drives its print adapter.
    private WebView printWebView;

    @PluginMethod
    public void share(final PluginCall call) {
        final String html = call.getString("html");
        if (html == null || html.isEmpty()) { call.reject("html required"); return; }
        final String jobName = sanitize(call.getString("fileName", "reading"));

        getActivity().runOnUiThread(() -> {
            try {
                final WebView wv = new WebView(getContext());
                printWebView = wv;
                // JS on so the in-document corrector can re-measure the column
                // pitch in THIS (the actual print) WebView and align the page
                // windows to whole columns — otherwise text laid out against the
                // app WebView's pitch drifts ~½ column by the last page here.
                wv.getSettings().setJavaScriptEnabled(true);
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        // Print synchronously here. The inline corrector script
                        // runs during page load (before onPageFinished), so the
                        // DOM is already aligned. NOTE: do NOT use view.postDelayed
                        // — this WebView is never attached to a window, so its
                        // delayed Runnables never fire (that silently killed print).
                        try {
                            PrintManager pm = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                            if (pm == null) { call.reject("print service unavailable"); return; }
                            PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.NA_LETTER.asLandscape())
                                .build();
                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                            pm.print(jobName, adapter, attrs);
                            JSObject ret = new JSObject();
                            ret.put("ok", true);
                            call.resolve(ret);
                        } catch (Exception e) {
                            call.reject("print failed: " + e.getMessage());
                        }
                    }
                });
                wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                call.reject("webview failed: " + e.getMessage());
                printWebView = null;
            }
        });
    }

    private String sanitize(String s) {
        if (s == null || s.isEmpty()) return "reading";
        // Keep Unicode (Japanese titles); strip only filesystem-illegal chars.
        String c = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "").trim();
        return c.isEmpty() ? "reading" : c;
    }
}
