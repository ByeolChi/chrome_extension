// 왼쪽 사이드바: 컬렉션 / 환경 / 히스토리
import { h, clear, methodClass, methodShort, relativeDayLabel, timeLabel, statusClass, formatMs } from '../util.js';
import { countRequests } from '../model.js';
import { icon } from './icons.js';
import { openMenu, confirmDialog, promptDialog, toast } from './overlay.js';
import { app } from '../app.js';

export class Sidebar {
  constructor(el) {
    this.el = el;
    this.query = '';
    this.renaming = null;
    this.dragId = null;
  }

  get panel() {
    return app.state.workspace.sidebar || 'collections';
  }

  render() {
    clear(this.el);
    const panel = this.panel;
    const titles = { collections: 'Collections', environments: 'Environments', history: 'History' };
    const plusBtn = h('button.icon-btn', { title: panel === 'history' ? '' : '새로 만들기' }, icon('plus', 16));
    plusBtn.addEventListener('click', () => this.onPlus());
    const moreBtn = h('button.icon-btn', { title: '더 보기' }, icon('more', 16));
    moreBtn.addEventListener('click', () => this.onMore(moreBtn));
    const search = h('input.sb-search', { placeholder: '검색', value: this.query, spellcheck: 'false' });
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderBody();
    });
    this.bodyEl = h('div.sb-body');
    this.el.append(
      h('div.sb-title', titles[panel]),
      h('div.sb-tools', panel !== 'history' ? plusBtn : null, h('div.sb-search-wrap', icon('search', 14), search), moreBtn),
      this.bodyEl
    );
    this.renderBody();
  }

  renderBody() {
    clear(this.bodyEl);
    if (this.panel === 'collections') this.renderCollections();
    else if (this.panel === 'environments') this.renderEnvironments();
    else this.renderHistory();
  }

  onPlus() {
    if (this.panel === 'collections') {
      const c = app.createCollection();
      this.renaming = c.id;
      this.render();
    } else if (this.panel === 'environments') {
      const e = app.createEnvironment();
      app.openEnvironment(e.id);
      this.render();
      setTimeout(() => {
        const inp = document.querySelector('.ev-name-input');
        if (inp) {
          inp.focus();
          inp.select();
        }
      }, 50);
    }
  }

  onMore(btn) {
    if (this.panel === 'history') {
      openMenu(btn, [
        {
          label: '히스토리 전체 삭제',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            if (await confirmDialog({ title: '히스토리 삭제', message: '모든 요청 기록을 삭제할까요?', okText: '삭제', danger: true })) {
              app.state.history = [];
              app.store.changed('history');
              this.render();
            }
          },
        },
      ], { alignRight: true });
    } else if (this.panel === 'collections') {
      openMenu(btn, [
        { label: '가져오기…', icon: 'import', onClick: () => app.ui.openImport() },
        { label: '모두 펼치기', onClick: () => { this.setAllExpanded(true); } },
        { label: '모두 접기', onClick: () => { this.setAllExpanded(false); } },
      ], { alignRight: true });
    } else {
      openMenu(btn, [{ label: '가져오기…', icon: 'import', onClick: () => app.ui.openImport() }], { alignRight: true });
    }
  }

  setAllExpanded(v) {
    const ex = app.state.workspace.expanded;
    const walk = (items) => items.forEach((it) => {
      if (it.items) {
        ex[it.id] = v;
        walk(it.items);
      }
    });
    app.state.collections.forEach((c) => (ex[c.id] = v));
    app.state.collections.forEach((c) => walk(c.items));
    app.saveWorkspace();
    this.renderBody();
  }

  /* ---------------- Collections ---------------- */
  renderCollections() {
    const cols = app.state.collections;
    if (!cols.length) {
      this.bodyEl.appendChild(
        h('div.sb-empty',
          icon('collections', 36),
          h('div.sb-empty-title', '컬렉션이 없습니다'),
          h('div.sb-empty-sub', '자주 쓰는 요청을 컬렉션에 저장해 관리하세요.'),
          h('button.btn.btn-primary', { onclick: () => this.onPlus() }, icon('plus', 14), '컬렉션 만들기'),
          h('button.link-btn', { onclick: () => app.ui.openImport() }, 'Postman 컬렉션 가져오기'))
      );
      return;
    }
    const q = this.query.trim().toLowerCase();
    const tree = h('div.tree', { role: 'tree' });
    for (const col of cols) {
      const node = this.renderNode(col, 0, true, q);
      if (node) tree.appendChild(node);
    }
    if (q && !tree.children.length) tree.appendChild(h('div.sb-none', '검색 결과가 없습니다.'));
    this.bodyEl.appendChild(tree);
    this.markActive();
  }

  matches(it, q) {
    if (!q) return true;
    if (String(it.name).toLowerCase().includes(q)) return true;
    if (it.type === 'request' && (String(it.request.url).toLowerCase().includes(q) || it.request.method.toLowerCase() === q)) return true;
    return (it.items || []).some((c) => this.matches(c, q));
  }

  renderNode(it, depth, isCollection, q) {
    if (q && !this.matches(it, q)) return null;
    const ex = app.state.workspace.expanded;
    const isContainer = isCollection || it.type === 'folder';
    const open = q ? true : !!ex[it.id];
    const row = h('div.tree-row' + (isCollection ? '.col-row' : ''), {
      style: { paddingLeft: 8 + depth * 14 + 'px' },
      dataset: { id: it.id },
      draggable: 'true',
      role: 'treeitem',
      tabindex: '0',
    });
    if (isContainer) {
      row.appendChild(h('span.tree-caret', icon(open ? 'chevronDown' : 'chevronRight', 14)));
      if (!isCollection) row.appendChild(icon('folder', 15, 'tree-ic'));
    } else {
      row.appendChild(h('span.tree-caret.empty'));
      row.appendChild(h('span.tree-method.' + methodClass(it.request.method), methodShort(it.request.method)));
    }
    if (this.renaming === it.id) {
      const input = h('input.tree-rename', { value: it.name, spellcheck: 'false' });
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        this.renaming = null;
        const v = input.value.trim();
        if (commit && v) app.renameItem(it.id, v);
        this.renderBody();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.isComposing) finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      row.draggable = false;
    } else {
      row.appendChild(h('span.tree-name', { title: it.type === 'request' ? `${it.request.method} ${it.request.url}` : it.name }, it.name));
      if (isCollection) row.appendChild(h('span.tree-count', String(countRequests(it.items))));
    }
    const more = h('button.icon-btn.tree-more', { title: '더 보기' }, icon('more', 15));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.itemMenu(it, isCollection, more);
    });
    row.appendChild(more);

    row.addEventListener('click', () => {
      if (isContainer) {
        ex[it.id] = !open;
        app.saveWorkspace();
        this.renderBody();
      } else {
        app.openItem(it.id);
      }
    });
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (isContainer) {
        app.openItem(it.id);
      } else {
        this.renaming = it.id;
        this.renderBody();
      }
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') row.click();
      if (e.key === 'F2') {
        this.renaming = it.id;
        this.renderBody();
      }
      if (e.key === 'Delete') this.confirmDelete(it, isCollection);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.itemMenu(it, isCollection, { x: e.clientX, y: e.clientY });
    });
    this.bindDnd(row, it, isContainer);

    const wrap = h('div.tree-node', row);
    if (isContainer && open) {
      const kids = h('div.tree-kids');
      for (const c of it.items || []) {
        const n = this.renderNode(c, depth + 1, false, q);
        if (n) kids.appendChild(n);
      }
      if (!(it.items || []).length) {
        kids.appendChild(
          h('div.tree-empty', { style: { paddingLeft: 30 + depth * 14 + 'px' } },
            isCollection ? '이 컬렉션은 비어 있습니다. ' : '이 폴더는 비어 있습니다. ',
            h('button.link-btn', { onclick: () => app.addRequestTo(it.id) }, '요청 추가'))
        );
      }
      wrap.appendChild(kids);
    }
    return wrap;
  }

  itemMenu(it, isCollection, anchor) {
    const items = [];
    if (it.type === 'request') {
      items.push({ label: '열기', icon: 'file', onClick: () => app.openItem(it.id) });
      items.push({ label: '새 탭에서 열기', icon: 'plus', onClick: () => app.openItem(it.id, { newTab: true }) });
      items.push({ label: 'cURL로 복사', icon: 'terminal', onClick: () => app.ui.copyItemAsCurl(it.id) });
      items.push({ divider: true });
    } else {
      items.push({ label: '요청 추가', icon: 'filePlus', onClick: () => app.addRequestTo(it.id) });
      items.push({
        label: '폴더 추가',
        icon: 'folderPlus',
        onClick: () => {
          const f = app.addFolderTo(it.id);
          this.renaming = f.id;
          this.renderBody();
        },
      });
      items.push({ label: isCollection ? '컬렉션 설정 (인증/변수)' : '폴더 설정 (인증)', icon: 'settings', onClick: () => app.openItem(it.id) });
      items.push({ divider: true });
    }
    items.push({ label: '이름 변경', icon: 'edit', hint: 'F2', onClick: () => { this.renaming = it.id; this.renderBody(); } });
    items.push({ label: '복제', icon: 'duplicate', onClick: () => { app.duplicateItem(it.id); this.renderBody(); } });
    if (isCollection) items.push({ label: '내보내기 (Postman v2.1)', icon: 'download', onClick: () => app.exportCollection(it.id) });
    items.push({ divider: true });
    items.push({ label: '삭제', icon: 'trash', danger: true, hint: 'Del', onClick: () => this.confirmDelete(it, isCollection) });
    openMenu(anchor, items, { alignRight: !!anchor.getBoundingClientRect });
  }

  async confirmDelete(it, isCollection) {
    const kind = isCollection ? '컬렉션' : it.type === 'folder' ? '폴더' : '요청';
    const extra = it.items && it.items.length ? ` (포함된 요청 ${countRequests(it.items)}개도 함께 삭제됩니다)` : '';
    if (await confirmDialog({ title: `${kind} 삭제`, message: `"${it.name}" ${kind}을(를) 삭제할까요?${extra}`, okText: '삭제', danger: true })) {
      app.deleteItem(it.id);
      this.renderBody();
    }
  }

  bindDnd(row, it, isContainer) {
    row.addEventListener('dragstart', (e) => {
      this.dragId = it.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-cs-item', it.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragId = null;
      row.classList.remove('dragging');
      this.el.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    });
    const zone = (e) => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (isContainer) return y < 0.25 ? 'before' : y > 0.75 && !app.state.workspace.expanded[it.id] ? 'after' : 'inside';
      return y < 0.5 ? 'before' : 'after';
    };
    row.addEventListener('dragover', (e) => {
      if (!this.dragId || this.dragId === it.id) return;
      e.preventDefault();
      const z = zone(e);
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      row.classList.add('drop-' + z);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const z = zone(e);
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      if (this.dragId && app.moveItem(this.dragId, it.id, z)) this.renderBody();
      this.dragId = null;
    });
  }

  markActive() {
    const tab = app.activeTab();
    const activeId = tab ? (tab.type === 'request' ? tab.itemId : tab.type === 'collection' ? tab.refId : null) : null;
    this.el.querySelectorAll('.tree-row.active').forEach((x) => x.classList.remove('active'));
    if (activeId) {
      const row = this.el.querySelector(`.tree-row[data-id="${CSS.escape(activeId)}"]`);
      if (row) row.classList.add('active');
    }
    this.el.querySelectorAll('.env-row').forEach((x) => {
      x.classList.toggle('active', !!tab && tab.type === 'environment' && tab.refId === x.dataset.id);
    });
  }

  /* ---------------- Environments ---------------- */
  renderEnvironments() {
    const q = this.query.trim().toLowerCase();
    const list = h('div.env-list');
    const envRow = (id, name, isGlobal) => {
      const active = app.state.activeEnvId === id;
      const row = h('div.env-row' + (active ? '.env-on' : ''), { dataset: { id }, tabindex: '0' },
        isGlobal ? icon('globe', 15, 'tree-ic') : h('button.env-check' + (active ? '.on' : ''), {
          title: active ? '활성 환경 (클릭하여 해제)' : '활성 환경으로 설정',
          onclick: (e) => {
            e.stopPropagation();
            app.setActiveEnv(active ? null : id);
            this.renderBody();
          },
        }, active ? icon('check', 13) : null),
        h('span.tree-name', name),
        !isGlobal ? h('span.tree-count', String((app.state.environments.find((x) => x.id === id)?.variables || []).length)) : null);
      if (!isGlobal) {
        const more = h('button.icon-btn.tree-more', { title: '더 보기' }, icon('more', 15));
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          this.envMenu(id, name, more);
        });
        row.appendChild(more);
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.envMenu(id, name, { x: e.clientX, y: e.clientY });
        });
      }
      row.addEventListener('click', () => app.openEnvironment(id));
      row.addEventListener('keydown', (e) => e.key === 'Enter' && app.openEnvironment(id));
      return row;
    };
    if (!q || 'globals'.includes(q)) list.appendChild(envRow('globals', 'Globals', true));
    list.appendChild(h('div.env-div'));
    const envs = app.state.environments.filter((e) => !q || e.name.toLowerCase().includes(q));
    envs.forEach((e) => list.appendChild(envRow(e.id, e.name, false)));
    if (!app.state.environments.length) {
      list.appendChild(
        h('div.sb-empty.small',
          h('div.sb-empty-sub', '환경을 만들어 dev / staging / prod 등 서버별 변수를 전환해 보세요.'),
          h('button.btn.btn-primary', { onclick: () => this.onPlus() }, icon('plus', 14), '환경 만들기'))
      );
    }
    this.bodyEl.appendChild(list);
    this.markActive();
  }

  envMenu(id, name, anchor) {
    const active = app.state.activeEnvId === id;
    openMenu(anchor, [
      { label: active ? '비활성화' : '활성 환경으로 설정', icon: 'bolt', onClick: () => { app.setActiveEnv(active ? null : id); this.renderBody(); } },
      {
        label: '이름 변경',
        icon: 'edit',
        onClick: async () => {
          const v = await promptDialog({ title: '환경 이름 변경', value: name });
          if (v) {
            const env = app.state.environments.find((e) => e.id === id);
            env.name = v;
            app.tabs.forEach((t) => { if (t.type === 'environment' && t.refId === id) t.name = v; });
            app.store.changed('environments');
            app.ui.renderTabs();
            app.ui.renderEnvSelector();
            app.ui.refreshView && app.tabs.forEach((t) => t.refId === id && app.ui.refreshView(t));
            this.renderBody();
          }
        },
      },
      { label: '복제', icon: 'duplicate', onClick: () => { app.duplicateEnvironment(id); this.renderBody(); } },
      { label: '내보내기 (Postman)', icon: 'download', onClick: () => app.exportEnvironment(id) },
      { divider: true },
      {
        label: '삭제',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (await confirmDialog({ title: '환경 삭제', message: `"${name}" 환경을 삭제할까요?`, okText: '삭제', danger: true })) {
            app.deleteEnvironment(id);
            this.renderBody();
          }
        },
      },
    ], { alignRight: !!anchor.getBoundingClientRect });
  }

  /* ---------------- History ---------------- */
  renderHistory() {
    const q = this.query.trim().toLowerCase();
    const hist = app.state.history.filter((e) => !q || e.request.url.toLowerCase().includes(q) || e.request.method.toLowerCase() === q || (e.name || '').toLowerCase().includes(q));
    if (!hist.length) {
      this.bodyEl.appendChild(
        h('div.sb-empty', icon('history', 36), h('div.sb-empty-title', q ? '검색 결과가 없습니다' : '아직 보낸 요청이 없습니다'),
          h('div.sb-empty-sub', '보낸 요청은 여기에 자동으로 기록됩니다.'))
      );
      return;
    }
    let lastDay = null;
    let group = null;
    for (const e of hist) {
      const day = relativeDayLabel(e.ts);
      if (day !== lastDay) {
        lastDay = day;
        group = h('div.hist-group', h('div.hist-day', day));
        this.bodyEl.appendChild(group);
      }
      const row = h('div.hist-row', { tabindex: '0', title: `${e.request.method} ${e.request.url}\n${timeLabel(e.ts)}` },
        h('span.tree-method.' + methodClass(e.request.method), methodShort(e.request.method)),
        h('span.hist-url', e.name ? h('span.hist-name', e.name) : null, h('span', e.request.url)),
        h('span.hist-status.' + statusClass(e.status), e.status ? String(e.status) : 'ERR'));
      const more = h('button.icon-btn.tree-more', { title: '더 보기' }, icon('more', 15));
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.historyMenu(e, more);
      });
      row.appendChild(more);
      row.addEventListener('click', () => app.openHistory(e));
      row.addEventListener('keydown', (ev) => ev.key === 'Enter' && app.openHistory(e));
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.historyMenu(e, { x: ev.clientX, y: ev.clientY });
      });
      group.appendChild(row);
    }
  }

  historyMenu(e, anchor) {
    openMenu(anchor, [
      { label: '새 탭에서 열기', icon: 'plus', onClick: () => app.openHistory(e) },
      {
        label: '컬렉션에 저장…',
        icon: 'save',
        onClick: async () => {
          const tab = app.openHistory(e);
          await app.saveTab(tab, { saveAs: true });
        },
      },
      { label: 'cURL로 복사', icon: 'terminal', onClick: () => app.ui.copyRequestAsCurl(e.request) },
      { divider: true },
      {
        label: '삭제',
        icon: 'trash',
        danger: true,
        onClick: () => {
          app.state.history = app.state.history.filter((x) => x.id !== e.id);
          app.store.changed('history');
          this.renderBody();
        },
      },
    ], { alignRight: !!anchor.getBoundingClientRect });
  }
}

export { formatMs, toast };
