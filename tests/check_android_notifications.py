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

gradle = Path('android/app/build.gradle').read_text()
for role in ['admin', 'captain']:
    manifest = json.loads(Path(f'manifest-{role}.json').read_text())
    page = Path(f'{role}.html').read_text()
    assert manifest['scope'] == f'/{role}'
    assert f'scope:"/{role}"' in page
    assert f'pathPrefix: "/{role}"' in gradle
    assert manifest['start_url'].startswith(manifest['scope'])
    assert re.search(r'<script src="/push-client.js"></script>', page)
print('Android permission activity and both application scopes match.')
