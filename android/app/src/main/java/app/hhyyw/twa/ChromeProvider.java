package app.hhyyw.twa;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import androidx.browser.customtabs.CustomTabsService;

/** Capability check for the pinned notification-capable browser. */
final class ChromeProvider {
    static final String PACKAGE_NAME = "com.android.chrome";

    private ChromeProvider() {}

    static boolean isAvailable(PackageManager pm) {
        try {
            ApplicationInfo application = pm.getApplicationInfo(PACKAGE_NAME, 0);
            if (!application.enabled) return false;

            Intent serviceIntent = new Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION)
                    .addCategory(CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY)
                    .setPackage(PACKAGE_NAME);
            ResolveInfo service = pm.resolveService(serviceIntent, 0);
            return service != null && service.serviceInfo != null
                    && service.serviceInfo.enabled
                    && PACKAGE_NAME.equals(service.serviceInfo.packageName);
        } catch (PackageManager.NameNotFoundException | SecurityException unavailable) {
            return false;
        }
    }
}
