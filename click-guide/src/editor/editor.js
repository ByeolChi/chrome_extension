import * as db from '../common/db.js';
import { getSettings } from '../common/settings.js';
import { describeStep, suggestGuideTitle } from '../common/describe.js';
import { enhanceSteps } from '../common/ai.js';
import { bakeStepImage, buildGuideHtml, buildMarkdown, dataUrlToUint8 } from '../common/render.js';
import { createZip } from '../lib/zip.js';
import { downloadBlob, slugify, formatDate, bytes, blobToDataURL } from '../common/util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  settings: null,
  sessions: [],
  session: null,
  steps: [],
  urls: new Map(),      // stepId -> objectURL
  redactingId: null,
  saveTimers: new Map()
};

/* ------------------------------------------------------------------ */
/* 유틸                                                                 */
/* ------------------------------------------------------------------ */

function toast(msg, isError = false, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => { el.hidden = true; }, ms);
  return el;
}

function debounceSave(key, fn, ms = 500) {
  clearTimeout(S.saveTimers.get(key));
  S.saveTimers.set(key, setTimeout(fn, ms));
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(400, ta.scrollHeight + 2) + 'px';
}

function revokeUrls() {
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear();
}

/* ------------------------------------------------------------------ */
/* 로딩 / 렌더                                                          */
/* ------------------------------------------------------------------ */

async function boot() {
  S.settings = await getSettings();
  document.documentElement.style.setProperty('--hl', S.settings.highlightColor || '#ff3b30');
  S.sessions = await db.listSessions();

  const wanted = new URLSearchParams(location.search).get('session');
  const target = S.sessions.find((s) => s.id === wanted) || S.sessions[0] || null;

  renderSessionSelect(target);
  if (!target) { $('#empty').hidden = false; $('#doc').hidden = true; return; }
  await openSession(target.id);
}

function renderSessionSelect(active) {
  const sel = $('#session-select');
  sel.innerHTML = '';
  for (const s of S.sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name || '제목 없는 가이드'} (${s.stepCount || 0}단계)`;
    if (active && s.id === active.id) o.selected = true;
    sel.append(o);
  }
  sel.hidden = S.sessions.length === 0;
}

async function openSession(id) {
  revokeUrls();
  S.session = await db.getSession(id);
  S.steps = await db.getSteps(id);
  if (!S.session) { $('#empty').hidden = false; $('#doc').hidden = true; return; }

  $('#empty').hidden = true;
  $('#doc').hidden = false;
  $('#guide-title').value = S.session.name || suggestGuideTitle(S.steps, S.settings.lang);
  $('#guide-desc').value = S.session.description || '';
  autoGrow($('#guide-desc'));
  history.replaceState(null, '', `?session=${id}`);
  await renderSteps();
  updateStats();
}

async function renderSteps() {
  const list = $('#steps');
  list.innerHTML = '';
  const tpl = $('#step-tpl');
  for (const step of S.steps) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = step.id;
    node.classList.toggle('is-note', step.type === 'note');
    $('.s-title', node).value = step.title || '';
    const desc = $('.s-desc', node);
    desc.value = step.description || '';
    $('.t-hl', node).classList.toggle('active', step.highlight !== false);
    $('.t-hl', node).hidden = !step.nrect;
    $('.t-redact', node).hidden = !step.shotId;

    const meta = [];
    if (step.url) meta.push(step.url);
    $('.s-meta', node).textContent = meta.join(' · ');
    if (!step.shotId && step.type !== 'note') {
      const warn = document.createElement('span');
      warn.className = 'stale-chip noshot';
      warn.textContent = step.shotError
        ? `화면을 찍지 못했습니다 — ${step.shotError}`
        : '이 단계는 화면이 저장되지 않았습니다';
      $('.s-meta', node).before(warn);
    }
    if ((step.lateMs || 0) > 1200) {
      const warn = document.createElement('span');
      warn.className = 'stale-chip';
      warn.textContent = `촬영이 ${(step.lateMs / 1000).toFixed(1)}초 늦어 클릭 시점과 화면이 다를 수 있습니다`;
      warn.title = '빠르게 연속 클릭하면 브라우저의 캡처 제한(초당 2회) 때문에 촬영이 밀립니다.';
      $('.s-meta', node).before(warn);
    }

    if (step.shotId) {
      const blob = await db.getShot(step.shotId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        S.urls.set(step.id, url);
        const shot = $('.shot', node);
        shot.hidden = false;
        $('img', shot).src = url;
        $('img', shot).alt = step.title || '';
        drawOverlay(node, step);
      }
    }
    list.append(node);
    autoGrow(desc);
  }
}

function drawOverlay(node, step) {
  const ov = $('.overlay', node);
  if (!ov) return;
  ov.innerHTML = '';
  const pct = (n) => (n * 100) + '%';

  if (step.nrect && step.highlight !== false && S.settings.highlight) {
    if (S.settings.dimOutside) {
      const hole = document.createElement('div');
      hole.className = 'dim-hole';
      Object.assign(hole.style, { left: pct(step.nrect.x), top: pct(step.nrect.y), width: pct(step.nrect.w), height: pct(step.nrect.h) });
      ov.append(hole);
    }
    const box = document.createElement('div');
    box.className = 'hl-box';
    Object.assign(box.style, { left: pct(step.nrect.x), top: pct(step.nrect.y), width: pct(step.nrect.w), height: pct(step.nrect.h) });
    ov.append(box);
  }

  (step.redactions || []).forEach((r, i) => {
    const b = document.createElement('div');
    b.className = 'rd-box';
    Object.assign(b.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = '가림 해제';
    x.dataset.redactIndex = String(i);
    b.append(x);
    ov.append(b);
  });
}

function updateStats() {
  const n = S.steps.length;
  const withShot = S.steps.filter((s) => s.shotId).length;
  $('#stats').textContent = `${n}단계 · 스크린샷 ${withShot}장 · 녹화 ${formatDate(S.session.createdAt)}`;
}

/* ------------------------------------------------------------------ */
/* 단계 편집                                                            */
/* ------------------------------------------------------------------ */

function stepOf(el) {
  const li = el.closest('li.step');
  if (!li) return null;
  return S.steps.find((s) => s.id === li.dataset.id) || null;
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'guide-title') {
    const v = t.value;
    debounceSave('title', async () => {
      await db.updateSession(S.session.id, { name: v });
      S.session.name = v;
      const opt = $(`#session-select option[value="${S.session.id}"]`);
      if (opt) opt.textContent = `${v || '제목 없는 가이드'} (${S.steps.length}단계)`;
    });
    return;
  }
  if (t.id === 'guide-desc') {
    autoGrow(t);
    const v = t.value;
    debounceSave('desc', async () => { await db.updateSession(S.session.id, { description: v }); S.session.description = v; });
    return;
  }
  if (t.classList.contains('s-title') || t.classList.contains('s-desc')) {
    if (t.classList.contains('s-desc')) autoGrow(t);
    const step = stepOf(t);
    if (!step) return;
    if (t.classList.contains('s-title')) step.title = t.value; else step.description = t.value;
    step.edited = true;
    debounceSave('step-' + step.id, () => db.putStep(step));
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  // 가림 박스 삭제
  if (btn.dataset.redactIndex !== undefined) {
    const step = stepOf(btn);
    if (!step) return;
    step.redactions.splice(Number(btn.dataset.redactIndex), 1);
    await db.putStep(step);
    drawOverlay(btn.closest('li.step'), step);
    return;
  }

  const li = btn.closest('li.step');
  const step = li ? stepOf(btn) : null;

  if (btn.classList.contains('t-up') || btn.classList.contains('t-down')) {
    const i = S.steps.indexOf(step);
    const j = btn.classList.contains('t-up') ? i - 1 : i + 1;
    if (j < 0 || j >= S.steps.length) return;
    S.steps.splice(j, 0, S.steps.splice(i, 1)[0]);
    S.steps.forEach((s, k) => { s.index = k; });
    await db.putSteps(S.steps);
    await renderSteps();
    return;
  }

  if (btn.classList.contains('t-hl')) {
    step.highlight = step.highlight === false;
    await db.putStep(step);
    btn.classList.toggle('active', step.highlight !== false);
    drawOverlay(li, step);
    return;
  }

  if (btn.classList.contains('t-redact')) {
    const on = S.redactingId !== step.id;
    setRedactMode(on ? step.id : null);
    return;
  }

  if (btn.classList.contains('t-reset')) {
    const d = describeStep(step, S.settings.lang);
    step.title = d.title; step.description = d.description; step.edited = false;
    await db.putStep(step);
    $('.s-title', li).value = step.title;
    $('.s-desc', li).value = step.description;
    autoGrow($('.s-desc', li));
    toast('자동 생성 문장으로 되돌렸습니다.');
    return;
  }

  if (btn.classList.contains('t-del')) {
    if (!confirm('이 단계를 삭제할까요?')) return;
    await db.deleteStep(step);
    S.steps = S.steps.filter((s) => s.id !== step.id);
    S.steps.forEach((s, k) => { s.index = k; });
    await db.putSteps(S.steps);
    await db.updateSession(S.session.id, { stepCount: S.steps.length });
    await renderSteps();
    updateStats();
    return;
  }
});

function setRedactMode(stepId) {
  S.redactingId = stepId;
  $$('li.step').forEach((li) => {
    const on = li.dataset.id === stepId;
    const shot = $('.shot', li);
    if (shot) {
      shot.classList.toggle('redacting', on);
      const hint = $('.redact-hint', shot);
      if (hint) hint.hidden = !on;
    }
    $('.t-redact', li).classList.toggle('active', on);
  });
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.redactingId) setRedactMode(null); });

/* 드래그로 가릴 영역 지정 */
let draft = null;
document.addEventListener('pointerdown', (e) => {
  const shot = e.target.closest('.shot.redacting');
  if (!shot) return;
  if (e.target.closest('.rd-box button')) return;
  e.preventDefault();
  const rect = shot.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'rd-draft';
  $('.overlay', shot).append(el);
  draft = { shot, rect, x0: e.clientX - rect.left, y0: e.clientY - rect.top, el };
  shot.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!draft) return;
  const x = Math.max(0, Math.min(draft.rect.width, e.clientX - draft.rect.left));
  const y = Math.max(0, Math.min(draft.rect.height, e.clientY - draft.rect.top));
  const l = Math.min(x, draft.x0), t = Math.min(y, draft.y0);
  Object.assign(draft.el.style, {
    left: l + 'px', top: t + 'px',
    width: Math.abs(x - draft.x0) + 'px', height: Math.abs(y - draft.y0) + 'px'
  });
});
document.addEventListener('pointerup', async (e) => {
  if (!draft) return;
  const d = draft; draft = null;
  const box = d.el.getBoundingClientRect();
  d.el.remove();
  if (box.width < 8 || box.height < 8) return;
  const li = d.shot.closest('li.step');
  const step = S.steps.find((s) => s.id === li.dataset.id);
  if (!step) return;
  step.redactions = step.redactions || [];
  step.redactions.push({
    x: (box.left - d.rect.left) / d.rect.width,
    y: (box.top - d.rect.top) / d.rect.height,
    w: box.width / d.rect.width,
    h: box.height / d.rect.height
  });
  await db.putStep(step);
  drawOverlay(li, step);
});

/* 메모 단계 추가 */
$('#add-note').addEventListener('click', async () => {
  const step = {
    id: db.uid('stp'), sessionId: S.session.id, index: S.steps.length,
    type: 'note', ts: Date.now(), url: '', pageTitle: '', el: null,
    value: '', masked: false, nrect: null, redactions: [], shotId: null,
    highlight: false, edited: true,
    title: '메모', description: ''
  };
  await db.putStep(step);
  S.steps.push(step);
  await db.updateSession(S.session.id, { stepCount: S.steps.length });
  await renderSteps();
  updateStats();
  const last = $$('li.step').pop();
  if (last) $('.s-title', last).focus();
});

/* ------------------------------------------------------------------ */
/* 상단 바                                                              */
/* ------------------------------------------------------------------ */

$('#session-select').addEventListener('change', (e) => openSession(e.target.value));
$('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('#btn-delete').addEventListener('click', async () => {
  if (!S.session) return;
  if (!confirm(`‘${S.session.name || '제목 없는 가이드'}’와 스크린샷을 삭제합니다. 되돌릴 수 없습니다.`)) return;
  await db.deleteSession(S.session.id);
  revokeUrls();
  S.sessions = await db.listSessions();
  renderSessionSelect(S.sessions[0]);
  if (S.sessions[0]) await openSession(S.sessions[0].id);
  else { $('#doc').hidden = true; $('#empty').hidden = false; }
});

const menu = $('#export-menu');
$('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) menu.hidden = true; });
menu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (!b) return;
  menu.hidden = true;
  doExport(b.dataset.export).catch((err) => toast('내보내기 실패: ' + err.message, true, 5000));
});

/* ------------------------------------------------------------------ */
/* AI 다듬기                                                            */
/* ------------------------------------------------------------------ */

$('#btn-ai').addEventListener('click', async () => {
  S.settings = await getSettings();
  if (!S.settings.ai || S.settings.ai.provider === 'none') {
    toast('설정에서 AI 제공자와 API 키를 먼저 등록해 주세요.', true, 4000);
    chrome.runtime.openOptionsPage();
    return;
  }
  const btn = $('#btn-ai');
  btn.disabled = true;
  const t = toast('AI에게 보내는 중… 0 / ' + S.steps.length, false, 0);
  try {
    const enhanced = await enhanceSteps(S.steps, S.settings, {
      onProgress: (done, total) => { t.textContent = `AI에게 보내는 중… ${done} / ${total}`; },
      getShotDataUrl: async (step) => {
        const blob = await db.getShot(step.shotId);
        return blob ? blobToDataURL(blob) : null;
      }
    });
    S.steps = enhanced;
    await db.putSteps(S.steps);
    await renderSteps();
    toast('문장을 다듬었습니다. 마음에 들지 않으면 각 단계의 ‘문장 복원’으로 되돌릴 수 있습니다.', false, 4500);
  } catch (err) {
    toast('AI 요청 실패: ' + err.message, true, 6000);
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* 내보내기                                                             */
/* ------------------------------------------------------------------ */

async function bakeAll(onProgress) {
  const map = new Map();
  let i = 0;
  for (const step of S.steps) {
    i++;
    if (onProgress) onProgress(i, S.steps.length);
    if (!step.shotId) continue;
    const blob = await db.getShot(step.shotId);
    if (!blob) continue;
    const baked = await bakeStepImage(blob, step, S.settings);
    if (baked) map.set(step.id, baked.dataUrl);
  }
  return map;
}

function baseName() {
  return `${slugify(S.session.name || 'guide')}-${formatDate(S.session.createdAt)}`;
}

async function doExport(kind) {
  if (!S.session) return;
  const t = toast('이미지 준비 중… 0 / ' + S.steps.length, false, 0);
  const images = await bakeAll((d, n) => { t.textContent = `이미지 준비 중… ${d} / ${n}`; });

  if (kind === 'html') {
    const html = buildGuideHtml(S.session, S.steps, images, { showUrls: false });
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName()}.html`);
    toast(`HTML로 저장했습니다 (${bytes(new Blob([html]).size)}).`);
    return;
  }

  if (kind === 'pdf') {
    const html = buildGuideHtml(S.session, S.steps, images, { showUrls: false });
    t.textContent = '인쇄 창을 준비하는 중…';
    await printHtml(html);
    toast('인쇄 창에서 “대상”을 “PDF로 저장”으로 선택하세요.', false, 5000);
    return;
  }

  if (kind === 'md') {
    const names = new Map();
    const files = [];
    S.steps.forEach((s, i) => {
      if (images.has(s.id)) names.set(s.id, `images/step-${String(i + 1).padStart(2, '0')}.jpg`);
    });
    for (const [id, name] of names) files.push({ name, data: await dataUrlToUint8(images.get(id)) });
    const md = buildMarkdown(S.session, S.steps, names, { showUrls: false });
    files.unshift({ name: 'guide.md', data: new TextEncoder().encode(md) });
    const zip = createZip(files);
    downloadBlob(zip, `${baseName()}.zip`);
    toast(`ZIP으로 저장했습니다 (${bytes(zip.size)}).`);
    return;
  }

  if (kind === 'json') {
    const payload = {
      format: 'clickguide/v1',
      exportedAt: new Date().toISOString(),
      guide: {
        id: S.session.id, name: S.session.name, description: S.session.description,
        createdAt: S.session.createdAt, startUrl: S.session.startUrl, lang: S.session.lang
      },
      steps: S.steps.map((s, i) => ({
        number: i + 1, type: s.type, title: s.title, description: s.description,
        url: s.url, pageTitle: s.pageTitle, element: s.el, value: s.value, masked: s.masked,
        highlightRect: s.nrect, redactions: s.redactions, image: images.get(s.id) || null
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${baseName()}.json`);
    toast(`JSON으로 저장했습니다 (${bytes(blob.size)}).`);
  }
}

function printHtml(html) {
  return new Promise((resolve) => {
    const old = document.getElementById('print-frame');
    if (old) old.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'print-frame';
    document.body.append(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    const go = () => {
      setTimeout(() => {
        try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (_) { /* noop */ }
        resolve();
      }, 300);
    };
    if (doc.readyState === 'complete') go();
    else iframe.addEventListener('load', go, { once: true });
  });
}

window.addEventListener('beforeunload', revokeUrls);
boot().catch((e) => toast('불러오기 실패: ' + e.message, true, 6000));
