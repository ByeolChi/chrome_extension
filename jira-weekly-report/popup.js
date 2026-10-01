import { loadSettings, loadState, saveHistory, saveLastResult, ensureHostPermission } from './src/storage.js';
import { JiraClient } from './src/jira.js';
import { generateReport } from './src/report.js';
import { ymd, parseYmd } from './src/dates.js';

const $ = (id) => document.getElementById(id);
let settings;
let lastResult = null;

function setStatus(text, busy = false) {
  $('status').innerHTML = '';
  if (busy) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    $('status').append(sp);
  }
  $('status').append(document.createTextNode(text || ''));
}

function chip(text, plain = false) {
  const el = document.createElement('span');
  el.className = 'chip' + (plain ? ' plain' : '');
  el.textContent = text;
  return el;
}

function showMeta(meta) {
  const box = $('meta');
  box.innerHTML = '';
  if (!meta) return;
  const by =
    meta.byStart !== undefined && (meta.byStart || meta.byEnd || meta.byProgress)
      ? ` (시작 ${meta.byStart} · 종료 ${meta.byEnd}${meta.byProgress ? ` · 진행률 ${meta.byProgress}` : ''})`
      : '';
  box.append(chip(`이번 주 작업 ${meta.total}건${by}`));
  box.append(chip(`완료 ${meta.done} · 진행 ${meta.inProgress} · 예정 ${meta.todo}`, true));
  if (meta.mine !== undefined) box.append(chip(`내 담당 ${meta.mine}`, true));
  if (meta.sprint) box.append(chip(`${meta.sprint} 실적 ${meta.sprintPct ?? '-'}%`, true));
  if (meta.lastWeekPct !== null && meta.lastWeekPct !== undefined) box.append(chip(`월요일 기준 ${meta.lastWeekPct}%`, true));
  if (meta.delayed) box.append(chip(`지연 ${meta.delayed}`, true));
}

function showNotices({ warnings = [], error = null, action = null } = {}) {
  const box = $('notices');
  box.innerHTML = '';
  if (error) {
    const n = document.createElement('div');
    n.className = 'notice err';
    n.textContent = error;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      n.append(document.createElement('br'), b);
    }
    box.append(n);
  }
  if (warnings.length) {
    const n = document.createElement('div');
    n.className = 'notice warn';
    const ul = document.createElement('ul');
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.append(li);
    }
    n.append(ul);
    box.append(n);
  }
}

function showWhen(res) {
  const t = new Date(res.generatedAt);
  $('when').textContent =
    `${res.edited ? '수정됨 · ' : ''}생성 ${ymd(t)} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function showResult(res) {
  lastResult = res;
  $('empty').classList.add('hidden');
  $('result').classList.remove('hidden');
  $('out').value = res.text;
  showWhen(res);
  showMeta(res.meta);
}

const openJira = () => chrome.tabs.create({ url: settings.baseUrl });
const openOptions = () => chrome.runtime.openOptionsPage();

async function generate() {
  const btn = $('gen');
  btn.disabled = true;
  showNotices();
  try {
    if (!(await ensureHostPermission(settings.baseUrl))) {
      showNotices({
        error: `${settings.baseUrl} 에 접근 권한이 없습니다. 설정 화면에서 저장하면 권한을 요청합니다.`,
        action: { label: '설정 열기', run: openOptions },
      });
      setStatus('');
      return;
    }
    const client = new JiraClient(settings);
    const { history } = await loadState();
    const refDate = $('ref').value ? parseYmd($('ref').value) : new Date();
    const r = await generateReport({
      settings,
      refDate,
      client,
      history,
      onProgress: (msg) => setStatus(msg, true),
    });
    await saveHistory(r.history);
    const res = { text: r.text, meta: r.meta, warnings: r.warnings, generatedAt: Date.now(), edited: false };
    await saveLastResult(res);
    showResult(res);
    showNotices({ warnings: r.warnings });
    setStatus(`${r.meta.user ? r.meta.user + ' 님, ' : ''}${r.meta.week} 보고서를 만들었습니다.`);
  } catch (e) {
    if (!e.kind) console.error(e);
    setStatus('');
    if (e.kind === 'auth') {
      showNotices({
        error: e.message,
        action: settings.authMode === 'token' ? { label: '설정 열기', run: openOptions } : { label: 'Jira 열어서 로그인', run: openJira },
      });
    } else if (e.kind === 'config') {
      showNotices({ error: e.message, action: { label: '설정 열기', run: openOptions } });
    } else {
      showNotices({ error: e.message || String(e), action: { label: '설정 열기', run: openOptions } });
    }
  } finally {
    btn.disabled = false;
  }
}

async function copy() {
  const text = $('out').value;
  const btn = $('copy');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('out').select();
    document.execCommand('copy');
  }
  btn.textContent = '복사됨 ✓';
  btn.classList.add('done');
  setTimeout(() => {
    btn.textContent = '복사하기';
    btn.classList.remove('done');
  }, 1500);
}

let saveTimer;
function onEdit() {
  if (!lastResult) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    lastResult = { ...lastResult, text: $('out').value, edited: true };
    await saveLastResult(lastResult);
    showWhen(lastResult);
  }, 400);
}

function viewInJira() {
  const jql = lastResult?.meta?.jql;
  if (!jql) return;
  chrome.tabs.create({ url: `${settings.baseUrl.replace(/\/+$/, '')}/issues/?jql=${encodeURIComponent(jql)}` });
}

async function init() {
  settings = await loadSettings();
  $('ref').value = ymd(new Date());
  try {
    $('target').textContent = `${new URL(settings.baseUrl).host} · ${settings.projectKey}${settings.boardId ? ' · 보드 ' + settings.boardId : ''}`;
  } catch {
    $('target').textContent = settings.baseUrl;
  }
  const { lastResult: saved } = await loadState();
  if (saved) {
    showResult(saved);
    setStatus('지난번에 만든 보고서입니다. 새로 만들려면 버튼을 누르세요.');
  }
  $('gen').addEventListener('click', generate);
  $('copy').addEventListener('click', copy);
  $('out').addEventListener('input', onEdit);
  $('openOptions').addEventListener('click', openOptions);
  $('viewJira').addEventListener('click', viewInJira);
}

init();
