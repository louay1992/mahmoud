package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import com.google.firebase.messaging.RemoteMessage;
import java.util.HashMap;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

/* FCM already accepted the message; these are the two places the app drops it without any trace. */
@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NativeNotificationDropTest {
    private static final String PREFS = "native-push-v1";
    private Context context;
    private NotificationManager manager;
    private ServiceController<DeliveryMessagingService> controller;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        manager = context.getSystemService(NotificationManager.class);
        controller = Robolectric.buildService(DeliveryMessagingService.class).create();
    }

    @After public void tearDown() { if (controller != null) controller.destroy(); }

    private RemoteMessage message(String binding, String tag) {
        Map<String, String> data = new HashMap<>();
        data.put("app_scope", BuildConfig.APP_SCOPE);
        data.put("binding_id", binding);
        data.put("title", "طلب جديد");
        data.put("body", "اختبار الإسقاط الصامت");
        data.put("tag", tag);
        return new RemoteMessage.Builder("test").setData(data).build();
    }

    private long lastReceivedAt() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("last_received_at", 0);
    }

    @Test public void aMessageForAnotherBindingIsDroppedWithoutTrace() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("binding_id", "binding-current").commit();
        controller.get().onMessageReceived(message("binding-someone-else", "drop-other"));
        assertNull("no notification for a stale binding", Shadows.shadowOf(manager).getNotification("drop-other".hashCode()));
        assertEquals("a rejected message must not look received", 0, lastReceivedAt());
    }

    @Test public void aMessageAfterUnbindIsDroppedWithoutTrace() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("binding_id").commit();
        controller.get().onMessageReceived(message("binding-current", "drop-logged-out"));
        assertNull(Shadows.shadowOf(manager).getNotification("drop-logged-out".hashCode()));
        assertEquals(0, lastReceivedAt());
    }

    @Test public void anAcceptedMessageIsRecordedButNotShownWithoutPermission() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("binding_id", "binding-current").commit();
        // A channel the user silenced reports IMPORTANCE_NONE, so permitted() is false.
        manager.createNotificationChannel(new NotificationChannel(
                NativeNotifications.CHANNEL, "تحديثات الطلبات والحساب", NotificationManager.IMPORTANCE_NONE));
        controller.get().onMessageReceived(message("binding-current", "drop-denied"));
        assertNull("a denied permission suppresses the notification", Shadows.shadowOf(manager).getNotification("drop-denied".hashCode()));
        assertTrue("the message still counts as received, which separates this case from a binding mismatch", lastReceivedAt() > 0);
    }

    @Test public void aMatchingBindingWithPermissionShowsTheNotification() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("binding_id", "binding-current").commit();
        controller.get().onMessageReceived(message("binding-current", "shown"));
        assertNotNull(Shadows.shadowOf(manager).getNotification("shown".hashCode()));
        assertEquals(NativeNotifications.CHANNEL, Shadows.shadowOf(manager).getNotification("shown".hashCode()).getChannelId());
        assertTrue(lastReceivedAt() > 0);
    }
}
