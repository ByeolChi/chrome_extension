// ClickGuide 그림 데이터(annotate.js)와 단계 합치기 판단(steps.js) 테스트
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../../click-guide/src/common/', import.meta.url);
const { normalizeAnnotation, normalizeAnnotations, normalizeCrop, cropPixels, PALETTE } = await import(new URL('annotate.js', SRC).href);
const { isFieldClick, sameField, fieldClicksToMerge, mergedDescription } = await import(new URL('steps.js', SRC).href);

test('주석 정리: 모르는 종류·빈 글자는 버리고, 좌표는 0~1 로, 색은 #rrggbb 만', () => {
  const list = normalizeAnnotations([
    { type: 'arrow', x1: -1, y1: 0.5, x2: 2, y2: 0.5, color: 'red' },
    { type: 'rect', x: 0.9, y: 0.9, w: 0.5, h: 0.5, color: '#00ff00' },
    { type: 'text', x: 0.1, y: 0.1, text: '   ' },
    { type: 'text', x: 0.1, y: 0.1, text: '글자' },
    { type: 'badge', x: 0.5, y: 0.5, n: 12.7 },
    { type: 'zoom', sx: 0.1, sy: 0.1, sw: 0.1, sh: 0.1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    { type: 'script', x: 0 },
    null,
  ]);
  assert.deepEqual(list.map((a) => a.type), ['arrow', 'rect', 'text', 'badge', 'zoom']);
  assert.deepEqual([list[0].x1, list[0].x2, list[0].color], [0, 1, PALETTE[0]]);
  assert.ok(Math.abs(list[1].w - 0.1) < 1e-9 && Math.abs(list[1].h - 0.1) < 1e-9, JSON.stringify(list[1])); // 오른쪽 끝을 넘지 않게
  assert.equal(list[1].color, '#00ff00');
  assert.equal(list[3].n, 13);
  assert.ok(list.every((a) => typeof a.id === 'string' && a.id));
  assert.equal(normalizeAnnotation({ type: 'badge', x: 0, y: 0, n: 5000 }).n, 999);
  assert.equal(normalizeAnnotations('x').length, 0);
});

test('자르기: 너무 작으면 없음, 픽셀로 바꿀 때 이미지 밖은 자름', () => {
  assert.equal(normalizeCrop({ x: 0.1, y: 0.1, w: 0.01, h: 0.5 }), null);
  assert.equal(normalizeCrop(null), null);
  assert.deepEqual(normalizeCrop({ x: 0.5, y: 0.5, w: 0.9, h: 0.2 }), { x: 0.5, y: 0.5, w: 0.5, h: 0.2 });
  assert.deepEqual(cropPixels({ x: 0.1, y: 0.25, w: 0.5, h: 0.5 }, 800, 400), { x: 80, y: 100, w: 400, h: 200 });
  assert.equal(cropPixels({ x: 0, y: 0, w: 0.001, h: 0.5 }, 800, 400), null);
});

const click = (id, extra = {}) => ({ id, type: 'click', el: { tag: 'input', type: 'text', selector: '#name' }, url: 'https://a.test/', shotId: 's' + id, ...extra });
const input = (id, extra = {}) => ({ id, type: 'input', el: { tag: 'input', type: 'text', selector: '#name' }, url: 'https://a.test/', shotId: 's' + id, description: '이름에 입력', ...extra });

test('입력란 클릭 합치기: 바로 뒤에 같은 칸의 입력·선택이 오면 클릭(들)을 뺌', () => {
  assert.equal(isFieldClick(click('a')), true);
  assert.equal(isFieldClick(click('a', { el: { tag: 'input', type: 'checkbox' } })), false);
  assert.equal(isFieldClick(click('a', { el: { tag: 'button' } })), false);
  assert.equal(isFieldClick(click('a', { el: { tag: 'textarea' } })), true);
  const steps = [click('1'), click('2'), input('3'), click('4', { el: { tag: 'input', type: 'text', selector: '#other' } }), input('5')];
  assert.deepEqual(fieldClicksToMerge(steps).map((s) => s.id), ['1', '2']);
  // 입력 단계에 스크린샷이 없으면 클릭 단계(유일한 화면)를 지우지 않음
  assert.deepEqual(fieldClicksToMerge([click('1'), input('2', { shotId: null })]), []);
  // 다른 페이지면 합치지 않음
  assert.deepEqual(fieldClicksToMerge([click('1'), input('2', { url: 'https://a.test/other' })]), []);
  assert.deepEqual(fieldClicksToMerge([click('1', { el: { tag: 'select', selector: '#s' } }), { id: '2', type: 'select', el: { tag: 'select', selector: '#s' }, shotId: 'x' }]).map((s) => s.id), ['1']);
  assert.equal(sameField({ el: { tag: 'input', id: 'a' } }, { el: { tag: 'input', id: 'a' } }), true);
  assert.equal(sameField({ el: { tag: 'input', name: 'q', label: 'A' } }, { el: { tag: 'input', name: 'q', label: 'B' } }), false);
});

test('위 단계와 합치기의 설명: 같은 칸 클릭+입력이면 입력 설명만, 아니면 두 설명을 이음', () => {
  assert.equal(mergedDescription(click('1', { description: '이름 칸 클릭' }), input('2')), '이름에 입력');
  assert.equal(mergedDescription({ type: 'click', el: { tag: 'button' }, description: '저장 클릭' }, { type: 'click', description: ' 확인 클릭 ' }), '저장 클릭\n확인 클릭');
  assert.equal(mergedDescription({ type: 'note', description: '' }, { type: 'click', description: 'b' }), 'b');
});
