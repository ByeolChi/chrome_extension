/* CleanShot Picker — service worker
 * 역할: 피커 주입, 화면 캡처, 전체 페이지 잇기, 파일 저장. DOM 은 건드리지 않는다.
 */

/* 공용 가리기 코어(사본은 node scripts/sync-shared.mjs 로 만든다). 피커도 같은 파일을 먼저 싣는다. */
importScripts('shared/redact-core.js');
const RC = globalThis.RedactCore;

const INJECT_FILES = ['shared/redact-core.js', 'picker.js'];
const INJECTABLE = /^(https?|file):/i;

/* captureVisibleTab 은 초당 2회 제한이 있다. 안전하게 550ms 간격을 둔다. */
const MIN_CAPTURE_GAP_MS = 550;
let lastCaptureAt = 0;

/* ---------------------------------------------------------------- 워커 예열
 * MV3 는 30초쯤 놀면 이 워커를 종료한다. 그러면 아이콘을 눌렀을 때
 * 워커가 다시 뜨기를 기다리느라 툴바가 늦게 나타난다.
 * 30초짜리 알람으로 계속 깨워 둔다 — 알람을 받는 것 자체가 목적이라
 * 핸들러는 비어 있다. (0.5분이 크롬이 허용하는 가장 짧은 주기다.)
 */

const WARM_ALARM = 'cleanshot-warm';

async function ensureWarmAlarm() {
  try {
    const existing = await chrome.alarms.get(WARM_ALARM);
    if (!existing) await chrome.alarms.create(WARM_ALARM, { periodInMinutes: 0.5 });
  } catch (err) {
    console.warn('[CleanShot] 예열 알람 등록 실패:', err);
  }
}

chrome.alarms.onAlarm.addListener(() => { /* 깨우는 것이 전부 */ });
chrome.runtime.onInstalled.addListener(ensureWarmAlarm);
chrome.runtime.onStartup.addListener(ensureWarmAlarm);
ensureWarmAlarm();

/* ---------------------------------------------------------------- 진입점 */

chrome.action.onClicked.addListener((tab) => {
  togglePicker(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePicker(tab);
});

async function togglePicker(tab) {
  if (!tab || typeof tab.id !== 'number') return;

  // chrome://, 웹스토어, 다른 확장 페이지에는 주입할 수 없다.
  if (tab.url && !INJECTABLE.test(tab.url)) {
    await flashBadge(tab.id, '✕', '#c0392b');
    return;
  }

  // 이미 들어가 있으면 메시지 한 통으로 끝난다 — 스크립트를 다시 컴파일하지 않는다
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'CLEANSHOT_TOGGLE' });
    if (res && res.ok) return;
  } catch (_) {
    /* 아직 주입 전인 탭이다. 아래에서 넣는다. */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: INJECT_FILES
    });
  } catch (err) {
    console.warn('[CleanShot] 주입 실패:', err);
    await flashBadge(tab.id, '✕', '#c0392b');
  }
}

async function flashBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#555555' });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2000);
  } catch (_) {
    /* 탭이 닫혔을 수 있다 */
  }
}

/* ---------------------------------------------------------------- 메시지 */

const HANDLERS = {
  /* 선택 모드가 열려 있는 동안 워커를 깨워 둔다 (캡처 때 콜드 스타트 방지) */
  CLEANSHOT_PING: async () => ({ ok: true }),

  /* 현재 화면을 찍어 바로 저장한다. msg.copy 면 저장하지 않고 (가리기를 칠한) PNG 를 돌려준다 — 피커가 클립보드에 넣는다.
     msg.crop(화면 CSS px)이 있으면 가리기를 칠한 뒤 그 부분만 잘라 낸다 (6 영역, 파일 이름 끝에 -area) */
  CLEANSHOT_CAPTURE: async (msg, sender) => {
    const shot = await grab(sender);
    if (!shot.ok) return shot;

    // 가리기 박스를 PNG 에 직접 칠한다. 화면의 박스가 다른 요소 아래에 깔렸어도
    // 저장되는 이미지에는 반드시 남게 하려는 것이다. 칠하지 못하면 저장하지 않는다.
    let dataUrl = shot.dataUrl;
    const masks = cleanMasks(msg.masks);
    if (masks.length) {
      try {
        dataUrl = await burnMasks(dataUrl, masks, msg.viewport, msg.dpr);
      } catch (err) {
        return { ok: false, error: `가리기 박스를 이미지에 넣지 못해 ${msg.copy ? '복사' : '저장'}하지 않았습니다 (${describe(err)})` };
      }
    }
    const crop = cleanMasks(msg.crop ? [msg.crop] : [])[0] || null;
    if (crop) {
      try {
        dataUrl = await cropPng(dataUrl, crop, msg.viewport, msg.dpr);
      } catch (err) {
        return { ok: false, error: `고른 영역을 잘라 내지 못했습니다 (${describe(err)})` };
      }
    }
    if (msg.copy) return { ok: true, dataUrl };
    return save(dataUrl, msg.pageUrl || sender.tab.url, crop ? '-area' : '');
  },

  /* 전체 페이지 캡처 — 아래 "전체 페이지" 참고 */
  CLEANSHOT_FULL_BEGIN: (msg, sender) => fullBegin(msg, sender),
  CLEANSHOT_FULL_FRAME: (msg, sender) => fullFrame(msg, sender),
  CLEANSHOT_FULL_END: (msg, sender) => fullEnd(msg, sender)
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && HANDLERS[msg.type];
  if (!fn) return;
  Promise.resolve(fn(msg, sender))
    .catch((err) => ({ ok: false, error: describe(err) }))
    .then(sendResponse);
  return true; // 비동기 응답
});

/* ---------------------------------------------------------------- 캡처와 저장 */

async function grab(sender) {
  const tab = sender && sender.tab;
  if (!tab) return { ok: false, error: '탭 정보를 찾을 수 없습니다.' };

  const wait = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    lastCaptureAt = Date.now();
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

async function save(dataUrl, pageUrl, suffix) {
  if (!dataUrl) return { ok: false, error: '저장할 이미지가 없습니다.' };
  const filename = makeFilename(pageUrl, suffix);

  // 1순위: downloads API. 실패하면 content script 가 <a download> 로 대신 받는다.
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { ok: true, filename };
  } catch (err) {
    console.warn('[CleanShot] downloads 실패, 폴백 사용:', err);
    return { ok: false, fallback: true, filename, dataUrl, error: describe(err) };
  }
}

/* 피커가 보낸 사각형(화면 CSS px) 중 숫자가 온전한 것만 받는다 */
function cleanMasks(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 2000).filter((m) =>
    m && [m.x, m.y, m.w, m.h].every(Number.isFinite) && m.w > 0 && m.h > 0
  );
}

/* 찍은 PNG 위에 검정 사각형을 칠해 다시 PNG 로 만든다.
   배율은 scaleOf 로 정한다. 경계는 바깥쪽으로 반올림해 반 픽셀도 덜 가리지 않는다. */
async function burnMasks(dataUrl, masks, viewport, dpr) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const vw = viewport && viewport.w > 0 ? viewport.w : bmp.width;
    const vh = viewport && viewport.h > 0 ? viewport.h : bmp.height;

    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = RC.toPixelRects(masks, scaleOf(bmp.width, vw, dpr), scaleOf(bmp.height, vh, dpr), bmp.width, bmp.height);
    RC.paintRedactions(ctx, px, { style: 'box' });
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(out);
  } finally {
    bmp.close();
  }
}

/* 찍은 PNG 에서 crop(화면 CSS px) 부분만 잘라 다시 PNG 로 만든다. 경계는 바깥쪽으로 반올림하고 이미지 안으로 자른다 */
async function cropPng(dataUrl, crop, viewport, dpr) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const vw = viewport && viewport.w > 0 ? viewport.w : bmp.width;
    const vh = viewport && viewport.h > 0 ? viewport.h : bmp.height;
    const sx = scaleOf(bmp.width, vw, dpr);
    const sy = scaleOf(bmp.height, vh, dpr);
    const x0 = Math.max(0, Math.floor(crop.x * sx));
    const y0 = Math.max(0, Math.floor(crop.y * sy));
    const x1 = Math.min(bmp.width, Math.ceil((crop.x + crop.w) * sx));
    const y1 = Math.min(bmp.height, Math.ceil((crop.y + crop.h) * sy));
    if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('영역이 화면 밖입니다');
    const canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
    canvas.getContext('2d').drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(out);
  } finally {
    bmp.close();
  }
}

/* ---------------------------------------------------------------- 전체 페이지
 * 피커가 스크롤 대상을 위에서부터 한 화면씩 내리며 장마다 CLEANSHOT_FULL_FRAME 을 보낸다.
 * 여기서는 그 화면을 찍어 스크롤 대상의 보이는 부분(clip)에서 아직 채우지 않은 줄만 큰 캔버스의
 * 제자리(내용 좌표)에 붙이고, 그 장에서 잰 가리기 박스를 같은 줄 범위 안에 칠한다.
 * CLEANSHOT_FULL_END 에서 PNG 로 만들어 저장한다.
 *
 * 좌표: clip·masks 는 화면 CSS px, offset·from·to 는 스크롤 대상의 내용 CSS px(맨 위가 0).
 * 배율은 첫 장으로 정한다(scaleOf — 고해상도 화면과 페이지 확대가 모두 들어 있다).
 * 내용 행 c 는 캔버스 행 round(c × 배율) 에 놓이고, 장마다 같은 반올림을 써서 이음매에 빈 줄이 생기지 않는다.
 *
 * 장마다 찍기 직전과 직후에 그 탭이 아직 창의 활성 탭인지 본다. 찍는 사이 다른 탭으로 바뀌면
 * captureVisibleTab 은 그 탭을 찍으므로, 다른 탭 화면이 이미지에 섞이지 않게 거기서 멈춘다.
 */

/* 캔버스 한 변의 최대 길이와 넓이. 넘는 부분은 위에서부터 잘라 저장한다(넓이 2^26 px 이면 메모리 256MB).
   시험에서 줄여 볼 수 있게 객체로 둔다. */
const FULL_LIMITS = { side: 32767, area: 2 ** 26 };
/* 이 시간 동안 다음 장이 오지 않으면 버린다 (탭을 닫았거나 페이지가 바뀌어 피커가 사라진 경우) */
const FULL_IDLE_MS = 60000;
const FULL_SWITCHED = '찍는 동안 다른 탭으로 바뀌어 멈췄습니다. 다른 탭 화면은 저장하지 않았습니다.';

const fullRuns = new Map(); // tabId → 진행 중인 전체 캡처

chrome.tabs.onRemoved.addListener((tabId) => dropRun(tabId));

async function fullBegin(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab) return { ok: false, error: '탭 정보를 찾을 수 없습니다.' };
  const clip = cleanRect(msg.clip);
  const vp = cleanRect({ x: 0, y: 0, ...(msg.viewport || {}) });
  const total = Number(msg.total);
  const dpr = Number(msg.dpr) > 0 ? Number(msg.dpr) : 1;
  if (!clip || !vp || !(total > 0)) return { ok: false, error: '전체 캡처 정보가 올바르지 않습니다.' };

  dropRun(tab.id);
  const limit = Math.max(1, Math.floor(maxRows(Math.round(clip.w * dpr)) / dpr)); // 내용 CSS px
  const run = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    pageUrl: msg.pageUrl || tab.url,
    clip,
    viewport: { w: vp.w, h: vp.h },
    dpr,
    total: Math.min(total, limit),
    truncated: total > limit,
    canvas: null,
    ctx: null,
    sx: 0,
    sy: 0,
    rows: 0,
    timer: 0
  };
  fullRuns.set(tab.id, run);
  touchRun(run);
  return { ok: true, id: run.id, total: run.total, truncated: run.truncated };
}

async function fullFrame(msg, sender) {
  const run = runOf(sender, msg.id);
  if (!run) return { ok: false, error: '전체 캡처가 이미 끝났거나 시작되지 않았습니다.' };
  touchRun(run);

  const shot = await grabRun(run);
  if (!shot.ok) { dropRun(run.tabId); return shot; }

  const blob = await (await fetch(shot.dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    if (!run.canvas) startCanvas(run, bmp);
    pasteFrame(run, bmp, msg);
  } catch (err) {
    dropRun(run.tabId);
    return { ok: false, error: `화면을 이어 붙이지 못했습니다 (${describe(err)})` };
  } finally {
    bmp.close();
  }

  const n = Number(msg.count) || 1;
  const i = Number(msg.index) || 0;
  setBadge(run.tabId, `${Math.min(99, Math.floor((100 * (i + 1)) / n))}%`, '#2f6fed');
  return { ok: true, rows: run.rows };
}

async function fullEnd(msg, sender) {
  const run = runOf(sender, msg.id);
  if (!run) return { ok: false, error: '전체 캡처가 이미 끝났거나 시작되지 않았습니다.' };
  // 목록에서 먼저 빼고(같은 탭의 다음 캡처와 섞이지 않게) 캔버스만 잠시 들고 있는다
  fullRuns.delete(run.tabId);
  clearTimeout(run.timer);
  setBadge(run.tabId, '', null);

  let canvas = run.canvas;
  try {
    if (msg.cancel || !canvas || run.rows <= 0) return { ok: false, cancelled: true };
    // 페이지가 찍는 동안 짧아져 끝까지 채우지 못했으면 채운 데까지만 남긴다
    if (run.rows < canvas.height) {
      const cut = new OffscreenCanvas(canvas.width, run.rows);
      cut.getContext('2d').drawImage(canvas, 0, 0);
      freeCanvas(canvas);
      canvas = cut;
    }
    const size = { w: canvas.width, h: canvas.height };
    const out = await canvas.convertToBlob({ type: 'image/png' });
    freeCanvas(canvas);
    canvas = null;
    const res = await save(await blobToDataUrl(out), run.pageUrl, '-full');
    return { ...res, size, truncated: run.truncated };
  } finally {
    if (canvas) freeCanvas(canvas);
    run.canvas = null;
    run.ctx = null;
  }
}

/* 첫 장으로 배율을 정하고 캔버스를 만든다 */
function startCanvas(run, bmp) {
  run.sx = scaleOf(bmp.width, run.viewport.w, run.dpr);
  run.sy = scaleOf(bmp.height, run.viewport.h, run.dpr);
  const w = Math.max(1, Math.round(run.clip.w * run.sx));
  const h = Math.max(1, Math.min(Math.round(run.total * run.sy), maxRows(w)));
  run.canvas = new OffscreenCanvas(w, h);
  run.ctx = run.canvas.getContext('2d');
}

/* 한 장에서 내용 [from, to) 줄을 캔버스 제자리에 붙이고 그 장의 가리기를 칠한다 */
function pasteFrame(run, bmp, msg) {
  const { sx, sy, clip, canvas, ctx } = run;
  const a = Number(msg.offset);
  const c0 = Number(msg.from);
  const c1 = Number(msg.to);
  if (![a, c0, c1].every(Number.isFinite) || c1 <= c0) return;

  const fy = Math.round((clip.y - a) * sy); // 이 장의 이미지에서 내용 0행이 놓이는 행
  const fx = Math.round(clip.x * sx);
  let top = Math.max(0, Math.round(c0 * sy), Math.round(clip.y * sy) - fy, -fy);
  let bot = Math.min(canvas.height, Math.round(c1 * sy), Math.round((clip.y + clip.h) * sy) - fy, bmp.height - fy);
  if (bot <= top) return;
  const w = Math.min(canvas.width, bmp.width - fx);
  if (w <= 0) return;

  ctx.drawImage(bmp, fx, top + fy, w, bot - top, 0, top, w, bot - top);

  // 가리기: 이 장의 이미지 좌표로 바꾼 뒤(바깥쪽 반올림) 붙인 자리만큼 옮기고, 이번에 붙인 줄 안만 칠한다
  const band = { x: 0, y: top, w: canvas.width, h: bot - top };
  const px = RC.toPixelRects(cleanMasks(msg.masks), sx, sy, bmp.width, bmp.height)
    .map((r) => RC.intersect({ x: r.x - fx, y: r.y - fy, w: r.w, h: r.h }, band))
    .filter(Boolean);
  RC.paintRedactions(ctx, px, { style: 'box' });
  run.rows = Math.max(run.rows, bot);
}

/* 찍기 직전·직후에 그 탭이 아직 활성 탭인지 확인한다 */
async function grabRun(run) {
  const wait = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);
  if (!(await stillActive(run))) return { ok: false, error: FULL_SWITCHED };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(run.windowId, { format: 'png' });
    lastCaptureAt = Date.now();
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
  if (!(await stillActive(run))) return { ok: false, error: FULL_SWITCHED };
  return { ok: true, dataUrl };
}

async function stillActive(run) {
  try {
    const t = await chrome.tabs.get(run.tabId);
    return !!t && t.active && t.windowId === run.windowId;
  } catch (_) {
    return false; // 탭이 닫혔다
  }
}

/* 이미지 너비 w 에서 캔버스가 담을 수 있는 최대 행 수 */
function maxRows(w) {
  return Math.max(1, Math.min(FULL_LIMITS.side, Math.floor(FULL_LIMITS.area / Math.max(1, w))));
}

function runOf(sender, id) {
  const tab = sender && sender.tab;
  const run = tab ? fullRuns.get(tab.id) : null;
  return run && run.id === id ? run : null;
}

function touchRun(run) {
  clearTimeout(run.timer);
  run.timer = setTimeout(() => {
    if (fullRuns.get(run.tabId) === run) dropRun(run.tabId);
  }, FULL_IDLE_MS);
}

function dropRun(tabId) {
  const run = fullRuns.get(tabId);
  if (!run) return;
  fullRuns.delete(tabId);
  clearTimeout(run.timer);
  if (run.canvas) freeCanvas(run.canvas);
  run.canvas = null;
  run.ctx = null;
  setBadge(tabId, '', null);
}

/* 큰 캔버스의 메모리를 GC 를 기다리지 않고 바로 놓는다 */
function freeCanvas(c) {
  try { c.width = 0; c.height = 0; } catch (_) { /* 무시 */ }
}

function setBadge(tabId, text, color) {
  try {
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  } catch (_) {
    /* 탭이 닫혔을 수 있다 */
  }
}

function cleanRect(r) {
  if (!r) return null;
  const x = Number(r.x), y = Number(r.y), w = Number(r.w), h = Number(r.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/* 이미지 픽셀 ÷ CSS px 배율. 고해상도 화면과 페이지 확대가 모두 들어 있다.
   이미지 크기 ÷ 화면 크기로 재면 화면 크기(innerWidth·innerHeight)가 정수로 반올림되어 있어 오차가 생긴다
   (확대 150% 에서 화면 높이 536.67 → 537 이면 0.06%, 4,000px 아래에서는 2~3px).
   페이지가 알려 준 devicePixelRatio 가 그 비율과 2% 안으로 맞으면 그 값을 쓴다. */
function scaleOf(imgLen, cssLen, dpr) {
  const r = imgLen / cssLen;
  const d = Number(dpr);
  return d > 0 && Math.abs(r - d) <= d * 0.02 ? d : r;
}

/* service worker 에는 URL.createObjectURL 이 없어 downloads 에 data URL 로 넘긴다 */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/* ---------------------------------------------------------------- 유틸 */

function makeFilename(url, suffix) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'page';
  } catch (_) {
    /* file:// 등 */
  }
  host = host.replace(/[^a-z0-9.-]+/gi, '-').slice(0, 40);

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

  return `cleanshot/${host}-${stamp}${suffix || ''}.png`;
}

function describe(err) {
  return String((err && err.message) || err || '알 수 없는 오류');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
