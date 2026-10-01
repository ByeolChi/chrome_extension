#!/usr/bin/env python3
# Ssoda - native messaging host for macOS / Linux
# Chrome talks to this script over stdin/stdout (4-byte length prefix + UTF-8 JSON).
# It runs curl with the argument list sent by the extension (no shell involved) and
# returns status, headers, body and terminal output.
# Only the extension ID listed in the host manifest (allowed_origins) can start this host.
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

HOST_VERSION = '1.1.0'
NAME_RE = re.compile(r'^[A-Za-z0-9_]{1,40}$')
STDIN = sys.stdin.buffer
STDOUT = sys.stdout.buffer
LOCK = threading.Lock()


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
    if custom and os.path.isfile(custom):
        return custom
    found = shutil.which('curl')
    if found:
        return found
    for p in ('/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl', '/opt/homebrew/opt/curl/bin/curl'):
        if os.path.isfile(p):
            return p
    return None


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
    started = time.time()
    proc = subprocess.Popen([curl] + argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=work)

    # 확장 프로그램이 연결을 끊으면(취소) curl 종료
    def watch_stdin():
        try:
            if not STDIN.read(1):
                proc.kill()
        except Exception:
            pass

    threading.Thread(target=watch_stdin, daemon=True).start()
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        out, err = proc.communicate()
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
    send({
        'type': 'result',
        'exitCode': proc.returncode if proc.returncode >= 0 else 128 - proc.returncode,
        'timedOut': timed_out,
        'elapsedMs': elapsed,
        'bodySize': len(body),
        'stdoutB64': b64(out),
        'stderrB64': b64(err),
        'headersB64': b64(hdr_bytes),
        'pathB64': b64(curl),
    })
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
                send({'type': 'pong', 'hostVersion': HOST_VERSION, 'platform': sys.platform,
                      'curlB64': b64(ver), 'pathB64': b64(curl or '')})
                break
            elif t == 'file':
                name = str(msg.get('name', ''))
                if not NAME_RE.match(name):
                    raise ValueError('invalid file name')
                with open(os.path.join(work, name), 'ab') as f:
                    f.write(base64.b64decode(msg.get('data') or ''))
            elif t == 'run':
                run_request(msg, work)
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
