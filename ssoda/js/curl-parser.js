// cURL 명령 파서 (bash / zsh / Windows cmd / PowerShell 형식 지원)
// 결과: { request, warnings, name }
import { newRequest, parseQueryToParams, newAuth } from './model.js';
import { kvRow } from './util.js';

export function looksLikeCurl(text) {
  return /^\s*(\$\s*|PS[^>]*>\s*|>\s*)?(\S*[\\/])?curl(\.exe)?(\s|$)/i.test(String(text || ''));
}

/* ------------------------------------------------------------------ */
/* 토크나이저                                                            */
/* ------------------------------------------------------------------ */

// Windows cmd 형식: 공백 뒤에 ^" 로 시작하는 인자가 있거나, 줄 끝이 " ^" 인 줄 연결이 있을 때
function isCmdStyle(t) {
  return /(^|[ \t])\^"/.test(t) || /[ \t]\^[ \t]*\n/.test(t);
}

export function tokenize(input) {
  let t = String(input || '').replace(/\r\n?/g, '\n');
  // 프롬프트 제거
  t = t.replace(/^\s*(\$|PS[^>\n]*>|>)\s+/, '');
  if (isCmdStyle(t)) return tokenizeCmd(t);
  return tokenizeBash(t);
}

function tokenizeBash(t) {
  const tokens = [];
  let cur = '';
  let has = false; // 빈 문자열 '' 도 토큰으로 인정
  let i = 0;
  const n = t.length;
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  while (i < n) {
    const c = t[i];
    if (c === '\\') {
      const nx = t[i + 1];
      if (nx === '\n') {
        i += 2;
        continue;
      }
      if (nx === undefined) {
        i++;
        continue;
      }
      // 토큰 시작 위치의 "\ " : 우클릭 메뉴 등으로 줄바꿈이 사라진 줄 연결로 간주
      if (!has && (nx === ' ' || nx === '\t')) {
        i += 2;
        continue;
      }
      cur += nx;
      has = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = t.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      cur += t.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && t[i + 1] === "'") {
      const r = readAnsiC(t, i + 2);
      cur += r.value;
      has = true;
      i = r.end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && t[i] !== '"') {
        if (t[i] === '\\' && i + 1 < n && '$`"\\\n'.includes(t[i + 1])) {
          if (t[i + 1] !== '\n') cur += t[i + 1];
          i += 2;
          continue;
        }
        cur += t[i];
        i++;
      }
      has = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '`' && t[i + 1] === '\n' && !has) {
      // PowerShell 줄 연결 (따옴표 밖)
      i += 2;
      continue;
    }
    if (c === '#' && !has) {
      // 주석
      const nl = t.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '|' || c === ';' || c === '>' || (c === '&' && t[i + 1] === '&')) {
      // 파이프/리다이렉트/명령 연결 이후는 무시
      break;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return tokens;
}

function readAnsiC(t, start) {
  let out = '';
  let i = start;
  while (i < t.length && t[i] !== "'") {
    if (t[i] === '\\' && i + 1 < t.length) {
      const e = t[i + 1];
      i += 2;
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'e': case 'E': out += '\x1b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\\': out += '\\'; break;
        case "'": out += "'"; break;
        case '"': out += '"'; break;
        case '?': out += '?'; break;
        case 'x': {
          const m = t.slice(i).match(/^[0-9a-fA-F]{1,2}/);
          if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else out += '\\x';
          break;
        }
        case 'u': case 'U': {
          const len = e === 'u' ? 4 : 8;
          const m = t.slice(i).match(new RegExp('^[0-9a-fA-F]{1,' + len + '}'));
          if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; } else out += '\\' + e;
          break;
        }
        default:
          if (/[0-7]/.test(e)) {
            const m = t.slice(i - 1).match(/^[0-7]{1,3}/);
            out += String.fromCharCode(parseInt(m[0], 8));
            i += m[0].length - 1;
          } else {
            out += '\\' + e;
          }
      }
      continue;
    }
    out += t[i];
    i++;
  }
  // UTF-8 바이트 시퀀스(\xHH 연속)를 문자열로 복원
  if (/[\x80-\xff]/.test(out)) {
    try {
      const bytes = new Uint8Array([...out].map((ch) => ch.charCodeAt(0) & 0xff));
      if ([...out].every((ch) => ch.charCodeAt(0) < 256)) {
        out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
    } catch (e) {
      /* keep as-is */
    }
  }
  return { value: out, end: i };
}

function tokenizeCmd(t) {
  // 1단계: cmd.exe 캐럿(^) 이스케이프 제거
  // "^<줄바꿈>" 은 줄 연결이며, 바로 다음 문자는 그대로(리터럴) 사용
  let s1 = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      inQ = !inQ;
      s1 += c;
    } else if (c === '^' && !inQ && i + 1 < t.length) {
      if (t[i + 1] === '\n') {
        i++;
        if (i + 1 < t.length) {
          const nx = t[i + 1];
          s1 += nx === '"' ? '\u0000Q' : nx;
          i++;
        }
      } else {
        const nx = t[i + 1];
        // 이스케이프된 따옴표는 2단계에서 따옴표로 해석되도록 그대로 둔다
        s1 += nx;
        i++;
      }
    } else {
      s1 += c;
    }
  }
  s1 = s1.replace(/\u0000Q/g, '"');
  // 2단계: MSVCRT 인자 분리 규칙
  const tokens = [];
  let cur = '';
  let has = false;
  inQ = false;
  for (let i = 0; i < s1.length; i++) {
    const c = s1[i];
    if (c === '\\') {
      let j = i;
      while (s1[j] === '\\') j++;
      const count = j - i;
      if (s1[j] === '"') {
        cur += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) {
          cur += '"';
          i = j;
        } else {
          i = j - 1;
        }
      } else {
        cur += '\\'.repeat(count);
        i = j - 1;
      }
      has = true;
      continue;
    }
    if (c === '"') {
      if (inQ && s1[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
      has = true;
      continue;
    }
    if (!inQ && (c === ' ' || c === '\t' || c === '\n')) {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 옵션 정의                                                             */
/* ------------------------------------------------------------------ */

const SHORT_WITH_VALUE = new Set('XHdFbuAemoxcUwTrzECKDYyQtP'.split(''));
const SHORT_ALIASES = {
  X: 'request', H: 'header', d: 'data', F: 'form', b: 'cookie', u: 'user', A: 'user-agent', e: 'referer',
  m: 'max-time', o: 'output', x: 'proxy', c: 'cookie-jar', U: 'proxy-user', w: 'write-out', T: 'upload-file',
  r: 'range', z: 'time-cond', E: 'cert', C: 'continue-at', K: 'config', D: 'dump-header', Y: 'speed-limit',
  y: 'speed-time', Q: 'quote', t: 'telnet-option', P: 'ftp-port',
  G: 'get', I: 'head', L: 'location', k: 'insecure', s: 'silent', S: 'show-error', v: 'verbose', i: 'include',
  f: 'fail', g: 'globoff', N: 'no-buffer', O: 'remote-name', J: 'remote-header-name', n: 'netrc', q: 'disable',
  0: 'http1.0', 4: 'ipv4', 6: 'ipv6', 1: 'tlsv1', j: 'junk-session-cookies', l: 'list-only', a: 'append',
  B: 'use-ascii', R: 'remote-time', Z: 'parallel', '#': 'progress-bar', p: 'proxytunnel', M: 'manual', V: 'version', h: 'help',
};

const LONG_WITH_VALUE = new Set([
  'url', 'request', 'header', 'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'json', 'form',
  'form-string', 'cookie', 'user', 'user-agent', 'referer', 'max-time', 'connect-timeout', 'oauth2-bearer', 'output',
  'cookie-jar', 'proxy', 'proxy-user', 'write-out', 'upload-file', 'range', 'time-cond', 'retry', 'retry-delay',
  'retry-max-time', 'cert', 'key', 'cacert', 'capath', 'resolve', 'connect-to', 'interface', 'speed-limit', 'speed-time',
  'limit-rate', 'max-redirs', 'max-filesize', 'config', 'request-target', 'dump-header', 'trace', 'trace-ascii', 'stderr',
  'unix-socket', 'abstract-unix-socket', 'noproxy', 'proxy-header', 'cert-type', 'key-type', 'pass', 'ciphers',
  'dns-servers', 'aws-sigv4', 'variable', 'continue-at', 'quote', 'telnet-option', 'ftp-port', 'expect100-timeout',
  'keepalive-time', 'local-port', 'login-options', 'mail-from', 'mail-rcpt', 'mail-auth', 'output-dir', 'proto',
  'proto-redir', 'proto-default', 'proxy-cacert', 'proxy-cert', 'proxy-key', 'pubkey', 'hostpubmd5', 'hostpubsha256',
  'sasl-authzid', 'service-name', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'tls-max', 'tlsuser', 'tlspassword',
  'url-query', 'happy-eyeballs-timeout-ms', 'parallel-max', 'rate', 'etag-save', 'etag-compare', 'doh-url', 'hsts', 'alt-svc',
  'create-file-mode', 'ip-tos', 'mptcp', 'haproxy-clientip', 'json', 'max-time', 'curves', 'ech',
]);

/* ------------------------------------------------------------------ */
/* 파서                                                                 */
/* ------------------------------------------------------------------ */

export function parseCurl(text) {
  const warnings = [];
  const tokens = tokenize(text).filter((tok) => !/^\s+$/.test(tok));
  if (!tokens.length) throw new Error('빈 명령입니다.');
  let idx = 0;
  if (/(^|[\\/])curl(\.exe)?$/i.test(tokens[0])) idx = 1;
  else if (!/^https?:|^[\w.-]+\.[a-z]{2,}|^-/i.test(tokens[0])) throw new Error('cURL 명령이 아닙니다.');

  const opts = [];
  const urls = [];
  let endOfOptions = false;
  for (; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (endOfOptions || !tok.startsWith('-') || tok === '-') {
      urls.push(tok);
      continue;
    }
    if (tok === '--') {
      endOfOptions = true;
      continue;
    }
    if (tok.startsWith('--')) {
      let name = tok.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq > 0 && LONG_WITH_VALUE.has(name.slice(0, eq))) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (name.startsWith('no-') && !LONG_WITH_VALUE.has(name)) {
        opts.push({ name: name.slice(3), value: false, negated: true });
        continue;
      }
      if (LONG_WITH_VALUE.has(name)) {
        if (value === undefined) value = tokens[++idx] ?? '';
        opts.push({ name, value });
      } else {
        opts.push({ name, value: true });
      }
      continue;
    }
    // 짧은 옵션 (묶음 가능: -sSL, -XPOST)
    const letters = tok.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const ch = letters[j];
      const name = SHORT_ALIASES[ch] || ch;
      if (SHORT_WITH_VALUE.has(ch)) {
        let value = letters.slice(j + 1);
        if (value === '') value = tokens[++idx] ?? '';
        opts.push({ name, value });
        break;
      }
      opts.push({ name, value: true });
    }
  }

  const req = newRequest();
  req.auth = newAuth('none');
  let method = null;
  const headers = [];
  const cookieRows = [];
  const dataParts = [];
  const formParts = [];
  let getMode = false;
  let headMode = false;
  let jsonMode = false;
  let url = null;
  let uploadFile = null;
  const curlOpts = {};
  const extra = [];
  const passthroughNames = new Set();

  for (const o of opts) {
    const v = o.value;
    switch (o.name) {
      case 'url':
        urls.unshift(v);
        break;
      case 'request':
        method = String(v).toUpperCase();
        break;
      case 'header': {
        const hv = String(v);
        if (hv.startsWith('@')) {
          warnings.push(`헤더 파일(${hv})은 불러올 수 없습니다.`);
          break;
        }
        const ci = hv.indexOf(':');
        const si = hv.indexOf(';');
        if (ci > 0) {
          const name = hv.slice(0, ci).trim();
          const val = hv.slice(ci + 1).trim();
          if (val === '' && ci === hv.length - 1) break; // "Name:" = 헤더 제거
          headers.push([name, val]);
        } else if (si > 0 && si === hv.length - 1) {
          headers.push([hv.slice(0, si).trim(), '']);
        } else if (hv.trim()) {
          headers.push([hv.trim(), '']);
        }
        break;
      }
      case 'data':
      case 'data-ascii':
        if (String(v).startsWith('@')) {
          warnings.push(`파일 데이터(${v})는 불러올 수 없어 Body를 직접 입력해야 합니다.`);
          dataParts.push('');
        } else dataParts.push(String(v));
        break;
      case 'data-binary':
        if (String(v).startsWith('@')) {
          warnings.push(`파일 데이터(${v})는 불러올 수 없어 Body를 직접 입력해야 합니다.`);
          dataParts.push('');
        } else dataParts.push(String(v));
        break;
      case 'data-raw':
        dataParts.push(String(v));
        break;
      case 'json':
        jsonMode = true;
        if (String(v).startsWith('@')) warnings.push(`파일 데이터(${v})는 불러올 수 없습니다.`);
        else dataParts.push({ json: String(v) });
        break;
      case 'data-urlencode':
        dataParts.push(encodeDataUrlencode(String(v), warnings));
        break;
      case 'form':
      case 'form-string': {
        const fv = String(v);
        const eq = fv.indexOf('=');
        if (eq < 0) {
          warnings.push(`잘못된 -F 값: ${fv}`);
          break;
        }
        const key = fv.slice(0, eq);
        let val = fv.slice(eq + 1);
        if (o.name === 'form' && (val.startsWith('@') || val.startsWith('<'))) {
          const fileName = val.slice(1).split(';')[0];
          const typeM = val.match(/;type=([^;]+)/);
          formParts.push(kvRow(key, '', true, {
            type: 'file',
            file: null,
            fileHint: fileName,
            contentType: typeM ? typeM[1] : '',
          }));
          warnings.push(`form-data 파일 "${fileName}"은(는) 직접 다시 선택해야 합니다.`);
        } else {
          if (o.name === 'form') val = val.replace(/;type=[^;]+$/, '');
          formParts.push(kvRow(key, val, true, { type: 'text', file: null }));
        }
        break;
      }
      case 'cookie': {
        const cv = String(v);
        if (cv.includes('=')) {
          cookieRows.push(...parseCookieString(cv));
        } else {
          warnings.push(`쿠키 파일(${cv})은 불러올 수 없습니다.`);
        }
        break;
      }
      case 'user': {
        const uv = String(v);
        const ci = uv.indexOf(':');
        req.auth = newAuth('basic');
        req.auth.basic.username = ci >= 0 ? uv.slice(0, ci) : uv;
        req.auth.basic.password = ci >= 0 ? uv.slice(ci + 1) : '';
        break;
      }
      case 'oauth2-bearer':
        req.auth = newAuth('bearer');
        req.auth.bearer.token = String(v);
        break;
      case 'user-agent':
        headers.push(['User-Agent', String(v)]);
        break;
      case 'referer': {
        const rv = String(v).replace(/;auto$/, '');
        if (rv) headers.push(['Referer', rv]);
        break;
      }
      case 'get':
        getMode = true;
        break;
      case 'head':
        headMode = true;
        break;
      case 'location':
      case 'location-trusted':
        req.settings.followRedirects = o.negated ? false : true;
        break;
      case 'max-time': {
        const sec = parseFloat(v);
        if (!isNaN(sec) && sec > 0) req.settings.timeout = Math.round(sec * 1000);
        break;
      }
      case 'upload-file':
        uploadFile = String(v);
        warnings.push(`업로드 파일(${v})은 Body > binary 에서 직접 선택해야 합니다.`);
        break;
      case 'insecure':
        curlOpts.insecure = !o.negated;
        warnings.push('-k (SSL 무시): 켜져 있는 동안 이 요청은 PC의 curl 로 실행됩니다. 브라우저 전송에서는 인증서 검증을 끌 수 없습니다.');
        break;
      case 'verbose':
        curlOpts.verbose = !o.negated;
        break;
      case 'silent':
        curlOpts.silent = !o.negated;
        break;
      case 'include':
        curlOpts.include = !o.negated;
        break;
      case 'compressed':
        curlOpts.compressed = !o.negated;
        break;
      case 'http1.0':
      case 'http1.1':
      case 'http2':
        curlOpts.http = o.name.slice(4);
        break;
      case 'digest':
      case 'ntlm':
      case 'negotiate':
        extra.push('--' + o.name);
        warnings.push(`--${o.name} 인증은 cURL 로 실행할 때만 적용됩니다.`);
        break;
      case 'url-query':
        dataParts.__urlQuery = (dataParts.__urlQuery || []).concat(String(v));
        break;
      default:
        // 프록시/인증서/DNS 등 curl 전용 옵션은 cURL 실행용 추가 인자로 보존
        if (PASSTHROUGH.has(o.name) && !o.negated) {
          extra.push('--' + o.name + (typeof v === 'string' ? ' ' + shellQuote(v) : ''));
          passthroughNames.add(o.name);
        }
        break;
    }
  }

  url = urls[0] || '';
  if (urls.length > 1) warnings.push(`URL이 여러 개입니다. 첫 번째만 사용합니다: ${url}`);
  if (!url) warnings.push('URL을 찾지 못했습니다.');

  // 데이터 조합
  let jsonBody = null;
  const plainParts = [];
  for (const p of dataParts) {
    if (p && typeof p === 'object' && 'json' in p) jsonBody = (jsonBody || '') + p.json;
    else plainParts.push(p);
  }
  let data = null;
  if (plainParts.length) data = plainParts.join('&');
  if (jsonBody != null) data = data ? data + jsonBody : jsonBody;

  if (dataParts.__urlQuery) {
    url += (url.includes('?') ? '&' : '?') + dataParts.__urlQuery.join('&');
  }

  if (getMode && data != null) {
    url += (url.includes('?') ? '&' : '?') + data;
    data = null;
  }

  // 메소드 결정
  if (!method) {
    if (headMode) method = 'HEAD';
    else if (getMode) method = 'GET';
    else if (uploadFile) method = 'PUT';
    else if (data != null || formParts.length) method = 'POST';
    else method = 'GET';
  }
  req.method = method;
  req.url = url;
  req.params = parseQueryToParams(url);

  // 헤더 & 쿠키 헤더 분리
  for (const [k, v] of headers) {
    if (k.toLowerCase() === 'cookie') cookieRows.push(...parseCookieString(v));
    else req.headers.push(kvRow(k, v));
  }
  req.cookies = cookieRows;

  if (jsonMode) {
    if (!hasHeader(req.headers, 'content-type')) req.headers.push(kvRow('Content-Type', 'application/json'));
    if (!hasHeader(req.headers, 'accept')) req.headers.push(kvRow('Accept', 'application/json'));
  }

  // Body 구성
  if (formParts.length) {
    req.body.mode = 'formdata';
    req.body.formdata = formParts;
    // multipart 경계는 브라우저가 생성하므로 기존 Content-Type 제거
    req.headers = req.headers.filter((hd) => !(hd.key.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(hd.value)));
    if (data != null) warnings.push('-d 와 -F 를 함께 사용할 수 없어 -d 값은 무시되었습니다.');
  } else if (data != null) {
    const ct = getHeader(req.headers, 'content-type');
    const ctl = (ct || '').toLowerCase();
    const trimmed = data.trim();
    const looksJson = (trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed);
    if (/json/.test(ctl) || (!ct && looksJson)) {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'json';
      req.body.raw = data; // 전송 바이트를 그대로 유지 (정렬은 Beautify 버튼으로)
    } else if (/xml/.test(ctl)) {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'xml';
      req.body.raw = data;
    } else if (/html/.test(ctl)) {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'html';
      req.body.raw = data;
    } else if (/javascript/.test(ctl)) {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'javascript';
      req.body.raw = data;
    } else if ((!ct || /x-www-form-urlencoded/.test(ctl)) && isFormLike(data)) {
      req.body.mode = 'urlencoded';
      req.body.urlencoded = parseFormBody(data);
      // urlencoded 모드는 Content-Type 자동 설정
      req.headers = req.headers.filter((hd) => !(hd.key.toLowerCase() === 'content-type' && /x-www-form-urlencoded/i.test(hd.value) && !/charset/i.test(hd.value)));
    } else {
      req.body.mode = 'raw';
      req.body.rawLanguage = 'text';
      req.body.raw = data;
      if (!ct) req.headers.push(kvRow('Content-Type', 'application/x-www-form-urlencoded'));
    }
  } else if (uploadFile) {
    req.body.mode = 'binary';
  }

  if (extra.length) curlOpts.extra = extra.join(' ');
  if (Object.keys(curlOpts).length) req.settings.curl = { ...(req.settings.curl || {}), ...curlOpts };
  if (passthroughNames.size) {
    warnings.push(`curl 전용 옵션(${[...passthroughNames].map((n) => '--' + n).join(', ')})은 cURL 로 실행할 때 적용됩니다.`);
  }
  return { request: req, warnings, name: suggestName(req.method, url) };
}

function encodeDataUrlencode(v, warnings) {
  // curl --data-urlencode 형식: content | =content | name=content | @file | name@file
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  if (v.startsWith('@')) {
    warnings.push(`파일 데이터(${v})는 불러올 수 없습니다.`);
    return '';
  }
  const eq = v.indexOf('=');
  const at = v.indexOf('@');
  if (eq === 0) return enc(v.slice(1));
  if (eq > 0 && (at < 0 || eq < at)) return v.slice(0, eq) + '=' + enc(v.slice(eq + 1));
  if (at > 0) {
    warnings.push(`파일 데이터(${v})는 불러올 수 없습니다.`);
    return v.slice(0, at) + '=';
  }
  return enc(v);
}

// cURL 실행 시 그대로 전달할 옵션
const PASSTHROUGH = new Set([
  'proxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy-user', 'proxy-header', 'noproxy', 'proxy-insecure', 'proxytunnel',
  'cacert', 'capath', 'cert', 'key', 'cert-type', 'key-type', 'pass', 'ciphers', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'tls-max',
  'resolve', 'connect-to', 'interface', 'ipv4', 'ipv6', 'http2-prior-knowledge', 'http3', 'connect-timeout', 'retry', 'retry-delay',
  'retry-max-time', 'retry-all-errors', 'limit-rate', 'max-redirs', 'path-as-is', 'anyauth', 'fail', 'fail-with-body', 'globoff',
  'keepalive-time', 'no-keepalive', 'local-port', 'tcp-nodelay', 'raw', 'ssl-no-revoke', 'request-target', 'unix-socket', 'abstract-unix-socket',
  'location-trusted', 'post301', 'post302', 'post303', 'aws-sigv4', 'doh-url', 'dns-servers',
]);

function shellQuote(v) {
  const s = String(v);
  if (/^[A-Za-z0-9_\-.,:\/@%+=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function parseCookieString(s) {
  return String(s)
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i >= 0 ? kvRow(p.slice(0, i).trim(), p.slice(i + 1).trim()) : kvRow(p, '');
    });
}

// 폼 필드로 변환해도 전송 바이트가 완전히 같을 때만 urlencoded 모드 사용 (서명/HMAC 보존)
function isFormLike(data) {
  if (data === '') return false;
  if (!data.split('&').every((pair) => /^[^=\s{}\[\]"<>]+=[^\s]*$/.test(pair))) return false;
  try {
    return new URLSearchParams(data).toString() === data;
  } catch (e) {
    return false;
  }
}

function parseFormBody(data) {
  return data
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = i >= 0 ? pair.slice(0, i) : pair;
      const v = i >= 0 ? pair.slice(i + 1) : '';
      return kvRow(formDecode(k), formDecode(v));
    });
}

function formDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch (e) {
    return s;
  }
}

function isJson(s) {
  try {
    JSON.parse(s);
    return true;
  } catch (e) {
    return false;
  }
}

function prettyJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch (e) {
    return s;
  }
}

function hasHeader(list, name) {
  return list.some((x) => x.key.toLowerCase() === name);
}

function getHeader(list, name) {
  const hit = list.find((x) => x.key.toLowerCase() === name);
  return hit ? hit.value : null;
}

export function suggestName(method, url) {
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : 'http://' + url);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs.slice(-2).join('/');
    return last ? `${method} /${last}` : `${method} ${u.host}`;
  } catch (e) {
    return `${method} ${url}`.slice(0, 60);
  }
}

// 옵션 표 (curl-runner 의 추가 인자 검사에서 사용)
export {
  SHORT_WITH_VALUE as CURL_SHORT_WITH_VALUE,
  SHORT_ALIASES as CURL_SHORT_ALIASES,
  LONG_WITH_VALUE as CURL_LONG_WITH_VALUE,
  PASSTHROUGH as CURL_PASSTHROUGH,
};
