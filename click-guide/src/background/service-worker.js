/* ClickGuide 백그라운드 서비스 워커
 * - 녹화 상태 관리 / 탭 추적
 * - 화면 캡처(직렬 큐 + 쿼터 재시도) / 리사이즈 / 민감영역 블러
 * - 단계 저장(IndexedDB)
 */
import { getSettings } from '../common/settings.js';
import { describeStep, suggestGuideTitle } from '../common/describe.js';
import * as db from '../common/db.js';

const STATE_KEY = 'cg_state';
const BAR_HIDDEN_KEY = 'cg_barHidden';
const EMPTY_STATE = {
  recording: false, paused: false, sessionId: null,
  stepCount: 0, tabIds: [], windowId: null, lastUrl: '', startedAt: 0
};

/* ------------------------------------------------------------------ */
/* 상태                                                                 */
/* ------------------------------------------------------------------ */

let cachedState = null;
let cachedSettings = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.cg_settings) cachedSettings = null;
});

async function settings() {
  if (!cachedSettings) cachedSettings = await getSettings();
  return cachedSettings;
}

async function getState() {
  if (cachedState) return cachedState;
  const g = await chrome.storage.local.get(STATE_KEY);
  cachedState = { ...EMPTY_STATE, ...(g[STATE_KEY] || {}) };
  return cachedState;
}

async function setState(patch, { quiet = false, alsoNotify = null } = {}) {
  const next = { ...(await getState()), ...patch };
  cachedState = next;
  chrome.storage.local.set({ [STATE_KEY]: next });   // 기다리지 않는다
  if (quiet) scheduleBroadcast(next);
  else {
    cancelBroadcast();
    const targets = [...new Set([...(next.tabIds || []), ...(alsoNotify || [])])];
    await broadcast(next, targets);
  }
  return next;
}

/* 단계가 쌓일 때마다 모든 탭에 방송하면 클릭 경로가 느려진다.
 * 카운터 갱신 같은 사소한 변화는 묶어서 보낸다. */
let bcTimer = null;
function scheduleBroadcast(state) {
  if (bcTimer) return;
  bcTimer = setTimeout(() => { bcTimer = null; broadcast(state); }, 150);
}
function cancelBroadcast() { if (bcTimer) { clearTimeout(bcTimer); bcTimer = null; } }

/* 녹화를 끝내면 state.tabIds 가 비므로, 그대로 두면 '종료됐다'는 사실이
 * 정작 바가 떠 있는 탭에 전달되지 않는다. 그래서 대상 탭을 따로 받을 수 있게 한다. */
async function broadcast(state, targetTabIds) {
  const cfg = await settings();
  try {
    await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#ffb020' : '#ff3b30' });
    await chrome.action.setBadgeText({ text: state.recording ? String(state.stepCount || 0) : '' });
  } catch (_) { /* noop */ }
  const msg = { type: 'STATE_CHANGED', state, settings: cfg };
  const targets = targetTabIds && targetTabIds.length ? targetTabIds : (state.tabIds || []);
  for (const tabId of targets) {
    try { await chrome.tabs.sendMessage(tabId, msg); } catch (_) { /* 콘텐츠 스크립트 없음 */ }
  }
  try { await chrome.runtime.sendMessage(msg); } catch (_) { /* 팝업 닫힘 */ }
}

/* ------------------------------------------------------------------ */
/* 캡처 큐                                                              */
/* ------------------------------------------------------------------ */

const MIN_GAP_MS = 520;      // captureVisibleTab 쿼터(초당 약 2회) 회피
const WIDGET_HIDE_MS = 32;   // 녹화 표시줄이 화면에서 지워지는 데 필요한 시간(약 2프레임)
let captureChain = Promise.resolve();   // 촬영 전용 (지연을 최소화해야 하는 경로)
let storeChain = Promise.resolve();     // 리사이즈·블러·저장 (무거운 작업)
let lastShotAt = 0;
let captureStartedAt = 0;   // 마지막 촬영을 요청한 시각 (프레임이 찍힌 시점에 가깝다)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueCapture(fn) {
  captureChain = captureChain.catch(() => {}).then(fn);
  return captureChain;
}

function enqueueStore(fn) {
  storeChain = storeChain.catch(() => {}).then(fn);
  return storeChain;
}

/* 클릭 직후 화면이 바뀌면(레이아웃 이동, 모달 열림/닫힘) 촬영된 그림과
 * 클릭 시점의 좌표가 어긋난다. 촬영 직후 콘텐츠 스크립트가 같은 요소를 다시 재서
 * 보내 주는 값을 여기서 기다렸다가 반영한다. */
const rectCorrections = new Map();   // clientId -> resolve

function awaitCorrection(clientId, ms = 260) {
  if (!clientId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { rectCorrections.delete(clientId); resolve(null); }, ms);
    rectCorrections.set(clientId, (data) => {
      clearTimeout(timer);
      rectCorrections.delete(clientId);
      resolve(data);
    });
  });
}

/* 최근에 찍은 프레임. 쿼터에 막혔을 때 재사용한다. */
let frameCache = null;   // { dataUrl, at, tabId, url, sx, sy }
const FRAME_REUSE_MS = 400;
const FRAME_REUSE_MUTATIONS = 0;    // DOM이 조금이라도 바뀌었으면 새로 찍는다

function reusableFrame(tabId, payload) {
  if (!frameCache || frameCache.tabId !== tabId) return null;
  if (Date.now() - frameCache.at > FRAME_REUSE_MS) return null;
  if (payload) {
    if (payload.url && frameCache.url && payload.url !== frameCache.url) return null;
    const sc = payload.scroll;
    if (sc && (Math.abs(sc.x - frameCache.sx) > 2 || Math.abs(sc.y - frameCache.sy) > 2)) return null;
    // 그 사이 화면이 바뀌었으면(모달이 뜨는 등) 재사용하지 않는다.
    // 변화량을 알 수 없을 때도 재사용하지 않는다.
    if (typeof payload.mut !== 'number' || typeof frameCache.mut !== 'number') return null;
    if (payload.mut - frameCache.mut > FRAME_REUSE_MUTATIONS) return null;
  }
  return frameCache;
}

async function rawCapture(windowId, quality) {
  captureStartedAt = Date.now();
  const url = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg', quality: Math.round(Math.max(0.4, Math.min(0.95, quality)) * 100)
  });
  lastShotAt = Date.now();
  return url;
}

/* 촬영 정책
 * 1) 브라우저 쿼터(초당 2회) 안이면 그냥 찍는다 — 대기 없음.
 * 2) 쿼터 안쪽이라 못 찍을 상황이면, 화면이 그대로일 때만 방금 프레임을 재사용한다.
 * 3) 재사용할 수 없으면 '남은 시간만큼만' 기다렸다 찍는다.
 * 4) 그래도 막히면 몇 번 더 시도한 뒤, 마지막에는 조금 오래된 프레임이라도 쓴다.
 *    (스크린샷이 아예 없는 단계를 만들지 않기 위해서다)
 */
async function captureVisible(windowId, quality, tabId, payload) {
  const remember = (url) => {
    if (!url || !tabId) return;
    frameCache = {
      dataUrl: url, at: captureStartedAt, tabId,
      url: (payload && payload.url) || '',
      sx: (payload && payload.scroll && payload.scroll.x) || 0,
      sy: (payload && payload.scroll && payload.scroll.y) || 0,
      mut: (payload && typeof payload.mut === 'number') ? payload.mut : null
    };
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const since = Date.now() - lastShotAt;
    if (since < MIN_GAP_MS) {
      const cached = reusableFrame(tabId, payload);
      if (cached) return { dataUrl: cached.dataUrl, at: cached.at, reused: true };
      await sleep(MIN_GAP_MS - since + 30);
    }
    try {
      const url = await rawCapture(windowId, quality);
      remember(url);
      return { dataUrl: url, at: captureStartedAt, reused: false };
    } catch (err) {
      const m = String(err && err.message || err);
      if (!/MAX_CAPTURE|quota|Tabs cannot be edited/i.test(m)) {
        console.warn('[ClickGuide] 화면 촬영 실패:', m);
        return { dataUrl: null, at: Date.now(), error: m };
      }
      // 쿼터에 막혔다 — 다음 회차에서 남은 시간만큼 기다린다
    }
  }
  // 마지막 수단: 화면이 그대로라면 조금 오래된 프레임이라도 쓴다
  if (frameCache && frameCache.tabId === tabId && Date.now() - frameCache.at < 2500
      && typeof payload?.mut === 'number' && typeof frameCache.mut === 'number'
      && payload.mut === frameCache.mut) {
    return { dataUrl: frameCache.dataUrl, at: frameCache.at, reused: true };
  }
  return { dataUrl: null, at: Date.now(), error: '브라우저의 화면 촬영 제한(초당 2회)에 막혔습니다.' };
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/* CSS 픽셀 사각형 -> 이미지 기준 0~1 좌표.
 * 가로 비율(imgW / viewport.w)로 CSS px 당 이미지 px 을 구한 뒤 세로에도 같은 배율을 적용한다.
 * 이렇게 하면 캡처 높이가 window.innerHeight 와 달라도(기기 에뮬레이션, DevTools 기기 모드 등)
 * 하이라이트가 어긋나지 않는다. */
function normRect(rect, viewport, imgW, imgH) {
  if (!rect || !viewport || !viewport.w) return null;
  if (!imgW || !imgH) {
    const vh = viewport.h || 1;
    const ax = clamp01(rect.x / viewport.w);
    const ay = clamp01(rect.y / vh);
    const bx = clamp01((rect.x + rect.width) / viewport.w);
    const by = clamp01((rect.y + rect.height) / vh);
    return { x: ax, y: ay, w: Math.max(0, bx - ax), h: Math.max(0, by - ay) };
  }
  const ratio = imgW / viewport.w;
  // 화면 밖으로 걸친 요소는 좌표만 자르는 게 아니라 크기까지 함께 잘라야
  // 박스가 엉뚱하게 늘어나지 않는다.
  const x1 = clamp01((rect.x * ratio) / imgW);
  const y1 = clamp01((rect.y * ratio) / imgH);
  const x2 = clamp01(((rect.x + rect.width) * ratio) / imgW);
  const y2 = clamp01(((rect.y + rect.height) * ratio) / imgH);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// 최상위 프레임의 녹화 위젯을 숨겼다/보였다 한다. 프레임 렌더링까지 기다린다.
async function toggleWidget(tabId, visible) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: visible ? 'SHOW_WIDGET' : 'HIDE_WIDGET' }, { frameId: 0 });
    return true;
  } catch (_) { return false; }
}

async function processShot(dataUrl, { maxWidth, quality, redactions, viewport }) {
  const srcBlob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(srcBlob);

  // 가릴 영역이 없고 이미 충분히 작으면 다시 인코딩하지 않는다 (CPU 절약)
  if (!(redactions || []).length && bmp.width <= maxWidth) {
    const w0 = bmp.width, h0 = bmp.height;
    bmp.close();
    return { blob: srcBlob, width: w0, height: h0 };
  }

  const scale = Math.min(1, maxWidth / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);

  const rects = (redactions || [])
    .map((r) => normRect(r, viewport, w, h))
    .filter(Boolean)
    .map((r) => ({ x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h }))
    .filter((r) => r.w > 1 && r.h > 1);

  if (rects.length) {
    const blurCanvas = new OffscreenCanvas(w, h);
    const bctx = blurCanvas.getContext('2d');
    bctx.filter = 'blur(14px)';
    bctx.drawImage(bmp, 0, 0, w, h);
    for (const r of rects) {
      ctx.drawImage(blurCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }
  }

  bmp.close();
  return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }), width: w, height: h };
}

/* 캡처 결과를 받아 단계에 들어갈 정규화 좌표를 만든다 */
function stepRects(payload, shot) {
  const vp = payload.viewport;
  const w = shot ? shot.width : 0;
  const h = shot ? shot.height : 0;
  return normRect(payload.rect, vp, w, h);
}

/* 캡처를 큐에 넣는 순간 세션과 순번을 확정해 둔다.
 * 저장이 녹화 종료보다 늦게 끝나도 단계가 사라지지 않는다. */
let slotBook = null;   // { sessionId, next }

/* 메시지가 도착한 순서 그대로, await 이전에 순번을 확보한다. */
function reserveSlotSync() {
  if (!slotBook) return null;
  return { sessionId: slotBook.sessionId, index: slotBook.next++ };
}

async function reserveSlot() {
  if (!slotBook) {
    const st = await getState();
    if (!st.sessionId) return null;
    slotBook = { sessionId: st.sessionId, next: st.stepCount || 0 };
  }
  return { sessionId: slotBook.sessionId, index: slotBook.next++ };
}

async function addStep(payload, shot, slot) {
  payload.nrect = stepRects(payload, shot);
  if (!slot || !slot.sessionId) return null;
  const cfg = await settings();

  let shotId = null;
  if (shot && shot.blob) {
    shotId = db.uid('shot');
    await db.putShot(shotId, shot.blob);
  }

  const step = {
    id: db.uid('stp'),
    sessionId: slot.sessionId,
    index: slot.index,
    type: payload.type || 'click',
    ts: payload.ts || Date.now(),
    url: payload.url || '',
    pageTitle: payload.title || '',
    el: payload.el || null,
    value: payload.value || '',
    masked: !!payload.masked,
    nrect: payload.nrect || null,
    redactions: [],                       // 편집기에서 추가로 칠하는 영역
    shotId,
    shotError: payload.shotError || '',
    shotW: shot ? shot.width : 0,
    shotH: shot ? shot.height : 0,
    highlight: true,
    lateMs: payload.lateMs || 0,
    edited: false
  };

  // 클릭한 요소가 화면 밖으로 밀려났거나 사라진 경우에는
  // 엉뚱한 자리에 박스를 그리느니 하이라이트를 끈다.
  const n = step.nrect;
  const tiny = !n || n.w < 0.004 || n.h < 0.004;
  step.highlight = !payload.dropHighlight && !tiny;

  const d = describeStep(
    { ...step, title: payload.title || '', value: step.value },
    cfg.lang
  );
  step.title = d.title;
  step.description = d.description;

  await db.putStep(step);
  await db.updateSession(slot.sessionId, { stepCount: slot.index + 1 });
  const st = await getState();
  if (st.sessionId === slot.sessionId) {
    await setState({ stepCount: Math.max(st.stepCount, slot.index + 1), lastUrl: payload.url || st.lastUrl }, { quiet: true });
  }
  return step;
}

/* ------------------------------------------------------------------ */
/* 녹화 시작 / 정지                                                      */
/* ------------------------------------------------------------------ */

const RECORDABLE = /^https?:\/\//i;

function unrecordableReason(tab) {
  const url = (tab && tab.url) || '';
  if (!url) return '탭 주소를 읽을 수 없습니다. 확장에 이 사이트 접근 권한이 있는지 확인해 주세요.';
  if (/^chrome:|^edge:|^about:|^devtools:|^view-source:/i.test(url)) return '브라우저 내부 페이지(chrome:// 등)에서는 녹화할 수 없습니다. 일반 웹페이지를 열고 다시 시작해 주세요.';
  if (/^chrome-extension:/i.test(url)) return '확장 프로그램 페이지에서는 녹화할 수 없습니다.';
  if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(url)) return '크롬 웹스토어 페이지는 브라우저 정책상 녹화할 수 없습니다.';
  if (/^file:/i.test(url)) return '로컬 파일(file://)을 녹화하려면 chrome://extensions 에서 이 확장의 “파일 URL에 대한 액세스 허용”을 켜 주세요.';
  if (!RECORDABLE.test(url)) return '이 페이지에서는 녹화할 수 없습니다.';
  return '';
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/recorder.js']
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* 녹화 바를 띄울 콘텐츠 스크립트가 실제로 살아 있는지 확인한다 */
async function pingContent(tabId) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
      if (r && r.ok) return true;
    } catch (_) { /* 아직 준비되지 않음 */ }
    await sleep(120);
  }
  return false;
}

async function startRecording(tab) {
  const cfg = await settings();
  slotBook = null;
  frameCache = null;
  const session = await db.createSession({
    name: '',
    startUrl: tab ? tab.url : '',
    lang: cfg.lang
  });
  await setState({
    ...EMPTY_STATE,
    recording: true, paused: false,
    sessionId: session.id, stepCount: 0,
    tabIds: tab ? [tab.id] : [], windowId: tab ? tab.windowId : null,
    lastUrl: tab ? tab.url : '', startedAt: Date.now()
  });
  slotBook = { sessionId: session.id, next: 0 };

  let attached = false;
  let reason = tab ? unrecordableReason(tab) : '녹화할 탭을 찾지 못했습니다.';
  if (tab && !reason) {
    const inj = await ensureContentScript(tab.id);
    attached = await pingContent(tab.id);
    if (!attached) {
      reason = inj.ok
        ? '이 탭에 녹화 바를 띄우지 못했습니다. 페이지를 새로고침한 뒤 다시 시작해 주세요.'
        : `이 탭에 접근할 수 없습니다 — ${inj.error}`;
    }
  }

  const st = await getState();
  await broadcast(st);
  return { session, attached, reason, tab };
}

async function stopRecording(openEditor = true) {
  const st = await getState();
  const sessionId = st.sessionId;
  const recordedTabs = [...(st.tabIds || [])];   // 바를 치우라고 알려야 할 탭들
  // 아직 저장 중인 단계가 있으면 기다린다 (마지막 클릭이 유실되지 않도록)
  await Promise.race([captureChain.catch(() => {}), sleep(6000)]);
  await Promise.race([storeChain.catch(() => {}), sleep(6000)]);
  slotBook = null;
  frameCache = null;
  if (sessionId) {
    const steps = await db.getSteps(sessionId);
    const cfg = await settings();
    const ses = await db.getSession(sessionId);
    if (ses && !ses.name) {
      await db.updateSession(sessionId, { name: suggestGuideTitle(steps, cfg.lang) });
    }
  }
  try { await chrome.storage.local.remove(BAR_HIDDEN_KEY); } catch (_) { /* noop */ }
  await setState({ ...EMPTY_STATE }, { alsoNotify: recordedTabs });
  if (openEditor && sessionId) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/editor.html?session=${sessionId}`) });
  }
  return sessionId;
}

/* ------------------------------------------------------------------ */
/* 메시지 처리                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 촬영 요청은 도착 순서를 지켜야 하므로 첫 await 전에 순번을 잡는다
  const preSlot = (msg && msg.type === 'CAPTURE_STEP') ? reserveSlotSync() : null;
  (async () => {
    const cfg = await settings();
    switch (msg && msg.type) {

      case 'GET_STATE':
        sendResponse({ state: await getState(), settings: cfg });
        return;

      case 'START': {
        let tab = null;
        if (msg.tabId) { try { tab = await chrome.tabs.get(msg.tabId); } catch (_) { tab = null; } }
        if (!tab) {
          // 서비스 워커에는 '현재 창'이 없으므로 마지막으로 포커스된 창을 기준으로 삼고,
          // 확장/브라우저 내부 페이지는 건너뛴다.
          const pick = async (q) => (await chrome.tabs.query(q)).find((t) => RECORDABLE.test(t.url || ''));
          tab = await pick({ active: true, lastFocusedWindow: true })
             || await pick({ active: true, currentWindow: true })
             || await pick({ active: true });
        }
        if (!tab) {
          sendResponse({ ok: false, error: '녹화할 웹페이지 탭을 찾지 못했습니다. 일반 웹페이지를 열고 다시 시도해 주세요.' });
          return;
        }
        const r = await startRecording(tab);
        sendResponse({
          ok: true, sessionId: r.session.id, attached: r.attached,
          reason: r.reason || '', tabTitle: tab.title || '', tabUrl: tab.url || ''
        });
        return;
      }

      case 'PAUSE': await setState({ paused: true }); sendResponse({ ok: true }); return;
      case 'RESUME': await setState({ paused: false }); sendResponse({ ok: true }); return;

      case 'STOP': {
        const id = await stopRecording(msg.openEditor !== false);
        sendResponse({ ok: true, sessionId: id });
        return;
      }

      case 'CAPTURE_STEP': {
        const st = await getState();
        if (!st.recording || st.paused) { sendResponse({ ok: false }); return; }
        const tab = sender.tab;
        if (!tab || !(st.tabIds || []).includes(tab.id)) { sendResponse({ ok: false }); return; }

        const payload = msg.step || {};
        payload.url = payload.url || (tab && tab.url) || '';
        payload.title = payload.title || (tab && tab.title) || '';

        // 콘텐츠 스크립트는 위젯을 숨긴 채 응답을 기다린다.
        // 촬영이 끝나자마자 응답해야 (1) 위젯이 사진에 찍히지 않고
        // (2) 클릭과 촬영 사이 간격이 최소가 된다. 무거운 가공은 응답 뒤로 미룬다.
        const slot = preSlot || await reserveSlot();
        if (!slot) { sendResponse({ ok: false }); return; }
        let dataUrl = null;
        let shotAt = Date.now();
        await enqueueCapture(async () => {
          // 녹화 표시줄이 화면에서 지워질 시간. 메시지가 오가는 동안 이미 흐른
          // 시간은 빼고 남은 만큼만 기다린다. 이미 숨어 있었다면 기다리지 않는다.
          if (payload.widgetShown === true) {
            const elapsed = payload.hiddenAt ? (Date.now() - payload.hiddenAt) : 0;
            const rest = WIDGET_HIDE_MS - elapsed;
            if (rest > 0) await sleep(rest);
          }
          if (cfg.captureDelayMs > 0) await sleep(cfg.captureDelayMs);
          if (tab.active) {
            const r = await captureVisible(tab.windowId, cfg.jpegQuality, tab.id, payload);
            dataUrl = r.dataUrl;
            shotAt = r.at;
            payload.shotError = r.error || '';
            payload.shotReused = !!r.reused;
          } else {
            payload.shotError = '탭이 활성 상태가 아니어서 촬영하지 못했습니다.';
          }
        });
        sendResponse({ ok: true, capturedAt: shotAt, wantRect: !!dataUrl });

        // 촬영 직후 좌표 재측정 결과를 기다렸다가 저장 큐로 넘긴다 (순서 유지)
        const correction = await awaitCorrection(payload.clientId);
        if (correction) {
          if (correction.drop) { payload.dropHighlight = true; frameCache = null; }
          else if (correction.rect) {
            const o = payload.rect;
            if (o && (Math.abs(o.x - correction.rect.x) > 3 || Math.abs(o.y - correction.rect.y) > 3)) frameCache = null;
            payload.rect = correction.rect;
          }
        }
        payload.lateMs = Math.max(0, shotAt - (payload.ts || Date.now()));
        enqueueStore(async () => {
          let shot = null;
          if (dataUrl) {
            try {
              shot = await processShot(dataUrl, {
                maxWidth: cfg.maxImageWidth,
                quality: cfg.jpegQuality,
                redactions: payload.redactions || [],
                viewport: payload.viewport
              });
            } catch (e) { console.warn('[ClickGuide] 이미지 처리 실패', e); }
          }
          dataUrl = null;
          await addStep(payload, shot, slot);
        });
        return;
      }

      case 'PAGE_LOADED': {
        const st = await getState();
        if (!st.recording || st.paused || !cfg.recordNavigation) { sendResponse({ ok: false }); return; }
        const tab = sender.tab;
        if (!tab || !(st.tabIds || []).includes(tab.id)) { sendResponse({ ok: false }); return; }
        if (!msg.url || msg.url === st.lastUrl) { sendResponse({ ok: false }); return; }

        frameCache = null;
        const navSlot = await reserveSlot();
        if (!navSlot) { sendResponse({ ok: false }); return; }
        await enqueueCapture(async () => {
          await sleep(400);
          let shot = null;
          let hidden = false;
          try {
            const fresh = await chrome.tabs.get(tab.id);
            if (fresh && fresh.active) {
              hidden = await toggleWidget(tab.id, false);
              const r = await captureVisible(fresh.windowId, cfg.jpegQuality, fresh.id, { url: msg.url });
              if (r.dataUrl) shot = await processShot(r.dataUrl, { maxWidth: cfg.maxImageWidth, quality: cfg.jpegQuality, redactions: [] });
            }
          } catch (_) { /* noop */ } finally {
            if (hidden) await toggleWidget(tab.id, true);
          }
          await addStep({ type: 'navigate', url: msg.url, title: msg.title, ts: Date.now() }, shot, navSlot);
        });
        sendResponse({ ok: true });
        return;
      }

      case 'CORRECT_RECT': {
        const fn = rectCorrections.get(msg.clientId);
        if (fn) fn({ rect: msg.rect || null, drop: !!msg.drop });
        sendResponse({ ok: true });
        return;
      }

      case 'SET_BAR_HIDDEN': {
        if (msg.hidden) await chrome.storage.local.set({ [BAR_HIDDEN_KEY]: true });
        else await chrome.storage.local.remove(BAR_HIDDEN_KEY);
        sendResponse({ ok: true });
        return;
      }

      case 'SPEED_TEST': {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const target = tabs.find((t) => /^https?:/.test(t.url || '')) || tabs[0];
        if (!target) { sendResponse({ ok: false, error: '측정할 탭을 찾지 못했습니다.' }); return; }
        if (!/^https?:/.test(target.url || '')) {
          sendResponse({ ok: false, error: '일반 웹페이지 탭을 열어 둔 상태에서 측정해 주세요. (chrome:// 페이지는 촬영할 수 없습니다)' });
          return;
        }
        const times = [];
        let lastUrl = null;
        let err = '';
        for (let i = 0; i < 5; i++) {
          await sleep(620);
          const t0 = Date.now();
          try {
            lastUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: Math.round(cfg.jpegQuality * 100) });
            times.push(Date.now() - t0);
          } catch (e) { err = String(e && e.message || e); }
        }
        if (!times.length) { sendResponse({ ok: false, error: err || '촬영에 실패했습니다.' }); return; }

        let imgW = 0, imgH = 0, processMs = 0, kb = 0;
        try {
          const blob = await (await fetch(lastUrl)).blob();
          kb = Math.round(blob.size / 1024);
          const t1 = Date.now();
          const shot = await processShot(lastUrl, { maxWidth: cfg.maxImageWidth, quality: cfg.jpegQuality, redactions: [], viewport: null });
          processMs = Date.now() - t1;
          imgW = shot.width; imgH = shot.height;
        } catch (_) { /* noop */ }

        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        sendResponse({
          ok: true,
          captureMs: median, captureAll: times,
          processMs, imgW, imgH, kb,
          widgetWaitMs: WIDGET_HIDE_MS,
          estimateMs: median + WIDGET_HIDE_MS + 15,
          pageUrl: target.url
        });
        return;
      }

      case 'OPEN_EDITOR': {
        const url = chrome.runtime.getURL('src/editor/editor.html' + (msg.sessionId ? `?session=${msg.sessionId}` : ''));
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })().catch((e) => {
    console.error('[ClickGuide]', e);
    try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) { /* noop */ }
  });
  return true;   // 비동기 응답
});

/* ------------------------------------------------------------------ */
/* 탭 추적                                                              */
/* ------------------------------------------------------------------ */

/* 녹화 중에는 서비스 워커가 잠들지 않게 붙잡아 둔다.
 * 잠들면 다음 클릭 때 콜드 스타트 때문에 촬영이 눈에 띄게 늦어진다. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cg-keepalive') return;
  port.onMessage.addListener(() => { /* 메시지 자체가 유휴 타이머를 되돌린다 */ });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const st = await getState();
  const cfg = await settings();
  if (!st.recording || !cfg.followNewTabs) return;
  if (tab.openerTabId && (st.tabIds || []).includes(tab.openerTabId)) {
    await setState({ tabIds: [...st.tabIds, tab.id] });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (!st.recording || !(st.tabIds || []).includes(tabId)) return;
  const left = st.tabIds.filter((t) => t !== tabId);
  if (left.length === 0) await stopRecording(true);
  else await setState({ tabIds: left });
});

chrome.runtime.onInstalled.addListener(async () => {
  cachedState = null; cachedSettings = null;
  await chrome.storage.local.set({ [STATE_KEY]: { ...EMPTY_STATE } });
  try { await chrome.action.setBadgeText({ text: '' }); } catch (_) { /* noop */ }
});

chrome.runtime.onStartup.addListener(async () => {
  cachedState = null; cachedSettings = null;
  await chrome.storage.local.set({ [STATE_KEY]: { ...EMPTY_STATE } });
});
