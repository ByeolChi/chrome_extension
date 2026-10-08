<# :
@echo off
setlocal
title Ssoda helper installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; Invoke-Expression ([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8))"
echo.
pause
exit /b
#>
# ---- Ssoda: cURL 실행 도우미 설치 (Windows) ----
# 이 파일은 Ssoda 확장 프로그램에서 생성되었습니다. 관리자 권한이 필요 없습니다.
# 설치 위치: %LOCALAPPDATA%\Ssoda\helper
# 등록 위치: HKCU\Software\<브라우저>\NativeMessagingHosts\com.ssoda.runner
$ErrorActionPreference = 'Stop'
$ExtId = '__CS_EXT_ID__'
$HostName = 'com.ssoda.runner'
$Dir = Join-Path $env:LOCALAPPDATA 'Ssoda\helper'
Write-Host ''
Write-Host '  Ssoda - cURL 실행 도우미 설치' -ForegroundColor Cyan
Write-Host '  ----------------------------------------'
try {
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $hostPs1 = @'
__CS_HOST_SCRIPT__
'@
  [IO.File]::WriteAllText((Join-Path $Dir 'ssoda-host.ps1'), $hostPs1, $utf8)
  $bat = "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0ssoda-host.ps1`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $Dir 'ssoda-host.bat'), $bat, (New-Object System.Text.ASCIIEncoding))
  $manifest = [ordered]@{
    name            = $HostName
    description     = 'Ssoda - runs curl.exe for the browser extension'
    path            = 'ssoda-host.bat'
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
  }
  $manifestPath = Join-Path $Dir "$HostName.json"
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)
  $browsers = [ordered]@{
    'Google Chrome'  = 'Software\Google\Chrome'
    'Microsoft Edge' = 'Software\Microsoft\Edge'
    'Naver Whale'    = 'Software\Naver\Whale'
    'Brave'          = 'Software\BraveSoftware\Brave-Browser'
    'Chromium'       = 'Software\Chromium'
  }
  foreach ($b in $browsers.Keys) {
    $key = 'HKCU:\' + $browsers[$b] + '\NativeMessagingHosts\' + $HostName
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
  }
  # 이전 이름(cURL Studio)으로 설치된 도우미 정리
  foreach ($b in $browsers.Keys) {
    $old = 'HKCU:\' + $browsers[$b] + '\NativeMessagingHosts\com.curlstudio.runner'
    if (Test-Path $old) { Remove-Item -Path $old -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $oldDir = Join-Path $env:LOCALAPPDATA 'cURLStudio'
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host ('  설치 폴더 : ' + $Dir)
  Write-Host ('  확장 ID   : ' + $ExtId)
  $curl = $null
  $sys = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path -LiteralPath $sys) { $curl = $sys }
  else {
    $c = Get-Command -Name 'curl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $curl = $c.Path }
  }
  if ($curl) {
    $ver = (& $curl --version 2>$null | Select-Object -First 1)
    Write-Host ('  curl      : ' + $ver) -ForegroundColor Gray
  } else {
    Write-Host '  [주의] curl.exe 를 찾지 못했습니다. Windows 10(1803 이상)/11 에는 기본 포함되어 있습니다.' -ForegroundColor Yellow
    Write-Host '         다른 위치에 설치했다면 Ssoda 설정에서 curl 경로를 지정하세요.' -ForegroundColor Yellow
  }
  $ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
  if (-not (Test-Path -LiteralPath $ssh)) {
    $c = Get-Command -Name 'ssh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $ssh = if ($c) { $c.Path } else { $null }
  }
  if ($ssh) {
    # ssh -V 는 stderr 로 출력하므로 이 부분만 오류로 취급하지 않음
    $sv = ''
    try {
      $ErrorActionPreference = 'Continue'
      $sv = (& $ssh -V 2>&1 | Select-Object -First 1 | ForEach-Object { "$_" })
    } catch { } finally { $ErrorActionPreference = 'Stop' }
    Write-Host ('  ssh       : ' + $sv) -ForegroundColor Gray
  } else {
    Write-Host '  [참고] ssh.exe 가 없어 SSH 터널 기능은 사용할 수 없습니다.' -ForegroundColor Yellow
    Write-Host '         설정 > 시스템 > 선택적 기능 > "OpenSSH 클라이언트" 를 추가하면 사용할 수 있습니다.' -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '  설치가 완료되었습니다. Ssoda 에서 [연결 확인] 을 눌러 주세요.' -ForegroundColor Green
  Write-Host '  (브라우저를 다시 시작할 필요는 없습니다)'
}
catch {
  Write-Host ''
  Write-Host ('  설치 실패: ' + $_.Exception.Message) -ForegroundColor Red
}
