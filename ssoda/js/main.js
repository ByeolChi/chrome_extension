// 진입점: 레이아웃, 탭 바, 환경 선택, 단축키, 연결
import { h, clear, methodClass, methodShort, modKey, copyText, isMac } from './util.js';
import { app } from './app.js';
import { icon } from './ui/icons.js';
import { toast, openMenu, confirmDialog } from './ui/overlay.js';
import { setScopeProvider } from './ui/varinput.js';
import { ensureDatalists } from './ui/kvtable.js';
import { Sidebar } from './ui/sidebar.js';
import { RequestView } from './ui/request-view.js';
import { EnvironmentView } from './ui/env-view.js';
import { CollectionView } from './ui/collection-view.js';
import { CodePanel } from './ui/code-panel.js';
import { openImport, saveAsDialog, askSaveChanges, openSettings, openCookieManager, openShortcuts, envQuickLook, openSearch, openCurlHelper } from './ui/dialogs.js';
import { generateCode } from './codegen.js';
import { prepareRequest } from './prepare.js';
import { findInCollections } from './model.js';
import { parseCurl } from './curl-parser.js';

const MOD = isMac() ? '⌘' : 'Ctrl';
let sidebar;
let codePanel;
let helperCache = null;
const dom = {};

async function boot() {
  await app.init();
  window.csApp = app; // 디버깅용
  setScopeProvider(() => app.getScope());
  ensureDatalists();
  buildLayout();
  wireUi();
  applyTheme();
  renderAll();
  handlePendingImport();
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.pendingImport && changes.pendingImport.newValue) handlePendingImport();
    });
  }
  // 탭을 닫거나 숨길 때 편집 중인 초안까지 즉시 저장
  const flushAll = () => {
    app.store.pending.add('workspace');
    app.store.flush();
  };
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  document.body.classList.remove('booting');
}

/* ---------------- 레이아웃 ---------------- */
function buildLayout() {
  const root = document.getElementById('app');
  clear(root);
  const logo = h('div.brand', h('img.brand-logo', { src: 'icons/icon32.png', alt: '' }), h('span.brand-name', 'Ssoda', h('span.brand-ko', '쏘다')));
  const searchBtn = h('button.top-search', { onclick: () => openSearch() }, icon('search', 15), h('span', '요청 검색'), h('kbd', `${MOD} K`));
  const themeBtn = h('button.icon-btn.top-ic', { title: '테마 전환', onclick: () => toggleTheme() });
  dom.themeBtn = themeBtn;
  const topbar = h('header.topbar',
    logo,
    h('div.top-center', searchBtn),
    h('div.top-right',
      h('button.btn.btn-sm.btn-ghost', { onclick: () => openImport(), title: '가져오기 (Alt+I)' }, icon('import', 15), 'Import'),
      themeBtn,
      h('button.icon-btn.top-ic', { title: '단축키 & 팁', onclick: () => openShortcuts() }, icon('keyboard', 17)),
      h('button.icon-btn.top-ic', { title: '설정', onclick: () => openSettings() }, icon('settings', 17))));

  // 왼쪽
  const railItem = (id, ic, label) => {
    const b = h('button.rail-item', { dataset: { panel: id }, title: label }, icon(ic, 20), h('span', label));
    b.addEventListener('click', () => {
      const ws = app.state.workspace;
      if (ws.sidebar === id && !ws.sidebarCollapsed) ws.sidebarCollapsed = true;
      else {
        ws.sidebar = id;
        ws.sidebarCollapsed = false;
      }
      app.saveWorkspace();
      renderLeft();
    });
    return b;
  };
  dom.rail = h('nav.rail', railItem('collections', 'collections', 'Collections'), railItem('environments', 'layers', 'Environments'), railItem('history', 'history', 'History'));
  dom.sidebar = h('aside.sidebar');
  dom.sbResizer = h('div.sb-resizer');
  const newBtn = h('button.btn.btn-sm', { title: '새로 만들기' }, 'New');
  newBtn.addEventListener('click', () =>
    openMenu(newBtn, [
      { label: 'HTTP 요청', icon: 'globe', hint: 'Alt+N', onClick: () => app.newRequestTab() },
      { label: 'cURL 붙여넣기로 요청 만들기', icon: 'terminal', onClick: () => openImport() },
      { divider: true },
      { label: '컬렉션', icon: 'collections', onClick: () => { app.state.workspace.sidebar = 'collections'; app.state.workspace.sidebarCollapsed = false; const c = app.createCollection(); sidebar.renaming = c.id; renderLeft(); } },
      { label: '환경', icon: 'layers', onClick: () => { const e = app.createEnvironment(); app.state.workspace.sidebar = 'environments'; app.state.workspace.sidebarCollapsed = false; renderLeft(); app.openEnvironment(e.id); } },
    ])
  );
  dom.left = h('div.left',
    h('div.ws-head', h('span.ws-name', icon('bolt', 14), '내 워크스페이스'), h('div.ws-btns', newBtn, h('button.btn.btn-sm', { onclick: () => openImport() }, 'Import'))),
    h('div.left-body', dom.rail, dom.sidebar));

  // 중앙
  dom.tabs = h('div.tabs', { role: 'tablist' });
  dom.tabsScroll = h('div.tabs-scroll', dom.tabs);
  dom.tabsScroll.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      dom.tabsScroll.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  const addTabBtn = h('button.icon-btn.tab-add', { title: '새 요청 (Alt+N)', onclick: () => app.newRequestTab() }, icon('plus', 16));
  const tabMore = h('button.icon-btn.tab-add', { title: '탭 목록' }, icon('chevronDown', 16));
  tabMore.addEventListener('click', () => {
    const items = app.tabs.map((t) => ({ label: `${t.type === 'request' ? t.draft.method + ' ' : ''}${t.name}${t.dirty ? ' •' : ''}`, checked: t.id === app.state.workspace.activeTabId, onClick: () => app.setActive(t.id) }));
    if (items.length) items.push({ divider: true });
    items.push({ label: '모든 탭 닫기', icon: 'x', onClick: () => app.closeTabs(app.tabs.map((t) => t.id)) });
    items.push({ label: '저장된 탭만 닫기', onClick: () => app.closeTabs(app.tabs.filter((t) => !t.dirty).map((t) => t.id)) });
    openMenu(tabMore, items, { alignRight: true, minWidth: 260 });
  });
  dom.envBtn = h('button.env-btn', { title: '환경 선택' });
  dom.envBtn.addEventListener('click', () => envMenu());
  const envEye = h('button.icon-btn.env-eye', { title: '환경 변수 빠른 보기' }, icon('eye', 16));
  envEye.addEventListener('click', () => envQuickLook(envEye));
  dom.tabbar = h('div.tabbar', dom.tabsScroll, addTabBtn, tabMore, h('div.flex1'), h('div.env-sel', dom.envBtn, envEye));
  dom.viewHost = h('div.view-host');
  dom.work = h('main.work', dom.tabbar, dom.viewHost);

  // 오른쪽
  dom.codePanel = h('aside.code-panel.hidden');
  dom.cpResizer = h('div.cp-resizer');
  const railRight = h('nav.rail-right',
    h('button.rr-item', { title: 'Code snippet', dataset: { panel: 'code' }, onclick: () => app.ui.toggleCodePanel() }, icon('code', 18)),
    h('button.rr-item', { title: '쿠키 관리자', onclick: () => openCookieManager() }, icon('cookie', 18)),
    h('button.rr-item', { title: '환경 변수 빠른 보기', onclick: (e) => envQuickLook(e.currentTarget) }, icon('eye', 18)));
  dom.railRight = railRight;

  dom.status = h('footer.statusbar',
    h('div.sb-left',
      h('button.sb-link', { onclick: () => { app.state.workspace.sidebarCollapsed = !app.state.workspace.sidebarCollapsed; app.saveWorkspace(); renderLeft(); }, title: '사이드바 토글' }, icon('cols', 14)),
      h('span.sb-text', h('span.dot-ok'), '로컬 저장소 사용 중')),
    h('div.sb-right',
      h('button.sb-link', { onclick: () => openCookieManager() }, icon('cookie', 14), 'Cookies'),
      h('button.sb-link', { onclick: () => toggleLayout(), title: '요청/응답 배치 전환' }, icon('rows', 14), '레이아웃'),
      h('button.sb-link', { onclick: () => openShortcuts() }, icon('keyboard', 14), '단축키')));

  root.append(topbar, h('div.shell', dom.left, dom.sbResizer, dom.work, dom.cpResizer, dom.codePanel, railRight), dom.status);
  sidebar = new Sidebar(dom.sidebar);
  codePanel = new CodePanel(dom.codePanel);
  bindSidebarResize();
  bindCodePanelResize();
}

function bindSidebarResize() {
  dom.sbResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = app.state.workspace.sidebarWidth || 300;
    document.body.classList.add('resizing-x');
    const move = (ev) => {
      const w = Math.min(560, Math.max(200, startW + ev.clientX - startX));
      app.state.workspace.sidebarWidth = w;
      dom.sidebar.style.width = w + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x');
      app.saveWorkspace();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function bindCodePanelResize() {
  dom.cpResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = app.state.workspace.codeWidth || 420;
    document.body.classList.add('resizing-x');
    const move = (ev) => {
      const w = Math.min(900, Math.max(280, startW - (ev.clientX - startX)));
      app.state.workspace.codeWidth = w;
      dom.codePanel.style.width = w + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x');
      app.saveWorkspace();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* ---------------- 렌더링 ---------------- */
function renderAll() {
  renderLeft();
  renderTabs();
  renderEnvSelector();
  renderMain();
  renderCodePanel();
}

function renderLeft() {
  const ws = app.state.workspace;
  dom.rail.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.panel === ws.sidebar && !ws.sidebarCollapsed));
  dom.sidebar.classList.toggle('collapsed', !!ws.sidebarCollapsed);
  dom.sbResizer.classList.toggle('hidden', !!ws.sidebarCollapsed);
  dom.sidebar.style.width = (ws.sidebarWidth || 300) + 'px';
  sidebar.render();
}

function renderTabs() {
  clear(dom.tabs);
  const ws = app.state.workspace;
  for (const t of ws.tabs) dom.tabs.appendChild(tabEl(t, t.id === ws.activeTabId));
  const act = dom.tabs.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.title = (app.activeTab() ? app.activeTab().name + ' - ' : '') + 'Ssoda';
}

function tabEl(t, active) {
  let lead;
  if (t.type === 'request') lead = h('span.tab-method.' + methodClass(t.draft.method), methodShort(t.draft.method));
  else if (t.type === 'environment') lead = icon(t.refId === 'globals' ? 'globe' : 'layers', 14, 'tab-ic');
  else lead = icon('collections', 14, 'tab-ic');
  const close = h('button.tab-close', { title: '닫기 (Alt+W)' }, icon('x', 13));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    app.closeTab(t.id);
  });
  const el = h('div.tab' + (active ? '.active' : '') + (t.dirty ? '.dirty' : '') + (t.type === 'request' && !t.itemId ? '.unsaved' : ''), {
    role: 'tab',
    title: t.type === 'request' ? `${t.draft.method} ${t.draft.url || '(URL 없음)'}` : t.name,
    dataset: { id: t.id },
    draggable: 'true',
  }, lead, h('span.tab-name', tabLabel(t)), h('span.tab-dot'), close);
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      app.closeTab(t.id);
    }
  });
  el.addEventListener('click', () => app.setActive(t.id));
  el.addEventListener('dblclick', () => {
    if (t.type === 'request') {
      const v = app.views.get(t.id);
      if (v && v.headerEl) v.headerEl.querySelector('.crumb-name')?.click();
    }
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const idx = app.tabs.indexOf(t);
    openMenu({ x: e.clientX, y: e.clientY }, [
      t.type === 'request' ? { label: '저장', icon: 'save', hint: `${MOD}+S`, onClick: () => app.saveTab(t) } : null,
      t.type === 'request' ? { label: '탭 복제', icon: 'duplicate', onClick: () => app.duplicateTab(t) } : null,
      t.type === 'request' ? { label: 'cURL로 복사', icon: 'terminal', onClick: () => copyAsCurl(t) } : null,
      t.type === 'request' ? { divider: true } : null,
      { label: '닫기', hint: 'Alt+W', onClick: () => app.closeTab(t.id) },
      { label: '다른 탭 모두 닫기', onClick: () => app.closeTabs(app.tabs.filter((x) => x.id !== t.id).map((x) => x.id)) },
      { label: '오른쪽 탭 모두 닫기', onClick: () => app.closeTabs(app.tabs.slice(idx + 1).map((x) => x.id)) },
      { label: '모든 탭 닫기', onClick: () => app.closeTabs(app.tabs.map((x) => x.id)) },
    ]);
  });
  // 탭 순서 드래그
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-cs-tab', t.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-cs-tab')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    el.classList.toggle('drop-left', e.clientX < r.left + r.width / 2);
    el.classList.toggle('drop-right', e.clientX >= r.left + r.width / 2);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-left', 'drop-right'));
  el.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('application/x-cs-tab');
    el.classList.remove('drop-left', 'drop-right');
    if (!id || id === t.id) return;
    e.preventDefault();
    const tabs = app.tabs;
    const from = tabs.findIndex((x) => x.id === id);
    const [moved] = tabs.splice(from, 1);
    let to = tabs.indexOf(t);
    const r = el.getBoundingClientRect();
    if (e.clientX >= r.left + r.width / 2) to++;
    tabs.splice(to, 0, moved);
    app.saveWorkspace();
    renderTabs();
  });
  return el;
}

function updateTabLabel(tab) {
  const el = dom.tabs.querySelector(`.tab[data-id="${CSS.escape(tab.id)}"]`);
  if (!el) return renderTabs();
  el.classList.toggle('dirty', !!tab.dirty);
  const m = el.querySelector('.tab-method');
  if (m && tab.type === 'request') {
    m.className = 'tab-method ' + methodClass(tab.draft.method);
    m.textContent = methodShort(tab.draft.method);
  }
  const n = el.querySelector('.tab-name');
  if (n) n.textContent = tabLabel(tab);
}

// 저장되지 않은 기본 이름 탭은 URL을 제목으로 표시
function tabLabel(t) {
  if (t.type === 'request' && !t.itemId && t.name === 'Untitled Request' && t.draft.url.trim()) {
    return t.draft.url.trim().replace(/^https?:\/\//, '');
  }
  return t.name;
}

function getView(tab) {
  let v = app.views.get(tab.id);
  if (v) return v;
  if (tab.type === 'request') v = new RequestView(tab);
  else if (tab.type === 'environment') v = new EnvironmentView(tab);
  else v = new CollectionView(tab);
  app.views.set(tab.id, v);
  return v;
}

function renderMain() {
  const tab = app.activeTab();
  const host = dom.viewHost;
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!tab) {
    host.appendChild(landing());
    renderCodePanel();
    return;
  }
  const v = getView(tab);
  if (v.stale && v.refresh) {
    v.refresh();
    v.stale = false;
  }
  if (v.varsStale && v.refreshVars) {
    v.varsStale = false;
    v.refreshVars();
  }
  host.appendChild(v.el);
  renderCodePanel();
}

function landing() {
  const ta = h('textarea.quick-curl', { placeholder: "curl 'https://httpbin.org/get' -H 'Accept: application/json'", spellcheck: 'false' });
  const run = async (send, engine) => {
    const text = ta.value.trim();
    if (!text) return toast('cURL 명령 또는 URL을 입력하세요.', 'error');
    try {
      const res = app.importText(text);
      (res.warnings || []).forEach((w) => toast(w, 'info', 5000));
      if ((res.kind === 'curl' || res.kind === 'url') && send) {
        const t = app.activeTab();
        if (engine) {
          t.draft.settings.engine = engine;
          app.markChanged(t);
          const v = app.views.get(t.id);
          if (v) {
            v.renderSendBtn(false);
            v.updateCounts();
          }
        }
        app.send(t, { engine });
      }
      else if (res.kind !== 'curl' && res.kind !== 'url') toast(res.message, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (modKey(e) && e.key === 'Enter') {
      e.preventDefault();
      run(true, app.settings.defaultEngine === 'curl' ? 'curl' : 'browser');
    }
  });
  const card = (ic, title, sub, onClick) => h('button.land-card', { onclick: onClick }, icon(ic, 22), h('div', h('div.land-card-title', title), h('div.land-card-sub', sub)));
  return h('div.landing',
    h('div.land-inner',
      h('div.land-hero', h('img', { src: 'icons/icon128.png', alt: '', width: 56, height: 56 }), h('div', h('h1', 'Ssoda ', h('span.hero-ko', '쏘다')), h('p', 'API를 쏘다 — cURL 명령을 붙여넣고 바로 쏘세요. 자주 쓰는 요청은 컬렉션에 저장해 다시 쓰면 됩니다.'))),
      h('div.quick-box',
        h('div.quick-head', icon('terminal', 16), h('b', 'cURL 바로 쏘기'), h('span.muted', `${MOD}+Enter`)),
        ta,
        h('div.quick-actions',
          h('button.btn', { onclick: () => run(false) }, '탭으로 열기'),
          h('button.btn.btn-run-curl', { onclick: () => run(true, 'curl'), title: 'PC의 curl 로 실행 (도우미 필요)' }, icon('terminal', 14), 'cURL로 실행'),
          h('button.btn.btn-send', { onclick: () => run(true, 'browser'), title: '브라우저로 전송' }, '브라우저로 실행', icon('send', 14)))),
      h('div.land-cards',
        card('globe', '새 HTTP 요청', 'Alt+N', () => app.newRequestTab()),
        card('import', '가져오기', 'Postman 컬렉션 · 환경 · cURL', () => openImport()),
        card('collections', '새 컬렉션', '요청을 폴더로 정리', () => { app.state.workspace.sidebar = 'collections'; app.state.workspace.sidebarCollapsed = false; const c = app.createCollection(); sidebar.renaming = c.id; renderLeft(); }),
        card('layers', '새 환경', 'dev / prod 변수 관리', () => { const e = app.createEnvironment(); app.state.workspace.sidebar = 'environments'; renderLeft(); app.openEnvironment(e.id); })),
      h('div.land-tip', icon('info', 14), '웹페이지에서 cURL 명령을 드래그로 선택하고 우클릭 → "Ssoda로 열기"로 바로 가져올 수 있습니다. Chrome 개발자도구 Network 탭의 "Copy as cURL (bash/cmd)" 결과도 지원합니다.')));
}

function renderEnvSelector() {
  const env = app.activeEnv();
  clear(dom.envBtn);
  dom.envBtn.append(h('span.env-name' + (env ? '' : '.muted'), env ? env.name : 'No Environment'), icon('chevronDown', 14));
  dom.envBtn.classList.toggle('has-env', !!env);
}

function envMenu() {
  const items = [{ label: 'No Environment', checked: !app.state.activeEnvId, onClick: () => app.setActiveEnv(null) }];
  if (app.state.environments.length) items.push({ divider: true });
  app.state.environments.forEach((e) => items.push({ label: e.name, checked: app.state.activeEnvId === e.id, onClick: () => app.setActiveEnv(e.id) }));
  items.push({ divider: true });
  items.push({ label: '환경 관리', icon: 'settings', onClick: () => { app.state.workspace.sidebar = 'environments'; app.state.workspace.sidebarCollapsed = false; renderLeft(); } });
  items.push({ label: '새 환경 만들기', icon: 'plus', onClick: () => { const e = app.createEnvironment(); app.state.workspace.sidebar = 'environments'; renderLeft(); app.openEnvironment(e.id); } });
  openMenu(dom.envBtn, items, { alignRight: true, minWidth: 220 });
}

function renderCodePanel() {
  const open = app.state.workspace.rightPanel === 'code';
  dom.codePanel.style.width = (app.state.workspace.codeWidth || 420) + 'px';
  dom.cpResizer.classList.toggle('hidden', !open);
  dom.railRight.querySelector('[data-panel="code"]').classList.toggle('active', open);
  codePanel.render();
}

/* ---------------- 테마/레이아웃 ---------------- */
const mq = window.matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() {
  const t = app.settings.theme;
  if (t === 'light' || t === 'dark') return t;
  return mq.matches ? 'dark' : 'light';
}
function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  clear(dom.themeBtn);
  dom.themeBtn.appendChild(icon(t === 'dark' ? 'sun' : 'moon', 17));
}
mq.addEventListener('change', () => app.settings.theme === 'system' && applyTheme());
function toggleTheme() {
  app.settings.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
  app.store.changed('settings');
  applyTheme();
}
function toggleLayout() {
  app.settings.layout = app.settings.layout === 'vertical' ? 'horizontal' : 'vertical';
  app.store.changed('settings');
  applySplitAll();
}
function applySplitAll() {
  app.views.forEach((v) => v.applySplit && v.applySplit());
}

/* ---------------- cURL 복사 ---------------- */
async function copyAsCurl(tab) {
  try {
    const p = await app.buildPrepared(tab, { engine: 'curl' });
    const ok = await copyText(app.curlCommandFor(tab, p));
    toast(ok ? 'cURL 명령을 복사했습니다.' : '복사 실패', ok ? 'success' : 'error');
  } catch (e) {
    toast('복사 실패: ' + e.message, 'error');
  }
}
async function copyRequestAsCurl(request, itemId = null) {
  const inh = app.getInheritedAuth(itemId);
  const p = prepareRequest(request, { scope: app.getScope(itemId ? { type: 'request', itemId } : null), inheritedAuth: inh ? inh.auth : null, defaults: app.settings });
  const ok = await copyText(generateCode('curl', p));
  toast(ok ? 'cURL 명령을 복사했습니다.' : '복사 실패', ok ? 'success' : 'error');
}
function copyItemAsCurl(itemId) {
  const hit = findInCollections(app.state.collections, itemId);
  if (hit) copyRequestAsCurl(hit.item.request, itemId);
}

/* ---------------- 외부에서 전달된 가져오기 (우클릭 메뉴) ---------------- */
async function handlePendingImport() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  const { pendingImport } = await chrome.storage.local.get('pendingImport');
  if (!pendingImport) return;
  await chrome.storage.local.remove('pendingImport');
  if (Date.now() - (pendingImport.ts || 0) > 60000) return;
  const text = String(pendingImport.text || '').trim();
  if (pendingImport.kind === 'url') {
    app.newRequestTab({ url: text }, text.replace(/^https?:\/\//, '').slice(0, 50));
    toast('링크를 새 요청으로 열었습니다.', 'success');
    return;
  }
  if (app.looksLikeCurl(text)) {
    try {
      const { request, warnings, name } = parseCurl(text);
      app.newRequestTab(request, name);
      toast('선택한 cURL 명령을 가져왔습니다.', 'success');
      warnings.forEach((w) => toast(w, 'info', 5000));
      return;
    } catch (e) {
      /* 가져오기 창으로 */
    }
  }
  openImport(text);
}

/* ---------------- 단축키 ---------------- */
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    if (modKey(e) && k === 'enter') {
      e.preventDefault();
      const t = app.activeTab();
      if (t && t.type === 'request') app.send(t);
    } else if (modKey(e) && k === 's') {
      e.preventDefault();
      const t = app.activeTab();
      if (t && t.type === 'request') app.saveTab(t, { saveAs: e.shiftKey });
      else if (t) toast('자동 저장되었습니다.', 'success');
    } else if (modKey(e) && k === 'k') {
      e.preventDefault();
      openSearch();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && k === 'n') {
      e.preventDefault();
      app.newRequestTab();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && k === 'w') {
      e.preventDefault();
      const t = app.activeTab();
      if (t) app.closeTab(t.id);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && k === 'i') {
      e.preventDefault();
      openImport();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (k === 'arrowleft' || k === 'arrowright')) {
      const tabs = app.tabs;
      if (!tabs.length) return;
      e.preventDefault();
      const i = tabs.findIndex((t) => t.id === app.state.workspace.activeTabId);
      const n = (i + (k === 'arrowright' ? 1 : -1) + tabs.length) % tabs.length;
      app.setActive(tabs[n].id);
    }
  });
  // 페이지 어디서든 cURL 붙여넣기 (입력창이 아닐 때)
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (app.looksLikeCurl(text)) {
      e.preventDefault();
      try {
        const { request, warnings, name } = parseCurl(text);
        app.newRequestTab(request, name);
        toast('cURL 명령을 새 탭으로 가져왔습니다.', 'success');
        warnings.forEach((w) => toast(w, 'info', 5000));
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  window.addEventListener('beforeunload', (e) => {
    app.store.flush();
  });
}

/* ---------------- 연결 ---------------- */
function wireUi() {
  app.ui = {
    toast,
    renderTabs,
    updateTabLabel,
    renderMain,
    renderSidebar: () => sidebar.render(),
    renderSidebarSelection: () => sidebar.markActive(),
    renderEnvSelector,
    showSidebar: (panel) => {
      app.state.workspace.sidebar = panel;
      app.state.workspace.sidebarCollapsed = false;
      app.saveWorkspace();
      renderLeft();
    },
    refreshView: (tab) => {
      const v = app.views.get(tab.id);
      if (!v) return;
      if (tab.type === 'request') v.renderHeader();
      else if (app.activeTab() === tab) v.refresh();
      else v.stale = true;
    },
    refreshVars: () => {
      const activeId = app.state.workspace.activeTabId;
      app.views.forEach((v, id) => {
        if (!(v instanceof RequestView)) return;
        if (id === activeId) v.refreshVars();
        else v.varsStale = true;
      });
      codePanel.update();
      sidebar.render();
    },
    onDraftChanged: () => codePanel.update(),
    askSaveChanges,
    saveAsDialog,
    openImport,
    openCookieManager,
    toggleCodePanel: (force) => {
      const ws = app.state.workspace;
      const open = force === undefined ? ws.rightPanel !== 'code' : force;
      ws.rightPanel = open ? 'code' : null;
      app.saveWorkspace();
      renderCodePanel();
    },
    copyAsCurl,
    copyItemAsCurl,
    openCurlHelper,
    // 도우미 상태 (세션 동안 캐시)
    helperStatus: ({ force = false } = {}) => {
      if (force || !helperCache) helperCache = app.pingHelper();
      return helperCache;
    },
    ensureCurlHelper: async () => {
      const st = await app.ui.helperStatus();
      if (!st.ok) openCurlHelper();
    },
    refreshEngines: () => {
      app.views.forEach((v) => {
        if (v instanceof RequestView) {
          v.renderSendBtn(app.controllers.has(v.tab.id));
          v.updateCounts();
          if (v.sub === 'curl') v.renderPane();
        }
      });
    },
    copyRequestAsCurl: (req) => copyRequestAsCurl(req),
    applyTheme,
    applySplitAll,
  };
  app.store.on('collections', () => {
    sidebar.render();
    app.views.forEach((v) => {
      if (v instanceof RequestView) v.renderHeader();
    });
  });
  app.store.on('environments', () => {
    if (app.state.workspace.sidebar === 'environments') sidebar.render();
    renderEnvSelector();
  });
  app.store.on('history', () => {
    if (app.state.workspace.sidebar === 'history') sidebar.render();
  });
  app.store.on('error', (msg) => toast(msg, 'error', 5000));
  bindKeys();
}

boot().catch((e) => {
  console.error(e);
  document.body.classList.remove('booting');
  document.getElementById('app').textContent = '초기화 오류: ' + e.message;
});
