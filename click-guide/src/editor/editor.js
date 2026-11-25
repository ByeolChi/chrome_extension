import * as db from '../common/db.js';
import { getSettings } from '../common/settings.js';
import { describeStep, suggestGuideTitle } from '../common/describe.js';
import { enhanceSteps } from '../common/ai.js';
import { bakeStepImage, buildGuideHtml, buildMarkdown, buildJsonExport, dataUrlToUint8 } from '../common/render.js';
import { PALETTE, normalizeAnnotations, normalizeCrop } from '../common/annotate.js';
import { mergedDescription } from '../common/steps.js';
import { createZip } from '../lib/zip.js';
import { downloadBlob, slugify, formatDate, bytes } from '../common/util.js';
import { StepCanvas, TOOLS, applyVisual } from './step-canvas.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

const S = {
  settings: null,
  sessions: [],
  session: null,
  steps: [],
  canvases: new Map(),  // stepId -> StepCanvas
  drawingId: null,      // 그리기 중인 단계
  dragId: null,         // 끌어서 옮기는 단계
  saveTimers: new Map()
};

/* ------------------------------------------------------------------ */
/* 유틸                                                                 */
/* ------------------------------------------------------------------ */

// action: { label, fn } — 알림 오른쪽에 버튼 (예: 되돌리기)
function toast(msg, isError = false, ms = 2600, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.hidden = true; action.fn(); });
    el.append(b);
  }
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => { el.hidden = true; }, ms);
  return el;
}

/* 입력이 멈추면 저장한다. 다른 가이드로 바꾸기 전에는 flushSaves() 로 미뤄 둔 저장을 바로 끝낸다. */
function debounceSave(key, fn, ms = 500) {
  const prev = S.saveTimers.get(key);
  if (prev) clearTimeout(prev.timer);
  const entry = { fn, timer: setTimeout(() => { S.saveTimers.delete(key); fn(); }, ms) };
  S.saveTimers.set(key, entry);
}

async function flushSaves() {
  const pending = [...S.saveTimers.values()];
  S.saveTimers.clear();
  for (const p of pending) {
    clearTimeout(p.timer);
    try { await p.fn(); } catch (e) { console.warn('[ClickGuide] 저장 실패', e); }
  }
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(400, ta.scrollHeight + 2) + 'px';
}

function dropCanvases() {
  for (const c of S.canvases.values()) c.destroy();
  S.canvases.clear();
}

/* ------------------------------------------------------------------ */
/* 되돌리기                                                             */
/* 그림 고치기, 단계 지우기·옮기기·합치기·나누기, 메모 넣기, 문장 복원을 되돌린다.          */
/* 제목·설명 글자는 입력칸 자체의 되돌리기(Ctrl+Z)를 쓴다. 가이드를 바꾸면 목록을 비운다.      */
/* ------------------------------------------------------------------ */

const H = { done: [], undone: [], busy: false };

function record(entry) {
  H.done.push(entry);
  if (H.done.length > 100) H.done.shift();
  H.undone.length = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const u = $('#btn-undo');
  const r = $('#btn-redo');
  u.disabled = !H.done.length || H.busy;
  r.disabled = !H.undone.length || H.busy;
  u.title = H.done.length ? `되돌리기: ${H.done[H.done.length - 1].label} (Ctrl+Z)` : '되돌리기 (Ctrl+Z)';
  r.title = H.undone.length ? `다시 하기: ${H.undone[H.undone.length - 1].label} (Ctrl+Shift+Z)` : '다시 하기 (Ctrl+Shift+Z)';
}

async function undo() {
  if (H.busy || !H.done.length) return;
  const e = H.done.pop();
  H.busy = true;
  try {
    await e.undo();
    H.undone.push(e);
    toast(`되돌렸습니다: ${e.label}`, false, 1800);
  } catch (err) {
    toast('되돌리지 못했습니다: ' + err.message, true, 4000);
  } finally {
    H.busy = false;
    updateHistoryButtons();
  }
}

async function redo() {
  if (H.busy || !H.undone.length) return;
  const e = H.undone.pop();
  H.busy = true;
  try {
    await e.redo();
    H.done.push(e);
    toast(`다시 했습니다: ${e.label}`, false, 1800);
  } catch (err) {
    toast('다시 하지 못했습니다: ' + err.message, true, 4000);
  } finally {
    H.busy = false;
    updateHistoryButtons();
  }
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
  await flushSaves();   // 바꾸기 직전에 고친 제목·설명이 다른 가이드에 저장되지 않도록 먼저 저장한다
  dropCanvases();
  H.done.length = 0;
  H.undone.length = 0;
  updateHistoryButtons();
  S.drawingId = null;
  S.session = await db.getSession(id);
  S.steps = await db.getSteps(id);
  if (!S.session) { $('#empty').hidden = false; $('#doc').hidden = true; return; }
  for (const s of S.steps) {
    s.annotations = normalizeAnnotations(s.annotations);
    s.crop = normalizeCrop(s.crop);
  }

  $('#empty').hidden = true;
  $('#doc').hidden = false;
  $('#guide-title').value = S.session.name || suggestGuideTitle(S.steps, S.settings.lang);
  $('#guide-desc').value = S.session.description || '';
  autoGrow($('#guide-desc'));
  history.replaceState(null, '', `?session=${id}`);
  await renderSteps();
  updateStats();
  // 녹화를 끝낼 때 입력란 클릭과 입력을 합쳤다면 처음 열 때 한 번 알린다
  if (S.session.mergedFieldClicks && !S.session.mergeNoticeShown) {
    toast(`입력란 클릭과 입력으로 나뉘어 있던 단계 ${S.session.mergedFieldClicks}개를 입력 단계에 합쳤습니다.`, false, 5000);
    await db.updateSession(id, { mergeNoticeShown: true });
    S.session.mergeNoticeShown = true;
  }
}

async function renderSteps() {
  dropCanvases();
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
    $('.t-draw', node).hidden = !step.shotId;

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
    list.append(node);
    autoGrow(desc);

    if (step.shotId) {
      const blob = await db.getShot(step.shotId);
      if (blob) {
        const shot = $('.shot', node);
        shot.hidden = false;
        const sc = new StepCanvas(shot, step, {
          settings: S.settings,
          onCommit: (before, after, label) => commitVisual(step.id, before, after, label),
          onSelect: () => updateDrawBar(node, sc)
        });
        S.canvases.set(step.id, sc);
        await sc.load(blob);
      }
    }
  }
  if (S.drawingId) setDrawing(S.drawingId);
}

function updateStats() {
  const n = S.steps.length;
  const withShot = S.steps.filter((s) => s.shotId).length;
  $('#stats').textContent = `${n}단계 · 스크린샷 ${withShot}장 · 녹화 ${formatDate(S.session.createdAt)}`;
}

/* ------------------------------------------------------------------ */
/* 그리기 (주석·가림·하이라이트·자르기)                                    */
/* ------------------------------------------------------------------ */

// 그림이 바뀌면 저장하고 되돌리기 목록에 넣는다
async function commitVisual(stepId, before, after, label) {
  const step = S.steps.find((s) => s.id === stepId);
  if (!step) return;
  await db.putStep(step);
  const li = document.querySelector(`li.step[data-id="${CSS.escape(stepId)}"]`);
  if (li) $('.t-hl', li).classList.toggle('active', step.highlight !== false);
  const apply = async (v) => {
    const s = S.steps.find((x) => x.id === stepId);
    if (!s) return;
    applyVisual(s, v);
    await db.putStep(s);
    const sc = S.canvases.get(stepId);
    if (sc) {
      sc.sel = null;
      sc.render();
      const node = document.querySelector(`li.step[data-id="${CSS.escape(stepId)}"]`);
      if (node) {
        updateDrawBar(node, sc);
        $('.t-hl', node).classList.toggle('active', s.highlight !== false);
      }
    }
  };
  record({ label, undo: () => apply(before), redo: () => apply(after) });
}

function buildDrawBar(node, sc) {
  const bar = $('.draw-bar', node);
  const tools = $('.draw-tools', bar);
  if (!tools.childElementCount) {
    for (const [id, label] of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sm ghost';
      b.dataset.tool = id;
      b.textContent = label;
      tools.append(b);
    }
    const colors = $('.draw-colors', bar);
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.color = c;
      b.title = c;
      b.setAttribute('aria-label', '색 ' + c);
      b.style.background = c;
      colors.append(b);
    }
  }
  updateDrawBar(node, sc);
}

function updateDrawBar(node, sc) {
  const bar = $('.draw-bar', node);
  if (!bar || !sc) return;
  $$('[data-tool]', bar).forEach((b) => b.classList.toggle('active', b.dataset.tool === sc.tool));
  $$('[data-color]', bar).forEach((b) => b.classList.toggle('active', b.dataset.color === sc.color));
  $('.d-del', bar).disabled = !sc.sel;
  $('.d-uncrop', bar).disabled = !normalizeCrop(sc.step.crop); // 숨기지 않는다: 막대 높이가 바뀌면 그림이 밀린다
}

// 한 번에 한 단계만 그린다
function setDrawing(stepId) {
  S.drawingId = stepId;
  for (const li of $$('li.step')) {
    const on = li.dataset.id === stepId;
    const sc = S.canvases.get(li.dataset.id);
    $('.t-draw', li).classList.toggle('active', on);
    $('.draw-bar', li).hidden = !on;
    if (sc && sc.editing !== on) sc.setEditing(on);
    if (on && sc) {
      buildDrawBar(li, sc);
      sc.canvas.focus({ preventScroll: true });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 단계 다루기 (지우기·옮기기·메모·합치기·나누기)                           */
/* ------------------------------------------------------------------ */

function stepOf(el) {
  const li = el.closest('li.step');
  if (!li) return null;
  return S.steps.find((s) => s.id === li.dataset.id) || null;
}

// 지금 순서대로 index 를 매기고 저장
async function saveOrder() {
  S.steps.forEach((s, k) => { s.index = k; });
  await db.putSteps(S.steps);
  await db.updateSession(S.session.id, { stepCount: S.steps.length });
  const hit = S.sessions.find((s) => s.id === S.session.id);
  if (hit) hit.stepCount = S.steps.length;
}

async function refreshAll() {
  await renderSteps();
  updateStats();
}

// 단계 기록과 스크린샷을 그대로 떠 둔다 (지운 것을 되살리기 위해)
async function snapshot(step) {
  return { step: clone(step), blob: step.shotId ? await db.getShot(step.shotId) : null };
}

async function restoreSnapshot(snap, index) {
  if (snap.blob && snap.step.shotId) await db.putShot(snap.step.shotId, snap.blob);
  const s = clone(snap.step);
  await db.putStep(s);
  S.steps.splice(Math.max(0, Math.min(index, S.steps.length)), 0, s);
}

async function removeStep(stepId) {
  const s = S.steps.find((x) => x.id === stepId);
  if (!s) return;
  await db.deleteStep(s);
  S.steps = S.steps.filter((x) => x.id !== stepId);
}

async function applyOrder(ids) {
  const byId = new Map(S.steps.map((s) => [s.id, s]));
  S.steps = ids.map((id) => byId.get(id)).filter(Boolean);
  await saveOrder();
  await refreshAll();
}

async function moveStep(step, to) {
  const from = S.steps.indexOf(step);
  if (from < 0 || to < 0 || to >= S.steps.length || to === from) return;
  const before = S.steps.map((s) => s.id);
  S.steps.splice(to, 0, S.steps.splice(from, 1)[0]);
  const after = S.steps.map((s) => s.id);
  await saveOrder();
  await refreshAll();
  record({ label: '순서 바꾸기', undo: () => applyOrder(before), redo: () => applyOrder(after) });
}

async function deleteStepWithUndo(step) {
  const index = S.steps.indexOf(step);
  const snap = await snapshot(step);
  await removeStep(step.id);
  await saveOrder();
  await refreshAll();
  const entry = {
    label: '단계 삭제',
    undo: async () => { await restoreSnapshot(snap, index); await saveOrder(); await refreshAll(); },
    redo: async () => { await removeStep(snap.step.id); await saveOrder(); await refreshAll(); }
  };
  record(entry);
  toast('단계를 삭제했습니다.', false, 5000, { label: '되돌리기', fn: undo });
}

function newNote(index) {
  return {
    id: db.uid('stp'), sessionId: S.session.id, index,
    type: 'note', ts: Date.now(), url: '', pageTitle: '', el: null,
    value: '', masked: false, nrect: null, redactions: [], annotations: [], crop: null, shotId: null,
    highlight: false, edited: true,
    title: '메모', description: ''
  };
}

async function insertNote(at) {
  const note = newNote(at);
  const put = async () => {
    await db.putStep(clone(note));
    S.steps.splice(Math.min(at, S.steps.length), 0, clone(note));
    await saveOrder();
    await refreshAll();
  };
  await put();
  record({
    label: '메모 넣기',
    undo: async () => { await removeStep(note.id); await saveOrder(); await refreshAll(); },
    redo: put
  });
  const li = document.querySelector(`li.step[data-id="${CSS.escape(note.id)}"]`);
  if (li) { li.scrollIntoView({ block: 'center' }); $('.s-title', li).focus(); $('.s-title', li).select(); }
}

// 이 단계를 바로 위 단계와 합친다: 이 단계의 화면·그림·제목을 남기고, 설명은 위 단계와 이어 붙인다
// (같은 입력란의 클릭+입력이면 입력 설명만). 위 단계는 지운다
async function mergeUp(step) {
  const i = S.steps.indexOf(step);
  if (i <= 0) return toast('맨 위 단계는 합칠 위 단계가 없습니다.', true);
  const upper = S.steps[i - 1];
  const snapUpper = await snapshot(upper);
  const beforeLower = clone(step);
  const merged = { ...clone(step), description: mergedDescription(upper, step), edited: true };
  const doMerge = async () => {
    const lower = S.steps.find((s) => s.id === merged.id);
    Object.assign(lower, clone(merged));
    await db.putStep(lower);
    await removeStep(snapUpper.step.id);
    await saveOrder();
    await refreshAll();
  };
  await doMerge();
  record({
    label: '위 단계와 합치기',
    undo: async () => {
      const lower = S.steps.find((s) => s.id === beforeLower.id);
      Object.assign(lower, clone(beforeLower));
      await db.putStep(lower);
      await restoreSnapshot(snapUpper, S.steps.indexOf(lower));
      await saveOrder();
      await refreshAll();
    },
    redo: doMerge
  });
  toast('위 단계와 합쳤습니다.', false, 4000, { label: '되돌리기', fn: undo });
}

// 같은 화면을 복사해 이 단계 바로 아래에 하나 더 만든다 (한 화면에서 두 가지를 설명할 때)
async function splitStep(step) {
  const i = S.steps.indexOf(step);
  const copy = { ...clone(step), id: db.uid('stp'), index: i + 1, edited: true, title: (step.title || '') + ' (2)' };
  let blob = null;
  if (step.shotId) {
    blob = await db.getShot(step.shotId);
    copy.shotId = blob ? db.uid('shot') : null;
  }
  const put = async () => {
    if (blob && copy.shotId) await db.putShot(copy.shotId, blob);
    await db.putStep(clone(copy));
    const at = S.steps.findIndex((s) => s.id === step.id);
    S.steps.splice(at + 1, 0, clone(copy));
    await saveOrder();
    await refreshAll();
  };
  await put();
  record({ label: '단계 나누기', undo: async () => { await removeStep(copy.id); await saveOrder(); await refreshAll(); }, redo: put });
  toast('같은 화면으로 단계를 하나 더 만들었습니다. 두 단계의 글과 그림을 따로 고치세요.', false, 4000);
}

async function resetText(step, li) {
  const before = { title: step.title, description: step.description, edited: step.edited };
  const d = describeStep(step, S.settings.lang);
  const after = { title: d.title, description: d.description, edited: false };
  const apply = async (v) => {
    const s = S.steps.find((x) => x.id === step.id);
    if (!s) return;
    Object.assign(s, v);
    await db.putStep(s);
    const node = document.querySelector(`li.step[data-id="${CSS.escape(step.id)}"]`);
    if (node) {
      $('.s-title', node).value = s.title || '';
      $('.s-desc', node).value = s.description || '';
      autoGrow($('.s-desc', node));
    }
  };
  await apply(after);
  record({ label: '문장 복원', undo: () => apply(before), redo: () => apply(after) });
  toast('자동 생성 문장으로 되돌렸습니다.');
}

/* ------------------------------------------------------------------ */
/* 입력·클릭                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!S.session) return;
  // 저장은 0.5초 뒤에 일어난다. 그 사이 다른 가이드로 바꿔도 입력한 가이드에 저장되도록 지금의 가이드를 붙잡아 둔다.
  const sid = S.session.id;
  if (t.id === 'guide-title') {
    const v = t.value;
    const count = S.steps.length;
    debounceSave('title-' + sid, async () => {
      await db.updateSession(sid, { name: v });
      if (S.session && S.session.id === sid) S.session.name = v;
      const hit = S.sessions.find((s) => s.id === sid);
      if (hit) hit.name = v;
      const opt = $(`#session-select option[value="${CSS.escape(sid)}"]`);
      if (opt) opt.textContent = `${v || '제목 없는 가이드'} (${count}단계)`;
    });
    return;
  }
  if (t.id === 'guide-desc') {
    autoGrow(t);
    const v = t.value;
    debounceSave('desc-' + sid, async () => {
      await db.updateSession(sid, { description: v });
      if (S.session && S.session.id === sid) S.session.description = v;
    });
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
  // 단계 메뉴는 바깥을 누르면 닫는다
  if (!btn || !btn.closest('.step-menu')) $$('.step-dropdown').forEach((d) => { d.hidden = true; });
  if (!btn) return;
  const li = btn.closest('li.step');
  const step = li ? stepOf(btn) : null;

  // 그리기 막대
  const bar = btn.closest('.draw-bar');
  if (bar && step) {
    const sc = S.canvases.get(step.id);
    if (!sc) return;
    if (btn.dataset.tool) sc.setTool(btn.dataset.tool);
    else if (btn.dataset.color) sc.setColor(btn.dataset.color);
    else if (btn.classList.contains('d-del')) sc.deleteSelected();
    else if (btn.classList.contains('d-uncrop')) sc.clearCrop();
    else if (btn.classList.contains('d-done')) setDrawing(null);
    updateDrawBar(li, sc);
    if (!btn.classList.contains('d-done')) sc.canvas.focus({ preventScroll: true });
    return;
  }

  if (btn.classList.contains('t-more')) {
    const dd = $('.step-dropdown', li);
    const open = dd.hidden;
    $$('.step-dropdown').forEach((d) => { d.hidden = true; });
    dd.hidden = !open;
    const i = S.steps.indexOf(step);
    $('[data-act="merge-up"]', dd).disabled = i <= 0;
    return;
  }
  if (btn.dataset.act && step) {
    btn.closest('.step-dropdown').hidden = true;
    const act = btn.dataset.act;
    if (act === 'note-below') return insertNote(S.steps.indexOf(step) + 1);
    if (act === 'merge-up') return mergeUp(step);
    if (act === 'split') return splitStep(step);
    if (act === 'reset') return resetText(step, li);
    return;
  }

  if (btn.classList.contains('t-up') || btn.classList.contains('t-down')) {
    const i = S.steps.indexOf(step);
    return moveStep(step, btn.classList.contains('t-up') ? i - 1 : i + 1);
  }

  if (btn.classList.contains('t-hl')) {
    const sc = S.canvases.get(step.id);
    const before = { ...visualOf(step) };
    step.highlight = step.highlight === false;
    btn.classList.toggle('active', step.highlight !== false);
    if (sc) sc.render();
    await commitVisual(step.id, before, visualOf(step), step.highlight !== false ? '하이라이트 보이기' : '하이라이트 숨기기');
    return;
  }

  if (btn.classList.contains('t-draw')) {
    setDrawing(S.drawingId === step.id ? null : step.id);
    return;
  }

  if (btn.classList.contains('t-del')) return deleteStepWithUndo(step);
});

function visualOf(step) {
  return clone({ annotations: step.annotations || [], redactions: step.redactions || [], nrect: step.nrect || null, highlight: step.highlight !== false, crop: step.crop || null });
}

// 되돌리기 단축키: 글자 칸 안에서는 칸 자체의 되돌리기를 쓴다
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !inField && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
  }
  if (e.key === 'Escape' && S.drawingId && !inField) setDrawing(null);
});

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

/* 끌어서 순서 바꾸기: ⠿ 손잡이를 잡았을 때만 단계 전체를 끈다 (글자 칸에서 글을 고르는 것과 섞이지 않게) */
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.t-drag');
  const li = handle && handle.closest('li.step');
  if (li) li.draggable = true;
});
document.addEventListener('pointerup', () => { $$('li.step[draggable="true"]').forEach((li) => { if (!S.dragId) li.draggable = false; }); });
const list = $('#steps');
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest && e.target.closest('li.step');
  if (!li || !li.draggable) return;
  S.dragId = li.dataset.id;
  li.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  }
});
list.addEventListener('dragover', (e) => {
  if (!S.dragId) return;
  const li = e.target.closest && e.target.closest('li.step');
  if (!li || li.dataset.id === S.dragId) return;
  e.preventDefault();
  const r = li.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  $$('li.step').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  li.classList.add(after ? 'drop-after' : 'drop-before');
});
list.addEventListener('drop', async (e) => {
  if (!S.dragId) return;
  e.preventDefault();
  const li = e.target.closest && e.target.closest('li.step');
  const id = S.dragId;
  endDrag();
  if (!li || li.dataset.id === id) return;
  const step = S.steps.find((s) => s.id === id);
  const target = S.steps.find((s) => s.id === li.dataset.id);
  if (!step || !target) return;
  const r = li.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  let to = S.steps.indexOf(target) + (after ? 1 : 0);
  if (S.steps.indexOf(step) < to) to--;
  await moveStep(step, to);
});
list.addEventListener('dragend', endDrag);
function endDrag() {
  S.dragId = null;
  $$('li.step').forEach((x) => { x.classList.remove('dragging', 'drop-before', 'drop-after'); x.draggable = false; });
}

/* 메모 단계 추가 (맨 끝) */
$('#add-note').addEventListener('click', () => insertNote(S.steps.length));

/* ------------------------------------------------------------------ */
/* 상단 바                                                              */
/* ------------------------------------------------------------------ */

$('#session-select').addEventListener('change', (e) => openSession(e.target.value));
$('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('#btn-delete').addEventListener('click', async () => {
  if (!S.session) return;
  if (!confirm(`‘${S.session.name || '제목 없는 가이드'}’와 스크린샷을 삭제합니다. 되돌릴 수 없습니다.`)) return;
  await db.deleteSession(S.session.id);
  dropCanvases();
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
  S.settings = await getSettings({ withApiKey: true });   // AI 다듬기에만 키를 꺼낸다
  if (!S.settings.ai || S.settings.ai.provider === 'none') {
    toast('설정에서 AI 제공자와 API 키를 먼저 등록해 주세요.', true, 4000);
    chrome.runtime.openOptionsPage();
    return;
  }
  const btn = $('#btn-ai');
  btn.disabled = true;
  const t = toast('AI에게 보내는 중… 0 / ' + S.steps.length, false, 0);
  // 응답을 기다리는 동안에도 편집할 수 있다. 보낼 때의 문장을 기억해 두었다가,
  // 그 사이 사용자가 고치거나 지운 단계에는 AI 결과를 덮어쓰지 않는다.
  const sid = S.session.id;
  const sent = S.steps.map((s) => ({ ...s }));
  const before = new Map(sent.map((s) => [s.id, { title: s.title || '', description: s.description || '' }]));
  try {
    const enhanced = await enhanceSteps(sent, S.settings, {
      onProgress: (done, total) => { t.textContent = `AI에게 보내는 중… ${done} / ${total}`; },
      getShotDataUrl: async (step) => {
        const blob = await db.getShot(step.shotId);
        if (!blob) return null;
        // 편집기에서 칠한 가림(과 그림)을 구운 이미지를 보낸다 (원본을 그대로 보내지 않는다)
        const baked = await bakeStepImage(blob, step, S.settings, { highlight: false });
        return baked ? baked.dataUrl : null;
      }
    });
    if (!S.session || S.session.id !== sid) {
      toast('그 사이 다른 가이드를 열어서 AI 결과를 적용하지 않았습니다.', true, 5000);
      return;
    }
    const changed = [];
    let skipped = 0;
    for (const e of enhanced) {
      if (!e.aiEnhanced) continue;
      const cur = S.steps.find((s) => s.id === e.id);
      const b = before.get(e.id);
      if (!cur || !b) continue;   // 그 사이 지운 단계
      if ((cur.title || '') !== b.title || (cur.description || '') !== b.description) { skipped++; continue; }
      cur.title = e.title;
      cur.description = e.description;
      cur.aiEnhanced = true;
      changed.push(cur);
      const li = document.querySelector(`li.step[data-id="${CSS.escape(cur.id)}"]`);
      if (li) {
        $('.s-title', li).value = cur.title;
        const d = $('.s-desc', li);
        d.value = cur.description;
        autoGrow(d);
      }
    }
    if (changed.length) await db.putSteps(changed);
    toast(skipped
      ? `문장을 다듬었습니다. 그 사이 직접 고친 ${skipped}개 단계는 그대로 두었습니다.`
      : '문장을 다듬었습니다. 마음에 들지 않으면 각 단계의 ⋯ → 문장 복원으로 되돌릴 수 있습니다.', false, 4500);
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
  await flushSaves();
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
    const payload = buildJsonExport(S.session, S.steps, images);
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

window.addEventListener('beforeunload', dropCanvases);
boot().catch((e) => toast('불러오기 실패: ' + e.message, true, 6000));
