// 환경 변수 편집 탭
import { h, clear, debounce } from '../util.js';
import { KVTable } from './kvtable.js';
import { icon } from './icons.js';
import { openMenu, confirmDialog } from './overlay.js';
import { app } from '../app.js';

export class EnvironmentView {
  constructor(tab) {
    this.tab = tab;
    this.el = h('div.ev');
    this._save = debounce(() => {
      app.store.changed(this.isGlobals ? 'globals' : 'environments');
      app.ui.refreshVars && app.ui.refreshVars();
    }, 250);
    this.build();
  }

  get isGlobals() {
    return this.tab.refId === 'globals';
  }

  get env() {
    if (this.isGlobals) return app.state.globals;
    return app.state.environments.find((e) => e.id === this.tab.refId);
  }

  build() {
    clear(this.el);
    const env = this.env;
    if (!env) {
      this.el.appendChild(h('div.pane-empty', '환경을 찾을 수 없습니다.'));
      return;
    }
    const isActive = app.state.activeEnvId === this.tab.refId;
    const nameEl = this.isGlobals
      ? h('div.ev-name', icon('globe', 18), 'Globals')
      : h('input.ev-name-input', { value: env.name, spellcheck: 'false', 'aria-label': '환경 이름' });
    if (!this.isGlobals) {
      nameEl.addEventListener('change', () => {
        const v = nameEl.value.trim();
        if (!v) return;
        env.name = v;
        this.tab.name = v;
        app.store.changed('environments');
        app.ui.renderTabs();
        app.ui.renderEnvSelector && app.ui.renderEnvSelector();
      });
    }
    const actions = h('div.ev-actions');
    if (!this.isGlobals) {
      actions.appendChild(
        h('button.btn' + (isActive ? '.btn-active' : ''), {
          onclick: () => {
            app.setActiveEnv(isActive ? null : env.id);
            this.build();
          },
        }, icon(isActive ? 'check' : 'bolt', 14), isActive ? '활성 환경' : '활성화')
      );
      const more = h('button.icon-btn', { title: '더 보기' }, icon('more', 16));
      more.addEventListener('click', () =>
        openMenu(more, [
          { label: '복제', icon: 'duplicate', onClick: () => app.duplicateEnvironment(env.id) },
          { label: '내보내기 (Postman)', icon: 'download', onClick: () => app.exportEnvironment(env.id) },
          { divider: true },
          {
            label: '삭제',
            icon: 'trash',
            danger: true,
            onClick: async () => {
              if (await confirmDialog({ title: '환경 삭제', message: `"${env.name}" 환경을 삭제할까요?`, okText: '삭제', danger: true })) app.deleteEnvironment(env.id);
            },
          },
        ], { alignRight: true })
      );
      actions.appendChild(more);
    } else {
      actions.appendChild(h('button.btn', { onclick: () => app.exportEnvironment('globals') }, icon('download', 14), '내보내기'));
    }
    const table = new KVTable({
      rows: () => env.variables,
      keyPlaceholder: '변수 이름',
      valuePlaceholder: '값',
      description: false,
      onChange: () => this._save(),
    });
    this.el.append(
      h('div.ev-head', nameEl, actions),
      h('div.ev-info', icon('info', 14),
        this.isGlobals
          ? '글로벌 변수는 모든 요청에서 사용됩니다. 우선순위: 환경 > 컬렉션 > 글로벌'
          : '이 환경이 활성화되면 {{변수명}} 으로 URL·헤더·Body·인증에서 사용할 수 있습니다.'),
      h('div.ev-table', table.el)
    );
  }

  refresh() {
    this.build();
  }
}
