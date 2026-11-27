// ClickGuide 따라하기: 누를 곳을 다시 찾는 점수 규칙 (src/content/cues.js, DOM 없이)
// 실행: 저장소 최상위에서 npm test. 실제 페이지에서 찾는 시험은 tests/e2e/click-guide/play.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import(new URL('../../click-guide/src/content/cues.js', import.meta.url).href);
const C = globalThis.ClickGuideCues;

// 후보 정보 (candidateInfo 결과와 같은 모양)
const cand = (o = {}) => ({
  tag: 'button', type: '', role: '', id: '', name: '', placeholder: '', ariaLabel: '', testId: '', label: '', text: '', href: '',
  path: '', hostDepth: 0, visible: true, disabled: false, center: null, selectorHit: false, selectorCount: 0, ...o
});
const sc = (cues, c, opts) => C.score(cues, cand(c), opts);

test('data-testid 가 맞으면 id·글자가 바뀌어도 찾음 점수를 넘음', () => {
  const cues = { tag: 'button', cv: 2, testId: 'save-order', id: 'btn-7f3a9c21', label: '저장' };
  const r = sc(cues, { testId: 'save-order', id: 'other', label: 'Save' });
  assert.ok(r.score >= C.FOUND_SCORE, JSON.stringify(r));
  assert.ok(r.why.includes('testId'));
});

test('자동으로 만든 것 같은 id 는 약하게 친다', () => {
  for (const id of [':r1:', 'ember123', 'ext-gen1042', 'mui-12', 'radix-:r3:', 'field_20240101', '3f9a8b7c', 'input-a1b2c3']) {
    assert.equal(C.weakId(id), true, id);
  }
  for (const id of ['save', 'save-button', 'customer_name', 'btn1', 'main-nav']) assert.equal(C.weakId(id), false, id);
  const strong = sc({ tag: 'button', id: 'save-button' }, { id: 'save-button' }).score;
  const weak = sc({ tag: 'button', id: 'save-1690000000' }, { id: 'save-1690000000' }).score;
  assert.ok(strong > weak, `${strong} > ${weak}`);
  assert.ok(weak < C.FOUND_SCORE, '자동 id 하나만으로는 찾았다고 하지 않음');
});

test('이름(화면 글자)이 같으면 찾고, 전혀 다른 태그로 바뀌면 크게 깎는다 (링크↔버튼은 봐 줌)', () => {
  const cues = { tag: 'button', label: '주문 등록' };
  assert.ok(sc(cues, { label: '주문 등록' }).score >= C.FOUND_SCORE);
  assert.ok(sc(cues, { tag: 'a', label: '주문 등록' }).score >= C.FOUND_SCORE, '버튼이 링크로 바뀐 경우');
  assert.ok(sc(cues, { tag: 'td', label: '주문 등록' }).score < C.FOUND_SCORE, '표 칸은 아님');
  // 글자가 일부만 같으면 약하게
  assert.ok(sc(cues, { label: '주문 등록하기' }).score < sc(cues, { label: '주문 등록' }).score);
});

test('같은 이름의 버튼이 둘이면 녹화한 selector·경로·자리가 맞는 쪽이 이긴다', () => {
  const cues = {
    tag: 'button', label: '저장', cv: 2, selector: '#sec2 > button.save', path: 'html>body>section:2>button',
    hosts: undefined
  };
  const nrect = { x: 0.6, y: 0.4, w: 0.1, h: 0.05 };
  const a = sc(cues, { label: '저장', path: 'html>body>section>button', center: { x: 0.15, y: 0.42 } }, { nrect });
  const b = sc(cues, { label: '저장', path: 'html>body>section:2>button', center: { x: 0.65, y: 0.42 }, selectorHit: true, selectorCount: 1 }, { nrect });
  assert.ok(b.score > a.score + 10, `${b.score} > ${a.score}`);
});

test('보이지 않거나 누를 수 없는 후보는 깎는다', () => {
  const cues = { tag: 'button', label: '확인', id: 'ok' };
  const v = sc(cues, { label: '확인', id: 'ok' }).score;
  assert.ok(sc(cues, { label: '확인', id: 'ok', visible: false }).score < v * 0.5);
  assert.ok(sc(cues, { label: '확인', id: 'ok', disabled: true }).score < v);
});

test('태그·자리·경로만 맞는 후보는 고르지 않는다 (단서가 하나는 맞아야)', () => {
  const r = sc({ tag: 'button', cv: 2, path: 'html>body>button' }, { path: 'html>body>button', center: { x: 0.5, y: 0.5 } }, { nrect: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } });
  assert.equal(C.anyStrongCue(r.why), false, JSON.stringify(r));
  assert.equal(C.anyStrongCue(sc({ tag: 'button', label: 'A' }, { label: 'A' }).why), true);
});

test('예전 가이드(새 단서 없음)도 id·이름·selector·placeholder 로 찾는다', () => {
  const old = { tag: 'input', type: 'text', role: '', label: '고객 이름', href: '', name: 'customer', id: '', placeholder: '홍길동', selector: 'form > input:nth-of-type(2)' };
  const r = sc(old, { tag: 'input', type: 'text', name: 'customer', placeholder: '홍길동', label: '고객 이름', selectorHit: true, selectorCount: 1 });
  assert.ok(r.score >= C.FOUND_SCORE + 30, JSON.stringify(r));
  // 이름은 같지만 다른 칸이면 훨씬 낮다
  const other = sc(old, { tag: 'input', type: 'text', name: 'memo', label: '메모' });
  assert.ok(other.score < C.FOUND_SCORE, JSON.stringify(other));
});

test('링크는 같은 주소면 강하게, 경로만 같으면 약하게', () => {
  const cues = { tag: 'a', label: '목록', href: 'https://x.test/orders?page=1' };
  const same = sc(cues, { tag: 'a', label: '목록', href: 'https://x.test/orders?page=1' }).score;
  const host = sc(cues, { tag: 'a', label: '목록', href: 'https://y.test/orders?page=1' }).score;   // 개발·운영 서버
  const other = sc(cues, { tag: 'a', label: '목록', href: 'https://x.test/users' }).score;
  assert.ok(same > host && host > other, `${same} > ${host} > ${other}`);
});

test('경로 점수: 요소 쪽에서부터 같은 만큼', () => {
  assert.equal(C.pathScore('html>body>div>button', 'html>body>div>button'), 12);
  assert.equal(C.pathScore('html>body>div:2>button', 'html>body>div>button'), 2);
  assert.equal(C.pathScore('html>body>main>div>form>button:2', 'html>body>div>main>div>form>button:2'), 8);
  assert.equal(C.pathScore('', 'html>body'), 0);
});

test('shadow DOM 깊이와 프레임 점수를 더한다', () => {
  const cues = { tag: 'button', label: '날짜 고르기', cv: 2, hosts: [{ tag: 'x-picker', id: '', selector: 'x-picker' }] };
  const inside = sc(cues, { label: '날짜 고르기', hostDepth: 1 }, { frameBonus: 6 });
  const outside = sc(cues, { label: '날짜 고르기', hostDepth: 0 }, { frameBonus: -12 });
  assert.ok(inside.score - outside.score >= 20, `${inside.score} vs ${outside.score}`);
});
