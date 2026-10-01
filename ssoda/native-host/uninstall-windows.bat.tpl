<# :
@echo off
setlocal
title Ssoda helper uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; Invoke-Expression ([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8))"
echo.
pause
exit /b
#>
# ---- Ssoda: cURL 실행 도우미 제거 (Windows) ----
$HostName = 'com.ssoda.runner'
$Dir = Join-Path $env:LOCALAPPDATA 'Ssoda'
$keys = @('Software\Google\Chrome', 'Software\Microsoft\Edge', 'Software\Naver\Whale', 'Software\BraveSoftware\Brave-Browser', 'Software\Chromium')
foreach ($k in $keys) {
  foreach ($h in @($HostName, 'com.curlstudio.runner')) {
    $key = 'HKCU:\' + $k + '\NativeMessagingHosts\' + $h
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
foreach ($d in @($Dir, (Join-Path $env:LOCALAPPDATA 'cURLStudio'))) {
  if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host ''
Write-Host '  Ssoda 의 cURL 실행 도우미를 제거했습니다.' -ForegroundColor Green
