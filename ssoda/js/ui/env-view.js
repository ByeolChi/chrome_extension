// 환경 변수 편집 탭
import { h, clear, debounce } from '../util.js';
import { KVTable } from './kvtable.js';
import { icon } from './icons.js';
import { openMenu, confirmDialog, toast } from './overlay.js';
import { app, SSH_SECRET_TTL_MS } from '../app.js';
import { normalizeSsh } from '../model.js';

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
    if (!this.isGlobals) {
      this.el.insertBefore(this.insecureSection(env), this.el.lastChild);
      this.el.insertBefore(this.sshSection(env), this.el.lastChild);
    }
  }

  /* ---------------- SSL 인증서 검증 무시 ---------------- */
  insecureSection(env) {
    const sw = h('input.switch', { type: 'checkbox', checked: !!env.insecure, 'aria-label': 'SSL 인증서 검증 무시' });
    sw.addEventListener('change', () => {
      env.insecure = sw.checked;
      app.store.changed('environments');
      app.ui.refreshEngines && app.ui.refreshEngines();
      if (sw.checked) app.ui.ensureCurlHelper && app.ui.ensureCurlHelper();
    });
    return h('div.ssh-sec' + (env.insecure ? '.on' : ''),
      h('label.ssh-head', sw,
        h('span.ssh-title', icon('alert', 14), 'SSL 인증서 검증 무시 (-k)'),
        h('span.muted', env.insecure
          ? '이 환경의 모든 요청이 인증서 검증 없이 PC의 curl 로 실행됩니다'
          : '켜면 자체 서명·만료 인증서 서버도 호출할 수 있습니다 (cURL 로 실행됨). 테스트 서버에만 사용하세요.')));
  }

  /* ---------------- SSH 터널 ---------------- */
  sshSection(env) {
    env.ssh = normalizeSsh(env.ssh);
    const s = env.ssh;
    const changed = () => {
      app.store.changed('environments');
      app.ui.refreshEngines && app.ui.refreshEngines();
    };
    const sec = h('div.ssh-sec' + (s.enabled ? '.on' : ''));
    const sw = h('input.switch', { type: 'checkbox', checked: s.enabled, 'aria-label': 'SSH 터널 사용' });
    sw.addEventListener('change', () => {
      s.enabled = sw.checked;
      changed();
      this.build();
    });
    sec.appendChild(h('label.ssh-head', sw,
      h('span.ssh-title', icon('lock', 14), 'SSH 터널'),
      h('span.muted', s.enabled ? '이 환경의 요청은 SSH 서버를 거쳐 cURL 로 실행됩니다' : '켜면 이 환경의 요청이 SSH 서버를 거쳐 실행됩니다')));
    if (!s.enabled) return sec;

    const field = (label, input, cls = '') => h('label.field.ssh-field' + cls, h('span.field-label', label), input);
    const text = (key, placeholder, attrs = {}) => {
      const el = h('input.input', { value: String(s[key] ?? ''), placeholder, spellcheck: 'false', autocomplete: 'off', ...attrs });
      el.addEventListener('input', () => {
        s[key] = key === 'port' ? parseInt(el.value, 10) || 22 : el.value.trim();
        changed();
      });
      return el;
    };
    // 비밀번호는 저장하지 않는다. 입력하면 이 탭의 메모리에만 두고, 오래 쓰지 않으면 지운다.
    const pw = h('input.input', {
      type: 'password',
      value: (app.sshSecret(env) || {}).password || '',
      placeholder: '저장되지 않음 · 보낼 때 물어봄',
      autocomplete: 'new-password',
    });
    const memo = h('div.ssh-memo');
    const renderMemo = () => {
      clear(memo);
      const hit = app.sshSecret(env);
      const mins = Math.round(SSH_SECRET_TTL_MS / 60000);
      if (hit) {
        memo.append(icon('lock', 12), `비밀번호는 디스크에 저장하지 않고 이 탭의 메모리에만 기억 중입니다 (${mins}분 동안 쓰지 않거나 탭을 닫으면 지워짐). `,
          h('button.link-btn', { type: 'button', onclick: () => { app.forgetSshSecret(env.id); pw.value = ''; renderMemo(); } }, '지금 지우기'));
      } else {
        memo.append(icon('lock', 12), `비밀번호는 저장하지 않습니다. 처음 보낼 때 묻고, 이 탭의 메모리에만 ${mins}분까지 기억합니다.`);
      }
    };
    pw.addEventListener('input', () => {
      if (pw.value) app.rememberSshSecret(env, pw.value);
      else app.forgetSshSecret(env.id);
      renderMemo();
    });
    const eye = h('button.icon-btn', { title: '비밀번호 보기', type: 'button' }, icon('eye', 15));
    eye.addEventListener('click', (e) => {
      e.preventDefault();
      pw.type = pw.type === 'password' ? 'text' : 'password';
    });
    renderMemo();

    const legacy = h('input.cb', { type: 'checkbox', checked: !!s.legacy });
    legacy.addEventListener('change', () => {
      s.legacy = legacy.checked;
      changed();
    });
    const status = h('div.ssh-status');
    const setStatus = (cls, ...children) => {
      status.className = 'ssh-status ' + cls;
      clear(status);
      status.append(...children.filter((c) => c != null));
    };
    // 도우미가 없거나 오래된 경우에는 바로 설치할 수 있게 버튼을 같이 보여 준다
    const HELPER_CODES = ['NO_HOST', 'HOST_FORBIDDEN', 'HOST_EXITED', 'HOST_ERROR', 'NO_NATIVE', 'HOST_OUTDATED', 'TIMEOUT'];
    const failed = (e) => {
      const helper = HELPER_CODES.includes(e.code);
      const legacyBtn = e.code === 'SSH_LEGACY' && !s.legacy
        ? h('button.btn.btn-sm', { type: 'button', onclick: () => { s.legacy = true; changed(); legacy.checked = true; testBtn.click(); } }, '구형 서버 호환 켜고 다시 테스트')
        : null;
      setStatus('bad', icon('alert', 13), e.message,
        e.hint ? h('div.muted', e.hint) : null,
        helper ? h('div', h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => app.ui.openCurlHelper() }, icon('download', 13), '도우미 설치 / 확인')) : null,
        legacyBtn ? h('div', legacyBtn) : null);
    };
    const testBtn = h('button.btn.btn-sm', { type: 'button' }, icon('bolt', 13), '연결 테스트');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      setStatus('checking', '연결 중…');
      try {
        const r = await app.testSshFor(env);
        pw.value = (app.sshSecret(env) || {}).password || '';
        renderMemo();
        if (!r) setStatus('', '');
        else if (r.ok) {
          setStatus('ok', icon('check', 13), `연결 성공 (${(r.connectMs / 1000).toFixed(1)}초)`,
            r.fingerprint ? h('div.ssh-fp', '서버 지문: ' + r.fingerprint.split(/\r?\n/)[0]) : null);
        } else failed(r);
      } catch (e) {
        failed(e);
      } finally {
        testBtn.disabled = false;
      }
    });
    const forgetBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button', title: '서버를 재설치해 호스트 키가 바뀐 경우에 사용' }, icon('refresh', 13), '호스트 키 초기화');
    forgetBtn.addEventListener('click', async () => {
      if (!s.host) return toast('서버 주소를 먼저 입력하세요.', 'error');
      const ok = await confirmDialog({
        title: '호스트 키 초기화',
        message: `${s.host}:${s.port} 의 저장된 호스트 키를 지웁니다. 다음 접속 때 서버 지문을 다시 확인합니다. 서버 키가 바뀐 이유를 알고 있을 때만 진행하세요.`,
        okText: '초기화',
        danger: true,
      });
      if (!ok) return;
      try {
        const n = await app.forgetSshHostFor(env);
        toast(n ? '저장된 호스트 키를 지웠습니다.' : '저장된 호스트 키가 없습니다.', 'success');
      } catch (e) {
        toast(e.message, 'error', 4000);
      }
    });

    sec.append(
      h('div.ssh-grid',
        field('SSH 서버 주소', text('host', '예) 10.10.1.20')),
        field('포트', text('port', '22', { inputmode: 'numeric' }), '.ssh-port'),
        field('사용자', text('user', '예) deploy')),
        field('비밀번호', h('div.ssh-pw', pw, eye))),
      memo,
      h('label.check.ssh-legacy', legacy, h('span', '구형 서버 호환 (ssh-rsa)'),
        h('span.muted', '오래된 서버가 "no matching host key type found" 로 접속을 거부할 때만 켜세요. SHA-1 기반이라 보안이 약합니다.')),
      h('div.ssh-actions', testBtn, forgetBtn),
      status,
      h('div.ssh-help', icon('info', 13),
        h('span', 'URL·헤더·Body 는 SSH 서버에서 보내는 것처럼 동작합니다. 아래 변수에 SSH 서버 기준 주소를 넣어 두고 ',
          h('code', '{{baseUrl}}/api/...'), ' 처럼 쓰세요. 예) ', h('code', 'baseUrl = http://10.0.0.5:8080'), ' · 서버 자신은 ', h('code', 'http://localhost:8080'))));
    return sec;
  }

  refresh() {
    this.build();
  }
}
