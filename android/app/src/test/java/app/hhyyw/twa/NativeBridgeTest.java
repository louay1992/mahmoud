package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.app.Activity;
import android.os.Looper;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import java.util.ArrayList;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class NativeBridgeTest {
    @Test public void namedHostHandshakeReportsInstalledAppAndStatusWithoutNetwork() throws Exception {
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();
        NativePushBridge bridge=new NativePushBridge(activity);
        ArrayList<String> responses=new ArrayList<>();
        try {
            bridge.message("{\"type\":\"hello\",\"version\":1,\"role\":\"wrong\"}",responses::add);
            assertTrue(responses.isEmpty());
            bridge.message(new JSONObject().put("type","hello").put("version",1).put("role",BuildConfig.APP_SCOPE).toString(),responses::add);
            JSONObject hello=new JSONObject(responses.get(0));
            assertEquals("delivery.native.ready",hello.getString("type"));
            assertEquals("android",hello.getString("host"));
            assertEquals(BuildConfig.VERSION_NAME,hello.getString("app_version"));
            assertEquals(activity.getString(R.string.app_name),hello.getString("app_name"));
            bridge.message("{\"type\":\"status\",\"id\":\"s1\"}",responses::add);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals("s1",new JSONObject(responses.get(1)).getString("id"));
            assertTrue(new JSONObject(responses.get(1)).getBoolean("ok"));
        } finally { bridge.close();activity.finish(); }
    }
}
