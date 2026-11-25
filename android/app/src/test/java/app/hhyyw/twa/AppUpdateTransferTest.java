package app.hhyyw.twa;

import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.ArrayList;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class AppUpdateTransferTest {
    @Test public void completeDownloadReportsProgressAndChecksTheActualBytes() throws Exception {
        byte[] bytes = new byte[90000]; for (int i=0; i<bytes.length; i++) bytes[i]=(byte)(i%251);
        ByteArrayOutputStream output = new ByteArrayOutputStream(); ArrayList<Long> progress = new ArrayList<>();
        AppUpdateTransfer.copy(new ByteArrayInputStream(bytes), output, AppUpdateTestData.release(bytes), new AtomicBoolean(), (done,total) -> progress.add(done));
        assertArrayEquals(bytes, output.toByteArray()); assertTrue(progress.size()>1); assertEquals(bytes.length, progress.get(progress.size()-1).longValue());
    }
    @Test public void corruptTruncatedAndOversizedDownloadsCannotBecomeInstallable() throws Exception {
        byte[] expected = new byte[]{1,2,3,4}; AppUpdateRelease release=AppUpdateTestData.release(expected);
        for(byte[] actual : new byte[][]{{1,2,3,5},{1,2},{1,2,3,4,5}})
            assertThrows(IOException.class, () -> AppUpdateTransfer.copy(new ByteArrayInputStream(actual),new ByteArrayOutputStream(),release,new AtomicBoolean(),(a,b)->{}));
    }
    @Test public void cancellationAndNetworkFailureStopTheDownload() throws Exception {
        byte[] bytes=new byte[90000]; AtomicBoolean cancelled=new AtomicBoolean(); ByteArrayOutputStream output=new ByteArrayOutputStream();
        assertThrows(CancellationException.class, () -> AppUpdateTransfer.copy(new ByteArrayInputStream(bytes),output,AppUpdateTestData.release(bytes),cancelled,(a,b)->cancelled.set(true)));
        assertTrue(output.size()<bytes.length);
        InputStream broken=new InputStream(){public int read() throws IOException{throw new IOException("disconnected");}};
        assertThrows(IOException.class, () -> AppUpdateTransfer.copy(broken,new ByteArrayOutputStream(),AppUpdateTestData.release(bytes),new AtomicBoolean(),(a,b)->{}));
    }
}
