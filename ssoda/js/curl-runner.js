// 실제 curl 실행 엔진 (Chrome Native Messaging 도우미 경유)
// - 확장 프로그램은 보안상 PC 프로그램을 직접 실행할 수 없으므로, 한 번 설치하는 작은 도우미(PowerShell/Python)를 통해
//   curl 을 셸 없이 인자 배열로 실행한다.
// - Body/폼 값은 임시 파일로 전달해 한글·따옴표·긴 데이터도 바이트 그대로 전송한다.
import { STATUS_TEXT } from './util.js';
import { tokenize } from './curl-parser.js';
import { DEFAULT_CURL_OPTS } from './model.js';

export const HOST_NAME = 'com.ssoda.runner';

export { DEFAULT_CURL_OPTS };

export function curlOptsOf(draft) {
  return { ...DEFAULT_CURL_OPTS, ...((draft && draft.settings && draft.settings.curl) || {}) };
}

const hasNative = () => typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connectNative === 'function';

export class CurlRunError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* 인자 구성                                                            */
/* ------------------------------------------------------------------ */

// 결과 파싱용 write-out (curl 7.29+ 에서 모두 지원)
const WRITEOUT = '\\n__CSW__%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}|%{size_download}|%{num_redirects}|%{remote_ip}|%{remote_port}|%{url_effective}\\n';

// 실행 결과 파싱에 방해되는 옵션은 추가 인자에서 제외
const BLOCKED_EXTRA = new Set(['-o', '--output', '-O', '--remote-name', '-D', '--dump-header', '-w', '--write-out', '-i', '--include', '--output-dir', '-J', '--remote-header-name', '-K', '--config', '-Z', '--parallel']);
const BLOCKED_WITH_VALUE = new Set(['-o', '--output', '-D', '--dump-header', '-w', '--write-out', '--output-dir', '-K', '--config']);

export function parseExtraArgs(extra) {
  const text = String(extra || '').trim();
  if (!text) return { args: [], removed: [] };
  let toks;
  try {
    toks = tokenize('curl ' + text).slice(1);
  } catch (e) {
    toks = text.split(/\s+/);
  }
  const args = [];
  const removed = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const name = t.includes('=') && t.startsWith('--') ? t.slice(0, t.indexOf('=')) : t;
    if (BLOCKED_EXTRA.has(name)) {
      removed.push(t);
      if (BLOCKED_WITH_VALUE.has(name) && !t.includes('=')) i++;
      continue;
    }
    args.push(t);
  }
  return { args, removed };
}

function utf8B64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function dataUrlB64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  if (i < 0) return '';
  const head = s.slice(0, i);
  const data = s.slice(i + 1);
  if (/;base64/i.test(head)) return data;
  return utf8B64(decodeURIComponent(data));
}

function safeFileName(name) {
  return String(name || 'file').replace(/[";\r\n\\]/g, '_');
}

/**
 * prepared(prepareRequest 결과) + curl 옵션 → 실행용 인자 배열
 * 반환: { argv, files:[{name, b64}], warnings }
 */
export function buildCurlExec(p, opts = DEFAULT_CURL_OPTS) {
  const argv = ['-sS'];
  const files = [];
  const warnings = [];
  const addFile = (b64) => {
    const name = 'FILE_' + files.length;
    files.push({ name, b64 });
    return `__CS_${name}__`;
  };
  if (opts.verbose) argv.push('-v');
  if (opts.insecure) argv.push('-k');
  if (opts.compressed) argv.push('--compressed');
  if (opts.http === '1.0') argv.push('--http1.0');
  else if (opts.http === '1.1') argv.push('--http1.1');
  else if (opts.http === '2') argv.push('--http2');
  if (p.settings && p.settings.followRedirects !== false) argv.push('-L');
  if (p.settings && p.settings.timeout > 0) argv.push('--max-time', String(Math.max(1, Math.ceil(p.settings.timeout / 1000))));

  const b = p.body || { mode: 'none' };
  const hasBody = b.mode !== 'none';
  if (p.method === 'HEAD') argv.push('--head');
  else if (p.method !== (hasBody ? 'POST' : 'GET')) argv.push('-X', p.method);

  for (const h of p.headers || []) {
    if (b.mode === 'formdata' && h.key.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(h.value) && !/boundary=/i.test(h.value)) continue;
    argv.push('-H', h.value === '' ? `${h.key};` : `${h.key}: ${h.value}`);
  }

  if (b.mode === 'raw') {
    argv.push('--data-binary', '@' + addFile(utf8B64(b.text)));
  } else if (b.mode === 'urlencoded') {
    const usp = new URLSearchParams();
    b.fields.forEach((f) => usp.append(f.key, f.value));
    argv.push('--data-binary', '@' + addFile(utf8B64(usp.toString())));
  } else if (b.mode === 'formdata') {
    for (const f of b.fields) {
      const key = String(f.key).replace(/=/g, '_');
      if (f.type === 'file') {
        if (!f.file || !(f.file.dataUrl || f.file.b64)) {
          warnings.push(`파일이 선택되지 않은 form-data 항목 "${f.key}" 은(는) 제외되었습니다.`);
          continue;
        }
        const ph = addFile(f.file.b64 || dataUrlB64(f.file.dataUrl));
        const type = String(f.file.type || '').split(';')[0].trim();
        argv.push('-F', `${key}=@${ph};filename="${safeFileName(f.file.name)}"${type ? ';type=' + type : ''}`);
      } else {
        // 값은 파일에서 읽어 텍스트 필드로 전송 (특수문자/한글 안전)
        argv.push('-F', `${key}=<${addFile(utf8B64(f.value))}`);
      }
    }
  } else if (b.mode === 'binary' && b.file) {
    if (b.file.dataUrl || b.file.b64) argv.push('--data-binary', '@' + addFile(b.file.b64 || dataUrlB64(b.file.dataUrl)));
  }

  const extra = parseExtraArgs(opts.extra);
  if (extra.removed.length) warnings.push(`결과 표시에 필요한 옵션과 충돌해 제외된 추가 인자: ${extra.removed.join(' ')}`);
  argv.push(...extra.args);

  let url = p.url;
  try {
    url = new URL(p.url).href; // 한글 등 비ASCII 는 퍼센트 인코딩
  } catch (e) {
    throw new CurlRunError('URL 형식이 올바르지 않습니다: ' + p.url, { code: 'INVALID_URL' });
  }
  argv.push('-D', '__CS_HDR__', '-o', '__CS_BODY__', '-w', WRITEOUT, '--url', url);
  return { argv, files, warnings, url };
}

/* ------------------------------------------------------------------ */
/* 실행                                                                 */
/* ------------------------------------------------------------------ */

const B64_CHUNK = 262144;

function b64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToText(b64) {
  return new TextDecoder('utf-8').decode(b64ToBytes(b64));
}

function hostError(msg) {
  const m = String(msg || '');
  if (/not found/i.test(m)) {
    return new CurlRunError('cURL 실행 도우미가 설치되어 있지 않습니다.', {
      code: 'NO_HOST',
      hint: 'PC의 curl 을 실행하려면 도우미를 한 번 설치해야 합니다. 아래 [도우미 설치] 버튼을 눌러 주세요.',
    });
  }
  if (/forbidden/i.test(m)) {
    return new CurlRunError('이 확장 프로그램은 설치된 도우미를 사용할 권한이 없습니다.', {
      code: 'HOST_FORBIDDEN',
      hint: '확장 프로그램 ID가 바뀌었을 수 있습니다 (폴더 이동/재설치). 도우미 설치 파일을 다시 받아 실행해 주세요.',
    });
  }
  if (/exited/i.test(m)) {
    return new CurlRunError('cURL 실행 도우미가 응답 없이 종료되었습니다.', {
      code: 'HOST_EXITED',
      hint: '도우미 설치 파일을 다시 실행해 보세요. 회사 보안 정책으로 PowerShell 실행이 막혀 있을 수도 있습니다.',
    });
  }
  return new CurlRunError('cURL 실행 도우미와 통신할 수 없습니다: ' + m, { code: 'HOST_ERROR', hint: '도우미 설치 파일을 다시 실행해 보세요.' });
}

function connect() {
  if (!hasNative()) throw new CurlRunError('이 브라우저에서는 Native Messaging 을 사용할 수 없습니다.', { code: 'NO_NATIVE' });
  try {
    return chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    throw hostError(e.message);
  }
}

// 도우미 연결 확인
export function pingHelper({ curlPath = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let port;
    try {
      port = connect();
    } catch (e) {
      resolve({ ok: false, code: e.code, message: e.message, hint: e.hint });
      return;
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch (e) {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', message: '도우미가 응답하지 않습니다.' }), timeoutMs);
    port.onMessage.addListener((m) => {
      if (m && m.type === 'pong') {
        finish({ ok: true, hostVersion: m.hostVersion, platform: m.platform, curl: b64ToText(m.curlB64), path: b64ToText(m.pathB64) });
      } else if (m && m.type === 'error') {
        finish({ ok: false, code: 'HOST_ERROR', message: b64ToText(m.messageB64) });
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      const e = hostError(err);
      finish({ ok: false, code: e.code, message: e.message, hint: e.hint });
    });
    port.postMessage({ type: 'ping', curlPath });
  });
}

/**
 * curl 실행. 결과 형식은 브라우저 엔진(http.js)과 동일 + engine:'curl', terminal:{...}
 * opts: { signal, curlPath, command(표시용 명령), curlOpts }
 */
export function runCurl(prepared, curlOpts, { signal, curlPath = '', command = '' } = {}) {
  const exec = buildCurlExec(prepared, curlOpts);
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = connect();
    } catch (e) {
      reject(e);
      return;
    }
    let meta = null;
    const chunks = [];
    let done = false;
    const cleanup = () => {
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch (e) {
        /* ignore */
      }
    };
    const onAbort = () => {
      if (done) return;
      cleanup();
      reject(new CurlRunError('요청이 취소되었습니다.', { code: 'ABORTED', elapsed: performance.now() - t0 }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    port.onMessage.addListener((m) => {
      if (done || !m) return;
      if (m.type === 'result') meta = m;
      else if (m.type === 'body') chunks.push(m.data);
      else if (m.type === 'error') {
        cleanup();
        reject(new CurlRunError('도우미 오류: ' + b64ToText(m.messageB64), { code: 'HOST_ERROR' }));
      } else if (m.type === 'end') {
        cleanup();
        try {
          resolve(assemble(meta, chunks, prepared, curlOpts, exec, command, performance.now() - t0));
        } catch (e) {
          reject(e);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(hostError(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Native host has exited.'));
    });
    // 파일 전송 (청크)
    for (const f of exec.files) {
      if (!f.b64) port.postMessage({ type: 'file', name: f.name, data: '' });
      for (let i = 0; i < f.b64.length; i += B64_CHUNK) port.postMessage({ type: 'file', name: f.name, data: f.b64.slice(i, i + B64_CHUNK) });
    }
    const timeoutMs = prepared.settings && prepared.settings.timeout > 0 ? prepared.settings.timeout + 5000 : 0;
    port.postMessage({ type: 'run', args: exec.argv, files: exec.files.map((f) => f.name), timeoutMs, curlPath });
  });
}

/* ------------------------------------------------------------------ */
/* 결과 해석                                                            */
/* ------------------------------------------------------------------ */

export function parseHeaderBlocks(text) {
  const blocks = [];
  const norm = String(text || '').replace(/\r\n/g, '\n');
  for (const raw of norm.split(/\n\n+/)) {
    const lines = raw.split('\n').filter((l) => l !== '');
    if (!lines.length || !/^HTTP\//i.test(lines[0])) continue;
    const statusLine = lines[0].trim();
    const m = statusLine.match(/^HTTP\/([\d.]+)\s+(\d{3})\s*(.*)$/i);
    const headers = [];
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) headers.push({ name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() });
    }
    blocks.push({ statusLine, httpVersion: m ? 'HTTP/' + m[1] : '', status: m ? +m[2] : 0, reason: m ? m[3] : '', headers });
  }
  return blocks;
}

export function parseWriteOut(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.startsWith('__CSW__'));
  if (!line) return null;
  const parts = line.slice(7).split('|');
  const num = (i) => parseFloat(parts[i]) || 0;
  return {
    httpCode: parseInt(parts[0], 10) || 0,
    namelookup: num(1),
    connect: num(2),
    appconnect: num(3),
    starttransfer: num(4),
    total: num(5),
    sizeDownload: num(6),
    numRedirects: parseInt(parts[7], 10) || 0,
    remoteIp: parts[8] || '',
    remotePort: parts[9] || '',
    urlEffective: parts.slice(10).join('|').trim(),
  };
}

const CURL_HINTS = {
  1: '지원하지 않는 프로토콜입니다. URL의 http/https 를 확인하세요.',
  2: 'curl 초기화에 실패했습니다. 추가 인자를 확인하세요.',
  3: 'URL 형식이 올바르지 않습니다.',
  5: '프록시 주소를 찾을 수 없습니다.',
  6: '호스트 이름을 찾을 수 없습니다 (DNS). 주소를 확인하세요.',
  7: '서버에 연결할 수 없습니다. 서버가 실행 중인지, 포트/방화벽을 확인하세요.',
  18: '응답을 끝까지 받지 못했습니다.',
  22: '-f 옵션으로 인해 HTTP 오류가 실패로 처리되었습니다.',
  26: '업로드할 파일을 읽을 수 없습니다.',
  28: '시간이 초과되었습니다. 타임아웃 설정을 늘리거나 서버 상태를 확인하세요.',
  35: 'SSL/TLS 연결에 실패했습니다. http/https 스킴과 TLS 버전을 확인하세요.',
  47: '리다이렉트가 너무 많습니다.',
  51: '서버 인증서가 올바르지 않습니다. 테스트 서버라면 cURL 탭에서 -k (SSL 무시)를 켜 보세요.',
  52: '서버가 빈 응답을 보냈습니다.',
  55: '데이터 전송에 실패했습니다.',
  56: '데이터 수신에 실패했습니다 (연결 끊김).',
  58: '클라이언트 인증서에 문제가 있습니다.',
  60: '서버 인증서를 신뢰할 수 없습니다. 자체 서명 인증서라면 cURL 탭에서 -k (SSL 무시)를 켜 보세요.',
};

function assemble(meta, chunks, prepared, curlOpts, exec, command, elapsed) {
  if (!meta) throw new CurlRunError('도우미가 결과를 보내지 않았습니다.', { code: 'HOST_ERROR' });
  const stderr = b64ToText(meta.stderrB64);
  const stdout = b64ToText(meta.stdoutB64);
  const headersText = b64ToText(meta.headersB64);
  const curlPath = b64ToText(meta.pathB64);
  const parts = chunks.map(b64ToBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  const wo = parseWriteOut(stdout);
  const terminal = {
    command,
    argv: exec.argv,
    stderr: stderr.replace(/(^|\n)__CSW__[^\n]*/g, ''),
    stdout: stdout.replace(/\n?__CSW__[^\n]*\n?/g, ''),
    headersText,
    exitCode: meta.exitCode,
    curlPath,
    elapsedMs: meta.elapsedMs,
    include: !!curlOpts.include,
    silent: !!curlOpts.silent,
    verbose: !!curlOpts.verbose,
  };
  const warnings = [...(prepared.warnings || []).filter((w) => !/Body가 제외/.test(w)), ...exec.warnings];
  if (meta.exitCode !== 0 || meta.timedOut) {
    const lastErr = (stderr.match(/curl: \(\d+\)[^\n]*/g) || []).pop();
    const code = meta.timedOut ? 28 : meta.exitCode;
    throw new CurlRunError(lastErr || (meta.timedOut ? '시간이 초과되었습니다.' : `curl 이 종료 코드 ${meta.exitCode} 로 끝났습니다.`), {
      code: 'CURL_' + code,
      hint: CURL_HINTS[code] || '',
      elapsed,
      terminal,
      engine: 'curl',
      warnings,
    });
  }
  const finalBlocks = parseHeaderBlocks(headersText).filter((b) => !(b.status >= 100 && b.status < 200));
  const last = finalBlocks[finalBlocks.length - 1] || { statusLine: '', status: wo ? wo.httpCode : 0, reason: '', headers: [], httpVersion: '' };
  const status = wo && wo.httpCode ? wo.httpCode : last.status;
  const headers = last.headers;
  const setCookies = headers.filter((x) => x.name.toLowerCase() === 'set-cookie').map((x) => x.value);
  const hopCookies = [];
  finalBlocks.slice(0, -1).forEach((b) =>
    b.headers.filter((x) => x.name.toLowerCase() === 'set-cookie').forEach((x) => hopCookies.push({ url: exec.url, value: x.value }))
  );
  const contentType = (headers.find((x) => x.name.toLowerCase() === 'content-type') || {}).value || '';
  const headersSize = headers.reduce((n, x) => n + x.name.length + x.value.length + 4, last.statusLine.length + 2);
  const ms = (s) => Math.round(s * 1000 * 10) / 10;
  const timing = wo
    ? {
        total: ms(wo.total),
        dns: ms(wo.namelookup),
        connect: ms(Math.max(0, wo.connect - wo.namelookup)),
        tls: wo.appconnect ? ms(Math.max(0, wo.appconnect - wo.connect)) : 0,
        ttfb: ms(Math.max(0, wo.starttransfer - (wo.appconnect || wo.connect))),
        download: ms(Math.max(0, wo.total - wo.starttransfer)),
        process: Math.max(0, elapsed - wo.total * 1000),
      }
    : { total: meta.elapsedMs, ttfb: meta.elapsedMs, download: 0 };
  return {
    ok: true,
    engine: 'curl',
    status,
    statusText: last.reason || STATUS_TEXT[status] || '',
    httpVersion: last.httpVersion,
    statusLine: last.statusLine,
    url: (wo && wo.urlEffective) || exec.url,
    redirected: !!(wo && wo.numRedirects),
    opaqueRedirect: false,
    headers,
    setCookies,
    hopCookies,
    contentType,
    body,
    size: { body: body.byteLength, headers: headersSize },
    timing,
    hops: [],
    redirects: finalBlocks.slice(0, -1).map((b) => ({ statusLine: b.statusLine, location: (b.headers.find((x) => x.name.toLowerCase() === 'location') || {}).value || '' })),
    remoteIp: wo ? wo.remoteIp + (wo.remotePort ? ':' + wo.remotePort : '') : '',
    fromCache: false,
    sentUrl: exec.url,
    method: prepared.method,
    requestBodyPreview: '',
    warnings,
    terminal,
    ts: Date.now(),
  };
}
