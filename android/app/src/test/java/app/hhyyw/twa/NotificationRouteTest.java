package app.hhyyw.twa;

import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NotificationRouteTest {
    @Test public void aNotificationCannotOpenAnotherOriginOrTheOtherApplication() {
        assertEquals("https://hhyyw.netlify.app/captain", NotificationRoute.safe("https://evil.test/admin", "captain").toString());
        assertEquals("https://hhyyw.netlify.app/captain", NotificationRoute.safe("/admin?notification=1", "captain").toString());
        assertEquals("https://hhyyw.netlify.app/admin", NotificationRoute.safe("javascript:alert(1)", "admin").toString());
    }
    @Test public void onlyTheOrderIdentifierAndNotificationFlagAreForwarded() {
        String order = "00000000-0000-0000-0000-000000000001";
        String route = NotificationRoute.safe("/admin.html?order=" + order + "&notification=1&access_token=secret", "admin").toString();
        assertEquals("https://hhyyw.netlify.app/admin?order=" + order + "&notification=1", route);
        assertFalse(route.contains("secret"));
    }
}
