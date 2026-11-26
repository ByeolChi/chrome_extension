# Ssoda - native messaging host for Windows (Windows PowerShell 5.1+ / PowerShell 7)
# Chrome starts this script through ssoda-host.bat and talks to it over stdin/stdout
# (4-byte length prefix + UTF-8 JSON). It runs curl.exe with the argument list sent by the
# extension (no shell involved) and returns status, headers, body and terminal output.
# With an "ssh" block it first opens an SSH tunnel (ssh.exe -D, SOCKS5 on 127.0.0.1) to the
# given server, so curl runs through that server. The password is handed to ssh.exe through
# SSH_ASKPASS from a temporary file that is deleted as soon as the tunnel is up.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.
#
# Two ways to talk:
#  - One request per start (Ssoda 1.x, and the version check): the helper answers one request and exits.
#  - Session (helper 2.0): the first message is {"type":"ping","session":true}. The helper answers with
#    "session":true and keeps running while the Ssoda tab is open. Every message then carries an "id",
#    requests run side by side, {"type":"cancel","id"} stops one, and an SSH tunnel stays open for
#    "keepMs" after its last request, so the next request to the same server uses it again.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$HostVersion = '2.0.0'
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

# ssh arguments for a tunnel with a SOCKS5 proxy on 127.0.0.1:<port> ($t: Get-SshTarget)
function Get-SshArgs($cfg, $t, [string]$conf, [int]$port) {
  # The path is quoted for OpenSSH: unquoted, a space in it (C:\Users\Hong Gildong\...) splits it into two file names,
  # so the trusted key is never found and every request asks to trust the server again.
  $argv = @(
    '-F', $conf, '-N', '-T', '-D', ('127.0.0.1:' + $port), '-p', [string]$t.Port, '-l', $t.User,
    '-o', 'StrictHostKeyChecking=yes', '-o', ('UserKnownHostsFile="' + $script:knownHosts + '"'),
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no', '-o', 'GSSAPIAuthentication=no',
    '-o', 'PreferredAuthentications=keyboard-interactive,password')
  if ($cfg.legacy) {
    # Old servers (OpenSSH < 7.2) only offer SHA-1 'ssh-rsa' host keys; enabled per environment by the user
    $argv += @('-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1')
  }
  $argv += $t.Host
  return ,$argv
}

# ssh.exe with the password handed over through SSH_ASKPASS
function New-SshStartInfo([string]$ssh, [string[]]$argv, [string]$askpass) {
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
  return $psi
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
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = New-SshStartInfo $ssh (Get-SshArgs $cfg $t $conf $port) $askpass
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

# Defense in depth: the extension already passes only allowed curl options. A request must still never make curl
# read or write local files, talk to a local socket, or start a second transfer (--next) that skips --proto.
# Comparisons are case-sensitive on purpose: -o / -O, -k / -K and -c / -C are different curl options.
function Assert-SafeArgs($argv) {
  $deny = @('--next', '-:', '--config', '-K', '--unix-socket', '--abstract-unix-socket', '--variable', '--output', '--dump-header',
    '--trace', '--trace-ascii', '--trace-config', '--stderr', '--libcurl', '--upload-file', '-T', '--cookie-jar', '-c', '--netrc',
    '-n', '--netrc-file', '--netrc-optional', '--etag-save', '--etag-compare', '--hsts', '--alt-svc', '--output-dir', '--create-dirs',
    '--remote-name', '-O', '--remote-name-all', '--remote-header-name', '-J', '--ssl-sessions', '--proto-default', '-q', '--disable')
  $userOpts = @('--user', '-u', '--proxy-user', '-U')
  $prev = ''
  foreach ($a in $argv) {
    $s = [string]$a
    if ($deny -ccontains $s -or $s.StartsWith('--expand-', [StringComparison]::Ordinal)) { throw ('curl option not allowed: ' + $s) }
    # Short option bundles such as -sSo would hide one of the options above
    if ($s -cmatch '^-[A-Za-z0-9#:]{2,}$' -and $s -cmatch '[KTcnOJqo:D]') { throw ('curl option not allowed: ' + $s) }
    if (@('-F', '--form') -ccontains $prev) {
      # name=@file / name=<file: only the temporary files sent by the extension
      $eq = $s.IndexOf('=')
      if ($eq -lt 1 -or $s.Substring($eq + 1) -cnotmatch '^[@<]__CS_[A-Za-z0-9_]{1,40}__(;|$)') { throw 'form fields must use the files sent by the extension' }
    }
    elseif ($s.StartsWith('@', [StringComparison]::Ordinal) -and $s -cnotmatch '^@__CS_[A-Za-z0-9_]{1,40}__$' -and $userOpts -cnotcontains $prev) {
      # -H @file, --proxy-header @file, --data @file ...
      throw ('curl argument must not read a local file: ' + $s)
    }
    if (@('-o', '-D') -ccontains $prev -and $s -cnotmatch '^__CS_(BODY|HDR)__$') { throw ('curl output path not allowed: ' + $s) }
    $prev = $s
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
  Assert-SafeArgs @($msg.args)
  $argv = New-Object 'System.Collections.Generic.List[string]'
  # Only http/https, also after redirects: no file://, and no gopher:// or dict:// to services on this PC
  foreach ($a in @('--proto', '=http,https', '--proto-redir', '=http,https')) { $argv.Add($a) }
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

function Send-Pong($msg, [string]$id, [bool]$session) {
  $curl = $null
  $ver = ''
  if ($session) {
    # A wrong curl path must not stop the session: SSH key checks do not need curl, and each request reports it
    try { $curl = Find-Curl ([string]$msg.curlPath) } catch { $ver = 'error: ' + $_.Exception.Message }
  } else { $curl = Find-Curl ([string]$msg.curlPath) }
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
  $s = '{"type":"pong"'
  if ($id) { $s += ',"id":"' + $id + '"' }
  $s += ',"hostVersion":"' + $HostVersion + '","platform":"windows","curlB64":"' + (To-B64Text $ver) + '","pathB64":"' + (To-B64Text $curl) +
    '","sshB64":"' + (To-B64Text $sshVer) + '","sshPathB64":"' + (To-B64Text $ssh) + '"'
  if ($session) { $s += ',"session":true' }
  Send-Json ($s + '}')
}

# ---------------- one request per start (Ssoda 1.x, version check) ----------------
function Invoke-OneShot($msg) {
  $done = $false
  while (-not $done) {
    $type = [string]$msg.type
    if ($type -eq 'ping') {
      Send-Pong $msg '' $false
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
    if (-not $done) {
      $msg = Read-Message
      if ($null -eq $msg) { break }
    }
  }
}

# ---------------- session (helper 2.0) ----------------
# One thread: the loop waits on stdin, the curl / ssh processes and the port checks, then moves every request on.
$script:jobs = @{}        # request id -> request
$script:tunnels = @{}     # number -> SSH tunnel
$script:seq = 0
$script:keepMs = 600000   # how long an unused tunnel stays open (the extension sends its setting)
$script:failedIds = @{}   # requests whose file upload failed: their "run" is dropped
$script:gone = $false     # the extension stopped reading
$script:rd = @{ Head = [byte[]]::new(4); Buf = $null; Off = 0; Need = 4; Body = $false; Task = $null }
$script:proxyEnv = @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME')

function Test-CsId([string]$id) { return ($id -match '^[A-Za-z0-9_-]{1,40}$') }

function Send-CsReply([string]$id, [string]$type, [string]$fields) {
  $s = '{"type":"' + $type + '","id":"' + $id + '"'
  if ($fields) { $s += ',' + $fields }
  try { Send-Json ($s + '}') } catch { $script:gone = $true }
}

function Get-CsKeep($v) {
  if ($null -eq $v) { return $script:keepMs }
  $n = [int64]0
  try { $n = [int64]$v } catch { return $script:keepMs }
  if ($n -lt 0) { $n = 0 }
  if ($n -gt 86400000) { $n = 86400000 }
  return $n
}

function Start-CsRead {
  $b = $script:rd.Head
  if ($script:rd.Body) { $b = $script:rd.Buf }
  $script:rd.Task = $script:stdin.ReadAsync($b, $script:rd.Off, $script:rd.Need - $script:rd.Off)
}

# $null: nothing yet, 'EOF': the extension closed the connection, otherwise one message
function Get-CsMessage {
  $t = $script:rd.Task
  if (-not $t.IsCompleted) { return $null }
  $n = 0
  try { $n = $t.Result } catch { return 'EOF' }
  if ($n -le 0) { return 'EOF' }
  $script:rd.Off += $n
  if ($script:rd.Off -lt $script:rd.Need) { Start-CsRead; return $null }
  if (-not $script:rd.Body) {
    $len = [BitConverter]::ToInt32($script:rd.Head, 0)
    if ($len -le 0 -or $len -gt 67108864) { return 'EOF' }
    $script:rd.Buf = [byte[]]::new($len)
    $script:rd.Body = $true
    $script:rd.Off = 0
    $script:rd.Need = $len
    Start-CsRead
    return $null
  }
  $text = $script:utf8.GetString($script:rd.Buf)
  $script:rd.Body = $false
  $script:rd.Off = 0
  $script:rd.Need = 4
  $script:rd.Buf = $null
  Start-CsRead
  return (ConvertFrom-Json -InputObject $text)
}

# Start a program without waiting for it (stdout / stderr are read in the background)
function Start-CsProc([string]$file, [string[]]$argv, [string]$dir, [bool]$noProxyEnv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  $psi.Arguments = (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $script:utf8
  $psi.StandardErrorEncoding = $script:utf8
  if ($dir -and (Test-Path -LiteralPath $dir)) { $psi.WorkingDirectory = $dir }
  if ($noProxyEnv) {
    # Proxy variables (NO_PROXY in particular) would let a request skip the SSH tunnel
    foreach ($k in $script:proxyEnv) { if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } }
  }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $p.StandardInput.Close()
  return @{ Proc = $p; Out = $p.StandardOutput.ReadToEndAsync(); Err = $p.StandardError.ReadToEndAsync() }
}

# ---- SSH tunnels kept between requests ----
# Same server, user, password and legacy setting -> same tunnel. The password is kept only as a hash.
function Get-CsTunnelKey($cfg) {
  $t = Get-SshTarget $cfg
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $h = [BitConverter]::ToString($sha.ComputeHash($script:utf8.GetBytes([string]$cfg.password))) } finally { $sha.Dispose() }
  return ($t.User + '@' + $t.Key + '|' + [string][bool]$cfg.legacy + '|' + $h)
}

# The open tunnel to this server (or the one still connecting), otherwise a new one. $fresh: always a new connection.
function Get-CsTunnel($cfg, [bool]$fresh) {
  $key = Get-CsTunnelKey $cfg
  if (-not $fresh) {
    foreach ($t in @($script:tunnels.Values)) {
      if ($t.Key -eq $key -and -not $t.Retired -and ($t.State -eq 'starting' -or ($t.State -eq 'ready' -and -not $t.Proc.HasExited))) { return $t }
    }
  }
  return (New-CsTunnel $cfg $key)
}

function New-CsTunnel($cfg, [string]$key) {
  $ssh = Find-Ssh
  if (-not $ssh) { throw 'ssh.exe not found. Windows 10 (1809+) and Windows 11 include the OpenSSH client (Settings > Optional features > OpenSSH Client).' }
  $tg = Get-SshTarget $cfg
  $script:seq++
  $dir = Join-Path $script:work ('t' + $script:seq)
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $script:knownHosts) -Force | Out-Null
  $pw = Join-Path $dir 'SSH_PW'
  [IO.File]::WriteAllText($pw, [string]$cfg.password, $script:utf8)
  $askpass = Join-Path $dir 'askpass.cmd'
  [IO.File]::WriteAllText($askpass, "@type `"%~dp0SSH_PW`"`r`n", (New-Object System.Text.ASCIIEncoding))
  # Empty config file: the user's ~/.ssh/config must not change how the tunnel is opened
  $conf = Join-Path $dir 'ssh_config'
  [IO.File]::WriteAllText($conf, '', (New-Object System.Text.ASCIIEncoding))
  $port = Get-FreePort
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = New-SshStartInfo $ssh (Get-SshArgs $cfg $tg $conf $port) $askpass
  [void]$p.Start()
  $p.StandardInput.Close()
  $t = @{
    Seq = $script:seq
    Key = $key
    Dir = $dir
    Pw = $pw
    Proc = $p
    Port = $port
    Ssh = $ssh
    Target = $tg
    State = 'starting'
    Sw = [Diagnostics.Stopwatch]::StartNew()
    Ms = 0
    Log = (New-Object System.Text.StringBuilder)
    Dropped = [int64]0
    LineTask = $p.StandardError.ReadLineAsync()
    OutTask = $p.StandardOutput.ReadToEndAsync()
    Probe = $null
    ProbeClient = $null
    ProbeSw = $null
    Users = 0
    Idle = [Diagnostics.Stopwatch]::StartNew()
    KeepMs = $script:keepMs
    Retired = $false
    Exit = 0
    Err = ''
  }
  $script:tunnels[$t.Seq] = $t
  return $t
}

# ssh's messages, line by line (each request gets the lines written while it ran)
function Read-CsTunnelLog($t) {
  while ($t.LineTask -and $t.LineTask.IsCompleted) {
    $line = $null
    try { $line = $t.LineTask.Result } catch { $line = $null }
    if ($null -eq $line) { $t.LineTask = $null; break }
    [void]$t.Log.Append($line).Append("`n")
    if ($t.Log.Length -gt 300000) {
      $cut = $t.Log.Length - 200000
      [void]$t.Log.Remove(0, $cut)
      $t.Dropped += $cut
    }
    $t.LineTask = $t.Proc.StandardError.ReadLineAsync()
  }
}

function Get-CsLogMark($t) { return ($t.Dropped + $t.Log.Length) }

function Get-CsLogSince($t, [int64]$mark) {
  $s = $t.Log.ToString()
  $i = $mark - $t.Dropped
  if ($i -lt 0) { $i = 0 }
  if ($i -ge $s.Length) { return '' }
  return $s.Substring([int]$i)
}

function Set-CsTunnelReady($t) {
  $t.State = 'ready'
  $t.Ms = [int]$t.Sw.ElapsedMilliseconds
  $t.Idle.Restart()
  Remove-Item -LiteralPath $t.Pw -Force -ErrorAction SilentlyContinue
}

function Set-CsTunnelFailed($t, [string]$fallback) {
  if (-not $t.Proc.HasExited) { try { $t.Proc.Kill() } catch { } }
  [void]$t.Proc.WaitForExit(3000)
  for ($i = 0; $i -lt 60 -and $t.LineTask; $i++) {
    try { [void]$t.LineTask.Wait(50) } catch { }
    Read-CsTunnelLog $t
  }
  $t.Err = $t.Log.ToString()
  if (-not $t.Err.Trim() -and $fallback) { $t.Err = $fallback }
  try { $t.Exit = $t.Proc.ExitCode } catch { $t.Exit = -1 }
  $t.State = 'failed'
  if ($t.Probe) { try { $t.ProbeClient.Close() } catch { }; $t.Probe = $null }
  Remove-Item -LiteralPath $t.Pw -Force -ErrorAction SilentlyContinue
}

function Close-CsTunnel($t) {
  if ($t.Proc -and -not $t.Proc.HasExited) {
    try { $t.Proc.Kill() } catch { }
    [void]$t.Proc.WaitForExit(2000)
  }
  if ($t.Probe) { try { $t.ProbeClient.Close() } catch { }; $t.Probe = $null }
  $t.State = 'closed'
  Remove-Item -LiteralPath $t.Dir -Recurse -Force -ErrorAction SilentlyContinue
  $script:tunnels.Remove($t.Seq)
}

# A request is done with the tunnel: when nobody uses it, it closes after keepMs (0: right away)
function Exit-CsTunnel($t, $keepMs) {
  $t.Users -= 1
  if ($t.Users -le 0) {
    $t.Users = 0
    $t.KeepMs = $keepMs
    $t.Idle.Restart()
  }
}

# The SOCKS port opens only after ssh has logged in, so a connection to it means the tunnel is ready
function Update-CsStarting($t) {
  if ($t.Proc.HasExited) { Set-CsTunnelFailed $t ''; return }
  if ($t.Sw.ElapsedMilliseconds -ge 25000) { Set-CsTunnelFailed $t 'ssh: connection timed out'; return }
  if ($t.Probe -and $t.Probe.IsCompleted) {
    $ok = ($t.Probe.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) -and $t.ProbeClient.Connected
    try { $t.ProbeClient.Close() } catch { }
    $t.Probe = $null
    if ($ok) { Set-CsTunnelReady $t; return }
  }
  elseif ($t.Probe -and $t.ProbeSw.ElapsedMilliseconds -ge 150) {
    # Windows reports a closed local port only after retrying for about a second: start another try instead of waiting
    try { $t.ProbeClient.Close() } catch { }
    $t.Probe = $null
  }
  if (-not $t.Probe) {
    $t.ProbeClient = New-Object System.Net.Sockets.TcpClient
    $t.Probe = $t.ProbeClient.ConnectAsync('127.0.0.1', [int]$t.Port)
    $t.ProbeSw = [Diagnostics.Stopwatch]::StartNew()
  }
}

function Update-CsTunnels {
  foreach ($t in @($script:tunnels.Values)) {
    try {
      Read-CsTunnelLog $t
      if ($t.State -eq 'starting') { Update-CsStarting $t }
      elseif ($t.State -eq 'ready') {
        if ($t.Proc.HasExited) { $t.State = 'dead' }
        elseif ($t.Users -le 0 -and ($t.Retired -or $t.Idle.ElapsedMilliseconds -ge $t.KeepMs)) { Close-CsTunnel $t }
      }
      if (($t.State -eq 'failed' -or $t.State -eq 'dead') -and $t.Users -le 0) { Close-CsTunnel $t }
    } catch {
      try { if (-not $t.Proc.HasExited) { $t.Proc.Kill() } } catch { }
      $t.Err = $_.Exception.Message
      $t.State = 'failed'
    }
  }
}

# After "reset host key": the trust is gone, so the tunnels to that server close (busy ones when their request ends)
function Close-CsHostTunnels($cfg) {
  $tg = Get-SshTarget $cfg
  foreach ($t in @($script:tunnels.Values)) {
    if ($t.Target.Key -eq $tg.Key) {
      if ($t.Users -le 0) { Close-CsTunnel $t } else { $t.Retired = $true }
    }
  }
}

function Send-CsSshError([string]$id, $t) {
  Send-CsReply $id 'sshError' ('"exitCode":' + [int]$t.Exit + ',"messageB64":"' + (To-B64Text $t.Err) + '","pathB64":"' + (To-B64Text $t.Ssh) + '"')
}

# ---- requests ----
function Get-CsDir([string]$id) {
  $d = Join-Path $script:work ('r-' + $id)
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  return $d
}

function Remove-CsDir([string]$id) {
  Remove-Item -LiteralPath (Join-Path $script:work ('r-' + $id)) -Recurse -Force -ErrorAction SilentlyContinue
}

function Add-CsFile($msg) {
  $id = [string]$msg.id
  if ($script:failedIds.ContainsKey($id)) { return }
  $name = [string]$msg.name
  if ($name -notmatch '^[A-Za-z0-9_]{1,40}$') { throw 'invalid file name' }
  $bytes = [Convert]::FromBase64String([string]$msg.data)
  $fs = [IO.File]::Open((Join-Path (Get-CsDir $id) $name), [IO.FileMode]::Append, [IO.FileAccess]::Write)
  try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
}

function Start-CsRun($msg) {
  $id = [string]$msg.id
  if ($script:failedIds.ContainsKey($id)) {
    $script:failedIds.Remove($id)
    Remove-CsDir $id
    return
  }
  if ($script:jobs.ContainsKey($id)) { throw 'duplicate request id' }
  $dir = Get-CsDir $id
  $job = @{ Kind = 'run'; Id = $id; Dir = $dir; State = 'new'; Proc = $null; Tunnel = $null; Retried = $false; TimedOut = $false; Reused = $false; LogFrom = [int64]0; KeepMs = (Get-CsKeep $msg.keepMs); Ssh = $msg.ssh }
  $script:jobs[$id] = $job
  $curl = Find-Curl ([string]$msg.curlPath)
  if (-not $curl) {
    throw 'curl.exe not found. Windows 10 (1803+) and Windows 11 include curl.exe. Otherwise set the curl path in Ssoda settings.'
  }
  $job.Curl = $curl
  $job.Hdr = Join-Path $dir 'CS_HDR'
  $job.BodyPath = Join-Path $dir 'CS_BODY'
  $map = @{ '__CS_HDR__' = $job.Hdr; '__CS_BODY__' = $job.BodyPath }
  foreach ($f in @($msg.files)) {
    if ($f) {
      $n = [string]$f
      if ($n -notmatch '^[A-Za-z0-9_]{1,40}$') { throw 'invalid file name' }
      $map['__CS_' + $n + '__'] = (Join-Path $dir $n)
    }
  }
  Assert-SafeArgs @($msg.args)
  $argv = New-Object 'System.Collections.Generic.List[string]'
  # Only http/https, also after redirects: no file://, and no gopher:// or dict:// to services on this PC
  foreach ($a in @('--proto', '=http,https', '--proto-redir', '=http,https')) { $argv.Add($a) }
  foreach ($a in @($msg.args)) {
    $s = [string]$a
    foreach ($k in $map.Keys) { $s = $s.Replace($k, $map[$k]) }
    $argv.Add($s)
  }
  $job.Argv = $argv
  $job.TimeoutMs = 0
  if ($msg.timeoutMs) { $job.TimeoutMs = [int]$msg.timeoutMs }
  if ($msg.ssh) {
    Assert-NoRoutingArgs $argv
    Join-CsTunnel $job
  } else { Start-CsCurl $job }
}

function Join-CsTunnel($job) {
  $t = Get-CsTunnel $job.Ssh $false
  $job.Reused = ($t.State -eq 'ready')
  $job.LogFrom = [int64]0
  if ($job.Reused) { $job.LogFrom = Get-CsLogMark $t }
  $t.Users += 1
  $job.Tunnel = $t
  $job.State = 'tunnel'
}

function Start-CsCurl($job) {
  $argv = New-Object 'System.Collections.Generic.List[string]'
  if ($job.Tunnel) {
    # -q must be first: ignore _curlrc / .curlrc, which could set a proxy or noproxy
    foreach ($a in @('-q', '--socks5-hostname', ('127.0.0.1:' + $job.Tunnel.Port), '--noproxy', '')) { $argv.Add($a) }
  }
  $argv.AddRange($job.Argv)
  foreach ($f in @($job.Hdr, $job.BodyPath)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  $r = Start-CsProc $job.Curl $argv.ToArray() $job.Dir ($null -ne $job.Tunnel)
  $job.Proc = $r.Proc
  $job.OutTask = $r.Out
  $job.ErrTask = $r.Err
  $job.Sw = [Diagnostics.Stopwatch]::StartNew()
  $job.State = 'running'
}

function Update-CsRun($job) {
  if ($job.State -eq 'tunnel') {
    $t = $job.Tunnel
    if ($t.State -eq 'ready') { Start-CsCurl $job }
    elseif ($t.State -eq 'failed') { Send-CsSshError $job.Id $t; Close-CsJob $job }
    elseif ($t.State -ne 'starting') {
      # The tunnel closed before curl started: take another one (once)
      if ($job.Retried) { Send-CsSshError $job.Id $t; Close-CsJob $job; return }
      $job.Retried = $true
      Exit-CsTunnel $t $job.KeepMs
      $job.Tunnel = $null
      Join-CsTunnel $job
    }
    return
  }
  $p = $job.Proc
  if (-not $p.HasExited) {
    if ($job.TimeoutMs -gt 0 -and $job.Sw.ElapsedMilliseconds -ge $job.TimeoutMs) {
      $job.TimedOut = $true
      try { $p.Kill() } catch { }
    }
    return
  }
  if (-not ($job.OutTask.IsCompleted -and $job.ErrTask.IsCompleted)) { return }
  $job.Sw.Stop()
  $exit = $p.ExitCode
  $t = $job.Tunnel
  if ($t -and -not $job.Retried -and -not $job.TimedOut -and ($exit -eq 7 -or $exit -eq 97) -and $t.Proc.HasExited) {
    # The kept tunnel had closed (server restart, network change), so curl could not reach the SOCKS port and the
    # request never left this PC: open a new connection once.
    $job.Retried = $true
    Exit-CsTunnel $t $job.KeepMs
    $job.Tunnel = $null
    Join-CsTunnel $job
    return
  }
  Send-CsResult $job
  Close-CsJob $job
}

function Send-CsResult($job) {
  $hdrBytes = $null
  if (Test-Path -LiteralPath $job.Hdr) { $hdrBytes = [IO.File]::ReadAllBytes($job.Hdr) }
  $bodyBytes = [byte[]]::new(0)
  if (Test-Path -LiteralPath $job.BodyPath) { $bodyBytes = [IO.File]::ReadAllBytes($job.BodyPath) }
  $err = [string]$job.ErrTask.Result
  if ($err.Length -gt 300000) { $err = $err.Substring($err.Length - 300000) }
  $out = [string]$job.OutTask.Result
  if ($out.Length -gt 60000) { $out = $out.Substring(0, 60000) }
  $fields = '"exitCode":' + [int]$job.Proc.ExitCode +
    ',"timedOut":' + ([string]$job.TimedOut).ToLower() +
    ',"elapsedMs":' + [int]$job.Sw.ElapsedMilliseconds +
    ',"bodySize":' + $bodyBytes.Length +
    ',"stdoutB64":"' + (To-B64Text $out) +
    '","stderrB64":"' + (To-B64Text $err) +
    '","headersB64":"' + (To-B64Bytes $hdrBytes 262144) +
    '","pathB64":"' + (To-B64Text $job.Curl) + '"'
  $t = $job.Tunnel
  if ($t) {
    Read-CsTunnelLog $t
    $connect = $t.Ms
    if ($job.Reused) { $connect = 0 }
    $fields += ',"ssh":{"port":' + $t.Port + ',"connectMs":' + $connect + ',"reused":' + ([string]$job.Reused).ToLower() +
      ',"logB64":"' + (To-B64Text (Get-CsLogSince $t $job.LogFrom)) + '","pathB64":"' + (To-B64Text $t.Ssh) + '"}'
  }
  Send-CsReply $job.Id 'result' $fields
  $chunk = 524288
  for ($off = 0; $off -lt $bodyBytes.Length; $off += $chunk) {
    $n = [Math]::Min($chunk, $bodyBytes.Length - $off)
    Send-CsReply $job.Id 'body' ('"data":"' + [Convert]::ToBase64String($bodyBytes, $off, $n) + '"')
  }
  Send-CsReply $job.Id 'end' ''
}

# Connection test: always a new connection, so it checks the server, user and password as they are now.
# The tested connection then replaces older ones to the same server and stays for the next request.
function Start-CsTest($msg) {
  $id = [string]$msg.id
  $job = @{ Kind = 'test'; Id = $id; Dir = $null; Proc = $null; Tunnel = $null; KeepMs = (Get-CsKeep $msg.keepMs) }
  $script:jobs[$id] = $job
  $t = Get-CsTunnel $msg.ssh $true
  $t.Users += 1
  $job.Tunnel = $t
}

function Update-CsTest($job) {
  $t = $job.Tunnel
  if ($t.State -eq 'starting') { return }
  if ($t.State -ne 'ready') { Send-CsSshError $job.Id $t; Close-CsJob $job; return }
  foreach ($o in @($script:tunnels.Values)) { if ($o.Seq -ne $t.Seq -and $o.Key -eq $t.Key) { $o.Retired = $true } }
  $fp = Get-HostFingerprint $t.Target $t.Ssh
  Send-CsReply $job.Id 'sshOk' ('"connectMs":' + $t.Ms + ',"logB64":"' + (To-B64Text $t.Log.ToString()) + '","fingerprintB64":"' + (To-B64Text $fp) + '","pathB64":"' + (To-B64Text $t.Ssh) + '"')
  Close-CsJob $job
}

# Fetch the server's host keys (not trusted yet) without holding up the other requests
function Start-CsScan($msg) {
  $id = [string]$msg.id
  $job = @{ Kind = 'scan'; Id = $id; Dir = $null; Proc = $null; Tunnel = $null; KeepMs = 0 }
  $script:jobs[$id] = $job
  $job.Target = Get-SshTarget $msg.ssh
  $scan = Find-SshTool 'ssh-keyscan.exe'
  $r = Start-CsProc $scan @('-p', [string]$job.Target.Port, '-T', '8', $job.Target.Host) $script:work $false
  $job.Proc = $r.Proc
  $job.OutTask = $r.Out
  $job.ErrTask = $r.Err
  $job.Sw = [Diagnostics.Stopwatch]::StartNew()
}

function Update-CsScan($job) {
  if (-not $job.Proc.HasExited) {
    if ($job.Sw.ElapsedMilliseconds -ge 20000) { try { $job.Proc.Kill() } catch { } }
    return
  }
  if (-not ($job.OutTask.IsCompleted -and $job.ErrTask.IsCompleted)) { return }
  $t = $job.Target
  $keys = @(([string]$job.OutTask.Result) -split "`r?`n" | Where-Object { Test-HostKeyLine $_ $t })
  $fp = ''
  if ($keys.Count) {
    $f = Join-Path $script:work ('SCAN-' + $job.Id)
    [IO.File]::WriteAllLines($f, [string[]]$keys, (New-Object System.Text.ASCIIEncoding))
    try {
      $kg = Find-SshTool 'ssh-keygen.exe'
      $fp = ((& $kg -l -f $f 2>$null) | ForEach-Object { $_.Trim() }) -join "`n"
    } catch { $fp = '' }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
  Send-CsReply $job.Id 'sshScanned' ('"keysB64":"' + (To-B64Text ($keys -join "`n")) + '","fingerprintsB64":"' + (To-B64Text $fp) + '","errB64":"' + (To-B64Text ([string]$job.ErrTask.Result)) + '"')
  Close-CsJob $job
}

function Close-CsJob($job) {
  if ($job.Proc) { try { if (-not $job.Proc.HasExited) { $job.Proc.Kill() } } catch { } }
  if ($job.Tunnel) {
    Exit-CsTunnel $job.Tunnel $job.KeepMs
    $job.Tunnel = $null
  }
  if ($job.Dir) { Remove-Item -LiteralPath $job.Dir -Recurse -Force -ErrorAction SilentlyContinue }
  $script:jobs.Remove($job.Id)
}

function Stop-CsRequest([string]$id) {
  $script:failedIds.Remove($id)
  $job = $script:jobs[$id]
  if ($job) {
    Close-CsJob $job
    Send-CsReply $id 'cancelled' ''
  } else { Remove-CsDir $id }
}

function Update-CsJobs {
  foreach ($job in @($script:jobs.Values)) {
    try {
      if ($job.Kind -eq 'run') { Update-CsRun $job }
      elseif ($job.Kind -eq 'test') { Update-CsTest $job }
      elseif ($job.Kind -eq 'scan') { Update-CsScan $job }
    } catch {
      Send-CsReply $job.Id 'error' ('"messageB64":"' + (To-B64Text $_.Exception.Message) + '"')
      Close-CsJob $job
    }
  }
}

function Invoke-CsMessage($msg) {
  $type = [string]$msg.type
  if ($type -eq 'config') {
    $script:keepMs = Get-CsKeep $msg.keepMs
    foreach ($t in @($script:tunnels.Values)) { $t.KeepMs = $script:keepMs }
    return
  }
  if ($type -eq 'closeTunnels') {
    foreach ($t in @($script:tunnels.Values)) { if ($t.Users -le 0) { Close-CsTunnel $t } else { $t.Retired = $true } }
    return
  }
  $id = [string]$msg.id
  if (-not (Test-CsId $id)) { throw ('invalid request id: ' + $id) }
  try {
    if ($type -eq 'file') { Add-CsFile $msg }
    elseif ($type -eq 'run') { Start-CsRun $msg }
    elseif ($type -eq 'cancel') { Stop-CsRequest $id }
    elseif ($type -eq 'sshTest') { Start-CsTest $msg }
    elseif ($type -eq 'sshScan') { Start-CsScan $msg }
    elseif ($type -eq 'sshTrust') {
      $n = Add-TrustedHostKeys $msg.ssh ([string]$msg.keys)
      Send-CsReply $id 'sshTrusted' ('"added":' + [int]$n)
    }
    elseif ($type -eq 'sshForget') {
      $n = Forget-SshHost $msg.ssh
      Close-CsHostTunnels $msg.ssh
      Send-CsReply $id 'sshForgot' ('"removed":' + [int]$n)
    }
    elseif ($type -eq 'ping') { Send-Pong $msg $id $true }
    else { throw ('unknown message type: ' + $type) }
  }
  catch {
    if ($type -eq 'file') { $script:failedIds[$id] = $true }
    $job = $script:jobs[$id]
    if ($job) { Close-CsJob $job } else { Remove-CsDir $id }
    Send-CsReply $id 'error' ('"messageB64":"' + (To-B64Text $_.Exception.Message) + '"')
  }
}

# A helper that was stopped by force (Task Manager) could not close its SSH tunnels. Its work folder
# (ssoda-s<pid>-...) is left behind: when that helper is gone, stop the ssh.exe started from that folder.
function Clear-CsStale {
  try {
    $stale = @()
    foreach ($d in @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'ssoda-s*' -ErrorAction SilentlyContinue)) {
      if ($d.Name -notmatch '^ssoda-s(\d+)-[0-9a-f]{32}$') { continue }
      $owner = [int]$Matches[1]
      if ($owner -eq $PID) { continue }
      $alive = $false
      try {
        $op = Get-Process -Id $owner -ErrorAction Stop
        $alive = ($op.ProcessName -match '^(powershell|pwsh)$')
      } catch { }
      if (-not $alive) { $stale += $d.FullName }
    }
    if (-not $stale.Count) { return }
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue)
    foreach ($dir in $stale) {
      foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
        }
      }
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}

function Invoke-Session($first) {
  $script:keepMs = Get-CsKeep $first.keepMs
  Send-Pong $first '' $true
  Clear-CsStale
  Start-CsRead
  while (-not $script:gone) {
    $wait = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
    $wait.Add($script:rd.Task)
    $busy = $false
    foreach ($job in @($script:jobs.Values)) {
      $busy = $true
      foreach ($tk in @($job.OutTask, $job.ErrTask)) { if ($tk -and -not $tk.IsCompleted) { $wait.Add($tk) } }
    }
    foreach ($t in @($script:tunnels.Values)) {
      if ($t.State -eq 'starting') {
        $busy = $true
        if ($t.Probe -and -not $t.Probe.IsCompleted) { $wait.Add($t.Probe) }
      }
      if ($t.LineTask -and -not $t.LineTask.IsCompleted) { $wait.Add($t.LineTask) }
    }
    # Idle (only kept tunnels): wake once a second to close the ones that were not used for keepMs
    $ms = 1000
    if ($busy) { $ms = 25 }
    [void][System.Threading.Tasks.Task]::WaitAny($wait.ToArray(), $ms)
    while ($true) {
      $m = Get-CsMessage
      if ($null -eq $m) { break }
      if ($m -is [string]) { return }
      Invoke-CsMessage $m
    }
    Update-CsTunnels
    Update-CsJobs
  }
}

function Stop-CsAll {
  foreach ($job in @($script:jobs.Values)) { try { if ($job.Proc -and -not $job.Proc.HasExited) { $job.Proc.Kill() } } catch { } }
  foreach ($t in @($script:tunnels.Values)) { try { if ($t.Proc -and -not $t.Proc.HasExited) { $t.Proc.Kill() } } catch { } }
  foreach ($t in @($script:tunnels.Values)) { try { [void]$t.Proc.WaitForExit(1000) } catch { } }
}

try {
  $first = Read-Message
  if ($null -ne $first) {
    if ([string]$first.type -eq 'ping' -and $first.session -eq $true) {
      # The folder name carries this helper's process ID (see Clear-CsStale)
      $script:work = Join-Path ([IO.Path]::GetTempPath()) ('ssoda-s' + $PID + '-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $script:work -Force | Out-Null
      Invoke-Session $first
    } else {
      New-Item -ItemType Directory -Path $script:work -Force | Out-Null
      Invoke-OneShot $first
    }
  }
}
catch {
  try { Send-Json ('{"type":"error","messageB64":"' + (To-B64Text $_.Exception.Message) + '"}') } catch { }
}
finally {
  Stop-CsAll
  try { Remove-Item -LiteralPath $script:work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
