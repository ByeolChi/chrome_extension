// 데이터 모델 & 트리 헬퍼
import { uid, clone, kvRow } from './util.js';

export function newAuth(type = 'inherit') {
  return {
    type,
    bearer: { token: '' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', in: 'header' },
  };
}

export function newBody() {
  return {
    mode: 'none',
    raw: '',
    rawLanguage: 'json',
    urlencoded: [],
    formdata: [],
    binary: null,
  };
}

// cURL 실행 옵션 기본값
export const DEFAULT_CURL_OPTS = {
  verbose: false, // -v
  insecure: false, // -k
  silent: false, // -s
  include: false, // -i
  compressed: false, // --compressed
  http: '', // '' | '1.0' | '1.1' | '2'
  extra: '', // 추가 인자 (예: --proxy http://127.0.0.1:8888)
};

export function newRequest(partial = {}) {
  const r = {
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    cookies: [],
    auth: newAuth('inherit'),
    body: newBody(),
    settings: { followRedirects: null, timeout: null, useBrowserCookies: false, useCookieJar: true, engine: null, curl: { ...DEFAULT_CURL_OPTS } },
    description: '',
  };
  return normalizeRequest(Object.assign(r, partial));
}

function normKv(list, extra) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const row = {
        id: x.id || uid('kv'),
        key: String(x.key ?? ''),
        value: x.value == null ? '' : String(x.value),
        enabled: x.enabled !== false,
        description: String(x.description ?? ''),
      };
      if (x.noEquals) row.noEquals = true;
      if (extra) Object.assign(row, extra(x));
      return row;
    });
}

export function normalizeRequest(r) {
  r = r || {};
  const out = {
    method: String(r.method || 'GET').toUpperCase(),
    url: String(r.url || ''),
    params: normKv(r.params),
    headers: normKv(r.headers),
    cookies: normKv(r.cookies),
    auth: Object.assign(newAuth(), clone(r.auth) || {}),
    body: Object.assign(newBody(), clone(r.body) || {}),
    settings: Object.assign(
      { followRedirects: null, timeout: null, useBrowserCookies: false, useCookieJar: true, engine: null },
      r.settings || {}
    ),
    description: String(r.description || ''),
  };
  out.settings.curl = { ...DEFAULT_CURL_OPTS, ...((r.settings && r.settings.curl) || {}) };
  if (!['browser', 'curl'].includes(out.settings.engine)) out.settings.engine = null;
  out.auth.bearer = Object.assign({ token: '' }, out.auth.bearer || {});
  out.auth.basic = Object.assign({ username: '', password: '' }, out.auth.basic || {});
  out.auth.apikey = Object.assign({ key: '', value: '', in: 'header' }, out.auth.apikey || {});
  if (!['inherit', 'none', 'bearer', 'basic', 'apikey'].includes(out.auth.type)) out.auth.type = 'none';
  out.body.urlencoded = normKv(out.body.urlencoded);
  out.body.formdata = normKv(out.body.formdata, (x) => ({
    type: x.type === 'file' ? 'file' : 'text',
    file: x.file || null,
  }));
  if (!['none', 'raw', 'urlencoded', 'formdata', 'binary'].includes(out.body.mode)) out.body.mode = 'none';
  out.body.raw = String(out.body.raw ?? '');
  // 파라미터 테이블이 비어 있으면 URL에서 추출
  if (!out.params.length && out.url.includes('?')) out.params = parseQueryToParams(out.url);
  return out;
}

export function newCollection(name = '새 컬렉션') {
  return { id: uid('col'), name, description: '', auth: newAuth('none'), variables: [], items: [] };
}

export function newFolder(name = '새 폴더') {
  return { id: uid('fld'), type: 'folder', name, description: '', items: [] };
}

export function newRequestItem(name = '새 요청', request) {
  return { id: uid('req'), type: 'request', name, request: normalizeRequest(request || newRequest()) };
}

export function newEnvironment(name = '새 환경') {
  return { id: uid('env'), name, variables: [], ssh: newSsh() };
}

// 환경별 SSH 터널 설정. enabled 이면 이 환경에서 보내는 요청은 SSH 서버를 거쳐 curl 로 실행된다.
// 비밀번호는 저장하지 않는다 (app.sshSecrets 에 메모리로만 잠시 보관).
export function newSsh() {
  return { enabled: false, host: '', port: 22, user: '', legacy: false };
}

export function normalizeSsh(ssh) {
  const src = ssh && typeof ssh === 'object' ? ssh : {};
  return {
    enabled: !!src.enabled,
    host: String(src.host || '').trim(),
    port: Math.min(65535, Math.max(1, parseInt(src.port, 10) || 22)),
    user: String(src.user || '').trim(),
    // 구형 서버 호환: SHA-1 기반 ssh-rsa 호스트 키 허용 (사용자가 켠 환경에서만)
    legacy: !!src.legacy,
  };
}

/* ---------------- 트리 헬퍼 ---------------- */

// 컬렉션 트리에서 id로 항목 찾기 → {item, parent(items 배열을 가진 객체), collection, path:[names]}
export function findInCollections(collections, id) {
  for (const col of collections) {
    if (col.id === id) return { item: col, parent: null, collection: col, path: [] };
    const r = findInItems(col, col.items, id, col, [col.name]);
    if (r) return r;
  }
  return null;
}

function findInItems(parent, items, id, collection, path) {
  for (const it of items || []) {
    if (it.id === id) return { item: it, parent, collection, path };
    if (it.type === 'folder') {
      const r = findInItems(it, it.items, id, collection, path.concat(it.name));
      if (r) return r;
    }
  }
  return null;
}

export function walkItems(items, fn, parents = []) {
  for (const it of items || []) {
    fn(it, parents);
    if (it.type === 'folder') walkItems(it.items, fn, parents.concat(it));
  }
}

export function countRequests(items) {
  let n = 0;
  walkItems(items, (it) => {
    if (it.type === 'request') n++;
  });
  return n;
}

// 폴더/컬렉션 복제 시 새 id 부여
export function reassignIds(item) {
  const c = clone(item);
  const walk = (it) => {
    if (it.type === 'folder') it.id = uid('fld');
    else if (it.type === 'request') it.id = uid('req');
    else it.id = uid('col');
    (it.items || []).forEach(walk);
  };
  walk(c);
  return c;
}

export function isDescendant(ancestor, id) {
  let found = false;
  walkItems(ancestor.items, (it) => {
    if (it.id === id) found = true;
  });
  return found;
}

/* ---------------- URL ↔ Params 동기화 ---------------- */

export function splitUrl(url) {
  const s = String(url || '');
  const hashIdx = s.indexOf('#');
  const noHash = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
  const hash = hashIdx >= 0 ? s.slice(hashIdx) : '';
  const qIdx = noHash.indexOf('?');
  if (qIdx < 0) return { base: noHash, query: null, hash };
  return { base: noHash.slice(0, qIdx), query: noHash.slice(qIdx + 1), hash };
}

export function parseQueryToParams(url) {
  const { query } = splitUrl(url);
  if (query == null || query === '') return [];
  return query
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = i >= 0 ? pair.slice(0, i) : pair;
      const v = i >= 0 ? pair.slice(i + 1) : '';
      return kvRow(safeDecode(k), safeDecode(v), true, { noEquals: i < 0 });
    });
}

function safeDecode(s) {
  // 원본(인코딩된 상태) 그대로 표시
  return s;
}

// 쿼리 구조를 깨는 문자만 인코딩 (변수 {{ }} 와 나머지는 원본 유지)
export function encodeQueryPart(s, isKey) {
  let out = String(s ?? '').replace(/[&#]/g, (ch) => encodeURIComponent(ch));
  if (isKey) out = out.replace(/=/g, '%3D');
  return out;
}

export function buildUrlFromParams(url, params) {
  const { base, hash } = splitUrl(url);
  const enabled = (params || []).filter((p) => p.enabled && (p.key !== '' || p.value !== ''));
  if (!enabled.length) {
    // 원래 '?' 로 끝나던 경우 유지
    const { query } = splitUrl(url);
    return base + (query === '' ? '?' : '') + hash;
  }
  const q = enabled
    .map((p) => {
      const k = encodeQueryPart(p.key, true);
      if (p.noEquals && p.value === '') return k;
      return k + '=' + encodeQueryPart(p.value, false);
    })
    .join('&');
  return base + '?' + q + hash;
}

// URL 입력이 바뀌었을 때: URL 쿼리에서 활성 params를 재구성하고, 비활성 params는 제자리에 유지
export function syncParamsFromUrl(url, oldParams) {
  const fromUrl = parseQueryToParams(url);
  const old = oldParams || [];
  const enabledOld = old.filter((p) => p.enabled);
  // 같은 키의 기존 행 id/설명 재사용
  const used = new Set();
  fromUrl.forEach((p, i) => {
    let prev = enabledOld.find((o) => !used.has(o) && o.key === p.key);
    if (!prev && enabledOld[i] && !used.has(enabledOld[i])) prev = enabledOld[i];
    if (prev) {
      used.add(prev);
      p.id = prev.id;
      p.description = prev.description || '';
    }
  });
  const out = [];
  const queue = fromUrl.slice();
  for (const o of old) {
    if (!o.enabled) out.push(o);
    else if (queue.length) out.push(queue.shift());
  }
  return out.concat(queue);
}

export function requestSignature(name, req) {
  return JSON.stringify({ name, r: stripIds(normalizeRequest(req)) });
}

function stripIds(req) {
  const c = clone(req);
  const s = (list) => (list || []).map(({ id, ...rest }) => rest);
  c.params = s(c.params);
  c.headers = s(c.headers);
  c.cookies = s(c.cookies);
  if (c.body) {
    c.body.urlencoded = s(c.body.urlencoded);
    c.body.formdata = s(c.body.formdata);
  }
  return c;
}
