// ssoda curl 실행 경로 시험: 확장 모듈(parseCurl → prepareRequest → runCurl) + 실제 도우미 + 실제 curl
// 실행: 저장소 최상위에서 node tests/ssoda-helper/curl-path.mjs   (다른 사본: SSODA_DIR=<ssoda 폴더>)
// 공유받은 요청·붙여넣은 cURL 에 PC 파일을 읽는 인자가 들어 있어도 내용이 밖으로 나가지 않는지 확인한다.
// Windows 는 ssoda-host.ps1, 그 밖의 OS 는 ssoda-host.py 를 쓴다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SSODA_DIR, KINDS, startHost, reporter, importSsoda } from './host.mjs';

const { check, finish } = reporter('curl 실행 경로 시험');
const KIND = KINDS[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-curl-path-'));
const SECRET = 'TOPSECRET-' + Math.random().toString(36).slice(2, 8);
const secretFile = path.join(tmp, 'kubeconfig').replace(/\\/g, '/');
fs.writeFileSync(secretFile, `X-Kube-Token: ${SECRET}\n`);

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/sse') {
      // 끝나지 않는 SSE: 0.2초마다 이벤트 하나
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const t = setInterval(() => res.write(`data: {"i":${++i}}\n\n`), 200);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const leaked = () => seen.some((s) => JSON.stringify(s).includes(SECRET));

// chrome.runtime.connectNative → 실제 도우미
globalThis.chrome = {
  runtime: {
    lastError: null,
    connectNative() {
      const onMsg = [];
      const onDisc = [];
      const h = startHost(KIND, { onMessage: (m) => onMsg.forEach((f) => f(m)), onExit: () => onDisc.forEach((f) => f()) });
      return {
        onMessage: { addListener: (f) => onMsg.push(f) },
        onDisconnect: { addListener: (f) => onDisc.push(f) },
        disconnect: () => h.close(),
        postMessage: (m) => h.send(m),
      };
    },
  },
};

const { parseCurl } = await importSsoda('curl-parser.js');
const { prepareRequest } = await importSsoda('prepare.js');
const { runCurl, curlOptsOf } = await importSsoda('curl-runner.js');

async function run(draft) {
  const p = prepareRequest(draft, { forCurl: true, allowBodyForGet: true });
  try {
    const r = await runCurl(p, curlOptsOf(draft), {});
    return { status: r.status, warnings: r.warnings || [] };
  } catch (e) {
    return { error: e.message, code: e.code, warnings: e.warnings || [] };
  }
}

console.log(`시험할 ssoda: ${SSODA_DIR} (${KIND} 도우미)`);

// 1) 공유받은 백업 속 요청: cURL 탭 추가 인자에 --proxy-header @파일
seen.length = 0;
const shared = parseCurl('curl http://example.test/api').request;
shared.settings.curl.extra = `--proxy http://127.0.0.1:${PORT} --proxy-header @${secretFile}`;
let r = await run(shared);
check('추가 인자의 --proxy-header @파일: 내용이 프록시로 나가지 않고 제외 안내가 뜸',
  !leaked() && r.status === 200 && r.warnings.some((w) => /@파일/.test(w)), `상태 ${r.status ?? r.error}, 유출=${leaked()}`);

// 2) 붙여넣은 cURL 에 같은 옵션
seen.length = 0;
const pasted = parseCurl(`curl --proxy http://127.0.0.1:${PORT} --proxy-header @${secretFile} http://example.test/api`);
r = await run(pasted.request);
check('붙여넣은 cURL 의 --proxy-header @파일: 내용이 나가지 않고 붙여넣을 때 안내가 뜸',
  !leaked() && r.status === 200 && pasted.warnings.some((w) => /@파일/.test(w)), `상태 ${r.status ?? r.error}, 유출=${leaked()}`);

// 3) 요청 주소가 file://
const fileReq = parseCurl('curl https://x.test/').request;
fileReq.url = 'file:///' + secretFile.replace(/^\//, '');
r = await run(fileReq);
check('file:// 주소는 실행하지 않음', r.code === 'INVALID_URL', r.error || `상태 ${r.status}`);

// 4) 헤더 이름이 @파일 (curl 은 -H @파일 을 파일로 읽는다)
seen.length = 0;
const hdrReq = parseCurl(`curl http://127.0.0.1:${PORT}/h`).request;
hdrReq.headers.push({ id: 'x', key: '@' + secretFile, value: '', enabled: true, description: '' });
r = await run(hdrReq);
check('헤더 이름이 @파일 이면 실행하지 않음', r.code === 'INVALID_HEADER' && !leaked(), r.error || `상태 ${r.status}`);

// 5) 정상 요청은 그대로 (큰 정수가 든 JSON Body 도 바이트 그대로)
seen.length = 0;
const ok = parseCurl(`curl -X POST http://127.0.0.1:${PORT}/ok -H 'X-A: 1' --json '{"id":1234567890123456789}' --retry 1`).request;
r = await run(ok);
check('정상 요청은 그대로 실행됨', r.status === 200 && seen[0]?.headers['x-a'] === '1' && seen[0]?.body === '{"id":1234567890123456789}',
  `상태 ${r.status ?? r.error}, X-A=${seen[0]?.headers['x-a']}, body=${seen[0]?.body}`);

// 6) SSE 를 받다가 --max-time 에 걸리면(curl 종료 코드 28) 오류가 아니라 받은 데까지 응답으로 (브라우저로 보낼 때와 같게)
const sseReq = parseCurl(`curl http://127.0.0.1:${PORT}/sse`).request;
sseReq.settings.timeout = 1500; // --max-time 2
let s;
try {
  const p = prepareRequest(sseReq, { forCurl: true, allowBodyForGet: true });
  const res = await runCurl(p, curlOptsOf(sseReq), {});
  s = {
    status: res.status, end: res.stream && res.stream.end, n: res.stream ? res.stream.events.length : -1, exit: res.terminal && res.terminal.exitCode,
    warned: (res.warnings || []).some((w) => /curl 이 스트림을 끊었습니다/.test(w)),
  };
} catch (e) {
  s = { error: e.message, code: e.code };
}
check('SSE 를 받다가 --max-time 에 걸리면 받은 이벤트까지 응답으로', s.status === 200 && s.end === 'timeout' && s.n >= 3 && s.exit === 28 && s.warned, JSON.stringify(s));

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(finish());
