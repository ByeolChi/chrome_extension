/* ClickGuide 백그라운드 서비스 워커
 * - 녹화 상태 관리 / 탭 추적
 * - 화면 캡처(직렬 큐 + 쿼터 재시도) / 리사이즈 / 민감 영역 가리기(검정 칠하기 또는 흐리게)
 * - 단계 저장(IndexedDB)
 */
import { getSettings, migrateApiKey } from '../common/settings.js';
import { describeStep, suggestGuideTitle } from '../common/describe.js';
import { localPageTitle } from '../common/util.js';
import { fieldClicksToMerge } from '../common/steps.js';
import * as db from '../common/db.js';
import '../shared/redact-core.js';   // 공용 가리기 코어 → globalThis.RedactCore (CleanShot Picker 와 같은 코드)

const RC = globalThis.RedactCore;

const STATE_KEY = 'cg_state';
const BAR_HIDDEN_KEY = 'cg_barHidden';
const BAR_POS_KEY = 'cg_barPos';
const RECORDER_ID = 'cg-recorder';
const EMPTY_STATE = {
  recording: false, paused: false, sessionId: null,
  stepCount: 0, tabIds: [], windowId: null, lastUrl: '', startedAt: 0
};

/* ------------------------------------------------------------------ */
/* 상태                                                                 */
/* ------------------------------------------------------------------ */

let cachedState = null;
let cachedSettings = null;
let barCache = null;   // { pos, hidden } — 녹화 바 위치와 숨김 여부

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.cg_settings) {
    cachedSettings = null;
    // 녹화 중에 바꾼 설정(가릴 선택자 등)을 바로 대상 탭에 알린다
    if (cachedState && cachedState.recording) scheduleBroadcast(cachedState);
  }
  if (changes[BAR_POS_KEY] || changes[BAR_HIDDEN_KEY]) {
    barCache = null;
    notifyBar();
  }
});

async function settings() {
  if (!cachedSettings) cachedSettings = await getSettings();
  return cachedSettings;
}

async function barState() {
  if (barCache) return barCache;
  const g = await chrome.storage.local.get([BAR_POS_KEY, BAR_HIDDEN_KEY]);
  const p = g[BAR_POS_KEY];
  barCache = {
    pos: (p && typeof p.nx === 'number' && typeof p.ny === 'number') ? { nx: p.nx, ny: p.ny } : null,
    hidden: !!g[BAR_HIDDEN_KEY]
  };
  return barCache;
}

/* 콘텐츠 스크립트는 웹페이지와 같은 프로세스에서 돈다. 그래서 설정 전체가 아니라
 * 콘텐츠 스크립트가 쓰는 값만 골라 보낸다. AI 설정과 API 키는 보내지 않는다. */
function contentSettings(cfg) {
  return {
    recordClicks: !!cfg.recordClicks,
    recordInputs: !!cfg.recordInputs,
    maskPasswords: !!cfg.maskPasswords,
    maskSensitiveValues: !!cfg.maskSensitiveValues,
    maskScreenPII: !!cfg.maskScreenPII,
    maskValueChars: cfg.maskValueChars | 0,
    redactSelectors: Array.isArray(cfg.redactSelectors) ? cfg.redactSelectors.slice(0, 50) : []
  };
}

/* 콘텐츠 스크립트에 보내는 상태. 녹화 대상 탭인지(isTarget)는 탭마다 여기서 정한다.
 * 대상이 아닌 탭은 녹화 바를 띄우지 않고, 클릭도 보내지 않는다. */
async function contentView(tabId, st) {
  const state = st || await getState();
  const isTarget = !!(state.recording && tabId != null && (state.tabIds || []).includes(tabId));
  return {
    state: { recording: !!state.recording, paused: !!state.paused, stepCount: state.stepCount || 0 },
    isTarget,
    settings: isTarget ? contentSettings(await settings()) : null,
    bar: isTarget ? await barState() : null
  };
}

const EXT_ORIGIN = chrome.runtime.getURL('');
function isExtensionPage(sender) {
  return !!(sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_ORIGIN));
}

/* 녹화 바 위치·숨김이 바뀌면(바를 끈 탭, 팝업, 설정 화면 어디서든) 대상 탭에 알린다 */
async function notifyBar() {
  const st = await getState();
  if (!st.recording) return;
  const bar = await barState();
  for (const tabId of st.tabIds || []) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'BAR_CHANGED', bar }); } catch (_) { /* 콘텐츠 스크립트 없음 */ }
  }
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
  try {
    await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#ffb020' : '#ff3b30' });
    await chrome.action.setBadgeText({ text: state.recording ? String(state.stepCount || 0) : '' });
  } catch (_) { /* noop */ }
  const targets = targetTabIds && targetTabIds.length ? targetTabIds : (state.tabIds || []);
  for (const tabId of targets) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'STATE_CHANGED', ...(await contentView(tabId, state)) });
    } catch (_) { /* 콘텐츠 스크립트 없음 */ }
  }
  // 확장 페이지(팝업)용. 콘텐츠 스크립트에는 전달되지 않는다.
  try { await chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state }); } catch (_) { /* 팝업 닫힘 */ }
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

/* 촬영 직후 탭의 모든 프레임에서 '지금 가릴 곳'을 다시 잰다.
 * 클릭 때 잰 가릴 곳만 쓰면 그사이 뜬 모달, 클릭하지 않은 다른 프레임의 비밀번호 칸 등을 놓친다.
 *  1) executeScript 로 녹화 스크립트가 있는 모든 프레임에서 recorder.js 의 __CLICKGUIDE_REDACT_NOW__ 를 부른다.
 *     (격리된 환경의 함수라 페이지 스크립트는 부를 수 없다) 각 프레임은 가릴 곳을 재서 최상위 프레임 좌표로
 *     올려 보내고(iframe 위치 보정은 클릭과 같은 경로), 보낸 개수와 일회용 표식을 돌려준다.
 *  2) 표식이 붙은 REDACT_RECTS 가 모두 올 때까지 기다린다. 보통 수십 ms 안에 끝난다.
 *  3) 정해진 시간 안에 오지 않은 프레임이 있으면 complete: false — 그 화면은 가리지 못한 채라 저장하지 않는다.
 *     프레임을 아예 확인하지 못한 경우(탭이 이미 다른 페이지로 넘어가는 중 등)는 클릭 때 잰 것으로 가린다. */
const redactCollections = new Map();   // clientId -> { got: Map(token -> rects), wake }
const REDACT_MAX_MS = 1500;

function redactNowInFrame(id) {
  const f = globalThis.__CLICKGUIDE_REDACT_NOW__;
  return typeof f === 'function' ? f(id) : null;
}

async function collectRedactions(tabId, clientId, maxMs = REDACT_MAX_MS) {
  if (!clientId) return { rects: [], complete: true };
  const col = { got: new Map(), wake: null };
  redactCollections.set(clientId, col);
  const all = () => [...col.got.values()].flat();
  try {
    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: redactNowInFrame, args: [clientId] }),
        sleep(maxMs).then(() => { throw new Error('프레임 확인 시간 초과'); })
      ]);
    } catch (e) {
      return { rects: all(), complete: true, probeError: String((e && e.message) || e) };
    }
    const pending = (results || []).map((r) => r && r.result).filter((x) => x && x.n > 0 && typeof x.token === 'string').map((x) => x.token);
    const deadline = Date.now() + maxMs;
    while (pending.some((t) => !col.got.has(t)) && Date.now() < deadline) {
      await new Promise((resolve) => {
        col.wake = resolve;
        setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
    }
    const missing = pending.filter((t) => !col.got.has(t)).length;
    return { rects: all(), complete: missing === 0, missing };
  } finally {
    redactCollections.delete(clientId);
  }
}

/* 촬영은 끝났지만 아직 저장 큐에 넣지 않은 단계(가릴 곳을 모으는 중). 녹화를 끝낼 때 이것도 기다린다. */
const postCapture = new Set();
function trackPostCapture() {
  let release = null;
  const p = new Promise((r) => { release = r; });
  postCapture.add(p);
  return () => { postCapture.delete(p); release(); };
}

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

/* 페이지 이동 단계를 찍기 직전: 최상위 프레임에 녹화 바를 숨기게 하고,
 * 지금 화면에서 가릴 영역(비밀번호 칸, 항상 가릴 선택자 등)과 제목을 받아 온다.
 * 응답이 없으면 null — 가릴 곳을 모르는 채로 찍지 않는다. */
async function prepareNavShot(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'NAV_SHOT_PREP' }, { frameId: 0 });
    return (r && r.ok) ? r : null;
  } catch (_) { return null; }
}

async function processShot(dataUrl, { maxWidth, quality, redactions, viewport, style }) {
  const srcBlob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(srcBlob);
  const reds = Array.isArray(redactions) ? redactions : [];

  // 가릴 영역이 없고 이미 충분히 작으면 다시 인코딩하지 않는다 (CPU 절약)
  if (!reds.length && bmp.width <= maxWidth) {
    const w0 = bmp.width, h0 = bmp.height;
    bmp.close();
    return { blob: srcBlob, width: w0, height: h0 };
  }
  // 가릴 곳이 있는데 기준 화면 크기를 모르면 어디를 가릴지 알 수 없다. 가리지 않은 이미지를 남기지 않는다.
  if (reds.length && !(viewport && viewport.w > 0)) {
    bmp.close();
    throw new Error('가릴 영역의 기준 화면 크기를 몰라 스크린샷을 저장하지 않았습니다.');
  }

  const scale = Math.min(1, maxWidth / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);

  // 좌표는 최상위 화면의 CSS px. 가로 배율 하나로 맞춘다
  // (기기 에뮬레이션 등으로 innerHeight 와 캡처 높이가 다를 수 있기 때문 — normRect 와 같은 기준).
  if (reds.length) {
    const k = w / viewport.w;
    RC.paintRedactions(ctx, RC.toPixelRects(reds, k, k, w, h), {
      style: style === 'blur' ? 'blur' : 'box', source: bmp, width: w, height: h, blurPx: 14
    });
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

/* 잡아 둔 순번을 쓰지 못하게 됐을 때, 그 뒤로 다른 순번이 나가지 않았으면 되돌린다 */
function releaseSlot(slot) {
  if (slot && slotBook && slotBook.sessionId === slot.sessionId && slotBook.next === slot.index + 1) slotBook.next--;
}

/* 녹화 대상 탭에서 온 촬영 요청인지 메모리에 있는 상태만으로 바로 판단한다.
 * 순번은 첫 await 전에 잡아야 하는데, 대상이 아닌 탭의 요청에 순번을 주면
 * 단계 번호가 비고 단계 수가 실제보다 커진다. 상태를 아직 읽지 않았으면 false(나중에 비동기로 확인). */
function isRecordingTabSync(sender) {
  const st = cachedState;
  if (!st || !st.recording || st.paused) return false;
  return !!(sender && sender.tab && (st.tabIds || []).includes(sender.tab.id));
}

/* '기록 버리고 중단'한 세션. 늦게 끝난 저장이 지운 세션에 단계를 다시 쓰지 않게 한다. */
const discarded = new Set();

async function addStep(payload, shot, slot) {
  payload.nrect = stepRects(payload, shot);
  if (!slot || !slot.sessionId || discarded.has(slot.sessionId)) return null;
  const cfg = await settings();
  // 로컬 파일 페이지의 제목에 경로가 들어 있으면(폴더 목록 'C:\Users\…\의 색인' 등) 파일 이름으로 바꾼다
  payload.title = localPageTitle(payload.title || '', payload.url || '');

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
  if (discarded.has(slot.sessionId)) {   // 저장하는 사이에 기록을 버렸다
    try { await db.deleteStep(step); } catch (_) { /* noop */ }
    return null;
  }
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
const LOCAL_FILE = /^file:/i;

/* 로컬 파일(file://)은 chrome://extensions 에서 '파일 URL에 대한 액세스 허용'을 켰을 때만 녹화할 수 있다.
 * 압축 해제로 올린 확장은 처음부터 켜져 있는 경우가 많고, 정책으로 설치한 확장은 꺼져 있다. */
async function fileAccessAllowed() {
  try { return !!(await chrome.extension.isAllowedFileSchemeAccess()); } catch (_) { return false; }
}

async function isRecordableUrl(url) {
  if (RECORDABLE.test(url || '')) return true;
  return LOCAL_FILE.test(url || '') && await fileAccessAllowed();
}

async function unrecordableReason(tab) {
  const url = (tab && tab.url) || '';
  if (!url) return '탭 주소를 읽을 수 없습니다. 확장에 이 사이트 접근 권한이 있는지 확인해 주세요.';
  if (/^chrome:|^edge:|^about:|^devtools:|^view-source:/i.test(url)) return '브라우저 내부 페이지(chrome:// 등)에서는 녹화할 수 없습니다. 일반 웹페이지를 열고 다시 시작해 주세요.';
  if (/^chrome-extension:/i.test(url)) return '확장 프로그램 페이지에서는 녹화할 수 없습니다.';
  if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(url)) return '크롬 웹스토어 페이지는 브라우저 정책상 녹화할 수 없습니다.';
  if (LOCAL_FILE.test(url)) {
    if (await fileAccessAllowed()) return '';
    return '로컬 파일(file://)을 녹화하려면 확장 프로그램 관리(chrome://extensions)에서 ClickGuide 의 세부정보를 열고 “파일 URL에 대한 액세스 허용”을 켠 뒤, 이 페이지를 새로고침하고 다시 시작해 주세요.';
  }
  if (!RECORDABLE.test(url)) return '이 페이지에서는 녹화할 수 없습니다.';
  return '';
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/shared/redact-core.js', 'src/content/recorder.js']
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

/* 녹화 스크립트는 녹화하는 동안에만 등록한다.
 * 예전에는 manifest 에 넣어 평소에도 모든 페이지에서 돌았고, 페이지를 열 때마다 서비스 워커를 깨웠다. */
async function registerRecorder() {
  try {
    const got = await chrome.scripting.getRegisteredContentScripts({ ids: [RECORDER_ID] });
    if (got && got.length) return;
    await chrome.scripting.registerContentScripts([{
      id: RECORDER_ID,
      matches: ['<all_urls>'],
      js: ['src/shared/redact-core.js', 'src/content/recorder.js'],
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: false
    }]);
  } catch (e) {
    console.warn('[ClickGuide] 녹화 스크립트 등록 실패:', e);
  }
}

async function unregisterRecorder() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_ID] }); } catch (_) { /* 등록되어 있지 않음 */ }
}

/* 녹화 중에는 대상 탭의 문서가 바뀔 때마다 녹화 스크립트가 들어 있는지 확인한다.
 * 뒤로 가기로 복원된 페이지(bfcache)는 녹화를 시작하기 전에 읽은 문서라 스크립트가 없을 수 있다.
 * 평소에는 이 리스너를 떼어 두어 탭이 바뀔 때마다 서비스 워커가 깨어나지 않게 한다. */
let tabWatchOn = false;
function onTabUpdated(tabId, changeInfo) {
  if (changeInfo.status !== 'complete') return;
  repairContentScript(tabId).catch(() => {});
}
function ensureTabWatch() {
  if (tabWatchOn) return;
  tabWatchOn = true;
  chrome.tabs.onUpdated.addListener(onTabUpdated);
}
function stopTabWatch() {
  if (!tabWatchOn) return;
  tabWatchOn = false;
  try { chrome.tabs.onUpdated.removeListener(onTabUpdated); } catch (_) { /* noop */ }
}

async function repairContentScript(tabId) {
  const st = await getState();
  if (!st.recording || !(st.tabIds || []).includes(tabId)) return;
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
  if (!tab || await unrecordableReason(tab)) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
    if (r && r.ok) return;
  } catch (_) { /* 녹화 스크립트가 없다 */ }
  await ensureContentScript(tabId);
}

async function startRecording(tab) {
  // 녹화할 수 없는 탭이면 가이드를 만들기 전에 돌려보낸다 (빈 가이드가 남지 않도록)
  const early = tab ? await unrecordableReason(tab) : '녹화할 탭을 찾지 못했습니다.';
  if (early) return { session: null, attached: false, reason: early, tab };

  const cfg = await settings();
  slotBook = null;
  frameCache = null;
  const session = await db.createSession({
    name: '',
    startUrl: tab.url,
    lang: cfg.lang
  });
  await setState({
    ...EMPTY_STATE,
    recording: true, paused: false,
    sessionId: session.id, stepCount: 0,
    tabIds: [tab.id], windowId: tab.windowId,
    lastUrl: tab.url, startedAt: Date.now()
  });
  slotBook = { sessionId: session.id, next: 0 };
  await registerRecorder();
  ensureTabWatch();

  let reason = '';
  const inj = await ensureContentScript(tab.id);
  const attached = await pingContent(tab.id);
  if (!attached) {
    reason = inj.ok
      ? '이 탭에 녹화 바를 띄우지 못했습니다. 페이지를 새로고침한 뒤 다시 시작해 주세요.'
      : `이 탭에 접근할 수 없습니다 — ${inj.error}`;
    // 바를 띄우지 못했으면 시작하지 않은 것으로 되돌린다 (빈 가이드와 녹화 상태를 남기지 않음)
    await stopRecording({ openEditor: false, discard: true });
    return { session: null, attached: false, reason, tab };
  }

  const st = await getState();
  await broadcast(st);
  return { session, attached, reason, tab };
}

/* discard: true 면 이번 녹화를 가이드로 남기지 않고 지운다 ('기록 버리고 중단') */
async function stopRecording({ openEditor = true, discard = false } = {}) {
  const st = await getState();
  const sessionId = st.sessionId;
  const recordedTabs = [...(st.tabIds || [])];   // 바를 치우라고 알려야 할 탭들
  if (discard && sessionId) discarded.add(sessionId);
  // 아직 저장 중인 단계가 있으면 기다린다 (마지막 클릭이 유실되지 않도록)
  await Promise.race([captureChain.catch(() => {}), sleep(6000)]);
  await Promise.race([Promise.allSettled([...postCapture]), sleep(6000)]);
  await Promise.race([storeChain.catch(() => {}), sleep(6000)]);
  slotBook = null;
  frameCache = null;
  if (sessionId && discard) {
    try { await db.deleteSession(sessionId); } catch (e) { console.warn('[ClickGuide] 기록 삭제 실패', e); }
  } else if (sessionId) {
    let steps = await db.getSteps(sessionId);
    // 입력란을 클릭한 단계 바로 뒤에 그 칸의 입력 단계가 있으면 클릭 단계를 뺀다 (입력 단계가 같은 칸을 하이라이트함)
    const extra = fieldClicksToMerge(steps);
    if (extra.length) {
      try {
        for (const s of extra) await db.deleteStep(s);
        steps = steps.filter((s) => !extra.includes(s));
        steps.forEach((s, k) => { s.index = k; });
        await db.putSteps(steps);
        await db.updateSession(sessionId, { stepCount: steps.length, mergedFieldClicks: extra.length });
      } catch (e) { console.warn('[ClickGuide] 입력란 클릭 단계 합치기 실패', e); }
    }
    const cfg = await settings();
    const ses = await db.getSession(sessionId);
    if (ses && !ses.name) {
      await db.updateSession(sessionId, { name: suggestGuideTitle(steps, cfg.lang) });
    }
  }
  try { await chrome.storage.local.remove(BAR_HIDDEN_KEY); } catch (_) { /* noop */ }
  await setState({ ...EMPTY_STATE }, { alsoNotify: recordedTabs });
  stopTabWatch();
  await unregisterRecorder();
  if (openEditor && !discard && sessionId) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/editor.html?session=${sessionId}`) });
  }
  return discard ? null : sessionId;
}

/* ------------------------------------------------------------------ */
/* 메시지 처리                                                          */
/* ------------------------------------------------------------------ */

/* 콘텐츠 스크립트(웹페이지 쪽)가 보낼 수 있는 메시지. 나머지는 확장 페이지에서만 받는다. */
const CONTENT_MESSAGES = new Set([
  'GET_STATE', 'CAPTURE_STEP', 'PAGE_LOADED', 'CORRECT_RECT', 'FRAME_UP', 'REMEASURE', 'REDACT_RECTS',
  'PAUSE', 'RESUME', 'STOP', 'SET_BAR_HIDDEN', 'SET_BAR_POS'
]);
// 녹화 바의 버튼이 보내는 메시지 — 녹화 대상 탭에서 온 것만 받는다
const BAR_MESSAGES = new Set(['PAUSE', 'RESUME', 'STOP', 'SET_BAR_HIDDEN', 'SET_BAR_POS']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 촬영 요청은 도착 순서를 지켜야 하므로 첫 await 전에 순번을 잡는다.
  // 단, 녹화 대상 탭에서 온 요청일 때만 잡는다.
  const preSlot = (msg && msg.type === 'CAPTURE_STEP' && isRecordingTabSync(sender)) ? reserveSlotSync() : null;
  (async () => {
    const cfg = await settings();
    const fromPage = !isExtensionPage(sender);
    if (fromPage) {
      if (!msg || !CONTENT_MESSAGES.has(msg.type)) { sendResponse({ ok: false, error: 'not allowed' }); return; }
      if (BAR_MESSAGES.has(msg.type)) {
        const st = await getState();
        if (!st.recording || !sender.tab || !(st.tabIds || []).includes(sender.tab.id)) { sendResponse({ ok: false }); return; }
      }
    }
    switch (msg && msg.type) {

      case 'GET_STATE': {
        const st = await getState();
        if (!fromPage) { sendResponse({ state: st }); return; }
        sendResponse(await contentView(sender.tab ? sender.tab.id : null, st));
        return;
      }

      case 'START': {
        let tab = null;
        if (msg.tabId) { try { tab = await chrome.tabs.get(msg.tabId); } catch (_) { tab = null; } }
        if (!tab) {
          // 서비스 워커에는 '현재 창'이 없으므로 마지막으로 포커스된 창을 기준으로 삼고,
          // 확장/브라우저 내부 페이지는 건너뛴다.
          const pick = async (q) => {
            for (const t of await chrome.tabs.query(q)) if (await isRecordableUrl(t.url)) return t;
            return null;
          };
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
          ok: true, sessionId: r.session ? r.session.id : null, attached: r.attached,
          reason: r.reason || '', tabTitle: tab.title || '', tabUrl: tab.url || ''
        });
        return;
      }

      case 'PAUSE': await setState({ paused: true }); sendResponse({ ok: true }); return;
      case 'RESUME': await setState({ paused: false }); sendResponse({ ok: true }); return;

      case 'STOP': {
        // 웹페이지 쪽(녹화 바)에서는 일반 완료만 할 수 있다. 버리기는 팝업에서만.
        const discard = !fromPage && msg.discard === true;
        const id = await stopRecording({ openEditor: !discard && msg.openEditor !== false, discard });
        sendResponse({ ok: true, sessionId: id, discarded: discard });
        return;
      }

      case 'CAPTURE_STEP': {
        const st = await getState();
        const tab = sender.tab;
        if (!st.recording || st.paused || !tab || !(st.tabIds || []).includes(tab.id)) {
          releaseSlot(preSlot);
          sendResponse({ ok: false });
          return;
        }

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

        // 촬영 직후 좌표 재측정 결과와, 모든 프레임이 지금 잰 가릴 곳을 함께 기다렸다가 저장 큐로 넘긴다 (순서 유지)
        const donePost = trackPostCapture();
        try {
          const [correction, late] = await Promise.all([
            awaitCorrection(payload.clientId),
            dataUrl ? collectRedactions(tab.id, payload.clientId) : Promise.resolve({ rects: [], complete: true })
          ]);
          if (!late.complete) {
            dataUrl = null;   // 가리지 못한 화면은 남기지 않는다
            payload.shotError = '가릴 곳을 모든 프레임에서 확인하지 못해 화면을 저장하지 않았습니다.';
          }
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
                  // 클릭 때 잰 것 + 촬영 직후 모든 프레임이 잰 것. 겹쳐도 한 번 더 칠할 뿐이다.
                  redactions: (payload.redactions || []).concat(late.rects),
                  viewport: payload.viewport,
                  style: cfg.redactStyle
                });
              } catch (e) {
                console.warn('[ClickGuide] 이미지 처리 실패', e);
                payload.shotError = payload.shotError || String((e && e.message) || e);
              }
            }
            dataUrl = null;
            await addStep(payload, shot, slot);
          });
        } finally {
          donePost();   // 저장 큐에 넣었으면 녹화 종료는 저장 큐를 기다린다
        }
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
          let prep = null;
          let shotError = '';
          try {
            const fresh = await chrome.tabs.get(tab.id);
            if (fresh && fresh.active) {
              // 클릭 단계와 같은 가리기를 적용한다. 예전에는 가릴 영역을 빈 목록으로 넘겨
              // 비밀번호 칸과 '항상 가릴 영역'이 이동 단계 스크린샷에 그대로 남았다.
              prep = await prepareNavShot(tab.id);
              if (!prep) {
                shotError = '페이지에서 가릴 영역을 확인하지 못해 화면을 저장하지 않았습니다.';
              } else {
                const r = await captureVisible(fresh.windowId, cfg.jpegQuality, fresh.id, { url: msg.url });
                if (r.dataUrl) {
                  // prep 은 최상위 문서만 잰다. 촬영 직후 모든 프레임(iframe 포함)이 잰 가릴 곳을 더한다.
                  const late = await collectRedactions(fresh.id, `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
                  if (!late.complete) {
                    shotError = '가릴 곳을 모든 프레임에서 확인하지 못해 화면을 저장하지 않았습니다.';
                  } else {
                    shot = await processShot(r.dataUrl, {
                      maxWidth: cfg.maxImageWidth, quality: cfg.jpegQuality,
                      redactions: (prep.redactions || []).concat(late.rects), viewport: prep.viewport, style: cfg.redactStyle
                    });
                  }
                } else shotError = r.error || '';
              }
            } else {
              shotError = '탭이 활성 상태가 아니어서 촬영하지 못했습니다.';
            }
          } catch (e) {
            shotError = shotError || String((e && e.message) || e);
          } finally {
            if (prep && prep.hidden) await toggleWidget(tab.id, true);
          }
          await addStep({
            type: 'navigate', url: msg.url, title: (prep && prep.title) || msg.title, ts: Date.now(), shotError
          }, shot, navSlot);
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

      // 촬영 직후 프레임들이 잰 가릴 곳. 최상위 프레임이 하위 프레임 것까지 자기 좌표로 옮겨 보낸다.
      case 'REDACT_RECTS': {
        const col = redactCollections.get(msg.clientId);
        if (col && sender.tab && sender.frameId === 0 && typeof msg.token === 'string' && Array.isArray(msg.redactions)) {
          const st = await getState();
          if (st.recording && (st.tabIds || []).includes(sender.tab.id)) {
            const rects = [];
            for (const r of msg.redactions.slice(0, 400)) {
              if (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0) {
                rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
              }
            }
            col.got.set(msg.token, rects);
            if (col.wake) col.wake();
          }
        }
        sendResponse({ ok: true });
        return;
      }

      /* 하위 프레임의 클릭·입력·좌표 보정을 부모 프레임으로 올린다.
       * 예전에는 내용을 window.parent.postMessage(…, '*') 로 보내서 부모 페이지의 스크립트도
       * iframe 안에서 입력한 값을 읽을 수 있었다. 이제 내용은 서비스 워커를 거쳐 그 탭의 콘텐츠 스크립트에만 전한다.
       * 부모 프레임은 하위 프레임이 postMessage 로 따로 보낸 일회용 표식(nonce)으로 어느 iframe 인지 찾는다. */
      case 'FRAME_UP': {
        const tab = sender.tab;
        const st = await getState();
        if (!tab || sender.frameId === 0 || typeof msg.nonce !== 'string'
            || !st.recording || !(st.tabIds || []).includes(tab.id)) { sendResponse({ ok: false }); return; }
        sendResponse({ ok: true });
        chrome.tabs.sendMessage(tab.id, { type: 'FRAME_UP', nonce: msg.nonce, payload: msg.payload || null })
          .catch(() => {});
        return;
      }

      // 클릭한 요소가 하위 프레임에 있을 때, 그 프레임에 촬영 시각의 좌표를 다시 재 달라고 한다
      case 'REMEASURE': {
        const tab = sender.tab;
        const st = await getState();
        if (!tab || !st.recording || !(st.tabIds || []).includes(tab.id)) { sendResponse({ ok: false }); return; }
        sendResponse({ ok: true });
        chrome.tabs.sendMessage(tab.id, { type: 'REMEASURE', clientId: msg.clientId, at: msg.at }).catch(() => {});
        return;
      }

      case 'SET_BAR_HIDDEN': {
        if (msg.hidden) await chrome.storage.local.set({ [BAR_HIDDEN_KEY]: true });
        else await chrome.storage.local.remove(BAR_HIDDEN_KEY);
        sendResponse({ ok: true });
        return;
      }

      case 'SET_BAR_POS': {
        const p = msg.pos;
        if (p && typeof p.nx === 'number' && typeof p.ny === 'number') {
          await chrome.storage.local.set({ [BAR_POS_KEY]: { nx: clamp01(p.nx), ny: clamp01(p.ny) } });
        } else {
          await chrome.storage.local.remove(BAR_POS_KEY);
        }
        sendResponse({ ok: true });
        return;
      }

      case 'SPEED_TEST': {
        // 옵션 페이지에서 누르면 활성 탭이 옵션 페이지 자신이라 예전에는 늘 실패했다.
        // 같은 창에서 가장 최근에 본 웹페이지 탭으로 잠깐 바꿔 재고, 끝나면 원래 탭으로 돌아온다.
        const isWeb = (t) => !!t && /^https?:/.test(t.url || '');
        const origin = sender.tab || null;
        let target = null;
        let restoreTabId = null;
        if (origin) {
          const same = (await chrome.tabs.query({ windowId: origin.windowId })).filter(isWeb)
            .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          if (same.length) {
            target = same[0];
            if (!target.active) {
              await chrome.tabs.update(target.id, { active: true });
              restoreTabId = origin.id;
            }
          } else {
            target = (await chrome.tabs.query({ active: true })).filter(isWeb)
              .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
          }
        } else {
          target = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(isWeb) || null;
        }
        if (!target) {
          sendResponse({ ok: false, error: '측정할 웹페이지 탭이 없습니다. 이 창에 일반 웹페이지 탭을 하나 열어 둔 뒤 다시 눌러 주세요. (chrome:// 페이지는 촬영할 수 없습니다)' });
          return;
        }
        const times = [];
        let lastUrl = null;
        let err = '';
        try {
          for (let i = 0; i < 5; i++) {
            await sleep(620);
            const t0 = Date.now();
            try {
              lastUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: Math.round(cfg.jpegQuality * 100) });
              times.push(Date.now() - t0);
            } catch (e) { err = String(e && e.message || e); }
          }
        } finally {
          if (restoreTabId != null) { try { await chrome.tabs.update(restoreTabId, { active: true }); } catch (_) { /* 탭이 닫힘 */ } }
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
  if (left.length === 0) await stopRecording({ openEditor: true });
  else await setState({ tabIds: left });
});

chrome.runtime.onInstalled.addListener(async () => {
  cachedState = null; cachedSettings = null;
  await migrateApiKey().catch((e) => console.warn('[ClickGuide] API 키를 옮기지 못했습니다:', e));
  await chrome.storage.local.set({ [STATE_KEY]: { ...EMPTY_STATE } });
  stopTabWatch();
  await unregisterRecorder();
  try { await chrome.action.setBadgeText({ text: '' }); } catch (_) { /* noop */ }
});

chrome.runtime.onStartup.addListener(async () => {
  cachedState = null; cachedSettings = null;
  await chrome.storage.local.set({ [STATE_KEY]: { ...EMPTY_STATE } });
  stopTabWatch();
  await unregisterRecorder();
});

// 예전 버전이 storage.local 에 둔 AI API 키를 비밀 보관소(확장 출처의 IndexedDB)로 옮긴다. 옮길 것이 없으면 아무것도 하지 않는다.
migrateApiKey().catch((e) => console.warn('[ClickGuide] API 키를 옮기지 못했습니다:', e));

// 녹화 중에 서비스 워커가 다시 떴다면 탭 감시를 이어서 붙인다.
// (cachedState 는 건드리지 않는다 — onStartup 의 초기화와 엇갈려 옛 상태가 남지 않도록)
chrome.storage.local.get(STATE_KEY).then((g) => {
  const s = g && g[STATE_KEY];
  if (s && s.recording) ensureTabWatch();
}).catch(() => {});
