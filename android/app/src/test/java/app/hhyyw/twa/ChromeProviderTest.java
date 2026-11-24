package app.hhyyw.twa;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;

import androidx.browser.customtabs.CustomTabsService;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class ChromeProviderTest {
    private PackageManager packageManager;

    @Before
    public void setUp() {
        packageManager = mock(PackageManager.class);
    }

    private void installChrome(boolean enabled) throws Exception {
        ApplicationInfo application = new ApplicationInfo();
        application.packageName = ChromeProvider.PACKAGE_NAME;
        application.enabled = enabled;
        when(packageManager.getApplicationInfo(ChromeProvider.PACKAGE_NAME, 0))
                .thenReturn(application);
    }

    private ResolveInfo chromeService() {
        ResolveInfo result = new ResolveInfo();
        result.serviceInfo = new ServiceInfo();
        result.serviceInfo.packageName = ChromeProvider.PACKAGE_NAME;
        result.serviceInfo.enabled = true;
        return result;
    }

    @Test
    public void missingChromeDoesNotLaunchAnotherBrowser() throws Exception {
        when(packageManager.getApplicationInfo(ChromeProvider.PACKAGE_NAME, 0))
                .thenThrow(new PackageManager.NameNotFoundException());

        assertFalse(ChromeProvider.isAvailable(packageManager));
        verify(packageManager, never()).resolveService(any(Intent.class), eq(0));
        verify(packageManager, never()).resolveActivity(any(Intent.class), eq(0));
    }

    @Test
    public void disabledChromeIsUnavailable() throws Exception {
        installChrome(false);

        assertFalse(ChromeProvider.isAvailable(packageManager));
        verify(packageManager, never()).resolveService(any(Intent.class), eq(0));
    }

    @Test
    public void chromeWithoutTrustedWebActivityServiceIsUnavailable() throws Exception {
        installChrome(true);
        when(packageManager.resolveService(any(Intent.class), eq(0))).thenReturn(null);

        assertFalse(ChromeProvider.isAvailable(packageManager));
    }

    @Test
    public void availableChromeWinsWithoutConsultingSamsungDefault() throws Exception {
        installChrome(true);
        ResolveInfo samsungDefault = new ResolveInfo();
        samsungDefault.activityInfo = new android.content.pm.ActivityInfo();
        samsungDefault.activityInfo.packageName = "com.sec.android.app.sbrowser";
        when(packageManager.resolveActivity(any(Intent.class), eq(0))).thenReturn(samsungDefault);
        when(packageManager.resolveService(any(Intent.class), eq(0))).thenReturn(chromeService());

        assertTrue(ChromeProvider.isAvailable(packageManager));
        verify(packageManager, never()).resolveActivity(any(Intent.class), eq(0));
        ArgumentCaptor<Intent> intent = ArgumentCaptor.forClass(Intent.class);
        verify(packageManager).resolveService(intent.capture(), eq(0));
        assertEquals(ChromeProvider.PACKAGE_NAME, intent.getValue().getPackage());
        assertEquals(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION, intent.getValue().getAction());
        assertTrue(intent.getValue().hasCategory(CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY));
    }

    @Test
    public void disabledChromeServiceIsUnavailable() throws Exception {
        installChrome(true);
        ResolveInfo service = chromeService();
        service.serviceInfo.enabled = false;
        when(packageManager.resolveService(any(Intent.class), eq(0))).thenReturn(service);

        assertFalse(ChromeProvider.isAvailable(packageManager));
    }

    @Test
    public void serviceFromAnotherPackageIsRejected() throws Exception {
        installChrome(true);
        ResolveInfo service = chromeService();
        service.serviceInfo.packageName = "com.sec.android.app.sbrowser";
        when(packageManager.resolveService(any(Intent.class), eq(0))).thenReturn(service);

        assertFalse(ChromeProvider.isAvailable(packageManager));
    }

    @Test
    public void restrictedPackageVisibilityIsUnavailable() throws Exception {
        when(packageManager.getApplicationInfo(ChromeProvider.PACKAGE_NAME, 0))
                .thenThrow(new SecurityException("Package unavailable"));

        assertFalse(ChromeProvider.isAvailable(packageManager));
    }
}
