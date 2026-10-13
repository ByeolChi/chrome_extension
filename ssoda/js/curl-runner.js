// 실제 curl 실행 엔진 (Chrome Native Messaging 도우미 경유)
// - 확장 프로그램은 보안상 PC 프로그램을 직접 실행할 수 없으므로, 한 번 설치하는 작은 도우미(PowerShell/Python)를 통해
//   curl 을 셸 없이 인자 배열로 실행한다.
// - Body/폼 값은 임시 파일로 전달해 한글·따옴표·긴 데이터도 바이트 그대로 전송한다.
import { STATUS_TEXT } from './util.js';
import { tokenize, CURL_SHORT_WITH_VALUE, CURL_SHORT_ALIASES, CURL_LONG_WITH_VALUE, CURL_PASSTHROUGH } from './curl-parser.js';
import { DEFAULT_CURL_OPTS } from './model.js';

export const HOST_NAME = 'com.ssoda.runner';
// SSH 터널을 지원하는 최소 도우미 버전 (1.3.0: 서버 키 확인 후 접속, 터널 우회 차단)
export const SSH_HOST_VERSION = '1.3.0';
// 구형 서버 호환(ssh-rsa) 옵션을 지원하는 도우미 버전
export const SSH_LEGACY_HOST_VERSION = '1.3.1';

export function versionAtLeast(v, min) {
  const a = String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

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

// 추가 인자는 허용 목록에 있는 옵션만 전달한다.
// 파일을 읽거나 쓰는 옵션(-T, -d @파일, --trace, -c, --libcurl …)이나 다른 URL 은 공유받은 백업 속 요청으로
// PC 파일을 유출하거나 덮어쓸 수 있으므로 받지 않는다.
const EXTRA_FLAGS = new Set([
  'verbose', 'insecure', 'silent', 'show-error', 'compressed', 'location', 'http1.0', 'http1.1', 'http2', 'max-time',
  'no-progress-meter',
]);
// SSH 터널을 거치지 않게 만드는 옵션
const ROUTING_OPTS = new Set([
  'proxy', 'preproxy', 'noproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxytunnel', 'proxy-user', 'proxy-header',
  'proxy-insecure', 'proxy-cacert', 'proxy-cert', 'proxy-key', 'unix-socket', 'abstract-unix-socket', 'doh-url', 'dns-servers',
]);

/**
 * 추가 인자 검사 → { args: 실행할 인자(긴 이름으로 정리), removed: [{arg, reason}] }
 * ssh: SSH 터널로 실행할 때 프록시·경로 관련 옵션도 제외
 */
export function parseExtraArgs(extra, { ssh = false } = {}) {
  const text = String(extra || '').trim();
  if (!text) return { args: [], removed: [] };
  let toks;
  try {
    toks = tokenize('curl ' + text).slice(1).filter((t) => !/^\s+$/.test(t));
  } catch (e) {
    toks = text.split(/\s+/);
  }
  const args = [];
  const removed = [];
  const accept = (name, value, raw) => {
    const base = name.startsWith('no-') && !CURL_PASSTHROUGH.has(name) ? name.slice(3) : name;
    if (!CURL_PASSTHROUGH.has(name) && !CURL_PASSTHROUGH.has(base) && !EXTRA_FLAGS.has(name)) {
      removed.push({ arg: raw, reason: 'unsafe' });
    } else if (ssh && (ROUTING_OPTS.has(name) || ROUTING_OPTS.has(base))) {
      removed.push({ arg: raw, reason: 'ssh' });
    } else {
      args.push('--' + name);
      if (value != null) args.push(value);
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(2, eq) : t.slice(2);
      let value = eq > 0 ? t.slice(eq + 1) : null;
      if (value == null && CURL_LONG_WITH_VALUE.has(name)) value = toks[++i] ?? '';
      accept(name, value, value != null ? `${t.split('=')[0]} ${value}` : t);
    } else if (t.startsWith('-') && t.length > 1) {
      // 묶음 옵션 (-sSL, -m5 …)
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        const name = CURL_SHORT_ALIASES[ch];
        if (!name) {
          removed.push({ arg: '-' + ch, reason: 'unsafe' });
          continue;
        }
        if (CURL_SHORT_WITH_VALUE.has(ch)) {
          const value = j + 1 < t.length ? t.slice(j + 1) : toks[++i] ?? '';
          accept(name, value, `-${ch} ${value}`);
          break;
        }
        accept(name, null, '-' + ch);
      }
    } else {
      // 옵션이 아닌 값(추가 URL 등)
      removed.push({ arg: t, reason: 'unsafe' });
    }
  }
  return { args, removed };
}

export function describeRemovedArgs(removed) {
  const out = [];
  const unsafe = removed.filter((r) => r.reason === 'unsafe').map((r) => r.arg);
  const ssh = removed.filter((r) => r.reason === 'ssh').map((r) => r.arg);
  if (unsafe.length) out.push(`허용되지 않아 제외된 추가 인자: ${unsafe.join(' ')} (파일을 읽거나 쓰는 옵션, 추가 URL, 결과 표시와 충돌하는 옵션은 사용할 수 없습니다)`);
  if (ssh.length) out.push(`SSH 터널을 우회하게 만들어 제외된 추가 인자: ${ssh.join(' ')}`);
  return out;
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
export function buildCurlExec(p, opts = DEFAULT_CURL_OPTS, { ssh = false } = {}) {
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

  const extra = parseExtraArgs(opts.extra, { ssh });
  warnings.push(...describeRemovedArgs(extra.removed));
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
      hint: 'PC의 curl 을 실행하려면 도우미를 한 번 설치해야 합니다. 아래 [도우미 설치 / 확인] 버튼을 눌러 설치 파일을 받아 실행해 주세요.',
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

// ssh 오류 출력 → 한국어 안내
export function describeSshError(log) {
  const m = String(log || '');
  const last = m.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^@+$/.test(l)).pop() || 'SSH 연결에 실패했습니다.';
  if (/host key is known for .* you have requested strict checking/i.test(m) && !/IDENTIFICATION HAS CHANGED/i.test(m)) {
    return { code: 'SSH_HOSTKEY_UNKNOWN', message: '처음 접속하는 SSH 서버입니다. 서버 지문을 확인해야 접속할 수 있습니다.',
      hint: '환경의 SSH 설정에서 [연결 테스트] 를 누르면 서버 지문을 확인하고 저장할 수 있습니다.' };
  }
  if (/IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(m)) {
    return { code: 'SSH_HOSTKEY', message: 'SSH 서버의 호스트 키가 처음 접속했을 때와 다릅니다.',
      hint: '서버를 재설치했거나 키를 바꾼 경우라면 환경의 SSH 설정에서 [호스트 키 초기화] 후 다시 시도하세요. 그런 일이 없었다면 중간자 공격일 수 있으니 서버 관리자에게 확인하세요.' };
  }
  if (/no matching (host key type|key exchange method) found/i.test(m)) {
    const offer = (m.match(/Their offer: ([^\r\n]*)/) || [])[1] || '';
    return { code: 'SSH_LEGACY', message: '오래된 SSH 서버라서 보안 방식이 맞지 않습니다' + (offer ? ` (서버 제시: ${offer})` : '') + '.',
      hint: '환경의 SSH 설정에서 [구형 서버 호환] 을 켜면 접속할 수 있습니다. 이 방식(SHA-1)은 보안이 약하므로, 가능하면 서버 관리자에게 SSH 서버 업데이트를 요청하세요.' };
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(m)) {
    return { code: 'SSH_AUTH', message: 'SSH 로그인에 실패했습니다 (사용자 이름 또는 비밀번호 오류).',
      hint: '환경의 SSH 설정에서 사용자 이름과 비밀번호를 확인하세요. OTP 등 추가 인증이 필요한 서버는 지원하지 않습니다.' };
  }
  if (/Could not resolve hostname|Name or service not known|No such host/i.test(m)) {
    return { code: 'SSH_DNS', message: 'SSH 서버 주소를 찾을 수 없습니다.', hint: '서버 주소(IP 또는 호스트 이름)를 확인하세요.' };
  }
  if (/Connection refused/i.test(m)) {
    return { code: 'SSH_REFUSED', message: 'SSH 서버가 연결을 거부했습니다.', hint: 'SSH 포트(기본 22)가 맞는지, 서버에서 sshd 가 실행 중인지 확인하세요.' };
  }
  if (/timed out|Network is unreachable|No route to host/i.test(m)) {
    return { code: 'SSH_TIMEOUT', message: 'SSH 서버에 연결할 수 없습니다 (시간 초과).', hint: '이 PC에서 서버의 SSH 포트로 접속이 허용되어 있는지(방화벽·망 정책) 확인하세요.' };
  }
  if (/ssh(\.exe)? not found/i.test(m)) {
    return { code: 'SSH_MISSING', message: 'ssh 프로그램을 찾을 수 없습니다.', hint: 'Windows: 설정 → 시스템 → 선택적 기능 → "OpenSSH 클라이언트" 를 추가하세요.' };
  }
  return { code: 'SSH_ERROR', message: 'SSH 연결 실패: ' + last, hint: '' };
}

// 터널은 열렸지만 curl 이 실패한 경우, ssh 로그로 원인 추정
function tunnelHint(sshLog) {
  const m = String(sshLog || '');
  if (/administratively prohibited/i.test(m)) return 'SSH 서버에서 포트 포워딩이 막혀 있습니다 (sshd_config 의 AllowTcpForwarding). 서버 관리자에게 문의하세요.';
  if (/open failed: connect failed/i.test(m)) return 'SSH 서버에서 이 주소로 연결하지 못했습니다. URL 의 IP·포트가 SSH 서버 기준으로 접근 가능한 주소인지 확인하세요.';
  if (/open failed/i.test(m)) return 'SSH 서버가 요청한 주소로의 연결을 열지 못했습니다: ' + (m.match(/open failed[^\n]*/i) || [''])[0];
  return '';
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
        finish({
          ok: true, hostVersion: m.hostVersion, platform: m.platform, curl: b64ToText(m.curlB64), path: b64ToText(m.pathB64),
          ssh: b64ToText(m.sshB64), sshPath: b64ToText(m.sshPathB64),
        });
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
 * opts: { signal, curlPath, command(표시용 명령), ssh }
 * ssh: { host, port, user, password, label } 이 있으면 도우미가 SSH 터널(SOCKS5)을 열고 그 위로 curl 을 실행
 */
export function runCurl(prepared, curlOpts, { signal, curlPath = '', command = '', ssh = null } = {}) {
  const exec = buildCurlExec(prepared, curlOpts, { ssh: !!ssh });
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
      else if (m.type === 'sshError') {
        cleanup();
        const log = b64ToText(m.messageB64);
        const info = describeSshError(log);
        reject(new CurlRunError(info.message, {
          code: info.code,
          hint: info.hint,
          elapsed: performance.now() - t0,
          engine: 'curl',
          terminal: { command, stderr: '', exitCode: null, ssh: { ...sshLabel(ssh), log, failed: true, path: b64ToText(m.pathB64) } },
        }));
      } else if (m.type === 'error') {
        cleanup();
        reject(new CurlRunError('도우미 오류: ' + b64ToText(m.messageB64), { code: 'HOST_ERROR' }));
      } else if (m.type === 'end') {
        cleanup();
        try {
          resolve(assemble(meta, chunks, prepared, curlOpts, exec, command, performance.now() - t0, ssh));
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
    const msg = { type: 'run', args: exec.argv, files: exec.files.map((f) => f.name), timeoutMs, curlPath };
    if (ssh) msg.ssh = sshPayload(ssh);
    port.postMessage(msg);
  });
}

function sshPayload(ssh) {
  return {
    host: String(ssh.host || '').trim(), port: parseInt(ssh.port, 10) || 22, user: String(ssh.user || '').trim(), password: String(ssh.password ?? ''),
    legacy: !!ssh.legacy,
  };
}

// 터미널 표시용 (비밀번호 제외)
function sshLabel(ssh) {
  if (!ssh) return {};
  const p = sshPayload(ssh);
  return { label: ssh.label || '', host: p.host, port: p.port, user: p.user };
}

// 도우미에 한 번 요청하고 응답 하나를 받는다 (SSH 연결 테스트 / 호스트 키 초기화)
function hostRequest(msg, expect, timeoutMs) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = connect();
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch (e) {
        /* ignore */
      }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new CurlRunError('도우미가 응답하지 않습니다.', { code: 'TIMEOUT' })), timeoutMs);
    port.onMessage.addListener((m) => {
      if (!m) return;
      if (expect.includes(m.type)) finish(resolve, m);
      else if (m.type === 'error') finish(reject, new CurlRunError('도우미 오류: ' + b64ToText(m.messageB64), { code: 'HOST_ERROR' }));
    });
    port.onDisconnect.addListener(() =>
      finish(reject, hostError(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Native host has exited.')));
    port.postMessage(msg);
  });
}

// SSH 접속만 시험 (터널을 열었다가 바로 닫음)
export async function testSsh(ssh) {
  const m = await hostRequest({ type: 'sshTest', ssh: sshPayload(ssh) }, ['sshOk', 'sshError'], 40000);
  const log = b64ToText(m.logB64 || m.messageB64);
  if (m.type === 'sshError') return { ok: false, ...describeSshError(log), log };
  return { ok: true, connectMs: m.connectMs, fingerprint: b64ToText(m.fingerprintB64), firstTime: /Permanently added/i.test(log), log, path: b64ToText(m.pathB64) };
}

// 서버 호스트 키 가져오기 (아직 신뢰하지 않음) → { keys, fingerprints:[...] }
export async function scanSshHost(ssh) {
  const m = await hostRequest({ type: 'sshScan', ssh: sshPayload(ssh) }, ['sshScanned'], 40000);
  const keys = b64ToText(m.keysB64);
  return { keys, fingerprints: b64ToText(m.fingerprintsB64).split(/\r?\n/).filter(Boolean), error: b64ToText(m.errB64) };
}

// 사용자가 확인한 호스트 키 저장
export async function trustSshHost(ssh, keys) {
  const m = await hostRequest({ type: 'sshTrust', ssh: sshPayload(ssh), keys }, ['sshTrusted'], 15000);
  return m.added || 0;
}

// 저장된 호스트 키 삭제 (서버 키가 정상적으로 바뀐 경우)
export async function forgetSshHost(ssh) {
  const m = await hostRequest({ type: 'sshForget', ssh: sshPayload(ssh) }, ['sshForgot'], 15000);
  return m.removed || 0;
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

// SSH 터널로 실행했을 때 curl 오류 안내 (주소는 SSH 서버 기준으로 해석됨)
const SSH_CURL_HINTS = {
  6: 'SSH 서버에서 이 호스트 이름을 찾지 못했습니다. URL 은 SSH 서버에서 접근하는 주소로 입력하세요.',
  7: 'SSH 서버에서 이 주소·포트로 연결하지 못했습니다. URL 은 SSH 서버 기준 주소입니다 (예: http://localhost:8080, http://10.0.0.5:8080).',
  97: 'SSH 터널(SOCKS)을 통한 연결에 실패했습니다. URL 의 주소가 SSH 서버에서 접근 가능한지, 서버에서 포트 포워딩이 허용되는지 확인하세요.',
};

function assemble(meta, chunks, prepared, curlOpts, exec, command, elapsed, ssh) {
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
  if (ssh) {
    // 이 요청이 터널 없이 실행됐다면(구버전 도우미) 결과를 믿을 수 없음
    if (!meta.ssh) {
      throw new CurlRunError('설치된 cURL 실행 도우미가 SSH 터널을 지원하지 않는 버전입니다.', {
        code: 'HOST_OUTDATED',
        hint: 'cURL 탭 → 도우미 설정에서 설치 파일을 다시 받아 실행해 주세요.',
        elapsed,
        terminal,
        engine: 'curl',
      });
    }
    terminal.ssh = { ...sshLabel(ssh), socksPort: meta.ssh.port, connectMs: meta.ssh.connectMs, log: b64ToText(meta.ssh.logB64), path: b64ToText(meta.ssh.pathB64) };
  }
  const warnings = [...(prepared.warnings || []).filter((w) => !/Body가 제외/.test(w)), ...exec.warnings];
  if (meta.exitCode !== 0 || meta.timedOut) {
    const lastErr = (stderr.match(/curl: \(\d+\)[^\n]*/g) || []).pop();
    const code = meta.timedOut ? 28 : meta.exitCode;
    throw new CurlRunError(lastErr || (meta.timedOut ? '시간이 초과되었습니다.' : `curl 이 종료 코드 ${meta.exitCode} 로 끝났습니다.`), {
      code: 'CURL_' + code,
      hint: (terminal.ssh && tunnelHint(terminal.ssh.log)) || (terminal.ssh && SSH_CURL_HINTS[code]) || CURL_HINTS[code] || '',
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
