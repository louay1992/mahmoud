package app.hhyyw.twa;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.File;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Owns update UX independently of login, WebView availability, and cached office data. */
final class AppUpdateController {
    interface Source { AppUpdateRelease latest(String role) throws Exception; }
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker;
    private final Source source;
    private final SharedPreferences preferences;
    private final File directory;
    private volatile boolean closed;
    private boolean resumed, checking, downloading, installing, awaitingPermission;
    private long lastCheck = -1;
    private int shownVersion = -1;
    private AppUpdateRelease available;
    private File ready;
    private AtomicBoolean cancelled;
    private AlertDialog dialog;

    AppUpdateController(Activity activity) {
        this(activity, AppUpdateTransfer::latest, Executors.newSingleThreadExecutor());
    }
    AppUpdateController(Activity activity, Source source, ExecutorService worker) {
        this.activity = activity;
        this.source = source; this.worker = worker;
        preferences = activity.getSharedPreferences("android-app-updates", Activity.MODE_PRIVATE);
        directory = new File(activity.getCacheDir(), "app-updates");
        try {
            String saved = preferences.getString("ready", "");
            if (!saved.isEmpty()) {
                AppUpdateRelease release = AppUpdateRelease.restore(new JSONObject(saved), BuildConfig.APP_SCOPE);
                File file = new File(directory, release.filename());
                if (release.newerThan(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT) && file.isFile()) { available = release; ready = file; }
                else { file.delete(); preferences.edit().remove("ready").apply(); }
            }
        } catch (Exception ignored) { preferences.edit().remove("ready").apply(); }
        File[] stale = directory.listFiles();
        if (stale != null) for (File file : stale) if (file.getName().endsWith(".part") && file.lastModified() < System.currentTimeMillis() - 3600000) file.delete();
    }
    void resume() {
        if (closed) return;
        resumed = true;
        if (awaitingPermission) {
            awaitingPermission = false;
            if (AppUpdateInstaller.permitted(activity)) beginInstall();
            else failure("لم يتم السماح بتثبيت التحديث. يمكنك المحاولة مجددًا عند رغبتك.");
            return;
        }
        if (available != null && !downloading && !installing && shownVersion != available.versionCode) present(available);
        check(false);
    }
    void pause() { resumed = false; }
    void check(boolean manual) {
        if (closed || checking || downloading || installing || !resumed) return;
        long now = SystemClock.elapsedRealtime();
        if (!manual && lastCheck >= 0 && now - lastCheck < 300000) return;
        checking = true; lastCheck = now;
        worker.execute(() -> {
            try {
                AppUpdateRelease release = source.latest(BuildConfig.APP_SCOPE);
                main.post(() -> {
                    checking = false;
                    if (closed) return;
                    if (!release.newerThan(BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT)) {
                        if (manual && resumed) Toast.makeText(activity, "التطبيق على أحدث إصدار متوافق مع جهازك", Toast.LENGTH_LONG).show();
                        return;
                    }
                    if (available == null || available.versionCode != release.versionCode) ready = null;
                    available = release;
                    if (manual) shownVersion = -1;
                    if (resumed && !downloading && !installing && shownVersion != release.versionCode) present(release);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    checking = false; lastCheck = -1;
                    if (!closed && manual && resumed) failure("تعذّر التحقق من التحديثات. تأكد من اتصال الإنترنت وحاول مجددًا.");
                });
            }
        });
    }
    void present(AppUpdateRelease release) {
        if (closed || !resumed || dialog != null) return;
        available = release; shownVersion = release.versionCode;
        LinearLayout panel = panel();
        TextView versions = text("الإصدار الحالي " + BuildConfig.VERSION_NAME + "  ←  " + release.versionName, 15);
        versions.setTextDirection(View.TEXT_DIRECTION_RTL); panel.addView(versions);
        panel.addView(text("حجم التحديث " + megabytes(release.size), 14));
        if (!release.notes.trim().isEmpty()) panel.addView(text(release.notes, 16));
        panel.addView(text("ستبقى بياناتك وحسابك محفوظة. سيطلب Android تأكيد التثبيت.", 14));
        panel.addView(text("احفظ أي عمل جارٍ قبل التثبيت.", 14));
        boolean cached = ready != null && ready.isFile() && ready.getName().equals(release.filename());
        AlertDialog offer = new AlertDialog.Builder(activity).setIcon(activity.getApplicationInfo().icon)
                .setTitle(cached ? "التحديث جاهز للتثبيت" : "تحديث جديد متاح").setView(panel)
                .setPositiveButton(cached ? "تثبيت التحديث" : "تحديث الآن", (unused, which) -> {
                    if (cached) beginInstall(); else download(release);
                }).setNegativeButton("لاحقًا", null).create();
        show(offer);
    }
    private void download(AppUpdateRelease release) {
        if (closed || downloading) return;
        downloading = true; cancelled = new AtomicBoolean();
        AtomicBoolean cancellation = cancelled;
        LinearLayout panel = panel();
        ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal); bar.setMax(100);
        TextView amount = text("0%  ·  0 / " + megabytes(release.size), 15); amount.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        panel.addView(bar, new LinearLayout.LayoutParams(-1, dp(12))); panel.addView(amount);
        AlertDialog progress = new AlertDialog.Builder(activity).setTitle("جارٍ تنزيل التحديث").setView(panel)
                .setNegativeButton("إلغاء التنزيل", (unused, which) -> cancellation.set(true)).setCancelable(false).create();
        show(progress);
        worker.execute(() -> {
            try {
                File file = AppUpdateTransfer.download(release, directory, cancellation, (bytes, total) -> main.post(() -> {
                    if (!closed && !cancellation.get()) {
                        int percent = (int) (bytes * 100 / total); bar.setProgress(percent);
                        amount.setText(percent == 100 ? "جارٍ التحقق من ملف التحديث…" : percent + "%  ·  " + megabytes(bytes) + " / " + megabytes(total));
                    }
                }));
                AppUpdateInstaller.verify(activity, file, release);
                if (cancellation.get() || closed) throw new CancellationException();
                preferences.edit().putString("ready", release.json().toString()).apply();
                main.post(() -> {
                    downloading = false;
                    if (closed || cancellation.get()) return;
                    ready = file; available = release; dismiss(progress);
                    if (resumed) beginInstall(); else shownVersion = -1;
                });
            } catch (Exception error) {
                main.post(() -> {
                    downloading = false; dismiss(progress);
                    if (!closed && !cancellation.get() && resumed) failure(error instanceof java.io.IOException ? error.getMessage() : "تعذّر تنزيل التحديث. حاول مجددًا عند استقرار الاتصال.");
                });
            }
        });
    }
    private void beginInstall() {
        if (closed || ready == null || available == null || installing || !resumed) return;
        if (!AppUpdateInstaller.permitted(activity)) {
            AlertDialog permission = new AlertDialog.Builder(activity).setTitle("السماح بتثبيت التحديث")
                    .setMessage("فعّل السماح لهذا التطبيق بتثبيت التحديثات، ثم ارجع إليه لإكمال التثبيت. هذا الإذن يُطلب مرة واحدة.")
                    .setPositiveButton("فتح الإعدادات", (unused, which) -> {
                        try { awaitingPermission = true; activity.startActivityForResult(AppUpdateInstaller.permissionIntent(activity), 823); }
                        catch (ActivityNotFoundException error) { awaitingPermission = false; failure("افتح إعدادات Android واسمح لهذا التطبيق بتثبيت التطبيقات غير المعروفة."); }
                    }).setNegativeButton("لاحقًا", null).create();
            show(permission); return;
        }
        installing = true; File file = ready; AppUpdateRelease release = available;
        worker.execute(() -> {
            try {
                // Repeat integrity and installed-certificate checks after returning from Settings.
                AppUpdateInstaller.verify(activity, file, release);
                main.post(() -> {
                    installing = false;
                    if (closed) return;
                    if (!resumed) { shownVersion = -1; return; }
                    try { activity.startActivityForResult(AppUpdateInstaller.installIntent(activity, file), 824); }
                    catch (ActivityNotFoundException error) { failure("تعذّر فتح مثبت Android. أعد المحاولة أو تحقق من إعدادات الجهاز."); }
                });
            } catch (Exception error) {
                file.delete(); preferences.edit().remove("ready").apply();
                main.post(() -> { installing = false; ready = null; if (!closed && resumed) failure(error.getMessage()); });
            }
        });
    }
    private void failure(String message) {
        if (closed || !resumed) return;
        AlertDialog error = new AlertDialog.Builder(activity).setTitle("تعذّر إكمال التحديث")
                .setMessage(message == null ? "تحقق من الاتصال وحاول مجددًا." : message)
                .setPositiveButton("المحاولة مجددًا", (unused, which) -> main.post(() -> { if (available != null) { shownVersion = -1; present(available); } else check(true); }))
                .setNegativeButton("إغلاق", null).create();
        show(error);
    }
    private void show(AlertDialog next) {
        if (closed || activity.isFinishing() || activity.isDestroyed()) return;
        if (dialog != null) dialog.dismiss(); dialog = next;
        next.setOnDismissListener(ignored -> { if (dialog == next) dialog = null; });
        next.show(); next.getWindow().getDecorView().setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        int color = android.graphics.Color.parseColor("admin".equals(BuildConfig.APP_SCOPE) ? "#0f766e" : "#1e40af");
        next.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(color);
    }
    private void dismiss(AlertDialog target) { if (!closed && target.isShowing()) target.dismiss(); }
    private LinearLayout panel() { LinearLayout value = new LinearLayout(activity); value.setOrientation(LinearLayout.VERTICAL); value.setPadding(dp(24), dp(8), dp(24), dp(8)); value.setLayoutDirection(View.LAYOUT_DIRECTION_RTL); return value; }
    private TextView text(String value, int size) { TextView text = new TextView(activity); text.setText(value); text.setTextSize(size); text.setTextColor(0xff334155); text.setPadding(0, dp(7), 0, dp(7)); return text; }
    private int dp(int value) { return (int) (activity.getResources().getDisplayMetrics().density * value + .5f); }
    private static String megabytes(long bytes) { return String.format(Locale.US, "%.1f MB", bytes / 1048576.0); }
    void close() {
        closed = true; resumed = false; if (cancelled != null) cancelled.set(true);
        worker.shutdownNow(); if (dialog != null) dialog.dismiss(); dialog = null;
    }
}
