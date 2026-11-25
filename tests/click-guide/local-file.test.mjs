// ClickGuide 로컬 파일(file://) 녹화: 폴더 경로(사용자 이름이 들어 있음)가 단계 문장·가이드 제목·내보내기에 들어가지 않는지
// (실제 브라우저에서 file:// 페이지를 녹화하는 것은 tests/e2e/click-guide/e2e.mjs 의 file 구역이 확인)
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const COMMON = new URL('../../click-guide/src/common/', import.meta.url);
const util = await import(new URL('util.js', COMMON).href);
const describe = await import(new URL('describe.js', COMMON).href);
const render = await import(new URL('render.js', COMMON).href);

const WIN = 'file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/Desktop/%EC%82%AC%EB%82%B4/manual.html';
const WIN_DIR = 'file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/Desktop/';
const UNIX = 'file:///home/hong/docs/%EC%84%A4%EB%AA%85%EC%84%9C.html?x=1#top';
const leaks = (s) => /Users|홍길동|hong|Desktop|docs|사내/.test(String(s));

test('장소 이름: 웹 주소는 호스트, 로컬 파일은 파일 이름, 폴더는 빈 문자열', () => {
  assert.equal(util.placeName('https://www.example.com/a?b=1'), 'example.com');
  assert.equal(util.placeName(WIN), 'manual.html');
  assert.equal(util.placeName(UNIX), '설명서.html');
  assert.equal(util.placeName(WIN_DIR), '');
  assert.equal(util.placeName(''), '');
  assert.equal(util.placeName('not a url'), '');
});

test('내보낼 주소: 로컬 파일은 file:///…/파일이름, 웹 주소·빈 값은 그대로', () => {
  assert.equal(util.shareableUrl(WIN), 'file:///…/manual.html');
  assert.equal(util.shareableUrl(UNIX), 'file:///…/설명서.html');
  assert.equal(util.shareableUrl(WIN_DIR), 'file:///…/');
  assert.equal(util.shareableUrl('https://ex.com/a?token=1'), 'https://ex.com/a?token=1');
  assert.equal(util.shareableUrl(undefined), undefined);
  assert.equal(util.shareableUrl(''), '');
});

test('로컬 파일 페이지 제목에 그 폴더 경로가 있으면 파일 이름으로 (폴더 목록·제목 없는 페이지), 보통 제목은 그대로', () => {
  assert.equal(util.localPageTitle('C:\\Users\\홍길동\\Desktop\\의 색인', WIN_DIR), '');
  assert.equal(util.localPageTitle('Index of C:\\Users\\홍길동\\Desktop\\', WIN_DIR), '');
  assert.equal(util.localPageTitle('C:/Users/홍길동/Desktop/사내/manual.html', WIN), 'manual.html');
  assert.equal(util.localPageTitle('Index of /home/hong/docs/', 'file:///home/hong/docs/'), '');
  assert.equal(util.localPageTitle('사내 매뉴얼', WIN), '사내 매뉴얼');
  assert.equal(util.localPageTitle('manual.html', WIN), 'manual.html');
  assert.equal(util.localPageTitle('C: 드라이브 안내', 'file:///C:/a.html'), 'C: 드라이브 안내', '드라이브 바로 아래 파일');
  assert.equal(util.localPageTitle('C:\\Users\\x', 'https://ex.com/'), 'C:\\Users\\x', '웹 페이지는 건드리지 않음');
  assert.equal(util.localPageTitle('', WIN), '');
});

test('로컬 파일로 이동하는 단계 문장: 파일 이름만 (ko/en), 폴더면 "페이지"', () => {
  const ko = describe.describeStep({ type: 'navigate', title: '', url: WIN }, 'ko');
  assert.equal(ko.title, 'manual.html로 이동');
  assert.equal(ko.description, '‘manual.html’ 페이지가 열립니다.');
  const en = describe.describeStep({ type: 'navigate', title: '', url: UNIX }, 'en');
  assert.equal(en.title, 'Open 설명서.html');
  const dir = describe.describeStep({ type: 'navigate', title: '', url: WIN_DIR }, 'ko');
  assert.equal(dir.title, '페이지로 이동');
  for (const d of [ko, en, dir]) assert.ok(!leaks(d.title + d.description), JSON.stringify(d));
});

test('가이드 제목 후보: 로컬 파일은 파일 이름으로', () => {
  const t = describe.suggestGuideTitle([{ type: 'click', url: WIN, el: { label: '저장' } }], 'ko');
  assert.equal(t, 'manual.html 사용 가이드 — 저장까지');
  assert.ok(!leaks(t), t);
});

test('HTML·Markdown 머리말과 JSON 내보내기에 로컬 폴더 경로가 없음', () => {
  const session = { id: 'ses_1', name: '가이드', createdAt: 0, startUrl: WIN, lang: 'ko' };
  const steps = [
    { id: 's1', type: 'click', title: '‘열기’ 링크 클릭', description: '설명', url: WIN, pageTitle: 'C:/Users/홍길동/Desktop/사내/manual.html',
      el: { tag: 'a', label: '열기', href: 'file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/Desktop/next.html' } },
    { id: 's2', type: 'navigate', title: 'next.html로 이동', description: '', url: 'file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/Desktop/next.html' },
  ];
  const html = render.buildGuideHtml(session, steps, new Map(), { showUrls: true });
  const md = render.buildMarkdown(session, steps, new Map(), { showUrls: true });
  assert.ok(html.includes('manual.html') && !leaks(html.replace(/가이드|설명/g, '')), html.slice(0, 600));
  assert.ok(!leaks(md.replace(/가이드|설명/g, '')), md);
  const json = render.buildJsonExport(session, steps, new Map());
  const text = JSON.stringify(json);
  assert.ok(!leaks(text), text);
  assert.equal(json.guide.startUrl, 'file:///…/manual.html');
  assert.equal(json.steps[0].url, 'file:///…/manual.html');
  assert.equal(json.steps[0].element.href, 'file:///…/next.html');
  assert.equal(json.steps[0].pageTitle, 'manual.html');
  assert.equal(steps[0].el.href.includes('Users'), true, '원본 단계는 건드리지 않음');
});

test('JSON 내보내기: 웹 주소는 그대로, 없는 값은 없는 그대로', () => {
  const json = render.buildJsonExport({ id: 'g', name: 'n', createdAt: 1 }, [
    { id: 'a', type: 'click', url: 'https://ex.com/p?q=1', pageTitle: 'P', el: { tag: 'a', href: 'https://ex.com/x' } },
    { id: 'b', type: 'note', title: '메모' },
  ], new Map([['a', 'data:image/jpeg;base64,AA']]));
  assert.equal(json.format, 'clickguide/v1');
  assert.equal(json.guide.startUrl, undefined);
  assert.equal(json.steps[0].url, 'https://ex.com/p?q=1');
  assert.equal(json.steps[0].element.href, 'https://ex.com/x');
  assert.equal(json.steps[0].image, 'data:image/jpeg;base64,AA');
  assert.equal(json.steps[1].url, undefined);
  assert.equal(json.steps[1].pageTitle, undefined);
  assert.equal(json.steps[1].image, null);
  assert.equal(json.steps[1].number, 2);
});
