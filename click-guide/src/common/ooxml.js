/* Word(.docx)·PowerPoint(.pptx) 공통: XML 글자 처리, 패키지 부품(콘텐츠 형식·관계·문서 속성), 단위 바꾸기.
 * 외부 라이브러리 없이 OOXML 을 직접 쓴다. ZIP 으로 묶는 일은 lib/zip.js 가 한다.
 * DOM 을 쓰지 않아 Node 시험에서도 그대로 돈다. */
import { formatDate } from './util.js';

export const EMU_PER_INCH = 914400;
export const EMU_PER_CM = 360000;
export const TWIP_PER_CM = 1440 / 2.54;   // 1 twip = 1/20 pt
export const EMU_PER_TWIP = 635;

export const NS = {
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
};

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles',
};

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML 1.0 에 넣을 수 없는 글자(제어 문자, 짝 없는 서로게이트, U+FFFE·U+FFFF)를 뺀다. 탭은 칸 하나로 */
export function cleanText(s) {
  let out = '';
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c === 0x09) { out += ' '; continue; }
    if (c === 0x0a || c === 0x0d) { out += str[i]; continue; }
    if (c < 0x20 || c === 0xfffe || c === 0xffff) continue;
    out += str[i];
  }
  return out;
}

/** 글자·속성값 이스케이프 (cleanText 포함) */
export function xmlEsc(s) {
  return cleanText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 여러 줄 글 → 줄 목록 (\r\n·\r 도 줄바꿈, 끝의 빈 줄은 뺌) */
export function splitLines(s) {
  const lines = cleanText(s).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** 관계 파일. rels: [{ id, type, target, mode? }] */
export function relsXml(rels) {
  const items = rels.map((r) => `<Relationship Id="${xmlEsc(r.id)}" Type="${xmlEsc(r.type)}" Target="${xmlEsc(r.target)}"${r.mode ? ` TargetMode="${xmlEsc(r.mode)}"` : ''}/>`);
  return `${XML_HEAD}<Relationships xmlns="${NS.pr}">${items.join('')}</Relationships>`;
}

/** [Content_Types].xml. defaults: { 확장자: 형식 }, overrides: { '/부품 경로': 형식 } */
export function contentTypesXml(defaults, overrides) {
  const d = Object.entries(defaults).map(([ext, type]) => `<Default Extension="${xmlEsc(ext)}" ContentType="${xmlEsc(type)}"/>`);
  const o = Object.entries(overrides).map(([part, type]) => `<Override PartName="${xmlEsc(part)}" ContentType="${xmlEsc(type)}"/>`);
  return `${XML_HEAD}<Types xmlns="${NS.ct}">${d.join('')}${o.join('')}</Types>`;
}

export const CT = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  jpeg: 'image/jpeg',
  png: 'image/png',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
};

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** docProps/core.xml — 작성자는 사용자가 설정에 적었을 때만 넣는다 */
export function corePropsXml({ title, author, created, modified, lang }) {
  const parts = [`<dc:title>${xmlEsc(title || '')}</dc:title>`];
  if (author) parts.push(`<dc:creator>${xmlEsc(author)}</dc:creator>`, `<cp:lastModifiedBy>${xmlEsc(author)}</cp:lastModifiedBy>`);
  if (lang) parts.push(`<dc:language>${xmlEsc(lang)}</dc:language>`);
  parts.push(`<dcterms:created xsi:type="dcterms:W3CDTF">${iso(created)}</dcterms:created>`);
  parts.push(`<dcterms:modified xsi:type="dcterms:W3CDTF">${iso(modified || created)}</dcterms:modified>`);
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"`
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `${parts.join('')}</cp:coreProperties>`;
}

/** docProps/app.xml. extra: 부품별 추가 요소 (예: '<Slides>3</Slides>') */
export function appPropsXml(extra = '') {
  return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"`
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Application>ClickGuide</Application>${extra}</Properties>`;
}

/** 이미지를 box(가로·세로 EMU) 안에 비율을 지켜 넣을 크기. 원래보다 키우지 않으려면 maxScale 로 막는다 */
export function fitBox(width, height, boxW, boxH, maxScale = Infinity) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const s = Math.min(boxW / w, boxH / h, maxScale);
  return { cx: Math.max(1, Math.round(w * s)), cy: Math.max(1, Math.round(h * s)) };
}

/** 이미지 바이트의 확장자 (PNG 서명이면 png, 아니면 jpeg) */
export function imageExt(bytes) {
  const b = bytes || [];
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : 'jpeg';
}

/* ---------------- 내보내기 문구 (HTML·Word·PowerPoint 공통) ---------------- */

const STR = {
  ko: {
    defaultTitle: '사용 가이드',
    steps: (n) => `${n}단계`,
    madeWith: 'ClickGuide로 만든 가이드',
    stepImage: '단계 이미지',
    contents: '목차',
    revisions: '개정 이력',
    version: '버전',
    date: '날짜',
    author: '작성자',
    changes: '내용',
    initial: '최초 작성',
    note: '메모',
    stepN: (n) => `${n}단계`,
  },
  en: {
    defaultTitle: 'User guide',
    steps: (n) => `${n} ${n === 1 ? 'step' : 'steps'}`,
    madeWith: 'Made with ClickGuide',
    stepImage: 'Step image',
    contents: 'Contents',
    revisions: 'Revision history',
    version: 'Version',
    date: 'Date',
    author: 'Author',
    changes: 'Changes',
    initial: 'Initial version',
    note: 'Note',
    stepN: (n) => `Step ${n}`,
  },
};

/** 내보내기 문구: 가이드를 만든 언어(session.lang) → 설정 언어 → 한국어 */
export function exportStrings(lang) {
  return STR[lang === 'en' ? 'en' : 'ko'];
}

/** 개정 이력 줄: 가이드에 적어 둔 것이 있으면 그것, 없으면 한 줄(1.0, 만든 날, 작성자, 최초 작성) */
export function revisionRows(session, author, t) {
  const rows = Array.isArray(session && session.revisions) ? session.revisions.filter((r) => r && (r.version || r.date || r.author || r.note)) : [];
  if (rows.length) return rows.map((r) => ({ version: String(r.version || ''), date: String(r.date || ''), author: String(r.author || ''), note: String(r.note || '') }));
  return [{ version: '1.0', date: formatDate(session && session.createdAt), author: author || '', note: t.initial }];
}
