/* 단계 이미지에 그리는 모든 것 — 편집기 미리보기와 내보내기가 같은 코드를 쓴다.
 * - 좌표는 모두 원본 스크린샷 기준 0~1
 * - 그리는 순서: 원본 → 가림(redactions) → 하이라이트(nrect) → 주석(annotations)
 * - 자르기(crop)는 내보낼 때 마지막에 잘라 낸다. 편집기에서는 바깥을 어둡게 보여 준다
 * - 확대(zoom)는 가림까지 칠한 화면을 확대한다 (가린 곳이 확대로 드러나지 않게)
 * 주석 { id, type, color, ... }
 *   arrow: x1,y1 → x2,y2 (끝에 화살촉)      rect: x,y,w,h (테두리)
 *   text:  x,y (왼쪽 위), text              badge: x,y (가운데), n (번호)
 *   zoom:  sx,sy,sw,sh (확대할 곳) → x,y,w,h (보여 줄 곳)
 */
import '../shared/redact-core.js';   // 공용 가리기 코어 → globalThis.RedactCore

const RC = globalThis.RedactCore;

export const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#111111', '#ffffff'];
export const ANNOTATION_TYPES = ['arrow', 'rect', 'text', 'badge', 'zoom'];

export const lineWidthOf = (w) => Math.max(3, Math.round(w / 320));
export const fontSizeOf = (w) => Math.max(14, Math.round(w / 56));
export const badgeRadiusOf = (w) => Math.max(12, Math.round(w / 80));
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

const num01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const HEX = /^#[0-9a-f]{6}$/i;

function isLight(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}
// 어떤 배경에서도 보이게 둘레에 두르는 색
const haloOf = (color) => (isLight(color) ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.92)');

function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '#ff3b30'));
  if (!m) return `rgba(255,59,48,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ---------------- 데이터 정리 (저장본·백업에서 읽을 때) ---------------- */

export function normalizeAnnotation(a) {
  if (!a || typeof a !== 'object' || !ANNOTATION_TYPES.includes(a.type)) return null;
  const color = HEX.test(a.color || '') ? a.color : PALETTE[0];
  const id = typeof a.id === 'string' && a.id ? a.id : 'ann' + Math.random().toString(36).slice(2, 10);
  switch (a.type) {
    case 'arrow':
      return { id, type: 'arrow', color, x1: num01(a.x1), y1: num01(a.y1), x2: num01(a.x2), y2: num01(a.y2) };
    case 'rect':
      return { id, type: 'rect', color, ...box01(a) };
    case 'text': {
      const text = String(a.text ?? '').slice(0, 500);
      return text.trim() ? { id, type: 'text', color, x: num01(a.x), y: num01(a.y), text } : null;
    }
    case 'badge':
      return { id, type: 'badge', color, x: num01(a.x), y: num01(a.y), n: Math.max(1, Math.min(999, Math.round(Number(a.n) || 1))) };
    case 'zoom': {
      const src = box01({ x: a.sx, y: a.sy, w: a.sw, h: a.sh });
      return { id, type: 'zoom', color, sx: src.x, sy: src.y, sw: src.w, sh: src.h, ...box01(a) };
    }
    default:
      return null;
  }
}

function box01(r) {
  const x = num01(r.x);
  const y = num01(r.y);
  return { x, y, w: Math.max(0.001, Math.min(1 - x, Number(r.w) || 0)), h: Math.max(0.001, Math.min(1 - y, Number(r.h) || 0)) };
}

export function normalizeAnnotations(list) {
  return (Array.isArray(list) ? list : []).map(normalizeAnnotation).filter(Boolean).slice(0, 200);
}

/** 자르기 영역 (너무 작으면 자르지 않음) */
export function normalizeCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const b = box01(c);
  return b.w >= 0.02 && b.h >= 0.02 ? b : null;
}

export function cropPixels(crop, w, h) {
  const c = normalizeCrop(crop);
  if (!c) return null;
  const x = Math.max(0, Math.floor(c.x * w));
  const y = Math.max(0, Math.floor(c.y * h));
  const x2 = Math.min(w, Math.ceil((c.x + c.w) * w));
  const y2 = Math.min(h, Math.ceil((c.y + c.h) * h));
  return x2 - x >= 2 && y2 - y >= 2 ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/* ---------------- 하이라이트 (녹화 때 클릭한 곳) ---------------- */

export function drawHighlight(ctx, nrect, w, h, settings) {
  const pad = Math.max(2, Math.round(w * 0.002));
  const x = Math.max(0, nrect.x * w - pad);
  const y = Math.max(0, nrect.y * h - pad);
  const rw = Math.min(w - x, nrect.w * w + pad * 2);
  const rh = Math.min(h - y, nrect.h * h + pad * 2);
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

/* ---------------- 주석 ---------------- */

/** 글상자의 자리와 크기 (이미지 픽셀). 그리기와 편집기의 고르기가 같이 쓴다 */
export function textBox(ctx, a, w, h) {
  const size = fontSizeOf(w);
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}`;
  const lines = String(a.text || '').split('\n').slice(0, 20);
  const width = Math.max(size, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const pad = Math.round(size * 0.45);
  const lh = Math.round(size * 1.3);
  return { x: a.x * w, y: a.y * h, w: width + pad * 2, h: (lines.length - 1) * lh + size + pad * 2, lines, size, pad, lh };
}

function drawArrow(ctx, a, w, h) {
  const lw = lineWidthOf(w);
  const x1 = a.x1 * w;
  const y1 = a.y1 * h;
  const x2 = a.x2 * w;
  const y2 = a.y2 * h;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = lw * 4.2;
  const bx = x2 - Math.cos(ang) * head * 0.75;
  const by = y2 - Math.sin(ang) * head * 0.75;
  const shaft = () => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
  };
  const tip = () => {
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
    ctx.closePath();
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = haloOf(a.color);
  ctx.lineWidth = lw + Math.max(2, Math.round(lw * 0.8));
  shaft();
  ctx.stroke();
  tip();
  ctx.stroke();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = lw;
  shaft();
  ctx.stroke();
  tip();
  ctx.fill();
  ctx.restore();
}

function drawRect(ctx, a, w, h) {
  const lw = lineWidthOf(w);
  ctx.save();
  roundRectPath(ctx, a.x * w, a.y * h, a.w * w, a.h * h, lw * 1.5);
  ctx.lineWidth = lw + Math.max(2, Math.round(lw * 0.8));
  ctx.strokeStyle = haloOf(a.color);
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = a.color;
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, a, w, h) {
  const b = textBox(ctx, a, w, h);
  ctx.save();
  ctx.font = `600 ${b.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = Math.round(b.size * 0.4);
  ctx.shadowOffsetY = Math.round(b.size * 0.08);
  roundRectPath(ctx, b.x, b.y, b.w, b.h, b.size * 0.35);
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = isLight(a.color) ? '#111111' : '#ffffff';
  b.lines.forEach((line, i) => ctx.fillText(line, b.x + b.pad, b.y + b.pad + i * b.lh));
  ctx.restore();
}

function drawBadge(ctx, a, w, h) {
  const r = badgeRadiusOf(w);
  const cx = a.x * w;
  const cy = a.y * h;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = a.color;
  ctx.shadowColor = 'rgba(0,0,0,.3)';
  ctx.shadowBlur = r * 0.4;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.strokeStyle = haloOf(a.color);
  ctx.stroke();
  ctx.fillStyle = isLight(a.color) ? '#111111' : '#ffffff';
  ctx.font = `700 ${Math.round(r * (String(a.n).length > 2 ? 0.8 : 1.05))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(a.n), cx, cy + r * 0.04);
  ctx.restore();
}

function drawZoom(ctx, a, w, h, base) {
  const lw = Math.max(2, lineWidthOf(w) - 1);
  const s = { x: a.sx * w, y: a.sy * h, w: a.sw * w, h: a.sh * h };
  const t = { x: a.x * w, y: a.y * h, w: a.w * w, h: a.h * h };
  ctx.save();
  // 확대할 곳 표시와 이어 주는 선
  ctx.strokeStyle = a.color;
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 2.5, lw * 1.5]);
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  const tc = { x: Math.max(t.x, Math.min(t.x + t.w, sc.x)), y: Math.max(t.y, Math.min(t.y + t.h, sc.y)) };
  ctx.beginPath();
  ctx.moveTo(Math.max(s.x, Math.min(s.x + s.w, tc.x)), Math.max(s.y, Math.min(s.y + s.h, tc.y)));
  ctx.lineTo(tc.x, tc.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // 확대한 그림
  if (base && s.w >= 1 && s.h >= 1) {
    ctx.save();
    roundRectPath(ctx, t.x, t.y, t.w, t.h, lw * 2);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, s.x, s.y, s.w, s.h, t.x, t.y, t.w, t.h);
    ctx.restore();
  }
  roundRectPath(ctx, t.x, t.y, t.w, t.h, lw * 2);
  ctx.lineWidth = lw + 2;
  ctx.strokeStyle = haloOf(a.color);
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = a.color;
  ctx.stroke();
  ctx.restore();
}

export function drawAnnotation(ctx, a, w, h, base) {
  if (a.type === 'arrow') drawArrow(ctx, a, w, h);
  else if (a.type === 'rect') drawRect(ctx, a, w, h);
  else if (a.type === 'text') drawText(ctx, a, w, h);
  else if (a.type === 'badge') drawBadge(ctx, a, w, h);
  else if (a.type === 'zoom') drawZoom(ctx, a, w, h, base);
}

/**
 * 원본 이미지 위에 가림·하이라이트·주석을 그린다 (자르기 전, 원본 크기 기준 좌표계).
 * 편집기는 ctx 를 줄여 놓고(setTransform) 같은 함수를 부른다.
 * opts: { width, height (원본 크기), highlight (하이라이트를 그릴지, 부르는 쪽이 설정까지 따져 정함) }
 */
export function paintStep(ctx, img, step, settings, { width, height, highlight = false } = {}) {
  const w = width;
  const h = height;
  ctx.drawImage(img, 0, 0, w, h);
  const reds = RC.toPixelRects(step.redactions || [], w, h, w, h);
  const style = settings && settings.redactStyle === 'blur' ? 'blur' : 'box';
  RC.paintRedactions(ctx, reds, { style, source: img, width: w, height: h, blurPx: 16 });
  if (highlight && step.highlight !== false && step.nrect) drawHighlight(ctx, step.nrect, w, h, settings || {});
  const anns = step.annotations || [];
  if (!anns.length) return;
  let base = null;
  if (anns.some((a) => a.type === 'zoom')) {
    // 확대할 바탕: 가림까지 칠한 원본 (하이라이트·다른 주석은 빼고)
    base = new OffscreenCanvas(w, h);
    const b = base.getContext('2d');
    b.drawImage(img, 0, 0, w, h);
    RC.paintRedactions(b, reds, { style, source: img, width: w, height: h, blurPx: 16 });
  }
  for (const a of anns) drawAnnotation(ctx, a, w, h, base);
}
