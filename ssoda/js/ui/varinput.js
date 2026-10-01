// {{변수}} 강조 + 자동완성 입력창
import { h, escapeHtml } from '../util.js';
import { DYNAMIC_VARIABLES } from '../variables.js';

let getScopeFn = () => new Map();
export function setScopeProvider(fn) {
  getScopeFn = fn;
}

function renderBackdrop(text, scope) {
  const s = String(text ?? '');
  if (!s.includes('{{')) return escapeHtml(s) + ' ';
  return (
    s
      .split(/(\{\{[^{}]*\}\})/g)
      .map((p, i) => {
        if (i % 2 === 0) return escapeHtml(p);
        const name = p.slice(2, -2).trim();
        const ok = DYNAMIC_VARIABLES.includes(name) || (scope && scope.has(name));
        return `<mark class="${ok ? 'var-ok' : 'var-bad'}">${escapeHtml(p)}</mark>`;
      })
      .join('') + ' '
  );
}

// 자동완성 팝업 (전역 1개)
let ac = null;
function closeAc() {
  if (ac) {
    ac.el.remove();
    ac = null;
  }
}

function showAc(input, prefix, scope, onPick) {
  const names = [...scope.keys()].map((k) => ({ name: k, value: scope.get(k).value, source: scope.get(k).source }));
  DYNAMIC_VARIABLES.forEach((d) => names.push({ name: d, value: '동적 변수', source: 'dynamic' }));
  const list = names.filter((n) => n.name.toLowerCase().includes(prefix.toLowerCase())).slice(0, 30);
  if (!list.length) return closeAc();
  if (!ac) {
    ac = { el: h('div.var-ac'), index: 0, list: [], input: null };
    document.body.appendChild(ac.el);
  }
  ac.list = list;
  ac.index = Math.min(ac.index, list.length - 1);
  ac.input = input;
  ac.onPick = onPick;
  ac.el.innerHTML = '';
  list.forEach((n, i) => {
    const row = h(
      'div.var-ac-item' + (i === ac.index ? '.active' : ''),
      {
        onmousedown: (e) => {
          e.preventDefault();
          onPick(n.name);
        },
      },
      h('span.var-ac-src.src-' + n.source, n.source === 'environment' ? 'E' : n.source === 'collection' ? 'C' : n.source === 'globals' ? 'G' : '$'),
      h('span.var-ac-name', n.name),
      h('span.var-ac-val', n.value)
    );
    ac.el.appendChild(row);
  });
  const r = input.getBoundingClientRect();
  ac.el.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
  ac.el.style.top = r.bottom + 2 + 'px';
  const act = ac.el.querySelector('.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

export function varInput({ value = '', placeholder = '', onInput, className = '', onKeyDown, onPaste, ariaLabel, getScope }) {
  const scopeOf = () => (getScope ? getScope() : getScopeFn());
  const backdrop = h('div.vi-backdrop');
  const input = h('input.vi-input', { type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': ariaLabel || placeholder });
  const el = h('div.vi' + (className ? '.' + className : ''), backdrop, input);
  const refresh = () => {
    backdrop.innerHTML = renderBackdrop(input.value, scopeOf());
    backdrop.scrollLeft = input.scrollLeft;
  };
  const sync = () => {
    backdrop.scrollLeft = input.scrollLeft;
  };
  const checkAc = () => {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/\{\{([^{}\s]*)$/);
    if (m) {
      showAc(input, m[1], scopeOf(), (name) => {
        const after = input.value.slice(pos).replace(/^[^{}\s]*\}\}/, '');
        const start = pos - m[1].length;
        input.value = input.value.slice(0, start) + name + '}}' + after;
        const caret = start + name.length + 2;
        input.setSelectionRange(caret, caret);
        closeAc();
        refresh();
        onInput && onInput(input.value);
      });
    } else if (ac && ac.input === input) closeAc();
  };
  input.addEventListener('input', () => {
    refresh();
    checkAc();
    onInput && onInput(input.value);
  });
  input.addEventListener('scroll', sync);
  input.addEventListener('keyup', sync);
  input.addEventListener('click', sync);
  input.addEventListener('blur', () => setTimeout(() => { if (ac && ac.input === input) closeAc(); }, 100));
  input.addEventListener('keydown', (e) => {
    if (ac && ac.input === input) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.list.length) % ac.list.length;
        checkAc();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        ac.onPick(ac.list[ac.index].name);
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAc();
        return;
      }
    }
    onKeyDown && onKeyDown(e);
  });
  if (onPaste) input.addEventListener('paste', onPaste);
  input.addEventListener('mouseenter', () => {
    const v = input.value;
    if (v.includes('{{')) {
      const scope = scopeOf();
      const parts = [];
      v.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, n) => {
        const hit = scope.get(n);
        parts.push(`{{${n}}} = ${hit ? hit.value + `  (${hit.source === 'environment' ? '환경' : hit.source === 'collection' ? '컬렉션' : '글로벌'})` : DYNAMIC_VARIABLES.includes(n) ? '(동적 변수)' : '(정의되지 않음)'}`);
        return _;
      });
      input.title = parts.join('\n');
    } else input.title = '';
  });
  refresh();
  return {
    el,
    input,
    refresh,
    get value() {
      return input.value;
    },
    setValue(v) {
      if (input.value !== v) input.value = v;
      refresh();
    },
  };
}

window.addEventListener('resize', closeAc);
