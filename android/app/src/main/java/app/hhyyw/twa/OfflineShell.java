package app.hhyyw.twa;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;

/** Serves bundled public assets at the existing HTTPS origin, never API/auth data. */
final class OfflineShell {
    private final Context context;
    private final String role;
    private final HashSet<String> paths = new HashSet<>();
    OfflineShell(Context context, String role) {
        this.context=context;this.role=role;
        try (java.io.InputStream input=context.getAssets().open("offline/offline-shell-manifest.json")) {
            JSONArray files=new JSONObject(new String(read(input),StandardCharsets.UTF_8)).getJSONObject(role).getJSONArray("files");
            for(int i=0;i<files.length();i++)paths.add(files.getJSONObject(i).getString("url"));
        } catch(Exception ignored) { paths.clear(); }
    }
    private static byte[] read(java.io.InputStream input) throws java.io.IOException {
        java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;
        while((count=input.read(buffer))!=-1)output.write(buffer,0,count);return output.toByteArray();
    }
    String assetPath(Uri uri) {
        if(!NativeHostPolicy.ownOrigin(uri))return null;
        String path=uri.getPath();if(NativeHostPolicy.appPage(uri,role))path="/"+role+".html";
        return paths.contains(path)?path.substring(1):null;
    }
    WebResourceResponse response(Uri uri) {
        String path=assetPath(uri);if(path==null)return null;
        try(java.io.InputStream input=context.getAssets().open("offline/"+path)) {
            byte[] content=read(input);String mime=path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":path.endsWith(".png")?"image/png":path.endsWith(".json")?"application/json":"text/html";
            if(path.equals(role+".html"))content=new String(content,StandardCharsets.UTF_8).replace("<head>","<head><meta name=\"delivery-offline-shell\" content=\"1\">").getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse(mime,"UTF-8",200,"OK",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(content));
        }catch(Exception ignored){return null;}
    }
}
