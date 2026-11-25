package app.hhyyw.twa;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;

/** Owns the screen and native notification bridge; no browser application is launched. */
public class MainActivity extends Activity {
    private WebView web;
    private FrameLayout root;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private NativePushBridge bridge;
    private AppUpdateController updates;
    private boolean pageFailed;
    private volatile boolean useOfflineShell;
    private OfflineShell offlineShell;
    private Uri launchUrl;
    private final ArrayList<Dialog> previews = new ArrayList<>();
    private String exportText;
    private NativePushBridge.Reply exportReply;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.parseColor("admin".equals(BuildConfig.APP_SCOPE) ? "#0f766e" : "#1e40af"));
        getWindow().setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 26) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        bridge = new NativePushBridge(this);
        updates = new AppUpdateController(this);
        offlineShell = new OfflineShell(this, BuildConfig.APP_SCOPE);
        ConnectivityManager connectivity=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
        android.net.NetworkInfo network=connectivity==null?null:connectivity.getActiveNetworkInfo();
        useOfflineShell=network==null||!network.isConnected();
        launchUrl = appUrl(getIntent().getDataString());
        createScreen();
        if (web == null) return;
        if (state == null || web.restoreState(state) == null || !NativeHostPolicy.appPage(Uri.parse(web.getUrl() == null ? "" : web.getUrl()), BuildConfig.APP_SCOPE)) web.loadUrl(launchUrl.toString());
    }
    private Uri appUrl(String value) {
        return NotificationRoute.safe(value, BuildConfig.APP_SCOPE).buildUpon()
                .appendQueryParameter("native", "1").appendQueryParameter("host", "android").build();
    }
    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setBackgroundColor(Color.WHITE);
    }
    private void createScreen() {
        root = new FrameLayout(this); setContentView(root);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView text = new TextView(this); text.setPadding(30, 60, 30, 30);
            text.setText("يلزم تحديث Android System WebView لتشغيل التطبيق. لا يلزم تثبيت متصفح أو تغييره."); root.addView(text); return;
        }
        web = new WebView(this); configure(web);
        // Shipping previews open after an async order lookup. They stay in an
        // isolated internal window; only user gestures may launch external links.
        web.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);
        WebViewCompat.addWebMessageListener(web, "DeliveryAndroidHost", Collections.singleton(NotificationRoute.ORIGIN),
                (view, message, sourceOrigin, mainFrame, reply) -> {
                    if (NativeHostPolicy.bridgeAllowed(sourceOrigin, mainFrame, view.getUrl(), BuildConfig.APP_SCOPE)) bridge.message(message.getData(), reply::postMessage);
                });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if(request.isForMainFrame() && NativeHostPolicy.appPage(request.getUrl(),BuildConfig.APP_SCOPE)
                        && "1".equals(request.getUrl().getQueryParameter("__delivery_online"))) useOfflineShell=false;
                return useOfflineShell && "GET".equals(request.getMethod()) ? offlineShell.response(request.getUrl()) : null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !NativeHostPolicy.ownOrigin(request.getUrl());
                return navigate(request.getUrl(), request.hasGesture());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return navigate(Uri.parse(url), view.getHitTestResult().getType() == WebView.HitTestResult.SRC_ANCHOR_TYPE);
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                pageFailed = false; errorPanel.setVisibility(View.GONE); progress.setVisibility(View.VISIBLE);
                if (!NativeHostPolicy.appPage(Uri.parse(url), BuildConfig.APP_SCOPE)) { view.stopLoading(); showError("تعذّر فتح هذا الرابط داخل التطبيق"); }
            }
            @Override public void onPageFinished(WebView view, String url) { progress.setVisibility(View.GONE); if (!pageFailed) errorPanel.setVisibility(View.GONE); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if(!request.isForMainFrame())return;
                if(!useOfflineShell && NativeHostPolicy.appPage(request.getUrl(),BuildConfig.APP_SCOPE)
                        && offlineShell.assetPath(launchUrl)!=null && error.getErrorCode()!=WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) {
                    useOfflineShell=true;view.loadUrl(launchUrl.toString());
                }else showError("تعذّر فتح التطبيق. أعد المحاولة عند توفر اتصال.");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); showError("تعذّر التحقق من اتصال الموقع الآمن."); }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                root.removeView(view); view.destroy(); web = null; showError("توقف عرض الصفحة. اضغط إعادة المحاولة."); return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!NativeHostPolicy.appPage(Uri.parse(view.getUrl() == null ? "" : view.getUrl()), BuildConfig.APP_SCOPE)) return false;
                showPrintPreview(result, gesture); return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new FrameLayout.LayoutParams(-1, 6, Gravity.TOP));
        errorPanel = new LinearLayout(this); errorPanel.setOrientation(LinearLayout.VERTICAL); errorPanel.setGravity(Gravity.CENTER); errorPanel.setBackgroundColor(Color.WHITE);
        TextView explanation = new TextView(this); explanation.setId(android.R.id.message); explanation.setPadding(30, 30, 30, 30); explanation.setGravity(Gravity.CENTER); errorPanel.addView(explanation);
        Button retry = new Button(this); retry.setText("إعادة المحاولة"); retry.setOnClickListener(view -> { if (web == null) { createScreen(); if (web != null) web.loadUrl(launchUrl.toString()); } else web.reload(); }); errorPanel.addView(retry);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1)); errorPanel.setVisibility(View.GONE);
    }
    private void showError(String text) { pageFailed = true; progress.setVisibility(View.GONE); ((TextView) errorPanel.findViewById(android.R.id.message)).setText(text); errorPanel.setVisibility(View.VISIBLE); }
    private boolean navigate(Uri uri, boolean gesture) {
        if (NativeHostPolicy.appPage(uri, BuildConfig.APP_SCOPE)) return false;
        if (gesture && NativeHostPolicy.external(uri)) openExternal(uri);
        return true;
    }
    private void openExternal(Uri uri) {
        try { startActivity(new Intent("tel".equals(uri.getScheme()) ? Intent.ACTION_DIAL : Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException ignored) { new AlertDialog.Builder(this).setMessage("لا يوجد تطبيق لفتح هذا الرابط").setPositiveButton("حسنًا", null).show(); }
    }
    private void showPrintPreview(Message result, boolean allowExternal) {
        Dialog dialog = new Dialog(this); LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        LinearLayout toolbar = new LinearLayout(this); Button print = new Button(this), close = new Button(this); print.setText("طباعة / حفظ PDF"); close.setText("إغلاق"); toolbar.addView(print); toolbar.addView(close); layout.addView(toolbar);
        WebView preview = new WebView(this); configure(preview); preview.getSettings().setSupportMultipleWindows(false); preview.getSettings().setBlockNetworkLoads(true);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1)); dialog.setContentView(layout); dialog.show(); dialog.getWindow().setLayout(-1, -1); previews.add(dialog);
        preview.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if ("about:blank".equals(request.getUrl().toString())) return false;
                if (allowExternal && NativeHostPolicy.external(request.getUrl())) openExternal(request.getUrl()); dialog.dismiss(); return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { if ("about:blank".equals(url)) return false; if (allowExternal && NativeHostPolicy.external(Uri.parse(url))) openExternal(Uri.parse(url)); dialog.dismiss(); return true; }
        });
        preview.setWebChromeClient(new WebChromeClient() { @Override public void onCloseWindow(WebView window) { dialog.dismiss(); } });
        print.setOnClickListener(view -> ((PrintManager) getSystemService(PRINT_SERVICE)).print(getString(R.string.app_name), preview.createPrintDocumentAdapter(getString(R.string.app_name)), null));
        close.setOnClickListener(view -> dialog.dismiss()); dialog.setOnDismissListener(ignored -> { previews.remove(dialog); preview.destroy(); });
        ((WebView.WebViewTransport) result.obj).setWebView(preview); result.sendToTarget();
    }
    void saveCsv(String filename, String text, NativePushBridge.Reply completion) {
        if (exportReply != null) { completion.send("أكمل حفظ الملف الحالي أولًا"); return; }
        exportText = text; exportReply = completion;
        Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/csv").putExtra(Intent.EXTRA_TITLE, filename.replaceAll("[\\\\/:*?\"<>|]", "_"));
        try { startActivityForResult(picker, 75); } catch (ActivityNotFoundException unavailable) { exportText = null; exportReply = null; completion.send("تعذّر فتح نافذة حفظ الملف"); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 75 || exportReply == null) return;
        NativePushBridge.Reply completion = exportReply; String content = exportText; exportReply = null; exportText = null;
        if (result != RESULT_OK || data == null || data.getData() == null) { completion.send("أُلغي حفظ الملف"); return; }
        Uri destination = data.getData();
        new Thread(() -> { String failure = null; try (OutputStream output = getContentResolver().openOutputStream(destination)) { if (output == null) throw new java.io.IOException(); output.write(content.getBytes(StandardCharsets.UTF_8)); } catch (Exception error) { failure = "تعذّر حفظ الملف"; } final String message = failure; runOnUiThread(() -> completion.send(message)); }, "delivery-csv-save").start();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); launchUrl = appUrl(intent.getDataString()); if (web != null) web.loadUrl(launchUrl.toString()); }
    @Override public void onBackPressed() {
        if (web == null || !NativeHostPolicy.appPage(Uri.parse(web.getUrl() == null ? "" : web.getUrl()), BuildConfig.APP_SCOPE)) { finish(); return; }
        web.evaluateJavascript("typeof handleNativeBack==='function' && handleNativeBack()", handled -> { if (!"true".equals(handled)) { if (web != null && web.canGoBack()) web.goBack(); else finish(); } });
    }
    void checkAppUpdate() { if (updates != null) updates.check(true); }
    @Override protected void onResume() { super.onResume(); if (updates != null) updates.resume(); }
    @Override protected void onPause() { if (updates != null) updates.pause(); super.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onSaveInstanceState(Bundle state) { if (web != null) web.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() { if (updates != null) updates.close(); for (Dialog preview : new ArrayList<>(previews)) preview.dismiss(); if (web != null) { root.removeView(web); web.destroy(); } if (bridge != null) bridge.close(); super.onDestroy(); }
}
