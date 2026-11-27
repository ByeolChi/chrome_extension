// 응답 도구 — 화면과 상관없는 계산
//   JSONPath 필터: 응답 JSON 에서 경로에 맞는 값만 (숫자는 원문 그대로, Tests 탭과 같은 경로 문법)
//   찾기: 본문 글에서 찾은 곳들 (글자 그대로 / 정규식, 대소문자)
//   큰 응답: 화면에 한 번에 그리는 구간 (줄 단위로 자르고, 찾은 곳이 보이게 옮김)
//   응답 예제: 받은 응답을 요청에 붙여 저장할 모양으로 (비밀 변수 값·쿠키 값·인증 머리글 값은 가림),
//             저장한 예제를 응답 화면·비교가 쓰는 결과 모양으로
import { jsonPath, isDefinitePath, toJsonText, JsonNum, responseContext } from './checks.js';
import { formatJson } from './json-format.js';
import { uid, isTextContentType, formatBytes, STATUS_TEXT } from './util.js';
import { redactSecrets, MASK } from './secrets.js';

export const VIEW_MAX = 5 * 1024 * 1024; // 화면에 한 번에 그리는 본문 글자 수
export const EXAMPLE_MAX_BYTES = 1024 * 1024; // 예제로 저장할 수 있는 본문 크기
export const EXAMPLES_MAX = 100; // 요청 하나에 두는 예제 수
const FIND_MAX = 100000; // 찾은 곳을 이만큼까지 센다

/* ---------------- JSONPath 필터 ---------------- */

/**
 * 응답 JSON(parseJson 결과)을 경로로 거른다.
 * 값 하나를 가리키는 경로($.data.id)면 그 값, 여럿일 수 있는 경로($.items[*].id · $..id · 조건)면 늘 배열.
 * 반환 { ok: true, count, text(들여 쓴 JSON, 없으면 ''), definite, value } | { ok: false, error }
 */
export function filterJson(json, path) {
  let definite;
  let found;
  try {
    definite = isDefinitePath(path);
    found = jsonPath(json, path);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!found.length) return { ok: true, count: 0, text: '', definite, value: undefined };
  const value = definite ? found[0] : found;
  return { ok: true, count: found.length, text: prettyValue(value), definite, value };
}

function prettyValue(v) {
  const t = toJsonText(v);
  try {
    return formatJson(t, 2);
  } catch (e) {
    return t;
  }
}

/**
 * 걸러 낸 결과로 Tests 탭의 확인 한 줄: 값 하나(200자 이하 글·숫자·참거짓·null)면 "=" 지금 값, 아니면 "있음".
 * 앞뒤 공백이 있거나 따옴표로 싼 글은 "따옴표" 로 감싸 그대로 비교되게 한다
 */
export function assertFromFilter(path, f) {
  const p = String(path || '').trim();
  const v = f && f.ok && f.definite && f.count === 1 ? f.value : undefined;
  let value = null;
  if (typeof v === 'string' && v.length <= 200) {
    const plain = v !== '' && v.trim() === v && !(v.startsWith('"') && v.endsWith('"'));
    value = plain ? v : JSON.stringify(v);
  } else if (v instanceof JsonNum) value = v.text;
  else if (typeof v === 'boolean' || (v === null && f && f.count === 1)) value = String(v);
  return value === null ? { target: 'json', path: p, op: 'exists', value: '' } : { target: 'json', path: p, op: 'eq', value };
}

/** 경로 끝의 이름 — 꺼내기 줄에 넣을 변수 이름의 처음 값 ($.data.token → token, $.items[*].id → id) */
export function suggestVarName(path) {
  let p = String(path || '').trim();
  for (;;) {
    const quoted = p.match(/\[\s*(['"])([A-Za-z_]\w*)\1\s*\]$/);
    if (quoted) return quoted[2];
    const bracket = p.match(/\[[^\]]*\]$/);
    if (bracket) {
      p = p.slice(0, -bracket[0].length);
      continue;
    }
    if (/\.length$/.test(p)) {
      p = p.slice(0, -'.length'.length);
      continue;
    }
    break;
  }
  const m = p.match(/(?:^|\.)([A-Za-z_]\w*)$/);
  return m ? m[1] : '';
}

/* ---------------- 찾기 ---------------- */

/**
 * 글에서 찾은 곳들. 기본은 대소문자를 가리지 않는 글자 그대로 찾기.
 * regex: 정규식(줄마다 ^ $), 빈 길이로 맞는 곳은 건너뜀. max 개를 넘으면 거기서 멈추고 capped
 * 반환 { ranges: [[시작, 끝]], capped, error }
 */
export function findMatches(text, query, { caseSensitive = false, regex = false, max = FIND_MAX } = {}) {
  const q = String(query ?? '');
  const out = { ranges: [], capped: false, error: '' };
  if (!q) return out;
  const s = String(text ?? '');
  if (!regex && caseSensitive) {
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
      if (out.ranges.length >= max) {
        out.capped = true;
        break;
      }
      out.ranges.push([i, i + q.length]);
    }
    return out;
  }
  let re;
  try {
    re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (regex ? 'm' : '') + (caseSensitive ? '' : 'i'));
  } catch (e) {
    return { ...out, error: '정규식이 올바르지 않습니다: ' + e.message };
  }
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (out.ranges.length >= max) {
      out.capped = true;
      break;
    }
    out.ranges.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/* ---------------- 큰 응답: 보이는 구간 ---------------- */

/**
 * 화면에 그릴 구간 [start, end). 글이 size 보다 짧으면 전체.
 * 줄 처음에서 시작하고, 줄바꿈 앞에서 끝난다(한 줄이 size 보다 길면 그냥 자름). 다음 구간은 end + 1 부터.
 * focus(찾은 곳 등)가 지금 구간(start 부터) 밖이면 그곳을 가운데로 옮긴다.
 * 반환 { start, end, line(start 의 줄 번호, 1부터) }
 */
export function viewWindow(text, { start = 0, focus = null, size = VIEW_MAX } = {}) {
  const s = String(text ?? '');
  const n = s.length;
  if (n <= size) return { start: 0, end: n, line: 1 };
  let st = lineStartAt(s, Math.max(0, Math.min(Number(start) || 0, n - 1)));
  if (focus != null) {
    const f = Math.max(0, Math.min(Number(focus) || 0, n));
    if (f < st || f >= endOf(s, st, size)) st = lineStartAt(s, Math.max(0, f - Math.floor(size / 2)));
  }
  return { start: st, end: endOf(s, st, size), line: lineAt(s, st) };
}

function lineStartAt(s, i) {
  return i <= 0 ? 0 : s.lastIndexOf('\n', i - 1) + 1;
}

function endOf(s, st, size) {
  if (s.length - st <= size) return s.length;
  const nl = s.lastIndexOf('\n', st + size);
  return nl > st ? nl : st + size;
}

/** offset 이 있는 줄의 번호 (1부터) */
export function lineAt(text, offset) {
  const s = String(text ?? '');
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0 && i < offset; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/* ---------------- 응답 예제 ---------------- */

// 값을 직접 담는 인증 머리글 (응답에 있으면 예제에는 값을 가려서 둔다)
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token', 'x-access-token']);

const toBytes = (b) => (b instanceof Uint8Array ? b : b ? new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength) : new Uint8Array(0));

/** 바이트가 글처럼 보이는가 (NUL 이 없고 제어 문자가 드묾) */
export function looksTextual(bytes) {
  const b = toBytes(bytes);
  const n = Math.min(b.length, 512);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.05;
}

function isTextual(result) {
  const ct = String(result.contentType || '').trim();
  return ct ? isTextContentType(ct) : looksTextual(result.body);
}

/** 글 본문을 UTF-8 로 다시 담을 때의 Content-Type (charset 이 있으면 utf-8 로) */
function utf8ContentType(ct) {
  return String(ct || '').replace(/charset=("?)[^;"]*\1/i, 'charset=utf-8');
}

const statusLine = (r) => `${r.status || ''} ${r.statusText || STATUS_TEXT[r.status] || ''}`.trim();

/** Set-Cookie 머리글의 쿠키 값만 가린다 (이름·속성은 둠, 값이 빈 지우기 쿠키는 그대로) */
export function maskSetCookie(v) {
  return String(v ?? '').replace(/^([^=;]*=)([^;]*)/, (all, k, val) => (val.trim() ? k + MASK : all));
}

// 머리글·본문에서 가릴 것을 가린다. 반환 { headers, body(글), masked: 가린 것 이름들 }
function maskParts(result, secrets) {
  const vals = [...(secrets || [])];
  let secretHit = false;
  let cookieHit = false;
  const headerHits = [];
  const headers = (result.headers || []).map((x) => {
    const name = String(x.name ?? '');
    let value = String(x.value ?? '');
    const lower = name.toLowerCase();
    if (lower === 'set-cookie') {
      const v = maskSetCookie(value);
      if (v !== value) cookieHit = true;
      value = v;
    } else if (CREDENTIAL_HEADERS.has(lower) && value.trim() && value !== MASK) {
      value = MASK;
      if (!headerHits.includes(name)) headerHits.push(name);
    }
    const v = redactSecrets(value, vals);
    if (v !== value) secretHit = true;
    return { name, value: v };
  });
  const text = responseContext(result).text();
  const body = redactSecrets(text, vals);
  if (body !== text) secretHit = true;
  const masked = [];
  if (secretHit) masked.push('비밀 변수 값');
  if (cookieHit) masked.push('Set-Cookie 값');
  for (const n of headerHits) masked.push(`${n} 머리글 값`);
  return { headers, body, masked };
}

/** 이 응답을 예제로 저장할 수 없는 까닭 (되면 '') — 이름을 묻거나 요청을 저장하기 전에 먼저 알린다 */
export function exampleProblem(result) {
  if (!result || !result.ok) return '응답을 받은 뒤에 예제로 저장할 수 있습니다.';
  if (!isTextual(result)) return '바이너리 응답(이미지·파일 등)은 예제로 저장할 수 없습니다.';
  const n = toBytes(result.body).byteLength;
  if (n > EXAMPLE_MAX_BYTES) return `본문이 ${formatBytes(n)} 라 예제로 저장할 수 없습니다 (1MB 까지).`;
  return '';
}

/**
 * 받은 응답(result)을 예제로. 본문은 받은 글 그대로 둔다(19자리 숫자·들여쓰기 그대로).
 * secrets: 비밀 변수 값들 — 본문·머리글에 있으면 •••• 로. Set-Cookie 의 쿠키 값과 인증 머리글 값도 가린다.
 * request: { method, url } 보낸 요청(변수 그대로)
 * 반환 { example, masked: ['비밀 변수 값', 'Set-Cookie 값', 'X-Auth-Token 머리글 값'] }
 * 응답이 없거나, 바이너리이거나, 본문이 1MB 를 넘으면 Error (사용자에게 보일 글)
 */
export function makeExample(result, { name = '', secrets = [], request = null, now = Date.now() } = {}) {
  const problem = exampleProblem(result);
  if (problem) throw new Error(problem);
  const bytes = toBytes(result.body);
  const m = maskParts(result, secrets);
  const example = {
    id: uid('ex'),
    name: String(name || '').trim() || statusLine(result) || '예제',
    savedAt: now,
    status: Number(result.status) || 0,
    statusText: result.statusText || '',
    headers: m.headers,
    contentType: result.contentType || '',
    body: m.body,
    size: bytes.byteLength,
    time: Math.round((result.timing && result.timing.total) || 0),
  };
  if (request) example.request = { method: String(request.method || 'GET').toUpperCase(), url: String(request.url || '') };
  return { example, masked: m.masked };
}

/**
 * 견주기 전에 지금 응답도 예제와 같은 방식으로 가린다(비밀 값·쿠키 값·인증 머리글 값).
 * 가린 예제와 진짜 값이 든 응답이 가린 자리 때문에 다르다고 나오지 않게, 비교 화면에 비밀 값이 드러나지 않게.
 * 바이너리 응답은 그대로 돌려준다
 */
export function maskResult(result, secrets = []) {
  if (!result || !result.ok || !isTextual(result)) return result;
  const m = maskParts(result, secrets);
  const body = new TextEncoder().encode(m.body);
  return {
    ...result,
    headers: m.headers,
    contentType: utf8ContentType(result.contentType),
    body,
    setCookies: (result.setCookies || []).map(maskSetCookie),
    size: { ...(result.size || {}), body: body.byteLength },
  };
}

/** 저장한 예제를 응답 화면·비교가 쓰는 결과 모양으로 (result.example 에 예제 정보) */
export function exampleAsResult(ex) {
  const body = new TextEncoder().encode(String(ex.body ?? ''));
  const headers = (ex.headers || []).map((x) => ({ name: String(x.name ?? ''), value: String(x.value ?? '') }));
  return {
    ok: true,
    example: { id: ex.id, name: ex.name, savedAt: ex.savedAt },
    status: ex.status,
    statusText: ex.statusText || STATUS_TEXT[ex.status] || '',
    statusLine: '',
    headers,
    contentType: utf8ContentType(ex.contentType || ''),
    body,
    setCookies: headers.filter((x) => x.name.toLowerCase() === 'set-cookie').map((x) => x.value),
    size: { body: body.byteLength, headers: headers.reduce((n, x) => n + x.name.length + x.value.length + 4, 0) },
    timing: { total: ex.time || 0 },
    url: '',
    sentUrl: ex.request ? ex.request.url : '',
    method: ex.request ? ex.request.method : '',
    engine: 'example',
    hops: [],
    warnings: [],
  };
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => {
  const s = typeof v === 'string' ? v : v == null || typeof v === 'object' ? '' : String(v);
  return max ? s.slice(0, max) : s;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** 백업·가져오기의 예제 목록을 정리한다: 깨진 줄은 빼고, 형식을 맞추고, 본문이 1MB 를 넘는 것은 뺀다 */
export function normalizeExamples(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (out.length >= EXAMPLES_MAX) break;
    if (!isObj(x)) continue;
    const body = typeof x.body === 'string' ? x.body : '';
    if (body.length > EXAMPLE_MAX_BYTES) continue;
    const st = parseInt(x.status, 10);
    const ex = {
      id: typeof x.id === 'string' && x.id ? x.id.slice(0, 64) : uid('ex'),
      name: str(x.name, 200).trim() || '예제',
      savedAt: num(x.savedAt) ?? 0,
      status: st >= 0 && st <= 999 ? st : 0,
      statusText: str(x.statusText, 200),
      headers: (Array.isArray(x.headers) ? x.headers : [])
        .filter((hd) => isObj(hd) && typeof hd.name === 'string' && hd.name.trim())
        .slice(0, 300)
        .map((hd) => ({ name: hd.name.slice(0, 1000), value: str(hd.value, 20000) })),
      contentType: str(x.contentType, 300),
      body,
      size: num(x.size) ?? new TextEncoder().encode(body).byteLength,
      time: Math.round(num(x.time) ?? 0),
    };
    if (isObj(x.request)) ex.request = { method: str(x.request.method, 20).toUpperCase() || 'GET', url: str(x.request.url, 10000) };
    out.push(ex);
  }
  return out;
}
