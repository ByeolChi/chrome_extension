/* CleanShot Picker — content script (격리 world)
 *
 * 다섯 도구로 페이지를 정리한 뒤 현재 화면을 PNG 로 저장한다.
 *   1 지우기 · 2 이동 · 3 크기 · 4 텍스트 · 5 가리기(검정)
 *
 * 원본 DOM 구조는 건드리지 않는다. 모든 변경은 인라인 스타일 한 줄이거나
 * 오버레이 위의 박스이고, 모든 조작은 하나의 작업 스택에 쌓여 Ctrl+Z 로 풀린다.
 *
 * 같은 파일이 다시 주입되면 (아이콘 재클릭) 토글로 동작한다.
 */

(() => {
  'use strict';

  if (window.__cleanShot) {
    window.__cleanShot.toggle();
    return;
  }

  /* ============================================================ 상수와 상태 */

  const HOST_ID = '__cleanshot_host__';
  const MAX_ESCALATE = 6;        // 자동 승격 최대 단계
  const AREA_RATIO = 0.9;        // 부모 면적의 이 비율 이상이면 부모를 대신 선택
  const NUDGE_MERGE_MS = 400;    // 이 안에 이어진 방향키는 한 작업으로 묶는다

  const TOOLS = [
    { id: 'hide',   key: '1', label: '지우기', cursor: 'crosshair' },
    { id: 'move',   key: '2', label: '이동',   cursor: 'move' },
    { id: 'resize', key: '3', label: '크기',   cursor: 'crosshair' },
    { id: 'text',   key: '4', label: '텍스트', cursor: 'text' },
    { id: 'mask',   key: '5', label: '가리기', cursor: 'crosshair' }
  ];

  const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSOR = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize'
  };

  const state = {
    active: false,
    busy: false,
    tool: 'hide',
    forceRemove: false,      // true 면 지우기가 항상 display:none
    barTop: false,
    candidate: null,
    pointer: { x: 0, y: 0 },
    history: [],             // { kind, el, undo, t }
    masks: [],               // { x, y, w, h, el } — x/y 는 문서 좌표
    drag: null,
    editing: null,
    editSnapshot: null,
    justDragged: false
  };

  /* 이동과 크기가 같은 transform 을 나눠 쓴다 */
  const offsets = new WeakMap();

  /* ============================================================ 오버레이 */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;overflow:hidden;' +
    'z-index:2147483647;pointer-events:none;';

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }

      /* 마스크 레이어 — 캡처에 남는다 */
      .masks { position: absolute; inset: 0; pointer-events: none; }
      .mask { position: absolute; background: #000; }

      /* UI 레이어 — 캡처 직전에 사라진다 */
      .ui { position: absolute; inset: 0; pointer-events: none; cursor: default; }
      :host(.capturing) .ui { display: none; }

      .hl {
        position: absolute;
        border: 2px solid #2f6fed;
        background: rgba(47,111,237,0.12);
        border-radius: 3px;
        pointer-events: none;
        display: none;
      }
      .tag {
        position: absolute;
        transform: translateY(-100%);
        margin-top: -4px;
        padding: 2px 6px;
        border-radius: 4px;
        background: #2f6fed;
        color: #fff;
        font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: nowrap;
        pointer-events: none;
        display: none;
        max-width: 60vw;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .marquee {
        position: absolute;
        border: 1px dashed #f2f2f3;
        background: rgba(0,0,0,0.55);
        pointer-events: none;
        display: none;
      }
      .handle {
        position: absolute;
        width: 11px; height: 11px;
        margin: -6px 0 0 -6px;
        border: 1.5px solid #2f6fed;
        background: #fff;
        border-radius: 2px;
        pointer-events: auto;
        display: none;
      }

      .bar {
        position: absolute;
        left: 50%;
        bottom: 24px;
        top: auto;
        transform: translateX(-50%);
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        gap: 6px;
        max-width: 94vw;
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(20,20,22,0.94);
        box-shadow: 0 6px 24px rgba(0,0,0,0.35);
        color: #f2f2f3;
        font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI",
              "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
        pointer-events: auto;
        user-select: none;
        white-space: nowrap;
      }
      .bar.at-top { top: 24px; bottom: auto; }

      .count { font-variant-numeric: tabular-nums; opacity: .85; padding: 0 2px; }
      .status { opacity: .85; font-variant-numeric: tabular-nums; }
      .sep { width: 1px; height: 18px; background: rgba(255,255,255,0.18); }

      button {
        all: unset;
        cursor: pointer;
        padding: 5px 9px;
        border-radius: 8px;
        font: inherit;
        color: #f2f2f3;
        background: rgba(255,255,255,0.10);
      }
      button:hover { background: rgba(255,255,255,0.20); }
      button[disabled] { opacity: .4; cursor: default; }
      button.primary { background: #2f6fed; }
      button.primary:hover { background: #4480f5; }
      button.on { background: #e0a400; color: #1a1a1a; }
      button.tool.sel { background: #2f6fed; color: #fff; }
      .num { opacity: .55; font-size: 11px; padding-left: 3px; }

      .toast {
        position: absolute;
        left: 50%;
        bottom: 96px;
        transform: translateX(-50%);
        padding: 9px 14px;
        border-radius: 10px;
        background: rgba(20,20,22,0.94);
        color: #f2f2f3;
        font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI",
              "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,0.35);
        pointer-events: none;
        display: none;
        max-width: 70vw;
      }
      .toast.at-top { top: 96px; bottom: auto; }
    </style>

    <div class="masks"></div>

    <div class="ui">
      <div class="hl"></div>
      <div class="tag"></div>
      <div class="marquee"></div>
      ${HANDLE_DIRS.map((d) => `<div class="handle" data-dir="${d}" style="cursor:${HANDLE_CURSOR[d]}"></div>`).join('')}
      <div class="toast"></div>
      <div class="bar">
        ${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})">${t.label}<span class="num">${t.key}</span></button>`).join('')}
        <span class="sep"></span>
        <span class="count">0개 작업</span>
        <button class="mode" title="지우기가 빈자리를 남길지 접을지">빈자리 남김</button>
        <button class="undo" disabled title="Ctrl+Z">되돌리기</button>
        <button class="reset" disabled>전체 복원</button>
        <span class="sep"></span>
        <button class="shot primary" title="Enter">캡처</button>
        <span class="status"></span>
        <button class="flip" title="툴바를 위/아래로 (Tab)">⇅</button>
        <button class="close" title="Esc">닫기</button>
      </div>
    </div>
  `;

  const ui = {
    masks: root.querySelector('.masks'),
    layer: root.querySelector('.ui'),
    hl: root.querySelector('.hl'),
    tag: root.querySelector('.tag'),
    marquee: root.querySelector('.marquee'),
    handles: [...root.querySelectorAll('.handle')],
    toast: root.querySelector('.toast'),
    bar: root.querySelector('.bar'),
    tools: [...root.querySelectorAll('.tool')],
    count: root.querySelector('.count'),
    status: root.querySelector('.status'),
    mode: root.querySelector('.mode'),
    undo: root.querySelector('.undo'),
    reset: root.querySelector('.reset'),
    shot: root.querySelector('.shot'),
    flip: root.querySelector('.flip'),
    close: root.querySelector('.close')
  };

  ui.tools.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  ui.mode.addEventListener('click', toggleMode);
  ui.undo.addEventListener('click', undo);
  ui.reset.addEventListener('click', () => { restoreAll(); paintBar(); });
  ui.shot.addEventListener('click', () => captureViewport());
  ui.flip.addEventListener('click', flipBar);
  ui.close.addEventListener('click', deactivate);
  ui.handles.forEach((h) =>
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startResize(e, h.dataset.dir);
    })
  );

  /* 선택 모드 동안의 커서. 우리 UI 는 제외한다. */
  const cursorStyle = document.createElement('style');
  cursorStyle.id = '__cleanshot_cursor__';

  function paintCursor() {
    const t = TOOLS.find((x) => x.id === state.tool);
    cursorStyle.textContent =
      `*:not(#${HOST_ID}):not(#${HOST_ID} *) { cursor: ${t ? t.cursor : 'crosshair'} !important; }`;
  }

  /* ============================================================ 켜고 끄기 */

  const BLOCKED = [
    'click', 'auxclick', 'dblclick', 'mousedown', 'mouseup',
    'contextmenu', 'submit'
  ];

  function activate() {
    if (state.active) return;
    state.active = true;

    (document.body || document.documentElement).appendChild(host);
    paintCursor();
    // 전역 커서 규칙은 문서 전체 스타일 재계산을 부른다. 툴바를 먼저 띄우고 다음 프레임에 건다.
    requestAnimationFrame(() => {
      if (!state.active) return;
      (document.head || document.documentElement).appendChild(cursorStyle);
    });

    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    BLOCKED.forEach((t) => document.addEventListener(t, onBlocked, true));
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);

    readSettings();
    setTool(state.tool);
    paintMode();
    paintBar();
    keepAlive('active');
    toast('지울 요소를 클릭하세요 · 1~5 로 도구 전환', 2200);
  }

  /* 선택 모드가 열려 있는 동안 service worker 를 깨워 둔다.
     MV3 는 30초쯤 놀면 워커를 종료하는데, 그러면 캡처를 누른 순간
     워커가 다시 뜨기를 기다리느라 저장이 늦어진다.
     닫은 뒤에도 5분은 더 깨워 둔다. 한 번 쓰면 대개 연달아 쓰기 때문에,
     두 번째 세 번째 클릭은 워커가 살아 있는 상태에서 받게 된다. */
  const PING_EVERY_MS = 20000;
  const WARM_AFTER_CLOSE_MS = 5 * 60 * 1000;
  let keepTimer = 0;
  let warmUntil = 0;

  function keepAlive(mode) {
    if (mode === 'active') warmUntil = Number.MAX_SAFE_INTEGER;
    else if (mode === 'cooldown') warmUntil = Date.now() + WARM_AFTER_CLOSE_MS;
    else warmUntil = 0;

    if (keepTimer) return;
    keepTimer = setInterval(() => {
      if (Date.now() >= warmUntil) { clearInterval(keepTimer); keepTimer = 0; return; }
      send({ type: 'CLEANSHOT_PING' });
    }, PING_EVERY_MS);
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;

    keepAlive('cooldown');
    endTextEdit();
    restoreAll();
    setCandidate(null);

    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    BLOCKED.forEach((t) => document.removeEventListener(t, onBlocked, true));
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);

    host.classList.remove('capturing');
    host.remove();
    cursorStyle.remove();
  }

  function toggle() {
    state.active ? deactivate() : activate();
  }

  function readSettings() {
    try {
      // 가리기 방식 설정은 없어졌다. 예전 판이 남긴 키는 치운다.
      chrome.storage.sync.remove(['maskStyle', 'settingsVersion']).catch(() => {});
      chrome.storage.sync.get({ forceRemove: false, barTop: false }).then((v) => {
        state.forceRemove = !!v.forceRemove;
        state.barTop = !!v.barTop;
        paintMode();
        paintBarSide();
      }).catch(() => {});
    } catch (_) { /* storage 권한이 없어도 동작한다 */ }
  }

  function writeSettings() {
    try {
      chrome.storage.sync.set({
        forceRemove: state.forceRemove,
        barTop: state.barTop
      }).catch(() => {});
    } catch (_) { /* 무시 */ }
  }

  /* ============================================================ 도구 전환 */

  function setTool(id) {
    if (!TOOLS.some((t) => t.id === id)) return;
    if (state.editing && id !== 'text') endTextEdit();
    state.tool = id;
    ui.tools.forEach((b) => b.classList.toggle('sel', b.dataset.tool === id));
    paintCursor();
    layoutHandles();
  }

  function toggleMode() {
    state.forceRemove = !state.forceRemove;
    paintMode();
    writeSettings();
  }

  function paintMode() {
    ui.mode.textContent = state.forceRemove ? '빈자리 제거' : '빈자리 남김';
    ui.mode.classList.toggle('on', state.forceRemove);
  }

  function flipBar() {
    state.barTop = !state.barTop;
    paintBarSide();
    writeSettings();
  }

  function paintBarSide() {
    ui.bar.classList.toggle('at-top', state.barTop);
    ui.toast.classList.toggle('at-top', state.barTop);
  }

  /* ============================================================ 작업 스택 */

  function push(kind, el, undoFn, mergeable) {
    state.history.push({ kind, el, undo: undoFn, t: Date.now(), mergeable: !!mergeable });
    paintBar();
  }

  /* 방향키 미세 조정은 짧은 시간 안에 이어지면 한 작업으로 묶는다.
     드래그처럼 이미 완결된 작업에는 붙지 않는다 (mergeable 플래그). */
  function pushNudge(kind, el, undoFn) {
    const last = state.history[state.history.length - 1];
    const now = Date.now();
    if (last && last.mergeable && last.kind === kind && last.el === el &&
        now - last.t < NUDGE_MERGE_MS) {
      last.t = now;
      return;
    }
    push(kind, el, undoFn, true);
  }

  function undo() {
    const op = state.history.pop();
    if (!op) return;
    try { op.undo(); } catch (err) { console.warn('[CleanShot] 되돌리기 실패:', err); }
    paintBar();
    reposition();
  }

  function restoreAll() {
    while (state.history.length) {
      const op = state.history.pop();
      try { op.undo(); } catch (_) { /* 계속 진행 */ }
    }
    paintBar();
  }

  function paintBar() {
    const n = state.history.length;
    ui.count.textContent = `${n}개 작업`;
    ui.undo.disabled = n === 0;
    ui.reset.disabled = n === 0;
  }

  function setStatus(text) {
    ui.status.textContent = text || '';
  }

  /* 스타일 속성 전체를 스냅샷으로 떠서 되돌린다.
     빈 style="" 은 남기지 않는다 — 원래 없던 속성이 생긴 것처럼 보이면 안 된다. */
  function snapStyle(el) {
    const prev = el.getAttribute('style');
    const prevOffset = offsets.get(el);
    return () => {
      if (!prev) el.removeAttribute('style');
      else el.setAttribute('style', prev);
      if (prevOffset) offsets.set(el, prevOffset);
      else offsets.delete(el);
      tidyStyle(el);
    };
  }

  function tidyStyle(el) {
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  /* ============================================================ 후보 고르기 */

  function pickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === host) return null;
    if (el === document.body || el === document.documentElement) return null;
    return escalate(el);
  }

  /* 클릭한 것이 부모와 거의 같은 크기라면 부모가 진짜 대상일 확률이 높다. */
  function escalate(el) {
    let cur = el;
    for (let i = 0; i < MAX_ESCALATE; i++) {
      const p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      const a = areaOf(cur);
      const pa = areaOf(p);
      if (pa > 0 && a / pa >= AREA_RATIO) cur = p;
      else break;
    }
    return cur;
  }

  function areaOf(el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function setCandidate(el) {
    state.candidate = el;
    reposition();
  }

  function reposition() {
    paintHighlight();
    layoutHandles();
    layoutMasks();
  }

  function paintHighlight() {
    const el = state.candidate;
    if (!el || !el.isConnected) {
      ui.hl.style.display = 'none';
      ui.tag.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      ui.hl.style.display = 'none';
      ui.tag.style.display = 'none';
      return;
    }
    ui.hl.style.display = 'block';
    ui.hl.style.left = r.left + 'px';
    ui.hl.style.top = r.top + 'px';
    ui.hl.style.width = r.width + 'px';
    ui.hl.style.height = r.height + 'px';

    ui.tag.style.display = 'block';
    ui.tag.style.left = Math.max(2, r.left) + 'px';
    ui.tag.style.top = Math.max(16, r.top) + 'px';
    ui.tag.textContent = `${label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function layoutHandles() {
    const el = state.candidate;
    const show = state.tool === 'resize' && el && el.isConnected;
    if (!show) {
      ui.handles.forEach((h) => { h.style.display = 'none'; });
      return;
    }
    const r = el.getBoundingClientRect();
    const px = { w: r.left, e: r.right, n: r.top, s: r.bottom };
    const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    ui.handles.forEach((h) => {
      const d = h.dataset.dir;
      const x = d.includes('w') ? px.w : d.includes('e') ? px.e : mid.x;
      const y = d.includes('n') ? px.n : d.includes('s') ? px.s : mid.y;
      h.style.display = 'block';
      h.style.left = x + 'px';
      h.style.top = y + 'px';
    });
  }

  function label(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  }

  /* ============================================================ 1 지우기 */

  function hideEl(el) {
    if (!usable(el)) return;

    const pos = getComputedStyle(el).position;
    const outOfFlow = pos === 'fixed' || pos === 'sticky' || pos === 'absolute';
    const removeSpace = state.forceRemove || outOfFlow;
    const restore = snapStyle(el);

    if (removeSpace) el.style.setProperty('display', 'none', 'important');
    else el.style.setProperty('visibility', 'hidden', 'important');

    push('hide', el, restore);
    setCandidate(null);
  }

  /* ============================================================ 2 이동 */

  function getOffset(el) {
    return offsets.get(el) || { tx: 0, ty: 0 };
  }

  function setOffset(el, tx, ty) {
    offsets.set(el, { tx, ty });
    if (!tx && !ty) {
      if (el.style.transform) el.style.removeProperty('transform');
      tidyStyle(el);
      return;
    }
    el.style.setProperty('transform', `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`, 'important');
  }

  function startMove(e) {
    const el = state.candidate;
    if (!usable(el)) return;
    const o = getOffset(el);
    state.drag = {
      kind: 'move', el,
      x0: e.clientX, y0: e.clientY,
      tx0: o.tx, ty0: o.ty,
      restore: snapStyle(el),
      moved: false
    };
  }

  function updateMove(e) {
    const d = state.drag;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    setOffset(d.el, d.tx0 + dx, d.ty0 + dy);
    reposition();
  }

  function nudge(dx, dy) {
    const el = state.candidate;
    if (!usable(el)) return;
    const restore = snapStyle(el);
    const o = getOffset(el);
    setOffset(el, o.tx + dx, o.ty + dy);
    pushNudge('move', el, restore);
    reposition();
  }

  /* ============================================================ 3 크기 */

  function startResize(e, dir) {
    const el = state.candidate;
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    const o = getOffset(el);
    state.drag = {
      kind: 'resize', el, dir,
      x0: e.clientX, y0: e.clientY,
      w0: r.width, h0: r.height,
      tx0: o.tx, ty0: o.ty,
      ratio: r.height > 0 ? r.width / r.height : 1,
      restore: snapStyle(el),
      moved: false
    };
  }

  function updateResize(e) {
    const d = state.drag;
    let dw = e.clientX - d.x0;
    let dh = e.clientY - d.y0;
    if (d.dir.includes('w')) dw = -dw;
    if (d.dir.includes('n')) dh = -dh;
    if (!d.dir.includes('e') && !d.dir.includes('w')) dw = 0;
    if (!d.dir.includes('n') && !d.dir.includes('s')) dh = 0;
    if (Math.abs(dw) > 2 || Math.abs(dh) > 2) d.moved = true;

    let w = Math.max(8, d.w0 + dw);
    let h = Math.max(8, d.h0 + dh);
    if (e.shiftKey && d.ratio > 0) {
      if (dw !== 0) h = w / d.ratio;
      else w = h * d.ratio;
    }
    applySize(d.el, w, h);

    // 위/왼쪽에서 끌면 반대편 모서리가 제자리에 있도록 밀어준다
    const shiftX = d.dir.includes('w') ? -(w - d.w0) : 0;
    const shiftY = d.dir.includes('n') ? -(h - d.h0) : 0;
    setOffset(d.el, d.tx0 + shiftX, d.ty0 + shiftY);
    reposition();
  }

  function applySize(el, w, h) {
    el.style.setProperty('width', Math.round(w) + 'px', 'important');
    el.style.setProperty('height', Math.round(h) + 'px', 'important');
    el.style.setProperty('max-width', 'none', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('min-width', '0', 'important');
    el.style.setProperty('min-height', '0', 'important');

    const parent = el.parentElement;
    const pd = parent ? getComputedStyle(parent).display : '';
    if (pd === 'flex' || pd === 'inline-flex') el.style.setProperty('flex', '0 0 auto', 'important');
    if (pd === 'grid' || pd === 'inline-grid') el.style.setProperty('grid-area', 'auto', 'important');

    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
      el.style.setProperty('object-fit', 'contain', 'important');
    }
  }

  function nudgeSize(dw, dh) {
    const el = state.candidate;
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    const restore = snapStyle(el);
    applySize(el, Math.max(8, r.width + dw), Math.max(8, r.height + dh));
    pushNudge('resize', el, restore);
    reposition();
  }

  /* ============================================================ 4 텍스트 */

  function startTextEdit(x, y) {
    let target = null;
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (range && range.startContainer && range.startContainer.nodeType === 3) {
      target = range.startContainer.parentElement;
    }
    if (!target) target = pickAt(x, y);
    if (!usable(target)) return;

    endTextEdit();

    state.editing = target;
    state.editSnapshot = {
      el: target,
      html: target.innerHTML,
      ce: target.getAttribute('contenteditable'),
      spell: target.getAttribute('spellcheck')
    };

    target.setAttribute('contenteditable', 'plaintext-only');
    target.setAttribute('spellcheck', 'false');
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }

    if (range) {
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }

    setCandidate(null);
    toast('고쳐 쓰고 Esc 를 누르세요', 1800);
  }

  function endTextEdit() {
    const snap = state.editSnapshot;
    state.editing = null;
    state.editSnapshot = null;
    if (!snap) return;

    const { el, html, ce, spell } = snap;
    const changed = el.innerHTML !== html;

    if (ce === null) el.removeAttribute('contenteditable');
    else el.setAttribute('contenteditable', ce);
    if (spell === null) el.removeAttribute('spellcheck');
    else el.setAttribute('spellcheck', spell);
    try { el.blur(); } catch (_) { /* 무시 */ }

    if (!changed) return;
    push('text', el, () => {
      el.innerHTML = html;
      if (ce === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', ce);
    });
  }

  /* ============================================================ 5 가리기 */

  function addMask(docRect) {
    const el = document.createElement('div');
    el.className = 'mask';
    ui.masks.appendChild(el);

    const m = { ...docRect, el };
    state.masks.push(m);
    layoutMasks();

    push('mask', null, () => {
      const i = state.masks.indexOf(m);
      if (i >= 0) state.masks.splice(i, 1);
      m.el.remove();
    });
  }

  function maskElement(el) {
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    setCandidate(null);
    addMask({
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height
    });
  }


  function startMarquee(e) {
    state.drag = {
      kind: 'marquee',
      x0: e.clientX, y0: e.clientY,
      moved: false
    };
    ui.marquee.style.display = 'block';
    updateMarquee(e);
  }

  function updateMarquee(e) {
    const d = state.drag;
    const x = Math.min(d.x0, e.clientX);
    const y = Math.min(d.y0, e.clientY);
    const w = Math.abs(e.clientX - d.x0);
    const h = Math.abs(e.clientY - d.y0);
    if (w > 3 || h > 3) d.moved = true;
    Object.assign(ui.marquee.style, {
      left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px'
    });
    d.rect = { x, y, w, h };
  }

  function endMarquee(d) {
    ui.marquee.style.display = 'none';
    if (d.moved && d.rect && d.rect.w > 4 && d.rect.h > 4) {
      addMask({
        x: d.rect.x + window.scrollX,
        y: d.rect.y + window.scrollY,
        w: d.rect.w,
        h: d.rect.h
      });
    }
  }

  function layoutMasks() {
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const m of state.masks) {
      Object.assign(m.el.style, {
        left: (m.x - sx) + 'px',
        top: (m.y - sy) + 'px',
        width: m.w + 'px',
        height: m.h + 'px'
      });
    }
  }

  /* ============================================================ 이벤트 */

  function usable(el) {
    return !!el && el.isConnected && el !== host &&
      el !== document.body && el !== document.documentElement;
  }

  function inOurUI(e) {
    return typeof e.composedPath === 'function' && e.composedPath().includes(host);
  }

  function inEditing(e) {
    if (!state.editing || typeof e.composedPath !== 'function') return false;
    return e.composedPath().includes(state.editing);
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onPointerMove(e) {
    if (state.drag) {
      block(e);
      if (state.drag.kind === 'move') updateMove(e);
      else if (state.drag.kind === 'resize') updateResize(e);
      else if (state.drag.kind === 'marquee') updateMarquee(e);
      return;
    }
    if (inOurUI(e)) return;
    state.pointer.x = e.clientX;
    state.pointer.y = e.clientY;
    if (state.busy || state.editing) return;
    setCandidate(pickAt(e.clientX, e.clientY));
  }

  function onPointerDown(e) {
    if (inOurUI(e) || inEditing(e)) return;
    if (state.busy) { block(e); return; }
    block(e);

    if (state.tool === 'move') startMove(e);
    else if (state.tool === 'mask' && e.shiftKey) startMarquee(e);
    else if (state.tool === 'mask' && !state.candidate) startMarquee(e);
  }

  function onPointerUp(e) {
    if (!state.drag) return;
    block(e);
    const d = state.drag;
    state.drag = null;
    state.justDragged = d.moved;

    if (d.kind === 'marquee') endMarquee(d);
    else if (d.moved) push(d.kind, d.el, d.restore);
    else if (d.restore) d.restore(); // 움직이지 않았으면 없던 일로

    setTimeout(() => { state.justDragged = false; }, 0);
    reposition();
  }

  function onBlocked(e) {
    if (inOurUI(e) || inEditing(e)) return;
    block(e);

    if (e.type !== 'click' || state.busy || state.justDragged) return;

    if (state.tool === 'hide') hideEl(state.candidate || pickAt(e.clientX, e.clientY));
    else if (state.tool === 'text') startTextEdit(e.clientX, e.clientY);
    else if (state.tool === 'mask') maskElement(state.candidate || pickAt(e.clientX, e.clientY));
  }

  function onKey(e) {
    // 편집 중에는 Esc 만 가로챈다. 나머지는 그대로 입력되어야 한다.
    if (state.editing) {
      if (e.key === 'Escape') { block(e); endTextEdit(); }
      return;
    }

    if (e.key === 'Escape') {
      block(e);
      deactivate();
      return;
    }

    if (state.busy) { block(e); return; }

    const tool = TOOLS.find((t) => t.key === e.key);
    if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) {
      block(e);
      setTool(tool.id);
      toast(tool.label, 900);
      return;
    }

    if (e.key === 'Enter') {
      block(e);
      captureViewport();
      return;
    }

    if (e.key === 'Tab') { block(e); flipBar(); return; }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      block(e); undo(); return;
    }

    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = arrows[e.key];
    if (!dir) return;
    block(e);

    if (state.tool === 'move') { nudge(dir[0] * step, dir[1] * step); return; }
    if (state.tool === 'resize') { nudgeSize(dir[0] * step, dir[1] * step); return; }

    // 지우기 · 텍스트 · 가리기에서는 선택 범위를 오르내린다
    if (e.key === 'ArrowUp') {
      const p = state.candidate && state.candidate.parentElement;
      if (p && p !== document.body && p !== document.documentElement) setCandidate(p);
    } else if (e.key === 'ArrowDown') {
      descend();
    }
  }

  /* 커서 아래의 가장 깊은 요소를 향해 한 단계 내려간다. */
  function descend() {
    const deep = document.elementFromPoint(state.pointer.x, state.pointer.y);
    if (!deep || deep === host || !state.candidate) return;
    if (deep === state.candidate) return;

    let cur = deep;
    while (cur.parentElement && cur.parentElement !== state.candidate) cur = cur.parentElement;
    if (cur.parentElement === state.candidate) setCandidate(cur);
  }

  /* ============================================================ 캡처 */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: '응답이 없습니다.' });
        });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  async function captureViewport() {
    if (state.busy) return;
    state.busy = true;
    lockBar(true);
    endTextEdit();
    setCandidate(null);
    setStatus('캡처 중…');

    host.classList.add('capturing');
    await uiGone();

    const res = await send({ type: 'CLEANSHOT_CAPTURE', pageUrl: location.href });

    host.classList.remove('capturing');
    setStatus('');
    lockBar(false);
    state.busy = false;

    if (res && res.ok) { finish(`저장했습니다 · ${short(res.filename)}`); return; }
    toast(`캡처 실패 · ${(res && res.error) || '알 수 없는 오류'}`, 3200);
  }

  function lockBar(on) {
    ui.shot.disabled = on;
  }

  function finish(message) {
    restoreAll();
    toast(message, 2200);
    setTimeout(deactivate, 700);
  }

  /* ============================================================ 유틸 */

  let toastTimer = 0;
  function toast(text, ms) {
    ui.toast.textContent = text;
    ui.toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.style.display = 'none'; }, ms || 2000);
  }

  function short(path) {
    return String(path || '').split('/').pop();
  }

  function nextPaint() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  /* 확장 UI 를 숨긴 화면이 실제로 합성될 때까지만 기다린다.
     고정 지연 대신 프레임 두 개 — 브라우저가 그림을 내보낸 뒤에야 캡처한다. */
  function uiGone() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // 마지막 프레임이 화면에 올라간 직후로 미룬다
        setTimeout(resolve, 0);
      }));
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ============================================================ 시작 */

  /* 두 번째부터는 40KB 를 다시 컴파일하지 않고 메시지로 토글한다 */
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (!msg || msg.type !== 'CLEANSHOT_TOGGLE') return;
      toggle();
      respond({ ok: true, active: state.active });
      return false;
    });
  } catch (_) { /* 무시 */ }

  window.__cleanShot = { toggle, activate, deactivate, setTool, state };
  activate();
})();
