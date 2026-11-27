// CleanShot Picker 한 번에 정리·사이트별 레시피(cleanshot-picker/recipes.js)의 순수 함수
//  - 사이트 이름(hostKey), 오래 남을 id·클래스 고르기(stableId·stableClass)
//  - 한 번에 정리의 판정: 쿠키 배너·채팅 버튼·앱 설치 배너(classify), "오늘 하루 보지 않기" 공지 팝업(popupContainer), 가림막(isBackdrop)
//  - 레시피 저장값 고르기(normalizeStore)·더하기(addItems)·요약(summary)
// 페이지에서 실제로 찾아 숨기고, 선택자를 만들고, 다시 켰을 때 적용하는 것은 브라우저 시험(tests/e2e/cleanshot-picker 의 clean·recipe 구역)이 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../../cleanshot-picker/recipes.js');
const R = globalThis.CleanShotRecipes;

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const VIEW = { w: 1280, h: 800 };
/* 판정에 넘기는 요소 정보. 빠진 칸은 "글자 없는 작은 요소" */
const el = (over = {}) => ({
  pos: 'fixed', rect: { x: 0, y: 0, w: 100, h: 40 }, view: VIEW, docTop: 0,
  text: '', plain: '', textLen: 0, attrs: '', frames: '', actions: [], count: 1, bgAlpha: 0, ...over
});
const withText = (text, over = {}) => el({ text, plain: text, textLen: text.length, ...over });

test('recipes.js 를 피커보다 먼저 주입하고, 설정 화면이 싣고, 배포 zip 에 들어감', () => {
  assert.match(read('cleanshot-picker/background.js'), /INJECT_FILES\s*=\s*\[\s*'shared\/redact-core\.js',\s*'recipes\.js',\s*'picker\.js'\s*\]/);
  const html = read('cleanshot-picker/options.html');
  assert.ok(html.indexOf('src="recipes.js"') > 0 && html.indexOf('src="recipes.js"') < html.indexOf('src="options.js"'), 'recipes.js 를 options.js 보다 먼저');
  const zip = (read('scripts/build-zip.ps1').match(/'cleanshot-picker'\s*=\s*@\(([^)]*)\)/) || [])[1] || '';
  assert.match(zip, /'recipes\.js'/);
});

test('사이트 이름: 도메인(포트 포함, 앞의 www. 뺌), 로컬 파일은 하나로, 웹 주소가 아니면 빈 값', () => {
  assert.equal(R.hostKey('https://www.Example.com/a?b=1#c'), 'example.com');
  assert.equal(R.hostKey('https://www.example.com:443/'), 'example.com');
  assert.equal(R.hostKey('http://127.0.0.1:8930/main.html'), '127.0.0.1:8930');
  assert.equal(R.hostKey('https://erp.corp.local:8443/x'), 'erp.corp.local:8443');
  assert.equal(R.hostKey('https://www2.example.com/'), 'www2.example.com');
  assert.equal(R.hostKey('file:///C:/Users/me/report.html'), 'file');
  assert.equal(R.hostKey('chrome://extensions'), '');
  assert.equal(R.hostKey('not a url'), '');
});

test('오래 남을 id: 사람이 붙인 이름은 쓰고, 틀이 만든 이름·긴 숫자·무작위 글자는 쓰지 않음', () => {
  for (const id of ['banner', 'flowSecret', 'onetrust-banner-sdk', 'ch-plugin', '__next', 'main-nav', 'h1', 'section2']) {
    assert.equal(R.stableId(id), true, id);
  }
  for (const id of ['', ' banner', 'ember123', ':r1:', ':R2a6:', 'react-select-3-input', 'radix-:r5:-content', 'headlessui-menu-button-1',
    'mui-12', 'ext-gen1234', 'item12345', 'post-123', '123abc', 'a1b2c3d4', 'yui_3_5_1_1', 'gwt-uid-7', 'j_idt12', 'x'.repeat(61), null, 7]) {
    assert.equal(R.stableId(id), false, String(id));
  }
});

test('오래 남을 클래스: 상태·자동 생성·해시 클래스와 따옴표가 필요한 이름은 쓰지 않음', () => {
  for (const c of ['cookie-bar', 'notice', 'item', 'btn-primary', 'Header_title', 'kakao_chat', 'w-full', 'p-4', 'col-md-6']) {
    assert.equal(R.stableClass(c), true, c);
  }
  for (const c of ['active', 'Selected', 'show', 'is-open', 'has-error', 'css-1x2y3z', 'sc-bdVaJa', 'jsx-1234', 'ng-star-inserted',
    'Header_title__a1B2c', '_3xYz9', 'a1b2', 'col-123', 'md:flex', 'w-1/2', 'x', 'y'.repeat(41), '', undefined]) {
    assert.equal(R.stableClass(c), false, String(c));
  }
});

test('한 번에 정리 — 쿠키 배너: 쿠키 안내 문장(또는 동의 관련 이름)과 동의·닫기 단추가 있는 띠·창', () => {
  const bar = { rect: { x: 0, y: 710, w: 1280, h: 90 }, actions: ['모두 허용', '설정'] };
  assert.equal(R.classify(withText('이 사이트는 더 나은 서비스를 위해 쿠키를 사용합니다. 모두 허용 설정', { ...bar, plain: '이 사이트는 더 나은 서비스를 위해 쿠키를 사용합니다.' })), 'cookie');
  assert.equal(R.classify(withText('We value your privacy Accept all', { rect: { x: 20, y: 560, w: 420, h: 220 }, plain: 'We value your privacy', attrs: 'consent-banner', actions: ['Accept all'] })), 'cookie');
  // 문서 맨 위에서 내용을 밀어내는 띠 (fixed 아님)
  assert.equal(R.classify(withText('We use cookies. OK', { pos: 'static', docTop: 0, rect: { x: 0, y: 0, w: 1280, h: 60 }, plain: 'We use cookies.', actions: ['OK'] })), 'cookie');
  // 아닌 것: 동의·닫기 단추가 없음(정책 링크만), 쿠키가 링크 글자에만 있음, 화면 높이만 한 옆 메뉴, 문서 한가운데, 너무 큰 앱 틀
  assert.equal(R.classify(withText('개인정보처리방침 쿠키 정책', { ...bar, plain: '', actions: ['개인정보처리방침', '쿠키 정책'] })), null);
  assert.equal(R.classify(withText('홈 제품 고객센터 쿠키 설정', { rect: { x: 0, y: 0, w: 1280, h: 50 }, plain: '', actions: ['홈', '제품', '고객센터', '쿠키 설정'] })), null);
  assert.equal(R.classify(withText('메뉴 대시보드 쿠키 관리 확인', { rect: { x: 0, y: 0, w: 220, h: 800 }, plain: '메뉴 대시보드 쿠키 관리', actions: ['확인'] })), null);
  assert.equal(R.classify(withText('We use cookies. OK', { pos: 'static', docTop: 900, rect: { x: 0, y: 300, w: 1280, h: 60 }, plain: 'We use cookies.', actions: ['OK'] })), null);
  assert.equal(R.classify(withText('쿠키를 사용합니다 ' + '본문 '.repeat(500), { ...bar, actions: ['확인'], count: 900 })), null);
});

test('한 번에 정리 — 채팅 버튼: 화면 아래쪽 작은 떠 있는 요소로, 이름·글자·안쪽 iframe 에 채팅·상담 말이 있음', () => {
  const corner = { rect: { x: 1200, y: 720, w: 60, h: 60 } };
  assert.equal(R.classify(el({ ...corner, attrs: 'chat-launcher' })), 'chat');
  assert.equal(R.classify(el({ ...corner, attrs: 'floating-btn 채팅 상담' })), 'chat');
  assert.equal(R.classify(el({ ...corner, attrs: 'widget', frames: 'chat widget' })), 'chat');
  assert.equal(R.classify(withText('1:1 문의', { rect: { x: 20, y: 700, w: 120, h: 48 } })), 'chat');
  assert.equal(R.classify(withText('상담원 연결 중입니다', { rect: { x: 880, y: 160, w: 380, h: 620 }, attrs: 'livechat-window' })), 'chat');
  // 아닌 것: 맨 위로 단추, 위쪽에 붙은 작은 채팅 아이콘, 화면 절반보다 넓은 띠
  assert.equal(R.classify(withText('맨 위로', { ...corner, attrs: 'top-btn' })), null);
  assert.equal(R.classify(el({ rect: { x: 1200, y: 10, w: 40, h: 40 }, attrs: 'chat-icon' })), null);
  assert.equal(R.classify(el({ rect: { x: 0, y: 740, w: 1280, h: 60 }, attrs: 'chat-bar' })), null);
});

test('한 번에 정리 — 앱 설치 배너: 위·아래 끝의 넓고 낮은 띠에 앱에서 보기·설치 말, 단추는 몇 개뿐', () => {
  const top = { rect: { x: 0, y: 0, w: 1280, h: 56 } };
  assert.equal(R.classify(withText('앱에서 보기 더 빠르고 편하게 열기', { ...top, plain: '앱에서 보기 더 빠르고 편하게', actions: ['열기'] })), 'app');
  assert.equal(R.classify(withText('Open in app', { rect: { x: 0, y: 744, w: 1280, h: 56 }, plain: '', actions: ['Open in app'] })), 'app');
  assert.equal(R.classify(withText('Get the app', { pos: 'static', docTop: 0, rect: { x: 0, y: 0, w: 1280, h: 80 }, plain: 'Get the app', attrs: 'smartbanner' })), 'app');
  // 아닌 것: 문서 아래쪽 바닥글, 앱 다운로드 링크가 낀 머리글 메뉴, 화면 가운데
  assert.equal(R.classify(withText('App Store 에서 다운로드', { pos: 'static', docTop: 2000, rect: { x: 0, y: 400, w: 1280, h: 80 } })), null);
  assert.equal(R.classify(withText('홈 제품 이벤트 고객센터 앱 다운로드', { ...top, plain: '', actions: ['홈', '제품', '이벤트', '고객센터', '앱 다운로드'] })), null);
  assert.equal(R.classify(withText('로그인 회원가입 앱 다운로드', { ...top, plain: '', actions: ['로그인', '회원가입', '앱 다운로드'] })), null);
  assert.equal(R.classify(withText('로그인 회원가입 앱 다운로드', { pos: 'static', docTop: 0, rect: { x: 0, y: 0, w: 1280, h: 40 }, plain: '', actions: ['로그인', '회원가입', '앱 다운로드'] })), null);
  assert.equal(R.classify(withText('앱에서 보기', { rect: { x: 0, y: 380, w: 1280, h: 56 } })), null);
  assert.equal(R.classify(null), null);
  assert.equal(R.classify(el({ rect: { x: 0, y: 0, w: 0, h: 0 }, attrs: 'chat' })), null);
});

test('한 번에 정리 — 공지 팝업: "오늘 하루 보지 않기" 글에서 올라가며 팝업을 품는 가장 바깥 띄운 요소를 고름', () => {
  assert.equal(R.isPopupText('오늘 하루 보지 않기'), true);
  assert.equal(R.isPopupText('오늘 하루 이 창을 열지 않음'), true);
  assert.equal(R.isPopupText('7일간 보지 않기'), true);
  assert.equal(R.isPopupText('다시 보지 않기'), true);
  assert.equal(R.isPopupText("Don't show this again"), true);
  assert.equal(R.isPopupText('오늘 하루 수고 많으셨습니다'), false);

  const L = (pos, w, h, textLen, count = 5) => ({ pos, rect: { x: 0, y: 0, w, h }, view: VIEW, textLen, count });
  // 글 → 아래 단추 줄(absolute) → 팝업(absolute) → 본문 틀(static, 다른 내용이 많음)
  assert.equal(R.popupContainer([L('static', 120, 20, 10), L('absolute', 420, 40, 14), L('absolute', 420, 300, 160), L('static', 1280, 2400, 1900, 300)]), 2);
  // 화면을 덮는 fixed 가림막 안의 팝업은 가림막째
  assert.equal(R.popupContainer([L('static', 120, 20, 10), L('absolute', 420, 300, 160), L('fixed', 1280, 800, 162)]), 2);
  // 작은 페이지의 absolute 본문 틀: 팝업보다 글이 훨씬 많으면 거기서 멈춤
  assert.equal(R.popupContainer([L('static', 120, 20, 10), L('absolute', 420, 300, 160), L('absolute', 1000, 600, 900, 120)]), 1);
  // 화면보다 큰 absolute 틀은 팝업으로 보지 않음, 띄운 조상이 없으면 -1
  assert.equal(R.popupContainer([L('static', 120, 20, 10), L('absolute', 1280, 900, 40)]), -1);
  assert.equal(R.popupContainer([L('static', 120, 20, 10), L('relative', 400, 300, 50)]), -1);
});

test('한 번에 정리 — 가림막: 화면을 다 덮는 글자 없는 반투명 fixed 요소만', () => {
  const full = { rect: { x: 0, y: 0, w: 1280, h: 800 } };
  assert.equal(R.isBackdrop(el({ ...full, bgAlpha: 0.4 })), true);
  assert.equal(R.isBackdrop(el({ ...full, bgAlpha: 1 })), false);                 // 불투명한 판은 화면 그 자체일 수 있다
  assert.equal(R.isBackdrop(el({ ...full, bgAlpha: 0.4, textLen: 3 })), false);
  assert.equal(R.isBackdrop(el({ ...full, bgAlpha: 0.4, pos: 'absolute' })), false);
  assert.equal(R.isBackdrop(el({ rect: { x: 0, y: 0, w: 1280, h: 300 }, bgAlpha: 0.4 })), false);
  assert.equal(R.isBackdrop(el({ ...full, bgAlpha: 0.4, count: 12 })), false);
});

test('내장 목록: 분류마다 선택자가 있고 겹치지 않음', () => {
  for (const cat of ['cookie', 'chat', 'app']) {
    const list = R.VENDORS[cat];
    assert.ok(Array.isArray(list) && list.length > 0, cat);
    assert.ok(list.every((s) => typeof s === 'string' && s.trim() === s && s.length > 1), cat);
  }
  const all = Object.values(R.VENDORS).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(Object.keys(R.CATEGORY_LABELS).sort(), ['app', 'chat', 'cookie', 'popup']);
});

test('레시피 저장값 고르기: 모르는 종류·빈 선택자·잘못된 경로는 버리고, 같은 항목은 하나로, 빈 레시피는 지움', () => {
  assert.deepEqual(R.normalizeStore(undefined), {});
  assert.deepEqual(R.normalizeStore('x'), {});
  const got = R.normalizeStore({
    'a.com': {
      on: false, cleanup: 1, at: 5,
      items: [
        { kind: 'hide', sel: '#x', path: [], label: 'div#x', remove: true },
        { kind: 'bogus', sel: '#y' },
        { kind: 'mask', sel: '' },
        { kind: 'mask', sel: '#m', path: ['#frame', 7] },
        { kind: 'text', sel: '#t', text: 'hi' },
        { kind: 'hide', sel: '#x', path: [] },
        { kind: 'mask', sel: 's'.repeat(401) },
        { kind: 'text', sel: '#u' }
      ]
    },
    '': { items: [{ kind: 'hide', sel: '#z' }] },
    'b.com': { items: [] },
    'c.com': { cleanup: true, items: 'nope' }
  });
  assert.deepEqual(got, {
    'a.com': {
      on: false, cleanup: false, at: 5,
      items: [
        { kind: 'hide', path: [], sel: '#x', label: 'div#x', remove: true },
        { kind: 'text', path: [], sel: '#t', label: '', text: 'hi' }
      ]
    },
    'c.com': { on: true, cleanup: true, at: 0, items: [] }
  });
  // 길이 한도: 글 2000자, 항목 200개, 이름표 80자
  const many = R.normalizeStore({ 'd.com': { items: Array.from({ length: 250 }, (_, i) => ({ kind: 'hide', sel: `#e${i}`, label: 'l'.repeat(90) })).concat([{ kind: 'text', sel: '#long', text: 't'.repeat(2500) }]) } });
  assert.equal(many['d.com'].items.length, 200);
  assert.equal(many['d.com'].items[0].label.length, 80);
  const long = R.normalizeStore({ 'e.com': { items: [{ kind: 'text', sel: '#long', text: 't'.repeat(2500) }] } });
  assert.equal(long['e.com'].items[0].text.length, 2000);
});

test('레시피 저장값 고르기: 사이트가 너무 많으면 최근에 저장한 300개만', () => {
  const raw = {};
  for (let i = 0; i < 310; i++) raw[`s${i}.com`] = { at: i, items: [{ kind: 'hide', sel: '#a' }] };
  const got = R.normalizeStore(raw);
  assert.equal(Object.keys(got).length, 300);
  assert.ok(!('s0.com' in got) && !('s9.com' in got) && 's10.com' in got && 's309.com' in got);
});

test('레시피에 더하기: 새 항목은 뒤에 붙이고, 같은 요소의 글 고침은 새 글로, 저장하면 켜짐', () => {
  const hide = { kind: 'hide', path: [], sel: '#banner', label: 'div#banner', remove: false };
  const first = R.addItems(undefined, [hide, { kind: 'text', path: [], sel: '#bold', label: 'b#bold', text: 'planet' }], { cleanup: false, at: 100 });
  assert.deepEqual(first, {
    recipe: { on: true, cleanup: false, at: 100, items: [hide, { kind: 'text', path: [], sel: '#bold', label: 'b#bold', text: 'planet' }] },
    added: 2, updated: 0, full: 0
  });
  const off = { ...first.recipe, on: false };
  const second = R.addItems(off, [
    { ...hide },
    { kind: 'text', path: [], sel: '#bold', label: 'b#bold', text: 'moon' },
    { kind: 'mask', path: ['#sameFrame'], sel: '#innerSecret', label: 'div#innerSecret' }
  ], { cleanup: true, at: 200 });
  assert.equal(second.added, 1);
  assert.equal(second.updated, 1);
  assert.deepEqual(second.recipe, {
    on: true, cleanup: true, at: 200,
    items: [hide, { kind: 'text', path: [], sel: '#bold', label: 'b#bold', text: 'moon' }, { kind: 'mask', path: ['#sameFrame'], sel: '#innerSecret', label: 'div#innerSecret' }]
  });
  assert.equal(off.on, false, '넘겨받은 레시피는 바꾸지 않음');
  assert.equal(first.recipe.items[1].text, 'planet');
  // 같은 선택자라도 종류나 iframe·shadow 경로가 다르면 다른 항목
  const third = R.addItems(second.recipe, [{ kind: 'mask', path: [], sel: '#banner', label: 'div#banner' }, { kind: 'hide', path: ['#host'], sel: '#banner', label: 'div#banner', remove: false }], { at: 300 });
  assert.equal(third.added, 2);
  assert.equal(third.recipe.cleanup, true, '정리를 쓰지 않고 저장해도 이미 켠 정리는 그대로');
  // 200개를 넘으면 더 넣지 않고 알려 줌
  const big = { on: true, cleanup: false, at: 1, items: Array.from({ length: 199 }, (_, i) => ({ kind: 'hide', path: [], sel: `#e${i}`, label: '', remove: false })) };
  const fill = R.addItems(big, [{ kind: 'hide', path: [], sel: '#n1', label: '' }, { kind: 'hide', path: [], sel: '#n2', label: '' }], { at: 2 });
  assert.equal(fill.recipe.items.length, 200);
  assert.equal(fill.added, 1);
  assert.equal(fill.full, 1);
});

test('정리 알림의 분류별 개수: 정한 순서로, 0 은 빼고', () => {
  assert.equal(R.countSummary({ popup: 1, chat: 2, cookie: 1, app: 0 }), '쿠키 배너 1 · 채팅 버튼 2 · 공지 팝업 1');
  assert.equal(R.countSummary({ app: 3, nope: 4 }), '앱 설치 배너 3');
  assert.equal(R.countSummary({}), '');
  assert.equal(R.countSummary(null), '');
});

test('레시피 요약: 종류별 개수와 정리 포함', () => {
  assert.equal(R.summary({ cleanup: true, items: [{ kind: 'hide' }, { kind: 'mask' }, { kind: 'hide' }, { kind: 'text' }] }), '지우기 2 · 가리기 1 · 글 고침 1 · 정리 포함');
  assert.equal(R.summary({ cleanup: true, items: [] }), '정리');
  assert.equal(R.summary({ cleanup: false, items: [{ kind: 'mask' }] }), '가리기 1');
  assert.equal(R.summary(null), '');
});
