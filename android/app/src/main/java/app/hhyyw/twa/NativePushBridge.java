package app.hhyyw.twa;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import androidx.browser.customtabs.CustomTabsSession;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class NativePushBridge {
    private final Activity activity;
    private final NativeDeviceStore device;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private CustomTabsSession session;
    NativePushBridge(Activity activity) { this.activity = activity; device = new NativeDeviceStore(activity); }

    void connected(CustomTabsSession session) {
        this.session = session;
        try {
            send(device.status().put("type", "delivery.native.ready").put("role", BuildConfig.APP_SCOPE).put("version", 1));
        } catch (Exception ignored) { /* The page reports a missing channel if the initial handshake fails. */ }
    }
    void message(String raw) {
        if (raw.length() > 20000 || session == null) return;
        try {
            JSONObject request = new JSONObject(raw);
            String id = request.optString("id");
            String action = request.optString("type");
            if (id.isEmpty()) return;
            if ("permission".equals(action)) {
                ResultReceiver receiver = new ResultReceiver(main) {
                    @Override protected void onReceiveResult(int code, Bundle data) { reply(id, null, null); }
                };
                activity.startActivity(new Intent(activity, NativePermissionActivity.class).putExtra("receiver", receiver));
                return;
            }
            if ("unbind".equals(action)) {
                // Clear local authorization before any network operation, including while offline.
                device.unbindLocally(); reply(id, null, null); return;
            }
            executor.execute(() -> {
                try {
                    JSONObject result = null;
                    switch (action) {
                        case "bind":
                            String jwt = request.optString("access_token");
                            if (jwt.isEmpty()) throw new IllegalStateException("سجّل الدخول أولاً");
                            result = device.bind(jwt); break;
                        case "status": break;
                        case "test":
                            if (!NativeNotifications.permitted(activity)) throw new IllegalStateException("إذن إشعارات Android غير مفعّل");
                            NativeNotifications.show(activity, "اختبار إشعارات التطبيق", "هذا اختبار عرض محلي؛ اختبار FCM من الخادم منفصل", "local-test", "/" + BuildConfig.APP_SCOPE);
                            break;
                        case "server-test": result = device.serverTest(request.optString("access_token")); break;
                        default: throw new IllegalArgumentException("إجراء غير معروف");
                    }
                    reply(id, result, null);
                } catch (Exception error) { reply(id, null, error.getMessage() == null ? "تعذّر تنفيذ إجراء الإشعارات" : error.getMessage()); }
            });
        } catch (Exception ignored) { /* Ignore malformed messages without logging session tokens. */ }
    }
    private void reply(String id, JSONObject result, String error) {
        main.post(() -> {
            try {
                JSONObject response = device.status().put("id", id).put("ok", error == null);
                if (result != null && result.has("message_id")) response.put("message_id", result.getString("message_id"));
                if (error != null) response.put("error", error);
                send(response);
            } catch (Exception ignored) { /* The page can retry a timed-out request. */ }
        });
    }
    private void send(JSONObject payload) { if (session != null) session.postMessage(payload.toString(), null); }
    void close() { session = null; executor.shutdown(); }
}
