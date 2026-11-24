/* CleanShot Picker — service worker
 * 역할: 피커 주입, 화면 캡처, 파일 저장. DOM 은 건드리지 않는다.
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

  /* 현재 화면을 찍어 바로 저장한다 */
  CLEANSHOT_CAPTURE: async (msg, sender) => {
    const shot = await grab(sender);
    if (!shot.ok) return shot;

    // 가리기 박스를 PNG 에 직접 칠한다. 화면의 박스가 다른 요소 아래에 깔렸어도
    // 저장되는 이미지에는 반드시 남게 하려는 것이다. 칠하지 못하면 저장하지 않는다.
    let dataUrl = shot.dataUrl;
    const masks = cleanMasks(msg.masks);
    if (masks.length) {
      try {
        dataUrl = await burnMasks(dataUrl, masks, msg.viewport);
      } catch (err) {
        return { ok: false, error: `가리기 박스를 이미지에 넣지 못해 저장하지 않았습니다 (${describe(err)})` };
      }
    }
    return save(dataUrl, msg.pageUrl || sender.tab.url);
  }
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

async function save(dataUrl, pageUrl) {
  if (!dataUrl) return { ok: false, error: '저장할 이미지가 없습니다.' };
  const filename = makeFilename(pageUrl);

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
   배율은 이미지 크기 ÷ 화면 크기로 잰다. 고해상도 화면과 페이지 확대가 모두 여기에 들어 있다.
   경계는 바깥쪽으로 반올림해 반 픽셀도 덜 가리지 않는다. */
async function burnMasks(dataUrl, masks, viewport) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const vw = viewport && viewport.w > 0 ? viewport.w : bmp.width;
    const vh = viewport && viewport.h > 0 ? viewport.h : bmp.height;

    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = RC.toPixelRects(masks, bmp.width / vw, bmp.height / vh, bmp.width, bmp.height);
    RC.paintRedactions(ctx, px, { style: 'box' });
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(out);
  } finally {
    bmp.close();
  }
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

function makeFilename(url) {
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

  return `cleanshot/${host}-${stamp}.png`;
}

function describe(err) {
  return String((err && err.message) || err || '알 수 없는 오류');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
