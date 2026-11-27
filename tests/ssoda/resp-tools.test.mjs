// 응답 도구(ssoda/js/resp-tools.js) 테스트: JSONPath 필터, 본문 찾기, 큰 응답의 보이는 구간, 응답 예제
// 실행: 저장소 최상위에서 npm test
// 응답 화면(필터 칸·찾기 막대·비교 탭·예제 메뉴)은 브라우저 시험(tests/e2e/ssoda)이 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const mod = (f) => import(new URL(f, JS).href);
const {
  filterJson, findMatches, viewWindow, lineAt, makeExample, maskSetCookie, maskResult, exampleAsResult, normalizeExamples,
  assertFromFilter, suggestVarName, exampleProblem, EXAMPLE_MAX_BYTES,
} = await mod('resp-tools.js');
const { parseJson, isDefinitePath, JsonNum } = await mod('checks.js');
const { compareResults } = await mod('compare.js');
const { exportPostmanCollection, importPostmanCollection } = await mod('postman.js');
const { normalizeRequest } = await mod('model.js');
const { sanitizeBackupData } = await mod('backup-check.js');

const MASK = '••••••••';
const J = (s) => parseJson(s);
const enc = (s) => new TextEncoder().encode(s);
const LOGIN = '{"data":{"token":"tok-xyz","id":1234567890123456789},"items":[{"name":"kim","age":31},{"name":"lee","age":9}]}';

/* ---------------- JSONPath 필터 ---------------- */

test('isDefinitePath: 값 하나를 가리키는 경로인가 (*·..·조건·목록·자르기는 여러 개)', () => {
  for (const p of ['$', '$.a.b', "$['a b'][0]", '$.items[-1]', 'data.token', '$.items.length']) assert.equal(isDefinitePath(p), true, p);
  for (const p of ['$.a[*]', '$..id', '$.a[0,1]', '$.a[1:3]', "$.a[?(@.x == 1)]", '$.*']) assert.equal(isDefinitePath(p), false, p);
});

test('filterJson: 값 하나를 가리키면 그 값, 여럿일 수 있는 경로면 늘 배열 · 숫자는 원문 그대로', () => {
  const json = J(LOGIN);
  assert.deepEqual(pick(filterJson(json, '$.data.id')), { ok: true, count: 1, text: '1234567890123456789' });
  assert.equal(filterJson(json, '$.data.id').value.text, '1234567890123456789');
  assert.equal(filterJson(json, '$.data').text, '{\n  "token": "tok-xyz",\n  "id": 1234567890123456789\n}');
  assert.deepEqual(pick(filterJson(json, '$.items[*].name')), { ok: true, count: 2, text: '[\n  "kim",\n  "lee"\n]' });
  // 조건에 하나만 맞아도 배열 (경로가 여러 개를 고를 수 있으므로)
  assert.deepEqual(pick(filterJson(json, '$.items[?(@.age > 10)].name')), { ok: true, count: 1, text: '[\n  "kim"\n]' });
  assert.equal(filterJson(json, 'data.token').text, '"tok-xyz"');
  assert.equal(filterJson(json, '$.items.length').text, '2');
  assert.equal(filterJson(json, '$').text.split('\n').length, 16);
  // 없음: 하나를 가리키는 경로는 0개, 여러 개 경로는 빈 배열 대신 0개
  assert.deepEqual(pick(filterJson(json, '$.nope')), { ok: true, count: 0, text: '' });
  assert.deepEqual(pick(filterJson(json, '$.items[*].nope')), { ok: true, count: 0, text: '' });
  const bad = filterJson(json, '$.items[(');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /닫히지 않았습니다/);
});

const pick = (r) => ({ ok: r.ok, count: r.count, text: r.text });

test('assertFromFilter: 걸러 낸 값 하나(짧은 글·숫자·참거짓·null)는 "=" 확인, 나머지는 "있음"', () => {
  const json = J('{"name":"kim","pad":" kim ","id":1234567890123456789,"on":true,"none":null,"obj":{"a":1},"long":"' + 'x'.repeat(201) + '"}');
  const a = (p) => assertFromFilter(p, filterJson(json, p));
  assert.deepEqual(a('$.name'), { target: 'json', path: '$.name', op: 'eq', value: 'kim' });
  assert.deepEqual(a('$.pad'), { target: 'json', path: '$.pad', op: 'eq', value: '" kim "' });
  assert.deepEqual(a('$.id'), { target: 'json', path: '$.id', op: 'eq', value: '1234567890123456789' });
  assert.deepEqual(a('$.on'), { target: 'json', path: '$.on', op: 'eq', value: 'true' });
  assert.deepEqual(a('$.none'), { target: 'json', path: '$.none', op: 'eq', value: 'null' });
  for (const p of ['$.obj', '$.long', '$.*', '$.missing']) assert.deepEqual(a(p), { target: 'json', path: p, op: 'exists', value: '' }, p);
});

test('suggestVarName: 경로 끝의 이름 (꺼내기 줄의 변수 이름 처음 값)', () => {
  const cases = { '$.data.token': 'token', '$.items[*].id': 'id', '$.items[0]': 'items', '$..id': 'id', "$['token']": 'token', 'data.accessToken': 'accessToken', '$': '', '$.items.length': 'items', "$['a b']": '' };
  for (const [p, want] of Object.entries(cases)) assert.equal(suggestVarName(p), want, p);
});

/* ---------------- 찾기 ---------------- */

test('findMatches: 대소문자 무시가 기본, 글자는 그대로(특수 문자 포함), 정규식은 줄마다 ^ $', () => {
  const T = 'Alpha beta\nalpha BETA\nend [0] $.x';
  assert.deepEqual(findMatches(T, 'alpha').ranges, [[0, 5], [11, 16]]);
  assert.deepEqual(findMatches(T, 'alpha', { caseSensitive: true }).ranges, [[11, 16]]);
  const at = T.indexOf('[0] $.x');
  assert.deepEqual(findMatches(T, '[0] $.x').ranges, [[at, at + 7]]);
  assert.deepEqual(findMatches(T, '^a\\w+', { regex: true }).ranges, [[0, 5], [11, 16]]);
  assert.deepEqual(findMatches(T, '^a\\w+', { regex: true, caseSensitive: true }).ranges, [[11, 16]]);
  // 빈 길이로 맞는 곳은 건너뜀
  assert.deepEqual(findMatches(T, 'x*', { regex: true }).ranges, [[T.length - 1, T.length]]);
  const bad = findMatches(T, '(', { regex: true });
  assert.deepEqual(bad.ranges, []);
  assert.match(bad.error, /정규식/);
  assert.deepEqual(findMatches(T, ''), { ranges: [], capped: false, error: '' });
  const many = findMatches('aaaa', 'a', { max: 2 });
  assert.equal(many.ranges.length, 2);
  assert.equal(many.capped, true);
  // 한글
  assert.deepEqual(findMatches('이름: 김철수, 이름: 이영희', '이름').ranges, [[0, 2], [9, 11]]);
});

/* ---------------- 큰 응답: 보이는 구간 ---------------- */

test('viewWindow: 줄 단위로 자른 보이는 구간, 찾은 곳이 밖이면 그곳을 가운데로 · 줄 번호 이어짐', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'); // 줄 i 는 6i 에서 시작, 전체 59자
  assert.deepEqual(viewWindow(text, { size: 100 }), { start: 0, end: 59, line: 1 });
  assert.deepEqual(viewWindow(text, { size: 20 }), { start: 0, end: 17, line: 1 });
  assert.equal(text.slice(0, 17), 'line0\nline1\nline2');
  assert.deepEqual(viewWindow(text, { size: 20, focus: 40 }), { start: 30, end: 47, line: 6 });
  // 찾은 곳이 지금 구간 안이면 그대로
  assert.deepEqual(viewWindow(text, { size: 20, start: 30, focus: 33 }), { start: 30, end: 47, line: 6 });
  // 끝 가까이
  assert.deepEqual(viewWindow(text, { size: 20, focus: 58 }), { start: 48, end: 59, line: 9 });
  // 줄바꿈 없는 긴 한 줄은 그냥 자름
  assert.deepEqual(viewWindow('x'.repeat(50), { size: 20 }), { start: 0, end: 20, line: 1 });
  assert.equal(lineAt(text, 0), 1);
  assert.equal(lineAt(text, 36), 7);
  assert.equal(lineAt(text, 59), 10);
});

/* ---------------- 응답 예제 ---------------- */

const LOGIN_RESULT = () => ({
  ok: true, status: 200, statusText: 'OK', contentType: 'application/json',
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Set-Cookie', value: 'SESSION=s-1; Path=/; HttpOnly' },
    { name: 'X-Auth-Token', value: 'abc123' },
    { name: 'X-Echo', value: 'key=prod-secret-7788' },
  ],
  setCookies: ['SESSION=s-1; Path=/; HttpOnly'],
  body: enc('{"id":1234567890123456789,"key":"prod-secret-7788"}'),
  size: { body: 51, headers: 120 },
  timing: { total: 42.4 },
});

test('maskSetCookie: 쿠키 값만 가리고 속성은 둠 (값이 빈 지우기 쿠키는 그대로)', () => {
  assert.equal(maskSetCookie('SESSION=abc; Path=/'), `SESSION=${MASK}; Path=/`);
  assert.equal(maskSetCookie('SESSION=; Max-Age=0'), 'SESSION=; Max-Age=0');
  assert.equal(maskSetCookie('weird'), 'weird');
});

test('makeExample: 받은 글 그대로(19자리 숫자) 저장하되 비밀 변수 값·Set-Cookie 값·인증 머리글 값은 가림', () => {
  const { example, masked } = makeExample(LOGIN_RESULT(), { name: ' 정상 ', secrets: ['prod-secret-7788'], request: { method: 'GET', url: '{{host}}/x' }, now: 1000 });
  assert.match(example.id, /^ex/);
  assert.equal(example.name, '정상');
  assert.equal(example.savedAt, 1000);
  assert.equal(example.status, 200);
  assert.equal(example.statusText, 'OK');
  assert.equal(example.contentType, 'application/json');
  assert.equal(example.time, 42);
  assert.equal(example.size, 51);
  assert.equal(example.body, `{"id":1234567890123456789,"key":"${MASK}"}`);
  assert.deepEqual(example.headers, [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Set-Cookie', value: `SESSION=${MASK}; Path=/; HttpOnly` },
    { name: 'X-Auth-Token', value: MASK },
    { name: 'X-Echo', value: `key=${MASK}` },
  ]);
  assert.deepEqual(example.request, { method: 'GET', url: '{{host}}/x' });
  assert.deepEqual(masked, ['비밀 변수 값', 'Set-Cookie 값', 'X-Auth-Token 머리글 값']);
  // 이름을 안 주면 상태 줄
  assert.equal(makeExample(LOGIN_RESULT(), {}).example.name, '200 OK');
  assert.deepEqual(makeExample({ ...LOGIN_RESULT(), headers: [{ name: 'Content-Type', value: 'application/json' }] }, {}).masked, []);
});

test('makeExample: 응답 없음·바이너리·1MB 넘는 본문은 저장하지 않음', () => {
  assert.throws(() => makeExample({ ok: false, error: { message: 'x' } }), /응답/);
  assert.throws(() => makeExample({ ok: true, status: 200, contentType: 'image/png', headers: [], body: new Uint8Array([137, 80, 78, 71, 0, 1]) }), /바이너리/);
  assert.throws(() => makeExample({ ok: true, status: 200, contentType: '', headers: [], body: new Uint8Array([65, 0, 66]) }), /바이너리/);
  const big = { ok: true, status: 200, contentType: 'text/plain', headers: [], body: enc('a'.repeat(EXAMPLE_MAX_BYTES + 1)) };
  assert.throws(() => makeExample(big), /1MB/);
  assert.equal(makeExample({ ...big, body: enc('a'.repeat(EXAMPLE_MAX_BYTES)) }).example.body.length, EXAMPLE_MAX_BYTES);
  assert.equal(EXAMPLE_MAX_BYTES, 1024 * 1024);
});

test('exampleProblem: 예제로 저장할 수 없는 까닭 (이름을 묻기 전에 알림), 되면 빈 글', () => {
  assert.equal(exampleProblem(LOGIN_RESULT()), '');
  assert.match(exampleProblem(null), /응답/);
  assert.match(exampleProblem({ ok: true, status: 200, contentType: 'application/pdf', headers: [], body: new Uint8Array([1]) }), /바이너리/);
  assert.match(exampleProblem({ ok: true, status: 200, contentType: 'text/plain', headers: [], body: new Uint8Array(EXAMPLE_MAX_BYTES + 1) }), /1MB/);
});

test('exampleAsResult: 응답 화면·비교가 쓰는 결과 모양 · maskResult 와 견주면 가린 곳 때문에 다르다고 하지 않음', () => {
  const { example } = makeExample(LOGIN_RESULT(), { name: '정상', secrets: ['prod-secret-7788'], now: 1000 });
  const r = exampleAsResult(example);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(new TextDecoder().decode(r.body), example.body);
  assert.equal(r.contentType, 'application/json');
  assert.deepEqual(r.headers, example.headers);
  assert.deepEqual(r.setCookies, [`SESSION=${MASK}; Path=/; HttpOnly`]);
  assert.equal(r.timing.total, 42);
  assert.equal(r.size.body, enc(example.body).length);
  assert.deepEqual(r.example, { id: example.id, name: '정상', savedAt: 1000 });
  assert.equal(r.engine, 'example');
  // 지금 응답(진짜 비밀 값이 든)도 같은 방식으로 가려서 견주면 같음
  const now = maskResult(LOGIN_RESULT(), ['prod-secret-7788']);
  assert.equal(new TextDecoder().decode(now.body), example.body);
  assert.equal(compareResults(r, now).same, true);
  // 값이 바뀌면 그 경로만
  const changed = { ...LOGIN_RESULT(), body: enc('{"id":1234567890123456788,"key":"prod-secret-7788"}') };
  assert.deepEqual(compareResults(r, maskResult(changed, ['prod-secret-7788'])).body.diffs.map((d) => d.path), ['$.id']);
  // 바이너리는 그대로 둠
  const bin = { ok: true, status: 200, contentType: 'image/png', headers: [], body: new Uint8Array([1, 2]) };
  assert.equal(maskResult(bin, ['x']).body, bin.body);
});

test('normalizeExamples: 깨진 줄은 빼고 형식을 맞춤 (백업·가져오기)', () => {
  const out = normalizeExamples([null, 'x', { name: 'a', status: '201', headers: [{ name: 'A', value: 1 }, 'bad', { value: 'no name' }], body: 'b', savedAt: 'x' }, { name: 'big', body: 'a'.repeat(EXAMPLE_MAX_BYTES + 1) }]);
  assert.equal(out.length, 1);
  assert.match(out[0].id, /^ex/);
  const { id, ...rest } = out[0];
  assert.deepEqual(rest, { name: 'a', savedAt: 0, status: 201, statusText: '', headers: [{ name: 'A', value: '1' }], contentType: '', body: 'b', size: 1, time: 0 });
  assert.deepEqual(normalizeExamples('nope'), []);
  assert.equal(normalizeExamples(Array.from({ length: 150 }, () => ({ name: 'x', body: '' }))).length, 100);
  const kept = normalizeExamples([{ id: 'ex_1', name: 'n', status: 404, statusText: 'Not Found', body: 'z', request: { method: 'post', url: 5 }, time: 7.6 }]);
  assert.deepEqual(kept[0].request, { method: 'POST', url: '5' });
  assert.equal(kept[0].id, 'ex_1');
  assert.equal(kept[0].time, 8);
});

/* ---------------- Postman · 백업 ---------------- */

test('Postman: 예제를 response[] 로 내보내고 다시 가져오면 같음 (문자열 머리글도 읽음)', () => {
  const { example } = makeExample(LOGIN_RESULT(), { name: '정상', secrets: ['prod-secret-7788'], request: { method: 'GET', url: '{{host}}/x' } });
  const col = { id: 'c', name: 'C', description: '', auth: { type: 'none' }, variables: [], items: [
    { id: 'r1', type: 'request', name: 'R', request: normalizeRequest({ method: 'GET', url: '{{host}}/x' }), examples: [example] },
    { id: 'r2', type: 'request', name: 'R2', request: normalizeRequest({ method: 'GET', url: '{{host}}/y' }) },
  ] };
  const pm = JSON.parse(JSON.stringify(exportPostmanCollection(col)));
  const res = pm.item[0].response;
  assert.equal(res.length, 1);
  assert.equal(res[0].name, '정상');
  assert.equal(res[0].code, 200);
  assert.equal(res[0].status, 'OK');
  assert.equal(res[0].body, example.body);
  assert.equal(res[0]._postman_previewlanguage, 'json');
  assert.deepEqual(res[0].header[0], { key: 'Content-Type', value: 'application/json' });
  assert.equal(res[0].originalRequest.method, 'GET');
  assert.deepEqual(pm.item[1].response, []);
  const back = importPostmanCollection(pm).collection.items[0].examples;
  assert.equal(back.length, 1);
  for (const k of ['name', 'status', 'statusText', 'headers', 'body', 'contentType']) assert.deepEqual(back[0][k], example[k], k);
  assert.equal(back[0].request.method, 'GET');
  assert.equal(importPostmanCollection(pm).collection.items[1].examples, undefined);
  const s = importPostmanCollection({ info: { name: 'x' }, item: [{ name: 'r', request: { method: 'GET', url: 'http://a' }, response: [{ name: 'e', code: 404, status: 'Not Found', header: 'Content-Type: text/plain\nX-A: 1', body: 'nope' }] }] });
  const e = s.collection.items[0].examples[0];
  assert.deepEqual(e.headers, [{ name: 'Content-Type', value: 'text/plain' }, { name: 'X-A', value: '1' }]);
  assert.equal(e.contentType, 'text/plain');
  assert.equal(e.status, 404);
  assert.equal(e.body, 'nope');
});

test('백업 복원: 요청의 예제를 정리 (없으면 그대로 없음)', () => {
  const out = sanitizeBackupData({ collections: [{ id: 'c', name: 'C', items: [
    { id: 'r', type: 'request', name: 'R', request: {}, examples: [{ name: 'e', body: 5 }, 'bad'] },
    { id: 'r2', type: 'request', name: 'R2', request: {} },
  ] }] });
  const [a, b] = out.collections[0].items;
  assert.equal(a.examples.length, 1);
  assert.equal(a.examples[0].name, 'e');
  assert.equal(a.examples[0].body, '');
  assert.equal('examples' in b, false);
});

test('JsonNum 은 그대로 내보냄 (필터 결과의 숫자 원문)', () => {
  assert.ok(filterJson(J('{"p":0.10000000000000000555}'), '$.p').value instanceof JsonNum);
  assert.equal(filterJson(J('{"p":0.10000000000000000555}'), '$.p').text, '0.10000000000000000555');
});
