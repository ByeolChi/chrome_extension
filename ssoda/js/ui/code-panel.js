// 오른쪽 코드 스니펫 패널
import { h, clear, debounce, copyText } from '../util.js';
import { CODEGEN_LANGS, generateCode } from '../codegen.js';
import { codeView } from './code-editor.js';
import { icon } from './icons.js';
import { toast } from './overlay.js';
import { app } from '../app.js';

export class CodePanel {
  constructor(el) {
    this.el = el;
    this.code = '';
    this.update = debounce(() => this.render(), 250);
  }

  get open() {
    return app.state.workspace.rightPanel === 'code';
  }

  async render() {
    if (!this.open) {
      this.el.classList.add('hidden');
      return;
    }
    this.el.classList.remove('hidden');
    const tab = app.activeTab();
    const langId = app.state.workspace.codeLang || 'curl';
    const sel = h('select.select.select-sm', CODEGEN_LANGS.map((l) => h('option', { value: l.id, selected: l.id === langId }, l.label)));
    sel.addEventListener('change', () => {
      app.state.workspace.codeLang = sel.value;
      app.saveWorkspace();
      this.render();
    });
    const copyBtn = h('button.icon-btn', { title: '복사', onclick: () => copyText(this.code).then((ok) => toast(ok ? '코드를 복사했습니다.' : '복사 실패', ok ? 'success' : 'error')) }, icon('copy', 16));
    const content = h('div.cp-content');
    let note = null;
    if (!tab || tab.type !== 'request') {
      content.appendChild(h('div.muted.pad', '요청 탭을 선택하면 코드가 표시됩니다.'));
      this.code = '';
    } else {
      try {
        const p = await app.buildPrepared(tab, { engine: langId.startsWith('curl') ? 'curl' : 'browser' });
        this.code = generateCode(langId, p, { curl: app.curlOptsFor(tab) });
        const lang = (CODEGEN_LANGS.find((l) => l.id === langId) || {}).lang || 'text';
        content.appendChild(codeView(this.code, lang, { wrap: false, lineNumbers: true }));
        if (p.unresolved.length) note = h('div.cp-note.warn', icon('alert', 13), `정의되지 않은 변수: ${p.unresolved.join(', ')}`);
      } catch (e) {
        content.appendChild(h('div.muted.pad', '코드를 생성할 수 없습니다: ' + e.message));
      }
    }
    clear(this.el);
    this.el.append(...[
      h('div.cp-head', h('div.cp-title', icon('code', 16), 'Code snippet'),
        h('button.icon-btn', { title: '닫기', onclick: () => app.ui.toggleCodePanel(false) }, icon('x', 16))),
      h('div.cp-tools', sel, copyBtn),
      content,
      note,
      h('div.cp-note', '변수·인증·쿠키가 현재 설정 기준으로 적용된 코드입니다.'),
    ].filter(Boolean));
  }
}
