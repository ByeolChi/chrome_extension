# Ssoda - native messaging host for Windows (Windows PowerShell 5.1+ / PowerShell 7)
# Chrome starts this script through ssoda-host.bat and talks to it over stdin/stdout
# (4-byte length prefix + UTF-8 JSON). It runs curl.exe with the argument list sent by the
# extension (no shell involved) and returns status, headers, body and terminal output.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$HostVersion = '1.1.0'
$script:stdin = [Console]::OpenStandardInput()
$script:stdout = [Console]::OpenStandardOutput()
$script:utf8 = New-Object System.Text.UTF8Encoding($false)
$script:work = Join-Path ([IO.Path]::GetTempPath()) ('ssoda-' + [guid]::NewGuid().ToString('N'))

function Read-Exact([int]$count) {
  $buf = New-Object byte[] $count
  $off = 0
  while ($off -lt $count) {
    $n = $script:stdin.Read($buf, $off, $count - $off)
    if ($n -le 0) { return $null }
    $off += $n
  }
  return ,$buf
}

function Read-Message {
  $lb = Read-Exact 4
  if ($null -eq $lb) { return $null }
  $len = [BitConverter]::ToInt32($lb, 0)
  if ($len -le 0) { return $null }
  $body = Read-Exact $len
  if ($null -eq $body) { return $null }
  return (ConvertFrom-Json -InputObject ($script:utf8.GetString($body)))
}

function Send-Json([string]$json) {
  $bytes = $script:utf8.GetBytes($json)
  $script:stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $script:stdout.Write($bytes, 0, $bytes.Length)
  $script:stdout.Flush()
}

function To-B64Text([string]$s) {
  if ($null -eq $s) { $s = '' }
  return [Convert]::ToBase64String($script:utf8.GetBytes($s))
}

function To-B64Bytes($b, [int]$max) {
  if ($null -eq $b -or $b.Length -eq 0) { return '' }
  $n = [Math]::Min($b.Length, $max)
  return [Convert]::ToBase64String($b, 0, $n)
}

# Quote one argument using the MSVCRT / CommandLineToArgvW rules that curl.exe uses
function Quote-Arg([string]$s) {
  if ($s.Length -gt 0 -and $s -notmatch '[\s"]') { return $s }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') {
      [void]$sb.Append('\' * ($bs * 2 + 1))
      [void]$sb.Append('"')
      $bs = 0
      continue
    }
    if ($bs -gt 0) { [void]$sb.Append('\' * $bs); $bs = 0 }
    [void]$sb.Append($ch)
  }
  if ($bs -gt 0) { [void]$sb.Append('\' * ($bs * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Find-Curl([string]$custom) {
  if ($custom -and (Test-Path -LiteralPath $custom -PathType Leaf)) { return $custom }
  if ($env:SystemRoot) {
    $sys = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $sys -PathType Leaf) { return $sys }
  }
  $c = Get-Command -Name 'curl.exe', 'curl' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path }
  return $null
}

function Invoke-Curl([string]$curl, [string[]]$argv, [int]$timeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $curl
  $psi.Arguments = (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $script:utf8
  $psi.StandardErrorEncoding = $script:utf8
  if (Test-Path -LiteralPath $script:work) { $psi.WorkingDirectory = $script:work }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $p.StandardInput.Close()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timedOut = $false
  if ($timeoutMs -gt 0) {
    if (-not $p.WaitForExit($timeoutMs)) {
      $timedOut = $true
      try { $p.Kill() } catch { }
    }
  }
  $p.WaitForExit()
  return @{ Exit = $p.ExitCode; Out = $outTask.Result; Err = $errTask.Result; TimedOut = $timedOut }
}

function Run-Request($msg) {
  $curl = Find-Curl ([string]$msg.curlPath)
  if (-not $curl) {
    throw 'curl.exe not found. Windows 10 (1803+) and Windows 11 include curl.exe. Otherwise set the curl path in Ssoda settings.'
  }
  $hdr = Join-Path $script:work 'CS_HDR'
  $bodyPath = Join-Path $script:work 'CS_BODY'
  $map = @{ '__CS_HDR__' = $hdr; '__CS_BODY__' = $bodyPath }
  foreach ($f in @($msg.files)) {
    if ($f) {
      $n = [string]$f
      if ($n -notmatch '^[A-Za-z0-9_]{1,40}$') { throw 'invalid file name' }
      $map['__CS_' + $n + '__'] = (Join-Path $script:work $n)
    }
  }
  $argv = New-Object 'System.Collections.Generic.List[string]'
  foreach ($a in @($msg.args)) {
    $s = [string]$a
    foreach ($k in $map.Keys) { $s = $s.Replace($k, $map[$k]) }
    $argv.Add($s)
  }
  $timeoutMs = 0
  if ($msg.timeoutMs) { $timeoutMs = [int]$msg.timeoutMs }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Curl $curl $argv.ToArray() $timeoutMs
  $sw.Stop()
  $hdrBytes = $null
  if (Test-Path -LiteralPath $hdr) { $hdrBytes = [IO.File]::ReadAllBytes($hdr) }
  $bodyBytes = New-Object byte[] 0
  if (Test-Path -LiteralPath $bodyPath) { $bodyBytes = [IO.File]::ReadAllBytes($bodyPath) }
  $err = [string]$r.Err
  if ($err.Length -gt 300000) { $err = $err.Substring($err.Length - 300000) }
  $out = [string]$r.Out
  if ($out.Length -gt 60000) { $out = $out.Substring(0, 60000) }
  $meta = '{"type":"result","exitCode":' + [int]$r.Exit +
    ',"timedOut":' + ([string]$r.TimedOut).ToLower() +
    ',"elapsedMs":' + [int]$sw.ElapsedMilliseconds +
    ',"bodySize":' + $bodyBytes.Length +
    ',"stdoutB64":"' + (To-B64Text $out) +
    '","stderrB64":"' + (To-B64Text $err) +
    '","headersB64":"' + (To-B64Bytes $hdrBytes 262144) +
    '","pathB64":"' + (To-B64Text $curl) + '"}'
  Send-Json $meta
  $chunk = 524288
  for ($off = 0; $off -lt $bodyBytes.Length; $off += $chunk) {
    $n = [Math]::Min($chunk, $bodyBytes.Length - $off)
    Send-Json ('{"type":"body","data":"' + [Convert]::ToBase64String($bodyBytes, $off, $n) + '"}')
  }
  Send-Json '{"type":"end"}'
}

$done = $false
try {
  New-Item -ItemType Directory -Path $script:work -Force | Out-Null
  while (-not $done) {
    $msg = Read-Message
    if ($null -eq $msg) { break }
    $type = [string]$msg.type
    if ($type -eq 'ping') {
      $curl = Find-Curl ([string]$msg.curlPath)
      $ver = ''
      if ($curl) {
        $r = Invoke-Curl $curl @('--version') 15000
        $ver = (([string]$r.Out) -split "`n")[0].Trim()
      }
      Send-Json ('{"type":"pong","hostVersion":"' + $HostVersion + '","platform":"windows","curlB64":"' + (To-B64Text $ver) + '","pathB64":"' + (To-B64Text $curl) + '"}')
      $done = $true
    }
    elseif ($type -eq 'file') {
      $name = [string]$msg.name
      if ($name -notmatch '^[A-Za-z0-9_]{1,40}$') { throw 'invalid file name' }
      $bytes = [Convert]::FromBase64String([string]$msg.data)
      $fs = [IO.File]::Open((Join-Path $script:work $name), [IO.FileMode]::Append, [IO.FileAccess]::Write)
      try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
    }
    elseif ($type -eq 'run') {
      Run-Request $msg
      $done = $true
    }
  }
}
catch {
  try { Send-Json ('{"type":"error","messageB64":"' + (To-B64Text $_.Exception.Message) + '"}') } catch { }
}
finally {
  try { Remove-Item -LiteralPath $script:work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
