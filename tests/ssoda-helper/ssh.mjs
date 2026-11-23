// ssoda SSH 터널 시험 — 실제 ssh + 시험용 SSH 서버(paramiko) + 실제 도우미
// 실행: 저장소 최상위에서 node tests/ssoda-helper/ssh.mjs
//   paramiko 가 있는 Python 이 필요하다 (SSH_TEST_PYTHON=<python 실행 파일>, 없으면 PYTHON). tests/ssoda-helper/README.md 참고
// 서버 키 파일 경로에 공백이 있어도(macOS 기본 설치 경로, "Hong Gildong" 같은 Windows 사용자 폴더) 저장한 키를 읽고 접속하는지,
// 그리고 터널로 요청이 서버 너머까지 가는지 확인한다.
// 준비가 안 되면(paramiko·ssh 없음) 종료 코드 2.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SSODA_DIR, startHost, b64text, reporter, hostScript } from './host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PY = process.env.SSH_TEST_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const WIN_OPENSSH = 'C:\\Windows\\System32\\OpenSSH';
const sshTool = (name) => (process.platform === 'win32' && fs.existsSync(path.join(WIN_OPENSSH, name + '.exe')) ? path.join(WIN_OPENSSH, name + '.exe') : name);

function notReady(msg) {
  console.log(`준비 안 됨: ${msg}`);
  process.exit(2);
}
if (spawnSync(SERVER_PY, ['-c', 'import paramiko'], { encoding: 'utf8' }).status !== 0) {
  notReady(`${SERVER_PY} 에 paramiko 가 없습니다. 예: python -m venv <폴더> && <폴더>/Scripts/pip install paramiko (macOS·Linux 는 <폴더>/bin/pip) 후 SSH_TEST_PYTHON=<폴더>/Scripts/python 으로 실행`);
}
for (const tool of ['ssh', 'ssh-keygen']) {
  if (spawnSync(sshTool(tool), ['-V'], { encoding: 'utf8' }).error) notReady(`${tool} 을(를) 찾을 수 없습니다 (OpenSSH 클라이언트 필요)`);
}

const { check, finish } = reporter('SSH 터널 시험');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-ssh-'));
const USER = 'tester';
const PASSWORD = 'p@ss w0rd"\'';   // 공백·따옴표가 든 비밀번호도 SSH_ASKPASS 로 그대로 가는지

// 호스트 키 + 시험용 SSH 서버
spawnSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'hostkey')]);
const srv = spawn(SERVER_PY, ['-I', path.join(HERE, 'ssh_server.py'), '0', path.join(tmp, 'hostkey'), USER, PASSWORD], { windowsHide: true });
const srvLog = [];
const SSH_PORT = await new Promise((resolve, reject) => {
  srv.stdout.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/).filter(Boolean)) {
      srvLog.push(l);
      const m = l.match(/^READY (\d+)/);
      if (m) resolve(+m[1]);
    }
  });
  srv.stderr.on('data', (d) => srvLog.push('ERR ' + d));
  setTimeout(() => reject(new Error('시험용 SSH 서버가 뜨지 않았습니다: ' + srvLog.join('\n'))), 20000);
});

// 터널 너머의 대상 서버
const target = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello-through-ssh ' + req.url);
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const TPORT = target.address().port;

async function one(kind, script, env, msg) {
  const h = startHost(kind, { script, env });
  h.send(msg);
  const msgs = await h.until(['end', 'error', 'sshError', 'sshOk', 'sshScanned', 'sshTrusted'], 60000);
  h.close();
  return msgs;
}

// 서버 키 가져오기 → 저장(신뢰) → 접속 시험 → (fullRun 이면) 터널로 요청
async function scenario(label, kind, script, env, { fullRun, allowAuthFailure = false }) {
  const ssh = { host: '127.0.0.1', port: SSH_PORT, user: USER, password: PASSWORD };
  const scan = (await one(kind, script, env, { type: 'sshScan', ssh })).find((m) => m.type === 'sshScanned');
  const keys = b64text(scan && scan.keysB64);
  const trusted = (await one(kind, script, env, { type: 'sshTrust', ssh, keys })).find((m) => m.type === 'sshTrusted');
  const test = await one(kind, script, env, { type: 'sshTest', ssh });
  const ok = test.find((m) => m.type === 'sshOk');
  const err = test.find((m) => m.type === 'sshError' || m.type === 'error');
  const log = err ? b64text(err.messageB64) : '';
  const keyUnknown = /host key is known for .* you have requested strict checking|No \S+ host key is known|Host key verification failed/i.test(log);
  const authOnly = !ok && !keyUnknown && /Permission denied/i.test(log);
  const verdict = ok ? '접속 성공' : keyUnknown ? '저장한 서버 키를 못 찾음' : authOnly ? '서버 키 확인 통과, 로그인 실패' : '실패: ' + log.split(/\r?\n/).filter(Boolean).slice(-1)[0];
  check(`[${label}] 서버 키 저장 후 접속${allowAuthFailure ? ' (서버 키 확인까지)' : ''}`,
    keys && trusted && trusted.added > 0 && (ok || (allowAuthFailure && authOnly)), `키 ${trusted ? trusted.added : 0}개 저장 → ${verdict}`);
  if (fullRun && ok) {
    const run = await one(kind, script, env, {
      type: 'run', ssh, timeoutMs: 30000, curlPath: '', files: [],
      args: ['-sS', '--proto', '=http,https', '--proto-redir', '=http,https', '-D', '__CS_HDR__', '-o', '__CS_BODY__', '-w', '\\n__CSW__%{http_code}\\n', '--url', `http://127.0.0.1:${TPORT}/via-ssh`],
    });
    const body = Buffer.concat(run.filter((m) => m.type === 'body').map((m) => Buffer.from(m.data, 'base64'))).toString();
    const res = run.find((m) => m.type === 'result');
    check(`[${label}] 터널로 보낸 요청이 서버 너머 주소에 도착`, res && res.exitCode === 0 && body.trim() === 'hello-through-ssh /via-ssh', `exit ${res && res.exitCode}, 응답 "${body.trim()}"`);
  }
}

// 사용자 폴더 이름에 공백이 있는 것처럼 LOCALAPPDATA·TEMP 를 바꾼 환경 (Windows 도우미의 known_hosts·임시 폴더 위치)
function winEnv(name, spaced) {
  const base = path.join(tmp, name, spaced ? 'Hong Gildong' : 'user');
  const env = { ...process.env, LOCALAPPDATA: path.join(base, 'AppData', 'Local'), TEMP: path.join(base, 'Temp'), TMP: path.join(base, 'Temp') };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  fs.mkdirSync(env.TEMP, { recursive: true });
  return env;
}
// macOS 기본 설치 경로처럼 "Application Support" 안에 py 도우미를 둔다 (known_hosts 는 도우미 옆에 생긴다)
function macLikeHost() {
  const dir = path.join(tmp, 'mac', 'Library', 'Application Support', 'Ssoda');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'ssoda-host.py');
  fs.copyFileSync(hostScript('py'), dst);
  return dst;
}

console.log(`시험할 ssoda: ${SSODA_DIR}`);
console.log(`ssh: ${(spawnSync(sshTool('ssh'), ['-V'], { encoding: 'utf8' }).stderr || '').trim()}, 시험용 서버 Python: ${SERVER_PY}\n`);
try {
  if (process.platform === 'win32') {
    await scenario('ps1, 경로에 공백', 'ps1', hostScript('ps1'), winEnv('ps1-spaced', true), { fullRun: true });
    await scenario('ps1, 공백 없는 경로', 'ps1', hostScript('ps1'), winEnv('ps1-plain', false), { fullRun: true });
  }
  // Windows 에서 py 도우미는 PATH 의 ssh 와 sh 스크립트(SSH_ASKPASS)를 쓰므로 로그인은 환경에 따라 다를 수 있다
  await scenario('py, "Application Support" 경로', 'py', macLikeHost(), process.env, { fullRun: true, allowAuthFailure: process.platform === 'win32' });
} finally {
  srv.kill();
  target.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('시험용 서버 기록: ' + srvLog.filter((l) => /^(AUTH|FORWARD)/.test(l)).join(' / '));
process.exit(finish());
