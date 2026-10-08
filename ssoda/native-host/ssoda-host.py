#!/usr/bin/env python3
# Ssoda - native messaging host for macOS / Linux
# Chrome talks to this script over stdin/stdout (4-byte length prefix + UTF-8 JSON).
# It runs curl with the argument list sent by the extension (no shell involved) and
# returns status, headers, body and terminal output.
# With an "ssh" block it first opens an SSH tunnel (ssh -D, SOCKS5 on 127.0.0.1) to the given
# server, so curl runs through that server. The password is handed to ssh through SSH_ASKPASS
# (OpenSSH 8.4+) from a temporary file that is deleted as soon as the tunnel is up.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.
import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

HOST_VERSION = '1.3.1'
NAME_RE = re.compile(r'^[A-Za-z0-9_]{1,40}$')
STDIN = sys.stdin.buffer
STDOUT = sys.stdout.buffer
LOCK = threading.Lock()
KNOWN_HOSTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'known_hosts')
HOST_RE = re.compile(r'^[A-Za-z0-9._:%-]{1,253}$')
CANCELLED = threading.Event()


def read_exact(n):
    buf = b''
    while len(buf) < n:
        chunk = STDIN.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_msg():
    raw = read_exact(4)
    if raw is None:
        return None
    n = struct.unpack('@I', raw)[0]
    data = read_exact(n)
    if data is None:
        return None
    return json.loads(data.decode('utf-8'))


def send(obj):
    b = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    with LOCK:
        STDOUT.write(struct.pack('@I', len(b)))
        STDOUT.write(b)
        STDOUT.flush()


def b64(v):
    if v is None:
        v = b''
    if isinstance(v, str):
        v = v.encode('utf-8')
    return base64.b64encode(v).decode('ascii')


def find_curl(custom):
    if custom:
        # A backup file must not be able to point this at another program
        if not os.path.isabs(custom) or custom.startswith('//') or os.path.basename(custom) != 'curl':
            raise ValueError('The curl path must be an absolute path to curl (for example /usr/local/bin/curl).')
        if os.path.isfile(custom):
            return custom
    found = shutil.which('curl')
    if found:
        return found
    for p in ('/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl', '/opt/homebrew/opt/curl/bin/curl'):
        if os.path.isfile(p):
            return p
    return None


def find_ssh():
    found = shutil.which('ssh')
    if found:
        return found
    for p in ('/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'):
        if os.path.isfile(p):
            return p
    return None


def ssh_target(cfg):
    """Validate the server settings sent by the extension (never let them become ssh options)."""
    host = str(cfg.get('host') or '').strip().strip('[]')
    user = str(cfg.get('user') or '').strip()
    port = int(cfg.get('port') or 22)
    if not HOST_RE.match(host) or host.startswith('-'):
        raise ValueError('invalid SSH host')
    if not user or user.startswith('-') or re.search(r'[\s"]', user):
        raise ValueError('invalid SSH user')
    if not 1 <= port <= 65535:
        raise ValueError('invalid SSH port')
    key = host if port == 22 else '[%s]:%d' % (host, port)
    return {'host': host, 'user': user, 'port': port, 'key': key}


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def port_open(port):
    try:
        socket.create_connection(('127.0.0.1', port), timeout=0.3).close()
        return True
    except OSError:
        return False


def start_tunnel(cfg, work):
    """Open an SSH tunnel with a SOCKS5 proxy on 127.0.0.1:<free port>."""
    ssh = find_ssh()
    if not ssh:
        raise RuntimeError('ssh not found. Install the OpenSSH client.')
    t = ssh_target(cfg)
    pw = os.path.join(work, 'SSH_PW')
    with open(os.open(pw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as f:
        f.write(str(cfg.get('password') or ''))
    askpass = os.path.join(work, 'askpass.sh')
    with open(askpass, 'w') as f:
        f.write("#!/bin/sh\nexec cat '%s'\n" % pw.replace("'", "'\\''"))
    os.chmod(askpass, 0o700)
    # Empty config file: the user's ~/.ssh/config must not change how the tunnel is opened
    conf = os.path.join(work, 'ssh_config')
    open(conf, 'w').close()
    port = free_port()
    argv = [ssh, '-F', conf, '-N', '-T', '-D', '127.0.0.1:%d' % port, '-p', str(t['port']), '-l', t['user'],
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS,
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
            '-o', 'GSSAPIAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password']
    if cfg.get('legacy'):
        # Old servers (OpenSSH < 7.2) only offer SHA-1 'ssh-rsa' host keys; enabled per environment by the user
        argv += ['-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1']
    argv.append(t['host'])
    env = dict(os.environ, SSH_ASKPASS=askpass, SSH_ASKPASS_REQUIRE='force', DISPLAY=os.environ.get('DISPLAY') or ':0')
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            env=env, cwd=work, start_new_session=True)
    err_chunks = []
    reader = threading.Thread(target=lambda: err_chunks.append(proc.stderr.read()), daemon=True)
    reader.start()
    started = time.time()
    ready = False
    while time.time() - started < 25:
        if proc.poll() is not None or CANCELLED.is_set():
            break
        if port_open(port):
            ready = True
            break
        time.sleep(0.1)
    try:
        os.remove(pw)
    except OSError:
        pass
    tun = {'ok': ready, 'port': port, 'proc': proc, 'reader': reader, 'err': err_chunks, 'ssh': ssh, 'target': t,
           'ms': int((time.time() - started) * 1000)}
    if not ready:
        log = stop_tunnel(tun)
        if not log.strip() and time.time() - started >= 25:
            log = 'ssh: connection timed out'
        tun['log'] = log
    return tun


def stop_tunnel(tun):
    proc = tun['proc']
    if proc.poll() is None:
        proc.kill()
    try:
        proc.wait(3)
    except subprocess.TimeoutExpired:
        pass
    tun['reader'].join(3)
    return b''.join(tun['err']).decode('utf-8', 'replace')


ROUTING_LONG = {'--proxy', '--preproxy', '--noproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--proxytunnel',
                '--unix-socket', '--abstract-unix-socket', '--config', '--doh-url', '--disable', '--next'}
PROXY_ENV = ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME')
KEY_TYPES = re.compile(r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$')


def assert_no_routing_args(argv):
    """Options that change where curl connects (they would bypass the SSH tunnel)."""
    for a in argv:
        s = str(a)
        if s.split('=')[0] in ROUTING_LONG:
            raise ValueError('option not allowed with an SSH tunnel: ' + s.split('=')[0])
        if re.match(r'^-[A-Za-z0-9#]+$', s) and re.search(r'[xpKq]', s):
            raise ValueError('option not allowed with an SSH tunnel: ' + s)


def ssh_tool(name):
    ssh = find_ssh()
    if not ssh:
        raise RuntimeError('ssh not found.')
    p = os.path.join(os.path.dirname(ssh), name)
    found = p if os.path.isfile(p) else shutil.which(name)
    if not found:
        raise RuntimeError(name + ' not found.')
    return found


def host_key_line_ok(line, t):
    parts = line.strip().split(' ')
    return (len(parts) == 3 and parts[0] == t['key'] and bool(KEY_TYPES.match(parts[1]))
            and bool(re.match(r'^[A-Za-z0-9+/]+={0,3}$', parts[2])))


def scan_host_keys(cfg, work):
    """Fetch the server's host keys (not trusted yet) so the user can compare the fingerprint."""
    t = ssh_target(cfg)
    r = subprocess.run([ssh_tool('ssh-keyscan'), '-p', str(t['port']), '-T', '8', t['host']], stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=20)
    keys = [x.strip() for x in r.stdout.decode('utf-8', 'replace').splitlines() if host_key_line_ok(x, t)]
    fp = ''
    if keys:
        f = os.path.join(work, 'SCAN')
        with open(f, 'w') as fh:
            fh.write('\n'.join(keys) + '\n')
        k = subprocess.run([ssh_tool('ssh-keygen'), '-l', '-f', f], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        fp = '\n'.join(x.strip() for x in k.stdout.decode('utf-8', 'replace').splitlines() if x.strip())
    return '\n'.join(keys), fp, r.stderr.decode('utf-8', 'replace')


def trust_host_keys(cfg, keys):
    """Save host keys the user has confirmed."""
    t = ssh_target(cfg)
    lines = [x.strip() for x in str(keys or '').splitlines() if x.strip()]
    if not lines or not all(host_key_line_ok(x, t) for x in lines):
        raise ValueError('invalid host key line')
    with open(KNOWN_HOSTS, 'a', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return len(lines)


def send_ssh_error(tun):
    send({'type': 'sshError', 'exitCode': tun['proc'].returncode, 'messageB64': b64(tun.get('log', '')), 'pathB64': b64(tun['ssh'])})


def host_fingerprint(tun):
    keygen = os.path.join(os.path.dirname(tun['ssh']), 'ssh-keygen')
    if not os.path.isfile(keygen) or not os.path.isfile(KNOWN_HOSTS):
        return ''
    try:
        r = subprocess.run([keygen, '-l', '-F', tun['target']['key'], '-f', KNOWN_HOSTS], stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=15)
        lines = r.stdout.decode('utf-8', 'replace').splitlines()
        return '\n'.join(x.strip() for x in lines if x.strip() and not x.startswith('#'))
    except Exception:  # noqa: BLE001
        return ''


def forget_host(cfg):
    """Remove a server's saved host key (after the server key was legitimately changed)."""
    t = ssh_target(cfg)
    if not os.path.isfile(KNOWN_HOSTS):
        return 0
    names = {t['key'], t['host']}
    kept, removed = [], 0
    with open(KNOWN_HOSTS, encoding='utf-8', errors='replace') as f:
        for line in f:
            first = (line.split() or [''])[0]
            if names & set(first.split(',')):
                removed += 1
            else:
                kept.append(line)
    with open(KNOWN_HOSTS, 'w', encoding='utf-8') as f:
        f.writelines(kept)
    return removed


def watch_stdin():
    """The extension closed the connection (request cancelled)."""
    try:
        if not STDIN.read(1):
            CANCELLED.set()
    except Exception:  # noqa: BLE001
        pass


def run_request(msg, work):
    curl = find_curl(msg.get('curlPath'))
    if not curl:
        raise RuntimeError('curl not found. Install curl or set the curl path in Ssoda settings.')
    hdr = os.path.join(work, 'CS_HDR')
    body_path = os.path.join(work, 'CS_BODY')
    mapping = {'__CS_HDR__': hdr, '__CS_BODY__': body_path}
    for name in msg.get('files') or []:
        if not NAME_RE.match(str(name)):
            raise ValueError('invalid file name')
        mapping['__CS_%s__' % name] = os.path.join(work, name)
    argv = []
    for a in msg.get('args') or []:
        s = str(a)
        for k, v in mapping.items():
            s = s.replace(k, v)
        argv.append(s)
    timeout = (msg.get('timeoutMs') or 0) / 1000.0 or None
    tun = None
    ssh_log = ''
    env = None
    if msg.get('ssh'):
        assert_no_routing_args(argv)
        tun = start_tunnel(msg['ssh'], work)
        if not tun['ok']:
            send_ssh_error(tun)
            return
        # -q must be first: ignore .curlrc, which could set a proxy or noproxy
        argv = ['-q', '--socks5-hostname', '127.0.0.1:%d' % tun['port'], '--noproxy', ''] + argv
        env = {k: v for k, v in os.environ.items() if k not in PROXY_ENV}
    started = time.time()
    proc = subprocess.Popen([curl] + argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=work, env=env)

    # 확장 프로그램이 연결을 끊으면(취소) curl 종료
    def kill_on_cancel():
        CANCELLED.wait()
        if proc.poll() is None:
            proc.kill()

    threading.Thread(target=kill_on_cancel, daemon=True).start()
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        out, err = proc.communicate()
    finally:
        if tun:
            ssh_log = stop_tunnel(tun)
    elapsed = int((time.time() - started) * 1000)
    hdr_bytes = b''
    if os.path.isfile(hdr):
        with open(hdr, 'rb') as f:
            hdr_bytes = f.read(262144)
    body = b''
    if os.path.isfile(body_path):
        with open(body_path, 'rb') as f:
            body = f.read()
    err = err[-300000:]
    out = out[:60000]
    meta = {
        'type': 'result',
        'exitCode': proc.returncode if proc.returncode >= 0 else 128 - proc.returncode,
        'timedOut': timed_out,
        'elapsedMs': elapsed,
        'bodySize': len(body),
        'stdoutB64': b64(out),
        'stderrB64': b64(err),
        'headersB64': b64(hdr_bytes),
        'pathB64': b64(curl),
    }
    if tun:
        meta['ssh'] = {'port': tun['port'], 'connectMs': tun['ms'], 'logB64': b64(ssh_log), 'pathB64': b64(tun['ssh'])}
    send(meta)
    chunk = 524288
    for off in range(0, len(body), chunk):
        send({'type': 'body', 'data': b64(body[off:off + chunk])})
    send({'type': 'end'})


def main():
    work = tempfile.mkdtemp(prefix='ssoda-')
    try:
        while True:
            msg = read_msg()
            if msg is None:
                break
            t = msg.get('type')
            if t == 'ping':
                curl = find_curl(msg.get('curlPath'))
                ver = ''
                if curl:
                    try:
                        r = subprocess.run([curl, '--version'], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
                        ver = r.stdout.decode('utf-8', 'replace').splitlines()[0].strip()
                    except Exception as e:  # noqa: BLE001
                        ver = 'error: %s' % e
                ssh = find_ssh()
                ssh_ver = ''
                if ssh:
                    try:
                        r = subprocess.run([ssh, '-V'], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
                        ssh_ver = (r.stderr + r.stdout).decode('utf-8', 'replace').strip().splitlines()[0]
                    except Exception as e:  # noqa: BLE001
                        ssh_ver = 'error: %s' % e
                send({'type': 'pong', 'hostVersion': HOST_VERSION, 'platform': sys.platform,
                      'curlB64': b64(ver), 'pathB64': b64(curl or ''), 'sshB64': b64(ssh_ver), 'sshPathB64': b64(ssh or '')})
                break
            elif t == 'file':
                name = str(msg.get('name', ''))
                if not NAME_RE.match(name):
                    raise ValueError('invalid file name')
                with open(os.path.join(work, name), 'ab') as f:
                    f.write(base64.b64decode(msg.get('data') or ''))
            elif t == 'run':
                threading.Thread(target=watch_stdin, daemon=True).start()
                run_request(msg, work)
                break
            elif t == 'sshTest':
                threading.Thread(target=watch_stdin, daemon=True).start()
                tun = start_tunnel(msg.get('ssh') or {}, work)
                if not tun['ok']:
                    send_ssh_error(tun)
                else:
                    log = stop_tunnel(tun)
                    send({'type': 'sshOk', 'connectMs': tun['ms'], 'logB64': b64(log),
                          'fingerprintB64': b64(host_fingerprint(tun)), 'pathB64': b64(tun['ssh'])})
                break
            elif t == 'sshScan':
                keys, fp, err = scan_host_keys(msg.get('ssh') or {}, work)
                send({'type': 'sshScanned', 'keysB64': b64(keys), 'fingerprintsB64': b64(fp), 'errB64': b64(err)})
                break
            elif t == 'sshTrust':
                send({'type': 'sshTrusted', 'added': trust_host_keys(msg.get('ssh') or {}, msg.get('keys'))})
                break
            elif t == 'sshForget':
                send({'type': 'sshForgot', 'removed': forget_host(msg.get('ssh') or {})})
                break
    except Exception as e:  # noqa: BLE001
        try:
            send({'type': 'error', 'messageB64': b64(str(e))})
        except Exception:
            pass
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
    # stdin 감시 스레드가 블록된 상태에서 인터프리터 종료 오류가 나지 않도록 즉시 종료
    sys.stdout.flush()
    os._exit(0)
