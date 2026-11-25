// SSE(text/event-stream) 해석 테스트 (ssoda/js/sse.js)
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSseParser, parseSse, isEventStream } = await import(new URL('../../ssoda/js/sse.js', import.meta.url).href);

const brief = (evs) => evs.map((e) => [e.type, e.data, e.id]);

test('SSE: 빈 줄마다 이벤트, 여러 data 줄은 줄바꿈으로 잇고 값 앞 공백 하나만 뺌', () => {
  const { events, comments, incomplete } = parseSse('data: a\n\ndata:  two\ndata: lines\n\nevent: done\ndata:{"x":1}\n\n');
  assert.deepEqual(brief(events), [['message', 'a', ''], ['message', ' two\nlines', ''], ['done', '{"x":1}', '']]);
  assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
  assert.equal(comments, 0);
  assert.equal(incomplete, null);
});

test('SSE: 주석·모르는 필드·data 없는 이벤트는 내보내지 않음, id 는 다음 이벤트에도 이어짐, retry 는 숫자만', () => {
  const { events, comments } = parseSse(': ping\n\nfoo: bar\n\nid: 7\nretry: 3000\ndata: x\n\ndata: y\n\nretry: 1s\nid\ndata\n\n');
  assert.deepEqual(brief(events), [['message', 'x', '7'], ['message', 'y', '7'], ['message', '', '']]);
  assert.equal(events[0].retry, 3000);
  assert.equal('retry' in events[2], false);
  assert.equal(comments, 1);
});

test('SSE: 줄 끝 CRLF·CR·LF 모두, 조각 경계에 걸린 CRLF 와 글자, 맨 앞 BOM', () => {
  const p = createSseParser();
  const out = [];
  for (const part of ['﻿data: 한', '글\r', '\n\r\ndata: b\r\rdata: c\n', '\n']) out.push(...p.push(part, 5));
  assert.deepEqual(brief(out), [['message', '한글', ''], ['message', 'b', ''], ['message', 'c', '']]);
  assert.equal(out[0].t, 5);
  assert.deepEqual(p.end(), { incomplete: null });
});

test('SSE: 빈 줄 없이 끝난 마지막 내용은 이벤트가 아니고 incomplete 로', () => {
  const { events, incomplete } = parseSse('data: done\n\ndata: half');
  assert.deepEqual(brief(events), [['message', 'done', '']]);
  assert.equal(incomplete, 'data: half');
  assert.equal(parseSse('data: a\ndata: b\n').incomplete, 'data: a\ndata: b');
});

test('SSE: Content-Type 판별', () => {
  assert.equal(isEventStream('text/event-stream'), true);
  assert.equal(isEventStream('Text/Event-Stream; charset=utf-8'), true);
  assert.equal(isEventStream('application/json'), false);
  assert.equal(isEventStream('text/event-streamx'), false);
  assert.equal(isEventStream(''), false);
});

test('SSE: 이벤트 2만 개도 빠르게', () => {
  const text = Array.from({ length: 20000 }, (_, i) => `id: ${i}\ndata: {"i":${i},"tok":"안녕"}\n\n`).join('');
  const t0 = performance.now();
  const p = createSseParser();
  let n = 0;
  for (let i = 0; i < text.length; i += 997) n += p.push(text.slice(i, i + 997)).length;
  const ms = performance.now() - t0;
  assert.equal(n, 20000);
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});
