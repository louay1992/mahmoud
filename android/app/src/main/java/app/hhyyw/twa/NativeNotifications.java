package app.hhyyw.twa;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

final class NativeNotifications {
    static final String CHANNEL = "delivery_updates";
    private NativeNotifications() {}

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "تحديثات الطلبات والحساب", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("الطلبات والملاحظات والدفعات وتعديلات الأسعار");
            channel.enableVibration(true);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
    static boolean permitted(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }
    static void show(Context context, String title, String body, String tag, String url) {
        if (!permitted(context)) return;
        createChannel(context);
        Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .setData(NotificationRoute.safe(url, BuildConfig.APP_SCOPE))
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int id = (tag == null || tag.isEmpty() ? String.valueOf(System.nanoTime()) : tag).hashCode();
        PendingIntent click = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setContentIntent(click)
                .setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try { NotificationManagerCompat.from(context).notify(id, notification.build()); }
        catch (SecurityException ignored) { /* Permission may be revoked while receiving a message. */ }
    }
}
