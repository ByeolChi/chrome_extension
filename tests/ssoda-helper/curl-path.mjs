// ssoda curl 실행 경로 시험: 확장 모듈(parseCurl → prepareRequest → runCurl) + 실제 도우미 + 실제 curl
// 실행: 저장소 최상위에서 node tests/ssoda-helper/curl-path.mjs   (다른 사본: SSODA_DIR=<ssoda 폴더>)
// 공유받은 요청·붙여넣은 cURL 에 PC 파일을 읽는 인자가 들어 있어도 내용이 밖으로 나가지 않는지 확인한다.
// 도우미 2.0: 여러 요청이 켜 둔 도우미 하나로 가는지, 취소·도우미가 갑자기 끝난 경우, 옛 도우미(1.3.2)면 예전처럼 요청마다 띄우는지도 본다.
// Windows 는 ssoda-host.ps1, 그 밖의 OS 는 ssoda-host.py 를 쓴다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SSODA_DIR, KINDS, startHost, reporter, importSsoda, hostScript } from './host.mjs';

const { check, finish } = reporter('curl 실행 경로 시험');
const KIND = KINDS[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssoda-curl-path-'));
const SECRET = 'TOPSECRET-' + Math.random().toString(36).slice(2, 8);
const secretFile = path.join(tmp, 'kubeconfig').replace(/\\/g, '/');
fs.writeFileSync(secretFile, `X-Kube-Token: ${SECRET}\n`);

const seen = [];
const cut = new Set(); // 응답 전에 연결이 끊긴 요청 (curl 이 멈춤)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body });
    const tag = new URL(req.url, 'http://x').searchParams.get('tag') || '';
    if (req.url.startsWith('/echo')) {
      // 느린 요청은 0.8초 뒤에
      setTimeout(() => res.end('echo:' + tag), tag.startsWith('slow') ? 800 : 0);
      return;
    }
    if (req.url.startsWith('/hang')) {
      // 답하지 않는다 (5초 뒤 끊어 남은 curl 이 없게)
      let byServer = false;
      res.on('close', () => { if (!res.writableEnded && !byServer) cut.add(tag); });
      setTimeout(() => {
        byServer = true;
        res.destroy();
      }, 5000);
      return;
    }
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

// chrome.runtime.connectNative → 실제 도우미. Chrome 처럼: 내가 disconnect() 하면 내 onDisconnect 는 부르지 않고,
// 끊긴 연결에 postMessage 하면 예외. 도우미가 끝나면(스스로·강제로) onDisconnect.
let hostFile = hostScript(KIND);
let spawned = 0;
const live = new Set();
globalThis.chrome = {
  runtime: {
    lastError: null,
    connectNative() {
      spawned++;
      const onMsg = [];
      const onDisc = [];
      let closed = false;
      const h = startHost(KIND, {
        script: hostFile,
        onMessage: (m) => { if (!closed) onMsg.forEach((f) => f(m)); },
        onExit: () => {
          live.delete(h);
          if (closed) return;
          closed = true;
          onDisc.forEach((f) => f());
        },
      });
      live.add(h);
      return {
        onMessage: { addListener: (f) => onMsg.push(f) },
        onDisconnect: { addListener: (f) => onDisc.push(f) },
        disconnect: () => {
          closed = true;
          h.close();
        },
        postMessage: (m) => {
          if (closed) throw new Error('Attempting to use a disconnected port object');
          h.send(m);
        },
      };
    },
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { parseCurl } = await importSsoda('curl-parser.js');
const { prepareRequest } = await importSsoda('prepare.js');
const { runCurl, curlOptsOf, helperSession, closeHelperSession, pingHelper } = await importSsoda('curl-runner.js');

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

/* ---------------- 도우미 2.0: 켜 둔 도우미 ---------------- */
const echo = (tag, opts = {}) => {
  const d = parseCurl(`curl http://127.0.0.1:${PORT}/echo?tag=${tag}`).request;
  return runCurl(prepareRequest(d, { forCurl: true }), curlOptsOf(d), opts)
    .then((r) => ({ status: r.status, body: new TextDecoder().decode(r.body) }), (e) => ({ error: e.message, code: e.code }));
};
const hang = (tag, opts = {}) => {
  const d = parseCurl(`curl http://127.0.0.1:${PORT}/hang?tag=${tag}`).request;
  return runCurl(prepareRequest(d, { forCurl: true }), curlOptsOf(d), opts).then((r) => ({ status: r.status }), (e) => ({ error: e.message, code: e.code }));
};

// 7) 지금까지의 요청은 켜 둔 도우미 하나로
check('지금까지의 요청이 모두 켜 둔 도우미 하나로 감 (요청마다 새로 띄우지 않음)', spawned === 1 && helperSession().connected && !helperSession().legacy,
  `도우미를 ${spawned}번 띄움, 연결=${helperSession().connected}`);

// 8) 동시에 세 요청 (느린 요청 하나 포함): 각자 자기 응답
let t0 = performance.now();
const three = await Promise.all([echo('slowA'), echo('fastB'), echo('fastC')]);
check('동시에 보낸 세 요청이 각자 자기 응답을 받음 (도우미 하나)', three.every((r, i) => r.status === 200 && r.body === 'echo:' + ['slowA', 'fastB', 'fastC'][i]) && spawned === 1,
  `${Math.round(performance.now() - t0)}ms, ${JSON.stringify(three.map((r) => r.body || r.error))}`);

// 9) 취소: 그 요청만 멈추고(curl 끊김) 도우미는 그대로
const ac = new AbortController();
const pending = hang('H1', { signal: ac.signal });
await sleep(600);
t0 = performance.now();
ac.abort();
const aborted = await pending;
const abortMs = performance.now() - t0;
await sleep(500);
const after = await echo('afterAbort');
check('취소한 요청만 멈추고(curl 끊김) 도우미는 계속, 다음 요청은 그대로', aborted.code === 'ABORTED' && cut.has('H1') && after.status === 200 && spawned === 1,
  `${aborted.code} ${Math.round(abortMs)}ms 만에, 서버에서 끊김=${cut.has('H1')}, 다음 요청 ${after.status ?? after.error}`);

// 10) 도우미가 갑자기 끝나면: 기다리던 요청은 오류, 다음 요청 때 다시 켬
const waiting = hang('H2');
await sleep(600);
[...live].forEach((h) => h.kill());
const killed = await waiting;
const again = await echo('afterKill');
check('도우미가 갑자기 끝나면 기다리던 요청은 오류로 끝나고, 다음 요청 때 다시 켬', killed.code === 'HOST_EXITED' && again.status === 200 && spawned === 2,
  `${killed.code}: ${killed.error} → 다음 요청 ${again.status ?? again.error}, 도우미를 ${spawned}번 띄움`);

// 11) closeHelperSession: 도우미가 끝나고 다음 요청 때 다시 켬
closeHelperSession();
await sleep(1500);
const liveAfterClose = live.size;
const reopened = await echo('afterClose');
check('연결을 닫으면 도우미가 끝나고, 다음 요청 때 다시 켬', liveAfterClose === 0 && reopened.status === 200 && spawned === 3 && helperSession().connected,
  `닫은 뒤 남은 도우미 ${liveAfterClose}개, 다음 요청 ${reopened.status ?? reopened.error}`);

// 12) 옛 도우미(1.3.2, git 기록의 fa81dfb): session 없이 답하면 예전처럼 요청마다 띄움
const oldText = spawnSync('git', ['show', `fa81dfb:ssoda/native-host/${path.basename(hostScript(KIND))}`], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}).stdout;
if (oldText && /1\.3\.2/.test(oldText)) {
  closeHelperSession();
  await sleep(800);
  hostFile = path.join(tmp, path.basename(hostScript(KIND)));
  fs.writeFileSync(hostFile, oldText);
  const before = spawned;
  const o1 = await echo('old1');
  const mid = spawned;
  const o2 = await echo('old2');
  check('옛 도우미(1.3.2)면 예전처럼 요청마다 새로 띄워 보냄', o1.status === 200 && o2.status === 200 && o1.body === 'echo:old1' && helperSession().legacy && spawned - mid === 1,
    `응답 ${o1.status ?? o1.error}/${o2.status ?? o2.error}, 첫 요청 ${mid - before}번(확인+요청)·둘째 ${spawned - mid}번 띄움`);
  // 13) 새 도우미를 설치하고 [연결 확인]을 누르면 다음 요청부터 켜 둔 도우미
  hostFile = hostScript(KIND);
  const st = await pingHelper();
  const n1 = await echo('new1');
  const base = spawned;
  const n2 = await echo('new2');
  check('새 도우미로 다시 설치한 뒤 연결을 확인하면 다음 요청부터 켜 둔 도우미로', st.ok && !helperSession().legacy && helperSession().connected && n1.status === 200 && n2.status === 200 && spawned === base,
    `확인 v${st.hostVersion}, 켜 둠=${helperSession().connected}, 둘째 요청에 띄운 도우미 ${spawned - base}개`);
} else {
  console.log('(git 기록에서 옛 도우미를 꺼내지 못해 옛 도우미 시험은 건너뜁니다)');
}

closeHelperSession();
await sleep(500);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(finish());
