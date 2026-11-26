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

// 호스트 키 + 시험용 SSH 서버 (port 0: 빈 포트. 다시 띄울 때는 같은 포트·같은 키)
spawnSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'hostkey')]);
const srvLog = [];
function startServer(port) {
  const proc = spawn(SERVER_PY, ['-I', path.join(HERE, 'ssh_server.py'), String(port), path.join(tmp, 'hostkey'), USER, PASSWORD], { windowsHide: true });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      for (const l of String(d).split(/\r?\n/).filter(Boolean)) {
        srvLog.push(l);
        const m = l.match(/^READY (\d+)/);
        if (m) resolve({ proc, port: +m[1] });
      }
    });
    proc.stderr.on('data', (d) => srvLog.push('ERR ' + d));
    setTimeout(() => reject(new Error('시험용 SSH 서버가 뜨지 않았습니다: ' + srvLog.join('\n'))), 20000);
  });
}
let srv = await startServer(0);
const SSH_PORT = srv.port;

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

/* ---------------- 도우미 2.0: 열어 둔 SSH 연결 다시 쓰기 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auths = () => srvLog.filter((l) => /^AUTH ok/.test(l)).length;

// 지금 떠 있는 ssh 중 명령줄에 text 가 든 것의 수 (도우미가 연 터널: known_hosts 경로가 시험 폴더 안)
function sshProcsWith(text) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'ssh.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' });
    return (r.stdout || '').split(/\r?\n/).filter((l) => l.toLowerCase().includes(text.toLowerCase())).length;
  }
  const r = spawnSync('ps', ['axww', '-o', 'args='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => /(^|\/)ssh /.test(l) && l.includes(text)).length;
}

// 켜 둔 도우미 하나 (요청 번호로 답을 기다림)
function sessionHost(kind, script, env) {
  const msgs = [];
  const waiters = [];
  let exited = false;
  const h = startHost(kind, {
    script,
    env,
    onMessage: (m) => {
      msgs.push(m);
      waiters.splice(0).forEach((f) => f());
    },
    onExit: () => {
      exited = true;
      waiters.splice(0).forEach((f) => f());
    },
  });
  const wait = (pred, ms = 60000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const look = () => {
      const m = msgs.find(pred);
      if (m || exited) {
        clearTimeout(timer);
        resolve(m || null);
      } else waiters.push(look);
    };
    look();
  });
  const bodyOf = (id) => Buffer.concat(msgs.filter((m) => m.id === id && m.type === 'body').map((m) => Buffer.from(m.data, 'base64'))).toString('utf8');
  return { ...h, msgs, wait, bodyOf, get exited() { return exited; } };
}

async function sessionScenario(label, kind, script, env, { allowAuthFailure = false } = {}) {
  const ssh = { host: '127.0.0.1', port: SSH_PORT, user: USER, password: PASSWORD };
  const s = sessionHost(kind, script, env);
  s.send({ type: 'ping', session: true, curlPath: '', keepMs: 60000 });
  await s.wait((m) => m.type === 'pong');
  let n = 0;
  const run = async (extra = {}) => {
    const id = `${kind}${++n}`;
    const t0 = performance.now();
    s.send({
      type: 'run', id, ssh, timeoutMs: 30000, curlPath: '', files: [], keepMs: 60000, ...extra,
      args: ['-sS', '-D', '__CS_HDR__', '-o', '__CS_BODY__', '-w', '\\n__CSW__%{http_code}\\n', '--url', `http://127.0.0.1:${TPORT}/via-ssh/${id}`],
    });
    const end = await s.wait((m) => m.id === id && ['end', 'error', 'sshError'].includes(m.type));
    const res = s.msgs.find((m) => m.id === id && m.type === 'result');
    return {
      ms: Math.round(performance.now() - t0),
      ok: !!res && res.exitCode === 0 && s.bodyOf(id).trim() === `hello-through-ssh /via-ssh/${id}`,
      reused: !!(res && res.ssh && res.ssh.reused),
      connectMs: res && res.ssh ? res.ssh.connectMs : null,
      err: end ? `${end.type} ${b64text(end.messageB64 || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''}` : '응답 없음',
    };
  };
  try {
    let a0 = auths();
    const r1 = await run();
    if (!r1.ok && allowAuthFailure && /Permission denied/.test(r1.err)) {
      console.log(`(${label}: 이 PC 에서는 로그인이 안 되어 SSH 연결 다시 쓰기 시험을 건너뜁니다 — ${r1.err})`);
      return;
    }
    const r2 = await run();
    check(`[${label}] 같은 서버로 보낸 두 번째 요청은 열어 둔 연결을 씀 (로그인 한 번)`,
      r1.ok && !r1.reused && r1.connectMs > 0 && r2.ok && r2.reused && r2.connectMs === 0 && auths() - a0 === 1,
      `첫 요청 ${r1.ms}ms(접속 ${r1.connectMs}ms) · 둘째 ${r2.ms}ms(다시 씀=${r2.reused}) · 로그인 ${auths() - a0}번${r1.ok ? '' : ' · ' + r1.err}`);

    a0 = auths();
    const [r3, r4] = await Promise.all([run(), run()]);
    check(`[${label}] 동시에 보낸 두 요청도 열어 둔 연결 하나로`, r3.ok && r4.ok && r3.reused && r4.reused && auths() === a0,
      `${r3.ms}ms·${r4.ms}ms, 새 로그인 ${auths() - a0}번`);

    // 유지 시간을 줄이면(설정 바꿈) 쓰지 않는 연결은 그만큼 뒤에 닫힘
    s.send({ type: 'config', keepMs: 1500 });
    await sleep(3200);
    a0 = auths();
    const r5 = await run();
    check(`[${label}] 유지 시간이 지나면 연결을 닫고, 다음 요청은 새로 접속`, r5.ok && !r5.reused && auths() - a0 === 1,
      `다시 씀=${r5.reused}, 새 로그인 ${auths() - a0}번`);

    // 요청에 유지 시간 0: 끝나자마자 닫음 (설정에서 0 으로 끈 경우)
    const r6 = await run({ keepMs: 0 });
    await sleep(1500);
    a0 = auths();
    const r7 = await run();
    check(`[${label}] 유지 시간 0 이면 요청이 끝나자마자 연결을 닫음`, r6.ok && r6.reused && r7.ok && !r7.reused && auths() - a0 === 1,
      `0 으로 보낸 요청 다시 씀=${r6.reused}, 다음 요청 다시 씀=${r7.reused}, 새 로그인 ${auths() - a0}번`);

    // 연결 테스트는 늘 새로 접속하고(지금의 비밀번호로 확인), 그 연결을 다음 요청이 씀
    a0 = auths();
    s.send({ type: 'sshTest', id: `${kind}-test`, ssh, keepMs: 60000 });
    const ok = await s.wait((m) => m.id === `${kind}-test`);
    const a1 = auths();
    const r8 = await run();
    check(`[${label}] 연결 테스트는 새로 접속하고, 그 연결을 다음 요청이 다시 씀`, ok && ok.type === 'sshOk' && a1 - a0 === 1 && r8.ok && r8.reused && auths() === a1,
      `${ok ? ok.type : '응답 없음'}, 테스트 로그인 ${a1 - a0}번, 다음 요청 다시 씀=${r8.reused}`);

    // 서버가 다시 시작되면(열어 둔 연결이 끊김) 다음 요청은 새로 접속해 그대로 성공
    srv.proc.kill();
    await sleep(800);
    srv = await startServer(SSH_PORT);
    await sleep(500);
    a0 = auths();
    const r9 = await run();
    check(`[${label}] 서버가 다시 시작되어 끊긴 연결은 다음 요청 때 새로 접속 (요청은 그대로 성공)`, r9.ok && !r9.reused && auths() - a0 === 1,
      `${r9.ok ? '성공' : r9.err}, 다시 씀=${r9.reused}, 새 로그인 ${auths() - a0}번`);

    // 서버 키 초기화: 그 서버로 열어 둔 연결도 닫혀, 다음 요청은 서버 키 확인부터 다시
    s.send({ type: 'sshForget', id: `${kind}-forget`, ssh });
    await s.wait((m) => m.id === `${kind}-forget`);
    const r10 = await run();
    s.send({ type: 'sshScan', id: `${kind}-scan`, ssh });
    const scan = await s.wait((m) => m.id === `${kind}-scan`);
    s.send({ type: 'sshTrust', id: `${kind}-trust`, ssh, keys: b64text(scan && scan.keysB64) });
    const trusted = await s.wait((m) => m.id === `${kind}-trust`);
    const r11 = await run();
    check(`[${label}] 서버 키를 초기화하면 열어 둔 연결도 닫히고, 다시 신뢰한 뒤에는 새로 접속`,
      !r10.ok && /host key/i.test(r10.err) && trusted && trusted.added > 0 && r11.ok && !r11.reused,
      `초기화 뒤 요청: ${r10.ok ? '성공(열어 둔 연결을 씀)' : r10.err} → 다시 신뢰 ${trusted ? trusted.added : 0}개 → ${r11.ok ? '성공' : r11.err}`);

    // 도우미가 끝나면(확장이 연결을 끊음) 열어 둔 ssh 도 끝남
    const before = sshProcsWith(tmp);
    s.close();
    for (let i = 0; i < 50 && !s.exited; i++) await sleep(100);
    await sleep(500);
    const afterClose = sshProcsWith(tmp);
    check(`[${label}] 도우미가 끝나면 열어 둔 SSH 연결도 닫힘`, before >= 1 && afterClose === 0, `끝나기 전 ssh ${before}개 → 뒤 ${afterClose}개`);
  } finally {
    s.close();
  }
}

console.log(`시험할 ssoda: ${SSODA_DIR}`);
console.log(`ssh: ${(spawnSync(sshTool('ssh'), ['-V'], { encoding: 'utf8' }).stderr || '').trim()}, 시험용 서버 Python: ${SERVER_PY}\n`);
try {
  if (process.platform === 'win32') {
    const spaced = winEnv('ps1-spaced', true);
    await scenario('ps1, 경로에 공백', 'ps1', hostScript('ps1'), spaced, { fullRun: true });
    await scenario('ps1, 공백 없는 경로', 'ps1', hostScript('ps1'), winEnv('ps1-plain', false), { fullRun: true });
    await sessionScenario('ps1 켜 둔 도우미', 'ps1', hostScript('ps1'), spaced);
  }
  // Windows 에서 py 도우미는 PATH 의 ssh 와 sh 스크립트(SSH_ASKPASS)를 쓰므로 로그인은 환경에 따라 다를 수 있다
  const macHost = macLikeHost();
  await scenario('py, "Application Support" 경로', 'py', macHost, process.env, { fullRun: true, allowAuthFailure: process.platform === 'win32' });
  await sessionScenario('py 켜 둔 도우미', 'py', macHost, process.env, { allowAuthFailure: process.platform === 'win32' });
} finally {
  srv.proc.kill();
  target.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('시험용 서버 기록: ' + srvLog.filter((l) => /^(AUTH|FORWARD)/.test(l)).join(' / '));
process.exit(finish());
