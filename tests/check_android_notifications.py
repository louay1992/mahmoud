"""Check cross-platform notification wiring without requiring an Android SDK."""
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

android = '{http://schemas.android.com/apk/res/android}'
root = ET.parse('android/app/src/main/AndroidManifest.xml').getroot()
assert root.find(f"uses-permission[@{android}name='android.permission.POST_NOTIFICATIONS']") is not None
application = root.find('application')
activity = application.find(f"activity[@{android}name='.NativePermissionActivity']")
assert activity is not None
assert activity.get(android + 'exported') == 'false'
assert root.find('queries') is None, 'The app must not select a browser provider'
launcher = Path('android/app/src/main/java/app/hhyyw/twa/MainActivity.java').read_text(encoding='utf-8')
assert 'extends Activity' in launcher and 'new WebView(this)' in launcher
assert 'WebViewCompat.addWebMessageListener' in launcher
assert 'NativeHostPolicy.bridgeAllowed' in launcher
assert 'addJavascriptInterface' not in launcher
assert application.find(f"service[@{android}name='androidx.browser.customtabs.PostMessageService']") is None
assert 'androidbrowserhelper' not in ET.tostring(application).decode()
assert application.find(f"service[@{android}name='.DeliveryMessagingService']").get(android + 'exported') == 'false'
links = json.loads(Path('.well-known/assetlinks.json').read_text(encoding='utf-8'))
for link in links:
    assert 'delegate_permission/common.use_as_origin' in link['relation']

gradle = Path('android/app/build.gradle').read_text(encoding='utf-8')
assert 'androidbrowserhelper' not in gradle and 'androidx.browser:' not in gradle
for role in ['admin', 'captain']:
    manifest = json.loads(Path(f'manifest-{role}.json').read_text())
    page = Path(f'{role}.html').read_text(encoding='utf-8')
    app = Path(f'{role}-app.js').read_text(encoding='utf-8')
    assert manifest['scope'] == f'/{role}'
    assert f'scope:"/{role}"' in app
    assert f'pathPrefix: "/{role}"' in gradle
    assert manifest['start_url'].startswith(manifest['scope'])
    assert re.search(r'<script src="/push-client.js"></script>', page)
    assert re.search(r'<script src="/native-push.js"></script>', page)
print('Internal Android host, own native FCM service, browser independence, and application scopes match.')
