// 컬렉션 러너(ssoda/js/runner.js) 테스트
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { collectRequests, parseCsv, parseDataFile, runAll, summarize, summarizeRun, toJUnit, toHtml } = await import(new URL('../../ssoda/js/runner.js', import.meta.url).href);

const req = (method, url, tests) => ({ method, url, tests: tests || { extract: [], assert: [] } });
const COL = {
  id: 'c', name: 'API', items: [
    { id: 'r1', type: 'request', name: '로그인', request: req('POST', '{{base}}/login') },
    { id: 'f1', type: 'folder', name: '주문', items: [
      { id: 'r2', type: 'request', name: '목록', request: req('GET', '{{base}}/orders') },
      { id: 'f2', type: 'folder', name: '상세', items: [{ id: 'r3', type: 'request', name: '하나', request: req('GET', '{{base}}/orders/1') }] },
    ] },
    { id: 'r4', type: 'request', name: '로그아웃', request: req('POST', '{{base}}/logout') },
  ],
};

test('요청 모으기: 트리 순서, 폴더 경로', () => {
  const list = collectRequests(COL);
  assert.deepEqual(list.map((x) => [x.id, x.path]), [['r1', ''], ['r2', '주문'], ['r3', '주문 / 상세'], ['r4', '']]);
  assert.deepEqual(collectRequests(COL.items[1]).map((x) => x.id), ['r2', 'r3']);
  assert.deepEqual(collectRequests({ items: [] }), []);
});

test('CSV: 따옴표 안의 쉼표·줄바꿈, "" 는 따옴표, CRLF·BOM·빈 줄, 구분자(쉼표·탭·세미콜론) 알아냄', () => {
  assert.deepEqual(parseCsv('﻿id,name,memo\r\n1,"kim, 철수","줄1\n줄2"\r\n\r\n2,lee,"say ""hi"""\r\n'), [['id', 'name', 'memo'], ['1', 'kim, 철수', '줄1\n줄2'], ['2', 'lee', 'say "hi"']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a;b\n"1;5";2'), [['a', 'b'], ['1;5', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,'), [['a', 'b'], ['1', '']]);
  assert.throws(() => parseCsv('a\n"open'), /닫히지 않은 따옴표/);
});

test('데이터 파일: CSV 첫 줄이 열 이름, 모자란 칸은 빈 값 / JSON 은 객체 배열, 숫자 원문 그대로', () => {
  const csv = parseDataFile('id,name,\n1,kim\n2,lee,extra', 'users.csv');
  assert.equal(csv.kind, 'csv');
  assert.deepEqual(csv.columns, ['id', 'name']);
  assert.deepEqual(csv.rows, [{ id: '1', name: 'kim' }, { id: '2', name: 'lee' }]);
  const json = parseDataFile('[{"id":1234567890123456789,"user":{"n":"kim"},"ok":true},{"id":2,"extra":"x"}]', 'data.json');
  assert.equal(json.kind, 'json');
  assert.deepEqual(json.columns, ['id', 'user', 'ok', 'extra']);
  assert.deepEqual(json.rows[0], { id: '1234567890123456789', user: '{"n":"kim"}', ok: 'true' });
  assert.deepEqual(parseDataFile('{"a":"1"}').rows, [{ a: '1' }]); // 객체 하나 = 한 행
  assert.throws(() => parseDataFile('[1,2]', 'x.json'), /객체의 배열/);
  assert.throws(() => parseDataFile('[{"a":1}', 'x.json'), /JSON 을 읽을 수 없습니다/);
  assert.throws(() => parseDataFile('   '), /비어 있습니다/);
  assert.throws(() => parseDataFile(',,\n1,2', 'x.csv'), /열 이름/);
});

const ok = (status = 200, checks) => ({ ok: true, status, statusText: 'OK', method: 'GET', sentUrl: 'http://x/a?key=SECRET', timing: { total: 12.4 }, size: { body: 3 }, checks });
const err = (code = 'NETWORK') => ({ ok: false, method: 'GET', error: { message: '연결할 수 없습니다', code }, timing: { total: 5 } });
const checks = (asserts, captures = []) => ({ asserts, captures, passed: asserts.filter((a) => a.ok).length, failed: asserts.filter((a) => !a.ok).length });

test('실행: 반복마다 전체를 차례로, 데이터가 있으면 행 수만큼 반복하고 행을 넘김', async () => {
  const items = collectRequests(COL).slice(0, 2);
  const calls = [];
  const progress = [];
  const r = await runAll({
    name: 'API', items, iterations: 5, rows: [{ id: '1' }, { id: '2' }],
    exec: async (item, { iteration, row }) => { calls.push(`${iteration}:${item.id}:${row.id}`); return ok(); },
    onProgress: (p) => progress.push(`${p.done}/${p.total}`),
  });
  assert.deepEqual(calls, ['0:r1:1', '0:r2:1', '1:r1:2', '1:r2:2']);
  assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
  assert.equal(r.iterations, 2);
  assert.deepEqual(r.dataColumns, ['id']);
  const r2 = await runAll({ items, iterations: 3, exec: async () => ok() });
  assert.equal(r2.runs.length, 6);
  assert.equal(r2.dataColumns.length, 0);
});

test('실행: 실패하면 멈춤, 멈춤 신호, 실패의 뜻(응답 못 받음·확인 실패·꺼내기 실패 — 상태 코드만으로는 아님)', async () => {
  const items = collectRequests(COL);
  const r = await runAll({ items, iterations: 1, stopOnFailure: true, exec: async (item) => (item.id === 'r2' ? err() : ok()) });
  assert.equal(r.runs.length, 2);
  assert.equal(r.stoppedOnFailure, true);
  const ctrl = new AbortController();
  const r2 = await runAll({ items, iterations: 2, signal: ctrl.signal, exec: async (item) => { if (item.id === 'r3') ctrl.abort(); return item.id === 'r3' ? err('ABORTED') : ok(); } });
  assert.deepEqual(r2.runs.map((x) => x.item.id), ['r1', 'r2']); // 멈춤으로 끊긴 요청은 넣지 않음
  assert.equal(r2.stopped, true);
  const item = items[0];
  assert.equal(summarizeRun(item, 0, null, ok(500)).failed, false);
  assert.equal(summarizeRun(item, 0, null, ok(200, checks([{ target: 'status', op: 'eq', expected: '200', ok: false, actual: '500' }]))).failed, true);
  assert.equal(summarizeRun(item, 0, null, ok(200, checks([], [{ name: 't', ok: false, error: '없음' }]))).failed, true);
  assert.equal(summarizeRun(item, 0, null, ok(200, { skipped: '응답 없음', asserts: [], captures: [] })).failed, false);
  assert.equal(summarizeRun(item, 0, null, err()).failed, true);
});

test('보고서: JUnit 은 요청마다 testsuite·확인마다 testcase, HTML·XML 모두 특수 문자를 바꾸고 꺼낸 값·데이터 값은 넣지 않음', async () => {
  const evil = { id: 'x', name: '<script>alert(1)</script> & "q"', path: '', request: req('GET', 'http://h/a?token={{token}}') };
  const report = await runAll({
    name: 'API & <Test>', items: [evil, collectRequests(COL)[1]], rows: [{ password: 'P@ss-SECRET-1' }],
    exec: async (item) => (item.id === 'x'
      ? ok(200, checks([
        { target: 'status', op: 'eq', expected: '200', path: '', ok: true, actual: '200' },
        { target: 'json', path: '$.a', op: 'eq', expected: '1', ok: false, actual: '"<b>"', message: '' },
      ], [{ name: 'token', ok: true, value: 'TOKEN-SECRET-VALUE', savedTo: '환경 "개발"' }]))
      : err()),
  });
  const S = summarize(report);
  assert.deepEqual([S.requests, S.failed, S.errors, S.asserts, S.assertsPassed], [2, 2, 1, 2, 1]);
  const x = toJUnit(report);
  // testcase: 꺼내기 1 + 확인 2 (첫 요청) + 요청 오류 1 (둘째 요청) = 4
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="Ssoda: API &amp; &lt;Test&gt;" tests="4" failures="1" errors="1"/);
  assert.equal((x.match(/<testsuite /g) || []).length, 2);
  assert.match(x, /<testcase name="상태 코드 = 200"/);
  assert.match(x, /<failure message="찾은 값: &quot;&lt;b&gt;&quot;"\/>/);
  assert.match(x, /<error type="NETWORK" message="연결할 수 없습니다">GET \{\{base\}\}\/orders<\/error>/);
  assert.match(x, /<testcase name="변수 꺼내기: token"/);
  assert.ok(!x.includes('<script>') && !x.includes('TOKEN-SECRET-VALUE') && !x.includes('P@ss-SECRET-1') && !x.includes('key=SECRET'), x);
  const html = toHtml(report);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;'));
  assert.ok(!html.includes('<script>') && !html.includes('TOKEN-SECRET-VALUE') && !html.includes('P@ss-SECRET-1'), 'HTML 에 비밀 값');
  assert.match(html, /변수 꺼내기 token → 환경 &quot;개발&quot;/);
  assert.match(html, /확인 통과<b>1\/2<\/b>/);
});
