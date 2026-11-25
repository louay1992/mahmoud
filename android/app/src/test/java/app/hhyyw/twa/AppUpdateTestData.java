package app.hhyyw.twa;

import org.json.JSONObject;

final class AppUpdateTestData {
    static JSONObject manifest(byte[] bytes) throws Exception {
        JSONObject apps = new JSONObject();
        for (String role : new String[]{"admin", "captain"}) {
            String filename = "Delivery-" + (role.equals("admin") ? "Admin" : "Captain") + "-1.4.1.apk";
            apps.put(role, new JSONObject().put("packageName", "app.hhyyw." + role).put("versionCode", BuildConfig.VERSION_CODE + 1).put("versionName", "1.4.1")
                    .put("minSdk", 23).put("size", bytes.length).put("sha256", AppUpdateTransfer.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)))
                    .put("notes", "تحديث جديد للاختبار").put("url", "https://github.com/louay1992/mahmoud/releases/download/android-v1.4.1/" + filename));
        }
        return new JSONObject().put("schema", 1).put("sourceCommit", "a".repeat(40)).put("apps", apps);
    }
    static AppUpdateRelease release(byte[] bytes) throws Exception { return AppUpdateRelease.parse(manifest(bytes), BuildConfig.APP_SCOPE); }
}
