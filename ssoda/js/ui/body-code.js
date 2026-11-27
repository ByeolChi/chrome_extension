// 응답 본문 글 보기 (Body 의 Pretty·Raw, 걸러 낸 결과, SSE 의 Raw)
// - 큰 글은 한 번에 VIEW_MAX 글자 구간만 그린다. 줄 번호는 구간 앞의 줄 수부터 이어진다.
// - 찾기: 글 전체에서 찾고, 찾은 곳을 CSS Custom Highlight API 로 칠한다(DOM 을 바꾸지 않아 큰 글도 가볍다).
//   지금 찾은 곳이 구간 밖이면 그곳이 보이게 구간을 옮겨 다시 그린다.
import { h, clear } from '../util.js';
import { codeView } from './code-editor.js';
import { viewWindow, lineAt, findMatches, VIEW_MAX } from '../resp-tools.js';

const PAINT_MAX = 2000; // 한 번에 칠하는 찾은 곳 수 (지금 찾은 곳 둘레)
const HL = 'ssoda-find';
const HL_CUR = 'ssoda-find-cur';
let owner = null; // 지금 칠한 BodyCode (하이라이트 등록부는 문서에 하나뿐)
const canPaint = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

function unpaint() {
  if (!canPaint()) return;
  CSS.highlights.delete(HL);
  CSS.highlights.delete(HL_CUR);
}

export class BodyCode {
  /**
   * box: 스크롤되는 상자 (.body-content). onState({ total, cur, capped, error }): 찾은 개수·위치가 바뀔 때
   */
  constructor(box, { onState } = {}) {
    this.box = box;
    this.onState = onState;
    this.text = '';
    this.win = { start: 0, end: 0, line: 1 };
    this.find = null; // { ranges, capped, error, cur, key }
  }

  /** 글을 그린다. opts: { wrap, lineNumbers, maxHighlight, size } */
  show(text, lang, opts = {}) {
    this.text = String(text ?? '');
    this.lang = lang;
    this.opts = opts;
    this.size = opts.size || VIEW_MAX;
    this.total = null;
    this.win = viewWindow(this.text, { start: 0, size: this.size });
    this.draw();
  }

  get windowed() {
    return this.win.end - this.win.start < this.text.length;
  }

  draw() {
    clear(this.box);
    const shown = this.text.slice(this.win.start, this.win.end);
    const cv = codeView(shown, this.lang, { wrap: this.opts.wrap, lineNumbers: this.opts.lineNumbers, maxHighlight: this.opts.maxHighlight, firstLine: this.win.line });
    this.pre = cv.querySelector('pre');
    this.nodes = null;
    this.box.appendChild(cv);
    if (this.windowed) this.box.appendChild(this.note());
    this.paint();
  }

  // 큰 응답: 지금 보이는 줄과 앞·뒤 부분으로 옮기는 단추
  note() {
    if (this.total == null) this.total = lineAt(this.text, this.text.length);
    const last = lineAt(this.text, this.win.end);
    const move = (dir) => {
      const start = dir < 0 ? Math.max(0, this.win.start - this.size) : Math.min(this.text.length - 1, this.win.end + 1);
      this.win = viewWindow(this.text, { start, size: this.size });
      this.draw();
      this.box.scrollTop = 0;
    };
    const n = (x) => x.toLocaleString('ko-KR');
    return h('div.body-note.win-note',
      h('span', `응답이 커서 일부만 보입니다: ${n(this.win.line)}~${n(last)}번째 줄 (전체 ${n(this.total)}줄). 찾기(Ctrl+F)는 전체에서 찾아 그곳을 보여 줍니다. 전체는 파일로 저장하세요.`),
      this.win.start > 0 ? h('button.link-btn.win-prev', { onclick: () => move(-1) }, '앞 부분') : null,
      this.win.end < this.text.length ? h('button.link-btn.win-next', { onclick: () => move(1) }, '뒷 부분') : null);
  }

  /* ---------------- 찾기 ---------------- */

  /** 찾는다. 같은 글·같은 옵션이면 다시 찾지 않는다. 지금 보이는 구간의 첫 찾은 곳을 고른다 */
  setFind(query, { caseSensitive = false, regex = false } = {}) {
    const q = String(query ?? '');
    const key = `${caseSensitive ? 1 : 0}${regex ? 1 : 0}\u0000${q}`;
    if (this.find && this.find.key === key) return this.state();
    if (!q) {
      this.find = null;
      this.paint();
      return this.emit();
    }
    const r = findMatches(this.text, q, { caseSensitive, regex });
    let cur = r.ranges.findIndex(([s]) => s >= this.win.start);
    if (cur < 0) cur = r.ranges.length ? 0 : -1;
    this.find = { ...r, cur, key };
    if (cur >= 0) this.reveal();
    else this.paint();
    return this.emit();
  }

  clearFind() {
    this.find = null;
    this.paint();
  }

  /** 다음(1)·이전(-1) 찾은 곳으로 */
  step(dir) {
    const f = this.find;
    if (!f || !f.ranges.length) return this.state();
    f.cur = (f.cur + dir + f.ranges.length) % f.ranges.length;
    this.reveal();
    return this.emit();
  }

  state() {
    const f = this.find;
    return f ? { total: f.ranges.length, cur: f.cur, capped: f.capped, error: f.error } : { total: 0, cur: -1, capped: false, error: '' };
  }

  emit() {
    const s = this.state();
    if (this.onState) this.onState(s);
    return s;
  }

  // 지금 찾은 곳이 보이게: 구간 밖이면 구간을 옮겨 다시 그리고, 상자를 굴려 가운데에
  reveal() {
    const f = this.find;
    const [s, e] = f.ranges[f.cur];
    if (s < this.win.start || e > this.win.end) {
      this.win = viewWindow(this.text, { start: this.win.start, focus: s, size: this.size });
      this.draw();
    } else this.paint();
    this.scrollToCurrent();
  }

  paint() {
    if (!canPaint()) return;
    const f = this.find;
    if (!f || !f.ranges.length || !this.pre || !this.pre.isConnected) {
      if (owner === this) {
        unpaint();
        owner = null;
      }
      return;
    }
    const idx = this.index();
    const all = new Highlight();
    const cur = new Highlight();
    cur.priority = 1;
    const lo = Math.max(0, f.cur - PAINT_MAX / 2);
    const hi = Math.min(f.ranges.length, lo + PAINT_MAX);
    for (let i = lo; i < hi; i++) {
      const [s, e] = f.ranges[i];
      if (s < this.win.start || e > this.win.end) continue;
      const r = this.rangeOf(s - this.win.start, e - this.win.start, idx);
      if (!r) continue;
      all.add(r);
      if (i === f.cur) cur.add(this.rangeOf(s - this.win.start, e - this.win.start, idx));
    }
    CSS.highlights.set(HL, all);
    CSS.highlights.set(HL_CUR, cur);
    owner = this;
  }

  /** 다른 화면에 가 있다 돌아왔을 때 이 화면의 찾은 곳을 다시 칠한다 */
  repaint() {
    if (this.find && owner !== this) this.paint();
  }

  destroy() {
    if (owner === this) {
      unpaint();
      owner = null;
    }
  }

  // 글 조각(텍스트 노드)들과 각 조각이 시작하는 글자 위치 — 강조(span) 때문에 글이 여러 조각으로 나뉜다
  index() {
    if (this.nodes) return this.nodes;
    const nodes = [];
    const starts = [];
    let pos = 0;
    const w = document.createTreeWalker(this.pre, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      nodes.push(n);
      starts.push(pos);
      pos += n.length;
    }
    this.nodes = { nodes, starts };
    return this.nodes;
  }

  rangeOf(s, e, { nodes, starts }) {
    if (!nodes.length) return null;
    const at = (off, isEnd) => {
      let lo = 0;
      let hi = nodes.length - 1;
      let k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= off) {
          k = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (isEnd) while (k > 0 && starts[k] === off) k--; // 끝은 앞 조각의 끝으로
      return [nodes[k], Math.min(off - starts[k], nodes[k].length)];
    };
    const a = at(s, false);
    const b = at(e, true);
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    return r;
  }

  scrollToCurrent() {
    const f = this.find;
    if (!f || f.cur < 0 || !this.box.isConnected) return;
    const [s, e] = f.ranges[f.cur];
    if (s < this.win.start || e > this.win.end) return;
    const r = this.rangeOf(s - this.win.start, e - this.win.start, this.index());
    if (!r) return;
    const rect = r.getBoundingClientRect();
    const box = this.box.getBoundingClientRect();
    const noteH = this.windowed ? 44 : 0; // 아래에 붙은 안내 줄
    if (rect.top < box.top + 4 || rect.bottom > box.bottom - noteH - 4) this.box.scrollTop += rect.top - box.top - (box.height - noteH) / 2;
    if (rect.left < box.left + 48 || rect.right > box.right - 8) this.box.scrollLeft += rect.left - box.left - box.width / 2;
  }
}
