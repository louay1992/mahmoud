package app.hhyyw.twa;
import static org.junit.Assert.*;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28)
public class OfflineShellTest {
    @Test public void bundledRoleAndSdkOpenAtTheExistingOriginOnly() throws Exception {
        String role=BuildConfig.APP_SCOPE;OfflineShell shell=new OfflineShell(RuntimeEnvironment.getApplication(),role);
        assertEquals(role+".html",shell.assetPath(Uri.parse("https://hhyyw.netlify.app/"+role+"?native=1")));
        WebResourceResponse page=shell.response(Uri.parse("https://hhyyw.netlify.app/"+role));assertNotNull(page);
        String html=new String(page.getData().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);assertTrue(html.contains("delivery-offline-shell"));assertTrue(html.contains("/vendor/supabase.js"));assertTrue(html.contains("/subscription-access.js"));
        assertNotNull(shell.response(Uri.parse("https://hhyyw.netlify.app/vendor/supabase.js")));
        assertNotNull(shell.response(Uri.parse("https://hhyyw.netlify.app/subscription-access.js")));
        for(String url:new String[]{"https://evil.example/"+role,"http://hhyyw.netlify.app/"+role,"https://hhyyw.netlify.app/app-version.json","https://hhyyw.netlify.app/../admin.html","https://hhyyw.netlify.app/"+(role.equals("admin")?"captain":"admin"),"https://jabapvnmfdflysxfxwwf.supabase.co/rest/v1/orders"})assertNull(url,shell.assetPath(Uri.parse(url)));
    }
}
