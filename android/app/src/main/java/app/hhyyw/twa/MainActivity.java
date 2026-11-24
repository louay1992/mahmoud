package app.hhyyw.twa;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/** Use a provider with notification delegation regardless of the default browser. */
public class MainActivity extends LauncherActivity {
    private NativePushBridge nativeBridge;
    private BridgeTwaLauncher bridgeLauncher;
    @Override protected void onCreate(Bundle state) {
        nativeBridge = new NativePushBridge(this);
        super.onCreate(state);
    }
    @Override
    protected boolean shouldLaunchImmediately() {
        if (ChromeProvider.isAvailable(getPackageManager())) return true;

        new AlertDialog.Builder(this)
                .setTitle("يلزم Google Chrome")
                .setMessage("لتعمل إشعارات التطبيق، ثبّت Google Chrome وفعّله وحدّثه، ثم افتح التطبيق مجددًا. لا يلزم تغيير متصفحك الافتراضي.")
                .setPositiveButton("فتح صفحة Chrome", (dialog, which) -> {
                    openChromeSetup();
                    finish();
                })
                .setNegativeButton("إغلاق", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
        return false;
    }

    @Override
    protected TwaLauncher createTwaLauncher() {
        bridgeLauncher = new BridgeTwaLauncher(this, ChromeProvider.PACKAGE_NAME, nativeBridge);
        return bridgeLauncher;
    }

    @Override protected Uri getLaunchingUrl() {
        Uri safe = NotificationRoute.safe(getIntent().getDataString(), BuildConfig.APP_SCOPE);
        return safe.buildUpon().appendQueryParameter("native", "1").build();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridgeLauncher != null) bridgeLauncher.launch(getLaunchingUrl());
    }

    private void openChromeSetup() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=" + ChromeProvider.PACKAGE_NAME))
                    .setPackage("com.android.vending"));
        } catch (ActivityNotFoundException unavailableStore) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://play.google.com/store/apps/details?id="
                                + ChromeProvider.PACKAGE_NAME)));
            } catch (ActivityNotFoundException unavailableBrowser) {
                // The setup message remains the instruction when no store/browser is available.
            }
        }
    }
}
