/* Word 문서(.docx) 만들기 — 외부 라이브러리 없이 OOXML 부품을 직접 쓴다.
 * 구성: 제목·요약 → 개정 이력 표 → 목차(TOC 필드) → 단계(제목 1 + 설명 + 그림)
 * 머리글에 로고·머리글 글, 바닥글에 쪽 번호(현재/전체). 글꼴은 맑은 고딕, 용지는 A4.
 * 목차의 쪽 번호는 Word 가 문서를 열 때 필드를 업데이트하면서 채운다(settings.xml 의 updateFields).
 * DOM 을 쓰지 않는다 (Node 시험에서도 돈다). */
import {
  NS, REL, CT, XML_HEAD, xmlEsc, splitLines, relsXml, contentTypesXml, corePropsXml, appPropsXml,
  fitBox, imageExt, exportStrings, revisionRows, EMU_PER_CM, EMU_PER_TWIP,
} from './ooxml.js';
import { formatDate, placeName } from './util.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const FONT = '맑은 고딕';
// A4, 여백 위아래 2.5cm·좌우 2cm (twip)
const PAGE = { w: 11906, h: 16838, top: 1418, bottom: 1418, left: 1134, right: 1134, header: 567, footer: 567 };
const TEXT_W = PAGE.w - PAGE.left - PAGE.right;            // 9638 twip = 17cm
const IMG_BOX = { w: TEXT_W * EMU_PER_TWIP, h: 14 * EMU_PER_CM };
const PX_EMU = 9525;                                         // 96dpi 에서 1px. 작은 그림을 이보다 크게 늘리지 않는다
const COLORS = { ink: '1F2A44', muted: '666C78', line: 'D0D4DC', head: 'EEF1F6', note: 'FFF8E1', accent: '2F6DF6' };

const ROOT_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`;

const rPr = (inner) => (inner ? `<w:rPr>${inner}</w:rPr>` : '');
const run = (text, props = '') => `<w:r>${rPr(props)}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const style = (id) => `<w:pStyle w:val="${id}"/>`;

/** 여러 줄 글: 줄 사이에 줄바꿈(<w:br/>)을 넣어 한 문단으로 */
function linesRuns(text, props = '') {
  return splitLines(text).map((line, i) => (i ? `<w:r>${rPr(props)}<w:br/></w:r>` : '') + run(line, props)).join('');
}

function inlineImage({ rid, cx, cy, id, name, descr, border }) {
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="${xmlEsc(name)}" descr="${xmlEsc(descr)}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlEsc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + (border ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${COLORS.line}"/></a:solidFill></a:ln>` : '')
    + '</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

const fld = (type) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
const instr = (code) => `<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>`;

/** 바뀌는 값 필드 (쪽 번호 등). 처음 보이는 값은 shown */
const field = (code, shown) => fld('begin') + instr(code) + fld('separate') + run(shown) + fld('end');

function cell(text, width, { head = false } = {}) {
  const shd = head ? `<w:shd w:val="clear" w:color="auto" w:fill="${COLORS.head}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shd}</w:tcPr>`
    + para(linesRuns(text, head ? '<w:b/>' : ''), '<w:spacing w:before="40" w:after="40"/>') + '</w:tc>';
}

function revisionTable(rows, t) {
  const widths = [1250, 1650, 1900, TEXT_W - 1250 - 1650 - 1900];
  const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${[t.version, t.date, t.author, t.changes].map((h, i) => cell(h, widths[i], { head: true })).join('')}</w:tr>`;
  const body = rows.map((r) => `<w:tr>${[r.version, r.date, r.author, r.note].map((v, i) => cell(v, widths[i])).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/>`
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

const bookmarkName = (i) => `_TocCG${String(i + 1).padStart(4, '0')}`;

/** 목차: TOC 필드. 처음 보이는 내용은 단계 제목 링크(쪽 번호 없음), Word 가 필드를 업데이트하면 쪽 번호가 붙는다 */
function tocParagraphs(titles) {
  const tab = `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TEXT_W}"/></w:tabs>`;
  const out = titles.map((title, i) => {
    const begin = i === 0 ? fld('begin') + instr('TOC \\o "1-1" \\h \\z \\u') + fld('separate') : '';
    const link = `<w:hyperlink w:anchor="${bookmarkName(i)}" w:history="1">${run(title, '<w:rStyle w:val="Hyperlink"/><w:noProof/>')}</w:hyperlink>`;
    return para(begin + link, style('TOC1') + tab);
  });
  out.push(para(fld('end')));
  return out.join('');
}

function stylesXml() {
  const fonts = `<w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`;
  const p = (id, name, { basedOn = 'Normal', next = 'Normal', ui, q = true, pPr = '', rPr: r = '', hidden = false } = {}) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}<w:next w:val="${next}"/>`
    + `${ui !== undefined ? `<w:uiPriority w:val="${ui}"/>` : ''}${hidden ? '<w:unhideWhenUsed/>' : ''}${q ? '<w:qFormat/>' : ''}`
    + `${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${r ? `<w:rPr>${r}</w:rPr>` : ''}</w:style>`;
  return `${XML_HEAD}<w:styles xmlns:w="${NS.w}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="2B2F38"/></w:rPr></w:style>`
    + p('Title', 'Title', { pPr: '<w:spacing w:after="80"/>', rPr: `<w:b/><w:color w:val="${COLORS.ink}"/><w:sz w:val="44"/><w:szCs w:val="44"/>` })
    + p('Subtitle', 'Subtitle', { pPr: '<w:spacing w:after="240"/>', rPr: `<w:color w:val="${COLORS.muted}"/><w:sz w:val="19"/><w:szCs w:val="19"/>` })
    + p('Heading1', 'heading 1', { ui: 9, pPr: '<w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', rPr: `<w:b/><w:color w:val="${COLORS.ink}"/><w:sz w:val="26"/><w:szCs w:val="26"/>` })
    + p('SectionTitle', 'Section Title', { pPr: '<w:keepNext/><w:spacing w:before="360" w:after="120"/>', rPr: `<w:b/><w:color w:val="${COLORS.ink}"/><w:sz w:val="24"/><w:szCs w:val="24"/>` })
    + p('TOCHeading', 'TOC Heading', { basedOn: 'SectionTitle', ui: 39, hidden: true })
    + p('TOC1', 'toc 1', { ui: 39, q: false, hidden: true, pPr: `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TEXT_W}"/></w:tabs><w:spacing w:after="80"/>` })
    + p('Note', 'Note', { pPr: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="E0B040"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${COLORS.note}"/><w:ind w:left="170" w:right="170"/>` })
    + p('Figure', 'Figure', { pPr: '<w:spacing w:before="60" w:after="240" w:line="240" w:lineRule="auto"/>' })
    + p('Header', 'header', { ui: 99, q: false, hidden: true, pPr: `<w:tabs><w:tab w:val="right" w:pos="${TEXT_W}"/></w:tabs><w:spacing w:after="0"/>`, rPr: `<w:color w:val="${COLORS.muted}"/><w:sz w:val="17"/><w:szCs w:val="17"/>` })
    + p('Footer', 'footer', { ui: 99, q: false, hidden: true, pPr: '<w:spacing w:after="0"/><w:jc w:val="center"/>', rPr: `<w:color w:val="${COLORS.muted}"/><w:sz w:val="17"/><w:szCs w:val="17"/>` })
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="${COLORS.accent}"/></w:rPr></w:style>`
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>'
    + '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>'
    + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    + `<w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${COLORS.line}"/>`).join('')}</w:tblBorders></w:tblPr></w:style>`
    + '</w:styles>';
}

/** updateFields: 목차가 있을 때만. Word 가 문서를 열면서 필드(목차 쪽 번호)를 다시 계산할지 묻는다 */
function settingsXml(updateFields) {
  return `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="800"/>`
    + '<w:characterSpacingControl w:val="doNotCompress"/>' + (updateFields ? '<w:updateFields w:val="true"/>' : '')
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + '<w:themeFontLang w:val="en-US" w:eastAsia="ko-KR"/><w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>';
}

function fontTableXml() {
  return `${XML_HEAD}<w:fonts xmlns:w="${NS.w}"><w:font w:name="${FONT}"><w:altName w:val="Malgun Gothic"/>`
    + '<w:panose1 w:val="020B0503020000020004"/><w:charset w:val="81"/><w:family w:val="modern"/><w:pitch w:val="variable"/></w:font></w:fonts>';
}

function headerXml(text, logoRun) {
  const border = `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="${COLORS.line}"/></w:pBdr>`;
  return `${XML_HEAD}<w:hdr ${ROOT_NS}>${para((logoRun || '') + '<w:r><w:tab/></w:r>' + run(text), style('Header') + border)}</w:hdr>`;
}

function footerXml() {
  return `${XML_HEAD}<w:ftr ${ROOT_NS}>${para(field('PAGE', '1') + run(' / ') + field('NUMPAGES', '1'), style('Footer'))}</w:ftr>`;
}

/**
 * Word 문서 부품 목록을 만든다.
 * session: 가이드, steps: 단계(순서대로), images: Map<stepId, { data: Uint8Array, width, height }> (가림·그림을 구운 JPEG)
 * settings: 설정 (lang, doc: { headerText, author, toc, revisions }), logo: { data, width, height } | null, now: Date
 * 반환: [{ name, data: Uint8Array }]  ([Content_Types].xml 이 맨 앞)
 */
export function buildDocx({ session, steps, images, settings = {}, logo = null, now = new Date() }) {
  const lang = session.lang || settings.lang || 'ko';
  const t = exportStrings(lang);
  const doc = settings.doc || {};
  const title = session.name || t.defaultTitle;
  const author = String(doc.author || '').trim();
  const enc = new TextEncoder();
  const files = [];
  const media = [];
  const docRels = [
    { id: 'rIdStyles', type: REL.styles, target: 'styles.xml' },
    { id: 'rIdSettings', type: REL.settings, target: 'settings.xml' },
    { id: 'rIdFonts', type: REL.fontTable, target: 'fontTable.xml' },
    { id: 'rIdHeader1', type: REL.header, target: 'header1.xml' },
    { id: 'rIdFooter1', type: REL.footer, target: 'footer1.xml' },
  ];

  /* ---- 머리 ---- */
  const body = [];
  body.push(para(run(title), style('Title')));
  const host = placeName(session.startUrl);
  const meta = [t.steps(steps.length), formatDate(session.createdAt), host, author].filter(Boolean).join(' · ');
  body.push(para(run(meta), style('Subtitle')));
  if (session.description && String(session.description).trim()) body.push(para(linesRuns(session.description)));

  const withRevisions = doc.revisions !== false;
  const withToc = doc.toc !== false && steps.length > 0;
  if (withRevisions) {
    body.push(para(run(t.revisions), style('SectionTitle')));
    body.push(revisionTable(revisionRows(session, author, t), t));
    body.push(para(''));
  }
  const stepTitle = (s, i) => `${i + 1}. ${String(s.title || '').trim() || t.stepN(i + 1)}`;
  if (withToc) {
    body.push(para(run(t.contents), style('TOCHeading')));
    body.push(tocParagraphs(steps.map(stepTitle)));
  }

  /* ---- 단계 ---- */
  let picId = 1;
  steps.forEach((s, i) => {
    const pageBreak = i === 0 && (withRevisions || withToc) ? '<w:pageBreakBefore/>' : '';
    const bm = bookmarkName(i);
    body.push(`<w:p><w:pPr>${style('Heading1')}${pageBreak}</w:pPr><w:bookmarkStart w:id="${i + 1}" w:name="${bm}"/>${run(stepTitle(s, i))}<w:bookmarkEnd w:id="${i + 1}"/></w:p>`);
    const img = images && images.get(s.id);
    const desc = String(s.description || '').trim() ? s.description : '';
    if (s.type === 'note') {
      if (desc) body.push(para(linesRuns(desc), style('Note') + (img ? '<w:keepNext/>' : '')));
    } else if (desc) {
      body.push(para(linesRuns(desc), img ? '<w:keepNext/>' : ''));
    }
    if (img && img.data) {
      const ext = imageExt(img.data);
      const name = `media/step-${String(i + 1).padStart(3, '0')}.${ext}`;
      const rid = `rIdImg${i + 1}`;
      media.push({ name: `word/${name}`, data: img.data });
      docRels.push({ id: rid, type: REL.image, target: name });
      const { cx, cy } = fitBox(img.width, img.height, IMG_BOX.w, IMG_BOX.h, PX_EMU);
      body.push(para(inlineImage({ rid, cx, cy, id: picId, name: `Picture ${picId}`, descr: stepTitle(s, i), border: true }), style('Figure')));
      picId++;
    }
  });

  const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:footerReference w:type="default" r:id="rIdFooter1"/>'
    + `<w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>`
    + `<w:pgMar w:top="${PAGE.top}" w:right="${PAGE.right}" w:bottom="${PAGE.bottom}" w:left="${PAGE.left}" w:header="${PAGE.header}" w:footer="${PAGE.footer}" w:gutter="0"/>`
    + '<w:cols w:space="425"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  const documentXml = `${XML_HEAD}<w:document ${ROOT_NS}><w:body>${body.join('')}${sect}</w:body></w:document>`;

  /* ---- 머리글(로고·글)·바닥글(쪽 번호) ---- */
  const headerRels = [];
  let logoRun = '';
  if (logo && logo.data && logo.width && logo.height) {
    const ext = imageExt(logo.data);
    media.push({ name: `word/media/logo.${ext}`, data: logo.data });
    headerRels.push({ id: 'rIdLogo', type: REL.image, target: `media/logo.${ext}` });
    const { cx, cy } = fitBox(logo.width, logo.height, 4 * EMU_PER_CM, 0.9 * EMU_PER_CM);
    logoRun = inlineImage({ rid: 'rIdLogo', cx, cy, id: 100000, name: 'Logo', descr: 'logo', border: false });   // 본문 그림 번호와 겹치지 않게
  }
  const headerText = String(doc.headerText || '').trim() || title;

  const exts = new Set(media.map((m) => m.name.split('.').pop()));
  const defaults = { rels: CT.rels, xml: CT.xml };
  for (const e of exts) defaults[e] = CT[e];
  files.push({ name: '[Content_Types].xml', data: contentTypesXml(defaults, {
    '/word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    '/word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    '/word/settings.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
    '/word/fontTable.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
    '/word/header1.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
    '/word/footer1.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
    '/docProps/core.xml': CT.core,
    '/docProps/app.xml': CT.app,
  }) });
  files.push({ name: '_rels/.rels', data: relsXml([
    { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
    { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
    { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' },
  ]) });
  files.push({ name: 'docProps/core.xml', data: corePropsXml({ title, author, created: session.createdAt || now, modified: now, lang: lang === 'en' ? 'en-US' : 'ko-KR' }) });
  files.push({ name: 'docProps/app.xml', data: appPropsXml() });
  files.push({ name: 'word/document.xml', data: documentXml });
  files.push({ name: 'word/_rels/document.xml.rels', data: relsXml(docRels) });
  files.push({ name: 'word/styles.xml', data: stylesXml() });
  files.push({ name: 'word/settings.xml', data: settingsXml(withToc) });
  files.push({ name: 'word/fontTable.xml', data: fontTableXml() });
  files.push({ name: 'word/header1.xml', data: headerXml(headerText, logoRun) });
  if (headerRels.length) files.push({ name: 'word/_rels/header1.xml.rels', data: relsXml(headerRels) });
  files.push({ name: 'word/footer1.xml', data: footerXml() });
  for (const m of media) files.push(m);
  return files.map((f) => ({ name: f.name, data: typeof f.data === 'string' ? enc.encode(f.data) : f.data }));
}
