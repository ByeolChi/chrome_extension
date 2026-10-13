// 코드 스니펫 생성기
// 입력: prepareRequest()가 만든 prepared 객체
//  { method, url, headers:[{key,value}], body:{mode, text, fields, file}, settings:{followRedirects, timeout} }

export const CODEGEN_LANGS = [
  { id: 'curl', label: 'cURL', lang: 'shell' },
  { id: 'curl-cmd', label: 'cURL (Windows cmd)', lang: 'shell' },
  { id: 'fetch', label: 'JavaScript - Fetch', lang: 'javascript' },
  { id: 'axios', label: 'NodeJs - Axios', lang: 'javascript' },
  { id: 'python', label: 'Python - Requests', lang: 'python' },
  { id: 'httpie', label: 'Shell - HTTPie', lang: 'shell' },
  { id: 'powershell', label: 'PowerShell - Invoke-WebRequest', lang: 'powershell' },
  { id: 'go', label: 'Go - net/http', lang: 'go' },
];

export function generateCode(langId, p, opts = {}) {
  switch (langId) {
    case 'curl': return genCurl(p, opts);
    case 'curl-cmd': return genCurl(p, { ...opts, shell: 'cmd' });
    case 'fetch': return genFetch(p);
    case 'axios': return genAxios(p);
    case 'python': return genPython(p);
    case 'httpie': return genHttpie(p);
    case 'powershell': return genPowerShell(p);
    case 'go': return genGo(p);
    default: return '';
  }
}

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const jsStr = (s) => JSON.stringify(String(s));
const pyStr = (s) => {
  const str = String(s);
  if (str.includes('\n')) return '"""' + str.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '"""';
  return JSON.stringify(str);
};
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const goStr = (s) => {
  const str = String(s);
  if (!str.includes('`')) return '`' + str + '`';
  return JSON.stringify(str);
};

function fileName(f) {
  return (f && (f.name || f.fileHint)) || 'file';
}

function hasHeader(p, name) {
  return p.headers.some((h) => h.key.toLowerCase() === name);
}

/* ---------------- cURL ---------------- */
// opts: { shell: 'bash' | 'cmd', multiline: true, short: false, curl: {verbose, insecure, silent, include, compressed, http, extra} }
export function genCurl(p, opts = {}) {
  const shell = opts.shell === 'cmd' ? 'cmd' : 'bash';
  const short = !!opts.short;
  const multiline = opts.multiline !== false;
  const c = opts.curl || {};
  const q = shell === 'cmd' ? quoteCmd : quoteBash;
  const head = [];
  const rest = [];
  if (c.silent) head.push('-s');
  if (c.verbose) head.push('-v');
  if (c.include) head.push('-i');
  if (c.insecure) head.push('-k');
  if (c.compressed) head.push('--compressed');
  if (c.http === '1.0') head.push('--http1.0');
  else if (c.http === '1.1') head.push('--http1.1');
  else if (c.http === '2') head.push('--http2');
  if (p.settings?.followRedirects !== false) head.push(short ? '-L' : '--location');
  const b = p.body || { mode: 'none' };
  const hasBody = b.mode !== 'none';
  if (p.method === 'HEAD') head.push(short ? '-I' : '--head');
  else if (p.method !== (hasBody ? 'POST' : 'GET')) head.push((short ? '-X ' : '--request ') + p.method);
  head.push(q(p.url));
  for (const h of p.headers) {
    if (b.mode === 'formdata' && h.key.toLowerCase() === 'content-type' && /multipart/i.test(h.value)) continue;
    rest.push((short ? '-H ' : '--header ') + q(h.value === '' ? `${h.key};` : `${h.key}: ${h.value}`));
  }
  if (b.mode === 'raw') {
    const flag = b.text.startsWith('@') || !short ? '--data-raw ' : '-d ';
    rest.push(flag + q(b.text));
  } else if (b.mode === 'urlencoded') {
    for (const f of b.fields) rest.push('--data-urlencode ' + q(`${f.key}=${f.value}`));
  } else if (b.mode === 'formdata') {
    for (const f of b.fields) {
      if (f.type === 'file') rest.push((short ? '-F ' : '--form ') + q(`${f.key}=@"${fileName(f.file)}"`));
      else if (/^[@<]/.test(f.value)) rest.push('--form-string ' + q(`${f.key}=${f.value}`));
      else rest.push((short ? '-F ' : '--form ') + q(`${f.key}=${f.value}`));
    }
  } else if (b.mode === 'binary') {
    rest.push('--data-binary ' + q('@' + fileName(b.file)));
  }
  if (p.settings?.timeout) rest.push('--max-time ' + Math.max(1, Math.ceil(p.settings.timeout / 1000)));
  if (Array.isArray(c.extraArgs)) {
    if (c.extraArgs.length) rest.push(c.extraArgs.map((a) => (/^[A-Za-z0-9_\-.,:\/@%+=]+$/.test(a) ? a : q(a))).join(' '));
  } else if (c.extra && String(c.extra).trim()) rest.push(String(c.extra).trim());
  const first = 'curl ' + head.join(' ');
  if (!multiline) return [first, ...rest].join(' ');
  const cont = shell === 'cmd' ? ' ^' : ' \\';
  return [first, ...rest.map((r) => '  ' + r)].join(cont + '\n');
}

function quoteBash(s) {
  const str = String(s);
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// MSVCRT(curl.exe) 인자 규칙: 따옴표 앞의 역슬래시만 두 배로
function msvcrtInner(str) {
  let out = '';
  let bs = 0;
  for (const ch of str) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(bs * 2 + 1) + '"';
      bs = 0;
      continue;
    }
    out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2); // 닫는 따옴표 앞
}

// Windows cmd.exe: 특수문자가 없으면 읽기 쉬운 "..." 형식, 있으면 ^" 캐럿 이스케이프 형식 (Chrome "Copy as cURL (cmd)" 과 호환)
function quoteCmd(s) {
  const str = String(s);
  const inner = msvcrtInner(str);
  if (!/[&|<>^%!\r\n]/.test(str)) return '"' + inner + '"';
  return (
    '^"' +
    inner
      .replace(/[^a-zA-Z0-9\s_\-:=+~'\/.',?;()*`]/g, '^$&')
      .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
      .replace(/\r?\n/g, '^\n\n') +
    '^"'
  );
}

/* ---------------- fetch ---------------- */
function genFetch(p) {
  const out = [];
  const b = p.body || { mode: 'none' };
  const headers = p.headers.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type'));
  out.push('const myHeaders = new Headers();');
  for (const h of headers) out.push(`myHeaders.append(${jsStr(h.key)}, ${jsStr(h.value)});`);
  out.push('');
  let bodyVar = null;
  if (b.mode === 'raw') {
    let text = b.text;
    if (isJsonText(text)) out.push(`const raw = JSON.stringify(${JSON.stringify(JSON.parse(text), null, 2)});`);
    else out.push(`const raw = ${jsStr(text)};`);
    out.push('');
    bodyVar = 'raw';
  } else if (b.mode === 'urlencoded') {
    out.push('const urlencoded = new URLSearchParams();');
    for (const f of b.fields) out.push(`urlencoded.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
    out.push('');
    bodyVar = 'urlencoded';
  } else if (b.mode === 'formdata') {
    out.push('const formdata = new FormData();');
    for (const f of b.fields) {
      if (f.type === 'file') out.push(`formdata.append(${jsStr(f.key)}, fileInput.files[0], ${jsStr(fileName(f.file))});`);
      else out.push(`formdata.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
    }
    out.push('');
    bodyVar = 'formdata';
  } else if (b.mode === 'binary') {
    out.push('const file = fileInput.files[0]; // ' + fileName(b.file));
    out.push('');
    bodyVar = 'file';
  }
  out.push('const requestOptions = {');
  out.push(`  method: ${jsStr(p.method)},`);
  out.push('  headers: myHeaders,');
  if (bodyVar) out.push(`  body: ${bodyVar},`);
  out.push(`  redirect: ${jsStr(p.settings?.followRedirects === false ? 'manual' : 'follow')}`);
  out.push('};');
  out.push('');
  out.push(`fetch(${jsStr(p.url)}, requestOptions)`);
  out.push('  .then((response) => response.text())');
  out.push('  .then((result) => console.log(result))');
  out.push('  .catch((error) => console.error(error));');
  return out.join('\n');
}

/* ---------------- axios ---------------- */
function genAxios(p) {
  const out = ["const axios = require('axios');"];
  const b = p.body || { mode: 'none' };
  let dataExpr = null;
  if (b.mode === 'raw') {
    if (isJsonText(b.text)) out.push(`let data = JSON.stringify(${JSON.stringify(JSON.parse(b.text), null, 2)});`);
    else out.push(`let data = ${jsStr(b.text)};`);
    dataExpr = 'data';
  } else if (b.mode === 'urlencoded') {
    out.push("const qs = require('qs');");
    out.push('let data = qs.stringify({');
    out.push(b.fields.map((f) => `  ${jsStr(f.key)}: ${jsStr(f.value)}`).join(',\n'));
    out.push('});');
    dataExpr = 'data';
  } else if (b.mode === 'formdata') {
    out.push("const FormData = require('form-data');");
    out.push("const fs = require('fs');");
    out.push('let data = new FormData();');
    for (const f of b.fields) {
      if (f.type === 'file') out.push(`data.append(${jsStr(f.key)}, fs.createReadStream(${jsStr(fileName(f.file))}));`);
      else out.push(`data.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
    }
    dataExpr = 'data';
  } else if (b.mode === 'binary') {
    out.push("const fs = require('fs');");
    out.push(`let data = fs.readFileSync(${jsStr(fileName(b.file))});`);
    dataExpr = 'data';
  }
  out.push('');
  out.push('let config = {');
  out.push(`  method: ${jsStr(p.method.toLowerCase())},`);
  out.push('  maxBodyLength: Infinity,');
  out.push(`  url: ${jsStr(p.url)},`);
  const headers = p.headers.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type'));
  out.push('  headers: { ');
  const hl = headers.map((h) => `    ${jsStr(h.key)}: ${jsStr(h.value)}`);
  if (b.mode === 'formdata') hl.push('    ...data.getHeaders()');
  out.push(hl.join(', \n'));
  out.push('  },');
  if (p.settings?.followRedirects === false) out.push('  maxRedirects: 0,');
  if (p.settings?.timeout) out.push(`  timeout: ${p.settings.timeout},`);
  if (dataExpr) out.push(`  data : ${dataExpr}`);
  out.push('};');
  out.push('');
  out.push('axios.request(config)');
  out.push('.then((response) => {');
  out.push('  console.log(JSON.stringify(response.data));');
  out.push('})');
  out.push('.catch((error) => {');
  out.push('  console.log(error);');
  out.push('});');
  return out.join('\n');
}

/* ---------------- Python ---------------- */
function genPython(p) {
  const out = ['import requests'];
  const b = p.body || { mode: 'none' };
  const isJ = b.mode === 'raw' && isJsonText(b.text);
  if (isJ) out.push('import json');
  out.push('');
  out.push(`url = ${pyStr(p.url)}`);
  out.push('');
  let dataArg = null;
  let filesArg = null;
  if (b.mode === 'raw') {
    if (isJ) out.push(`payload = json.dumps(${pyLiteral(JSON.parse(b.text), 0)})`);
    else out.push(`payload = ${pyStr(b.text)}`);
    dataArg = 'payload';
  } else if (b.mode === 'urlencoded') {
    out.push('payload = {');
    out.push(b.fields.map((f) => `  ${pyStr(f.key)}: ${pyStr(f.value)}`).join(',\n'));
    out.push('}');
    dataArg = 'payload';
  } else if (b.mode === 'formdata') {
    const texts = b.fields.filter((f) => f.type !== 'file');
    const files = b.fields.filter((f) => f.type === 'file');
    out.push('payload = {');
    out.push(texts.map((f) => `  ${pyStr(f.key)}: ${pyStr(f.value)}`).join(',\n'));
    out.push('}');
    dataArg = 'payload';
    if (files.length) {
      out.push('files = [');
      out.push(files.map((f) => `  (${pyStr(f.key)}, (${pyStr(fileName(f.file))}, open(${pyStr(fileName(f.file))}, 'rb')))`).join(',\n'));
      out.push(']');
      filesArg = 'files';
    }
  } else if (b.mode === 'binary') {
    out.push(`payload = open(${pyStr(fileName(b.file))}, 'rb').read()`);
    dataArg = 'payload';
  } else {
    out.push('payload = {}');
    dataArg = 'payload';
  }
  const headers = p.headers.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type'));
  out.push('headers = {');
  out.push(headers.map((h) => `  ${pyStr(h.key)}: ${pyStr(h.value)}`).join(',\n'));
  out.push('}');
  out.push('');
  let call = `response = requests.request(${pyStr(p.method)}, url, headers=headers, data=${dataArg}`;
  if (filesArg) call += `, files=${filesArg}`;
  if (p.settings?.followRedirects === false) call += ', allow_redirects=False';
  if (p.settings?.timeout) call += `, timeout=${(p.settings.timeout / 1000).toString()}`;
  call += ')';
  out.push(call);
  out.push('');
  out.push('print(response.text)');
  return out.join('\n');
}

function pyLiteral(v, ind) {
  const pad = '  '.repeat(ind + 1);
  const end = '  '.repeat(ind);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => pad + pyLiteral(x, ind + 1)).join(',\n') + '\n' + end + ']';
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => pad + JSON.stringify(k) + ': ' + pyLiteral(v[k], ind + 1)).join(',\n') + '\n' + end + '}';
}

/* ---------------- HTTPie ---------------- */
function genHttpie(p) {
  const b = p.body || { mode: 'none' };
  const parts = [];
  let prefix = '';
  if (b.mode === 'raw') prefix = `printf ${sq(b.text)} | `;
  let cmd = 'http';
  if (b.mode === 'urlencoded') cmd += ' --form';
  if (b.mode === 'formdata') cmd += ' --multipart';
  if (p.settings?.followRedirects !== false) cmd += ' --follow';
  if (p.settings?.timeout) cmd += ' --timeout=' + Math.ceil(p.settings.timeout / 1000);
  cmd += ' ' + p.method + ' ' + sq(p.url);
  parts.push(prefix + cmd);
  for (const h of p.headers) {
    if (b.mode === 'formdata' && h.key.toLowerCase() === 'content-type') continue;
    parts.push(sq(`${h.key}:${h.value}`));
  }
  if (b.mode === 'urlencoded') for (const f of b.fields) parts.push(sq(`${f.key}=${f.value}`));
  if (b.mode === 'formdata')
    for (const f of b.fields) parts.push(sq(f.type === 'file' ? `${f.key}@${fileName(f.file)}` : `${f.key}=${f.value}`));
  if (b.mode === 'binary') parts.push('< ' + sq(fileName(b.file)));
  return parts.join(' \\\n  ');
}

/* ---------------- PowerShell ---------------- */
function genPowerShell(p) {
  const out = [];
  const b = p.body || { mode: 'none' };
  const headers = p.headers.filter((h) => !['content-type', 'user-agent', 'cookie'].includes(h.key.toLowerCase()));
  const ct = p.headers.find((h) => h.key.toLowerCase() === 'content-type');
  const ua = p.headers.find((h) => h.key.toLowerCase() === 'user-agent');
  const cookie = p.headers.find((h) => h.key.toLowerCase() === 'cookie');
  out.push('$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"');
  for (const h of headers) out.push(`$headers.Add(${psStr(h.key)}, ${psStr(h.value)})`);
  if (cookie) out.push(`$headers.Add('Cookie', ${psStr(cookie.value)})`);
  out.push('');
  let bodyArg = '';
  if (b.mode === 'raw') {
    // 리터럴 here-string (@' '@) : $ 변수 확장 없음
    out.push("$body = @'\n" + b.text.replace(/^'@/gm, "' @") + "\n'@");
    out.push('');
    bodyArg = ' -Body $body';
  } else if (b.mode === 'urlencoded') {
    out.push('$body = @{');
    for (const f of b.fields) out.push(`  ${psStr(f.key)} = ${psStr(f.value)}`);
    out.push('}');
    out.push('');
    bodyArg = ' -Body $body';
  } else if (b.mode === 'formdata') {
    out.push('$form = @{');
    for (const f of b.fields) {
      if (f.type === 'file') out.push(`  ${psStr(f.key)} = Get-Item -Path ${psStr(fileName(f.file))}`);
      else out.push(`  ${psStr(f.key)} = ${psStr(f.value)}`);
    }
    out.push('}');
    out.push('');
    bodyArg = ' -Form $form';
  } else if (b.mode === 'binary') {
    bodyArg = ` -InFile ${psStr(fileName(b.file))}`;
  }
  let cmd = `$response = Invoke-WebRequest -Uri ${psStr(p.url)} -Method ${p.method} -Headers $headers`;
  if (ct && b.mode !== 'formdata') cmd += ` -ContentType ${psStr(ct.value)}`;
  if (ua) cmd += ` -UserAgent ${psStr(ua.value)}`;
  cmd += bodyArg;
  if (p.settings?.followRedirects === false) cmd += ' -MaximumRedirection 0';
  if (p.settings?.timeout) cmd += ` -TimeoutSec ${Math.ceil(p.settings.timeout / 1000)}`;
  out.push(cmd);
  out.push('$response.Content');
  return out.join('\n');
}

/* ---------------- Go ---------------- */
function genGo(p) {
  const b = p.body || { mode: 'none' };
  const imports = new Set(['fmt', 'net/http', 'io']);
  const pre = [];
  let bodyExpr = 'nil';
  if (b.mode === 'raw') {
    imports.add('strings');
    pre.push(`  payload := strings.NewReader(${goStr(b.text)})`);
    bodyExpr = 'payload';
  } else if (b.mode === 'urlencoded') {
    imports.add('strings');
    imports.add('net/url');
    pre.push('  form := url.Values{}');
    for (const f of b.fields) pre.push(`  form.Add(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)})`);
    pre.push('  payload := strings.NewReader(form.Encode())');
    bodyExpr = 'payload';
  } else if (b.mode === 'formdata') {
    imports.add('bytes');
    imports.add('mime/multipart');
    imports.add('os');
    pre.push('  payload := &bytes.Buffer{}');
    pre.push('  writer := multipart.NewWriter(payload)');
    let fi = 0;
    for (const f of b.fields) {
      if (f.type === 'file') {
        const n = fi++;
        pre.push(`  file${n}, _ := os.Open(${JSON.stringify(fileName(f.file))})`);
        pre.push(`  defer file${n}.Close()`);
        pre.push(`  part${n}, _ := writer.CreateFormFile(${JSON.stringify(f.key)}, ${JSON.stringify(fileName(f.file))})`);
        pre.push(`  io.Copy(part${n}, file${n})`);
      } else pre.push(`  _ = writer.WriteField(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)})`);
    }
    pre.push('  writer.Close()');
    bodyExpr = 'payload';
  } else if (b.mode === 'binary') {
    imports.add('os');
    pre.push(`  payload, _ := os.Open(${JSON.stringify(fileName(b.file))})`);
    bodyExpr = 'payload';
  }
  const out = ['package main', '', 'import (', ...[...imports].sort().map((i) => `  "${i}"`), ')', '', 'func main() {', ''];
  out.push(`  reqURL := ${JSON.stringify(p.url)}`);
  out.push(`  method := ${JSON.stringify(p.method)}`);
  out.push('');
  out.push(...pre);
  out.push('');
  out.push('  client := &http.Client{}');
  out.push(`  req, err := http.NewRequest(method, reqURL, ${bodyExpr})`);
  out.push('  if err != nil {');
  out.push('    fmt.Println(err)');
  out.push('    return');
  out.push('  }');
  for (const h of p.headers) {
    if (b.mode === 'formdata' && h.key.toLowerCase() === 'content-type') continue;
    out.push(`  req.Header.Add(${JSON.stringify(h.key)}, ${JSON.stringify(h.value)})`);
  }
  if (b.mode === 'formdata') out.push('  req.Header.Set("Content-Type", writer.FormDataContentType())');
  out.push('');
  out.push('  res, err := client.Do(req)');
  out.push('  if err != nil {');
  out.push('    fmt.Println(err)');
  out.push('    return');
  out.push('  }');
  out.push('  defer res.Body.Close()');
  out.push('');
  out.push('  body, err := io.ReadAll(res.Body)');
  out.push('  if err != nil {');
  out.push('    fmt.Println(err)');
  out.push('    return');
  out.push('  }');
  out.push('  fmt.Println(string(body))');
  out.push('}');
  return out.join('\n');
}

function isJsonText(t) {
  const s = String(t || '').trim();
  if (!s || !(s.startsWith('{') || s.startsWith('['))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch (e) {
    return false;
  }
}

export { hasHeader };
