package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NativeNotificationTest {
    @Test public void notificationUsesOwnChannelAndOpensOwnActivity() {
        Context context=RuntimeEnvironment.getApplication();
        String order="30000000-0000-0000-0000-000000000037";
        NativeNotifications.show(context,"طلب جديد","اختبار","order-37","/"+BuildConfig.APP_SCOPE+"?order="+order);
        Notification notification=Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getNotification("order-37".hashCode());
        assertNotNull(notification);
        assertEquals(NativeNotifications.CHANNEL,notification.getChannelId());
        Intent intent=Shadows.shadowOf(notification.contentIntent).getSavedIntent();
        assertEquals(context.getPackageName(),intent.getComponent().getPackageName());
        assertEquals(MainActivity.class.getName(),intent.getComponent().getClassName());
        assertEquals("/"+BuildConfig.APP_SCOPE,intent.getData().getPath());
        assertEquals(order,intent.getData().getQueryParameter("order"));
    }
}
