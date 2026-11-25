// YAML 읽기 (OpenAPI 문서용, 외부 라이브러리 없이)
// YAML 1.2 core 스키마에서 자주 쓰는 부분만 읽는다:
//   블록 매핑·시퀀스, 흐름 모음 [ ] { } (여러 줄 가능), 따옴표 문자열 " ' (여러 줄·이스케이프), 블록 문자열 | > (+ - 숫자 표시),
//   주석 #, 앵커 & · 별칭 * · 병합 키 <<, !!str 태그. 문서가 여럿이면 첫 문서만 읽는다.
// 복잡한 키(?)는 지원하지 않는다. 그 밖의 태그(!foo 등)는 무시한다.
// 19자리처럼 JavaScript 숫자로 정확히 담을 수 없는 정수는 원문 그대로(JsonNum) 둔다.
import { JsonNum } from './checks.js';

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (${line}번째 줄)` : message);
    this.line = line || 0;
  }
}

// 따옴표 밖의 '#'(앞이 공백이거나 줄 처음)부터 주석. 따옴표는 값이 시작하는 자리에서만 연다 (it's 같은 글은 그대로)
function stripComment(r) {
  let q = '';
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) {
        if (q === "'" && r[i + 1] === "'") i++;
        else q = '';
      }
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,]/.test(r[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(r[i - 1]))) return r.slice(0, i);
  }
  return r;
}

// s[i] 의 따옴표가 닫히는 자리 (없으면 -1)
function quotedEnd(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') j++;
    else if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") j++;
      else return j;
    }
  }
  return -1;
}

const ESC = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };

function unescapeDouble(s, line) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, e) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (e in ESC) return ESC[e];
    throw new YamlError(`알 수 없는 이스케이프입니다: \\${e}`, line);
  });
}

// 여러 줄 따옴표 문자열 접기: 줄바꿈은 공백 하나, 빈 줄은 줄바꿈. 큰따옴표에서 줄 끝 \ 는 그냥 이음
function foldQuoted(body, dbl) {
  const lines = body.split('\n');
  if (lines.length === 1) return body;
  let out = lines[0].replace(/[ \t]+$/, '');
  let empties = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = i === lines.length - 1 ? lines[i].replace(/^[ \t]+/, '') : lines[i].trim();
    if (l === '' && i < lines.length - 1) {
      empties++;
      continue;
    }
    if (dbl && /(^|[^\\])(\\\\)*\\$/.test(out)) out = out.slice(0, -1) + (empties ? '\n'.repeat(empties) : '');
    else out += empties ? '\n'.repeat(empties) : ' ';
    out += l;
    empties = 0;
  }
  return out;
}

// 접는 블록 문자열(>): 보통 줄끼리는 공백으로, 빈 줄은 줄바꿈, 더 들여 쓴 줄은 줄바꿈 그대로
function foldBlock(lines) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    out += l;
    let j = i + 1;
    let empties = 0;
    while (j < lines.length && lines[j] === '') {
      empties++;
      j++;
    }
    if (j >= lines.length) break;
    const more = /^[ \t]/.test(l) || /^[ \t]/.test(lines[j]);
    out += !more && l !== '' ? (empties ? '\n'.repeat(empties) : ' ') : '\n' + '\n'.repeat(empties);
    i = j;
  }
  return out;
}

/** 일반 스칼라의 타입 (null·참거짓·정수·실수, 나머지는 문자열) */
export function resolvePlain(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^[-+]?[0-9]+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : new JsonNum(s.replace(/^\+/, ''));
  }
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/** YAML 글 → 값 (매핑은 프로토타입 없는 객체) */
export function parseYaml(text) {
  const raw = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  // 문서 범위: 지시어(%…)와 첫 '---' 다음부터, 다음 '---'·'...' 앞까지
  let start = 0;
  for (; start < raw.length; start++) {
    const t = raw[start].trim();
    if (t === '' || t.startsWith('#') || t.startsWith('%')) continue;
    if (/^---(\s|$)/.test(raw[start])) {
      if (raw[start].slice(3).trim() && !raw[start].slice(3).trim().startsWith('#')) throw new YamlError("'---' 와 같은 줄에 값을 두는 문서는 지원하지 않습니다", start + 1);
      start++;
    }
    break;
  }
  let end = raw.length;
  for (let i = start; i < raw.length; i++) {
    if (/^(---|\.\.\.)(\s|$)/.test(raw[i])) {
      end = i;
      break;
    }
  }
  const L = [];
  for (let i = start; i < end; i++) {
    const r = raw[i];
    const indent = r.match(/^ */)[0].length;
    const text = stripComment(r).replace(/\s+$/, '').slice(indent);
    if (text && r[indent] === '\t') throw new YamlError('들여쓰기에 탭은 쓸 수 없습니다. 공백으로 바꾸세요', i + 1);
    L.push({ n: i + 1, raw: r, indent, text });
  }
  let p = 0;
  const anchors = new Map();
  const cur = () => {
    while (p < L.length && L[p].text === '') p++;
    return p < L.length ? L[p] : null;
  };
  const isSeqItem = (t) => t === '-' || t.startsWith('- ');

  // "키: 값" 의 ':' 자리 (매핑 줄이 아니면 -1)
  const mapColon = (t, n) => {
    if (t[0] === '?' && (t.length === 1 || t[1] === ' ')) throw new YamlError('복잡한 키(?)는 지원하지 않습니다', n);
    if (t[0] === '[' || t[0] === '{') return -1;
    let i = 0;
    if (t[0] === '"' || t[0] === "'") {
      const e = quotedEnd(t, 0);
      if (e < 0) return -1;
      i = e + 1;
      while (t[i] === ' ') i++;
      return t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ') ? i : -1;
    }
    if (t[0] === '&' || t[0] === '*' || t[0] === '!' || t[0] === '|' || t[0] === '>') return -1;
    for (; i < t.length; i++) if (t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ')) return i;
    return -1;
  };
  const keyText = (k, n) => {
    if (k[0] === '"' || k[0] === "'") {
      const e = quotedEnd(k, 0);
      if (e !== k.length - 1) throw new YamlError('키의 따옴표가 맞지 않습니다', n);
      return k[0] === '"' ? unescapeDouble(k.slice(1, -1), n) : k.slice(1, -1).replace(/''/g, "'");
    }
    return k;
  };
  const merge = (out, v, n) => {
    const list = Array.isArray(v) ? v : [v];
    for (const m of list) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new YamlError('병합 키(<<)의 값은 매핑이어야 합니다', n);
      for (const k of Object.keys(m)) if (!(k in out)) out[k] = m[k];
    }
  };

  function parseBlock(minIndent) {
    const ln = cur();
    if (!ln || ln.indent < minIndent) return null;
    return parseAt(ln);
  }

  function parseAt(ln) {
    if (isSeqItem(ln.text)) return parseSeq(ln.indent);
    if (mapColon(ln.text, ln.n) >= 0) return parseMap(ln.indent);
    p++;
    return parseInline(ln.text, ln.indent - 1, ln);
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const ln = cur();
      if (!ln || ln.indent !== indent || !isSeqItem(ln.text)) break;
      const rest = ln.text === '-' ? '' : ln.text.slice(1).replace(/^ +/, '');
      if (!rest) {
        p++;
        out.push(parseBlock(indent + 1));
        continue;
      }
      // 나머지를 그 칸에서 시작하는 줄처럼 다룬다 ("- key: v" 다음 줄의 키는 같은 칸에 맞춰 있음)
      L[p] = { ...ln, indent: indent + (ln.text.length - rest.length), text: rest };
      out.push(parseAt(L[p]));
    }
    return out;
  }

  function parseMap(indent) {
    const out = Object.create(null);
    for (;;) {
      const ln = cur();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError('들여쓰기가 맞지 않습니다', ln.n);
      if (isSeqItem(ln.text)) throw new YamlError('매핑 안에 "- " 항목이 같은 칸에 있습니다', ln.n);
      const c = mapColon(ln.text, ln.n);
      if (c < 0) throw new YamlError('"키: 값" 모양이어야 합니다', ln.n);
      const key = keyText(ln.text.slice(0, c).trim(), ln.n);
      const rest = ln.text.slice(c + 1).replace(/^ +/, '');
      p++;
      let v;
      if (rest === '') {
        // 값이 다음 줄들에: 더 들여 쓴 블록, 또는 같은 칸에서 시작하는 시퀀스 ("key:\n- a")
        const nx = cur();
        v = nx && nx.indent === indent && isSeqItem(nx.text) ? parseSeq(indent) : parseBlock(indent + 1);
      } else v = parseInline(rest, indent, ln);
      if (key === '<<') merge(out, v, ln.n);
      else out[key] = v;
    }
    return out;
  }

  // 줄의 나머지 t 에서 시작하는 값 (현재 줄은 이미 넘김). parentIndent: 이어지는 줄은 이보다 더 들여 써야 함
  function parseInline(t, parentIndent, ln) {
    let anchor = null;
    let tag = null;
    for (;;) {
      let m = t.match(/^&([^\s,[\]{}]+)(?:\s+|$)/);
      if (m) {
        anchor = m[1];
        t = t.slice(m[0].length);
        continue;
      }
      m = t.match(/^(![^\s]*)(?:\s+|$)/);
      if (m) {
        tag = m[1];
        t = t.slice(m[0].length);
        continue;
      }
      break;
    }
    let v;
    if (t === '') {
      const nx = cur();
      v = nx && nx.indent === parentIndent && isSeqItem(nx.text) ? parseSeq(parentIndent) : parseBlock(parentIndent + 1);
    } else if (t[0] === '*') {
      const name = t.slice(1).trim();
      if (!anchors.has(name)) throw new YamlError(`정의되지 않은 별칭입니다: *${name}`, ln.n);
      v = anchors.get(name);
    } else if (t[0] === '|' || t[0] === '>') v = blockScalar(t, parentIndent, ln);
    else if (t[0] === '[' || t[0] === '{') v = flowFrom(t, ln);
    else if (t[0] === '"' || t[0] === "'") v = quotedFrom(t, ln);
    else {
      const s = plainFrom(t, parentIndent);
      v = tag === '!!str' ? s : resolvePlain(s);
    }
    if (tag === '!!str' && v !== null && typeof v !== 'object') v = String(v);
    if (anchor) anchors.set(anchor, v);
    return v;
  }

  function plainFrom(t, parentIndent) {
    let s = t;
    let empties = 0;
    while (p < L.length) {
      const l = L[p];
      if (l.text === '') {
        empties++;
        p++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      // 값 다음의 더 들여 쓴 "키: 값" 줄은 이어지는 글이 아니라 들여쓰기 실수다 (YAML 에서도 오류)
      if (isSeqItem(l.text) || mapColon(l.text, l.n) >= 0) throw new YamlError('들여쓰기가 맞지 않습니다 (값 다음 줄이 키나 "- " 항목처럼 보입니다)', l.n);
      s += empties ? '\n'.repeat(empties) : ' ';
      s += l.text;
      empties = 0;
      p++;
    }
    return s.trim();
  }

  function quotedFrom(t, ln) {
    let buf = t;
    let e = quotedEnd(buf, 0);
    while (e < 0) {
      if (p >= L.length) throw new YamlError('따옴표가 닫히지 않았습니다', ln.n);
      buf += '\n' + L[p].raw.trim();
      p++;
      e = quotedEnd(buf, 0);
    }
    const after = stripComment(buf.slice(e + 1)).trim();
    if (after) throw new YamlError('따옴표 문자열 뒤에 다른 글자가 있습니다', ln.n);
    const dbl = buf[0] === '"';
    const body = foldQuoted(buf.slice(1, e), dbl);
    return dbl ? unescapeDouble(body, ln.n) : body.replace(/''/g, "'");
  }

  function blockScalar(t, parentIndent, ln) {
    const m = t.match(/^([|>])([+-]?)([1-9]?)([+-]?)\s*$/);
    if (!m) throw new YamlError('블록 문자열 표시(| 또는 >) 뒤에는 + - 숫자만 올 수 있습니다', ln.n);
    const literal = m[1] === '|';
    const chomp = m[2] || m[4] || '';
    let ci = m[3] ? Math.max(0, parentIndent) + Number(m[3]) : -1;
    const out = [];
    while (p < L.length) {
      const l = L[p];
      const blank = l.raw.trim() === '';
      if (!blank) {
        if (ci < 0) {
          if (l.indent <= parentIndent) break;
          ci = l.indent;
        }
        if (l.indent < ci) break;
      }
      out.push(blank ? '' : l.raw.slice(ci));
      p++;
    }
    let trailing = 0;
    while (out.length && out[out.length - 1] === '') {
      out.pop();
      trailing++;
    }
    if (!out.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const body = literal ? out.join('\n') : foldBlock(out);
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n' + '\n'.repeat(trailing);
    return body + '\n';
  }

  // 흐름 모음: 괄호가 맞을 때까지 다음 줄을 붙인 뒤 읽는다
  function flowFrom(t, ln) {
    let buf = t;
    const balanced = () => {
      let depth = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '"' || c === "'") {
          const e = quotedEnd(buf, i);
          if (e < 0) return false;
          i = e;
        } else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
      }
      return depth <= 0;
    };
    while (!balanced()) {
      if (p >= L.length) throw new YamlError('[ 나 { 가 닫히지 않았습니다', ln.n);
      buf += ' ' + L[p].text;
      p++;
    }
    const st = { s: buf, i: 0 };
    const v = flowNode(st, ln);
    skipWs(st);
    if (st.i < st.s.length) throw new YamlError('[ ] { } 뒤에 다른 글자가 있습니다', ln.n);
    return v;
  }

  function skipWs(st) {
    while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i++;
  }

  function flowScalar(st, ln, inKey) {
    const s = st.s;
    if (s[st.i] === '"' || s[st.i] === "'") {
      const e = quotedEnd(s, st.i);
      if (e < 0) throw new YamlError('따옴표가 닫히지 않았습니다', ln.n);
      const body = s.slice(st.i + 1, e);
      const dbl = s[st.i] === '"';
      st.i = e + 1;
      return { quoted: true, value: dbl ? unescapeDouble(body, ln.n) : body.replace(/''/g, "'") };
    }
    let j = st.i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === ',' || c === ']' || c === '}' || c === '[' || c === '{') break;
      if (c === ':' && (j + 1 >= s.length || /[\s,\]}]/.test(s[j + 1]) || inKey)) break;
    }
    const text = s.slice(st.i, j).trim();
    st.i = j;
    return { quoted: false, value: text };
  }

  function flowNode(st, ln) {
    skipWs(st);
    const s = st.s;
    const c = s[st.i];
    if (c === '[') {
      st.i++;
      const arr = [];
      for (;;) {
        skipWs(st);
        if (s[st.i] === ']') {
          st.i++;
          break;
        }
        let item = flowNode(st, ln);
        skipWs(st);
        if (s[st.i] === ':') {
          // [key: value] — 짝 하나짜리 매핑
          st.i++;
          const o = Object.create(null);
          o[String(item)] = flowNode(st, ln);
          item = o;
          skipWs(st);
        }
        arr.push(item);
        if (s[st.i] === ',') st.i++;
        else if (s[st.i] === ']') {
          st.i++;
          break;
        } else throw new YamlError("[ ] 안에서 ',' 나 ']' 가 있어야 합니다", ln.n);
      }
      return arr;
    }
    if (c === '{') {
      st.i++;
      const obj = Object.create(null);
      for (;;) {
        skipWs(st);
        if (s[st.i] === '}') {
          st.i++;
          break;
        }
        const k = flowScalar(st, ln, true).value;
        skipWs(st);
        let v = null;
        if (s[st.i] === ':') {
          st.i++;
          skipWs(st);
          if (s[st.i] !== ',' && s[st.i] !== '}') v = flowNode(st, ln);
        }
        if (k === '<<') merge(obj, v, ln.n);
        else obj[k] = v;
        skipWs(st);
        if (s[st.i] === ',') st.i++;
        else if (s[st.i] === '}') {
          st.i++;
          break;
        } else throw new YamlError("{ } 안에서 ',' 나 '}' 가 있어야 합니다", ln.n);
      }
      return obj;
    }
    if (c === '*') {
      const m = s.slice(st.i).match(/^\*([^\s,[\]{}]+)/);
      st.i += m[0].length;
      if (!anchors.has(m[1])) throw new YamlError(`정의되지 않은 별칭입니다: *${m[1]}`, ln.n);
      return anchors.get(m[1]);
    }
    if (c === '&') {
      const m = s.slice(st.i).match(/^&([^\s,[\]{}]+)\s*/);
      st.i += m[0].length;
      const v = flowNode(st, ln);
      anchors.set(m[1], v);
      return v;
    }
    const sc = flowScalar(st, ln, false);
    return sc.quoted ? sc.value : resolvePlain(sc.value);
  }

  const first = cur();
  if (!first) return null;
  const value = parseAt(first);
  const left = cur();
  if (left) throw new YamlError('읽지 못한 내용이 남았습니다. 들여쓰기를 확인하세요', left.n);
  return value;
}
