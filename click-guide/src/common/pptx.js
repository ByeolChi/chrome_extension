/* PowerPoint(.pptx) 만들기 — 외부 라이브러리 없이 OOXML 부품을 직접 쓴다.
 * 16:9. 첫 장은 표지(로고·제목·요약), 그다음 단계마다 한 장(번호·제목·설명·그림), 아래쪽에 머리글 글과 쪽 번호.
 * 글꼴은 맑은 고딕. 슬라이드 마스터·레이아웃·테마는 최소 구성(빈 레이아웃 하나)이다.
 * DOM 을 쓰지 않는다 (Node 시험에서도 돈다). */
import {
  NS, REL, CT, XML_HEAD, xmlEsc, splitLines, relsXml, contentTypesXml, corePropsXml, appPropsXml,
  fitBox, imageExt, exportStrings, EMU_PER_INCH,
} from './ooxml.js';
import { formatDate, placeName } from './util.js';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const FONT = '맑은 고딕';
const W = 12192000;   // 13.333in
const H = 6858000;    // 7.5in
const IN = (x) => Math.round(x * EMU_PER_INCH);
const M = IN(0.5);
const PX_EMU = 9525 * 1.25;   // 작은 그림은 96dpi 의 1.25배까지만 키운다
const COLORS = { ink: '1F2A44', text: '2B2F38', muted: '666C78', line: 'D0D4DC', accent: '2F6DF6', note: 'FFF8E1', noteLine: 'E0B040' };
const ROOT_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const fill = (hex) => (hex ? `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>` : '<a:noFill/>');
const xfrm = (x, y, cx, cy) => `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`;

function runXml(text, { size, color, bold, lang }) {
  return `<a:r><a:rPr lang="${lang}" altLang="en-US" sz="${size}"${bold ? ' b="1"' : ''} dirty="0">${fill(color)}`
    + `<a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/></a:rPr><a:t>${xmlEsc(text)}</a:t></a:r>`;
}

/** 글 상자. lines: 문단 목록 (빈 줄은 빈 문단) */
function textShape(id, name, { x, y, w, h, lines, size = 1800, color = COLORS.text, bold = false, anchor = 't', align = 'l', bg = '', border = '', inset = 0, geom = 'rect', lang, autofit = true }) {
  const paras = lines.map((line) => {
    const pPr = align === 'l' ? '' : `<a:pPr algn="${align}"/>`;
    const end = `<a:endParaRPr lang="${lang}" altLang="en-US" sz="${size}" dirty="0"/>`;
    return line ? `<a:p>${pPr}${runXml(line, { size, color, bold, lang })}</a:p>` : `<a:p>${pPr}${end}</a:p>`;
  }).join('');
  const ins = Math.round(inset);
  const ln = border ? `<a:ln w="12700">${fill(border)}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill(bg)}${ln}</p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${anchor}" rtlCol="0">${autofit ? '<a:normAutofit/>' : '<a:noAutofit/>'}</a:bodyPr>`
    + `<a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

function picture(id, name, descr, rid, { x, y, cx, cy, border = true }) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEsc(name)}" descr="${xmlEsc(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(x, y, cx, cy)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + (border ? `<a:ln w="9525">${fill(COLORS.line)}</a:ln>` : '')
    + '</p:spPr></p:pic>';
}

function slideXml(shapes) {
  return `${XML_HEAD}<p:sld ${ROOT_NS}><p:cSld><p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/* 글 상자에 들어갈 글자 크기 고르기. 글자 폭(em)은 한글·한자·전각 1, 칸 0.3, 그 밖 0.55 로 어림한다 */
function isWide(c) {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
}
function emWidth(line) {
  let w = 0;
  for (const ch of line) w += isWide(ch.codePointAt(0)) ? 1 : ch === ' ' ? 0.3 : 0.55;
  return w;
}
/** 글이 차지할 줄 수 (sizePt 크기, 상자 가로 boxW EMU) */
export function lineCount(text, sizePt, boxW) {
  const perLine = Math.max(1, ((boxW / EMU_PER_INCH) * 0.95 * 72) / sizePt);
  return splitLines(text).reduce((n, l) => n + Math.max(1, Math.ceil(emWidth(l) / perLine)), 0);
}
const lineH = (sizePt) => (sizePt * 1.25 * EMU_PER_INCH) / 72;
/** 상자(boxW×boxH EMU)에 들어가는 가장 큰 크기(1/100 pt)와 그때의 높이. 다 넘치면 가장 작은 크기 */
export function fitText(text, boxW, boxH, sizes) {
  for (const sz of sizes) {
    const h = lineCount(text, sz / 100, boxW) * lineH(sz / 100);
    if (h <= boxH) return { size: sz, h };
  }
  const sz = sizes[sizes.length - 1];
  return { size: sz, h: Math.min(boxH, lineCount(text, sz / 100, boxW) * lineH(sz / 100)) };
}

function themeXml() {
  const accents = ['2F6DF6', 'FF3B30', 'FF9500', '34C759', 'AF52DE', '00A3BF'];
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML_HEAD}<a:theme xmlns:a="${NS.a}" name="ClickGuide"><a:themeElements>`
    + `<a:clrScheme name="ClickGuide"><a:dk1><a:srgbClr val="${COLORS.ink}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>`
    + `<a:dk2><a:srgbClr val="${COLORS.text}"/></a:dk2><a:lt2><a:srgbClr val="F5F6F8"/></a:lt2>`
    + accents.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')
    + `<a:hlink><a:srgbClr val="${COLORS.accent}"/></a:hlink><a:folHlink><a:srgbClr val="8B5CF6"/></a:folHlink></a:clrScheme>`
    + `<a:fontScheme name="ClickGuide"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:majorFont>`
    + `<a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="ClickGuide"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>`
    + `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${solid}</a:ln>`).join('')}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

function masterXml() {
  const lvl = (sz, mj) => `<a:lvl1pPr><a:defRPr${sz ? ` sz="${sz}"` : ''}><a:latin typeface="+${mj}-lt"/><a:ea typeface="+${mj}-ea"/></a:defRPr></a:lvl1pPr>`;
  return `${XML_HEAD}<p:sldMaster ${ROOT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + `<p:txStyles><p:titleStyle>${lvl(3200, 'mj')}</p:titleStyle><p:bodyStyle>${lvl(1800, 'mn')}</p:bodyStyle><p:otherStyle>${lvl(0, 'mn')}</p:otherStyle></p:txStyles>`
    + '</p:sldMaster>';
}

function layoutXml() {
  return `${XML_HEAD}<p:sldLayout ${ROOT_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

/**
 * PowerPoint 부품 목록을 만든다.
 * session: 가이드, steps: 단계(순서대로), images: Map<stepId, { data: Uint8Array, width, height }>
 * settings: 설정 (lang, doc: { headerText, author }), logo: { data, width, height } | null, now: Date
 * 반환: [{ name, data: Uint8Array }]  ([Content_Types].xml 이 맨 앞)
 */
export function buildPptx({ session, steps, images, settings = {}, logo = null, now = new Date() }) {
  const lang = session.lang || settings.lang || 'ko';
  const t = exportStrings(lang);
  const doc = settings.doc || {};
  const textLang = lang === 'en' ? 'en-US' : 'ko-KR';
  const title = session.name || t.defaultTitle;
  const author = String(doc.author || '').trim();
  const footerText = String(doc.headerText || '').trim() || title;
  const enc = new TextEncoder();
  const media = [];
  const slides = [];   // { xml, rels }

  let logoInfo = null;
  if (logo && logo.data && logo.width && logo.height) {
    const ext = imageExt(logo.data);
    logoInfo = { ...logo, target: `../media/logo.${ext}` };
    media.push({ name: `ppt/media/logo.${ext}`, data: logo.data });
  }
  const layoutRel = { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' };

  /* ---- 표지 ---- */
  {
    const shapes = [];
    const rels = [layoutRel];
    let id = 2;
    if (logoInfo) {
      rels.push({ id: 'rIdLogo', type: REL.image, target: logoInfo.target });
      const { cx, cy } = fitBox(logoInfo.width, logoInfo.height, IN(2.6), IN(0.8));
      shapes.push(picture(id++, 'Logo', 'logo', 'rIdLogo', { x: M, y: IN(0.6), cx, cy, border: false }));
    }
    shapes.push(textShape(id++, 'Accent', { x: M, y: IN(2.35), w: IN(1.1), h: IN(0.08), lines: [''], bg: COLORS.accent, lang: textLang, autofit: false }));
    const tf = fitText(title, W - 2 * M, IN(1.4), [4000, 3400, 2800, 2400]);
    shapes.push(textShape(id++, 'Title', { x: M, y: IN(2.55), w: W - 2 * M, h: IN(1.4), lines: splitLines(title), size: tf.size, color: COLORS.ink, bold: true, anchor: 't', lang: textLang }));
    const meta = [t.steps(steps.length), formatDate(session.createdAt), placeName(session.startUrl), author].filter(Boolean).join(' · ');
    shapes.push(textShape(id++, 'Meta', { x: M, y: IN(4.05), w: W - 2 * M, h: IN(0.45), lines: [meta], size: 1400, color: COLORS.muted, lang: textLang }));
    const desc = String(session.description || '').trim();
    if (desc) shapes.push(textShape(id++, 'Description', { x: M, y: IN(4.65), w: W - 2 * M, h: IN(2.1), lines: splitLines(desc), size: fitText(desc, W - 2 * M, IN(2.1), [1600, 1400, 1200, 1100]).size, color: COLORS.text, lang: textLang }));
    slides.push({ xml: slideXml(shapes), rels });
  }

  /* ---- 단계 ---- */
  steps.forEach((s, i) => {
    const shapes = [];
    const rels = [layoutRel];
    let id = 2;
    const right = logoInfo ? IN(1.9) : 0;
    shapes.push(textShape(id++, 'Number', { x: M, y: IN(0.42), w: IN(0.5), h: IN(0.5), lines: [String(i + 1)], size: 1600, color: 'FFFFFF', bold: true, anchor: 'ctr', align: 'ctr', bg: s.type === 'note' ? COLORS.noteLine : COLORS.accent, geom: 'ellipse', lang: textLang, autofit: false }));
    const stepTitle = String(s.title || '').trim() || t.stepN(i + 1);
    const titleW = W - 2 * M - IN(0.7) - right;
    shapes.push(textShape(id++, 'Title', { x: M + IN(0.7), y: IN(0.3), w: titleW, h: IN(0.75), lines: [stepTitle], size: fitText(stepTitle, titleW, IN(0.75), [2600, 2200, 2000, 1800, 1600]).size, color: COLORS.ink, bold: true, anchor: 'ctr', lang: textLang }));
    if (logoInfo) {
      rels.push({ id: 'rIdLogo', type: REL.image, target: logoInfo.target });
      const { cx, cy } = fitBox(logoInfo.width, logoInfo.height, IN(1.6), IN(0.45));
      shapes.push(picture(id++, 'Logo', 'logo', 'rIdLogo', { x: W - M - cx, y: IN(0.45), cx, cy, border: false }));
    }
    const desc = String(s.description || '').trim();
    const img = images && images.get(s.id);
    let top = IN(1.25);
    if (s.type === 'note' && !img) {
      // 메모: 그림 없이 글만 크게
      const nh = H - top - IN(0.8);
      shapes.push(textShape(id++, 'Note', { x: M, y: top, w: W - 2 * M, h: nh, lines: desc ? splitLines(desc) : [''], size: fitText(desc, W - 2 * M - IN(0.5), nh - IN(0.5), [2000, 1800, 1600, 1400, 1200, 1100]).size, color: COLORS.text, bg: COLORS.note, border: COLORS.noteLine, inset: IN(0.25), lang: textLang }));
    } else {
      if (desc) {
        const inset = s.type === 'note' ? IN(0.1) : 0;
        const df = fitText(desc, W - 2 * M - 2 * inset, IN(1.3), [1600, 1500, 1400, 1300, 1200]);
        const h = df.h + 2 * inset + IN(0.06);
        shapes.push(textShape(id++, 'Description', { x: M, y: top, w: W - 2 * M, h, lines: splitLines(desc), size: df.size, color: s.type === 'note' ? COLORS.text : COLORS.muted, bg: s.type === 'note' ? COLORS.note : '', inset, lang: textLang }));
        top += h + IN(0.2);
      }
      if (img && img.data) {
        const ext = imageExt(img.data);
        const name = `step-${String(i + 1).padStart(3, '0')}.${ext}`;
        media.push({ name: `ppt/media/${name}`, data: img.data });
        rels.push({ id: 'rIdImg', type: REL.image, target: `../media/${name}` });
        const box = { w: W - 2 * M, h: H - top - IN(0.65) };
        const { cx, cy } = fitBox(img.width, img.height, box.w, box.h, PX_EMU);
        shapes.push(picture(id++, `Picture ${i + 1}`, stepTitle, 'rIdImg', { x: (W - cx) / 2, y: top, cx, cy }));
      }
    }
    shapes.push(textShape(id++, 'Footer', { x: M, y: H - IN(0.45), w: IN(8), h: IN(0.3), lines: [footerText], size: 1000, color: COLORS.muted, anchor: 'ctr', lang: textLang, autofit: false }));
    shapes.push(textShape(id++, 'Slide number', { x: W - M - IN(2), y: H - IN(0.45), w: IN(2), h: IN(0.3), lines: [`${i + 1} / ${steps.length}`], size: 1000, color: COLORS.muted, anchor: 'ctr', align: 'r', lang: textLang, autofit: false }));
    slides.push({ xml: slideXml(shapes), rels });
  });

  /* ---- 패키지 ---- */
  const files = [];
  const exts = new Set(media.map((m) => m.name.split('.').pop()));
  const defaults = { rels: CT.rels, xml: CT.xml };
  for (const e of exts) defaults[e] = CT[e];
  const overrides = {
    '/ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    '/ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    '/ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    '/ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
    '/ppt/presProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
    '/ppt/viewProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
    '/ppt/tableStyles.xml': 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
    '/docProps/core.xml': CT.core,
    '/docProps/app.xml': CT.app,
  };
  slides.forEach((_, k) => { overrides[`/ppt/slides/slide${k + 1}.xml`] = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'; });
  files.push({ name: '[Content_Types].xml', data: contentTypesXml(defaults, overrides) });
  files.push({ name: '_rels/.rels', data: relsXml([
    { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
    { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' },
  ]) });
  files.push({ name: 'docProps/core.xml', data: corePropsXml({ title, author, created: session.createdAt || now, modified: now, lang: textLang }) });
  files.push({ name: 'docProps/app.xml', data: appPropsXml(`<PresentationFormat>${lang === 'en' ? 'Widescreen' : '와이드스크린'}</PresentationFormat><Slides>${slides.length}</Slides>`) });

  const presRels = [
    { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: REL.presProps, target: 'presProps.xml' },
    { id: 'rId3', type: REL.viewProps, target: 'viewProps.xml' },
    { id: 'rId4', type: REL.theme, target: 'theme/theme1.xml' },
    { id: 'rId5', type: REL.tableStyles, target: 'tableStyles.xml' },
  ];
  const sldIds = slides.map((_, k) => {
    presRels.push({ id: `rId${10 + k}`, type: REL.slide, target: `slides/slide${k + 1}.xml` });
    return `<p:sldId id="${256 + k}" r:id="rId${10 + k}"/>`;
  });
  files.push({ name: 'ppt/presentation.xml', data: `${XML_HEAD}<p:presentation ${ROOT_NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` });
  files.push({ name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) });
  files.push({ name: 'ppt/presProps.xml', data: `${XML_HEAD}<p:presentationPr ${ROOT_NS}/>` });
  files.push({ name: 'ppt/viewProps.xml', data: `${XML_HEAD}<p:viewPr ${ROOT_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` });
  files.push({ name: 'ppt/tableStyles.xml', data: `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` });
  files.push({ name: 'ppt/theme/theme1.xml', data: themeXml() });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml() });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml([
    { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
  ]) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: layoutXml() });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relsXml([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }]) });
  slides.forEach((sl, k) => {
    files.push({ name: `ppt/slides/slide${k + 1}.xml`, data: sl.xml });
    files.push({ name: `ppt/slides/_rels/slide${k + 1}.xml.rels`, data: relsXml(sl.rels) });
  });
  for (const m of media) files.push(m);
  return files.map((f) => ({ name: f.name, data: typeof f.data === 'string' ? enc.encode(f.data) : f.data }));
}
