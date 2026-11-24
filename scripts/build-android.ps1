param(
    [Parameter(Mandatory=$true)][string]$KeyStorePath,
    [Parameter(Mandatory=$true)][string]$PasswordFile,
    [string]$KeyAlias = 'delivery',
    [string]$ToolsRoot = (Join-Path $env:TEMP 'delivery-android-tools'),
    [string]$ExistingBuildRoot
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsPath = [System.IO.Path]::GetFullPath($ToolsRoot)
$env:JAVA_HOME = (Get-ChildItem -LiteralPath (Join-Path $toolsPath 'jdk') -Directory | Select-Object -First 1).FullName
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
$env:ANDROID_HOME = Join-Path $toolsPath 'android-sdk'
$env:ANDROID_USER_HOME = Join-Path $toolsPath 'android-user'
$env:GRADLE_USER_HOME = Join-Path $toolsPath 'gradle-home'
$assetLinks = Get-Content -LiteralPath (Join-Path $projectRoot '.well-known/assetlinks.json') -Raw | ConvertFrom-Json
$expectedFingerprint = $assetLinks[0].target.sha256_cert_fingerprints[0].Replace(':','').ToUpperInvariant()
$certificate = & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') '-J-Duser.language=en' -list -v -alias $KeyAlias -keystore $KeyStorePath '-storepass:file' $PasswordFile
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the supplied signing key' }
$match = [regex]::Match(($certificate -join "`n"), 'SHA256:\s*([0-9A-F:]+)')
if (!$match.Success -or $match.Groups[1].Value.Replace(':','') -ne $expectedFingerprint) { throw 'Signing certificate does not match the existing application certificate' }
$configFile = Join-Path $projectRoot 'android/app/google-services.json'
$gradleSource = Get-Content -LiteralPath (Join-Path $projectRoot 'android/app/build.gradle') -Raw
$versionName = [regex]::Match($gradleSource, 'versionName "([0-9.]+)"').Groups[1].Value
$versionCode = [regex]::Match($gradleSource, 'versionCode ([0-9]+)').Groups[1].Value
if (!$versionName -or !$versionCode) { throw 'Missing Android application version' }
if (!(Test-Path -LiteralPath $configFile)) { throw 'Missing Firebase Android configuration: android/app/google-services.json' }
$firebase = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$packages = @($firebase.client | ForEach-Object { $_.client_info.android_client_info.package_name })
foreach ($role in @('admin','captain')) { if ($packages -notcontains "app.hhyyw.$role") { throw "Firebase configuration is missing app.hhyyw.$role" } }

# Android's Windows tools require an ASCII build path. Copy source, never move it.
$buildRoot = if ($ExistingBuildRoot) { [System.IO.Path]::GetFullPath($ExistingBuildRoot) } else { Join-Path $toolsPath ('build-' + [guid]::NewGuid().ToString('N')) }
if (!$buildRoot.StartsWith($toolsPath + [System.IO.Path]::DirectorySeparatorChar)) { throw 'Build output must be inside the tools directory' }
$androidRoot = Join-Path $buildRoot 'android'
if (!$ExistingBuildRoot) {
New-Item -ItemType Directory -Path (Join-Path $androidRoot 'app') -Force | Out-Null
foreach ($name in @('build.gradle','settings.gradle','gradle.properties')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "android/$name") -Destination (Join-Path $androidRoot $name)
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'admin.html') -Destination (Join-Path $buildRoot 'admin.html')
Copy-Item -LiteralPath (Join-Path $projectRoot 'android/app/build.gradle') -Destination (Join-Path $androidRoot 'app/build.gradle')
Copy-Item -LiteralPath $configFile -Destination (Join-Path $androidRoot 'app/google-services.json')
Copy-Item -LiteralPath (Join-Path $projectRoot 'android/app/src') -Destination (Join-Path $androidRoot 'app/src') -Recurse
& (Join-Path $toolsPath 'gradle/gradle-8.7/bin/gradle.bat') -p $androidRoot --no-daemon testAdminDebugUnitTest testCaptainDebugUnitTest assembleAdminRelease assembleCaptainRelease
if ($LASTEXITCODE -ne 0) { throw "Android build failed. Build directory: $buildRoot" }
}
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/34.0.0'
$artifacts = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$hashes = @()
foreach ($role in @('admin','captain')) {
    $unsigned = Join-Path $androidRoot "app/build/outputs/apk/$role/release/app-$role-release-unsigned.apk"
    $aligned = Join-Path $buildRoot "$role-aligned.apk"
    $signed = Join-Path $buildRoot "signed-$role.apk"
    & (Join-Path $buildTools 'zipalign.exe') -f -p 4 $unsigned $aligned
    if ($LASTEXITCODE -ne 0) { throw "Alignment failed: $role" }
    & (Join-Path $buildTools 'apksigner.bat') sign --ks $KeyStorePath --ks-key-alias $KeyAlias --ks-pass "file:$PasswordFile" --out $signed $aligned
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: $role" }
    $verified = & (Join-Path $buildTools 'apksigner.bat') verify --verbose --print-certs $signed
    if ($LASTEXITCODE -ne 0) { throw "APK verification failed: $role" }
    $digest = [regex]::Match(($verified -join "`n"), 'certificate SHA-256 digest:\s*([0-9a-f]+)').Groups[1].Value.ToUpperInvariant()
    if ($digest -ne $expectedFingerprint) { throw "APK certificate mismatch: $role" }
    & (Join-Path $buildTools 'zipalign.exe') -c -p 4 $signed
    if ($LASTEXITCODE -ne 0) { throw "Signed APK alignment failed: $role" }
    $badging = & (Join-Path $buildTools 'aapt2.exe') dump badging $signed
    if ($LASTEXITCODE -ne 0 -or !($badging -match "package: name='app.hhyyw.$role' versionCode='$versionCode' versionName='$versionName'")) { throw "APK package/version mismatch: $role" }
    $hash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
    $artifactPath = Join-Path $artifacts "$role-$versionName.apk"
    Copy-Item -LiteralPath $signed -Destination $artifactPath
    $hashes += "$hash  $role-$versionName.apk"
    Write-Output "Verified app.hhyyw.$role $versionName with the existing signing certificate: $artifactPath"
}
$hashes | Set-Content -LiteralPath (Join-Path $artifacts 'SHA256SUMS') -Encoding utf8
Write-Output "Build and test directory: $buildRoot"
