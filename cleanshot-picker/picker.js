/* CleanShot Picker — content script (격리 world)
 *
 * 다섯 도구로 페이지를 정리한 뒤 현재 화면을 PNG 로 저장한다.
 *   1 지우기 · 2 이동 · 3 크기 · 4 텍스트 · 5 가리기(검정)
 *
 * 원본 DOM 구조는 건드리지 않는다. 모든 변경은 인라인 스타일 한 줄이거나
 * 오버레이 위의 박스이고, 모든 조작은 하나의 작업 스택에 쌓여 Ctrl+Z 로 풀린다.
 * 텍스트 도구만 글자를 바꾸는데, 되돌릴 때 원래 노드 객체를 그대로 제자리에 돌려놓는다.
 *
 * 같은 파일이 다시 주입되면 (아이콘 재클릭) 토글로 동작한다.
 */

(() => {
  'use strict';

  if (window.__cleanShot) {
    window.__cleanShot.toggle();
    return;
  }

  /* 화면 위치 계산(요소의 화면 좌표, iframe 위치, 스크롤 영역에 잘린 부분)은 공용 가리기 코어를 쓴다.
     ClickGuide 도 같은 코드로 가릴 곳을 잰다. 코어는 이 파일보다 먼저 주입된다(background.js 의 INJECT_FILES). */
  const RC = globalThis.RedactCore;
  if (!RC) {
    console.error('[CleanShot] 공용 가리기 코어(shared/redact-core.js)가 실리지 않았습니다.');
    return;
  }
  const { styleOf, parentOf, frameOf, contentBox, docOffset, viewSize, rectOf, intersect, clipVisible } = RC;

  /* ============================================================ 상수와 상태 */

  const HOST_ID = '__cleanshot_host__';
  const MAX_ESCALATE = 6;        // 자동 승격 최대 단계
  const AREA_RATIO = 0.9;        // 부모 면적의 이 비율 이상이면 부모를 대신 선택
  const NUDGE_MERGE_MS = 400;    // 이 안에 이어진 방향키는 한 작업으로 묶는다
  const FRAME_TAGS = 'iframe, frame, object, embed';

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
    pointer: { x: 0, y: 0 }, // 최상위 화면 좌표
    history: [],             // { kind, el, undo, t }
    masks: [],               // { box, anchor, size, view, last } — "5 가리기" 참고
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
  /* popover 로 띄워 top layer 에 올린다. <dialog>(showModal)·popover 는 z-index 와
     상관없이 그 위에 그려지므로, 그냥 두면 툴바와 가리기 박스가 그 아래에 깔린다. */
  host.setAttribute('popover', 'manual');
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;overflow:hidden;' +
    'z-index:2147483647;pointer-events:none;';

  /* closed — 페이지 스크립트가 host.shadowRoot 로 들어와 버튼을 누를 수 없게 */
  const root = host.attachShadow({ mode: 'closed' });
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
      startResize(pt(e), h.dataset.dir);
    })
  );

  /* 선택 모드 동안의 커서. 우리 UI 는 제외한다. */
  const cursorStyle = document.createElement('style');
  cursorStyle.id = '__cleanshot_cursor__';

  function cursorCss() {
    const t = TOOLS.find((x) => x.id === state.tool);
    return `*:not(#${HOST_ID}):not(#${HOST_ID} *) { cursor: ${t ? t.cursor : 'crosshair'} !important; }`;
  }

  function paintCursor() {
    const css = cursorCss();
    cursorStyle.textContent = css;
    for (const s of frameStyles.values()) s.textContent = css;
  }

  /* 오버레이를 붙일 자리. 모달 <dialog> 가 열려 있으면 그 바깥은 전부 inert 라서
     top layer 에 올려도 툴바를 누를 수 없다. 그때는 가장 위의 모달 안에 붙인다. */
  function hostParent() {
    let modal = null;
    try {
      const list = document.querySelectorAll('dialog:modal');
      modal = list.length ? list[list.length - 1] : null;
    } catch (_) { /* :modal 을 모르는 브라우저 */ }
    return modal || document.body || document.documentElement;
  }

  function mountHost() {
    const parent = hostParent();
    if (host.parentNode !== parent) parent.appendChild(host);
    raise();
  }

  /* top layer 는 나중에 연 것이 위다. 닫았다 다시 열어 맨 위로 올린다. */
  function raise() {
    if (typeof host.showPopover !== 'function') return; // 지원하지 않으면 z-index 로 버틴다
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (_) { /* 연결되지 않았거나 이미 열린 상태 */ }
  }

  /* 모달이 열리고 닫히는 것(open 속성)과 새로 생기는 iframe 을 지켜본다 */
  const pageWatch = new MutationObserver((records) => {
    if (!state.active) return;
    let remount = !host.isConnected;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.localName === 'dialog') remount = true;
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n === host) continue;
        if (n.matches(FRAME_TAGS)) watchFrame(n);
        else if (n.firstElementChild) n.querySelectorAll(FRAME_TAGS).forEach(watchFrame);
      }
    }
    if (remount) mountHost();
  });

  /* ============================================================ 켜고 끄기 */

  const BLOCKED = [
    'click', 'auxclick', 'dblclick', 'mousedown', 'mouseup',
    'contextmenu', 'submit'
  ];

  function activate() {
    if (state.active) return;
    state.active = true;

    mountHost();
    paintCursor();
    // 전역 커서 규칙은 문서 전체 스타일 재계산을 부른다. 툴바를 먼저 띄우고 다음 프레임에 건다.
    requestAnimationFrame(() => {
      if (!state.active) return;
      (document.head || document.documentElement).appendChild(cursorStyle);
    });

    attachDoc(document);
    try {
      pageWatch.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['open']
      });
    } catch (_) { /* 무시 */ }

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

    pageWatch.disconnect();
    for (const d of [...docs]) detachDoc(d);
    unblindAll();

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

  /* ============================================================ 프레임
   * 같은 출처 iframe 은 안쪽 문서에도 같은 리스너를 걸어 그 안의 요소까지 고른다.
   * 다른 출처 iframe 은 안을 볼 수 없다. 선택 모드 동안 pointer-events 를 꺼서
   * 클릭이 iframe 안으로 새지 않게 하고, iframe 전체를 한 요소로 고르게 한다.
   */

  const docs = new Set();          // 리스너를 건 문서 (최상위 포함)
  const frameStyles = new Map();   // iframe 문서 → 커서 <style>
  const blinded = new Map();       // 다른 출처 iframe → 원래 pointer-events

  function attachDoc(doc) {
    if (!doc || docs.has(doc)) return;
    const win = doc.defaultView;
    if (!win) return;
    docs.add(doc);

    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    BLOCKED.forEach((t) => doc.addEventListener(t, onBlocked, true));
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('load', onFrameLoad, true);
    win.addEventListener('scroll', reposition, true);
    win.addEventListener('resize', reposition, true);

    if (doc !== document) {
      try {
        const s = doc.createElement('style');
        s.textContent = cursorCss();
        (doc.head || doc.documentElement).appendChild(s);
        frameStyles.set(doc, s);
      } catch (_) { /* 무시 */ }
    }
    try { doc.querySelectorAll(FRAME_TAGS).forEach(watchFrame); } catch (_) { /* 무시 */ }
  }

  function detachDoc(doc) {
    docs.delete(doc);
    try {
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      BLOCKED.forEach((t) => doc.removeEventListener(t, onBlocked, true));
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('load', onFrameLoad, true);
      const win = doc.defaultView;
      if (win) {
        win.removeEventListener('scroll', reposition, true);
        win.removeEventListener('resize', reposition, true);
      }
    } catch (_) { /* 이미 사라진 문서 */ }
    const s = frameStyles.get(doc);
    if (s) { s.remove(); frameStyles.delete(doc); }
  }

  /* iframe 안 문서를 고를 수 있으면 리스너를 걸고, 못 보면 눈을 가린다 */
  function watchFrame(f) {
    if (!state.active || !f || f.nodeType !== 1) return;
    const d = f.localName === 'embed' ? null : frameDoc(f);
    if (d) { unblind(f); attachDoc(d); }
    else blind(f);
  }

  function onFrameLoad(e) {
    const f = e.target;
    if (f && f.nodeType === 1 && f.matches(FRAME_TAGS)) watchFrame(f);
  }

  function frameDoc(f) {
    try {
      const d = f.contentDocument;
      return d && d.documentElement ? d : null;
    } catch (_) {
      return null;
    }
  }

  function isFrameEl(el) {
    return el.localName === 'iframe' || el.localName === 'frame' || el.localName === 'object';
  }

  function blind(f) {
    if (blinded.has(f)) return;
    blinded.set(f, {
      value: f.style.getPropertyValue('pointer-events'),
      priority: f.style.getPropertyPriority('pointer-events')
    });
    f.style.setProperty('pointer-events', 'none', 'important');
  }

  function unblind(f) {
    const prev = blinded.get(f);
    if (!prev) return;
    blinded.delete(f);
    if (prev.value) f.style.setProperty('pointer-events', prev.value, prev.priority);
    else f.style.removeProperty('pointer-events');
    tidyStyle(f);
  }

  function unblindAll() {
    for (const f of [...blinded.keys()]) unblind(f);
  }

  /* ============================================================ 좌표
   * 모든 좌표는 "최상위 화면 좌표"(최상위 문서의 viewport 기준 CSS px)로 다룬다.
   * iframe 안 요소는 그 iframe 의 내용 영역 위치를 더해 바꾼다.
   * 계산 함수(rectOf·docOffset·clipVisible 등)는 맨 위에서 공용 가리기 코어(RC)에서 꺼내 쓴다.
   */

  /* 이벤트 좌표를 최상위 화면 좌표로 */
  function pt(e) {
    const doc = (e.view && e.view.document) || (e.target && e.target.ownerDocument) || document;
    if (doc === document) return { x: e.clientX, y: e.clientY };
    const o = docOffset(doc);
    return { x: e.clientX + o.x, y: e.clientY + o.y };
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

  /* 최상위 화면 좌표 (x, y) 아래에 실제로 보이는 가장 깊은 요소와, 그 요소가 속한 문서·문서 안 좌표.
     shadow DOM(open·closed)과 같은 출처 iframe 안까지 내려간다. */
  function probe(x, y) {
    let doc = document;
    let lx = x;
    let ly = y;
    let el = null;
    for (let depth = 0; depth < 8; depth++) {
      el = doc.elementFromPoint(lx, ly);
      if (!el || el === host) return { el: null, doc, x: lx, y: ly };
      el = blindedAt(doc, lx, ly, el) || el;
      for (let i = 0; i < 32; i++) {
        const sr = shadowOf(el);
        if (!sr) break;
        const inner = sr.elementFromPoint(lx, ly);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!isFrameEl(el)) break;
      const d = frameDoc(el);
      if (!d) break;
      const b = contentBox(el);
      if (lx < b.x || ly < b.y || lx >= b.x + b.w || ly >= b.y + b.h) break; // 테두리를 맞혔다
      const inner = d.elementFromPoint(lx - b.x, ly - b.y);
      if (!inner || isRoot(inner)) break; // 안이 비어 있으면 iframe 자체를 고른다
      doc = d;
      lx -= b.x;
      ly -= b.y;
    }
    return { el, doc, x: lx, y: ly };
  }

  function hitAt(x, y) {
    return probe(x, y).el;
  }

  function shadowOf(el) {
    if (el === host) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot)
        ? chrome.dom.openOrClosedShadowRoot(el) || null
        : null;
    } catch (_) {
      return null;
    }
  }

  /* pointer-events 를 끈 다른 출처 iframe 은 elementFromPoint 에 잡히지 않는다.
     좌표가 그 iframe 안이고, 맞은 요소가 iframe 을 품고 있으면(= iframe 이 그 위에 그려져 있으면) iframe 을 고른다. */
  function blindedAt(doc, x, y, top) {
    let best = null;
    for (const f of blinded.keys()) {
      if (f.ownerDocument !== doc || !f.isConnected) continue;
      const r = f.getBoundingClientRect();
      if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) continue;
      if (top !== f && !isRoot(top) && !top.contains(f)) continue;
      best = f;
    }
    return best;
  }

  function pickAt(x, y) {
    const el = hitAt(x, y);
    if (!usable(el)) return null;
    return escalate(el);
  }

  /* 클릭한 것이 부모와 거의 같은 크기라면 부모가 진짜 대상일 확률이 높다. */
  function escalate(el) {
    let cur = el;
    for (let i = 0; i < MAX_ESCALATE; i++) {
      const p = parentOf(cur);
      if (!p || isRoot(p)) break;
      const a = areaOf(cur);
      const pa = areaOf(p);
      if (pa > 0 && a / pa >= AREA_RATIO) cur = p;
      else break;
    }
    return cur;
  }

  /* ↑ 키로 올라갈 때: iframe 안 맨 위 요소의 위는 그 iframe 이다 */
  function upOf(el) {
    const p = parentOf(el);
    if (p && !isRoot(p)) return p;
    return frameOf(el.ownerDocument);
  }

  function containsDeep(anc, el) {
    for (let cur = el, i = 0; cur && i < 256; cur = parentOf(cur), i++) {
      if (cur === anc) return true;
    }
    return false;
  }

  function isRoot(el) {
    const d = el.ownerDocument;
    return !d || el === d.documentElement || el === d.body;
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
    const r = rectOf(el);
    if (r.w <= 0 || r.h <= 0) {
      ui.hl.style.display = 'none';
      ui.tag.style.display = 'none';
      return;
    }
    ui.hl.style.display = 'block';
    ui.hl.style.left = r.x + 'px';
    ui.hl.style.top = r.y + 'px';
    ui.hl.style.width = r.w + 'px';
    ui.hl.style.height = r.h + 'px';

    ui.tag.style.display = 'block';
    ui.tag.style.left = Math.max(2, r.x) + 'px';
    ui.tag.style.top = Math.max(16, r.y) + 'px';
    ui.tag.textContent = `${label(el)}  ${Math.round(r.w)}×${Math.round(r.h)}`;
  }

  function layoutHandles() {
    const el = state.candidate;
    const show = state.tool === 'resize' && el && el.isConnected;
    if (!show) {
      ui.handles.forEach((h) => { h.style.display = 'none'; });
      return;
    }
    const r = rectOf(el);
    const px = { w: r.x, e: r.x + r.w, n: r.y, s: r.y + r.h };
    const mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
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

    const pos = styleOf(el).position;
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

  function startMove(p) {
    const el = state.candidate;
    if (!usable(el)) return;
    const o = getOffset(el);
    state.drag = {
      kind: 'move', el,
      x0: p.x, y0: p.y,
      tx0: o.tx, ty0: o.ty,
      restore: snapStyle(el),
      moved: false
    };
  }

  function updateMove(p) {
    const d = state.drag;
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
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

  function startResize(p, dir) {
    const el = state.candidate;
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    const o = getOffset(el);
    state.drag = {
      kind: 'resize', el, dir,
      x0: p.x, y0: p.y,
      w0: r.width, h0: r.height,
      tx0: o.tx, ty0: o.ty,
      ratio: r.height > 0 ? r.width / r.height : 1,
      restore: snapStyle(el),
      moved: false
    };
  }

  function updateResize(p, shiftKey) {
    const d = state.drag;
    let dw = p.x - d.x0;
    let dh = p.y - d.y0;
    if (d.dir.includes('w')) dw = -dw;
    if (d.dir.includes('n')) dh = -dh;
    if (!d.dir.includes('e') && !d.dir.includes('w')) dw = 0;
    if (!d.dir.includes('n') && !d.dir.includes('s')) dh = 0;
    if (Math.abs(dw) > 2 || Math.abs(dh) > 2) d.moved = true;

    let w = Math.max(8, d.w0 + dw);
    let h = Math.max(8, d.h0 + dh);
    if (shiftKey && d.ratio > 0) {
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

  /* 레이아웃상의 부모. shadow DOM 의 slot 과 display:contents 를 건너뛴다. */
  function layoutParent(el) {
    let p = el.assignedSlot || parentOf(el);
    for (let i = 0; p && i < 32 && styleOf(p).display === 'contents'; i++) {
      p = p.assignedSlot || parentOf(p);
    }
    return p;
  }

  function applySize(el, w, h) {
    el.style.setProperty('width', Math.round(w) + 'px', 'important');
    el.style.setProperty('height', Math.round(h) + 'px', 'important');
    el.style.setProperty('max-width', 'none', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('min-width', '0', 'important');
    el.style.setProperty('min-height', '0', 'important');

    const parent = layoutParent(el);
    const pd = parent ? styleOf(parent).display : '';
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

  /* 커서 위치. shadow DOM 안이면 그 shadow root 들을 넘겨야 안쪽 위치를 돌려준다(Chrome 128+).
     그렇지 않으면 caretRangeFromPoint 는 호스트 바깥 위치를 돌려준다. */
  function caretAt(doc, x, y, deep) {
    const roots = [];
    for (let n = deep, i = 0; n && i < 32; i++) {
      const r = n.getRootNode();
      if (!r || !r.host) break;
      roots.push(r);
      n = r.host;
    }
    if (roots.length && typeof doc.caretPositionFromPoint === 'function') {
      try {
        const p = doc.caretPositionFromPoint(x, y, { shadowRoots: roots });
        if (p && p.offsetNode && p.offsetNode.nodeType === 3) {
          const range = doc.createRange();
          range.setStart(p.offsetNode, p.offset);
          range.collapse(true);
          return range;
        }
      } catch (_) { /* 옛 브라우저 */ }
    }
    try {
      return doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
    } catch (_) {
      return null;
    }
  }

  function startTextEdit(x, y) {
    const spot = probe(x, y);
    let range = caretAt(spot.doc, spot.x, spot.y, spot.el);
    let target = null;
    if (range && range.startContainer && range.startContainer.nodeType === 3) {
      target = range.startContainer.parentElement;
    }
    // shadow DOM 안의 글자를 눌렀는데 위치를 못 받았으면, 맞은 요소를 그대로 쓴다
    if (!target && spot.el && spot.el.getRootNode() !== spot.el.ownerDocument) target = spot.el;
    if (!target) { target = pickAt(x, y); range = null; }
    if (!usable(target)) return;

    endTextEdit();

    state.editing = target;
    state.editSnapshot = {
      el: target,
      html: target.innerHTML,
      tree: snapTree(target),
      ce: target.getAttribute('contenteditable'),
      spell: target.getAttribute('spellcheck')
    };

    target.setAttribute('contenteditable', 'plaintext-only');
    target.setAttribute('spellcheck', 'false');
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }

    if (range) {
      const sel = target.ownerDocument.getSelection();
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

    const { el, html, tree, ce, spell } = snap;
    const changed = el.innerHTML !== html;

    if (ce === null) el.removeAttribute('contenteditable');
    else el.setAttribute('contenteditable', ce);
    if (spell === null) el.removeAttribute('spellcheck');
    else el.setAttribute('spellcheck', spell);
    try { el.blur(); } catch (_) { /* 무시 */ }

    if (!changed) return;
    push('text', el, () => {
      restoreTree(tree);
      if (ce === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', ce);
    });
  }

  /* 편집 전의 자식 노드 목록과 글자 값을 노드 객체째 기억한다.
     innerHTML 을 다시 넣으면 하위 노드가 새 객체로 바뀌어 이벤트 리스너와
     React 같은 프레임워크가 쥔 참조가 끊긴다. */
  function snapTree(top) {
    const kids = [];   // [요소, 원래 자식 노드들]
    const texts = [];  // [글자·주석 노드, 원래 값]
    const stack = [top];
    while (stack.length) {
      const node = stack.pop();
      const list = Array.from(node.childNodes);
      kids.push([node, list]);
      for (const c of list) {
        if (c.nodeType === 1) stack.push(c);
        else if (c.nodeType === 3 || c.nodeType === 4 || c.nodeType === 8) texts.push([c, c.data]);
      }
    }
    return { kids, texts };
  }

  function restoreTree(tree) {
    for (const [node, list] of tree.kids) {
      const now = node.childNodes;
      const same = now.length === list.length && list.every((c, i) => now[i] === c);
      if (!same) node.replaceChildren(...list);
    }
    for (const [node, data] of tree.texts) {
      if (node.data !== data) node.data = data;
    }
  }

  /* ============================================================ 5 가리기
   * 박스는 페이지 좌표에 고정하지 않고 기준을 따라간다.
   *   요소를 가린 박스 — 그 요소의 지금 위치와 크기. 고정·sticky 요소, 내부 스크롤,
   *                    빈자리 제거로 밀린 레이아웃, 이동·크기 도구를 모두 따라간다.
   *   영역을 가린 박스 — 영역을 통째로 품는 가장 안쪽 요소에 붙는다(스크롤 영역이면 그 내용에).
   *                    그런 요소가 없으면 문서 좌표.
   * 스크롤 영역 밖으로 나간 부분은 잘라서 그린다. 요소가 접혀(display:none) 보이지 않으면 숨기고,
   * 페이지가 요소를 DOM 에서 떼어 내면 마지막 위치(문서 좌표)에 남긴다.
   * 캡처할 때는 이 사각형을 service worker 로 보내 PNG 에 한 번 더 직접 칠한다.
   */

  function addMask(anchor, size) {
    const box = document.createElement('div');
    box.className = 'mask';
    ui.masks.appendChild(box);

    const m = { box, anchor, size, view: null, last: null };
    state.masks.push(m);
    layoutMasks();

    push('mask', null, () => {
      const i = state.masks.indexOf(m);
      if (i >= 0) state.masks.splice(i, 1);
      m.box.remove();
    });
  }

  function maskElement(el) {
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    setCandidate(null);
    addMask({ el }, null);
  }

  /* 스크롤 영역이면 내용이 움직이므로 박스도 스크롤 위치를 따라가야 한다 */
  function scrolls(el) {
    const cs = styleOf(el);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  }

  function originOf(el) {
    const r = rectOf(el);
    if (!scrolls(el)) return { x: r.x, y: r.y };
    return {
      x: r.x + el.clientLeft - el.scrollLeft,
      y: r.y + el.clientTop - el.scrollTop
    };
  }

  /* 영역(최상위 화면 좌표)을 통째로 품는 가장 안쪽 요소를 기준으로 삼는다 */
  function regionAnchor(rect) {
    const spot = probe(rect.x + rect.w / 2, rect.y + rect.h / 2);
    let el = spot.el;
    for (let i = 0; el && i < 128; i++) {
      if (isRoot(el)) {
        // iframe 문서의 맨 위까지 왔다. 영역이 그 iframe 화면 안이면 그 문서 좌표에 붙인다.
        const d = el.ownerDocument;
        const f = frameOf(d);
        if (!f) break;
        const o = docOffset(d);
        const vs = viewSize(d);
        if (rect.x >= o.x - 0.5 && rect.y >= o.y - 0.5 &&
            rect.x + rect.w <= o.x + vs.w + 0.5 && rect.y + rect.h <= o.y + vs.h + 0.5) {
          return docAnchor(d, rect);
        }
        el = f;
        continue;
      }
      const r = rectOf(el);
      if (r.x <= rect.x + 0.5 && r.y <= rect.y + 0.5 &&
          r.x + r.w >= rect.x + rect.w - 0.5 && r.y + r.h >= rect.y + rect.h - 0.5) {
        const o = originOf(el);
        return { el, dx: rect.x - o.x, dy: rect.y - o.y };
      }
      el = upOf(el);
    }
    return docAnchor(document, rect);
  }

  function docAnchor(doc, rect) {
    const win = doc.defaultView || window;
    const o = docOffset(doc);
    return { doc, x: rect.x - o.x + win.scrollX, y: rect.y - o.y + win.scrollY };
  }

  /* 기준이 사라졌으면 마지막으로 그린 자리를 최상위 문서 좌표로 붙든다 */
  function pinToDocument(m) {
    const v = m.last;
    m.anchor = v
      ? { doc: document, x: v.x + window.scrollX, y: v.y + window.scrollY }
      : { doc: document, x: -1e6, y: -1e6 };
    m.size = v ? { w: v.w, h: v.h } : { w: 0, h: 0 };
  }

  /* 박스가 지금 그려질 자리(최상위 화면 좌표). 보이는 부분이 없으면 null. */
  function maskRect(m) {
    const a = m.anchor;
    if (a.el) {
      const el = a.el;
      if (!el.isConnected || !el.ownerDocument.defaultView) {
        pinToDocument(m);
        return maskRect(m);
      }
      let box;
      let self = null; // 기준이 스크롤 영역이면 그 영역 밖으로 나간 부분도 잘라야 한다
      if (m.size) {
        const r = rectOf(el);
        if (r.w <= 0 || r.h <= 0) return null; // 기준 요소가 접혔다
        const o = originOf(el);
        box = { x: o.x + a.dx, y: o.y + a.dy, w: m.size.w, h: m.size.h };
        if (scrolls(el)) {
          const cs = styleOf(el);
          self = {
            rect: { x: r.x + el.clientLeft, y: r.y + el.clientTop, w: el.clientWidth, h: el.clientHeight },
            cx: cs.overflowX !== 'visible',
            cy: cs.overflowY !== 'visible'
          };
        }
      } else {
        box = rectOf(el);
        if (box.w <= 0 || box.h <= 0) return null; // 지워졌거나 접혔다
      }
      m.last = box;
      if (self) {
        box = intersect(box, self.rect, self.cx, self.cy);
        if (!box) return null;
      }
      return clipVisible(el, el.ownerDocument, box);
    }
    const win = a.doc.defaultView;
    if (!win) {
      pinToDocument(m);
      return maskRect(m);
    }
    const o = docOffset(a.doc);
    const box = { x: a.x - win.scrollX + o.x, y: a.y - win.scrollY + o.y, w: m.size.w, h: m.size.h };
    if (box.w <= 0 || box.h <= 0) return null;
    m.last = box;
    return clipVisible(null, a.doc, box);
  }

  function startMarquee(p) {
    state.drag = {
      kind: 'marquee',
      x0: p.x, y0: p.y,
      moved: false
    };
    ui.marquee.style.display = 'block';
    updateMarquee(p);
  }

  function updateMarquee(p) {
    const d = state.drag;
    const x = Math.min(d.x0, p.x);
    const y = Math.min(d.y0, p.y);
    const w = Math.abs(p.x - d.x0);
    const h = Math.abs(p.y - d.y0);
    if (w > 3 || h > 3) d.moved = true;
    Object.assign(ui.marquee.style, {
      left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px'
    });
    d.rect = { x, y, w, h };
  }

  function endMarquee(d) {
    ui.marquee.style.display = 'none';
    if (d.moved && d.rect && d.rect.w > 4 && d.rect.h > 4) {
      addMask(regionAnchor(d.rect), { w: d.rect.w, h: d.rect.h });
    }
  }

  function layoutMasks() {
    for (const m of state.masks) {
      let r = null;
      try { r = maskRect(m); } catch (_) { r = m.view; } // 계산이 깨지면 직전 자리를 지킨다
      m.view = r;
      const s = m.box.style;
      if (!r) { s.display = 'none'; continue; }
      s.display = 'block';
      s.left = r.x + 'px';
      s.top = r.y + 'px';
      s.width = r.w + 'px';
      s.height = r.h + 'px';
    }
  }

  /* ============================================================ 이벤트 */

  function usable(el) {
    return !!el && el.nodeType === 1 && el.isConnected && el !== host && !isRoot(el);
  }

  function inOurUI(e) {
    return typeof e.composedPath === 'function' && e.composedPath().includes(host);
  }

  function inEditing(e) {
    const ed = state.editing;
    if (!ed) return false;
    if (typeof e.composedPath === 'function' && e.composedPath().includes(ed)) return true;
    // closed shadow DOM 안은 composedPath 에 보이지 않는다 — 좌표로 확인한다
    if (typeof e.clientX !== 'number') return false;
    const p = pt(e);
    const hit = hitAt(p.x, p.y);
    return !!hit && containsDeep(ed, hit);
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onPointerMove(e) {
    const p = pt(e);
    if (state.drag) {
      block(e);
      if (state.drag.kind === 'move') updateMove(p);
      else if (state.drag.kind === 'resize') updateResize(p, e.shiftKey);
      else if (state.drag.kind === 'marquee') updateMarquee(p);
      return;
    }
    if (inOurUI(e)) return;
    state.pointer.x = p.x;
    state.pointer.y = p.y;
    if (state.busy || state.editing) return;
    if (!host.isConnected) mountHost();
    setCandidate(pickAt(p.x, p.y));
  }

  function onPointerDown(e) {
    if (inOurUI(e) || inEditing(e)) return;
    if (state.busy) { block(e); return; }
    block(e);

    const p = pt(e);
    if (state.tool === 'move') startMove(p);
    else if (state.tool === 'mask' && e.shiftKey) startMarquee(p);
    else if (state.tool === 'mask' && !state.candidate) startMarquee(p);
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

    const p = pt(e);
    if (state.tool === 'hide') hideEl(state.candidate || pickAt(p.x, p.y));
    else if (state.tool === 'text') startTextEdit(p.x, p.y);
    else if (state.tool === 'mask') maskElement(state.candidate || pickAt(p.x, p.y));
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
      const p = state.candidate && upOf(state.candidate);
      if (p) setCandidate(p);
    } else if (e.key === 'ArrowDown') {
      descend();
    }
  }

  /* 커서 아래의 가장 깊은 요소를 향해 한 단계 내려간다. */
  function descend() {
    const deep = hitAt(state.pointer.x, state.pointer.y);
    if (!deep || !state.candidate || deep === state.candidate) return;

    let cur = deep;
    for (let i = 0; cur && i < 256; i++) {
      const up = upOf(cur);
      if (up === state.candidate) { setCandidate(cur); return; }
      cur = up;
    }
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
    mountHost(); // 그사이 열린 dialog·popover 보다 위로
    await uiGone();

    // 찍기 직전의 가리기 사각형. service worker 가 PNG 에 직접 칠한다.
    layoutMasks();
    const masks = state.masks
      .map((m) => m.view)
      .filter(Boolean)
      .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));

    const res = await send({
      type: 'CLEANSHOT_CAPTURE',
      pageUrl: location.href,
      masks,
      viewport: { w: window.innerWidth, h: window.innerHeight }
    });

    host.classList.remove('capturing');
    setStatus('');
    lockBar(false);
    state.busy = false;

    if (res && res.ok) { finish(`저장했습니다 · ${short(res.filename)}`); return; }

    // downloads API 가 실패하면 페이지에서 직접 내려받는다
    if (res && res.fallback && res.dataUrl) {
      const err = saveInPage(res.dataUrl, res.filename);
      if (!err) { finish(`브라우저 다운로드로 저장했습니다 · ${short(res.filename)}`); return; }
      toast(`캡처 실패 · ${res.error} · 대체 저장도 실패: ${err}`, 4200);
      return;
    }
    toast(`캡처 실패 · ${(res && res.error) || '알 수 없는 오류'}`, 3200);
  }

  /* <a download> 로 내려받는다. 문서에 붙이지 않은 링크라 페이지의 클릭 리스너와
     선택 모드의 클릭 차단을 거치지 않는다. 폴더는 지정할 수 없어 파일 이름만 쓴다. */
  function saveInPage(dataUrl, filename) {
    try {
      const comma = dataUrl.indexOf(',');
      const bin = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = short(filename) || 'cleanshot.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return '';
    } catch (err) {
      return String((err && err.message) || err);
    }
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

  /* 두 번째부터는 스크립트를 다시 컴파일하지 않고 메시지로 토글한다 */
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
