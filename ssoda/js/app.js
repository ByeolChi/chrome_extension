// 앱 컨트롤러: 탭/컬렉션/환경/히스토리/전송
import { store } from './store.js';
import { uid, clone, download } from './util.js';
import {
  newRequest, newRequestItem, newCollection, newFolder, newEnvironment, findInCollections, reassignIds,
  isDescendant, requestSignature, normalizeRequest, normalizeSsh,
} from './model.js';
import { buildScope } from './variables.js';
import { prepareRequest } from './prepare.js';
import { sendRequest, getBrowserCookies, initHttpEngine } from './http.js';
import {
  runCurl, curlOptsOf, pingHelper, testSsh, forgetSshHost, scanSshHost, trustSshHost, parseExtraArgs, versionAtLeast, SSH_HOST_VERSION,
  SSH_LEGACY_HOST_VERSION, CurlRunError,
} from './curl-runner.js';

// SSH 비밀번호는 저장하지 않고 이 탭의 메모리에만 둔다. 마지막으로 쓴 뒤 이 시간이 지나면 지운다.
export const SSH_SECRET_TTL_MS = 30 * 60 * 1000;
import { genCurl } from './codegen.js';
import { parseSetCookie, storeCookie, cookiesForUrl, purgeExpired } from './cookiejar.js';
import { detectImport, exportPostmanCollection, exportPostmanEnvironment } from './postman.js';
import { looksLikeCurl, parseCurl, suggestName } from './curl-parser.js';

export const app = {
  store,
  views: new Map(), // tabId → view
  responses: new Map(), // tabId → response
  controllers: new Map(), // tabId → AbortController
  sshSecrets: new Map(), // envId → { password, server, lastUsed } (메모리에만 보관, 저장하지 않음)
  ui: {}, // 렌더러 훅 (main.js에서 주입)

  get state() {
    return store.state;
  },
  get settings() {
    return store.state.settings;
  },
  get tabs() {
    return store.state.workspace.tabs;
  },

  /* ---------------- 스코프/변수 ---------------- */
  activeEnv() {
    return store.state.environments.find((e) => e.id === store.state.activeEnvId) || null;
  },

  // 활성 환경의 SSH 터널 설정 (사용 중일 때만)
  tunnelOf(env = this.activeEnv()) {
    return env && env.ssh && env.ssh.enabled ? normalizeSsh(env.ssh) : null;
  },

  collectionOfTab(tab) {
    if (!tab || !tab.itemId) return null;
    const hit = findInCollections(store.state.collections, tab.itemId);
    return hit ? hit.collection : null;
  },

  getScope(tab = this.activeTab()) {
    const env = this.activeEnv();
    const col = tab && tab.type === 'request' ? this.collectionOfTab(tab) : tab && tab.type === 'collection' ? this.findCollection(tab.refId) : null;
    return buildScope([
      { name: 'environment', vars: env ? env.variables : [] },
      { name: 'collection', vars: col ? col.variables : [] },
      { name: 'globals', vars: store.state.globals.variables },
    ]);
  },

  // 상위 폴더/컬렉션에서 상속되는 인증 정보
  getInheritedAuth(itemId) {
    if (!itemId) return null;
    const chain = this.ancestors(itemId);
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i].auth;
      if (a && a.type && a.type !== 'inherit') return a.type === 'none' ? null : { auth: a, from: chain[i] };
    }
    return null;
  },

  // [collection, folder1, folder2 ...] (항목 자신 제외)
  ancestors(itemId) {
    for (const col of store.state.collections) {
      const path = [];
      const walk = (items) => {
        for (const it of items || []) {
          if (it.id === itemId) return true;
          if (it.type === 'folder') {
            path.push(it);
            if (walk(it.items)) return true;
            path.pop();
          }
        }
        return false;
      };
      if (col.id === itemId) return [];
      if (walk(col.items)) return [col, ...path];
    }
    return [];
  },

  findCollection(id) {
    return store.state.collections.find((c) => c.id === id) || null;
  },

  /* ---------------- 탭 ---------------- */
  activeTab() {
    const ws = store.state.workspace;
    return ws.tabs.find((t) => t.id === ws.activeTabId) || null;
  },

  saveWorkspace() {
    store.save('workspace');
  },

  setActive(tabId) {
    store.state.workspace.activeTabId = tabId;
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
    this.ui.renderMain && this.ui.renderMain();
    this.ui.renderSidebarSelection && this.ui.renderSidebarSelection();
  },

  addTab(tab, { activate = true, afterActive = true } = {}) {
    const ws = store.state.workspace;
    const idx = ws.tabs.findIndex((t) => t.id === ws.activeTabId);
    if (afterActive && idx >= 0) ws.tabs.splice(idx + 1, 0, tab);
    else ws.tabs.push(tab);
    if (activate) this.setActive(tab.id);
    else {
      this.saveWorkspace();
      this.ui.renderTabs && this.ui.renderTabs();
    }
    return tab;
  },

  newRequestTab(partial = {}, name = 'Untitled Request') {
    const draft = normalizeRequest(newRequest(partial));
    const tab = { id: uid('tab'), type: 'request', itemId: null, name, draft, dirty: false };
    tab.savedSig = requestSignature(tab.name, tab.draft);
    return this.addTab(tab);
  },

  openItem(itemId, { newTab = false } = {}) {
    const hit = findInCollections(store.state.collections, itemId);
    if (!hit) return;
    const it = hit.item;
    if (it.type === 'request') {
      const existing = this.tabs.find((t) => t.type === 'request' && t.itemId === itemId);
      if (existing && !newTab) return this.setActive(existing.id);
      const tab = { id: uid('tab'), type: 'request', itemId, name: it.name, draft: clone(it.request), dirty: false };
      tab.savedSig = requestSignature(it.name, it.request);
      return this.addTab(tab);
    }
    // 컬렉션/폴더 설정 탭
    const existing = this.tabs.find((t) => t.type === 'collection' && t.refId === itemId);
    if (existing) return this.setActive(existing.id);
    return this.addTab({ id: uid('tab'), type: 'collection', refId: itemId, name: it.name, sub: 'overview' });
  },

  openEnvironment(envId) {
    const existing = this.tabs.find((t) => t.type === 'environment' && t.refId === envId);
    if (existing) return this.setActive(existing.id);
    const env = envId === 'globals' ? { name: 'Globals' } : store.state.environments.find((e) => e.id === envId);
    if (!env) return;
    return this.addTab({ id: uid('tab'), type: 'environment', refId: envId, name: env.name });
  },

  openHistory(entry) {
    const tab = this.newRequestTab(clone(entry.request), entry.name || suggestName(entry.request.method, entry.request.url));
    return tab;
  },

  async closeTab(tabId, { force = false } = {}) {
    const ws = store.state.workspace;
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return true;
    const tab = ws.tabs[idx];
    if (tab.type === 'request') tab.dirty = requestSignature(tab.name, tab.draft) !== tab.savedSig;
    if (!force && tab.type === 'request' && tab.dirty) {
      const choice = await this.ui.askSaveChanges(tab);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        const ok = await this.saveTab(tab);
        if (!ok) return false;
      }
    }
    const i2 = ws.tabs.findIndex((t) => t.id === tabId);
    if (i2 < 0) return true;
    ws.tabs.splice(i2, 1);
    this.controllers.get(tabId)?.abort();
    const view = this.views.get(tabId);
    if (view && view.destroy) view.destroy();
    this.views.delete(tabId);
    this.responses.delete(tabId);
    if (ws.activeTabId === tabId) {
      const next = ws.tabs[i2] || ws.tabs[i2 - 1] || null;
      ws.activeTabId = next ? next.id : null;
    }
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
    this.ui.renderMain && this.ui.renderMain();
    this.ui.renderSidebarSelection && this.ui.renderSidebarSelection();
    return true;
  },

  async closeTabs(ids) {
    for (const id of ids) {
      const ok = await this.closeTab(id);
      if (!ok) break;
    }
  },

  duplicateTab(tab) {
    if (tab.type !== 'request') return;
    return this.newRequestTab(clone(tab.draft), tab.name + ' 복사본');
  },

  // 에디터 변경 시 호출
  markChanged(tab) {
    const sig = requestSignature(tab.name, tab.draft);
    const dirty = sig !== tab.savedSig;
    const was = tab.dirty;
    tab.dirty = dirty;
    this.saveWorkspace();
    if (was !== dirty) this.ui.renderTabs && this.ui.renderTabs();
    else this.ui.updateTabLabel && this.ui.updateTabLabel(tab);
  },

  /* ---------------- 저장 ---------------- */
  async saveTab(tab, { saveAs = false } = {}) {
    if (!tab || tab.type !== 'request') return false;
    const hit = tab.itemId ? findInCollections(store.state.collections, tab.itemId) : null;
    if (hit && !saveAs) {
      hit.item.name = tab.name;
      hit.item.request = clone(tab.draft);
      tab.savedSig = requestSignature(tab.name, tab.draft);
      tab.dirty = false;
      store.changed('collections');
      this.saveWorkspace();
      this.ui.renderTabs && this.ui.renderTabs();
      this.ui.renderSidebar && this.ui.renderSidebar();
      this.ui.refreshView && this.ui.refreshView(tab);
      this.ui.toast('저장되었습니다.', 'success');
      return true;
    }
    const res = await this.ui.saveAsDialog(tab);
    if (!res) return false;
    const item = newRequestItem(res.name, clone(tab.draft));
    const parent = findInCollections(store.state.collections, res.parentId);
    if (!parent) return false;
    parent.item.items.push(item);
    tab.itemId = item.id;
    tab.name = res.name;
    tab.savedSig = requestSignature(tab.name, tab.draft);
    tab.dirty = false;
    store.state.workspace.expanded[parent.collection.id] = true;
    store.state.workspace.expanded[res.parentId] = true;
    store.changed('collections');
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
    this.ui.renderSidebar && this.ui.renderSidebar();
    this.ui.refreshView && this.ui.refreshView(tab);
    this.ui.toast(`"${parent.item.name}"에 저장되었습니다.`, 'success');
    return true;
  },

  /* ---------------- 전송 ---------------- */
  engineOf(tab) {
    // SSH 터널은 PC의 curl 로만 사용할 수 있음
    if (this.tunnelOf()) return 'curl';
    const e = tab && tab.draft && tab.draft.settings.engine;
    return e === 'curl' || e === 'browser' ? e : this.settings.defaultEngine === 'curl' ? 'curl' : 'browser';
  },

  // 표시용 cURL 명령 (cURL 탭 / Terminal)
  curlCommandFor(tab, prepared, { shell, multiline } = {}) {
    const curl = curlOptsOf(tab.draft);
    return genCurl(prepared, {
      shell: shell || this.settings.curlShell || 'bash',
      multiline: multiline ?? this.settings.curlMultiline !== false,
      short: true,
      curl: { ...curl, extraArgs: parseExtraArgs(curl.extra, { ssh: !!this.tunnelOf() }).args },
    });
  },

  async buildPrepared(tab, { engine } = {}) {
    const forCurl = (engine || this.engineOf(tab)) === 'curl';
    const scope = this.getScope(tab);
    const inh = this.getInheritedAuth(tab.itemId);
    const base = prepareRequest(tab.draft, { scope, inheritedAuth: inh ? inh.auth : null, defaults: this.settings });
    let jarCookies = [];
    let browserCookies = [];
    let url = base.url;
    try {
      url = new URL(base.url).href;
    } catch (e) {
      /* invalid url */
    }
    if (tab.draft.settings.useCookieJar !== false) jarCookies = cookiesForUrl(store.state.cookieJar, url);
    if (tab.draft.settings.useBrowserCookies) browserCookies = await getBrowserCookies(url);
    return prepareRequest(tab.draft, {
      scope,
      inheritedAuth: inh ? inh.auth : null,
      jarCookies,
      browserCookies,
      allowBodyForGet: forCurl,
      defaults: { followRedirects: this.settings.followRedirects, timeout: this.settings.timeout },
    });
  },

  async send(tab = this.activeTab(), { engine } = {}) {
    if (!tab || tab.type !== 'request') return;
    engine = engine || this.engineOf(tab);
    if (this.controllers.has(tab.id)) return this.cancel(tab);
    if (!String(tab.draft.url).trim()) {
      this.ui.toast('URL을 입력하세요.', 'error');
      return;
    }
    const env = this.activeEnv();
    let ssh = null;
    if (this.tunnelOf(env)) {
      if (engine === 'browser') this.ui.toast(`"${env.name}" 환경은 SSH 터널을 사용하므로 cURL로 실행합니다.`, 'info', 3500);
      engine = 'curl';
      ssh = await this.sshConfigFor(env);
      if (!ssh) return;
      if (this.controllers.has(tab.id)) return;
    }
    const view = this.views.get(tab.id);
    const ctrl = new AbortController();
    this.controllers.set(tab.id, ctrl);
    view && view.setLoading(true, engine);
    let prepared;
    let result;
    let command = '';
    try {
      prepared = await this.buildPrepared(tab, { engine });
      if (prepared.unresolved.length) {
        this.ui.toast(`정의되지 않은 변수: ${prepared.unresolved.map((v) => `{{${v}}}`).join(', ')}`, 'error', 4000);
      }
      if (engine === 'curl') {
        command = this.curlCommandFor(tab, prepared, { shell: 'bash', multiline: true });
        const run = () => runCurl(prepared, curlOptsOf(tab.draft), { signal: ctrl.signal, curlPath: this.settings.curlPath || '', command, ssh });
        if (ssh) {
          await this.ensureSshHelper(ssh);
          result = await this.withHostKeyTrust(env, ssh, run);
        } else result = await run();
      } else {
        result = await sendRequest(prepared, { signal: ctrl.signal, removeOrigin: this.settings.removeOrigin });
      }
      this.captureCookies(result);
    } catch (err) {
      result = {
        ok: false,
        engine,
        error: { message: err.message || String(err), code: err.code || 'ERROR', hint: err.hint || '' },
        timing: { total: err.elapsed },
        hops: err.capture ? err.capture.hops : [],
        terminal: err.terminal || (engine === 'curl' ? { command, stderr: '', exitCode: null, ssh: ssh ? { label: ssh.label, host: ssh.host, port: ssh.port, user: ssh.user, failed: true, log: '' } : undefined } : null),
        warnings: err.warnings || (prepared ? prepared.warnings : []),
        sentUrl: prepared ? prepared.url : tab.draft.url,
        method: prepared ? prepared.method : tab.draft.method,
        ts: Date.now(),
      };
      // 비밀번호가 틀렸다면 다음 전송 때 다시 묻는다
      if (err.code === 'SSH_AUTH' && env) this.forgetSshSecret(env.id);
    } finally {
      this.controllers.delete(tab.id);
    }
    this.responses.set(tab.id, result);
    this.addHistory(tab, result);
    const v = this.views.get(tab.id);
    if (v) {
      v.setLoading(false);
      v.showResponse(result);
    }
    return result;
  },

  /* ---------------- SSH ---------------- */
  // 메모리에 있는 비밀번호 (서버 정보가 바뀌었거나 오래 쓰지 않았으면 버림)
  sshSecret(env) {
    const hit = this.sshSecrets.get(env.id);
    if (!hit) return null;
    const s = normalizeSsh(env.ssh);
    if (hit.server !== `${s.user}@${s.host}:${s.port}` || Date.now() - hit.lastUsed > SSH_SECRET_TTL_MS) {
      this.sshSecrets.delete(env.id);
      return null;
    }
    return hit;
  },

  rememberSshSecret(env, password) {
    const s = normalizeSsh(env.ssh);
    this.sshSecrets.set(env.id, { password, server: `${s.user}@${s.host}:${s.port}`, lastUsed: Date.now() });
  },

  forgetSshSecret(envId) {
    this.sshSecrets.delete(envId);
  },

  purgeSshSecrets() {
    for (const env of store.state.environments) this.sshSecret(env);
    for (const id of [...this.sshSecrets.keys()]) if (!store.state.environments.some((e) => e.id === id)) this.sshSecrets.delete(id);
  },

  // SSH 접속 정보 (비밀번호가 없으면 물어봄). 취소하면 null
  async sshConfigFor(env) {
    const s = normalizeSsh(env.ssh);
    if (!s.host || !s.user) {
      this.ui.toast(`"${env.name}" 환경의 SSH 서버 주소와 사용자를 입력하세요.`, 'error', 4000);
      this.openEnvironment(env.id);
      return null;
    }
    let hit = this.sshSecret(env);
    if (!hit) {
      const password = await this.ui.askSshPassword(env, s);
      if (password == null) return null;
      this.rememberSshSecret(env, password);
      hit = this.sshSecrets.get(env.id);
    }
    hit.lastUsed = Date.now();
    return { host: s.host, port: s.port, user: s.user, password: hit.password, legacy: s.legacy, label: env.name };
  },

  // 처음 접속하는 서버면 지문을 보여 주고, 사용자가 확인하면 저장한 뒤 다시 시도
  async withHostKeyTrust(env, ssh, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.code !== 'SSH_HOSTKEY_UNKNOWN') throw e;
      if (!(await this.confirmHostKey(env, ssh))) {
        e.message = '서버 지문을 확인하지 않아 접속하지 않았습니다.';
        throw e;
      }
      return fn();
    }
  },

  async confirmHostKey(env, ssh) {
    const scan = await scanSshHost(ssh);
    if (!scan.keys) {
      throw new CurlRunError('서버의 호스트 키를 가져오지 못했습니다.', {
        code: 'SSH_ERROR',
        hint: scan.error || 'SSH 서버 주소와 포트를 확인하세요.',
      });
    }
    if (!(await this.ui.askTrustHostKey(env, ssh, scan))) return false;
    await trustSshHost(ssh, scan.keys);
    return true;
  },

  // SSH 터널을 지원하는 도우미인지 확인 (구버전 도우미는 터널 없이 바로 요청을 보내 버리므로 실행 전에 막는다)
  async ensureSshHelper(ssh) {
    const need = ssh && ssh.legacy ? SSH_LEGACY_HOST_VERSION : SSH_HOST_VERSION;
    let st = await this.ui.helperStatus();
    if (!st.ok || !versionAtLeast(st.hostVersion, need)) st = await this.ui.helperStatus({ force: true });
    if (!st.ok) throw new CurlRunError(st.message || 'cURL 실행 도우미에 연결할 수 없습니다.', { code: st.code || 'NO_HOST', hint: st.hint || 'SSH 터널은 cURL 실행 도우미가 있어야 사용할 수 있습니다.' });
    if (!versionAtLeast(st.hostVersion, need)) {
      throw new CurlRunError(`설치된 cURL 실행 도우미(v${st.hostVersion || '?'})가 ${ssh && ssh.legacy ? '구형 서버 호환을' : 'SSH 터널을'} 지원하지 않습니다.`, {
        code: 'HOST_OUTDATED',
        hint: `도우미 v${need} 이상이 필요합니다. 아래 [도우미 설치 / 확인] 버튼으로 설치 파일을 다시 받아 실행해 주세요.`,
      });
    }
  },

  async testSshFor(env) {
    const ssh = await this.sshConfigFor(env);
    if (!ssh) return null;
    await this.ensureSshHelper(ssh);
    let r = await testSsh(ssh);
    if (!r.ok && r.code === 'SSH_HOSTKEY_UNKNOWN') {
      if (!(await this.confirmHostKey(env, ssh))) return { ok: false, code: 'SSH_HOSTKEY_UNKNOWN', message: '서버 지문을 확인하지 않아 접속하지 않았습니다.', hint: '' };
      r = await testSsh(ssh);
    }
    if (!r.ok && r.code === 'SSH_AUTH') this.forgetSshSecret(env.id);
    return r;
  },

  async forgetSshHostFor(env) {
    const s = normalizeSsh(env.ssh);
    await this.ensureSshHelper();
    return forgetSshHost({ host: s.host, port: s.port, user: s.user || 'x', password: '' });
  },

  cancel(tab) {
    const c = this.controllers.get(tab.id);
    if (c) c.abort();
  },

  captureCookies(result) {
    if (!this.settings.autoSaveCookies || !result || !result.ok) return;
    const jar = store.state.cookieJar;
    let n = 0;
    for (const hc of result.hopCookies || []) {
      const c = parseSetCookie(hc.value, hc.url);
      if (c) {
        storeCookie(jar, c);
        n++;
      }
    }
    for (const sc of result.setCookies || []) {
      const c = parseSetCookie(sc, result.url);
      if (c) {
        storeCookie(jar, c);
        n++;
      }
    }
    if (n) {
      store.state.cookieJar = purgeExpired(jar);
      store.changed('cookieJar');
    }
  },

  addHistory(tab, result) {
    if (!this.settings.historyEnabled) return;
    const req = clone(tab.draft);
    // 히스토리에는 파일 데이터 저장하지 않음
    (req.body.formdata || []).forEach((f) => {
      if (f.file) f.file = { name: f.file.name, missing: true };
    });
    if (req.body.binary) req.body.binary = null;
    const entry = {
      id: uid('his'),
      ts: Date.now(),
      name: tab.itemId ? tab.name : '',
      itemId: tab.itemId || null,
      request: req,
      status: result.ok ? result.status : 0,
      statusText: result.ok ? result.statusText : result.error?.message,
      time: result.timing?.total,
      size: result.ok ? result.size.body : 0,
      engine: result.engine || 'browser',
    };
    const h = store.state.history;
    h.unshift(entry);
    const limit = this.settings.historyLimit > 0 ? this.settings.historyLimit : 300;
    if (h.length > limit) h.length = limit;
    store.changed('history');
  },

  /* ---------------- 컬렉션 ---------------- */
  createCollection(name = '새 컬렉션') {
    const c = newCollection(name);
    store.state.collections.push(c);
    store.state.workspace.expanded[c.id] = true;
    store.changed('collections');
    this.saveWorkspace();
    return c;
  },

  addRequestTo(parentId, name = '새 요청') {
    const hit = findInCollections(store.state.collections, parentId);
    if (!hit) return null;
    const item = newRequestItem(name);
    hit.item.items.push(item);
    store.state.workspace.expanded[parentId] = true;
    store.changed('collections');
    this.saveWorkspace();
    this.openItem(item.id);
    return item;
  },

  addFolderTo(parentId, name = '새 폴더') {
    const hit = findInCollections(store.state.collections, parentId);
    if (!hit) return null;
    const f = newFolder(name);
    hit.item.items.push(f);
    store.state.workspace.expanded[parentId] = true;
    store.changed('collections');
    this.saveWorkspace();
    return f;
  },

  renameItem(id, name) {
    const hit = findInCollections(store.state.collections, id);
    if (!hit || !name) return;
    hit.item.name = name;
    // 열린 탭 이름 동기화
    for (const t of this.tabs) {
      if ((t.type === 'request' && t.itemId === id) || (t.type === 'collection' && t.refId === id)) {
        if (t.type === 'request') {
          const wasDirty = t.dirty;
          t.name = name;
          t.savedSig = requestSignature(name, hit.item.request);
          t.dirty = wasDirty ? requestSignature(t.name, t.draft) !== t.savedSig : false;
        } else t.name = name;
        this.ui.refreshView && this.ui.refreshView(t);
      }
    }
    store.changed('collections');
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
  },

  deleteItem(id) {
    const hit = findInCollections(store.state.collections, id);
    if (!hit) return;
    const ids = new Set([id]);
    const collect = (items) => (items || []).forEach((it) => {
      ids.add(it.id);
      if (it.items) collect(it.items);
    });
    collect(hit.item.items);
    if (!hit.parent) {
      store.state.collections = store.state.collections.filter((c) => c.id !== id);
    } else {
      hit.parent.items = hit.parent.items.filter((x) => x.id !== id);
    }
    // 관련 탭: 저장 안 된 탭으로 전환
    for (const t of [...this.tabs]) {
      if (t.type === 'request' && ids.has(t.itemId)) {
        t.itemId = null;
        t.dirty = true;
        t.savedSig = '';
      } else if (t.type === 'collection' && ids.has(t.refId)) {
        this.closeTab(t.id, { force: true });
      }
    }
    store.changed('collections');
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
    const at = this.activeTab();
    if (at) this.ui.refreshView && this.ui.refreshView(at);
  },

  duplicateItem(id) {
    const hit = findInCollections(store.state.collections, id);
    if (!hit) return;
    const copy = reassignIds(hit.item);
    copy.name = hit.item.name + ' 복사본';
    if (!hit.parent) {
      const i = store.state.collections.indexOf(hit.item);
      store.state.collections.splice(i + 1, 0, copy);
    } else {
      const i = hit.parent.items.indexOf(hit.item);
      hit.parent.items.splice(i + 1, 0, copy);
    }
    store.changed('collections');
  },

  // 드래그앤드롭 이동. position: 'before' | 'after' | 'inside'
  moveItem(dragId, targetId, position) {
    if (dragId === targetId) return false;
    const cols = store.state.collections;
    const src = findInCollections(cols, dragId);
    const dst = findInCollections(cols, targetId);
    if (!src || !dst) return false;
    // 컬렉션 순서 변경
    if (!src.parent) {
      if (dst.parent) return false;
      const from = cols.indexOf(src.item);
      cols.splice(from, 1);
      let to = cols.indexOf(dst.item);
      if (position === 'after' || position === 'inside') to++;
      cols.splice(to, 0, src.item);
      store.changed('collections');
      return true;
    }
    if (src.item.type === 'folder' && (src.item.id === targetId || isDescendant(src.item, targetId))) return false;
    let parent;
    let index;
    if (position === 'inside') {
      if (dst.item.type === 'request') return false;
      parent = dst.item;
      index = parent.items.length;
    } else {
      if (!dst.parent) {
        parent = dst.item;
        index = position === 'before' ? 0 : parent.items.length;
      } else {
        parent = dst.parent;
        index = parent.items.indexOf(dst.item) + (position === 'after' ? 1 : 0);
      }
    }
    const fromArr = src.parent.items;
    const fromIdx = fromArr.indexOf(src.item);
    fromArr.splice(fromIdx, 1);
    if (fromArr === parent.items && fromIdx < index) index--;
    parent.items.splice(index, 0, src.item);
    store.state.workspace.expanded[parent.id] = true;
    store.changed('collections');
    this.saveWorkspace();
    this.ui.renderTabs && this.ui.renderTabs();
    return true;
  },

  exportCollection(id) {
    const col = this.findCollection(id);
    if (!col) return;
    const json = exportPostmanCollection(col);
    download(`${safeFile(col.name)}.postman_collection.json`, JSON.stringify(json, null, 2));
  },

  /* ---------------- 환경 ---------------- */
  createEnvironment(name = '새 환경') {
    const env = newEnvironment(name);
    store.state.environments.push(env);
    store.changed('environments');
    return env;
  },

  setActiveEnv(id) {
    store.state.activeEnvId = id;
    store.changed('activeEnvId');
    this.ui.renderEnvSelector && this.ui.renderEnvSelector();
    this.ui.refreshVars && this.ui.refreshVars();
    this.ui.refreshEngines && this.ui.refreshEngines();
  },

  deleteEnvironment(id) {
    this.forgetSshSecret(id);
    store.state.environments = store.state.environments.filter((e) => e.id !== id);
    if (store.state.activeEnvId === id) store.state.activeEnvId = null;
    for (const t of [...this.tabs]) if (t.type === 'environment' && t.refId === id) this.closeTab(t.id, { force: true });
    store.changed('environments');
    store.changed('activeEnvId');
    this.ui.renderEnvSelector && this.ui.renderEnvSelector();
  },

  duplicateEnvironment(id) {
    const env = store.state.environments.find((e) => e.id === id);
    if (!env) return;
    const c = clone(env);
    c.id = uid('env');
    c.name = env.name + ' 복사본';
    store.state.environments.push(c);
    store.changed('environments');
  },

  exportEnvironment(id) {
    const env = id === 'globals' ? { name: 'Globals', variables: store.state.globals.variables } : store.state.environments.find((e) => e.id === id);
    if (!env) return;
    const json = exportPostmanEnvironment(env);
    if (id === 'globals') json._postman_variable_scope = 'globals';
    download(`${safeFile(env.name)}.postman_environment.json`, JSON.stringify(json, null, 2));
  },

  /* ---------------- 가져오기 ---------------- */
  // 텍스트(cURL/Postman JSON/URL) 가져오기. 결과 요약 반환
  importText(text, { openCurlInTab = true } = {}) {
    const r = detectImport(text);
    if (r.kind === 'curl' || r.kind === 'url') {
      if (openCurlInTab) this.newRequestTab(r.request, r.name || 'Untitled Request');
      return { kind: r.kind, warnings: r.warnings || [], message: 'cURL 명령을 새 탭으로 가져왔습니다.' };
    }
    if (r.kind === 'collection') {
      store.state.collections.push(r.collection);
      store.state.workspace.expanded[r.collection.id] = true;
      store.changed('collections');
      this.saveWorkspace();
      this.ui.showSidebar && this.ui.showSidebar('collections');
      return { kind: 'collection', warnings: r.warnings, message: `컬렉션 "${r.collection.name}"을(를) 가져왔습니다.` };
    }
    if (r.kind === 'environment') {
      store.state.environments.push(r.environment);
      store.changed('environments');
      this.ui.showSidebar && this.ui.showSidebar('environments');
      return { kind: 'environment', warnings: [], message: `환경 "${r.environment.name}"을(를) 가져왔습니다.` };
    }
    if (r.kind === 'backup') {
      return { kind: 'backup', data: r.data, warnings: [], message: '백업 파일' };
    }
    throw new Error('지원하지 않는 형식입니다.');
  },

  applyCurlToTab(tab, text) {
    const { request, warnings } = parseCurl(text);
    tab.draft = request;
    if (!tab.itemId && (tab.name === 'Untitled Request' || !tab.name)) tab.name = suggestName(request.method, request.url);
    const view = this.views.get(tab.id);
    if (view && view.destroy) view.destroy();
    this.views.delete(tab.id);
    this.markChanged(tab);
    this.ui.renderTabs && this.ui.renderTabs();
    this.ui.renderMain && this.ui.renderMain();
    return warnings;
  },

  looksLikeCurl,
  pingHelper: (opts) => pingHelper({ curlPath: store.state.settings.curlPath || '', ...(opts || {}) }),

  async init() {
    await store.load();
    await initHttpEngine();
    // 예전에 저장된 SSH 비밀번호(평문) 삭제
    let dirty = false;
    for (const e of store.state.environments) {
      if (e.ssh && ('password' in e.ssh || 'savePassword' in e.ssh)) {
        e.ssh = normalizeSsh(e.ssh);
        dirty = true;
      }
    }
    if (dirty) {
      store.save('environments');
      await store.flush();
    }
    setInterval(() => this.purgeSshSecrets(), 60 * 1000);
    // 저장된 탭 정규화
    for (const t of this.tabs) {
      if (t.type === 'request') t.draft = normalizeRequest(t.draft);
    }
  },

  backupData() {
    const s = store.state;
    return {
      app: 'ssoda',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        collections: s.collections,
        environments: s.environments.map((e) => (e.ssh ? { ...e, ssh: normalizeSsh(e.ssh) } : e)),
        globals: s.globals,
        activeEnvId: s.activeEnvId,
        history: s.history,
        cookieJar: s.cookieJar,
        settings: s.settings,
      },
    };
  },
};

function safeFile(name) {
  return String(name || 'export').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

