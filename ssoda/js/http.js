// HTTP 전송 엔진
// - 확장 프로그램 페이지에서 fetch (host_permissions 덕분에 CORS 제약 없음)
// - fetch로 설정 불가한 헤더(Cookie, Origin, Referer, User-Agent 등)는 declarativeNetRequest 세션 규칙으로 주입
// - webRequest로 실제 전송된 헤더, Set-Cookie 포함 원본 응답 헤더, 리다이렉트, 네트워크 오류 코드를 수집
import { FORBIDDEN_HEADERS, UNSETTABLE_HEADERS, STATUS_TEXT, dataURLtoBlob } from './util.js';
import { base64Utf8 } from './prepare.js';

const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
const EXT_ORIGIN = hasChrome ? `chrome-extension://${chrome.runtime.id}` : '';
let myTabId = null;
const captures = new Set(); // 진행 중인 요청 캡처 (동시 요청 지원)
const hostLocks = new Map(); // 같은 호스트 요청은 순차 처리 (헤더 규칙이 섞이지 않도록)
const byRequestId = new Map();
let listenersReady = false;

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
    if (cap) cap.hops.push({ url: d.url, method: d.method, requestHeaders: d.requestHeaders || [], ts: d.timeStamp });
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

  chrome.webRequest.onBeforeRedirect.addListener((d) => {
    const cap = capOf(d);
    if (!cap) return;
    const hop = lastHop(cap);
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

// 요청별 헤더 규칙: 정확한 URL 규칙(우선순위 2) + 같은 출처 리다이렉트용 규칙(우선순위 1)
async function addDnrRules(url, requestHeaders) {
  if (!hasChrome || !requestHeaders.length) return [];
  const u = new URL(url);
  const base = { resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] };
  if (myTabId != null) base.tabIds = [myTabId];
  const rnd = () => 1 + Math.floor(Math.random() * 2000000000);
  const rules = [];
  if (!/[*^|]/.test(url)) {
    rules.push({ id: rnd(), priority: 2, condition: { ...base, urlFilter: '|' + url + '|' }, action: { type: 'modifyHeaders', requestHeaders } });
  }
  rules.push({ id: rnd(), priority: 1, condition: { ...base, urlFilter: '|' + u.protocol + '//' + u.host + '/' }, action: { type: 'modifyHeaders', requestHeaders } });
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

function acquireHost(host, signal) {
  const prev = hostLocks.get(host) || Promise.resolve();
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
 * opts: { signal, removeOrigin }
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

  const fetchHeaders = new Headers();
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
      fetchHeaders.append(name, hd.value);
    } catch (e) {
      throw new RequestError(`헤더를 설정할 수 없습니다: ${name} (${e.message})`, { code: 'INVALID_HEADER' });
    }
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

  // 같은 호스트로 진행 중인 요청이 있으면 끝날 때까지 대기
  const releaseHost = await acquireHost(url.host, opts.signal);
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
  let ruleIds = [];
  const t0 = performance.now();
  let tHeaders = null;
  let tEnd = null;
  try {
    try {
      ruleIds = await addDnrRules(finalUrl, dnr);
    } catch (e) {
      warnings.push('일부 헤더(Cookie/Origin 등)를 적용하지 못했습니다: ' + e.message);
    }
    let res;
    const tStart = performance.now();
    try {
      res = await fetch(finalUrl, {
        method: prepared.method,
        headers: fetchHeaders,
        body,
        redirect: follow ? 'follow' : 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (e) {
      const elapsed = performance.now() - tStart;
      if (controller.signal.aborted) {
        if (timedOut) throw new RequestError(`요청 시간이 초과되었습니다 (${timeout} ms).`, { code: 'TIMEOUT', elapsed, capture: cap, warnings });
        throw new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed, capture: cap, warnings });
      }
      await new Promise((r) => setTimeout(r, 30)); // onErrorOccurred 이벤트 대기
      const net = cap.netError;
      const hint = net ? ERROR_HINTS[net] || '' : '';
      let msg = net ? `${net}` : e.message || String(e);
      if (!net && /Failed to fetch/i.test(msg)) msg = '서버에 연결할 수 없습니다 (Failed to fetch).';
      throw new RequestError(msg, { code: net || 'NETWORK', hint, elapsed, capture: cap, warnings });
    }
    tHeaders = performance.now();
    let buf;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      const elapsed = performance.now() - tStart;
      if (controller.signal.aborted) {
        if (timedOut) throw new RequestError(`요청 시간이 초과되었습니다 (${timeout} ms). 응답 본문을 받는 중이었습니다.`, { code: 'TIMEOUT', elapsed, capture: cap, warnings });
        throw new RequestError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed, capture: cap, warnings });
      }
      throw new RequestError('응답 본문을 읽는 중 연결이 끊어졌습니다: ' + (cap.netError || e.message), { code: cap.netError || 'NETWORK', elapsed, capture: cap, warnings });
    }
    tEnd = performance.now();
    // webRequest 이벤트가 fetch 완료보다 늦게 도착할 수 있어 잠시 대기
    for (let i = 0; i < 20; i++) {
      const lh = cap.hops[cap.hops.length - 1];
      if (lh && lh.responseHeaders) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const lastHop = cap.hops[cap.hops.length - 1];
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
    cap.hops.slice(0, -1).forEach((hop) => {
      (hop.responseHeaders || []).forEach((x) => {
        if (x.name.toLowerCase() === 'set-cookie') String(x.value).split('\n').forEach((v) => v.trim() && hopCookies.push({ url: hop.url, value: v.trim() }));
      });
    });
    const headersSize = rawHeaders.reduce((n, x) => n + x.name.length + String(x.value).length + 4, statusLine.length + 2);
    const contentType = (rawHeaders.find((x) => x.name.toLowerCase() === 'content-type') || {}).value || res.headers.get('content-type') || '';

    return {
      ok: true,
      status,
      statusText,
      httpVersion,
      statusLine,
      url: res.url || finalUrl,
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
      },
      hops: cap.hops,
      remoteIp: cap.ip || lastHop?.ip || '',
      fromCache: !!lastHop?.fromCache,
      sentUrl: finalUrl,
      method: prepared.method,
      requestBodyPreview: bodyPreview(prepared.body),
      warnings,
      ts: Date.now(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    await removeDnrRules(ruleIds);
    releaseHost();
    captures.delete(cap);
    if (cap.requestId) setTimeout(() => byRequestId.delete(cap.requestId), 2000);
  }
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
