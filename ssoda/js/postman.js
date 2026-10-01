// Postman Collection v2.0 / v2.1, Postman Environment 가져오기·내보내기
import { newCollection, newFolder, newRequestItem, newRequest, newAuth, newEnvironment, parseQueryToParams } from './model.js';
import { kvRow, uuidv4 } from './util.js';
import { looksLikeCurl, parseCurl } from './curl-parser.js';

export const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ---------------- 입력 형식 감지 ---------------- */
export function detectImport(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('가져올 내용이 비어 있습니다.');
  if (looksLikeCurl(t)) return { kind: 'curl', ...parseCurl(t) };
  let obj = null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error('JSON 형식이 올바르지 않습니다: ' + e.message);
    }
  }
  if (obj) {
    if ((obj.app === 'ssoda' || obj.app === 'curl-studio') && obj.data) return { kind: 'backup', data: obj.data };
    if (obj.info && Array.isArray(obj.item)) return { kind: 'collection', ...importPostmanCollection(obj) };
    if (obj.collection && obj.collection.info && Array.isArray(obj.collection.item))
      return { kind: 'collection', ...importPostmanCollection(obj.collection) };
    if (Array.isArray(obj.values) && ('name' in obj || obj._postman_variable_scope)) {
      return { kind: 'environment', environment: importPostmanEnvironment(obj) };
    }
    if (obj.requests && obj.order) throw new Error('Postman Collection v1 형식은 지원하지 않습니다. Postman에서 v2.1로 다시 내보내 주세요.');
    throw new Error('지원하지 않는 JSON 형식입니다. (Postman Collection v2.x / Environment / Ssoda 백업만 지원)');
  }
  if (/^(https?:\/\/|www\.|localhost[:/])/i.test(t) && !/\s/.test(t)) {
    const req = newRequest({ url: t });
    return { kind: 'url', request: req, warnings: [], name: t };
  }
  throw new Error('인식할 수 없는 형식입니다. cURL 명령, Postman Collection(JSON) 또는 URL을 붙여넣어 주세요.');
}

/* ---------------- Collection 가져오기 ---------------- */
export function importPostmanCollection(pm) {
  const warnings = [];
  const col = newCollection(pm.info?.name || '가져온 컬렉션');
  col.description = descText(pm.info?.description);
  col.auth = pm.auth ? convertAuthIn(pm.auth, warnings) : newAuth('none');
  if (col.auth.type === 'inherit') col.auth.type = 'none';
  col.variables = (pm.variable || []).map((v) => kvRow(String(v.key ?? v.id ?? ''), valueToString(v.value), v.disabled !== true));
  col.items = convertItems(pm.item || [], warnings);
  if (pm.event && pm.event.length) warnings.push('Pre-request / Test 스크립트는 지원하지 않아 제외되었습니다.');
  return { collection: col, warnings: dedupe(warnings) };
}

function convertItems(items, warnings) {
  const out = [];
  for (const it of items) {
    if (Array.isArray(it.item)) {
      const f = newFolder(it.name || '폴더');
      f.description = descText(it.description);
      if (it.auth) f.auth = convertAuthIn(it.auth, warnings);
      f.items = convertItems(it.item, warnings);
      if (it.event && it.event.length) warnings.push('Pre-request / Test 스크립트는 지원하지 않아 제외되었습니다.');
      out.push(f);
    } else if (it.request !== undefined) {
      const ri = newRequestItem(it.name || '요청', convertRequestIn(it.request, warnings));
      if (it.event && it.event.some((e) => e.script && [].concat(e.script.exec || []).join('').trim()))
        warnings.push('Pre-request / Test 스크립트는 지원하지 않아 제외되었습니다.');
      out.push(ri);
    }
  }
  return out;
}

function convertRequestIn(pr, warnings) {
  if (typeof pr === 'string') return newRequest({ url: pr, method: 'GET' });
  const req = newRequest();
  req.method = String(pr.method || 'GET').toUpperCase();
  req.description = descText(pr.description);
  // URL
  const u = pr.url;
  if (typeof u === 'string') {
    req.url = u;
    req.params = parseQueryToParams(u);
  } else if (u && typeof u === 'object') {
    const query = Array.isArray(u.query) ? u.query.filter((q) => q && (q.key != null || q.value != null)) : [];
    let raw = u.raw;
    if (!raw) {
      raw = buildRawFromUrlObject(u);
      const en = query.filter((q) => q.disabled !== true);
      if (en.length) raw += '?' + en.map((q) => `${q.key ?? ''}=${q.value ?? ''}`).join('&');
    }
    req.url = String(raw);
    req.params = query.length
      ? query.map((q) => kvRow(String(q.key ?? ''), q.value == null ? '' : String(q.value), q.disabled !== true, { description: descText(q.description) }))
      : parseQueryToParams(req.url);
    // 경로 변수 :id → 값으로 치환
    if (Array.isArray(u.variable) && u.variable.length) {
      for (const v of u.variable) {
        if (v && v.key && v.value != null && v.value !== '') {
          req.url = req.url.replace(new RegExp(':' + escapeRe(v.key) + '(?=/|$|\\?)', 'g'), String(v.value));
        }
      }
    }
  }
  // Headers
  const headers = Array.isArray(pr.header) ? pr.header : typeof pr.header === 'string' ? parseHeaderString(pr.header) : [];
  req.headers = headers
    .filter((hd) => hd && hd.key != null)
    .map((hd) => kvRow(String(hd.key), hd.value == null ? '' : String(hd.value), hd.disabled !== true, { description: descText(hd.description) }));
  // Cookie 헤더 → Cookies 탭 (값 보존)
  // Auth
  req.auth = pr.auth ? convertAuthIn(pr.auth, warnings) : newAuth('inherit');
  // Body
  const b = pr.body;
  if (b && b.mode && !b.disabled) {
    if (b.mode === 'raw') {
      req.body.mode = 'raw';
      req.body.raw = typeof b.raw === 'string' ? b.raw : '';
      const lang = b.options?.raw?.language;
      req.body.rawLanguage = ['json', 'text', 'xml', 'html', 'javascript'].includes(lang) ? lang : guessRawLang(req.body.raw, req.headers);
    } else if (b.mode === 'urlencoded') {
      req.body.mode = 'urlencoded';
      req.body.urlencoded = (b.urlencoded || []).map((f) => kvRow(String(f.key ?? ''), f.value == null ? '' : String(f.value), f.disabled !== true, { description: descText(f.description) }));
    } else if (b.mode === 'formdata') {
      req.body.mode = 'formdata';
      req.body.formdata = (b.formdata || []).map((f) => {
        if (f.type === 'file') {
          const src = Array.isArray(f.src) ? f.src[0] : f.src;
          if (src) warnings.push('form-data 파일은 경로만 저장되어 있어 다시 선택해야 합니다.');
          return kvRow(String(f.key ?? ''), '', f.disabled !== true, { type: 'file', file: src ? { name: String(src).split(/[\\/]/).pop(), missing: true } : null });
        }
        return kvRow(String(f.key ?? ''), f.value == null ? '' : String(f.value), f.disabled !== true, { type: 'text', file: null });
      });
    } else if (b.mode === 'file') {
      req.body.mode = 'binary';
      req.body.binary = null;
      if (b.file?.src) warnings.push('binary 파일은 다시 선택해야 합니다.');
    } else if (b.mode === 'graphql') {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'json';
      let vars = b.graphql?.variables;
      try {
        vars = vars ? JSON.parse(vars) : undefined;
      } catch (e) {
        /* keep string */
      }
      req.body.raw = JSON.stringify({ query: b.graphql?.query || '', variables: vars || {} }, null, 2);
      if (!req.headers.some((x) => x.key.toLowerCase() === 'content-type')) req.headers.push(kvRow('Content-Type', 'application/json'));
      warnings.push('GraphQL Body는 JSON raw Body로 변환되었습니다.');
    }
  }
  return req;
}

function guessRawLang(raw, headers) {
  const ct = (headers.find((x) => x.key.toLowerCase() === 'content-type') || {}).value || '';
  if (/json/i.test(ct)) return 'json';
  if (/xml/i.test(ct)) return 'xml';
  if (/html/i.test(ct)) return 'html';
  const t = String(raw).trim();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.startsWith('<')) return 'xml';
  return 'text';
}

function buildRawFromUrlObject(u) {
  let s = '';
  if (u.protocol) s += u.protocol + '://';
  if (u.host) s += Array.isArray(u.host) ? u.host.join('.') : u.host;
  if (u.port) s += ':' + u.port;
  if (u.path) {
    const p = Array.isArray(u.path) ? u.path.map((x) => (typeof x === 'object' ? x.value : x)).join('/') : String(u.path).replace(/^\//, '');
    s += '/' + p;
  }
  return s;
}

function parseHeaderString(s) {
  return String(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return { key: i > 0 ? l.slice(0, i).trim() : l, value: i > 0 ? l.slice(i + 1).trim() : '' };
    });
}

function authParams(list) {
  // v2.1: [{key, value}] / v2.0: {key: value}
  const map = {};
  if (Array.isArray(list)) for (const x of list) map[x.key] = x.value;
  else if (list && typeof list === 'object') Object.assign(map, list);
  return map;
}

function convertAuthIn(a, warnings) {
  const out = newAuth('none');
  if (!a || !a.type) return newAuth('inherit');
  switch (a.type) {
    case 'noauth':
      out.type = 'none';
      break;
    case 'bearer': {
      const p = authParams(a.bearer);
      out.type = 'bearer';
      out.bearer.token = valueToString(p.token);
      break;
    }
    case 'basic': {
      const p = authParams(a.basic);
      out.type = 'basic';
      out.basic.username = valueToString(p.username);
      out.basic.password = valueToString(p.password);
      break;
    }
    case 'apikey': {
      const p = authParams(a.apikey);
      out.type = 'apikey';
      out.apikey.key = valueToString(p.key);
      out.apikey.value = valueToString(p.value);
      out.apikey.in = p.in === 'query' ? 'query' : 'header';
      break;
    }
    case 'oauth2': {
      const p = authParams(a.oauth2);
      if (p.accessToken) {
        out.type = 'bearer';
        out.bearer.token = valueToString(p.accessToken);
        warnings.push('OAuth 2.0 인증은 Bearer 토큰으로 변환되었습니다.');
      } else warnings.push('OAuth 2.0 인증은 지원하지 않습니다.');
      break;
    }
    default:
      warnings.push(`"${a.type}" 인증 방식은 지원하지 않아 제외되었습니다.`);
  }
  return out;
}

function valueToString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function descText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && d.content) return String(d.content);
  return '';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/* ---------------- Collection 내보내기 (v2.1) ---------------- */
export function exportPostmanCollection(col) {
  const out = {
    info: {
      _postman_id: uuidv4(),
      name: col.name,
      description: col.description || '',
      schema: SCHEMA_V21,
    },
    item: exportItems(col.items || []),
  };
  if (col.auth && col.auth.type !== 'none' && col.auth.type !== 'inherit') out.auth = convertAuthOut(col.auth);
  if (col.variables && col.variables.length) {
    out.variable = col.variables.map((v) => ({ key: v.key, value: v.value, type: 'string', ...(v.enabled ? {} : { disabled: true }) }));
  }
  return out;
}

function exportItems(items) {
  return items.map((it) => {
    if (it.type === 'folder') {
      const f = { name: it.name, item: exportItems(it.items || []) };
      if (it.description) f.description = it.description;
      if (it.auth && it.auth.type !== 'inherit') f.auth = convertAuthOut(it.auth);
      return f;
    }
    return { name: it.name, request: exportRequest(it.request), response: [] };
  });
}

export function exportRequest(r) {
  const out = {
    method: r.method,
    header: (r.headers || []).map((hd) => ({ key: hd.key, value: hd.value, type: 'text', ...(hd.enabled ? {} : { disabled: true }), ...(hd.description ? { description: hd.description } : {}) })),
  };
  // Cookies 탭 → Cookie 헤더
  const cookies = (r.cookies || []).filter((c) => c.enabled && c.key);
  if (cookies.length) out.header.push({ key: 'Cookie', value: cookies.map((c) => `${c.key}=${c.value}`).join('; '), type: 'text' });
  if (r.auth && r.auth.type !== 'inherit') out.auth = convertAuthOut(r.auth);
  const b = r.body || {};
  if (b.mode === 'raw') {
    out.body = { mode: 'raw', raw: b.raw, options: { raw: { language: b.rawLanguage || 'text' } } };
  } else if (b.mode === 'urlencoded') {
    out.body = { mode: 'urlencoded', urlencoded: (b.urlencoded || []).map((f) => ({ key: f.key, value: f.value, type: 'text', ...(f.enabled ? {} : { disabled: true }) })) };
  } else if (b.mode === 'formdata') {
    out.body = {
      mode: 'formdata',
      formdata: (b.formdata || []).map((f) =>
        f.type === 'file'
          ? { key: f.key, type: 'file', src: f.file?.name || '', ...(f.enabled ? {} : { disabled: true }) }
          : { key: f.key, value: f.value, type: 'text', ...(f.enabled ? {} : { disabled: true }) }
      ),
    };
  } else if (b.mode === 'binary') {
    out.body = { mode: 'file', file: { src: b.binary?.name || '' } };
  }
  out.url = urlToObject(r.url, r.params);
  if (r.description) out.description = r.description;
  return out;
}

export function urlToObject(raw, params) {
  const obj = { raw: raw || '' };
  const noQuery = String(raw || '').split('?')[0].split('#')[0];
  const m = noQuery.match(/^([a-z][\w+.-]*):\/\/(.*)$/i);
  let rest = noQuery;
  if (m) {
    obj.protocol = m[1];
    rest = m[2];
  }
  const slash = rest.indexOf('/');
  let hostPort = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : '';
  const pm = hostPort.match(/^(.*?):(\d+|\{\{[^}]+\}\})$/);
  if (pm) {
    hostPort = pm[1];
    obj.port = pm[2];
  }
  obj.host = hostPort ? (hostPort.startsWith('{{') ? [hostPort] : hostPort.split('.')) : [];
  if (path !== '' || slash >= 0) obj.path = path.split('/');
  const q = (params || []).filter((p) => p.key || p.value);
  if (q.length) obj.query = q.map((p) => ({ key: p.key, value: p.value, ...(p.enabled ? {} : { disabled: true }) }));
  return obj;
}

function convertAuthOut(a) {
  switch (a.type) {
    case 'none':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: [{ key: 'token', value: a.bearer?.token || '', type: 'string' }] };
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: a.basic?.username || '', type: 'string' },
          { key: 'password', value: a.basic?.password || '', type: 'string' },
        ],
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: a.apikey?.key || '', type: 'string' },
          { key: 'value', value: a.apikey?.value || '', type: 'string' },
          { key: 'in', value: a.apikey?.in || 'header', type: 'string' },
        ],
      };
    default:
      return { type: 'noauth' };
  }
}

/* ---------------- Environment ---------------- */
export function importPostmanEnvironment(pe) {
  const env = newEnvironment(pe.name || (pe._postman_variable_scope === 'globals' ? 'Globals' : '가져온 환경'));
  env.variables = (pe.values || []).map((v) => kvRow(String(v.key ?? ''), valueToString(v.value), v.enabled !== false));
  return env;
}

export function exportPostmanEnvironment(env) {
  return {
    id: uuidv4(),
    name: env.name,
    values: (env.variables || []).map((v) => ({ key: v.key, value: v.value, type: 'default', enabled: !!v.enabled })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'Ssoda',
  };
}
