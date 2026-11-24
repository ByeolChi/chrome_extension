// 공용 가리기 코어(shared/redact-core.js)의 순수 함수: 개인정보 패턴, 검증 숫자, 사각형 계산
// 화면 위치(DOM)와 그리기는 브라우저 시험(tests/e2e)에서 확인한다.
// 아래 번호는 모두 형식만 맞춘 가짜 값이다 (카드는 카드사가 공개한 시험용 번호).
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/redact-core.js');
const RC = globalThis.RedactCore;

const found = (text, opts) => RC.findPII(text, opts).map((m) => [m.type, m.text]);
const one = (text, type, opts) => assert.deepEqual(found(text, opts), [[type, text]], text);
const none = (text, opts) => assert.deepEqual(found(text, opts), [], text);

test('주민등록번호·외국인등록번호: 생년월일과 성별 숫자가 맞으면 잡음', () => {
  for (const s of ['900101-1234567', '900101 1234567', '9001011234567', '051231-4123456', '900101-5234567', '000229-3234567']) one(s, 'rrn');
  one('900101-1******', 'rrn');  // 뒷자리를 가렸어도 생년월일·성별이 드러남
  one('900101-1●●●●●●', 'rrn');
});

test('주민등록번호: 날짜가 틀리거나 형식이 다르면 잡지 않음', () => {
  for (const s of ['901301-1234567', '900230-1234567', '010229-3234567', '900100-1234567', '900101-9234567',
    '900101-0234567', '900101-12345678', '1900101-1234567', '900101 1******', '9001011******']) none(s);
});

test('카드번호: 흔한 묶음과 붙여 쓴 형태, Luhn 검사', () => {
  for (const s of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '5555 5555 5555 4444',
    '3782 822463 10005', '30569309025904', '6011-0009-9013-9424']) one(s, 'card');
  assert.ok(RC.luhnValid('6011000990139424'));
  for (const s of ['4111 1111 1111 1112', '4111-1111 1111-1111', '411111111111', '41111111111111111111']) none(s);
});

test('사업자등록번호: 000-00-00000 이고 검증 숫자가 맞을 때만', () => {
  one('124-81-00998', 'brn');
  none('124-81-00997');
  none('1248100998');         // 붙여 쓴 10자리는 우연히 통과하기 쉬워 잡지 않음
  assert.ok(RC.brnValid('1248100998'));
  assert.ok(!RC.brnValid('1248100997'));
});

test('휴대폰 번호: 010·011·016~019 와 +82, 구분자는 앞뒤가 같아야 함', () => {
  for (const s of ['010-1234-5678', '01012345678', '010 1234 5678', '010.1234.5678', '011-123-4567', '019-9876-5432',
    '+82 10-1234-5678', '+82-10-1234-5678', '+821012345678', '+82 (0)10 1234 5678']) one(s, 'phone');
  for (const s of ['02-123-4567', '031-123-4567', '010-1234-567', '010-1234-56789', '1010-1234-5678',
    '010-1234 5678', '012-1234-5678']) none(s);
});

test('이메일', () => {
  for (const s of ['hong@example.com', 'a.b+c@sub.example.co.kr', 'user_01@corp-mail.io']) one(s, 'email');
  for (const s of ['hong@localhost', '@example.com', 'hong@', 'hong@example.c']) none(s);
  assert.deepEqual(found('문의: hong@example.com.'), [['email', 'hong@example.com']]);
  assert.deepEqual(found('메일hong@example.com입니다'), [['email', 'hong@example.com']]);
});

test('계좌번호: 숫자 모양에 더해 글이나 주변에 계좌를 뜻하는 말이 있어야 함', () => {
  assert.deepEqual(found('입금 계좌 110-123-456789'), [['account', '110-123-456789']]);
  assert.deepEqual(found('국민은행 123456-01-123456'), [['account', '123456-01-123456']]);
  assert.deepEqual(found('농협 352-1234-5678-93'), [['account', '352-1234-5678-93']]);
  assert.deepEqual(found('계좌번호: 110123456789'), [['account', '110123456789']]);
  none('110-123-456789');                       // 말이 없으면 주문번호와 구별할 수 없음
  one('110-123-456789', 'account', { context: '<th>입금 계좌</th>' });
  one('110-123-456789', 'account', { context: () => 'Bank account' });
  none('주문번호 2024-1124-0001');
  none('계좌 2024-11-24');                       // 10자리보다 짧음
  none('계좌 1234-5678-9012-3456-78');           // 14자리보다 김
});

test('계좌 판정용 주변 글(context)은 필요할 때만 구함 — 큰 표에서 클릭이 굼떠지지 않게', () => {
  let calls = 0;
  const ctx = () => { calls++; return '입금 계좌'; };
  // 휴대폰·주민·사업자번호로 이미 잡힌 자리는 계좌인지 따지지 않는다
  for (const s of ['010-1234-5678', '900101-1234567', '124-81-00998']) RC.findPII(s, { context: ctx });
  assert.equal(calls, 0, '앞선 종류로 잡힌 번호에서 주변 글을 구함');
  // 날짜·금액처럼 개인정보가 될 수 없는 글도 구하지 않는다
  for (const s of ['2026-11-24', '6,498,700원', '주문 ORD-100001']) RC.findPII(s, { context: ctx });
  assert.equal(calls, 0, '개인정보가 될 수 없는 글에서 주변 글을 구함');
  // 계좌 모양인데 글 안에 단서가 없을 때만 한 번 구한다
  assert.deepEqual(found('110-123-456789 / 110-987-654321', { context: ctx }).map((m) => m[0]), ['account', 'account']);
  assert.equal(calls, 1);
});

test('여러 개가 섞인 글: 위치 순서, 겹치면 앞 종류가 이김', () => {
  const text = '주민 900101-1234567, 연락처 010-1234-5678, 메일 hong@example.com, 계좌 110-123-456789';
  assert.deepEqual(found(text), [
    ['rrn', '900101-1234567'], ['phone', '010-1234-5678'], ['email', 'hong@example.com'], ['account', '110-123-456789']
  ]);
  const ms = RC.findPII(text);
  for (const m of ms) assert.equal(text.slice(m.start, m.end), m.text);
  // 13자리가 주민번호이면서 계좌 모양이어도 주민번호
  assert.deepEqual(found('계좌 9001011234567'), [['rrn', '9001011234567']]);
  // 휴대폰 모양은 계좌 말이 있어도 휴대폰
  assert.deepEqual(found('송금 문의 010-1234-5678'), [['phone', '010-1234-5678']]);
  // 사업자번호는 계좌 말이 있어도 사업자번호
  assert.deepEqual(found('은행 사업자 124-81-00998'), [['brn', '124-81-00998']]);
});

test('앞뒤 경계: 더 긴 숫자의 일부는 잡지 않고, 글자로 둘러싸인 것은 잡음', () => {
  assert.deepEqual(found('tel:010-1234-5678;'), [['phone', '010-1234-5678']]);
  assert.deepEqual(found('ID12345678901234567890'), []);
  assert.deepEqual(found('x900101-1234567y'), [['rrn', '900101-1234567']]);
  assert.deepEqual(found('2900101-1234567'), []);
});

test('types 로 종류를 고를 수 있고, 숫자·@ 가 없거나 문자열이 아니면 빈 배열', () => {
  const text = '010-1234-5678 hong@example.com';
  assert.deepEqual(found(text, { types: ['email'] }), [['email', 'hong@example.com']]);
  assert.deepEqual(found(text, { types: ['phone'] }), [['phone', '010-1234-5678']]);
  for (const v of ['가나다라', '', null, undefined, 123, {}]) assert.deepEqual(RC.findPII(v), []);
  assert.deepEqual([...RC.PII_TYPES], ['rrn', 'card', 'brn', 'phone', 'account', 'email']);
  for (const t of RC.PII_TYPES) assert.ok(RC.PII_LABELS[t]);
});

test('rrnDateValid: 윤년과 세기', () => {
  assert.ok(RC.rrnDateValid('000229', 3));   // 2000-02-29
  assert.ok(!RC.rrnDateValid('000229', 1));  // 1900-02-29 는 없음
  assert.ok(RC.rrnDateValid('960229', 2));
  assert.ok(!RC.rrnDateValid('970229', 2));
  assert.ok(!RC.rrnDateValid('900101', 9));
});

test('toPixelRects: 배율을 곱하고 바깥쪽으로 반올림, 이미지 밖은 잘라 냄', () => {
  assert.deepEqual(RC.toPixelRects([{ x: 10.2, y: 5.5, w: 10, h: 10 }], 2, 2, 1000, 1000), [{ x: 20, y: 11, w: 21, h: 20 }]);
  // {x,y,width,height} 도 받음, 가로·세로 배율이 다를 수 있음
  assert.deepEqual(RC.toPixelRects([{ x: 1, y: 1, width: 2, height: 2 }], 1.5, 2, 100, 100), [{ x: 1, y: 2, w: 4, h: 4 }]);
  // 이미지 밖으로 걸친 부분은 자르고, 완전히 밖이면 버림
  assert.deepEqual(RC.toPixelRects([{ x: -5, y: 90, w: 20, h: 20 }, { x: 200, y: 0, w: 5, h: 5 }], 1, 1, 100, 100),
    [{ x: 0, y: 90, w: 15, h: 10 }]);
  // 숫자가 온전하지 않거나 넓이가 없으면 버림
  assert.deepEqual(RC.toPixelRects([null, { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 5 }, { x: 0, y: 0, w: -1, h: 5 }], 1, 1, 10, 10), []);
  // 배율·이미지 크기가 잘못되면 아무것도 돌려주지 않음
  assert.deepEqual(RC.toPixelRects([{ x: 0, y: 0, w: 1, h: 1 }], 0, 1, 10, 10), []);
  assert.deepEqual(RC.toPixelRects('x', 1, 1, 10, 10), []);
});

test('intersect·hull·rectFrom', () => {
  assert.deepEqual(RC.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.equal(RC.intersect({ x: 0, y: 0, w: 5, h: 5 }, { x: 5, y: 0, w: 5, h: 5 }), null);
  assert.deepEqual(RC.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 2, h: 2 }, true, false), { x: 5, y: 0, w: 2, h: 10 });
  assert.deepEqual(RC.hull({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 30, w: 5, h: 5 }), { x: 0, y: 0, w: 25, h: 35 });
  assert.deepEqual(RC.hull(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(RC.rectFrom({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(RC.rectFrom({ x: 1, y: 2 }), null);
});

test('RedactCore 는 바꿀 수 없음', () => {
  assert.ok(Object.isFrozen(RC));
  assert.equal(RC.version, 1);
});
