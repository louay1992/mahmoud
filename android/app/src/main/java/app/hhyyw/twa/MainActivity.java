package app.hhyyw.twa;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/** Use a provider with notification delegation regardless of the default browser. */
public class MainActivity extends LauncherActivity {
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
        return new TwaLauncher(this, ChromeProvider.PACKAGE_NAME);
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
