// 에디터 상태(draft) → 실제 전송용 요청(prepared) 변환 (순수 함수)
import { resolveRequest, resolveString, unresolvedVariables } from './variables.js';

export const RAW_CONTENT_TYPES = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
};

export function base64Utf8(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function hasScheme(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}

/**
 * ctx: {
 *   scope: Map (variables.buildScope 결과),
 *   inheritedAuth: auth 객체 | null,
 *   jarCookies: [{name, value}],
 *   browserCookies: [{name, value}],
 *   defaults: { followRedirects, timeout },
 * }
 */
export function prepareRequest(draft, ctx = {}) {
  const scope = ctx.scope || new Map();
  const warnings = [];
  const r = resolveRequest(draft, scope);

  // 미해결 변수 확인
  const unresolved = new Set();
  const check = (s) => unresolvedVariables(s, scope).forEach((v) => unresolved.add(v));
  check(draft.url);
  (draft.headers || []).filter((x) => x.enabled).forEach((x) => { check(x.key); check(x.value); });
  if (draft.body?.mode === 'raw') check(draft.body.raw);

  let url = String(r.url || '').trim();
  if (url && !hasScheme(url)) url = 'http://' + url;

  const headers = [];
  for (const hd of r.headers || []) {
    if (!hd.enabled || !String(hd.key).trim()) continue;
    headers.push({ key: String(hd.key).trim(), value: String(hd.value ?? '') });
  }
  const has = (name) => headers.some((x) => x.key.toLowerCase() === name);

  // 인증
  let auth = r.auth;
  if (auth?.type === 'inherit') {
    auth = ctx.inheritedAuth ? resolveAuth(ctx.inheritedAuth, scope) : null;
  }
  if (auth && auth.type === 'bearer' && auth.bearer?.token) {
    if (!has('authorization')) headers.push({ key: 'Authorization', value: 'Bearer ' + auth.bearer.token });
  } else if (auth && auth.type === 'basic' && (auth.basic?.username || auth.basic?.password)) {
    if (!has('authorization'))
      headers.push({ key: 'Authorization', value: 'Basic ' + base64Utf8(`${auth.basic.username || ''}:${auth.basic.password || ''}`) });
  } else if (auth && auth.type === 'apikey' && auth.apikey?.key) {
    if (auth.apikey.in === 'query') {
      const pair = encodeURIComponent(auth.apikey.key) + '=' + encodeURIComponent(auth.apikey.value || '');
      const hashIdx = url.indexOf('#');
      const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      url = base + (base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?') + pair;
    } else if (!has(auth.apikey.key.toLowerCase())) {
      headers.push({ key: auth.apikey.key, value: auth.apikey.value || '' });
    }
  }

  // Body
  const method = String(r.method || 'GET').toUpperCase();
  let body = { mode: 'none' };
  const b = r.body || {};
  if (b.mode === 'raw' && b.raw !== '') {
    body = { mode: 'raw', text: b.raw };
    if (!has('content-type')) headers.push({ key: 'Content-Type', value: RAW_CONTENT_TYPES[b.rawLanguage] || 'text/plain' });
  } else if (b.mode === 'urlencoded') {
    const fields = (b.urlencoded || []).filter((f) => f.enabled && f.key !== '').map((f) => ({ key: f.key, value: f.value }));
    if (fields.length) {
      body = { mode: 'urlencoded', fields };
      if (!has('content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    }
  } else if (b.mode === 'formdata') {
    const fields = (b.formdata || [])
      .filter((f) => f.enabled && f.key !== '')
      .map((f) => ({ key: f.key, value: f.value, type: f.type || 'text', file: f.file || null }));
    if (fields.length) {
      body = { mode: 'formdata', fields };
      const missing = fields.filter((f) => f.type === 'file' && !(f.file && (f.file.dataUrl || f.file.blob)));
      if (missing.length) warnings.push(`파일이 선택되지 않은 form-data 항목: ${missing.map((m) => m.key).join(', ')}`);
    }
  } else if (b.mode === 'binary' && b.binary && (b.binary.dataUrl || b.binary.blob)) {
    body = { mode: 'binary', file: b.binary };
    if (!has('content-type') && b.binary.type) headers.push({ key: 'Content-Type', value: b.binary.type });
  }
  if ((method === 'GET' || method === 'HEAD') && body.mode !== 'none' && !ctx.allowBodyForGet) {
    warnings.push(`브라우저는 ${method} 요청에 Body를 보낼 수 없어 Body가 제외됩니다.`);
    body = { mode: 'none' };
  }

  // 쿠키 병합: 브라우저 쿠키 < 쿠키 관리자 < 요청 Cookies 탭 < Cookie 헤더
  const cookieMap = new Map();
  const put = (name, value) => {
    if (!name) return;
    cookieMap.delete(name);
    cookieMap.set(name, value);
  };
  (ctx.browserCookies || []).forEach((c) => put(c.name, c.value));
  (ctx.jarCookies || []).forEach((c) => put(c.name, c.value));
  (r.cookies || []).filter((c) => c.enabled && String(c.key).trim()).forEach((c) => put(String(c.key).trim(), c.value));
  // Cookie 헤더(여러 개 가능)는 모두 파싱해 가장 높은 우선순위로 병합
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].key.toLowerCase() !== 'cookie') continue;
    headers[i].value.split(';').map((x) => x.trim()).filter(Boolean).forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq > 0) put(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      else put(pair, '');
    });
  }
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i].key.toLowerCase() === 'cookie') headers.splice(i, 1);
  }
  if (cookieMap.size) {
    headers.push({ key: 'Cookie', value: [...cookieMap].map(([k, v]) => `${k}=${v}`).join('; ') });
  }

  const defaults = ctx.defaults || {};
  const settings = {
    followRedirects: draft.settings?.followRedirects ?? defaults.followRedirects ?? true,
    timeout: draft.settings?.timeout ?? defaults.timeout ?? 0,
  };

  return { method, url, headers, body, settings, warnings, unresolved: [...unresolved] };
}

function resolveAuth(auth, scope) {
  const r = (s) => resolveString(s, scope);
  return {
    type: auth.type,
    bearer: { token: r(auth.bearer?.token) },
    basic: { username: r(auth.basic?.username), password: r(auth.basic?.password) },
    apikey: { key: r(auth.apikey?.key), value: r(auth.apikey?.value), in: auth.apikey?.in || 'header' },
  };
}
