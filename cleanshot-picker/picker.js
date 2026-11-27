/* CleanShot Picker — content script (격리 world)
 *
 * 도구로 페이지를 정리하고 표시를 더한 뒤 현재 화면(Enter)이나 페이지 전체(Shift+Enter)를 PNG 로 저장한다.
 *   1 지우기 · 2 이동 · 3 크기 · 4 텍스트 · 5 가리기(검정) · 6 영역
 *   7 강조 · 8 스포트라이트 · 9 화살표 · 0 번호 · T 글상자 — 찍은 그림에 남는 표시. 그린 뒤 옮기고 크기를 바꾼다.
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
  /* 한 번에 정리의 판정·내장 목록과 사이트별 레시피 저장값(recipes.js). 설정 화면도 같은 파일을 쓴다. */
  const R = globalThis.CleanShotRecipes;
  if (!R) {
    console.error('[CleanShot] 한 번에 정리·레시피 모듈(recipes.js)이 실리지 않았습니다.');
    return;
  }

  /* ============================================================ 상수와 상태 */

  const HOST_ID = '__cleanshot_host__';
  const MAX_ESCALATE = 6;        // 자동 승격 최대 단계
  const AREA_RATIO = 0.9;        // 부모 면적의 이 비율 이상이면 부모를 대신 선택
  const NUDGE_MERGE_MS = 400;    // 이 안에 이어진 방향키는 한 작업으로 묶는다
  const ESC_CONFIRM_MS = 2500;   // 정리한 것이 있을 때 이 안에 Esc 를 한 번 더 눌러야 닫힌다
  const FRAME_TAGS = 'iframe, frame, object, embed';

  /* key 는 누른 글자(e.key), code 가 있으면 키 위치(e.code)로 본다 — 한글 입력 상태에서 T 는 'ㅅ' 이 된다.
     hint 는 키로 바꿀 때 띄우는 안내 */
  const TOOLS = [
    { id: 'hide',   key: '1', label: '지우기', cursor: 'crosshair' },
    { id: 'move',   key: '2', label: '이동',   cursor: 'move' },
    { id: 'resize', key: '3', label: '크기',   cursor: 'crosshair' },
    { id: 'text',   key: '4', label: '텍스트', cursor: 'text', tip: '페이지 문구를 제자리에서 고쳐 씁니다' },
    { id: 'mask',   key: '5', label: '가리기', cursor: 'crosshair' },
    { id: 'crop',   key: '6', label: '영역',   cursor: 'crosshair' },
    { id: 'box',    key: '7', label: '강조',   cursor: 'crosshair' },
    { id: 'spot',   key: '8', label: '스포트라이트', cursor: 'crosshair' },
    { id: 'arrow',  key: '9', label: '화살표', cursor: 'crosshair', hint: '화살표 · 꼬리에서 머리 쪽으로 끌어 그립니다' },
    { id: 'badge',  key: '0', label: '번호',   cursor: 'crosshair', hint: '번호 · 누르는 곳마다 1, 2, 3… 을 붙입니다' },
    { id: 'label',  key: 'T', code: 'KeyT', label: '글상자', cursor: 'text', tip: '그림 위에 글을 써 넣습니다',
      hint: '글상자 · 누른 곳에 씁니다 (Enter 끝, Shift+Enter 줄바꿈)' }
  ];

  // 클릭으로 요소, Shift+드래그(또는 빈 곳 드래그)로 영역을 고르는 도구
  const AREA_TOOLS = new Set(['mask', 'crop', 'box', 'spot']);
  // 그린 것을 눌러 고르고 옮기고 크기를 바꿀 수 있는 도구. 그 도구로 그린 것만 잡는다.
  const OBJ_TOOLS = new Set(['mask', 'crop', 'box', 'spot', 'arrow', 'badge', 'label']);
  // 사각형으로 크기를 바꾸는 그림 (8방향 핸들). 화살표는 두 끝, 번호·글상자는 옮기기만.
  const RECT_KINDS = new Set(['mask', 'crop', 'box', 'spot']);
  // 페이지 요소를 고르지 않는 도구 — 요소 강조 상자를 띄우지 않는다
  const FREE_TOOLS = new Set(['arrow', 'badge', 'label']);

  const GRAB = 7;          // 테두리만 있는 그림(강조·스포트라이트·영역)은 테두리에서 이만큼 안팎을 눌러야 잡힌다
  const MIN_OBJ = 8;       // 크기를 줄일 수 있는 한도
  const ARROW_PAD = 14;    // 화살표 사각형이 두 끝 바깥으로 두는 여백 (굵기와 머리가 들어가게)
  const ARROW_MIN = 10;    // 이보다 짧게 끌면 클릭으로 보고 누른 곳을 가리키는 화살표를 놓는다
  const BADGE = 28;        // 번호 배지 지름
  const SVG_NS = 'http://www.w3.org/2000/svg';

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
    /* 그린 것은 모두 { kind, anchor, size, view, last } 틀로 페이지를 따라간다 — "5 가리기"·"그린 것 고르기" 참고 */
    masks: [],               // kind 'mask' (+box: 검은 박스 요소)
    crop: null,              // kind 'crop' — "6 영역". 있으면 그 부분만 저장·복사
    notes: [],               // kind 'box'·'arrow'·'badge'·'label' (+box: 그리는 요소) — 7 강조·9 화살표·0 번호·T 글상자
    spot: null,              // kind 'spot' — "8 스포트라이트" 바깥을 어둡게 (하나만)
    sel: null,               // 고른 그림. 그 그림을 그린 도구일 때 옮기고 크기를 바꾼다
    hover: null,             // 포인터 아래에 있는 잡을 수 있는 그림
    noteEdit: null,          // 글을 쓰는 중인 글상자 { obj, before(글), isNew, g0(자리·크기) }
    eatClick: false,         // 다음 클릭 한 번은 도구 동작으로 쓰지 않는다 (글상자 쓰기를 끝낸 클릭)
    keepAfter: false,        // 찍은 뒤에도 정리한 상태를 두고 이어서 찍는다 (툴바 "찍고 계속")
    pass: null,              // Space 를 누르고 있는 동안 페이지 조작 — "페이지 조작" 참고
    escAt: 0,                // 정리한 것이 있을 때 Esc 를 처음 누른 시각 (한 번 더 눌러야 닫힌다)
    drag: null,
    editing: null,
    editSnapshot: null,
    justDragged: false,
    full: null               // 진행 중인 전체 페이지 캡처 — "전체 페이지 캡처" 참고
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

      /* 주석 레이어 (7 강조·8 스포트라이트·9 화살표·0 번호·T 글상자) — 캡처 때도 남아 화면 그대로 찍힌다.
         페이지 전체 캡처에서도 장마다 그 스크롤 위치에 맞춰 그려져 함께 이어 붙는다. */
      .notes { position: absolute; inset: 0; pointer-events: none; }
      .note-box { position: absolute; border: 3px solid #ff3b30; border-radius: 6px; box-shadow: 0 0 0 1px rgba(255,255,255,0.85); }
      .note-spot { position: absolute; border-radius: 4px; box-shadow: 0 0 0 200vmax rgba(0,0,0,0.5); display: none; }
      .note-arrow { position: absolute; overflow: visible; }
      .note-arrow .halo { stroke: #fff; stroke-width: 8; stroke-linecap: round; }
      .note-arrow .halo-head { fill: #fff; stroke: #fff; stroke-width: 4; stroke-linejoin: round; }
      .note-arrow .shaft { stroke: #ff3b30; stroke-width: 4; stroke-linecap: round; }
      .note-arrow .head { fill: #ff3b30; stroke: #ff3b30; stroke-width: 1; stroke-linejoin: round; }
      .note-badge {
        position: absolute;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%;
        border: 2px solid #fff;
        background: #ff3b30;
        color: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.35);
        font: 700 15px/1 "Segoe UI", "Malgun Gothic", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .note-badge.small { font-size: 11px; }
      .note-label {
        position: absolute;
        max-width: 420px;
        min-width: 24px;
        padding: 4px 9px;
        border-radius: 6px;
        background: #ff3b30;
        color: #fff;
        caret-color: #fff;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.85), 0 1px 3px rgba(0,0,0,0.3);
        font: 600 15px/1.4 "Segoe UI", "Malgun Gothic", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        text-align: left;
      }
      .note-label.editing {
        pointer-events: auto;
        cursor: text;
        outline: 2px dashed #2f6fed;
        outline-offset: 3px;
        user-select: text;
        -webkit-user-select: text;
      }
      .note-label.editing:empty::before { content: '글자를 입력하세요'; opacity: .75; }

      /* 마스크 레이어 — 캡처에 남는다. 주석보다 위: 저장할 때도 서비스 워커가 가리기를 맨 위에 칠한다 */
      .masks { position: absolute; inset: 0; pointer-events: none; }
      .mask { position: absolute; background: #000; }

      /* UI 레이어 — 캡처 직전에 사라진다 */
      .ui { position: absolute; inset: 0; pointer-events: none; cursor: default; }
      :host(.capturing) .ui { display: none; }
      /* 전체 페이지 캡처에서는 장마다 잰 자리를 service worker 가 칠하므로 화면의 박스도 숨긴다 */
      :host(.capturing-full) .masks { display: none; }

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
      /* 6 영역: 저장·복사할 부분. 바깥을 어둡게 보여 준다 (UI 층이라 캡처 직전에 사라진다) */
      .crop {
        position: absolute;
        outline: 2px dashed #2f6fed;
        box-shadow: 0 0 0 200vmax rgba(0,0,0,0.38);
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
      .handle.end { width: 13px; height: 13px; margin: -7px 0 0 -7px; border-radius: 50%; cursor: move; }
      /* 고른 그림과 포인터 아래의 잡을 수 있는 그림 */
      .selbox, .hoverbox {
        position: absolute;
        pointer-events: none;
        display: none;
        border-radius: 4px;
      }
      .selbox { outline: 1.5px dashed #2f6fed; outline-offset: 3px; }
      .hoverbox { outline: 1px solid rgba(47,111,237,0.9); outline-offset: 3px; }
      /* Space 를 누른 채 페이지를 조작하는 동안: 페이지를 누르는 데 걸리지 않게 핸들·고른 표시를 숨긴다 */
      :host(.passing) .handle, :host(.passing) .selbox, :host(.passing) .hoverbox,
      :host(.passing) .hl, :host(.passing) .tag { display: none !important; }

      /* 툴바: 윗줄은 도구, 아랫줄은 작업·저장 단추. 좁은 화면에서는 줄마다 접힌다.
         left:50% + translate 로 가운데 두면 쓸 수 있는 너비가 화면 절반으로 줄어 일찍 접히므로 margin:auto 로 가운데 둔다 */
      .bar {
        position: absolute;
        left: 0;
        right: 0;
        margin: 0 auto;
        width: fit-content;
        bottom: 24px;
        top: auto;
        display: flex;
        flex-direction: column;
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
      .row { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px; }

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

      /* 알림은 툴바 바로 위(툴바가 위에 있으면 바로 아래). --bar-h 는 툴바 높이 (ResizeObserver) */
      .toast {
        position: absolute;
        left: 0;
        right: 0;
        margin: 0 auto;
        width: fit-content;
        bottom: calc(var(--bar-h, 76px) + 34px);
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
      .toast.at-top { top: calc(var(--bar-h, 76px) + 34px); bottom: auto; }
    </style>

    <div class="notes"><div class="note-spot"></div></div>
    <div class="masks"></div>

    <div class="ui">
      <div class="crop"></div>
      <div class="hl"></div>
      <div class="tag"></div>
      <div class="marquee"></div>
      <div class="hoverbox"></div>
      <div class="selbox"></div>
      ${HANDLE_DIRS.map((d) => `<div class="handle" data-dir="${d}" style="cursor:${HANDLE_CURSOR[d]}"></div>`).join('')}
      <div class="handle end" data-end="tail" title="꼬리"></div>
      <div class="handle end" data-end="head" title="머리"></div>
      <div class="toast"></div>
      <div class="bar">
        <div class="row tools">
          ${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})${t.tip ? ' — ' + t.tip : ''}">${t.label}<span class="num">${t.key}</span></button>`).join('')}
        </div>
        <div class="row acts">
          <span class="count">0개 작업</span>
          <button class="mode" title="지우기가 빈자리를 남길지 접을지">빈자리 남김</button>
          <button class="undo" disabled title="Ctrl+Z">되돌리기</button>
          <button class="reset" disabled>전체 복원</button>
          <span class="sep"></span>
          <button class="clean" title="쿠키 배너·채팅 버튼·앱 설치 배너·공지 팝업을 한 번에 숨깁니다 (Q)">정리<span class="num">Q</span></button>
          <button class="recipe" title="지운 것·요소째 가린 것·고친 글과 정리를 이 사이트 레시피로 저장합니다. 다음에 켜면 바로 적용됩니다 (설정에서 끄거나 지움)">레시피 저장</button>
          <span class="sep"></span>
          <button class="shot primary" title="보이는 화면 (Enter)">캡처</button>
          <button class="full" title="페이지 전체 (Shift+Enter)">전체</button>
          <button class="copy" title="보이는 화면을 클립보드에 복사 (C)">복사</button>
          <button class="keep" title="찍은 뒤 닫을지, 정리한 상태를 두고 이어서 찍을지">찍고 닫기</button>
          <span class="status"></span>
          <button class="opts" title="저장 형식·크기·파일 이름·저장 위치·주소와 시각 표시">설정</button>
          <button class="flip" title="툴바를 위/아래로 (Tab)">⇅</button>
          <button class="close" title="Esc">닫기</button>
        </div>
      </div>
    </div>
  `;

  const ui = {
    masks: root.querySelector('.masks'),
    notes: root.querySelector('.notes'),
    spot: root.querySelector('.note-spot'),
    layer: root.querySelector('.ui'),
    hl: root.querySelector('.hl'),
    tag: root.querySelector('.tag'),
    marquee: root.querySelector('.marquee'),
    crop: root.querySelector('.crop'),
    selbox: root.querySelector('.selbox'),
    hoverbox: root.querySelector('.hoverbox'),
    handles: [...root.querySelectorAll('.handle[data-dir]')],
    ends: [...root.querySelectorAll('.handle[data-end]')],
    toast: root.querySelector('.toast'),
    bar: root.querySelector('.bar'),
    tools: [...root.querySelectorAll('.tool')],
    count: root.querySelector('.count'),
    status: root.querySelector('.status'),
    mode: root.querySelector('.mode'),
    undo: root.querySelector('.undo'),
    reset: root.querySelector('.reset'),
    clean: root.querySelector('.clean'),
    recipe: root.querySelector('.recipe'),
    shot: root.querySelector('.shot'),
    full: root.querySelector('.full'),
    copy: root.querySelector('.copy'),
    keep: root.querySelector('.keep'),
    opts: root.querySelector('.opts'),
    flip: root.querySelector('.flip'),
    close: root.querySelector('.close')
  };

  ui.tools.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  // 툴바 높이가 바뀌면(좁은 화면에서 줄이 접힘) 알림을 그 위로 옮긴다
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => ui.layer.style.setProperty('--bar-h', ui.bar.offsetHeight + 'px')).observe(ui.bar);
  }
  ui.mode.addEventListener('click', toggleMode);
  ui.undo.addEventListener('click', undo);
  ui.reset.addEventListener('click', () => { restoreAll(); paintBar(); reposition(); });
  ui.clean.addEventListener('click', () => cleanUp());
  ui.recipe.addEventListener('click', () => saveRecipe());
  ui.shot.addEventListener('click', () => captureViewport());
  ui.full.addEventListener('click', () => captureFullPage());
  ui.copy.addEventListener('click', () => captureViewport('', { copy: true }));
  ui.keep.addEventListener('click', toggleKeep);
  // 설정 화면은 서비스 워커가 연다 (콘텐츠 스크립트에는 openOptionsPage 가 없다). 정리한 것은 그대로 둔다
  ui.opts.addEventListener('click', () => {
    send({ type: 'CLEANSHOT_OPEN_OPTIONS' }).then((res) => {
      if (!res || !res.ok) toast(`설정 화면을 열지 못했습니다 · ${(res && res.error) || '알 수 없는 오류'}`, 3200);
    });
  });
  ui.flip.addEventListener('click', flipBar);
  ui.close.addEventListener('click', deactivate);
  /* 8방향 핸들: 고른 그림이 있으면 그 크기를, 아니면 3 크기 도구에서 고른 요소의 크기를 바꾼다 */
  ui.handles.forEach((h) =>
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (selShown()) startObjResize(pt(e), h.dataset.dir);
      else startResize(pt(e), h.dataset.dir);
    })
  );
  ui.ends.forEach((h) =>
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (selShown()) startArrowEnd(pt(e), h.dataset.end);
    })
  );

  /* 선택 모드 동안의 커서. 우리 UI 는 제외한다. */
  const cursorStyle = document.createElement('style');
  cursorStyle.id = '__cleanshot_cursor__';

  /* cursor 를 주면 도구 커서 대신 그것을 쓴다 (전체 페이지 캡처 중의 progress) */
  function cursorCss(cursor) {
    const t = TOOLS.find((x) => x.id === state.tool);
    return `*:not(#${HOST_ID}):not(#${HOST_ID} *) { cursor: ${cursor || (t ? t.cursor : 'crosshair')} !important; }`;
  }

  function paintCursor(cursor) {
    const css = cursorCss(cursor);
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
    toast('지울 요소를 클릭하세요 · 1~9·0·T 로 도구 전환 · Q 한 번에 정리', 2200);
    autoApply(); // 이 사이트의 레시피·켤 때 정리 (툴바를 먼저 띄운 뒤)
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
    endPass();
    state.active = false;
    state.escAt = 0;

    keepAlive('cooldown');
    endTextEdit();
    restoreAll();
    state.hover = null;
    setCandidate(null);

    pageWatch.disconnect();
    for (const d of [...docs]) detachDoc(d);
    unblindAll();

    host.classList.remove('capturing');
    host.remove();
    cursorStyle.remove();
  }

  function toggle() {
    // 전체 페이지 캡처 중에 아이콘·단축키를 누르면 캡처만 멈춘다 (끄면 찍던 페이지를 정리하지 못한다)
    if (state.full) { state.full.cancel = true; return; }
    state.active ? deactivate() : activate();
  }

  function readSettings() {
    try {
      // 가리기 방식 설정은 없어졌다. 예전 판이 남긴 키는 치운다.
      chrome.storage.sync.remove(['maskStyle', 'settingsVersion']).catch(() => {});
      chrome.storage.sync.get({ forceRemove: false, barTop: false, keepAfter: false }).then((v) => {
        state.forceRemove = !!v.forceRemove;
        state.barTop = !!v.barTop;
        state.keepAfter = v.keepAfter === true;
        paintMode();
        paintBarSide();
        paintKeep();
      }).catch(() => {});
    } catch (_) { /* storage 권한이 없어도 동작한다 */ }
  }

  function writeSettings() {
    try {
      chrome.storage.sync.set({
        forceRemove: state.forceRemove,
        barTop: state.barTop,
        keepAfter: state.keepAfter
      }).catch(() => {});
    } catch (_) { /* 무시 */ }
  }

  /* 설정 화면에서 "이어서 찍기"를 바꾸면 켜져 있는 툴바에도 바로 보인다 */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.keepAfter) return;
      state.keepAfter = changes.keepAfter.newValue === true;
      paintKeep();
    });
  } catch (_) { /* 무시 */ }

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
    doc.addEventListener('keypress', onKeyQuiet, true);
    doc.addEventListener('keyup', onKeyUp, true);
    doc.addEventListener('load', onFrameLoad, true);
    win.addEventListener('scroll', reposition, true);
    win.addEventListener('resize', reposition, true);
    if (doc === document) win.addEventListener('blur', onWindowBlur);

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
      doc.removeEventListener('keypress', onKeyQuiet, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      doc.removeEventListener('load', onFrameLoad, true);
      const win = doc.defaultView;
      if (win) {
        win.removeEventListener('scroll', reposition, true);
        win.removeEventListener('resize', reposition, true);
        win.removeEventListener('blur', onWindowBlur);
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
    if (state.noteEdit && id !== 'label') endNoteEdit();
    state.tool = id;
    if (state.sel && state.sel.kind !== id) state.sel = null; // 고른 그림은 그린 도구에서만 다룬다
    state.hover = null;
    ui.tools.forEach((b) => b.classList.toggle('sel', b.dataset.tool === id));
    paintCursor();
    if (FREE_TOOLS.has(id) && state.candidate) setCandidate(null);
    else layoutHandles();
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

  /* 찍고 닫기 ↔ 찍고 계속: 계속이면 저장·복사한 뒤에도 정리한 상태를 두어 이어서 찍는다 (설정 화면과 같은 값) */
  function toggleKeep() {
    state.keepAfter = !state.keepAfter;
    paintKeep();
    writeSettings();
    toast(state.keepAfter ? '찍은 뒤에도 정리한 상태를 두고 이어서 찍습니다' : '찍으면 모두 되돌리고 닫습니다', 1600);
  }

  function paintKeep() {
    ui.keep.textContent = state.keepAfter ? '찍고 계속' : '찍고 닫기';
    ui.keep.classList.toggle('on', state.keepAfter);
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

  /* info: 레시피로 저장할 때 쓰는 값 (지우기의 빈자리 제거 여부, 고친 글, 묶은 작업의 분류별 개수 등) */
  function push(kind, el, undoFn, mergeable, info) {
    state.history.push({ kind, el, undo: undoFn, t: Date.now(), mergeable: !!mergeable, info: info || null });
    paintBar();
  }

  /* fn 안에서 쌓인 작업들을 kind 작업 하나로 묶는다 — Ctrl+Z 한 번에 모두 되돌린다 (한 번에 정리, 켤 때 적용한 레시피).
     묶은 작업 수를 돌려준다. 하나도 없으면 아무것도 쌓지 않는다. */
  function groupOps(kind, fn, info) {
    const outer = state.history;
    const inner = [];
    state.history = inner;
    try {
      fn();
    } catch (err) {
      console.warn(`[CleanShot] ${kind} 도중 멈춤:`, err); // 그때까지 한 것은 아래에서 묶어 되돌릴 수 있게 둔다
    } finally {
      state.history = outer;
    }
    if (!inner.length) { paintBar(); return 0; }
    push(kind, null, () => {
      for (let i = inner.length - 1; i >= 0; i--) {
        try { inner[i].undo(); } catch (_) { /* 나머지는 계속 되돌린다 */ }
      }
    }, false, { ...(info || {}), ops: inner });
    return inner.length;
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
    endNoteEdit();
    while (state.history.length) {
      const op = state.history.pop();
      try { op.undo(); } catch (_) { /* 계속 진행 */ }
    }
    state.sel = null;
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

  /* 그린 것의 자리를 먼저 다시 잰 뒤(layoutMasks) 그 자리에 핸들과 고른 표시를 놓는다 */
  function reposition() {
    paintHighlight();
    layoutMasks();
    layoutHandles();
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

  /* 8방향 핸들: 고른 그림(가리기·영역·강조·스포트라이트)이 있으면 그 둘레에, 아니면 3 크기 도구에서 요소 둘레에.
     화살표를 골랐으면 두 끝에 둥근 핸들. 고른 그림과 포인터 아래 그림의 테두리도 여기서 그린다. */
  function layoutHandles() {
    if (state.sel && !alive(state.sel)) state.sel = null;   // 되돌리기 등으로 사라졌다
    if (state.hover && !alive(state.hover)) state.hover = null;
    const o = selShown() ? state.sel : null;
    let r = null;
    if (o) {
      if (RECT_KINDS.has(o.kind)) r = drawnFull(o);
    } else if (state.tool === 'resize' && state.candidate && state.candidate.isConnected) {
      r = rectOf(state.candidate);
    }
    if (!r) {
      ui.handles.forEach((h) => { h.style.display = 'none'; });
    } else {
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

    const ends = o && o.kind === 'arrow' && o.last ? arrowEnds(o, o.last) : null;
    ui.ends.forEach((h) => {
      const q = ends && ends[h.dataset.end];
      if (!q) { h.style.display = 'none'; return; }
      h.style.display = 'block';
      h.style.left = q.x + 'px';
      h.style.top = q.y + 'px';
    });

    // 고른 그림의 점선 테두리 (화살표는 두 끝 핸들로 보이고, 쓰는 중인 글상자는 제 테두리가 있다)
    const editingIt = !!o && !!state.noteEdit && state.noteEdit.obj === o;
    placeAt(ui.selbox, o && o.kind !== 'arrow' && !editingIt ? drawnFull(o) : null, 0);
    // 포인터 아래의 잡을 수 있는 그림 (끄는 동안은 숨긴다)
    const h = !state.drag && state.hover && state.hover !== o && state.hover.kind === state.tool ? state.hover : null;
    placeAt(ui.hoverbox, h ? drawnVis(h) : null, 0);
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

  /* opts.remove 가 있으면 빈자리 남김·제거 설정 대신 그 값을 쓴다 (한 번에 정리는 늘 제거, 레시피는 저장할 때의 방식).
     숨겼으면 true */
  function hideEl(el, opts = {}) {
    if (!usable(el)) return false;

    const pos = styleOf(el).position;
    const outOfFlow = pos === 'fixed' || pos === 'sticky' || pos === 'absolute';
    const removeSpace = (opts.remove === undefined ? state.forceRemove : !!opts.remove) || outOfFlow;
    const restore = snapStyle(el);

    if (removeSpace) el.style.setProperty('display', 'none', 'important');
    else el.style.setProperty('visibility', 'hidden', 'important');

    push('hide', el, restore, false, { remove: removeSpace });
    setCandidate(null);
    return true;
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
    // 레시피에는 고쳐 쓴 글(innerText — 줄바꿈이 남는다)을 남긴다
    push('text', el, () => {
      restoreTree(tree);
      if (ce === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', ce);
    }, false, { text: String(el.innerText || '') });
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

  /* opts.fromRecipe: 레시피를 적용해 만든 가리기 (다시 레시피로 저장할 때 겹쳐 넣지 않는다) */
  function addMask(anchor, size, opts = {}) {
    const box = document.createElement('div');
    box.className = 'mask';
    ui.masks.appendChild(box);

    const m = { kind: 'mask', box, anchor, size, view: null, last: null, fromRecipe: !!opts.fromRecipe };
    state.masks.push(m);
    layoutMasks();

    push('mask', null, () => {
      const i = state.masks.indexOf(m);
      if (i >= 0) state.masks.splice(i, 1);
      m.box.remove();
    });
  }

  /* 가렸으면 true (보이지 않는 요소는 가리지 않는다) */
  function maskElement(el, opts = {}) {
    if (!usable(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    setCandidate(null);
    addMask({ el }, null, opts);
    return true;
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
      const size = { w: d.rect.w, h: d.rect.h };
      if (state.tool === 'crop') setCrop(regionAnchor(d.rect), size);
      else if (state.tool === 'box') addNote('box', regionAnchor(d.rect), size);
      else if (state.tool === 'spot') setSpot(regionAnchor(d.rect), size);
      else addMask(regionAnchor(d.rect), size);
    }
  }

  /* ============================================================ 7 강조 · 8 스포트라이트 · 9 화살표 · 0 번호 · T 글상자
   * 찍은 그림에 남는 표시. 가리기 박스와 같은 기준(요소·영역)으로 붙어 스크롤·레이아웃이 바뀌어도 따라간다.
   *   강조 — 빨간 테두리. 요소면 요소 바깥으로 3px 띄워 그린다. 여러 개.
   *   스포트라이트 — 고른 곳 바깥을 어둡게. 하나만 두고 다시 고르면 바뀐다.
   *   화살표 — 끈 방향(꼬리 → 머리)으로. 그냥 누르면 누른 곳을 가리키는 화살표를 놓는다.
   *   번호 — 누르는 곳마다 1, 2, 3… (지금 있는 번호 가운데 가장 큰 것 다음).
   *   글상자 — 누른 곳에 글을 쓴다. Enter·Esc·바깥 클릭으로 끝내고 Shift+Enter 는 줄바꿈. 비우면 없어진다.
   * 주석 레이어는 캡처 직전에도 남아 화면 그대로 찍히고, 페이지 전체 캡처에서도 장마다 그 스크롤 위치에 그려져
   * 함께 이어 붙는다. 스크롤 영역·화면 끝에 걸쳐 일부만 보이면 잘린 쪽을 잘라 그린다 — 잘린 자리에 가짜 테두리를
   * 긋지 않아 전체 페이지의 이음매에도 줄이 생기지 않는다. 작업 스택에 들어가 Ctrl+Z·전체 복원으로 없앤다. */

  function makeNote(kind, anchor, size, extra) {
    let node;
    if (kind === 'arrow') {
      node = document.createElementNS(SVG_NS, 'svg');
      node.setAttribute('class', 'note-arrow');
      for (const c of ['halo', 'halo-head', 'shaft', 'head']) {
        const part = document.createElementNS(SVG_NS, c.endsWith('head') ? 'polygon' : 'line');
        part.setAttribute('class', c);
        node.appendChild(part);
      }
    } else {
      node = document.createElement('div');
      node.className = 'note-' + kind;
    }
    ui.notes.appendChild(node);
    const n = { kind, box: node, anchor, size, view: null, last: null, ...extra };
    state.notes.push(n);
    return n;
  }

  /* 주석을 뺀다. 작업 스택에는 남기지 않는다 (만들기를 되돌릴 때, 그리다 그만둘 때) */
  function dropNote(n) {
    const i = state.notes.indexOf(n);
    if (i >= 0) state.notes.splice(i, 1);
    n.box.remove();
    if (state.sel === n) state.sel = null;
    if (state.hover === n) state.hover = null;
  }

  function addNote(kind, anchor, size, extra) {
    const n = makeNote(kind, anchor, size, extra);
    layoutMasks();
    push('note', null, () => dropNote(n));
    return n;
  }

  function setSpot(anchor, size) {
    const prev = state.spot;
    state.spot = { kind: 'spot', anchor, size, view: null, last: null };
    layoutMasks();
    push('spot', null, () => { state.spot = prev; layoutMasks(); });
  }

  /* 화살표 사각형 r(두 끝 바깥 여백 포함)의 두 끝. dir 은 꼬리가 오른쪽(tx)·아래쪽(ty)에 있는지 */
  function arrowEnds(n, r) {
    const P = ARROW_PAD;
    const left = r.x + P;
    const right = r.x + r.w - P;
    const top = r.y + P;
    const bottom = r.y + r.h - P;
    return {
      tail: { x: n.dir.tx ? right : left, y: n.dir.ty ? bottom : top },
      head: { x: n.dir.tx ? left : right, y: n.dir.ty ? top : bottom }
    };
  }

  /* 화살표를 tail → head 로 놓고 그 사각형을 돌려준다. final 이면 사각형을 품는 요소에 붙인다 */
  function setArrow(n, tail, head, final) {
    const P = ARROW_PAD;
    const rect = {
      x: Math.min(tail.x, head.x) - P,
      y: Math.min(tail.y, head.y) - P,
      w: Math.abs(head.x - tail.x) + P * 2,
      h: Math.abs(head.y - tail.y) + P * 2
    };
    n.dir = { tx: tail.x > head.x ? 1 : 0, ty: tail.y > head.y ? 1 : 0 };
    placeObject(n, rect, final);
    return rect;
  }

  /* 끌기 시작. 조금이라도 움직여야 화살표가 생긴다 */
  function startArrow(p) {
    state.drag = { kind: 'arrow', obj: null, x0: p.x, y0: p.y, moved: false };
  }

  function updateArrowDraw(p) {
    const d = state.drag;
    if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 4) return;
    d.moved = true;
    if (!d.obj) d.obj = makeNote('arrow', null, null, { dir: { tx: 0, ty: 0 } });
    setArrow(d.obj, { x: d.x0, y: d.y0 }, p, false);
  }

  function endArrow(d, p) {
    let n = d.obj;
    let tail = { x: d.x0, y: d.y0 };
    let head = p;
    if (!n || Math.hypot(head.x - tail.x, head.y - tail.y) < ARROW_MIN) {
      // 그냥 눌렀다: 누른 곳을 머리로, 왼쪽 아래에서 오는 화살표 (화면 끝이면 반대쪽에서)
      head = tail;
      tail = defaultTail(head);
      if (!n) n = makeNote('arrow', null, null, { dir: { tx: 0, ty: 0 } });
    }
    setArrow(n, tail, head, true);
    push('note', null, () => dropNote(n));
  }

  function defaultTail(h) {
    const vs = viewSize(document);
    return { x: h.x + (h.x - 64 < 8 ? 64 : -64), y: h.y + (h.y + 48 > vs.h - 8 ? -48 : 48) };
  }

  function paintArrow(n) {
    const svg = n.box;
    const full = n.last;
    const vis = n.view;
    if (!full || !vis) { svg.style.display = 'none'; return; }
    placeClipped(svg, full, vis, 0, true);
    const { tail, head } = arrowEnds(n, { x: 0, y: 0, w: full.w, h: full.h });
    const dx = head.x - tail.x;
    const dy = head.y - tail.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const hl = Math.min(18, len * 0.7);  // 머리 길이
    const hw = hl * 0.85;                // 머리 너비
    const bx = head.x - ux * hl;         // 머리 밑변 가운데
    const by = head.y - uy * hl;
    const pts = [
      [head.x, head.y],
      [bx - (uy * hw) / 2, by + (ux * hw) / 2],
      [bx + (uy * hw) / 2, by - (ux * hw) / 2]
    ].map((q) => q.map((v) => v.toFixed(2)).join(',')).join(' ');
    // 몸통은 머리 안쪽에서 끝낸다 (둥근 끝이 머리 앞으로 삐져나오지 않게)
    const ex = head.x - ux * hl * 0.6;
    const ey = head.y - uy * hl * 0.6;
    const [halo, haloHead, shaft, tip] = svg.children;
    for (const line of [halo, shaft]) {
      line.setAttribute('x1', tail.x.toFixed(2));
      line.setAttribute('y1', tail.y.toFixed(2));
      line.setAttribute('x2', ex.toFixed(2));
      line.setAttribute('y2', ey.toFixed(2));
    }
    haloHead.setAttribute('points', pts);
    tip.setAttribute('points', pts);
  }

  function addBadge(p) {
    const num = state.notes.reduce((m, n) => (n.kind === 'badge' ? Math.max(m, n.num) : m), 0) + 1;
    const n = makeNote('badge', null, null, { num });
    n.box.textContent = String(num);
    if (num >= 100) n.box.classList.add('small');
    placeObject(n, { x: p.x - BADGE / 2, y: p.y - BADGE / 2, w: BADGE, h: BADGE }, true);
    push('note', null, () => dropNote(n));
  }

  /* 글상자: 누른 곳에서 바로 쓰기 시작한다. 다 쓰면(endNoteEdit) 작업 스택에 들어간다 */
  function newLabel(p) {
    const n = makeNote('label', null, { w: 40, h: 29 }, { text: '' });
    placeObject(n, { x: p.x - 6, y: p.y - 14, w: 40, h: 29 }, true);
    startNoteEdit(n, true);
  }

  function startNoteEdit(n, isNew) {
    endNoteEdit();
    const node = n.box;
    state.noteEdit = { obj: n, before: n.text || '', isNew, g0: geomOf(n) };
    node.classList.add('editing');
    node.setAttribute('contenteditable', 'plaintext-only');
    node.setAttribute('spellcheck', 'false');
    node.addEventListener('input', onLabelInput);
    node.addEventListener('blur', onLabelBlur);
    layoutMasks();
    host.removeAttribute('aria-hidden'); // 포커스를 받는 동안은 보조 기술에서 숨기지 않는다
    try { node.focus({ preventScroll: true }); } catch (_) { node.focus(); }
    try { // 고칠 때는 글 끝에 커서를 둔다
      const sel = typeof root.getSelection === 'function' ? root.getSelection() : document.getSelection();
      if (sel && node.firstChild) { sel.selectAllChildren(node); sel.collapseToEnd(); }
    } catch (_) { /* 무시 */ }
    measureLabel(n);
    reposition();
  }

  function onLabelInput() {
    if (!state.noteEdit) return;
    measureLabel(state.noteEdit.obj);
    reposition();
  }

  /* 툴바 단추나 다른 창으로 포커스가 옮겨 가면 쓰기를 끝낸다 */
  function onLabelBlur() {
    if (state.noteEdit) endNoteEdit();
  }

  function measureLabel(n) {
    const r = n.box.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) n.size = { w: r.width, h: r.height };
  }

  /* 글상자 쓰기를 끝낸다. 비었으면 새 글상자는 없애고, 있던 글상자는 지운 작업으로 남긴다(Ctrl+Z 로 되살림) */
  function endNoteEdit() {
    const ed = state.noteEdit;
    if (!ed) return;
    state.noteEdit = null;
    const n = ed.obj;
    const node = n.box;
    node.removeEventListener('input', onLabelInput);
    node.removeEventListener('blur', onLabelBlur);
    const text = String(node.innerText || '').replace(/ /g, ' ').replace(/\r/g, '').trim();
    node.removeAttribute('contenteditable');
    node.removeAttribute('spellcheck');
    node.classList.remove('editing');
    try { node.blur(); } catch (_) { /* 무시 */ }
    host.setAttribute('aria-hidden', 'true');
    if (!alive(n)) return; // 그사이 없어졌다

    const g0 = ed.g0;
    if (!text) {
      node.textContent = ed.before;
      if (ed.isNew) dropNote(n);
      else { setGeom(n, g0); removeObject(n); }
      reposition();
      return;
    }
    node.textContent = text;
    n.text = text;
    measureLabel(n);
    layoutMasks();
    if (n.last) n.anchor = regionAnchor(n.last); // 다 쓴 글상자를 통째로 품는 가장 안쪽 요소에 다시 붙인다
    if (ed.isNew) {
      push('note', null, () => dropNote(n));
    } else if (text !== ed.before) {
      const before = ed.before;
      push('label', n, () => { n.text = before; node.textContent = before; setGeom(n, g0); measureLabel(n); });
    }
    reposition();
  }

  function pickTarget(el) {
    if (!usable(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    setCandidate(null);
    return true;
  }

  function placeAt(el, r, out) {
    const s = el.style;
    if (!r) { s.display = 'none'; return; }
    s.display = 'block';
    s.left = (r.x - out) + 'px';
    s.top = (r.y - out) + 'px';
    s.width = (r.w + out * 2) + 'px';
    s.height = (r.h + out * 2) + 'px';
  }

  /* 잘리기 전 사각형 full 에 그리되, 보이는 부분 vis 밖은 잘라 낸다(clip-path). out 은 바깥으로 띄운 만큼.
     안 잘린 쪽은 띄운 테두리까지 그리고, 잘린 쪽은 보이는 경계에서 자른다. sized 가 아니면 크기는 내용이 정한다(글상자). */
  function placeClipped(node, full, vis, out, sized) {
    const s = node.style;
    if (!full || !vis) { s.display = 'none'; return; }
    s.display = '';
    s.left = (full.x - out) + 'px';
    s.top = (full.y - out) + 'px';
    if (sized) {
      s.width = (full.w + out * 2) + 'px';
      s.height = (full.h + out * 2) + 'px';
    }
    s.clipPath = clipInset(full, vis, out);
  }

  function clipInset(full, vis, out) {
    const t = vis.y > full.y + 0.5 ? vis.y - full.y + out : 0;
    const l = vis.x > full.x + 0.5 ? vis.x - full.x + out : 0;
    const b = vis.y + vis.h < full.y + full.h - 0.5 ? full.y + full.h - vis.y - vis.h + out : 0;
    const r = vis.x + vis.w < full.x + full.w - 0.5 ? full.x + full.w - vis.x - vis.w + out : 0;
    return t || r || b || l ? `inset(${t}px ${r}px ${b}px ${l}px)` : '';
  }

  function layoutNotes() {
    for (const n of state.notes) {
      let r = null;
      if (n.anchor && !hiddenInFull(n)) {
        try { r = maskRect(n); } catch (_) { r = n.view; }
      }
      n.view = r;
      if (n.kind === 'arrow') paintArrow(n);
      else placeClipped(n.box, n.last, r, outOf(n), n.kind !== 'label'); // 요소를 감싼 강조는 바깥으로 띄운다
    }
    layoutSpot();
  }

  /* 스포트라이트. 페이지 전체를 찍는 동안 구멍이 이 장에 없으면 장 전체를 어둡게 한다 */
  function layoutSpot() {
    const sp = state.spot;
    if (!sp) { ui.spot.style.display = 'none'; return; }
    let r = null;
    if (!hiddenInFull(sp)) {
      try { r = maskRect(sp); } catch (_) { r = sp.view; }
    }
    sp.view = r;
    if (r) placeAt(ui.spot, r, outOf(sp));
    else if (state.full) placeAt(ui.spot, { x: -41, y: -41, w: 1, h: 1 }, 0);
    else ui.spot.style.display = 'none';
  }

  /* 페이지 전체를 찍는 동안 이 장에서 뺄 표시인가
     - 이 장에서 숨긴 화면 고정(fixed) 요소 안에 붙은 것 (그 요소와 함께 첫 장·마지막 장에만)
     - 안쪽 스크롤 영역을 찍을 때 그 영역 밖에 붙은 것 — 화면에 떠 있는 셈이라 첫 장에만 둔다 */
  function hiddenInFull(o) {
    const run = state.full;
    if (!run || !run.plan) return false;
    const el = o.anchor && o.anchor.el;
    const f = el ? run.fixed.find((x) => insideOf(x.el, el)) : null;
    if (f) return f.hidden;
    if (run.plan.el && !(el && insideOf(run.plan.el, el))) return run.frame > 0;
    return false;
  }

  /* ============================================================ 그린 것 고르기·옮기기·크기
   * 가리기·영역·강조·스포트라이트·화살표·번호·글상자는 모두 같은 틀(anchor·size·view·last)로 페이지를 따라간다.
   * 그 도구일 때 그린 것을 누르면 고르고, 끌면 옮긴다. 고른 것은 8방향 핸들(화살표는 두 끝)로 크기를 바꾸고,
   * 방향키로 1px(Shift 10px)씩 옮기고, Delete 로 지운다. Esc 는 고르기만 푼다. 고른 글상자를 한 번 더 누르면 글을 고친다.
   * 테두리만 있는 강조·스포트라이트·영역은 테두리 근처를 눌러야 잡힌다 — 안쪽 클릭은 지금처럼 요소를 고른다.
   * Shift 를 누른 채 누르면 잡지 않고 새로 끈다(영역).
   * 옮기거나 크기를 바꾸면 새 사각형을 통째로 품는 가장 안쪽 요소에 다시 붙인다(regionAnchor). 요소를 감싸던 것도
   * 그때부터는 그 자리·크기를 지킨다. 모든 조작은 작업 스택에 들어가 Ctrl+Z 로 풀린다.
   */

  /* 요소를 감쌀 때 바깥으로 띄우는 만큼 (강조 3px, 스포트라이트 4px). 영역으로 그렸거나 옮긴 뒤에는 0 */
  function outOf(o) {
    if (o.size) return 0;
    return o.kind === 'box' ? 3 : o.kind === 'spot' ? 4 : 0;
  }

  function grow(r, d) {
    return { x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 };
  }

  /* 그려지는 사각형 — 잘리기 전(full)과 보이는 부분(vis). 화면에 없으면 null */
  function drawnFull(o) { return o && o.view && o.last ? grow(o.last, outOf(o)) : null; }
  function drawnVis(o) { return o && o.view ? grow(o.view, outOf(o)) : null; }

  function objectsOf(tool) {
    if (tool === 'mask') return state.masks;
    if (tool === 'crop') return state.crop ? [state.crop] : [];
    if (tool === 'spot') return state.spot ? [state.spot] : [];
    return state.notes.filter((n) => n.kind === tool);
  }

  function alive(o) {
    if (!o) return false;
    if (o.kind === 'mask') return state.masks.includes(o);
    if (o.kind === 'crop') return state.crop === o;
    if (o.kind === 'spot') return state.spot === o;
    return state.notes.includes(o);
  }

  /* 고른 그림을 지금 도구로 다룰 수 있는가 (selShown 은 화면에 보이기까지) */
  function selActive() {
    const o = state.sel;
    return !!o && o.kind === state.tool && alive(o);
  }

  function selShown() {
    return selActive() && !!state.sel.view;
  }

  /* 포인터 아래에서 지금 도구가 잡을 그림 (나중에 그린 것이 위) */
  function hitObject(tool, p) {
    const list = objectsOf(tool);
    for (let i = list.length - 1; i >= 0; i--) {
      if (hits(list[i], p)) return list[i];
    }
    return null;
  }

  function hits(o, p) {
    const r = drawnVis(o);
    if (!r) return false;
    const inside = (m) => p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;
    if (o.kind === 'arrow') {
      if (!inside(0) || !o.last) return false;
      const { tail, head } = arrowEnds(o, o.last);
      return segDist(p, tail, head) <= 8;
    }
    if (o.kind === 'mask' || o.kind === 'badge' || o.kind === 'label') return inside(2);
    // 강조·스포트라이트·영역: 테두리 근처만
    if (!inside(GRAB)) return false;
    const deep = r.w > GRAB * 2 && r.h > GRAB * 2 &&
      p.x > r.x + GRAB && p.x < r.x + r.w - GRAB && p.y > r.y + GRAB && p.y < r.y + r.h - GRAB;
    return !deep;
  }

  function segDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function select(o) {
    state.sel = o || null;
    layoutHandles();
  }

  /* 잡을 수 있는 그림 위에서는 이동 커서. 커서 규칙은 문서 전체를 다시 계산하게 하므로 바뀔 때만 건다 */
  function setHover(o) {
    if (state.hover === o) return;
    state.hover = o;
    paintCursor(o ? 'move' : '');
    layoutHandles();
  }

  function geomOf(o) {
    return { anchor: o.anchor, size: o.size, dir: o.dir };
  }

  function setGeom(o, g) {
    o.anchor = g.anchor;
    o.size = g.size;
    if (g.dir) o.dir = g.dir;
  }

  /* 그림을 rect(그려지는 사각형, 최상위 화면 좌표) 자리로. 끄는 동안은 최상위 문서 좌표에 붙여 두고,
     끝나면(final) 그 사각형을 통째로 품는 가장 안쪽 요소에 다시 붙인다. 글상자 크기는 글이 정한다. */
  function placeObject(o, rect, final) {
    o.anchor = final ? regionAnchor(rect) : docAnchor(document, rect);
    if (o.kind !== 'label') o.size = { w: rect.w, h: rect.h };
    layoutMasks();
    layoutHandles();
  }

  function grabObject(o, p) {
    const wasSel = state.sel === o;
    select(o);
    state.drag = { kind: 'objMove', obj: o, x0: p.x, y0: p.y, rect0: drawnFull(o), g0: geomOf(o), wasSel, moved: false };
  }

  function updateObjMove(p) {
    const d = state.drag;
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (!d.rect0 || (!d.moved && Math.abs(dx) <= 3 && Math.abs(dy) <= 3)) return;
    d.moved = true;
    d.rect = { x: d.rect0.x + dx, y: d.rect0.y + dy, w: d.rect0.w, h: d.rect0.h };
    placeObject(d.obj, d.rect, false);
  }

  function startObjResize(p, dir) {
    const o = state.sel;
    const r = drawnFull(o);
    if (!r || !RECT_KINDS.has(o.kind)) return;
    state.drag = {
      kind: 'objResize', obj: o, dir,
      x0: p.x, y0: p.y,
      rect0: r, g0: geomOf(o),
      ratio: r.h > 0 ? r.w / r.h : 1,
      moved: false
    };
    layoutHandles();
  }

  /* 끈 쪽 변만 움직인다. 모서리를 Shift 로 끌면 가로세로 비율을 지킨다 */
  function updateObjResize(p, keepRatio) {
    const d = state.drag;
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (!d.moved && Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return;
    d.moved = true;
    const r0 = d.rect0;
    let x0 = r0.x;
    let y0 = r0.y;
    let x1 = r0.x + r0.w;
    let y1 = r0.y + r0.h;
    if (d.dir.includes('w')) x0 = Math.min(x1 - MIN_OBJ, x0 + dx);
    if (d.dir.includes('e')) x1 = Math.max(x0 + MIN_OBJ, x1 + dx);
    if (d.dir.includes('n')) y0 = Math.min(y1 - MIN_OBJ, y0 + dy);
    if (d.dir.includes('s')) y1 = Math.max(y0 + MIN_OBJ, y1 + dy);
    if (keepRatio && d.ratio > 0 && d.dir.length === 2) {
      let w = x1 - x0;
      let h = y1 - y0;
      if (w / h > d.ratio) h = w / d.ratio;
      else w = h * d.ratio;
      if (d.dir.includes('w')) x0 = x1 - w; else x1 = x0 + w;
      if (d.dir.includes('n')) y0 = y1 - h; else y1 = y0 + h;
    }
    d.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    placeObject(d.obj, d.rect, false);
  }

  /* 화살표 한쪽 끝을 끈다 */
  function startArrowEnd(p, end) {
    const o = state.sel;
    if (!o || o.kind !== 'arrow' || !o.last) return;
    const ends = arrowEnds(o, o.last);
    state.drag = {
      kind: 'arrowEnd', obj: o, end,
      from: ends[end], other: ends[end === 'head' ? 'tail' : 'head'],
      x0: p.x, y0: p.y, g0: geomOf(o), moved: false
    };
  }

  function updateArrowEnd(p) {
    const d = state.drag;
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (!d.moved && Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return;
    d.moved = true;
    const q = { x: d.from.x + dx, y: d.from.y + dy };
    d.rect = d.end === 'head' ? setArrow(d.obj, d.other, q, false) : setArrow(d.obj, q, d.other, false);
  }

  /* 옮기기·크기·화살표 끝 끌기를 마친다 */
  function endObjDrag(d) {
    const o = d.obj;
    if (!d.moved || !d.rect) {
      // 누르기만 했다. 이미 골라 둔 글상자를 다시 누르면 글을 고친다
      if (d.kind === 'objMove' && o.kind === 'label' && d.wasSel && alive(o)) startNoteEdit(o, false);
      return;
    }
    placeObject(o, d.rect, true);
    const g0 = d.g0;
    push(d.kind, o, () => { setGeom(o, g0); layoutMasks(); });
  }

  /* 방향키로 고른 그림을 옮긴다. 짧은 시간 안에 이어 누르면 한 작업으로 묶는다 */
  function nudgeObject(o, dx, dy) {
    const r = drawnFull(o);
    if (!r) return;
    const g0 = geomOf(o);
    placeObject(o, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, true);
    pushNudge('objMove', o, () => { setGeom(o, g0); layoutMasks(); });
  }

  /* 고른 그림을 지운다 (Ctrl+Z 로 되살린다) */
  function removeObject(o) {
    let back;
    if (o.kind === 'crop' || o.kind === 'spot') {
      if (state[o.kind] !== o) return;
      state[o.kind] = null;
      back = () => { state[o.kind] = o; };
    } else {
      const list = o.kind === 'mask' ? state.masks : state.notes;
      const layer = o.kind === 'mask' ? ui.masks : ui.notes;
      const i = list.indexOf(o);
      if (i < 0) return;
      const next = o.box.nextSibling;
      list.splice(i, 1);
      o.box.remove();
      back = () => {
        list.splice(Math.min(i, list.length), 0, o);
        layer.insertBefore(o.box, next && next.parentNode === layer ? next : null);
      };
    }
    if (state.sel === o) state.sel = null;
    if (state.hover === o) { state.hover = null; paintCursor(); }
    push('remove', null, () => { back(); layoutMasks(); });
    reposition();
  }

  /* ============================================================ 6 영역
   * 캡처·복사할 부분을 고른다. 요소를 누르면 그 요소, Shift+드래그(또는 빈 곳 드래그)하면 그 영역.
   * 가리기 박스와 같은 기준(요소·영역 기준점)을 써서 스크롤·레이아웃이 바뀌어도 따라간다. 하나만 둔다.
   * 화면에는 바깥을 어둡게 보여 주고(UI 층, 캡처 직전에 사라짐), 캡처하면 service worker 가 가리기를 칠한 뒤 이 부분만 잘라 낸다.
   * 되돌리기(Ctrl+Z)·전체 복원으로 없앤다. 페이지 전체 캡처에는 쓰지 않는다. */

  function setCrop(anchor, size) {
    const prev = state.crop;
    state.crop = { kind: 'crop', anchor, size, view: null, last: null };
    layoutMasks();
    push('crop', null, () => { state.crop = prev; layoutMasks(); });
    const v = state.crop.view;
    if (v) toast(`영역 ${Math.round(v.w)}×${Math.round(v.h)} · Enter 저장 · C 복사`, 1600);
  }

  function cropElement(el) {
    if (!usable(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    setCandidate(null);
    setCrop({ el }, null);
  }

  function layoutCrop() {
    const c = state.crop;
    const s = ui.crop.style;
    if (!c) { s.display = 'none'; return; }
    let r = null;
    try { r = maskRect(c); } catch (_) { r = c.view; }
    c.view = r;
    if (!r) { s.display = 'none'; return; }
    s.display = 'block';
    s.left = r.x + 'px';
    s.top = r.y + 'px';
    s.width = r.w + 'px';
    s.height = r.h + 'px';
  }

  function layoutMasks() {
    layoutCrop();
    layoutNotes();
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

  /* ============================================================ 한 번에 정리 (Q)
   * 쿠키 배너·채팅 버튼·앱 설치 배너·"오늘 하루 보지 않기" 공지 팝업을 찾아 작업 하나로 숨긴다(빈자리까지, display:none).
   * 찾는 곳은 넷이다. 판정 규칙은 recipes.js 에 있다(classify·popupContainer·isBackdrop — node 에서 단위 시험).
   *   내장 목록     — 동의 관리·채팅·앱 배너 도구가 만드는 요소 (R.VENDORS)
   *   떠 있는 요소  — fixed·sticky 요소의 크기·자리·글·이름·단추
   *   맨 위 띠      — 문서 맨 위에서 내용을 밀어내는 넓고 낮은 요소 (body 의 자식·손자)
   *   공지 팝업     — "오늘 하루 보지 않기" 글을 품은 띄운 요소. 팝업이나 쿠키 창을 숨길 때는 그 뒤의 반투명 가림막도
   * 문서와 그 안 shadow root 를 본다(같은 출처 iframe 안은 보지 않는다). 이미 숨긴 것과 보이지 않는 것은 건너뛰고,
   * 찾은 것끼리 겹치면 바깥 것만 숨긴다. Ctrl+Z 한 번이면 모두 돌아온다. */

  const ACTIONABLE = 'a[href], button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function cleanUp() {
    if (state.busy || !state.active) return;
    endTextEdit();
    endNoteEdit();
    const found = findClutter();
    const counts = countCats(found);
    const n = groupOps('cleanup', () => { for (const f of found) hideEl(f.el, { remove: true }); }, { counts });
    reposition();
    if (!n) { toast('숨길 쿠키 배너·채팅 버튼·앱 설치 배너·공지 팝업을 찾지 못했습니다', 2400); return; }
    toast(`정리했습니다 · ${R.countSummary(counts) || '가림막'} · Ctrl+Z 로 되돌리기`, 3200);
  }

  function countCats(found) {
    const c = {};
    for (const f of found) if (R.CATEGORIES.includes(f.cat)) c[f.cat] = (c[f.cat] || 0) + 1;
    return c;
  }

  /** 숨길 것 [{ el, cat }] — cat 은 'cookie'·'chat'·'app'·'popup'·'backdrop' */
  function findClutter() {
    const roots = [document, ...RC.shadowRoots(document, { skip: (n) => n === host })];
    const view = { w: window.innerWidth, h: window.innerHeight };
    const picked = new Map();
    const backdrops = [];
    const take = (el, cat) => {
      if (!el || el === host || picked.has(el) || !el.isConnected || isRoot(el) || holdsUI(el) || !shownNow(el)) return;
      picked.set(el, cat);
    };

    for (const cat of Object.keys(R.VENDORS)) {
      for (const sel of R.VENDORS[cat]) {
        for (const r of roots) for (const el of queryAll(r, sel)) take(el, cat);
      }
    }
    for (const r of roots) {
      for (const el of r.querySelectorAll('*')) {
        if (el === host || picked.has(el)) continue;
        const pos = styleOf(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const f = clutterInfo(el, pos, view);
        if (!f) continue;
        const cat = R.classify(f);
        if (cat) take(el, cat);
        else if (R.isBackdrop(f)) backdrops.push(el);
      }
    }
    for (const el of topBands(view)) {
      const f = clutterInfo(el, styleOf(el).position, view);
      const cat = f && R.classify(f);
      if (cat) take(el, cat);
    }
    for (const el of popupsByText(roots, view)) take(el, 'popup');
    if ([...picked.values()].some((c) => c === 'popup' || c === 'cookie')) for (const el of backdrops) take(el, 'backdrop');

    // 찾은 것끼리 겹치면 바깥 것만 (바깥 것을 숨기면 안쪽도 함께 사라진다)
    const els = [...picked.keys()];
    return els.filter((el) => !els.some((o) => o !== el && insideOf(o, el))).map((el) => ({ el, cat: picked.get(el) }));
  }

  function queryAll(root, sel) {
    try { return root.querySelectorAll(sel); } catch (_) { return []; }
  }

  /* 이 오버레이를 품은 요소 (모달 dialog 가 열려 있으면 툴바를 그 안에 붙인다 — hostParent). 숨기면 툴바까지 사라진다 */
  function holdsUI(el) {
    return insideOf(el, host);
  }

  /* 지금 화면에 그려지는가. 크기 없는 틀 안에 떠 있는 자식만 보이는 도구도 있다(#onetrust-consent-sdk 처럼) */
  function shownNow(el) {
    const cs = styleOf(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    let n = 0;
    for (const c of el.querySelectorAll('*')) {
      if (++n > 200) break;
      const q = c.getBoundingClientRect();
      if (q.width > 0 && q.height > 0 && styleOf(c).visibility !== 'hidden') return true;
    }
    return false;
  }

  /* 판정에 넘길 요소 정보 (recipes.js 의 classify·isBackdrop). 너무 큰 요소는 글을 읽지 않고 null */
  function clutterInfo(el, pos, view) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const count = el.getElementsByTagName('*').length;
    if (count > 500) return null;
    const text = norm(el.innerText);
    if (text.length > 2000) return null;
    const actions = [];
    const own = el.matches(ACTIONABLE) ? actionText(el) : '';
    if (own) actions.push(own);
    for (const a of el.querySelectorAll(ACTIONABLE)) {
      if (actions.length >= 12) break;
      const t = actionText(a);
      if (t) actions.push(t);
    }
    const frames = [...(el.localName === 'iframe' ? [el] : []), ...el.querySelectorAll('iframe')].slice(0, 4)
      .map((f) => [f.id, f.getAttribute('title'), f.getAttribute('name'), hostOfSrc(f.getAttribute('src'))].filter(Boolean).join(' ')).join(' ');
    const cs = styleOf(el);
    return {
      pos,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      view,
      docTop: r.top + window.scrollY,
      text: text.slice(0, 400),
      plain: plainText(el),
      textLen: text.length,
      attrs: [el.id, typeof el.className === 'string' ? el.className : el.getAttribute('class'), el.getAttribute('role'),
        el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name')].filter(Boolean).join(' ').toLowerCase(),
      frames: frames.toLowerCase(),
      actions,
      count,
      bgAlpha: alphaOf(cs.backgroundColor) * (Number(cs.opacity) || 0)
    };
  }

  function actionText(a) {
    return norm(a.innerText || a.value || a.getAttribute('aria-label') || a.getAttribute('title') || '').slice(0, 40);
  }

  function hostOfSrc(src) {
    try { return src ? new URL(src, location.href).hostname : ''; } catch (_) { return ''; }
  }

  function alphaOf(color) {
    const m = /rgba?\(([^)]+)\)/.exec(String(color || ''));
    if (!m) return 0;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return Number.isFinite(a) ? a : 1;
  }

  /* 링크·단추 밖의 글 (쿠키 안내 문장은 여기에, 메뉴의 "쿠키 설정" 링크는 여기 들어가지 않는다) */
  function plainText(el) {
    const doc = el.ownerDocument;
    const tw = doc.createTreeWalker(el, doc.defaultView.NodeFilter.SHOW_TEXT);
    let s = '';
    for (let n = tw.nextNode(); n && s.length < 600; n = tw.nextNode()) {
      const p = n.parentElement;
      if (!p || /^(script|style|noscript|template)$/.test(p.localName) || inAction(p, el)) continue;
      s += n.data + ' ';
    }
    return norm(s).slice(0, 400);
  }

  function inAction(p, top) {
    for (let c = p; c; c = c.parentElement) {
      if (c.matches(ACTIONABLE)) return true;
      if (c === top) break;
    }
    return false;
  }

  /* 문서 맨 위에서 내용을 밀어내는 넓고 낮은 띠 후보: body 의 자식·손자 */
  function topBands(view) {
    const out = [];
    const b = document.body;
    if (!b) return out;
    const consider = (el) => {
      if (el === host || out.length >= 60) return;
      const pos = styleOf(el).position;
      if (pos === 'fixed' || pos === 'sticky') return; // 떠 있는 요소는 따로 본다
      const r = el.getBoundingClientRect();
      if (r.top + window.scrollY < 160 && r.height > 0 && r.height <= 200 && r.width >= view.w * 0.8) out.push(el);
    };
    for (const c of b.children) {
      consider(c);
      for (const g of c.children) consider(g);
    }
    return out;
  }

  /* "오늘 하루 보지 않기" 같은 글을 품은 요소에서 올라가며 팝업 전체(띄운 가장 바깥 요소)를 고른다 */
  function popupsByText(roots, view) {
    const out = [];
    for (const r of roots) {
      const doc = r.nodeType === 9 ? r : r.ownerDocument;
      const tw = doc.createTreeWalker(r, doc.defaultView.NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const s = n.data;
        if (s.length > 300 || !(s.includes('않') || /show/i.test(s))) continue;
        let at = null;
        for (let e = n.parentElement, i = 0; e && i < 2; e = e.parentElement, i++) {
          const t = e.textContent || '';
          if (t.length <= 300 && R.isPopupText(t)) { at = e; break; }
        }
        if (!at || out.some((o) => insideOf(o, at))) continue;
        const chain = [];
        for (let e = at, i = 0; e && !isRoot(e) && i < 40; e = parentOf(e), i++) {
          const rr = e.getBoundingClientRect();
          const info = {
            el: e,
            f: { pos: styleOf(e).position, rect: { x: rr.left, y: rr.top, w: rr.width, h: rr.height }, view,
              textLen: norm(e.textContent).length, count: e.getElementsByTagName('*').length }
          };
          chain.push(info);
          if (info.f.textLen > 2000 || info.f.count > 500) break;
        }
        const k = R.popupContainer(chain.map((c) => c.f));
        if (k >= 0) out.push(chain[k].el);
      }
    }
    return out;
  }

  /* ============================================================ 사이트별 레시피
   * 이 사이트(도메인)에서 한 일 가운데 다음에도 그대로 할 것 — 지우기·요소째 가리기·글 고침과 정리를 썼는지 — 를
   * 요소를 찾는 선택자로 chrome.storage.local 에 저장하고(툴바 "레시피 저장"), 다음에 선택 모드를 켜면 작업 하나로 바로 적용한다.
   * 같은 출처 iframe·shadow DOM(닫힌 것 포함) 안의 요소는 주인 요소의 선택자를 path 로 함께 남긴다.
   * 영역으로 그린 가리기, 이동·크기, 주석은 그때 화면의 자리라 넣지 않는다. 페이지 글자는 저장하지 않는다
   * (선택자에는 id·클래스·data-testid·name·태그 순서만 쓰고, 이름표는 태그#id.클래스). 저장값의 모양과 한도는 recipes.js.
   * 선택자에 맞는 요소가 여럿이면 모두에 적용한다(항목마다 50개까지). 페이지 구조가 바뀌면 못 찾거나 다른 요소에 맞을 수 있어
   * 적용한 개수와 못 찾은 개수를 알린다. */

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const MAX_MATCH = 50;

  /* 켤 때: 이 사이트의 켜 둔 레시피와 설정 "켤 때 자동으로 정리" */
  async function autoApply() {
    const site = R.hostKey(location.href);
    let rec = null;
    let autoClean = false;
    try {
      const [loc, sync] = await Promise.all([
        site ? chrome.storage.local.get('recipes') : Promise.resolve({}),
        chrome.storage.sync.get({ autoClean: false })
      ]);
      const store = R.normalizeStore(loc.recipes);
      rec = site && store[site] && store[site].on ? store[site] : null;
      autoClean = sync.autoClean === true;
    } catch (_) {
      return; // storage 를 못 읽으면 아무것도 하지 않는다
    }
    const clean = autoClean || !!(rec && rec.cleanup);
    if (!state.active || state.busy || (!rec && !clean)) return;

    let res = { done: {}, missing: 0 };
    let found = [];
    const n = groupOps('auto', () => {
      if (rec) res = applyItems(rec.items);
      if (clean) {
        found = findClutter();
        for (const f of found) hideEl(f.el, { remove: true });
      }
    }, { recipe: !!rec });
    reposition();

    const bits = [];
    if (rec) {
      const done = R.KINDS.filter((k) => res.done[k]).map((k) => `${R.KIND_LABELS[k]} ${res.done[k]}`).join(' · ');
      if (done) bits.push(`레시피를 적용했습니다 · ${done}${res.missing ? ` · 못 찾음 ${res.missing}` : ''}`);
      else if (rec.items.length) bits.push(`레시피의 요소 ${rec.items.length}개를 이 페이지에서 찾지 못했습니다`);
      else bits.push('레시피를 적용했습니다');
    }
    if (clean) {
      const c = R.countSummary(countCats(found));
      if (c) bits.push(`${rec ? '정리' : '켤 때 정리'} · ${c}`);
    }
    if (!bits.length || (!rec && !n)) return; // 자동 정리만 켰고 숨길 것이 없으면 조용히
    if (n) bits.push('Ctrl+Z 로 이번만 빼기');
    toast(bits.join(' · '), 3600);
  }

  /* 레시피 항목을 적용한다. 항목마다 맞는 요소 모두에(50개까지). 종류별로 적용한 항목 수와 못 찾은 항목 수 */
  function applyItems(items) {
    const done = {};
    let missing = 0;
    for (const it of items) {
      let hit = 0;
      for (const el of resolveItem(it)) {
        if (it.kind === 'hide' ? !holdsUI(el) && hideEl(el, { remove: it.remove }) :
          it.kind === 'mask' ? maskElement(el, { fromRecipe: true }) :
          it.kind === 'text' ? setText(el, it.text) : false) hit++;
      }
      if (hit) done[it.kind] = (done[it.kind] || 0) + 1;
      else missing++;
    }
    return { done, missing };
  }

  /* 글 고침을 다시 한다. 되돌릴 때는 텍스트 도구와 같이 원래 노드 객체를 그대로 제자리에 돌려놓는다 */
  function setText(el, text) {
    if (!usable(el)) return false;
    if (el.textContent === text) return true; // 이미 그 글이다
    const tree = snapTree(el);
    el.textContent = text;
    push('text', el, () => restoreTree(tree), false, { text, fromRecipe: true });
    return true;
  }

  /* 항목의 선택자에 맞는 요소. path 를 따라 같은 출처 iframe 의 문서나 shadow root 로 들어간다 */
  function resolveItem(it) {
    let roots = [document];
    for (const step of it.path) {
      const next = [];
      for (const r of roots) {
        for (const el of queryAll(r, step)) {
          const inner = isFrameEl(el) ? frameDoc(el) : shadowOf(el);
          if (inner && !next.includes(inner)) next.push(inner);
          if (next.length >= MAX_MATCH) break;
        }
      }
      roots = next;
      if (!roots.length) return [];
    }
    const out = [];
    for (const r of roots) {
      for (const el of queryAll(r, it.sel)) {
        if (usable(el) && !out.includes(el)) out.push(el);
        if (out.length >= MAX_MATCH) return out;
      }
    }
    return out;
  }

  /* 툴바 "레시피 저장": 지금까지 한 일을 이 사이트 레시피에 더한다 */
  async function saveRecipe() {
    if (state.busy || !state.active) return;
    endTextEdit();
    endNoteEdit();
    const site = R.hostKey(location.href);
    if (!site) { toast('이 페이지에는 레시피를 저장할 수 없습니다', 2400); return; }
    const got = collectRecipe();
    if (!got.items.length && !got.cleanup) {
      toast(`레시피로 저장할 것이 없습니다 · 지운 것·요소째 가린 것·고친 글과 정리를 저장합니다${got.failed ? ` · 위치를 정하지 못한 ${got.failed}개` : ''}`, 3200);
      return;
    }
    let res;
    try {
      const v = await chrome.storage.local.get('recipes');
      const store = R.normalizeStore(v.recipes);
      res = R.addItems(store[site], got.items, { cleanup: got.cleanup, at: Date.now() });
      store[site] = res.recipe;
      await chrome.storage.local.set({ recipes: R.normalizeStore(store) });
    } catch (err) {
      toast(`레시피를 저장하지 못했습니다 · ${(err && err.message) || err}`, 3600);
      return;
    }
    const notes = [];
    if (got.failed) notes.push(`위치를 정하지 못한 ${got.failed}개는 뺐습니다`);
    if (got.skipped) notes.push(`영역 가리기·이동·크기·주석 ${got.skipped}개는 넣지 않습니다`);
    if (res.full) notes.push(`항목이 ${R.LIMITS.items}개라 ${res.full}개는 넣지 못했습니다`);
    toast(`${site} 레시피에 저장했습니다 · ${R.summary(res.recipe)}${notes.length ? ' · ' + notes.join(' · ') : ''} · 다음에 켜면 바로 적용합니다`, 4200);
  }

  /* 작업 스택과 가리기에서 레시피 항목을 모은다 */
  function collectRecipe() {
    const picked = [];
    let cleanup = false;
    let skipped = 0;
    for (const op of state.history) {
      if (op.kind === 'hide' && op.el) picked.push({ kind: 'hide', el: op.el, remove: !!(op.info && op.info.remove) });
      else if (op.kind === 'text' && op.el && op.info) picked.push({ kind: 'text', el: op.el, text: op.info.text });
      else if (op.kind === 'cleanup') cleanup = true;
      // 가리기는 아래에서 지금 남아 있는 것으로 본다. 켤 때 적용한 것(auto)은 이미 레시피에 있고, remove 는 그린 것 지우기
      else if (op.kind !== 'mask' && op.kind !== 'auto' && op.kind !== 'remove') skipped++;
    }
    for (const m of state.masks) {
      if (m.fromRecipe) continue;
      if (m.anchor && m.anchor.el && !m.size) picked.push({ kind: 'mask', el: m.anchor.el });
      else skipped++;
    }
    const items = [];
    let failed = 0;
    for (const p of picked) {
      const loc = p.el.isConnected ? locate(p.el) : null;
      if (!loc) { failed++; continue; }
      const it = { kind: p.kind, path: loc.path, sel: loc.sel, label: label(p.el) };
      if (p.kind === 'hide') it.remove = p.remove;
      if (p.kind === 'text') it.text = p.text;
      items.push(it);
    }
    return { items, cleanup, skipped, failed };
  }

  /* 요소를 다시 찾을 선택자. shadow root·같은 출처 iframe 안이면 바깥으로 나가며 주인 요소의 선택자를 path 에 쌓는다 */
  function locate(el) {
    const steps = [];
    let node = el;
    for (let i = 0; node && i <= R.LIMITS.path; i++) {
      const root = node.getRootNode();
      const sel = localSel(node, root);
      if (!sel || sel.length > R.LIMITS.sel) return null;
      steps.unshift(sel);
      if (root.host) { node = root.host; continue; }
      const f = root.nodeType === 9 ? frameOf(root) : null;
      if (!f) return { path: steps.slice(0, -1), sel: steps[steps.length - 1] };
      node = f;
    }
    return null; // 너무 깊다
  }

  /* root(문서·shadow root) 안에서 el 하나에만 맞는 짧은 선택자. 오래 남을 이름(id·data-testid·클래스·name)부터 쓰고,
     안 되면 조상으로 올라가며 > 와 :nth-of-type 으로 잇는다. 만들 때 그 요소 하나에만 맞는지 확인한다. */
  function localSel(el, root) {
    const uniq = (s) => {
      try {
        const l = root.querySelectorAll(s);
        return l.length === 1 && l[0] === el;
      } catch (_) {
        return false;
      }
    };
    const tag = el.localName;
    const id = el.getAttribute('id');
    if (id && R.stableId(id) && uniq('#' + CSS.escape(id))) return '#' + CSS.escape(id);
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 80 && uniq(`${tag}[${a}="${cssStr(v)}"]`)) return `${tag}[${a}="${cssStr(v)}"]`;
    }
    const cls = stableClasses(el);
    for (const c of cls) if (uniq(`${tag}.${CSS.escape(c)}`)) return `${tag}.${CSS.escape(c)}`;
    for (let i = 0; i < cls.length; i++) {
      for (let j = i + 1; j < cls.length; j++) {
        const s = `${tag}.${CSS.escape(cls[i])}.${CSS.escape(cls[j])}`;
        if (uniq(s)) return s;
      }
    }
    const name = el.getAttribute('name');
    if (name && name.length <= 80 && /^(input|select|textarea|button|form|iframe)$/.test(tag) && uniq(`${tag}[name="${cssStr(name)}"]`)) {
      return `${tag}[name="${cssStr(name)}"]`;
    }
    const parts = [];
    for (let node = el, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      const p = piece(node);
      if (depth > 0 && !p.anchor) {
        const loose = [p.s, ...parts].join(' > ');
        if (uniq(loose)) return loose;
      }
      parts.unshift(p.anchor ? p.s : p.s + nthOf(node));
      const s = parts.join(' > ');
      if (uniq(s)) return s;
    }
    return null;
  }

  /* 경로 한 칸: 오래 남을 id 면 그것만(여기서 멈출 수 있다), 아니면 태그와 클래스 둘까지 */
  function piece(node) {
    const id = node.getAttribute('id');
    if (id && R.stableId(id)) return { s: '#' + CSS.escape(id), anchor: true };
    for (const a of TEST_ATTRS) {
      const v = node.getAttribute(a);
      if (v && v.length <= 80) return { s: `${node.localName}[${a}="${cssStr(v)}"]`, anchor: false };
    }
    return { s: node.localName + stableClasses(node).slice(0, 2).map((c) => '.' + CSS.escape(c)).join(''), anchor: false };
  }

  function nthOf(node) {
    const p = node.parentElement || (node.parentNode && node.parentNode.nodeType === 11 ? node.parentNode : null);
    if (!p) return '';
    let k = 0;
    let n = 0;
    for (const c of p.children) {
      if (c.localName !== node.localName) continue;
      n++;
      if (c === node) k = n;
    }
    return n > 1 ? `:nth-of-type(${k})` : '';
  }

  function stableClasses(el) {
    return [...el.classList].filter(R.stableClass).slice(0, 4);
  }

  function cssStr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
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
      const k = state.drag.kind;
      if (k === 'move') updateMove(p);
      else if (k === 'resize') updateResize(p, e.shiftKey);
      else if (k === 'marquee') updateMarquee(p);
      else if (k === 'objMove') updateObjMove(p);
      else if (k === 'objResize') updateObjResize(p, e.shiftKey);
      else if (k === 'arrow') updateArrowDraw(p);
      else if (k === 'arrowEnd') updateArrowEnd(p);
      return;
    }
    if (state.pass) return; // 페이지 조작 중: 요소를 고르지 않는다
    if (inOurUI(e)) return;
    state.pointer.x = p.x;
    state.pointer.y = p.y;
    if (state.busy || state.editing || state.noteEdit) return;
    if (!host.isConnected) mountHost();
    // 지금 도구로 그린 것 위면 그것을 잡을 수 있다고 보여 주고, 요소는 고르지 않는다
    const over = OBJ_TOOLS.has(state.tool) && !e.shiftKey ? hitObject(state.tool, p) : null;
    setHover(over);
    if (over || FREE_TOOLS.has(state.tool)) {
      if (state.candidate) setCandidate(null);
      return;
    }
    setCandidate(pickAt(p.x, p.y));
  }

  function onPointerDown(e) {
    if (state.pass || inOurUI(e) || inEditing(e)) return; // 페이지 조작 중에는 페이지가 받는다
    if (state.busy) { block(e); return; }
    block(e);
    state.eatClick = false;

    // 글상자에 쓰는 중이면 바깥을 누른 것은 쓰기만 끝낸다
    if (state.noteEdit) {
      endNoteEdit();
      state.eatClick = true;
      return;
    }

    const p = pt(e);
    if (OBJ_TOOLS.has(state.tool) && !e.shiftKey) {
      const hit = hitObject(state.tool, p);
      if (hit) { grabObject(hit, p); return; }
    }
    if (state.sel) select(null);

    if (state.tool === 'move') startMove(p);
    else if (state.tool === 'arrow') startArrow(p);
    else if (AREA_TOOLS.has(state.tool) && e.shiftKey) startMarquee(p);
    else if (AREA_TOOLS.has(state.tool) && !state.candidate) startMarquee(p);
  }

  function onPointerUp(e) {
    if (!state.drag) return;
    block(e);
    const d = state.drag;
    state.drag = null;
    // 그린 것을 잡았거나 화살표를 그렸으면 움직이지 않았어도 뒤따르는 클릭을 도구 동작으로 쓰지 않는다
    state.justDragged = d.moved || d.kind === 'objMove' || d.kind === 'objResize' || d.kind === 'arrow' || d.kind === 'arrowEnd';

    if (d.kind === 'marquee') endMarquee(d);
    else if (d.kind === 'objMove' || d.kind === 'objResize' || d.kind === 'arrowEnd') endObjDrag(d);
    else if (d.kind === 'arrow') endArrow(d, pt(e));
    else if (d.moved) push(d.kind, d.el, d.restore);
    else if (d.restore) d.restore(); // 움직이지 않았으면 없던 일로

    setTimeout(() => { state.justDragged = false; }, 0);
    reposition();
  }

  function onBlocked(e) {
    if (state.pass || inOurUI(e) || inEditing(e)) return; // 페이지 조작 중에는 페이지가 받는다
    block(e);

    if (e.type !== 'click' || state.busy || state.justDragged) return;
    if (state.eatClick) { state.eatClick = false; return; }

    const p = pt(e);
    if (state.tool === 'hide') hideEl(state.candidate || pickAt(p.x, p.y));
    else if (state.tool === 'text') startTextEdit(p.x, p.y);
    else if (state.tool === 'mask') maskElement(state.candidate || pickAt(p.x, p.y));
    else if (state.tool === 'crop') cropElement(state.candidate || pickAt(p.x, p.y));
    else if (state.tool === 'box' || state.tool === 'spot') {
      const el = state.candidate || pickAt(p.x, p.y);
      if (!pickTarget(el)) return;
      if (state.tool === 'box') addNote('box', { el }, null);
      else setSpot({ el }, null);
    }
    else if (state.tool === 'badge') addBadge(p);
    else if (state.tool === 'label') newLabel(p);
  }

  /* 글상자에 쓰는 동안 키 입력이 페이지 단축키에 닿지 않게 한다 (글자는 기본 동작으로 그대로 들어간다).
     이 오버레이 안에서 난 키 입력은 페이지에는 오버레이 요소에서 난 것으로 보여, 입력란인 줄 모르고 단축키로 받는다. */
  function onKeyQuiet(e) {
    if (!state.noteEdit) return;
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  /* Space 를 떼면 페이지 조작을 끝낸다. 버튼에 포커스가 있을 때 Space 를 떼면 눌리므로 그것도 막는다 */
  function onKeyUp(e) {
    onKeyQuiet(e);
    if (e.code !== 'Space' || state.editing || state.noteEdit) return;
    block(e);
    endPass();
  }

  /* ============================================================ 페이지 조작 (Space 를 누르는 동안)
   * 누르고 있는 동안은 클릭·누르기를 막지 않아, 페이지의 드롭다운·메뉴·탭을 직접 열 수 있다. 떼면 다시 고르기로 돌아오고
   * 연 상태 그대로 Enter·C 로 찍는다 — 그 키는 페이지로 가지 않으므로 바깥 클릭이나 키로 닫히는 메뉴도 열린 채 찍힌다.
   * 그동안 요소 강조·핸들·도구 커서를 끄고(페이지 커서가 보인다), 막아 둔 다른 출처 iframe 도 풀어 그 안도 누를 수 있게 한다.
   * 창이 포커스를 잃으면(iframe 안을 누른 경우 등, 떼는 키를 받지 못할 수 있다) 끝낸다. 호버로 열리는 메뉴는 원래도 열린다
   * (포인터 움직임은 막지 않는다).
   */
  const PASS_HINT = '페이지 조작 중 · 클릭이 페이지로 갑니다 · Space 를 떼면 돌아옵니다';

  function startPass() {
    if (state.pass || state.busy || state.drag) return;
    state.pass = { frames: [...blinded.keys()] };
    if (state.hover) { state.hover = null; }
    setCandidate(null);
    unblindAll();
    cursorStyle.textContent = '';
    for (const s of frameStyles.values()) s.textContent = '';
    host.classList.add('passing');
    toast(PASS_HINT, 600000);
  }

  function endPass() {
    const p = state.pass;
    if (!p) return;
    state.pass = null;
    for (const f of p.frames) if (f.isConnected) watchFrame(f); // 다시 막는다 (그사이 같은 출처가 되었으면 안을 고르게)
    host.classList.remove('passing');
    paintCursor();
    if (ui.toast.textContent === PASS_HINT) hideToast();
  }

  function onWindowBlur() {
    if (state.pass) endPass();
  }

  function onKey(e) {
    // 편집 중에는 Esc 만 가로챈다. 나머지는 그대로 입력되어야 한다.
    if (state.editing) {
      if (e.key === 'Escape') { block(e); endTextEdit(); }
      return;
    }

    // 글상자: Enter·Esc 로 끝내고 Shift+Enter 는 줄바꿈. 한글 조합 중의 Enter 는 조합을 끝내는 것이라 두고 본다.
    if (state.noteEdit) {
      onKeyQuiet(e);
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        endNoteEdit();
      }
      return;
    }

    if (e.key === 'Escape') {
      block(e);
      if (state.pass) { endPass(); return; }                // 페이지 조작만 끝낸다
      if (state.full) { state.full.cancel = true; return; } // 전체 페이지 캡처만 멈춘다
      if (state.sel) { select(null); return; }             // 고른 그림이 있으면 고르기만 푼다
      // 정리한 것이 있으면 한 번 더 눌러야 모두 되돌리고 닫는다 — 편집·고르기를 끝내려고 누른 Esc 가 작업을 날리지 않게
      const n = state.history.length;
      if (n && Date.now() - state.escAt > ESC_CONFIRM_MS) {
        state.escAt = Date.now();
        toast(`작업 ${n}개를 모두 되돌리고 닫으려면 Esc 를 한 번 더 누르세요`, ESC_CONFIRM_MS);
        return;
      }
      state.escAt = 0;
      deactivate();
      return;
    }

    if (state.busy) { block(e); return; }

    // Space 를 누르고 있는 동안 페이지 조작 (자동 반복되는 keydown 도 막아 페이지가 스크롤되지 않게)
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      block(e);
      startPass();
      return;
    }

    // 키 위치(code)로 정한 도구는 Shift 와 함께 누르면 고르지 않는다
    const tool = TOOLS.find((t) => (t.code ? e.code === t.code && !e.shiftKey : t.key === e.key));
    if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) {
      block(e);
      setTool(tool.id);
      toast(tool.hint || tool.label, tool.hint ? 1800 : 900);
      return;
    }

    // 고른 그림 지우기
    if ((e.key === 'Delete' || e.key === 'Backspace') && selActive()) {
      block(e);
      removeObject(state.sel);
      return;
    }

    if (e.key === 'Enter') {
      block(e);
      if (e.shiftKey) captureFullPage();
      else captureViewport();
      return;
    }

    // C: 보이는 화면을 클립보드에 복사. 한글 입력 상태에서도 되도록 키 이름이 아니라 키 위치(code)로 본다
    if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      block(e);
      captureViewport('', { copy: true });
      return;
    }

    // Q: 한 번에 정리 (한글 입력 상태의 ㅂ 도 같은 자리)
    if (e.code === 'KeyQ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      block(e);
      cleanUp();
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

    if (selActive()) { nudgeObject(state.sel, dir[0] * step, dir[1] * step); return; }
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

  /* note: 저장했을 때 알릴 문구 (전체 페이지 캡처가 스크롤할 내용이 없어 이리로 넘어온 경우)
     opts.copy: 파일로 저장하지 않고 클립보드에 복사한다 */
  async function captureViewport(note, opts = {}) {
    if (state.busy) return;
    state.busy = true;
    lockBar(true);
    endTextEdit();
    endNoteEdit();
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

    // 6 영역: 고른 부분만 저장·복사한다. 화면에 보이지 않으면 찍지 않는다
    let crop = null;
    let cropNote = '';
    if (state.crop) {
      const v = state.crop.view;
      if (!v || v.w < 1 || v.h < 1) {
        host.classList.remove('capturing');
        setStatus('');
        lockBar(false);
        state.busy = false;
        toast('고른 영역이 화면에 보이지 않습니다 · 보이게 스크롤한 뒤 다시 하세요', 3200);
        return;
      }
      crop = { x: v.x, y: v.y, w: v.w, h: v.h };
      const whole = state.crop.last;
      if (whole && (whole.w - v.w > 1 || whole.h - v.h > 1)) cropNote = ' · 화면 밖 부분은 빠졌습니다';
    }

    const vs = viewSize(document); // 스크롤 막대를 뺀 문서 화면 — 설정(스크롤 막대 빼기)이 켜져 있으면 이만큼만 저장한다
    const res = await send({
      type: 'CLEANSHOT_CAPTURE',
      copy: !!opts.copy,
      pageUrl: location.href,
      pageTitle: document.title,
      masks,
      crop,
      client: { x: 0, y: 0, w: vs.w, h: vs.h },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio || 1
    });

    host.classList.remove('capturing');
    setStatus('');
    lockBar(false);
    state.busy = false;

    if (opts.copy) { await afterCopy(res, cropNote); return; }
    afterSave(res, (typeof note === 'string' && note ? note : '저장했습니다') + cropNote, '캡처 실패');
  }

  /* 복사: 서비스 워커가 가리기까지 칠한 PNG 를 클립보드에 넣고, 되면 전체 복원 후 닫는다.
     클립보드를 쓸 수 없는 페이지(https 가 아닌 http 주소 등)이거나 브라우저가 거부하면,
     정리한 상태를 그대로 두고 이유를 알린다 (Enter 로 파일 저장은 그대로 할 수 있다). */
  async function afterCopy(res, note = '') {
    if (!res || !res.ok || !res.dataUrl) {
      toast(`복사 실패 · ${(res && res.error) || '알 수 없는 오류'}`, 3200);
      return;
    }
    const err = await copyPng(res.dataUrl);
    if (!err) { finish('클립보드에 복사했습니다' + note + (res.note ? ` · ${res.note}` : '')); return; }
    toast(`클립보드에 복사하지 못했습니다 · ${err} · Enter 로 파일 저장은 됩니다`, 4200);
  }

  /* data URL 을 Blob 으로 (PNG·JPEG·WebP — 형식은 data URL 머리에서) */
  function dataBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const m = /^data:([^;,]+)/.exec(dataUrl);
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m ? m[1] : 'image/png' });
  }

  /** PNG 를 클립보드에 넣는다. 되면 빈 문자열, 안 되면 이유 */
  async function copyPng(dataUrl) {
    if (!window.isSecureContext || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
      return '이 페이지(https 가 아닌 주소)에서는 브라우저가 클립보드 쓰기를 막습니다';
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataBlob(dataUrl) })]);
      return '';
    } catch (err) {
      const m = String((err && err.message) || err);
      if (/focus/i.test(m)) return '이 탭에 포커스가 없습니다. 페이지를 한 번 누른 뒤 다시 하세요';
      if (err && err.name === 'NotAllowedError') return '브라우저가 클립보드 쓰기를 허용하지 않았습니다 (사이트 설정의 클립보드 권한을 확인하세요)';
      return m;
    }
  }

  /* 저장 결과를 알린다. 저장했으면 전체 복원 후 닫는다.
     downloads API 가 실패했으면 페이지에서 직접 내려받는다.
     저장 위치 창을 닫았으면(declined) 저장하지 않은 것이므로 정리한 상태를 그대로 둔다. */
  function afterSave(res, done, failed) {
    const note = res && res.note ? ` · ${res.note}` : '';
    if (res && res.ok) {
      const name = res.pending ? '저장 위치 창이 아직 열려 있습니다' : short(res.filename);
      finish(`${done} · ${name}${note}`);
      return;
    }
    if (res && res.declined) {
      toast('저장 위치 창을 닫아 저장하지 않았습니다 · 정리한 것은 그대로입니다', 3200);
      return;
    }

    if (res && res.fallback && res.dataUrl) {
      const err = saveInPage(res.dataUrl, res.filename);
      if (!err) { finish(`브라우저 다운로드로 저장했습니다 · ${short(res.filename)}${note}`); return; }
      toast(`${failed} · ${res.error} · 대체 저장도 실패: ${err}`, 4200);
      return;
    }
    toast(`${failed} · ${(res && res.error) || '알 수 없는 오류'}`, 3200);
  }

  /* ============================================================ 전체 페이지 캡처
   * 스크롤 대상을 위에서부터 한 화면씩 내려가며 찍고, service worker 가 한 장으로 잇는다.
   *   스크롤 대상 — 문서가 스크롤되면 문서. 문서가 스크롤되지 않으면 화면 넓이의 1/4 이상을 차지하는
   *                가장 큰 안쪽 스크롤 영역이고, 그때는 그 영역의 내용만 저장한다(머리글·옆 메뉴는 빠진다).
   *   fixed 요소 — 화면에 붙어 있어 장마다 되풀이될 것은 위쪽에 붙은 것(화면 절반보다 높은 것 포함)은
   *                첫 장에만, 아래쪽에 붙은 것은 마지막 장에만 남긴다. 그 안의 가리기 박스도 함께 따른다.
   *                화면을 거의 다 덮는 것(배경·앱 틀)과 스크롤 영역을 품은 것은 그대로 둔다.
   *   sticky 요소 — 찍는 동안 제자리(position: relative)에 둬서 한 번만 나오게 한다.
   *   가리기 — 화면의 박스 레이어는 숨기고, 장마다 그때의 박스 자리를 보내 service worker 가 칠한다.
   *   주석 — 화면에 그대로 두어 장마다 그 스크롤 위치에 그려진 채 찍힌다. 숨긴 fixed 요소 안의 것은 그 장에서 빼고,
   *          스포트라이트는 구멍이 없는 장도 어둡게 한다(hiddenInFull·layoutSpot).
   * 찍는 동안 휠 스크롤을 막고, Esc 나 아이콘으로 멈출 수 있다. 끝나면(멈춰도) 바꾼 스타일과 스크롤 위치를 돌려놓는다.
   * 장마다 service worker 가 찍기 직전·직후에 이 탭이 아직 활성 탭인지 본다(다른 탭 화면이 섞이지 않게).
   */

  const FULL_MIN_SCROLLER = 0.25; // 안쪽 스크롤 영역이 화면 넓이의 이 비율 이상이어야 대상
  const FULL_BACKDROP = 0.8;      // fixed 요소가 찍는 영역의 이 비율 이상을 덮으면 배경으로 보고 그대로 둔다
  const FULL_IMG_WAIT_MS = 1200;  // 장마다 화면 안 이미지가 다 받아지기를 기다리는 최대 시간
  const FULL_HINT_MS = 700;       // 시작 안내를 보여 주는 시간 (이 동안 Esc 로 그만둘 수 있다)
  const FULL_RETRY = 2;           // 찍는 사이 스크롤이 움직였을 때 같은 장을 다시 찍는 횟수
  const SCROLLS = /^(auto|scroll|hidden|overlay)$/;

  async function captureFullPage() {
    if (state.busy) return;
    endNoteEdit(); // 쓰던 글상자는 마치고 찍는다
    const roots = [document, ...RC.shadowRoots(document)];
    const plan = fullPlan(roots);
    if (!plan) {
      captureViewport('더 내려갈 내용이 없어 보이는 화면을 저장했습니다');
      return;
    }

    state.busy = true;
    lockBar(true);
    endTextEdit();
    setCandidate(null);

    const run = { plan, roots, cancel: false, id: '', undos: [], fixed: [], frame: 0, total: plan.total, truncated: false };
    state.full = run;
    window.addEventListener('wheel', blockWheel, { capture: true, passive: false });
    paintCursor('progress');

    let res;
    try {
      toast('페이지 전체를 위에서부터 찍습니다 · Esc 로 멈춤', FULL_HINT_MS + 300);
      await sleep(FULL_HINT_MS);
      host.classList.add('capturing', 'capturing-full');
      mountHost(); // 그사이 열린 dialog·popover 보다 위로
      res = run.cancel ? { ok: false, cancelled: true } : await shootFull(run);
    } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    } finally {
      undoFull(run);
    }

    if (run.id) {
      if (res && res.ok && !run.cancel) {
        setStatus('저장 중…');
        res = await send({ type: 'CLEANSHOT_FULL_END', id: run.id });
      } else {
        send({ type: 'CLEANSHOT_FULL_END', id: run.id, cancel: true }); // 쌓아 둔 이미지를 버린다
      }
    }
    setStatus('');
    lockBar(false);
    state.busy = false;

    if (run.cancel) { toast('전체 캡처를 멈췄습니다 · 정리한 것은 그대로입니다', 2600); return; }
    const what = plan.el ? '스크롤 영역 전체를 저장했습니다' : '페이지 전체를 저장했습니다';
    const cut = run.truncated ? ` · 너무 길어 위에서 ${Math.round(run.total)}px 까지만` : '';
    afterSave(res, what + cut, '전체 캡처 실패');
  }

  /* 무엇을 스크롤하며 찍을지. 스크롤할 것이 없으면 null.
     clip 은 찍을 영역(화면 CSS px, 스크롤 막대 제외), total 은 내용 전체 높이(CSS px). */
  function fullPlan(roots) {
    const vs = viewSize(document);
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight - vs.h > 1) {
      return { el: null, clip: { x: 0, y: 0, w: vs.w, h: vs.h }, total: se.scrollHeight, top0: window.scrollY, left0: window.scrollX };
    }
    const s = mainScroller(roots, vs);
    if (!s) return null;
    return { el: s.el, clip: s.box, total: s.el.scrollHeight, top0: s.el.scrollTop, left0: s.el.scrollLeft };
  }

  /* 화면 안에 다 들어 있고 화면 넓이의 1/4 이상인 세로 스크롤 영역 가운데 가장 큰 것 */
  function mainScroller(roots, vs) {
    let best = null;
    const consider = (el) => {
      if (el === host || el.clientHeight < 40 || el.scrollHeight - el.clientHeight <= 1) return;
      const oy = styleOf(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return;
      const r = el.getBoundingClientRect();
      const box = { x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight };
      if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > vs.w + 0.5 || box.y + box.h > vs.h + 0.5) return;
      const area = box.w * box.h;
      if (area >= vs.w * vs.h * FULL_MIN_SCROLLER && (!best || area > best.area)) best = { el, box, area };
    };
    if (document.body) consider(document.body);
    for (const r of roots) for (const el of r.querySelectorAll('*')) consider(el);
    return best;
  }

  async function shootFull(run) {
    const { plan } = run;
    const layout = scanLayout(run.roots);
    prepareFull(run, layout.sticky);

    await scrollFullTo(plan, 0);
    const begin = await send({
      type: 'CLEANSHOT_FULL_BEGIN',
      pageUrl: location.href,
      pageTitle: document.title,
      clip: plan.clip,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      total: plan.total,
      dpr: window.devicePixelRatio || 1
    });
    if (!begin || !begin.ok) return begin || { ok: false, error: '응답이 없습니다.' };
    run.id = begin.id;
    run.total = Math.min(plan.total, begin.total);
    run.truncated = !!begin.truncated;

    await sortFixed(run, layout.fixed);

    const h = plan.clip.h;
    // 화면·요소 높이는 정수로 반올림되어 있어 실제로 보이는 높이보다 0.5px 까지 클 수 있다(페이지 확대 등).
    // 끝이 아닌 장은 아래 한 줄을 믿지 않고 다음 장과 겹치게 해 이음매에 빈 줄이 생기지 않게 한다.
    const step = Math.max(1, h - 1);
    const n = run.total <= h + 0.5 ? 1 : Math.ceil((run.total - h) / step - 0.001) + 1;
    let covered = 0; // 내용 맨 위부터 이어 붙인 높이
    let retry = 0;
    const moved = () => ++retry > FULL_RETRY
      ? { ok: false, error: '찍는 동안 페이지가 스스로 스크롤되어 이어 붙일 수 없습니다.' }
      : null;

    for (let i = 0; covered < run.total - 0.5;) {
      if (run.cancel) return { ok: false, cancelled: true };
      if (i > n + 4) break; // 혹시 끝나지 않으면 이어 붙인 데까지만 저장한다

      // 앞 장이 덮은 줄 바로 아래가 화면 맨 위에 오게 한다. 넘어가면 빈 줄이 생기므로 한 줄 덜 내려 본다.
      // 남은 내용이 한 화면보다 적으면 끝(total)이 화면 맨 아래에 오게 한다 — 너무 길어 자른 페이지에서도
      // 바닥글이 저장하는 부분의 맨 아래에 남는다.
      const target = Math.min(Math.floor(covered), Math.max(0, run.total - h));
      let a = await scrollFullTo(plan, target);
      if (a > covered + 0.01) a = await scrollFullTo(plan, target - 1);
      if (a > covered + 0.01) return { ok: false, error: '요청한 자리로 스크롤되지 않아 이어 붙일 수 없습니다.' };
      // 맨 끝까지 내려왔으면 브라우저가 내용 끝을 화면 끝에 맞추므로 끝까지 믿는다
      const last = a + h >= run.total - 0.5;
      const to = last ? run.total : Math.min(run.total, a + step);
      if (to <= covered + 0.5) break; // 더 내려가지 않는다 (찍는 동안 페이지가 짧아졌다)

      showFixed(run, i === 0, last);
      // 주석을 이 장에 맞춘다 — 숨긴 fixed 요소 안의 것은 빼고, 스포트라이트는 구멍이 없는 장도 어둡게
      run.frame = i;
      layoutMasks();
      await settle(plan);
      if (run.cancel) return { ok: false, cancelled: true };
      if (Math.abs(offsetOf(plan) - a) > 0.01) { const e = moved(); if (e) return e; continue; }

      // 마지막 장은 대개 남은 몇 줄만 새로 붙이는데, 아래쪽 fixed 요소(바닥글)는 그보다 위에 놓인다.
      // 그 요소가 시작하는 줄부터 마지막 장으로 다시 덮어 온전히 남긴다(첫 장의 위쪽 fixed 요소 자리는 지킨다).
      if (i === 0) run.topEnd = fixedEdge(run, a, true);
      const from = last && i > 0
        ? Math.min(covered, Math.max(fixedEdge(run, a, false), run.topEnd || 0))
        : covered;

      const masks = frameMasks(run);
      if (!masks) return { ok: false, error: '가리기 박스 자리를 재지 못해 저장하지 않았습니다.' };
      const r = await send({ type: 'CLEANSHOT_FULL_FRAME', id: run.id, offset: a, from, to, masks, index: i, count: n });
      if (!r || !r.ok) return r || { ok: false, error: '응답이 없습니다.' };
      // 찍는 사이 스크롤이 움직였으면 같은 줄을 다시 찍어 덮어쓴다
      if (Math.abs(offsetOf(plan) - a) > 0.01) { const e = moved(); if (e) return e; continue; }

      retry = 0;
      covered = to;
      i++;
    }
    return covered > 0 ? { ok: true } : { ok: false, error: '찍은 화면이 없습니다.' };
  }

  /* 문서와 그 안 shadow root 의 fixed·sticky 요소 (이 오버레이는 빼고) */
  function scanLayout(roots) {
    const fixed = [];
    const sticky = [];
    for (const r of roots) {
      for (const el of r.querySelectorAll('*')) {
        if (el === host) continue;
        const pos = styleOf(el).position;
        if (pos === 'fixed') fixed.push(el);
        else if (pos === 'sticky') sticky.push(el);
      }
    }
    return { fixed, sticky };
  }

  /* 찍는 동안만 바꿔 두는 스타일. 되돌릴 함수는 run.undos 에 쌓는다. */
  function prepareFull(run, sticky) {
    const { plan } = run;
    // 스크롤 스냅(요청한 자리 대신 가까운 스냅 지점에 멈춤)과 스크롤 앵커링(위쪽 내용이 바뀌면
    // 브라우저가 스크롤 위치를 옮김)은 이어 붙일 자리를 어긋나게 하므로 끈다
    const targets = plan.el ? [plan.el] : [document.documentElement, document.body].filter(Boolean);
    for (const t of targets) {
      run.undos.push(snapStyle(t));
      t.style.setProperty('scroll-snap-type', 'none', 'important');
      t.style.setProperty('overflow-anchor', 'none', 'important');
    }
    // 이 스크롤 대상 안의 sticky 요소는 제자리에 둔다 (위치 값은 비워 relative 로 밀리지 않게)
    for (const el of sticky) {
      if (scrollerOf(el) !== plan.el) continue;
      run.undos.push(snapStyle(el));
      el.style.setProperty('position', 'relative', 'important');
      el.style.setProperty('inset', 'auto', 'important');
    }
  }

  /* sticky 요소가 붙는 스크롤 영역. 문서(화면)면 null */
  function scrollerOf(el) {
    for (let p = parentOf(el), i = 0; p && i < 512; p = parentOf(p), i++) {
      if (p === document.body || p === document.documentElement) return null;
      const cs = styleOf(p);
      if (SCROLLS.test(cs.overflowY) || SCROLLS.test(cs.overflowX)) return p;
    }
    return null;
  }

  /* 찍는 영역에 걸친 fixed 요소 가운데 화면에 붙어 장마다 되풀이될 것을 골라, 첫 장에만 남길지
     마지막 장에만 남길지 정한다. 문서를 스크롤할 때는 한 번 내려 봐서 정말 화면에 붙어 있는지 확인한다
     (transform 이 걸린 조상 안의 fixed 요소는 내용과 함께 움직이므로 그대로 둔다). */
  async function sortFixed(run, list) {
    const { plan } = run;
    const c = plan.clip;
    const area = (r) => {
      const w = Math.min(r.right, c.x + c.w) - Math.max(r.left, c.x);
      const h = Math.min(r.bottom, c.y + c.h) - Math.max(r.top, c.y);
      return w > 0 && h > 0 ? w * h : 0;
    };
    let cands = list.filter((el) => {
      if (!el.isConnected || (plan.el && containsDeep(el, plan.el))) return false; // 스크롤 영역을 품은 앱 틀
      const a = area(el.getBoundingClientRect());
      return a > 0 && a < c.w * c.h * FULL_BACKDROP;
    });
    if (!cands.length || run.total <= c.h + 0.5) return;

    if (!plan.el) {
      const before = cands.map((el) => el.getBoundingClientRect().top);
      await scrollFullTo(plan, Math.min(c.h, run.total - c.h));
      cands = cands.filter((el, i) => Math.abs(el.getBoundingClientRect().top - before[i]) < 1);
      await scrollFullTo(plan, 0);
    }
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const top = r.height > c.h / 2 || (r.top + r.bottom) / 2 < c.y + c.h / 2;
      const restore = snapStyle(el);
      run.undos.push(restore);
      run.fixed.push({ el, top, restore, hidden: false });
    }
  }

  /* 위쪽 fixed 요소는 첫 장에만, 아래쪽 fixed 요소는 마지막 장에만 보인다 */
  function showFixed(run, first, last) {
    for (const f of run.fixed) {
      const show = f.top ? first : last;
      if (show && f.hidden) {
        f.restore();
        f.hidden = false;
      } else if (!show && !f.hidden) {
        f.el.style.setProperty('transition', 'none', 'important'); // 서서히 사라지는 도중에 찍히지 않게
        f.el.style.setProperty('visibility', 'hidden', 'important');
        f.hidden = true;
      }
    }
  }

  /* 스크롤 위치 a 에서 보이는 fixed 요소가 내용 좌표로 어디까지 덮는지.
     top 이 true 면 위쪽 요소들의 가장 아래 줄(없으면 0), false 면 아래쪽 요소들의 가장 위 줄(없으면 Infinity). */
  function fixedEdge(run, a, top) {
    const c = run.plan.clip;
    let row = top ? 0 : Infinity;
    for (const f of run.fixed) {
      if (f.top !== top || f.hidden) continue;
      const r = f.el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (top) row = Math.max(row, a + Math.min(c.h, r.bottom - c.y));
      else row = Math.min(row, a + Math.max(0, r.top - c.y));
    }
    return row;
  }

  /* 이번 장에서 칠할 가리기 사각형(화면 CSS px). 숨긴 fixed 요소 안의 것은 뺀다. 재지 못하면 null. */
  function frameMasks(run) {
    const hidden = run.fixed.filter((f) => f.hidden).map((f) => f.el);
    const out = [];
    for (const m of state.masks) {
      const a = m.anchor;
      if (a && a.el && hidden.some((el) => insideOf(el, a.el))) continue;
      let r;
      try { r = maskRect(m); } catch (_) { return null; }
      m.view = r;
      if (r) out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
    return out;
  }

  /* anc 가 el 이거나 el 을 품는가 (shadow DOM 과 같은 출처 iframe 을 건너 올라간다) */
  function insideOf(anc, el) {
    for (let cur = el, i = 0; cur && i < 512; cur = upOf(cur), i++) {
      if (cur === anc) return true;
    }
    return false;
  }

  function offsetOf(plan) {
    return plan.el ? plan.el.scrollTop : window.scrollY;
  }

  /* 즉시(부드러운 스크롤 없이) 옮기고, 스크롤 이벤트가 돈 뒤의 실제 위치를 돌려준다 */
  async function scrollFullTo(plan, y) {
    const opts = { left: plan.left0, top: Math.max(0, y), behavior: 'instant' };
    if (plan.el) plan.el.scrollTo(opts);
    else window.scrollTo(opts);
    await nextPaint();
    return offsetOf(plan);
  }

  /* 찍는 영역 안 이미지가 다 받아지기를 잠깐 기다린 뒤, 바뀐 화면이 합성될 때까지 기다린다 */
  async function settle(plan) {
    const c = plan.clip;
    const waits = [];
    for (const img of document.images) {
      if (img.complete || waits.length >= 200) continue;
      const r = img.getBoundingClientRect();
      if (r.width <= 0 || r.bottom <= c.y || r.top >= c.y + c.h) continue;
      waits.push(new Promise((ok) => {
        img.addEventListener('load', ok, { once: true });
        img.addEventListener('error', ok, { once: true });
      }));
    }
    if (waits.length) await Promise.race([Promise.all(waits), sleep(FULL_IMG_WAIT_MS)]);
    await uiGone();
  }

  /* 바꾼 스타일과 스크롤 위치를 돌려놓는다. 다 찍었든 멈췄든 실패했든 부른다. */
  function undoFull(run) {
    for (let i = run.undos.length - 1; i >= 0; i--) {
      try { run.undos[i](); } catch (_) { /* 나머지는 계속 되돌린다 */ }
    }
    run.undos = [];
    run.fixed = [];
    const p = run.plan;
    try {
      const opts = { left: p.left0, top: p.top0, behavior: 'instant' };
      if (p.el) p.el.scrollTo(opts);
      else window.scrollTo(opts);
    } catch (_) { /* 요소가 사라졌을 수 있다 */ }
    window.removeEventListener('wheel', blockWheel, true);
    host.classList.remove('capturing', 'capturing-full');
    paintCursor();
    state.full = null;
    reposition();
  }

  /* 찍는 동안 사용자가 굴린 휠이 페이지를 움직이지 않게 */
  function blockWheel(e) {
    if (!state.full) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /* <a download> 로 내려받는다. 문서에 붙이지 않은 링크라 페이지의 클릭 리스너와
     선택 모드의 클릭 차단을 거치지 않는다. 폴더는 지정할 수 없어 파일 이름만 쓴다. */
  function saveInPage(dataUrl, filename) {
    try {
      const url = URL.createObjectURL(dataBlob(dataUrl));
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
    ui.full.disabled = on;
    ui.copy.disabled = on;
    ui.clean.disabled = on;
    ui.recipe.disabled = on;
  }

  /* 저장·복사를 마쳤을 때. 찍고 계속이면 정리한 상태를 그대로 두고, 아니면 전체 복원 후 닫는다 */
  function finish(message) {
    if (state.keepAfter) {
      toast(`${message} · 정리한 것은 그대로, 이어서 찍을 수 있습니다`, 2600);
      return;
    }
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
    toastTimer = setTimeout(hideToast, ms || 2000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    ui.toast.style.display = 'none';
  }

  /* 경로의 끝 이름 (저장 위치 창에서 고른 경로는 Windows 면 \ 로 나뉜다) */
  function short(path) {
    return String(path || '').split(/[\\/]/).pop();
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
