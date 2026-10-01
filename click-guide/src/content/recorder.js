/* ClickGuide 콘텐츠 스크립트 (모든 프레임에서 실행, document_start)
 * - 녹화 중이 아닐 때는 아무 것도 하지 않는다.
 * - 클릭/입력/페이지 이동을 감지해 백그라운드에 캡처를 요청한다.
 * - iframe 안에서 일어난 클릭은 부모 프레임으로 좌표를 올려 최상위 뷰포트 기준으로 보정한다.
 */
(() => {
  // 확장을 다시 불러오면 기존 탭에 남은 인스턴스는 죽은 채로 남는다.
  // 예전에는 전역 표식만 보고 재주입을 건너뛰어서, 그 탭은 페이지를 새로고침하기 전까지
  // 녹화 바가 뜨지 않았다. 이제는 이전 인스턴스를 정리하고 자리를 넘겨받는다.
  try { if (typeof window.__CLICKGUIDE_TEARDOWN__ === 'function') window.__CLICKGUIDE_TEARDOWN__(); } catch (_) { /* noop */ }
  window.__CLICKGUIDE_RECORDER__ = true;

  const IS_TOP = (() => { try { return window.top === window; } catch (_) { return false; } })();

  let state = { recording: false, paused: false, stepCount: 0 };
  let settings = null;
  let widget = null;          // { host, shadow, countEl }
  let lastClickKey = '';
  let lastClickAt = 0;

  let pendingCaptures = 0;
  let clientSeq = 0;
  let onRuntimeMessage = null;
  let onStorageChanged = null;

  /* 화면이 얼마나 바뀌었는지 가늠하는 값.
   * 백그라운드가 '방금 찍은 프레임을 재사용해도 되는지' 판단할 때 쓴다.
   * (모달이 열렸는데 열리기 전 사진을 재사용하는 일을 막는다) */
  let mutationCount = 0;
  let mutationObserver = null;

  function isOurs(node) {
    return !!(node && (node.__clickguideWidget || (node.parentNode && node.parentNode.__clickguideWidget)));
  }

  function startMutationWatch() {
    if (mutationObserver || !IS_TOP || !document.documentElement) return;
    try {
      mutationObserver = new MutationObserver((list) => {
        for (const rec of list) {
          // 녹화 표시줄을 숨겼다 보이는 것은 화면 변화로 치지 않는다
          if (isOurs(rec.target)) continue;
          if (rec.type === 'childList') {
            const nodes = [...rec.addedNodes, ...rec.removedNodes];
            if (nodes.length && nodes.every(isOurs)) continue;
          }
          mutationCount++;
        }
      });
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch (_) { mutationObserver = null; }
  }
  function stopMutationWatch() {
    if (mutationObserver) { try { mutationObserver.disconnect(); } catch (_) { /* noop */ } mutationObserver = null; }
  }
  const FRAME_TAG = Math.random().toString(36).slice(2, 8);
  function newClientId() { return FRAME_TAG + '-' + (++clientSeq); }

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[onclick]', '[data-testid]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const SENSITIVE_RE = /pass|pwd|passwd|secret|token|card|cvc|cvv|ssn|security|otp|비밀번호|암호|주민|계좌|카드|보안/i;

  /* ------------------------------------------------------------------ */
  /* 백그라운드 통신                                                      */
  /* ------------------------------------------------------------------ */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // 컨텍스트 무효화 무시
          resolve(res || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  async function syncState() {
    const res = await send({ type: 'GET_STATE' });
    if (res) applyState(res.state, res.settings);
  }

  /* 녹화 중에는 백그라운드(서비스 워커)가 잠들지 않도록 붙잡아 둔다.
   * 잠들면 다음 클릭에서 콜드 스타트가 일어나 촬영이 눈에 띄게 늦어진다. */
  let keepPort = null;
  let keepTimer = null;

  function startKeepAlive() {
    if (!IS_TOP || keepPort) return;
    try {
      keepPort = chrome.runtime.connect({ name: 'cg-keepalive' });
      keepPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        keepPort = null;
        if (state.recording) setTimeout(startKeepAlive, 500);
      });
    } catch (_) { keepPort = null; return; }
    clearInterval(keepTimer);
    keepTimer = setInterval(() => {
      if (!keepPort) return;
      try { keepPort.postMessage({ t: 1 }); } catch (_) { keepPort = null; }
    }, 15000);
  }

  function stopKeepAlive() {
    clearInterval(keepTimer);
    keepTimer = null;
    if (keepPort) { try { keepPort.disconnect(); } catch (_) { /* noop */ } keepPort = null; }
  }

  function applyState(nextState, nextSettings) {
    state = nextState || state;
    if (nextSettings) settings = nextSettings;
    if (IS_TOP) {
      if (state.recording) { startKeepAlive(); startMutationWatch(); }
      else { stopKeepAlive(); stopMutationWatch(); }
    }
    if (IS_TOP) {
      if (state.recording && !barHidden) ensureWidget();
      else removeWidget();
      if (widget && !state.recording) widget.countEl.textContent = '0';
      if (widget) {
        const shown = parseInt(widget.countEl.textContent, 10) || 0;
        widget.countEl.textContent = String(Math.max(shown, state.stepCount || 0));
        widget.host.dataset.paused = state.paused ? '1' : '0';
        widget.pauseBtn.textContent = state.paused ? '재개' : '일시정지';
      }
    }
  }

  try {
    onRuntimeMessage = (msg, _sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'STATE_CHANGED') { applyState(msg.state, msg.settings); }
      if (msg.type === 'PING') { sendResponse({ ok: true }); return true; }
      if (msg.type === 'HIDE_WIDGET') { hideWidget(); nextFrame().then(() => sendResponse({ ok: true })); return true; }
      if (msg.type === 'SHOW_WIDGET') { showWidget(); sendResponse({ ok: true }); return true; }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (_) { /* noop */ }

  syncState();

  /* ------------------------------------------------------------------ */
  /* 요소 메타데이터 추출                                                 */
  /* ------------------------------------------------------------------ */

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

  function elMeta(el) {
    if (!el || !el.tagName) return { tag: 'unknown' };
    const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
    return {
      tag: el.tagName.toLowerCase(),
      type: (attr('type') || '').toLowerCase(),
      role: attr('role'),
      label: bestLabel(el),
      href: (el.tagName.toLowerCase() === 'a' && el.href) ? String(el.href).slice(0, 300) : '',
      name: attr('name'),
      id: el.id || '',
      placeholder: attr('placeholder'),
      selector: cssPath(el)
    };
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    } catch (_) { return null; }
  }

  // 클릭 지점에서 "의미 있는" 조상 요소 찾기
  function interactiveTarget(path) {
    const first = path.find((n) => n && n.nodeType === 1);
    if (!first) return null;
    let node = first;
    let hops = 0;
    while (node && node.nodeType === 1 && hops < 6) {
      try {
        if (node.matches && node.matches(INTERACTIVE)) {
          const r = rectOf(node);
          // 화면 대부분을 덮는 컨테이너면 원래 타깃을 쓴다
          if (r && r.width < innerWidth * 0.95 && r.height < innerHeight * 0.9) return node;
          return first;
        }
      } catch (_) { /* noop */ }
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      hops++;
    }
    return first;
  }

  /* ------------------------------------------------------------------ */
  /* 가릴 영역(민감 정보) 수집                                            */
  /* ------------------------------------------------------------------ */

  function redactionRects() {
    if (!settings) return [];
    const sel = [];
    if (settings.maskPasswords) sel.push('input[type="password"]');
    sel.push('[data-clickguide-redact]');
    for (const s of (settings.redactSelectors || [])) { if (s && s.trim()) sel.push(s.trim()); }
    if (!sel.length) return [];
    const out = [];
    try {
      const nodes = document.querySelectorAll(sel.join(','));
      for (const n of nodes) {
        const r = rectOf(n);
        if (!r) continue;
        if (r.x + r.width < 0 || r.y + r.height < 0 || r.x > innerWidth || r.y > innerHeight) continue;
        out.push({ x: r.x - 3, y: r.y - 3, width: r.width + 6, height: r.height + 6 });
      }
    } catch (_) { /* 잘못된 선택자 무시 */ }
    return out.slice(0, 40);
  }

  /* ------------------------------------------------------------------ */
  /* 캡처 요청 (iframe -> 최상위 프레임 좌표 보정)                         */
  /* ------------------------------------------------------------------ */

  /* 클릭 순간과 실제 촬영 순간 사이에 화면이 움직이는 일이 잦다
   * (버튼을 누르면 레이아웃이 밀리거나 모달이 뜨는 등).
   * 그래서 클릭 직후부터 매 프레임 대상 요소의 위치를 기록해 두었다가,
   * 백그라운드가 알려 준 '촬영 시각'에 가장 가까운 표본을 하이라이트 좌표로 쓴다. */
  const tracked = new Map();   // clientId -> { el, samples:[{t,r}], stop }
  const MAX_SAMPLES = 90;

  function trackTarget(clientId, el) {
    if (!clientId || !el) return;
    const rec = { el, samples: [], stop: false };
    const tick = () => {
      if (rec.stop || rec.samples.length >= MAX_SAMPLES) return;
      let r = null;
      try { if (el.isConnected) r = rectOf(el); } catch (_) { r = null; }
      rec.samples.push({ t: Date.now(), r });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    tracked.set(clientId, rec);
    // 오래된 기록 정리
    setTimeout(() => { const x = tracked.get(clientId); if (x) { x.stop = true; tracked.delete(clientId); } }, 4000);
  }

  function pickSample(clientId, at) {
    const rec = tracked.get(clientId);
    if (!rec) return null;
    rec.stop = true;
    tracked.delete(clientId);
    let best = null;
    let bestD = Infinity;
    for (const s of rec.samples) {
      const d = Math.abs(s.t - at);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) return null;
    return { rect: best.r, drop: !best.r };
  }

  function broadcastDown(msg) {
    try {
      const frames = document.querySelectorAll('iframe, frame');
      for (const f of frames) { try { f.contentWindow.postMessage(msg, '*'); } catch (_) { /* noop */ } }
    } catch (_) { /* noop */ }
  }

  function bubbleUp(payload, el) {
    if (el && payload.clientId) trackTarget(payload.clientId, el);
    if (IS_TOP) {
      if (payload._kind === 'corr') {
        send({ type: 'CORRECT_RECT', clientId: payload.clientId, rect: payload.rect || null, drop: !!payload.drop });
        return;
      }
      // 앞 요청의 응답을 기다리지 않고 바로 보낸다.
      // 순서는 백그라운드가 메시지 도착 순서로 잡아 준다.
      captureFromTop(payload);
      return;
    }
    try { window.parent.postMessage({ __clickguide: 'up', payload }, '*'); } catch (_) { /* noop */ }
  }

  const onWindowMessage = (e) => {
    const d = e.data;
    if (d && d.__clickguide === 'remeasure') {
      const picked = pickSample(d.clientId, d.at);
      if (picked) bubbleUp({ _kind: 'corr', clientId: d.clientId, rect: picked.rect, drop: picked.drop });
      else broadcastDown(d);
      return;
    }
    if (!d || d.__clickguide !== 'up' || !d.payload) return;
    let off = null;
    try {
      const frames = document.querySelectorAll('iframe, frame');
      for (const f of frames) {
        if (f.contentWindow === e.source) { const r = f.getBoundingClientRect(); off = { x: r.left, y: r.top }; break; }
      }
    } catch (_) { /* noop */ }
    if (!off) return;
    const p = d.payload;
    const shift = (r) => r && { x: r.x + off.x, y: r.y + off.y, width: r.width, height: r.height };
    p.rect = shift(p.rect);
    p.redactions = (p.redactions || []).map(shift).filter(Boolean);
    bubbleUp(p);
  };
  window.addEventListener('message', onWindowMessage, false);

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  async function captureFromTop(payload) {
    // 좌표는 최상위 뷰포트의 CSS 픽셀 그대로 보낸다.
    // 0~1 정규화는 백그라운드가 실제 캡처 이미지 크기를 보고 수행한다
    // (기기 에뮬레이션 등으로 innerHeight 와 캡처 높이가 다를 수 있기 때문).
    payload.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    payload.url = location.href;
    payload.title = document.title;

    const localRect = payload.rect;
    payload.scroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    payload.mut = mutationCount;
    // 위젯을 숨긴 '직후' 곧바로 요청을 보낸다.
    // 여기서 프레임을 기다리면, 링크처럼 클릭 즉시 이동하는 경우
    // 페이지가 먼저 사라져 요청 자체가 전달되지 않는다.
    // 위젯이 화면에서 지워질 시간은 백그라운드가 촬영 직전에 확보한다.
    payload.widgetShown = pendingCaptures === 0 && !!widget;
    pendingCaptures++;
    hideWidget();
    // 표시줄을 숨긴 시각. 백그라운드는 '이미 지난 시간'을 빼고 남은 만큼만 기다린다.
    payload.hiddenAt = Date.now();
    let res = null;
    try {
      res = await send({ type: 'CAPTURE_STEP', step: payload });
    } finally {
      pendingCaptures = Math.max(0, pendingCaptures - 1);
      if (pendingCaptures === 0) showWidget();
    }

    if (res && res.ok) bumpCount();
    let finalRect = localRect;
    if (res && res.ok && res.wantRect && payload.clientId) {
      const picked = pickSample(payload.clientId, res.capturedAt || Date.now());
      if (picked) {
        finalRect = picked.rect || localRect;
        send({ type: 'CORRECT_RECT', clientId: payload.clientId, rect: picked.rect, drop: picked.drop });
      } else {
        // 대상 요소가 하위 프레임에 있다 — 그 프레임에 재측정을 요청한다
        broadcastDown({ __clickguide: 'remeasure', clientId: payload.clientId, at: res.capturedAt || Date.now() });
        setTimeout(() => send({ type: 'CORRECT_RECT', clientId: payload.clientId, rect: null, drop: false }), 160);
      }
    }
    if (finalRect) flash(finalRect, !(res && res.ok && res.wantRect));
  }

  // 백그라운드의 공식 집계는 조금 뒤에 오므로, 화면 숫자는 먼저 올린다
  function bumpCount() {
    if (!widget) return;
    const n = parseInt(widget.countEl.textContent, 10) || 0;
    widget.countEl.textContent = String(n + 1);
  }

  /* ------------------------------------------------------------------ */
  /* 이벤트 핸들러                                                        */
  /* ------------------------------------------------------------------ */

  function active() { return state.recording && !state.paused && settings; }

  // 입력칸은 blur 시점에 change 가 뜨므로, 다음 클릭보다 늦게 기록된다.
  // 클릭 직전에 먼저 '입력' 단계를 내보내 순서를 바로잡는다.
  let pendingInput = null;   // { el, value }

  function trackFocus(el) {
    if (!el || !el.tagName) { pendingInput = null; return; }
    const tag = el.tagName.toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) pendingInput = { el, value: el.value };
    else pendingInput = null;
  }

  function flushPendingInput(exceptEl) {
    if (!pendingInput || !pendingInput.el) return;
    const el = pendingInput.el;
    if (el === exceptEl) return;
    let cur = '';
    try { cur = el.value; } catch (_) { return; }
    if (cur === pendingInput.value) return;
    pendingInput.value = cur;          // change 이벤트에서 중복 기록되지 않도록
    emitValueStep(el);
  }

  const onFocusIn = (e) => { if (active()) trackFocus(e.target); };
  document.addEventListener('focusin', onFocusIn, true);

  function onPointerDown(e) {
    if (!active() || !settings.recordClicks) return;
    if (!e.isTrusted || e.button !== 0) return;
    const path = (e.composedPath && e.composedPath()) || [e.target];
    if (path.some((n) => n && n.__clickguideWidget)) return;   // 우리 위젯 클릭은 무시

    const target = interactiveTarget(path);
    if (!target) return;
    if (settings.recordInputs) flushPendingInput(target);
    const rect = rectOf(target) || { x: e.clientX - 12, y: e.clientY - 12, width: 24, height: 24 };

    const meta = elMeta(target);
    const key = meta.selector + '|' + meta.label;
    const now = Date.now();
    if (key === lastClickKey && now - lastClickAt < 400) return;  // 더블클릭/중복 방지
    lastClickKey = key; lastClickAt = now;

    bubbleUp({ type: 'click', ts: now, clientId: newClientId(), el: meta, rect, redactions: redactionRects() }, target);
  }

  function maskValue(el, raw) {
    const meta = elMeta(el);
    const hay = [meta.type, meta.name, meta.id, meta.placeholder, meta.label].join(' ');
    const digits = String(raw).replace(/\D/g, '');
    const sensitive = meta.type === 'password'
      || (settings.maskSensitiveValues && (SENSITIVE_RE.test(hay) || digits.length >= 12));
    if (sensitive) return { value: '●'.repeat(Math.min(8, Math.max(4, String(raw).length))), masked: true };
    const keep = settings.maskValueChars | 0;
    if (keep > 0 && String(raw).length > keep) {
      return { value: String(raw).slice(0, keep) + '●'.repeat(Math.min(8, String(raw).length - keep)), masked: true };
    }
    return { value: String(raw).slice(0, 200), masked: false };
  }

  function onChange(e) {
    if (!active() || !settings.recordInputs) return;
    // 프레임워크가 대신 쏘는 이벤트는 그 요소가 지금 포커스를 가진 경우에만 인정한다
    // (자동완성으로 여러 칸이 한꺼번에 채워지는 상황을 걸러낸다)
    if (!e.isTrusted && document.activeElement !== e.target) return;
    const el = e.target;
    if (pendingInput && pendingInput.el === el) {
      let cur = ''; try { cur = el.value; } catch (_) { /* noop */ }
      if (cur === pendingInput.value) return;   // 이미 클릭 직전에 기록됨
      pendingInput.value = cur;
    }
    emitValueStep(el);
  }

  function emitValueStep(el) {
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return;
    if (el.__clickguideWidget) return;

    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['checkbox', 'radio', 'submit', 'button', 'reset', 'hidden'].includes(type)) return;  // 클릭으로 이미 기록됨

    let raw = '';
    let stepType = 'input';
    if (tag === 'select') {
      stepType = 'select';
      const opt = el.options && el.options[el.selectedIndex];
      raw = opt ? (opt.textContent || opt.value || '') : el.value;
    } else {
      raw = el.value || '';
    }
    raw = String(raw).replace(/\s+/g, ' ').trim();
    if (!raw) return;

    const { value, masked } = maskValue(el, raw);
    bubbleUp({
      type: stepType, ts: Date.now(), clientId: newClientId(), el: elMeta(el), value, masked,
      rect: rectOf(el) || null, redactions: redactionRects()
    }, el);
  }

  const onBeforeUnload = () => { if (active() && settings.recordInputs) flushPendingInput(null); };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('change', onChange, true);
  window.addEventListener('beforeunload', onBeforeUnload, true);

  /* ---- 페이지 이동 알림 (최상위 프레임만) ---- */

  let lastNotifiedUrl = '';
  function notifyNavigation() {
    if (!IS_TOP || !state.recording || state.paused) return;
    if (location.href === lastNotifiedUrl) return;
    lastNotifiedUrl = location.href;
    send({ type: 'PAGE_LOADED', url: location.href, title: document.title });
  }

  if (IS_TOP) {
    if (document.readyState === 'complete') setTimeout(notifyNavigation, 300);
    window.addEventListener('load', () => setTimeout(notifyNavigation, 300));
    window.addEventListener('popstate', () => setTimeout(notifyNavigation, 400));
    try {
      ['pushState', 'replaceState'].forEach((m) => {
        const orig = history[m];
        history[m] = function () {
          const r = orig.apply(this, arguments);
          setTimeout(notifyNavigation, 500);
          return r;
        };
      });
    } catch (_) { /* noop */ }
  }

  /* ------------------------------------------------------------------ */
  /* 녹화 위젯 (최상위 프레임)                                            */
  /* ------------------------------------------------------------------ */

  const WIDGET_CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 9px;
    padding: 8px 12px 8px 8px; border-radius: 999px;
    background: rgba(17,17,20,.92); color: #fff;
    font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
    box-shadow: 0 6px 24px rgba(0,0,0,.28); backdrop-filter: blur(6px);
    user-select: none; cursor: grab; touch-action: none;
  }
  .bar.dragging { cursor: grabbing; box-shadow: 0 10px 34px rgba(0,0,0,.42); }
  .grip {
    flex: none; width: 14px; height: 18px; opacity: .45;
    background-image: radial-gradient(currentColor 1.2px, transparent 1.3px);
    background-size: 5px 5px; background-position: 1px 2px;
  }
  .bar:hover .grip { opacity: .8; }
  .hint {
    position: absolute; right: 0; bottom: calc(100% + 8px); white-space: nowrap;
    z-index: 1;
    background: rgba(17,17,20,.92); color: #fff; font-size: 11.5px; line-height: 1.4;
    padding: 5px 10px; border-radius: 8px; opacity: 0; transition: opacity .15s;
    pointer-events: none;
  }
  .bar:hover .hint { opacity: .95; }
  .bar.hint-below .hint { bottom: auto; top: calc(100% + 8px); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff3b30; animation: p 1.4s ease-in-out infinite; }
  :host([data-paused="1"]) .dot { background: #ffb020; animation: none; }
  @keyframes p { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  .txt { opacity: .9; }
  .n { font-variant-numeric: tabular-nums; font-weight: 700; }
  button {
    all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
    position: relative;
    background: rgba(255,255,255,.14); font-size: 12px; color: #fff;
  }
  button:hover { background: rgba(255,255,255,.26); }
  .stop { background: #ff3b30; }
  .stop:hover { background: #ff5b52; }
  .x {
    width: 22px; height: 22px; padding: 0; margin-left: -2px;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; line-height: 1; background: transparent; opacity: .6;
  }
  .x:hover { background: rgba(255,255,255,.2); opacity: 1; }
  .flash {
    position: fixed; z-index: 2147483646; pointer-events: none;
    border: 3px solid #ff3b30; border-radius: 6px;
    box-shadow: 0 0 0 3px rgba(255,59,48,.22);
    animation: f .7s ease-out forwards;
  }
  @keyframes f { 0% { opacity: 0; transform: scale(1.06) } 20% { opacity: 1; transform: scale(1) } 100% { opacity: 0 } }
  .flash.noshot { border-color: #ffb020; box-shadow: 0 0 0 3px rgba(255,176,32,.25); }
  `;

  function ensureWidget() {
    if (widget) return widget;
    if (barHidden) return null;
    if (!document.documentElement) return null;
    if (!barPosLoaded) loadBarPos();   // 저장된 위치를 비동기로 불러와 적용
    const host = document.createElement('div');
    host.__clickguideWidget = true;
    host.style.cssText = 'all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<span class="grip"></span><span class="dot"></span>'
      + '<span class="txt">ClickGuide 녹화 중 · <span class="n">0</span>단계</span>'
      + '<span class="hint">끌어서 옮기기 · 두 번 클릭하면 제자리로 · ×는 숨기기</span>';
    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '일시정지';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '완료';
    stopBtn.className = 'stop';
    const hideBtn = document.createElement('button');
    hideBtn.textContent = '×';
    hideBtn.className = 'x';
    hideBtn.title = '이 바를 화면에서 숨깁니다 (녹화는 계속되며, 확장 아이콘에서 다시 표시할 수 있습니다)';
    hideBtn.setAttribute('aria-label', '녹화 바 숨기기');
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'SET_BAR_HIDDEN', hidden: true });
      barHidden = true;
      removeWidget();
    });
    pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); send({ type: state.paused ? 'RESUME' : 'PAUSE' }); });
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'STOP' }); });
    bar.append(pauseBtn, stopBtn, hideBtn);
    shadow.append(style, bar);
    document.documentElement.appendChild(host);
    widget = { host, shadow, bar, countEl: bar.querySelector('.n'), pauseBtn, stopBtn };
    enableDragging(bar);
    applyBarPos();
    return widget;
  }

  /* ---- 녹화 바 위치 (끌어서 이동, 브라우저에 기억) ----
   * 위치는 화면 크기에 대한 비율(0~1)로 저장해, 창 크기가 달라져도 비슷한 자리에 놓인다. */
  const BAR_POS_KEY = 'cg_barPos';
  const BAR_HIDDEN_KEY = 'cg_barHidden';
  let barHidden = false;
  const BAR_MARGIN = 12;
  let barPos = null;            // { nx, ny } 또는 null(기본 위치)
  let barPosLoaded = false;

  function loadBarPos() {
    try {
      chrome.storage.local.get([BAR_POS_KEY, BAR_HIDDEN_KEY], (got) => {
        void chrome.runtime.lastError;
        const p = got && got[BAR_POS_KEY];
        barPos = (p && typeof p.nx === 'number' && typeof p.ny === 'number') ? p : null;
        barHidden = !!(got && got[BAR_HIDDEN_KEY]);
        barPosLoaded = true;
        if (barHidden) removeWidget();
        applyBarPos();
      });
    } catch (_) { /* noop */ }
  }

  function saveBarPos() {
    try { chrome.storage.local.set({ [BAR_POS_KEY]: barPos }); } catch (_) { /* noop */ }
  }

  function applyBarPos() {
    if (!widget) return;
    const bar = widget.bar;
    if (!barPos) {
      bar.style.left = ''; bar.style.top = '';
      bar.style.right = BAR_MARGIN + 'px'; bar.style.bottom = BAR_MARGIN + 'px';
      bar.classList.remove('hint-below');
      return;
    }
    const r = bar.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - r.width - BAR_MARGIN * 2);
    const maxY = Math.max(0, window.innerHeight - r.height - BAR_MARGIN * 2);
    bar.style.right = 'auto'; bar.style.bottom = 'auto';
    bar.style.left = Math.round(BAR_MARGIN + barPos.nx * maxX) + 'px';
    bar.style.top = Math.round(BAR_MARGIN + barPos.ny * maxY) + 'px';
    updateHintSide();
  }

  function updateHintSide() {
    if (!widget) return;
    try {
      const r = widget.bar.getBoundingClientRect();
      widget.bar.classList.toggle('hint-below', r.top < 44);
    } catch (_) { /* noop */ }
  }

  function enableDragging(bar) {
    let drag = null;

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;   // 버튼은 그대로 눌린다
      e.preventDefault();
      e.stopPropagation();
      const r = bar.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moved: false };
      bar.classList.add('dragging');
      try { bar.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    });

    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      e.preventDefault();
      drag.moved = true;
      const maxX = Math.max(0, window.innerWidth - drag.w - BAR_MARGIN * 2);
      const maxY = Math.max(0, window.innerHeight - drag.h - BAR_MARGIN * 2);
      const x = Math.min(BAR_MARGIN + maxX, Math.max(BAR_MARGIN, e.clientX - drag.dx));
      const y = Math.min(BAR_MARGIN + maxY, Math.max(BAR_MARGIN, e.clientY - drag.dy));
      bar.style.right = 'auto'; bar.style.bottom = 'auto';
      bar.style.left = Math.round(x) + 'px';
      bar.style.top = Math.round(y) + 'px';
      barPos = { nx: maxX ? (x - BAR_MARGIN) / maxX : 0, ny: maxY ? (y - BAR_MARGIN) / maxY : 0 };
    });

    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      bar.classList.remove('dragging');
      try { bar.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      if (moved) { saveBarPos(); updateHintSide(); }
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    // 두 번 클릭하면 기본 자리(오른쪽 아래)로 되돌린다
    bar.addEventListener('dblclick', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      e.preventDefault(); e.stopPropagation();
      barPos = null;
      applyBarPos();
      saveBarPos();
    });
  }

  const onResize = () => { if (widget && barPos) applyBarPos(); };
  window.addEventListener('resize', onResize);

  onStorageChanged = (changes, area) => {
      if (area !== 'local') return;
      if (changes[BAR_POS_KEY]) {
        const p = changes[BAR_POS_KEY].newValue;
        barPos = (p && typeof p.nx === 'number') ? p : null;
        applyBarPos();
      }
      if (changes[BAR_HIDDEN_KEY]) {
        barHidden = !!changes[BAR_HIDDEN_KEY].newValue;
        if (!IS_TOP) return;
        if (barHidden) removeWidget();
        else if (state.recording) applyState(state, null);
      }
      // 녹화 상태 자체도 직접 지켜본다.
      // 메시지가 닿지 않는 경우에도 바가 화면에 남지 않도록 하는 안전장치.
      if (changes.cg_state && IS_TOP) {
        const ns = changes.cg_state.newValue;
        if (ns && typeof ns.recording === 'boolean') applyState(ns, null);
      }
  };
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_) { /* noop */ }

  function removeWidget() {
    if (widget && widget.host && widget.host.parentNode) widget.host.parentNode.removeChild(widget.host);
    widget = null;
  }

  function hideWidget() { if (widget) widget.host.style.visibility = 'hidden'; }
  function showWidget() { if (widget) widget.host.style.visibility = 'visible'; }

  /* 이 인스턴스가 페이지에 심어 둔 것을 모두 걷어낸다.
   * 새 인스턴스가 주입될 때 호출되어 자리를 넘긴다. */
  window.__CLICKGUIDE_TEARDOWN__ = () => {
    try { document.removeEventListener('pointerdown', onPointerDown, true); } catch (_) { /* noop */ }
    try { document.removeEventListener('change', onChange, true); } catch (_) { /* noop */ }
    try { document.removeEventListener('focusin', onFocusIn, true); } catch (_) { /* noop */ }
    try { window.removeEventListener('message', onWindowMessage, false); } catch (_) { /* noop */ }
    try { window.removeEventListener('beforeunload', onBeforeUnload, true); } catch (_) { /* noop */ }
    try { if (onRuntimeMessage) chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) { /* noop */ }
    try { if (onStorageChanged) chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) { /* noop */ }
    try { window.removeEventListener('resize', onResize); } catch (_) { /* noop */ }
    try { stopKeepAlive(); } catch (_) { /* noop */ }
    try { stopMutationWatch(); } catch (_) { /* noop */ }
    try { removeWidget(); } catch (_) { /* noop */ }
    // 남아 있을 수 있는 다른 인스턴스의 위젯 껍데기도 치운다
    try {
      for (const n of Array.from(document.documentElement.children)) {
        if (n.__clickguideWidget && n.parentNode) n.parentNode.removeChild(n);
      }
    } catch (_) { /* noop */ }
    window.__CLICKGUIDE_TEARDOWN__ = null;
  };

  function flash(rect, failed) {
    const w = ensureWidget();
    if (!w) return;
    const el = document.createElement('div');
    el.className = failed ? 'flash noshot' : 'flash';
    el.style.left = (rect.x - 2) + 'px';
    el.style.top = (rect.y - 2) + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    w.shadow.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 750);
  }
})();
