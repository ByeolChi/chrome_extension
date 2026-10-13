# Ssoda - native messaging host for Windows (Windows PowerShell 5.1+ / PowerShell 7)
# Chrome starts this script through ssoda-host.bat and talks to it over stdin/stdout
# (4-byte length prefix + UTF-8 JSON). It runs curl.exe with the argument list sent by the
# extension (no shell involved) and returns status, headers, body and terminal output.
# With an "ssh" block it first opens an SSH tunnel (ssh.exe -D, SOCKS5 on 127.0.0.1) to the
# given server, so curl runs through that server. The password is handed to ssh.exe through
# SSH_ASKPASS from a temporary file that is deleted as soon as the tunnel is up.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$HostVersion = '1.3.1'
$script:stdin = [Console]::OpenStandardInput()
$script:stdout = [Console]::OpenStandardOutput()
$script:utf8 = New-Object System.Text.UTF8Encoding($false)
$script:work = Join-Path ([IO.Path]::GetTempPath()) ('ssoda-' + [guid]::NewGuid().ToString('N'))
$script:knownHosts = Join-Path $env:LOCALAPPDATA 'Ssoda\known_hosts'
$script:stdinTask = $null

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
  if ($custom) {
    if ($custom -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFileName($custom) -ne 'curl.exe') {
      throw 'The curl path must be a local path to curl.exe (for example C:\Tools\curl\bin\curl.exe).'
    }
    if (Test-Path -LiteralPath $custom -PathType Leaf) { return $custom }
  }
  if ($env:SystemRoot) {
    $sys = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $sys -PathType Leaf) { return $sys }
  }
  $c = Get-Command -Name 'curl.exe', 'curl' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path }
  return $null
}

function Find-Ssh {
  if ($env:SystemRoot) {
    foreach ($rel in @('Sysnative\OpenSSH\ssh.exe', 'System32\OpenSSH\ssh.exe')) {
      $p = Join-Path $env:SystemRoot $rel
      if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
  }
  $c = Get-Command -Name 'ssh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path }
  return $null
}

function Get-FreePort {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start()
  $port = $l.LocalEndpoint.Port
  $l.Stop()
  return $port
}

function Test-LocalPort([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(300)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

# Validate the server settings sent by the extension (never let them become ssh options)
function Get-SshTarget($cfg) {
  $h = ([string]$cfg.host).Trim().Trim('[', ']')
  $u = ([string]$cfg.user).Trim()
  $port = 22
  if ($cfg.port) { $port = [int]$cfg.port }
  if ($h -notmatch '^[A-Za-z0-9._:%-]{1,253}$' -or $h.StartsWith('-')) { throw 'invalid SSH host' }
  if ($u -eq '' -or $u.StartsWith('-') -or $u -match '[\s"]') { throw 'invalid SSH user' }
  if ($port -lt 1 -or $port -gt 65535) { throw 'invalid SSH port' }
  $key = $h
  if ($port -ne 22) { $key = '[' + $h + ']:' + $port }
  return @{ Host = $h; User = $u; Port = $port; Key = $key }
}

# Open an SSH tunnel with a SOCKS5 proxy on 127.0.0.1:<free port>.
# Returns @{ Ok = $true; Port; Proc; ErrTask; Ssh; Target; Ms } or @{ Ok = $false; Exit; Err; Ssh }
function Start-SshTunnel($cfg) {
  $ssh = Find-Ssh
  if (-not $ssh) { throw 'ssh.exe not found. Windows 10 (1809+) and Windows 11 include the OpenSSH client (Settings > Optional features > OpenSSH Client).' }
  $t = Get-SshTarget $cfg
  New-Item -ItemType Directory -Path (Split-Path -Parent $script:knownHosts) -Force | Out-Null
  $pw = Join-Path $script:work 'SSH_PW'
  [IO.File]::WriteAllText($pw, [string]$cfg.password, $script:utf8)
  $askpass = Join-Path $script:work 'askpass.cmd'
  [IO.File]::WriteAllText($askpass, "@type `"%~dp0SSH_PW`"`r`n", (New-Object System.Text.ASCIIEncoding))
  # Empty config file: the user's ~/.ssh/config must not change how the tunnel is opened
  $conf = Join-Path $script:work 'ssh_config'
  [IO.File]::WriteAllText($conf, '', (New-Object System.Text.ASCIIEncoding))
  $port = Get-FreePort
  $argv = @(
    '-F', $conf, '-N', '-T', '-D', ('127.0.0.1:' + $port), '-p', [string]$t.Port, '-l', $t.User,
    '-o', 'StrictHostKeyChecking=yes', '-o', ('UserKnownHostsFile=' + $script:knownHosts),
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no', '-o', 'GSSAPIAuthentication=no',
    '-o', 'PreferredAuthentications=keyboard-interactive,password')
  if ($cfg.legacy) {
    # Old servers (OpenSSH < 7.2) only offer SHA-1 'ssh-rsa' host keys; enabled per environment by the user
    $argv += @('-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1')
  }
  $argv += $t.Host
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ssh
  $psi.Arguments = (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardErrorEncoding = $script:utf8
  $psi.EnvironmentVariables['SSH_ASKPASS'] = $askpass
  $psi.EnvironmentVariables['SSH_ASKPASS_REQUIRE'] = 'force'
  $psi.EnvironmentVariables['DISPLAY'] = 'localhost:0'
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $p.StandardInput.Close()
  [void]$p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  while ($sw.ElapsedMilliseconds -lt 25000) {
    if ($p.HasExited) { break }
    if ($script:stdinTask -and $script:stdinTask.IsCompleted) { break }
    if (Test-LocalPort $port) { $ready = $true; break }
    Start-Sleep -Milliseconds 100
  }
  Remove-Item -LiteralPath $pw -Force -ErrorAction SilentlyContinue
  if (-not $ready) {
    if (-not $p.HasExited) { try { $p.Kill() } catch { } }
    $p.WaitForExit()
    $err = [string]$errTask.Result
    if (-not $err.Trim() -and $sw.ElapsedMilliseconds -ge 25000) { $err = 'ssh: connection timed out' }
    return @{ Ok = $false; Exit = $p.ExitCode; Err = $err; Ssh = $ssh }
  }
  return @{ Ok = $true; Port = $port; Proc = $p; ErrTask = $errTask; Ssh = $ssh; Target = $t; Ms = [int]$sw.ElapsedMilliseconds }
}

function Stop-SshTunnel($tun) {
  if (-not $tun -or -not $tun.Proc) { return '' }
  if (-not $tun.Proc.HasExited) { try { $tun.Proc.Kill() } catch { } }
  [void]$tun.Proc.WaitForExit(3000)
  try { return [string]$tun.ErrTask.Result } catch { return '' }
}

function Get-HostFingerprint($t, [string]$ssh) {
  try {
    $kg = Join-Path (Split-Path -Parent $ssh) 'ssh-keygen.exe'
    if (-not (Test-Path -LiteralPath $kg -PathType Leaf) -or -not (Test-Path -LiteralPath $script:knownHosts)) { return '' }
    $lines = & $kg -l -F $t.Key -f $script:knownHosts 2>$null
    return (@($lines | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $_.Trim() }) -join "`n")
  } catch { return '' }
}

# Options that change where curl connects (they would bypass the SSH tunnel)
function Assert-NoRoutingArgs($argv) {
  $long = @('--proxy', '--preproxy', '--noproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--proxytunnel',
    '--unix-socket', '--abstract-unix-socket', '--config', '--doh-url', '--disable', '--next')
  foreach ($a in $argv) {
    $s = [string]$a
    $name = $s.Split('=')[0]
    if ($long -contains $name) { throw ('option not allowed with an SSH tunnel: ' + $name) }
    if ($s -match '^-[A-Za-z0-9#:]+$' -and -not $s.StartsWith('--') -and $s -cmatch '[xpKq]') { throw ('option not allowed with an SSH tunnel: ' + $s) }
  }
}

function Find-SshTool([string]$name) {
  $ssh = Find-Ssh
  if (-not $ssh) { throw 'ssh.exe not found.' }
  $p = Join-Path (Split-Path -Parent $ssh) $name
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ($name + ' not found next to ssh.exe.') }
  return $p
}

# Fetch the server's host keys (not trusted yet) so the user can compare the fingerprint
function Get-SshHostKeys($cfg) {
  $t = Get-SshTarget $cfg
  $scan = Find-SshTool 'ssh-keyscan.exe'
  $r = Invoke-Curl $scan @('-p', [string]$t.Port, '-T', '8', $t.Host) 20000
  $keys = @(([string]$r.Out) -split "`r?`n" | Where-Object { Test-HostKeyLine $_ $t })
  $fp = ''
  if ($keys.Count) {
    $f = Join-Path $script:work 'SCAN'
    [IO.File]::WriteAllLines($f, [string[]]$keys, (New-Object System.Text.ASCIIEncoding))
    $kg = Find-SshTool 'ssh-keygen.exe'
    $fp = ((& $kg -l -f $f 2>$null) | ForEach-Object { $_.Trim() }) -join "`n"
  }
  return @{ Keys = ($keys -join "`n"); Fingerprints = $fp; Err = [string]$r.Err }
}

function Test-HostKeyLine([string]$line, $t) {
  $parts = $line.Trim() -split ' '
  if ($parts.Count -ne 3) { return $false }
  if ($parts[0] -ne $t.Key) { return $false }
  if ($parts[1] -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$') { return $false }
  return ($parts[2] -match '^[A-Za-z0-9+/]+={0,3}$')
}

# Save host keys the user has confirmed
function Add-TrustedHostKeys($cfg, [string]$keys) {
  $t = Get-SshTarget $cfg
  $lines = @($keys -split "`r?`n" | Where-Object { $_.Trim() })
  foreach ($l in $lines) { if (-not (Test-HostKeyLine $l $t)) { throw 'invalid host key line' } }
  if (-not $lines.Count) { throw 'no host keys' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $script:knownHosts) -Force | Out-Null
  [IO.File]::AppendAllText($script:knownHosts, (($lines | ForEach-Object { $_.Trim() }) -join "`n") + "`n", (New-Object System.Text.ASCIIEncoding))
  return $lines.Count
}

function Send-SshError($res) {
  Send-Json ('{"type":"sshError","exitCode":' + [int]$res.Exit + ',"messageB64":"' + (To-B64Text $res.Err) + '","pathB64":"' + (To-B64Text $res.Ssh) + '"}')
}

# Remove a server's saved host key (after the server key was legitimately changed)
function Forget-SshHost($cfg) {
  $t = Get-SshTarget $cfg
  if (-not (Test-Path -LiteralPath $script:knownHosts)) { return 0 }
  $names = @($t.Key, $t.Host)
  $kept = New-Object 'System.Collections.Generic.List[string]'
  $removed = 0
  foreach ($line in [IO.File]::ReadAllLines($script:knownHosts)) {
    $hit = $false
    foreach ($n in ((($line.Trim() -split '\s+')[0]) -split ',')) { if ($names -contains $n) { $hit = $true } }
    if ($hit) { $removed++ } else { $kept.Add($line) }
  }
  [IO.File]::WriteAllLines($script:knownHosts, $kept.ToArray(), (New-Object System.Text.ASCIIEncoding))
  return $removed
}

function Invoke-Curl([string]$curl, [string[]]$argv, [int]$timeoutMs, [bool]$noProxyEnv = $false) {
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
  if ($noProxyEnv) {
    # Proxy variables (NO_PROXY in particular) would let a request skip the SSH tunnel
    foreach ($k in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME')) {
      if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) }
    }
  }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $p.StandardInput.Close()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timedOut = $false
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not $p.WaitForExit(100)) {
    if ($timeoutMs -gt 0 -and $sw.ElapsedMilliseconds -ge $timeoutMs) {
      $timedOut = $true
      try { $p.Kill() } catch { }
      break
    }
    # The extension closed the connection (request cancelled)
    if ($script:stdinTask -and $script:stdinTask.IsCompleted) {
      try { $p.Kill() } catch { }
      break
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
  $tun = $null
  $sshLog = ''
  if ($msg.ssh) {
    Assert-NoRoutingArgs $argv
    $tun = Start-SshTunnel $msg.ssh
    if (-not $tun.Ok) {
      Send-SshError $tun
      return
    }
    $argv.Insert(0, '')
    $argv.Insert(0, '--noproxy')
    $argv.Insert(0, ('127.0.0.1:' + $tun.Port))
    $argv.Insert(0, '--socks5-hostname')
    # -q must be first: ignore _curlrc / .curlrc, which could set a proxy or noproxy
    $argv.Insert(0, '-q')
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-Curl $curl $argv.ToArray() $timeoutMs ($null -ne $tun)
  } finally {
    if ($tun) { $sshLog = Stop-SshTunnel $tun }
  }
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
    '","pathB64":"' + (To-B64Text $curl) + '"'
  if ($tun) {
    $meta += ',"ssh":{"port":' + $tun.Port + ',"connectMs":' + $tun.Ms + ',"logB64":"' + (To-B64Text $sshLog) +
      '","pathB64":"' + (To-B64Text $tun.Ssh) + '"}'
  }
  $meta += '}'
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
      $ssh = Find-Ssh
      $sshVer = ''
      if ($ssh) {
        $sr = Invoke-Curl $ssh @('-V') 15000
        $sshVer = (([string]$sr.Err + [string]$sr.Out) -split "`n")[0].Trim()
      }
      Send-Json ('{"type":"pong","hostVersion":"' + $HostVersion + '","platform":"windows","curlB64":"' + (To-B64Text $ver) + '","pathB64":"' + (To-B64Text $curl) +
        '","sshB64":"' + (To-B64Text $sshVer) + '","sshPathB64":"' + (To-B64Text $ssh) + '"}')
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
      $script:stdinTask = $script:stdin.ReadAsync((New-Object byte[] 1), 0, 1)
      Run-Request $msg
      $done = $true
    }
    elseif ($type -eq 'sshTest') {
      $script:stdinTask = $script:stdin.ReadAsync((New-Object byte[] 1), 0, 1)
      $tun = Start-SshTunnel $msg.ssh
      if (-not $tun.Ok) { Send-SshError $tun }
      else {
        $log = Stop-SshTunnel $tun
        $fp = Get-HostFingerprint $tun.Target $tun.Ssh
        Send-Json ('{"type":"sshOk","connectMs":' + $tun.Ms + ',"logB64":"' + (To-B64Text $log) + '","fingerprintB64":"' + (To-B64Text $fp) + '","pathB64":"' + (To-B64Text $tun.Ssh) + '"}')
      }
      $done = $true
    }
    elseif ($type -eq 'sshScan') {
      $k = Get-SshHostKeys $msg.ssh
      Send-Json ('{"type":"sshScanned","keysB64":"' + (To-B64Text $k.Keys) + '","fingerprintsB64":"' + (To-B64Text $k.Fingerprints) + '","errB64":"' + (To-B64Text $k.Err) + '"}')
      $done = $true
    }
    elseif ($type -eq 'sshTrust') {
      $n = Add-TrustedHostKeys $msg.ssh ([string]$msg.keys)
      Send-Json ('{"type":"sshTrusted","added":' + [int]$n + '}')
      $done = $true
    }
    elseif ($type -eq 'sshForget') {
      $n = Forget-SshHost $msg.ssh
      Send-Json ('{"type":"sshForgot","removed":' + [int]$n + '}')
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
