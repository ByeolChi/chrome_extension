/* CleanShot Picker — 설정 화면 (options.html)
 * 저장 형식·크기·파일 이름 양식·저장 위치 묻기·주소와 시각 띠·스크롤 막대 빼기·이어서 찍기·켤 때 정리를 chrome.storage.sync 에 둔다.
 * 값의 뜻과 기본값, 파일 이름 만들기는 settings.js(서비스 워커와 같은 파일)를 쓴다. 바꾸면 바로 저장한다.
 * 사이트별 레시피(chrome.storage.local 'recipes')를 보여 주고 켜기·끄기, 정리 포함, 항목·사이트 지우기를 한다 (저장값은 recipes.js).
 */
(() => {
  'use strict';

  const CS = globalThis.CleanShotSettings;
  const $ = (id) => document.getElementById(id);
  const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];
  const nameInput = $('nameTemplate');
  const EXAMPLE = { url: 'https://www.example.com/docs/page?id=1', title: '사용 설명서 · 예시' };

  let current = CS.normalize(null);
  let savedTimer = 0;

  function paint(v) {
    radios('outFormat').forEach((r) => { r.checked = r.value === v.outFormat; });
    radios('outScale').forEach((r) => { r.checked = r.value === v.outScale; });
    if (document.activeElement !== nameInput) nameInput.value = v.nameTemplate;
    $('askWhere').checked = v.askWhere;
    $('stamp').checked = v.stamp;
    $('hideScrollbars').checked = v.hideScrollbars;
    $('keepAfter').checked = v.keepAfter;
    $('autoClean').checked = v.autoClean;
    paintPreview();
  }

  /* 이 화면의 배율을 알려 준다 (확장을 쓰는 탭과 같은 모니터라면 같은 값) */
  function paintDpr() {
    const d = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    $('dprNote').textContent = ` · 지금 이 화면은 ${d}배`;
  }

  function paintPreview() {
    const tpl = nameInput.value;
    const ext = CS.FORMATS[current.outFormat].ext;
    const at = new Date();
    const name = CS.fileName(tpl, { ...EXAMPLE, at, suffix: '', ext });
    const full = CS.fileName(tpl, { ...EXAMPLE, at, suffix: '-full', ext });
    const box = $('namePreview');
    const line = (label, text) => {
      const div = document.createElement('div');
      const code = document.createElement('code');
      code.textContent = text;
      div.append(label, code);
      return div;
    };
    box.replaceChildren(line('예: ', name), line('전체 페이지: ', full));

    const warns = [];
    const trimmed = tpl.trim();
    if (!trimmed) warns.push('비어 있어 기본 양식을 씁니다.');
    else {
      const { unknown } = CS.fillTemplate(trimmed, { ...EXAMPLE, at });
      if (unknown.length) warns.push(`모르는 칸은 글자 그대로 들어갑니다: ${unknown.map((k) => `{${k}}`).join(' ')}`);
      if (!/\{(time|title)\}/.test(trimmed)) warns.push('{time} 이나 {title} 이 없으면 이름이 겹치기 쉽습니다. 겹치면 Chrome 이 끝에 (1), (2)… 를 붙입니다.');
    }
    const w = $('nameWarn');
    w.textContent = warns.join(' ');
    w.hidden = !warns.length;
  }

  async function write(patch) {
    current = CS.normalize({ ...current, ...patch });
    try {
      await chrome.storage.sync.set(patch);
      flash('저장했습니다');
    } catch (err) {
      flash(`저장하지 못했습니다 · ${(err && err.message) || err}`, true);
    }
    paintPreview();
  }

  /* 오른쪽 아래 알림. 실패는 사라지지 않게 둔다 */
  function flash(text, stay) {
    const s = $('saved');
    s.textContent = text;
    s.classList.add('on');
    clearTimeout(savedTimer);
    if (!stay) savedTimer = setTimeout(() => s.classList.remove('on'), 1200);
  }

  radios('outFormat').forEach((r) => r.addEventListener('change', () => { if (r.checked) write({ outFormat: r.value }); }));
  radios('outScale').forEach((r) => r.addEventListener('change', () => { if (r.checked) write({ outScale: r.value }); }));
  $('askWhere').addEventListener('change', (e) => write({ askWhere: e.target.checked }));
  $('stamp').addEventListener('change', (e) => write({ stamp: e.target.checked }));
  $('hideScrollbars').addEventListener('change', (e) => write({ hideScrollbars: e.target.checked }));
  $('keepAfter').addEventListener('change', (e) => write({ keepAfter: e.target.checked }));
  $('autoClean').addEventListener('change', (e) => write({ autoClean: e.target.checked }));

  // 파일 이름: 쓰는 동안 미리 보기만, 칸을 떠나거나 Enter 를 누르면 저장한다 (빈 값이면 기본 양식으로 되돌림)
  nameInput.addEventListener('input', paintPreview);
  const commitName = () => {
    const v = nameInput.value.trim();
    if (!v) nameInput.value = CS.DEFAULTS.nameTemplate;
    const next = nameInput.value.trim().slice(0, 200);
    if (next !== current.nameTemplate) write({ nameTemplate: next });
    else paintPreview();
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); } });
  $('nameReset').addEventListener('click', () => {
    nameInput.value = CS.DEFAULTS.nameTemplate;
    write({ nameTemplate: CS.DEFAULTS.nameTemplate });
  });

  // 다른 기기·다른 탭에서 바꾼 값도 보이게
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const k of Object.keys(CS.DEFAULTS)) if (changes[k]) patch[k] = changes[k].newValue;
    if (!Object.keys(patch).length) return;
    current = CS.normalize({ ...current, ...patch });
    paint(current);
  });

  /* ---------------------------------------------------------------- 사이트별 레시피 */
  const RS = globalThis.CleanShotRecipes;
  const box = $('recipes');
  let recipes = {};
  const opened = new Set();     // 항목 목록을 펼쳐 둔 사이트 (다시 그려도 펼친 채로)
  const armed = new Map();      // 지우기를 한 번 누른 사이트 → 되돌릴 타이머

  /* 요소 만들기. 빈 자식(null·false)은 넣지 않는다 (append(null) 은 "null" 글자를 넣는다) */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('data-')) e.setAttribute(k, v);
      else e[k] = v;
    }
    e.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
    return e;
  }

  function paintRecipes() {
    const hosts = Object.keys(recipes);
    if (!hosts.length) {
      box.replaceChildren(h('p', { class: 'empty', text: '저장한 레시피가 없습니다. 선택 모드 툴바의 레시피 저장으로 만듭니다.' }));
      return;
    }
    box.replaceChildren(...hosts.map(siteRow));
  }

  function siteRow(host) {
    const r = recipes[host];
    const on = h('input', { type: 'checkbox', class: 'on', checked: r.on, title: '켜면 이 사이트에서 선택 모드를 켤 때 바로 적용합니다' });
    on.addEventListener('change', () => change(host, (x) => { x.on = on.checked; }));
    const drop = h('button', { type: 'button', class: 'drop', text: '지우기', title: '이 사이트의 레시피를 지웁니다 (두 번 눌러야)' });
    drop.addEventListener('click', () => dropSite(host, drop));
    const cleanup = h('input', { type: 'checkbox', class: 'cleanup', checked: r.cleanup });
    cleanup.addEventListener('change', () => change(host, (x) => { x.cleanup = cleanup.checked; }));
    let list = null;
    if (r.items.length) {
      list = h('details', { open: opened.has(host) },
        h('summary', { text: `항목 ${r.items.length}개` }),
        h('ul', { class: 'items' }, ...r.items.map((it, i) => itemRow(host, it, i))));
      list.addEventListener('toggle', () => { if (list.open) opened.add(host); else opened.delete(host); });
    }
    return h('div', { class: 'recipe-site', 'data-host': host },
      h('div', { class: 'site-head' },
        h('label', { class: 'choice' }, on, h('span', { class: 'host', text: host })),
        h('span', { class: 'sum', text: RS.summary(r) }),
        drop),
      h('label', { class: 'choice cleanup-row' }, cleanup, h('span', { text: '한 번에 정리도 함께 (쿠키 배너·채팅 버튼·앱 설치 배너·공지 팝업)' })),
      list);
  }

  function itemRow(host, it, i) {
    const del = h('button', { type: 'button', class: 'del', title: '이 항목 지우기', text: '×' });
    del.addEventListener('click', () => change(host, (x) => { x.items.splice(i, 1); }));
    const what = h('span', { class: 'what' }, h('code', { text: it.sel }));
    // 이름표(태그#id.클래스)는 선택자가 말해 주지 않는 것이 있을 때만 (#banner 옆의 div#banner 는 빼고)
    if (it.label && !it.label.endsWith(it.sel) && !it.sel.includes(it.label)) what.append(' ', h('span', { class: 'where', text: it.label }));
    if (it.path.length) what.append(' ', h('span', { class: 'where', text: `(안쪽: ${it.path.join(' › ')})` }));
    if (it.kind === 'hide' && it.remove) what.append(' ', h('span', { class: 'where', text: '· 빈자리까지' }));
    if (it.kind === 'text') what.append(' → ', h('q', { text: it.text }));
    return h('li', { class: 'item', 'data-index': String(i) }, h('span', { class: 'kind', text: RS.KIND_LABELS[it.kind] }), what, del);
  }

  /* 저장된 값을 다시 읽어 고치고 저장한다 (피커가 그사이 저장했을 수 있다). 항목도 정리도 없으면 사이트째 빠진다.
     바꾸기는 하나씩 차례로 — 연달아 누른 두 칸이 같은 옛 값을 읽어 앞의 것을 덮어쓰지 않게 */
  let queue = Promise.resolve();
  function change(host, fn) {
    queue = queue.then(() => applyChange(host, fn));
    return queue;
  }

  async function applyChange(host, fn) {
    try {
      const v = await chrome.storage.local.get('recipes');
      const store = RS.normalizeStore(v.recipes);
      if (store[host]) {
        fn(store[host]);
        await chrome.storage.local.set({ recipes: RS.normalizeStore(store) });
        flash('저장했습니다');
      }
    } catch (err) {
      flash(`저장하지 못했습니다 · ${(err && err.message) || err}`, true);
    }
    await loadRecipes();
  }

  /* 한 번 누르면 4초 동안 "한 번 더 누르면 지웁니다", 그 안에 또 누르면 지운다 */
  function dropSite(host, btn) {
    if (armed.has(host)) {
      clearTimeout(armed.get(host));
      armed.delete(host);
      change(host, (x) => { x.items = []; x.cleanup = false; });
      return;
    }
    btn.textContent = '한 번 더 누르면 지웁니다';
    btn.classList.add('armed');
    armed.set(host, setTimeout(() => {
      armed.delete(host);
      btn.textContent = '지우기';
      btn.classList.remove('armed');
    }, 4000));
  }

  async function loadRecipes() {
    try {
      const v = await chrome.storage.local.get('recipes');
      recipes = RS.normalizeStore(v.recipes);
    } catch (_) {
      recipes = {};
    }
    paintRecipes();
  }

  // 피커가 레시피를 저장하면 바로 보이게
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recipes) loadRecipes();
  });

  paintDpr();
  chrome.storage.sync.get(CS.DEFAULTS).then((v) => {
    current = CS.normalize(v);
    paint(current);
  }).catch(() => paint(current));
  loadRecipes();
})();
