/* ClickGuide 요소 단서 — 녹화(recorder.js)와 따라하기(player.js)가 같이 쓴다.
 * classic 스크립트: 서비스 워커가 공용 가리기 코어(redact-core.js) 다음, 녹화·따라하기 스크립트 앞에 싣는다.
 *  - describe(el): 녹화 때 단계에 남기는 요소 정보. 예전 칸(tag·type·role·label·href·name·id·placeholder·selector)은
 *    예전과 같은 방법으로 만들고, 다시 찾을 때 쓰는 단서(testId·ariaLabel·text·path·hosts)를 더한다 (cv: 2).
 *    iframe 안 요소면 녹화 스크립트가 위로 올리면서 frames(바깥 → 안쪽 iframe 단서)를 붙인다.
 *  - find(cues, opts): 지금 문서(열린 shadow root 포함)에서 그 요소일 만한 것들을 모아 점수를 매긴다.
 *  - score(cues, info, opts): 후보 하나의 점수. DOM 을 쓰지 않는 함수라 node 에서 단위 시험한다.
 * 페이지 스크립트는 이 값을 볼 수 없다 (콘텐츠 스크립트의 격리된 환경).
 */
(() => {
  const RC = globalThis.RedactCore || null;

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[onclick]', '[data-testid]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // 시험 자동화용 속성: 화면이 바뀌어도 잘 남는다
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  /* ---------------- 이름 (녹화와 같은 규칙) ---------------- */

  function textOf(el, max = 120) {
    if (!el) return '';
    let t = '';
    try { t = (el.innerText || el.textContent || ''); } catch (_) { t = ''; }
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > max ? '' : t;   // 너무 길면 라벨로 부적절
  }

  function labelFromAriaLabelledBy(el) {
    const ids = (el.getAttribute && el.getAttribute('aria-labelledby') || '').trim();
    if (!ids) return '';
    const root = el.getRootNode ? el.getRootNode() : document;
    return ids.split(/\s+/)
      .map((id) => { try { return root.getElementById ? root.getElementById(id) : document.getElementById(id); } catch (_) { return null; } })
      .filter(Boolean).map((n) => textOf(n, 80)).join(' ').trim();
  }

  function labelFromFormLabel(el) {
    try {
      if (el.labels && el.labels.length) return textOf(el.labels[0], 80);
      const wrap = el.closest && el.closest('label');
      if (wrap) return textOf(wrap, 80);
      if (el.id) {
        const root = el.getRootNode ? el.getRootNode() : document;
        const q = root.querySelector ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        if (q) return textOf(q, 80);
      }
    } catch (_) { /* noop */ }
    return '';
  }

  function svgTitle(el) {
    try {
      const t = el.querySelector && el.querySelector('svg title, svg desc');
      return t ? textOf(t, 60) : '';
    } catch (_) { return ''; }
  }

  function bestLabel(el) {
    if (!el || !el.getAttribute) return '';
    const attr = (n) => (el.getAttribute(n) || '').trim();
    const tag = (el.tagName || '').toLowerCase();
    const type = (attr('type') || '').toLowerCase();

    const candidates = [
      attr('aria-label'),
      labelFromAriaLabelledBy(el),
      (tag === 'input' || tag === 'select' || tag === 'textarea') ? labelFromFormLabel(el) : '',
      (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) ? (el.value || '') : '',
      textOf(el),
      attr('title'),
      attr('alt'),
      (() => { try { const img = el.querySelector && el.querySelector('img[alt]'); return img ? img.getAttribute('alt') : ''; } catch (_) { return ''; } })(),
      svgTitle(el),
      attr('placeholder'),
      attr('data-testid'),
      attr('name')
    ];
    for (const c of candidates) {
      const v = (c || '').replace(/\s+/g, ' ').trim();
      if (v) return v.length > 80 ? v.slice(0, 79) + '…' : v;
    }
    return '';
  }

  /* 짧은 CSS 경로 (녹화와 같은 규칙: 5단계까지, id 가 있는 조상에서 멈춤, shadow root 경계에서 멈춤) */
  function cssPath(el) {
    try {
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        let sel = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter((c) => c && !/^(is-|has-|ng-|css-)/.test(c))[0];
        if (cls) sel += `.${CSS.escape(cls)}`;
        const parent = node.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    } catch (_) { return ''; }
  }

  /* ---------------- 다시 찾을 때 쓰는 단서 ---------------- */

  function testIdOf(el) {
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) return { attr: a, value: String(v).slice(0, 120) };
    }
    return null;
  }

  /* 문서(또는 shadow root) 안의 자리: 위에서부터 '태그:같은 태그 중 몇 번째' (20단계까지). 클래스·id 가 바뀌어도 남는다 */
  function domPath(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 20; i++) {
      const parent = node.parentElement;
      let n = 1;
      if (parent) {
        for (const c of parent.children) {
          if (c === node) break;
          if (c.tagName === node.tagName) n++;
        }
      }
      parts.unshift(node.tagName.toLowerCase() + (n > 1 ? ':' + n : ''));
      node = parent;
    }
    return parts.join('>');
  }

  /* 요소가 든 shadow root 의 주인(host)들. 바깥 → 안쪽 */
  function hostsOf(el) {
    const out = [];
    let root = el && el.getRootNode ? el.getRootNode() : null;
    while (root && root.host && out.length < 8) {
      const host = root.host;
      out.unshift({ tag: host.tagName.toLowerCase(), id: host.id || '', selector: cssPath(host) });
      root = host.getRootNode ? host.getRootNode() : null;
    }
    return out;
  }

  /* 녹화 때 남기는 요소 정보 */
  function describe(el) {
    if (!el || !el.tagName) return { tag: 'unknown' };
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    const tag = el.tagName.toLowerCase();
    const meta = {
      tag,
      type: (attr('type') || '').toLowerCase(),
      role: attr('role'),
      label: bestLabel(el),
      href: (tag === 'a' && el.href) ? String(el.href).slice(0, 300) : '',
      name: attr('name'),
      id: el.id || '',
      placeholder: attr('placeholder'),
      selector: cssPath(el)
    };
    const t = testIdOf(el);
    meta.cv = 2;
    meta.testId = t ? t.value : '';
    meta.testAttr = t ? t.attr : '';
    meta.ariaLabel = attr('aria-label').replace(/\s+/g, ' ').trim().slice(0, 120);
    // 화면 글자는 이름(label)과 다를 때만 (aria-label 이 이름이 된 경우 등). 같은 글자를 두 번 남기지 않는다
    const text = textOf(el, 120);
    meta.text = text && text !== meta.label ? text : '';
    meta.path = domPath(el);
    const hosts = hostsOf(el);
    if (hosts.length) meta.hosts = hosts;
    return meta;
  }

  /* iframe 하나의 단서 (부모 프레임이 그 iframe 요소를 보고 만든다) */
  function frameCue(iframe, index) {
    let src = '';
    try { src = iframe.getAttribute('src') || ''; } catch (_) { src = ''; }
    let path = '';
    try { path = src ? new URL(src, location.href).pathname : ''; } catch (_) { path = ''; }
    return {
      id: iframe.id || '',
      name: (iframe.getAttribute && iframe.getAttribute('name')) || '',
      path: path.slice(0, 200),
      index: typeof index === 'number' ? index : 0
    };
  }

  /* ---------------- 점수 (DOM 을 쓰지 않음) ---------------- */

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  /* 다시 열면 바뀌기 쉬운 자동 id: React useId(:r1:), ember123, 숫자가 길게 든 것, 해시, 끝에 글자·숫자가 섞인 꼬리 */
  function weakId(id) {
    const s = String(id || '');
    return /^:|^(ember|ext-gen|ui-id-|mui-|radix-|headlessui-|react-select-)/i.test(s)
      || /\d{4,}/.test(s)
      || /^[a-f0-9]{8,}$/i.test(s)
      || /[_-](?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{6,}$/i.test(s);
  }

  // 같은 일을 하는 요소로 바뀌기 쉬운 태그 (링크 ↔ 버튼, button ↔ input[type=button])
  const SIMILAR_TAGS = [['button', 'input'], ['a', 'button'], ['div', 'span'], ['li', 'div']];
  function similarTag(a, b) {
    if (a === b) return true;
    return SIMILAR_TAGS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
  }

  function samePath(a, b) {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.pathname === y.pathname && x.search === y.search;
    } catch (_) { return false; }
  }

  /* 경로가 끝(요소 쪽)에서부터 얼마나 같은지 → 0 ~ 12 */
  function pathScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 12;
    const x = a.split('>');
    const y = b.split('>');
    let k = 0;
    while (k < x.length && k < y.length && x[x.length - 1 - k] === y[y.length - 1 - k]) k++;
    return Math.min(10, k * 2);
  }

  /**
   * 후보 하나의 점수.
   *  cues: 녹화한 요소 정보(describe 결과, 예전 가이드는 tag·label·id·name·selector… 만 있음)
   *  c:    지금 후보의 정보(candidateInfo 결과)
   *  opts: { nrect: 녹화 때 상자(맨 위 화면 기준 0~1), frameBonus: 이 프레임이 녹화한 프레임과 맞는 정도 }
   * → { score, why: [단서 이름] }
   */
  function score(cues, c, opts = {}) {
    let s = 0;
    const why = [];
    const add = (n, w) => { if (n) { s += n; why.push(w); } };
    const has = (k) => cues && cues[k] != null && cues[k] !== '';

    if (has('testId') && c.testId === cues.testId) add(50, 'testId');
    if (has('id') && c.id === cues.id) add(weakId(cues.id) ? 12 : 40, 'id');
    if (has('name') && c.name === cues.name) add(18, 'name');
    if (has('ariaLabel') && norm(c.ariaLabel) === norm(cues.ariaLabel)) add(25, 'aria-label');
    const L = norm(cues.label);
    const cl = norm(c.label);
    if (L && cl === L) add(30, 'label');
    else if (L && cl && Math.min(L.length, cl.length) >= 2 && (cl.includes(L) || L.includes(cl))) add(10, 'label~');
    if (has('text') && cl !== L && norm(c.text) === norm(cues.text)) add(12, 'text');
    if (has('placeholder') && c.placeholder === cues.placeholder) add(15, 'placeholder');
    if (has('href') && c.href) {
      if (c.href === cues.href) add(20, 'href');
      else if (samePath(c.href, cues.href)) add(10, 'href~');
    }
    if (c.selectorHit) add(c.selectorCount === 1 ? 20 : 12, 'selector');
    if (has('path')) add(pathScore(cues.path, c.path), 'path');
    if (has('tag')) {
      if (c.tag === cues.tag) add(6, 'tag');
      else if (similarTag(cues.tag, c.tag)) add(5, 'tag~');   // 링크 ↔ 버튼처럼 같은 일을 하는 요소로 바뀐 경우
      else add(-25, 'tag≠');
    }
    if (has('type') && c.type === cues.type) add(4, 'type');
    if (has('role') && c.role === cues.role) add(3, 'role');
    if (Array.isArray(cues.hosts) && cues.hosts.length && cues.hosts.length === c.hostDepth) add(4, 'shadow');
    const n = opts.nrect;
    if (n && c.center && [n.x, n.y, n.w, n.h].every(Number.isFinite)) {
      const d = Math.hypot(n.x + n.w / 2 - c.center.x, n.y + n.h / 2 - c.center.y);
      add(Math.max(0, Math.round(6 - d * 15)), 'position');
    }
    if (opts.frameBonus) add(opts.frameBonus, 'frame');
    if (c.disabled) add(-5, 'disabled');
    if (!c.visible) { s = Math.round(s * 0.4); why.push('hidden'); }
    return { score: s, why };
  }

  // 이 점수보다 낮으면 '못 찾음'
  const FOUND_SCORE = 35;

  /* 단서 중 하나라도 맞는 것이 있으면 (이것 없이 태그·자리만 맞는 후보는 고르지 않는다) */
  function anyStrongCue(why) {
    return why.some((w) => !['tag', 'tag~', 'tag≠', 'type', 'role', 'position', 'path', 'shadow', 'frame', 'hidden', 'disabled'].includes(w));
  }

  /* ---------------- DOM 에서 후보 모으기 ---------------- */

  function visible(el, r) {
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    } catch (_) { /* noop */ }
    return true;
  }

  function allDeep(selector) {
    try {
      if (RC && RC.queryAllDeep) return RC.queryAllDeep(document, selector);
      return [...document.querySelectorAll(selector)];
    } catch (_) { return []; }
  }

  // 녹화한 selector 는 그 요소가 든 문서·shadow root 기준이다: 문서와 모든 shadow root 에서 찾아 본다
  function selectorHits(selector) {
    const out = new Set();
    if (!selector) return out;
    const roots = [document];
    try { if (RC && RC.shadowRoots) roots.push(...RC.shadowRoots(document)); } catch (_) { /* noop */ }
    for (const r of roots) {
      try { for (const el of r.querySelectorAll(selector)) out.add(el); } catch (_) { return new Set(); }   // 잘못된 선택자
    }
    return out;
  }

  function attrSel(name, value) {
    return `[${name}="${CSS.escape(String(value))}"]`;
  }

  function candidateInfo(el, ctx) {
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    const tag = el.tagName.toLowerCase();
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
    const t = testIdOf(el);
    return {
      tag,
      type: (attr('type') || '').toLowerCase(),
      role: attr('role'),
      id: el.id || '',
      name: attr('name'),
      placeholder: attr('placeholder'),
      ariaLabel: attr('aria-label'),
      testId: t ? t.value : '',
      label: bestLabel(el),
      text: textOf(el, 120),
      href: tag === 'a' && el.href ? String(el.href) : '',
      path: domPath(el),
      hostDepth: hostsOf(el).length,
      visible: visible(el, r),
      disabled: !!el.disabled || attr('aria-disabled') === 'true',
      center: r && (r.width || r.height) && ctx.viewW && ctx.viewH
        ? { x: (r.left + r.width / 2 + ctx.offX) / ctx.viewW, y: (r.top + r.height / 2 + ctx.offY) / ctx.viewH }
        : null,
      selectorHit: ctx.selectorSet.has(el),
      selectorCount: ctx.selectorSet.size
    };
  }

  /**
   * 지금 문서에서 그 요소를 찾는다.
   *  opts.nrect: 녹화 때 상자(맨 위 화면 기준 0~1), opts.view: { offX, offY, viewW, viewH } 이 프레임을 맨 위 화면에 놓는 값
   *  opts.frameBonus: 이 프레임이 녹화한 프레임과 맞는 정도 (player 가 정함)
   * → { el, score, why, second, count } 또는 null(후보 없음)
   */
  function find(cues, opts = {}) {
    if (!cues || !cues.tag || cues.tag === 'unknown') return null;
    const pool = new Set();
    const addAll = (list) => { for (const el of list) if (el && el.nodeType === 1) pool.add(el); };
    if (cues.testId) addAll(allDeep(TEST_ATTRS.map((a) => attrSel(a, cues.testId)).join(',')));
    if (cues.id) addAll(allDeep(`#${CSS.escape(cues.id)}`));
    if (cues.name) addAll(allDeep(attrSel('name', cues.name)));
    if (cues.ariaLabel) addAll(allDeep(attrSel('aria-label', cues.ariaLabel)));
    if (cues.placeholder) addAll(allDeep(attrSel('placeholder', cues.placeholder)));
    const selectorSet = selectorHits(cues.selector);
    addAll(selectorSet);
    if (cues.href) {
      for (const a of allDeep('a[href]')) if (a.href === cues.href || samePath(a.href, cues.href)) pool.add(a);
    }
    // 이름(화면 글자)으로: 같은 태그이거나 누를 수 있는 요소 중에서
    const L = norm(cues.label);
    if (L) {
      const tagSel = /^[a-z][a-z0-9-]*$/.test(cues.tag) ? cues.tag + ',' : '';
      for (const el of allDeep(tagSel + INTERACTIVE)) {
        if (pool.has(el)) continue;
        const l = norm(bestLabel(el));
        if (l && (l === L || (Math.min(l.length, L.length) >= 2 && (l.includes(L) || L.includes(l))))) pool.add(el);
      }
    }
    if (!pool.size) return null;
    const v = opts.view || { offX: 0, offY: 0, viewW: innerWidth, viewH: innerHeight };
    const ctx = { selectorSet, offX: v.offX || 0, offY: v.offY || 0, viewW: v.viewW || innerWidth, viewH: v.viewH || innerHeight };
    const ranked = [];
    for (const el of pool) {
      if (el.closest && el.closest('[data-clickguide-ui]')) continue;   // 따라하기 화면 자신
      const res = score(cues, candidateInfo(el, ctx), opts);
      if (anyStrongCue(res.why)) ranked.push({ el, ...res });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    return { el: best.el, score: best.score, why: best.why, second: ranked[1] ? ranked[1].score : 0, count: ranked.length };
  }

  globalThis.ClickGuideCues = Object.freeze({
    INTERACTIVE, FOUND_SCORE,
    textOf, bestLabel, cssPath, describe, domPath, hostsOf, frameCue,
    weakId, pathScore, score, anyStrongCue, find, candidateInfo
  });
})();
