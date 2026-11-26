// PC 전체 도우미 등록 스크립트(scripts/install-ssoda-helper-machine.ps1) 시험. Windows 전용
// 레지스트리는 건드리지 않도록 -Browsers @() 로 임시 폴더에 설치하고, 만든 도우미를 브라우저와 같은 방식
// (cmd.exe /d /c <bat> <origin> --parent-window=0)으로 띄워 ping → pong 을 확인한다.
// 인터넷에서 받은 zip 을 푼 것처럼 원본에 Zone.Identifier 표시를 붙여, 설치본에서는 지워지는지도 본다.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSODA_DIR, hostScript, importSsoda, reporter } from './host.mjs';

if (process.platform !== 'win32') {
  console.log('Windows 전용 시험이라 건너뜁니다.');
  process.exit(2);
}

const SCRIPT = fileURLToPath(new URL('../../scripts/install-ssoda-helper-machine.ps1', import.meta.url));
const { LATEST_HOST_VERSION } = await importSsoda('curl-runner.js');
const { check, finish } = reporter('PC 전체 등록 스크립트');

// 확장 ID = manifest 의 key(공개 키) SHA-256 앞 32자리 16진수를 a~p 로 바꾼 것
const key = JSON.parse(fs.readFileSync(path.join(SSODA_DIR, 'manifest.json'), 'utf8')).key;
const extId = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const quote = (s) => `'${s.replace(/'/g, "''")}'`;

// 브라우저처럼 cmd 로 bat 을 띄워 ping 을 보내고 첫 응답을 받는다
function ping(bat) {
  const cp = spawn('cmd.exe', ['/d', '/c', bat, `chrome-extension://${extId}/`, '--parent-window=0'], { windowsHide: true });
  let buf = Buffer.alloc(0);
  return new Promise((resolve) => {
    const done = (msg) => {
      clearTimeout(timer);
      try {
        cp.stdin.end();
      } catch (e) {
        /* 이미 끝남 */
      }
      setTimeout(() => {
        try {
          cp.kill();
        } catch (e) {
          /* noop */
        }
        resolve(msg);
      }, 300);
    };
    const timer = setTimeout(() => done(null), 30000);
    cp.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) done(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')));
    });
    cp.on('exit', () => setTimeout(() => done(null), 500));
    const body = Buffer.from(JSON.stringify({ type: 'ping' }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    cp.stdin.write(Buffer.concat([head, body]));
  });
}

// 브라우저처럼 cmd 로 bat 을 띄워 켜 둔 도우미로 요청 두 개를 보내고, 입력을 닫아 끝나는지 본다
async function sessionViaBat(bat) {
  const server = http.createServer((req, res) => res.end('ok:' + req.url.slice(1)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cp = spawn('cmd.exe', ['/d', '/c', bat, `chrome-extension://${extId}/`, '--parent-window=0'], { windowsHide: true });
  const msgs = [];
  let buf = Buffer.alloc(0);
  let exited = false;
  cp.on('exit', () => (exited = true));
  cp.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      msgs.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
    }
  });
  const send = (m) => {
    const body = Buffer.from(JSON.stringify(m));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    cp.stdin.write(Buffer.concat([head, body]));
  };
  const waitFor = async (pred, ms) => {
    for (let t = 0; t < ms; t += 50) {
      if (msgs.some(pred) || exited) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return msgs.find(pred) || null;
  };
  const out = { session: false, bodies: [], exitMs: null };
  try {
    send({ type: 'ping', session: true, curlPath: '' });
    const pong = await waitFor((m) => m.type === 'pong', 30000);
    out.session = !!(pong && pong.session);
    for (const id of ['1', '2']) {
      send({ type: 'run', id, files: [], timeoutMs: 20000, curlPath: '', args: ['-sS', '-D', '__CS_HDR__', '-o', '__CS_BODY__', '--url', `http://127.0.0.1:${port}/${id}`] });
      await waitFor((m) => m.id === id && (m.type === 'end' || m.type === 'error'), 20000);
      out.bodies.push(Buffer.concat(msgs.filter((m) => m.id === id && m.type === 'body').map((m) => Buffer.from(m.data, 'base64'))).toString());
    }
    const t0 = performance.now();
    cp.stdin.end();
    for (let t = 0; t < 8000 && !exited; t += 50) await new Promise((r) => setTimeout(r, 50));
    if (exited) out.exitMs = performance.now() - t0;
  } finally {
    if (!exited) cp.kill();
    server.close();
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-machine-'));
try {
  // 압축을 푼 ssoda 폴더 흉내 (도우미 원본에 인터넷 표시를 붙임)
  const src = path.join(tmp, 'ssoda');
  const srcHost = path.join(src, 'native-host', 'ssoda-host.ps1');
  fs.mkdirSync(path.dirname(srcHost), { recursive: true });
  fs.copyFileSync(hostScript('ps1'), srcHost);
  fs.writeFileSync(`${srcHost}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  const dest = path.join(tmp, 'Program Files', 'Ssoda', 'helper'); // 기본 위치처럼 공백이 든 경로

  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `& ${quote(SCRIPT)} -SsodaDir ${quote(src)} -Dest ${quote(dest)} -Browsers @()`], { encoding: 'utf8' });
  check('스크립트가 오류 없이 끝남', r.status === 0, `exit ${r.status} ${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-2).join(' | ')}`);

  const files = fs.existsSync(dest) ? fs.readdirSync(dest).sort() : [];
  check('도우미 파일 세 개를 만듦', files.join(',') === 'com.ssoda.runner.json,ssoda-host.bat,ssoda-host.ps1', files.join(', '));

  const destHost = path.join(dest, 'ssoda-host.ps1');
  check('ssoda-host.ps1 이 저장소 원본과 같음', fs.existsSync(destHost) && fs.readFileSync(destHost).equals(fs.readFileSync(hostScript('ps1'))));
  check('원본의 인터넷 표시(Zone.Identifier)를 설치본에서 지움',
    fs.existsSync(`${srcHost}:Zone.Identifier`) && fs.existsSync(destHost) && !fs.existsSync(`${destHost}:Zone.Identifier`));

  // 사용자 설치 파일(install-windows.bat.tpl)이 쓰는 bat 과 같아야 한다
  const tpl = fs.readFileSync(path.join(SSODA_DIR, 'native-host', 'install-windows.bat.tpl'), 'utf8');
  const m = tpl.match(/\$bat = "(.*)"\r?$/m);
  const expectedBat = m ? m[1].replace(/`r`n/g, '\r\n').replace(/`"/g, '"') : null;
  const bat = path.join(dest, 'ssoda-host.bat');
  check('ssoda-host.bat 이 사용자 설치 파일이 만드는 것과 같음', expectedBat && fs.existsSync(bat) && fs.readFileSync(bat, 'latin1') === expectedBat);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dest, 'com.ssoda.runner.json'), 'utf8'));
  } catch (e) {
    /* 아래에서 실패로 표시 */
  }
  check(`호스트 manifest: 이름·실행 파일·허용 확장(${extId})`,
    manifest && manifest.name === 'com.ssoda.runner' && manifest.path === 'ssoda-host.bat' && manifest.type === 'stdio'
      && JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${extId}/`]),
    JSON.stringify(manifest));

  const pong = fs.existsSync(bat) ? await ping(bat) : null;
  check(`브라우저처럼 bat 으로 띄운 도우미가 응답함 (v${LATEST_HOST_VERSION})`, pong && pong.type === 'pong' && pong.hostVersion === LATEST_HOST_VERSION,
    pong ? `${pong.type} v${pong.hostVersion}` : '응답 없음');

  // 도우미 2.0: bat(cmd.exe) 으로 띄워도 켜 둔 채 여러 요청을 처리하고, 연결을 끊으면 끝나는지
  if (fs.existsSync(bat)) {
    const r = await sessionViaBat(bat);
    check('bat 으로 띄운 도우미도 켜 둔 채 요청 둘을 처리하고, 연결을 끊으면 끝남',
      r.session && r.bodies.join(',') === 'ok:1,ok:2' && r.exitMs !== null,
      `session=${r.session}, 응답 ${JSON.stringify(r.bodies)}, ${r.exitMs !== null ? Math.round(r.exitMs) + 'ms 만에 끝남' : '끝나지 않음'}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(finish());
