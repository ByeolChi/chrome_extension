// HAR(HTTP Archive, 브라우저 개발자 도구의 "Save all as HAR") → Ssoda 컬렉션
// - Chrome 의 HAR 처럼 요청 종류(_resourceType)가 있으면 XHR·fetch 만, 없으면 스크립트·스타일·이미지·글꼴을 뺀 요청을 가져온다
// - 호스트가 여럿이면 호스트마다 폴더. 요청 이름은 "METHOD 경로"
// - 브라우저가 정하는 헤더(:authority 같은 HTTP/2 가짜 헤더, Host, Content-Length, sec-*, Accept-Encoding 등)는 뺀다
// - Cookie·Authorization 같은 헤더는 그대로 가져오므로 공유하기 전에 지우라고 알린다
import { newCollection, newFolder, newRequestItem, newRequest, parseQueryToParams } from './model.js';
import { kvRow } from './util.js';

const MAX_ENTRIES = 1000;
const API_TYPES = new Set(['xhr', 'fetch']);
const STATIC_URL = /\.(m?js|css|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|map|mp4|webm|mp3|wav|ogg)(\?|#|$)/i;
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'accept-encoding', 'priority']);
const SECRET_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token']);

export function isHar(obj) {
  return !!obj && typeof obj === 'object' && !!obj.log && Array.isArray(obj.log.entries);
}

function langOf(mime, text) {
  if (/json/i.test(mime)) return 'json';
  if (/xml/i.test(mime)) return 'xml';
  if (/html/i.test(mime)) return 'html';
  if (/javascript/i.test(mime)) return 'javascript';
  const t = String(text || '').trim();
  return t.startsWith('{') || t.startsWith('[') ? 'json' : 'text';
}

/** HAR → { collection, warnings, count } */
export function importHar(har, { name = '' } = {}) {
  const warnings = new Set();
  const entries = har.log.entries.filter((e) => e && e.request && /^https?:/i.test(String(e.request.url || '')));
  const typed = entries.some((e) => e._resourceType);
  let picked = typed ? entries.filter((e) => API_TYPES.has(String(e._resourceType).toLowerCase())) : entries.filter((e) => !STATIC_URL.test(e.request.url));
  if (!picked.length) picked = entries; // 고를 것이 없으면 전부
  const skipped = entries.length - picked.length;
  if (skipped) warnings.add(typed ? `XHR·fetch 요청만 가져오고 문서·스크립트·이미지 같은 요청 ${skipped}개는 뺐습니다.` : `스크립트·스타일·이미지·글꼴 요청 ${skipped}개는 뺐습니다.`);
  if (picked.length > MAX_ENTRIES) {
    warnings.add(`요청이 너무 많아 앞의 ${MAX_ENTRIES}개만 가져왔습니다 (전체 ${picked.length}개).`);
    picked = picked.slice(0, MAX_ENTRIES);
  }
  const started = har.log.pages && har.log.pages[0] && har.log.pages[0].startedDateTime;
  const stamp = (started || (picked[0] && picked[0].startedDateTime) || '').slice(0, 16).replace('T', ' ');
  const col = newCollection(name || `HAR 가져오기${stamp ? ' ' + stamp : ''}`);
  col.description = har.log.creator && har.log.creator.name ? `만든 프로그램: ${har.log.creator.name} ${har.log.creator.version || ''}`.trim() : '';
  const hosts = new Map();
  let secrets = false;
  for (const e of picked) {
    const r = e.request;
    let u;
    try {
      u = new URL(r.url);
    } catch (err) {
      continue;
    }
    const method = String(r.method || 'GET').toUpperCase();
    const headers = [];
    for (const hd of Array.isArray(r.headers) ? r.headers : []) {
      const n = String(hd && hd.name || '');
      const low = n.toLowerCase();
      if (!n || n.startsWith(':') || SKIP_HEADERS.has(low) || low.startsWith('sec-')) continue;
      if (SECRET_HEADERS.has(low)) secrets = true;
      headers.push(kvRow(n, String(hd.value ?? '')));
    }
    const req = newRequest({ method, url: u.href, headers, params: parseQueryToParams(u.href) });
    const pd = r.postData;
    if (pd && method !== 'GET' && method !== 'HEAD') {
      const mime = String(pd.mimeType || '');
      if (Array.isArray(pd.params) && pd.params.length && /form/i.test(mime)) {
        const multi = /multipart/i.test(mime);
        const rows = pd.params.map((p) => (multi && p.fileName
          ? kvRow(String(p.name || ''), '', true, { type: 'file', file: { name: String(p.fileName), missing: true } })
          : kvRow(String(p.name || ''), String(p.value ?? ''), true, multi ? { type: 'text', file: null } : {})));
        req.body.mode = multi ? 'formdata' : 'urlencoded';
        if (multi) {
          req.body.formdata = rows;
          // multipart 의 경계값은 브라우저가 새로 만든다
          req.headers = req.headers.filter((x) => x.key.toLowerCase() !== 'content-type');
          if (pd.params.some((p) => p.fileName)) warnings.add('파일을 올리는 form-data 칸은 Body 탭에서 파일을 다시 골라야 합니다.');
        } else req.body.urlencoded = rows;
      } else if (typeof pd.text === 'string' && pd.text !== '') {
        req.body.mode = 'raw';
        req.body.raw = pd.text;
        req.body.rawLanguage = langOf(mime, pd.text);
      }
    }
    const item = newRequestItem(`${method} ${u.pathname}${u.search ? '?…' : ''}`.slice(0, 120), req);
    if (!hosts.has(u.host)) hosts.set(u.host, []);
    hosts.get(u.host).push(item);
  }
  if (hosts.size > 1) {
    col.items = [...hosts].map(([host, items]) => {
      const f = newFolder(host);
      f.items = items;
      return f;
    });
  } else col.items = [...hosts.values()][0] || [];
  if (secrets) warnings.add('HAR 에 들어 있던 Cookie·Authorization 같은 헤더도 그대로 가져왔습니다. 컬렉션을 남에게 주기 전에 지우세요.');
  const count = [...hosts.values()].reduce((n, l) => n + l.length, 0);
  if (!count) warnings.add('가져올 요청이 없습니다.');
  return { collection: col, warnings: [...warnings], count };
}
