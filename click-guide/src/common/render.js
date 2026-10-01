/* 내보내기 렌더링: 스크린샷에 하이라이트/가림을 굽고, HTML·Markdown 문서를 만든다. */
import { escapeHtml, formatDate } from './util.js';

/* ---------------- 이미지 굽기 ---------------- */

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '#ff3b30'));
  if (!m) return `rgba(255,59,48,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    img.src = src;
  });
}

/**
 * 스크린샷 Blob 에 가림 영역과 하이라이트를 그려 dataURL 로 돌려준다.
 * step.nrect / step.redactions 는 0~1 정규화 좌표.
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
    ctx.drawImage(img, 0, 0);

    // 1) 편집기에서 추가한 가림 영역 (녹화 중 가린 곳은 이미 저장 시점에 처리됨)
    const reds = (step.redactions || [])
      .map((r) => ({ x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h }))
      .filter((r) => r.w > 1 && r.h > 1);
    if (reds.length) {
      const bc = document.createElement('canvas');
      bc.width = w; bc.height = h;
      const bctx = bc.getContext('2d');
      bctx.filter = 'blur(16px)';
      bctx.drawImage(img, 0, 0);
      for (const r of reds) ctx.drawImage(bc, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }

    // 2) 하이라이트
    const showHl = (opts.highlight !== undefined ? opts.highlight : settings.highlight) && step.highlight !== false && step.nrect;
    if (showHl) {
      const pad = Math.max(2, Math.round(w * 0.002));
      const x = Math.max(0, step.nrect.x * w - pad);
      const y = Math.max(0, step.nrect.y * h - pad);
      const rw = Math.min(w - x, step.nrect.w * w + pad * 2);
      const rh = Math.min(h - y, step.nrect.h * h + pad * 2);
      const lw = Math.max(2, Math.round((settings.highlightWidth || 3) * (w / 1280)));
      const radius = Math.max(4, lw * 2);
      const color = settings.highlightColor || '#ff3b30';

      if (settings.dimOutside) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        roundRectPath(ctx, x, y, rw, rh, radius);
        ctx.fillStyle = 'rgba(0,0,0,.30)';
        ctx.fill('evenodd');
        ctx.restore();
      }
      ctx.save();
      roundRectPath(ctx, x, y, rw, rh, radius);
      ctx.lineWidth = lw + Math.round(lw * 2.2);
      ctx.strokeStyle = hexToRgba(color, 0.22);
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }

    return {
      dataUrl: canvas.toDataURL('image/jpeg', opts.quality || 0.85),
      width: w, height: h
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
  parts.push(`<p class="sub">${steps.length}단계 · ${formatDate(session.createdAt)}${session.startUrl ? ' · ' + escapeHtml(hostOf(session.startUrl)) : ''}</p>`);
  if (session.description) parts.push(`<p class="desc">${escapeHtml(session.description)}</p>`);
  parts.push('</header><ol class="steps">');

  for (const s of steps) {
    const img = images ? images.get(s.id) : null;
    parts.push(`<li class="step${s.type === 'note' ? ' note' : ''}">`);
    parts.push('<div class="hd"><span class="num"></span>');
    parts.push(`<h2 class="ttl">${escapeHtml(s.title || '')}</h2></div>`);
    parts.push('<div class="body">');
    if (s.description) parts.push(`<p>${escapeHtml(s.description)}</p>`);
    if (opts.showUrls && s.url) parts.push(`<p class="meta">${escapeHtml(s.url)}</p>`);
    parts.push('</div>');
    if (img) parts.push(`<figure><img src="${img}" alt="${escapeHtml(s.title || '단계 이미지')}"></figure>`);
    parts.push('</li>');
  }

  parts.push('</ol>');
  parts.push('<footer class="doc">ClickGuide로 만든 가이드</footer>');
  parts.push('</div></body></html>');
  return parts.join('\n');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

/* ---------------- Markdown ---------------- */

export function buildMarkdown(session, steps, imageNames, opts = {}) {
  const out = [];
  out.push(`# ${session.name || '사용 가이드'}`);
  out.push('');
  out.push(`_${steps.length}단계 · ${formatDate(session.createdAt)}${session.startUrl ? ' · ' + hostOf(session.startUrl) : ''}_`);
  if (session.description) { out.push(''); out.push(session.description); }
  out.push('');
  steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title || ''}`);
    out.push('');
    if (s.description) { out.push(s.description); out.push(''); }
    if (opts.showUrls && s.url) { out.push(`\`${s.url}\``); out.push(''); }
    const name = imageNames ? imageNames.get(s.id) : null;
    if (name) { out.push(`![${(s.title || '단계').replace(/[\[\]]/g, '')}](${name})`); out.push(''); }
  });
  out.push('---');
  out.push('');
  out.push('_ClickGuide로 만든 가이드_');
  return out.join('\n');
}
