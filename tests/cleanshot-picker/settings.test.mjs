// CleanShot Picker 저장 설정(cleanshot-picker/settings.js)의 순수 함수: 기본값·값 고르기, 파일 이름 양식, 주소·시각 띠 글
// 실제 저장(형식·크기·띠 그리기·저장 위치 창)은 브라우저 시험(tests/e2e/cleanshot-picker 의 output 구역)에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../../cleanshot-picker/settings.js');
const CS = globalThis.CleanShotSettings;

const AT = new Date(2026, 10, 26, 10, 15, 30); // 이 컴퓨터 시간대의 2026-11-26 10:15:30
const info = (over = {}) => ({ url: 'https://www.example.com/a/b?x=1', title: '예시 페이지', at: AT, suffix: '', ext: 'png', ...over });

test('settings.js 를 서비스 워커·설정 화면이 싣고, 배포 zip 에 설정 화면 파일이 들어감', () => {
  const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  assert.match(read('cleanshot-picker/background.js'), /importScripts\([^)]*'settings\.js'[^)]*\)/);
  const html = read('cleanshot-picker/options.html');
  assert.ok(html.indexOf('src="settings.js"') > 0 && html.indexOf('src="settings.js"') < html.indexOf('src="options.js"'), 'settings.js 를 options.js 보다 먼저');
  assert.equal(JSON.parse(read('cleanshot-picker/manifest.json')).options_ui.page, 'options.html');
  const zip = (read('scripts/build-zip.ps1').match(/'cleanshot-picker'\s*=\s*@\(([^)]*)\)/) || [])[1] || '';
  for (const f of ['settings.js', 'options.html', 'options.js']) assert.match(zip, new RegExp(`'${f.replace('.', '\\.')}'`), f);
});

test('기본값과 값 고르기: 모르는 값은 기본값, 아는 값은 그대로', () => {
  assert.deepEqual(CS.normalize(null), {
    outFormat: 'png', outScale: 'device', nameTemplate: 'cleanshot/{host}-{date}-{time}', askWhere: false, stamp: false, hideScrollbars: true, keepAfter: false,
    autoClean: false
  });
  assert.deepEqual(CS.normalize({ outFormat: 'gif', outScale: 3, nameTemplate: '   ', askWhere: 'yes', stamp: 1, hideScrollbars: 0, keepAfter: 'y', autoClean: 1 }), CS.normalize(null));
  assert.deepEqual(CS.normalize({ outFormat: 'webp', outScale: 2, nameTemplate: '  a/{title} ', askWhere: true, stamp: true, hideScrollbars: false, keepAfter: true, autoClean: true }),
    { outFormat: 'webp', outScale: '2', nameTemplate: 'a/{title}', askWhere: true, stamp: true, hideScrollbars: false, keepAfter: true, autoClean: true });
  assert.equal(CS.normalize({ nameTemplate: 'x'.repeat(500) }).nameTemplate.length, 200);
  assert.equal(CS.normalize({ outFormat: 'toString' }).outFormat, 'png'); // 객체의 물려받은 이름은 형식이 아니다
});

test('출력 배율: 1배·2배는 고정, 화면 그대로는 찍힌 배율', () => {
  assert.equal(CS.outFactor('1', 2), 1);
  assert.equal(CS.outFactor('2', 1), 2);
  assert.equal(CS.outFactor('device', 1.5), 1.5);
});

test('기본 양식은 예전 파일 이름과 같음 (cleanshot/도메인-날짜-시간, 끝에 -full·-area 와 확장자)', () => {
  assert.equal(CS.fileName(CS.DEFAULTS.nameTemplate, info()), 'cleanshot/example.com-20261126-101530.png');
  assert.equal(CS.fileName(CS.DEFAULTS.nameTemplate, info({ suffix: '-full', ext: 'jpg' })), 'cleanshot/example.com-20261126-101530-full.jpg');
  assert.equal(CS.fileName(CS.DEFAULTS.nameTemplate, info({ url: 'file:///C:/Users/me/report.html', suffix: '-area', ext: 'webp' })), 'cleanshot/file-20261126-101530-area.webp');
  assert.equal(CS.fileName(CS.DEFAULTS.nameTemplate, info({ url: 'not a url' })), 'cleanshot/page-20261126-101530.png');
});

test('양식: 폴더·제목 칸, 제목의 쓸 수 없는 글자와 / 는 _ 로 (폴더를 만들지 않음)', () => {
  assert.equal(CS.fileName('shots/{date}/{title}', info()), 'shots/20261126/예시 페이지.png');
  assert.equal(CS.fileName('{title}', info({ title: 'a<b>:c?"d|e*/f\\g' })), 'a_b__c__d_e__f_g.png');
  assert.equal(CS.fileName('{title}', info({ title: '   ' })), 'untitled.png');
  assert.equal(CS.fileName('{title}', info({ title: '가'.repeat(100) })), '가'.repeat(60) + '.png');
  assert.equal(CS.fileName('x/{nope}-{time}', info()), 'x/{nope}-101530.png'); // 모르는 칸은 글자 그대로
  assert.deepEqual(CS.fillTemplate('{host}{nope}{nope}{ }', info()).unknown, ['nope', ' ']);
});

test('양식: 다운로드 폴더 밖·숨김·예약 이름·빈 칸을 막음', () => {
  assert.equal(CS.fileName('../../{host}', info()), 'example.com.png');
  assert.equal(CS.fileName('/abs//./.hidden/ end. /{time}', info()), 'abs/hidden/end/101530.png');
  assert.equal(CS.fileName('C:\\Windows\\{time}', info()), 'C_/Windows/101530.png');
  assert.equal(CS.fileName('con/nul.txt/{time}', info()), '_con/_nul.txt/101530.png');
  assert.equal(CS.fileName('', info()), 'cleanshot/example.com-20261126-101530.png');
  assert.equal(CS.fileName('///..///', info()), 'cleanshot/example.com-20261126-101530.png'); // 남는 것이 없으면 기본 양식
  // 한 칸은 80자, 경로 전체는 180자까지 (확장자 앞까지). 양식 자체도 200자까지만 읽는다
  const wide = CS.fileName(`${'a'.repeat(100)}/{time}`, info());
  assert.equal(wide, `${'a'.repeat(80)}/101530.png`);
  const deep = CS.fileName('abcdefghij/'.repeat(30) + '{time}', info());
  assert.ok(deep.length - '.png'.length <= 180, deep.length);
  assert.ok(!/[/.]\.png$/.test(deep), deep); // 잘린 끝에 / 나 . 이 남지 않음
});

test('주소·시각 띠: ? 뒤와 # 뒤는 빼고 풀어 쓴 주소, 로컬 파일은 이름만, 시각은 시간대와 함께', () => {
  const s = CS.stampText('https://사내.example.com/%EB%AC%B8%EC%84%9C/view?token=SECRET&id=7#top', AT);
  assert.equal(s.url, `https://${new URL('https://사내.example.com/').hostname}/문서/view`); // 한글 도메인은 브라우저가 쓰는 punycode 로
  assert.ok(!/SECRET|token|#top/.test(s.url));
  assert.match(s.when, /^2026-11-26 10:15:30 \(UTC[+-]\d\d:\d\d\)$/);
  assert.equal(CS.stampText('file:///C:/Users/me/secret-folder/report.html', AT).url, 'file:///…/report.html');
  assert.equal(CS.stampText('http://127.0.0.1:8930/main.html?x=1', AT).url, 'http://127.0.0.1:8930/main.html');
  assert.equal(CS.stampText('%%%', AT).url, '%%%'); // 주소가 아니면 그대로
});
