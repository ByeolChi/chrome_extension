/* CleanShot Picker — service worker
 * 역할: 피커 주입, 화면 캡처, 전체 페이지 잇기, 저장 설정(형식·크기·파일 이름·주소와 시각 띠)대로 만들어 파일 저장.
 * DOM 은 건드리지 않는다.
 */

/* 공용 가리기 코어(사본은 node scripts/sync-shared.mjs 로 만든다). 피커도 같은 파일을 먼저 싣는다.
   저장 설정(settings.js)은 설정 화면(options.html)과 함께 쓴다. */
importScripts('shared/redact-core.js', 'settings.js');
const RC = globalThis.RedactCore;
const CS = globalThis.CleanShotSettings;

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
     msg.crop(화면 CSS px)이 있으면 가리기를 칠한 뒤 그 부분만 잘라 낸다 (6 영역, 파일 이름 끝에 -area).
     그다음 저장 설정대로 크기를 바꾸고 주소·시각 띠를 붙여 그 형식으로 만든다 (복사는 늘 PNG). */
  CLEANSHOT_CAPTURE: async (msg, sender) => {
    const [out, shot] = await Promise.all([readOutput(), grab(sender)]); // 설정 읽기가 찍기를 늦추지 않게
    if (!shot.ok) return shot;
    const at = new Date();
    const pageUrl = msg.pageUrl || sender.tab.url;
    const masks = cleanMasks(msg.masks);
    const crop = cleanMasks(msg.crop ? [msg.crop] : [])[0] || null;
    const fmt = msg.copy ? 'png' : out.outFormat; // 클립보드는 PNG 만 받는다
    const dpr = Number(msg.dpr) > 0 ? Number(msg.dpr) : 1;

    let made;
    if (!masks.length && !crop && fmt === 'png' && !out.stamp && Math.abs(CS.outFactor(out.outScale, dpr) - dpr) < 0.01) {
      made = { dataUrl: shot.dataUrl, ext: 'png' }; // 손볼 것이 없으면 찍은 PNG 그대로 (가장 빠른 길)
    } else {
      let canvas;
      try {
        canvas = await loadCanvas(shot.dataUrl);
      } catch (err) {
        return { ok: false, error: `찍은 화면을 읽지 못했습니다 (${describe(err)})` };
      }
      try {
        const vw = msg.viewport && msg.viewport.w > 0 ? msg.viewport.w : canvas.width;
        const vh = msg.viewport && msg.viewport.h > 0 ? msg.viewport.h : canvas.height;
        const sx = scaleOf(canvas.width, vw, msg.dpr);
        const sy = scaleOf(canvas.height, vh, msg.dpr);
        // 가리기 박스를 이미지에 직접 칠한다. 화면의 박스가 다른 요소 아래에 깔렸어도
        // 저장되는 이미지에는 반드시 남게 하려는 것이다. 칠하지 못하면 저장하지 않는다.
        if (masks.length) {
          try {
            paintMasks(canvas, masks, sx, sy);
          } catch (err) {
            return { ok: false, error: `가리기 박스를 이미지에 넣지 못해 ${msg.copy ? '복사' : '저장'}하지 않았습니다 (${describe(err)})` };
          }
        }
        if (crop) {
          try {
            const cut = cropCanvas(canvas, crop, sx, sy);
            freeCanvas(canvas);
            canvas = cut;
          } catch (err) {
            return { ok: false, error: `고른 영역을 잘라 내지 못했습니다 (${describe(err)})` };
          }
        }
        try {
          made = await finishImage(canvas, sx, sy, out, fmt, { url: pageUrl, at });
        } catch (err) {
          return { ok: false, error: `저장할 그림을 만들지 못했습니다 (${describe(err)})` };
        }
      } finally {
        freeCanvas(canvas);
      }
    }
    if (msg.copy) return { ok: true, dataUrl: made.dataUrl, note: made.note || '' };
    const filename = CS.fileName(out.nameTemplate, { url: pageUrl, title: msg.pageTitle, at, suffix: crop ? '-area' : '', ext: made.ext });
    const res = await save(made.dataUrl, filename, out.askWhere);
    return made.note ? { ...res, note: made.note } : res;
  },

  /* 전체 페이지 캡처 — 아래 "전체 페이지" 참고 */
  CLEANSHOT_FULL_BEGIN: (msg, sender) => fullBegin(msg, sender),
  CLEANSHOT_FULL_FRAME: (msg, sender) => fullFrame(msg, sender),
  CLEANSHOT_FULL_END: (msg, sender) => fullEnd(msg, sender),

  /* 툴바의 "설정" — 콘텐츠 스크립트는 설정 화면을 직접 열 수 없다 */
  CLEANSHOT_OPEN_OPTIONS: async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
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

/* 파일로 저장한다. 1순위는 downloads API, 실패하면 content script 가 <a download> 로 대신 받는다(fallback).
   askWhere 면 저장 위치 창을 띄운다. download() 는 창이 뜨기 전에 바로 돌아오므로(Chromium 131 에서 확인)
   사용자가 위치를 고를 때까지 기다린다. 창을 닫으면 저장하지 않았다고 알린다(declined) — 이때는 대신 받지 않는다. */
async function save(dataUrl, filename, askWhere) {
  if (!dataUrl) return { ok: false, error: '저장할 이미지가 없습니다.' };
  let id;
  try {
    id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: !!askWhere });
  } catch (err) {
    console.warn('[CleanShot] downloads 실패, 폴백 사용:', err);
    return { ok: false, fallback: true, filename, dataUrl, error: describe(err) };
  }
  if (!askWhere) return { ok: true, filename };
  const d = await downloadDecision(id);
  if (d.declined) return { ok: false, declined: true, error: '저장 위치 창을 닫아 저장하지 않았습니다.' };
  if (d.error) return { ok: false, error: d.error };
  return { ok: true, filename: d.filename || filename, pending: !!d.pending };
}

/* 저장 위치 창의 결과. 파일 위치가 정해지면 { filename }, 창을 닫으면 { declined }, 다른 이유로 멈추면 { error }.
   오래(10분) 열려 있으면 기다리지 않는다 { pending } — 그 뒤에 고르면 그대로 저장된다. */
const DECISION_WAIT_MS = 10 * 60 * 1000;
function downloadDecision(id, timeoutMs = DECISION_WAIT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(r);
    };
    const judge = (item) => {
      if (!item || done) return;
      if (item.error === 'USER_CANCELED') finish({ declined: true });
      else if (item.state === 'interrupted' || item.error) finish({ error: downloadError(item.error) });
      else if (item.filename) finish({ filename: item.filename });
    };
    const look = () => chrome.downloads.search({ id }).then((items) => judge(items[0])).catch(() => {});
    const onChanged = (delta) => { if (delta.id === id) look(); };
    const timer = setTimeout(() => finish({ pending: true }), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    look(); // 리스너를 걸기 전에 이미 정해졌을 수 있다
  });
}

function downloadError(code) {
  const known = {
    FILE_ACCESS_DENIED: '그 폴더에 저장할 권한이 없습니다',
    FILE_NO_SPACE: '디스크 공간이 부족합니다',
    FILE_NAME_TOO_LONG: '파일 이름이나 경로가 너무 깁니다',
    FILE_TOO_LARGE: '파일이 너무 큽니다',
    FILE_BLOCKED: '이 PC 의 정책이 파일 저장을 막았습니다'
  };
  return `저장하지 못했습니다 (${known[code] || code || '알 수 없는 이유'})`;
}

/* 저장 설정. 읽지 못하면 기본값 */
async function readOutput() {
  try {
    return CS.normalize(await chrome.storage.sync.get(CS.DEFAULTS));
  } catch (_) {
    return CS.normalize(null);
  }
}

/* 피커가 보낸 사각형(화면 CSS px) 중 숫자가 온전한 것만 받는다 */
function cleanMasks(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 2000).filter((m) =>
    m && [m.x, m.y, m.w, m.h].every(Number.isFinite) && m.w > 0 && m.h > 0
  );
}

/* 찍은 PNG 를 캔버스로. 색 공간·알파를 바꾸지 않아 픽셀 값이 그대로다 */
async function loadCanvas(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return canvas;
  } finally {
    bmp.close();
  }
}

/* 검정 사각형(화면 CSS px)을 칠한다. 경계는 바깥쪽으로 반올림해 반 픽셀도 덜 가리지 않는다 */
function paintMasks(canvas, masks, sx, sy) {
  const px = RC.toPixelRects(masks, sx, sy, canvas.width, canvas.height);
  RC.paintRedactions(canvas.getContext('2d'), px, { style: 'box' });
}

/* crop(화면 CSS px) 부분만 잘라 새 캔버스로. 경계는 바깥쪽으로 반올림하고 이미지 안으로 자른다 */
function cropCanvas(canvas, crop, sx, sy) {
  const x0 = Math.max(0, Math.floor(crop.x * sx));
  const y0 = Math.max(0, Math.floor(crop.y * sy));
  const x1 = Math.min(canvas.width, Math.ceil((crop.x + crop.w) * sx));
  const y1 = Math.min(canvas.height, Math.ceil((crop.y + crop.h) * sy));
  if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('영역이 화면 밖입니다');
  const cut = new OffscreenCanvas(x1 - x0, y1 - y0);
  cut.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return cut;
}

/* ---------------------------------------------------------------- 저장할 그림 만들기
 * 가리기를 칠하고 잘라 낸 캔버스(배율 sx·sy = 이미지 픽셀 ÷ CSS px)를 저장 설정대로 마무리한다.
 *   크기   — 화면 그대로 / CSS 픽셀의 1배 / 2배. 한도(한 변 32,767px, 넓이 2^26px)를 넘으면 들어가게 줄이고 알린다.
 *   띠     — 그림 아래에 주소(? 뒤·# 뒤 뺌)와 찍은 시각. 그림을 가리지 않게 밑에 덧붙인다.
 *   형식   — PNG·JPEG·WebP (품질 0.92). 브라우저가 그 형식을 못 만들면 PNG 로 만들고 알린다.
 * 넘겨받은 canvas 는 건드리지 않는다(부르는 쪽이 놓는다).
 */
const STAMP_CSS_H = 26;   // 띠 높이(CSS px). 출력 배율만큼 커진다
const STAMP_FONT = '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

async function finishImage(canvas, sx, sy, out, fmt, info) {
  const notes = [];
  // 크기: want 는 바라는 출력 배율. 한도를 넘으면 fit 만큼 줄인다 (띠는 한 변 한도에만 넣는다 — 두 줄일 수도 있어 두 줄로 잡는다)
  const want = CS.outFactor(out.outScale, sx);
  const w0 = Math.max(1, Math.round((canvas.width * want) / sx));
  const h0 = Math.max(1, Math.round((canvas.height * want) / sy));
  const stamp0 = out.stamp ? Math.round(STAMP_CSS_H * want) * 2 : 0;
  const fit = Math.min(1, FULL_LIMITS.side / w0, FULL_LIMITS.side / (h0 + stamp0), Math.sqrt(FULL_LIMITS.area / (w0 * h0)));
  const w = fit < 1 ? Math.max(1, Math.floor(w0 * fit)) : w0;
  const h = fit < 1 ? Math.max(1, Math.floor(h0 * fit)) : h0;
  if (fit < 1) notes.push(`너무 커서 ${(want * fit).toFixed(2).replace(/\.?0+$/, '')}배로 줄여 저장했습니다`);
  const f = want * fit; // 실제 출력 배율
  let img = canvas;
  if (w !== canvas.width || h !== canvas.height) {
    img = new OffscreenCanvas(w, h);
    const ctx = img.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
  }
  try {
    if (out.stamp) {
      const stamped = addStamp(img, f, CS.stampText(info.url, info.at));
      if (img !== canvas) freeCanvas(img);
      img = stamped;
    }
    // 형식
    const spec = CS.FORMATS[fmt] || CS.FORMATS.png;
    let blob = await img.convertToBlob(spec.mime === 'image/png' ? { type: spec.mime } : { type: spec.mime, quality: CS.QUALITY });
    let ext = spec.ext;
    if (blob.type !== spec.mime) {
      blob = await img.convertToBlob({ type: 'image/png' });
      ext = 'png';
      notes.push(`${fmt.toUpperCase()} 로 만들 수 없어 PNG 로 저장했습니다`);
    }
    return { dataUrl: await blobToDataUrl(blob), ext, w: img.width, h: img.height, note: notes.join(' · ') };
  } finally {
    if (img !== canvas) freeCanvas(img);
  }
}

/* 그림 아래에 주소와 시각을 적은 띠를 붙인 새 캔버스. f 는 출력 배율(글자 크기·여백에 곱한다).
   그림이 좁아 한 줄에 다 들어가지 않으면 두 줄로 쓴다. */
function addStamp(canvas, f, text) {
  const lineH = STAMP_CSS_H * f;
  const pad = Math.round(10 * f);
  const font = `500 ${Math.max(9, Math.round(12 * f))}px ${STAMP_FONT}`;
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.font = font;
  const whenW = probe.measureText(text.when).width;
  const urlW = probe.measureText(text.url).width;
  const oneLine = pad * 3 + whenW + Math.min(urlW, 160 * f) <= canvas.width;
  const h = Math.round(lineH * (oneLine ? 1 : 2));
  const out = new OffscreenCanvas(canvas.width, canvas.height + h);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = '#1c1c1f';
  ctx.fillRect(0, canvas.height, out.width, h);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f2f2f3';
  if (oneLine) {
    const y = canvas.height + h / 2;
    ctx.textAlign = 'right';
    ctx.fillText(text.when, out.width - pad, y);
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, text.url, out.width - pad * 3 - whenW), pad, y);
  } else {
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, text.url, out.width - pad * 2), pad, canvas.height + lineH / 2);
    ctx.fillText(ellipsize(ctx, text.when, out.width - pad * 2), pad, canvas.height + lineH * 1.5);
  }
  return out;
}

/* 너비 안에 들어가게 뒤를 줄이고 … 를 붙인다 */
function ellipsize(ctx, s, width) {
  if (ctx.measureText(s).width <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + '…').width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + '…' : '';
}

/* ---------------------------------------------------------------- 전체 페이지
 * 피커가 스크롤 대상을 위에서부터 한 화면씩 내리며 장마다 CLEANSHOT_FULL_FRAME 을 보낸다.
 * 여기서는 그 화면을 찍어 스크롤 대상의 보이는 부분(clip)에서 아직 채우지 않은 줄만 큰 캔버스의
 * 제자리(내용 좌표)에 붙이고, 그 장에서 잰 가리기 박스를 같은 줄 범위 안에 칠한다.
 * CLEANSHOT_FULL_END 에서 저장 설정(시작할 때 읽어 둔 것)대로 크기·띠·형식을 마무리해 저장한다.
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
  const out = await readOutput(); // 찍는 도중에 설정을 바꿔도 이번 캡처는 시작할 때의 설정으로
  const limit = Math.max(1, Math.floor(maxRows(Math.round(clip.w * dpr)) / dpr)); // 내용 CSS px
  const run = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    pageUrl: msg.pageUrl || tab.url,
    pageTitle: msg.pageTitle || tab.title || '',
    at: new Date(),
    out,
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
    if (msg.cancel) return { ok: false, cancelled: true };
    if (!canvas || run.rows <= 0) return { ok: false, error: '찍은 화면이 없습니다.' };
    // 페이지가 찍는 동안 짧아져 끝까지 채우지 못했으면 채운 데까지만 남긴다
    if (run.rows < canvas.height) {
      const cut = new OffscreenCanvas(canvas.width, run.rows);
      cut.getContext('2d').drawImage(canvas, 0, 0);
      freeCanvas(canvas);
      canvas = cut;
    }
    // 저장 설정대로 크기·띠·형식 (이어 붙인 캔버스의 배율은 첫 장으로 정한 sx·sy)
    let made;
    try {
      made = await finishImage(canvas, run.sx, run.sy, run.out, run.out.outFormat, { url: run.pageUrl, at: run.at });
    } catch (err) {
      return { ok: false, error: `저장할 그림을 만들지 못했습니다 (${describe(err)})` };
    }
    freeCanvas(canvas);
    canvas = null;
    const filename = CS.fileName(run.out.nameTemplate, { url: run.pageUrl, title: run.pageTitle, at: run.at, suffix: '-full', ext: made.ext });
    const res = await save(made.dataUrl, filename, run.out.askWhere);
    return { ...res, size: { w: made.w, h: made.h }, truncated: run.truncated, note: made.note || '' };
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

function describe(err) {
  return String((err && err.message) || err || '알 수 없는 오류');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
