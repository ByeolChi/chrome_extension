import { DEFAULT_SETTINGS, DEFAULT_TEMPLATE, TEMPLATE_TOKENS, ITEM_TOKENS, JQL_TOKENS } from './src/defaults.js';
import { loadSettings, saveSettings, loadState, ensureHostPermission } from './src/storage.js';
import { JiraClient, parseBoardUrl } from './src/jira.js';
import { generateReport } from './src/report.js';

const $ = (id) => document.getElementById(id);
const inputs = () => [...document.querySelectorAll('[data-key]')];
let saved = null;

// 필드 목록을 불러오기 전에도 이름이 보이도록 (raoncorp SAN 기준)
const KNOWN_FIELDS = {
  customfield_10057: '진행률(%) (customfield_10057)',
  customfield_10053: '시작일(Start) (customfield_10053)',
  customfield_10054: '종료일(Finish) (customfield_10054)',
  customfield_10051: '시작예정일 (customfield_10051)',
  customfield_10052: '종료예정일 (customfield_10052)',
};

/* ── 폼 ↔ 설정 ── */

function ensureOption(select, value, label) {
  if (value === '' || [...select.options].some((o) => o.value === String(value))) return;
  const o = new Option(label || String(value), String(value));
  select.add(o);
}

function fillForm(s) {
  ensureOption($('boardId'), s.boardId, `보드 #${s.boardId}`);
  for (const k of ['progressField', 'pointsField', 'startField', 'endField', 'dueField']) ensureOption($(k), s[k], KNOWN_FIELDS[s[k]]);
  for (const el of inputs()) {
    const k = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else if (el.type === 'radio') el.checked = el.value === s[k];
    else el.value = s[k] ?? '';
  }
  syncVisibility();
}

function readForm() {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  for (const el of inputs()) {
    const k = el.dataset.key;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) s[k] = el.value;
    } else s[k] = el.type === 'textarea' || el.tagName === 'TEXTAREA' ? el.value : el.value.trim();
  }
  s.baseUrl = s.baseUrl.replace(/\/+$/, '');
  s.projectKey = s.projectKey.toUpperCase();
  return s;
}

function syncVisibility() {
  const s = readForm();
  $('tokenFields').classList.toggle('hidden', s.authMode !== 'token');
  document.querySelectorAll('.field-only').forEach((el) => el.classList.toggle('hidden', s.progressSource !== 'field'));
  document.querySelectorAll('.points-only').forEach((el) => el.classList.toggle('hidden', s.sprintCalc !== 'points'));
  document.querySelectorAll('.date-only').forEach((el) => el.classList.toggle('hidden', !s.useDateFilter));
}

function markDirty() {
  const dirty = JSON.stringify(readForm()) !== JSON.stringify({ ...DEFAULT_SETTINGS, ...saved });
  $('saveState').textContent = dirty ? '저장되지 않은 변경 사항이 있습니다' : '변경 사항 없음';
  $('saveState').className = dirty ? 'dirty' : '';
}

/* ── 알림 ── */

function notice(box, kind, text) {
  box.innerHTML = '';
  if (!text) return;
  const n = document.createElement('div');
  n.className = `notice ${kind}`;
  n.textContent = text;
  box.append(n);
}

async function clientFromForm(box, requestPermission = true) {
  const s = readForm();
  const ok = await ensureHostPermission(s.baseUrl, requestPermission);
  if (!ok) {
    notice(box, 'err', `${s.baseUrl} 접근 권한이 허용되지 않았습니다.`);
    return null;
  }
  try {
    return { s, client: new JiraClient(s) };
  } catch (e) {
    notice(box, 'err', e.message);
    return null;
  }
}

/* ── 버튼 동작 ── */

async function testConnection() {
  const box = $('connResult');
  notice(box, 'ok', '확인 중…');
  const c = await clientFromForm(box);
  if (!c) return;
  try {
    const me = await c.client.myself();
    let boards = [];
    try {
      boards = await c.client.boards(c.s.projectKey);
    } catch {
      /* 보드 권한 없음 — 아래 메시지로 안내 */
    }
    notice(
      box,
      'ok',
      `연결됨: ${me.displayName}${me.emailAddress ? ` (${me.emailAddress})` : ''} · ${c.s.projectKey} 보드 ${boards.length}개`
    );
  } catch (e) {
    notice(box, 'err', e.message);
  }
}

async function loadBoards() {
  const box = $('connResult');
  const c = await clientFromForm(box);
  if (!c) return;
  try {
    const boards = await c.client.boards(c.s.projectKey);
    const sel = $('boardId');
    const cur = sel.value;
    sel.innerHTML = '';
    sel.add(new Option('자동 (스페이스의 첫 번째 스크럼 보드)', ''));
    for (const b of boards) sel.add(new Option(`${b.name} (#${b.id}, ${b.type === 'scrum' ? '스크럼' : b.type})`, String(b.id)));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    notice(box, 'ok', `보드 ${boards.length}개를 불러왔습니다.`);
    markDirty();
  } catch (e) {
    notice(box, 'err', `보드를 불러오지 못했습니다: ${e.message}`);
  }
}

async function loadFields() {
  const box = $('connResult');
  const c = await clientFromForm(box);
  if (!c) return;
  try {
    const all = await c.client.fields();
    const fields = all
      .filter((f) => f.custom || f.id === 'timeoriginalestimate')
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const likelyPct = /진척|진행|진도|progress|percent|%|완료율/i;
    const likelyPts = /story ?point|스토리 ?포인트|point|포인트/i;
    for (const [id, re] of [['progressField', likelyPct], ['pointsField', likelyPts]]) {
      const sel = $(id);
      const cur = sel.value;
      sel.innerHTML = '';
      sel.add(new Option('(선택 안 함)', ''));
      const ranked = [...fields.filter((f) => re.test(f.name)), ...fields.filter((f) => !re.test(f.name))];
      for (const f of ranked) {
        const type = f.schema?.type ? ` · ${f.schema.type}` : '';
        sel.add(new Option(`${re.test(f.name) ? '★ ' : ''}${f.name} (${f.id}${type})`, f.id));
      }
      ensureOption(sel, cur, KNOWN_FIELDS[cur]);
      sel.value = cur;
    }
    const dates = all
      .filter((f) => ['date', 'datetime'].includes(f.schema?.type))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const dateHints = { startField: /시작|start/i, endField: /종료|finish|end/i, dueField: /예정|기한|마감|due/i };
    for (const [id, re] of Object.entries(dateHints)) {
      const sel = $(id);
      const cur = sel.value;
      sel.innerHTML = '';
      sel.add(new Option(id === 'dueField' ? '기한 (duedate)' : '(선택 안 함)', ''));
      const ranked = [...dates.filter((f) => re.test(f.name)), ...dates.filter((f) => !re.test(f.name))];
      for (const f of ranked) {
        if (id === 'dueField' && f.id === 'duedate') continue;
        sel.add(new Option(`${re.test(f.name) ? '★ ' : ''}${f.name} (${f.id})`, f.id));
      }
      ensureOption(sel, cur, KNOWN_FIELDS[cur]);
      sel.value = cur;
    }
    notice(box, 'ok', `사용자 정의 필드 ${fields.length}개, 날짜 필드 ${dates.length}개를 불러왔습니다. ★ 표시는 이름으로 추정한 후보입니다.`);
    markDirty();
  } catch (e) {
    notice(box, 'err', `필드를 불러오지 못했습니다: ${e.message}`);
  }
}

async function preview() {
  const box = $('previewNotice');
  const out = $('preview');
  notice(box, 'ok', '미리보기를 만드는 중…');
  const c = await clientFromForm(box);
  if (!c) return;
  try {
    const { history } = await loadState();
    const r = await generateReport({
      settings: c.s,
      refDate: new Date(),
      client: c.client,
      history,
      onProgress: (m) => notice(box, 'ok', m),
    });
    out.textContent = r.text;
    out.classList.remove('hidden');
    notice(
      box,
      r.warnings.length ? 'warn' : 'ok',
      r.warnings.length
        ? r.warnings.join(' / ')
        : `${r.meta.week} · 이번 주 작업 ${r.meta.total}건 (시작일 ${r.meta.byStart ?? 0} · 종료일 ${r.meta.byEnd ?? 0} · 진행률 변경 ${r.meta.byProgress ?? 0} / 내 담당 ${r.meta.mine ?? 0}) · ${r.meta.sprint || '스프린트 없음'} 실적 ${r.meta.sprintPct ?? '-'}% — 저장 전 설정으로 만든 미리보기`
    );
  } catch (e) {
    out.classList.add('hidden');
    notice(box, 'err', e.message);
  }
}

async function save() {
  const s = readForm();
  const ok = await ensureHostPermission(s.baseUrl, true);
  if (!ok) {
    $('saveState').textContent = `${s.baseUrl} 접근 권한이 없어 저장하지 않았습니다`;
    $('saveState').className = 'dirty';
    return;
  }
  await saveSettings(s);
  saved = s;
  $('saveState').textContent = '저장했습니다';
  $('saveState').className = 'saved';
}

function applyBoardUrl() {
  const help = $('boardUrlHelp');
  const v = $('boardUrl').value.trim();
  if (!v) return;
  const p = parseBoardUrl(v);
  if (!p) {
    help.textContent = '보드 주소를 알아보지 못했습니다. 예) https://raoncorp.atlassian.net/jira/software/c/projects/SAN/boards/281';
    return;
  }
  $('baseUrl').value = p.baseUrl;
  if (p.projectKey) $('projectKey').value = p.projectKey;
  if (p.boardId) {
    ensureOption($('boardId'), p.boardId, `보드 #${p.boardId}`);
    $('boardId').value = p.boardId;
  }
  help.textContent = `적용됨: ${new URL(p.baseUrl).host} · 스페이스 ${p.projectKey || '(그대로)'} · 보드 ${p.boardId || '(자동)'} — 저장을 눌러야 반영됩니다.`;
  syncVisibility();
  markDirty();
}

/* ── 도움말 표 ── */

function fillTokenTable(table, rows) {
  for (const [tok, desc] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = tok;
    tr.insertCell().textContent = desc;
  }
}

/* ── 시작 ── */

async function init() {
  fillTokenTable($('tplTokens'), TEMPLATE_TOKENS);
  fillTokenTable($('itemTokens'), ITEM_TOKENS);
  fillTokenTable($('jqlTokens'), JQL_TOKENS);

  saved = await loadSettings();
  fillForm(saved);

  for (const el of inputs()) {
    el.addEventListener('input', () => {
      syncVisibility();
      markDirty();
    });
    el.addEventListener('change', () => {
      syncVisibility();
      markDirty();
    });
  }
  $('testConn').addEventListener('click', testConnection);
  $('loadBoards').addEventListener('click', loadBoards);
  document.querySelectorAll('.loadFields').forEach((b) => b.addEventListener('click', loadFields));
  $('previewBtn').addEventListener('click', preview);
  $('resetTemplate').addEventListener('click', () => {
    $('template').value = DEFAULT_TEMPLATE;
    markDirty();
  });
  $('save').addEventListener('click', save);
  $('boardUrl').addEventListener('input', applyBoardUrl);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
}

init();
