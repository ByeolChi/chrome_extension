// ssoda cURL 실행 도우미(ssoda-host.ps1 / ssoda-host.py) 보안 시험 — 실제 도우미와 실제 curl
// 실행: 저장소 최상위에서 node tests/ssoda-helper/helper.mjs   (다른 사본: SSODA_DIR=<ssoda 폴더>)
//  - 127.0.0.1 에 기록용 서버(일반 서버 겸 프록시)를 띄우고, 서버가 실제로 받은 내용을 본다.
//  - 확장을 거치지 않고 도우미에 직접 인자를 보내, 도우미의 이중 검사만으로 막히는지 확인한다.
//  - PC 의 비밀 파일 내용(TOPSECRET-…)이 서버·프록시로 새거나, 다른 파일이 덮어써지면 실패.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SSODA_DIR, KINDS, startHost, b64text, reporter, hostScript, importSsoda } from './host.mjs';

const { check, finish } = reporter('도우미 보안 시험');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-helper-test-'));
const SECRET = 'TOPSECRET-' + Math.random().toString(36).slice(2, 8);
const secretFile = path.join(tmp, 'secret.txt');
fs.writeFileSync(secretFile, `X-Secret: ${SECRET}\r\n`);
const secretUrl = pathToFileURL(secretFile).href;
const { LATEST_HOST_VERSION } = await importSsoda('curl-runner.js');

/* ---------------- 기록용 서버 (일반 서버 겸 프록시) ---------------- */
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"id":1234567890123456789}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const leaked = () => seen.some((s) => JSON.stringify(s).includes(SECRET));
const target = `http://127.0.0.1:${PORT}/target`;
const TAIL = ['-D', '__CS_HDR__', '-o', '__CS_BODY__', '-w', '\\n__CSW__%{http_code}\\n'];

async function rawRun(kind, args, files = {}) {
  const h = startHost(kind);
  for (const [name, text] of Object.entries(files)) h.send({ type: 'file', name, data: Buffer.from(text).toString('base64') });
  h.send({ type: 'run', args, files: Object.keys(files), timeoutMs: 20000, curlPath: '' });
  const msgs = await h.until(['end', 'error'], 30000);
  h.close();
  const err = msgs.find((m) => m.type === 'error');
  const result = msgs.find((m) => m.type === 'result');
  return {
    error: err ? b64text(err.messageB64) : null,
    exitCode: result ? result.exitCode : null,
    stderr: result ? b64text(result.stderrB64) : '',
    body: Buffer.concat(msgs.filter((m) => m.type === 'body').map((m) => Buffer.from(m.data, 'base64'))).toString('utf8'),
    timeout: msgs.some((m) => m.type === 'timeout'),
  };
}

console.log(`시험할 ssoda: ${SSODA_DIR}`);
for (const kind of KINDS) {
  console.log(`\n=== ${kind} 도우미 (${path.basename(hostScript(kind))})`);
  {
    const h = startHost(kind);
    h.send({ type: 'ping', curlPath: '' });
    const msgs = await h.until(['pong', 'error'], 30000);
    h.close();
    const pong = msgs.find((m) => m.type === 'pong');
    check(`[${kind}] 도우미 버전이 확장이 기대하는 버전(v${LATEST_HOST_VERSION})과 같음`, pong && pong.hostVersion === LATEST_HOST_VERSION,
      pong ? `도우미 v${pong.hostVersion}, ${b64text(pong.curlB64)}` : '도우미가 응답하지 않음');
  }
  // 정상 요청은 막히면 안 된다 (확장이 실제로 보내는 형태)
  seen.length = 0;
  let r = await rawRun(kind, ['-sS', '--proto', '=http,https', '--proto-redir', '=http,https', '-X', 'PUT', '-H', 'X-Test: 1', '--user', '@admin:pw',
    '--data-binary', '@__CS_FILE_0__', '--max-time', '10', ...TAIL, '--url', target], { FILE_0: '{"a":1}' });
  check(`[${kind}] 정상 요청(raw body·--user)이 그대로 실행됨`, r.error === null && r.exitCode === 0 && seen[0]?.body === '{"a":1}' && seen[0]?.headers['x-test'] === '1', r.error || `exit ${r.exitCode}`);
  seen.length = 0;
  r = await rawRun(kind, ['-sS', '-F', 'up=@__CS_FILE_0__;filename="a.txt";type=text/plain', '-F', 'note=<__CS_FILE_1__', ...TAIL, '--url', target], { FILE_0: 'filedata', FILE_1: '메모' });
  check(`[${kind}] 정상 form-data(파일·텍스트)가 그대로 실행됨`, r.error === null && r.exitCode === 0 && /filedata/.test(seen[0]?.body || '') && /메모/.test(seen[0]?.body || ''), r.error || `exit ${r.exitCode}`);

  // PC 파일을 읽어 보내는 인자
  for (const [name, args] of [
    ['--proxy-header @파일 (프록시로 유출)', ['-sS', '--proxy', `http://127.0.0.1:${PORT}`, '--proxy-header', '@' + secretFile, ...TAIL, '--url', 'http://example.test/x']],
    ['-H @파일', ['-sS', '-H', '@' + secretFile, ...TAIL, '--url', target]],
    ['-F x=@로컬파일', ['-sS', '-F', 'x=@' + secretFile, ...TAIL, '--url', target]],
  ]) {
    seen.length = 0;
    r = await rawRun(kind, args);
    check(`[${kind}] ${name} 차단, 유출 없음`, !leaked() && !!r.error, r.error || `exit ${r.exitCode}, 유출=${leaked()}`);
  }
  // file:// 로 PC 파일 읽기, --next 로 --proto 없는 두 번째 전송
  r = await rawRun(kind, ['-sS', ...TAIL, '--url', secretUrl]);
  check(`[${kind}] file:// 주소는 실행되지 않음 (--proto)`, !r.body.includes(SECRET) && (!!r.error || r.exitCode !== 0), r.error || `exit ${r.exitCode} ${r.stderr.trim()}`);
  r = await rawRun(kind, ['-sS', ...TAIL, '--url', target, '--next', '-o', '__CS_BODY__', secretUrl]);
  check(`[${kind}] --next 차단`, !!r.error && !r.body.includes(SECRET), r.error || `exit ${r.exitCode}`);
  // 결과 파일 경로 바꾸기 (PC 파일 덮어쓰기)
  const out = path.join(tmp, `overwritten-${kind}.txt`);
  r = await rawRun(kind, ['-sS', '-D', '__CS_HDR__', '-o', out, '--url', target]);
  check(`[${kind}] -o 로컬 경로 차단`, !!r.error && !fs.existsSync(out), r.error || `exit ${r.exitCode}`);
  r = await rawRun(kind, ['-sSo', out, '--url', target]);
  check(`[${kind}] 묶음 옵션 -sSo 차단`, !!r.error && !fs.existsSync(out), r.error || `exit ${r.exitCode}`);
  // 로컬 소켓, 설정 파일
  r = await rawRun(kind, ['-sS', '--unix-socket', '/var/run/docker.sock', ...TAIL, '--url', 'http://localhost/containers/json']);
  check(`[${kind}] --unix-socket 차단`, !!r.error, r.error || `exit ${r.exitCode}`);
  r = await rawRun(kind, ['-sS', '--config', secretFile, ...TAIL, '--url', target]);
  check(`[${kind}] --config 차단`, !!r.error, r.error || `exit ${r.exitCode}`);
}

/* ---------------- 설치 파일: 도우미 스크립트가 깨지지 않고 들어가는지 ---------------- */
// 확장의 실제 설치 파일 생성 코드(helper-installer.js)를 그대로 쓴다.
globalThis.chrome = { runtime: { id: 'cnnlkogkbglbbbcefpaknbmebieabijo', getURL: (p) => pathToFileURL(path.join(SSODA_DIR, p)).href } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...rest) => (String(u).startsWith('file:')
  ? { ok: true, text: async () => fs.readFileSync(new URL(u), 'utf8') }
  : realFetch(u, ...rest));
const { buildInstaller } = await importSsoda('helper-installer.js');
console.log('\n=== 설치 파일');
const unix = await buildInstaller('mac', 'install');
const pyHost = fs.readFileSync(hostScript('py'), 'utf8');
check('macOS·Linux 설치 파일: 도우미 코드 안에 heredoc 끝 표시(CS_HOST_EOF) 줄이 없음', !/^CS_HOST_EOF\r?$/m.test(pyHost) && unix.content.includes('__CS_HOST_SCRIPT__') === false);
if (process.platform === 'win32') {
  const win = await buildInstaller('windows', 'install');
  const file = path.join(tmp, 'ssoda-helper-install.ps1');
  fs.writeFileSync(file, win.content, 'utf8');
  const ps = path.join(tmp, 'parse.ps1');
  fs.writeFileSync(ps, [
    'param([string]$Installer, [string]$HostPath)',
    '$text = [IO.File]::ReadAllText($Installer, [Text.Encoding]::UTF8)',
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)',
    "$here = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.StringConstantType -eq 'SingleQuotedHereString' }, $true) | Select-Object -First 1",
    '$orig = [IO.File]::ReadAllText($HostPath, [Text.Encoding]::UTF8).TrimEnd()',
    '$same = $false',
    'if ($here) { $same = (($here.Value -replace "`r`n", "`n") -eq ($orig -replace "`r`n", "`n")) }',
    '@{ errors = $errors.Count; embedded = $same } | ConvertTo-Json -Compress',
  ].join('\r\n'), 'utf8');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, file, hostScript('ps1')], { encoding: 'utf8' });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch (e) {
    /* 아래에서 실패로 표시 */
  }
  check('Windows 설치 파일: PowerShell 구문 오류 없음, 도우미 스크립트가 그대로 들어감', parsed && parsed.errors === 0 && parsed.embedded === true, res.stdout.trim() || res.stderr.trim());
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(finish());
