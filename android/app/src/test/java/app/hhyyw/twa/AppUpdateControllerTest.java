package app.hhyyw.twa;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.AlertDialog;
import android.os.Looper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowAlertDialog;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@LooperMode(LooperMode.Mode.PAUSED)
public class AppUpdateControllerTest {
    static class Immediate extends AbstractExecutorService {
        boolean stopped;public void shutdown(){stopped=true;}public List<Runnable> shutdownNow(){stopped=true;return java.util.Collections.emptyList();}
        public boolean isShutdown(){return stopped;}public boolean isTerminated(){return stopped;}public boolean awaitTermination(long n,TimeUnit u){return stopped;}
        public void execute(Runnable run){run.run();}
    }
    @Test public void openingAnOldVersionShowsAnOfferBeforeLoginAndLaterDefersIt() throws Exception {
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();
        AppUpdateController updates=new AppUpdateController(activity,role->AppUpdateTestData.release(new byte[]{1}),new Immediate());
        try{
            updates.resume();Shadows.shadowOf(Looper.getMainLooper()).idle();
            AlertDialog offer=ShadowAlertDialog.getLatestAlertDialog();assertNotNull(offer);assertTrue(offer.isShowing());
            assertEquals("تحديث الآن",offer.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
            offer.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(offer.isShowing());
            updates.pause();updates.resume();Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(offer.isShowing());
        }finally{updates.close();activity.finish();}
    }
    @Test public void anOfflineVersionCheckDoesNotBlockApplicationStartup(){
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();
        AppUpdateController updates=new AppUpdateController(activity,role->{throw new java.io.IOException("offline");},new Immediate());
        try{updates.resume();Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(activity.isFinishing());}
        finally{updates.close();activity.finish();}
    }
}
