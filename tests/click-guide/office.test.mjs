// ClickGuide Word(.docx)·PowerPoint(.pptx) 내보내기: 패키지 구성, 관계, XML 짜임, 글자 처리, 목차·개정 이력·그림 크기
// Office 에서 열리는지·스키마에 맞는지는 손으로 확인한다 (README 의 시험 항목 참고)
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../../click-guide/src/', import.meta.url);
const { buildDocx, DOCX_MIME } = await import(new URL('common/docx.js', SRC).href);
const { buildPptx, PPTX_MIME, fitText, lineCount } = await import(new URL('common/pptx.js', SRC).href);
const { cleanText, xmlEsc, splitLines, fitBox, revisionRows, exportStrings } = await import(new URL('common/ooxml.js', SRC).href);
const { buildGuideHtml, buildMarkdown } = await import(new URL('common/render.js', SRC).href);
const { normalizeDoc, normalizeSettings, DEFAULT_SETTINGS } = await import(new URL('common/settings.js', SRC).href);
const { createZip } = await import(new URL('lib/zip.js', SRC).href);
const { readZip } = await import(new URL('lib/unzip.js', SRC).href);

const dec = new TextDecoder();
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/* ---------- 검사 도구 ---------- */

const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
/** 직접 만든 XML 이 짜임에 맞는지 (선언, 태그 짝, 속성 겹침, 엔터티, 제어 문자, 뿌리 하나) */
function wellFormed(xml, name) {
  const s = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack = [];
  let last = 0;
  let roots = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    assert.equal(m.index, last, `${name}: ${last} 자리를 읽지 못함 — ${s.slice(last, last + 60)}`);
    last = re.lastIndex;
    assert.ok(!m[6], `${name}: 짝 없는 < (${m.index})`);
    if (m[5] !== undefined) {
      assert.ok(!BAD_ENTITY.test(m[5]), `${name}: 이스케이프 안 된 & — ${m[5].slice(0, 60)}`);
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(m[5]), `${name}: 제어 문자`);
      assert.ok(stack.length || !m[5].trim(), `${name}: 뿌리 밖 글자`);
      continue;
    }
    const [, close, tag, attrs, self] = m;
    assert.ok(!BAD_ENTITY.test(attrs), `${name}: 속성에 이스케이프 안 된 & — <${tag}>`);
    const names = [...attrs.matchAll(/([\w.:-]+)\s*=/g)].map((x) => x[1]);
    assert.equal(new Set(names).size, names.length, `${name}: <${tag}> 속성 겹침`);
    if (close) assert.equal(stack.pop(), tag, `${name}: </${tag}> 짝이 맞지 않음`);
    else {
      if (!stack.length) roots++;
      if (!self) stack.push(tag);
    }
  }
  assert.equal(last, s.length, `${name}: 끝까지 읽지 못함`);
  assert.equal(stack.length, 0, `${name}: 닫히지 않은 태그 ${stack.join(',')}`);
  assert.equal(roots, 1, `${name}: 뿌리 요소가 ${roots}개`);
}

const resolve = (base, target) => {
  const out = [];
  for (const seg of (base + target).split('/')) {
    if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
};

/** 패키지: [Content_Types] 맨 앞, 모든 XML 짜임, 콘텐츠 형식, 관계 대상·ID, 부품이 쓰는 r:id */
function checkPackage(files) {
  const map = new Map(files.map((f) => [f.name, f.data]));
  const text = (n) => dec.decode(map.get(n));
  assert.equal(files[0].name, '[Content_Types].xml');
  assert.equal(map.size, files.length, '같은 이름의 부품이 둘');
  for (const f of files) {
    assert.ok(!f.name.startsWith('/') && !f.name.endsWith('/'), f.name);
    if (/\.(xml|rels)$/.test(f.name)) wellFormed(text(f.name), f.name);
  }
  const ct = text('[Content_Types].xml');
  const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]));
  const overrides = new Set([...ct.matchAll(/<Override PartName="([^"]+)"/g)].map((m) => m[1]));
  for (const f of files.slice(1)) assert.ok(overrides.has('/' + f.name) || defaults.has(f.name.split('.').pop()), `콘텐츠 형식 없음: ${f.name}`);
  for (const o of overrides) assert.ok(map.has(o.slice(1)), `없는 부품의 형식: ${o}`);
  for (const f of files) {
    if (!/\.(xml)$/.test(f.name)) continue;
    const used = [...text(f.name).matchAll(/\br:(?:id|embed)="([^"]+)"/g)].map((m) => m[1]);
    const relsName = f.name.replace(/([^/]+)$/, '_rels/$1.rels');
    if (!used.length) continue;
    assert.ok(map.has(relsName), `${f.name} 이 관계를 쓰는데 ${relsName} 이 없음`);
    const ids = new Set([...text(relsName).matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
    for (const u of used) assert.ok(ids.has(u), `${f.name}: ${u} 가 ${relsName} 에 없음`);
  }
  for (const f of files) {
    if (!f.name.endsWith('.rels')) continue;
    const base = f.name.replace(/_rels\/[^/]*\.rels$/, '');
    const rels = [...text(f.name).matchAll(/<Relationship Id="([^"]+)" Type="[^"]+" Target="([^"]+)"\/>/g)];
    assert.ok(rels.length, `${f.name}: 관계가 없음`);
    const ids = rels.map((r) => r[1]);
    assert.equal(new Set(ids).size, ids.length, `${f.name}: 관계 ID 겹침`);
    for (const [, id, target] of rels) assert.ok(map.has(resolve(base, target)), `${f.name}: ${id} → ${target} (${resolve(base, target)}) 없음`);
  }
  return { map, text };
}

/* ---------- 견본 ---------- */

const session = {
  id: 'ses1', name: '주문 취소 <관리자> & "테스트"', createdAt: Date.UTC(2026, 10, 25), lang: 'ko',
  startUrl: 'https://shop.example.com/orders?token=SECRET', description: '첫 줄\n둘째 줄',
};
const steps = [
  { id: 's1', type: 'click', title: "'저장' 버튼 클릭", description: '저장합니다.\n두 번째 줄\u0007' },
  { id: 's2', type: 'note', title: '확인', description: '메모 내용' },
  { id: 's3', type: 'click', title: '', description: '' },
];
const images = new Map([['s1', { data: JPEG, width: 1600, height: 1000 }], ['s3', { data: PNG, width: 300, height: 900 }]]);
const settings = { lang: 'ko', doc: { headerText: '팀 매뉴얼', author: '홍길동', toc: true, revisions: true } };
const logo = { data: PNG, width: 400, height: 100 };
const now = new Date(Date.UTC(2026, 10, 25, 5));

/* ---------- 공통 ---------- */

test('XML 글자: 제어 문자·짝 없는 서로게이트는 빼고, 탭은 칸으로, 이스케이프', () => {
  assert.equal(cleanText('a\u0000b\u0007c\td\ud800e\udc00f😀'), 'abc def😀');
  assert.equal(xmlEsc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  assert.deepEqual(splitLines('a\r\nb\rc\n\n'), ['a', 'b', 'c']);
  assert.deepEqual(fitBox(2000, 1000, 1000, 1000), { cx: 1000, cy: 500 });
  assert.deepEqual(fitBox(100, 50, 1000, 1000, 2), { cx: 200, cy: 100 });   // 작은 그림은 maxScale 까지만
});

test('개정 이력 줄: 가이드에 적은 줄을 쓰고, 없으면 한 줄(1.0, 만든 날, 작성자, 최초 작성)', () => {
  const t = exportStrings('ko');
  assert.deepEqual(revisionRows({ createdAt: Date.UTC(2026, 0, 2, 3) }, '홍길동', t), [{ version: '1.0', date: '2026-01-02', author: '홍길동', note: '최초 작성' }]);
  const rows = revisionRows({ revisions: [{ version: '1.1', date: '2026-02-01', author: 'A', note: '수정' }, {}, null] }, 'X', t);
  assert.deepEqual(rows, [{ version: '1.1', date: '2026-02-01', author: 'A', note: '수정' }]);
  assert.equal(exportStrings('en').initial, 'Initial version');
});

/* ---------- Word ---------- */

test('Word: 패키지 구성·관계·XML 짜임이 맞음', () => {
  const files = buildDocx({ session, steps, images, settings, logo, now });
  const { map, text } = checkPackage(files);
  for (const n of ['word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/header1.xml', 'word/footer1.xml', 'docProps/core.xml', 'docProps/app.xml'])
    assert.ok(map.has(n), n);
  assert.ok(map.has('word/media/step-001.jpeg') && map.has('word/media/step-003.png') && map.has('word/media/logo.png'));
  assert.ok(text('word/_rels/header1.xml.rels').includes('media/logo.png'));
  assert.ok(text('word/styles.xml').includes('w:eastAsia="맑은 고딕"'));
  assert.ok(text('word/settings.xml').includes('<w:updateFields w:val="true"/>'));
  assert.ok(text('docProps/core.xml').includes('<dc:creator>홍길동</dc:creator>'));
});

test('Word: 제목의 특수 문자는 이스케이프, 제어 문자는 빠지고, 설명의 줄바꿈은 유지', () => {
  const doc = dec.decode(buildDocx({ session, steps, images, settings, logo, now }).find((f) => f.name === 'word/document.xml').data);
  assert.ok(doc.includes('주문 취소 &lt;관리자&gt; &amp; &quot;테스트&quot;'));
  assert.ok(!doc.includes('\u0007'));
  assert.match(doc, /저장합니다\.<\/w:t><\/w:r><w:r><w:br\/><\/w:r><w:r><w:t xml:space="preserve">두 번째 줄/);
  assert.match(doc, /첫 줄<\/w:t><\/w:r><w:r><w:br\/>/);
  assert.ok(!doc.includes('SECRET'), '주소의 쿼리를 넣지 않음');
  assert.ok(doc.includes('shop.example.com'));
});

test('Word: 목차는 단계마다 책갈피로 이어지고, 제목 없는 단계는 "n단계", 메모는 Note 스타일', () => {
  const doc = dec.decode(buildDocx({ session, steps, images, settings, logo, now }).find((f) => f.name === 'word/document.xml').data);
  const anchors = [...doc.matchAll(/w:anchor="([^"]+)"/g)].map((m) => m[1]);
  const marks = [...doc.matchAll(/<w:bookmarkStart w:id="\d+" w:name="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.deepEqual(anchors, marks);
  assert.equal(marks.length, 3);
  assert.match(doc, /TOC \\o "1-1" \\h \\z \\u/);
  assert.equal((doc.match(/w:fldCharType="begin"/g) || []).length, 1, '본문의 필드는 목차 하나');
  assert.ok(doc.includes('3. 3단계'));
  assert.match(doc, /<w:pStyle w:val="Note"\/><\/w:pPr><w:r><w:t xml:space="preserve">메모 내용/);
  // 첫 단계는 새 쪽에서 (앞에 개정 이력·목차가 있으니)
  assert.match(doc, /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/>/);
});

test('Word: 그림은 본문 폭(17cm)·높이(14cm) 안으로, 작은 그림은 96dpi 보다 키우지 않음', () => {
  const doc = dec.decode(buildDocx({ session, steps, images, settings, logo, now }).find((f) => f.name === 'word/document.xml').data);
  const ext = [...doc.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(ext.length, 2);
  const [wide, tall] = ext;
  assert.ok(wide[0] <= 9638 * 635 && Math.abs(wide[0] / wide[1] - 1.6) < 0.01, JSON.stringify(wide));
  assert.ok(tall[1] <= 14 * 360000 && tall[0] <= 300 * 9525, JSON.stringify(tall));
  const ids = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, '그림 번호가 겹치지 않음');
});

test('Word: 개정 이력·목차를 끄고 로고·작성자가 없으면 그 부분이 빠지고, 영어 가이드는 영어 문구', () => {
  const files = buildDocx({ session: { ...session, lang: 'en', revisions: [] }, steps, images, settings: { lang: 'en', doc: { toc: false, revisions: false } }, logo: null, now });
  const { map, text } = checkPackage(files);
  const doc = text('word/document.xml');
  assert.ok(!doc.includes('TOC \\o') && !doc.includes('w:tbl>') && !doc.includes('pageBreakBefore'));
  assert.ok(!text('word/settings.xml').includes('updateFields'));
  assert.ok(!map.has('word/_rels/header1.xml.rels') && !map.has('word/media/logo.png'));
  assert.ok(!text('docProps/core.xml').includes('dc:creator'));
  assert.ok(doc.includes('3 steps') && doc.includes('3. Step 3'));
  assert.ok(text('word/header1.xml').includes(xmlEsc(session.name)), '머리글을 비우면 가이드 제목');
});

test('Word: 가이드에 적은 개정 이력이 표에 들어감', () => {
  const s = { ...session, revisions: [{ version: '1.0', date: '2026-11-01', author: '김', note: '최초' }, { version: '1.1', date: '2026-11-20', author: '이', note: '화면 바뀜' }] };
  const doc = dec.decode(buildDocx({ session: s, steps, images, settings, logo, now }).find((f) => f.name === 'word/document.xml').data);
  assert.equal((doc.match(/<w:tr>/g) || []).length, 3, '머리 줄 + 2줄');
  assert.ok(doc.includes('화면 바뀜') && !doc.includes('최초 작성'));
});

/* ---------- PowerPoint ---------- */

test('PowerPoint: 패키지 구성·관계·XML 짜임이 맞고, 표지 + 단계마다 한 장', () => {
  const files = buildPptx({ session, steps, images, settings, logo, now });
  const { map, text } = checkPackage(files);
  const pres = text('ppt/presentation.xml');
  const sld = [...pres.matchAll(/<p:sldId id="(\d+)" r:id="([^"]+)"\/>/g)];
  assert.equal(sld.length, 4);
  assert.equal(new Set(sld.map((m) => m[1])).size, 4);
  assert.ok(sld.every((m) => Number(m[1]) >= 256));
  assert.ok(pres.includes('<p:sldSz cx="12192000" cy="6858000"/>'));
  for (let k = 1; k <= 4; k++) assert.ok(text(`ppt/slides/_rels/slide${k}.xml.rels`).includes('slideLayout1.xml'));
  assert.ok(map.has('ppt/media/step-001.jpeg') && map.has('ppt/media/step-003.png') && map.has('ppt/media/logo.png'));
  assert.ok(text('ppt/theme/theme1.xml').includes('typeface="맑은 고딕"'));
  assert.ok(text('docProps/app.xml').includes('<Slides>4</Slides>'));
});

test('PowerPoint: 슬라이드 글 — 이스케이프, 줄바꿈은 문단, 쪽 번호, 메모 슬라이드, 로고', () => {
  const files = buildPptx({ session, steps, images, settings, logo, now });
  const get = (n) => dec.decode(files.find((f) => f.name === n).data);
  const cover = get('ppt/slides/slide1.xml');
  assert.ok(cover.includes('주문 취소 &lt;관리자&gt; &amp; &quot;테스트&quot;'));
  assert.ok(cover.includes('<a:t>첫 줄</a:t>') && cover.includes('<a:t>둘째 줄</a:t>'));
  const s1 = get('ppt/slides/slide2.xml');
  assert.ok(s1.includes('<a:t>저장합니다.</a:t>') && s1.includes('<a:t>두 번째 줄</a:t>') && !s1.includes('\u0007'));
  assert.ok(s1.includes('<a:t>1 / 3</a:t>') && s1.includes('<a:t>팀 매뉴얼</a:t>'));
  const note = get('ppt/slides/slide3.xml');
  assert.ok(note.includes('name="Note"') && !/name="Picture \d+"/.test(note), '메모 슬라이드에는 단계 그림 없음 (로고만)');
  assert.ok(get('ppt/slides/slide4.xml').includes('<a:t>3단계</a:t>'));
  for (let k = 1; k <= 4; k++) assert.ok(get(`ppt/slides/_rels/slide${k}.xml.rels`).includes('../media/logo.png'), `slide${k} 로고`);
  // 그림은 슬라이드 안에
  const pic = s1.match(/<p:pic>.*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
  const [x, y, cx, cy] = pic.slice(1).map(Number);
  assert.ok(x >= 0 && y > 0 && x + cx <= 12192000 && y + cy <= 6858000, pic.slice(1).join(','));
});

test('PowerPoint 글자 크기: 한글은 라틴보다 넓게 어림하고, 길면 작은 크기로', () => {
  const W = 9144000;   // 10in
  assert.ok(lineCount('가'.repeat(60), 24, W) > lineCount('a'.repeat(60), 24, W));
  const short = fitText('짧은 제목', W, 685800, [2600, 2200, 1800]);
  const long = fitText('아주 긴 제목 '.repeat(12), W, 685800, [2600, 2200, 1800]);
  assert.equal(short.size, 2600);
  assert.ok(long.size < 2600);
});

test('ZIP: Word·PowerPoint 형식으로 묶고 다시 읽으면 그대로', async () => {
  const files = buildDocx({ session, steps, images, settings, logo, now });
  const blob = createZip(files, now, DOCX_MIME);
  assert.equal(blob.type, DOCX_MIME);
  const z = await readZip(blob);
  assert.deepEqual(z.names, files.map((f) => f.name));
  assert.deepEqual(await z.read('word/media/step-001.jpeg'), JPEG);
  assert.equal(createZip(buildPptx({ session, steps, images, settings, logo, now }), now, PPTX_MIME).type, PPTX_MIME);
});

/* ---------- HTML·Markdown·설정 ---------- */

test('HTML·Markdown: 고정 문구를 가이드 언어로, HTML 설명은 줄바꿈 유지', () => {
  const html = buildGuideHtml({ ...session, lang: 'en', name: '' }, steps, new Map(), { lang: 'ko' });
  assert.ok(html.includes('<html lang="en">') && html.includes('User guide') && html.includes('3 steps') && html.includes('Made with ClickGuide'));
  assert.ok(/\.body p\{[^}]*white-space:pre-wrap/.test(html));
  const ko = buildGuideHtml({ ...session, lang: undefined }, steps, new Map(), { lang: 'ko' });
  assert.ok(ko.includes('3단계') && ko.includes('ClickGuide로 만든 가이드'));
  const md = buildMarkdown({ ...session, lang: 'en' }, steps, new Map(), {});
  assert.ok(md.includes('_3 steps · ') && md.includes('_Made with ClickGuide_'));
});

test('설정: 문서 양식은 글 길이를 줄이고, 로고는 PNG·JPEG data URL 만, 이미지 크기는 정한 값만', () => {
  const d = normalizeDoc({ headerText: '  머리글 '.repeat(40), author: 'a'.repeat(100), logo: 'data:image/svg+xml;base64,PHN2Zz4=', toc: false });
  assert.equal(d.headerText.length, 120);
  assert.equal(d.author.length, 60);
  assert.equal(d.logo, '');
  assert.equal(d.toc, false);
  assert.equal(d.revisions, true);
  assert.equal(normalizeDoc({ logo: 'data:image/png;base64,iVBORw0KGgo=' }).logo, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(normalizeDoc({ logo: 'data:image/png;base64,' + 'A'.repeat(800000) }).logo, '');
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, exportImageWidth: 1280 }).exportImageWidth, 1280);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, exportImageWidth: 777 }).exportImageWidth, 0);
  assert.deepEqual(normalizeSettings({ ...DEFAULT_SETTINGS, doc: undefined }).doc, DEFAULT_SETTINGS.doc);
});
