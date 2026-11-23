// ClickGuide 0단계 수정 E2E 검증 (Playwright Chromium + CDP 직접 제어)
// 실행: 저장소 최상위에서 node tests/e2e/click-guide/e2e.mjs [--headed] [--only=구역,…]
//       다른 사본을 시험하려면 CG_EXT=<확장 폴더>. 요구 사항과 시험 내용은 tests/e2e/README.md 참고
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChromium, evaluate, sleep } from './cdp.mjs';
import { startServers, llm } from './server.mjs';
import { tempDir } from '../lib/chromium.mjs';

const EXT = path.resolve(process.env.CG_EXT || fileURLToPath(new URL('../../../click-guide', import.meta.url)));
const PROFILE = tempDir('click-guide-e2e-');
const PORT = Number(process.env.CDP_PORT) || 9301;
const A = 'http://127.0.0.1:18931';
const B = 'http://127.0.0.1:18932';
const HEADED = process.argv.includes('--headed');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const servers = await startServers([18931, 18932]);
const { proc, cdp } = await launchChromium({ extPath: EXT, userDataDir: PROFILE, port: PORT, headless: !HEADED });

/* ---------------- 대상(target)·세션 도우미 ---------------- */
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
console.log('확장 ID:', extId);

async function openPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const page = { targetId, sessionId, url };
  if (url) await navigate(page, url);
  return page;
}

async function navigate(page, url) {
  if (/^about:/.test(url)) {   // about:blank#… 는 같은 문서 안 이동이라 load 가 오지 않는다
    await cdp.send('Page.navigate', { url }, page.sessionId);
    await sleep(300);
    page.url = url;
    return;
  }
  const loaded = cdp.waitFor((m) => m.sessionId === page.sessionId && m.method === 'Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url }, page.sessionId);
  await loaded;
  page.url = url;
}

const pageEval = (page, expr) => evaluate(cdp, page.sessionId, expr);

/* 확장 페이지(옵션)에서 메시지 보내기·DB 읽기 */
const ext = await openPage(`chrome-extension://${extId}/src/options/options.html`);
const extEval = (expr) => pageEval(ext, expr);
const sendMsg = (msg) => extEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

async function tabIdOf(page) {
  const info = await cdp.send('Target.getTargetInfo', { targetId: page.targetId });
  const url = info.targetInfo.url;
  const tabs = await extEval(`chrome.tabs.query({}).then(ts => ts.map(t => ({id:t.id, url:t.url, windowId:t.windowId, active:t.active})))`);
  const hits = tabs.filter((x) => x.url === url);
  if (hits.length > 1) throw new Error('같은 주소의 탭이 여럿이라 고를 수 없습니다: ' + url);
  return hits[0] ? hits[0].id : null;
}

async function activate(page) {
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  const id = await tabIdOf(page);
  if (id) await extEval(`chrome.tabs.update(${id}, {active:true}).then(()=>true)`);
  await sleep(250);
}

async function click(page, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.sessionId);
}

async function typeText(page, text) {
  await cdp.send('Input.insertText', { text }, page.sessionId);
}

async function sessionsDump() {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const ss = await db.listSessions();
    const out = [];
    for (const s of ss) {
      const steps = await db.getSteps(s.id);
      out.push({ id: s.id, name: s.name, stepCount: s.stepCount, createdAt: s.createdAt,
        steps: steps.map(st => ({ id: st.id, index: st.index, type: st.type, url: st.url, title: st.title,
          description: st.description, shotId: st.shotId, nrect: st.nrect, value: st.value, shotW: st.shotW, shotH: st.shotH, shotError: st.shotError })) });
    }
    return out;
  })()`);
}

async function shotCount() {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const d = await db.openDb();
    return await new Promise((res) => { const r = d.transaction('shots').objectStore('shots').count(); r.onsuccess = () => res(r.result); });
  })()`);
}

/* 저장된 스크린샷의 특정 영역(CSS px) 밝기 표준편차 */
async function regionStd(shotId, viewportW, rects) {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const blob = await db.getShot(${JSON.stringify(shotId)});
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const ratio = bmp.width / ${viewportW};
    return ${JSON.stringify(rects)}.map(([x, y, w, h]) => {
      const px = Math.round((x + 12) * ratio), py = Math.round((y + 12) * ratio);
      const pw = Math.round((w - 24) * ratio), ph = Math.round((h - 24) * ratio);
      const d = ctx.getImageData(px, py, pw, ph).data;
      let s = 0, s2 = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const L = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]; s += L; s2 += L*L; n++; }
      const m = s / n; return Math.round(Math.sqrt(Math.max(0, s2 / n - m * m)));
    });
  })()`);
}

/* 페이지 쪽(메인 월드)에서 녹화 바 껍데기 확인 */
const barInfo = (page) => pageEval(page, `[...document.documentElement.children]
  .filter(n => n.tagName === 'DIV' && n.style.zIndex === '2147483647')
  .map(n => ({ open: !!n.shadowRoot, vis: n.style.visibility }))`);

/* 콘텐츠 스크립트(격리된 월드) 실행 컨텍스트 */
async function contentContexts(page) {
  await sleep(100);
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, page.sessionId);
  const main = frameTree.frame.id;
  const all = [...(contexts.get(page.sessionId) || new Map()).values()];
  return all.filter((c) => c.auxData && c.auxData.type === 'isolated' && c.auxData.frameId === main && /ClickGuide/.test(c.name || ''));
}

async function contentEval(page, expr) {
  const ctxs = await contentContexts(page);
  if (!ctxs.length) throw new Error('콘텐츠 스크립트 컨텍스트 없음');
  return evaluate(cdp, page.sessionId, expr, { contextId: ctxs[ctxs.length - 1].id });
}

const state = async () => (await sendMsg({ type: 'GET_STATE' })) || {};
const want = (k) => !ONLY.length || ONLY.includes(k);

async function newestSession() {
  const ss = await sessionsDump();
  return ss.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

async function waitSteps(pred, ms = 5000) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < ms) {
    s = await newestSession();
    if (s && pred(s)) return s;
    await sleep(200);
  }
  return s;
}

try {
  await extEval(`chrome.storage.local.set({ cg_settings: {} }).then(() => true)`);

  /* ============ 1. 녹화 대상 탭만 기록 ============ */
  const tabB = await openPage(`${B}/b.html`);
  const tabA = await openPage(`${A}/a.html`);
  if (want('tabs')) try {
    const before = await contentContexts(tabB);
    check('1-0 녹화 전에는 다른 탭에 콘텐츠 스크립트가 없음', before.length === 0, `컨텍스트 ${before.length}개`);

    await activate(tabA);
    const idA = await tabIdOf(tabA);
    const r = await sendMsg({ type: 'START', tabId: idA });
    check('1-1 녹화 시작 시 대상 탭에 바가 붙음', r && r.ok && r.attached, JSON.stringify(r).slice(0, 160));
    await sleep(800);
    const barA = await barInfo(tabA);
    const barB = await barInfo(tabB);
    check('1-2 대상 탭 A에만 녹화 바 표시', barA.length === 1 && barB.length === 0, `A=${barA.length} B=${barB.length}`);

    // 다른 탭(B)을 새로고침해도(녹화 중 등록된 스크립트가 들어가도) 바가 뜨지 않아야 한다
    await navigate(tabB, `${B}/b.html?reload=1`);
    await sleep(800);
    const barB2 = await barInfo(tabB);
    check('1-3 녹화 중 새로 읽은 다른 탭에도 바가 없음', barB2.length === 0, `B=${barB2.length}`);

    await activate(tabB);
    await click(tabB, 80, 40);
    await sleep(1200);
    let st = await state();
    check('1-4 다른 탭 클릭은 단계 수를 늘리지 않음', (st.state && st.state.stepCount) === 0, `stepCount=${st.state && st.state.stepCount}`);

    await activate(tabA);
    await click(tabA, 80, 40);   // '저장' 버튼
    const s1 = await waitSteps((s) => s.steps.length >= 1);
    st = await state();
    const idx = s1 && s1.steps[0] ? s1.steps[0].index : null;
    check('1-5 대상 탭의 첫 클릭이 0번 단계, 단계 수 1', s1 && s1.steps.length === 1 && idx === 0 && st.state.stepCount === 1,
      `steps=${s1 && s1.steps.length} index=${idx} stepCount=${st.state && st.state.stepCount} sessionCount=${s1 && s1.stepCount}`);
    check('1-6 클릭 단계에 스크린샷이 저장됨', s1 && s1.steps[0] && !!s1.steps[0].shotId, s1 && s1.steps[0] && (s1.steps[0].shotError || ''));

    /* ---- 닫힌 shadow root ---- */
    const bar = await barInfo(tabA);
    check('6-1 녹화 바 shadow root가 페이지에서 보이지 않음(closed)', bar.length === 1 && bar[0].open === false, JSON.stringify(bar));

    /* ---- 콘텐츠 스크립트로 가는 설정에 API 키 없음, 저장소 직접 접근 차단 ---- */
    await extEval(`(async () => { const m = await import('/src/common/settings.js'); await m.setSettings({ ai: { provider: 'openai', apiKey: 'sk-test-SECRET-KEY' } }); return true; })()`);
    await sleep(300);
    try {
      const resp = await contentEval(tabA, `new Promise(r => chrome.runtime.sendMessage({type:'GET_STATE'}, x => r(JSON.stringify(x || null))))`);
      check('5c-1 콘텐츠 스크립트가 받는 상태 응답에 API 키 없음', resp && !resp.includes('sk-test-SECRET-KEY') && !/"ai"/.test(resp), resp.slice(0, 200));
    } catch (e) { check('5c-1 콘텐츠 스크립트가 받는 상태 응답에 API 키 없음', false, e.message); }
    try {
      // Chromium 은 storage.local 의 접근 수준을 바꿀 수 없다(setAccessLevel 은 session 전용). 참고로만 기록한다.
      const got = await contentEval(tabA, `chrome.storage.local.get(null).then(x => 'READ', e => 'DENIED:' + e.message)`);
      console.log(`INFO  콘텐츠 스크립트의 chrome.storage.local 직접 읽기: ${got} (브라우저 제약, 남은 위험)`);
    } catch (e) { console.log('INFO  storage 직접 읽기 확인 실패: ' + e.message); }
    await extEval(`(async () => { const m = await import('/src/common/settings.js'); await m.setSettings({ ai: { provider: 'none', apiKey: '' } }); return true; })()`);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 5d. iframe 값이 부모 페이지로 새지 않음 + 좌표 보정 ============ */
  if (want('iframe')) try {
    await activate(tabA);
    let st = await state();
    if (!st.state || !st.state.recording) { await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) }); await sleep(800); }
    const base = (await newestSession()).steps.length;
    await pageEval(tabA, `window.__leaks.length = 0, true`);
    // 교차 출처 iframe(#fx: 20,480) 안의 입력칸(30,30) 클릭 → 입력 → 같은 출처 iframe(#fs: 480,480)의 버튼(30,100) 클릭
    await click(tabA, 20 + 60, 480 + 45);
    await sleep(300);
    await typeText(tabA, '프레임값');
    await sleep(200);
    await click(tabA, 480 + 60, 480 + 118);
    await sleep(400);
    await click(tabA, 640, 200);   // 빈 곳 클릭 → 교차 출처 iframe 입력칸 blur(change)
    const s = await waitSteps((x) => x.steps.length >= base + 3, 6000);
    const added = s.steps.slice(base);
    const inp = added.find((x) => x.type === 'input');
    const fbtn = added.find((x) => x.type === 'click' && x.title && x.title.includes('프레임 버튼'));
    const vw = await pageEval(tabA, 'innerWidth');
    const vh = await pageEval(tabA, 'innerHeight');
    const inX = inp && inp.nrect ? inp.nrect.x * vw : -1;
    const inY = inp && inp.nrect ? inp.nrect.y * vh : -1;
    check('5d-1 교차 출처 iframe 입력이 단계로 기록되고 좌표가 iframe 위치만큼 보정됨',
      inp && inp.value === '프레임값' && Math.abs(inX - 50) < 6 && Math.abs(inY - 510) < 6,
      inp ? `value=${inp.value} x=${inX.toFixed(1)} y=${inY.toFixed(1)}` : `단계 없음: ${JSON.stringify(added.map(a => a.type + ':' + a.title))}`);
    const bX = fbtn && fbtn.nrect ? fbtn.nrect.x * vw : -1;
    const bY = fbtn && fbtn.nrect ? fbtn.nrect.y * vh : -1;
    check('5d-2 같은 출처 iframe 버튼 클릭 좌표 보정', fbtn && Math.abs(bX - 510) < 6 && Math.abs(bY - 580) < 6,
      fbtn ? `x=${bX.toFixed(1)} y=${bY.toFixed(1)}` : 'click 단계 없음');
    // 테두리 7px + 안쪽 여백 5px 인 iframe(#fb: 900,300) 안 버튼(30,100) → 최상위 기준 (942, 412)
    await sleep(1500);   // 앞 동작(빈 곳 클릭)의 단계가 다 저장될 때까지
    const nb = (await newestSession()).steps.length;
    await click(tabA, 942 + 60, 412 + 18);
    const s2 = await waitSteps((x) => x.steps.length >= nb + 1, 4000);
    const fb = s2.steps.slice(nb).find((x) => x.type === 'click' && /프레임 버튼/.test(x.title || ''));
    const fbX = fb && fb.nrect ? fb.nrect.x * vw : -1;
    const fbY = fb && fb.nrect ? fb.nrect.y * vh : -1;
    check('5d-4 테두리·안쪽 여백이 있는 iframe도 좌표가 어긋나지 않음', fb && Math.abs(fbX - 942) < 3 && Math.abs(fbY - 412) < 3,
      fb ? `x=${fbX.toFixed(1)} y=${fbY.toFixed(1)} (기대 942, 412)` : 'click 단계 없음');
    const leaks = await pageEval(tabA, `window.__leaks.filter(x => /프레임값|프레임 입력|프레임 버튼|payload|label|selector|"rect"/.test(x))`);
    const nonceOnly = await pageEval(tabA, `window.__leaks.filter(x => /^\\{"__clickguideFrame":"[0-9a-z]+"\\}$/.test(x)).length`);
    const others = await pageEval(tabA, `window.__leaks.filter(x => /clickguide/.test(x) && !/^\\{"__clickguideFrame":"[0-9a-z]+"\\}$/.test(x))`);
    check('5d-3 부모 페이지(메인 월드)가 입력값·요소 정보를 받지 못함(일회용 표식만 보임)', leaks.length === 0 && others.length === 0,
      `내용 누출 ${leaks.length}건, 기타 ${others.length}건, 표식만 ${nonceOnly}건 ${leaks.concat(others).slice(0, 2).join(' | ').slice(0, 160)}`);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 4. SPA 화면 전환 ============ */
  if (want('spa')) try {
    await activate(tabA);
    let st = await state();
    if (!st.state || !st.state.recording) { await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) }); await sleep(800); }
    await navigate(tabA, `${A}/spa/`);
    let s = await waitSteps((x) => x.steps.some((y) => y.type === 'navigate' && /\/spa\/$/.test(y.url)), 5000);
    check('4-0 일반 페이지 이동 단계 기록', s && s.steps.some((y) => y.type === 'navigate' && /\/spa\/$/.test(y.url)));
    const navCount = () => newestSession().then((x) => x.steps.filter((y) => y.type === 'navigate').length);
    let n0 = await navCount();
    await click(tabA, 100, 40);   // pushState /spa/users
    s = await waitSteps((x) => x.steps.some((y) => y.type === 'navigate' && /\/spa\/users$/.test(y.url)), 4000);
    const pushStep = s.steps.find((y) => y.type === 'navigate' && /\/spa\/users$/.test(y.url));
    check('4-1 pushState 화면 전환을 이동 단계로 기록', !!pushStep, pushStep ? pushStep.title : '없음');
    check('4-1b 전환 뒤 제목을 반영', pushStep && /SPA 사용자/.test(pushStep.title), pushStep && pushStep.title);
    n0 = await navCount();
    await click(tabA, 280, 40);   // replaceState ?q=
    await sleep(2200);
    check('4-2 쿼리만 바꾸는 replaceState는 기록하지 않음', (await navCount()) === n0);
    await click(tabA, 460, 40);   // #section
    await sleep(2200);
    check('4-3 일반 #앵커 이동은 기록하지 않음', (await navCount()) === n0);
    await click(tabA, 640, 40);   // #/settings
    s = await waitSteps((x) => x.steps.some((y) => y.type === 'navigate' && /#\/settings$/.test(y.url)), 4000);
    check('4-4 해시 라우팅(#/...) 전환은 기록', s.steps.some((y) => y.type === 'navigate' && /#\/settings$/.test(y.url)));
    await click(tabA, 100, 120);  // replaceState /spa/redirected
    s = await waitSteps((x) => x.steps.some((y) => y.type === 'navigate' && /\/spa\/redirected$/.test(y.url)), 4000);
    check('4-5 경로가 바뀌는 replaceState(리다이렉트)는 기록', s.steps.some((y) => y.type === 'navigate' && /\/spa\/redirected$/.test(y.url)));
    n0 = await navCount();
    await pageEval(tabA, 'history.back(), true');
    s = await waitSteps((x) => x.steps.filter((y) => y.type === 'navigate').length > n0, 4000);
    const last = s.steps.filter((y) => y.type === 'navigate').pop();
    check('4-6 뒤로 가기 전환 기록', s.steps.filter((y) => y.type === 'navigate').length > n0, last && last.url);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 3·5b. 페이지 이동 스크린샷 가리기, 주소 노출 ============ */
  if (want('navredact')) try {
    await activate(tabA);
    let st = await state();
    if (!st.state || !st.state.recording) { await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) }); await sleep(800); }
    await navigate(tabA, `${A}/a.html`);
    await sleep(1500);
    await click(tabA, 660, 30);   // 이동 링크 → /nav.html?token=SECRET123
    const s = await waitSteps((x) => x.steps.some((y) => y.type === 'navigate' && /nav\.html/.test(y.url) && y.shotId), 7000);
    const nav = s.steps.find((y) => y.type === 'navigate' && /nav\.html/.test(y.url));
    check('3-0 이동 단계에 스크린샷이 있음', nav && nav.shotId, nav ? (nav.shotError || '') : '단계 없음');
    if (nav && nav.shotId) {
      const vw = await pageEval(tabA, 'innerWidth');
      const [red, ctl, pw] = await regionStd(nav.shotId, vw, [[20, 300, 120, 120], [200, 300, 120, 120], [400, 300, 200, 40]]);
      check('3-1 이동 스크린샷에서 data-clickguide-redact 영역이 흐려짐', red < 40 && ctl > 90, `가림=${red} 대조=${ctl}`);
      check('3-2 이동 스크린샷에서 비밀번호 칸이 흐려짐', pw !== null && pw < 30, `비밀번호 칸 표준편차=${pw}`);
    }
    check('5b-1 이동 단계 제목·설명에 쿼리 문자열(토큰)이 없음',
      nav && !/SECRET123/.test(nav.title + nav.description), nav && (nav.title + ' / ' + nav.description));
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 2. 기록 버리고 중단 / 시작 실패 ============ */
  if (want('discard')) try {
    await activate(tabA);
    let st = await state();
    if (!st.state || !st.state.recording) { await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) }); await sleep(800); }
    await navigate(tabA, `${A}/a.html`);
    await sleep(800);
    await click(tabA, 260, 40);
    await sleep(1200);
    const sid = (await state()).state.sessionId;
    const shotsBefore = await shotCount();
    const r = await sendMsg({ type: 'STOP', discard: true });
    await sleep(500);
    const ss = await sessionsDump();
    st = await state();
    check('2-1 기록 버리기: 가이드가 삭제됨', r && r.ok && !ss.some((x) => x.id === sid), `sid=${sid} 남은 가이드=${ss.length}`);
    const shotsAfter = await shotCount();
    check('2-2 기록 버리기: 스크린샷도 삭제됨', shotsAfter < shotsBefore, `${shotsBefore} → ${shotsAfter}`);
    check('2-3 기록 버리기: 녹화 상태 해제 + 바 제거', st.state && !st.state.recording && (await barInfo(tabA)).length === 0);

    const n0 = (await sessionsDump()).length;
    const blank = await openPage('about:blank#start-fail');
    await activate(blank);
    const r2 = await sendMsg({ type: 'START', tabId: await tabIdOf(blank) });
    await sleep(500);
    const n1 = (await sessionsDump()).length;
    st = await state();
    check('2-4 시작 실패 시 빈 가이드가 남지 않고 녹화 상태도 아님', n1 === n0 && !(st.state && st.state.recording),
      `가이드 ${n0}→${n1}, recording=${st.state && st.state.recording}, attached=${r2 && r2.attached}`);
    if (st.state && st.state.recording) await sendMsg({ type: 'STOP', openEditor: false });
    await cdp.send('Target.closeTarget', { targetId: blank.targetId });

    // 팝업의 '기록 버리고 중단' 버튼: 두 번 눌러야 버린다
    await activate(tabA);
    await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) });
    await sleep(800);
    await click(tabA, 260, 40);
    await sleep(1200);
    const sid2 = (await state()).state.sessionId;
    const pop = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
    await sleep(500);
    await pageEval(pop, `document.querySelector('#cancel').click(), true`);
    await sleep(400);
    const still = (await state()).state.recording;
    const label = await pageEval(pop, `document.querySelector('#cancel').textContent`);
    await pageEval(pop, `document.querySelector('#cancel').click(), true`);
    await sleep(1200);
    const ss2 = await sessionsDump();
    st = await state();
    check('2-5 팝업 버튼: 한 번 누르면 확인 문구, 두 번째에 버림', still === true && !st.state.recording && !ss2.some((x) => x.id === sid2),
      `첫 클릭 후 recording=${still}, 문구='${label}', 남음=${ss2.some((x) => x.id === sid2)}`);
    try { await cdp.send('Target.closeTarget', { targetId: pop.targetId }); } catch (_) { /* 이미 닫힘 */ }
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 6e. 이미지 폭 칸을 비워도 1×1이 되지 않음 ============ */
  if (want('width')) try {
    await activate(ext);
    await extEval(`(() => { const el = document.querySelector('#maxImageWidth'); el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await sleep(900);
    const stored = await extEval(`chrome.storage.local.get('cg_settings').then(g => g.cg_settings.maxImageWidth)`);
    check('6e-1 이미지 폭 칸을 비우면 기본값으로 저장', stored === 1440, `저장값=${stored}`);
    await extEval(`chrome.storage.local.get('cg_settings').then(g => chrome.storage.local.set({ cg_settings: { ...g.cg_settings, maxImageWidth: 0 } })).then(() => true)`);
    await sleep(300);
    await activate(tabA);
    await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) });
    await sleep(800);
    await click(tabA, 80, 40);
    await sleep(1500);
    await sendMsg({ type: 'STOP', openEditor: false });
    await sleep(500);
    const s = await newestSession();
    const shot = s.steps.find((x) => x.shotId);
    check('6e-2 저장된 값이 0이어도 스크린샷이 1×1이 아님', shot && shot.shotW > 100, shot ? `${shot.shotW}×${shot.shotH}` : '스크린샷 없음');
    await extEval(`chrome.storage.local.set({ cg_settings: {} }).then(() => true)`);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 6b. 속도 진단 ============ */
  if (want('speed')) try {
    await activate(ext);
    await extEval(`document.querySelector('#speed-test').click(), true`);
    let txt = '';
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      txt = await extEval(`(() => { const b = document.querySelector('#speed-result'); return b.hidden ? '' : b.textContent; })()`);
      if (txt) break;
    }
    const activeNow = await extEval(`chrome.tabs.query({active:true, lastFocusedWindow:true}).then(t => t[0] && t[0].url)`);
    check('6b-1 옵션 페이지에서 속도 진단이 성공', txt && !/실패/.test(txt), txt.slice(0, 120));
    check('6b-2 진단 뒤 옵션 탭으로 돌아옴', /options\.html/.test(activeNow || ''), activeNow);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 6c·6d·5a. 편집기: AI 결과 병합, 제목 저장 대상, AI로 보내는 내용 ============ */
  if (want('editor')) try {
    const mk = await extEval(`(async () => {
      const db = await import('/src/common/db.js');
      const s1 = await db.createSession({ name: '가이드 하나', startUrl: '${A}/a.html' });
      const s2 = await db.createSession({ name: '가이드 둘', startUrl: '${A}/a.html' });
      // 1번 세션에 스크린샷이 있는 단계 3개 (3번째 단계에는 편집기 가림 영역)
      const c = new OffscreenCanvas(400, 200); const x = c.getContext('2d');
      for (let i = 0; i < 400; i += 20) for (let j = 0; j < 200; j += 20) { x.fillStyle = ((i + j) / 20) % 2 ? '#000' : '#fff'; x.fillRect(i, j, 20, 20); }
      const blob = await c.convertToBlob({ type: 'image/png' });
      const mkStep = async (i, extra) => {
        const shotId = db.uid('shot'); await db.putShot(shotId, blob);
        await db.putStep({ id: db.uid('stp'), sessionId: s1.id, index: i, type: 'input', ts: Date.now(), url: '${A}/a.html?email=hong%40example.com',
          pageTitle: '고객 상세', el: { tag: 'input', label: '이메일' }, value: 'hong@example.com', masked: false, nrect: null,
          redactions: [], shotId, highlight: false, edited: false, title: '원래 제목 ' + (i + 1), description: '원래 설명 ' + (i + 1), ...extra });
      };
      await mkStep(0, {}); await mkStep(1, {}); await mkStep(2, { redactions: [{ x: 0, y: 0, w: 0.5, h: 1 }] });
      await db.updateSession(s1.id, { stepCount: 3 });
      return { s1: s1.id, s2: s2.id };
    })()`);
    await extEval(`(async () => { const m = await import('/src/common/settings.js'); await m.setSettings({ ai: { provider: 'openai', endpoint: '${A}', model: 'test-model', apiKey: '', includeScreenshots: true } }); return true; })()`);
    llm.requests.length = 0;
    llm.delayMs = 2500;
    llm.reply = (body) => {
      const user = body.messages.find((m) => m.role === 'user');
      const text = Array.isArray(user.content) ? user.content.find((c) => c.type === 'text').text : user.content;
      const arr = JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2));
      return JSON.stringify(arr.map((s) => ({ index: s.index, title: 'AI 제목 ' + s.index, description: 'AI 설명 ' + s.index })));
    };
    const ed = await openPage(`chrome-extension://${extId}/src/editor/editor.html?session=${mk.s1}`);
    await sleep(1200);
    await pageEval(ed, `document.querySelector('#btn-ai').click(), true`);
    await sleep(500);
    // AI 응답을 기다리는 동안 1번 단계 제목을 고치고 3번 단계를 지운다
    await pageEval(ed, `(() => { const el = document.querySelectorAll('.s-title')[0]; el.value = '사용자가 고친 제목'; el.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await pageEval(ed, `document.querySelectorAll('li.step')[2].querySelector('.t-del').click(), true`);
    await sleep(3500);
    const dump = (await sessionsDump()).find((x) => x.id === mk.s1);
    const t = dump.steps.map((x) => x.title);
    check('6c-1 AI 응답 중 고친 제목이 덮어써지지 않음', t[0] === '사용자가 고친 제목', JSON.stringify(t));
    check('6c-2 고치지 않은 단계에는 AI 결과 적용', t[1] === 'AI 제목 2', JSON.stringify(t));
    check('6c-3 AI 응답 중 지운 단계가 되살아나지 않음', dump.steps.length === 2, `단계 ${dump.steps.length}개`);
    const req = llm.requests[0];
    if (req) {
      const user = req.messages.find((m) => m.role === 'user');
      const text = Array.isArray(user.content) ? user.content.find((c) => c.type === 'text').text : user.content;
      const payload = JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2));
      const keys = [...new Set(payload.flatMap((p) => Object.keys(p)))];
      check('5a-1 AI로 입력값·페이지 제목·주소를 따로 보내지 않음',
        !keys.includes('value') && !keys.includes('url') && !keys.includes('page') && !/hong%40example|고객 상세/.test(text), `보낸 항목: ${keys.join(',')}`);
      const imgs = Array.isArray(user.content) ? user.content.filter((c) => c.type === 'image_url').map((c) => c.image_url.url) : [];
      if (imgs.length === 3) {
        const stds = await extEval(`(async () => {
          const out = [];
          for (const u of ${JSON.stringify(imgs)}) {
            const b = await (await fetch(u)).blob(); const bmp = await createImageBitmap(b);
            const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
            const d = x.getImageData(20, 20, 160, 160).data; let s = 0, s2 = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) { const L = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]; s += L; s2 += L*L; n++; }
            const m = s / n; out.push(Math.round(Math.sqrt(Math.max(0, s2 / n - m * m))));
          }
          return out;
        })()`);
        check('5a-2 AI로 보내는 스크린샷에 편집기 가림이 적용됨', stds[2] < 40 && stds[0] > 90, `표준편차 ${stds.join(', ')} (3번째가 가림)`);
      } else check('5a-2 AI로 보내는 스크린샷에 편집기 가림이 적용됨', false, `이미지 ${imgs.length}장`);
    } else check('5a-1 AI로 입력값·페이지 제목·주소를 따로 보내지 않음', false, 'AI 요청이 오지 않음');

    // 6d: 제목을 입력하고 0.5초 안에 다른 가이드로 바꾸기
    await pageEval(ed, `(() => { const el = document.querySelector('#guide-title'); el.value = '하나의 새 제목'; el.dispatchEvent(new Event('input', {bubbles:true}));
      const sel = document.querySelector('#session-select'); sel.value = ${JSON.stringify(mk.s2)}; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
    await sleep(1500);
    const all = await sessionsDump();
    const n1 = all.find((x) => x.id === mk.s1).name;
    const n2 = all.find((x) => x.id === mk.s2).name;
    check('6d-1 가이드를 바꿔도 입력한 제목은 원래 가이드에 저장', n1 === '하나의 새 제목' && n2 === '가이드 둘', `하나='${n1}' 둘='${n2}'`);
    await extEval(`(async () => { const m = await import('/src/common/settings.js'); await m.setSettings({ ai: { provider: 'none', includeScreenshots: false } }); return true; })()`);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ 녹화 바: 닫힌 shadow 안 버튼, 위치·숨김 전달, 메시지 제한, 새 탭 ============ */
  if (want('bar')) try {
    // CDP DOM 은 닫힌 shadow root 안도 볼 수 있다 → 버튼의 화면 좌표를 구해 실제 마우스로 누른다
    const findInBar = async (page, pred) => {
      await cdp.send('DOM.enable', {}, page.sessionId);
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId);
      let hit = null;
      const text = (n) => (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
      const walk = (n) => {
        if (hit || !n) return;
        if (pred(n, text(n))) { hit = n; return; }
        for (const c of n.children || []) walk(c);
        for (const s of n.shadowRoots || []) walk(s);
      };
      walk(root);
      if (!hit) return null;
      const { model } = await cdp.send('DOM.getBoxModel', { nodeId: hit.nodeId }, page.sessionId);
      const q = model.border;
      return { x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2, left: q[0], top: q[1] };
    };
    const attr = (n, k) => { const a = n.attributes || []; const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };

    await activate(tabA);
    let st = await state();
    if (st.state && st.state.recording) await sendMsg({ type: 'STOP', openEditor: false });
    await navigate(tabA, `${A}/a.html?bar=1`);
    await activate(tabA);
    await sendMsg({ type: 'START', tabId: await tabIdOf(tabA) });
    await sleep(800);

    // 대상이 아닌 탭의 콘텐츠 스크립트가 보낸 STOP·START 는 받지 않는다
    await navigate(tabB, `${B}/b.html?bar=1`);
    await sleep(600);
    const rStop = await contentEval(tabB, `new Promise(r => chrome.runtime.sendMessage({type:'STOP'}, x => r(JSON.stringify(x))))`);
    st = await state();
    check('8-1 녹화 대상이 아닌 탭의 콘텐츠 스크립트는 녹화를 끝낼 수 없음', st.state.recording === true, rStop);
    const rStart = await contentEval(tabB, `new Promise(r => chrome.runtime.sendMessage({type:'START'}, x => r(JSON.stringify(x))))`);
    check('8-2 콘텐츠 스크립트는 확장 전용 메시지(START)를 보낼 수 없음', /not allowed/.test(rStart || ''), rStart);

    await activate(tabA);
    // 일시정지 버튼
    const pauseBtn = await findInBar(tabA, (n, t) => n.nodeName === 'BUTTON' && t === '일시정지');
    if (pauseBtn) { await click(tabA, pauseBtn.x, pauseBtn.y); await sleep(500); }
    st = await state();
    check('8-3 닫힌 shadow 안 일시정지 버튼이 실제 클릭으로 동작', pauseBtn && st.state.paused === true, pauseBtn ? `paused=${st.state.paused}` : '버튼을 찾지 못함');
    const resumeBtn = await findInBar(tabA, (n, t) => n.nodeName === 'BUTTON' && t === '재개');
    if (resumeBtn) { await click(tabA, resumeBtn.x, resumeBtn.y); await sleep(500); }
    st = await state();
    check('8-4 재개 버튼', resumeBtn && st.state.paused === false);

    // 바 끌어서 옮기기 → 위치 저장 (서비스 워커가 저장)
    const grip = await findInBar(tabA, (n) => n.nodeName === 'SPAN' && attr(n, 'class') === 'grip');
    const barBefore = await findInBar(tabA, (n) => n.nodeName === 'DIV' && /\bbar\b/.test(attr(n, 'class') || ''));
    if (grip) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y }, tabA.sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 }, tabA.sessionId);
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x - i * 80, y: grip.y - i * 60, button: 'left', buttons: 1 }, tabA.sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x - 400, y: grip.y - 300, button: 'left', clickCount: 1 }, tabA.sessionId);
      await sleep(600);
    }
    const pos = await extEval(`chrome.storage.local.get('cg_barPos').then(g => g.cg_barPos || null)`);
    const stepsAfterDrag = (await newestSession()).steps.length;
    check('8-5 바를 끌면 위치가 저장되고 단계로 기록되지 않음', pos && typeof pos.nx === 'number' && stepsAfterDrag === 0,
      `pos=${JSON.stringify(pos)} steps=${stepsAfterDrag}`);
    // 설정 화면의 '바 위치 초기화'처럼 저장값을 지우면 열린 탭의 바도 제자리로
    await extEval(`chrome.storage.local.remove('cg_barPos').then(() => true)`);
    await sleep(600);
    const barAfter = await findInBar(tabA, (n) => n.nodeName === 'DIV' && /\bbar\b/.test(attr(n, 'class') || ''));
    check('8-6 저장된 위치를 지우면 열린 탭의 바도 오른쪽 아래로 돌아감', barBefore && barAfter && Math.abs(barAfter.left - barBefore.left) < 2 && Math.abs(barAfter.top - barBefore.top) < 2,
      `처음 ${barBefore && barBefore.left.toFixed(0)},${barBefore && barBefore.top.toFixed(0)} → 초기화 뒤 ${barAfter && barAfter.left.toFixed(0)},${barAfter && barAfter.top.toFixed(0)}`);

    // × 로 숨기기 → 팝업의 '다시 표시'
    const xBtn = await findInBar(tabA, (n, t) => n.nodeName === 'BUTTON' && t === '×');
    if (xBtn) { await click(tabA, xBtn.x, xBtn.y); await sleep(500); }
    const hiddenStored = await extEval(`chrome.storage.local.get('cg_barHidden').then(g => !!g.cg_barHidden)`);
    check('8-7 × 버튼으로 바 숨기기', xBtn && hiddenStored && (await barInfo(tabA)).length === 0);
    await sendMsg({ type: 'SET_BAR_HIDDEN', hidden: false });
    await sleep(600);
    check('8-8 팝업에서 다시 표시하면 바가 돌아옴', (await barInfo(tabA)).length === 1);

    // 새 탭 따라가기 (target=_blank 링크)
    await click(tabA, 740, 30);
    let newT = null;
    for (let i = 0; i < 30 && !newT; i++) {
      await sleep(200);
      const { targetInfos } = await cdp.send('Target.getTargets');
      newT = targetInfos.find((t) => t.type === 'page' && /b\.html\?new=1/.test(t.url));
    }
    if (newT) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: newT.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      const np = { targetId: newT.targetId, sessionId };
      await sleep(1500);
      const nbar = await barInfo(np);
      await click(np, 80, 40);
      const s = await waitSteps((x) => x.steps.some((y) => y.type === 'click' && /new=1/.test(y.url)), 4000);
      check('8-9 녹화 중 연 새 탭도 기록하고 바를 띄움', nbar.length === 1 && s.steps.some((y) => y.type === 'click' && /new=1/.test(y.url)),
        `bar=${nbar.length} steps=${JSON.stringify(s.steps.map((y) => y.type + ':' + (y.title || '')))}`);
      await cdp.send('Target.closeTarget', { targetId: newT.targetId });
      await sleep(500);
    } else check('8-9 녹화 중 연 새 탭도 기록하고 바를 띄움', false, '새 탭이 열리지 않음');

    // 완료 버튼 → 편집기 열림
    await activate(tabA);
    const doneBtn = await findInBar(tabA, (n, t) => n.nodeName === 'BUTTON' && t === '완료');
    if (doneBtn) { await click(tabA, doneBtn.x, doneBtn.y); }
    let editorOpened = false;
    for (let i = 0; i < 30 && !editorOpened; i++) {
      await sleep(200);
      const { targetInfos } = await cdp.send('Target.getTargets');
      editorOpened = targetInfos.some((t) => /editor\.html\?session=/.test(t.url));
    }
    st = await state();
    check('8-10 바의 완료 버튼 → 녹화 종료 + 편집기 열림', doneBtn && !st.state.recording && editorOpened);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }

  /* ============ bfcache: 녹화 전 페이지로 뒤로 가기 ============ */
  if (want('bfcache')) try {
    const st0 = await state();
    if (st0.state && st0.state.recording) await sendMsg({ type: 'STOP', openEditor: false });
    const tabC = await openPage(`${A}/b.html?c=1`);
    await navigate(tabC, `${A}/a.html?c=1`);
    await activate(tabC);
    await sendMsg({ type: 'START', tabId: await tabIdOf(tabC) });
    await sleep(800);
    await pageEval(tabC, 'history.back(), true');   // 녹화 전에 열었던 b.html (bfcache 복원)
    await sleep(2000);
    const restored = await pageEval(tabC, 'location.pathname');
    const bar = await barInfo(tabC);
    await click(tabC, 80, 40);   // B 버튼
    const s = await waitSteps((x) => x.steps.some((y) => y.type === 'click' && /B 버튼/.test(y.title || '')), 4000);
    check('7-1 녹화 전 페이지로 뒤로 가도 기록이 이어짐', restored === '/b.html' && bar.length === 1 && s.steps.some((y) => y.type === 'click' && /B 버튼/.test(y.title || '')),
      `path=${restored} bar=${bar.length} steps=${JSON.stringify(s.steps.map(y => y.type + ':' + y.title))}`);
    await sendMsg({ type: 'STOP', openEditor: false });
    await sleep(600);
    check('7-2 녹화를 끝내면 등록된 콘텐츠 스크립트도 해제', (await extEval(`chrome.scripting.getRegisteredContentScripts().then(x => x.length)`)) === 0);
  } catch (e) { check('구역 실행 오류', false, (e && e.message || String(e)).slice(0, 200)); }
} catch (e) {
  check('실행 오류', false, e.stack || e.message);
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n결과: ${pass} / ${results.length} 통과`);
  try { await cdp.send("Browser.close"); } catch (_) { /* noop */ }
  cdp.close();
  try { proc.kill(); } catch (_) { /* noop */ }
  for (const s of servers) s.close();
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* 잠금 해제 전일 수 있음 */ }
  process.exit(pass === results.length ? 0 : 1);
}
