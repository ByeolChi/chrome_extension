# 확장 프로그램 배포 zip 만들기 (모든 확장 공용)
# 사용법 (저장소 최상위 폴더에서):
#   pwsh scripts/build-zip.ps1 -Extension ssoda               # 현재 버전으로 zip 생성
#   pwsh scripts/build-zip.ps1 -Extension ssoda -Bump patch   # 1.3.4 -> 1.3.5 로 올린 뒤 zip 생성 (minor / major 도 가능)
#   pwsh scripts/build-zip.ps1 -Extension cleanshot-picker -AllowNoKey   # manifest 에 key 가 없는 확장
# 결과: <확장 폴더>/dist/<확장 폴더>-v<버전>.zip  (zip 안 최상위에 manifest.json 이 바로 있음)
# 검사:
#   - 허용 목록에 있는 파일만 넣는다 (개인키·패키지 파일이 섞이면 중단)
#   - manifest 가 가리키는 파일(서비스 워커, 팝업, 아이콘, content script, 언어 파일)이 zip 에 모두 들어가는지
#   - manifest 의 key(확장 ID 고정)가 있는지. 없으면 폴더를 옮길 때 ID 와 저장 데이터가 바뀌므로 -AllowNoKey 가 있어야 진행
#   - 저장소 README.md 표의 버전이 manifest 와 같은지 (-Bump 하면 함께 고친다)
# Windows PowerShell 5.1 에서도 동작합니다.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ssoda', 'click-guide', 'cleanshot-picker', 'jira-weekly-report')]
  [string]$Extension,
  [ValidateSet('none', 'patch', 'minor', 'major')]
  [string]$Bump = 'none',
  [switch]$AllowNoKey,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repo $Extension
$manifestPath = Join-Path $root 'manifest.json'
$readmePath = Join-Path $repo 'README.md'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 배포에 넣을 파일·폴더 (허용 목록 방식: 여기 없는 건 절대 들어가지 않음)
$includes = @{
  'ssoda'              = @('manifest.json', 'app.html', 'background.js', 'css', 'icons', 'js', 'native-host', 'README.md', 'EDGE.md')
  'click-guide'        = @('manifest.json', '_locales', 'icons', 'src', 'README.md', 'LICENSE')
  'cleanshot-picker'   = @('manifest.json', 'background.js', 'picker.js', 'icons', 'README.md')
  'jira-weekly-report' = @('manifest.json', 'popup.html', 'popup.js', 'options.html', 'options.js', 'ui.css', 'src', 'icons', 'README.md')
}
$include = $includes[$Extension]

# 1. manifest 확인
$text = [IO.File]::ReadAllText($manifestPath, $utf8)
$manifest = $text | ConvertFrom-Json
if (-not $manifest.key) {
  if (-not $AllowNoKey) {
    throw ('manifest.json 에 "key" 가 없습니다. 확장 ID가 설치 폴더 경로에 따라 바뀌어, 폴더를 옮기거나 다른 PC에 설치하면 저장된 데이터가 보이지 않습니다. ' +
      '그래도 만들려면 -AllowNoKey 를 붙이세요.')
  }
  Write-Warning 'manifest.json 에 "key" 가 없습니다. 이 zip 으로 설치하면 설치 폴더마다 확장 ID가 달라집니다.'
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

# 3. 저장소 README 표의 버전 (| [`폴더`](./폴더) | 이름 | 버전 | 설명 |)
if (Test-Path -LiteralPath $readmePath) {
  $readme = [IO.File]::ReadAllText($readmePath, $utf8)
  $rowPattern = '(\|\s*\[`' + [regex]::Escape($Extension) + '`\]\(\./' + [regex]::Escape($Extension) + '\)\s*\|[^|]*\|\s*)([0-9][0-9.]*)(\s*\|)'
  $m = [regex]::Match($readme, $rowPattern)
  if (-not $m.Success) {
    Write-Warning "README.md 표에서 $Extension 줄을 찾지 못했습니다."
  } elseif ($m.Groups[2].Value -ne $version) {
    if ($Bump -ne 'none') {
      $readme = $readme.Substring(0, $m.Groups[2].Index) + $version + $readme.Substring($m.Groups[2].Index + $m.Groups[2].Length)
      [IO.File]::WriteAllText($readmePath, $readme, $utf8)
      Write-Host "README.md 표 버전: $($m.Groups[2].Value) -> $version"
    } else {
      Write-Warning "README.md 표의 버전($($m.Groups[2].Value))이 manifest($version)와 다릅니다."
    }
  }
}

# 4. 파일 모으기 + 안전 검사
$files = foreach ($item in $include) {
  $path = Join-Path $root $item
  if (-not (Test-Path -LiteralPath $path)) { throw "필수 항목이 없습니다: $item" }
  if (Test-Path -LiteralPath $path -PathType Container) { Get-ChildItem -LiteralPath $path -Recurse -File } else { Get-Item -LiteralPath $path }
}
# 실행·편집하다 생긴 캐시 파일은 넣지 않는다 (Python __pycache__, OS 썸네일 등)
$files = @($files | Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -ne '.pyc' -and $_.Name -notin @('Thumbs.db', 'desktop.ini', '.DS_Store') })
$blocked = $files | Where-Object { $_.Extension -in @('.pem', '.crx', '.key', '.zip') }
if ($blocked) {
  throw ('개인키/패키지 파일이 포함되어 있습니다. 제거 후 다시 실행하세요: ' + ($blocked.FullName -join ', '))
}
$entries = @{}
foreach ($f in $files) { $entries[$f.FullName.Substring($root.Length + 1).Replace('\', '/')] = $true }

# manifest 가 가리키는 파일이 모두 들어가는지
$refs = New-Object 'System.Collections.Generic.List[string]'
if ($manifest.background -and $manifest.background.service_worker) { $refs.Add($manifest.background.service_worker) }
if ($manifest.action) {
  if ($manifest.action.default_popup) { $refs.Add($manifest.action.default_popup) }
  if ($manifest.action.default_icon) { $manifest.action.default_icon.PSObject.Properties | ForEach-Object { $refs.Add($_.Value) } }
}
if ($manifest.icons) { $manifest.icons.PSObject.Properties | ForEach-Object { $refs.Add($_.Value) } }
if ($manifest.options_page) { $refs.Add($manifest.options_page) }
if ($manifest.options_ui -and $manifest.options_ui.page) { $refs.Add($manifest.options_ui.page) }
foreach ($cs in @($manifest.content_scripts)) {
  if ($cs) { @($cs.js) + @($cs.css) | Where-Object { $_ } | ForEach-Object { $refs.Add($_) } }
}
if ($manifest.default_locale) { $refs.Add("_locales/$($manifest.default_locale)/messages.json") }
$missing = $refs | ForEach-Object { $_.TrimStart('/') } | Where-Object { -not $entries.ContainsKey($_) } | Select-Object -Unique
if ($missing) { throw ('manifest 가 가리키는 파일이 zip 에 없습니다: ' + ($missing -join ', ')) }

# 5. zip 생성
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$dist = if ($OutDir) { $OutDir } else { Join-Path $root 'dist' }
New-Item -ItemType Directory -Force $dist | Out-Null
$zipName = "$Extension-v$version.zip"
$zipPath = Join-Path $dist $zipName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

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

$size = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)
Write-Host "완료: $zipPath ($($files.Count)개 파일, $size KB)"
