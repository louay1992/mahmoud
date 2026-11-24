package app.hhyyw.twa;

import android.app.Activity;
import android.content.ComponentName;
import android.net.Uri;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.browser.customtabs.CustomTabsCallback;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsService;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.browser.trusted.Token;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import com.google.androidbrowserhelper.trusted.SharedPreferencesTokenStore;
import com.google.androidbrowserhelper.trusted.TwaLauncher;
import com.google.androidbrowserhelper.trusted.splashscreens.SplashScreenStrategy;

/* Uses one session for the TWA and its origin-validated postMessage channel. */
final class BridgeTwaLauncher extends TwaLauncher {
    private final Activity activity;
    private final String provider;
    private final NativePushBridge bridge;
    private final Uri origin = Uri.parse(NotificationRoute.ORIGIN);
    private CustomTabsSession session;
    private CustomTabsServiceConnection connection;
    private TrustedWebActivityIntentBuilder builder;
    private Runnable completion;
    private CustomTabsCallback quality;
    private boolean validated;
    private boolean loaded;
    private boolean destroyed;

    BridgeTwaLauncher(Activity activity, String provider, NativePushBridge bridge) {
        super(activity, provider); this.activity = activity; this.provider = provider; this.bridge = bridge;
    }
    @Override public void launch(TrustedWebActivityIntentBuilder builder, CustomTabsCallback callback,
            SplashScreenStrategy splash, Runnable completion, FallbackStrategy fallback) {
        this.builder = builder; this.quality = callback; this.completion = completion;
        if (session != null) { open(); return; }
        if (connection != null) return;
        connection = new CustomTabsServiceConnection() {
            @Override public void onCustomTabsServiceConnected(@NonNull ComponentName name, @NonNull CustomTabsClient client) {
                if (destroyed) return;
                client.warmup(0);
                session = client.newSession(events);
                if (session == null) { activity.finish(); return; }
                new SharedPreferencesTokenStore(activity).store(Token.create(provider, activity.getPackageManager()));
                session.validateRelationship(CustomTabsService.RELATION_USE_AS_ORIGIN, origin, null);
                open();
            }
            @Override public void onServiceDisconnected(ComponentName name) { session = null; validated = false; loaded = false; }
        };
        if (!CustomTabsClient.bindCustomTabsServicePreservePriority(activity, provider, connection)) activity.finish();
    }
    private void open() {
        if (destroyed || activity.isFinishing() || session == null) return;
        loaded = false;
        builder.build(session).launchTrustedWebActivity(activity);
        if (completion != null) completion.run();
    }
    private void channel() {
        if (validated && loaded && session != null && !destroyed) session.requestPostMessageChannel(origin, origin, new Bundle());
    }
    private final CustomTabsCallback events = new CustomTabsCallback() {
        @Override public void onNavigationEvent(int event, Bundle extras) {
            if (quality != null) quality.onNavigationEvent(event, extras);
            if (event == NAVIGATION_STARTED) loaded = false;
            if (event == NAVIGATION_FINISHED) { loaded = true; channel(); }
        }
        @Override public void onRelationshipValidationResult(int relation, @NonNull Uri requestedOrigin, boolean result, Bundle extras) {
            if (quality != null) quality.onRelationshipValidationResult(relation, requestedOrigin, result, extras);
            if (relation == CustomTabsService.RELATION_USE_AS_ORIGIN && origin.equals(requestedOrigin)) { validated = result; channel(); }
        }
        @Override public void onMessageChannelReady(Bundle extras) { if (validated && session != null) bridge.connected(session); }
        @Override public void onPostMessage(@NonNull String message, Bundle extras) { if (validated && loaded) bridge.message(message); }
    };
    @Override public void destroy() {
        destroyed = true;
        if (connection != null) { try { activity.unbindService(connection); } catch (IllegalArgumentException ignored) {} }
        bridge.close(); super.destroy();
    }
}
