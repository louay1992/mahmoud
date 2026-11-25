package app.hhyyw.twa;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.net.URL;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class AppUpdateReleaseTest {
    @Test public void onlyANewerCompatibleReleaseForTheInstalledRoleIsOffered() throws Exception {
        AppUpdateRelease release = AppUpdateTestData.release(new byte[]{1,2,3});
        assertEquals("app.hhyyw." + BuildConfig.APP_SCOPE, release.packageName);
        assertTrue(release.newerThan(release.versionCode-1, 28)); assertFalse(release.newerThan(release.versionCode, 28)); assertFalse(release.newerThan(release.versionCode+1, 28)); assertFalse(release.newerThan(release.versionCode-1, 22));
    }
    @Test public void crossApplicationFilesAndUntrustedReleaseLocationsAreRejected() throws Exception {
        String role = BuildConfig.APP_SCOPE;
        for (String url : new String[]{"https://evil.example/update.apk", "http://github.com/louay1992/mahmoud/releases/download/v1/Delivery-Admin-1.4.1.apk",
                "https://github.com/another/repository/releases/download/v1/Delivery-Admin-1.4.1.apk",
                "https://user@github.com/louay1992/mahmoud/releases/download/v1/Delivery-Admin-1.4.1.apk",
                "https://github.com/louay1992/mahmoud/releases/download/v1/Delivery-Other-1.4.1.apk"}) {
            JSONObject manifest = AppUpdateTestData.manifest(new byte[]{1}); manifest.getJSONObject("apps").getJSONObject(role).put("url", url);
            assertThrows(Exception.class, () -> AppUpdateRelease.parse(manifest, role));
        }
        JSONObject wrong = AppUpdateTestData.manifest(new byte[]{1}); wrong.getJSONObject("apps").getJSONObject(role).put("packageName", "app.hhyyw.other");
        assertThrows(Exception.class, () -> AppUpdateRelease.parse(wrong, role));
    }
    @Test public void invalidChecksumsOversizedPackagesAndUnknownSchemasAreRejected() throws Exception {
        String role = BuildConfig.APP_SCOPE;
        JSONObject manifest = AppUpdateTestData.manifest(new byte[]{1}); manifest.getJSONObject("apps").getJSONObject(role).put("sha256", "no checksum");
        assertThrows(Exception.class, () -> AppUpdateRelease.parse(manifest, role));
        JSONObject large = AppUpdateTestData.manifest(new byte[]{1}); large.getJSONObject("apps").getJSONObject(role).put("size", AppUpdateRelease.MAX_APK_BYTES + 1);
        assertThrows(Exception.class, () -> AppUpdateRelease.parse(large, role));
        JSONObject overflow = AppUpdateTestData.manifest(new byte[]{1}); overflow.getJSONObject("apps").getJSONObject(role).put("versionCode", 4294967303L);
        assertThrows(Exception.class, () -> AppUpdateRelease.parse(overflow, role));
        JSONObject future = AppUpdateTestData.manifest(new byte[]{1}).put("schema", 2);
        assertThrows(Exception.class, () -> AppUpdateRelease.parse(future, role));
        assertFalse(AppUpdateRelease.trustedDownload(new URL("https://release-assets.githubusercontent.com/asset"), false));
        assertTrue(AppUpdateRelease.trustedDownload(new URL("https://release-assets.githubusercontent.com/asset?signature=value"), true));
        assertFalse(AppUpdateRelease.trustedDownload(new URL("https://github.com.evil.example/asset"), true));
        assertFalse(AppUpdateRelease.trustedDownload(new URL("http://release-assets.githubusercontent.com/asset"), true));
    }
}
