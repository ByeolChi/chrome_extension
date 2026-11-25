// 응답값 꺼내기(변수로 저장)와 확인(검증): 코드 없이 표로 (Hurl 의 [Captures]·[Asserts] 와 비슷)
// - 요청의 tests = { extract: [꺼내기 줄], assert: [확인 줄] }
// - JSON 은 숫자를 원문 그대로 두는 해석기(parseJson)로 읽는다. 19자리 ID 를 꺼내 다음 요청에 넣어도 값이 바뀌지 않는다
// - JSON 경로는 JSONPath 의 자주 쓰는 부분만: $.a.b  $['a b']  [0]  [-1]  [*]  ..name  [0,2]  [1:3]  [?(@.k == 'v')]
import { parseSetCookie } from './cookiejar.js';
import { uid } from './util.js';

export const CAPTURE_SOURCES = [
  ['json', 'JSON 경로'],
  ['header', '응답 헤더'],
  ['cookie', '응답 쿠키'],
  ['regex', '본문 정규식'],
  ['status', '상태 코드'],
];
export const CAPTURE_SCOPES = [
  ['env', '현재 환경'],
  ['collection', '컬렉션'],
  ['global', '글로벌'],
];
export const ASSERT_TARGETS = [
  ['status', '상태 코드'],
  ['json', 'JSON 경로'],
  ['header', '응답 헤더'],
  ['cookie', '응답 쿠키'],
  ['body', '본문'],
  ['time', '응답 시간 (ms)'],
  ['size', '본문 크기 (바이트)'],
];
export const ASSERT_OPS = [
  ['eq', '='],
  ['ne', '≠'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['contains', '포함'],
  ['not_contains', '포함 안 함'],
  ['matches', '정규식 일치'],
  ['exists', '있음'],
  ['not_exists', '없음'],
  ['type', '타입'],
];
export const VALUE_TYPES = ['string', 'number', 'boolean', 'null', 'array', 'object'];
// 식이 필요 없는 대상과 기대값이 필요 없는 비교
export const NO_EXPR = new Set(['status', 'time', 'size', 'body']);
export const NO_EXPECTED = new Set(['exists', 'not_exists']);

const pick = (list, v, d) => (list.some(([k]) => k === v) ? v : d);

export function newCapture(p = {}) {
  return { id: uid('cap'), enabled: true, name: '', from: 'json', path: '', scope: 'env', ...p };
}

export function newAssert(p = {}) {
  return { id: uid('ast'), enabled: true, target: 'status', path: '', op: 'eq', value: '', ...p };
}

export function normalizeTests(t) {
  const src = t && typeof t === 'object' ? t : {};
  const rows = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []);
  const str = (v) => (v == null ? '' : String(v));
  return {
    extract: rows(src.extract).map((x) => ({
      id: str(x.id) || uid('cap'),
      enabled: x.enabled !== false,
      name: str(x.name),
      from: pick(CAPTURE_SOURCES, x.from, 'json'),
      path: str(x.path),
      scope: pick(CAPTURE_SCOPES, x.scope, 'env'),
    })),
    assert: rows(src.assert).map((x) => ({
      id: str(x.id) || uid('ast'),
      enabled: x.enabled !== false,
      target: pick(ASSERT_TARGETS, x.target, 'status'),
      path: str(x.path),
      op: pick(ASSERT_OPS, x.op, 'eq'),
      value: str(x.value),
    })),
  };
}

/** 켜져 있는 줄 수 (요청 탭의 숫자 표시) */
export function countTests(t) {
  if (!t) return 0;
  return (t.extract || []).filter((x) => x.enabled && x.name).length + (t.assert || []).filter((x) => x.enabled).length;
}

/* ------------------------------------------------------------------ */
/* 숫자를 원문 그대로 두는 JSON                                           */
/* ------------------------------------------------------------------ */

/** JSON 숫자. 원문(text)을 그대로 둔다 (1234567890123456789, 1.10, 1e400 등) */
export class JsonNum {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const STR_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUM_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** JSON 해석. 객체는 프로토타입 없는 객체(키 '__proto__' 도 그냥 키), 숫자는 JsonNum */
export function parseJson(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  let i = 0;
  const fail = (m) => {
    throw new SyntaxError(`${m} (${i + 1}번째 글자)`);
  };
  const ws = () => {
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    }
  };
  const str = () => {
    STR_RE.lastIndex = i;
    const m = STR_RE.exec(s);
    if (!m) fail('문자열이 올바르지 않습니다');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const value = (depth) => {
    if (depth > 1000) fail('너무 깊게 중첩되어 있습니다');
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const o = Object.create(null);
      ws();
      if (s[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (s[i] !== '"') fail('키가 있어야 합니다');
        const k = str();
        ws();
        if (s[i] !== ':') fail("':' 가 있어야 합니다");
        i++;
        o[k] = value(depth + 1);
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '}') {
          i++;
          return o;
        }
        fail("',' 나 '}' 가 있어야 합니다");
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (s[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return a;
        }
        fail("',' 나 ']' 가 있어야 합니다");
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (s.startsWith('null', i)) {
      i += 4;
      return null;
    }
    NUM_TOKEN.lastIndex = i;
    const m = NUM_TOKEN.exec(s);
    if (m && m[0]) {
      i += m[0].length;
      return new JsonNum(m[0]);
    }
    return fail(i >= s.length ? '내용이 끝났습니다' : '값이 있어야 합니다');
  };
  const v = value(0);
  ws();
  if (i < s.length) fail('JSON 뒤에 다른 글자가 있습니다');
  return v;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** JSON 글 (숫자는 원문 그대로). sortKeys: 비교용으로 키 순서를 맞춤 */
export function toJsonText(v, sortKeys = false) {
  if (v instanceof JsonNum) return v.text;
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => toJsonText(x, sortKeys)).join(',') + ']';
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (sortKeys) keys.sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + toJsonText(v[k], sortKeys)).join(',') + '}';
  }
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}

/** 변수에 넣을 글: 문자열은 그대로, 숫자는 원문, 객체·배열은 JSON */
export function valueText(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v instanceof JsonNum) return v.text;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return toJsonText(v);
}

export function typeOf(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof JsonNum || typeof v === 'number') return 'number';
  if (isObj(v)) return 'object';
  return typeof v;
}

/** 결과 화면에 보일 값 (문자열은 따옴표) */
export function displayValue(v, max = 300) {
  if (v === undefined) return '(없음)';
  const t = typeof v === 'string' ? JSON.stringify(v) : valueText(v);
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/* ------------------------------------------------------------------ */
/* JSONPath (자주 쓰는 부분)                                              */
/* ------------------------------------------------------------------ */

const pathCache = new Map();

function parsePath(path) {
  let p = String(path ?? '').trim();
  if (!p) throw new Error('JSON 경로를 넣으세요 (예: $.data.token)');
  if (pathCache.has(p)) return pathCache.get(p);
  const src = p;
  if (p[0] !== '$') p = (p[0] === '[' ? '$' : '$.') + p;
  const segs = [];
  let i = 1;
  const ident = () => {
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    const name = p.slice(i, j).trim();
    if (!name) throw new Error(`JSON 경로에서 이름이 빠졌습니다: ${src}`);
    i = j;
    return name;
  };
  const bracket = () => {
    // 따옴표와 괄호를 건너뛰며 짝이 맞는 ']' 를 찾는다
    let j = i + 1;
    let q = '';
    let depth = 0;
    for (; j < p.length; j++) {
      const c = p[j];
      if (q) {
        if (c === '\\') j++;
        else if (c === q) q = '';
      } else if (c === "'" || c === '"') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ']' && depth <= 0) break;
    }
    if (j >= p.length) throw new Error(`JSON 경로의 '[' 가 닫히지 않았습니다: ${src}`);
    const inner = p.slice(i + 1, j).trim();
    i = j + 1;
    return selector(inner, src);
  };
  while (i < p.length) {
    if (p.startsWith('..', i)) {
      i += 2;
      if (p[i] === '[') segs.push({ deep: true, ...bracket() });
      else {
        const name = ident();
        segs.push(name === '*' ? { deep: true, kind: 'all' } : { deep: true, kind: 'union', items: [{ name }] });
      }
    } else if (p[i] === '.') {
      i++;
      const name = ident();
      segs.push(name === '*' ? { kind: 'all' } : { kind: 'union', items: [{ name }] });
    } else if (p[i] === '[') {
      segs.push(bracket());
    } else throw new Error(`JSON 경로를 읽을 수 없습니다: ${src}`);
  }
  if (pathCache.size > 500) pathCache.clear();
  pathCache.set(src, segs);
  return segs;
}

const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    const body = t.slice(1, -1);
    return t[0] === '"' ? JSON.parse(t) : body.replace(/\\(.)/g, '$1');
  }
  return null;
};

function selector(inner, src) {
  if (inner === '*') return { kind: 'all' };
  if (inner[0] === '?') {
    const m = inner.match(/^\?\s*\(([\s\S]*)\)$/);
    if (!m) throw new Error(`JSON 경로의 조건은 [?(@.키 == 값)] 모양이어야 합니다: ${src}`);
    return { kind: 'filter', filter: parseFilter(m[1], src) };
  }
  const sl = inner.match(/^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d*))?$/);
  if (sl) return { kind: 'slice', start: sl[1] === '' ? null : Number(sl[1]), end: sl[2] === '' ? null : Number(sl[2]), step: sl[3] ? Number(sl[3]) : 1 };
  // 쉼표로 나눈 목록 (따옴표 안의 쉼표는 그대로)
  const items = [];
  let cur = '';
  let q = '';
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (q) {
      cur += c;
      if (c === '\\' && k + 1 < inner.length) cur += inner[++k];
      else if (c === q) q = '';
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  items.push(cur);
  return {
    kind: 'union',
    items: items.map((it) => {
      const name = unquote(it);
      if (name !== null) return { name };
      const t = it.trim();
      if (/^-?\d+$/.test(t)) return { index: Number(t) };
      if (/^[^\s'"()]+$/.test(t)) return { name: t };
      throw new Error(`JSON 경로의 [ ] 안을 읽을 수 없습니다: ${src}`);
    }),
  };
}

const FILTER_OPS = ['==', '!=', '>=', '<=', '=~', '>', '<'];

function parseFilter(expr, src) {
  const e = expr.trim();
  if (e[0] !== '@') throw new Error(`JSON 경로의 조건은 @ 로 시작해야 합니다: ${src}`);
  let opAt = -1;
  let op = '';
  let q = '';
  for (let k = 1; k < e.length && opAt < 0; k++) {
    const c = e[k];
    if (q) {
      if (c === '\\') k++;
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    for (const o of FILTER_OPS) {
      if (e.startsWith(o, k)) {
        opAt = k;
        op = o;
        break;
      }
    }
  }
  const rel = (opAt < 0 ? e : e.slice(0, opAt)).trim().slice(1);
  const path = rel ? parsePath('$' + (rel[0] === '.' || rel[0] === '[' ? rel : '.' + rel)) : [];
  if (opAt < 0) return { path, op: 'exists' };
  const raw = e.slice(opAt + op.length).trim();
  if (op === '=~') {
    const rm = raw.match(/^\/([\s\S]*)\/([a-z]*)$/);
    return { path, op, re: rm ? new RegExp(rm[1], rm[2]) : new RegExp(unquote(raw) ?? raw) };
  }
  const str = unquote(raw);
  return { path, op, rhs: str !== null ? JSON.stringify(str) : raw };
}

function children(node) {
  if (Array.isArray(node)) return node;
  if (isObj(node)) return Object.keys(node).map((k) => node[k]);
  return [];
}

function* selfAndDescendants(node) {
  yield node;
  for (const c of children(node)) yield* selfAndDescendants(c);
}

function evalSegs(root, segs) {
  let nodes = [root];
  for (const seg of segs) {
    const out = [];
    const apply = (node) => {
      if (seg.kind === 'all') out.push(...children(node));
      else if (seg.kind === 'union') {
        for (const it of seg.items) {
          if ('index' in it) {
            if (Array.isArray(node)) {
              const k = it.index < 0 ? node.length + it.index : it.index;
              if (k >= 0 && k < node.length) out.push(node[k]);
            }
          } else if (isObj(node) && has(node, it.name)) out.push(node[it.name]);
          else if (Array.isArray(node) && it.name === 'length') out.push(new JsonNum(String(node.length)));
        }
      } else if (seg.kind === 'slice') {
        if (!Array.isArray(node)) return;
        const n = node.length;
        const step = seg.step || 1;
        if (step <= 0) return;
        const norm = (v, d) => (v == null ? d : v < 0 ? Math.max(0, n + v) : Math.min(n, v));
        for (let k = norm(seg.start, 0); k < norm(seg.end, n); k += step) out.push(node[k]);
      } else if (seg.kind === 'filter') {
        for (const c of children(node)) if (testFilter(seg.filter, c)) out.push(c);
      }
    };
    for (const node of nodes) {
      if (seg.deep) for (const d of selfAndDescendants(node)) apply(d);
      else apply(node);
    }
    nodes = out;
  }
  return nodes;
}

function testFilter(f, node) {
  const vals = f.path.length ? evalSegs(node, f.path) : [node];
  if (f.op === 'exists') return vals.length > 0 && vals.some((v) => v !== null && v !== false);
  return vals.some((v) => {
    if (f.op === '=~') return f.re.test(valueText(v));
    const r = compare({ '==': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[f.op], v, f.rhs);
    return r.ok;
  });
}

/** JSONPath 로 찾은 값들 (없으면 빈 배열) */
export function jsonPath(root, path) {
  return evalSegs(root, parsePath(path));
}

/* ------------------------------------------------------------------ */
/* 비교                                                                 */
/* ------------------------------------------------------------------ */

const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function numberText(v) {
  if (v instanceof JsonNum) return v.text;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && NUM_RE.test(v.trim())) return v.trim();
  return null;
}

// 정수끼리는 자릿수가 많아도 정확히(BigInt), 그 밖에는 Number 로 비교
function cmpNumbers(a, b) {
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a);
  const y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// 기대값 글: "따옴표" 로 감싸면 그 안의 문자열(앞뒤 공백 포함), 아니면 앞뒤 공백을 뺀 글
function expectedString(text) {
  const t = String(text ?? '').trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try {
      return JSON.parse(t);
    } catch (e) {
      /* 그대로 */
    }
  }
  return t;
}

function equals(actual, expectedText) {
  const t = String(expectedText ?? '').trim();
  if (actual instanceof JsonNum || typeof actual === 'number') {
    const a = numberText(actual);
    return NUM_RE.test(t) ? cmpNumbers(a, t) === 0 : a === expectedString(t);
  }
  if (typeof actual === 'boolean' || actual === null) return String(actual) === t;
  if (typeof actual === 'string') return actual === expectedString(t);
  // 배열·객체: 같은 JSON 인지 (키 순서는 따지지 않음)
  try {
    return toJsonText(actual, true) === toJsonText(parseJson(t), true);
  } catch (e) {
    return toJsonText(actual) === t;
  }
}

function regexOf(text) {
  const t = String(text ?? '');
  const m = t.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
  return m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(t);
}

/**
 * 확인 하나. actual: 응답에서 찾은 값(없으면 undefined), expected: 사용자가 넣은 기대값 글
 * 반환 { ok, message }
 */
export function compare(op, actual, expected) {
  if (op === 'exists') return { ok: actual !== undefined, message: actual === undefined ? '값이 없습니다' : '' };
  if (op === 'not_exists') return { ok: actual === undefined, message: actual === undefined ? '' : '값이 있습니다' };
  if (actual === undefined) return { ok: false, message: '값이 없습니다' };
  const exp = String(expected ?? '');
  switch (op) {
    case 'eq':
      return { ok: equals(actual, exp), message: '' };
    case 'ne':
      return { ok: !equals(actual, exp), message: '' };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = numberText(actual);
      const b = exp.trim();
      if (a === null) return { ok: false, message: '찾은 값이 숫자가 아닙니다' };
      if (!NUM_RE.test(b)) return { ok: false, message: '기대값이 숫자가 아닙니다' };
      const c = cmpNumbers(a, b);
      return { ok: op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0, message: '' };
    }
    case 'contains':
    case 'not_contains': {
      let hit;
      if (Array.isArray(actual)) hit = actual.some((x) => equals(x, exp));
      else if (isObj(actual)) hit = has(actual, expectedString(exp));
      else hit = valueText(actual).includes(expectedString(exp));
      return { ok: op === 'contains' ? hit : !hit, message: '' };
    }
    case 'matches': {
      let re;
      try {
        re = regexOf(exp.trim());
      } catch (e) {
        return { ok: false, message: '정규식이 올바르지 않습니다: ' + e.message };
      }
      return { ok: re.test(valueText(actual)), message: '' };
    }
    case 'type': {
      const want = exp.trim().toLowerCase();
      if (!VALUE_TYPES.includes(want)) return { ok: false, message: `타입은 ${VALUE_TYPES.join(' · ')} 중 하나로 넣으세요` };
      return { ok: typeOf(actual) === want, message: '' };
    }
    default:
      return { ok: false, message: '알 수 없는 비교입니다' };
  }
}

/* ------------------------------------------------------------------ */
/* 응답에서 값 찾기 · 실행                                                */
/* ------------------------------------------------------------------ */

/** 응답 결과(http.js·curl-runner.js 의 result)를 감싸 본문 글·JSON 을 한 번만 해석한다 */
export function responseContext(result) {
  let text;
  let json;
  let jsonError = null;
  return {
    result,
    text() {
      if (text === undefined) {
        const charset = ((result.contentType || '').match(/charset=([^;]+)/i) || [])[1];
        try {
          text = new TextDecoder((charset || 'utf-8').trim().replace(/"/g, '')).decode(result.body || new Uint8Array(0));
        } catch (e) {
          text = new TextDecoder('utf-8').decode(result.body || new Uint8Array(0));
        }
      }
      return text;
    },
    json() {
      if (json === undefined && !jsonError) {
        try {
          json = parseJson(this.text());
        } catch (e) {
          jsonError = new Error('본문이 JSON 이 아닙니다: ' + e.message);
        }
      }
      if (jsonError) throw jsonError;
      return json;
    },
  };
}

function headerValue(result, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) throw new Error('헤더 이름을 넣으세요');
  const vals = (result.headers || []).filter((x) => String(x.name).toLowerCase() === n).map((x) => String(x.value ?? ''));
  return vals.length ? vals.join(n === 'set-cookie' ? '\n' : ', ') : undefined;
}

function cookieValue(result, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('쿠키 이름을 넣으세요');
  let found;
  // 리다이렉트 중간에 받은 쿠키 → 마지막 응답의 쿠키 순서로, 나중 것이 이김
  const all = [...(result.hopCookies || []).map((c) => [c.value, c.url]), ...(result.setCookies || []).map((v) => [v, result.url])];
  for (const [header, url] of all) {
    const c = parseSetCookie(header, url || result.url);
    if (c && c.name === n) found = c.value;
  }
  return found;
}

/** 대상(from/target)과 식으로 응답에서 값을 찾는다. 없으면 undefined, 식이 틀리면 예외 */
export function findValue(kind, expr, ctx) {
  const r = ctx.result;
  switch (kind) {
    case 'status':
      return r.status;
    case 'time':
      return Math.round((r.timing && r.timing.total) || 0);
    case 'size':
      return (r.size && r.size.body) || 0;
    case 'body':
      return ctx.text();
    case 'header':
      return headerValue(r, expr);
    case 'cookie':
      return cookieValue(r, expr);
    case 'json': {
      const found = jsonPath(ctx.json(), expr);
      return found.length === 0 ? undefined : found.length === 1 ? found[0] : found;
    }
    case 'regex': {
      if (!String(expr || '').trim()) throw new Error('정규식을 넣으세요');
      let re;
      try {
        re = regexOf(expr);
      } catch (e) {
        throw new Error('정규식이 올바르지 않습니다: ' + e.message);
      }
      const m = re.exec(ctx.text());
      if (!m) return undefined;
      return m.length > 1 ? m[1] ?? '' : m[0];
    }
    default:
      throw new Error('알 수 없는 대상입니다');
  }
}

/**
 * 꺼내기: 켜져 있고 이름이 있는 줄마다 값을 찾는다 (저장은 부르는 쪽이)
 * resolve: {{변수}} 를 바꾸는 함수
 * 반환 [{ id, name, from, path, scope, ok, value, error }]
 */
export function runCaptures(rows, ctx, resolve = (s) => s) {
  return (rows || [])
    .filter((x) => x.enabled && String(x.name || '').trim())
    .map((x) => {
      const base = { id: x.id, name: resolve(x.name).trim(), from: x.from, path: resolve(x.path), scope: x.scope };
      try {
        const v = findValue(x.from, base.path, ctx);
        if (v === undefined) return { ...base, ok: false, error: '응답에서 값을 찾지 못했습니다' };
        return { ...base, ok: true, value: valueText(v) };
      } catch (e) {
        return { ...base, ok: false, error: e.message };
      }
    });
}

/**
 * 확인: 켜져 있는 줄마다 비교한다
 * 반환 [{ id, target, path, op, expected, actual, ok, message }]
 */
export function runAsserts(rows, ctx, resolve = (s) => s) {
  return (rows || [])
    .filter((x) => x.enabled)
    .map((x) => {
      const base = { id: x.id, target: x.target, path: NO_EXPR.has(x.target) ? '' : resolve(x.path), op: x.op, expected: NO_EXPECTED.has(x.op) ? '' : resolve(x.value) };
      let actual;
      try {
        actual = findValue(x.target, base.path, ctx);
      } catch (e) {
        return { ...base, actual: '(없음)', ok: false, message: e.message };
      }
      const r = compare(x.op, actual, base.expected);
      return { ...base, actual: displayValue(actual), ok: r.ok, message: r.message };
    });
}

/** 확인 한 줄을 사람이 읽는 글로 (결과 화면·러너) */
export function describeAssert(a) {
  const target = (ASSERT_TARGETS.find(([k]) => k === a.target) || [])[1] || a.target;
  const op = (ASSERT_OPS.find(([k]) => k === a.op) || [])[1] || a.op;
  return [target, a.path, op, NO_EXPECTED.has(a.op) ? '' : a.expected].filter((x) => x !== '' && x != null).join(' ');
}
