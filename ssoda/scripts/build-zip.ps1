# Ssoda 배포 zip 만들기 → 저장소 공용 스크립트(../../scripts/build-zip.ps1)를 부른다
# 사용법 (ssoda 폴더에서):
#   pwsh scripts/build-zip.ps1               # 현재 버전으로 zip 생성
#   pwsh scripts/build-zip.ps1 -Bump patch   # 1.3.4 -> 1.3.5 로 올린 뒤 zip 생성 (minor / major 도 가능)
# 결과: dist/ssoda-v<버전>.zip  (zip 안 최상위에 manifest.json 이 바로 있음)
# Windows PowerShell 5.1 에서도 동작합니다.

param(
  [ValidateSet('none', 'patch', 'minor', 'major')]
  [string]$Bump = 'none'
)

$ErrorActionPreference = 'Stop'
$shared = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\build-zip.ps1'
& $shared -Extension ssoda -Bump $Bump
