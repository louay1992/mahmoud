package app.hhyyw.twa;

import android.app.Application;

public final class DeliveryApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        NativeNotifications.createChannel(this);
    }
}
