// Ssoda 도우미 2.0 확장 쪽: 켜 둔 도우미 하나로 여러 요청 (가짜 Native Messaging 연결)
// 실행: 저장소 최상위에서 npm test. 실제 도우미와 curl 로 하는 시험은 tests/ssoda-helper (npm run test:helper)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const mod = (p) => import(new URL('../../ssoda/js/' + p, import.meta.url).href);
const { runCurl, curlOptsOf, testSsh, pingHelper, helperSession, closeHelperSession, configureHelper } = await mod('curl-runner.js');
const { parseCurl } = await mod('curl-parser.js');
const { prepareRequest } = await mod('prepare.js');

// chrome.runtime.connectNative 흉내: 보낸 메시지를 모으고, 시험에서 답하거나(reply) 도우미가 끝난 것처럼(die) 만든다
const ports = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    connectNative(name) {
      const p = {
        name, posted: [], onMsg: [], onDisc: [], disconnected: false,
        onMessage: { addListener: (f) => p.onMsg.push(f) },
        onDisconnect: { addListener: (f) => p.onDisc.push(f) },
        postMessage(m) {
          if (p.disconnected) throw new Error('Attempting to use a disconnected port object');
          p.posted.push(JSON.parse(JSON.stringify(m)));
        },
        disconnect() { p.disconnected = true; },
        reply(m) { p.onMsg.forEach((f) => f(m)); },
        die(message = 'Native host has exited.') {
          p.disconnected = true;
          globalThis.chrome.runtime.lastError = { message };
          p.onDisc.forEach((f) => f());
          globalThis.chrome.runtime.lastError = null;
        },
      };
      ports.push(p);
      return p;
    },
  },
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const tick = () => new Promise((r) => setTimeout(r, 0));
const pong = (extra = {}) => ({ type: 'pong', hostVersion: '2.0.0', platform: 'windows', curlB64: b64('curl 8.22.0'), pathB64: b64('C:\\curl.exe'), sshB64: '', sshPathB64: '', ...extra });
const result = (id, body = 'ok', extra = {}) => [
  { type: 'result', id, exitCode: 0, timedOut: false, elapsedMs: 5, bodySize: body.length, stdoutB64: b64('\n__CSW__200|0|0|0|0|0.005|2|0|127.0.0.1|80|http://x.test/\n'), stderrB64: '', headersB64: b64('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'), pathB64: b64('C:\\curl.exe'), ...extra },
  { type: 'body', id, data: b64(body) },
  { type: 'end', id },
];
const prepared = (url = 'http://x.test/a') => {
  const d = parseCurl(`curl -X POST ${url} -d 'hello'`).request;
  return { p: prepareRequest(d, { forCurl: true }), o: curlOptsOf(d) };
};
const send = (url, opts) => {
  const { p, o } = prepared(url);
  return runCurl(p, o, opts);
};
const runsOf = (port) => port.posted.filter((m) => m.type === 'run');
const last = () => ports[ports.length - 1];
// 켜 둔 연결의 "쉬면 끊기" 타이머가 시험 프로세스를 붙잡지 않게
after(() => closeHelperSession());

test('켜 둔 도우미: ping{session} 에 session 으로 답하면 여러 요청을 한 연결로 보내고 요청 번호로 답을 나눔', async () => {
  closeHelperSession();
  const n0 = ports.length;
  const a = send('http://x.test/a', { keepMs: 60000 });
  const b = send('http://x.test/b');
  await tick();
  assert.equal(ports.length, n0 + 1, '연결은 하나');
  const port = last();
  assert.deepEqual(port.posted[0], { type: 'ping', session: true, curlPath: '', keepMs: helperSession().keepMs });
  port.reply(pong({ session: true }));
  await tick();
  const [ra, rb] = runsOf(port);
  assert.ok(ra && rb && ra.id && rb.id && ra.id !== rb.id, '요청마다 다른 번호');
  assert.equal(ra.keepMs, 60000);
  assert.equal(rb.keepMs, helperSession().keepMs, '요청에 유지 시간이 없으면 설정 값');
  // 본문 파일도 그 요청 번호로
  assert.ok(port.posted.filter((m) => m.type === 'file').every((m) => m.id === ra.id || m.id === rb.id));
  // B 의 답이 먼저 와도 각자 자기 응답
  result(rb.id, 'body-B').forEach((m) => port.reply(m));
  result(ra.id, 'body-A').forEach((m) => port.reply(m));
  const [A, B] = await Promise.all([a, b]);
  assert.equal(new TextDecoder().decode(A.body), 'body-A');
  assert.equal(new TextDecoder().decode(B.body), 'body-B');
  assert.ok(helperSession().connected && helperSession().pending === 0);
  // 다음 요청도 같은 연결 (ping 없이)
  const c = send('http://x.test/c');
  await tick();
  assert.equal(ports.length, n0 + 1);
  const rc = runsOf(port)[2];
  result(rc.id, 'body-C', { ssh: { port: 50000, connectMs: 0, reused: true, logB64: '', pathB64: b64('ssh.exe') } }).forEach((m) => port.reply(m));
  // ssh 없이 보낸 요청이라 terminal.ssh 는 없음 (ssh 를 줄 때만 읽음)
  assert.equal((await c).status, 200);
});

test('켜 둔 도우미: SSH 요청의 결과에 "열어 둔 연결을 다시 씀" 이 실림', async () => {
  const port = last();
  const { p, o } = prepared('http://10.0.0.5:8080/x');
  const r = runCurl(p, o, { ssh: { host: 'gw.example', port: 22, user: 'u', password: 'pw', label: '운영1' }, keepMs: 0 });
  await tick();
  const run = runsOf(port).pop();
  assert.equal(run.ssh.host, 'gw.example');
  assert.equal(run.keepMs, 0);
  result(run.id, 'x', { ssh: { port: 50001, connectMs: 0, reused: true, logB64: '', pathB64: b64('C:\\ssh.exe') } }).forEach((m) => port.reply(m));
  const res = await r;
  assert.equal(res.terminal.ssh.reused, true);
  assert.equal(res.terminal.ssh.connectMs, 0);
  assert.equal(res.terminal.ssh.label, '운영1');
});

test('켜 둔 도우미: 취소하면 그 요청 번호로 cancel 을 보내고 ABORTED, 연결은 그대로', async () => {
  const port = last();
  const ac = new AbortController();
  const r = send('http://x.test/slow', { signal: ac.signal });
  await tick();
  const run = runsOf(port).pop();
  ac.abort();
  await assert.rejects(r, (e) => e.code === 'ABORTED');
  assert.deepEqual(port.posted[port.posted.length - 1], { type: 'cancel', id: run.id });
  assert.ok(helperSession().connected && !port.disconnected);
  // 늦게 온 답은 무시
  result(run.id).forEach((m) => port.reply(m));
  assert.equal(helperSession().pending, 0);
});

test('켜 둔 도우미: 요청 하나의 오류는 그 요청만 실패', async () => {
  const port = last();
  const a = send('http://x.test/bad');
  const b = send('http://x.test/good');
  await tick();
  const [ra, rb] = runsOf(port).slice(-2);
  port.reply({ type: 'error', id: ra.id, messageB64: b64('curl option not allowed: -K') });
  result(rb.id, 'fine').forEach((m) => port.reply(m));
  await assert.rejects(a, (e) => e.code === 'HOST_ERROR' && /-K/.test(e.message));
  assert.equal((await b).status, 200);
});

test('켜 둔 도우미가 끝나면 기다리던 요청은 HOST_EXITED, 다음 요청은 새로 연결', async () => {
  const port = last();
  const a = send('http://x.test/a');
  await tick();
  port.die();
  await assert.rejects(a, (e) => e.code === 'HOST_EXITED');
  assert.equal(helperSession().connected, false);
  const n = ports.length;
  const b = send('http://x.test/b');
  await tick();
  assert.equal(ports.length, n + 1);
  const p2 = last();
  assert.equal(p2.posted[0].type, 'ping');
  p2.reply(pong({ session: true }));
  await tick();
  result(runsOf(p2)[0].id).forEach((m) => p2.reply(m));
  assert.equal((await b).status, 200);
});

test('연결 테스트(sshTest)도 켜 둔 도우미로 보내고 유지 시간을 붙임', async () => {
  const port = last();
  const r = testSsh({ host: 'gw.example', port: 22, user: 'u', password: 'pw' }, { keepMs: 0 });
  await tick();
  const m = port.posted[port.posted.length - 1];
  assert.equal(m.type, 'sshTest');
  assert.equal(m.keepMs, 0);
  port.reply({ type: 'sshOk', id: m.id, connectMs: 321, logB64: '', fingerprintB64: b64('256 SHA256:abc (ED25519)'), pathB64: b64('ssh.exe') });
  const res = await r;
  assert.equal(res.ok, true);
  assert.equal(res.connectMs, 321);
});

test('configureHelper: 켜 둔 도우미에 config 를 보내고, 요청이 없으면 max(10분, 유지 시간 + 30초) 뒤 연결을 끊음', async (t) => {
  closeHelperSession();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    configureHelper({ keepMs: 30 * 60 * 1000 });
    const r = send('http://x.test/a');
    await Promise.resolve();
    await Promise.resolve();
    const port = last();
    port.reply(pong({ session: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    result(runsOf(port)[0].id).forEach((m) => port.reply(m));
    await r;
    t.mock.timers.tick(30 * 60 * 1000 + 29000);
    assert.equal(port.disconnected, false, '유지 시간 + 30초 전에는 끊지 않음');
    t.mock.timers.tick(2000);
    assert.equal(port.disconnected, true, '그 뒤 끊음');
    assert.equal(helperSession().connected, false);
  } finally {
    t.mock.timers.reset();
    configureHelper({ keepMs: 10 * 60 * 1000 });
  }
  // config 는 켜 둔 도우미가 있을 때 바로 보냄
  const r2 = send('http://x.test/b');
  await tick();
  const port = last();
  port.reply(pong({ session: true }));
  await tick();
  result(runsOf(port)[0].id).forEach((m) => port.reply(m));
  await r2;
  configureHelper({ keepMs: 0 });
  assert.deepEqual(port.posted[port.posted.length - 1], { type: 'config', keepMs: 0 });
  configureHelper({ keepMs: 10 * 60 * 1000 });
});

test('도우미가 설치되지 않았으면(연결이 바로 끊김) NO_HOST 로 알리고, 옛 도우미로 고정하지 않음', async () => {
  closeHelperSession();
  const r = send('http://x.test/a');
  await tick();
  last().die('Specified native messaging host not found.');
  await assert.rejects(r, (e) => e.code === 'NO_HOST');
  assert.equal(helperSession().legacy, false);
});

test('옛 도우미(1.x): session 없는 pong 이면 그 연결을 닫고 예전처럼 요청마다 새로 연결 · 새 도우미를 확인하면 다시 켜 둔 도우미', async () => {
  closeHelperSession();
  const n0 = ports.length;
  const a = send('http://x.test/a');
  await tick();
  const ping = last();
  ping.reply(pong({ hostVersion: '1.3.2' }));
  await tick();
  assert.equal(ping.disconnected, true);
  assert.equal(helperSession().legacy, true);
  const one = last();
  assert.equal(ports.length, n0 + 2, '확인용 연결 + 요청 연결');
  const run = runsOf(one)[0];
  assert.equal(run.id, undefined, '옛 도우미에는 요청 번호를 보내지 않음');
  assert.ok(one.posted.filter((m) => m.type === 'file').every((m) => m.id === undefined));
  result(undefined).forEach((m) => { delete m.id; one.reply(m); });
  assert.equal((await a).status, 200);
  assert.equal(one.disconnected, true, '요청이 끝나면 연결을 닫음');
  // 다음 요청은 확인 없이 바로 새 연결
  const b = send('http://x.test/b');
  await tick();
  assert.equal(ports.length, n0 + 3);
  assert.equal(last().posted[0].type, 'file');
  result(undefined).forEach((m) => { delete m.id; last().reply(m); });
  await b;
  // 새 도우미로 다시 설치하고 [연결 확인]
  const st = pingHelper();
  await tick();
  last().reply(pong());
  assert.equal((await st).hostVersion, '2.0.0');
  assert.equal(helperSession().legacy, false);
});
