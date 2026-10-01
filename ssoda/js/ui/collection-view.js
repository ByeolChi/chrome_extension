// 컬렉션 / 폴더 설정 탭 (개요, 인증, 변수)
import { h, clear, debounce } from '../util.js';
import { findInCollections, countRequests, newAuth } from '../model.js';
import { KVTable } from './kvtable.js';
import { authEditor, authLabel } from './auth-editor.js';
import { icon } from './icons.js';
import { app } from '../app.js';

export class CollectionView {
  constructor(tab) {
    this.tab = tab;
    this.sub = tab.sub || 'overview';
    this.el = h('div.cv-view');
    this._save = debounce(() => {
      app.store.changed('collections');
      app.ui.refreshVars && app.ui.refreshVars();
    }, 250);
    this.build();
  }

  get hit() {
    return findInCollections(app.state.collections, this.tab.refId);
  }

  build() {
    clear(this.el);
    const hit = this.hit;
    if (!hit) {
      this.el.appendChild(h('div.pane-empty', '항목을 찾을 수 없습니다.'));
      return;
    }
    const item = hit.item;
    const isCollection = !hit.parent;
    if (!item.auth) item.auth = newAuth(isCollection ? 'none' : 'inherit');
    const nameIn = h('input.ev-name-input', { value: item.name, spellcheck: 'false', 'aria-label': '이름' });
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.trim();
      if (v) app.renameItem(item.id, v);
      app.ui.renderSidebar();
    });
    const subs = [['overview', '개요'], ['auth', 'Authorization']];
    if (isCollection) subs.push(['variables', 'Variables']);
    const subtabs = h('div.subtabs', subs.map(([id, label]) =>
      h('button.subtab' + (this.sub === id ? '.active' : ''), { onclick: () => { this.sub = id; this.tab.sub = id; app.saveWorkspace(); this.build(); } },
        label,
        id === 'variables' && item.variables && item.variables.length ? h('span.count', `(${item.variables.length})`) : null)));
    const pane = h('div.cv-pane');
    if (this.sub === 'overview') {
      const desc = h('textarea.input.desc-ta.big', { placeholder: '컬렉션/폴더에 대한 설명을 입력하세요 (API 문서, 사용법 등)', spellcheck: 'false' });
      desc.value = item.description || '';
      desc.addEventListener('input', () => {
        item.description = desc.value;
        this._save();
      });
      const reqCount = countRequests(item.items);
      pane.append(
        h('div.cv-stats',
          h('div.stat', h('div.stat-v', String(reqCount)), h('div.stat-k', '요청')),
          h('div.stat', h('div.stat-v', String((item.items || []).filter((x) => x.type === 'folder').length)), h('div.stat-k', '하위 폴더')),
          h('div.stat', h('div.stat-v', authLabel(item.auth.type)), h('div.stat-k', '인증'))),
        h('div.field-label', '설명'),
        desc,
        h('div.cv-actions',
          h('button.btn', { onclick: () => app.addRequestTo(item.id) }, icon('filePlus', 14), '요청 추가'),
          h('button.btn', { onclick: () => { app.addFolderTo(item.id); app.ui.renderSidebar(); } }, icon('folderPlus', 14), '폴더 추가'),
          isCollection ? h('button.btn', { onclick: () => app.exportCollection(item.id) }, icon('download', 14), 'Postman 형식으로 내보내기') : null)
      );
    } else if (this.sub === 'auth') {
      const ed = authEditor(item.auth, {
        getScope: () => app.getScope({ type: 'collection', refId: hit.collection.id }),
        allowInherit: !isCollection,
        inheritInfo: () => {
          const inh = app.getInheritedAuth(item.id);
          return inh ? { label: authLabel(inh.auth.type), from: inh.from.name } : null;
        },
        onChange: () => this._save(),
      });
      pane.append(
        h('div.ev-info', icon('info', 14), `이 ${isCollection ? '컬렉션' : '폴더'}의 요청 중 인증이 "Inherit auth from parent"인 요청에 적용됩니다.`),
        ed.el
      );
    } else if (this.sub === 'variables') {
      if (!item.variables) item.variables = [];
      const table = new KVTable({
        getScope: () => app.getScope({ type: 'collection', refId: hit.collection.id }),
        rows: () => item.variables,
        keyPlaceholder: '변수 이름',
        valuePlaceholder: '값',
        description: false,
        onChange: () => this._save(),
      });
      pane.append(h('div.ev-info', icon('info', 14), '컬렉션 변수는 이 컬렉션의 요청에서만 사용됩니다. 같은 이름의 환경 변수가 있으면 환경 변수가 우선합니다.'), table.el);
    }
    this.el.append(
      h('div.ev-head', h('div.cv-kind', icon(isCollection ? 'collections' : 'folder', 18)), nameIn),
      subtabs,
      pane
    );
  }

  refresh() {
    this.build();
  }
}
