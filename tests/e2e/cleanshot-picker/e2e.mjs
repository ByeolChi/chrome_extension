// CleanShot Picker e2e 시험 (0단계 수정 + 전체 페이지 캡처)
// 실행: 저장소 최상위에서 node tests/e2e/cleanshot-picker/e2e.mjs   (화면 배율 2: DPR=2, 다른 사본: CLEANSHOT_EXT=<확장 폴더>,
//       일부만: ONLY=fullPageDoc,fullPagePanel)
// 요구 사항과 시험 내용은 tests/e2e/README.md 참고
// Playwright Chromium 131 에 확장의 시험용 사본을 로드한다. 사본은 코드가 같고
// manifest 에 host_permissions <all_urls> 만 더했다 — CDP 로는 activeTab(사용자 클릭)을 줄 수 없어서다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, decodePng, blackRatio, pixel } from './cdp.mjs';
import { tempDir } from '../lib/chromium.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.CLEANSHOT_EXT || path.join(DIR, '..', '..', '..', 'cleanshot-picker'));
const WORK = tempDir('cleanshot-e2e-');   // 시험용 확장 사본, 브라우저 프로필, 다운로드
const EXT = path.join(WORK, 'ext');
const DPR = Number(process.env.DPR || 1);
const DL = path.join(WORK, 'downloads');
const PORT = Number(process.env.CDP_PORT) || 9302;
const WEB = 8930;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

/* ---------------------------------------------------------------- 결과 */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  const d = detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${d}`);
}
const near = (a, b, tol = 1.5) => !!a && !!b &&
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
const fmt = (r) => r ? `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}x${r.h.toFixed(1)}` : 'null';

/* ---------------------------------------------------------------- 시험용 확장 사본 */
function syncExt() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(path.join(EXT, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(EXT, 'shared'), { recursive: true });
  for (const f of ['picker.js', 'background.js', 'shared/redact-core.js']) fs.copyFileSync(path.join(SRC, f), path.join(EXT, f));
  for (const f of fs.readdirSync(path.join(SRC, 'icons'))) fs.copyFileSync(path.join(SRC, 'icons', f), path.join(EXT, 'icons', f));
  const man = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  man.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
}

/* ---------------------------------------------------------------- 시험 페이지 서버 (127.0.0.1 과 localhost 는 서로 다른 출처) */
function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/' ? '/main.html' : u.pathname;
  const p = path.join(DIR, 'site', file);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (file === '/nav-target.html') { res.end('<h1 id=navigated>navigated</h1>'); return; }
  if (!fs.existsSync(p)) { res.statusCode = 404; res.end('nf'); return; }
  res.end(fs.readFileSync(p));
}
const servers = [http.createServer(handler), http.createServer(handler)];
await new Promise((r) => servers[0].listen(WEB, '127.0.0.1', r));
await new Promise((r) => servers[1].listen(WEB, '::1', r).on('error', () => r()));

/* ---------------------------------------------------------------- 브라우저 */
syncExt();
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const { proc, cdp } = await launch({
  extPath: EXT,
  profile: path.join(WORK, 'profile'),
  port: PORT,
  prefs: { download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true } },
  extraArgs: DPR !== 1 ? [`--force-device-scale-factor=${DPR}`] : []
});

let pageS = null;
let pageTargetId = null;
let swS = null;
let mainFrameId = null;
const contexts = new Map();
cdp.on((m) => {
  if (m.sessionId !== pageS) return;
  if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
  else if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId);
  else if (m.method === 'Runtime.executionContextsCleared') contexts.clear();
});
const consoleLines = [];

async function evalIn(session, expression, contextId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId }, session);
  if (r.exceptionDetails) {
    throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result.value;
}
const main = (expr) => evalIn(pageS, expr);
function isoId() {
  for (const c of contexts.values()) {
    if (c.auxData && c.auxData.frameId === mainFrameId && c.auxData.type === 'isolated' && c.name === 'CleanShot Picker') return c.id;
  }
  return null;
}
const iso = (expr) => evalIn(pageS, expr, isoId());
const sw = (expr) => evalIn(swS, expr);

/* 닫힌 shadow root 는 격리 world 의 chrome.dom 으로만 연다 */
const UI = `chrome.dom.openOrClosedShadowRoot(document.getElementById('__cleanshot_host__'))`;
const uiRect = (sel) => iso(`(() => { const e = ${UI}.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, display: getComputedStyle(e).display }; })()`);
const masks = () => iso(`window.__cleanShot.state.masks.map((m) => m.view ? { x: m.view.x, y: m.view.y, w: m.view.w, h: m.view.h } : null)`);
const maskBoxes = () => iso(`[...${UI}.querySelectorAll('.mask')].map((e) => { const r = e.getBoundingClientRect(); return getComputedStyle(e).display === 'none' ? null : { x: r.left, y: r.top, w: r.width, h: r.height }; })`);
const toastText = () => iso(`${UI}.querySelector('.toast').textContent`);
const cand = () => iso(`(() => { const c = window.__cleanShot.state.candidate; return c ? { id: c.id, tag: c.localName, inFrame: c.ownerDocument !== document } : null; })()`);

const rectMain = (sel) => main(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const rectInner = (sel) => main(`(() => { const f = document.getElementById('sameFrame'); const fr = f.getBoundingClientRect(); const r = f.contentDocument.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height }; })()`);
const rectShadow = (hostSel, innerId, closed) => main(`(() => { const root = ${closed ? 'window.__closedRoot' : `document.querySelector(${JSON.stringify(hostSel)}).shadowRoot`}; const r = root.getElementById(${JSON.stringify(innerId)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
/* 클릭 결과는 입력 처리 뒤에 반영된다 — 1초까지 기다리며 확인하고, 걸린 시간을 돌려준다 */
async function waitTrue(fn, timeout = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return Date.now() - t0;
    await sleep(25);
  }
  return -1;
}

/* ---------------------------------------------------------------- 입력 */
async function mouse(type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, pageS);
}
async function move(x, y, modifiers = 0) { await mouse('mouseMoved', x, y, { modifiers }); await sleep(30); }
async function click(x, y, modifiers = 0) {
  await move(x, y, modifiers);
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(60);
}
async function drag(x0, y0, x1, y1, modifiers = 0, steps = 8) {
  await move(x0, y0, modifiers);
  await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await mouse('mouseMoved', x, y, { button: 'left', buttons: 1, modifiers });
    await sleep(16);
  }
  await mouse('mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(80);
}
async function wheel(x, y, dy) {
  await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: dy });
  await sleep(350);
}
const KEYS = {
  1: { code: 'Digit1', vk: 49, text: '1' }, 2: { code: 'Digit2', vk: 50, text: '2' },
  3: { code: 'Digit3', vk: 51, text: '3' }, 4: { code: 'Digit4', vk: 52, text: '4' },
  5: { code: 'Digit5', vk: 53, text: '5' },
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  z: { code: 'KeyZ', vk: 90, text: 'z' }, a: { code: 'KeyA', vk: 65, text: 'a' },
  c: { code: 'KeyC', vk: 67, text: 'c' }, 'ㅊ': { code: 'KeyC', vk: 67, text: 'ㅊ' }
};
async function key(k, modifiers = 0) {
  const d = KEYS[k];
  const base = { key: k, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers };
  const typed = d.text && !(modifiers & 2);
  await cdp.send('Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', ...base, ...(typed ? { text: d.text, unmodifiedText: d.text } : {}) }, pageS);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, pageS);
  await sleep(60);
}
const CTRL = 2;
const SHIFT = 8;

/* ---------------------------------------------------------------- 페이지 열기와 피커 켜기 */
async function freshPage(url = `http://127.0.0.1:${WEB}/main.html`) {
  const loaded = cdp.waitFor((m) => m.sessionId === pageS && m.method === 'Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url }, pageS);
  await loaded;
  await sleep(400);
  const tree = await cdp.send('Page.getFrameTree', {}, pageS);
  mainFrameId = tree.frameTree.frame.id;
}

async function activate() {
  // 앞 시험이 저장한 설정(빈자리 제거·툴바 위치)이 다음 시험에 새지 않게 되돌린다
  const r = await sw(`(async () => { await chrome.storage.sync.set({ forceRemove: false, barTop: false }); const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); await togglePicker(tab); return tab.id; })()`);
  for (let i = 0; i < 50 && !isoId(); i++) await sleep(50);
  if (!isoId()) throw new Error('isolated world not found');
  for (let i = 0; i < 50; i++) {
    if (await iso(`!!(window.__cleanShot && window.__cleanShot.state.active)`)) break;
    await sleep(50);
  }
  await sleep(120);
  return r;
}

function listFiles(dir = DL) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

async function waitNewPng(before, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const files = listFiles().filter((f) => !before.has(f));
    const done = files.filter((f) => f.endsWith('.png'));
    if (done.length && !files.some((f) => f.endsWith('.crdownload'))) {
      await sleep(150);
      return done[0];
    }
    await sleep(80);
  }
  return null;
}

/* 캡처하고 PNG 를 읽는다. 캡처 직전의 가리기 사각형도 돌려준다. */
async function captureAndRead() {
  const before = new Set(listFiles());
  const views = await masks();
  await key('Enter');
  const file = await waitNewPng(before);
  if (!file) return { file: null, views };
  const img = decodePng(fs.readFileSync(file));
  const last = await sw(`self.__lastCapture || null`).catch(() => null);
  return { file, img, views, last };
}

const scaled = (r, inset = 1) => ({ x: r.x * DPR + inset, y: r.y * DPR + inset, w: r.w * DPR - 2 * inset, h: r.h * DPR - 2 * inset });

/* ---------------------------------------------------------------- 전체 페이지 캡처 도우미 */
const sameRgb = (p, c) => !!p && !!c && p[0] === c[0] && p[1] === c[1] && p[2] === c[2];
const HDR = [20, 40, 60];
const FTR = [60, 40, 20];
const GREEN = [0, 200, 0];
const BLUE = [0, 0, 255];
const FULL_URL = (q = '') => `http://127.0.0.1:${WEB}/full.html${q}`;
const styleSnap = () => main(`JSON.stringify([...document.querySelectorAll('*')].map((e) => e.getAttribute('style')))`);
const swFull = () => sw(`(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); return { runs: fullRuns.size, badge: await chrome.action.getBadgeText({ tabId: tab.id }) }; })()`);

/* full.html 의 배치(문서 좌표). sticky 가 붙기 전(맨 위)에 잰다. hs 는 고정 머리글 안 요소의 화면 좌표. */
const fullLayout = () => main(`(() => {
  const sy = scrollY;
  const doc = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top + sy, w: b.width, h: b.height }; };
  const hs = document.getElementById('hdrSecret').getBoundingClientRect();
  return {
    W: document.documentElement.clientWidth, H: document.scrollingElement.scrollHeight, vh: document.documentElement.clientHeight,
    bands: [...document.querySelectorAll('.band')].map((b, i) => ({ ...doc(b), c: window.__bandColor(i) })),
    stk: doc(document.getElementById('stk')), deep: doc(document.getElementById('deep')), tfix: doc(document.getElementById('tfix')),
    hs: { x: hs.left, y: hs.top, w: hs.width, h: hs.height }
  };
})()`);

/* 전체 캡처를 시작하고 새 PNG 를 기다리며, 그동안 뜬 안내 문구를 모은다. want 가 있으면 그 문구가 뜰 때까지 조금 더 본다. */
async function fullShot(start, { timeout = 45000, want = null } = {}) {
  const before = new Set(listFiles());
  const t0 = Date.now();
  await start();
  const toasts = new Set();
  let file = null;
  let fileAt = 0;
  while (Date.now() - t0 < timeout) {
    const t = await toastText().catch(() => '');
    if (t) toasts.add(t);
    if (!file) {
      const files = listFiles().filter((f) => !before.has(f));
      const done = files.filter((f) => f.endsWith('.png'));
      if (done.length && !files.some((f) => f.endsWith('.crdownload'))) { file = done[0]; fileAt = Date.now(); }
    }
    if (file && (!want || [...toasts].some((x) => want.test(x)) || Date.now() - fileAt > 1500)) break;
    await sleep(40);
  }
  if (file) await sleep(150);
  return { file, img: file ? decodePng(fs.readFileSync(file)) : null, ms: (fileAt || Date.now()) - t0, toasts: [...toasts] };
}

/* 새로 생긴 PNG 들 (멈춘 시험에서 아무것도 저장되지 않았는지 볼 때) */
const newPngs = (before) => listFiles().filter((f) => !before.has(f) && f.endsWith('.png'));

/* 이미지의 세로줄 x(CSS px)를 맨 위부터 맨 아래까지 모두 보고, 기대 색 expect(문서 y)와 다른 줄을 모은다.
   expect 가 null 이면 그 줄은 보지 않고, 기대 색이 바뀌는 경계의 앞뒤 한 줄도 건너뛴다(반올림).
   장 사이 이음매의 빈 줄·어긋남, 장마다 되풀이된 머리글·바닥글·sticky·검정 박스를 모두 잡는다. */
function columnErrors(img, x, scale, expect) {
  const bad = [];
  const px = Math.round(x * scale);
  const at = (row) => expect((row + 0.5) / scale);
  for (let row = 0; row < img.height; row++) {
    const want = at(row);
    if (!want || at(row - 1) !== want || at(row + 1) !== want) continue;
    const got = pixel(img, px, row);
    if (!sameRgb(got, want) || got[3] !== 255) bad.push({ row, y: Math.round((row + 0.5) / scale), want, got });
  }
  return bad;
}

/* full.html 의 문서 y 에서 기대하는 색 (머리글·바닥글 자리는 보지 않음). H 를 주면 그 높이를 문서 끝으로 본다. */
const fullExpect = (L, H = L.H) => (y) => {
  if (y < 50 || y >= H - 40) return null;
  if (y >= L.stk.y && y < L.stk.y + L.stk.h) return GREEN;
  const b = L.bands.find((q) => y >= q.y && y < q.y + q.h);
  return b ? b.c : null;
};
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

/* ---------------------------------------------------------------- 시작 */
async function setup() {
  let swT = null;
  for (let i = 0; i < 60 && !swT; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    swT = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    if (!swT) await sleep(150);
  }
  if (!swT) throw new Error('service worker not found');
  swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, swS);
  // 저장 시간 재기 — 메시지 처리기를 감싼다 (onMessage 가 HANDLERS 를 매번 찾아 쓰므로 그대로 반영된다)
  await sw(`(() => { if (self.__wrapped) return; self.__wrapped = true; const orig = HANDLERS.CLEANSHOT_CAPTURE; HANDLERS.CLEANSHOT_CAPTURE = async (m, s) => { const t = performance.now(); const r = await orig(m, s); self.__lastCapture = { ms: Math.round(performance.now() - t), masks: (m.masks || []).length, ok: !!r.ok, fallback: !!r.fallback, error: r.error || '' }; return r; }; })()`);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const pageT = targetInfos.find((t) => t.type === 'page');
  pageTargetId = pageT.targetId;
  pageS = (await cdp.send('Target.attachToTarget', { targetId: pageT.targetId, flatten: true })).sessionId;
  await cdp.send('Page.enable', {}, pageS);
  await cdp.send('Runtime.enable', {}, pageS);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pageS);
  cdp.on((m) => {
    if (m.sessionId === pageS && m.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  // Browser.setDownloadBehavior 를 쓰면 chrome.downloads 의 파일 이름(cleanshot/…)이 무시된다. 프로필 기본 폴더만 쓴다.
}

/* ================================================================ 시험 */

const cases = {
  /* closed shadow root, popover(top layer) */
  async overlay() {
    await freshPage();
    await activate();
    check('툴바 shadow root 가 closed (페이지에서 host.shadowRoot === null)', await main(`document.getElementById('__cleanshot_host__').shadowRoot === null`));
    check('오버레이가 popover 로 top layer 에 올라감', await main(`document.getElementById('__cleanshot_host__').matches(':popover-open')`));
    const bar = await uiRect('.bar');
    const hitBar = await main(`document.elementFromPoint(${center(bar).x}, ${center(bar).y})?.id`);
    check('툴바 위치에서 elementFromPoint 가 오버레이 host', hitBar === '__cleanshot_host__', hitBar);
  },

  /* 1-a 고정 요소를 가린 뒤 스크롤 */
  async fixedScroll() {
    await freshPage();
    await activate();
    await key('5');
    const r0 = await rectMain('#fixedSecret');
    await click(center(r0).x, center(r0).y);
    let v = (await masks())[0];
    check('고정 요소 가리기: 박스가 요소 위치', near(v, r0), `${fmt(v)} vs ${fmt(r0)}`);
    await wheel(640, 500, 400);
    const sy = await main('scrollY');
    const r1 = await rectMain('#fixedSecret');
    v = (await masks())[0];
    const box = (await maskBoxes())[0];
    check('고정 요소 가리기: 스크롤 후에도 요소를 따라감', sy > 100 && near(v, r1) && near(box, r1), `scrollY=${sy} mask=${fmt(v)} dom=${fmt(box)} el=${fmt(r1)}`);
    const shot = await captureAndRead();
    check('고정 요소 가리기: 스크롤 후 캡처한 PNG 에서 요소 자리가 검정', shot.img && blackRatio(shot.img, ...Object.values(scaled(r1))) > 0.999,
      shot.img ? `black=${blackRatio(shot.img, ...Object.values(scaled(r1))).toFixed(4)} file=${path.basename(shot.file)} ${JSON.stringify(shot.last)}` : 'no file');
  },

  /* 1-b sticky 요소 */
  async stickyScroll() {
    await freshPage();
    await activate();
    await key('5');
    await main('scrollTo(0, 700)');
    await sleep(200);
    const r0 = await rectMain('#stickySecret');
    await click(center(r0).x, center(r0).y);
    await wheel(640, 500, 300);
    const r1 = await rectMain('#stickySecret');
    const v = (await masks())[0];
    check('sticky 요소 가리기: 스크롤 후에도 따라감', near(v, r1) && Math.abs(r1.y - r0.y) < 2, `mask=${fmt(v)} el=${fmt(r1)} before=${fmt(r0)}`);
  },

  /* 1-c 빈자리 제거로 레이아웃이 밀릴 때 */
  async layoutShift() {
    await freshPage();
    await activate();
    await key('5');
    const r0 = await rectMain('#flowSecret');
    await click(center(r0).x, center(r0).y);
    const mode = await uiRect('.mode');
    await click(center(mode).x, center(mode).y);
    check('툴바 버튼을 실제 클릭으로 누를 수 있음 (빈자리 제거 켜짐)', await iso('window.__cleanShot.state.forceRemove === true'));
    await key('1');
    const b = await rectMain('#banner');
    await click(center(b).x, center(b).y);
    const r1 = await rectMain('#flowSecret');
    const v = (await masks())[0];
    check('빈자리 제거로 밀린 요소: 박스가 따라감', Math.abs(r1.y - (r0.y - 120)) < 1.5 && near(v, r1), `mask=${fmt(v)} el=${fmt(r1)} before=${fmt(r0)}`);
    await key('z', CTRL);
    const r2 = await rectMain('#flowSecret');
    const v2 = (await masks())[0];
    check('되돌리기 후 다시 따라감', near(v2, r2) && near(r2, r0), `mask=${fmt(v2)} el=${fmt(r2)}`);
    // 이동 도구로 옮겨도 따라간다
    await key('2');
    await drag(center(r2).x, center(r2).y, center(r2).x + 50, center(r2).y + 20);
    const r3 = await rectMain('#flowSecret');
    const v3 = (await masks())[0];
    check('이동 도구로 옮긴 요소: 박스가 따라감', Math.abs(r3.x - r2.x - 50) < 1.5 && near(v3, r3), `mask=${fmt(v3)} el=${fmt(r3)}`);
    // 크기 도구
    await key('3');
    await move(center(r3).x, center(r3).y);
    const se = await iso(`(() => { const h = [...${UI}.querySelectorAll('.handle')].find((x) => x.dataset.dir === 'se'); const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await drag(se.x, se.y, se.x + 40, se.y + 10);
    const r4 = await rectMain('#flowSecret');
    const v4 = (await masks())[0];
    check('크기 도구로 키운 요소: 박스가 따라감', Math.abs(r4.w - r3.w - 40) < 1.5 && near(v4, r4), `mask=${fmt(v4)} el=${fmt(r4)}`);
  },

  /* 1-d 내부 스크롤 영역 */
  async innerScroll() {
    await freshPage();
    await activate();
    await key('5');
    const sc = await rectMain('#scroller');
    const r0 = await rectMain('#scrollSecret');
    await click(center(r0).x, center(r0).y);
    await wheel(center(sc).x, center(sc).y, 60);
    let st = await main(`document.getElementById('scroller').scrollTop`);
    let r1 = await rectMain('#scrollSecret');
    let v = (await masks())[0];
    check('내부 스크롤: 스크롤해도 박스가 요소를 따라감', st > 0 && near(v, r1), `scrollTop=${st} mask=${fmt(v)} el=${fmt(r1)}`);
    await main(`document.getElementById('scroller').scrollTop = 140`);
    await sleep(200);
    r1 = await rectMain('#scrollSecret');
    v = (await masks())[0];
    const expect = { x: r1.x, y: sc.y, w: r1.w, h: r1.y + r1.h - sc.y };
    check('내부 스크롤: 영역 밖으로 반쯤 나가면 보이는 부분만 가림', near(v, expect), `mask=${fmt(v)} expect=${fmt(expect)}`);
    await main(`document.getElementById('scroller').scrollTop = 400`);
    await sleep(200);
    v = (await masks())[0];
    const box = (await maskBoxes())[0];
    check('내부 스크롤: 완전히 나가면 박스를 숨김', v === null && box === null, `mask=${fmt(v)} dom=${fmt(box)}`);
  },

  /* 눈으로 확인할 화면 두 장 (기본, 모달 dialog 위) — 판정 없음 */
  async screens() {
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageS);
      const out = path.join(os.tmpdir(), `cleanshot-screen-${name}-dpr${DPR}.png`);
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log('   화면 저장: ' + out);
    };
    await freshPage();
    await activate();
    await key('5');
    const r = await rectMain('#flowSecret');
    await click(center(r).x, center(r).y);
    const s = await rectMain('#scrollSecret');
    await move(center(s).x, center(s).y);
    await sleep(100);
    await shot('normal');
    await key('Escape');
    await main(`document.getElementById('dlg').showModal()`);
    await activate();
    await key('5');
    const d = await rectMain('#dlgSecret');
    await click(center(d).x, center(d).y);
    await move(10, 300);
    await sleep(100);
    await shot('dialog');
    check('화면 두 장 저장', true);
  },

  /* 여러 요소에 걸친 영역은 예전처럼 문서 좌표에 붙는다 */
  async regionDoc() {
    await freshPage();
    await activate();
    await key('5');
    await drag(30, 160, 400, 230, SHIFT); // 배너 아래쪽과 flowSecret 에 걸침
    const a0 = (await masks())[0];
    await wheel(640, 600, 100);
    const sy = await main('scrollY');
    const a1 = (await masks())[0];
    const expect = { x: a0.x, y: a0.y - sy, w: a0.w, h: a0.h };
    check('여러 요소에 걸친 영역: 문서와 함께 스크롤', sy > 0 && near(a1, expect), `scrollY=${sy} ${fmt(a1)} vs ${fmt(expect)}`);
  },

  /* 같은 출처 iframe 안의 텍스트 편집과 되돌리기 */
  async iframeText() {
    await freshPage();
    await activate();
    await key('4');
    const r = await rectInner('#innerText');
    await click(r.x + 20, center(r).y);
    const ed = await iso(`(() => { const e = window.__cleanShot.state.editing; return e ? { id: e.id, inFrame: e.ownerDocument !== document } : null; })()`);
    check('iframe 안 텍스트 편집 시작', ed && ed.id === 'innerText' && ed.inFrame, ed);
    await key('a', CTRL);
    await cdp.send('Input.insertText', { text: '아이프레임 수정' }, pageS);
    await key('Escape'); // 포커스가 iframe 안에 있어도 Esc 가 먹어야 한다
    const mid = await main(`document.getElementById('sameFrame').contentDocument.getElementById('innerText').textContent`);
    const stillOn = await iso(`window.__cleanShot.state.active && !window.__cleanShot.state.editing`);
    check('iframe 안 편집 반영, Esc 는 편집만 끝냄', mid === '아이프레임 수정' && stillOn, { mid, stillOn });
    await key('z', CTRL);
    const back = await main(`document.getElementById('sameFrame').contentDocument.getElementById('innerText').textContent`);
    check('iframe 안 편집 되돌리기', back === 'inner text here', back);
  },

  /* 페이지 확대(150%)에서도 PNG 의 검정 위치가 맞는지 */
  async zoom() {
    await freshPage();
    await sw(`(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); await chrome.tabs.setZoom(tab.id, 1.5); })()`);
    await sleep(400);
    try {
      await activate();
      await key('5');
      const r = await rectMain('#flowSecret');
      await click(center(r).x, center(r).y);
      const shot = await captureAndRead();
      const z = 1.5;
      const sr = { x: r.x * DPR * z + 1, y: r.y * DPR * z + 1, w: r.w * DPR * z - 2, h: r.h * DPR * z - 2 };
      const br = shot.img ? blackRatio(shot.img, sr.x, sr.y, sr.w, sr.h) : -1;
      const vw = await main('innerWidth');
      check('확대 150%: PNG 에서 가린 자리가 검정', br > 0.999, `black=${br.toFixed(4)} img=${shot.img && shot.img.width} vw(css)=${vw}`);
    } finally {
      await sw(`(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); await chrome.tabs.setZoom(tab.id, 1); })()`);
      await sleep(900);
    }
  },

  /* 1-e 영역 가리기(Shift+드래그) */
  async regions() {
    await freshPage();
    await activate();
    await key('5');
    // 고정 바 위의 영역
    await drag(300, 15, 500, 45, SHIFT);
    // 내부 스크롤 영역 안, 두 항목에 걸친 영역
    const sc = await rectMain('#scroller');
    await drag(sc.x + 20, sc.y + 50, sc.x + 200, sc.y + 110, SHIFT);
    let [a, b] = await masks();
    check('영역 가리기 2개 생성', !!a && !!b, `${fmt(a)} | ${fmt(b)}`);
    const a0 = a, b0 = b;
    await wheel(640, 600, 300);
    [a, b] = await masks();
    const sy = await main('scrollY');
    check('고정 바 위 영역: 페이지 스크롤에도 제자리(고정 바를 따라감)', sy > 100 && near(a, a0), `scrollY=${sy} ${fmt(a)} vs ${fmt(a0)}`);
    await main('scrollTo(0, 0)');
    await sleep(200);
    await main(`document.getElementById('scroller').scrollTop = 30`);
    await sleep(200);
    [a, b] = await masks();
    const expectB = { x: b0.x, y: b0.y - 30, w: b0.w, h: b0.h };
    check('스크롤 영역 안의 영역: 내용과 함께 움직임', near(b, expectB), `${fmt(b)} vs ${fmt(expectB)}`);
  },

  /* 4 shadow DOM 과 같은 출처·다른 출처 iframe */
  async picking() {
    await freshPage();
    await activate();
    await key('1');
    // open shadow
    let r = await rectShadow('#shadowHost', 'shadowInner', false);
    await move(center(r).x, center(r).y);
    let c = await cand();
    check('open shadow DOM 안의 요소를 고름', c && c.id === 'shadowInner', c);
    await click(center(r).x, center(r).y);
    let waited = await waitTrue(() => main(`document.getElementById('shadowHost').shadowRoot.getElementById('shadowInner').style.visibility === 'hidden'`));
    check('open shadow DOM 안 요소 지우기', waited >= 0, `반영까지 ${waited}ms`);
    // closed shadow
    r = await rectShadow('#closedHost', 'closedInner', true);
    await move(center(r).x, center(r).y);
    c = await cand();
    check('closed shadow DOM 안의 요소를 고름', c && c.id === 'closedInner', c);
    // 같은 출처 iframe
    r = await rectInner('#innerSecret');
    await move(center(r).x, center(r).y);
    c = await cand();
    const hl = await uiRect('.hl');
    check('같은 출처 iframe 안의 요소를 고름', c && c.id === 'innerSecret' && c.inFrame, c);
    check('iframe 안 요소의 강조 상자가 제자리', near(hl, r, 1), `hl=${fmt(hl)} el=${fmt(r)}`);
    await click(center(r).x, center(r).y);
    // innerSecret 은 position:absolute 라 지우기가 display:none 으로 공간까지 없앤다
    waited = await waitTrue(() => main(`document.getElementById('sameFrame').contentDocument.getElementById('innerSecret').style.display === 'none'`));
    check('iframe 안 요소 지우기', waited >= 0, `반영까지 ${waited}ms; history=${JSON.stringify(await iso('window.__cleanShot.state.history.map((h) => h.kind + ":" + (h.el && h.el.id))'))}`);
    // iframe 안의 링크 클릭이 페이지로 새지 않음
    const ln = await rectInner('#innerLink');
    await click(center(ln).x, center(ln).y);
    const innerState = await main(`(() => { const w = document.getElementById('sameFrame').contentWindow; return { clicks: w.__innerClicks, path: w.location.pathname }; })()`);
    check('iframe 안 링크 클릭이 막힘', innerState.clicks === 0 && innerState.path === '/inner.html', innerState);
    // iframe 을 누른 뒤에도 단축키가 먹음 (포커스가 iframe 으로 가도)
    await key('5');
    check('iframe 안을 누른 뒤에도 단축키 동작', await iso(`window.__cleanShot.state.tool === 'mask'`));
    await key('1');
    // ↑ 로 iframe 자체까지 올라감
    const it = await rectInner('#innerText');
    await move(center(it).x, center(it).y);
    await key('ArrowUp');
    c = await cand();
    check('iframe 안 맨 위 요소에서 ↑ 하면 iframe 자체', c && c.id === 'sameFrame' && !c.inFrame, c);
    await key('ArrowDown');
    c = await cand();
    check('↓ 로 다시 iframe 안으로', c && c.id === 'innerText' && c.inFrame, c);
    // 다른 출처 iframe
    const pe = await main(`getComputedStyle(document.getElementById('xoFrame')).pointerEvents`);
    check('다른 출처 iframe 은 선택 모드 동안 pointer-events:none', pe === 'none', pe);
    r = await rectMain('#xoFrame');
    await move(center(r).x, center(r).y);
    c = await cand();
    check('다른 출처 iframe 을 통째로 고름', c && c.id === 'xoFrame', c);
    await click(center(r).x, center(r).y);
    waited = await waitTrue(() => main(`document.getElementById('xoFrame').style.visibility === 'hidden'`));
    await sleep(150);
    const xo = await main(`({ clicks: window.__xoClicks, vis: document.getElementById('xoFrame').style.visibility, waited: ${waited} })`);
    check('다른 출처 iframe 지우기, 클릭이 iframe 안으로 새지 않음', xo.clicks === 0 && xo.vis === 'hidden', xo);
    // 링크 클릭 차단 (최상위)
    const l1 = await rectMain('#link1');
    await key('5');
    await click(center(l1).x, center(l1).y);
    check('최상위 링크 클릭 차단', await main(`window.__navClicks === 0 && location.pathname === '/main.html'`));
    // 닫으면 모두 원래대로
    await key('Escape');
    await sleep(100);
    const after = await main(`(() => { const f = document.getElementById('xoFrame'); const d = document.getElementById('sameFrame').contentDocument; return { xoStyle: f.getAttribute('style'), xoPe: getComputedStyle(f).pointerEvents, innerStyle: d.getElementById('innerSecret').getAttribute('style'), frameCursor: [...d.querySelectorAll('style')].length, topCursor: !!document.getElementById('__cleanshot_cursor__'), host: !!document.getElementById('__cleanshot_host__'), shadow: document.getElementById('shadowHost').shadowRoot.getElementById('shadowInner').getAttribute('style') }; })()`);
    check('Esc 후 iframe·shadow·커서 스타일이 모두 원래대로', after.xoStyle === null && after.xoPe === 'auto' && after.innerStyle === null && after.frameCursor === 1 && !after.topCursor && !after.host && after.shadow === 'display:inline-block;width:150px;height:40px;background:rgb(255,0,0);color:#fff', after);
  },

  /* 같은 출처 iframe 안 요소의 가리기와 iframe 스크롤 */
  async iframeMask() {
    await freshPage();
    await activate();
    await key('5');
    let r = await rectInner('#innerSecret');
    await click(center(r).x, center(r).y);
    const fr = await rectMain('#sameFrame');
    await wheel(center(fr).x, center(fr).y, 50);
    const sy = await main(`document.getElementById('sameFrame').contentWindow.scrollY`);
    r = await rectInner('#innerSecret');
    const v = (await masks())[0];
    check('iframe 안 요소 가리기: iframe 을 스크롤해도 따라감', sy > 0 && near(v, r), `iframe scrollY=${sy} mask=${fmt(v)} el=${fmt(r)}`);
    await main(`document.getElementById('sameFrame').contentWindow.scrollTo(0, 120)`);
    await sleep(200);
    r = await rectInner('#innerSecret');
    const v2 = (await masks())[0];
    const expect = { x: r.x, y: fr.y, w: r.w, h: r.y + r.h - fr.y };
    check('iframe 안 요소 가리기: iframe 화면 밖으로 나간 부분은 자름', near(v2, expect), `mask=${fmt(v2)} expect=${fmt(expect)}`);
  },

  /* 2 텍스트 되돌리기가 원래 노드 객체를 돌려놓는지 */
  async textUndo() {
    await freshPage();
    await activate();
    await key('4');
    const r = await rectMain('#bold');
    await click(center(r).x, center(r).y);
    check('텍스트 편집 시작', await iso(`window.__cleanShot.state.editing && window.__cleanShot.state.editing.id === 'bold'`));
    await key('a', CTRL);
    await cdp.send('Input.insertText', { text: '바뀐 글자' }, pageS);
    await sleep(80);
    await key('Escape');
    const mid = await main(`({ text: document.getElementById('bold').textContent, sameText: window.__refs.worldText.parentNode === document.getElementById('bold') })`);
    check('편집이 반영됨', mid.text === '바뀐 글자', mid);
    await key('z', CTRL);
    const after = await main(`(() => { const b = document.getElementById('bold'); const p = document.getElementById('textTarget'); return { sameBold: b === window.__refs.bold, sameText: b.firstChild === window.__refs.worldText && b.childNodes.length === 1, sameHello: p.firstChild === window.__refs.hello, text: p.textContent, ce: b.getAttribute('contenteditable') }; })()`);
    check('되돌리기 후 원래 노드 객체와 글자 그대로', after.sameBold && after.sameText && after.sameHello && after.text === 'Hello world!' && after.ce === null, after);
    await key('Escape');
    await main(`document.getElementById('bold').click()`);
    check('되돌린 요소의 이벤트 리스너가 살아 있음', await main(`window.__boldClicks === 1`));
    // 더 깊은 편집: 부모 문단 전체를 고쳐 쓴 뒤 되돌리기
    await activate();
    await key('4');
    const h = await rectMain('#textTarget');
    await click(h.x + 10, center(h).y);
    await key('a', CTRL);
    await cdp.send('Input.insertText', { text: '전부 다른 문장' }, pageS);
    await key('Escape');
    const mid2 = await main(`document.getElementById('textTarget').textContent`);
    await key('z', CTRL);
    const after2 = await main(`(() => { const b = document.getElementById('bold'); const p = document.getElementById('textTarget'); return { sameBold: b === window.__refs.bold, boldParent: b && b.parentNode === p, sameHello: p.firstChild === window.__refs.hello, text: p.textContent }; })()`);
    check('문단 전체를 고친 뒤 되돌려도 하위 요소 객체가 그대로', mid2 === '전부 다른 문장' && after2.sameBold && after2.boldParent && after2.sameHello && after2.text === 'Hello world!', { mid2, ...after2 });
  },

  /* top layer: 모달 dialog */
  async dialog() {
    await freshPage();
    await main(`document.getElementById('dlg').showModal()`);
    await activate();
    const parent = await main(`document.getElementById('__cleanshot_host__').parentElement.id`);
    check('모달 dialog 가 열려 있으면 오버레이를 그 안에 붙임', parent === 'dlg', parent);
    const btn = await iso(`(() => { const b = ${UI}.querySelector('.tool[data-tool="mask"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await click(btn.x, btn.y);
    check('모달이 열린 상태에서 툴바 버튼이 눌림 (inert 아님)', await iso(`window.__cleanShot.state.tool === 'mask'`));
    const r = await rectMain('#dlgSecret');
    await click(center(r).x, center(r).y);
    const v = (await masks())[0];
    check('dialog 안 요소 가리기', near(v, r), `mask=${fmt(v)} el=${fmt(r)}`);
    const hitMask = await main(`(() => { const e = document.elementFromPoint(${center(r).x}, ${center(r).y}); return e && e.id; })()`);
    const shot = await captureAndRead();
    const br = shot.img ? blackRatio(shot.img, ...Object.values(scaled(r))) : -1;
    check('dialog 안 요소: 캡처 PNG 에서 검정', br > 0.999, `black=${br.toFixed(4)} ${JSON.stringify(shot.last)}`);
    await sleep(900);
    // 모달이 나중에 열리는 경우
    await main(`document.getElementById('dlg').close()`);
    await activate();
    await main(`document.getElementById('dlg').showModal()`);
    await sleep(100);
    const parent2 = await main(`document.getElementById('__cleanshot_host__').parentElement.id`);
    check('켠 뒤에 모달이 열려도 오버레이를 그 안으로 옮김', parent2 === 'dlg', parent2);
    await main(`document.getElementById('dlg').close()`);
    await sleep(100);
    const parent3 = await main(`(() => { const h = document.getElementById('__cleanshot_host__'); return { parent: h.parentElement.tagName, open: h.matches(':popover-open') }; })()`);
    check('모달이 닫히면 오버레이를 body 로 되돌림', parent3.parent === 'BODY' && parent3.open, parent3);
  },

  /* top layer: 페이지 popover 가 오버레이보다 나중에 열려도 PNG 에는 검정이 남는다 (service worker 가 직접 칠함) */
  async popoverBurn() {
    await freshPage();
    await activate();
    await main(`document.getElementById('pop').showPopover()`);
    await sleep(100);
    await key('5');
    const r = await rectMain('#popSecret');
    await click(center(r).x, center(r).y);
    const v = (await masks())[0];
    check('popover 안 요소 가리기', near(v, r), `mask=${fmt(v)} el=${fmt(r)}`);
    // 화면의 박스를 일부러 숨겨, PNG 의 검정이 service worker 가 칠한 것인지 확인한다
    await iso(`${UI}.querySelector('.masks').style.visibility = 'hidden'`);
    const shot = await captureAndRead();
    const br = shot.img ? blackRatio(shot.img, ...Object.values(scaled(r))) : -1;
    check('화면의 박스가 없어도 PNG 에 검정이 칠해짐 (service worker)', br > 0.999, `black=${br.toFixed(4)} ${JSON.stringify(shot.last)}`);
    // 가리지 않은 부분은 그대로
    const pr = await rectMain('#pop');
    const px = shot.img ? pixel(shot.img, Math.round((pr.x + pr.w - 4) * DPR), Math.round((pr.y + pr.h / 2) * DPR)) : null;
    check('가리지 않은 popover 테두리 안쪽 픽셀은 흰색 그대로', px && px[0] === 255 && px[1] === 255 && px[2] === 255, px);
  },

  /* 클립보드에 복사 (C 키): 막히면 정리한 상태를 두고 알림, 되면 가리기를 칠한 PNG 가 클립보드에 들어가고 파일은 만들지 않음 */
  async clipboard() {
    const ORIGIN = `http://127.0.0.1:${WEB}`;
    const toastText = () => iso(`(() => { const h = document.getElementById('__cleanshot_host__'); return h ? chrome.dom.openOrClosedShadowRoot(h).querySelector('.toast').textContent : ''; })()`);
    const waitToast = async (re) => {
      let t = '';
      for (let i = 0; i < 160 && !re.test(t); i++) { t = await toastText(); await sleep(25); }
      return t;
    };
    await freshPage();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pageS);
    await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name: 'clipboard-write' }, setting: 'denied' });
    try {
      await activate();
      await key('5');
      const r = await rectMain('#fixedSecret');
      await click(center(r).x, center(r).y);
      const before = new Set(listFiles());

      // 1) 클립보드 쓰기가 막힌 경우
      await key('c');
      const t1 = await waitToast(/복사하지 못했습니다|복사했습니다/);
      await sleep(300);
      const stillOn = await iso(`!!(window.__cleanShot && window.__cleanShot.state.active && window.__cleanShot.state.masks.length === 1)`);
      check('클립보드가 막히면 이유를 알리고, 정리한 상태(가리기)는 그대로 둠', /클립보드에 복사하지 못했습니다/.test(t1) && stillOn, `${t1} active+mask=${stillOn}`);

      // 2) 허용된 경우 — 한글 입력 상태(ㅊ)로 눌러도 C 키로 본다
      await cdp.send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      await iso(`(() => { const h = document.getElementById('__cleanshot_host__'); chrome.dom.openOrClosedShadowRoot(h).querySelector('.toast').textContent = ''; return true; })()`);   // 앞의 알림을 지운다
      await key('ㅊ');
      const t2 = await waitToast(/클립보드에 복사했습니다|복사하지 못했습니다/);
      check('C 키(한글 입력 상태 포함): 클립보드에 복사했다고 알림', /클립보드에 복사했습니다/.test(t2), t2);
      await sleep(900);
      check('복사는 파일로 저장하지 않음', listFiles().filter((f) => !before.has(f)).length === 0);
      const box = scaled(r);
      const clip = await main(`(async () => {
        const items = await navigator.clipboard.read();
        const it = items.find((x) => x.types.includes('image/png'));
        if (!it) return { types: items.map((x) => x.types) };
        const bmp = await createImageBitmap(await it.getType('image/png'));
        const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
        const r = ${JSON.stringify(box)};
        const d = x.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
        let black = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) black++;
        return { w: bmp.width, h: bmp.height, black: black / (d.length / 4), vw: Math.round(innerWidth * devicePixelRatio) };
      })()`);
      check('클립보드의 PNG 는 보이는 화면 크기이고 가리기가 칠해짐', !!clip && clip.w === clip.vw && clip.black > 0.999, JSON.stringify(clip));
      const off = await iso(`!(window.__cleanShot && window.__cleanShot.state.active)`);
      check('복사한 뒤에는 전체 복원 후 닫힘 (저장과 같음)', off);
    } finally {
      await cdp.send('Browser.resetPermissions', {}).catch(() => {});
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, pageS).catch(() => {});
      await sleep(300);
    }
  },

  /* 3 저장 실패 시 대체 경로 */
  async fallback() {
    await freshPage();
    const patched = await sw(`(() => { self.__origDownload = chrome.downloads.download; try { chrome.downloads.download = () => Promise.reject(new Error('시험용 차단')); } catch (e) {} if (chrome.downloads.download === self.__origDownload) { Object.defineProperty(chrome.downloads, 'download', { value: () => Promise.reject(new Error('시험용 차단')), configurable: true, writable: true }); } return chrome.downloads.download !== self.__origDownload; })()`);
    check('시험 준비: downloads.download 를 실패하게 바꿈', patched);
    try {
      await activate();
      await key('5');
      const r = await rectMain('#fixedSecret');
      await click(center(r).x, center(r).y);
      const before = new Set(listFiles());
      await key('Enter');
      // 안내 문구는 700ms 뒤 피커가 닫히면 사라진다 — 파일을 기다리기 전에 읽어 둔다
      let t = '';
      for (let i = 0; i < 80 && !/저장했습니다|실패/.test(t); i++) {
        t = await iso(`(() => { const h = document.getElementById('__cleanshot_host__'); return h ? chrome.dom.openOrClosedShadowRoot(h).querySelector('.toast').textContent : ''; })()`);
        await sleep(25);
      }
      const file = await waitNewPng(before);
      const last = await sw(`self.__lastCapture`);
      check('downloads 실패 시 페이지에서 내려받음', !!file && path.dirname(file) === DL, `${file ? path.basename(file) : 'no file'} ${JSON.stringify(last)}`);
      check('대체 저장 안내 문구', /브라우저 다운로드로 저장했습니다/.test(t), t);
      if (file) {
        const img = decodePng(fs.readFileSync(file));
        const br = blackRatio(img, ...Object.values(scaled(r)));
        check('대체 저장된 PNG 에도 가리기가 들어감', br > 0.999, `black=${br.toFixed(4)}`);
      }
    } finally {
      await sw(`(() => { try { chrome.downloads.download = self.__origDownload; } catch (e) {} if (chrome.downloads.download !== self.__origDownload) Object.defineProperty(chrome.downloads, 'download', { value: self.__origDownload, configurable: true, writable: true }); return chrome.downloads.download === self.__origDownload; })()`);
      await sleep(900);
    }
  },

  /* 여러 가리기를 한 번에 캡처 + 가리지 않은 것은 남는지 + 정리 후 원상복구 */
  async fullCapture() {
    await freshPage();
    const snapBefore = await main(`JSON.stringify([...document.querySelectorAll('*')].map((e) => e.getAttribute('style')))`);
    await activate();
    await key('5');
    const ids = ['#fixedSecret', '#flowSecret', '#scrollSecret'];
    const rects = [];
    for (const s of ids) { const r = await rectMain(s); rects.push(r); await click(center(r).x, center(r).y); }
    const ri = await rectInner('#innerSecret');
    rects.push(ri);
    await click(center(ri).x, center(ri).y);
    const rs = await rectShadow('#shadowHost', 'shadowInner', false);
    rects.push(rs);
    await click(center(rs).x, center(rs).y);
    // 영역 가리기 하나
    await drag(700, 120, 800, 160, SHIFT);
    rects.push({ x: 700, y: 120, w: 100, h: 40 });
    const shot = await captureAndRead();
    if (!shot.img) { check('캡처 파일', false, 'no file'); return; }
    const vw = await main('innerWidth');
    check(`PNG 크기 = 화면 × DPR(${DPR})`, shot.img.width === Math.round(vw * DPR), `${shot.img.width}x${shot.img.height} vw=${vw}`);
    rects.forEach((r, i) => {
      const br = blackRatio(shot.img, ...Object.values(scaled(r)));
      check(`가린 영역 ${i + 1} 이 PNG 에서 검정`, br > 0.999, `${fmt(r)} black=${br.toFixed(4)}`);
    });
    const rc = await rectShadow('#closedHost', 'closedInner', true);
    const px = pixel(shot.img, Math.round((rc.x + 10) * DPR), Math.round((rc.y + rc.h / 2) * DPR));
    check('가리지 않은 빨간 요소는 빨강 그대로', px[0] === 255 && px[1] === 0 && px[2] === 0, px);
    const barPx = pixel(shot.img, Math.round(vw / 2 * DPR), Math.round((await main('innerHeight') - 40) * DPR));
    check('툴바가 PNG 에 새지 않음 (툴바 자리 픽셀이 툴바 색이 아님)', !(barPx[0] < 40 && barPx[1] < 40 && barPx[2] < 45 && barPx[0] > 10), barPx);
    console.log('   capture timing:', JSON.stringify(shot.last));
    await sleep(1000);
    const snapAfter = await main(`JSON.stringify([...document.querySelectorAll('*')].map((e) => e.getAttribute('style')))`);
    check('저장 후 페이지 인라인 스타일이 모두 원래대로', snapAfter === snapBefore);
  },

  /* 전체 페이지(문서 스크롤): 띠가 모두 제자리, 고정 머리글·바닥글은 한 번씩, sticky 는 제자리 한 번,
     장마다 가리기, transform 안 fixed 는 내용과 함께, 끝나면 스크롤·스타일 복원 */
  async fullPageDoc() {
    await freshPage(FULL_URL());
    const L = await fullLayout();
    await main('scrollTo(0, 700)');
    await sleep(150);
    const styleBefore = await styleSnap();
    await activate();
    await key('5');
    const hs = await rectMain('#hdrSecret');
    await click(center(hs).x, center(hs).y);
    await main(`document.getElementById('deep').scrollIntoView({ block: 'center' })`);
    await sleep(250);
    const dp = await rectMain('#deep');
    await click(center(dp).x, center(dp).y);
    await main('scrollTo(0, 700)');
    await sleep(250);
    check('전체 페이지 준비: 가리기 2개 (고정 머리글 안, 아래쪽)', (await masks()).length === 2);

    const shot = await fullShot(() => key('Enter', SHIFT));
    if (!shot.img) { check('전체 페이지 PNG 저장 (Shift+Enter)', false, `파일 없음 ${JSON.stringify(shot.toasts)}`); return; }
    const img = shot.img;
    const at = (x, y) => pixel(img, Math.round(x * DPR), Math.round(y * DPR));
    const X = 1000; // 다른 요소가 없는 세로줄
    console.log(`   전체 페이지 ${Math.ceil(L.H / L.vh)}장 ${img.width}x${img.height}: ${shot.ms}ms`);
    check('전체 페이지: 파일 이름이 -full.png 로 끝남', /-full\.png$/.test(shot.file), path.basename(shot.file));
    check('전체 페이지: PNG 크기 = 문서 너비(스크롤 막대 제외) × 전체 높이 × DPR',
      Math.abs(img.width - L.W * DPR) <= 1 && Math.abs(img.height - L.H * DPR) <= 1, `${img.width}x${img.height} 기대 ${L.W * DPR}x${L.H * DPR}`);

    const exp = fullExpect(L);
    const col = columnErrors(img, X, DPR, exp);
    check('전체 페이지: 세로줄 전체가 문서와 같음 (띠 제자리, 이음매 빈 줄 없음, 머리글·바닥글·sticky 되풀이 없음)',
      col.length === 0, col.length ? col.slice(0, 4) : `띠 ${L.bands.length}개, ${img.height}줄`);
    check('고정 머리글: 맨 위에 한 번', sameRgb(at(X, 25), HDR), at(X, 25));
    check('고정 바닥글: 맨 아래에 한 번', sameRgb(at(X, L.H - 20), FTR) && sameRgb(at(X, L.H - 39), FTR), [at(X, L.H - 39), at(X, L.H - 20)]);
    check('sticky 막대: 제자리에 한 번', sameRgb(at(X, L.stk.y + 15), GREEN), at(X, L.stk.y + 15));

    const br1 = blackRatio(img, ...Object.values(scaled(L.hs)));
    check('고정 머리글 안 요소 가리기: 맨 위에 검정', br1 > 0.999, `black=${br1.toFixed(4)}`);
    const col2 = columnErrors(img, L.hs.x + 60, DPR, (y) => (y >= L.deep.y && y < L.deep.y + L.deep.h ? BLACK : exp(y)));
    check('고정 머리글 안 요소 가리기: 다음 장들에 검정 박스가 되풀이되지 않음 (그 세로줄 전체가 문서와 같음)', col2.length === 0, col2.slice(0, 4));
    const br2 = blackRatio(img, ...Object.values(scaled(L.deep)));
    check('아래쪽 요소 가리기: 제자리에 검정', br2 > 0.999, `black=${br2.toFixed(4)} ${fmt(L.deep)}`);
    check('transform 안의 fixed 요소는 내용과 함께 제자리에', sameRgb(at(L.tfix.x + 50, L.tfix.y + 20), BLUE), at(L.tfix.x + 50, L.tfix.y + 20));

    await sleep(1200);
    const sy = await main('scrollY');
    check('전체 캡처 뒤 스크롤 위치 복원', Math.abs(sy - 700) < 1, sy);
    check('전체 캡처 뒤 페이지 인라인 스타일이 모두 원래대로', (await styleSnap()) === styleBefore);
    check('전체 캡처 뒤 피커가 닫힘', !(await iso('window.__cleanShot.state.active')));
    const s = await swFull();
    check('전체 캡처 뒤 service worker 정리 (진행 목록 비움, 배지 지움)', s.runs === 0 && s.badge === '', s);
  },

  /* 전체 페이지(안쪽 스크롤 영역): 문서는 스크롤되지 않는 관리 화면. 툴바의 "전체" 버튼으로 찍는다. */
  async fullPagePanel() {
    await freshPage(`http://127.0.0.1:${WEB}/panel.html`);
    const L = await main(`(() => {
      const m = document.getElementById('main');
      const mr = m.getBoundingClientRect();
      const clip = { x: mr.left + m.clientLeft, y: mr.top + m.clientTop, w: m.clientWidth, h: m.clientHeight };
      const c = (el) => { const b = el.getBoundingClientRect(); return { x: b.left - clip.x, y: b.top - clip.y + m.scrollTop, w: b.width, h: b.height }; };
      const f = document.getElementById('fab').getBoundingClientRect();
      return { clip, total: m.scrollHeight, bands: [...m.querySelectorAll('.band')].map((b, i) => ({ ...c(b), c: window.__bandColor(i) })),
        stk: c(document.getElementById('pstk')), secret: c(document.getElementById('psecret')),
        fab: { x: f.left - clip.x, y: f.top - clip.y, w: f.width, h: f.height } };
    })()`);
    await main(`document.getElementById('main').scrollTop = 300`);
    await sleep(150);
    const styleBefore = await styleSnap();
    await activate();
    await key('5');
    await main(`document.getElementById('psecret').scrollIntoView({ block: 'center' })`);
    await sleep(250);
    const ps = await rectMain('#psecret');
    await click(center(ps).x, center(ps).y);
    await main(`document.getElementById('main').scrollTop = 300`);
    await sleep(250);

    const btn = await uiRect('.full');
    const shot = await fullShot(() => click(center(btn).x, center(btn).y), { want: /스크롤 영역 전체를 저장했습니다/ });
    if (!shot.img) { check('스크롤 영역: PNG 저장 ("전체" 버튼)', false, `파일 없음 ${JSON.stringify(shot.toasts)}`); return; }
    const img = shot.img;
    const at = (x, y) => pixel(img, Math.round(x * DPR), Math.round(y * DPR));
    const X = 400;
    console.log(`   스크롤 영역 ${Math.ceil(L.total / L.clip.h)}장 ${img.width}x${img.height}: ${shot.ms}ms`);
    check('스크롤 영역: PNG 크기 = 영역 너비 × 내용 높이 × DPR (머리글·옆 메뉴 빠짐)',
      Math.abs(img.width - L.clip.w * DPR) <= 1 && Math.abs(img.height - L.total * DPR) <= 1, `${img.width}x${img.height} 기대 ${L.clip.w * DPR}x${L.total * DPR}`);
    check('스크롤 영역: 맨 위가 머리글이 아니라 첫 띠', sameRgb(at(X, 20), L.bands[0].c), at(X, 20));
    check('스크롤 영역 안내 문구', shot.toasts.some((t) => /스크롤 영역 전체를 저장했습니다/.test(t)), shot.toasts);
    const pexp = (y) => {
      if (y >= L.stk.y && y < L.stk.y + L.stk.h) return GREEN;
      if (y >= L.secret.y - 30 && y < L.secret.y + L.secret.h + 30) return WHITE; // #psecret 이 있는 줄(여백 포함)의 빈 바탕
      const b = L.bands.find((q) => y >= q.y && y < q.y + q.h);
      return b ? b.c : null;
    };
    const col = columnErrors(img, X, DPR, pexp);
    check('스크롤 영역: 세로줄 전체가 내용과 같음 (띠 제자리, 이음매 빈 줄 없음, sticky 되풀이 없음)', col.length === 0, col.slice(0, 4));
    check('스크롤 영역 sticky: 제자리에 한 번', sameRgb(at(X, L.stk.y + 15), GREEN), at(X, L.stk.y + 15));
    const br = blackRatio(img, ...Object.values(scaled(L.secret)));
    check('스크롤 영역 안 요소 가리기: 제자리에 검정', br > 0.999, `black=${br.toFixed(4)} ${fmt(L.secret)}`);
    const fabY = L.total - L.clip.h + L.fab.y; // 마지막 장(맨 끝)에서 버튼이 놓이는 내용 좌표
    check('화면에 붙은 버튼(fixed): 마지막 장 자리에 한 번', sameRgb(at(L.fab.x + 25, fabY + 25), BLUE), at(L.fab.x + 25, fabY + 25));
    const colFab = columnErrors(img, L.fab.x + 25, DPR, (y) => (y >= fabY && y < fabY + L.fab.h ? BLUE : pexp(y)));
    check('화면에 붙은 버튼(fixed): 앞 장들에는 없음 (그 세로줄 전체가 내용과 같음)', colFab.length === 0, colFab.slice(0, 4));

    await sleep(1200);
    const st = await main(`document.getElementById('main').scrollTop`);
    check('스크롤 영역 캡처 뒤 스크롤 위치 복원', Math.abs(st - 300) < 1, st);
    check('스크롤 영역 캡처 뒤 인라인 스타일이 모두 원래대로', (await styleSnap()) === styleBefore);
  },

  /* 전체 캡처 도중 Esc: 저장하지 않고, 찍느라 바꾼 것만 되돌리고, 사용자가 정리한 것은 남긴다 */
  async fullPageCancel() {
    await freshPage(FULL_URL('?bands=80'));
    await main('scrollTo(0, 400)');
    await sleep(150);
    await activate();
    await key('1');
    const b = await rectMain('#band5');
    await click(center(b).x, center(b).y);
    check('멈춤 시험 준비: 띠 하나를 지움', await main(`document.getElementById('band5').style.visibility === 'hidden'`));
    const before = new Set(listFiles());
    await key('Enter', SHIFT);
    await sleep(2300); // 안내 0.7초 + 두세 장
    const mid = await main('scrollY');
    const midRuns = (await swFull()).runs;
    await key('Escape');
    let t = '';
    for (let i = 0; i < 160 && !/멈췄습니다/.test(t); i++) { t = await toastText().catch(() => ''); await sleep(25); }
    await sleep(1500);
    const files = newPngs(before);
    check('멈추면 파일을 저장하지 않음', files.length === 0, files.map((f) => path.basename(f)));
    check('멈춤 안내 문구', /멈췄습니다/.test(t), t);
    const s = await main(`({ sy: scrollY, vis: document.getElementById('band5').style.visibility, hdr: document.getElementById('hdr').getAttribute('style'), ftr: document.getElementById('ftr').getAttribute('style'), stk: document.getElementById('stk').getAttribute('style'), html: document.documentElement.getAttribute('style'), body: document.body.getAttribute('style') })`);
    check('멈춘 뒤 스크롤 위치와 찍느라 바꾼 스타일 복원, 정리한 것은 그대로',
      Math.abs(s.sy - 400) < 1 && s.vis === 'hidden' && s.hdr === null && s.ftr === null && s.stk === null && s.html === null && s.body === null, { mid, midRuns, ...s });
    check('멈춘 뒤 피커는 켜진 채 다시 쓸 수 있음', await iso('window.__cleanShot.state.active && !window.__cleanShot.state.busy && !window.__cleanShot.state.full'));
    const w = await swFull();
    check('멈춘 뒤 service worker 가 쌓던 이미지를 버리고 배지를 지움', w.runs === 0 && w.badge === '', w);
    await key('Escape');
  },

  /* 찍는 사이 탭이 활성 탭이 아니게 되면(시험에서는 확인 함수를 바꿔 흉내) 멈추고 저장하지 않는다 */
  async fullPageSwitchSim() {
    await freshPage(FULL_URL('?bands=60'));
    await sw(`(() => { self.__origStill = stillActive; let n = 0; stillActive = async (run) => (++n <= 3) && self.__origStill(run); })()`);
    try {
      await activate();
      const before = new Set(listFiles());
      await key('Enter', SHIFT);
      let t = '';
      for (let i = 0; i < 300 && !/다른 탭/.test(t); i++) { t = await toastText().catch(() => ''); await sleep(40); }
      await sleep(1200);
      check('활성 탭이 아니게 되면 멈추고 알림', /다른 탭으로 바뀌어 멈췄습니다/.test(t), t);
      check('활성 탭이 아니게 되면 저장하지 않음', newPngs(before).length === 0, newPngs(before).map((f) => path.basename(f)));
      const w = await swFull();
      check('멈춘 뒤 service worker 정리', w.runs === 0 && w.badge === '', w);
      check('멈춘 뒤 스크롤 위치 복원', Math.abs((await main('scrollY')) - 0) < 1);
    } finally {
      await sw(`stillActive = self.__origStill`);
    }
    await key('Escape');
  },

  /* 실제로 다른 탭을 열었다 닫아도, 다른 탭 화면(자홍색)이 저장된 이미지에 섞이지 않는다 */
  async fullPageSwitch() {
    await freshPage(FULL_URL('?bands=80'));
    await activate();
    const before = new Set(listFiles());
    await key('Enter', SHIFT);
    await sleep(1800);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'data:text/html,<body style="margin:0;background:rgb(250,0,250)"></body>' });
    await sleep(2500);
    const activeUrl = await sw(`chrome.tabs.query({ active: true }).then((t) => t.map((x) => (x.url || x.pendingUrl || '').slice(0, 24)))`);
    await cdp.send('Target.closeTarget', { targetId });
    await cdp.send('Target.activateTarget', { targetId: pageTargetId });
    for (let i = 0; i < 600; i++) {
      if (!(await iso('!!window.__cleanShot.state.busy').catch(() => false))) break;
      await sleep(50);
    }
    await sleep(1500);
    let t = await toastText().catch(() => '');
    const files = newPngs(before);
    let magenta = 0;
    for (const f of files) {
      const img = decodePng(fs.readFileSync(f));
      for (let y = 0; y < img.height; y += 7) for (let x = 0; x < img.width; x += 13) if (sameRgb(pixel(img, x, y), [250, 0, 250])) magenta++;
    }
    console.log(`   다른 탭 연 동안 활성 탭: ${JSON.stringify(activeUrl)} → 결과: ${files.length ? '끝까지 찍어 저장' : '멈춤'} ${t}`);
    check('다른 탭을 연 동안 그 탭 화면이 이미지에 섞이지 않음', magenta === 0, { files: files.map((f) => path.basename(f)), magenta });
    const w = await swFull();
    check('다른 탭 시험 뒤 service worker 정리', w.runs === 0 && w.badge === '', w);
    if (await iso('window.__cleanShot.state.active').catch(() => false)) await key('Escape');
  },

  /* 너무 긴 페이지: 캔버스 한도(시험에서 1500px 로 줄임)까지만 저장하고 알린다 */
  async fullPageTruncate() {
    await freshPage(FULL_URL());
    const W = await main('document.documentElement.clientWidth');
    const L = await fullLayout();
    await sw(`FULL_LIMITS.area = ${Math.round(W * DPR)} * ${Math.round(1500 * DPR)}`);
    try {
      await activate();
      const shot = await fullShot(() => key('Enter', SHIFT), { want: /너무 길어/ });
      if (!shot.img) { check('긴 페이지: PNG 저장', false, `파일 없음 ${JSON.stringify(shot.toasts)}`); return; }
      const img = shot.img;
      check('긴 페이지: 한도 높이까지만 저장', Math.abs(img.height - 1500 * DPR) <= 1 && Math.abs(img.width - W * DPR) <= 1, `${img.width}x${img.height}`);
      check('긴 페이지: 잘랐다는 안내', shot.toasts.some((t) => /너무 길어 위에서 1500px 까지만/.test(t)), shot.toasts);
      const col = columnErrors(img, 1000, DPR, fullExpect(L, 1500));
      check('긴 페이지: 저장한 부분의 세로줄 전체가 문서와 같음', col.length === 0, col.slice(0, 4));
      check('긴 페이지: 바닥글은 저장한 부분의 맨 아래에', sameRgb(pixel(img, Math.round(1000 * DPR), Math.round(1480 * DPR)), FTR), pixel(img, Math.round(1000 * DPR), Math.round(1480 * DPR)));
    } finally {
      await sw(`FULL_LIMITS.area = 2 ** 26`);
    }
    await sleep(900);
  },

  /* 페이지 확대 150% 에서도 이어 붙인 자리가 맞는지 */
  async fullPageZoom() {
    await freshPage(FULL_URL());
    await sw(`(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); await chrome.tabs.setZoom(tab.id, 1.5); })()`);
    await sleep(500);
    try {
      const L = await fullLayout();
      await activate();
      const shot = await fullShot(() => key('Enter', SHIFT));
      if (!shot.img) { check('확대 150% 전체 페이지: PNG 저장', false, `파일 없음 ${JSON.stringify(shot.toasts)}`); return; }
      const img = shot.img;
      const z = DPR * 1.5;
      const X = 600; // 확대하면 화면 너비가 약 850 CSS px 로 줄어든다
      check('확대 150% 전체 페이지: PNG 크기 = 문서 × 배율 × 1.5', Math.abs(img.width - L.W * z) <= 2 && Math.abs(img.height - L.H * z) <= 2, `${img.width}x${img.height} 기대 ${L.W * z}x${L.H * z}`);
      const col = columnErrors(img, X, z, fullExpect(L));
      check('확대 150% 전체 페이지: 세로줄 전체가 문서와 같음 (이음매 빈 줄 없음)', col.length === 0, col.slice(0, 4));
      check('확대 150% 전체 페이지: 바닥글이 맨 아래에', sameRgb(pixel(img, Math.round(X * z), img.height - Math.round(20 * z)), FTR), pixel(img, Math.round(X * z), img.height - Math.round(20 * z)));
    } finally {
      await sw(`(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${WEB}/*' }); await chrome.tabs.setZoom(tab.id, 1); })()`);
      await sleep(900);
    }
  },

  /* 가리기 없을 때 저장 시간 (빠른 경로 유지 확인) */
  async timing() {
    await freshPage();
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await activate();
      const before = new Set(listFiles());
      const t0 = Date.now();
      await key('Enter');
      const f = await waitNewPng(before);
      const last = await sw(`self.__lastCapture`);
      runs.push({ none: last.ms, e2e: Date.now() - t0, ok: !!f });
      await sleep(900);
    }
    for (let i = 0; i < 3; i++) {
      await activate();
      await key('5');
      const r = await rectMain('#fixedSecret');
      await click(center(r).x, center(r).y);
      const before = new Set(listFiles());
      const t0 = Date.now();
      await key('Enter');
      const f = await waitNewPng(before);
      const last = await sw(`self.__lastCapture`);
      runs.push({ withMask: last.ms, e2e: Date.now() - t0, ok: !!f });
      await sleep(900);
    }
    console.log('   timing runs (service worker ms, e2e ms incl. polling):', JSON.stringify(runs));
    check('저장 시간 측정 완료', runs.every((x) => x.ok));
  }
};

let exitCode = 0;
try {
  await setup();
  for (const [name, fn] of Object.entries(cases)) {
    if (ONLY ? !ONLY.includes(name) : name === 'screens') continue; // screens 는 눈으로 볼 화면만 저장한다
    console.log(`\n== ${name} (DPR ${DPR})`);
    try { await fn(); } catch (err) { check(`${name} 실행`, false, String(err && err.stack || err)); }
  }
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (DPR ${DPR})`);
  if (failed.length) { exitCode = 1; console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); }
  if (consoleLines.length) console.log('page console:', consoleLines.slice(-10));
  cdp.close();
  proc.kill();
  servers.forEach((s) => s.close());
  await sleep(500);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) { /* 브라우저가 아직 파일을 잡고 있을 수 있음 */ }
  process.exitCode = exitCode;
}
