package app.hhyyw.twa;

import android.net.Uri;
import java.util.UUID;

final class NotificationRoute {
    static final String ORIGIN = "https://hhyyw.netlify.app";
    private NotificationRoute() {}

    static Uri safe(String value, String scope) {
        Uri result = Uri.parse(ORIGIN + "/" + scope);
        if (value == null) return result;
        Uri candidate = Uri.parse(value.startsWith("/") && !value.startsWith("//") ? ORIGIN + value : value);
        if (!"https".equals(candidate.getScheme()) || !"hhyyw.netlify.app".equals(candidate.getHost()) ||
                candidate.getPort() != -1 || candidate.getUserInfo() != null ||
                !(candidate.getPath().equals("/" + scope) || candidate.getPath().equals("/" + scope + ".html"))) return result;
        Uri.Builder builder = result.buildUpon();
        String order = candidate.getQueryParameter("order");
        if (order != null) {
            try { builder.appendQueryParameter("order", UUID.fromString(order).toString()); }
            catch (IllegalArgumentException ignored) { /* Ignore an invalid order identifier. */ }
        }
        if ("1".equals(candidate.getQueryParameter("notification"))) builder.appendQueryParameter("notification", "1");
        return builder.build();
    }
}
