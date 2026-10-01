import { getSettings, setSettings, resetSettings, DEFAULT_SETTINGS } from '../common/settings.js';
import { listSessions, deleteSession, estimateUsage } from '../common/db.js';
import { testConnection, listModels, resolveEndpoint } from '../common/ai.js';
import { bytes } from '../common/util.js';

const $ = (s) => document.querySelector(s);
let saveTimer = null;

const FIELDS = {
  lang: { el: '#lang', type: 'value' },
  recordClicks: { el: '#recordClicks', type: 'checked' },
  recordInputs: { el: '#recordInputs', type: 'checked' },
  recordNavigation: { el: '#recordNavigation', type: 'checked' },
  followNewTabs: { el: '#followNewTabs', type: 'checked' },
  captureDelayMs: { el: '#captureDelayMs', type: 'number' },
  maxImageWidth: { el: '#maxImageWidth', type: 'number' },
  maskPasswords: { el: '#maskPasswords', type: 'checked' },
  maskSensitiveValues: { el: '#maskSensitiveValues', type: 'checked' },
  maskValueChars: { el: '#maskValueChars', type: 'number' },
  highlight: { el: '#highlight', type: 'checked' },
  dimOutside: { el: '#dimOutside', type: 'checked' },
  highlightColor: { el: '#highlightColor', type: 'value' },
  highlightWidth: { el: '#highlightWidth', type: 'number' }
};

function load(s) {
  for (const [key, def] of Object.entries(FIELDS)) {
    const el = $(def.el);
    if (!el) continue;
    if (def.type === 'checked') el.checked = !!s[key];
    else el.value = s[key];
  }
  $('#jpegQuality').value = Math.round((s.jpegQuality || 0.82) * 100);
  $('#qv').textContent = `${Math.round((s.jpegQuality || 0.82) * 100)}%`;
  $('#redactSelectors').value = (s.redactSelectors || []).join('\n');

  $('#aiProvider').value = s.ai.provider || 'none';
  $('#aiEndpoint').value = s.ai.endpoint || '';
  $('#aiModel').value = s.ai.model || '';
  $('#aiKey').value = s.ai.apiKey || '';
  $('#aiImages').checked = !!s.ai.includeScreenshots;
  $('#aiExtra').value = s.ai.extraPrompt || '';
  toggleAi();
}

function collect() {
  const patch = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    const el = $(def.el);
    if (!el) continue;
    if (def.type === 'checked') patch[key] = el.checked;
    else if (def.type === 'number') patch[key] = Number(el.value) || 0;
    else patch[key] = el.value;
  }
  patch.jpegQuality = Math.max(0.5, Math.min(0.95, Number($('#jpegQuality').value) / 100));
  patch.redactSelectors = $('#redactSelectors').value.split('\n').map((x) => x.trim()).filter(Boolean);
  patch.ai = {
    provider: $('#aiProvider').value,
    endpoint: $('#aiEndpoint').value.trim(),
    model: $('#aiModel').value.trim(),
    apiKey: $('#aiKey').value,
    includeScreenshots: $('#aiImages').checked,
    extraPrompt: $('#aiExtra').value
  };
  return patch;
}

function flashSaved() {
  const el = $('#saved');
  el.hidden = false;
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => { el.hidden = true; }, 1400);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await setSettings(collect()); flashSaved(); }, 350);
}

function toggleAi() {
  const on = $('#aiProvider').value !== 'none';
  $('#ai-fields').hidden = !on;
  showResolved();
}

// 실제로 호출될 주소를 그대로 보여 준다 (베이스 URL만 넣어도 되도록 보정되므로)
function showResolved() {
  const el = $('#resolved-endpoint');
  if (!el) return;
  const provider = $('#aiProvider').value;
  if (provider === 'none') { el.textContent = ''; return; }
  const raw = $('#aiEndpoint').value;
  let url = '';
  try { url = resolveEndpoint(raw, provider); } catch (_) { url = ''; }
  el.textContent = url ? `실제 요청 주소: ${url}` : '';
}

async function loadModels() {
  const hint = $('#model-hint');
  const btn = $('#load-models');
  btn.disabled = true;
  hint.textContent = '불러오는 중…';
  hint.style.color = '';
  try {
    await setSettings(collect());
    const s = await getSettings();
    const models = await listModels(s.ai);
    const dl = $('#model-list');
    dl.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      dl.append(o);
    }
    if (!models.length) hint.textContent = '서버가 모델 목록을 주지 않았습니다. 모델 이름을 직접 입력하세요.';
    else {
      hint.textContent = `사용 가능한 모델 ${models.length}개: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ' …' : ''} (입력칸을 누르면 목록이 뜹니다)`;
      if (!models.includes($('#aiModel').value)) {
        hint.textContent += ' — 지금 입력된 모델은 이 목록에 없습니다.';
        hint.style.color = 'var(--warn)';
      }
    }
  } catch (e) {
    hint.textContent = '실패: ' + e.message;
    hint.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
  }
}

$('#load-models').addEventListener('click', loadModels);
$('#preset-litellm').addEventListener('click', () => {
  $('#aiProvider').value = 'openai';
  $('#aiEndpoint').value = 'http://localhost:4000';
  toggleAi(); scheduleSave();
});
$('#preset-ollama').addEventListener('click', () => {
  $('#aiProvider').value = 'openai';
  $('#aiEndpoint').value = 'http://localhost:11434';
  if (!$('#aiModel').value || /^gpt-/.test($('#aiModel').value)) $('#aiModel').value = 'llama3.1';
  toggleAi(); scheduleSave();
});

$('#aiProvider').addEventListener('change', () => {
  const v = $('#aiProvider').value;
  if (v === 'anthropic') {
    if (!/anthropic/.test($('#aiEndpoint').value)) $('#aiEndpoint').value = 'https://api.anthropic.com/v1/messages';
    if (!/claude/.test($('#aiModel').value)) $('#aiModel').value = 'claude-sonnet-4-5';
  } else if (v === 'openai') {
    if (/anthropic/.test($('#aiEndpoint').value) || !$('#aiEndpoint').value) $('#aiEndpoint').value = DEFAULT_SETTINGS.ai.endpoint;
    if (/claude/.test($('#aiModel').value) || !$('#aiModel').value) $('#aiModel').value = DEFAULT_SETTINGS.ai.model;
  }
  toggleAi();
  scheduleSave();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'jpegQuality') $('#qv').textContent = `${e.target.value}%`;
  if (e.target.id === 'aiEndpoint') showResolved();
  if (e.target.closest('main')) scheduleSave();
});
document.addEventListener('change', (e) => { if (e.target.closest('main')) scheduleSave(); });

$('#reset').addEventListener('click', async () => {
  if (!confirm('모든 설정을 기본값으로 되돌릴까요? (저장된 가이드는 지워지지 않습니다)')) return;
  load(await resetSettings());
  flashSaved();
});

$('#ai-test').addEventListener('click', async () => {
  const out = $('#ai-test-result');
  out.textContent = '확인 중…';
  await setSettings(collect());
  try {
    const s = await getSettings();
    const r = await testConnection(s.ai);
    out.textContent = `연결됨 — 응답: ${r || '(빈 응답)'}`;
    out.style.color = 'var(--accent)';
  } catch (e) {
    out.textContent = `실패: ${e.message}`;
    out.style.color = 'var(--danger)';
    if (/403|모델/.test(e.message)) loadModels();
  }
});

$('#wipe').addEventListener('click', async () => {
  const sessions = await listSessions();
  if (!sessions.length) { alert('삭제할 가이드가 없습니다.'); return; }
  if (!confirm(`가이드 ${sessions.length}개와 스크린샷을 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`)) return;
  for (const s of sessions) await deleteSession(s.id);
  await showUsage();
  alert('삭제했습니다.');
});

function send(msg) {
  return new Promise((res) => {
    chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); });
  });
}

$('#speed-test').addEventListener('click', async () => {
  const btn = $('#speed-test');
  const state = $('#speed-state');
  const box = $('#speed-result');
  btn.disabled = true;
  state.textContent = '측정 중… (창을 그대로 두세요)';
  box.hidden = true;
  const r = await send({ type: 'SPEED_TEST' });
  btn.disabled = false;
  state.textContent = '';
  if (!r || !r.ok) {
    box.hidden = false;
    box.innerHTML = '<p class="verdict bad"></p>';
    box.querySelector('p').textContent = '측정 실패: ' + ((r && r.error) || '알 수 없는 오류');
    return;
  }
  let cls = 'good';
  let verdict = '빠릅니다. 클릭할 때 거의 바로 찍힙니다.';
  if (r.estimateMs > 400) { cls = 'bad'; verdict = '느립니다. 화면 해상도가 높아 브라우저의 촬영 자체가 오래 걸립니다. 창을 조금 줄이면 빨라집니다.'; }
  else if (r.estimateMs > 180) { cls = 'warn'; verdict = '보통입니다. 클릭 후 잠깐 멈춤이 느껴질 수 있습니다.'; }

  box.hidden = false;
  box.innerHTML =
    '<dl>' +
    `<dt>브라우저 촬영</dt><dd>${r.captureMs}ms (측정값 ${r.captureAll.join(', ')}ms)</dd>` +
    `<dt>표시줄 숨김 대기</dt><dd>최대 ${r.widgetWaitMs}ms</dd>` +
    `<dt>클릭당 예상 지연</dt><dd><strong>약 ${r.estimateMs}ms</strong></dd>` +
    `<dt>캡처 크기</dt><dd>${r.imgW}×${r.imgH} · ${r.kb}KB</dd>` +
    `<dt>저장 가공</dt><dd>${r.processMs}ms (촬영과 별도로 진행되어 클릭을 막지 않습니다)</dd>` +
    '</dl><p class="verdict ' + cls + '"></p>';
  box.querySelector('.verdict').textContent = verdict;
});

$('#reset-bar-pos').addEventListener('click', async () => {
  await chrome.storage.local.remove('cg_barPos');
  const el = $('#bar-pos-state');
  el.textContent = '오른쪽 아래로 되돌렸습니다.';
  setTimeout(() => { el.textContent = ''; }, 2000);
});

async function showUsage() {
  const sessions = await listSessions().catch(() => []);
  const est = await estimateUsage();
  const steps = sessions.reduce((a, s) => a + (s.stepCount || 0), 0);
  $('#usage').textContent =
    `가이드 ${sessions.length}개 · 단계 ${steps}개` + (est && est.usage ? ` · 사용 중 ${bytes(est.usage)}` : '');
}

(async () => { load(await getSettings()); showResolved(); await showUsage(); })();
