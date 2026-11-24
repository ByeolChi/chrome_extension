# Register the Ssoda cURL helper for every user of this PC. Run it in an elevated PowerShell.
# Use it where policy blocks per-user native messaging hosts (NativeMessagingUserLevelHosts = 0),
# or where scripts may only run from Program Files (AppLocker default rules).
# Guide: docs/airgap-deploy.md
#
#   powershell -ExecutionPolicy Bypass -File .\install-ssoda-helper-machine.ps1 -SsodaDir C:\Tools\ssoda
#
# It writes the same three files as the per-user installer that Ssoda downloads
# (ssoda/native-host/install-windows.bat.tpl) into -Dest, and registers the host under
# HKLM\<browser>\NativeMessagingHosts\com.ssoda.runner. Tested by: npm run test:helper (machine).
# This file is ASCII only, so Windows PowerShell 5.1 reads it correctly without a BOM.
param(
  [Parameter(Mandatory = $true)][string]$SsodaDir,                              # unzipped ssoda folder (has native-host\ssoda-host.ps1)
  [string]$Dest = (Join-Path $env:ProgramFiles 'Ssoda\helper'),                 # where the helper files go
  [string[]]$Browsers = @('SOFTWARE\Google\Chrome', 'SOFTWARE\Microsoft\Edge')  # registry paths under HKLM
)
$ErrorActionPreference = 'Stop'
$ExtId = 'cnnlkogkbglbbbcefpaknbmebieabijo'  # fixed by the key in ssoda/manifest.json
$HostName = 'com.ssoda.runner'

$src = Join-Path $SsodaDir 'native-host\ssoda-host.ps1'
if (-not (Test-Path -LiteralPath $src)) { throw "Not found: $src (pass the unzipped ssoda folder as -SsodaDir)" }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$hostPs1 = Join-Path $Dest 'ssoda-host.ps1'
Copy-Item -LiteralPath $src -Destination $hostPs1 -Force
# Files unzipped from a download carry the internet mark, and a RemoteSigned policy would block the helper
Unblock-File -LiteralPath $hostPs1
$bat = "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0ssoda-host.ps1`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $Dest 'ssoda-host.bat'), $bat, (New-Object System.Text.ASCIIEncoding))
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Ssoda - runs curl.exe for the browser extension'
  path            = 'ssoda-host.bat'
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
}
$manifestPath = Join-Path $Dest "$HostName.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
foreach ($b in $Browsers) {
  # This key belongs to the helper alone, so recreating it with -Force is safe
  $key = "HKLM:\$b\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
  Write-Host "Registered: $key -> $manifestPath"
}
Write-Host "Done: $Dest"
