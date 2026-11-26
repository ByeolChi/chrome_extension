// 오른쪽 코드 스니펫 패널
import { h, clear, debounce, copyText } from '../util.js';
import { CODEGEN_LANGS, generateCode } from '../codegen.js';
import { curlOptsOf } from '../curl-runner.js';
import { codeView } from './code-editor.js';
import { icon } from './icons.js';
import { toast } from './overlay.js';
import { app } from '../app.js';

export class CodePanel {
  constructor(el) {
    this.el = el;
    this.code = '';
    this.showSecrets = false; // 비밀 변수의 값을 코드에 넣을지 (기억하지 않는다 — 창을 다시 열면 꺼짐)
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
    // 비밀 변수는 기본으로 {{이름}} 으로 보인다. 켜면 값까지 넣는다 (그대로 실행할 명령이 필요할 때)
    const secretCb = h('input.cb', { type: 'checkbox', checked: this.showSecrets });
    secretCb.addEventListener('change', () => {
      this.showSecrets = secretCb.checked;
      this.render();
    });
    let usesSecrets = false;
    const content = h('div.cp-content');
    let note = null;
    if (!tab || tab.type !== 'request') {
      content.appendChild(h('div.muted.pad', '요청 탭을 선택하면 코드가 표시됩니다.'));
      this.code = '';
    } else {
      try {
        const p = await app.buildPrepared(tab, { engine: langId.startsWith('curl') ? 'curl' : 'browser', mask: !this.showSecrets });
        this.code = generateCode(langId, p, { curl: curlOptsOf(tab.draft) });
        const scope = app.getScope(tab, { mask: true });
        usesSecrets = [...scope.entries()].some(([k, e]) => e.secret && this.code.includes(`{{${k}}}`)) || (this.showSecrets && [...scope.values()].some((e) => e.secret));
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
      h('div.cp-tools', sel, usesSecrets ? h('label.cp-secret', { title: '켜면 비밀 변수의 실제 값을 코드에 넣습니다. 복사해 붙여 넣을 곳을 확인하세요.' }, secretCb, '비밀 값 넣기') : null, copyBtn),
      content,
      note,
      h('div.cp-note', usesSecrets && !this.showSecrets
        ? '변수·인증·쿠키가 현재 설정 기준으로 적용된 코드입니다. 비밀 변수는 값 대신 {{이름}} 으로 보입니다.'
        : '변수·인증·쿠키가 현재 설정 기준으로 적용된 코드입니다.'),
    ].filter(Boolean));
  }
}
