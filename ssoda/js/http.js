// HTTP 전송 엔진
// - 확장 프로그램 페이지에서 fetch (host_permissions 덕분에 CORS 제약 없음)
// - fetch로 설정 불가한 헤더(Cookie, Origin, Referer, User-Agent 등)는 declarativeNetRequest 세션 규칙으로 주입
// - 리다이렉트는 fetch 가 따라가게 두지 않고(redirect: 'manual') 한 단계씩 직접 따라간다. 단계마다 그 서버로 가는
//   차례를 기다리고 그 주소에만 헤더 규칙을 걸어, 다른 서버로 리다이렉트될 때 그 서버로 가는 다른 요청의 헤더가 섞이지 않게 한다
// - webRequest로 실제 전송된 헤더, Set-Cookie 포함 원본 응답 헤더, 리다이렉트, 네트워크 오류 코드를 수집
// - text/event-stream(SSE) 응답은 받는 대로 해석해 onStream 으로 알리고, 멈추거나 시간이 다 되면 받은 데까지 결과로 돌려준다
import { FORBIDDEN_HEADERS, UNSETTABLE_HEADERS, STATUS_TEXT, dataURLtoBlob, formatBytes } from './util.js';
import { base64Utf8 } from './prepare.js';
import { isEventStream, createSseParser } from './sse.js';

const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
const EXT_ORIGIN = hasChrome ? `chrome-extension://${chrome.runtime.id}` : '';
let myTabId = null;
const captures = new Set(); // 진행 중인 요청 캡처 (동시 요청 지원)
const hostLocks = new Map(); // 같은 호스트 요청은 순차 처리 (헤더 규칙이 섞이지 않도록)
const byRequestId = new Map();
let listenersReady = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MAX_REDIRECTS = 20; // Chrome 이 스스로 따라갈 때와 같은 한도
export const STREAM_MAX_BYTES = 32 * 1024 * 1024; // SSE 를 받는 대로 보여 줄 때 쌓아 둘 최대 크기
// 본문이 있던 요청이 GET 으로 바뀌는 리다이렉트에서 함께 빼는 헤더 (Fetch 표준의 request-body-header names)
const BODY_HEADERS = new Set(['content-type', 'content-encoding', 'content-language', 'content-location']);
// 처음 요청과 출처(스킴·호스트·포트)가 다른 곳으로 리다이렉트되면 보내지 않는 인증 정보 (curl 7.83+ 과 같음)
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'cookie2']);

export async function initHttpEngine() {
  if (!hasChrome || listenersReady) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    myTabId = tab ? tab.id : null;
  } catch (e) {
    myTabId = null;
  }
  // 이전 페이지(새로고침 전)에서 남은 이 탭의 헤더 규칙 정리
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const stale = rules.filter((r) => myTabId != null && (r.condition.tabIds || []).includes(myTabId)).map((r) => r.id);
    if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch (e) {
    /* ignore */
  }
  if (!chrome.webRequest) return;
  const filter = { urls: ['<all_urls>'], types: ['xmlhttprequest'] };
  if (myTabId != null) filter.tabId = myTabId;
  const capOf = (d) => byRequestId.get(d.requestId);
  const lastHop = (cap) => cap.hops[cap.hops.length - 1] || {};

  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (byRequestId.has(d.requestId)) return;
    if (d.initiator && d.initiator !== EXT_ORIGIN) return;
    const url = normalizeUrl(d.url);
    for (const cap of captures) {
      if (!cap.requestId && cap.method === d.method && cap.url === url) {
        cap.requestId = d.requestId;
        cap.startTs = d.timeStamp;
        byRequestId.set(d.requestId, cap);
        break;
      }
    }
  }, filter);

  chrome.webRequest.onSendHeaders.addListener((d) => {
    const cap = capOf(d);
    if (cap) cap.hops.push({ url: d.url, method: d.method, requestHeaders: d.requestHeaders || [], ts: d.timeStamp, requestId: d.requestId });
  }, filter, ['requestHeaders', 'extraHeaders']);

  chrome.webRequest.onHeadersReceived.addListener((d) => {
    const cap = capOf(d);
    if (!cap) return;
    const hop = lastHop(cap);
    hop.statusCode = d.statusCode;
    hop.statusLine = d.statusLine;
    hop.responseHeaders = d.responseHeaders || [];
    hop.headersTs = d.timeStamp;
  }, filter, ['responseHeaders', 'extraHeaders']);

  // redirect: 'manual' 이라 브라우저가 따라가지는 않지만, Chrome 내부 리다이렉트(HSTS 등)도 여기로 온다.
  // 내부 리다이렉트는 네트워크로 나가기 전이라 onSendHeaders 기록이 없을 수 있어 요청 ID 와 함께 따로 남긴다
  chrome.webRequest.onBeforeRedirect.addListener((d) => {
    const cap = capOf(d);
    if (!cap) return;
    cap.lastRedirect = { requestId: d.requestId, url: d.redirectUrl };
    const hop = cap.hops[cap.hops.length - 1];
    if (!hop || hop.requestId !== d.requestId) return;
    hop.redirectUrl = d.redirectUrl;
    hop.ip = d.ip;
    hop.fromCache = d.fromCache;
  }, filter, ['responseHeaders', 'extraHeaders']);

  chrome.webRequest.onResponseStarted.addListener((d) => {
    const cap = capOf(d);
    if (!cap) return;
    const hop = lastHop(cap);
    hop.ip = d.ip;
    hop.fromCache = d.fromCache;
  }, filter, ['responseHeaders', 'extraHeaders']);

  chrome.webRequest.onCompleted.addListener((d) => {
    const cap = capOf(d);
    if (!cap) return;
    cap.completedTs = d.timeStamp;
    cap.ip = d.ip;
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const cap = capOf(d);
    if (cap) cap.netError = d.error;
  }, filter);
  listenersReady = true;
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch (e) {
    return u;
  }
}

// 요청 한 단계의 헤더 규칙: 이 주소로 가는 요청에만 건다. 서버가 보낸 리다이렉트는 sendRequest 가 단계마다 새 규칙으로 따라간다.
// - urlFilter 는 * ^ | 를 특수 문자로 읽어 이런 문자가 든 주소는 정확히 고를 수 없으므로, 그때는 같은 서버 전체에 건다
// - http 주소는 Chrome 이 스스로 https 로 바꿔 보낼 수 있다(HSTS). 이 전환은 fetch 가 리다이렉트로 돌려주지 않고 그대로
//   따라갈 수 있어, 같은 서버의 https 에도 같은 헤더를 건다 (서버가 보낸 리다이렉트가 아니라 같은 요청이므로 Cookie 도)
// 같은 서버로 가는 요청은 hostLocks 로 하나씩 보내므로(http·https 기본 포트는 같은 키) 다른 요청에 섞이지 않는다.
export function buildDnrRules(url, requestHeaders, { tabId = null, extId = '' } = {}) {
  if (!requestHeaders.length) return [];
  const u = new URL(url);
  const base = { resourceTypes: ['xmlhttprequest'], initiatorDomains: [extId] };
  if (tabId != null) base.tabIds = [tabId];
  const rule = (priority, urlFilter) => ({ id: 1 + Math.floor(Math.random() * 2000000000), priority, condition: { ...base, urlFilter }, action: { type: 'modifyHeaders', requestHeaders } });
  const rules = [rule(2, /[*^|]/.test(url) ? '|' + u.protocol + '//' + u.host + '/' : '|' + url + '|')];
  if (u.protocol === 'http:') rules.push(rule(1, '|https://' + u.host + '/'));
  return rules;
}

/**
 * 리다이렉트 한 단계 뒤의 요청: 메서드·본문, 보낼 헤더 (Fetch 표준 + curl 과 같은 인증 정보 규칙)
 * - 301·302 의 POST, 303 의 GET·HEAD 아닌 요청은 본문 없는 GET 으로 바뀌고 본문 헤더(Content-Type 등)도 뺀다. 307·308 은 그대로
 * - 처음 요청과 출처(스킴·호스트·포트)가 다르면 Authorization·Cookie 는 보내지 않는다. 처음 출처로 돌아오면 다시 보낸다
 * - 그 밖의 헤더(User-Agent·Referer·직접 넣은 헤더)는 curl 처럼 모든 단계에 보낸다
 */
export function redirectStep({ status, method, to, origin }) {
  const toGet = ((status === 301 || status === 302) && method === 'POST') || (status === 303 && method !== 'GET' && method !== 'HEAD');
  return { method: toGet ? 'GET' : method, dropBody: toGet, crossOrigin: new URL(to).origin !== origin };
}

// 이 단계에서 보낼 헤더: fetch 로 넣는 것(pairs)과 규칙으로 넣는 것(dnr)
export function hopHeaders(pairs, dnr, { crossOrigin = false, bodyDropped = false } = {}) {
  const keep = (name) => !(crossOrigin && CREDENTIAL_HEADERS.has(name)) && !(bodyDropped && BODY_HEADERS.has(name));
  return {
    pairs: pairs.filter(([k]) => keep(k.toLowerCase())),
    dnr: dnr.filter((x) => keep(x.header)),
  };
}

const headerOf = (list, name) => ((list || []).find((x) => String(x.name).toLowerCase() === name) || {}).value;

// webRequest 기록이 fetch 결과보다 늦게 올 수 있어 잠시 기다린다. before: 이 단계를 보내기 전의 기록 개수
async function hopRecord(cap, before, waitMs) {
  const hop = () => (cap.hops.length > before ? cap.hops[cap.hops.length - 1] : null);
  for (let i = 0; i < waitMs / 10 && !(hop() && hop().responseHeaders); i++) await sleep(10);
  return hop();
}

async function addDnrRules(url, requestHeaders) {
  if (!hasChrome || !requestHeaders.length) return [];
  const rules = buildDnrRules(url, requestHeaders, { tabId: myTabId, extId: chrome.runtime.id });
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  return rules.map((r) => r.id);
}

async function removeDnrRules(ids) {
  if (!ids || !ids.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (e) {
    /* ignore */
  }
}

// onWait: 같은 호스트로 보낸 이전 요청이 아직 헤더 규칙을 쓰고 있어 기다려야 할 때 한 번 호출
function acquireHost(host, signal, onWait) {
  const busy = hostLocks.get(host);
  if (busy && onWait) {
    try {
      onWait(host);
    } catch (e) {
      /* ignore */
    }
  }
  const prev = busy || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const tail = prev.then(() => mine);
  hostLocks.set(host, tail);
  const done = () => {
    release();
    if (hostLocks.get(host) === tail) hostLocks.delete(host);
  };
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      done();
      reject(new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed: 0 }));
    };
    if (signal && signal.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    prev.then(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return;
      resolve(done);
    });
  });
}

export async function getBrowserCookies(url) {
  if (!hasChrome || !chrome.cookies) return [];
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure }));
  } catch (e) {
    return [];
  }
}

const ERROR_HINTS = {
  'net::ERR_NAME_NOT_RESOLVED': '도메인을 찾을 수 없습니다. 호스트 이름을 확인하세요.',
  'net::ERR_CONNECTION_REFUSED': '서버가 연결을 거부했습니다. 서버가 실행 중인지, 포트가 맞는지 확인하세요.',
  'net::ERR_CONNECTION_TIMED_OUT': '연결 시간이 초과되었습니다.',
  'net::ERR_CONNECTION_RESET': '연결이 재설정되었습니다.',
  'net::ERR_CONNECTION_CLOSED': '서버가 연결을 닫았습니다.',
  'net::ERR_EMPTY_RESPONSE': '서버가 빈 응답을 보냈습니다.',
  'net::ERR_CERT_AUTHORITY_INVALID': 'SSL 인증서를 신뢰할 수 없습니다. 브라우저에서 해당 주소를 한 번 열어 인증서 예외를 허용한 뒤 다시 시도하세요.',
  'net::ERR_CERT_COMMON_NAME_INVALID': 'SSL 인증서의 도메인이 일치하지 않습니다.',
  'net::ERR_CERT_DATE_INVALID': 'SSL 인증서가 만료되었거나 아직 유효하지 않습니다.',
  'net::ERR_SSL_PROTOCOL_ERROR': 'SSL 프로토콜 오류입니다. http/https 스킴을 확인하세요.',
  'net::ERR_BLOCKED_BY_CLIENT': '다른 확장 프로그램(광고 차단기 등)이 요청을 차단했습니다.',
  'net::ERR_BLOCKED_BY_ADMINISTRATOR': '관리자 정책에 의해 차단되었습니다.',
  'net::ERR_INTERNET_DISCONNECTED': '인터넷에 연결되어 있지 않습니다.',
  'net::ERR_ADDRESS_UNREACHABLE': '주소에 도달할 수 없습니다.',
  'net::ERR_TOO_MANY_REDIRECTS': '리다이렉트가 너무 많습니다.',
  'net::ERR_INVALID_HTTP_RESPONSE': '서버 응답이 올바른 HTTP 형식이 아닙니다.',
  'net::ERR_UNSAFE_PORT': '브라우저가 보안상 허용하지 않는 포트입니다.',
  'net::ERR_ABORTED': '요청이 중단되었습니다.',
};

export class RequestError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/**
 * prepared: prepareRequest() 결과
 * opts: { signal, removeOrigin, onWait(host | null) }
 *   onWait: 같은 호스트로 보낸 이전 요청 때문에 기다려야 하면 host 로, 기다림이 끝나 전송을 시작하면 null 로 호출
 */
export async function sendRequest(prepared, opts = {}) {
  const warnings = [...(prepared.warnings || [])];
  let url;
  try {
    url = new URL(prepared.url);
  } catch (e) {
    throw new RequestError('URL 형식이 올바르지 않습니다: ' + prepared.url, { code: 'INVALID_URL' });
  }
  if (!/^https?:$/.test(url.protocol)) throw new RequestError(`지원하지 않는 프로토콜입니다: ${url.protocol}`, { code: 'INVALID_URL' });
  const headers = prepared.headers.map((x) => ({ ...x }));
  // URL에 포함된 계정정보 → Basic 인증
  if (url.username || url.password) {
    if (!headers.some((x) => x.key.toLowerCase() === 'authorization')) {
      headers.push({ key: 'Authorization', value: 'Basic ' + base64Utf8(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)) });
    }
    url.username = '';
    url.password = '';
  }
  url.hash = '';
  const finalUrl = url.href;

  const pairs = []; // fetch 로 넣는 헤더 [이름, 값]. 리다이렉트 단계마다 hopHeaders 로 골라 Headers 를 새로 만든다
  const check = new Headers(); // 값 검사용
  const dnr = [];
  for (const hd of headers) {
    const name = hd.key.trim();
    const lower = name.toLowerCase();
    if (prepared.body.mode === 'formdata' && lower === 'content-type') continue; // 경계값은 브라우저가 생성
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new RequestError(`헤더 이름이 올바르지 않습니다: "${name}"`, { code: 'INVALID_HEADER' });
    }
    if (/[^\t\x20-\x7e\x80-\xff]/.test(hd.value)) {
      throw new RequestError(`"${name}" 헤더 값에 한글 등 ASCII가 아닌 문자가 있습니다. 값을 URL 인코딩하거나 Base64로 변환하세요.`, { code: 'INVALID_HEADER' });
    }
    if (UNSETTABLE_HEADERS.has(lower)) {
      warnings.push(`"${name}" 헤더는 브라우저가 자동으로 설정하므로 무시되었습니다.`);
      continue;
    }
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) {
      const existing = dnr.find((x) => x.header === lower);
      if (existing) existing.value += (lower === 'cookie' ? '; ' : ', ') + hd.value;
      else dnr.push({ header: lower, operation: 'set', value: hd.value });
      continue;
    }
    try {
      check.append(name, hd.value);
    } catch (e) {
      throw new RequestError(`헤더를 설정할 수 없습니다: ${name} (${e.message})`, { code: 'INVALID_HEADER' });
    }
    pairs.push([name, hd.value]);
  }
  if (opts.removeOrigin !== false && !dnr.some((x) => x.header === 'origin')) {
    dnr.push({ header: 'origin', operation: 'remove' });
  }

  // Body
  let body;
  const b = prepared.body;
  if (b.mode === 'raw') body = b.text;
  else if (b.mode === 'urlencoded') {
    const usp = new URLSearchParams();
    b.fields.forEach((f) => usp.append(f.key, f.value));
    body = usp.toString();
  } else if (b.mode === 'formdata') {
    const fd = new FormData();
    for (const f of b.fields) {
      if (f.type === 'file') {
        if (f.file && f.file.dataUrl) fd.append(f.key, dataURLtoBlob(f.file.dataUrl), f.file.name || 'file');
        else if (f.file && f.file.blob) fd.append(f.key, f.file.blob, f.file.name || 'file');
      } else fd.append(f.key, f.value);
    }
    body = fd;
  } else if (b.mode === 'binary' && b.file) {
    body = b.file.blob || (b.file.dataUrl ? dataURLtoBlob(b.file.dataUrl) : undefined);
  }

  // 타임아웃은 같은 호스트의 이전 요청을 기다리는 시간도 포함한다 (응답 없는 요청 하나가 뒤 요청을 끝없이 막지 않게)
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const timeout = Number(prepared.settings?.timeout) || 0;
  if (timeout > 0) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    opts.signal.addEventListener('abort', onAbort);
  }

  const follow = prepared.settings?.followRedirects !== false;
  const cap = { url: finalUrl, method: prepared.method, requestId: null, hops: [], netError: null };
  captures.add(cap);
  const tQueued = performance.now();
  let queuedMs = 0;
  let t0 = null; // 첫 단계의 차례를 얻은 시각
  let tStart = null;
  let tHeaders = null;
  let tEnd = null;
  let res = null;
  let hopUrl = url;
  let method = prepared.method;
  let hopBody = body;
  let bodyDropped = false;
  // 인증 정보(Authorization·Cookie)를 보내는 출처. 처음 요청의 출처이고, Chrome 이 같은 서버를 https 로 바꾼 것(HSTS)만 따라 바뀐다
  let credOrigin = url.origin;
  let before = 0; // 마지막으로 보낸 단계 앞의 webRequest 기록 개수
  const since = () => performance.now() - (tStart ?? tQueued);
  try {
    for (let n = 0; ; n++) {
      const step = hopHeaders(pairs, dnr, { crossOrigin: hopUrl.origin !== credOrigin, bodyDropped });
      // 1) 같은 서버로 가는 다른 요청이 헤더 규칙을 쓰는 동안(응답 헤더를 받을 때까지) 기다린다
      const tQ = performance.now();
      let waited = false;
      let releaseHost;
      try {
        releaseHost = await acquireHost(hopUrl.host, controller.signal, opts.onWait ? (host) => { waited = true; opts.onWait(host); } : null);
        if (waited) opts.onWait(null); // 기다림 끝 → 전송 시작
      } catch (e) {
        if (timedOut) {
          throw new RequestError(`요청 시간이 초과되었습니다 (${timeout} ms). 같은 서버(${hopUrl.host})로 보낸 이전 요청의 응답을 기다리는 중이었습니다.`, {
            code: 'TIMEOUT',
            hint: '같은 서버로 가는 요청은 헤더가 섞이지 않도록 하나씩 보냅니다. 응답이 오지 않는 이전 요청을 취소한 뒤 다시 보내세요.',
            elapsed: performance.now() - tQueued,
            capture: cap,
            warnings,
          });
        }
        throw new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed: performance.now() - tQueued, capture: cap, warnings });
      }
      queuedMs += performance.now() - tQ;
      if (t0 == null) t0 = performance.now();
      // 2) 이 주소에만 헤더 규칙을 걸고 보낸다. 응답 헤더를 받으면(리다이렉트 포함) 규칙을 지우고 차례를 넘긴다.
      //    본문을 오래 받는 응답(대용량 파일, 끝나지 않는 SSE)이 다른 요청을 막지 않게 하기 위해서다.
      let ruleIds = [];
      before = cap.hops.length;
      try {
        try {
          ruleIds = await addDnrRules(hopUrl.href, step.dnr);
        } catch (e) {
          warnings.push('일부 헤더(Cookie/Origin 등)를 적용하지 못했습니다: ' + e.message);
        }
        cap.requestId = null;
        cap.url = normalizeUrl(hopUrl.href);
        cap.method = method;
        cap.netError = null;
        if (tStart == null) tStart = performance.now();
        const hdrs = new Headers();
        step.pairs.forEach(([k, v]) => hdrs.append(k, v));
        try {
          res = await fetch(hopUrl.href, {
            method,
            headers: hdrs,
            body: hopBody,
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          });
        } catch (e) {
          if (controller.signal.aborted) {
            if (timedOut) throw new RequestError(`요청 시간이 초과되었습니다 (${timeout} ms).`, { code: 'TIMEOUT', elapsed: since(), capture: cap, warnings });
            throw new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed: since(), capture: cap, warnings });
          }
          await sleep(30); // onErrorOccurred 이벤트 대기
          const net = cap.netError;
          const hint = net ? ERROR_HINTS[net] || '' : '';
          let msg = net ? `${net}` : e.message || String(e);
          if (!net && /Failed to fetch/i.test(msg)) msg = '서버에 연결할 수 없습니다 (Failed to fetch).';
          throw new RequestError(msg, { code: net || 'NETWORK', hint, elapsed: since(), capture: cap, warnings });
        }
      } finally {
        await removeDnrRules(ruleIds);
        releaseHost();
      }
      if (res.type !== 'opaqueredirect' || !follow) break;
      // 3) 리다이렉트: 이 단계의 응답 헤더(Location)를 webRequest 기록에서 읽어 다음 단계를 만든다.
      //    Chrome 내부 리다이렉트(HSTS 등)는 응답 헤더 기록 없이 onBeforeRedirect 로만 올 수 있다
      const rid = cap.requestId;
      let rec = null;
      let internal = '';
      for (let i = 0; i < 100; i++) {
        rec = cap.hops.length > before ? cap.hops[cap.hops.length - 1] : null;
        internal = rid && cap.lastRedirect && cap.lastRedirect.requestId === rid ? cap.lastRedirect.url : '';
        if ((rec && rec.responseHeaders) || internal) break;
        await sleep(10);
      }
      const loc = (rec && headerOf(rec.responseHeaders, 'location')) || internal;
      if (!loc) {
        warnings.push('리다이렉트 응답의 Location 을 읽지 못해 따라가지 못했습니다.');
        break;
      }
      let next;
      try {
        next = new URL(loc, hopUrl);
      } catch (e) {
        throw new RequestError(`리다이렉트 주소가 올바르지 않습니다: ${loc}`, { code: 'INVALID_REDIRECT', elapsed: since(), capture: cap, warnings });
      }
      if (!/^https?:$/.test(next.protocol)) {
        throw new RequestError(`지원하지 않는 프로토콜로 리다이렉트되었습니다: ${next.href}`, { code: 'INVALID_REDIRECT', hint: 'http, https 주소로만 따라갑니다.', elapsed: since(), capture: cap, warnings });
      }
      if (n + 1 > MAX_REDIRECTS) {
        throw new RequestError(`리다이렉트가 ${MAX_REDIRECTS}번을 넘었습니다.`, { code: 'net::ERR_TOO_MANY_REDIRECTS', hint: ERROR_HINTS['net::ERR_TOO_MANY_REDIRECTS'], elapsed: since(), capture: cap, warnings });
      }
      next.hash = '';
      if (rec) rec.redirectUrl = next.href;
      // 응답 기록이 없는 내부 리다이렉트는 307 처럼 메서드·본문을 그대로 둔다
      const s = redirectStep({ status: rec && rec.statusCode ? rec.statusCode : 307, method, to: next.href, origin: credOrigin });
      // Chrome 내부 리다이렉트로 같은 서버의 https 로 바뀐 것은 서버가 보낸 리다이렉트가 아니라 같은 요청이다
      const viaInternal = !!internal && (!rec || !rec.responseHeaders || /Internal Redirect/i.test(rec.statusLine || ''));
      if (viaInternal && hopUrl.origin === credOrigin && next.host === hopUrl.host && next.protocol === 'https:') credOrigin = next.origin;
      method = s.method;
      if (s.dropBody) {
        hopBody = undefined;
        bodyDropped = true;
      }
      // 이 단계 요청의 늦은 이벤트(따라가지 않고 끝낸 요청의 취소 오류 등)가 다음 단계 기록에 섞이지 않게 묶음을 푼다
      if (cap.requestId) byRequestId.delete(cap.requestId);
      hopUrl = next;
    }
    tHeaders = performance.now();

    // 4) 본문. SSE 는 받는 대로 해석해 알리고, 멈추거나 시간이 다 되면 받은 데까지 쓴다
    let buf;
    let stream = null;
    const ctype0 = res.headers.get('content-type') || '';
    if (res.type !== 'opaqueredirect' && res.body && isEventStream(ctype0)) {
      const out = await readEventStream(res, { signal: controller.signal, timedOut: () => timedOut, onStream: opts.onStream });
      buf = out.bytes;
      stream = out.stream;
    } else {
      try {
        buf = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (controller.signal.aborted) {
          if (timedOut) throw new RequestError(`요청 시간이 초과되었습니다 (${timeout} ms). 응답 본문을 받는 중이었습니다.`, { code: 'TIMEOUT', elapsed: since(), capture: cap, warnings });
          throw new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed: since(), capture: cap, warnings });
        }
        throw new RequestError('응답 본문을 읽는 중 연결이 끊어졌습니다: ' + (cap.netError || e.message), { code: cap.netError || 'NETWORK', elapsed: since(), capture: cap, warnings });
      }
    }
    tEnd = performance.now();
    // webRequest 이벤트가 fetch 완료보다 늦게 도착할 수 있어 잠시 대기
    const lastHop = await hopRecord(cap, before, 200);
    const prior = lastHop ? cap.hops.slice(0, -1) : cap.hops;
    let status = res.status;
    let statusLine = lastHop?.statusLine || '';
    let rawHeaders;
    if (res.type === 'opaqueredirect') {
      status = lastHop?.statusCode || 0;
    }
    if (lastHop && lastHop.responseHeaders && lastHop.responseHeaders.length) {
      rawHeaders = lastHop.responseHeaders.map((x) => ({ name: x.name, value: x.value ?? '' }));
    } else {
      rawHeaders = [];
      res.headers.forEach((v, k) => rawHeaders.push({ name: k, value: v }));
    }
    const httpVersion = (statusLine.match(/^(HTTP\/[\d.]+)/) || [])[1] || '';
    let statusText = res.statusText || (statusLine.replace(/^HTTP\/[\d.]+\s+\d+\s*/, '') || '');
    if (!statusText) statusText = STATUS_TEXT[status] || '';
    const setCookies = [];
    rawHeaders.forEach((x) => {
      if (x.name.toLowerCase() === 'set-cookie') String(x.value).split('\n').forEach((v) => v.trim() && setCookies.push(v.trim()));
    });
    // 리다이렉트 경로별 Set-Cookie 도 쿠키 관리자에 반영
    const hopCookies = [];
    prior.forEach((hop) => {
      (hop.responseHeaders || []).forEach((x) => {
        if (x.name.toLowerCase() === 'set-cookie') String(x.value).split('\n').forEach((v) => v.trim() && hopCookies.push({ url: hop.url, value: v.trim() }));
      });
    });
    const headersSize = rawHeaders.reduce((n, x) => n + x.name.length + String(x.value).length + 4, statusLine.length + 2);
    const contentType = (rawHeaders.find((x) => x.name.toLowerCase() === 'content-type') || {}).value || ctype0;
    if (stream) {
      const n = stream.events.length;
      if (stream.end === 'timeout') warnings.push(`타임아웃(${timeout} ms)이 되어 스트림을 끊었습니다. 그때까지 받은 이벤트 ${n}개를 보여 줍니다. 더 오래 받으려면 요청의 Settings 탭이나 설정에서 타임아웃을 늘리거나 0(무제한)으로 두세요.`);
      else if (stream.end === 'limit') warnings.push(`스트림이 ${formatBytes(STREAM_MAX_BYTES)}를 넘어 받기를 멈췄습니다. 그때까지 받은 이벤트 ${n}개를 보여 줍니다.`);
      else if (stream.end === 'error') warnings.push(`스트림을 받는 중 연결이 끊어졌습니다 (${cap.netError || stream.error}). 그때까지 받은 이벤트 ${n}개를 보여 줍니다.`);
    }

    return {
      ok: true,
      status,
      statusText,
      httpVersion,
      statusLine,
      url: res.url || hopUrl.href,
      redirected: res.redirected || cap.hops.length > 1,
      opaqueRedirect: res.type === 'opaqueredirect',
      headers: rawHeaders,
      setCookies,
      hopCookies,
      contentType,
      body: buf,
      size: { body: buf.byteLength, headers: headersSize },
      timing: {
        total: tEnd - t0,
        ttfb: tHeaders - tStart,
        download: tEnd - tHeaders,
        prepare: tStart - t0,
        queued: queuedMs,
      },
      hops: cap.hops,
      remoteIp: cap.ip || lastHop?.ip || '',
      fromCache: !!lastHop?.fromCache,
      sentUrl: finalUrl,
      method: prepared.method,
      requestBodyPreview: bodyPreview(prepared.body),
      stream,
      warnings,
      ts: Date.now(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    captures.delete(cap);
    if (cap.requestId) setTimeout(() => byRequestId.delete(cap.requestId), 2000);
  }
}

/**
 * text/event-stream 본문을 받는 대로 읽는다.
 * onStream({ status, statusText, events, received, elapsed, comments }): 처음(응답 헤더를 받았을 때)과 조각을 받을 때마다.
 *   events 는 지금까지 받은 이벤트 전체(같은 배열을 계속 늘림)
 * 반환: { bytes, stream: { kind:'sse', end, error, events, comments, incomplete, duration } }
 *   end: closed(서버가 끝냄) | stopped(사용자가 멈춤) | timeout | limit(너무 큼) | error(연결 끊김)
 */
async function readEventStream(res, { signal, timedOut, onStream }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  const chunks = [];
  const events = [];
  let size = 0;
  let end = 'closed';
  let error = '';
  const t0 = performance.now();
  const report = () => {
    if (!onStream) return;
    try {
      onStream({ status: res.status, statusText: res.statusText, events, received: size, elapsed: performance.now() - t0, comments: parser.comments });
    } catch (e) {
      /* 화면 오류가 받기를 멈추지 않게 */
    }
  };
  const add = (list) => {
    for (const ev of list) events.push(ev);
  };
  report();
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch (e) {
      if (signal.aborted) end = timedOut() ? 'timeout' : 'stopped';
      else {
        end = 'error';
        error = e.message || String(e);
      }
      break;
    }
    if (r.done) break;
    chunks.push(r.value);
    size += r.value.byteLength;
    add(parser.push(decoder.decode(r.value, { stream: true }), performance.now() - t0));
    report();
    if (size >= STREAM_MAX_BYTES) {
      end = 'limit';
      try {
        await reader.cancel();
      } catch (e) {
        /* ignore */
      }
      break;
    }
  }
  add(parser.push(decoder.decode(), performance.now() - t0));
  const { incomplete } = parser.end();
  report();
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, stream: { kind: 'sse', end, error, events, comments: parser.comments, incomplete, duration: performance.now() - t0 } };
}

function bodyPreview(b) {
  if (!b || b.mode === 'none') return '';
  if (b.mode === 'raw') return b.text.length > 20000 ? b.text.slice(0, 20000) + '\n…(생략)' : b.text;
  if (b.mode === 'urlencoded') {
    const usp = new URLSearchParams();
    b.fields.forEach((f) => usp.append(f.key, f.value));
    return usp.toString();
  }
  if (b.mode === 'formdata') return b.fields.map((f) => `${f.key}: ${f.type === 'file' ? `<파일: ${f.file?.name || '없음'}>` : f.value}`).join('\n');
  if (b.mode === 'binary') return `<바이너리 파일: ${b.file?.name || ''}>`;
  return '';
}
