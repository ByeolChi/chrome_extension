// ClickGuide 따라하기 E2E (Playwright Chromium + CDP 직접 제어)
// 실행: 저장소 최상위에서 node tests/e2e/click-guide/play.mjs [--headed]
//  1. 시험 페이지(play.html)에서 실제로 녹화한다: data-testid 버튼, 입력칸, 목록, 같은 글자의 '저장' 둘 중 하나,
//     shadow DOM 버튼, 같은 출처·다른 출처 iframe 버튼, 다른 화면으로 가는 링크, 그 화면의 버튼
//  2. 새 탭에서 따라 한다: 단계마다 표시가 맞는 요소에 있는지, 그 요소를 실제로 누르면(입력하면) 다음 단계로 가는지,
//     페이지가 바뀌어도 카드가 이어지는지, 화면 이동 단계가 저절로 넘어가는지
//  3. 바뀐 화면(play2.html: id·클래스·구조가 다름)에서도 찾는지, 못 찾으면 녹화 화면과 [이 화면 열기]를 보여 주는지
//  4. 늦게 그려지는 버튼, 예전 형식(새 단서 없는) 가이드, 카드 단추(이전·끝내기), 탭을 닫으면 끝남, 녹화와 겹치지 않음
//  5. 가이드 파일(가이드 하나) 내보내기 → 지우기 → 편집기 [가져오기] → 같은 가이드를 다시 가져오면 바꿀지 묻고 바꿈,
//     편집기에서 내려받은 가이드 파일 속 스크린샷에 편집기에서 더 가린 곳이 칠해져 있는지
//  6. 주소만 바꾸는 화면(play-spa.html)과 같은 단추를 연달아 누르는 단계를 사람처럼 눌러(누르고 0.12초 뒤 뗌) 따라 한다
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChromium, evaluate, sleep } from './cdp.mjs';
import { startServers } from './server.mjs';
import { tempDir } from '../lib/chromium.mjs';

const EXT = path.resolve(process.env.CG_EXT || fileURLToPath(new URL('../../../click-guide', import.meta.url)));
const PROFILE = tempDir('click-guide-play-');
const PORT = Number(process.env.CDP_PORT) || 9304;
const P1 = 18941;
const A = `http://127.0.0.1:${P1}`;
const HEADED = process.argv.includes('--headed');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
// CG_SHOTS=<폴더> 를 주면 눈으로 볼 화면을 남긴다 (밝게·어둡게)
const SHOTS = process.env.CG_SHOTS || '';

const servers = await startServers([P1, P1 + 1]);
const { proc, cdp } = await launchChromium({ extPath: EXT, userDataDir: PROFILE, port: PORT, headless: !HEADED });

/* ---------------- 대상·실행 컨텍스트 ---------------- */
const contexts = new Map();   // sessionId -> Map(contextId -> context)
cdp.on((m) => {
  if (!m.sessionId) return;
  if (m.method === 'Runtime.executionContextCreated') {
    if (!contexts.has(m.sessionId)) contexts.set(m.sessionId, new Map());
    contexts.get(m.sessionId).set(m.params.context.id, m.params.context);
  } else if (m.method === 'Runtime.executionContextDestroyed') {
    const c = contexts.get(m.sessionId); if (c) c.delete(m.params.executionContextId);
  } else if (m.method === 'Runtime.executionContextsCleared') {
    contexts.set(m.sessionId, new Map());
  } else if (m.method === 'Page.javascriptDialogOpening') {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {});
  }
});

await cdp.send('Target.setDiscoverTargets', { discover: true });
let extId = null;
for (let i = 0; i < 60 && !extId; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && /service-worker\.js$/.test(t.url));
  if (sw) extId = new URL(sw.url).host;
  else await sleep(200);
}
if (!extId) throw new Error('확장 서비스 워커를 찾지 못했습니다');

async function attach(targetId, url = '') {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId, url };
}

async function openPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const page = await attach(targetId);
  if (url) await navigate(page, url);
  return page;
}

async function navigate(page, url) {
  const loaded = cdp.waitFor((m) => m.sessionId === page.sessionId && m.method === 'Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url }, page.sessionId);
  await loaded;
  page.url = url;
}

const pageEval = (page, expr) => evaluate(cdp, page.sessionId, expr);
let ext = await openPage(`chrome-extension://${extId}/src/options/options.html`);
const extEval = (expr) => pageEval(ext, expr);
const sendMsg = (msg) => extEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

async function tabIdOf(page) {
  const info = await cdp.send('Target.getTargetInfo', { targetId: page.targetId });
  const tabs = await extEval(`chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`);
  const hits = tabs.filter((x) => x.url === info.targetInfo.url);
  return hits.length === 1 ? hits[0].id : null;
}

async function activate(page) {
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  const id = await tabIdOf(page);
  if (id) await extEval(`chrome.tabs.update(${id}, {active:true}).then(()=>true)`);
  await sleep(250);
}

// 새로 열린 탭(대상) 중 주소가 맞는 것에 붙는다
async function attachNewPage(urlPart, known, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'page' && x.url.includes(urlPart) && !known.has(x.targetId));
    if (t) return attach(t.targetId, t.url);
    await sleep(150);
  }
  throw new Error('새 탭을 찾지 못했습니다: ' + urlPart);
}
const knownTargets = async () => new Set((await cdp.send('Target.getTargets')).targetInfos.map((t) => t.targetId));

async function click(page, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.sessionId);
}
async function key(page, k, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }, page.sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, page.sessionId);
}
// 사람처럼 누르기: 누르고 떼기 사이에 시간이 있다. 위 click() 은 바로 떼서, 그 사이에 일어나는 일(누를 때 다음 단계로 넘어감)을 못 본다
async function humanClick(page, x, y, holdMs = 120) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.sessionId);
  await sleep(holdMs);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.sessionId);
}
// 포커스가 있는 단추를 Enter 로 누르기 (text 가 있어야 단추가 눌린다)
async function pressEnter(page) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, page.sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId);
}

/* 요소의 화면 위치 (맨 위 화면 기준). where: 맨 위 선택자 / 'shadow' / 'inner:<선택자>' / 'xo' (다른 출처 iframe 의 버튼) */
async function rectOf(page, where) {
  return pageEval(page, `(() => {
    const w = ${JSON.stringify(where)};
    const box = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
    if (w === 'shadow') return box(document.querySelector('x-picker').shadowRoot.querySelector('button').getBoundingClientRect());
    if (w.startsWith('inner:')) {
      const f = document.querySelector('iframe[src="/play-frame.html"]');
      const fr = f.getBoundingClientRect();
      const r = f.contentDocument.querySelector(w.slice(6)).getBoundingClientRect();
      return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height };
    }
    if (w === 'xo') {   // 다른 출처라 안을 볼 수 없다: 시험 페이지에서 정한 자리 (20, 20, 160×36)
      const f = document.querySelector('iframe[src*="play-xframe"]');
      const fr = f.getBoundingClientRect();
      return { x: fr.left + f.clientLeft + 20, y: fr.top + f.clientTop + 20, w: 160, h: 36 };
    }
    const el = document.querySelector(w);
    return el ? box(el.getBoundingClientRect()) : null;
  })()`);
}
const center = (r) => [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)];
async function clickAt(page, where) {
  const r = await rectOf(page, where);
  if (!r) throw new Error('요소 없음: ' + where);
  await click(page, ...center(r));
  return r;
}

/* 맨 위 프레임의 콘텐츠 스크립트(격리된 환경)에서 평가 */
async function topIsolated(page) {
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, page.sessionId);
  const main = frameTree.frame.id;
  const all = [...(contexts.get(page.sessionId) || new Map()).values()];
  return all.filter((c) => c.auxData && c.auxData.type === 'isolated' && c.auxData.frameId === main && /ClickGuide/.test(c.name || ''));
}
async function player(page, expr = 'window.__CLICKGUIDE_PLAYER__ ? window.__CLICKGUIDE_PLAYER__.debug() : null') {
  const ctxs = await topIsolated(page);
  for (let i = ctxs.length - 1; i >= 0; i--) {
    try {
      const v = await evaluate(cdp, page.sessionId, expr, { contextId: ctxs[i].id });
      if (v != null) return v;
    } catch (_) { /* 사라진 컨텍스트 */ }
  }
  return null;
}
const press = (page, name) => player(page, `window.__CLICKGUIDE_PLAYER__ ? window.__CLICKGUIDE_PLAYER__.press(${JSON.stringify(name)}) : null`);

/* 카드가 조건을 만족할 때까지 */
async function waitCard(page, pred, ms = 8000) {
  const t0 = Date.now();
  let d = null;
  while (Date.now() - t0 < ms) {
    try { d = await player(page); } catch (_) { d = null; }
    if (d && d.card && pred(d)) return d;
    await sleep(120);
  }
  return d;
}
const atStep = (n, total) => (d) => d.card.count === `${n} / ${total}` && !/찾는 중/.test(d.card.status);
const near = (a, b, tol = 2) => a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
// 테두리가 그 요소를 감싸는지 (테두리는 4px 바깥)
const ringOn = (d, r) => !!(d && d.ring && d.ring.shown && r && near(d.ring.el, r) && near(d.ring, { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }));

async function sessionsDump() {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const out = [];
    for (const s of await db.listSessions()) {
      const steps = await db.getSteps(s.id);
      out.push({ id: s.id, name: s.name, createdAt: s.createdAt, steps: steps.map((st) => ({ id: st.id, type: st.type, url: st.url, el: st.el, shotId: st.shotId, value: st.value })) });
    }
    return out;
  })()`);
}
const playStatus = () => sendMsg({ type: 'PLAY_STATUS' });

async function snap(page, name, { dark = false } = {}) {
  if (!SHOTS) return;
  await cdp.send('Target.activateTarget', { targetId: page.targetId });   // 뒤에 있는 탭은 찍히지 않을 수 있다
  if (dark) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, page.sessionId);
  await sleep(300);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `cg-play-${name}.png`), Buffer.from(data, 'base64'));
  if (dark) await cdp.send('Emulation.setEmulatedMedia', { features: [] }, page.sessionId);
}

let G1 = null;
try {
  await extEval(`chrome.storage.local.set({ cg_settings: {} }).then(() => true)`);

  /* ============ 1. 녹화 ============ */
  const rec = await openPage(`${A}/play.html`);
  await activate(rec);
  await sleep(1700);   // 늦게 나오는 버튼까지 그려지게
  const startRes = await sendMsg({ type: 'START', tabId: await tabIdOf(rec) });
  check('1-1 시험 페이지에서 녹화 시작', startRes && startRes.ok && startRes.attached, JSON.stringify(startRes).slice(0, 120));
  await sleep(700);
  await clickAt(rec, '[data-testid="new-order"]');
  await sleep(500);
  await clickAt(rec, 'input[name="customer"]');
  await cdp.send('Input.insertText', { text: '김철수' }, rec.sessionId);
  await sleep(200);
  // 목록: 포커스를 옮기면 입력칸의 값이 기록되고, 목록 값을 바꾸면 목록 단계가 기록된다
  await pageEval(rec, `(() => { const s = document.getElementById('kind'); s.focus(); s.value = '급송'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(500);
  await clickAt(rec, '#sec2 button.save');
  await sleep(500);
  await clickAt(rec, 'shadow');
  await sleep(500);
  await clickAt(rec, 'inner:#confirm');
  await sleep(700);
  await clickAt(rec, 'xo');
  await sleep(700);
  const loaded = cdp.waitFor((m) => m.sessionId === rec.sessionId && m.method === 'Page.loadEventFired', 15000);
  await clickAt(rec, '#to-list');
  await loaded;
  await sleep(1500);   // 화면 이동 단계 촬영
  await clickAt(rec, '#refresh');
  await sleep(800);
  await sendMsg({ type: 'STOP', openEditor: false });
  await sleep(500);
  const ss = await sessionsDump();
  G1 = ss.sort((a, b) => b.createdAt - a.createdAt)[0];
  const types = G1 ? G1.steps.map((s) => s.type).join(',') : '';
  check('1-2 녹화한 단계 (입력칸 클릭은 입력 단계에 합쳐짐)', types === 'click,input,select,click,click,click,click,click,navigate,click', types);
  const st = G1 ? G1.steps : [];
  const el = (i) => (st[i] && st[i].el) || {};
  check('1-3 새 단서: data-testid·경로(cv 2)', el(0).cv === 2 && el(0).testId === 'new-order' && /button$/.test(el(0).path || ''), JSON.stringify({ testId: el(0).testId, path: el(0).path }));
  check('1-4 shadow DOM 버튼은 주인(x-picker)을 남김', Array.isArray(el(4).hosts) && el(4).hosts.length === 1 && el(4).hosts[0].tag === 'x-picker', JSON.stringify(el(4).hosts));
  check('1-5 iframe 안 버튼은 iframe 단서(경로·id·이름)를 남김',
    Array.isArray(el(5).frames) && el(5).frames.length === 1 && el(5).frames[0].path === '/play-frame.html' && el(5).frames[0].id === 'inner' && el(5).frames[0].name === 'inner'
      && Array.isArray(el(6).frames) && el(6).frames[0].path === '/play-xframe.html',
    JSON.stringify([el(5).frames, el(6).frames]));
  check('1-6 예전 칸(이름·selector)은 그대로', el(3).label === '저장' && /#sec2/.test(el(3).selector) && el(1).name === 'customer', JSON.stringify({ l: el(3).label, s: el(3).selector }));

  /* ============ 2. 새 탭에서 따라 하기 ============ */
  let known = await knownTargets();
  const r0 = await sendMsg({ type: 'PLAY_START', sessionId: G1.id, newTab: true });
  check('2-0 따라하기 시작 (가이드의 시작 화면을 새 탭으로)', r0 && r0.ok, JSON.stringify(r0));
  const pl = await attachNewPage('/play.html', known);
  const T = G1.steps.length;
  let d = await waitCard(pl, atStep(1, T));
  let r = await rectOf(pl, '[data-testid="new-order"]');
  check('2-1 카드가 뜨고 첫 단계(data-testid 버튼)에 테두리', d && d.card.name && ringOn(d, r) && /누르세요/.test(d.card.status) && d.card.prevDisabled,
    JSON.stringify({ card: d && d.card && { count: d.card.count, status: d.card.status }, ring: d && d.ring, r }));
  await snap(pl, 'found-light');
  await snap(pl, 'found-dark', { dark: true });
  await click(pl, ...center(r));
  d = await waitCard(pl, atStep(2, T));
  r = await rectOf(pl, 'input[name="customer"]');
  check('2-2 누르면 다음 단계: 입력칸에 테두리, 녹화한 값을 예로 보여 줌', d && ringOn(d, r) && /김철수/.test(d.card.value || '') && d.ring.tip === '여기에 입력하세요',
    JSON.stringify({ count: d && d.card.count, value: d && d.card.value, ring: d && d.ring }));
  await snap(pl, 'input');
  await click(pl, ...center(r));
  await cdp.send('Input.insertText', { text: '김영희' }, pl.sessionId);
  await key(pl, 'Tab', 'Tab', 9);
  d = await waitCard(pl, atStep(3, T));
  r = await rectOf(pl, '#kind');
  check('2-3 입력하고 칸을 벗어나면 다음 단계: 목록', d && ringOn(d, r) && /급송/.test(d.card.value || ''), JSON.stringify({ count: d && d.card.count, value: d && d.card.value }));
  await pageEval(pl, `(() => { const s = document.getElementById('kind'); s.focus(); s.value = '급송'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  d = await waitCard(pl, atStep(4, T));
  r = await rectOf(pl, '#sec2 button.save');
  const r1 = await rectOf(pl, '#sec1 button.save');
  check('2-4 같은 글자의 "저장" 둘 중 녹화한 쪽(주문 칸)에 테두리', d && ringOn(d, r) && !ringOn(d, r1), JSON.stringify({ ring: d && d.ring, want: r }));
  await click(pl, ...center(r));
  d = await waitCard(pl, atStep(5, T));
  r = await rectOf(pl, 'shadow');
  check('2-5 shadow DOM 안 버튼에 테두리', d && ringOn(d, r), JSON.stringify({ ring: d && d.ring, want: r }));
  await click(pl, ...center(r));
  d = await waitCard(pl, atStep(6, T));
  check('2-6 iframe 안 버튼: 찾았다고 안내 (테두리는 iframe 안에)', d && /누르세요/.test(d.card.status) && !d.ring, d && d.card.status);
  // 다른 곳을 누르면 넘어가지 않는다
  await clickAt(pl, '#sec1 button.save');
  await sleep(600);
  d = await player(pl);
  const stay = d && d.card.count === `6 / ${T}`;
  await clickAt(pl, 'inner:#confirm');
  d = await waitCard(pl, atStep(7, T));
  check('2-7 다른 곳을 누르면 그대로, iframe 안 그 버튼을 누르면 다음 단계', stay && d && d.card.count === `7 / ${T}`, d && d.card.count);
  check('2-8 다른 출처 iframe 안 버튼도 찾음', d && /누르세요/.test(d.card.status), d && d.card.status);
  await clickAt(pl, 'xo');
  d = await waitCard(pl, atStep(8, T));
  r = await rectOf(pl, '#to-list');
  check('2-9 다른 출처 iframe 버튼을 누르면 다음 단계: 링크', d && ringOn(d, r), JSON.stringify({ count: d && d.card.count, ring: d && d.ring }));
  const navLoaded = cdp.waitFor((m) => m.sessionId === pl.sessionId && m.method === 'Page.loadEventFired', 15000);
  await click(pl, ...center(r));
  await navLoaded;
  d = await waitCard(pl, atStep(10, T), 10000);
  r = await rectOf(pl, '#refresh');
  check('2-10 링크를 눌러 화면이 바뀌어도 카드가 이어지고, 화면 이동 단계는 저절로 넘어감', d && ringOn(d, r), JSON.stringify({ count: d && d.card.count, status: d && d.card.status }));
  await click(pl, ...center(r));
  d = await waitCard(pl, (x) => x.card.restart, 8000);
  check('2-11 마지막 단계를 하면 "마쳤습니다" (처음부터·닫기)', d && /마쳤습니다/.test(d.card.title) && d.card.next === null && d.card.restart, JSON.stringify(d && d.card));
  await snap(pl, 'done');
  await press(pl, 'close');

  await sleep(500);
  const afterClose = await player(pl);
  const ps0 = await playStatus();
  check('2-12 닫기를 누르면 카드가 사라지고 따라하기가 끝남', (!afterClose || !afterClose.card) && ps0 && ps0.playing === false, JSON.stringify(ps0));

  /* ============ 3. 바뀐 화면에서 ============ */
  const p2 = await openPage(`${A}/play2.html`);
  await activate(p2);
  const r2 = await sendMsg({ type: 'PLAY_START', sessionId: G1.id, tabId: await tabIdOf(p2) });
  d = await waitCard(p2, atStep(1, T));
  r = await rectOf(p2, '[data-testid="new-order"]');
  const found = [];
  const first = { r2, ring: d && d.ring, r, status: d && d.card && d.card.status };
  found.push(r2 && r2.ok && d && ringOn(d, r));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(2, T));
  found.push(d && ringOn(d, await rectOf(p2, 'input[name="customer"]')));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(3, T));
  found.push(d && ringOn(d, await rectOf(p2, '#kind2')));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(4, T));
  found.push(d && d.ring && /누르세요/.test(d.card.status));   // 같은 글자의 저장 둘 중 하나
  await press(p2, 'next');
  d = await waitCard(p2, atStep(5, T));
  found.push(d && ringOn(d, await rectOf(p2, 'shadow')));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(6, T));
  found.push(d && /누르세요/.test(d.card.status));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(7, T));
  found.push(d && /누르세요/.test(d.card.status));
  await press(p2, 'next');
  d = await waitCard(p2, atStep(8, T));
  found.push(d && ringOn(d, await rectOf(p2, 'a.nav-link')));
  check('3-1 id·클래스·구조가 바뀐 화면에서도 8단계를 모두 찾음 (testId·입력칸·목록·저장·shadow·iframe 둘·링크)', found.every(Boolean),
    JSON.stringify(found) + (found[0] ? '' : ' 첫 단계: ' + JSON.stringify(first)));
  await press(p2, 'next');
  d = await waitCard(p2, (x) => x.card.count === `9 / ${T}`);
  check('3-2 다른 화면으로 가는 단계는 그 화면이 아니면 안내만 (이 화면 열기)', d && d.card.goto && /다음 화면/.test(d.card.status), d && d.card.status);
  await press(p2, 'next');
  // 녹화 화면은 '찾지 못했습니다'를 띄운 뒤에 받아 그린다: 그림까지 뜨기를 기다린다 (상태만 보고 바로 읽으면 가끔 그리기 전)
  d = await waitCard(p2, (x) => x.card.count === `10 / ${T}` && /찾지 못했습니다/.test(x.card.status) && x.card.shotShown, 9000);
  check('3-3 이 화면에 없는 버튼은 몇 초 뒤 "찾지 못했습니다" + 녹화 화면 + [이 화면 열기]·[제가 했어요]',
    d && d.card.goto && d.card.retry && d.card.shotShown && d.card.shotW === 600 && /제가 했어요/.test(d.card.next) && /다른 화면/.test(d.card.status),
    JSON.stringify(d && d.card));
  await snap(p2, 'notfound-light');
  await snap(p2, 'notfound-dark', { dark: true });
  const navP2
 = cdp.waitFor((m) => m.sessionId === p2.sessionId && m.method === 'Page.loadEventFired', 15000);
  await press(p2, 'goto');
  await navP2;
  d = await waitCard(p2, atStep(10, T), 10000);
  check('3-4 [이 화면 열기]를 누르면 녹화한 화면이 열리고 그 버튼을 찾음', d && ringOn(d, await rectOf(p2, '#refresh')), JSON.stringify({ count: d && d.card.count, status: d && d.card.status }));
  await press(p2, 'prev');
  d = await waitCard(p2, (x) => x.card.count === `9 / ${T}`, 4000);
  // 9단계(화면 이동)는 이미 그 화면이라 저절로 10단계로 넘어간다
  d = await waitCard(p2, atStep(10, T), 6000);
  check('3-5 [이전]으로 돌아가도 이미 그 화면이면 화면 이동 단계는 저절로 넘어감', d && d.card.count === `10 / ${T}`, d && d.card.count);
  await press(p2, 'close');
  await sleep(300);

  /* ============ 4. 늦게 그려지는 버튼 · 예전 형식 가이드 ============ */
  // 늦게 나오는 버튼 하나만 누른 가이드를 만든다 (녹화)
  const recL = await openPage(`${A}/play.html`);
  await activate(recL);
  await sleep(1700);
  await sendMsg({ type: 'START', tabId: await tabIdOf(recL) });
  await sleep(600);
  await clickAt(recL, '#late');
  await sleep(700);
  await sendMsg({ type: 'STOP', openEditor: false });
  await sleep(400);
  const GL = (await sessionsDump()).sort((a, b) => b.createdAt - a.createdAt)[0];
  known = await knownTargets();
  await sendMsg({ type: 'PLAY_START', sessionId: GL.id, newTab: true });
  const pL = await attachNewPage('/play.html', known);
  const early = await waitCard(pL, (x) => x.card.count === '1 / 1', 4000);
  const t0 = Date.now();
  d = await waitCard(pL, (x) => x.ring && x.ring.shown, 6000);
  check('4-1 처음엔 "찾는 중", 1.5초 뒤 그려진 버튼을 찾아 테두리 ("못 찾음"을 띄우기 전에)',
    early && /찾는 중/.test(early.card.status) && d && ringOn(d, await rectOf(pL, '#late')) && !/찾지 못했/.test(d.card.status),
    `${early && early.card.status} → ${Date.now() - t0}ms 뒤 ${d && d.card.status}`);
  await press(pL, 'close');

  // 예전 형식: 새 단서(cv·testId·path·frames…) 없이 예전 칸만 있는 단계
  const GO = await extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const src = await db.getSteps(${JSON.stringify(G1.id)});
    const keep = ['tag', 'type', 'role', 'label', 'href', 'name', 'id', 'placeholder', 'selector'];
    const sid = db.uid('ses');
    const steps = [src[0], src[3]].map((s, i) => {
      const el = {}; for (const k of keep) el[k] = s.el[k];
      return { ...s, id: db.uid('stp'), sessionId: sid, index: i, el, shotId: null };
    });
    await db.importSession({ id: sid, name: '예전 형식 가이드', createdAt: Date.now(), updatedAt: Date.now(), startUrl: steps[0].url, stepCount: 2 }, steps, []);
    return sid;
  })()`);
  known = await knownTargets();
  await sendMsg({ type: 'PLAY_START', sessionId: GO, newTab: true });
  const pO = await attachNewPage('/play.html', known);
  d = await waitCard(pO, atStep(1, 2));
  const okA = d && ringOn(d, await rectOf(pO, '[data-testid="new-order"]'));
  await clickAt(pO, '[data-testid="new-order"]');
  d = await waitCard(pO, atStep(2, 2));
  const okB = d && ringOn(d, await rectOf(pO, '#sec2 button.save')) && d.card.shotShown === false;
  check('4-2 예전 형식 가이드(id·이름·selector 만)도 찾음, 같은 글자의 "저장"은 selector 로 가름', okA && okB, JSON.stringify({ okA, okB, ring: d && d.ring }));
  check('4-3 스크린샷이 없는 단계는 [녹화 화면] 단추를 숨김', d && d.card && (await player(pO, `window.__CLICKGUIDE_PLAYER__.press('shot-toggle')`)) === false, '');

  /* ============ 5. 탭 닫기 · 녹화와 겹치지 않음 ============ */
  await cdp.send('Target.closeTarget', { targetId: pO.targetId });
  await sleep(800);
  const ps1 = await playStatus();
  check('5-1 따라하던 탭을 닫으면 따라하기가 끝남', ps1 && ps1.playing === false, JSON.stringify(ps1));
  known = await knownTargets();
  await sendMsg({ type: 'PLAY_START', sessionId: G1.id, newTab: true });
  const pR = await attachNewPage('/play.html', known);
  await waitCard(pR, atStep(1, T));
  const recTab = await openPage(`${A}/b.html`);
  await activate(recTab);
  const recRes = await sendMsg({ type: 'START', tabId: await tabIdOf(recTab) });
  await sleep(500);
  const ps2 = await playStatus();
  const cardGone = await waitCard(pR, () => false, 800).then(() => player(pR));
  check('5-2 녹화를 시작하면 따라하기는 끝남 (카드도 사라짐)', recRes && recRes.ok && ps2.playing === false && (!cardGone || !cardGone.card), JSON.stringify({ ps2, card: cardGone && cardGone.card }));
  const blocked = await sendMsg({ type: 'PLAY_START', sessionId: G1.id, newTab: true });
  check('5-3 녹화하는 중에는 따라하기를 시작하지 않음', blocked && !blocked.ok && /녹화하는 중/.test(blocked.error || ''), JSON.stringify(blocked));
  await sendMsg({ type: 'STOP', discard: true });
  await sleep(400);

  /* ============ 6. 가이드 파일 ============ */
  const exp = await extEval(`(async () => {
    const { buildBackup, readBackup } = await import('/src/common/backup.js');
    const { blob, counts } = await buildBackup({ sessionIds: [${JSON.stringify(G1.id)}], includeSettings: false });
    const plan = await readBackup(new File([blob], 'g.zip'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), counts, scope: plan.meta.scope, hasSettings: 'settings' in plan.meta, sessions: plan.meta.sessions.map((s) => s.id) };
  })()`);
  check('6-1 가이드 파일: 그 가이드 하나와 스크린샷만, 설정은 넣지 않음', exp.scope === 'guide' && !exp.hasSettings && exp.sessions.length === 1 && exp.sessions[0] === G1.id && exp.counts.steps === T && exp.counts.shots > 0,
    JSON.stringify({ ...exp, b64: undefined }));
  const zipPath = path.join(PROFILE, 'guide.clickguide.zip');
  fs.writeFileSync(zipPath, Buffer.from(exp.b64, 'base64'));
  const shotsBefore = G1.steps.filter((s) => s.shotId).length;
  await extEval(`import('/src/common/db.js').then((db) => db.deleteSession(${JSON.stringify(G1.id)})).then(() => true)`);
  const ed = await openPage(`chrome-extension://${extId}/src/editor/editor.html`);
  await cdp.send('DOM.enable', {}, ed.sessionId);
  const setFile = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('import-file')` }, ed.sessionId);
    await cdp.send('DOM.setFileInputFiles', { files: [zipPath], objectId: result.objectId }, ed.sessionId);
  };
  await setFile();
  let back = null;
  for (let i = 0; i < 40 && !back; i++) {
    await sleep(150);
    back = (await sessionsDump()).find((s) => s.id === G1.id) || null;
  }
  await sleep(400);
  const toast1 = await pageEval(ed, `document.getElementById('toast').textContent`);
  const shownName = await pageEval(ed, `document.getElementById('session-select').value`);
  check('6-2 편집기 [가져오기]: 지운 가이드가 단계·스크린샷과 함께 돌아오고 그 가이드를 엶',
    back && back.steps.length === T && back.steps.filter((s) => s.shotId).length === shotsBefore && shownName === G1.id && /가져왔습니다/.test(toast1),
    JSON.stringify({ steps: back && back.steps.length, shots: back && back.steps.filter((s) => s.shotId).length, shotsBefore, shownName, toast1 }));
  await setFile();   // 같은 파일을 다시: 바꿀지 묻는 창(시험에서는 '예')
  await sleep(1500);
  const all = await sessionsDump();
  const copies = all.filter((s) => s.id === G1.id);
  check('6-3 같은 가이드를 다시 가져오면 바꿀지 묻고 바꿈 (두 개가 되지 않음)', copies.length === 1 && copies[0].steps.length === T, `같은 가이드 ${copies.length}개`);
  // 가져온 가이드로도 따라 할 수 있다
  known = await knownTargets();
  const r6 = await sendMsg({ type: 'PLAY_START', sessionId: G1.id, newTab: true });
  const p6 = await attachNewPage('/play.html', known);
  d = await waitCard(p6, atStep(1, T));
  check('6-4 가져온 가이드로 따라하기', r6 && r6.ok && d && ringOn(d, await rectOf(p6, '[data-testid="new-order"]')), d && d.card.status);
  if (SHOTS) {
    await snap(ed, 'editor');
    const pop = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
    await snap(pop, 'popup');
  }
  await press(p6, 'close');

  // 편집기에서 더 가린 곳: 남에게 보내는 가이드 파일에서는 스크린샷에 칠해져 있어야 한다 (zip 을 풀어 그림만 봐도 안 보이게)
  const masked = G1.steps.find((s) => s.shotId);
  await extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const st = (await db.getSteps(${JSON.stringify(G1.id)})).find((s) => s.id === ${JSON.stringify(masked.id)});
    await db.putStep({ ...st, redactions: [{ x: 0, y: 0, w: 0.3, h: 0.15 }] });
    return true;
  })()`);
  const DL = path.join(PROFILE, 'dl');
  fs.mkdirSync(DL, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  const ed2 = await openPage(`chrome-extension://${extId}/src/editor/editor.html?session=${G1.id}`);
  await sleep(1200);
  await pageEval(ed2, `document.querySelector('[data-export="guide"]').click(), true`);
  let guideZip = null;
  for (let i = 0; i < 100 && !guideZip; i++) {
    const f = fs.readdirSync(DL).find((x) => /\.clickguide\.zip$/.test(x));
    if (f) { await sleep(400); guideZip = path.join(DL, f); } else await sleep(200);
  }
  const gz = guideZip ? await extEval(`(async () => {
    const { readZip } = await import('/src/lib/unzip.js');
    const db = await import('/src/common/db.js');
    const bin = atob(${JSON.stringify(fs.readFileSync(guideZip).toString('base64'))});
    const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const zip = await readZip(new Blob([u8]));
    const meta = JSON.parse(new TextDecoder().decode(await zip.read('backup.json')));
    const st = meta.steps.find((s) => s.id === ${JSON.stringify(masked.id)});
    const sh = meta.shots.find((s) => s.id === st.shotId);
    // 가린 곳(왼쪽 위 30%×15%) 안 16점의 가장 밝은 채널, 가린 곳 밖 한 점
    const stats = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
      c.drawImage(bmp, 0, 0);
      const W = bmp.width, H = bmp.height, inside = [];
      for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) {
        const [r, g, b] = c.getImageData(Math.floor(W * 0.3 * i / 5), Math.floor(H * 0.15 * j / 5), 1, 1).data;
        inside.push(Math.max(r, g, b));
      }
      const o = c.getImageData(Math.floor(W * 0.6), Math.floor(H * 0.6), 1, 1).data;
      return { W, H, insideMax: Math.max(...inside), insideMean: Math.round(inside.reduce((a, x) => a + x, 0) / inside.length), outside: [o[0], o[1], o[2]] };
    };
    return {
      exported: await stats(new Blob([await zip.read(sh.file)], { type: sh.type })),
      original: await stats(await db.getShot(st.shotId)),
      redactions: st.redactions
    };
  })()`) : null;
  const diff = gz ? Math.max(...gz.exported.outside.map((v, i) => Math.abs(v - gz.original.outside[i]))) : 999;
  check('6-5 편집기에서 더 가린 곳은 가이드 파일 속 스크린샷에 칠해져 있음 (가린 곳 밖은 그대로, 가림 상자는 단계에 남음)',
    gz && gz.original.insideMean > 120 && gz.exported.insideMax < 40 && diff < 30 && gz.redactions.length === 1,
    JSON.stringify({ file: guideZip && path.basename(guideZip), ...gz, diff }));

  /* ============ 7. 주소만 바꾸는 화면(SPA) · 같은 단추를 연달아 누르는 단계 — 사람처럼 누른다 ============ */
  // play-spa.html: [하나 더] 두 번 → [다음 화면으로](pushState) → [마무리 화면으로](해시 주소) → [끝]
  const recS = await openPage(`${A}/play-spa.html`);
  await activate(recS);
  await sleep(600);
  await sendMsg({ type: 'START', tabId: await tabIdOf(recS) });
  await sleep(700);
  await clickAt(recS, '#inc');
  await sleep(700);
  await clickAt(recS, '#inc');
  await sleep(700);
  await clickAt(recS, '#go');
  await sleep(1800);   // 화면 이동 단계 촬영
  await clickAt(recS, '#to-done');
  await sleep(1800);
  await clickAt(recS, '#fin');
  await sleep(800);
  await sendMsg({ type: 'STOP', openEditor: false });
  await sleep(500);
  const GS = (await sessionsDump()).sort((a, b) => b.createdAt - a.createdAt)[0];
  const sTypes = GS ? GS.steps.map((s) => s.type).join(',') : '';
  check('7-1 주소만 바꾸는 화면 녹화: 같은 단추 두 번, pushState·해시 주소로 바뀐 화면은 화면 이동 단계', sTypes === 'click,click,click,navigate,click,navigate,click', sTypes);
  const TS = GS.steps.length;
  known = await knownTargets();
  await sendMsg({ type: 'PLAY_START', sessionId: GS.id, newTab: true });
  const pS = await attachNewPage('/play-spa.html', known);
  const pressed = () => pageEval(pS, `document.getElementById('n') ? document.getElementById('n').textContent : null`);
  d = await waitCard(pS, (x) => atStep(1, TS)(x) && x.ring && x.ring.shown);
  await humanClick(pS, ...center(await rectOf(pS, '#inc')));
  await sleep(1200);   // 같은 누름의 click 으로 한 단계 더 넘어가는지 볼 시간
  d = await player(pS);
  let n1 = await pressed();
  check('7-2 같은 단추를 연달아 누르는 단계: 한 번 누르면 한 단계만 넘어감 (테두리는 그 단추에 그대로)',
    d && d.card.count === `2 / ${TS}` && ringOn(d, await rectOf(pS, '#inc')) && n1 === '1', JSON.stringify({ count: d && d.card.count, pressed: n1 }));
  await humanClick(pS, ...center(await rectOf(pS, '#inc')));
  d = await waitCard(pS, (x) => atStep(3, TS)(x) && x.ring && x.ring.shown);
  n1 = await pressed();
  check('7-3 한 번 더 누르면 다음 단계', d && ringOn(d, await rectOf(pS, '#go')) && n1 === '2', JSON.stringify({ count: d && d.card.count, pressed: n1 }));
  await humanClick(pS, ...center(await rectOf(pS, '#go')));
  d = await waitCard(pS, (x) => atStep(5, TS)(x) && x.ring && x.ring.shown, 5000);
  check('7-4 pushState 로 주소만 바뀌어도 화면 이동 단계는 저절로 넘어감', d && ringOn(d, await rectOf(pS, '#to-done')), JSON.stringify({ count: d && d.card.count, status: d && d.card.status }));
  await humanClick(pS, ...center(await rectOf(pS, '#to-done')));
  d = await waitCard(pS, (x) => atStep(7, TS)(x) && x.ring && x.ring.shown, 5000);
  check('7-5 해시 주소(#/…)로 바뀌어도 저절로 넘어감', d && ringOn(d, await rectOf(pS, '#fin')), JSON.stringify({ count: d && d.card.count, status: d && d.card.status }));
  await pageEval(pS, `document.getElementById('fin').focus(), true`);
  await pressEnter(pS);
  d = await waitCard(pS, (x) => x.card.restart, 5000);
  check('7-6 키보드(Enter)로 눌러도 다음 단계 → 마침', d && /마쳤습니다/.test(d.card.title), JSON.stringify(d && d.card && { count: d.card.count, title: d.card.title }));
  await press(pS, 'close');
} catch (e) {
  check('시험 진행 중 예외', false, (e && e.stack) || String(e));
} finally {
  try { cdp.close(); } catch (_) { /* noop */ }
  try { proc.kill(); } catch (_) { /* noop */ }
  for (const s of servers) s.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n결과: ${results.length - failed} / ${results.length} 통과`);
process.exit(failed ? 1 : 0);
