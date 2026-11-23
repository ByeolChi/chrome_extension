// Ssoda cURL 붙여넣기: 문서에서 복사한 명령(둥근 따옴표·긴 대시), PowerShell 따옴표, 기존 형식 회귀
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCurl, tokenize } = await import(new URL('../../ssoda/js/curl-parser.js', import.meta.url).href);
const raw = String.raw;

test('둥근 따옴표로 바뀐 명령을 일반 따옴표로 해석하고 안내', () => {
  const { request: r, warnings } = parseCurl('curl -X POST “https://api.example.com/users” -H “Content-Type: application/json” -d ‘{“name”:“kim”}’');
  assert.equal(r.url, 'https://api.example.com/users');
  assert.deepEqual(r.headers.map((h) => [h.key, h.value]), [['Content-Type', 'application/json']]);
  assert.equal(r.body.raw, '{"name":"kim"}');
  assert.ok(warnings.some((w) => /둥근 따옴표/.test(w)));
});

test('긴 대시로 바뀐 옵션(–X, —data, –sSL, —header)', () => {
  const { request: r, warnings } = parseCurl('curl –sSL –X PUT —header “X-A: 1” —data “a=1” https://x.test/p');
  assert.equal(r.method, 'PUT');
  assert.deepEqual(r.headers.map((h) => h.key), ['X-A']);
  assert.equal(r.url, 'https://x.test/p');
  assert.equal(r.settings.followRedirects, true);
  assert.ok(warnings.some((w) => /긴 대시/.test(w)));
});

test("PowerShell 작은따옴표 안의 '' 는 작은따옴표 하나", () => {
  const { request: r } = parseCurl(`curl.exe -X POST 'https://api.example.com/q' -H 'Content-Type: application/json' -d '{"msg":"it''s ok"}'`);
  assert.equal(r.body.raw, `{"msg":"it's ok"}`);
});

test('PowerShell 큰따옴표 안의 `" 와 "" 와 \\" + 백틱 줄 연결', () => {
  const { request: r } = parseCurl('curl.exe -X POST "https://api.example.com/q" `\n  -H "Content-Type: application/json" `\n  -d "{`"a`":1,""b"":2,\\"c\\":3}"');
  assert.equal(r.body.raw, '{"a":1,"b":2,"c":3}');
  assert.deepEqual(r.headers.map((h) => h.key), ['Content-Type']);
});

test('PS 프롬프트가 붙은 명령', () => {
  const { request: r } = parseCurl(`PS C:\\Users\\me> curl.exe -d 'it''s' https://x.test/`);
  assert.equal(r.body.raw, "it's");
});

test("회귀: bash 의 '\\'' 이스케이프", () => {
  const { request: r } = parseCurl(raw`curl -X POST 'https://api.example.com/q' -d '{"msg":"it'\''s ok"}'`);
  assert.equal(r.body.raw, `{"msg":"it's ok"}`);
});

test("회귀: bash 의 작은따옴표 두 개는 문자열 이어 붙이기", () => {
  assert.deepEqual([...tokenize(`curl -d 'a''b' x`)], ['curl', '-d', 'ab', 'x']);
});

test('회귀: 일반 따옴표가 있으면 둥근 따옴표는 값 그대로', () => {
  const { request: r, warnings } = parseCurl(`curl -d '{"q":"“hi” ‘there’"}' https://api.example.com/x`);
  assert.equal(r.body.raw, '{"q":"“hi” ‘there’"}');
  assert.ok(!warnings.some((w) => /둥근/.test(w)));
});

test('회귀: 따옴표 안의 긴 대시는 그대로', () => {
  const { request: r } = parseCurl(`curl -d 'range –5 —x' https://x.test/`);
  assert.equal(r.body.raw, 'range –5 —x');
});

test('회귀: Chrome Copy as cURL (cmd)', () => {
  const { request: r } = parseCurl(raw`curl ^"https://x.test/a^" ^` + '\n' + raw`  -H ^"accept: */*^" ^` + '\n' + raw`  --data-raw ^"^{^\^"a^\^":1^}^"`);
  assert.equal(r.url, 'https://x.test/a');
  assert.equal(r.body.raw, '{"a":1}');
});
