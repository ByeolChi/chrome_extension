// 요청 탭 화면 (URL 바, Params/Auth/Headers/Body/Cookies/Settings, 응답)
import { h, clear, debounce, METHODS, methodClass, readFileAsDataURL, formatBytes, kvRow } from '../util.js';
import { buildUrlFromParams, syncParamsFromUrl } from '../model.js';
import { varInput } from './varinput.js';
import { KVTable, headerValueList } from './kvtable.js';
import { CodeEditor } from './code-editor.js';
import { authEditor, authLabel } from './auth-editor.js';
import { ResponseView } from './response-view.js';
import { icon } from './icons.js';
import { openMenu, promptDialog, toast } from './overlay.js';
import { getBrowserCookies } from '../http.js';
import { prepareRequest } from '../prepare.js';
import { cookiesForUrl } from '../cookiejar.js';
import { curlOptsOf, parseExtraArgs, describeRemovedArgs } from '../curl-runner.js';
import { highlight } from '../highlight.js';
import { copyText } from '../util.js';
import { app } from '../app.js';

const SUBTABS = [
  ['params', 'Params'],
  ['auth', 'Authorization'],
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['cookies', 'Cookies'],
  ['curl', 'cURL'],
  ['settings', 'Settings'],
];

const RAW_LANGS = [
  ['json', 'JSON'],
  ['text', 'Text'],
  ['javascript', 'JavaScript'],
  ['html', 'HTML'],
  ['xml', 'XML'],
];

export class RequestView {
  constructor(tab) {
    this.tab = tab;
    this.sub = tab.sub || 'params';
    this.el = h('div.rv');
    this.response = new ResponseView();
    this.response.onCancel = () => app.cancel(this.tab);
    this.response.onRetry = (engine) => app.send(this.tab, { engine });
    this.response.onToggleInsecure = () => {
      this.draft.settings.curl = { ...curlOptsOf(this.draft), insecure: true };
      this.changed();
      if (this.sub === 'curl') this.renderPane();
      app.send(this.tab, { engine: 'curl' });
    };
    this._markChanged = debounce(() => app.markChanged(this.tab), 120);
    this._refreshCookiePreview = debounce(() => this.updateCookiePreview(), 300);
    this._refreshCurlPreview = debounce(() => this.updateCurlPreview(), 200);
    this.build();
    const res = app.responses.get(tab.id);
    if (res) this.response.show(res);
    if (app.controllers.has(tab.id)) this.setLoading(true);
  }

  get draft() {
    return this.tab.draft;
  }

  destroy() {
    this.response.destroy();
  }

  changed(opts = {}) {
    this._markChanged();
    this.updateCounts();
    if (app.ui.onDraftChanged) app.ui.onDraftChanged(this.tab);
    if (this.sub === 'cookies') this._refreshCookiePreview();
    if (this.sub === 'curl') this._refreshCurlPreview();
    if (this.sub === 'headers' && this.hiddenOpen) this.renderHiddenHeaders();
  }

  /* ---------------- 레이아웃 ---------------- */
  build() {
    clear(this.el);
    this.headerEl = h('div.rv-head');
    this.renderHeader();
    this.el.appendChild(this.headerEl);
    this.el.appendChild(this.buildUrlBar());

    this.subtabsEl = h('div.subtabs.req-subtabs');
    this.paneEl = h('div.req-pane');
    const reqArea = h('div.rv-req',
      h('div.subtabs-row', this.subtabsEl, h('div.subtabs-right',
        h('button.link-btn', { onclick: () => app.ui.openCookieManager(), title: '쿠키 관리자' }, icon('cookie', 14), h('span.lbl', 'Cookies')),
        h('button.link-btn', { onclick: () => app.ui.toggleCodePanel(true), title: '코드 스니펫' }, icon('code', 14), h('span.lbl', 'Code')))),
      this.paneEl);
    const handle = h('div.split-handle', { title: '드래그하여 크기 조절' });
    this.splitEl = h('div.rv-split', reqArea, handle, this.response.el);
    this.reqArea = reqArea;
    this.applySplit();
    this.bindSplit(handle);
    this.el.appendChild(this.splitEl);
    this.renderSubtabs();
    this.renderPane();
  }

  applySplit() {
    const vertical = app.settings.layout === 'vertical';
    this.splitEl.classList.toggle('vertical', vertical);
    const ratio = app.state.workspace.split || 0.48;
    this.reqArea.style.flex = `0 0 ${Math.round(ratio * 1000) / 10}%`;
  }

  bindSplit(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const vertical = app.settings.layout === 'vertical';
      const rect = this.splitEl.getBoundingClientRect();
      document.body.classList.add(vertical ? 'resizing-x' : 'resizing-y');
      const move = (ev) => {
        const r = vertical ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        app.state.workspace.split = Math.min(0.85, Math.max(0.12, r));
        this.applySplit();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing-x', 'resizing-y');
        app.saveWorkspace();
        app.ui.applySplitAll && app.ui.applySplitAll();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  renderHeader() {
    const tab = this.tab;
    clear(this.headerEl);
    const crumbs = h('div.crumbs');
    if (tab.itemId) {
      const anc = app.ancestors(tab.itemId);
      anc.forEach((a) => {
        crumbs.appendChild(h('button.crumb', { onclick: () => app.openItem(a.id) }, a.name));
        crumbs.appendChild(h('span.crumb-sep', '/'));
      });
    } else {
      crumbs.appendChild(h('span.crumb.muted', icon('file', 14)));
    }
    const nameEl = h('button.crumb-name', { title: '클릭하여 이름 변경' }, tab.name);
    nameEl.addEventListener('click', () => {
      const input = h('input.crumb-input', { value: tab.name, spellcheck: 'false' });
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (commit && v && v !== tab.name) {
          tab.name = v;
          app.markChanged(tab);
          app.ui.renderTabs();
        }
        this.renderHeader();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) finish(true);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
    });
    crumbs.appendChild(nameEl);
    if (!tab.itemId) crumbs.appendChild(h('span.unsaved-tag', '저장 안 됨'));

    const saveBtn = h('button.btn.btn-save', { title: '저장 (Ctrl+S)', onclick: () => app.saveTab(tab) }, icon('save', 15), 'Save');
    const saveMore = h('button.btn.btn-save-more', { title: '다른 이름으로 저장' }, icon('chevronDown', 14));
    saveMore.addEventListener('click', () =>
      openMenu(saveMore, [
        { label: '다른 이름으로 저장…', icon: 'save', hint: 'Ctrl+Shift+S', onClick: () => app.saveTab(tab, { saveAs: true }) },
        { label: '탭 복제', icon: 'duplicate', onClick: () => app.duplicateTab(tab) },
        { label: 'cURL로 복사', icon: 'terminal', onClick: () => app.ui.copyAsCurl(tab) },
      ], { alignRight: true })
    );
    this.headerEl.append(crumbs, h('div.rv-head-actions', h('div.btn-group', saveBtn, saveMore)));
  }

  buildUrlBar() {
    const d = this.draft;
    this.methodBtn = h('button.method-btn', { title: 'HTTP 메소드' });
    this.renderMethod();
    this.methodBtn.addEventListener('click', () => {
      const items = METHODS.map((m) => ({
        label: m,
        cls: methodClass(m) + ' mono-b',
        checked: d.method === m,
        onClick: () => this.setMethod(m),
      }));
      items.push({ divider: true });
      items.push({
        label: '직접 입력…',
        onClick: async () => {
          const v = await promptDialog({ title: '사용자 정의 메소드', label: '메소드 이름', value: METHODS.includes(d.method) ? '' : d.method, placeholder: 'PROPFIND' });
          if (v) this.setMethod(v.toUpperCase().replace(/[^A-Z0-9_-]/g, ''));
        },
      });
      openMenu(this.methodBtn, items, { minWidth: 150 });
    });
    this.urlInput = varInput({
      value: d.url,
      placeholder: 'URL을 입력하거나 cURL 명령을 붙여넣으세요',
      className: 'url-input',
      ariaLabel: 'Request URL',
      getScope: () => app.getScope(this.tab),
      onInput: (v) => {
        d.url = v;
        d.params = syncParamsFromUrl(v, d.params);
        if (this.sub === 'params' && this.paramsTable) this.paramsTable.render();
        this.changed();
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          app.send(this.tab);
        }
      },
      onPaste: (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (app.looksLikeCurl(text)) {
          e.preventDefault();
          try {
            const warnings = app.applyCurlToTab(this.tab, text);
            toast('cURL 명령을 가져왔습니다.', 'success');
            warnings.forEach((w) => toast(w, 'info', 5000));
          } catch (err) {
            toast('cURL 파싱 실패: ' + err.message, 'error');
          }
        }
      },
    });
    this.sendBtn = h('button.btn.btn-send', { onclick: () => app.send(this.tab) });
    this.sendMore = h('button.btn.btn-send-more', { title: '실행 방식 선택 (브라우저 / cURL)' }, icon('chevronDown', 14));
    this.sendMore.addEventListener('click', () => this.sendMenu());
    this.renderSendBtn(false);
    return h('div.urlbar', h('div.url-group', this.methodBtn, h('div.url-sep'), this.urlInput.el), h('div.send-group', this.sendBtn, this.sendMore));
  }

  sendMenu() {
    const engine = app.engineOf(this.tab);
    const other = engine === 'curl' ? 'browser' : 'curl';
    const ssh = app.tunnelOf();
    if (ssh) {
      openMenu(this.sendMore, [
        { header: `SSH 터널: ${ssh.user}@${ssh.host}:${ssh.port}` },
        { label: '이 환경은 SSH 서버를 거쳐 cURL 로 실행합니다', disabled: true },
        { label: 'SSH 설정 열기', icon: 'lock', onClick: () => app.openEnvironment(app.state.activeEnvId) },
        { divider: true },
        { label: 'cURL 명령 복사 (bash)', icon: 'copy', onClick: () => this.copyCommand('bash') },
        { label: 'cURL 명령 복사 (Windows cmd)', icon: 'copy', onClick: () => this.copyCommand('cmd') },
        { divider: true },
        { label: 'cURL 실행 도우미 설정…', icon: 'settings', onClick: () => app.ui.openCurlHelper() },
      ], { alignRight: true, minWidth: 250 });
      return;
    }
    openMenu(this.sendMore, [
      { header: '실행 방식 (이 요청에 저장)' },
      { label: '브라우저로 보내기', hint: 'fetch', checked: engine === 'browser', onClick: () => this.setEngine('browser') },
      { label: 'cURL로 실행', hint: 'PC의 curl', checked: engine === 'curl', onClick: () => this.setEngine('curl') },
      { divider: true },
      {
        label: other === 'curl' ? '이번만 cURL로 실행' : '이번만 브라우저로 보내기',
        icon: other === 'curl' ? 'terminal' : 'globe',
        onClick: () => app.send(this.tab, { engine: other }),
      },
      { divider: true },
      { label: 'cURL 명령 복사 (bash)', icon: 'copy', onClick: () => this.copyCommand('bash') },
      { label: 'cURL 명령 복사 (Windows cmd)', icon: 'copy', onClick: () => this.copyCommand('cmd') },
      { divider: true },
      { label: 'cURL 실행 도우미 설정…', icon: 'settings', onClick: () => app.ui.openCurlHelper() },
    ], { alignRight: true, minWidth: 250 });
  }

  setEngine(engine) {
    this.draft.settings.engine = engine;
    this.changed();
    this.renderSendBtn(app.controllers.has(this.tab.id));
    if (this.sub === 'curl') this.renderPane();
    if (engine === 'curl') app.ui.ensureCurlHelper && app.ui.ensureCurlHelper();
  }

  async copyCommand(shell, multiline) {
    try {
      const p = await app.buildPrepared(this.tab, { engine: 'curl' });
      const cmd = app.curlCommandFor(this.tab, p, { shell, multiline });
      const ok = await copyText(cmd);
      toast(ok ? `cURL 명령을 복사했습니다 (${shell === 'cmd' ? 'Windows cmd' : 'bash'}).` : '복사 실패', ok ? 'success' : 'error');
    } catch (e) {
      toast('명령 생성 실패: ' + e.message, 'error');
    }
  }

  setMethod(m) {
    this.draft.method = m;
    this.renderMethod();
    this.changed();
    app.ui.renderTabs();
    if (this.sub === 'body') this.renderPane();
  }

  renderMethod() {
    clear(this.methodBtn);
    this.methodBtn.className = 'method-btn ' + methodClass(this.draft.method);
    this.methodBtn.append(h('span', this.draft.method), icon('chevronDown', 14));
  }

  renderSendBtn(loading) {
    clear(this.sendBtn);
    const curl = app.engineOf(this.tab) === 'curl';
    this.sendBtn.classList.toggle('loading', loading);
    this.sendMore.classList.toggle('loading', loading);
    this.sendBtn.classList.toggle('engine-curl', curl);
    this.sendMore.classList.toggle('engine-curl', curl);
    const ssh = app.tunnelOf();
    if (loading) this.sendBtn.append('Cancel');
    else if (ssh) this.sendBtn.append(icon('lock', 14), 'Send', h('span.engine-tag.ssh-tag', 'SSH'));
    else if (curl) this.sendBtn.append(icon('terminal', 15), 'Send', h('span.engine-tag', 'cURL'));
    else this.sendBtn.append('Send', icon('send', 14));
    this.sendBtn.title = loading ? '요청 취소'
      : ssh ? `SSH 서버 ${ssh.user}@${ssh.host}:${ssh.port} 를 거쳐 curl 로 실행 (Ctrl+Enter)`
        : curl ? 'PC의 curl 로 실행 (Ctrl+Enter)' : '브라우저로 전송 (Ctrl+Enter)';
  }

  setLoading(on, engine) {
    this.renderSendBtn(on);
    this.response.setLoading(on, null, engine || app.engineOf(this.tab));
  }

  showResponse(result) {
    this.response.show(result);
  }

  /* ---------------- 하위 탭 ---------------- */
  counts() {
    const d = this.draft;
    const n = (list) => (list || []).filter((x) => x.enabled && (x.key || x.value)).length;
    return {
      params: n(d.params),
      headers: n(d.headers),
      cookies: n(d.cookies),
      curl: app.engineOf(this.tab) === 'curl',
      body: d.body.mode !== 'none',
      auth: d.auth.type !== 'inherit' && d.auth.type !== 'none',
    };
  }

  renderSubtabs() {
    clear(this.subtabsEl);
    const c = this.counts();
    for (const [id, label] of SUBTABS) {
      const cnt = c[id];
      const badge = typeof cnt === 'number' ? (cnt ? h('span.count', `(${cnt})`) : null) : cnt ? h('span.dot-ind') : null;
      const b = h('button.subtab' + (this.sub === id ? '.active' : ''), { dataset: { sub: id } }, label, badge);
      b.addEventListener('click', () => {
        this.sub = id;
        this.tab.sub = id;
        app.saveWorkspace();
        this.renderSubtabs();
        this.renderPane();
      });
      this.subtabsEl.appendChild(b);
    }
  }

  updateCounts() {
    this.renderSubtabs();
  }

  renderPane() {
    clear(this.paneEl);
    this.paramsTable = null;
    const fn = {
      params: () => this.paneParams(),
      auth: () => this.paneAuth(),
      headers: () => this.paneHeaders(),
      body: () => this.paneBody(),
      cookies: () => this.paneCookies(),
      settings: () => this.paneSettings(),
      curl: () => this.paneCurl(),
    }[this.sub];
    this.paneEl.appendChild(fn ? fn() : h('div'));
  }

  paneParams() {
    const d = this.draft;
    this.paramsTable = new KVTable({
      getScope: () => app.getScope(this.tab),
      title: 'Query Params',
      rows: () => d.params,
      onChange: () => {
        d.url = buildUrlFromParams(d.url, d.params);
        this.urlInput.setValue(d.url);
        this.changed();
      },
    });
    return h('div.pane', this.paramsTable.el);
  }

  paneAuth() {
    const d = this.draft;
    const ed = authEditor(d.auth, {
      getScope: () => app.getScope(this.tab),
      allowInherit: true,
      inheritInfo: () => {
        const inh = app.getInheritedAuth(this.tab.itemId);
        if (!inh) return null;
        return { label: authLabel(inh.auth.type), from: inh.from.name };
      },
      onChange: () => this.changed(),
    });
    return h('div.pane', ed.el);
  }

  paneHeaders() {
    const d = this.draft;
    this.hiddenBox = h('div.hidden-headers');
    this.hiddenToggle = h('button.link-btn.hidden-toggle', {
      onclick: () => {
        this.hiddenOpen = !this.hiddenOpen;
        this.renderHiddenHeaders();
      },
    });
    const table = new KVTable({
      getScope: () => app.getScope(this.tab),
      rows: () => d.headers,
      keyList: 'dl-headers',
      valueList: headerValueList,
      onChange: () => this.changed(),
      extraTools: this.hiddenToggle,
      beforeTable: this.hiddenBox,
    });
    const pane = h('div.pane', table.el);
    this.renderHiddenHeaders();
    return pane;
  }

  computeAutoHeaders() {
    const tab = this.tab;
    const inh = app.getInheritedAuth(tab.itemId);
    let jar = [];
    try {
      const url0 = prepareRequest(tab.draft, { scope: app.getScope(tab) }).url;
      if (tab.draft.settings.useCookieJar !== false) jar = cookiesForUrl(app.state.cookieJar, new URL(url0).href);
    } catch (e) {
      /* ignore */
    }
    const p = prepareRequest(tab.draft, { scope: app.getScope(tab), inheritedAuth: inh ? inh.auth : null, jarCookies: jar, defaults: app.settings });
    const userKeys = new Set(d_keys(tab.draft.headers));
    const auto = p.headers.filter((x) => !userKeys.has(x.key.toLowerCase()) || x.key.toLowerCase() === 'cookie').map((x) => ({ ...x, note: autoNote(x.key) }));
    if (tab.draft.settings.useBrowserCookies) auto.push({ key: 'Cookie', value: '(+ 브라우저 쿠키)', note: 'Chrome 쿠키' });
    const lower = new Set(p.headers.map((x) => x.key.toLowerCase()));
    if (!lower.has('user-agent')) auto.push({ key: 'User-Agent', value: navigator.userAgent, note: '브라우저 기본값' });
    if (!lower.has('accept')) auto.push({ key: 'Accept', value: '*/*', note: '브라우저 기본값' });
    auto.push({ key: 'Accept-Encoding', value: 'gzip, deflate, br, zstd', note: '브라우저 기본값' });
    if (app.settings.removeOrigin && !lower.has('origin')) auto.push({ key: 'Origin', value: '(제거됨)', note: '설정: Origin 제거' });
    return auto;
  }

  renderHiddenHeaders() {
    if (!this.hiddenBox) return;
    let auto = [];
    try {
      auto = this.computeAutoHeaders();
    } catch (e) {
      auto = [];
    }
    if (this.hiddenToggle) {
      clear(this.hiddenToggle);
      this.hiddenToggle.append(icon('eye', 14), this.hiddenOpen ? '자동 헤더 숨기기' : `자동 헤더 ${auto.length}개`);
    }
    clear(this.hiddenBox);
    if (!this.hiddenOpen) return;
    this.hiddenBox.appendChild(
      h('div.auto-headers',
        auto.map((x) => h('div.auto-row', h('span.auto-k', x.key), h('span.auto-v', x.value), h('span.auto-n', x.note || ''))))
    );
  }

  paneBody() {
    const d = this.draft;
    const b = d.body;
    const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['binary', 'binary']];
    const radios = h('div.body-modes', modes.map(([id, label]) => {
      const r = h('input', { type: 'radio', name: 'bm-' + this.tab.id, checked: b.mode === id });
      r.addEventListener('change', () => {
        b.mode = id;
        this.changed();
        this.renderPane();
      });
      return h('label.radio', r, h('span', label));
    }));
    const right = h('div.body-modes-right');
    if (b.mode === 'raw') {
      const langBtn = h('button.btn.btn-sm.btn-ghost.lang-btn', (RAW_LANGS.find((x) => x[0] === b.rawLanguage) || RAW_LANGS[1])[1], icon('chevronDown', 12));
      langBtn.addEventListener('click', () =>
        openMenu(langBtn, RAW_LANGS.map(([id, label]) => ({
          label,
          checked: b.rawLanguage === id,
          onClick: () => {
            b.rawLanguage = id;
            this.changed();
            this.renderPane();
          },
        })))
      );
      radios.appendChild(langBtn);
      right.appendChild(h('button.link-btn', { onclick: () => this.beautify(), title: 'JSON/XML 정렬' }, 'Beautify'));
    }
    const top = h('div.body-top', radios, right);
    let content;
    if (b.mode === 'none') {
      content = h('div.pane-empty', '이 요청에는 Body가 없습니다.');
    } else if (b.mode === 'formdata') {
      content = new KVTable({
      getScope: () => app.getScope(this.tab), rows: () => b.formdata, files: true, onChange: () => this.changed() }).el;
    } else if (b.mode === 'urlencoded') {
      content = new KVTable({
      getScope: () => app.getScope(this.tab), rows: () => b.urlencoded, onChange: () => this.changed() }).el;
    } else if (b.mode === 'raw') {
      this.editor = new CodeEditor({
        value: b.raw,
        language: b.rawLanguage,
        placeholder: b.rawLanguage === 'json' ? '{\n  "key": "value"\n}' : '',
        onChange: (v) => {
          b.raw = v;
          this.changed();
        },
      });
      content = this.editor.el;
    } else if (b.mode === 'binary') {
      content = this.binaryPicker();
    }
    const warn = (d.method === 'GET' || d.method === 'HEAD') && b.mode !== 'none'
      ? h('div.inline-warn', icon('alert', 14), `브라우저 제한으로 ${d.method} 요청에는 Body를 보낼 수 없습니다. 메소드를 POST 등으로 변경하세요.`)
      : null;
    return h('div.pane.pane-body' + (b.mode === 'raw' ? '.raw' : ''), top, warn, content);
  }

  binaryPicker() {
    const b = this.draft.body;
    const inp = h('input', { type: 'file', style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) return toast('파일이 너무 큽니다 (최대 20MB).', 'error');
      b.binary = { name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: await readFileAsDataURL(f) };
      this.changed();
      this.renderPane();
    });
    return h('div.binary-pick',
      h('button.btn', { onclick: () => inp.click() }, icon('upload', 14), '파일 선택'),
      b.binary && b.binary.dataUrl
        ? h('span.file-chip', icon('file', 13), h('span', b.binary.name), h('span.muted', formatBytes(b.binary.size)),
            h('button.icon-btn', { title: '제거', onclick: () => { b.binary = null; this.changed(); this.renderPane(); } }, icon('x', 12)))
        : h('span.muted', '선택된 파일 없음'),
      inp);
  }

  beautify() {
    const b = this.draft.body;
    const src = b.raw;
    let out = src;
    try {
      if (b.rawLanguage === 'json' || /^\s*[{[]/.test(src)) out = beautifyJsonWithVars(src);
      else if (b.rawLanguage === 'xml' || b.rawLanguage === 'html') out = prettyXmlLocal(src);
    } catch (e) {
      toast('정렬 실패: ' + e.message, 'error');
      return;
    }
    b.raw = out;
    if (this.editor) this.editor.setValue(out);
    this.changed();
  }

  paneCookies() {
    const d = this.draft;
    const s = d.settings;
    const jarCb = h('input.cb', { type: 'checkbox', checked: s.useCookieJar !== false });
    jarCb.addEventListener('change', () => {
      s.useCookieJar = jarCb.checked;
      this.changed();
    });
    const brCb = h('input.cb', { type: 'checkbox', checked: !!s.useBrowserCookies });
    brCb.addEventListener('change', () => {
      s.useBrowserCookies = brCb.checked;
      this.changed();
    });
    const table = new KVTable({
      getScope: () => app.getScope(this.tab),
      title: '요청 쿠키',
      rows: () => d.cookies,
      keyPlaceholder: 'Name',
      valuePlaceholder: 'Value',
      description: false,
      onChange: () => this.changed(),
      extraTools: h('button.link-btn', { onclick: () => this.importBrowserCookies() }, icon('download', 13), 'Chrome 쿠키 가져오기'),
    });
    this.cookiePreview = h('div.cookie-preview');
    const pane = h('div.pane',
      h('div.cookie-opts',
        h('label.check', jarCb, h('span', '쿠키 관리자(Cookie Jar)에 저장된 쿠키 함께 보내기'), h('button.link-btn', { onclick: () => app.ui.openCookieManager() }, '관리')),
        h('label.check', brCb, h('span', 'Chrome 브라우저에 로그인된 쿠키 함께 보내기 (현재 세션 쿠키 포함)'))),
      table.el,
      this.cookiePreview);
    this.updateCookiePreview();
    return pane;
  }

  async importBrowserCookies() {
    let url;
    try {
      url = new URL(prepareRequest(this.draft, { scope: app.getScope(this.tab) }).url).href;
    } catch (e) {
      return toast('먼저 올바른 URL을 입력하세요.', 'error');
    }
    const list = await getBrowserCookies(url);
    if (!list.length) return toast('이 URL에 해당하는 Chrome 쿠키가 없습니다.', 'info');
    let n = 0;
    for (const c of list) {
      const ex = this.draft.cookies.find((x) => x.key === c.name);
      if (ex) ex.value = c.value;
      else this.draft.cookies.push(kvRow(c.name, c.value));
      n++;
    }
    toast(`Chrome 쿠키 ${n}개를 가져왔습니다.`, 'success');
    this.changed();
    this.renderPane();
  }

  async updateCookiePreview() {
    if (!this.cookiePreview) return;
    try {
      const p = await app.buildPrepared(this.tab);
      const c = p.headers.find((x) => x.key.toLowerCase() === 'cookie');
      clear(this.cookiePreview);
      this.cookiePreview.append(h('div.field-label', '전송될 Cookie 헤더'), h('code.cookie-line', c ? c.value : '(없음)'));
    } catch (e) {
      clear(this.cookiePreview);
    }
  }

  /* ---------------- cURL 탭 ---------------- */
  paneCurl() {
    const d = this.draft;
    const o = (d.settings.curl = curlOptsOf(d));
    const engine = app.engineOf(this.tab);
    const g = app.settings;
    const ssh = app.tunnelOf();
    const env = app.activeEnv();

    // 실행 방식
    const seg = ssh ? h('div.ssh-chip', icon('lock', 13), `SSH 터널 · ${env.name} (${ssh.user}@${ssh.host}:${ssh.port})`,
      h('button.link-btn', { onclick: () => app.openEnvironment(env.id) }, '설정')) : h('div.seg.engine-seg',
      h('button.seg-btn' + (engine === 'browser' ? '.active' : ''), { onclick: () => this.setEngine('browser') }, icon('globe', 13), '브라우저'),
      h('button.seg-btn' + (engine === 'curl' ? '.active' : ''), { onclick: () => this.setEngine('curl') }, icon('terminal', 13), 'cURL (PC의 curl 실행)'));
    this.helperChip = h('span.helper-chip.checking', '도우미 확인 중…');
    this.updateHelperChip();

    // 옵션 체크박스 (스크린샷의 "추가 옵션"과 동일)
    const opt = (key, label, title) => {
      const cb = h('input.cb', { type: 'checkbox', checked: !!o[key] });
      cb.addEventListener('change', () => {
        o[key] = cb.checked;
        this.changed();
        this.renderCurlNotes();
      });
      return h('label.check.curl-opt', { title }, cb, h('span', label));
    };
    const follow = h('input.cb', { type: 'checkbox', checked: (d.settings.followRedirects ?? g.followRedirects) !== false });
    follow.addEventListener('change', () => {
      d.settings.followRedirects = follow.checked;
      this.changed();
    });
    const httpSel = h('select.select.select-sm',
      [['', 'HTTP 버전: 자동'], ['1.0', '--http1.0'], ['1.1', '--http1.1'], ['2', '--http2']].map(([v, l]) => h('option', { value: v, selected: o.http === v }, l)));
    httpSel.addEventListener('change', () => {
      o.http = httpSel.value;
      this.changed();
    });
    const extra = h('input.input.mono-input', { value: o.extra || '', placeholder: '예) --proxy http://127.0.0.1:8888 --connect-timeout 5 --resolve api.local:443:127.0.0.1', spellcheck: 'false' });
    extra.addEventListener('input', () => {
      o.extra = extra.value;
      this.changed();
      this.renderCurlNotes();
    });

    // 명령어 형식
    const shellSel = h('select.select.select-sm',
      h('option', { value: 'bash', selected: (g.curlShell || 'bash') === 'bash' }, 'bash (Linux · macOS · Git Bash)'),
      h('option', { value: 'cmd', selected: g.curlShell === 'cmd' }, 'Windows cmd'));
    shellSel.addEventListener('change', () => {
      g.curlShell = shellSel.value;
      app.store.changed('settings');
      this.updateCurlPreview();
    });
    const ml = h('input.cb', { type: 'checkbox', checked: g.curlMultiline !== false });
    ml.addEventListener('change', () => {
      g.curlMultiline = ml.checked;
      app.store.changed('settings');
      this.updateCurlPreview();
    });
    this.curlPre = h('pre.curl-cmd');
    this.curlNotes = h('div.curl-notes');
    const copyBtn = h('button.btn.btn-sm', { onclick: () => this.copyCommand(g.curlShell || 'bash', g.curlMultiline !== false) }, icon('copy', 13), '복사');
    const runBtn = h('button.btn.btn-sm.btn-run-curl', { onclick: () => app.send(this.tab, { engine: 'curl' }) }, icon('play', 12), 'cURL로 실행');

    const pane = h('div.pane.curl-pane',
      h('div.curl-sec',
        h('div.curl-sec-title', '실행 방식'),
        h('div.curl-row', seg, this.helperChip),
        h('div.curl-help', ssh
          ? `Send 를 누르면 도우미가 SSH 서버(${ssh.host})에 접속해 터널을 열고, PC의 curl 이 그 터널(SOCKS5)로 요청을 보냅니다. URL 의 주소는 SSH 서버 기준으로 해석됩니다. 환경을 바꾸면 SSH 없이 실행할 수 있습니다.`
          : engine === 'curl'
          ? 'Send 를 누르면 PC에 설치된 curl 이 이 요청을 실행합니다. 브라우저 제약(Body 있는 GET, -k, 프록시, Host 헤더 등) 없이 터미널과 똑같이 동작합니다.'
          : 'Send 를 누르면 브라우저가 요청을 보냅니다. 오른쪽 아래 [cURL로 실행] 으로 이번 요청만 curl 로 실행할 수도 있습니다.')),
      h('div.curl-sec',
        h('div.curl-sec-title', '추가 옵션'),
        h('div.curl-opts',
          opt('verbose', '-v (Verbose)', '요청/응답 과정을 상세히 출력 (Terminal 탭)'),
          opt('insecure', '-k (SSL 무시)', '인증서 검증 생략 - cURL 실행 시에만 적용'),
          opt('silent', '-s (Silent)', '진행 표시줄 숨김 (명령어에 반영)'),
          opt('include', '-i (Response 헤더 포함)', '출력에 응답 헤더 포함 (Terminal 탭)'),
          opt('compressed', '--compressed', '압축 응답 요청 및 자동 해제'),
          h('label.check.curl-opt', { title: 'Settings 탭의 리다이렉트 설정과 같습니다' }, follow, h('span', '-L (리다이렉트 따라가기)')),
          httpSel)),
      h('div.curl-sec',
        h('div.curl-sec-title', '추가 인자', h('span.muted', ' (cURL 실행 시 그대로 전달)')),
        extra),
      h('div.curl-sec',
        h('div.curl-sec-head',
          h('div.curl-sec-title', '생성된 cURL 명령어'),
          h('div.curl-tools', shellSel, h('label.check.curl-opt', ml, h('span', '줄바꿈으로 정렬')), copyBtn, runBtn)),
        this.curlPre,
        this.curlNotes));
    this.renderCurlNotes();
    this.updateCurlPreview();
    return pane;
  }

  renderCurlNotes() {
    if (!this.curlNotes) return;
    clear(this.curlNotes);
    const o = curlOptsOf(this.draft);
    const notes = [];
    if (app.engineOf(this.tab) === 'browser' && o.insecure) notes.push('-k 는 cURL 로 실행할 때만 적용됩니다. 브라우저 전송에서는 인증서 검증을 끌 수 없습니다.');
    if (o.silent || o.include) notes.push('-s / -i 는 명령어에 반영됩니다. 실행 결과는 아래 응답 패널(Body · Headers · Terminal)에 나뉘어 표시됩니다.');
    notes.push(...describeRemovedArgs(parseExtraArgs(o.extra, { ssh: !!app.tunnelOf() }).removed));
    notes.forEach((n) => this.curlNotes.appendChild(h('div.curl-note', icon('info', 13), n)));
  }

  async updateCurlPreview() {
    if (!this.curlPre) return;
    try {
      const p = await app.buildPrepared(this.tab, { engine: 'curl' });
      const cmd = app.curlCommandFor(this.tab, p);
      this.curlPre.innerHTML = highlight(cmd, 'shell');
    } catch (e) {
      this.curlPre.textContent = '명령을 만들 수 없습니다: ' + e.message;
    }
  }

  async updateHelperChip() {
    const chip = this.helperChip;
    if (!chip) return;
    const st = await app.ui.helperStatus();
    if (!chip.isConnected && chip !== this.helperChip) return;
    clear(chip);
    if (st && st.ok) {
      chip.className = 'helper-chip ok';
      chip.append(icon('check', 12), '도우미 연결됨' + (st.curl ? ' · ' + st.curl.split(' ').slice(0, 2).join(' ') : ''));
      chip.title = st.path || '';
    } else {
      chip.className = 'helper-chip bad';
      chip.append(icon('alert', 12), 'cURL 실행 도우미 미설치',
        h('button.link-btn', { onclick: () => app.ui.openCurlHelper() }, '설치하기'));
      chip.title = st ? st.message || '' : '';
    }
  }

  paneSettings() {
    const d = this.draft;
    const s = d.settings;
    const g = app.settings;
    const follow = h('select.select',
      h('option', { value: '', selected: s.followRedirects == null }, `기본값 (${g.followRedirects ? '따라감' : '따라가지 않음'})`),
      h('option', { value: 'yes', selected: s.followRedirects === true }, '리다이렉트 자동으로 따라가기'),
      h('option', { value: 'no', selected: s.followRedirects === false }, '따라가지 않기 (3xx 응답 그대로 표시)'));
    follow.addEventListener('change', () => {
      s.followRedirects = follow.value === '' ? null : follow.value === 'yes';
      this.changed();
    });
    const timeout = h('input.input', { type: 'number', min: '0', step: '100', value: s.timeout ?? '', placeholder: `기본값 (${g.timeout ? g.timeout + ' ms' : '무제한'})` });
    timeout.addEventListener('input', () => {
      const v = timeout.value.trim();
      s.timeout = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
      this.changed();
    });
    const desc = h('textarea.input.desc-ta', { placeholder: '이 요청에 대한 설명 (선택)', spellcheck: 'false' });
    desc.value = d.description || '';
    desc.addEventListener('input', () => {
      d.description = desc.value;
      this.changed();
    });
    return h('div.pane.settings-pane',
      h('div.set-row', h('div.set-label', h('div', '리다이렉트'), h('div.muted', 'curl의 -L 옵션과 동일합니다.')), follow),
      h('div.set-row', h('div.set-label', h('div', '타임아웃 (ms)'), h('div.muted', 'curl의 --max-time 옵션과 동일합니다.')), timeout),
      h('div.set-row.col', h('div.set-label', h('div', '설명')), desc));
  }

  refreshVars() {
    this.urlInput.refresh();
    if (this.sub !== 'body' || this.draft.body.mode !== 'raw') this.renderPane();
    else if (this.editor) this.editor.render();
  }
}

function d_keys(headers) {
  return (headers || []).filter((x) => x.enabled && x.key).map((x) => x.key.toLowerCase());
}

function autoNote(key) {
  const k = key.toLowerCase();
  if (k === 'authorization') return 'Authorization 탭';
  if (k === 'content-type') return 'Body 타입';
  if (k === 'cookie') return 'Cookies 탭 / 쿠키 관리자';
  return '인증 설정';
}

function prettyXmlLocal(xml) {
  const tokens = String(xml).trim().replace(/>\s+</g, '><').split(/(<[^>]+>)/g).filter((t) => t.trim() !== '');
  let indent = 0;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^<\//.test(t)) {
      indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + t);
    } else if (/^<[^!?][^>]*[^/]>$/.test(t)) {
      const next = tokens[i + 1];
      const close = tokens[i + 2];
      if (next && !next.startsWith('<') && close && /^<\//.test(close)) {
        out.push('  '.repeat(indent) + t + next.trim() + close);
        i += 2;
      } else {
        out.push('  '.repeat(indent) + t);
        indent++;
      }
    } else out.push('  '.repeat(indent) + t.trim());
  }
  return out.join('\n');
}

// {{변수}}가 문자열 밖(값 위치)에 있어도 JSON 정렬이 되도록 임시 치환
export function beautifyJsonWithVars(src) {
  const vars = [];
  let tmp = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && inStr) {
      tmp += c + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (c === '{' && src[i + 1] === '{') {
      const end = src.indexOf('}}', i + 2);
      if (end > 0) {
        const v = src.slice(i, end + 2);
        vars.push({ v, bare: !inStr });
        const ph = `__CSVAR_${vars.length - 1}__`;
        tmp += inStr ? ph : `"${ph}"`;
        i = end + 1;
        continue;
      }
    }
    tmp += c;
  }
  let out = JSON.stringify(JSON.parse(tmp), null, 2);
  vars.forEach((x, i) => {
    const ph = `__CSVAR_${i}__`;
    out = x.bare ? out.replace(`"${ph}"`, () => x.v) : out.replace(ph, () => x.v);
  });
  return out;
}
