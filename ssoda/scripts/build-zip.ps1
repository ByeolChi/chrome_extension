# Ssoda 배포 zip 만들기
# 사용법 (프로젝트 폴더에서):
#   pwsh scripts/build-zip.ps1               # 현재 버전으로 zip 생성
#   pwsh scripts/build-zip.ps1 -Bump patch   # 1.3.2 -> 1.3.3 으로 올린 뒤 zip 생성 (minor / major 도 가능)
# 결과: dist/ssoda-v<버전>.zip  (zip 안 최상위에 manifest.json 이 바로 있음)
# Windows PowerShell 5.1 에서도 동작합니다.

param(
  [ValidateSet('none', 'patch', 'minor', 'major')]
  [string]$Bump = 'none'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 배포에 넣을 파일·폴더 (허용 목록 방식: 여기 없는 건 절대 들어가지 않음)
$include = @('manifest.json', 'app.html', 'background.js', 'css', 'icons', 'js', 'native-host', 'README.md', 'EDGE.md')

# 1. manifest 확인
$text = [IO.File]::ReadAllText($manifestPath, $utf8)
$manifest = $text | ConvertFrom-Json
if (-not $manifest.key) {
  throw 'manifest.json 에 "key" 가 없습니다. 확장 ID가 폴더 경로에 따라 바뀌므로 배포를 중단합니다.'
}

# 2. 버전 올리기 (선택)
$version = $manifest.version
if ($Bump -ne 'none') {
  $p = $version.Split('.') | ForEach-Object { [int]$_ }
  while ($p.Count -lt 3) { $p += 0 }
  switch ($Bump) {
    'major' { $p[0]++; $p[1] = 0; $p[2] = 0 }
    'minor' { $p[1]++; $p[2] = 0 }
    'patch' { $p[2]++ }
  }
  $newVersion = ($p[0..2]) -join '.'
  $pattern = '("version"\s*:\s*")' + [regex]::Escape($version) + '"'
  $text = [regex]::Replace($text, $pattern, ('${1}' + $newVersion + '"'), 1)
  [IO.File]::WriteAllText($manifestPath, $text, $utf8)
  Write-Host "버전: $version -> $newVersion"
  $version = $newVersion
}

# 3. 파일 모으기 + 안전 검사
$files = foreach ($item in $include) {
  $path = Join-Path $root $item
  if (-not (Test-Path $path)) { throw "필수 항목이 없습니다: $item" }
  if (Test-Path $path -PathType Container) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
}
$blocked = $files | Where-Object { $_.Extension -in @('.pem', '.crx', '.key') }
if ($blocked) {
  throw ('개인키/패키지 파일이 포함되어 있습니다. 제거 후 다시 실행하세요: ' + ($blocked.FullName -join ', '))
}

# 4. zip 생성
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist "ssoda-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in $files) {
    # zip 안 경로는 / 구분자 사용 (\ 를 쓰면 일부 압축 도구에서 폴더가 깨짐)
    $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "완료: dist/ssoda-v$version.zip ($($files.Count)개 파일, $size KB)"
