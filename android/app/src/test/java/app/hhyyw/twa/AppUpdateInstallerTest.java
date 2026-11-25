package app.hhyyw.twa;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.provider.Settings;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.io.File;
import java.io.IOException;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AppUpdateInstallerTest {
    private Signature[] signer(int value){return new Signature[]{new Signature(new byte[]{(byte)value,2,3})};}
    @Test public void replacementRequiresTheSamePackageANewerVersionAndTheExactSigner() throws Exception {
        AppUpdateRelease release=AppUpdateTestData.release(new byte[]{1}); String own="app.hhyyw."+BuildConfig.APP_SCOPE;
        int next=release.versionCode,current=next-1;
        AppUpdateInstaller.verifyIdentity(own,current,own,next,"1.4.1",signer(1),signer(1),release);
        assertThrows(IOException.class, () -> AppUpdateInstaller.verifyIdentity(own,current,own,next,"1.4.1",signer(1),signer(2),release));
        assertThrows(IOException.class, () -> AppUpdateInstaller.verifyIdentity(own,next,own,next,"1.4.1",signer(1),signer(1),release));
        assertThrows(IOException.class, () -> AppUpdateInstaller.verifyIdentity(own,current,"app.hhyyw.other",next,"1.4.1",signer(1),signer(1),release));
        assertThrows(IOException.class, () -> AppUpdateInstaller.verifyIdentity(own,current,own,next+1,"1.4.1",signer(1),signer(1),release));
        assertFalse(AppUpdateInstaller.sameSigners(signer(1),null)); assertFalse(AppUpdateInstaller.sameSigners(new Signature[0],signer(1)));
        assertFalse(AppUpdateInstaller.sameSigners(signer(1),new Signature[]{signer(1)[0],signer(2)[0]}));
    }
    @Test public void installerOnlySharesThePrivateUpdateFileWithReadPermission() throws Exception {
        Context context=RuntimeEnvironment.getApplication(); File directory=new File(context.getCacheDir(),"app-updates"); directory.mkdirs();
        File apk=new File(directory,"update-8.apk"); assertTrue(apk.createNewFile()||apk.exists());
        Intent intent=AppUpdateInstaller.installIntent(context,apk);
        assertEquals(Intent.ACTION_VIEW,intent.getAction()); assertEquals("application/vnd.android.package-archive",intent.getType());
        assertEquals("content",intent.getData().getScheme()); assertEquals(context.getPackageName()+".updates",intent.getData().getAuthority());
        assertNotEquals(0,intent.getFlags()&Intent.FLAG_GRANT_READ_URI_PERMISSION); assertEquals(0,intent.getFlags()&Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        File unrelated=new File(context.getCacheDir(),"private-account-data"); unrelated.createNewFile();
        assertThrows(IllegalArgumentException.class, () -> AppUpdateInstaller.installIntent(context,unrelated));
    }
    @Test public void androidInstallPermissionIsCheckedAndRequestedForThisAppOnly() {
        Context context=mock(Context.class); PackageManager manager=mock(PackageManager.class);
        when(context.getPackageManager()).thenReturn(manager); when(context.getPackageName()).thenReturn("app.hhyyw."+BuildConfig.APP_SCOPE);
        when(manager.canRequestPackageInstalls()).thenReturn(false); assertFalse(AppUpdateInstaller.permitted(context));
        when(manager.canRequestPackageInstalls()).thenReturn(true); assertTrue(AppUpdateInstaller.permitted(context));
        Intent permission=AppUpdateInstaller.permissionIntent(context);
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,permission.getAction()); assertEquals("package:"+context.getPackageName(),permission.getDataString());
    }
}
