package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.content.Context;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NativeBindingTest {
    @Test public void queuedMessagesFromAnOldAccountAreRejected() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("native-push-v1", Context.MODE_PRIVATE).edit().putString("binding_id", "new-account-binding").commit();
        NativeDeviceStore store = new NativeDeviceStore(context);
        assertTrue(store.accepts(BuildConfig.APP_SCOPE, "new-account-binding"));
        assertFalse(store.accepts(BuildConfig.APP_SCOPE, "old-account-binding"));
        assertFalse(store.accepts("admin".equals(BuildConfig.APP_SCOPE) ? "captain" : "admin", "new-account-binding"));
        context.getSharedPreferences("native-push-v1", Context.MODE_PRIVATE).edit().remove("binding_id").commit();
        assertFalse(store.accepts(BuildConfig.APP_SCOPE, "new-account-binding"));
    }
}
