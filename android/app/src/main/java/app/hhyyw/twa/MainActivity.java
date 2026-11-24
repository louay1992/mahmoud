package app.hhyyw.twa;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** يطلب إذن الإشعارات (أندرويد 13+) ويطلب استثناء التطبيق من توفير البطارية مرة واحدة، ثم يفتح التطبيق. */
public class MainActivity extends LauncherActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
            }
            SharedPreferences p = getSharedPreferences("prefs", Context.MODE_PRIVATE);
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && !p.getBoolean("battery_asked", false)
                    && pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                p.edit().putBoolean("battery_asked", true).apply();
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception ignored) { }
        super.onCreate(savedInstanceState);
    }
}
