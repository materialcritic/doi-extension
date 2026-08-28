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
# Generated (real-values) manifest goes OUTSIDE the repo checkout, in
# %LOCALAPPDATA%\doi-grabber\ -- not next to doi_host.py the way an earlier
# version of this script did. Writing it inside native-host/ meant it landed
# on a path git already tracks (as a placeholder template with
# YOUR_USERNAME/YOUR_EXTENSION_ID), so `git status` immediately showed the
# generated file as locally modified -- forever, on every machine that ever
# ran this installer. apply_update refuses to `git pull` while any tracked
# file is modified, so anyone who installed on Windows exactly per the
# README permanently lost the ability to self-update. install.sh doesn't
# have this problem: it heredocs its own copy straight to the OS's real
# NativeMessagingHosts folder and never touches a path git tracks -- this
# does the equivalent for Windows, which registers hosts via the registry
# instead of a fixed folder.
$ManifestDir = Join-Path $env:LOCALAPPDATA "doi-grabber"
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null
$ManifestDest = Join-Path $ManifestDir $ManifestName

if (-not (Test-Path $HostWrapper)) {
    Write-Error "Couldn't find doi_host.bat next to this script - make sure you're running install.ps1 from inside native-host\."
    exit 1
}

Write-Host ""
Write-Host "Open chrome://extensions, enable Developer Mode, load the extension,"
Write-Host "and paste its Extension ID below."
Write-Host ""
# Chrome extension IDs are always exactly 32 lowercase characters from a-p
# (derived from a SHA-256 hash mapped into that alphabet) -- validating the
# shape here catches a typo/paste mistake immediately, instead of producing
# a manifest Chrome will silently ignore and leaving the user staring at a
# generic "native host has exited" with nothing to go on. This has
# historically been the single most common support symptom for this project.
while ($true) {
    $ExtId = Read-Host "Extension ID"
    if ([string]::IsNullOrWhiteSpace($ExtId)) {
        Write-Host "Extension ID cannot be empty."
        continue
    }
    if ($ExtId -notmatch "^[a-p]{32}$") {
        Write-Host "That doesn't look like a Chrome extension ID (expected exactly 32 letters, a-p)."
        Write-Host "Double-check chrome://extensions and paste it again."
        continue
    }
    break
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
