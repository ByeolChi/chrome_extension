/* 내보내기 렌더링: 스크린샷에 가림·하이라이트·주석을 굽고, HTML·Markdown 문서를 만든다.
 * 그림은 편집기 미리보기와 같은 코드(annotate.js)로 그린다. */
import { escapeHtml, formatDate, placeName, shareableUrl, localPageTitle } from './util.js';
import { paintStep, cropPixels } from './annotate.js';

/* ---------------- 이미지 굽기 ---------------- */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    img.src = src;
  });
}

/**
 * 스크린샷 Blob 에 가림·하이라이트·주석을 그리고 자르기까지 해서 dataURL 로 돌려준다.
 * step.nrect / redactions / annotations / crop 은 0~1 정규화 좌표. 녹화 중 가린 곳은 저장할 때 이미 칠해져 있다.
 * opts.highlight: 하이라이트를 그릴지 (없으면 설정을 따름. AI 로 보내는 그림은 false)
 */
export async function bakeStepImage(blob, step, settings, opts = {}) {
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const showHl = !!((opts.highlight !== undefined ? opts.highlight : settings.highlight) && step.highlight !== false && step.nrect);
    paintStep(ctx, img, step, settings, { width: w, height: h, highlight: showHl });
    let out = canvas;
    const c = cropPixels(step.crop, w, h);
    if (c) {
      out = document.createElement('canvas');
      out.width = c.w; out.height = c.h;
      out.getContext('2d').drawImage(canvas, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    }
    return {
      dataUrl: out.toDataURL('image/jpeg', opts.quality || 0.85),
      width: out.width, height: out.height
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function dataUrlToUint8(dataUrl) {
  const res = await fetch(dataUrl);
  return new Uint8Array(await res.arrayBuffer());
}

/* ---------------- HTML 문서 ---------------- */

const DOC_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f4f5f7;color:#14161a;
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:840px;margin:0 auto;padding:40px 24px 80px}
header.doc{margin-bottom:28px;padding-bottom:22px;border-bottom:1px solid #e0e2e8}
h1{font-size:28px;line-height:1.3;margin:0 0 8px;letter-spacing:-.02em}
.sub{color:#5c6270;font-size:14px;margin:0}
.desc{margin:14px 0 0;color:#3d424d;white-space:pre-wrap}
ol.steps{list-style:none;margin:0;padding:0;counter-reset:s}
li.step{counter-increment:s;background:#fff;border:1px solid #e3e5ea;border-radius:12px;
  padding:20px 22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,18,24,.05);break-inside:avoid}
.hd{display:flex;gap:12px;align-items:flex-start}
.num{flex:none;width:26px;height:26px;border-radius:50%;background:#2f6df6;color:#fff;
  font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.num::before{content:counter(s)}
.ttl{font-size:16px;font-weight:650;margin:0;letter-spacing:-.01em}
.body{margin:6px 0 0 38px}
.body p{margin:0;color:#3d424d}
.meta{margin:8px 0 0;font-size:12px;color:#8a909c;word-break:break-all}
figure{margin:14px 0 0 38px}
figure img{width:100%;height:auto;display:block;border:1px solid #e3e5ea;border-radius:8px}
.note{background:#fffbea;border-color:#f0e2b0}
footer.doc{margin-top:28px;color:#8a909c;font-size:12px;text-align:center}
@media print{
  body{background:#fff}
  .page{max-width:none;padding:0}
  li.step{box-shadow:none;border-color:#d8dbe2;page-break-inside:avoid}
  @page{margin:14mm}
}
@media (max-width:560px){ .page{padding:24px 14px 60px} .body,figure{margin-left:0} }
`;

/**
 * 완전 독립 실행 HTML 문자열을 만든다 (이미지 base64 내장, 스크립트 없음).
 * images: Map<stepId, dataUrl>
 */
export function buildGuideHtml(session, steps, images, opts = {}) {
  const title = session.name || '사용 가이드';
  const parts = [];
  parts.push('<!doctype html>');
  parts.push(`<html lang="${session.lang === 'en' ? 'en' : 'ko'}"><head><meta charset="utf-8">`);
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push(`<title>${escapeHtml(title)}</title><style>${DOC_CSS}</style></head><body><div class="page">`);
  parts.push('<header class="doc">');
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  parts.push(`<p class="sub">${steps.length}단계 · ${formatDate(session.createdAt)}${hostOf(session.startUrl) ? ' · ' + escapeHtml(hostOf(session.startUrl)) : ''}</p>`);
  if (session.description) parts.push(`<p class="desc">${escapeHtml(session.description)}</p>`);
  parts.push('</header><ol class="steps">');

  for (const s of steps) {
    const img = images ? images.get(s.id) : null;
    parts.push(`<li class="step${s.type === 'note' ? ' note' : ''}">`);
    parts.push('<div class="hd"><span class="num"></span>');
    parts.push(`<h2 class="ttl">${escapeHtml(s.title || '')}</h2></div>`);
    parts.push('<div class="body">');
    if (s.description) parts.push(`<p>${escapeHtml(s.description)}</p>`);
    if (opts.showUrls && s.url) parts.push(`<p class="meta">${escapeHtml(shareableUrl(s.url))}</p>`);
    parts.push('</div>');
    if (img) parts.push(`<figure><img src="${img}" alt="${escapeHtml(s.title || '단계 이미지')}"></figure>`);
    parts.push('</li>');
  }

  parts.push('</ol>');
  parts.push('<footer class="doc">ClickGuide로 만든 가이드</footer>');
  parts.push('</div></body></html>');
  return parts.join('\n');
}

// 머리말에는 사이트 이름만 (로컬 파일은 파일 이름만)
const hostOf = placeName;

/* ---------------- Markdown ---------------- */

/* 단계 제목·설명에는 웹페이지에서 읽은 글자(버튼 이름 등)가 들어간다.
 * HTML 내보내기처럼 글자 그대로 보이도록, HTML 태그와 Markdown 문법(링크·강조·코드)을 무력화한다. */
export function mdInline(s) {
  return String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/[\\`*_[\]]/g, '\\$&')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 여러 줄 글: 줄마다 이스케이프하고, 줄 맨 앞의 제목·목록·구분선 문법도 글자로 남긴다
export function mdBlock(s) {
  return String(s == null ? '' : s).split(/\r?\n/).map((line) => {
    let l = mdInline(line);
    l = l.replace(/^(\s*)(#|[+-](?=\s|$)|-+\s*$|=+\s*$)/, '$1\\$2');   // # 제목, - / + 목록, ---·=== 구분선과 밑줄
    l = l.replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');          // 1. 번호 목록
    return l;
  }).join('\n');
}

export function buildMarkdown(session, steps, imageNames, opts = {}) {
  const out = [];
  out.push(`# ${mdInline(session.name || '사용 가이드')}`);
  out.push('');
  out.push(`_${steps.length}단계 · ${formatDate(session.createdAt)}${hostOf(session.startUrl) ? ' · ' + mdInline(hostOf(session.startUrl)) : ''}_`);
  if (session.description) { out.push(''); out.push(mdBlock(session.description)); }
  out.push('');
  steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${mdInline(s.title || '')}`);
    out.push('');
    if (s.description) { out.push(mdBlock(s.description)); out.push(''); }
    if (opts.showUrls && s.url) { out.push(mdInline(shareableUrl(s.url))); out.push(''); }
    const name = imageNames ? imageNames.get(s.id) : null;
    if (name) { out.push(`![${mdInline((s.title || '단계').replace(/[\[\]]/g, ''))}](${name})`); out.push(''); }
  });
  out.push('---');
  out.push('');
  out.push('_ClickGuide로 만든 가이드_');
  return out.join('\n');
}

/* ---------------- JSON ---------------- */

/* 데이터로 쓰는 내보내기라 주소를 그대로 넣는다. 단 로컬 파일(file://) 주소는 폴더 경로(사용자 이름이 들어 있음)를
 * 지우고 파일 이름만 남긴다. 링크 요소의 href 도 같다. images: Map<stepId, dataUrl> */
export function buildJsonExport(session, steps, images) {
  const el = (e) => (e && typeof e.href === 'string' && e.href ? { ...e, href: shareableUrl(e.href) } : e);
  return {
    format: 'clickguide/v1',
    exportedAt: new Date().toISOString(),
    guide: {
      id: session.id, name: session.name, description: session.description,
      createdAt: session.createdAt, startUrl: shareableUrl(session.startUrl), lang: session.lang
    },
    steps: steps.map((s, i) => ({
      number: i + 1, type: s.type, title: s.title, description: s.description,
      url: shareableUrl(s.url), pageTitle: s.pageTitle ? localPageTitle(s.pageTitle, s.url || '') : s.pageTitle, element: el(s.el),
      value: s.value, masked: s.masked, highlightRect: s.nrect, redactions: s.redactions,
      annotations: s.annotations || [], crop: s.crop || null,
      image: (images && images.get(s.id)) || null
    }))
  };
}
