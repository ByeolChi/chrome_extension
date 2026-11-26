// 환경 간 응답 비교 — 화면과 상관없는 계산
//
// 같은 요청을 여러 환경에 보낸 결과를 기준 환경(맨 앞)과 견준다: 상태 코드, 응답 머리글, 본문.
//   본문이 둘 다 JSON 이면 경로마다 값을 견준다. 숫자는 원문 그대로라 19자리 ID·소수 자릿수도 정확히 견준다.
//   JSON 이 아니면 줄 단위로 견준다(Myers 차이 계산). 바이너리는 바이트가 같은지만 본다.
// 요청마다 달라지는 값(날짜·요청 ID·추적 머리글 등)은 기본으로 빼고, 사용자가 더 뺄 곳을 정할 수 있다.
import { JsonNum, responseContext } from './checks.js';
import { isTextContentType } from './util.js';

/** 요청마다 달라져 견줄 뜻이 없는 응답 머리글 (소문자) */
export const DEFAULT_IGNORE_HEADERS = Object.freeze([
  'date', 'age', 'expires', 'set-cookie', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'x-request-id', 'x-correlation-id', 'request-id', 'x-trace-id', 'traceparent', 'tracestate',
  'x-b3-traceid', 'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled',
  'x-amzn-requestid', 'x-amzn-trace-id', 'x-amz-request-id', 'x-amz-id-2', 'x-amz-cf-id', 'cf-ray',
  'server-timing', 'x-runtime', 'x-response-time', 'x-envoy-upstream-service-time',
]);

export const MAX_DIFFS = 500; // 본문 차이를 이만큼까지만 모은다
const MAX_LINES = 20000; // 줄 비교: 두 본문의 줄 수 합이 이보다 많으면 줄 비교를 하지 않는다
const MAX_D = 800; // 줄 비교: 다른 줄이 이보다 많으면 그만둔다

/* ---------------- 뺄 곳 (본문) ---------------- */

const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 경로 조각 → 글 ($.a.b[0]['c d']) */
export function pathText(toks) {
  return '$' + toks.map((t) => (t.t === 'idx' ? `[${t.v}]` : ID.test(t.v) ? `.${t.v}` : `['${String(t.v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`)).join('');
}

/** 뺄 곳의 식을 조각으로: $.a.b · $.items[*].id · $..updatedAt · $.a.*.b · $['a b'] · $.list[0] */
export function tokenizePattern(p) {
  const s = String(p).trim();
  if (!s.startsWith('$')) throw new Error('$ 로 시작해야 합니다');
  const toks = [];
  let i = 1;
  const name = () => {
    const m = /^[^.[\]]+/.exec(s.slice(i));
    if (!m) throw new Error(`${i + 1}번째 글자 근처를 읽지 못했습니다`);
    i += m[0].length;
    return m[0];
  };
  while (i < s.length) {
    if (s.startsWith('..', i)) {
      toks.push({ t: 'deep' });
      i += 2;
      if (i < s.length && s[i] !== '[') {
        const n = name();
        toks.push(n === '*' ? { t: 'anykey' } : { t: 'key', v: n });
      }
    } else if (s[i] === '.') {
      i += 1;
      const n = name();
      toks.push(n === '*' ? { t: 'anykey' } : { t: 'key', v: n });
    } else if (s[i] === '[') {
      const q = s[i + 1];
      let inner;
      let end;
      if (q === "'" || q === '"') {
        end = i + 2;
        let v = '';
        while (end < s.length && s[end] !== q) {
          if (s[end] === '\\' && end + 1 < s.length) end++;
          v += s[end];
          end++;
        }
        if (s[end + 1] !== ']') throw new Error('따옴표 뒤에 ] 가 없습니다');
        toks.push({ t: 'key', v });
        i = end + 2;
        continue;
      }
      end = s.indexOf(']', i);
      if (end < 0) throw new Error('] 가 없습니다');
      inner = s.slice(i + 1, end).trim();
      if (inner === '*') toks.push({ t: 'anyidx' });
      else if (/^\d+$/.test(inner)) toks.push({ t: 'idx', v: Number(inner) });
      else throw new Error(`[${inner}] 은 쓸 수 없습니다 ([숫자]·[*]·['이름'])`);
      i = end + 1;
    } else {
      throw new Error(`${i + 1}번째 글자 '${s[i]}' 를 읽지 못했습니다`);
    }
  }
  return toks;
}

/**
 * 차이 목록의 경로를 뺄 곳으로: 중간의 배열 번째는 [*] 로 바꿔 다른 번째의 같은 자리도 함께 뺀다 ($.items[0].at → $.items[*].at).
 * 끝의 번째는 그대로 둔다 ($.items[2] 가 [*] 가 되면 배열 전체를 견주지 않게 되므로)
 */
export function ignorePathOf(path) {
  return String(path).replace(/\[\d+\](?!$)/g, '[*]');
}

function matchToks(pt, at, pi = 0, ai = 0) {
  if (pi === pt.length) return ai === at.length;
  const p = pt[pi];
  if (p.t === 'deep') {
    for (let k = ai; k <= at.length; k++) if (matchToks(pt, at, pi + 1, k)) return true;
    return false;
  }
  if (ai >= at.length) return false;
  const a = at[ai];
  const ok = p.t === 'key' ? a.t === 'key' && a.v === p.v
    : p.t === 'anykey' ? a.t === 'key'
      : p.t === 'idx' ? a.t === 'idx' && a.v === p.v
        : p.t === 'anyidx' ? a.t === 'idx' : false;
  return ok && matchToks(pt, at, pi + 1, ai + 1);
}

/**
 * 본문에서 뺄 곳. 한 줄에 하나:
 *   $ 로 시작하면 경로 식 — 그 경로(와 그 아래)를 뺀다. [*] 는 아무 번째, .* 는 아무 이름, .. 는 아무 깊이
 *   아니면 키 이름 — 어느 깊이든 그 이름의 키를 뺀다 (예: updatedAt)
 *   # 로 시작하는 줄과 빈 줄은 건너뛴다
 * 반환 { key(k), path(toks), errors: [{ line, message }] }
 */
export function makeIgnore(lines = []) {
  const keys = new Set();
  const pats = [];
  const errors = [];
  (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/)).forEach((raw, i) => {
    const s = String(raw).trim();
    if (!s || s.startsWith('#')) return;
    if (!s.startsWith('$')) {
      keys.add(s);
      return;
    }
    try {
      pats.push(tokenizePattern(s));
    } catch (e) {
      errors.push({ line: i + 1, text: s, message: e.message });
    }
  });
  return {
    key: (k) => keys.has(k),
    path: (toks) => pats.some((p) => matchToks(p, toks)),
    errors,
    size: keys.size + pats.length,
  };
}

/* ---------------- JSON 견주기 ---------------- */

const MISSING = Symbol('없음');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 값을 짧은 글로 (차이 표에 쓴다) */
export function showValue(v) {
  if (v === undefined || v === MISSING) return '(없음)';
  if (v instanceof JsonNum) return v.text;
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[…] (${v.length}개)`;
  if (isObj(v)) return `{…} (키 ${Object.keys(v).length}개)`;
  return String(v);
}

function sameLeaf(x, y) {
  if (x instanceof JsonNum || y instanceof JsonNum) return x instanceof JsonNum && y instanceof JsonNum && x.text === y.text;
  return x === y;
}

/**
 * 두 JSON 값(parseJson 결과)을 경로마다 견준다.
 * 반환 { diffs: [{ path, kind: 'changed'|'added'|'removed', a, b }], truncated }
 *   added: 기준(a)에는 없고 견줄 쪽(b)에 있음, removed: 기준에는 있고 견줄 쪽에 없음
 */
export function diffJson(a, b, ignore = makeIgnore()) {
  const diffs = [];
  let truncated = false;
  const walk = (x, y, toks, key) => {
    if (diffs.length >= MAX_DIFFS) {
      truncated = true;
      return;
    }
    if (key !== undefined && ignore.key(key)) return;
    if (toks.length && ignore.path(toks)) return;
    if (x === MISSING) return void diffs.push({ path: pathText(toks), kind: 'added', a: undefined, b: y });
    if (y === MISSING) return void diffs.push({ path: pathText(toks), kind: 'removed', a: x, b: undefined });
    if (isObj(x) && isObj(y)) {
      const keys = [...Object.keys(x), ...Object.keys(y).filter((k) => !has(x, k))];
      for (const k of keys) walk(has(x, k) ? x[k] : MISSING, has(y, k) ? y[k] : MISSING, [...toks, { t: 'key', v: k }], k);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) walk(i < x.length ? x[i] : MISSING, i < y.length ? y[i] : MISSING, [...toks, { t: 'idx', v: i }]);
      return;
    }
    if (isObj(x) || isObj(y) || Array.isArray(x) || Array.isArray(y) || !sameLeaf(x, y)) {
      diffs.push({ path: pathText(toks), kind: 'changed', a: x, b: y });
    }
  };
  walk(a, b, []);
  return { diffs, truncated };
}

/* ---------------- 줄 견주기 (Myers) ---------------- */

/**
 * 두 글을 줄 단위로 견준다. 반환 { ops: [{ t: '='|'-'|'+', a?, b? }], changed, tooBig }
 *   '=' 같은 줄(a·b 는 0부터 센 줄 번호), '-' 기준에만 있는 줄, '+' 견줄 쪽에만 있는 줄
 * 줄이 너무 많거나 다른 줄이 너무 많으면 tooBig (ops 없음)
 */
export function diffLines(aText, bText) {
  const A = String(aText ?? '').split(/\r?\n/);
  const B = String(bText ?? '').split(/\r?\n/);
  const d = diffSeq(A, B);
  return d.tooBig ? d : { ...d, a: A, b: B };
}

/** 두 배열(줄, 또는 줄마다 붙인 열쇠)을 견준다. 반환은 diffLines 와 같다 (a·b 없이) */
export function diffSeq(A, B) {
  if (A.length + B.length > MAX_LINES) return { ops: null, changed: null, tooBig: true };
  // 앞뒤의 같은 줄은 미리 떼어 계산을 줄인다
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const mid = myers(a, b, MAX_D);
  if (!mid) return { ops: null, changed: null, tooBig: true };
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: '=', a: i, b: i });
  for (const o of mid) ops.push({ t: o.t, a: o.a === undefined ? undefined : o.a + pre, b: o.b === undefined ? undefined : o.b + pre });
  for (let i = 0; i < suf; i++) ops.push({ t: '=', a: A.length - suf + i, b: B.length - suf + i });
  return { ops, changed: ops.filter((o) => o.t !== '=').length, tooBig: false };
}

function myers(a, b, maxD) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // k = -d-1 … d+1 (이 단계를 거꾸로 따라갈 때 쓴다)
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, N, M);
    }
  }
  return null;
}

function backtrack(trace, N, M) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const T = trace[d];
    const v = (k) => T[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && v(k - 1) < v(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', b: y - 1 });
      else ops.push({ t: '-', a: x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** 줄 차이를 보여 줄 덩어리로: 바뀐 줄 앞뒤 context 줄씩, 떨어진 덩어리 사이는 … */
export function lineHunks(ops, context = 2) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === '=') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const hunks = [];
  let cur = null;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      cur = null;
      return;
    }
    if (!cur) hunks.push((cur = []));
    cur.push(o);
  });
  return hunks;
}

/* ---------------- 나란히 보기 ---------------- */

function leafText(v) {
  if (v instanceof JsonNum) return v.text;
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/**
 * JSON 값을 들여 쓴 줄로 편다. 줄마다 { text, key, mark, ignored }
 *   key: 경로(닫는 괄호 줄은 뒤에 ' end') — 두 쪽 줄을 경로로 맞출 때 쓴다
 *   mark: 그 경로나 그 위가 marks(경로 모음)에 있음 = 이 쪽에서 다른 곳
 *   ignored: 그 경로나 그 위가 뺀 곳
 * limit 줄을 넘으면 거기서 멈추고 truncated: true
 */
export function prettyJsonLines(value, { ignore = makeIgnore(), marks = new Set(), limit = 5000 } = {}) {
  const lines = [];
  let truncated = false;
  const walk = (v, toks, depth, prefix, comma, key, up) => {
    if (lines.length >= limit) {
      truncated = true;
      return;
    }
    const path = pathText(toks);
    const ignored = up.ignored || (key !== undefined && ignore.key(key)) || (toks.length > 0 && ignore.path(toks));
    const mark = !ignored && (up.mark || marks.has(path));
    const pad = '  '.repeat(depth);
    const push = (text, end) => lines.push({ text: pad + text, key: end ? path + ' end' : path, mark, ignored });
    const me = { ignored, mark };
    if (isObj(v) || Array.isArray(v)) {
      const arr = Array.isArray(v);
      const keys = arr ? v.map((_, i) => i) : Object.keys(v);
      if (!keys.length) return void push(prefix + (arr ? '[]' : '{}') + comma);
      push(prefix + (arr ? '[' : '{'));
      keys.forEach((k, i) => {
        const tail = i === keys.length - 1 ? '' : ',';
        if (arr) walk(v[k], [...toks, { t: 'idx', v: k }], depth + 1, '', tail, undefined, me);
        else walk(v[k], [...toks, { t: 'key', v: k }], depth + 1, JSON.stringify(k) + ': ', tail, k, me);
      });
      if (lines.length < limit) push((arr ? ']' : '}') + comma, true);
      else truncated = true;
      return;
    }
    push(prefix + leafText(v) + comma);
  };
  walk(value, [], 0, '', '', undefined, { ignored: false, mark: false });
  return { lines, truncated };
}

/**
 * 나란히 보기의 행: 두 쪽 줄을 같은 열쇠(JSON 은 경로, 글은 줄 자체)끼리 한 행에 맞춘다.
 * left/right: [{ text, key, … }]
 * 반환 { rows: [{ l, r, li, ri }], aligned } — 한쪽에만 있는 줄은 l 이나 r 이 null, li·ri 는 줄 번호(없으면 -1)
 *   지운 줄 뒤에 더한 줄이 이어지면 같은 행에 짝짓는다. 차이가 너무 많아 못 맞추면 aligned: false 이고 줄 번호대로 놓는다
 */
export function sideBySide(left, right) {
  const d = diffSeq(left.map((x) => x.key), right.map((x) => x.key));
  const rows = [];
  if (d.tooBig) {
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) rows.push({ l: left[i] || null, r: right[i] || null, li: i < left.length ? i : -1, ri: i < right.length ? i : -1 });
    return { rows, aligned: false };
  }
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const a = dels[i];
      const b = adds[i];
      rows.push({ l: a === undefined ? null : left[a], r: b === undefined ? null : right[b], li: a === undefined ? -1 : a, ri: b === undefined ? -1 : b });
    }
    dels = [];
    adds = [];
  };
  for (const o of d.ops) {
    if (o.t === '-') {
      if (adds.length) flush();
      dels.push(o.a);
    } else if (o.t === '+') {
      adds.push(o.b);
    } else {
      flush();
      rows.push({ l: left[o.a], r: right[o.b], li: o.a, ri: o.b });
    }
  }
  flush();
  return { rows, aligned: true };
}

/* ---------------- 머리글 견주기 ---------------- */

/** 응답 머리글([{name, value}])을 이름(대소문자 무시)으로 견준다. ignore: 뺄 이름(소문자) */
export function diffHeaders(aHeaders, bHeaders, ignore = new Set(DEFAULT_IGNORE_HEADERS)) {
  const pack = (list) => {
    const m = new Map();
    for (const x of list || []) {
      const k = String(x.name || '').toLowerCase();
      if (!k || ignore.has(k)) continue;
      m.set(k, m.has(k) ? `${m.get(k)}, ${x.value}` : String(x.value ?? ''));
    }
    return m;
  };
  const A = pack(aHeaders);
  const B = pack(bHeaders);
  const out = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    if (!B.has(k)) out.push({ name: k, kind: 'removed', a: A.get(k), b: undefined });
    else if (!A.has(k)) out.push({ name: k, kind: 'added', a: undefined, b: B.get(k) });
    else if (A.get(k) !== B.get(k)) out.push({ name: k, kind: 'changed', a: A.get(k), b: B.get(k) });
  }
  return out;
}

/* ---------------- 응답 둘 견주기 ---------------- */

function sameBytes(a, b) {
  const x = a ? new Uint8Array(a.buffer || a, a.byteOffset || 0, a.byteLength) : new Uint8Array(0);
  const y = b ? new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength) : new Uint8Array(0);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** 본문 견주기. 반환 { mode: 'json'|'text'|'binary', count, … } */
export function diffBodies(base, other, ignore = makeIgnore()) {
  const textual = isTextContentType(base.contentType) && isTextContentType(other.contentType);
  if (!textual) {
    const same = sameBytes(base.body, other.body);
    return { mode: 'binary', count: same ? 0 : 1, same };
  }
  const ca = responseContext(base);
  const cb = responseContext(other);
  let ja;
  let jb;
  let json = true;
  try {
    ja = ca.json();
    jb = cb.json();
  } catch (_) {
    json = false;
  }
  if (json) {
    const { diffs, truncated } = diffJson(ja, jb, ignore);
    return { mode: 'json', diffs, truncated, count: diffs.length };
  }
  const d = diffLines(ca.text(), cb.text());
  return { mode: 'text', ...d, count: d.tooBig ? (ca.text() === cb.text() ? 0 : 1) : d.changed };
}

/**
 * 기준 응답과 견줄 응답 하나를 견준다.
 * opts: { ignoreBody: 줄 목록 또는 글, ignoreHeaders: 이름 목록 (기본 목록에 더한다) }
 * 반환 { failed, status, headers, body, count, same }
 *   failed: 어느 한쪽이라도 응답을 받지 못함 ('base'|'other'|'both')
 */
export function compareResults(base, other, opts = {}) {
  if (!base || !base.ok || !other || !other.ok) {
    const failed = (!base || !base.ok) && (!other || !other.ok) ? 'both' : !base || !base.ok ? 'base' : 'other';
    return { failed, count: 1, same: false };
  }
  const ignoreHeaders = new Set([...DEFAULT_IGNORE_HEADERS, ...(opts.ignoreHeaders || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)]);
  const status = base.status === other.status;
  const headers = diffHeaders(base.headers, other.headers, ignoreHeaders);
  const body = diffBodies(base, other, makeIgnore(opts.ignoreBody || []));
  const count = (status ? 0 : 1) + headers.length + body.count;
  return { failed: null, status, headers, body, count, same: count === 0 };
}
