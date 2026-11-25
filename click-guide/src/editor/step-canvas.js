/* 편집기의 단계 그림: 내보내기와 같은 코드(annotate.js)로 그리고, 그 위에서 주석을 그리고 고친다.
 * 도구: 선택(옮기기·크기 바꾸기·지우기) · 화살표 · 박스 · 텍스트 · 번호 · 확대 · 가리기 · 자르기
 * 녹화 때의 하이라이트(nrect)와 가린 곳도 선택 도구로 옮기고 크기를 바꿀 수 있다.
 * 바뀐 것은 onCommit(before, after, label) 으로 알린다 (편집기가 저장하고 되돌리기 목록에 넣음). */
import { paintStep, PALETTE, textBox, badgeRadiusOf, normalizeCrop } from '../common/annotate.js';

export const TOOLS = [
  ['select', '선택'], ['arrow', '화살표'], ['rect', '박스'], ['text', '텍스트'],
  ['badge', '번호'], ['zoom', '확대'], ['redact', '가리기'], ['crop', '자르기'],
];

const HANDLE = 6;     // 손잡이 반쪽 크기 (화면 px)
const MIN = 0.008;    // 가장 작은 박스 (0~1)

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const newId = () => 'ann' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 그림에 관한 값만 모은 사본 (되돌리기용) */
export function visualState(step) {
  return clone({
    annotations: step.annotations || [], redactions: step.redactions || [], nrect: step.nrect || null,
    highlight: step.highlight !== false, crop: step.crop || null,
  });
}

export function applyVisual(step, v) {
  step.annotations = clone(v.annotations);
  step.redactions = clone(v.redactions);
  step.nrect = clone(v.nrect);
  step.highlight = v.highlight;
  step.crop = clone(v.crop);
}

function boxFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function inBox(p, r, tx = 0, ty = 0) {
  return !!r && p.x >= r.x - tx && p.x <= r.x + r.w + tx && p.y >= r.y - ty && p.y <= r.y + r.h + ty;
}

// 테두리 근처인지 (안쪽이 비어 보이는 박스·확대 원본은 먼저 테두리로만 고른다)
function onEdge(p, r, tx, ty) {
  return inBox(p, r, tx, ty) && !(p.x > r.x + tx && p.x < r.x + r.w - tx && p.y > r.y + ty && p.y < r.y + r.h - ty);
}

export class StepCanvas {
  constructor(host, step, { settings, onCommit, onSelect }) {
    this.host = host;
    this.step = step;
    this.settings = settings;
    this.onCommit = onCommit;
    this.onSelect = onSelect || (() => {});
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'shot-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '단계 그림');
    host.append(this.canvas);
    this.img = null;
    this.editing = false;
    this.tool = 'select';
    this.color = PALETTE[0];
    this.sel = null;
    this.drag = null;
    this.textEdit = null;
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', (e) => this.up(e));
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('keydown', (e) => this.key(e));
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(host);
  }

  destroy() {
    this.ro.disconnect();
    this.closeText(false);
  }

  async load(blob) {
    const url = URL.createObjectURL(blob);
    try {
      this.img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
        i.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    this.W = this.img.naturalWidth;
    this.H = this.img.naturalHeight;
    this.render();
  }

  setEditing(on) {
    this.editing = on;
    if (!on) {
      this.closeText(true);
      this.sel = null;
      this.tool = 'select';
    }
    this.canvas.classList.toggle('editing', on);
    this.updateCursor(null);
    this.render();
  }

  setTool(t) {
    this.closeText(true);
    this.tool = t;
    if (t !== 'select') this.sel = null;
    if (t === 'crop' && normalizeCrop(this.step.crop)) this.sel = { kind: 'crop' };
    this.onSelect(this.sel);
    this.updateCursor(null);
    this.render();
  }

  // 색을 바꾸면 고른 주석의 색도 바꾼다
  setColor(c) {
    this.color = c;
    const a = this.selectedAnn();
    if (a && a.color !== c) {
      const before = visualState(this.step);
      a.color = c;
      this.commitFrom(before, '색 바꾸기');
    }
  }

  selectedAnn() {
    return this.sel && this.sel.kind === 'ann' ? (this.step.annotations || []).find((a) => a.id === this.sel.id) || null : null;
  }

  /* ---------------- 그리기 ---------------- */

  render() {
    if (!this.img) return;
    const c = this.canvas;
    const cssW = this.host.clientWidth || this.W;
    const cssH = Math.max(1, Math.round((cssW * this.H) / this.W));
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const k = pw / this.W;
    this.k = k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const s = this.settings;
    const hl = !!(s.highlight && this.step.highlight !== false && this.step.nrect);
    paintStep(ctx, this.img, this.step, s, { width: this.W, height: this.H, highlight: hl });
    const W = this.W;
    const H = this.H;
    // 자르기: 바깥을 어둡게
    const crop = normalizeCrop(this.step.crop);
    if (crop) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(crop.x * W, crop.y * H, crop.w * W, crop.h * H);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fill('evenodd');
      ctx.setLineDash([6 / k, 4 / k]);
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(crop.x * W, crop.y * H, crop.w * W, crop.h * H);
      ctx.restore();
    }
    // 확대할 곳을 고르는 중
    if (this.drag && this.drag.mode === 'create-zoom' && this.drag.box) {
      const b = this.drag.box;
      ctx.save();
      ctx.setLineDash([6 / k, 4 / k]);
      ctx.lineWidth = 2 / k;
      ctx.strokeStyle = this.color;
      ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
      ctx.restore();
    }
    if (this.editing && this.sel) this.drawSelection(ctx, k);
  }

  // 고른 것의 테두리와 손잡이
  drawSelection(ctx, k) {
    const W = this.W;
    const H = this.H;
    const handles = this.handles();
    const box = this.selBox();
    ctx.save();
    if (box) {
      ctx.setLineDash([5 / k, 3 / k]);
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = '#2f6df6';
      ctx.strokeRect(box.x * W, box.y * H, box.w * W, box.h * H);
      ctx.setLineDash([]);
    }
    const r = (HANDLE * (window.devicePixelRatio || 1)) / k;
    for (const hd of handles) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2f6df6';
      ctx.lineWidth = 1.5 / k;
      ctx.fillRect(hd.x * W - r, hd.y * H - r, r * 2, r * 2);
      ctx.strokeRect(hd.x * W - r, hd.y * H - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /* ---------------- 고르기 ---------------- */

  pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  // 화면 px 를 0~1 로
  tol(px = 8) {
    const r = this.canvas.getBoundingClientRect();
    return { x: px / Math.max(1, r.width), y: px / Math.max(1, r.height) };
  }

  textRect(a) {
    const b = textBox(this.canvas.getContext('2d'), a, this.W, this.H);
    return { x: b.x / this.W, y: b.y / this.H, w: b.w / this.W, h: b.h / this.H };
  }

  badgeRect(a) {
    const r = badgeRadiusOf(this.W);
    return { x: a.x - r / this.W, y: a.y - r / this.H, w: (2 * r) / this.W, h: (2 * r) / this.H };
  }

  annBox(a) {
    if (a.type === 'arrow') return boxFrom({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 });
    if (a.type === 'text') return this.textRect(a);
    if (a.type === 'badge') return this.badgeRect(a);
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }

  // inner=false: 눈에 보이는 부분(화살표 선·번호·글자·확대 그림·박스와 확대 원본의 테두리), inner=true: 박스·확대 원본의 안쪽
  hitAnn(a, p, inner = false) {
    const t = this.tol();
    if (a.type === 'zoom') {
      const src = { x: a.sx, y: a.sy, w: a.sw, h: a.sh };
      if (inner) return inBox(p, src);
      return inBox(p, { x: a.x, y: a.y, w: a.w, h: a.h }, t.x, t.y) || onEdge(p, src, t.x / 2, t.y / 2);
    }
    if (a.type === 'rect') {
      const b = { x: a.x, y: a.y, w: a.w, h: a.h };
      return inner ? inBox(p, b) : onEdge(p, b, t.x / 2, t.y / 2);
    }
    if (inner) return false;
    if (a.type === 'arrow') {
      // 선까지의 거리 (화면 px)
      const r = this.canvas.getBoundingClientRect();
      const ax = a.x1 * r.width;
      const ay = a.y1 * r.height;
      const bx = a.x2 * r.width;
      const by = a.y2 * r.height;
      const px = p.x * r.width;
      const py = p.y * r.height;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const u = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
      return Math.hypot(px - (ax + u * (bx - ax)), py - (ay + u * (by - ay))) <= 9;
    }
    return inBox(p, this.annBox(a), t.x / 2, t.y / 2);
  }

  // 고르는 차례: 눈에 보이는 주석 → 가림 → 하이라이트 → 박스·확대 원본의 안쪽
  // (박스 안의 번호·가림을 누르면 박스가 아니라 그것이 골라지게)
  hit(p) {
    const anns = this.step.annotations || [];
    for (let i = anns.length - 1; i >= 0; i--) if (this.hitAnn(anns[i], p)) return { kind: 'ann', id: anns[i].id };
    const reds = this.step.redactions || [];
    for (let i = reds.length - 1; i >= 0; i--) if (inBox(p, reds[i])) return { kind: 'redact', index: i };
    if (this.step.nrect && this.step.highlight !== false && this.settings.highlight && inBox(p, this.step.nrect)) return { kind: 'hl' };
    for (let i = anns.length - 1; i >= 0; i--) if (this.hitAnn(anns[i], p, true)) return { kind: 'ann', id: anns[i].id };
    return null;
  }

  // 고른 것 (주석·가림·하이라이트·자르기)의 실제 객체
  selObj() {
    const s = this.sel;
    if (!s) return null;
    if (s.kind === 'ann') return this.selectedAnn();
    if (s.kind === 'redact') return (this.step.redactions || [])[s.index] || null;
    if (s.kind === 'hl') return this.step.nrect || null;
    if (s.kind === 'crop') return this.step.crop || null;
    return null;
  }

  selBox() {
    const o = this.selObj();
    if (!o) return null;
    if (this.sel.kind === 'ann') {
      if (o.type === 'zoom') return { x: o.x, y: o.y, w: o.w, h: o.h };
      return this.annBox(o);
    }
    return o;
  }

  // 크기를 바꿀 수 있는 손잡이
  handles() {
    const o = this.selObj();
    if (!o) return [];
    if (this.sel.kind === 'ann' && o.type === 'arrow') return [{ name: 'p1', x: o.x1, y: o.y1 }, { name: 'p2', x: o.x2, y: o.y2 }];
    if (this.sel.kind === 'ann' && (o.type === 'text' || o.type === 'badge')) return [];
    const b = this.sel.kind === 'ann' && o.type === 'zoom' ? { x: o.x, y: o.y, w: o.w, h: o.h } : o;
    return [
      { name: 'nw', x: b.x, y: b.y }, { name: 'ne', x: b.x + b.w, y: b.y },
      { name: 'sw', x: b.x, y: b.y + b.h }, { name: 'se', x: b.x + b.w, y: b.y + b.h },
    ];
  }

  handleAt(p) {
    const t = this.tol(HANDLE + 4);
    return this.handles().find((hd) => Math.abs(hd.x - p.x) <= t.x && Math.abs(hd.y - p.y) <= t.y) || null;
  }

  updateCursor(p) {
    const c = this.canvas;
    if (!this.editing) {
      c.style.cursor = '';
      return;
    }
    if (this.tool !== 'select' && this.tool !== 'crop') {
      c.style.cursor = this.tool === 'text' ? 'text' : 'crosshair';
      return;
    }
    if (!p) {
      c.style.cursor = this.tool === 'crop' ? 'crosshair' : 'default';
      return;
    }
    const hd = this.sel && this.handleAt(p);
    if (hd) c.style.cursor = hd.name === 'nw' || hd.name === 'se' ? 'nwse-resize' : hd.name === 'ne' || hd.name === 'sw' ? 'nesw-resize' : 'move';
    else if (this.tool === 'crop') c.style.cursor = inBox(p, normalizeCrop(this.step.crop)) ? 'move' : 'crosshair';
    else c.style.cursor = this.hit(p) ? 'move' : 'default';
  }

  /* ---------------- 마우스 ---------------- */

  down(e) {
    if (!this.editing || !this.img || e.button !== 0) return;
    if (this.textEdit) this.closeText(true);
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const p = this.pt(e);
    this.before = visualState(this.step);
    const t = this.tool;
    const capture = () => {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (_) {
        /* 이미 끝난 포인터 등: 붙잡지 못해도 그리기는 이어 간다 */
      }
    };
    // 고른 것의 손잡이 · 옮기기
    if (t === 'select' || t === 'crop') {
      const hd = this.sel && this.handleAt(p);
      if (hd) {
        this.drag = { mode: 'resize', handle: hd.name, start: p, orig: clone(this.selObj()) };
        capture();
        return;
      }
      if (t === 'select') {
        this.sel = this.hit(p);
        this.onSelect(this.sel);
        if (this.sel) {
          const o = this.selObj();
          const tl = this.tol();
          const part = this.sel.kind === 'ann' && o.type === 'zoom' && !inBox(p, { x: o.x, y: o.y, w: o.w, h: o.h }, tl.x, tl.y) ? 'source' : 'body';
          this.drag = { mode: 'move', start: p, orig: clone(o), part };
          capture();
        }
        this.render();
        return;
      }
      if (inBox(p, normalizeCrop(this.step.crop))) {
        this.sel = { kind: 'crop' };
        this.drag = { mode: 'move', start: p, orig: clone(this.step.crop), part: 'body' };
        capture();
        return;
      }
    }
    // 새로 그리기
    if (t === 'text') {
      this.openText(p, null);
      return;
    }
    if (t === 'badge') {
      const n = 1 + Math.max(0, ...(this.step.annotations || []).filter((a) => a.type === 'badge').map((a) => a.n || 0));
      const a = { id: newId(), type: 'badge', color: this.color, x: p.x, y: p.y, n };
      (this.step.annotations = this.step.annotations || []).push(a);
      this.sel = { kind: 'ann', id: a.id };
      this.commitFrom(this.before, '번호 넣기');
      return;
    }
    if (t === 'arrow') {
      const a = { id: newId(), type: 'arrow', color: this.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      (this.step.annotations = this.step.annotations || []).push(a);
      this.drag = { mode: 'create-arrow', ann: a };
    } else if (t === 'rect') {
      const a = { id: newId(), type: 'rect', color: this.color, x: p.x, y: p.y, w: 0, h: 0 };
      (this.step.annotations = this.step.annotations || []).push(a);
      this.drag = { mode: 'create-box', obj: a, anchor: p };
    } else if (t === 'redact') {
      const r = { x: p.x, y: p.y, w: 0, h: 0 };
      (this.step.redactions = this.step.redactions || []).push(r);
      this.drag = { mode: 'create-box', obj: r, anchor: p };
    } else if (t === 'crop') {
      this.step.crop = { x: p.x, y: p.y, w: 0, h: 0 };
      this.drag = { mode: 'create-box', obj: this.step.crop, anchor: p };
    } else if (t === 'zoom') {
      this.drag = { mode: 'create-zoom', anchor: p, box: { x: p.x, y: p.y, w: 0, h: 0 } };
    }
    capture();
    this.render();
  }

  move(e) {
    const p = this.pt(e);
    if (!this.drag) {
      this.updateCursor(p);
      return;
    }
    const d = this.drag;
    if (d.mode === 'create-arrow') {
      d.ann.x2 = p.x;
      d.ann.y2 = p.y;
    } else if (d.mode === 'create-box') {
      Object.assign(d.obj, boxFrom(d.anchor, p));
    } else if (d.mode === 'create-zoom') {
      d.box = boxFrom(d.anchor, p);
    } else if (d.mode === 'move') {
      this.moveSel(d, p.x - d.start.x, p.y - d.start.y);
    } else if (d.mode === 'resize') {
      this.resizeSel(d, p);
    }
    this.render();
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* 이미 풀림 */
    }
    const anns = this.step.annotations || [];
    if (d.mode === 'create-arrow') {
      const a = d.ann;
      if (Math.hypot((a.x2 - a.x1) * this.W, (a.y2 - a.y1) * this.H) < 8) anns.splice(anns.indexOf(a), 1);
      else this.sel = { kind: 'ann', id: a.id };
      return this.commitFrom(this.before, '화살표 그리기');
    }
    if (d.mode === 'create-box') {
      const small = d.obj.w < MIN || d.obj.h < MIN;
      if (this.tool === 'rect') {
        if (small) anns.splice(anns.indexOf(d.obj), 1);
        else this.sel = { kind: 'ann', id: d.obj.id };
        return this.commitFrom(this.before, '박스 그리기');
      }
      if (this.tool === 'redact') {
        const reds = this.step.redactions;
        if (small) reds.splice(reds.indexOf(d.obj), 1);
        return this.commitFrom(this.before, '가리기');
      }
      if (this.tool === 'crop') {
        if (small) this.step.crop = this.before.crop;
        this.sel = normalizeCrop(this.step.crop) ? { kind: 'crop' } : null;
        return this.commitFrom(this.before, '자르기');
      }
    }
    if (d.mode === 'create-zoom') {
      const b = d.box;
      if (b.w >= MIN * 2 && b.h >= MIN * 2) {
        const a = { id: newId(), type: 'zoom', color: this.color, sx: b.x, sy: b.y, sw: b.w, sh: b.h, ...this.placeZoom(b) };
        anns.push(a);
        this.sel = { kind: 'ann', id: a.id };
      }
      return this.commitFrom(this.before, '확대 넣기');
    }
    this.commitFrom(this.before, d.mode === 'resize' ? '크기 바꾸기' : '옮기기');
  }

  // 확대한 그림을 둘 곳: 고른 곳의 2배(넓이의 45%까지)로, 오른쪽 → 왼쪽 → 아래 → 위 중 들어가는 곳
  placeZoom(src) {
    let f = Math.min(2, 0.45 / Math.max(src.w, 0.001), 0.6 / Math.max(src.h, 0.001));
    f = Math.max(1.2, f);
    const w = Math.min(0.95, src.w * f);
    const h = Math.min(0.95, src.h * f);
    const gap = 0.025;
    const fitY = clamp01(Math.min(src.y, 1 - h));
    const fitX = clamp01(Math.min(src.x, 1 - w));
    if (src.x + src.w + gap + w <= 1) return { x: src.x + src.w + gap, y: fitY, w, h };
    if (src.x - gap - w >= 0) return { x: src.x - gap - w, y: fitY, w, h };
    if (src.y + src.h + gap + h <= 1) return { x: fitX, y: src.y + src.h + gap, w, h };
    if (src.y - gap - h >= 0) return { x: fitX, y: src.y - gap - h, w, h };
    return { x: clamp01(1 - w), y: clamp01(1 - h), w, h };
  }

  moveSel(d, dx, dy) {
    const o = this.selObj();
    const g = d.orig;
    if (!o || !g) return;
    const shiftBox = (keyX, keyY, keyW, keyH) => {
      o[keyX] = clamp01(Math.min(g[keyX] + dx, 1 - g[keyW]));
      o[keyY] = clamp01(Math.min(g[keyY] + dy, 1 - g[keyH]));
    };
    if (this.sel.kind === 'ann') {
      if (o.type === 'arrow') {
        const mdx = Math.max(-Math.min(g.x1, g.x2), Math.min(1 - Math.max(g.x1, g.x2), dx));
        const mdy = Math.max(-Math.min(g.y1, g.y2), Math.min(1 - Math.max(g.y1, g.y2), dy));
        Object.assign(o, { x1: g.x1 + mdx, y1: g.y1 + mdy, x2: g.x2 + mdx, y2: g.y2 + mdy });
      } else if (o.type === 'text' || o.type === 'badge') {
        o.x = clamp01(g.x + dx);
        o.y = clamp01(g.y + dy);
      } else if (o.type === 'zoom' && d.part === 'source') shiftBox('sx', 'sy', 'sw', 'sh');
      else shiftBox('x', 'y', 'w', 'h');
      return;
    }
    shiftBox('x', 'y', 'w', 'h');
  }

  resizeSel(d, p) {
    const o = this.selObj();
    const g = d.orig;
    if (!o || !g) return;
    if (this.sel.kind === 'ann' && o.type === 'arrow') {
      if (d.handle === 'p1') Object.assign(o, { x1: p.x, y1: p.y });
      else Object.assign(o, { x2: p.x, y2: p.y });
      return;
    }
    // 반대쪽 꼭짓점을 고정하고 끄는 꼭짓점을 따라간다
    const fixed = {
      nw: { x: g.x + g.w, y: g.y + g.h }, ne: { x: g.x, y: g.y + g.h },
      sw: { x: g.x + g.w, y: g.y }, se: { x: g.x, y: g.y },
    }[d.handle];
    const b = boxFrom(fixed, p);
    o.x = b.x;
    o.y = b.y;
    o.w = Math.max(MIN, b.w);
    o.h = Math.max(MIN, b.h);
  }

  dbl(e) {
    if (!this.editing || (this.tool !== 'select' && this.tool !== 'text')) return;
    const p = this.pt(e);
    const hit = this.hit(p);
    const a = hit && hit.kind === 'ann' ? (this.step.annotations || []).find((x) => x.id === hit.id) : null;
    if (a && a.type === 'text') this.openText({ x: a.x, y: a.y }, a);
    else if (a && a.type === 'badge') {
      this.openText({ x: a.x, y: a.y }, a);
    }
  }

  key(e) {
    if (!this.editing || this.textEdit) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) {
      e.preventDefault();
      this.deleteSelected();
    } else if (e.key === 'Escape' && this.sel) {
      e.preventDefault();
      e.stopPropagation();
      this.sel = null;
      this.onSelect(null);
      this.render();
    }
  }

  deleteSelected() {
    const s = this.sel;
    if (!s) return;
    const before = visualState(this.step);
    if (s.kind === 'ann') this.step.annotations = (this.step.annotations || []).filter((a) => a.id !== s.id);
    else if (s.kind === 'redact') this.step.redactions.splice(s.index, 1);
    else if (s.kind === 'hl') this.step.highlight = false;
    else if (s.kind === 'crop') this.step.crop = null;
    this.sel = null;
    this.onSelect(null);
    this.commitFrom(before, s.kind === 'hl' ? '하이라이트 숨기기' : s.kind === 'crop' ? '자르기 해제' : '지우기');
  }

  clearCrop() {
    if (!this.step.crop) return;
    const before = visualState(this.step);
    this.step.crop = null;
    if (this.sel && this.sel.kind === 'crop') this.sel = null;
    this.commitFrom(before, '자르기 해제');
  }

  commitFrom(before, label) {
    const after = visualState(this.step);
    this.before = null;
    this.onSelect(this.sel);
    this.render();
    if (before && JSON.stringify(after) !== JSON.stringify(before)) this.onCommit(before, after, label);
  }

  /* ---------------- 글자 넣기·고치기 (그림 위에 칸을 띄움) ---------------- */

  openText(p, ann) {
    this.closeText(true);
    const ta = document.createElement('textarea');
    ta.className = 'ann-text-input';
    ta.rows = 1;
    ta.value = ann ? (ann.type === 'badge' ? String(ann.n) : ann.text) : '';
    ta.placeholder = ann && ann.type === 'badge' ? '번호' : '설명 글 (Enter 로 넣기, Shift+Enter 줄바꿈)';
    ta.style.left = p.x * 100 + '%';
    ta.style.top = p.y * 100 + '%';
    this.host.append(ta);
    this.textEdit = { ta, ann, p, before: visualState(this.step) };
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.closeText(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.closeText(false);
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => this.closeText(true), 0));
    setTimeout(() => ta.focus(), 0);
  }

  closeText(save) {
    const t = this.textEdit;
    if (!t) return;
    this.textEdit = null;
    t.ta.remove();
    if (!save) return;
    const text = t.ta.value.replace(/\s+$/, '');
    const anns = (this.step.annotations = this.step.annotations || []);
    if (t.ann && t.ann.type === 'badge') {
      const n = parseInt(text, 10);
      if (n > 0) t.ann.n = Math.min(999, n);
    } else if (t.ann) {
      if (text.trim()) t.ann.text = text;
      else this.step.annotations = anns.filter((a) => a !== t.ann);
    } else if (text.trim()) {
      const a = { id: newId(), type: 'text', color: this.color, x: t.p.x, y: t.p.y, text };
      anns.push(a);
      this.sel = { kind: 'ann', id: a.id };
    }
    this.commitFrom(t.before, t.ann ? '글자 고치기' : '글자 넣기');
  }
}
