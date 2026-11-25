// YAML 읽기(ssoda/js/yaml.js) 테스트
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseYaml, YamlError } = await import(new URL('../../ssoda/js/yaml.js', import.meta.url).href);
const { JsonNum } = await import(new URL('../../ssoda/js/checks.js', import.meta.url).href);
// 프로토타입 없는 객체를 평범한 값으로 (deepEqual 비교용)
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof JsonNum ? `#${x.text}` : x)));

test('YAML: OpenAPI 모양 — 중첩 매핑, 시퀀스, 같은 칸의 시퀀스, 시퀀스 안의 매핑, 경로·응답 코드 키', () => {
  const v = parseYaml(`%YAML 1.2
---
openapi: 3.0.3   # 판
info:
  title: 'Pet''s API'
  version: "1.0"
servers:
- url: https://api.example.com/v1
  description: 운영
paths:
  /pets/{petId}:
    get:
      tags: [pets]
      parameters:
        - name: petId
          in: path
          required: true
          schema: {type: integer, format: int64}
      responses:
        '200':
          description: OK
        404:
          description: 없음
...
ignored: true`);
  assert.deepEqual(plain(v), {
    openapi: '3.0.3',
    info: { title: "Pet's API", version: '1.0' },
    servers: [{ url: 'https://api.example.com/v1', description: '운영' }],
    paths: { '/pets/{petId}': { get: {
      tags: ['pets'],
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer', format: 'int64' } }],
      responses: { 200: { description: 'OK' }, 404: { description: '없음' } },
    } } },
  });
});

test('YAML: 스칼라 타입 — null·~·참거짓·정수·실수·16진수, 19자리 정수는 원문 그대로, 따옴표는 문자열', () => {
  const v = parseYaml('a: ~\nb:\nc: true\nd: False\ne: 42\nf: -1.5e3\ng: 0x1F\nh: 1234567890123456789\ni: "123"\nj: 010\nk: .inf\nl: yes\nm: 2024-01-01');
  assert.equal(v.a, null);
  assert.equal(v.b, null);
  assert.equal(v.c, true);
  assert.equal(v.d, false);
  assert.equal(v.e, 42);
  assert.equal(v.f, -1500);
  assert.equal(v.g, 31);
  assert.ok(v.h instanceof JsonNum);
  assert.equal(v.h.text, '1234567890123456789');
  assert.equal(v.i, '123');
  assert.equal(v.j, 10);
  assert.equal(v.k, Infinity);
  assert.equal(v.l, 'yes'); // YAML 1.2: yes 는 문자열
  assert.equal(v.m, '2024-01-01');
  assert.equal(parseYaml('x: !!str 0123').x, '0123');
});

test('YAML: 문자열 — 이스케이프, 여러 줄 일반·따옴표 접기, 주석과 # 이 든 값, it\'s', () => {
  const v = parseYaml([
    'a: "탭\\t유니코드\\u00e9 \\"인용\\""',
    "b: 'single # not comment'   # 진짜 주석",
    "c: it's fine # 주석",
    'd: 첫 줄',
    '   이어지는 줄',
    '',
    '   빈 줄 다음',
    'e: "여러',
    '   줄 따옴표"',
    'f: http://example.com/a#frag',
    'g: a:b',
  ].join('\n'));
  assert.equal(v.a, '탭\t유니코드é "인용"');
  assert.equal(v.b, 'single # not comment');
  assert.equal(v.c, "it's fine");
  assert.equal(v.d, '첫 줄 이어지는 줄\n빈 줄 다음');
  assert.equal(v.e, '여러 줄 따옴표');
  assert.equal(v.f, 'http://example.com/a#frag');
  assert.equal(v.g, 'a:b');
});

test('YAML: 블록 문자열 | > 와 + - 표시, 빈 줄, 더 들여 쓴 줄', () => {
  const v = parseYaml([
    'lit: |',
    '  줄1',
    '    들여쓴 줄',
    '',
    '  줄3',
    'fold: >',
    '  가',
    '  나',
    '',
    '  다',
    'strip: |-',
    '  끝',
    '',
    'keep: |+',
    '  남김',
    '',
    'next: 1',
  ].join('\n'));
  assert.equal(v.lit, '줄1\n  들여쓴 줄\n\n줄3\n');
  assert.equal(v.fold, '가 나\n다\n');
  assert.equal(v.strip, '끝');
  assert.equal(v.keep, '남김\n\n');
  assert.equal(v.next, 1);
  assert.equal(parseYaml('- |\n  a\n  b\n- x').join('|'), 'a\nb\n|x');
});

test('YAML: 흐름 모음 [ ] { } — 중첩·여러 줄·따옴표·빈 값', () => {
  const v = parseYaml('a: [1, "two, 2", {k: v, n: [x, y]}]\nb: {a: 1,\n  b: [\n    3, 4\n  ], c}\nc: []\nd: {}');
  assert.deepEqual(plain(v), { a: [1, 'two, 2', { k: 'v', n: ['x', 'y'] }], b: { a: 1, b: [3, 4], c: null }, c: [], d: {} });
});

test('YAML: 앵커·별칭·병합 키', () => {
  const v = parseYaml('base: &b\n  type: string\n  maxLength: 10\nname:\n  <<: *b\n  maxLength: 20\nlist:\n  - *b\n  - &x 3\n  - *x');
  assert.deepEqual(plain(v), { base: { type: 'string', maxLength: 10 }, name: { type: 'string', maxLength: 20 }, list: [{ type: 'string', maxLength: 10 }, 3, 3] });
});

test('YAML: 시퀀스 안의 시퀀스·빈 항목, 맨 위가 시퀀스·스칼라', () => {
  assert.deepEqual(plain(parseYaml('- - a\n  - b\n-\n  - c\n- ')), [['a', 'b'], ['c'], null]);
  assert.equal(parseYaml('just text'), 'just text');
  assert.equal(parseYaml('# only comment\n'), null);
});

test('YAML: 틀린 곳은 줄 번호와 함께 알려 줌', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), (e) => e instanceof YamlError && /탭/.test(e.message) && e.line === 2);
  assert.throws(() => parseYaml('a: "열린\nb: 1'), /따옴표가 닫히지 않았습니다/);
  assert.throws(() => parseYaml('a: 1\n   b: 2'), /들여쓰기가 맞지 않습니다|읽지 못한 내용/);
  assert.throws(() => parseYaml('a: *nope'), /정의되지 않은 별칭입니다: \*nope \(1번째 줄\)/);
  assert.throws(() => parseYaml('? complex\n: v'), /복잡한 키/);
  assert.throws(() => parseYaml('a: [1, 2'), /닫히지 않았습니다/);
});
