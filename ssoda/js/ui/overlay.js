// 토스트, 모달, 확인창, 드롭다운 메뉴
import { h, clear } from '../util.js';
import { icon } from './icons.js';

/* ---------------- Toast ---------------- */
let toastHost;
export function toast(message, type = 'info', ms = 2600) {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  const el = h('div.toast.toast-' + type, icon(ic, 16), h('span.toast-msg', message));
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* ---------------- Modal ---------------- */
const modalStack = [];

export function openModal({ title, body, footer, width = 560, onClose, className = '', subtitle }) {
  const backdrop = h('div.modal-backdrop');
  const closeBtn = h('button.icon-btn.modal-x', { title: '닫기 (Esc)', onclick: () => close() }, icon('x', 18));
  const box = h(
    'div.modal' + (className ? '.' + className : ''),
    { style: { width: typeof width === 'number' ? width + 'px' : width }, role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', h('div', h('div.modal-title', title), subtitle ? h('div.modal-sub', subtitle) : null), closeBtn),
    h('div.modal-body', body),
    footer ? h('div.modal-foot', footer) : null
  );
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) backdrop._downOnBackdrop = true;
  });
  backdrop.addEventListener('mouseup', (e) => {
    if (e.target === backdrop && backdrop._downOnBackdrop) close();
    backdrop._downOnBackdrop = false;
  });
  document.body.appendChild(backdrop);
  const entry = { backdrop, close };
  modalStack.push(entry);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const i = modalStack.indexOf(entry);
    if (i >= 0) modalStack.splice(i, 1);
    if (onClose) onClose(result);
  }
  setTimeout(() => {
    if (box.contains(document.activeElement)) return; // 사용자가 이미 다른 입력칸에 포커스한 경우 유지
    const f = box.querySelector('[autofocus]') || box.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
    if (f) f.focus();
  }, 30);
  return { close, el: box, body: box.querySelector('.modal-body') };
}

export function topModal() {
  return modalStack[modalStack.length - 1];
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (menuState) {
      closeMenu();
      e.stopPropagation();
      return;
    }
    const m = topModal();
    if (m) {
      m.close();
      e.stopPropagation();
    }
  }
}, true);

export function confirmDialog({ title = '확인', message, okText = '확인', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button.btn' + (danger ? '.btn-danger' : '.btn-primary'), { onclick: () => { result = true; m.close(); } }, okText);
    const m = openModal({
      title,
      width: 420,
      body: h('div.confirm-msg', message),
      footer: [h('button.btn', { onclick: () => m.close() }, '취소'), ok],
      onClose: () => resolve(result),
    });
    setTimeout(() => ok.focus(), 40);
  });
}

export function promptDialog({ title, label, value = '', okText = '확인', placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder, autofocus: true, spellcheck: 'false' });
    const submit = () => {
      result = input.value.trim();
      m.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) submit();
    });
    const m = openModal({
      title,
      width: 420,
      body: h('label.field', label ? h('span.field-label', label) : null, input),
      footer: [h('button.btn', { onclick: () => m.close() }, '취소'), h('button.btn.btn-primary', { onclick: submit }, okText)],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  });
}

/* ---------------- Dropdown / Context menu ---------------- */
let menuState = null;

export function closeMenu() {
  if (!menuState) return;
  menuState.el.remove();
  document.removeEventListener('mousedown', menuState.outside, true);
  window.removeEventListener('blur', menuState.blur);
  const cb = menuState.onClose;
  menuState = null;
  if (cb) cb();
}

/**
 * items: [{label, icon, onClick, danger, disabled, checked, cls, hint, divider, header}]
 * at: {x, y} 또는 anchor 엘리먼트
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const el = h('div.menu' + (opts.className ? '.' + opts.className : ''), { role: 'menu' });
  if (opts.minWidth) el.style.minWidth = opts.minWidth + 'px';
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.divider) {
      el.appendChild(h('div.menu-div'));
      continue;
    }
    if (it.header) {
      el.appendChild(h('div.menu-header', it.header));
      continue;
    }
    if (it.node) {
      el.appendChild(it.node);
      continue;
    }
    const b = h(
      'button.menu-item' + (it.danger ? '.danger' : '') + (it.checked ? '.checked' : ''),
      {
        disabled: !!it.disabled,
        role: 'menuitem',
        onclick: (e) => {
          e.stopPropagation();
          closeMenu();
          it.onClick && it.onClick(e);
        },
      },
      h('span.menu-check', it.checked ? icon('check', 14) : null),
      it.icon ? icon(it.icon, 15, 'menu-ic') : null,
      h('span.menu-label' + (it.cls ? '.' + it.cls : ''), it.label),
      it.hint ? h('span.menu-hint', it.hint) : null
    );
    buttons.push(b);
    el.appendChild(b);
  }
  if (!opts.showChecks && !items.some((i) => i && i.checked !== undefined)) el.classList.add('no-checks');
  document.body.appendChild(el);
  // 위치 계산
  let x;
  let y;
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    x = opts.alignRight ? r.right - el.offsetWidth : r.left;
    y = r.bottom + 4;
    if (y + el.offsetHeight > window.innerHeight - 8) y = Math.max(8, r.top - el.offsetHeight - 4);
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + el.offsetHeight > window.innerHeight - 8) y = Math.max(8, window.innerHeight - el.offsetHeight - 8);
  }
  if (x + el.offsetWidth > window.innerWidth - 8) x = window.innerWidth - el.offsetWidth - 8;
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = y + 'px';
  const outside = (e) => {
    if (!el.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) closeMenu();
  };
  const blur = () => closeMenu();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  window.addEventListener('blur', blur);
  // 키보드 탐색
  el.tabIndex = -1;
  el.addEventListener('keydown', (e) => {
    const idx = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (buttons[idx + 1] || buttons[0])?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      (buttons[idx - 1] || buttons[buttons.length - 1])?.focus();
    }
  });
  if (opts.focus !== false) setTimeout(() => (buttons.find((b) => b.classList.contains('checked')) || buttons[0])?.focus(), 0);
  menuState = { el, outside, blur, onClose: opts.onClose };
  return el;
}

export function popover(anchor, content, opts = {}) {
  closeMenu();
  const el = h('div.menu.popover' + (opts.className ? '.' + opts.className : ''), content);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  let x = opts.alignRight ? r.right - el.offsetWidth : r.left;
  if (x + el.offsetWidth > window.innerWidth - 8) x = window.innerWidth - el.offsetWidth - 8;
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = r.bottom + 6 + 'px';
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  const blur = () => {};
  window.addEventListener('blur', blur);
  menuState = { el, outside, blur, onClose: opts.onClose };
  return el;
}

export function isMenuOpen() {
  return !!menuState;
}

export { clear };
