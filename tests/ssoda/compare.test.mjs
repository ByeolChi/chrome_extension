// 환경 간 응답 비교(ssoda/js/compare.js) 테스트
// 실행: 저장소 최상위에서 npm test
// 화면(비교 탭)과 실제로 환경마다 보내는 것은 브라우저 시험(tests/e2e/ssoda)이 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const {
  diffJson, diffLines, diffSeq, diffHeaders, diffBodies, compareResults, makeIgnore, tokenizePattern, pathText, showValue,
  prettyJsonLines, sideBySide, lineHunks, ignorePathOf, DEFAULT_IGNORE_HEADERS,
} = await import(new URL('compare.js', JS).href);
const { parseJson } = await import(new URL('checks.js', JS).href);

const J = (s) => parseJson(s);
const enc = (s) => new TextEncoder().encode(s);
const res = (body, { status = 200, headers = [], ct = 'application/json' } = {}) => ({
  ok: true, status, headers: [{ name: 'Content-Type', value: ct }, ...headers], contentType: ct, body: enc(body),
});

test('JSON: 바뀐 값·더한 키·없어진 키를 경로로, 숫자는 원문 그대로(19자리 ID·소수 자릿수)', () => {
  const a = J('{"id":1234567890123456789,"price":10.00,"name":"kim","tags":["a","b"],"meta":{"v":1}}');
  const b = J('{"id":1234567890123456788,"price":10.0,"name":"kim","tags":["a"],"meta":{"v":1,"w":2},"extra":null}');
  const { diffs, truncated } = diffJson(a, b);
  assert.equal(truncated, false);
  assert.deepEqual(diffs.map((d) => [d.path, d.kind, showValue(d.a), showValue(d.b)]), [
    ['$.id', 'changed', '1234567890123456789', '1234567890123456788'],
    ['$.price', 'changed', '10.00', '10.0'],
    ['$.tags[1]', 'removed', '"b"', '(없음)'],
    ['$.meta.w', 'added', '(없음)', '2'],
    ['$.extra', 'added', '(없음)', 'null'],
  ]);
  // 같은 값이면 차이 없음 (키 순서는 상관없음)
  assert.equal(diffJson(J('{"a":1,"b":[true,null]}'), J('{"b":[true,null],"a":1}')).diffs.length, 0);
  // 형태가 다르면 그 자리에서 한 번만 (아래로 내려가지 않음)
  assert.deepEqual(diffJson(J('{"x":{"y":1}}'), J('{"x":[1]}')).diffs.map((d) => [d.path, d.kind, showValue(d.a), showValue(d.b)]),
    [['$.x', 'changed', '{…} (키 1개)', '[…] (1개)']]);
  // 문자열 "1" 과 숫자 1 은 다르다
  assert.equal(diffJson(J('{"n":"1"}'), J('{"n":1}')).diffs.length, 1);
});

test('뺄 곳: 키 이름(어느 깊이든)·경로 식([*]·.*·..·[\'이름\'])·# 줄 건너뜀·틀린 식은 오류로', () => {
  const a = J('{"ts":1,"data":{"updatedAt":"x","items":[{"id":1,"at":"p"},{"id":2,"at":"q"}],"m":{"k1":{"s":1},"k2":{"s":2}}},"a b":1,"trace":{"deep":{"traceId":"t1"}}}');
  const b = J('{"ts":2,"data":{"updatedAt":"y","items":[{"id":1,"at":"P"},{"id":3,"at":"Q"}],"m":{"k1":{"s":9},"k2":{"s":8}}},"a b":2,"trace":{"deep":{"traceId":"t2"}}}');
  const all = diffJson(a, b).diffs.map((d) => d.path);
  assert.deepEqual(all, ['$.ts', '$.data.updatedAt', '$.data.items[0].at', '$.data.items[1].id', '$.data.items[1].at', '$.data.m.k1.s', '$.data.m.k2.s', "$['a b']", '$.trace.deep.traceId']);
  const ig = makeIgnore(['# 시각', 'ts', 'updatedAt', '', '$.data.items[*].at', '$.data.m.*.s', "$['a b']", '$..traceId', '$.bad[', '$.x[foo]']);
  assert.deepEqual(ig.errors.map((e) => e.line), [9, 10]);
  assert.deepEqual(diffJson(a, b, ig).diffs.map((d) => d.path), ['$.data.items[1].id']);
  // 경로를 빼면 그 아래도 빠진다
  assert.deepEqual(diffJson(a, b, makeIgnore('$.data\n$.trace')).diffs.map((d) => d.path), ['$.ts', "$['a b']"]);
  // 특정 번째만
  assert.deepEqual(diffJson(a, b, makeIgnore(['$.data.items[0]', 'ts', 'updatedAt', '$.data.m', "$['a b']", '$.trace'])).diffs.map((d) => d.path), ['$.data.items[1].id', '$.data.items[1].at']);
  assert.throws(() => tokenizePattern('data.x'), /\$ 로 시작/);
  // 목록의 "빼기": 중간 번째는 [*], 끝 번째는 그대로
  assert.equal(ignorePathOf('$.items[0].at'), '$.items[*].at');
  assert.equal(ignorePathOf('$.a[1].b[2].c'), '$.a[*].b[*].c');
  assert.equal(ignorePathOf('$.items[2]'), '$.items[2]');
  assert.equal(ignorePathOf('$.m[0][3]'), '$.m[*][3]');
  assert.equal(ignorePathOf("$['a b']"), "$['a b']");
  assert.equal(pathText(tokenizePattern("$.a['b.c'][2].d")), "$.a['b.c'][2].d");
});

test('JSON 차이는 MAX_DIFFS 에서 끊고 truncated 로 알림', () => {
  const big = (k) => J(JSON.stringify({ list: Array.from({ length: 600 }, (_, i) => i * k) }));
  const r = diffJson(big(1), big(2));
  assert.equal(r.diffs.length, 500);
  assert.equal(r.truncated, true);
});

test('줄 비교(Myers): 같은 줄은 그대로, 바뀐 줄은 지움+더함, 앞뒤 같은 줄은 미리 뗌', () => {
  const r = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.equal(r.tooBig, false);
  assert.deepEqual(r.ops.map((o) => o.t + (o.t === '+' ? r.b[o.b] : r.a[o.a])), ['=a', '-b', '+B', '=c', '=d', '+e']);
  assert.equal(r.changed, 3);
  assert.equal(diffLines('같음\r\n줄', '같음\n줄').changed, 0); // 줄바꿈 종류는 상관없음
  assert.deepEqual(diffLines('', '').ops.map((o) => o.t), ['=']);
  // 무작위로 견주어 ops 를 따라가면 두 글이 그대로 나오는지
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let t = 0; t < 200; t++) {
    const A = Array.from({ length: rnd(12) }, () => 'xyz'[rnd(3)]);
    const B = Array.from({ length: rnd(12) }, () => 'xyz'[rnd(3)]);
    const d = diffSeq(A, B);
    const a2 = d.ops.filter((o) => o.t !== '+').map((o) => A[o.a]);
    const b2 = d.ops.filter((o) => o.t !== '-').map((o) => B[o.b]);
    assert.deepEqual(a2, A);
    assert.deepEqual(b2, B);
    for (const o of d.ops) if (o.t === '=') assert.equal(A[o.a], B[o.b]);
  }
  // 줄이 너무 많으면 줄 비교를 하지 않음
  const many = Array.from({ length: 10001 }, (_, i) => String(i)).join('\n');
  assert.equal(diffLines(many, many + '\nx').tooBig, true);
});

test('줄 차이 덩어리: 바뀐 줄 앞뒤 2줄씩, 떨어진 곳은 따로', () => {
  const A = Array.from({ length: 20 }, (_, i) => 'l' + i).join('\n');
  const B = A.replace('l3', 'L3').replace('l15', 'L15');
  const h = lineHunks(diffLines(A, B).ops, 2);
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => x.length), [6, 6]);
});

test('머리글: 이름은 대소문자 무시, 날짜·요청 ID 같은 머리글은 기본으로 빼고 더 뺄 수 있음', () => {
  const a = [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Version', value: '1.2' }, { name: 'Date', value: 'Mon' }, { name: 'X-Request-Id', value: 'r1' }, { name: 'X-Old', value: 'o' }];
  const b = [{ name: 'content-type', value: 'application/json' }, { name: 'x-version', value: '1.3' }, { name: 'date', value: 'Tue' }, { name: 'x-request-id', value: 'r2' }, { name: 'X-New', value: 'n' }];
  assert.deepEqual(diffHeaders(a, b).map((d) => [d.name, d.kind]), [['x-version', 'changed'], ['x-old', 'removed'], ['x-new', 'added']]);
  assert.ok(DEFAULT_IGNORE_HEADERS.includes('date') && DEFAULT_IGNORE_HEADERS.includes('x-request-id'));
  assert.deepEqual(diffHeaders(a, b, new Set([...DEFAULT_IGNORE_HEADERS, 'x-version', 'x-old', 'x-new'])), []);
  // 같은 이름이 여러 번이면 이어서 견준다
  assert.equal(diffHeaders([{ name: 'Vary', value: 'A' }, { name: 'Vary', value: 'B' }], [{ name: 'vary', value: 'A, B' }]).length, 0);
});

test('본문: JSON 이 아니면 줄 비교, 바이너리는 바이트가 같은지만, 한쪽만 JSON 이어도 줄 비교', () => {
  const t = diffBodies(res('hello\nworld', { ct: 'text/plain' }), res('hello\nthere', { ct: 'text/plain' }));
  assert.equal(t.mode, 'text');
  assert.equal(t.count, 2);
  const bin = (bytes) => ({ ok: true, status: 200, headers: [], contentType: 'image/png', body: new Uint8Array(bytes) });
  assert.deepEqual(diffBodies(bin([1, 2, 3]), bin([1, 2, 3])), { mode: 'binary', count: 0, same: true });
  assert.equal(diffBodies(bin([1, 2, 3]), bin([1, 2, 4])).count, 1);
  assert.equal(diffBodies(res('{"a":1}'), res('<html>', { ct: 'text/html' })).mode, 'text');
  const j = diffBodies(res('{"a":1,"ts":5}'), res('{"a":2,"ts":6}'), makeIgnore('ts'));
  assert.equal(j.mode, 'json');
  assert.deepEqual(j.diffs.map((d) => d.path), ['$.a']);
});

test('응답 둘: 상태 코드·머리글·본문 차이를 합쳐 세고, 못 받은 쪽은 failed 로', () => {
  const base = res('{"v":1}', { headers: [{ name: 'X-Version', value: '1' }, { name: 'Date', value: 'a' }] });
  const same = res('{"v":1}', { headers: [{ name: 'X-Version', value: '1' }, { name: 'Date', value: 'b' }] });
  assert.deepEqual(compareResults(base, same).same, true);
  const other = res('{"v":2}', { status: 500, headers: [{ name: 'X-Version', value: '2' }] });
  const c = compareResults(base, other);
  assert.equal(c.status, false);
  assert.equal(c.headers.length, 1);
  assert.equal(c.body.count, 1);
  assert.equal(c.count, 3);
  assert.equal(compareResults(base, other, { ignoreHeaders: ['X-Version'], ignoreBody: ['v'] }).count, 1);
  const fail = { ok: false, error: { message: 'x' } };
  assert.equal(compareResults(base, fail).failed, 'other');
  assert.equal(compareResults(fail, base).failed, 'base');
  assert.equal(compareResults(fail, fail).failed, 'both');
});

test('나란히 보기: JSON 줄을 경로로 맞추고, 다른 곳·뺀 곳을 줄마다 표시', () => {
  const a = J('{"id":1,"name":"kim","list":[1,2],"ts":5}');
  const b = J('{"id":1,"name":"lee","list":[1],"ts":6,"new":true}');
  const ig = makeIgnore('ts');
  const { diffs } = diffJson(a, b, ig);
  const L = prettyJsonLines(a, { ignore: ig, marks: new Set(diffs.filter((d) => d.kind !== 'added').map((d) => d.path)) }).lines;
  const R = prettyJsonLines(b, { ignore: ig, marks: new Set(diffs.filter((d) => d.kind !== 'removed').map((d) => d.path)) }).lines;
  assert.deepEqual(L.map((x) => x.text), ['{', '  "id": 1,', '  "name": "kim",', '  "list": [', '    1,', '    2', '  ],', '  "ts": 5', '}']);
  assert.deepEqual(L.filter((x) => x.mark).map((x) => x.key), ['$.name', '$.list[1]']);
  assert.deepEqual(L.filter((x) => x.ignored).map((x) => x.key), ['$.ts']);
  assert.deepEqual(R.filter((x) => x.mark).map((x) => x.key), ['$.name', '$.new']);
  const { rows, aligned } = sideBySide(L, R);
  assert.equal(aligned, true);
  // 같은 경로는 같은 행, 한쪽에만 있는 줄은 반대쪽이 비어 있음
  const row = (k) => rows.find((x) => (x.l || x.r).key === k);
  assert.equal(row('$.name').l.text.trim(), '"name": "kim",');
  assert.equal(row('$.name').r.text.trim(), '"name": "lee",');
  assert.equal(row('$.list[1]').r, null);
  assert.equal(row('$.new').l, null);
  assert.equal(row('$.ts').r.text.trim(), '"ts": 6,');
  // 줄이 많으면 limit 에서 멈춤
  const big = prettyJsonLines(J(JSON.stringify(Array.from({ length: 100 }, (_, i) => i))), { limit: 10 });
  assert.equal(big.lines.length, 10);
  assert.equal(big.truncated, true);
});
