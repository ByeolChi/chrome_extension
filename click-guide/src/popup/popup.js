import { listSessions } from '../common/db.js';

const $ = (s) => document.querySelector(s);
const els = {
  status: $('#status'), idle: $('#idle'), live: $('#live'), count: $('#count'),
  start: $('#start'), pause: $('#pause'), stop: $('#stop'), cancel: $('#cancel'),
  toggleBar: $('#toggle-bar'),
  list: $('#recent-list'), empty: $('#recent-empty'),
  targetTab: $('#target-tab'), startError: $('#start-error'),
  openEditor: $('#open-editor'), openOptions: $('#open-options')
};

function send(msg) {
  return new Promise((res) => {
    chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); });
  });
}

function render(state) {
  const rec = !!state.recording;
  els.idle.hidden = rec;
  els.live.hidden = !rec;
  els.count.textContent = state.stepCount || 0;
  els.pause.textContent = state.paused ? '재개' : '일시정지';
  els.status.innerHTML = rec
    ? `<span class="dot ${state.paused ? 'paused' : 'rec'}"></span>${state.paused ? '일시정지' : '녹화 중'}`
    : '대기 중';
}

function relTime(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

async function renderRecent() {
  let sessions = [];
  try { sessions = await listSessions(); } catch (_) { /* noop */ }
  const recent = sessions.slice(0, 5);
  els.empty.hidden = recent.length > 0;
  els.list.innerHTML = '';
  for (const s of recent) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'open';
    b.innerHTML = `<span><span class="name"></span><span class="meta"></span></span>`;
    b.querySelector('.name').textContent = s.name || '제목 없는 가이드';
    b.querySelector('.meta').textContent = `${s.stepCount || 0}단계 · ${relTime(s.createdAt)}`;
    b.addEventListener('click', () => send({ type: 'OPEN_EDITOR', sessionId: s.id }).then(() => window.close()));
    li.append(b);
    els.list.append(li);
  }
}

// 팝업에서 직접 대상 탭을 정한다. 서비스 워커에는 '현재 창' 개념이 없어
// 여러 창을 띄워 둔 경우 엉뚱한 탭이 잡힐 수 있기 때문이다.
const isWebPage = (t) => !!t && /^https?:\/\//i.test(t.url || '');

async function currentTab() {
  for (const q of [{ active: true, currentWindow: true },
                   { active: true, lastFocusedWindow: true },
                   { active: true }]) {
    try {
      const t = (await chrome.tabs.query(q)).find(isWebPage);
      if (t) return t;
    } catch (_) { /* noop */ }
  }
  // 웹페이지 탭이 없으면 활성 탭이라도 넘겨서, 왜 안 되는지 안내가 나오게 한다
  try { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null; } catch (_) { return null; }
}

async function showTargetTab() {
  const t = await currentTab();
  if (!t) { els.targetTab.textContent = '녹화할 웹페이지 탭이 없습니다.'; return; }
  if (!isWebPage(t)) {
    els.targetTab.textContent = '이 탭은 녹화할 수 없습니다 (일반 웹페이지를 열어 주세요).';
    return;
  }
  const host = (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  els.targetTab.textContent = host ? `기록할 탭: ${host}` : '';
}

els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  els.startError.hidden = true;
  const t = await currentTab();
  const res = await send({ type: 'START', tabId: t ? t.id : undefined });
  els.start.disabled = false;

  if (!res || !res.ok) {
    els.startError.hidden = false;
    els.startError.textContent = (res && res.error) || '녹화를 시작하지 못했습니다.';
    return;
  }
  if (!res.attached) {
    // 녹화 바가 뜨지 않는 상황 — 그냥 닫지 않고 이유를 알린다
    await send({ type: 'STOP', openEditor: false });
    els.startError.hidden = false;
    els.startError.textContent = res.reason || '이 페이지에서는 녹화 바를 띄울 수 없습니다.';
    return;
  }
  const r = await send({ type: 'GET_STATE' });
  if (r) render(r.state);
  window.close();
});
els.pause.addEventListener('click', async () => {
  const r = await send({ type: 'GET_STATE' });
  await send({ type: r && r.state.paused ? 'RESUME' : 'PAUSE' });
  const r2 = await send({ type: 'GET_STATE' });
  if (r2) render(r2.state);
});
async function refreshBarToggle() {
  let hidden = false;
  try { hidden = !!(await chrome.storage.local.get('cg_barHidden')).cg_barHidden; } catch (_) { /* noop */ }
  els.toggleBar.textContent = hidden ? '화면에 바 다시 표시' : '화면의 바 숨기기';
  return hidden;
}

els.toggleBar.addEventListener('click', async () => {
  const hidden = await refreshBarToggle();
  await send({ type: 'SET_BAR_HIDDEN', hidden: !hidden });
  await refreshBarToggle();
});

els.stop.addEventListener('click', async () => { await send({ type: 'STOP' }); window.close(); });
els.cancel.addEventListener('click', async () => { await send({ type: 'STOP', openEditor: false }); window.close(); });
els.openEditor.addEventListener('click', async () => { await send({ type: 'OPEN_EDITOR' }); window.close(); });
els.openOptions.addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'STATE_CHANGED') render(msg.state); });

(async () => {
  const r = await send({ type: 'GET_STATE' });
  if (r) render(r.state);
  await showTargetTab();
  await refreshBarToggle();
  await renderRecent();
})();
