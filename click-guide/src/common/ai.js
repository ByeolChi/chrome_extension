/* 선택 기능: LLM으로 단계 문장을 다듬는다.
 * 기본값은 '사용 안 함'이며, 켜더라도 스크린샷은 별도로 허용해야 전송된다.
 */
import { blobToDataURL } from './util.js';

const SYSTEM_KO = `당신은 사내 업무 매뉴얼을 쓰는 테크니컬 라이터입니다.
화면 조작 기록(클릭·입력·페이지 이동)을 받아 각 단계의 제목과 설명을 다듬습니다.
규칙:
- 사실을 지어내지 마세요. 주어진 정보에 없는 버튼 이름, 결과, 화면을 추가하지 않습니다.
- 제목은 12자 내외의 명사형 요약, 설명은 1~2문장의 존댓말(\"~합니다\")로 씁니다.
- 화면에 보이는 라벨은 작은따옴표로 감쌉니다. 예: '저장' 버튼을 클릭합니다.
- 가려진 값(●●●● 또는 (가려짐))은 실제 값을 추측하지 말고 \"입력합니다\" 수준으로만 씁니다.
- 반드시 JSON 배열만 출력합니다. 다른 말은 쓰지 마세요.`;

const SYSTEM_EN = `You are a technical writer producing step-by-step product documentation.
You receive a recording of UI actions (clicks, typing, navigation) and rewrite each step's title and description.
Rules:
- Never invent facts. Do not add buttons, results, or screens that are not in the input.
- Title: a short noun phrase. Description: 1-2 imperative sentences.
- Wrap on-screen labels in quotes.
- For masked values (●●●● or "(hidden)"), do not guess the real value.
- Output ONLY a JSON array, nothing else.`;

function stepPayload(step, i) {
  const el = step.el || {};
  return {
    index: i + 1,
    action: step.type,
    element: { role: el.role || '', tag: el.tag || '', type: el.type || '', label: el.label || '' },
    value: step.masked ? '(가려짐)' : (step.value || ''),
    page: step.pageTitle || '',
    url: step.url || '',
    current: { title: step.title || '', description: step.description || '' }
  };
}

function parseJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('['); const b = t.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

/* LiteLLM·Ollama·vLLM 문서는 보통 베이스 URL(http://localhost:4000)만 알려 준다.
 * 사용자가 그대로 붙여 넣어도 동작하도록 실제 호출 경로를 보정한다. */
export function resolveEndpoint(endpoint, provider) {
  let raw = String(endpoint || '').trim();
  if (!raw) raw = provider === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:4000';
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  let u;
  try { u = new URL(raw); } catch (_) { return raw; }

  // 쿼리스트링이 붙어 있으면(Azure 배포 주소 등) 손대지 않는다
  if (u.search) return u.toString();

  let path = u.pathname.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    if (!/\/messages$/.test(path)) path = (path === '/v1' ? '' : path) + '/v1/messages';
  } else {
    if (!/chat\/completions$/.test(path)) {
      if (/\/v\d+$/.test(path)) path += '/chat/completions';
      else path += '/v1/chat/completions';
    }
  }
  u.pathname = path;
  return u.toString();
}

/* /v1/models 주소 (모델 목록 조회용) */
export function modelsEndpoint(endpoint, provider) {
  try {
    const u = new URL(resolveEndpoint(endpoint, provider));
    u.search = '';
    u.pathname = u.pathname.replace(/\/(chat\/completions|messages)$/, '/models');
    return u.toString();
  } catch (_) { return ''; }
}

function describeNetworkError(url) {
  let u = null;
  try { u = new URL(url); } catch (_) { /* noop */ }
  if (!u) return `주소를 해석할 수 없습니다: ${url}`;
  const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(u.hostname);
  const parts = [`${u.origin} 에 연결하지 못했습니다.`];
  if (local) {
    parts.push(`LiteLLM이 실행 중인지, 포트가 ${u.port || '(기본)'} 가 맞는지 확인하세요.`);
    parts.push(`터미널에서 확인: curl ${u.origin}/v1/models`);
  } else {
    parts.push('주소·포트·방화벽(VPN 포함)을 확인하세요.');
    if (u.protocol === 'http:') parts.push('사내망 평문 http 주소는 브라우저가 막을 수 있습니다.');
  }
  return parts.join(' ');
}

async function httpJson(url, init, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error(`응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다: ${url}`);
    throw new Error(describeNetworkError(url));
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const body = text.slice(0, 400);
    if (res.status === 401) throw new Error(`인증 실패(401). API 키를 확인하세요. LiteLLM이라면 마스터 키나 발급받은 가상 키가 필요합니다. — ${body}`);
    if (res.status === 403) throw new Error(`접근 거부(403). 이 키로 쓸 수 없는 모델일 수 있습니다. ‘모델 목록 불러오기’로 허용된 모델을 확인하세요. — ${body}`);
    if (res.status === 404) throw new Error(`엔드포인트를 찾지 못했습니다(404). 실제 요청 주소: ${url} — ${body}`);
    throw new Error(`${res.status} ${res.statusText} — ${body}`);
  }
  try { return JSON.parse(text); } catch (_) {
    throw new Error(`JSON이 아닌 응답을 받았습니다: ${text.slice(0, 200)}`);
  }
}

async function callOpenAI(ai, systemPrompt, userText, images) {
  const url = resolveEndpoint(ai.endpoint, 'openai');
  const content = [{ type: 'text', text: userText }];
  for (const img of images || []) content.push({ type: 'image_url', image_url: { url: img } });
  const headers = { 'Content-Type': 'application/json' };
  if (ai.apiKey) {
    headers.Authorization = `Bearer ${ai.apiKey}`;
    headers['api-key'] = ai.apiKey;            // Azure OpenAI 호환
  }
  const body = {
    model: ai.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: images && images.length ? content : userText }
    ]
  };
  let json;
  try {
    json = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    // 추론 계열 모델은 temperature 를 거부한다 — 한 번만 빼고 재시도
    if (/temperature/i.test(err.message)) {
      delete body.temperature;
      json = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else throw err;
  }
  const choice = json && json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (msg && Array.isArray(msg.content)) return msg.content.map((c) => c.text || '').join('');
  return (msg && msg.content) || (choice && choice.text) || '';
}

async function callAnthropic(ai, systemPrompt, userText, images) {
  const content = [];
  for (const img of images || []) {
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(img);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: userText });
  const url = resolveEndpoint(ai.endpoint, 'anthropic');
  const json = await httpJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ai.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: ai.model, max_tokens: 2000, system: systemPrompt,
      messages: [{ role: 'user', content }]
    })
  });
  return ((json && json.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function call(ai, systemPrompt, userText, images) {
  if (ai.provider === 'anthropic') return callAnthropic(ai, systemPrompt, userText, images);
  return callOpenAI(ai, systemPrompt, userText, images);
}

/* 서버가 허용하는 모델 목록을 가져온다 (LiteLLM /v1/models) */
export async function listModels(ai) {
  const url = modelsEndpoint(ai.endpoint, ai.provider);
  if (!url) throw new Error('모델 목록 주소를 만들 수 없습니다.');
  const headers = {};
  if (ai.apiKey) {
    if (ai.provider === 'anthropic') { headers['x-api-key'] = ai.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else { headers.Authorization = `Bearer ${ai.apiKey}`; headers['api-key'] = ai.apiKey; }
  }
  const json = await httpJson(url, { method: 'GET', headers }, 15000);
  const rows = (json && (json.data || json.models)) || [];
  return rows.map((m) => (typeof m === 'string' ? m : (m.id || m.model_name || m.name))).filter(Boolean);
}

export async function testConnection(ai) {
  const out = await call(ai, 'Reply with exactly: OK', 'ping', null);
  return String(out).trim().slice(0, 40);
}

/**
 * steps 배열의 title/description 을 다듬어 새 배열로 돌려준다 (원본은 건드리지 않음).
 * getShotDataUrl: (step) => Promise<string|null>  — 이미지 전송을 켠 경우에만 호출된다.
 */
export async function enhanceSteps(steps, settings, { getShotDataUrl, onProgress } = {}) {
  const ai = settings.ai || {};
  if (!ai.provider || ai.provider === 'none') throw new Error('AI 제공자가 설정되어 있지 않습니다.');
  if (ai.provider === 'anthropic' && !ai.apiKey) throw new Error('Anthropic은 API 키가 필요합니다.');
  if (!ai.model) throw new Error('모델 이름이 비어 있습니다.');

  const system = (settings.lang === 'en' ? SYSTEM_EN : SYSTEM_KO) + (ai.extraPrompt ? `\n\n추가 지시:\n${ai.extraPrompt}` : '');
  const chunkSize = ai.includeScreenshots ? 4 : 10;
  const result = steps.map((s) => ({ ...s }));

  for (let i = 0; i < steps.length; i += chunkSize) {
    const slice = steps.slice(i, i + chunkSize);
    const payload = slice.map((s, k) => stepPayload(s, i + k));
    const userText =
      `다음은 웹 화면 조작 기록입니다. 각 항목의 index 를 유지한 채 title 과 description 을 다듬어 주세요.\n` +
      `출력 형식: [{"index": 1, "title": "...", "description": "..."}]\n\n` +
      JSON.stringify(payload, null, 1);

    let images = null;
    if (ai.includeScreenshots && getShotDataUrl) {
      images = [];
      for (const s of slice) {
        const d = await getShotDataUrl(s).catch(() => null);
        if (d) images.push(d);
      }
    }

    const text = await call(ai, system, userText, images);
    const arr = parseJsonArray(text);
    if (arr) {
      for (const item of arr) {
        const idx = (item.index | 0) - 1;
        if (idx >= 0 && idx < result.length) {
          if (item.title) result[idx].title = String(item.title).slice(0, 120);
          if (item.description) result[idx].description = String(item.description).slice(0, 600);
          result[idx].aiEnhanced = true;
        }
      }
    }
    if (onProgress) onProgress(Math.min(i + chunkSize, steps.length), steps.length);
  }
  return result;
}

export { blobToDataURL };
