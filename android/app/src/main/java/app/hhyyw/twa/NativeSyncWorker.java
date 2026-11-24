package app.hhyyw.twa;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class NativeSyncWorker extends Worker {
    public NativeSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    @NonNull @Override public Result doWork() {
        try { new NativeDeviceStore(getApplicationContext()).sync(); return Result.success(); }
        catch (Exception unavailable) { return getRunAttemptCount() < 12 ? Result.retry() : Result.failure(); }
    }
}
