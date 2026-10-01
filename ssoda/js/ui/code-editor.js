// 코드 편집기 (textarea + 강조 오버레이 + 줄 번호) / 읽기 전용 코드 뷰
import { h, escapeHtml } from '../util.js';
import { highlight } from '../highlight.js';

const HIGHLIGHT_LIMIT = 300000;

export class CodeEditor {
  constructor({ value = '', language = 'text', onChange, placeholder = '', readOnly = false }) {
    this.language = language;
    this.onChange = onChange;
    this.gutter = h('div.ce-gutter');
    this.pre = h('pre.ce-hl', { 'aria-hidden': 'true' });
    this.ta = h('textarea.ce-input', { spellcheck: 'false', placeholder, readOnly, autocomplete: 'off', wrap: 'off' });
    this.ta.value = value;
    this.el = h('div.ce', this.gutter, h('div.ce-main', this.pre, this.ta));
    this.ta.addEventListener('input', () => {
      this.schedule();
      this.onChange && this.onChange(this.ta.value);
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  get value() {
    return this.ta.value;
  }

  setValue(v) {
    if (this.ta.value !== v) {
      this.ta.value = v;
      this.render();
    }
  }

  setLanguage(lang) {
    this.language = lang;
    this.render();
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  render() {
    const v = this.ta.value;
    const html = v.length > HIGHLIGHT_LIMIT ? escapeHtml(v) : highlight(v, this.language);
    this.pre.innerHTML = html + '\n';
    const lines = v.split('\n').length;
    if (lines !== this._lines) {
      this._lines = lines;
      let s = '';
      for (let i = 1; i <= lines; i++) s += i + '\n';
      this.gutter.textContent = s;
    }
    this.syncScroll();
  }

  syncScroll() {
    const { scrollTop, scrollLeft } = this.ta;
    this.pre.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-scrollTop}px)`;
  }

  insert(text) {
    this.ta.focus();
    // execCommand 는 실행 취소(Ctrl+Z) 기록을 유지
    if (!document.execCommand('insertText', false, text)) {
      const { selectionStart: s, selectionEnd: e } = this.ta;
      this.ta.setRangeText(text, s, e, 'end');
      this.ta.dispatchEvent(new Event('input'));
    }
  }

  onKey(e) {
    const ta = this.ta;
    if (ta.readOnly || e.isComposing || e.keyCode === 229) return;
    const v = ta.value;
    const s = ta.selectionStart;
    const end = ta.selectionEnd;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (s === end && !e.shiftKey) {
        this.insert('  ');
        return;
      }
      // 여러 줄 들여쓰기/내어쓰기
      const blockEnd = v.indexOf('\n', end - (end > s && v[end - 1] === '\n' ? 1 : 0));
      const stop = blockEnd < 0 ? v.length : blockEnd;
      const block = v.slice(lineStart, stop);
      const lines = block.split('\n');
      const changed = e.shiftKey ? lines.map((l) => l.replace(/^ {1,2}/, '')) : lines.map((l) => '  ' + l);
      ta.setSelectionRange(lineStart, stop);
      this.insert(changed.join('\n'));
      ta.setSelectionRange(lineStart, lineStart + changed.join('\n').length);
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = (v.slice(lineStart, s).match(/^[ \t]*/) || [''])[0];
      const prev = v.slice(0, s).trimEnd().slice(-1);
      const next = v.slice(end).trimStart()[0];
      if ('{[('.includes(prev) && prev) {
        e.preventDefault();
        const closing = { '{': '}', '[': ']', '(': ')' }[prev];
        if (next === closing && v.slice(end).match(/^\s*/)[0].indexOf('\n') < 0) {
          this.insert('\n' + indent + '  ' + '\n' + indent);
          const pos = s + 1 + indent.length + 2;
          ta.setSelectionRange(pos, pos);
        } else this.insert('\n' + indent + '  ');
        return;
      }
      if (indent) {
        e.preventDefault();
        this.insert('\n' + indent);
      }
    }
  }
}

// 읽기 전용 코드 뷰 (응답 본문, 코드 스니펫)
export function codeView(text, language, { wrap = false, lineNumbers = true, maxHighlight = 1000000 } = {}) {
  const t = String(text ?? '');
  const html = t.length > maxHighlight ? escapeHtml(t) : highlight(t, language, maxHighlight);
  const pre = h('pre.cv-code' + (wrap ? '.wrap' : ''));
  pre.innerHTML = html;
  if (!lineNumbers || wrap) return h('div.cv' + (wrap ? '.wrap' : ''), pre);
  const lines = t.split('\n').length;
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  const gutter = h('div.cv-gutter', s);
  return h('div.cv', gutter, pre);
}
