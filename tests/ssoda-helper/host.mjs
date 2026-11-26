// ssoda cURL 실행 도우미(Native Messaging host) 시험 공용 모듈
// 도우미를 직접 띄워 Chrome 과 같은 형식(4바이트 길이 + UTF-8 JSON)으로 주고받는다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 시험할 ssoda 폴더 (기본: 저장소의 ssoda). SSODA_DIR 로 다른 사본을 지정할 수 있다 */
export const SSODA_DIR = path.resolve(process.env.SSODA_DIR || fileURLToPath(new URL('../../ssoda', import.meta.url)));
/** 도우미를 실행할 Python (py 도우미용) */
export const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
/** 이 PC 에서 시험할 도우미 종류. ps1 은 Windows PowerShell 전용이다 */
export const KINDS = process.platform === 'win32' ? ['ps1', 'py'] : ['py'];

export const importSsoda = (rel) => import(pathToFileURL(path.join(SSODA_DIR, 'js', rel)).href);

export function hostScript(kind, root = SSODA_DIR) {
  return path.join(root, 'native-host', kind === 'ps1' ? 'ssoda-host.ps1' : 'ssoda-host.py');
}

/**
 * 도우미 하나를 띄운다.
 *  script: 실행할 도우미 파일 (복사본을 쓸 때), env: 환경 변수,
 *  onMessage(msg) / onExit(): 메시지가 올 때마다 / 도우미가 끝났을 때
 * 반환: { send(msg), until(types, ms), close(), kill(), messages }
 */
export function startHost(kind, { script = hostScript(kind), env = process.env, onMessage = null, onExit = null } = {}) {
  const cp = kind === 'ps1'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'chrome-extension://test/'], { windowsHide: true, env })
    : spawn(PYTHON, ['-I', script, 'chrome-extension://test/'], { windowsHide: true, env });
  const messages = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  let exited = false;
  const wake = () => waiters.splice(0).forEach((f) => f());
  const ended = () => {
    if (exited) return;
    exited = true;
    wake();
    if (onExit) onExit();
  };
  cp.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      messages.push(msg);
      if (onMessage) onMessage(msg);
      wake();
    }
  });
  cp.stderr.on('data', () => {});
  cp.on('exit', ended);
  cp.on('error', ended); // powershell.exe / python 을 찾지 못한 경우
  const send = (m) => {
    const body = Buffer.from(JSON.stringify(m), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    try {
      cp.stdin.write(Buffer.concat([head, body]));
    } catch (e) {
      /* 이미 끝남 */
    }
  };
  // 주어진 종류의 메시지가 오거나 도우미가 끝날 때까지 기다린다 (시간이 지나면 { type: 'timeout' } 을 붙여 돌려준다)
  const until = (types, ms = 60000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve([...messages, { type: 'timeout' }]), ms);
    const check = () => {
      if (exited || messages.some((m) => types.includes(m.type))) {
        clearTimeout(timer);
        resolve(messages);
      } else waiters.push(check);
    };
    check();
  });
  const close = () => {
    try {
      cp.stdin.end();
    } catch (e) {
      /* noop */
    }
  };
  // 도우미가 갑자기 끝난 것처럼 (작업 관리자에서 끝내기)
  const kill = () => {
    try {
      cp.kill();
    } catch (e) {
      /* noop */
    }
  };
  return { send, until, close, kill, messages };
}

export const b64text = (s) => Buffer.from(s || '', 'base64').toString('utf8');

/** PASS/FAIL 출력과 종료 코드 */
export function reporter(title) {
  const results = [];
  return {
    check(name, ok, info = '') {
      results.push({ name, ok: !!ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${title}: ${results.length - failed}/${results.length} 통과`);
      return failed ? 1 : 0;
    },
  };
}
