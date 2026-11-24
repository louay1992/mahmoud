param([string]$ToolsRoot = (Join-Path $env:TEMP 'delivery-android-tools'))
$ErrorActionPreference = 'Stop'
$toolsPath = [System.IO.Path]::GetFullPath($ToolsRoot)
New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
function Get-ToolArchive([string]$Url, [string]$Name, [string]$Directory) {
    $archivePath = Join-Path $toolsPath $Name
    $extractPath = Join-Path $toolsPath $Directory
    if (!(Test-Path -LiteralPath $archivePath)) {
        Write-Host "Downloading $Name"
        Invoke-WebRequest -Uri $Url -OutFile $archivePath
    }
    if (!(Test-Path -LiteralPath $extractPath)) {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
    }
    return $extractPath
}
$jdkPath = Get-ToolArchive 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' 'jdk17.zip' 'jdk'
$env:JAVA_HOME = (Get-ChildItem -LiteralPath $jdkPath -Directory | Select-Object -First 1).FullName
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
$gradlePath = Get-ToolArchive 'https://services.gradle.org/distributions/gradle-8.7-bin.zip' 'gradle-8.7.zip' 'gradle'
$cliPath = Get-ToolArchive 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' 'android-cli.zip' 'android-cli'
$env:ANDROID_USER_HOME = Join-Path $toolsPath 'android-user'
$env:ANDROID_HOME = Join-Path $toolsPath 'android-sdk'
$env:GRADLE_USER_HOME = Join-Path $toolsPath 'gradle-home'
$sdkManager = Join-Path $cliPath 'cmdline-tools/bin/sdkmanager.bat'
1..100 | ForEach-Object { 'y' } | & $sdkManager "--sdk_root=$env:ANDROID_HOME" --licenses | Out-Null
& $sdkManager "--sdk_root=$env:ANDROID_HOME" 'platforms;android-34' 'build-tools;34.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'Android SDK installation failed' }
Write-Output "Android tools ready under $toolsPath"
