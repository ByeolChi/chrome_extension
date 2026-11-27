/* ClickGuide 따라하기 — 저장한 가이드를 실제 화면 위에서 한 단계씩 따라 하게 돕는다.
 * 따라하는 동안에만 등록되어 모든 프레임에서 돈다(서비스 워커가 executeScript 로도 넣는다).
 * 따라하는 탭이 아니면 아무것도 하지 않는다. 대신 눌러 주지는 않는다.
 *  - 서비스 워커가 단계마다 모든 프레임의 find 를 부르고, 점수가 가장 높은 프레임의 show 를 부른다.
 *  - show 한 프레임은 그 요소에 테두리를 그리고, 사용자가 누르거나(입력·목록 단계는 값을 바꾸면) PLAY_DONE 을 보낸다.
 *    요소가 문서에서 사라지거나 한동안 보이지 않으면 PLAY_LOST 를 보내 다시 찾게 한다.
 *  - 맨 위 프레임은 안내 카드(단계 제목·설명·진행·이전/다음/끝내기)를 띄운다 (PLAY_CARD).
 *    새 문서 없이 주소만 바뀌면(SPA) PLAY_ROUTE 를 보내, 화면 이동 단계가 그 화면에서 넘어가게 한다.
 * 화면은 닫힌 shadow root 안에 그려 웹페이지 스크립트가 볼 수 없다. 테두리는 클릭을 막지 않는다(pointer-events: none).
 * chrome.storage 는 읽지 않는다. 필요한 것은 서비스 워커가 메시지로 보낸다.
 */
(() => {
  // 확장을 다시 불러오거나 다시 주입하면 이전 인스턴스를 정리하고 자리를 넘겨받는다
  try { if (typeof window.__CLICKGUIDE_PLAYER_TEARDOWN__ === 'function') window.__CLICKGUIDE_PLAYER_TEARDOWN__(); } catch (_) { /* noop */ }

  const IS_TOP = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const CUES = globalThis.ClickGuideCues || null;
  const Z = '2147483647';
  const LOST_AFTER_MS = 1500;   // 표시한 요소가 이만큼 보이지 않으면 다시 찾는다

  let lastFound = null;   // { token, el, type } 이 프레임에서 마지막으로 찾은 요소
  let shown = null;       // { token, el, type, host, ring, tip, raf, off, done, hiddenSince }
  let card = null;        // 맨 위 프레임의 안내 카드
  let view = null;        // 카드에 보이는 단계 (서비스 워커가 보낸 것)
  let shot = null;        // { token, state: 'loading'|'ok'|'none' }
  let left = false;       // 카드를 왼쪽에 둠
  let collapsed = false;
  let keepPort = null;
  let keepTimer = null;
  let onRuntimeMessage = null;

  // 이 프레임에서 마지막으로 누른 때와, 단계를 끝내는 데 쓴 누름의 때. 이미 앞 단계를 끝낸 누름의 click 은 세지 않는다
  // (같은 단추를 연달아 누르는 단계: 누를 때 앞 단계가 끝나고, 떼기 전에 다음 단계 테두리가 같은 단추에 붙는다)
  let lastDownAt = -Infinity;
  let usedDownAt = NaN;
  const onAnyPointerDown = (e) => { if (e.isTrusted) lastDownAt = e.timeStamp; };
  window.addEventListener('pointerdown', onAnyPointerDown, true);

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;   // 컨텍스트 무효화 무시
          resolve(res || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 찾기                                                                 */
  /* ------------------------------------------------------------------ */

  /* 이 프레임이 녹화한 프레임과 맞는 정도. 예전 가이드(cv 없음)는 어느 프레임이었는지 모른다 */
  function frameBonus(cues) {
    if (!cues || !cues.cv) return 0;
    const frames = Array.isArray(cues.frames) ? cues.frames : [];
    if (!frames.length) return IS_TOP ? 6 : -12;
    if (IS_TOP) return -12;
    const inner = frames[frames.length - 1] || {};
    let b = 0;
    if (inner.path && location.pathname === inner.path) b += 8;
    if (inner.name && window.name === inner.name) b += 4;
    try {
      const fe = window.frameElement;   // 다른 출처면 null
      if (fe && inner.id && fe.id === inner.id) b += 6;
    } catch (_) { /* noop */ }
    let depth = 0;
    try { for (let w = window; w !== w.parent && depth < 10; w = w.parent) depth++; } catch (_) { depth = -1; }
    if (depth === frames.length) b += 3;
    return b;
  }

  /* req: { token, cues: 단계의 el, nrect, type } → { found, score, … } */
  function find(req) {
    if (!CUES || !req || !req.cues) return null;
    let res = null;
    try {
      // 녹화 때 상자(nrect)는 맨 위 화면 기준이라 맨 위 프레임에서만 자리 점수에 쓴다
      res = CUES.find(req.cues, { nrect: IS_TOP ? req.nrect : null, frameBonus: frameBonus(req.cues) });
    } catch (e) {
      return { found: false, score: 0, error: String((e && e.message) || e) };
    }
    if (!res || res.score < CUES.FOUND_SCORE) {
      if (lastFound && lastFound.token === req.token) lastFound = null;
      return { found: false, score: res ? res.score : 0 };
    }
    lastFound = { token: req.token, el: res.el, type: req.type || 'click' };
    return { found: true, score: res.score, second: res.second, why: res.why, count: res.count };
  }

  /* ------------------------------------------------------------------ */
  /* 표시 (찾은 요소의 테두리)                                            */
  /* ------------------------------------------------------------------ */

  const RING_CSS = `
  :host { all: initial; }
  .ring {
    position: fixed; box-sizing: border-box; display: none;
    border: 3px solid #ff6a00; border-radius: 8px; pointer-events: none;
    box-shadow: 0 0 0 3px rgba(255,106,0,.25), 0 0 12px rgba(255,106,0,.45);
    animation: cg-pulse 1.4s ease-in-out infinite;
  }
  @keyframes cg-pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(255,106,0,.25), 0 0 12px rgba(255,106,0,.45); }
    50% { box-shadow: 0 0 0 7px rgba(255,106,0,.12), 0 0 22px rgba(255,106,0,.6); }
  }
  @media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
  .tip {
    position: absolute; left: -3px; bottom: 100%; margin-bottom: 6px; white-space: nowrap;
    background: #ff6a00; color: #fff; padding: 5px 8px; border-radius: 6px;
    font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  }
  .tip.below { bottom: auto; top: 100%; margin: 6px 0 0; }
  `;

  function tipText(type) {
    if (type === 'input') return '여기에 입력하세요';
    if (type === 'select') return '여기서 고르세요';
    return '여기를 누르세요';
  }

  function show(token) {
    if (!lastFound || lastFound.token !== token || !lastFound.el || !lastFound.el.isConnected) return { ok: false };
    if (shown && shown.token === token && shown.el === lastFound.el) return { ok: true };
    clear();
    const { el, type } = lastFound;
    const host = document.createElement('div');
    host.setAttribute('data-clickguide-ui', '');
    host.style.cssText = `all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:${Z};pointer-events:none;`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = RING_CSS;
    const ring = document.createElement('div');
    ring.className = 'ring';
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = tipText(type);
    ring.append(tip);
    root.append(style, ring);
    (document.documentElement || document.body).appendChild(host);
    shown = { token, el, type, host, ring, tip, raf: 0, off: null, done: false, hiddenSince: 0 };
    try {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) { /* noop */ }
    track(shown);
    watchDone(shown);
    if (IS_TOP) setTimeout(avoidCard, 50);
    return { ok: true };
  }

  function track(s) {
    const tick = () => {
      if (shown !== s) return;
      if (!s.el.isConnected) { lost(s); return; }
      let r = null;
      try { r = s.el.getBoundingClientRect(); } catch (_) { r = null; }
      const visible = !!(r && (r.width > 0 || r.height > 0));
      if (!visible) {
        if (!s.hiddenSince) s.hiddenSince = performance.now();
        else if (performance.now() - s.hiddenSince > LOST_AFTER_MS) { lost(s); return; }
        s.ring.style.display = 'none';
      } else {
        s.hiddenSince = 0;
        const pad = 4;
        s.ring.style.display = 'block';
        s.ring.style.left = (r.left - pad) + 'px';
        s.ring.style.top = (r.top - pad) + 'px';
        s.ring.style.width = (r.width + pad * 2) + 'px';
        s.ring.style.height = (r.height + pad * 2) + 'px';
        s.tip.classList.toggle('below', r.top < 34);
      }
      s.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function lost(s) {
    if (shown !== s) return;
    const t = s.token;
    clear();
    send({ type: 'PLAY_LOST', token: t });
  }

  /* 사용자가 그 요소를 눌렀는지(입력·목록 단계는 값을 바꿨는지) 본다 */
  function watchDone(s) {
    const doc = s.el.ownerDocument || document;
    const done = () => {
      if (shown !== s || s.done) return;
      s.done = true;
      const t = s.token;
      clear();
      send({ type: 'PLAY_DONE', token: t });
    };
    const inPath = (e) => {
      try { return (e.composedPath ? e.composedPath() : [e.target]).includes(s.el); } catch (_) { return false; }
    };
    const offs = [];
    if (s.type === 'input' || s.type === 'select') {
      // 다 쓰고 칸을 벗어나거나 Enter 를 누르면 change 가 온다. 페이지 스크립트가 쏜 것은 그 칸이 포커스를 가졌을 때만 인정
      const onChange = (e) => {
        if (!inPath(e)) return;
        if (e.isTrusted || doc.activeElement === s.el) done();
      };
      doc.addEventListener('change', onChange, true);
      offs.push(() => doc.removeEventListener('change', onChange, true));
    } else {
      const onDown = (e) => {
        if (!e.isTrusted || e.button !== 0 || !inPath(e)) return;
        usedDownAt = e.timeStamp;
        done();
      };
      // 키보드(Enter·Space)로 누른 경우(detail 0), label 을 눌러 넘어온 click, 테두리를 다시 그리는 사이에 시작한 누름.
      // 마우스 click 인데 그 누름이 이미 앞 단계를 끝냈으면 세지 않는다
      const onClick = (e) => {
        if (!e.isTrusted || !inPath(e)) return;
        if (e.detail > 0 && lastDownAt === usedDownAt) return;
        done();
      };
      doc.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('click', onClick, true);
      offs.push(() => {
        doc.removeEventListener('pointerdown', onDown, true);
        doc.removeEventListener('click', onClick, true);
      });
    }
    s.off = () => offs.forEach((f) => { try { f(); } catch (_) { /* noop */ } });
  }

  function clear() {
    if (!shown) return;
    const s = shown;
    shown = null;
    try { cancelAnimationFrame(s.raf); } catch (_) { /* noop */ }
    try { if (s.off) s.off(); } catch (_) { /* noop */ }
    try { s.host.remove(); } catch (_) { /* noop */ }
  }

  /* ------------------------------------------------------------------ */
  /* 안내 카드 (맨 위 프레임)                                              */
  /* ------------------------------------------------------------------ */

  const CARD_CSS = `
  :host { all: initial; }
  .card {
    box-sizing: border-box; width: 330px; max-height: calc(100vh - 32px); overflow: auto;
    background: #fff; color: #1d1d1f; border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.22);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  }
  .head { display: flex; align-items: center; gap: 6px; padding: 9px 10px 9px 12px; border-bottom: 1px solid rgba(0,0,0,.08); }
  .badge { flex: none; background: #ff6a00; color: #fff; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 999px; }
  .name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .count { flex: none; color: #6e6e73; font-variant-numeric: tabular-nums; }
  .ic { flex: none; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0; }
  .ic:hover { background: rgba(0,0,0,.07); }
  .body { padding: 10px 12px 12px; }
  .title { font-weight: 700; font-size: 14px; margin-bottom: 4px; word-break: keep-all; overflow-wrap: anywhere; }
  .desc { color: #3a3a3c; white-space: pre-wrap; overflow-wrap: anywhere; }
  .desc:empty, .title:empty { display: none; }
  .value { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: #f2f2f5; overflow-wrap: anywhere; }
  .status { margin-top: 10px; padding: 7px 9px; border-radius: 8px; background: #fff4eb; color: #8a3a00; }
  .status.warn { background: #fdecea; color: #a1180f; }
  .status.ok { background: #eaf7ee; color: #1b6b32; }
  .shotbox { margin-top: 10px; }
  .shotbox canvas { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid rgba(0,0,0,.12); }
  .shotnote { margin-top: 4px; color: #6e6e73; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .sp { flex: 1; }
  button.b { border: 1px solid rgba(0,0,0,.16); background: #fff; color: inherit; border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
  button.b:hover { background: #f5f5f7; }
  button.b.primary { background: #ff6a00; border-color: #ff6a00; color: #fff; font-weight: 600; }
  button.b.primary:hover { background: #ea6200; }
  button.b:disabled { opacity: .45; cursor: default; }
  [hidden] { display: none !important; }
  .collapsed .body { display: none; }
  @media (prefers-color-scheme: dark) {
    .card { background: #1c1c1e; color: #f2f2f7; border-color: rgba(255,255,255,.14); }
    .head { border-bottom-color: rgba(255,255,255,.1); }
    .count, .shotnote { color: #a1a1a6; }
    .desc { color: #d1d1d6; }
    .ic:hover, button.b:hover { background: rgba(255,255,255,.1); }
    .value { background: #2c2c2e; }
    .status { background: #3a2a1c; color: #ffb877; }
    .status.warn { background: #3b1f1d; color: #ff9d94; }
    .status.ok { background: #1d3324; color: #8fe0a6; }
    button.b { background: #2c2c2e; border-color: rgba(255,255,255,.16); }
    button.b.primary { background: #ff6a00; border-color: #ff6a00; color: #fff; }
  }
  `;

  function ensureCard() {
    if (card) return card;
    const host = document.createElement('div');
    host.setAttribute('data-clickguide-ui', '');
    host.style.cssText = `all:initial;position:fixed;z-index:${Z};bottom:16px;right:16px;`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CARD_CSS;
    const box = document.createElement('div');
    box.className = 'card';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'ClickGuide 따라하기');
    box.innerHTML = `
      <div class="head">
        <span class="badge">따라하기</span><span class="name"></span><span class="count"></span>
        <button class="ic side" title="카드를 반대쪽으로 옮기기">⇄</button>
        <button class="ic min" title="접기">–</button>
        <button class="ic close" title="따라하기 끝내기">✕</button>
      </div>
      <div class="body">
        <div class="title"></div>
        <div class="desc"></div>
        <div class="value" hidden></div>
        <div class="status"></div>
        <div class="shotbox" hidden><canvas></canvas><div class="shotnote">녹화할 때의 화면입니다. 주황색 상자가 누른 곳입니다.</div></div>
        <div class="row">
          <button class="b prev">◀ 이전</button>
          <button class="b shot-toggle">녹화 화면</button>
          <span class="sp"></span>
          <button class="b retry" hidden>다시 찾기</button>
          <button class="b goto" hidden>이 화면 열기</button>
          <button class="b restart" hidden>처음부터</button>
          <button class="b next primary">다음 ▶</button>
        </div>
      </div>`;
    root.append(style, box);
    (document.documentElement || document.body).appendChild(host);
    const q = (sel) => box.querySelector(sel);
    card = {
      host, box,
      name: q('.name'), count: q('.count'), title: q('.title'), desc: q('.desc'), value: q('.value'), status: q('.status'),
      shotbox: q('.shotbox'), canvas: q('.shotbox canvas'),
      prev: q('.prev'), next: q('.next'), retry: q('.retry'), goto: q('.goto'), restart: q('.restart'), shotToggle: q('.shot-toggle'),
      side: q('.side'), min: q('.min'), close: q('.close')
    };
    const ctrl = (action) => () => { if (view) send({ type: 'PLAY_CTRL', action, token: view.token }); };
    card.prev.addEventListener('click', ctrl('prev'));
    card.next.addEventListener('click', ctrl('next'));
    card.retry.addEventListener('click', ctrl('retry'));
    card.goto.addEventListener('click', ctrl('goto'));
    card.restart.addEventListener('click', ctrl('restart'));
    card.close.addEventListener('click', () => { send({ type: 'PLAY_CTRL', action: 'stop' }); endAll(); });
    card.shotToggle.addEventListener('click', () => {
      if (!card.shotbox.hidden) { card.shotbox.hidden = true; return; }
      showShot();
    });
    card.side.addEventListener('click', () => { left = !left; placeCard(); });
    card.min.addEventListener('click', () => {
      collapsed = !collapsed;
      card.box.classList.toggle('collapsed', collapsed);
      card.min.textContent = collapsed ? '+' : '–';
      card.min.title = collapsed ? '펼치기' : '접기';
    });
    // 카드 안을 누른 것은 페이지에 다른 일이 일어나지 않게 (녹화 바와 같은 방식)
    for (const t of ['pointerdown', 'mousedown', 'click']) host.addEventListener(t, (e) => e.stopPropagation());
    placeCard();
    startKeepAlive();
    return card;
  }

  function placeCard(avoid) {
    if (!card) return;
    const onLeft = avoid === undefined ? left : avoid;
    card.host.style.left = onLeft ? '16px' : 'auto';
    card.host.style.right = onLeft ? 'auto' : '16px';
  }

  /* 표시한 요소가 카드 밑에 깔리면 카드를 반대쪽으로 */
  function avoidCard() {
    if (!card || !shown) return;
    let a = null;
    let b = null;
    try { a = shown.el.getBoundingClientRect(); b = card.host.getBoundingClientRect(); } catch (_) { return; }
    const overlap = a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    if (overlap) placeCard(!left);
  }

  const STATUS = {
    finding: () => ['', '이 화면에서 찾는 중…'],
    found: (v) => ['', v.step.type === 'input'
      ? '주황색으로 표시한 칸에 입력하세요. 다 쓰고 Enter·Tab 을 누르거나 칸 밖을 누르면 다음 단계로 넘어갑니다.'
      : v.step.type === 'select'
        ? '주황색으로 표시한 목록에서 고르세요. 고르면 다음 단계로 넘어갑니다.'
        : '주황색으로 표시한 곳을 누르세요. 누르면 다음 단계로 넘어갑니다.'],
    notfound: (v) => ['warn', v.offPage
      ? '이 화면에서 찾지 못했습니다. 녹화할 때와 다른 화면입니다. [이 화면 열기]로 그 화면을 열거나, 직접 한 뒤 [제가 했어요]를 누르세요.'
      : '이 화면에서 찾지 못했습니다. 화면이 바뀌었을 수 있습니다. 아래 녹화 화면을 보고 직접 한 뒤 [제가 했어요]를 누르세요.'],
    navigate: (v) => ['', `다음 화면으로 넘어갑니다${v.step.pageTitle ? ` — ${v.step.pageTitle}` : ''}. 그 화면이 열리면 저절로 다음 단계로 갑니다.`],
    note: () => ['', '읽고 [다음]을 누르세요.'],
    done: () => ['ok', '모든 단계를 마쳤습니다.']
  };

  function renderCard() {
    if (!view) return;
    ensureCard();
    const v = view;
    const st = v.step || {};
    const isDone = v.status === 'done';
    card.name.textContent = v.name || '가이드';
    card.count.textContent = isDone ? `${v.total} / ${v.total}` : `${v.index + 1} / ${v.total}`;
    card.title.textContent = isDone ? '따라하기를 마쳤습니다' : (st.title || '');
    card.desc.textContent = isDone ? `${v.total}단계를 모두 따라 했습니다.` : (st.description || '');
    if (!isDone && (st.type === 'input' || st.type === 'select') && st.value) {
      card.value.hidden = false;
      card.value.textContent = st.masked
        ? '녹화할 때 가린 값입니다. 알맞은 값을 직접 입력하세요.'
        : `${st.type === 'select' ? '고를 항목' : '입력할 값(예)'}: ${st.value}`;
    } else card.value.hidden = true;
    const [cls, text] = (STATUS[v.status] || STATUS.finding)(v);
    card.status.className = 'status' + (cls ? ' ' + cls : '');
    card.status.textContent = text;
    card.prev.disabled = !isDone && v.index <= 0;
    card.prev.hidden = false;
    card.next.hidden = isDone;
    card.next.textContent = v.status === 'notfound' ? '제가 했어요 ▶'
      : (v.status === 'note' || v.status === 'navigate') ? '다음 ▶' : '건너뛰기 ▶';
    card.retry.hidden = v.status !== 'notfound';
    card.goto.hidden = !(v.status === 'navigate' || (v.status === 'notfound' && v.offPage));
    card.restart.hidden = !isDone;
    card.shotToggle.hidden = isDone || !v.hasShot;
    // 단계가 바뀌면 이전 단계의 녹화 화면은 치운다. 못 찾으면 녹화 화면을 바로 보여 준다
    if (!shot || shot.token !== v.token) {
      card.shotbox.hidden = true;
      shot = null;
    }
    if (v.status === 'notfound' && v.hasShot) showShot();
    if (isDone) { card.close.title = '닫기'; card.prev.textContent = '◀ 마지막 단계'; } else { card.close.title = '따라하기 끝내기'; card.prev.textContent = '◀ 이전'; }
  }

  /* 녹화할 때의 화면. 페이지의 CSP 와 상관없게 이미지 대신 canvas 에 그린다 */
  async function showShot() {
    if (!view || !card) return;
    const token = view.token;
    if (shot && shot.token === token && shot.state === 'ok') { card.shotbox.hidden = false; return; }
    if (shot && shot.token === token && shot.state === 'loading') return;
    shot = { token, state: 'loading' };
    const res = await send({ type: 'PLAY_SHOT', token });
    if (!view || view.token !== token || !card) return;
    if (!res || !res.ok || !res.b64) { shot = { token, state: 'none' }; card.shotbox.hidden = true; return; }
    try {
      const bin = atob(res.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: res.mime || 'image/jpeg' }));
      const W = 600;
      const H = Math.max(1, Math.round(bmp.height * (W / bmp.width)));
      const c = card.canvas;
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, W, H);
      // 편집기에서 더 가린 곳 (이미지에는 아직 칠해져 있지 않다). 흐리게 설정이어도 여기서는 검게 칠한다
      ctx.fillStyle = '#000';
      const RC = globalThis.RedactCore || null;
      const reds = RC && RC.toPixelRects
        ? RC.toPixelRects(res.redactions || [], W, H, W, H)
        : (res.redactions || []).filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite))
          .map((r) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H }));
      for (const r of reds) ctx.fillRect(r.x, r.y, r.w, r.h);
      const n = res.nrect;
      if (n && [n.x, n.y, n.w, n.h].every(Number.isFinite)) {
        ctx.strokeStyle = '#ff6a00';
        ctx.lineWidth = 4;
        ctx.strokeRect(n.x * W - 3, n.y * H - 3, n.w * W + 6, n.h * H + 6);
      }
      shot = { token, state: 'ok' };
      card.shotbox.hidden = false;
    } catch (_) {
      shot = { token, state: 'none' };
      card.shotbox.hidden = true;
    }
  }

  /* 따라하는 동안 서비스 워커가 잠들지 않게 (녹화와 같은 포트 이름) */
  function startKeepAlive() {
    if (!IS_TOP || keepPort) return;
    try {
      keepPort = chrome.runtime.connect({ name: 'cg-keepalive' });
      keepPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        keepPort = null;
        // 서비스 워커가 다시 떴다면 이어서 붙잡고, 지금 단계를 다시 받아 온다
        setTimeout(() => { if (card) { startKeepAlive(); send({ type: 'PLAY_HELLO' }); } }, 500);
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

  function removeCard() {
    if (!card) return;
    try { card.host.remove(); } catch (_) { /* noop */ }
    card = null;
  }

  function endAll() {
    clear();
    removeCard();
    stopKeepAlive();
    view = null;
    shot = null;
    lastFound = null;
  }

  /* ------------------------------------------------------------------ */
  /* 서비스 워커와 주고받기                                                */
  /* ------------------------------------------------------------------ */

  try {
    onRuntimeMessage = (msg, _sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'PLAY_END') { endAll(); return; }
      if (msg.type === 'PLAY_CLEAR') { clear(); return; }
      if (!IS_TOP) return;   // 아래는 맨 위 프레임만
      if (msg.type === 'PLAY_PING') { sendResponse({ ok: true }); return true; }
      if (msg.type === 'PLAY_CARD') {
        view = msg.view || null;
        if (view) renderCard(); else removeCard();
        sendResponse({ ok: true });
        return true;
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (_) { /* noop */ }

  // 서비스 워커가 부르는 함수들 (scripting.executeScript 로, 이 격리된 환경에서). 웹페이지는 볼 수 없다
  const api = {
    find,
    show,
    clear,
    // 시험용: 카드와 테두리의 지금 모습
    debug: () => ({
      top: IS_TOP,
      card: card ? {
        name: card.name.textContent, count: card.count.textContent, title: card.title.textContent, desc: card.desc.textContent,
        value: card.value.hidden ? null : card.value.textContent, status: card.status.textContent, statusClass: card.status.className,
        next: card.next.hidden ? null : card.next.textContent, retry: !card.retry.hidden, goto: !card.goto.hidden, restart: !card.restart.hidden,
        prevDisabled: card.prev.disabled, shotShown: !card.shotbox.hidden, shotW: card.canvas.width, left: card.host.style.left === '16px',
        rect: (() => { const r = card.host.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()
      } : null,
      ring: shown ? (() => {
        const r = shown.ring.getBoundingClientRect();
        const e = shown.el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, shown: shown.ring.style.display !== 'none', tip: shown.tip.textContent, el: { x: e.left, y: e.top, w: e.width, h: e.height } };
      })() : null
    }),
    // 시험용: 카드의 단추 누르기 (이름: prev·next·retry·goto·restart·close·side·min·shot-toggle)
    press: (name) => {
      if (!card) return false;
      const b = card.box.querySelector('.' + name);
      if (!b || b.hidden || b.disabled) return false;
      b.click();
      return true;
    }
  };
  window.__CLICKGUIDE_PLAYER__ = api;

  window.__CLICKGUIDE_PLAYER_TEARDOWN__ = () => {
    endAll();
    window.removeEventListener('pointerdown', onAnyPointerDown, true);
    stopRouteWatch();
    try { if (onRuntimeMessage) chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) { /* noop */ }
    if (window.__CLICKGUIDE_PLAYER__ === api) window.__CLICKGUIDE_PLAYER__ = null;
  };

  /* 새 문서 없이 주소만 바뀐 경우(SPA: pushState·해시 주소). 탭 이벤트는 이때도 새 문서처럼 'loading' 과 함께 오므로
   * 서비스 워커는 둘을 가려낼 수 없다. 맨 위 프레임이 보고 알리면, 화면 이동 단계일 때 서비스 워커가 그 화면인지 다시 본다 */
  let routeHref = location.href;
  let routeTimer = 0;
  const onRoute = () => {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      if (location.href === routeHref) return;
      routeHref = location.href;
      if (view) send({ type: 'PLAY_ROUTE' });   // 따라하는 탭(카드가 떠 있음)에서만
    }, 100);
  };
  const nav = (() => {
    try { return window.navigation && typeof window.navigation.addEventListener === 'function' ? window.navigation : null; } catch (_) { return null; }
  })();
  if (IS_TOP) {
    if (nav) nav.addEventListener('currententrychange', onRoute);
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
  }
  const stopRouteWatch = () => {
    clearTimeout(routeTimer);
    try { if (nav) nav.removeEventListener('currententrychange', onRoute); } catch (_) { /* noop */ }
    window.removeEventListener('popstate', onRoute);
    window.removeEventListener('hashchange', onRoute);
  };

  // 맨 위 프레임: 새 문서가 열리면 따라하는 탭인지 묻는다. 따라하는 중이면 서비스 워커가 지금 단계를 다시 보낸다
  if (IS_TOP) send({ type: 'PLAY_HELLO' });
})();
