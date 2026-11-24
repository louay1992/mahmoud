package app.hhyyw.twa;

import android.net.Uri;

final class NativeHostPolicy {
    private NativeHostPolicy() {}
    static boolean ownOrigin(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "hhyyw.netlify.app".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    static boolean appPage(Uri uri, String role) {
        return ownOrigin(uri) && (('/' + role).equals(uri.getPath()) || ('/' + role + ".html").equals(uri.getPath()));
    }
    static boolean bridgeAllowed(Uri source, boolean mainFrame, String currentUrl, String role) {
        return mainFrame && ownOrigin(source) && currentUrl != null && appPage(Uri.parse(currentUrl), role);
    }
    static boolean external(Uri uri) {
        if (uri == null || uri.getScheme() == null || uri.getUserInfo() != null) return false;
        String scheme = uri.getScheme();
        return "https".equals(scheme) || "http".equals(scheme) || "tel".equals(scheme) || "mailto".equals(scheme) || "geo".equals(scheme);
    }
}
