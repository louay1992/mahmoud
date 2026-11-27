package app.hhyyw.twa;

import org.json.JSONObject;
import java.net.URL;

/** Public release metadata; downloading never accepts an arbitrary URL from the WebView. */
final class AppUpdateRelease {
    static final String SITE = "https://applications.nature-care.net";
    static final String FEED = SITE + "/downloads/latest.json";
    private static final String SITE_PREFIX = "/downloads/releases/";
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    final String role, packageName, versionName, url, sha256, notes;
    final int versionCode, minSdk;
    final long size;

    private AppUpdateRelease(String role, JSONObject data) throws Exception {
        if (!"admin".equals(role) && !"captain".equals(role)) throw new IllegalArgumentException("Unknown application");
        this.role = role;
        packageName = data.getString("packageName"); versionName = data.getString("versionName");
        versionCode = (int) integer(data, "versionCode", Integer.MAX_VALUE);
        minSdk = data.has("minSdk") ? (int) integer(data, "minSdk", 10000) : 23;
        url = data.getString("url"); sha256 = data.getString("sha256"); size = integer(data, "size", MAX_APK_BYTES);
        notes = data.optString("notes", "");
        if (!packageName.equals("app.hhyyw." + role) || !versionName.matches("[0-9]+\\.[0-9]+\\.[0-9]+")
                || versionCode <= 0 || minSdk < 23 || size <= 0 || size > MAX_APK_BYTES
                || !sha256.matches("[a-f0-9]{64}") || notes.length() > 2000) throw new IllegalArgumentException("Invalid release metadata");
        URL asset = new URL(url);
        String filename = "Delivery-" + ("admin".equals(role) ? "Admin" : "Captain") + "-" + versionName + ".apk";
        boolean expectedPath = site(asset)
                ? asset.getPath().equals(SITE_PREFIX + versionName + "/" + sha256 + "/delivery-" + role + ".apk")
                : asset.getPath().matches("/louay1992/mahmoud/releases/download/[A-Za-z0-9._-]+/" + java.util.regex.Pattern.quote(filename));
        if (!trustedDownload(asset, false) || !expectedPath || asset.getQuery() != null || asset.getRef() != null)
            throw new IllegalArgumentException("Invalid APK location");
    }
    static AppUpdateRelease parse(JSONObject manifest, String role) throws Exception {
        if (manifest.getInt("schema") != 1 || !manifest.getString("sourceCommit").matches("[a-f0-9]{40}"))
            throw new IllegalArgumentException("Invalid release manifest");
        return new AppUpdateRelease(role, manifest.getJSONObject("apps").getJSONObject(role));
    }
    static AppUpdateRelease parseSite(JSONObject manifest, String role) throws Exception {
        AppUpdateRelease release = parse(manifest, role);
        if (!site(new URL(release.url))) throw new IllegalArgumentException("Expected an APK on the application domain");
        return release;
    }
    private static long integer(JSONObject data, String field, long maximum) throws Exception {
        Object value = data.get(field);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid release number");
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number != Math.floor(number) || number <= 0 || number > maximum)
            throw new IllegalArgumentException("Invalid release number");
        return ((Number) value).longValue();
    }
    static AppUpdateRelease restore(JSONObject data, String role) throws Exception { return new AppUpdateRelease(role, data); }
    boolean newerThan(long installedVersion, int sdk) { return versionCode > installedVersion && minSdk <= sdk; }
    String filename() { return "update-" + versionCode + ".apk"; }
    JSONObject json() throws Exception {
        return new JSONObject().put("packageName", packageName).put("versionName", versionName).put("versionCode", versionCode)
                .put("minSdk", minSdk).put("url", url).put("sha256", sha256).put("size", size).put("notes", notes);
    }
    static boolean https(URL value) {
        return "https".equals(value.getProtocol()) && value.getUserInfo() == null && (value.getPort() == -1 || value.getPort() == 443);
    }
    static boolean site(URL value) {
        return https(value) && "applications.nature-care.net".equalsIgnoreCase(value.getHost());
    }
    static boolean trustedDownload(URL value, boolean redirect) {
        if (!https(value)) return false;
        String host = value.getHost();
        if (site(value)) return !redirect && value.getPath().startsWith(SITE_PREFIX);
        if ("github.com".equalsIgnoreCase(host)) return value.getPath().startsWith("/louay1992/mahmoud/releases/download/");
        return redirect && ("release-assets.githubusercontent.com".equalsIgnoreCase(host) || "objects.githubusercontent.com".equalsIgnoreCase(host));
    }
}
