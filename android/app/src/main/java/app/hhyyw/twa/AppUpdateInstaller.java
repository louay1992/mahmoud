package app.hhyyw.twa;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

final class AppUpdateInstaller {
    static boolean permitted(Context context) { return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls(); }
    static Intent permissionIntent(Context context) { return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())); }
    static Intent installIntent(Context context, File file) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".updates", file);
        return new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    @SuppressWarnings("deprecation")
    static void verify(Context context, File file, AppUpdateRelease release) throws Exception {
        if (!file.isFile() || file.length() != release.size || !AppUpdateTransfer.hash(file).equals(release.sha256))
            throw new IOException("ملف التحديث غير مكتمل؛ نزّله مجددًا");
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (archive == null) throw new IOException("ملف التحديث غير صالح للتثبيت");
        Signature[] own = Build.VERSION.SDK_INT >= 28 ? installed.signingInfo == null ? null : installed.signingInfo.getApkContentsSigners() : installed.signatures;
        Signature[] received = Build.VERSION.SDK_INT >= 28 ? archive.signingInfo == null ? null : archive.signingInfo.getApkContentsSigners() : archive.signatures;
        long current = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
        long version = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        verifyIdentity(context.getPackageName(), current, archive.packageName, version, archive.versionName, own, received, release);
        if (Build.VERSION.SDK_INT >= 24 && archive.applicationInfo != null && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new IOException("هذا التحديث لا يتوافق مع إصدار Android على جهازك");
    }
    static void verifyIdentity(String ownPackage, long current, String packageName, long code, String name,
                               Signature[] own, Signature[] received, AppUpdateRelease release) throws Exception {
        if (!ownPackage.equals(release.packageName) || !ownPackage.equals(packageName) || code != release.versionCode || code <= current || !release.versionName.equals(name))
            throw new IOException("هذا الملف ليس تحديثًا مناسبًا للتطبيق");
        if (!sameSigners(own, received)) throw new IOException("شهادة ملف التحديث غير مطابقة للتطبيق المثبّت");
    }
    static boolean sameSigners(Signature[] own, Signature[] received) throws Exception {
        if (own == null || received == null || own.length == 0 || received.length == 0) return false;
        Set<String> expected = new HashSet<>(), actual = new HashSet<>();
        for (Signature signature : own) expected.add(AppUpdateTransfer.hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        for (Signature signature : received) actual.add(AppUpdateTransfer.hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        return expected.equals(actual);
    }
}
