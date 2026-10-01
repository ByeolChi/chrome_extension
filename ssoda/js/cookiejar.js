// 쿠키 관리자 (Cookie Jar, 브라우저 쿠키와 분리)

export function parseSetCookie(header, requestUrl) {
  const str = String(header || '').trim();
  if (!str) return null;
  const parts = str.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  const name = (eq >= 0 ? first.slice(0, eq) : '').trim();
  const value = (eq >= 0 ? first.slice(eq + 1) : first).trim();
  let u;
  try {
    u = new URL(requestUrl);
  } catch (e) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const c = {
    name,
    value: value.replace(/^"(.*)"$/, '$1'),
    domain: host,
    hostOnly: true,
    path: defaultPath(u.pathname),
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: '',
    created: Date.now(),
    raw: str,
  };
  let maxAge = null;
  for (const p of parts) {
    const i = p.indexOf('=');
    const k = (i >= 0 ? p.slice(0, i) : p).trim().toLowerCase();
    const v = (i >= 0 ? p.slice(i + 1) : '').trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      if (host === d || host.endsWith('.' + d)) {
        c.domain = d;
        c.hostOnly = false;
      } else {
        return null; // 다른 도메인 쿠키는 거부
      }
    } else if (k === 'path') {
      c.path = v.startsWith('/') ? v : defaultPath(u.pathname);
    } else if (k === 'expires') {
      const t = Date.parse(v);
      if (!isNaN(t)) c.expires = t;
    } else if (k === 'max-age') {
      const n = parseInt(v, 10);
      if (!isNaN(n)) maxAge = n;
    } else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite') c.sameSite = v;
  }
  if (maxAge != null) c.expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
  return c;
}

function defaultPath(p) {
  if (!p || !p.startsWith('/')) return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function isExpired(c, now = Date.now()) {
  return c.expires != null && c.expires <= now;
}

// jar에 쿠키 추가/교체 (만료된 쿠키는 삭제)
export function storeCookie(jar, c) {
  if (!c || !c.name) return jar;
  const idx = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
  if (idx >= 0) jar.splice(idx, 1);
  if (!isExpired(c)) jar.push(c);
  return jar;
}

export function domainMatches(c, host) {
  host = host.toLowerCase();
  if (c.hostOnly) return host === c.domain;
  return host === c.domain || host.endsWith('.' + c.domain);
}

function pathMatches(cookiePath, reqPath) {
  if (cookiePath === reqPath) return true;
  if (reqPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    if (reqPath[cookiePath.length] === '/') return true;
  }
  return false;
}

export function cookiesForUrl(jar, url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return [];
  }
  const now = Date.now();
  const secureCtx = u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return (jar || [])
    .filter((c) => !isExpired(c, now) && domainMatches(c, u.hostname) && pathMatches(c.path || '/', u.pathname || '/') && (!c.secure || secureCtx))
    .sort((a, b) => (b.path || '').length - (a.path || '').length || a.created - b.created);
}

export function purgeExpired(jar) {
  const now = Date.now();
  return (jar || []).filter((c) => !isExpired(c, now));
}

export function groupByDomain(jar) {
  const map = new Map();
  for (const c of jar || []) {
    if (!map.has(c.domain)) map.set(c.domain, []);
    map.get(c.domain).push(c);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function cookieToString(c) {
  let s = `${c.name}=${c.value}`;
  if (!c.hostOnly) s += `; Domain=${c.domain}`;
  s += `; Path=${c.path || '/'}`;
  if (c.expires) s += `; Expires=${new Date(c.expires).toUTCString()}`;
  if (c.secure) s += '; Secure';
  if (c.httpOnly) s += '; HttpOnly';
  if (c.sameSite) s += `; SameSite=${c.sameSite}`;
  return s;
}

// 쿠키 관리자에서 문자열로 입력/수정할 때 사용
export function parseCookieInput(str, domain) {
  const url = 'https://' + String(domain).replace(/^\./, '') + '/';
  const c = parseSetCookie(str, url);
  if (!c) return null;
  // 입력 문자열에 Domain이 없으면 도메인 전체에 적용
  if (!/;\s*domain=/i.test(str)) {
    c.domain = String(domain).replace(/^\./, '').toLowerCase();
    c.hostOnly = false;
  }
  if (!/;\s*path=/i.test(str)) c.path = '/';
  return c;
}
