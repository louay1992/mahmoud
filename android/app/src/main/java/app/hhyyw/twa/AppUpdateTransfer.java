package app.hhyyw.twa;

import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;

final class AppUpdateTransfer {
    interface Progress { void changed(long downloaded, long total); }
    static HttpURLConnection open(String address, boolean apk) throws Exception {
        URL url = new URL(address);
        for (int redirects = 0; redirects <= 5; redirects++) {
            boolean allowed = apk ? AppUpdateRelease.trustedDownload(url, redirects > 0)
                    : AppUpdateRelease.https(url) && "raw.githubusercontent.com".equalsIgnoreCase(url.getHost());
            if (!allowed) throw new IOException("تعذّر التحقق من مصدر التحديث");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
            connection.setRequestProperty("User-Agent", "DeliveryApps-Android-Updater/1");
            connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("Accept", apk ? "application/octet-stream" : "application/json");
            int status;
            try { status = connection.getResponseCode(); } catch (Exception error) { connection.disconnect(); throw error; }
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = connection.getHeaderField("Location"); connection.disconnect();
                if (location == null) throw new IOException("رابط التحديث غير متاح");
                url = new URL(url, location); continue;
            }
            if (status != 200) { connection.disconnect(); throw new IOException("تعذّر تحميل التحديث؛ حاول مجددًا عند استقرار الاتصال"); }
            return connection;
        }
        throw new IOException("تعذّر الوصول إلى ملف التحديث");
    }
    static AppUpdateRelease latest(String role) throws Exception {
        HttpURLConnection connection = open(AppUpdateRelease.FEED, false);
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 65536) throw new IOException("بيانات الإصدار غير صالحة");
                output.write(buffer, 0, count);
            }
            return AppUpdateRelease.parse(new JSONObject(output.toString(StandardCharsets.UTF_8.name())), role);
        } finally { connection.disconnect(); }
    }
    static File download(AppUpdateRelease release, File directory, AtomicBoolean cancelled, Progress progress) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("لا توجد مساحة لحفظ التحديث");
        File temporary = File.createTempFile("download-", ".part", directory);
        HttpURLConnection connection = null;
        try {
            connection = open(release.url, true);
            String contentLength = connection.getHeaderField("Content-Length");
            long length = contentLength == null ? -1 : Long.parseLong(contentLength);
            if (length >= 0 && length != release.size) throw new IOException("حجم ملف التحديث غير مطابق؛ أعد المحاولة");
            try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(temporary)) {
                copy(input, output, release, cancelled, progress);
            }
            if (cancelled.get()) throw new CancellationException();
            File complete = new File(directory, release.filename());
            if (complete.exists() && !complete.delete()) throw new IOException("تعذّر تجهيز التحديث");
            if (!temporary.renameTo(complete)) throw new IOException("تعذّر حفظ التحديث");
            return complete;
        } finally {
            if (connection != null) connection.disconnect();
            if (temporary.exists()) temporary.delete();
        }
    }
    static void copy(InputStream input, OutputStream output, AppUpdateRelease release, AtomicBoolean cancelled, Progress progress) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32768]; long downloaded = 0; int count, lastPercent = -1;
        while ((count = input.read(buffer)) != -1) {
            if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new CancellationException();
            downloaded += count;
            if (downloaded > release.size) throw new IOException("حجم ملف التحديث غير مطابق");
            output.write(buffer, 0, count); digest.update(buffer, 0, count);
            int percent = (int) (downloaded * 100 / release.size);
            if (percent != lastPercent) { progress.changed(downloaded, release.size); lastPercent = percent; }
        }
        if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new CancellationException();
        if (downloaded != release.size || !hex(digest.digest()).equals(release.sha256))
            throw new IOException("تعذّر التحقق من سلامة ملف التحديث؛ نزّله مجددًا");
    }
    static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[32768]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); }
        return hex(digest.digest());
    }
    static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString(); }
}
