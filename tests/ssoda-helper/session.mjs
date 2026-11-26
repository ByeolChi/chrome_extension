// ssoda cURL 실행 도우미 2.0 시험 — 켜 둔 도우미 하나로 여러 요청 (실제 도우미 + 실제 curl, SSH 서버 없이)
// 실행: 저장소 최상위에서 node tests/ssoda-helper/session.mjs   (다른 사본: SSODA_DIR=<ssoda 폴더>)
//  - 첫 메시지 {type:'ping', session:true} 에 session:true 로 답하고 끝나지 않는지
//  - 요청 번호(id)로 동시에 보낸 요청이 섞이지 않고, 먼저 끝난 요청이 먼저 오는지 (요청마다 따로 받은 파일)
//  - 취소(cancel)한 요청만 멈추고, 요청 하나의 오류가 다른 요청을 막지 않는지, 파일을 못 받은 요청은 보내지 않는지
//  - 서버 키 가져오기(ssh-keyscan)가 기다리는 동안에도 다른 요청이 나가는지
//  - 확장이 연결을 끊으면 받는 중이던 curl 까지 멈추고 끝나는지
//  - 요청마다 새로 띄우는 예전 방식보다 빠른지 (가운데값)
//  - (Windows ps1) 강제로 끝난 도우미가 남긴 작업 폴더의 ssh 를 다음 도우미가 정리하는지
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SSODA_DIR, KINDS, startHost, b64text, reporter, hostScript, importSsoda } from './host.mjs';

const { check, finish } = reporter('도우미 2.0 (켜 둔 도우미) 시험');
const { LATEST_HOST_VERSION } = await importSsoda('curl-runner.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-session-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 시험 서버 ---------------- */
const seen = [];
const closed = new Set(); // 응답 전에 연결이 끊긴 요청 (curl 이 멈춤)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const tag = new URL(req.url, 'http://x').searchParams.get('tag') || '';
    seen.push({ path: req.url.split('?')[0], tag, body });
    res.on('close', () => { if (!res.writableEnded) closed.add(tag); });
    if (req.url.startsWith('/slow')) return setTimeout(() => res.end('slow:' + body), 1200);
    if (req.url.startsWith('/hang')) return; // 끝까지 답하지 않음
    res.end('fast:' + body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const url = (p, tag) => `http://127.0.0.1:${PORT}${p}?tag=${tag}`;
const TAIL = ['-D', '__CS_HDR__', '-o', '__CS_BODY__', '-w', '\\n__CSW__%{http_code}\\n'];
const runMsg = (id, p, tag, extra = {}) => ({ type: 'run', id, args: ['-sS', '--data-binary', '@__CS_FILE_0__', ...TAIL, '--url', url(p, tag)], files: ['FILE_0'], timeoutMs: 20000, curlPath: '', ...extra });

// SSH 배너를 보내지 않고 2초 뒤 끊는 서버 (ssh-keyscan 이 기다리게)
const silent = net.createServer((s) => setTimeout(() => s.destroy(), 2000));
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const SILENT_PORT = silent.address().port;

/* ---------------- 도우미 하나 (메시지를 조건으로 기다림) ---------------- */
function session(kind, { env } = {}) {
  const msgs = [];
  const waiters = [];
  let exited = false;
  const h = startHost(kind, {
    env,
    onMessage: (m) => {
      m.at = performance.now();
      msgs.push(m);
      waiters.splice(0).forEach((f) => f());
    },
    onExit: () => {
      exited = true;
      waiters.splice(0).forEach((f) => f());
    },
  });
  const wait = (pred, ms = 30000) => new Promise((resolve) => {
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
  const waitExit = (ms) => new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => (exited ? resolve(performance.now() - t0) : performance.now() - t0 > ms ? resolve(null) : setTimeout(tick, 50));
    tick();
  });
  const of = (id) => msgs.filter((m) => m.id === id);
  const bodyOf = (id) => Buffer.concat(of(id).filter((m) => m.type === 'body').map((m) => Buffer.from(m.data, 'base64'))).toString('utf8');
  return { ...h, msgs, wait, waitExit, of, bodyOf, get exited() { return exited; } };
}
const sendFile = (s, id, text) => s.send({ type: 'file', id, name: 'FILE_0', data: Buffer.from(text).toString('base64') });

// 요청 하나를 보내고 끝(end/error) 메시지를 기다림
async function one(s, id, p, tag, text) {
  sendFile(s, id, text);
  s.send(runMsg(id, p, tag));
  return s.wait((m) => m.id === id && ['end', 'error', 'sshError'].includes(m.type), 30000);
}

console.log(`시험할 ssoda: ${SSODA_DIR}`);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const kind of KINDS) {
  console.log(`\n=== ${kind} 도우미 (${path.basename(hostScript(kind))})`);
  const s = session(kind);
  s.send({ type: 'ping', session: true, curlPath: '', keepMs: 600000 });
  const pong = await s.wait((m) => m.type === 'pong' || m.type === 'error', 30000);
  await sleep(800);
  check(`[${kind}] ping{session:true} 에 session:true 로 답하고 끝나지 않음 (v${LATEST_HOST_VERSION})`,
    pong && pong.type === 'pong' && pong.session === true && pong.hostVersion === LATEST_HOST_VERSION && !s.exited,
    pong ? `${pong.type} v${pong.hostVersion} session=${pong.session} 끝남=${s.exited}` : '응답 없음');

  // 동시에 보낸 두 요청: 느린 A, 빠른 B (같은 이름의 파일 FILE_0 을 요청마다 따로 받음)
  seen.length = 0;
  sendFile(s, 'a1', 'body-A');
  s.send(runMsg('a1', '/slow', 'A'));
  sendFile(s, 'b1', 'body-B');
  s.send(runMsg('b1', '/fast', 'B'));
  const endA = await s.wait((m) => m.id === 'a1' && m.type === 'end');
  const endB = await s.wait((m) => m.id === 'b1' && m.type === 'end');
  const resA = s.of('a1').find((m) => m.type === 'result');
  check(`[${kind}] 동시에 보낸 두 요청: 빠른 요청이 먼저 오고, 요청마다 자기 파일·응답`,
    endA && endB && endB.at < endA.at && s.bodyOf('a1') === 'slow:body-A' && s.bodyOf('b1') === 'fast:body-B' && resA && resA.exitCode === 0,
    `B 가 ${endA && endB ? Math.round(endA.at - endB.at) : '?'}ms 먼저, A="${s.bodyOf('a1')}", B="${s.bodyOf('b1')}"`);

  // 취소: 답이 없는 요청 C 를 취소하면 C 만 멈춤
  sendFile(s, 'c1', 'body-C');
  s.send(runMsg('c1', '/hang', 'C'));
  await sleep(700);
  const t0 = performance.now();
  s.send({ type: 'cancel', id: 'c1' });
  const cancelled = await s.wait((m) => m.id === 'c1' && m.type === 'cancelled', 10000);
  await sleep(300);
  const d = await one(s, 'd1', '/fast', 'D', 'body-D');
  check(`[${kind}] 취소한 요청만 멈추고(curl 끊김) 다음 요청은 그대로`,
    cancelled && closed.has('C') && d && d.type === 'end' && s.bodyOf('d1') === 'fast:body-D' && !s.of('c1').some((m) => m.type === 'result'),
    `취소 ${cancelled ? Math.round(cancelled.at - t0) + 'ms' : '응답 없음'}, 서버에서 끊김=${closed.has('C')}, D="${s.bodyOf('d1')}"`);

  // 요청 하나의 오류(막힌 인자)는 그 요청만 실패
  s.send({ type: 'run', id: 'e1', args: ['-sS', '-H', '@' + path.join(tmp, 'x.txt'), ...TAIL, '--url', url('/fast', 'E')], files: [], timeoutMs: 20000, curlPath: '' });
  const e1 = await s.wait((m) => m.id === 'e1', 10000);
  const f1 = await one(s, 'f1', '/fast', 'F', 'body-F');
  check(`[${kind}] 막힌 인자는 그 요청만 오류, 도우미는 계속`, e1 && e1.type === 'error' && /local file/.test(b64text(e1.messageB64)) && f1 && f1.type === 'end',
    e1 ? `${e1.type}: ${b64text(e1.messageB64)}` : '응답 없음');

  // 파일을 받지 못한 요청은 보내지 않음 (지금까지 받은 내용으로 반쯤 보내지 않게)
  seen.length = 0;
  s.send({ type: 'file', id: 'g1', name: 'bad/name', data: '' });
  s.send(runMsg('g1', '/fast', 'G'));
  const g1 = await s.wait((m) => m.id === 'g1' && m.type === 'error', 10000);
  await sleep(1200);
  check(`[${kind}] 파일을 못 받은 요청은 오류만 알리고 보내지 않음`, g1 && !seen.some((x) => x.tag === 'G') && !s.of('g1').some((m) => m.type === 'result'),
    g1 ? b64text(g1.messageB64) : '응답 없음');

  // 서버 키 가져오기(ssh-keyscan)가 기다리는 동안에도 다른 요청은 나감
  s.send({ type: 'sshScan', id: 'k1', ssh: { host: '127.0.0.1', port: SILENT_PORT, user: 'x', password: '' } });
  await sleep(300);
  const tk = performance.now();
  const h1 = await one(s, 'h1', '/fast', 'H', 'body-H');
  const hMs = performance.now() - tk;
  const k1 = await s.wait((m) => m.id === 'k1', 30000);
  check(`[${kind}] 서버 키를 가져오는 동안에도 다른 요청이 바로 나감`, h1 && h1.type === 'end' && k1 && k1.type === 'sshScanned' && k1.at > h1.at,
    `요청 ${Math.round(hMs)}ms, 키 가져오기 ${k1 ? k1.type : '응답 없음'} (${k1 && h1 ? Math.round(k1.at - h1.at) + 'ms 뒤' : ''})`);

  // 속도: 켜 둔 도우미로 다섯 번 vs 요청마다 새로 띄우는 예전 방식 다섯 번
  const kept = [];
  for (let i = 0; i < 5; i++) {
    const tt = performance.now();
    const m = await one(s, 'p' + i, '/fast', 'P' + i, 'x');
    if (m && m.type === 'end' && s.bodyOf('p' + i) === 'fast:x') kept.push(performance.now() - tt);
  }
  const fresh = [];
  for (let i = 0; i < 5; i++) {
    const tt = performance.now();
    const h = startHost(kind);
    h.send({ type: 'file', name: 'FILE_0', data: Buffer.from('x').toString('base64') });
    h.send({ ...runMsg(undefined, '/fast', 'Q' + i), id: undefined });
    await h.until(['end', 'error'], 30000);
    h.close();
    fresh.push(performance.now() - tt);
  }
  check(`[${kind}] 켜 둔 도우미가 요청마다 새로 띄우는 방식보다 빠름`, kept.length === 5 && median(kept) < median(fresh),
    `가운데값 ${Math.round(median(kept))}ms (켜 둠) 대 ${Math.round(median(fresh))}ms (요청마다 새로)`);

  // 확장이 연결을 끊으면: 받는 중이던 curl 까지 멈추고 도우미가 끝남
  sendFile(s, 'z1', 'body-Z');
  s.send(runMsg('z1', '/hang', 'Z'));
  await sleep(700);
  const sent = seen.some((x) => x.tag === 'Z') && !s.exited;
  s.close();
  const exitMs = await s.waitExit(8000);
  await sleep(300);
  check(`[${kind}] 연결을 끊으면 받는 중이던 요청까지 멈추고 도우미가 끝남`, sent && exitMs !== null && closed.has('Z'),
    `${exitMs !== null ? Math.round(exitMs) + 'ms 만에 끝남' : '끝나지 않음'}, 서버에서 끊김=${closed.has('Z')}`);
}

/* ---------------- 강제로 끝난 도우미가 남긴 ssh 정리 (Windows ps1) ---------------- */
if (process.platform === 'win32') {
  console.log('\n=== 남은 ssh 정리 (ps1)');
  const temp = path.join(tmp, 'Temp');
  fs.mkdirSync(temp, { recursive: true });
  // 끝난 프로세스의 번호 (그 번호의 도우미가 강제로 끝난 것처럼)
  const gone = spawn(process.execPath, ['-e', '0']);
  const deadPid = gone.pid;
  await new Promise((r) => gone.on('exit', r));
  const stale = path.join(temp, `ssoda-s${deadPid}-${'0123456789abcdef'.repeat(2)}`);
  fs.mkdirSync(path.join(stale, 't1'), { recursive: true });
  // 그 폴더에서 띄운 것처럼 보이는 가짜 ssh.exe (node 사본, 명령줄에 그 폴더가 들어감)
  const fakeSsh = path.join(tmp, 'bin', 'ssh.exe');
  fs.mkdirSync(path.dirname(fakeSsh), { recursive: true });
  fs.copyFileSync(process.execPath, fakeSsh);
  const victim = spawn(fakeSsh, ['-e', 'setTimeout(() => {}, 60000)', '--', '-F', path.join(stale, 't1', 'ssh_config')], { windowsHide: true });
  let victimExit = false;
  victim.on('exit', () => (victimExit = true));
  // 상관없는 ssh.exe (다른 폴더) 는 건드리면 안 됨
  const bystander = spawn(fakeSsh, ['-e', 'setTimeout(() => {}, 60000)', '--', '-F', path.join(tmp, 'other', 'ssh_config')], { windowsHide: true });
  let bystanderExit = false;
  bystander.on('exit', () => (bystanderExit = true));
  await sleep(500);
  const s = session('ps1', { env: { ...process.env, TEMP: temp, TMP: temp } });
  s.send({ type: 'ping', session: true, curlPath: '' });
  await s.wait((m) => m.type === 'pong', 30000);
  for (let i = 0; i < 40 && !victimExit; i++) await sleep(100);
  check('주인이 없는 작업 폴더의 ssh 만 멈추고 폴더를 지움 (다른 ssh 는 그대로)', victimExit && !fs.existsSync(stale) && !bystanderExit,
    `남은 ssh 멈춤=${victimExit}, 폴더 남음=${fs.existsSync(stale)}, 상관없는 ssh 멈춤=${bystanderExit}`);
  s.close();
  await s.waitExit(5000);
  try { victim.kill(); } catch (e) { /* 이미 끝남 */ }
  try { bystander.kill(); } catch (e) { /* noop */ }
  await sleep(300);
}

server.close();
silent.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(finish());
