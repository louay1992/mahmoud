package app.hhyyw.twa;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.ResultReceiver;
import android.provider.Settings;

public final class NativePermissionActivity extends Activity {
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (NativeNotifications.permitted(this)) { complete(); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                (!getPreferences(MODE_PRIVATE).getBoolean("asked", false) || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("asked", true).apply();
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 83);
        } else {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivityForResult(intent, 84);
        }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 83) complete();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 84) complete();
    }
    private void complete() {
        ResultReceiver receiver = getIntent().getParcelableExtra("receiver");
        if (receiver != null) receiver.send(0, Bundle.EMPTY);
        finish();
    }
}
