package app.hhyyw.twa;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

final class NativeDeviceStore {
    private static final Object NETWORK_LOCK = new Object();
    private static final Object INSTALLATION_LOCK = new Object();
    private final Context context;
    private final SharedPreferences prefs;

    NativeDeviceStore(Context context) {
        this.context = context.getApplicationContext();
        prefs = this.context.getSharedPreferences("native-push-v1", Context.MODE_PRIVATE);
        synchronized (INSTALLATION_LOCK) {
            if (!prefs.contains("installation_id")) {
                byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
                StringBuilder secret = new StringBuilder();
                for (byte value : bytes) secret.append(String.format("%02x", value & 0xff));
                prefs.edit().putString("installation_id", UUID.randomUUID().toString()).putString("secret", secret.toString()).commit();
            }
        }
    }
    boolean configured() { return BuildConfig.FCM_CONFIGURED && !FirebaseApp.getApps(context).isEmpty(); }
    JSONObject status() throws Exception {
        return new JSONObject().put("host", "android").put("app_version", BuildConfig.VERSION_NAME).put("app_name", context.getString(R.string.app_name))
                .put("app_version_code", BuildConfig.VERSION_CODE).put("app_update_supported", true)
                .put("permission", NativeNotifications.permitted(context) ? "granted" : "denied")
                .put("configured", configured()).put("saved", !prefs.getString("binding_id", "").isEmpty())
                .put("account_id", prefs.getString("account_id", ""))
                .put("last_received_at", prefs.getLong("last_received_at", 0));
    }
    boolean accepts(String scope, String binding) {
        return BuildConfig.APP_SCOPE.equals(scope) && binding != null && !binding.isEmpty() && binding.equals(prefs.getString("binding_id", ""));
    }
    void received() { prefs.edit().putLong("last_received_at", System.currentTimeMillis()).apply(); }
    void tokenChanged(String token) { prefs.edit().putString("token", token).commit(); scheduleSync(); }
    void unbindLocally() {
        prefs.edit().remove("binding_id").remove("account_id").putBoolean("pending_unbind", true)
                .putLong("generation", prefs.getLong("generation", 0) + 1).commit();
        androidx.core.app.NotificationManagerCompat.from(context).cancelAll();
        scheduleSync();
    }
    JSONObject bind(String jwt) throws Exception {
        synchronized (NETWORK_LOCK) {
            if (!configured()) throw new IllegalStateException("إعدادات Firebase غير متوفرة في هذا الإصدار");
            long generation = prefs.getLong("generation", 0);
            prefs.edit().remove("binding_id").remove("account_id").putBoolean("pending_unbind", true).commit();
            String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 10, TimeUnit.SECONDS);
            prefs.edit().putString("token", token).commit();
            JSONObject result = api("bind", jwt);
            if (generation != prefs.getLong("generation", 0)) { scheduleSync(); throw new IllegalStateException("تغيّر الحساب أثناء ربط الجهاز"); }
            if (!result.optBoolean("saved") || result.optString("binding_id").isEmpty()) throw new IllegalStateException("لم يُحفظ ربط الجهاز");
            prefs.edit().putString("binding_id", result.getString("binding_id")).putString("account_id", result.getString("account_id"))
                    .putBoolean("pending_unbind", false).commit();
            return status();
        }
    }
    boolean sync() throws Exception {
        synchronized (NETWORK_LOCK) {
            boolean remove = prefs.getBoolean("pending_unbind", false);
            if (!remove && prefs.getString("token", "").isEmpty()) return true;
            JSONObject result = api(remove ? "unbind" : "sync", null);
            if (remove) prefs.edit().putBoolean("pending_unbind", false).commit();
            else if (!result.optBoolean("saved")) prefs.edit().remove("binding_id").remove("account_id").commit();
            return true;
        }
    }
    JSONObject serverTest(String jwt) throws Exception { synchronized (NETWORK_LOCK) { return api("test", jwt); } }
    void scheduleSync() {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NativeSyncWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build();
        WorkManager.getInstance(context).enqueueUniqueWork("native-push-sync", ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }
    private JSONObject api(String action, String jwt) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.SUPABASE_URL + "/functions/v1/native-device").openConnection();
        try {
            connection.setRequestMethod("POST"); connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("apikey", BuildConfig.SUPABASE_ANON_KEY);
            if (jwt != null) connection.setRequestProperty("Authorization", "Bearer " + jwt);
            JSONObject body = new JSONObject().put("action", action).put("installation_id", prefs.getString("installation_id", ""))
                    .put("secret", prefs.getString("secret", "")).put("app_scope", BuildConfig.APP_SCOPE).put("fcm_token", prefs.getString("token", ""));
            connection.setDoOutput(true);
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1 && bytes.size() < 65536) bytes.write(buffer, 0, count);
            }
            JSONObject result;
            try { result = new JSONObject(bytes.toString("UTF-8")); } catch (Exception invalid) { throw new IllegalStateException("تعذّر الاتصال بخادم الإشعارات (" + status + ")"); }
            if (status < 200 || status >= 300) throw new IllegalStateException(result.optString("error", "فشل ربط الجهاز"));
            return result;
        } finally { connection.disconnect(); }
    }
}
