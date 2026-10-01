// 공용 유틸리티

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
}

export function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function clone(v) {
  if (v === undefined) return undefined;
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function formatBytes(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 2 : 1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function formatMs(ms) {
  if (ms == null || isNaN(ms)) return '-';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

/**
 * 하이퍼스크립트 스타일 DOM 생성기
 * h('div.cls#id', {onclick, title, dataset:{a:1}, style:{}}, child1, [child2, ...])
 */
export function h(sel, attrs, ...children) {
  let tag = 'div';
  let id = null;
  const classes = [];
  const m = String(sel).match(/^[a-zA-Z0-9-]+/);
  if (m) tag = m[0];
  String(sel).replace(/([.#])([\w-]+)/g, (_, t, v) => {
    if (t === '.') classes.push(v);
    else id = v;
  });
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') {
        el.className = [el.className, v].filter(Boolean).join(' ');
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k === 'text') {
        el.textContent = v;
      } else if (k in el && typeof v !== 'string') {
        el[k] = v;
      } else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : v);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function dataURLtoBlob(dataUrl) {
  const [head, data] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const isB64 = /;base64/.test(head);
  if (!isB64) return new Blob([decodeURIComponent(data || '')], { type: mime });
  const bin = atob(data || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function methodClass(m) {
  const up = String(m || 'GET').toUpperCase();
  return 'm-' + (METHODS.includes(up) ? up.toLowerCase() : 'other');
}

export function methodShort(m) {
  const up = String(m || 'GET').toUpperCase();
  const map = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH', HEAD: 'HEAD' };
  return map[up] || up;
}

export function statusClass(status) {
  if (!status) return 's-err';
  if (status < 300) return 's-ok';
  if (status < 400) return 's-redirect';
  if (status < 500) return 's-client';
  return 's-server';
}

export const STATUS_TEXT = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content',
  205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: "I'm a teapot", 422: 'Unprocessable Entity', 423: 'Locked', 425: 'Too Early', 426: 'Upgrade Required',
  428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 507: 'Insufficient Storage', 511: 'Network Authentication Required',
};

export function relativeDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  const w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${w})`;
}

export function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function isForbiddenHeaderName(name) {
  const n = String(name).toLowerCase().trim();
  if (n.startsWith('proxy-') || n.startsWith('sec-')) return true;
  return FORBIDDEN_HEADERS.has(n);
}

// fetch()로 직접 설정할 수 없어 네트워크 규칙(DNR)으로 적용하는 헤더
export const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent',
]);

// DNR로도 변경 불가(브라우저 네트워크 스택이 관리)
export const UNSETTABLE_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect']);

export function isTextContentType(ct) {
  const c = String(ct || '').toLowerCase();
  if (!c) return true;
  return /^text\//.test(c) || /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html|svg/.test(c);
}

export function guessLanguage(contentType, text) {
  const c = String(contentType || '').toLowerCase();
  if (/json/.test(c)) return 'json';
  if (/html/.test(c)) return 'html';
  if (/xml|svg/.test(c)) return 'xml';
  if (/javascript|ecmascript/.test(c)) return 'javascript';
  if (/css/.test(c)) return 'css';
  const t = String(text || '').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return 'json';
    } catch (e) {
      /* not json */
    }
  }
  if (/^<!doctype html|^<html/i.test(t)) return 'html';
  if (t.startsWith('<')) return 'xml';
  return 'text';
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function kvRow(key = '', value = '', enabled = true, extra = {}) {
  return { id: uid('kv'), key, value, enabled, description: '', ...extra };
}

export function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || '');
}

export function modKey(e) {
  return isMac() ? e.metaKey : e.ctrlKey;
}
