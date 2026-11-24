package app.hhyyw.twa;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public final class DeliveryMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) { new NativeDeviceStore(this).tokenChanged(token); }
    @Override public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        NativeDeviceStore device = new NativeDeviceStore(this);
        if (!device.accepts(data.get("app_scope"), data.get("binding_id"))) return;
        device.received();
        NativeNotifications.show(this, data.getOrDefault("title", "تحديث التطبيق"), data.getOrDefault("body", ""), data.get("tag"), data.get("url"));
    }
}
