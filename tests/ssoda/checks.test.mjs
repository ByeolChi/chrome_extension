// 응답값 꺼내기·확인(ssoda/js/checks.js) 테스트
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const mod = (f) => import(new URL(f, JS).href);
const {
  parseJson, toJsonText, valueText, typeOf, jsonPath, compare, findValue, responseContext, runCaptures, runAsserts,
  normalizeTests, countTests, describeAssert, JsonNum,
} = await mod('checks.js');
const { normalizeRequest, requestSignature } = await mod('model.js');

const enc = (s) => new TextEncoder().encode(s);
const res = (body, extra = {}) => ({
  ok: true, status: 200, contentType: 'application/json', body: enc(body), headers: [], setCookies: [], hopCookies: [],
  timing: { total: 123.4 }, size: { body: enc(body).byteLength, headers: 10 }, url: 'https://api.test/login', ...extra,
});

const DOC = `{
  "data": { "token": "abc.def", "id": 1234567890123456789, "price": 10.10, "ok": true, "none": null, "a b": "space", "__proto__": "safe" },
  "items": [ { "id": 1, "name": "kim", "tags": ["x"] }, { "id": 2, "name": "lee", "age": 40 }, { "id": 3, "name": "park", "age": 7 } ]
}`;

test('parseJson: 숫자 원문 그대로, __proto__ 도 그냥 키, 틀린 JSON 은 위치와 함께 예외', () => {
  const v = parseJson('﻿' + DOC);
  assert.ok(v.data.id instanceof JsonNum);
  assert.equal(v.data.id.text, '1234567890123456789');
  assert.equal(v.data.price.text, '10.10');
  assert.equal(v.data.__proto__, 'safe');
  assert.equal(Object.getPrototypeOf(v.data), null);
  assert.equal(toJsonText(parseJson('{"a":[1,2.50,{"b":null}],"c":"\\u003c"}')), '{"a":[1,2.50,{"b":null}],"c":"<"}');
  for (const bad of ['{a:1}', '{"a":1,}', '[1,2', '', '{"a":1} x', '01', '"\t"']) assert.throws(() => parseJson(bad), SyntaxError, bad);
  assert.throws(() => parseJson('[1,2'), /번째 글자/);
});

test('JSON 경로: 점·대괄호·음수 index·*·..·목록·자르기·조건·length', () => {
  const v = parseJson(DOC);
  const q = (p) => jsonPath(v, p).map(valueText);
  assert.deepEqual(q('$.data.token'), ['abc.def']);
  assert.deepEqual(q('data.token'), ['abc.def']); // $ 없이도
  assert.deepEqual(q("$.data['a b']"), ['space']);
  assert.deepEqual(q('$["data"]["id"]'), ['1234567890123456789']);
  assert.deepEqual(q('$.items[0].name'), ['kim']);
  assert.deepEqual(q('$.items[-1].name'), ['park']);
  assert.deepEqual(q('$.items[*].id'), ['1', '2', '3']);
  assert.deepEqual(q('$.items[0,2].name'), ['kim', 'park']);
  assert.deepEqual(q('$.items[1:].name'), ['lee', 'park']);
  assert.deepEqual(q('$.items[:2].id'), ['1', '2']);
  assert.deepEqual(q('$..name'), ['kim', 'lee', 'park']);
  assert.deepEqual(q("$.items[?(@.name == 'lee')].id"), ['2']);
  assert.deepEqual(q('$.items[?(@.age > 10)].name'), ['lee']);
  assert.deepEqual(q('$.items[?(@.age)].name'), ['lee', 'park']);
  assert.deepEqual(q('$.items[?(@.name =~ /^p/)].id'), ['3']);
  assert.deepEqual(q('$.items[?(@.id != 1)].id'), ['2', '3']);
  assert.deepEqual(q('$.items.length'), ['3']);
  assert.deepEqual(q('$.items[0].tags'), ['["x"]']);
  assert.deepEqual(q('$.nope.x'), []);
  assert.deepEqual(q('$.items[9]'), []);
  assert.throws(() => jsonPath(v, '$.items['), /닫히지 않았습니다/);
  assert.throws(() => jsonPath(v, ''), /JSON 경로를 넣으세요/);
});

test('비교: 숫자는 숫자로(19자리 정확히), 문자열·따옴표·참거짓·null, 크기 비교', () => {
  const big = new JsonNum('1234567890123456789');
  assert.equal(compare('eq', big, '1234567890123456789').ok, true);
  assert.equal(compare('eq', big, '1234567890123456800').ok, false); // JSON.parse 였다면 같다고 나옴
  assert.equal(compare('eq', new JsonNum('10.10'), '10.1').ok, true);
  assert.equal(compare('eq', 200, '200').ok, true);
  assert.equal(compare('ne', 404, '200').ok, true);
  assert.equal(compare('eq', 'ok', 'ok').ok, true);
  assert.equal(compare('eq', 'ok', ' ok ').ok, true); // 앞뒤 공백은 뺌
  assert.equal(compare('eq', ' ok ', '" ok "').ok, true); // 따옴표로 감싸면 그대로
  assert.equal(compare('eq', '200', '200').ok, true); // 헤더 값 같은 문자열
  assert.equal(compare('eq', true, 'true').ok, true);
  assert.equal(compare('eq', null, 'null').ok, true);
  assert.equal(compare('eq', parseJson('{"b":1,"a":[1,2]}'), '{"a":[1,2],"b":1}').ok, true); // 키 순서 무관
  assert.equal(compare('gt', new JsonNum('9007199254740993'), '9007199254740992').ok, true); // Number 였다면 같음
  assert.equal(compare('lte', 1000, '1000').ok, true);
  assert.equal(compare('lt', new JsonNum('1.5'), '2').ok, true);
  assert.match(compare('gt', 'abc', '1').message, /숫자가 아닙니다/);
  assert.match(compare('gt', 5, 'x').message, /기대값이 숫자가 아닙니다/);
});

test('비교: 포함·정규식·있음·없음·타입, 값이 없으면 실패', () => {
  const arr = parseJson('["a","b",3]');
  assert.equal(compare('contains', 'application/json; charset=utf-8', 'application/json').ok, true);
  assert.equal(compare('contains', arr, 'b').ok, true);
  assert.equal(compare('contains', arr, '3').ok, true);
  assert.equal(compare('not_contains', arr, 'z').ok, true);
  assert.equal(compare('contains', parseJson('{"k":1}'), 'k').ok, true);
  assert.equal(compare('matches', 'abc123', '^[a-z]+\\d+$').ok, true);
  assert.equal(compare('matches', 'ABC', '/^abc$/i').ok, true);
  assert.match(compare('matches', 'x', '(').message, /정규식이 올바르지 않습니다/);
  assert.equal(compare('exists', undefined, '').ok, false);
  assert.equal(compare('not_exists', undefined, '').ok, true);
  assert.equal(compare('exists', null, '').ok, true); // null 도 값
  assert.equal(compare('type', arr, 'array').ok, true);
  assert.equal(compare('type', new JsonNum('1'), 'number').ok, true);
  assert.equal(compare('type', parseJson('{}'), 'object').ok, true);
  assert.match(compare('type', 'x', 'text').message, /string/);
  for (const op of ['eq', 'ne', 'contains', 'not_contains', 'gt', 'matches', 'type']) assert.equal(compare(op, undefined, 'x').ok, false, op);
  assert.equal(typeOf(undefined), 'undefined');
});

test('응답에서 값 찾기: 헤더(대소문자 무시·여러 개), 쿠키(리다이렉트 중 받은 것도, 나중 것이 이김), 정규식, 상태·시간·크기', () => {
  const r = res(DOC, {
    headers: [{ name: 'X-Request-Id', value: 'r-1' }, { name: 'Vary', value: 'A' }, { name: 'vary', value: 'B' }],
    hopCookies: [{ url: 'https://api.test/login', value: 'SESSION=old; Path=/' }],
    setCookies: ['SESSION=new; Path=/; HttpOnly', 'theme=dark'],
  });
  const ctx = responseContext(r);
  assert.equal(findValue('header', 'x-request-id', ctx), 'r-1');
  assert.equal(findValue('header', 'VARY', ctx), 'A, B');
  assert.equal(findValue('header', 'X-None', ctx), undefined);
  assert.equal(findValue('cookie', 'SESSION', ctx), 'new');
  assert.equal(findValue('cookie', 'theme', ctx), 'dark');
  assert.equal(findValue('cookie', 'nope', ctx), undefined);
  assert.equal(findValue('regex', '"token": "([^"]+)"', ctx), 'abc.def');
  assert.equal(findValue('regex', '/"TOKEN"/i', ctx), '"token"');
  assert.equal(findValue('regex', 'zzz', ctx), undefined);
  assert.equal(findValue('status', '', ctx), 200);
  assert.equal(findValue('time', '', ctx), 123);
  assert.equal(findValue('size', '', ctx), enc(DOC).byteLength);
  assert.equal(valueText(findValue('json', '$.items[*].name', ctx)), '["kim","lee","park"]'); // 여러 개면 배열
  assert.throws(() => findValue('json', '$.a', responseContext(res('<html>'))), /본문이 JSON 이 아닙니다/);
  assert.throws(() => findValue('header', '', ctx), /헤더 이름/);
});

test('꺼내기·확인 실행: 켜진 줄만, {{변수}} 바꿈, 찾지 못하면 오류로 표시', () => {
  const ctx = responseContext(res(DOC, { headers: [{ name: 'Content-Type', value: 'application/json' }] }));
  const vars = { p: '$.data.id', want: '200' };
  const resolve = (s) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? _);
  const caps = runCaptures([
    { id: 'c1', enabled: true, name: 'orderId', from: 'json', path: '{{p}}', scope: 'env' },
    { id: 'c2', enabled: true, name: 'missing', from: 'json', path: '$.nope', scope: 'env' },
    { id: 'c3', enabled: false, name: 'off', from: 'status', path: '', scope: 'env' },
    { id: 'c4', enabled: true, name: '  ', from: 'status', path: '', scope: 'env' },
  ], ctx, resolve);
  assert.deepEqual(caps.map((c) => [c.name, c.ok, c.value ?? c.error]), [['orderId', true, '1234567890123456789'], ['missing', false, '응답에서 값을 찾지 못했습니다']]);
  const asts = runAsserts([
    { id: 'a1', enabled: true, target: 'status', path: 'ignored', op: 'eq', value: '{{want}}' },
    { id: 'a2', enabled: true, target: 'json', path: '$.items.length', op: 'gte', value: '3' },
    { id: 'a3', enabled: true, target: 'header', path: 'content-type', op: 'contains', value: 'json' },
    { id: 'a4', enabled: true, target: 'json', path: '$.data.token', op: 'exists', value: 'ignored' },
    { id: 'a5', enabled: true, target: 'json', path: '$.data.id', op: 'eq', value: '1' },
    { id: 'a6', enabled: false, target: 'status', path: '', op: 'eq', value: '500' },
  ], ctx, resolve);
  assert.deepEqual(asts.map((a) => a.ok), [true, true, true, true, false]);
  assert.equal(asts[0].path, ''); // 상태 코드는 식을 쓰지 않음
  assert.equal(asts[0].expected, '200');
  assert.equal(asts[3].expected, ''); // 있음은 기대값을 쓰지 않음
  assert.equal(asts[4].actual, '1234567890123456789');
  assert.equal(describeAssert(asts[1]), 'JSON 경로 $.items.length ≥ 3');
  assert.equal(describeAssert(asts[3]), 'JSON 경로 $.data.token 있음');
});

test('모델: 요청의 tests 정리(이상한 값은 기본값), 켜진 줄 수, 서명에 id 는 넣지 않음', () => {
  const t = normalizeTests({ extract: [{ name: 'x', from: 'evil', scope: 'nowhere', enabled: 0 }, null, 'x'], assert: [{ target: 'json', op: '???', value: 5 }] });
  assert.equal(t.extract.length, 1);
  assert.deepEqual([t.extract[0].from, t.extract[0].scope, t.extract[0].enabled], ['json', 'env', true]);
  assert.deepEqual([t.assert[0].target, t.assert[0].op, t.assert[0].value], ['json', 'eq', '5']);
  assert.deepEqual(normalizeTests(undefined), { extract: [], assert: [] });
  assert.equal(countTests({ extract: [{ enabled: true, name: 'a' }, { enabled: true, name: '' }, { enabled: false, name: 'b' }], assert: [{ enabled: true }, { enabled: false }] }), 2);
  const r = normalizeRequest({ url: 'https://a.test', tests: { assert: [{ id: 'x1', target: 'status', op: 'eq', value: '200' }] } });
  assert.equal(r.tests.assert[0].id, 'x1');
  assert.deepEqual(normalizeRequest({ url: 'https://a.test' }).tests, { extract: [], assert: [] });
  const r2 = normalizeRequest({ url: 'https://a.test', tests: { assert: [{ id: 'other', target: 'status', op: 'eq', value: '200' }] } });
  assert.equal(requestSignature('n', r), requestSignature('n', r2));
});
