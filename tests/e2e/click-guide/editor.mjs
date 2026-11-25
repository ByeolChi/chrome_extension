// ClickGuide 편집기 E2E: 그리기(주석·가림·자르기·확대), 되돌리기, 단계 다루기, 녹화 끝의 입력란 클릭 합치기, 내보내기(개정 이력·이미지 크기·Word·PowerPoint)
// 실행: 저장소 최상위에서 node tests/e2e/click-guide/editor.mjs   (다른 사본: CG_EXT=<확장 폴더>)
// 그림은 실제 마우스·키보드 입력(CDP)으로 그리고, 내보내기에 쓰는 이미지(bakeStepImage)의 픽셀로 판정한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, evaluate, sleep } from './cdp.mjs';
import { startServers } from './server.mjs';
import { tempDir } from '../lib/chromium.mjs';

const EXT = path.resolve(process.env.CG_EXT || fileURLToPath(new URL('../../../click-guide', import.meta.url)));
const PROFILE = tempDir('click-guide-editor-e2e-');
const PORT = Number(process.env.CDP_PORT) || 9301;
const A = 'http://127.0.0.1:18931';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const servers = await startServers([18931, 18932]);
const { proc, cdp } = await launchChromium({ extPath: EXT, userDataDir: PROFILE, port: PORT });
await cdp.send('Target.setDiscoverTargets', { discover: true });
let extId = null;
for (let i = 0; i < 60 && !extId; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && /service-worker\.js$/.test(t.url));
  if (sw) extId = new URL(sw.url).host;
  else await sleep(200);
}
if (!extId) throw new Error('확장 서비스 워커를 찾지 못했습니다');

async function openPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const page = { targetId, sessionId };
  const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  return page;
}
const pageEval = (page, expr) => evaluate(cdp, page.sessionId, expr);
const ext = await openPage(`chrome-extension://${extId}/src/options/options.html`);
const extEval = (expr) => pageEval(ext, expr);
const sendMsg = (msg) => extEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

async function tabIdOf(page) {
  const info = await cdp.send('Target.getTargetInfo', { targetId: page.targetId });
  const tabs = await extEval(`chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`);
  const hit = tabs.find((x) => x.url === info.targetInfo.url);
  return hit ? hit.id : null;
}
async function activate(page) {
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  const id = await tabIdOf(page);
  if (id) await extEval(`chrome.tabs.update(${id}, { active: true }).then(() => true)`);
  await sleep(250);
}
const mouse = (page, type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, page.sessionId);
async function click(page, x, y) {
  await mouse(page, 'mouseMoved', x, y, { button: 'none' });
  await mouse(page, 'mousePressed', x, y);
  await mouse(page, 'mouseReleased', x, y);
}
async function drag(page, x1, y1, x2, y2) {
  await mouse(page, 'mouseMoved', x1, y1, { button: 'none' });
  await mouse(page, 'mousePressed', x1, y1);
  for (let i = 1; i <= 6; i++) await mouse(page, 'mouseMoved', x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6, { buttons: 1 });
  await mouse(page, 'mouseReleased', x2, y2);
  await sleep(120);
}
const KEYS = { Delete: 46, Enter: 13, Tab: 9, Escape: 27, z: 90 };
async function key(page, k, modifiers = 0) {
  const base = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: KEYS[k] || 0, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, page.sessionId);
  if (k === 'Enter') await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base }, page.sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
  await sleep(150);
}
const typeText = (page, text) => cdp.send('Input.insertText', { text }, page.sessionId);

/* ============ 1. 녹화 끝: 입력란 클릭 + 입력 → 입력 단계 하나 ============ */
try {
  await extEval(`chrome.storage.local.set({ cg_settings: {} }).then(() => true)`);
  const tab = await openPage(`${A}/a.html`);
  await activate(tab);
  const started = await sendMsg({ type: 'START', tabId: await tabIdOf(tab) });
  await sleep(800);
  const r = await pageEval(tab, `(() => { const b = document.querySelector('#name').getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 }; })()`);
  await click(tab, r.x, r.y);
  await sleep(700);
  await typeText(tab, '홍길동');
  await key(tab, 'Tab'); // 칸을 떠나면 입력 단계가 생긴다
  let steps = [];
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    steps = await extEval(`(async () => { const db = await import('/src/common/db.js'); const ss = (await db.listSessions()).sort((a, b) => b.createdAt - a.createdAt); return ss.length ? (await db.getSteps(ss[0].id)).map((s) => ({ type: s.type, tag: s.el && s.el.tag, shot: !!s.shotId })) : []; })()`);
    if (steps.some((s) => s.type === 'input' && s.shot)) break;
  }
  const before = JSON.stringify(steps);
  const stop = await sendMsg({ type: 'STOP', openEditor: false });
  const after = await extEval(`(async () => { const db = await import('/src/common/db.js'); const s = await db.getSession(${JSON.stringify(stop.sessionId)}); const st = await db.getSteps(s.id); return { merged: s.mergedFieldClicks || 0, count: s.stepCount, steps: st.map((x) => ({ type: x.type, tag: x.el && x.el.tag, index: x.index })) }; })()`);
  check('M-1 녹화 중에는 입력란 클릭과 입력이 따로 기록됨', started && started.ok !== false && /"type":"click","tag":"input"/.test(before) && /"type":"input"/.test(before), before);
  check('M-2 녹화를 끝내면 입력란 클릭 단계를 빼고 입력 단계만 남김', after.merged === 1 && !after.steps.some((s) => s.type === 'click' && s.tag === 'input') && after.steps.some((s) => s.type === 'input')
    && after.count === after.steps.length && after.steps.every((s, i) => s.index === i), JSON.stringify(after));
  await cdp.send('Target.closeTarget', { targetId: tab.targetId });
} catch (e) { check('M 구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

/* ============ 2. 그리기: 박스·화살표·번호·글자, 되돌리기, 지우기, 가리기·확대·자르기 ============ */
// 800×400 흰 바탕, 파란 정사각형(100~200, 100~200)
const mk = await extEval(`(async () => {
  const db = await import('/src/common/db.js');
  const s = await db.createSession({ name: '그리기 시험', startUrl: '${A}/a.html' });
  const c = new OffscreenCanvas(800, 400); const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 800, 400); x.fillStyle = '#0000ff'; x.fillRect(100, 100, 100, 100);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const shotId = db.uid('shot'); await db.putShot(shotId, blob);
    const id = db.uid('stp'); ids.push(id);
    await db.putStep({ id, sessionId: s.id, index: i, type: 'click', ts: Date.now(), url: '${A}/a.html', el: { tag: 'button', label: '버튼 ' + (i + 1) },
      nrect: { x: 0.5, y: 0.1, w: 0.1, h: 0.1 }, redactions: [], shotId, highlight: true, title: '단계 ' + (i + 1), description: '설명 ' + (i + 1) });
  }
  await db.updateSession(s.id, { stepCount: 3 });
  return { sid: s.id, ids };
})()`);
const ed = await openPage(`chrome-extension://${extId}/src/editor/editor.html?session=${mk.sid}`);
await sleep(1200);
const stepState = (i = 0) => extEval(`(async () => { const db = await import('/src/common/db.js'); const st = (await db.getSteps(${JSON.stringify(mk.sid)}))[${i}]; return st ? { annotations: st.annotations || [], redactions: st.redactions || [], crop: st.crop || null, highlight: st.highlight, nrect: st.nrect } : null; })()`);
// 첫 단계 그림의 화면 좌표: (0~1) → 화면 px
async function canvasBox(i = 0) {
  return pageEval(ed, `(() => { const c = document.querySelectorAll('li.step')[${i}].querySelector('.shot-canvas'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
}
const at = (b, fx, fy) => [b.x + b.w * fx, b.y + b.h * fy];
const tool = (name) => pageEval(ed, `(() => { document.querySelectorAll('li.step')[0].querySelector('.draw-bar [data-tool="${name}"]').click(); return true; })()`);

try {
  await activate(ed);
  await pageEval(ed, `document.querySelectorAll('li.step')[0].querySelector('.t-draw').click(), true`);
  await sleep(200);
  const barShown = await pageEval(ed, `!document.querySelectorAll('li.step')[0].querySelector('.draw-bar').hidden`);
  let b = await canvasBox();
  await tool('rect');
  await drag(ed, ...at(b, 0.5, 0.5), ...at(b, 0.7, 0.8));
  await tool('arrow');
  await drag(ed, ...at(b, 0.1, 0.9), ...at(b, 0.3, 0.6));
  await tool('badge');
  await click(ed, ...at(b, 0.85, 0.2));
  await sleep(150);
  await tool('text');
  await click(ed, ...at(b, 0.04, 0.05));
  await sleep(200);
  await typeText(ed, '여기를 누르세요');
  await key(ed, 'Enter');
  let st = await stepState();
  check('D-1 그리기 막대가 열리고 박스·화살표·번호·글자가 저장됨', barShown && JSON.stringify(st.annotations.map((a) => a.type)) === '["rect","arrow","badge","text"]'
    && st.annotations[2].n === 1 && st.annotations[3].text === '여기를 누르세요', JSON.stringify(st.annotations.map((a) => a.type + (a.text ? ':' + a.text : ''))));
  const rect = st.annotations[0];
  check('D-2 박스 좌표가 끈 자리와 맞음 (0~1)', Math.abs(rect.x - 0.5) < 0.02 && Math.abs(rect.y - 0.5) < 0.02 && Math.abs(rect.w - 0.2) < 0.02 && Math.abs(rect.h - 0.3) < 0.02, JSON.stringify(rect));

  // 되돌리기·다시 하기 (Ctrl+Z / Ctrl+Shift+Z) — 그림에 포커스가 있을 때
  await key(ed, 'z', 2);
  const u1 = (await stepState()).annotations.length;
  await key(ed, 'z', 2 | 8);
  const r1 = (await stepState()).annotations.length;
  check('D-3 Ctrl+Z 로 글자 넣기를 되돌리고 Ctrl+Shift+Z 로 다시 함', u1 === 3 && r1 === 4, `되돌린 뒤 ${u1}개, 다시 한 뒤 ${r1}개`);

  // 고르기 → Delete 로 지우기 → 되돌리기 단추
  await tool('select');
  await click(ed, ...at(b, 0.6, 0.65));
  await key(ed, 'Delete');
  const afterDel = (await stepState()).annotations.map((a) => a.type);
  await pageEval(ed, `document.querySelector('#btn-undo').click(), true`);
  await sleep(300);
  const afterUndo = (await stepState()).annotations.map((a) => a.type);
  check('D-4 고른 박스를 Delete 로 지우고 되돌리기 단추로 되살림', !afterDel.includes('rect') && afterDel.length === 3 && afterUndo.includes('rect') && afterUndo.length === 4, `${afterDel} → ${afterUndo}`);

  // 하이라이트 옮기기 (선택 도구로 끌기)
  const hl0 = (await stepState()).nrect;
  await drag(ed, ...at(b, 0.55, 0.15), ...at(b, 0.65, 0.25));
  const hl1 = (await stepState()).nrect;
  check('D-5 녹화 때의 하이라이트를 끌어서 옮김', Math.abs(hl1.x - hl0.x - 0.1) < 0.02 && Math.abs(hl1.y - hl0.y - 0.1) < 0.02, `${JSON.stringify(hl0)} → ${JSON.stringify(hl1)}`);

  // 가리기: 파란 정사각형 위, 확대: 같은 자리 (가린 것이 확대에도 보여야 함), 자르기
  await tool('redact');
  await drag(ed, ...at(b, 0.12, 0.24), ...at(b, 0.26, 0.52));
  await tool('zoom');
  await drag(ed, ...at(b, 0.13, 0.26), ...at(b, 0.24, 0.48));
  const canvasTop = () => pageEval(ed, `document.querySelectorAll('li.step')[0].querySelector('.shot-canvas').getBoundingClientRect().y`);
  const top0 = await canvasTop();
  await tool('crop');
  await drag(ed, ...at(b, 0.02, 0.02), ...at(b, 0.98, 0.96));
  const top1 = await canvasTop();
  st = await stepState();
  const zoom = st.annotations.find((a) => a.type === 'zoom');
  check('D-6 가리기·확대·자르기가 저장됨 (확대는 고른 곳 옆에 2배로, 자르기로 그림이 밀리지 않음)', st.redactions.length === 1 && zoom && zoom.w > zoom.sw * 1.5 && zoom.x > zoom.sx + zoom.sw && st.crop && st.crop.w > 0.9
    && Math.abs(top1 - top0) < 1, JSON.stringify({ red: st.redactions, zoom, crop: st.crop, top: [top0, top1] }));

  // 겹친 곳 고르기: 확대 원본의 안쪽(가림 위)을 누르면 가림이, 확대 원본의 테두리를 누르면 확대가 골라짐 (Delete 로 확인 후 되돌림)
  await tool('select');
  const zc = { x: zoom.sx + zoom.sw / 2, y: zoom.sy + zoom.sh / 2 };
  await click(ed, ...at(b, zc.x, zc.y));
  await key(ed, 'Delete');
  const pickInner = await stepState();
  await pageEval(ed, `document.querySelector('#btn-undo').click(), true`);
  await sleep(300);
  await click(ed, ...at(b, zc.x, zoom.sy));
  await key(ed, 'Delete');
  const pickEdge = await stepState();
  await pageEval(ed, `document.querySelector('#btn-undo').click(), true`);
  await sleep(300);
  const restored = await stepState();
  const hasZoom = (s) => s.annotations.some((a) => a.type === 'zoom');
  check('D-7 겹친 곳: 확대 원본 안쪽은 아래의 가림이, 테두리는 확대가 골라짐', pickInner.redactions.length === 0 && hasZoom(pickInner)
    && pickEdge.redactions.length === 1 && !hasZoom(pickEdge) && restored.redactions.length === 1 && hasZoom(restored),
    JSON.stringify({ inner: [pickInner.redactions.length, hasZoom(pickInner)], edge: [pickEdge.redactions.length, hasZoom(pickEdge)], restored: [restored.redactions.length, hasZoom(restored)] }));

  // 내보내기 이미지: 자른 크기, 박스 테두리 색, 확대 안은 가린 검정 (파랑이 드러나지 않음)
  const px = await pageEval(ed, `(async () => {
    const db = await import('/src/common/db.js'); const { bakeStepImage } = await import('/src/common/render.js'); const { getSettings } = await import('/src/common/settings.js');
    const step = (await db.getSteps(${JSON.stringify(mk.sid)}))[0]; const blob = await db.getShot(step.shotId);
    const out = await bakeStepImage(blob, step, await getSettings());
    const img = new Image(); img.src = out.dataUrl; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const cx = Math.floor(step.crop.x * 800), cy = Math.floor(step.crop.y * 400);
    const get = (fx, fy) => Array.from(x.getImageData(Math.round(fx * 800) - cx, Math.round(fy * 400) - cy, 1, 1).data);
    const z = step.annotations.find((a) => a.type === 'zoom'); const r = step.annotations.find((a) => a.type === 'rect');
    return { w: out.width, h: out.height, rectEdge: get(r.x + r.w / 2, r.y), zoomCenter: get(z.x + z.w / 2, z.y + z.h / 2), inside: get(r.x + r.w / 2, r.y + r.h / 2) };
  })()`);
  const isRed = (c) => c[0] > 200 && c[1] < 120 && c[2] < 120;
  check('D-8 내보내기 이미지가 자른 크기이고 박스 테두리가 빨강, 확대 안은 가린 검정', Math.abs(px.w - 0.96 * 800) < 12 && Math.abs(px.h - 0.94 * 400) < 12 && isRed(px.rectEdge)
    && px.zoomCenter[0] < 60 && px.zoomCenter[1] < 60 && px.zoomCenter[2] < 60 && px.inside[0] > 200, JSON.stringify(px));

  // 자르기 해제와 그리기 끝내기
  await pageEval(ed, `document.querySelectorAll('li.step')[0].querySelector('.d-uncrop').click(), true`);
  await sleep(200);
  const uncrop = (await stepState()).crop;
  await key(ed, 'Escape');
  await key(ed, 'Escape');
  const closed = await pageEval(ed, `document.querySelectorAll('li.step')[0].querySelector('.draw-bar').hidden`);
  check('D-9 자르기 해제, Esc 로 그리기를 끝냄', uncrop === null && closed, JSON.stringify({ uncrop, closed }));

  // 다시 열어도 그대로 (저장됨) + 색 바꾸기
  await pageEval(ed, `location.reload(), true`);
  await sleep(1500);
  const again = await pageEval(ed, `(() => { const c = document.querySelector('.shot-canvas'); return !!c && c.width > 100; })()`);
  st = await stepState();
  check('D-10 새로고침 뒤에도 그림이 남고 캔버스로 다시 그려짐', again && st.annotations.length === 5 && st.redactions.length === 1, `주석 ${st.annotations.length}개`);
} catch (e) { check('D 구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

/* ============ 3. 단계 다루기: 지우기와 되돌리기, 끌어서 옮기기, 합치기, 나누기, 메모 ============ */
const order = () => extEval(`(async () => { const db = await import('/src/common/db.js'); return (await db.getSteps(${JSON.stringify(mk.sid)})).map((s) => ({ id: s.id, title: s.title, description: s.description, type: s.type, shot: s.shotId, index: s.index })); })()`);
try {
  await activate(ed);
  // 닫힌 메뉴·그리기 막대가 화면에 실제로 안 보이는지 (hidden 속성을 CSS display 가 덮지 않는지)
  const vis = await pageEval(ed, `(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const count = (sel) => [...document.querySelectorAll(sel)].filter(shown).length;
    const r = { menu: shown(document.querySelector('#export-menu')), dropdowns: count('.step-dropdown'), bars: count('.draw-bar') };
    const li = document.querySelectorAll('li.step')[1];
    li.querySelector('.t-more').click();
    r.afterMore = count('.step-dropdown');
    document.querySelector('#guide-desc').click();
    r.afterOutside = count('.step-dropdown');
    li.querySelector('.t-draw').click();
    r.barsDrawing = count('.draw-bar');
    li.querySelector('.t-draw').click();
    r.barsAfter = count('.draw-bar');
    return r;
  })()`);
  check('S-0 닫힌 메뉴·그리기 막대는 안 보이고, ⋯·그리기를 누른 단계의 것만 보임', !vis.menu && vis.dropdowns === 0 && vis.bars === 0 && vis.afterMore === 1 && vis.afterOutside === 0 && vis.barsDrawing === 1 && vis.barsAfter === 0, JSON.stringify(vis));
  // 지우기 → 알림의 되돌리기
  await pageEval(ed, `document.querySelectorAll('li.step')[1].querySelector('.t-del').click(), true`);
  await sleep(400);
  const o1 = await order();
  await pageEval(ed, `document.querySelector('#toast .toast-act').click(), true`);
  await sleep(600);
  const o2 = await order();
  const shotBack = await extEval(`(async () => { const db = await import('/src/common/db.js'); return !!(await db.getShot(${JSON.stringify((o2[1] || {}).shot || '')})); })()`);
  check('S-1 단계를 지우고 알림의 되돌리기로 스크린샷까지 되살림', o1.length === 2 && o2.length === 3 && o2[1].id === mk.ids[1] && shotBack && o2.every((s, i) => s.index === i), `${o1.length} → ${o2.length}`);

  // 끌어서 옮기기: 3번째 단계를 맨 위로
  await pageEval(ed, `(() => {
    const items = document.querySelectorAll('li.step'); const src = items[2]; const dst = items[0];
    src.querySelector('.t-drag').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 10, clientY: r.y + 4 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 10, clientY: r.y + 4 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(700);
  const o3 = await order();
  check('S-2 ⠿ 손잡이로 끌어서 맨 위로 옮김', o3.map((s) => s.id).join() === [mk.ids[2], mk.ids[0], mk.ids[1]].join(), o3.map((s) => s.title).join(' / '));
  await pageEval(ed, `document.querySelector('#btn-undo').click(), true`);
  await sleep(700);
  const o4 = await order();
  check('S-3 옮기기도 되돌리기로 원래 순서', o4.map((s) => s.id).join() === mk.ids.join(), o4.map((s) => s.title).join(' / '));

  // 위 단계와 합치기 (2번째를 1번째와), 단계 나누기, 아래에 메모
  const act = (i, a) => pageEval(ed, `(() => { const li = document.querySelectorAll('li.step')[${i}]; li.querySelector('.t-more').click(); li.querySelector('[data-act="${a}"]').click(); return true; })()`);
  await act(1, 'merge-up');
  await sleep(700);
  const o5 = await order();
  check('S-4 위 단계와 합치기: 아래 단계의 화면을 남기고 설명을 이어 붙임', o5.length === 2 && o5[0].id === mk.ids[1] && o5[0].description === '설명 1\n설명 2', JSON.stringify(o5.map((s) => [s.title, s.description])));
  await act(0, 'split');
  await sleep(700);
  const o6 = await order();
  check('S-5 단계 나누기: 같은 화면을 복사한 단계를 바로 아래에 (스크린샷은 따로)', o6.length === 3 && o6[1].title === '단계 2 (2)' && o6[1].shot && o6[1].shot !== o6[0].shot, JSON.stringify(o6.map((s) => s.title)));
  await act(0, 'note-below');
  await sleep(700);
  const o7 = await order();
  check('S-6 아래에 메모 넣기', o7.length === 4 && o7[1].type === 'note', JSON.stringify(o7.map((s) => s.type)));
  for (let i = 0; i < 3; i++) {
    await pageEval(ed, `document.querySelector('#btn-undo').click(), true`);
    await sleep(700);
  }
  const o8 = await order();
  check('S-7 메모·나누기·합치기를 차례로 되돌리면 처음 세 단계로', o8.map((s) => s.id).join() === mk.ids.join() && o8.map((s) => s.description).join() === '설명 1,설명 2,설명 3', JSON.stringify(o8.map((s) => s.title)));
} catch (e) { check('S 구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

/* ============ 4. 내보내기: 문서 양식·개정 이력·이미지 크기, Word·PowerPoint 파일 ============ */
const DL = tempDir('click-guide-editor-dl-');
const dec = new TextDecoder();
const { readZip } = await import(new URL('../../../click-guide/src/lib/unzip.js', import.meta.url).href);
async function waitFile(re, ms = 20000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const f = fs.readdirSync(DL).find((x) => re.test(x));
    if (f) { await sleep(400); return path.join(DL, f); }
    await sleep(200);
  }
  return null;
}
try {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  // 설정의 문서 양식: 머리글·작성자·로고(120×40 PNG)·목차·개정 이력
  await extEval(`(async () => {
    const c = new OffscreenCanvas(120, 40); const x = c.getContext('2d'); x.fillStyle = '#2f6df6'; x.fillRect(0, 0, 120, 40);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const logo = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const m = await import('/src/common/settings.js');
    await m.setSettings({ exportImageWidth: 0, doc: { headerText: '시험 팀 매뉴얼', author: '시험자', logo, toc: true, revisions: true } });
    return true;
  })()`);
  await pageEval(ed, 'location.reload(), true');
  await sleep(1500);
  await activate(ed);

  // 개정 이력: 줄 둘 추가 → 둘째 줄 내용 입력 → 가이드에 저장
  await pageEval(ed, `(() => { document.querySelector('#rev-box').open = true; document.querySelector('#rev-add').click(); document.querySelector('#rev-add').click(); return true; })()`);
  await sleep(200);
  await typeText(ed, '화면 바뀜');
  await sleep(900);
  const revs = await extEval(`import('/src/common/db.js').then((db) => db.getSession(${JSON.stringify(mk.sid)})).then((s) => s.revisions || [])`);
  check('X-1 개정 이력 줄 추가: 첫 줄은 1.0·작성자·최초 작성, 다음 줄은 1.1, 입력한 내용이 가이드에 저장됨',
    revs.length === 2 && revs[0].version === '1.0' && revs[0].author === '시험자' && revs[0].note === '최초 작성' && revs[1].version === '1.1' && revs[1].note === '화면 바뀜',
    JSON.stringify(revs));

  // 이미지 크기 고르기 → 설정에 저장
  await pageEval(ed, `(() => { document.querySelector('#btn-export').click(); const s = document.querySelector('#export-width'); s.value = '960'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(500);
  const width = await extEval(`import('/src/common/settings.js').then((m) => m.getSettings()).then((s) => s.exportImageWidth)`);
  const shrunk = await pageEval(ed, `(async () => {
    const db = await import('/src/common/db.js'); const { bakeStepImage } = await import('/src/common/render.js'); const { getSettings } = await import('/src/common/settings.js');
    const st = (await db.getSteps(${JSON.stringify(mk.sid)}))[1]; const out = await bakeStepImage(await db.getShot(st.shotId), st, await getSettings(), { maxWidth: 400 });
    return [out.width, out.height];
  })()`);
  check('X-2 내보낼 이미지 크기를 고르면 설정에 남고, 그 폭으로 줄여 구움 (800×400 → 400×200)', width === 960 && shrunk[0] === 400 && shrunk[1] === 200, JSON.stringify({ width, shrunk }));

  // Word
  await pageEval(ed, `document.querySelector('[data-export="docx"]').click(), true`);
  const docxPath = await waitFile(/\.docx$/);
  let docx = null;
  if (docxPath) {
    const z = await readZip(new Uint8Array(fs.readFileSync(docxPath)));
    const doc = dec.decode(await z.read('word/document.xml'));
    docx = {
      first: z.names[0], headings: (doc.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, toc: doc.includes('TOC \\o "1-1"'),
      rev: doc.includes('화면 바뀜') && doc.includes('최초 작성'), shots: z.names.filter((n) => /^word\/media\/step-/.test(n)).length,
      logo: z.names.includes('word/media/logo.png'), header: dec.decode(await z.read('word/header1.xml')).includes('시험 팀 매뉴얼'),
      font: dec.decode(await z.read('word/styles.xml')).includes('맑은 고딕'),
    };
  }
  check('X-3 Word 로 내보내면 단계 제목 3개·목차·개정 이력·그림 3장·머리글 로고와 글이 들어감',
    !!docx && docx.first === '[Content_Types].xml' && docx.headings === 3 && docx.toc && docx.rev && docx.shots === 3 && docx.logo && docx.header && docx.font,
    JSON.stringify({ file: docxPath && path.basename(docxPath), ...docx }));

  // PowerPoint
  await pageEval(ed, `(() => { document.querySelector('#btn-export').click(); document.querySelector('[data-export="pptx"]').click(); return true; })()`);
  const pptxPath = await waitFile(/\.pptx$/);
  let pptx = null;
  if (pptxPath) {
    const z = await readZip(new Uint8Array(fs.readFileSync(pptxPath)));
    const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const s2 = dec.decode(await z.read('ppt/slides/slide2.xml'));
    pptx = { slides: slides.length, shots: z.names.filter((n) => /^ppt\/media\/step-/.test(n)).length, logo: z.names.includes('ppt/media/logo.png'),
      footer: s2.includes('<a:t>시험 팀 매뉴얼</a:t>') && s2.includes('<a:t>1 / 3</a:t>'), title: s2.includes('<a:t>단계 1</a:t>') };
  }
  check('X-4 PowerPoint 로 내보내면 표지 + 단계마다 한 장, 그림·로고·아래쪽 머리글과 쪽 번호',
    !!pptx && pptx.slides === 4 && pptx.shots === 3 && pptx.logo && pptx.footer && pptx.title, JSON.stringify({ file: pptxPath && path.basename(pptxPath), ...pptx }));
} catch (e) { check('X 구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

const pass = results.filter((r) => r.ok).length;
console.log(`\nClickGuide 편집기: ${pass} / ${results.length} 통과`);
try { await cdp.send('Browser.close'); } catch (_) { /* noop */ }
cdp.close();
try { proc.kill(); } catch (_) { /* noop */ }
for (const s of servers) s.close();
await sleep(500);
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* 잠금 해제 전일 수 있음 */ }
try { fs.rmSync(DL, { recursive: true, force: true }); } catch (_) { /* noop */ }
process.exit(pass === results.length ? 0 : 1);
