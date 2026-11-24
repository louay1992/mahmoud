"""Check cross-platform notification wiring without requiring an Android SDK."""
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

android = '{http://schemas.android.com/apk/res/android}'
root = ET.parse('android/app/src/main/AndroidManifest.xml').getroot()
assert root.find(f"uses-permission[@{android}name='android.permission.POST_NOTIFICATIONS']") is not None
application = root.find('application')
activity = application.find(f"activity[@{android}name='com.google.androidbrowserhelper.trusted.NotificationPermissionRequestActivity']")
assert activity is not None, 'The browser must be able to launch the delegated permission activity'
assert activity.get(android + 'exported') == 'false'
assert application.find(f"service[@{android}name='com.google.androidbrowserhelper.trusted.DelegationService']") is not None
assert root.find(f"queries/package[@{android}name='com.android.chrome']") is not None
launcher = Path('android/app/src/main/java/app/hhyyw/twa/MainActivity.java').read_text(encoding='utf-8')
assert 'ChromeProvider.isAvailable(getPackageManager())' in launcher
assert 'new BridgeTwaLauncher(this, ChromeProvider.PACKAGE_NAME, nativeBridge)' in launcher
assert application.find(f"service[@{android}name='androidx.browser.customtabs.PostMessageService']") is not None
assert application.find(f"service[@{android}name='.DeliveryMessagingService']").get(android + 'exported') == 'false'
links = json.loads(Path('.well-known/assetlinks.json').read_text(encoding='utf-8'))
for link in links:
    assert 'delegate_permission/common.use_as_origin' in link['relation']

gradle = Path('android/app/build.gradle').read_text(encoding='utf-8')
for role in ['admin', 'captain']:
    manifest = json.loads(Path(f'manifest-{role}.json').read_text())
    page = Path(f'{role}.html').read_text(encoding='utf-8')
    assert manifest['scope'] == f'/{role}'
    assert f'scope:"/{role}"' in page
    assert f'pathPrefix: "/{role}"' in gradle
    assert manifest['start_url'].startswith(manifest['scope'])
    assert re.search(r'<script src="/push-client.js"></script>', page)
    assert re.search(r'<script src="/native-push.js"></script>', page)
print('Native FCM, validated TWA channel, fallback Web Push, and application scopes match.')
