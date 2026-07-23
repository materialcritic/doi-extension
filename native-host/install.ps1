# -------------------------------------------------------------------
# DOI Grabber - Native Messaging Host installer (Windows)
# Run this AFTER loading the extension in Chrome and getting
# its Extension ID from chrome://extensions
#
# Usage (from PowerShell):
#   cd native-host
#   .\install.ps1
#
# If script execution is blocked, run once first:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# -------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostWrapper = Join-Path $ScriptDir "doi_host.bat"
$ManifestName = "com.doi_grabber.host.json"
$ManifestDest = Join-Path $ScriptDir $ManifestName

if (-not (Test-Path $HostWrapper)) {
    Write-Error "Couldn't find doi_host.bat next to this script - make sure you're running install.ps1 from inside native-host\."
    exit 1
}

Write-Host ""
Write-Host "Open chrome://extensions, enable Developer Mode, load the extension,"
Write-Host "and paste its Extension ID below."
Write-Host ""
$ExtId = Read-Host "Extension ID"

if ([string]::IsNullOrWhiteSpace($ExtId)) {
    Write-Error "Extension ID cannot be empty."
    exit 1
}

# Native Messaging manifest - same shape as the macOS/Linux one, but "path"
# points at the .bat wrapper (Chrome needs an executable it can spawn
# directly; it can't run a bare .py file on Windows the way it can via a
# shebang line on macOS/Linux).
$ManifestObject = [ordered]@{
    name             = "com.doi_grabber.host"
    description      = "Native Messaging host for DOI Grabber"
    path             = $HostWrapper
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$ExtId/")
}
# Set-Content -Encoding UTF8 prepends a BOM on Windows PowerShell 5.1 (the
# default on Windows), which Chrome's native-messaging manifest reader can
# reject outright. WriteAllText with a BOM-less UTF8Encoding avoids that.
$ManifestJson = $ManifestObject | ConvertTo-Json
[System.IO.File]::WriteAllText($ManifestDest, $ManifestJson, (New-Object System.Text.UTF8Encoding($false)))

# Windows registers Native Messaging hosts via the registry instead of a
# fixed folder (which is how macOS/Linux do it) - the registry value just
# points at this manifest file's path.
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.doi_grabber.host"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestDest

Write-Host ""
Write-Host "Manifest written to: $ManifestDest"
Write-Host "Registered at: $RegPath"
Write-Host ""
Write-Host "Next: open Settings in the extension and set the Python interpreter"
Write-Host "path and script path if the defaults don't already work."
Write-Host "Done! Fully restart Chrome and try the popup."
