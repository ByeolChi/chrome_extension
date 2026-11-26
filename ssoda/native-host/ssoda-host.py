#!/usr/bin/env python3
# Ssoda - native messaging host for macOS / Linux
# Chrome talks to this script over stdin/stdout (4-byte length prefix + UTF-8 JSON).
# It runs curl with the argument list sent by the extension (no shell involved) and
# returns status, headers, body and terminal output.
# With an "ssh" block it first opens an SSH tunnel (ssh -D, SOCKS5 on 127.0.0.1) to the given
# server, so curl runs through that server. The password is handed to ssh through SSH_ASKPASS
# (OpenSSH 8.4+) from a temporary file that is deleted as soon as the tunnel is up.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.
#
# Two ways to talk:
#  - One request per start (Ssoda 1.x, and the version check): the helper answers one request and exits.
#  - Session (helper 2.0): the first message is {"type":"ping","session":true}. The helper answers with
#    "session":true and keeps running while the Ssoda tab is open. Every message then carries an "id",
#    requests run side by side, {"type":"cancel","id"} stops one, and an SSH tunnel stays open for
#    "keepMs" after its last request, so the next request to the same server uses it again.
import base64
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

HOST_VERSION = '2.0.0'
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


def prepare_tunnel(cfg, folder):
    """Files and arguments for an ssh tunnel with a SOCKS5 proxy on 127.0.0.1:<free port>.
    Returns (argv, env, port, password file, ssh path, target)."""
    ssh = find_ssh()
    if not ssh:
        raise RuntimeError('ssh not found. Install the OpenSSH client.')
    t = ssh_target(cfg)
    pw = os.path.join(folder, 'SSH_PW')
    with open(os.open(pw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as f:
        f.write(str(cfg.get('password') or ''))
    askpass = os.path.join(folder, 'askpass.sh')
    with open(askpass, 'w') as f:
        f.write("#!/bin/sh\nexec cat '%s'\n" % pw.replace("'", "'\\''"))
    os.chmod(askpass, 0o700)
    # Empty config file: the user's ~/.ssh/config must not change how the tunnel is opened
    conf = os.path.join(folder, 'ssh_config')
    open(conf, 'w').close()
    port = free_port()
    # The path is quoted for OpenSSH: unquoted, the space in "~/Library/Application Support/Ssoda" splits it into two
    # file names, so the trusted key is never found and every request asks to trust the server again.
    if '"' in KNOWN_HOSTS:
        raise RuntimeError('The helper folder path must not contain a double quote: ' + KNOWN_HOSTS)
    argv = [ssh, '-F', conf, '-N', '-T', '-D', '127.0.0.1:%d' % port, '-p', str(t['port']), '-l', t['user'],
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile="%s"' % KNOWN_HOSTS,
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
            '-o', 'GSSAPIAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password']
    if cfg.get('legacy'):
        # Old servers (OpenSSH < 7.2) only offer SHA-1 'ssh-rsa' host keys; enabled per environment by the user
        argv += ['-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1']
    argv.append(t['host'])
    env = dict(os.environ, SSH_ASKPASS=askpass, SSH_ASKPASS_REQUIRE='force', DISPLAY=os.environ.get('DISPLAY') or ':0')
    return argv, env, port, pw, ssh, t


def start_tunnel(cfg, work):
    """Open an SSH tunnel with a SOCKS5 proxy on 127.0.0.1:<free port>."""
    argv, env, port, pw, ssh, t = prepare_tunnel(cfg, work)
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


DENY_ARGS = {'--next', '-:', '--config', '-K', '--unix-socket', '--abstract-unix-socket', '--variable', '--output', '--dump-header',
             '--trace', '--trace-ascii', '--trace-config', '--stderr', '--libcurl', '--upload-file', '-T', '--cookie-jar', '-c', '--netrc',
             '-n', '--netrc-file', '--netrc-optional', '--etag-save', '--etag-compare', '--hsts', '--alt-svc', '--output-dir', '--create-dirs',
             '--remote-name', '-O', '--remote-name-all', '--remote-header-name', '-J', '--ssl-sessions', '--proto-default', '-q', '--disable'}
USER_OPTS = {'--user', '-u', '--proxy-user', '-U'}
PLACEHOLDER_FILE = re.compile(r'^@__CS_[A-Za-z0-9_]{1,40}__$')
FORM_FILE = re.compile(r'^[@<]__CS_[A-Za-z0-9_]{1,40}__(;|$)')


def assert_safe_args(argv):
    """Defense in depth: the extension already passes only allowed curl options. A request must still never make curl
    read or write local files, talk to a local socket, or start a second transfer (--next) that skips --proto."""
    prev = ''
    for a in argv:
        s = str(a)
        if s in DENY_ARGS or s.startswith('--expand-'):
            raise ValueError('curl option not allowed: ' + s)
        # Short option bundles such as -sSo would hide one of the options above
        if re.match(r'^-[A-Za-z0-9#:]{2,}$', s) and re.search(r'[KTcnOJqo:D]', s):
            raise ValueError('curl option not allowed: ' + s)
        if prev in ('-F', '--form'):
            # name=@file / name=<file: only the temporary files sent by the extension
            eq = s.find('=')
            if eq < 1 or not FORM_FILE.match(s[eq + 1:]):
                raise ValueError('form fields must use the files sent by the extension')
        elif s.startswith('@') and not PLACEHOLDER_FILE.match(s) and prev not in USER_OPTS:
            # -H @file, --proxy-header @file, --data @file ...
            raise ValueError('curl argument must not read a local file: ' + s)
        if prev in ('-o', '-D') and s not in ('__CS_BODY__', '__CS_HDR__'):
            raise ValueError('curl output path not allowed: ' + s)
        prev = s


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
    return fingerprint_of(tun['ssh'], tun['target'])


def fingerprint_of(ssh, target):
    keygen = os.path.join(os.path.dirname(ssh), 'ssh-keygen')
    if not os.path.isfile(keygen) or not os.path.isfile(KNOWN_HOSTS):
        return ''
    try:
        r = subprocess.run([keygen, '-l', '-F', target['key'], '-f', KNOWN_HOSTS], stdin=subprocess.DEVNULL,
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


def curl_command(msg, folder):
    """Check the request and build curl's arguments. Returns (curl, argv, header file, body file)."""
    curl = find_curl(msg.get('curlPath'))
    if not curl:
        raise RuntimeError('curl not found. Install curl or set the curl path in Ssoda settings.')
    hdr = os.path.join(folder, 'CS_HDR')
    body_path = os.path.join(folder, 'CS_BODY')
    mapping = {'__CS_HDR__': hdr, '__CS_BODY__': body_path}
    for name in msg.get('files') or []:
        if not NAME_RE.match(str(name)):
            raise ValueError('invalid file name')
        mapping['__CS_%s__' % name] = os.path.join(folder, name)
    assert_safe_args(msg.get('args') or [])
    # Only http/https, also after redirects: no file://, and no gopher:// or dict:// to services on this PC
    argv = ['--proto', '=http,https', '--proto-redir', '=http,https']
    for a in msg.get('args') or []:
        s = str(a)
        for k, v in mapping.items():
            s = s.replace(k, v)
        argv.append(s)
    if msg.get('ssh'):
        assert_no_routing_args(argv)
    return curl, argv, hdr, body_path


def send_result(curl, returncode, timed_out, elapsed, out, err, hdr, body_path, ssh_meta=None, rid=None):
    hdr_bytes = b''
    if os.path.isfile(hdr):
        with open(hdr, 'rb') as f:
            hdr_bytes = f.read(262144)
    body = b''
    if os.path.isfile(body_path):
        with open(body_path, 'rb') as f:
            body = f.read()
    extra = {'id': rid} if rid else {}
    meta = {
        'type': 'result',
        'exitCode': returncode if returncode >= 0 else 128 - returncode,
        'timedOut': timed_out,
        'elapsedMs': elapsed,
        'bodySize': len(body),
        'stdoutB64': b64(out[:60000]),
        'stderrB64': b64(err[-300000:]),
        'headersB64': b64(hdr_bytes),
        'pathB64': b64(curl),
    }
    if ssh_meta:
        meta['ssh'] = ssh_meta
    meta.update(extra)
    send(meta)
    chunk = 524288
    for off in range(0, len(body), chunk):
        send(dict(extra, type='body', data=b64(body[off:off + chunk])))
    send(dict(extra, type='end'))


def run_request(msg, work):
    curl, argv, hdr, body_path = curl_command(msg, work)
    timeout = (msg.get('timeoutMs') or 0) / 1000.0 or None
    tun = None
    ssh_log = ''
    env = None
    if msg.get('ssh'):
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
    ssh_meta = None
    if tun:
        ssh_meta = {'port': tun['port'], 'connectMs': tun['ms'], 'logB64': b64(ssh_log), 'pathB64': b64(tun['ssh'])}
    send_result(curl, proc.returncode, timed_out, elapsed, out, err, hdr, body_path, ssh_meta)


def pong(msg, session=False):
    curl = None
    ver = ''
    try:
        curl = find_curl(msg.get('curlPath'))
    except ValueError as e:
        # A wrong curl path must not stop a session: SSH key checks do not need curl, and each request reports it
        if not session:
            raise
        ver = 'error: %s' % e
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
    p = {'type': 'pong', 'hostVersion': HOST_VERSION, 'platform': sys.platform,
         'curlB64': b64(ver), 'pathB64': b64(curl or ''), 'sshB64': b64(ssh_ver), 'sshPathB64': b64(ssh or '')}
    if session:
        p['session'] = True
    return p


def one_shot(msg, work):
    """One request per start (Ssoda 1.x, version check): answer one request, then exit."""
    while msg is not None:
        t = msg.get('type')
        if t == 'ping':
            send(pong(msg))
            return
        elif t == 'file':
            name = str(msg.get('name', ''))
            if not NAME_RE.match(name):
                raise ValueError('invalid file name')
            with open(os.path.join(work, name), 'ab') as f:
                f.write(base64.b64decode(msg.get('data') or ''))
        elif t == 'run':
            threading.Thread(target=watch_stdin, daemon=True).start()
            run_request(msg, work)
            return
        elif t == 'sshTest':
            threading.Thread(target=watch_stdin, daemon=True).start()
            tun = start_tunnel(msg.get('ssh') or {}, work)
            if not tun['ok']:
                send_ssh_error(tun)
            else:
                log = stop_tunnel(tun)
                send({'type': 'sshOk', 'connectMs': tun['ms'], 'logB64': b64(log),
                      'fingerprintB64': b64(host_fingerprint(tun)), 'pathB64': b64(tun['ssh'])})
            return
        elif t == 'sshScan':
            keys, fp, err = scan_host_keys(msg.get('ssh') or {}, work)
            send({'type': 'sshScanned', 'keysB64': b64(keys), 'fingerprintsB64': b64(fp), 'errB64': b64(err)})
            return
        elif t == 'sshTrust':
            send({'type': 'sshTrusted', 'added': trust_host_keys(msg.get('ssh') or {}, msg.get('keys'))})
            return
        elif t == 'sshForget':
            send({'type': 'sshForgot', 'removed': forget_host(msg.get('ssh') or {})})
            return
        msg = read_msg()


# ---------------- session (helper 2.0) ----------------
ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')


def tunnel_key(cfg):
    """Same server, user, password and legacy setting -> same tunnel. The password is kept only as a hash."""
    t = ssh_target(cfg)
    pw = hashlib.sha256(str(cfg.get('password') or '').encode('utf-8')).hexdigest()
    return '%s@%s|%s|%s' % (t['user'], t['key'], bool(cfg.get('legacy')), pw)


def keep_of(value, default):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(n, 86400000))


class Tunnel:
    """An ssh -D tunnel kept between requests. Its fields are read and written under Session.lock."""

    def __init__(self, sess, cfg, key, seq):
        self.sess, self.key, self.seq = sess, key, seq
        self.dir = os.path.join(sess.work, 't%d' % seq)
        os.mkdir(self.dir)
        argv, env, self.port, self.pw, self.ssh, self.target = prepare_tunnel(cfg, self.dir)
        self.state = 'starting'   # starting -> ready | failed; ready -> dead (ssh ended) -> closed
        self.users = 0
        self.retired = False      # replaced by a newer connection: close when unused
        self.keep_ms = sess.keep_ms
        self.idle_since = time.time()
        self.ms = 0
        self.err = ''
        self.exit = None
        self.log = ''
        self.dropped = 0
        self.done = threading.Event()   # set when ready or failed
        self.started = time.time()
        self.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     env=env, cwd=self.dir, start_new_session=True)
        self.reader = threading.Thread(target=self._read_log, daemon=True)
        self.reader.start()
        threading.Thread(target=self._wait_ready, daemon=True).start()

    def _read_log(self):
        """ssh's messages, line by line (each request gets the lines written while it ran)."""
        try:
            for raw in iter(self.proc.stderr.readline, b''):
                line = raw.decode('utf-8', 'replace')
                with self.sess.lock:
                    self.log += line
                    if len(self.log) > 300000:
                        cut = len(self.log) - 200000
                        self.log = self.log[cut:]
                        self.dropped += cut
        except Exception:  # noqa: BLE001
            pass

    def mark(self):
        return self.dropped + len(self.log)

    def since(self, mark):
        return self.log[max(0, mark - self.dropped):]

    def _wait_ready(self):
        # The SOCKS port opens only after ssh has logged in, so a connection to it means the tunnel is ready
        ready = False
        while time.time() - self.started < 25:
            if self.proc.poll() is not None or self.sess.closed:
                break
            if port_open(self.port):
                ready = True
                break
            time.sleep(0.05)
        try:
            os.remove(self.pw)
        except OSError:
            pass
        if not ready:
            self.kill()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                pass
            self.reader.join(3)
        with self.sess.lock:
            if ready:
                self.state = 'ready'
                self.ms = int((time.time() - self.started) * 1000)
                self.idle_since = time.time()
            else:
                self.state = 'failed'
                self.exit = self.proc.returncode
                timed_out = time.time() - self.started >= 25
                self.err = self.log if self.log.strip() else ('ssh: connection timed out' if timed_out else '')
        self.done.set()

    def kill(self):
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass


class Job:
    def __init__(self, rid):
        self.id = rid
        self.cancel = threading.Event()
        self.proc = None


class Session:
    """One helper for the whole Ssoda tab: requests run in their own threads, replies carry the request id."""

    def __init__(self, work):
        self.work = work
        self.lock = threading.RLock()
        self.jobs = {}       # id -> Job
        self.tunnels = {}    # number -> Tunnel
        self.seq = 0
        self.keep_ms = 600000
        self.failed = set()  # requests whose file upload failed: their "run" is dropped
        self.closed = False
        threading.Thread(target=self._reaper, daemon=True).start()

    def reply(self, rid, obj):
        obj['id'] = rid
        try:
            send(obj)
        except Exception:  # noqa: BLE001  (the extension is gone; the read loop ends soon)
            pass

    def folder(self, rid):
        d = os.path.join(self.work, 'r-' + rid)
        if not os.path.isdir(d):
            os.mkdir(d)
        return d

    def drop_folder(self, rid):
        shutil.rmtree(os.path.join(self.work, 'r-' + rid), ignore_errors=True)

    # ---- tunnels ----
    def acquire(self, cfg, fresh=False):
        """The open tunnel to this server (or the one still connecting), otherwise a new one.
        fresh: always a new connection. Returns (tunnel, reused)."""
        key = tunnel_key(cfg)
        with self.lock:
            if not fresh:
                for t in self.tunnels.values():
                    if t.key == key and not t.retired and (t.state == 'starting' or (t.state == 'ready' and t.proc.poll() is None)):
                        t.users += 1
                        return t, t.state == 'ready'
            self.seq += 1
            t = Tunnel(self, cfg, key, self.seq)
            self.tunnels[t.seq] = t
            t.users += 1
            return t, False

    def release(self, t, keep_ms):
        """A request is done with the tunnel: when nobody uses it, it closes after keep_ms (0: right away)."""
        with self.lock:
            t.users -= 1
            if t.users <= 0:
                t.users = 0
                t.keep_ms = keep_ms
                t.idle_since = time.time()

    def _close(self, t):
        # called under self.lock
        t.state = 'closed'
        self.tunnels.pop(t.seq, None)
        t.kill()

        def cleanup():
            try:
                t.proc.wait(3)
            except Exception:  # noqa: BLE001
                pass
            shutil.rmtree(t.dir, ignore_errors=True)

        threading.Thread(target=cleanup, daemon=True).start()

    def _reaper(self):
        while not self.closed:
            time.sleep(0.5)
            with self.lock:
                now = time.time()
                for t in list(self.tunnels.values()):
                    if t.state == 'ready' and t.proc.poll() is not None:
                        t.state = 'dead'
                    if t.users > 0 or t.state == 'starting':
                        continue
                    if t.state != 'ready' or t.retired or (now - t.idle_since) * 1000 >= t.keep_ms:
                        self._close(t)

    def set_keep(self, keep_ms):
        with self.lock:
            self.keep_ms = keep_ms
            for t in self.tunnels.values():
                t.keep_ms = keep_ms

    def close_tunnels(self, host_key=None):
        """Close unused tunnels now (all, or those to one server); busy ones close when their request ends."""
        with self.lock:
            for t in list(self.tunnels.values()):
                if host_key is not None and t.target['key'] != host_key:
                    continue
                if t.users <= 0 and t.state != 'starting':
                    self._close(t)
                else:
                    t.retired = True

    # ---- requests ----
    def start(self, kind, msg):
        rid = msg['id']
        with self.lock:
            if rid in self.jobs:
                raise ValueError('duplicate request id')
            job = Job(rid)
            self.jobs[rid] = job
        fn = {'run': self._run, 'sshTest': self._test, 'sshScan': self._scan}[kind]
        threading.Thread(target=self._guard, args=(fn, job, msg), daemon=True).start()

    def _guard(self, fn, job, msg):
        try:
            fn(job, msg)
        except Exception as e:  # noqa: BLE001
            if not job.cancel.is_set():
                self.reply(job.id, {'type': 'error', 'messageB64': b64(str(e))})
        finally:
            with self.lock:
                self.jobs.pop(job.id, None)
            self.drop_folder(job.id)

    def cancel(self, rid):
        with self.lock:
            self.failed.discard(rid)
            job = self.jobs.get(rid)
        if not job:
            self.drop_folder(rid)
            return
        job.cancel.set()
        p = job.proc
        if p is not None and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass
        self.reply(rid, {'type': 'cancelled'})

    def _wait_tunnel(self, job, t):
        while not t.done.wait(0.1):
            if job.cancel.is_set() or self.closed:
                return False
        return not job.cancel.is_set()

    def _ssh_error(self, rid, t):
        self.reply(rid, {'type': 'sshError', 'exitCode': t.exit, 'messageB64': b64(t.err), 'pathB64': b64(t.ssh)})

    def _run(self, job, msg):
        rid = job.id
        d = self.folder(rid)
        curl, base, hdr, body_path = curl_command(msg, d)
        timeout = (msg.get('timeoutMs') or 0) / 1000.0 or None
        keep_ms = keep_of(msg.get('keepMs'), self.keep_ms)
        cfg = msg.get('ssh')
        tun = None
        retried = False
        try:
            while True:
                argv, env, reused, log_from = base, None, False, 0
                if cfg:
                    tun, reused = self.acquire(cfg)
                    with self.lock:
                        log_from = tun.mark() if reused else 0
                    if not self._wait_tunnel(job, tun):
                        return
                    if tun.state == 'failed':
                        self._ssh_error(rid, tun)
                        return
                    if tun.state != 'ready':
                        # The tunnel closed before curl started: take another one (once)
                        if retried:
                            self._ssh_error(rid, tun)
                            return
                        retried = True
                        self.release(tun, keep_ms)
                        tun = None
                        continue
                    # -q must be first: ignore .curlrc, which could set a proxy or noproxy
                    argv = ['-q', '--socks5-hostname', '127.0.0.1:%d' % tun.port, '--noproxy', ''] + base
                    env = {k: v for k, v in os.environ.items() if k not in PROXY_ENV}
                for f in (hdr, body_path):
                    try:
                        os.remove(f)
                    except OSError:
                        pass
                started = time.time()
                proc = subprocess.Popen([curl] + argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, cwd=d, env=env)
                job.proc = proc
                if job.cancel.is_set():
                    proc.kill()
                timed_out = False
                try:
                    out, err = proc.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    proc.kill()
                    out, err = proc.communicate()
                if job.cancel.is_set():
                    return
                code = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
                if tun and not retried and not timed_out and code in (7, 97) and tun.proc.poll() is not None:
                    # The kept tunnel had closed (server restart, network change), so curl could not reach the SOCKS
                    # port and the request never left this PC: open a new connection once.
                    retried = True
                    self.release(tun, keep_ms)
                    tun = None
                    continue
                break
            elapsed = int((time.time() - started) * 1000)
            ssh_meta = None
            if tun:
                time.sleep(0.02)  # let the log reader take ssh's last line
                with self.lock:
                    log = tun.since(log_from)
                ssh_meta = {'port': tun.port, 'connectMs': 0 if reused else tun.ms, 'reused': reused,
                            'logB64': b64(log), 'pathB64': b64(tun.ssh)}
            send_result(curl, proc.returncode, timed_out, elapsed, out, err, hdr, body_path, ssh_meta, rid=rid)
        finally:
            if tun:
                self.release(tun, keep_ms)

    def _test(self, job, msg):
        # Always a new connection, so the test checks the server, user and password as they are now.
        # The tested connection then replaces older ones to the same server and stays for the next request.
        keep_ms = keep_of(msg.get('keepMs'), self.keep_ms)
        tun, _ = self.acquire(msg.get('ssh') or {}, fresh=True)
        try:
            if not self._wait_tunnel(job, tun):
                return
            if tun.state != 'ready':
                self._ssh_error(job.id, tun)
                return
            with self.lock:
                for o in self.tunnels.values():
                    if o is not tun and o.key == tun.key:
                        o.retired = True
                log = tun.since(0)
            self.reply(job.id, {'type': 'sshOk', 'connectMs': tun.ms, 'logB64': b64(log),
                                'fingerprintB64': b64(fingerprint_of(tun.ssh, tun.target)), 'pathB64': b64(tun.ssh)})
        finally:
            self.release(tun, keep_ms)

    def _scan(self, job, msg):
        keys, fp, err = scan_host_keys(msg.get('ssh') or {}, self.folder(job.id))
        self.reply(job.id, {'type': 'sshScanned', 'keysB64': b64(keys), 'fingerprintsB64': b64(fp), 'errB64': b64(err)})

    def handle(self, msg):
        t = msg.get('type')
        if t == 'config':
            self.set_keep(keep_of(msg.get('keepMs'), self.keep_ms))
            return
        if t == 'closeTunnels':
            self.close_tunnels()
            return
        rid = str(msg.get('id') or '')
        if not ID_RE.match(rid):
            raise ValueError('invalid request id: ' + rid)
        try:
            if t == 'file':
                with self.lock:
                    if rid in self.failed:
                        return
                name = str(msg.get('name', ''))
                if not NAME_RE.match(name):
                    raise ValueError('invalid file name')
                with open(os.path.join(self.folder(rid), name), 'ab') as f:
                    f.write(base64.b64decode(msg.get('data') or ''))
            elif t == 'run':
                with self.lock:
                    dropped = rid in self.failed
                    self.failed.discard(rid)
                if dropped:
                    self.drop_folder(rid)
                    return
                self.start('run', msg)
            elif t == 'cancel':
                self.cancel(rid)
            elif t in ('sshTest', 'sshScan'):
                self.start(t, msg)
            elif t == 'sshTrust':
                self.reply(rid, {'type': 'sshTrusted', 'added': trust_host_keys(msg.get('ssh') or {}, msg.get('keys'))})
            elif t == 'sshForget':
                n = forget_host(msg.get('ssh') or {})
                # The trust is gone, so the tunnels to that server close (busy ones when their request ends)
                self.close_tunnels(ssh_target(msg.get('ssh') or {})['key'])
                self.reply(rid, {'type': 'sshForgot', 'removed': n})
            elif t == 'ping':
                self.reply(rid, pong(msg, session=True))
            else:
                raise ValueError('unknown message type: %s' % t)
        except Exception as e:  # noqa: BLE001
            if t == 'file':
                with self.lock:
                    self.failed.add(rid)
                self.drop_folder(rid)
            self.reply(rid, {'type': 'error', 'messageB64': b64(str(e))})

    def shutdown(self):
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.values())
            tunnels = list(self.tunnels.values())
        for j in jobs:
            j.cancel.set()
            p = j.proc
            if p is not None and p.poll() is None:
                try:
                    p.kill()
                except OSError:
                    pass
        for t in tunnels:
            t.kill()
        for t in tunnels:
            try:
                t.proc.wait(1)
            except Exception:  # noqa: BLE001
                pass


def clear_stale():
    """A helper that was stopped by force could not close its SSH tunnels. Its work folder (ssoda-s<pid>-...) is
    left behind: when that helper is gone, stop the ssh started from that folder."""
    if os.name != 'posix':
        return  # never call os.kill(pid, 0) on Windows: there it ends the process
    try:
        tmp = tempfile.gettempdir()
        stale = []
        for name in os.listdir(tmp):
            m = re.match(r'^ssoda-s(\d+)-', name)
            if not m or int(m.group(1)) == os.getpid():
                continue
            path = os.path.join(tmp, name)
            try:
                if not os.path.isdir(path) or os.stat(path).st_uid != os.getuid():
                    continue
                os.kill(int(m.group(1)), 0)
                continue  # its helper is still running
            except ProcessLookupError:
                stale.append(path)
            except OSError:
                continue
        if not stale:
            return
        out = subprocess.run(['ps', 'axww', '-o', 'pid=,args='], stdin=subprocess.DEVNULL, capture_output=True, timeout=10).stdout
        for line in out.decode('utf-8', 'replace').splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2 or not parts[0].isdigit():
                continue
            if os.path.basename(parts[1].split(' ', 1)[0]) == 'ssh' and any(s + os.sep in parts[1] for s in stale):
                try:
                    os.kill(int(parts[0]), signal.SIGTERM)
                except OSError:
                    pass
        for s in stale:
            shutil.rmtree(s, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass


def session_main(first, work):
    sess = Session(work)
    sess.keep_ms = keep_of(first.get('keepMs'), sess.keep_ms)
    send(pong(first, session=True))
    clear_stale()
    try:
        while True:
            msg = read_msg()
            if msg is None:
                break
            sess.handle(msg)
    finally:
        sess.shutdown()


def main():
    work = None
    try:
        first = read_msg()
        if first is None:
            return
        if first.get('type') == 'ping' and first.get('session') is True:
            # The folder name carries this helper's process ID (see clear_stale)
            work = tempfile.mkdtemp(prefix='ssoda-s%d-' % os.getpid())
            session_main(first, work)
        else:
            work = tempfile.mkdtemp(prefix='ssoda-')
            one_shot(first, work)
    except Exception as e:  # noqa: BLE001
        try:
            send({'type': 'error', 'messageB64': b64(str(e))})
        except Exception:
            pass
    finally:
        if work:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
    # stdin 감시 스레드가 블록된 상태에서 인터프리터 종료 오류가 나지 않도록 즉시 종료
    sys.stdout.flush()
    os._exit(0)
