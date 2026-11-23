// ClickGuide 0단계 수정 회귀 테스트 (순수 모듈: 조사, 이동 단계 문장, Markdown 내보내기, AI 요청 본문, 숫자 설정)
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const COMMON = new URL('../../click-guide/src/common/', import.meta.url);

// settings.js 는 chrome.storage 를 쓴다 → 메모리 가짜
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    },
  },
};

const describe = await import(new URL('describe.js', COMMON).href);
const render = await import(new URL('render.js', COMMON).href);
const ai = await import(new URL('ai.js', COMMON).href);
const settings = await import(new URL('settings.js', COMMON).href);

test('조사: 받침 ㄹ 뒤에는 "로" (서울로, 7로, 8로, 1로, Excel로)', () => {
  for (const w of ['서울', '파일', '7', '8', '1', 'Excel', 'Gmail', 'Tool']) assert.equal(describe.josa(w, '으로/로'), '로', w);
});

test('조사: 그 밖의 받침 뒤에는 "으로" (부산으로, 3으로, 0으로, Room으로)', () => {
  for (const w of ['부산', '버튼', '3', '0', '6', 'Room', 'admin']) assert.equal(describe.josa(w, '으로/로'), '으로', w);
});

test('조사: 받침 없으면 "로", 을/를 등 다른 조사는 그대로', () => {
  assert.equal(describe.josa('페이지', '으로/로'), '로');
  assert.equal(describe.josa('서울', '을/를'), '을');
  assert.equal(describe.josa('파일', '이/가'), '이');
  assert.equal(describe.josa('페이지', '을/를'), '를');
  assert.equal(describe.josa('‘서울’', '으로/로'), '로');
});

test('이동 단계 제목: "서울로 이동"', () => {
  const d = describe.describeStep({ type: 'navigate', title: '서울', url: 'https://ex.com/a' }, 'ko');
  assert.equal(d.title, '서울로 이동');
});

test('이동 단계 문장에 경로·쿼리(토큰)가 들어가지 않음 (ko/en)', () => {
  const url = 'https://intranet.example.com/reset/abc123?token=SECRET&email=a%40b.com';
  for (const lang of ['ko', 'en']) {
    const d = describe.describeStep({ type: 'navigate', title: '비밀번호 재설정', url }, lang);
    assert.ok(!/SECRET|abc123|token|reset/.test(d.title + d.description), lang + ': ' + d.title + ' / ' + d.description);
  }
});

test('제목 없는 페이지는 호스트 이름으로 부름', () => {
  const d = describe.describeStep({ type: 'navigate', title: '', url: 'https://www.example.com/x?y=1' }, 'ko');
  assert.equal(d.title, 'example.com으로 이동');
  assert.ok(!/x\?y/.test(d.description));
});

test('Markdown 내보내기: HTML 태그·링크·강조·줄머리 문법이 글자로 나감', () => {
  const md = render.buildMarkdown(
    { name: '<b>가이드</b>', createdAt: 0, startUrl: 'https://ex.com', description: '# 제목 아님\n- 목록 아님\n1. 번호 아님\n---' },
    [{ id: 's1', title: '<img src=x onerror=alert(1)> 클릭', description: '[링크](javascript:alert(1)) **굵게** `코드` a_b_c' }],
    new Map([['s1', 'images/step-01.jpg']]),
    {},
  );
  assert.ok(!/<img|<b>/.test(md), 'HTML 태그가 남음');
  assert.ok(md.includes('&lt;img src=x onerror=alert(1)&gt;'), md);
  assert.ok(md.includes('\\[링크\\](javascript:alert(1))'), '링크 문법이 남음');
  assert.ok(md.includes('\\*\\*굵게\\*\\*') && md.includes('\\`코드\\`') && md.includes('a\\_b\\_c'), '강조·코드 문법이 남음');
  const lines = md.split('\n');
  assert.ok(lines.includes('\\# 제목 아님') && lines.includes('\\- 목록 아님') && lines.includes('1\\. 번호 아님') && lines.includes('\\---'), lines.join(' | '));
  assert.ok(md.includes('](images/step-01.jpg)'));
});

test('Markdown 내보내기: 평범한 한국어 문장은 그대로', () => {
  const md = render.buildMarkdown({ name: '가이드', createdAt: 0 }, [{ id: 's', title: '‘저장’ 버튼 클릭', description: '‘저장’ 버튼을 클릭합니다.' }], null, {});
  assert.ok(md.includes('## 1. ‘저장’ 버튼 클릭') && md.includes('‘저장’ 버튼을 클릭합니다.'), md);
});

test('AI 요청 본문에 입력값·페이지 제목·주소가 따로 들어가지 않음', async (t) => {
  let sentBody = null;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '[{"index":1,"title":"T","description":"D"}]' } }] }) };
  });
  const steps = [{
    id: 'a', type: 'input', el: { tag: 'input', label: '이메일' }, value: 'hong@example.com', masked: false,
    pageTitle: '고객 상세 - 홍길동', url: 'https://crm.example.com/customer/77?ssn=900101', title: '이메일 입력', description: '설명',
  }];
  const out = await ai.enhanceSteps(steps, { lang: 'ko', ai: { provider: 'openai', endpoint: 'http://127.0.0.1:9', model: 'm' } });
  const user = sentBody.messages.find((m) => m.role === 'user').content;
  assert.ok(!/hong@example|홍길동|crm\.example|ssn/.test(user), user);
  const payload = JSON.parse(user.slice(user.lastIndexOf('\n\n') + 2));
  assert.deepEqual(Object.keys(payload[0]).sort(), ['action', 'current', 'element', 'index']);
  assert.equal(out[0].title, 'T');
});

test('숫자 설정: 0·빈칸이면 기본값, 범위 밖이면 경계값 (이미지 폭 1×1 방지)', async () => {
  store.cg_settings = { maxImageWidth: 0, jpegQuality: '', highlightWidth: 0, captureDelayMs: 99999, maskValueChars: -3 };
  const s = await settings.getSettings();
  assert.equal(s.maxImageWidth, 1440);
  assert.equal(s.jpegQuality, 0.82);
  assert.equal(s.highlightWidth, 3);
  assert.equal(s.captureDelayMs, 2000);
  assert.equal(s.maskValueChars, 0);
  store.cg_settings = { maxImageWidth: 100 };
  assert.equal((await settings.getSettings()).maxImageWidth, 640);
  const saved = await settings.setSettings({ maxImageWidth: 0 });
  assert.equal(saved.maxImageWidth, 1440);
  assert.equal(store.cg_settings.maxImageWidth, 1440);
  store.cg_settings = { maxImageWidth: 1920, captureDelayMs: 0, maskValueChars: 4 };
  const ok = await settings.getSettings();
  assert.equal(ok.maxImageWidth, 1920);
  assert.equal(ok.captureDelayMs, 0);
  assert.equal(ok.maskValueChars, 4);
});
