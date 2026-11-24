package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.net.Uri;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NativeHostPolicyTest {
    @Test public void onlyOwnRolePageCanUseNativeBridge() {
        Uri origin = Uri.parse("https://hhyyw.netlify.app");
        String page = "https://hhyyw.netlify.app/" + BuildConfig.APP_SCOPE + "?native=1&host=android";
        assertTrue(NativeHostPolicy.bridgeAllowed(origin,true,page,BuildConfig.APP_SCOPE));
        assertFalse(NativeHostPolicy.bridgeAllowed(origin,false,page,BuildConfig.APP_SCOPE));
        assertFalse(NativeHostPolicy.bridgeAllowed(Uri.parse("https://evil.example"),true,page,BuildConfig.APP_SCOPE));
        assertFalse(NativeHostPolicy.bridgeAllowed(origin,true,"https://hhyyw.netlify.app/other",BuildConfig.APP_SCOPE));
    }
    @Test public void lookalikeOriginsAndUnsafeExternalSchemesAreRejected() {
        for (String url : new String[]{"http://hhyyw.netlify.app", "https://hhyyw.netlify.app.evil.test", "https://user@hhyyw.netlify.app", "https://hhyyw.netlify.app:8443"})
            assertFalse(url,NativeHostPolicy.ownOrigin(Uri.parse(url)));
        for (String url : new String[]{"javascript:alert(1)", "intent://bad", "file:///sdcard/x", "content://contacts"})
            assertFalse(url,NativeHostPolicy.external(Uri.parse(url)));
        assertTrue(NativeHostPolicy.external(Uri.parse("tel:+963123456789")));
        assertTrue(NativeHostPolicy.external(Uri.parse("https://maps.google.com/?q=33,36")));
    }
}
