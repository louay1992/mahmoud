package app.hhyyw.twa;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class NativePushBridge {
    interface Reply { void send(String message); }
    private final Activity activity;
    private final NativeDeviceStore device;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private boolean closed;
    NativePushBridge(Activity activity) { this.activity = activity; device = new NativeDeviceStore(activity); }

    private void connected(Reply destination) {
        try {
            destination.send(device.status().put("type", "delivery.native.ready").put("role", BuildConfig.APP_SCOPE).put("version", 1).toString());
        } catch (Exception ignored) { /* The page reports a missing channel if the initial handshake fails. */ }
    }
    void message(String raw, Reply destination) {
        if (closed || raw == null || raw.length() > 1100000) return;
        String requestId = "";
        try {
            JSONObject request = new JSONObject(raw);
            String id = request.optString("id");
            requestId = id;
            String action = request.optString("type");
            if ("hello".equals(action)) {
                if (BuildConfig.APP_SCOPE.equals(request.optString("role")) && request.optInt("version") == 1) connected(destination);
                return;
            }
            if (id.isEmpty()) return;
            if ("status".equals(action)) { reply(id, null, null, destination); return; }
            if ("copy".equals(action)) {
                String text = request.optString("text");
                if (text.length() > 20000) throw new IllegalArgumentException("النص طويل جدًّا");
                ((ClipboardManager) activity.getSystemService(Activity.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("", text));
                reply(id, null, null, destination); return;
            }
            if ("save-csv".equals(action) && activity instanceof MainActivity) {
                ((MainActivity) activity).saveCsv(request.optString("filename", "report.csv"), request.optString("text"), error -> reply(id, null, error, destination)); return;
            }
            if (raw.length() > 20000) throw new IllegalArgumentException("الطلب طويل جدًّا");
            if ("permission".equals(action)) {
                ResultReceiver receiver = new ResultReceiver(main) {
                    @Override protected void onReceiveResult(int code, Bundle data) { reply(id, null, null, destination); }
                };
                activity.startActivity(new Intent(activity, NativePermissionActivity.class).putExtra("receiver", receiver));
                return;
            }
            if ("unbind".equals(action)) {
                // Clear local authorization before any network operation, including while offline.
                device.unbindLocally(); reply(id, null, null, destination); return;
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
                    reply(id, result, null, destination);
                } catch (Exception error) { reply(id, null, error.getMessage() == null ? "تعذّر تنفيذ إجراء الإشعارات" : error.getMessage(), destination); }
            });
        } catch (Exception error) {
            if (!requestId.isEmpty()) reply(requestId, null, "تعذّر تنفيذ الطلب داخل التطبيق", destination);
        }
    }
    private void reply(String id, JSONObject result, String error, Reply destination) {
        main.post(() -> {
            try {
                JSONObject response = device.status().put("id", id).put("ok", error == null);
                if (result != null && result.has("message_id")) response.put("message_id", result.getString("message_id"));
                if (error != null) response.put("error", error);
                if (!closed) destination.send(response.toString());
            } catch (Exception ignored) { /* The page can retry a timed-out request. */ }
        });
    }
    void close() { closed = true; executor.shutdown(); }
}
