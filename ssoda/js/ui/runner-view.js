// 컬렉션 러너 화면 (탭): 실행할 요청 고르기, 반복·데이터 파일·요청 사이 대기·실패하면 멈춤, 진행, 결과, 보고서 내보내기
// 저장된 요청을 실행한다 (열린 탭에서 고치고 저장하지 않은 내용은 쓰지 않음). 실행 결과는 히스토리에 남기지 않는다.
import { h, clear, formatMs, methodClass, methodShort, statusClass, download, readFileAsText } from '../util.js';
import { icon } from './icons.js';
import { toast } from './overlay.js';
import { findInCollections, normalizeRequest } from '../model.js';
import { countTests } from '../checks.js';
import { collectRequests, parseDataFile, runAll, summarize, toJUnit, toHtml } from '../runner.js';
import { app } from '../app.js';

const MAX_ITERATIONS = 1000;

export class RunnerView {
  constructor(tab) {
    this.tab = tab;
    if (!tab.runner) tab.runner = { skip: [], iterations: 1, delayMs: 0, stopOnFailure: false };
    this.el = h('div.runner');
    this.data = null; // { name, kind, columns, rows } — 파일 내용은 저장하지 않음
    this.report = null;
    this.running = false;
    this.ctrl = null;
    this.build();
  }

  get hit() {
    return findInCollections(app.state.collections, this.tab.refId);
  }

  get opts() {
    return this.tab.runner;
  }

  destroy() {
    if (this.ctrl) this.ctrl.abort();
  }

  refresh() {
    if (!this.running) this.build();
  }

  save() {
    app.saveWorkspace();
  }

  build() {
    clear(this.el);
    const hit = this.hit;
    if (!hit) {
      this.el.appendChild(h('div.pane-empty', '실행할 컬렉션·폴더를 찾을 수 없습니다. 지워졌을 수 있습니다.'));
      return;
    }
    const isCollection = !hit.parent;
    const where = [...hit.path, isCollection ? null : hit.item.name].filter(Boolean).join(' / ') || hit.item.name;
    const env = app.activeEnv();
    this.el.append(
      h('div.ev-head.runner-head',
        h('div.cv-kind', icon('play', 18)),
        h('div.runner-title', h('div', '러너'), h('div.runner-where', where)),
        h('div.flex1'),
        h('span.runner-env', { title: '실행할 때 쓰는 환경 (오른쪽 위에서 바꿉니다)' }, icon('layers', 13), env ? env.name : '환경 선택 안 함')),
      h('div.runner-main', this.buildSide(hit), this.resultsEl = h('div.runner-results')));
    this.renderResults();
  }

  /* ---------------- 왼쪽: 실행 설정 ---------------- */
  buildSide(hit) {
    const o = this.opts;
    const items = collectRequests(hit.item);
    const picked = () => items.filter((x) => !o.skip.includes(x.id));
    const countEl = h('span.runner-count');
    const updateCount = () => { countEl.textContent = `${picked().length}/${items.length}`; };
    const list = h('div.runner-list', items.length ? items.map((it) => {
      const cb = h('input.cb', { type: 'checkbox', checked: !o.skip.includes(it.id), disabled: this.running, 'aria-label': it.name });
      cb.addEventListener('change', () => {
        o.skip = cb.checked ? o.skip.filter((id) => id !== it.id) : [...o.skip, it.id];
        updateCount();
        this.save();
      });
      const n = countTests(it.request.tests);
      return h('label.runner-item',
        cb,
        h('span.tree-method.' + methodClass(it.request.method), methodShort(it.request.method)),
        h('span.runner-item-name', it.name, it.path ? h('span.runner-item-path', it.path) : null),
        n ? h('span.runner-item-tests', { title: 'Tests 탭에 든 줄 수' }, `Tests ${n}`) : null);
    }) : h('div.tests-empty', '이 안에 요청이 없습니다.'));
    updateCount();
    const all = (on) => {
      o.skip = on ? [] : items.map((x) => x.id);
      this.save();
      this.build();
    };

    // 반복·데이터 파일
    const iter = h('input.input.input-sm.runner-num', { type: 'number', min: '1', max: String(MAX_ITERATIONS), value: this.data ? this.data.rows.length : o.iterations, disabled: this.running || !!this.data, 'aria-label': '반복 횟수' });
    iter.addEventListener('change', () => {
      o.iterations = Math.min(MAX_ITERATIONS, Math.max(1, parseInt(iter.value, 10) || 1));
      iter.value = o.iterations;
      this.save();
    });
    const fileIn = h('input', { type: 'file', accept: '.csv,.json,.tsv,.txt,text/csv,application/json', style: { display: 'none' } });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try {
        const d = parseDataFile(await readFileAsText(f), f.name);
        if (!d.rows.length) throw new Error('열 이름 아래에 데이터 행이 없습니다');
        if (d.rows.length > MAX_ITERATIONS) throw new Error(`행이 ${MAX_ITERATIONS}개를 넘습니다 (${d.rows.length}개)`);
        this.data = { name: f.name, ...d };
        this.build();
      } catch (e) {
        toast('데이터 파일을 읽지 못했습니다: ' + e.message, 'error', 5000);
      }
    });
    const dataBox = this.data
      ? h('div.runner-data',
        h('div.runner-data-name', icon('file', 13), this.data.name, h('button.icon-btn', { title: '데이터 파일 빼기', disabled: this.running, onclick: () => { this.data = null; this.build(); } }, icon('x', 13))),
        h('div.muted', `행 ${this.data.rows.length}개 · 변수: ${this.data.columns.map((c) => `{{${c}}}`).join(' ')}`))
      : h('button.btn.btn-sm', { disabled: this.running, onclick: () => fileIn.click() }, icon('upload', 13), 'CSV·JSON 파일 고르기');

    const delay = h('input.input.input-sm.runner-num', { type: 'number', min: '0', step: '100', value: o.delayMs || 0, disabled: this.running, 'aria-label': '요청 사이 대기 (ms)' });
    delay.addEventListener('change', () => {
      o.delayMs = Math.max(0, parseInt(delay.value, 10) || 0);
      delay.value = o.delayMs;
      this.save();
    });
    const stop = h('input.cb', { type: 'checkbox', checked: !!o.stopOnFailure, disabled: this.running });
    stop.addEventListener('change', () => {
      o.stopOnFailure = stop.checked;
      this.save();
    });
    const runBtn = this.running
      ? h('button.btn.runner-go', { onclick: () => this.ctrl && this.ctrl.abort() }, icon('stop', 14), '멈춤')
      : h('button.btn.btn-primary.runner-go', { onclick: () => this.run(picked()) }, icon('play', 14), '실행');

    return h('div.runner-side',
      h('div.kv-toolbar', h('div', h('span.kv-title', '실행할 요청 '), countEl),
        h('div.kv-tools', h('button.link-btn', { disabled: this.running, onclick: () => all(true) }, '모두'), h('button.link-btn', { disabled: this.running, onclick: () => all(false) }, '없음'))),
      list,
      h('div.runner-opts',
        h('div.set-row', h('div.set-label', h('div', '반복'), h('div.muted', this.data ? '데이터 파일의 행마다 한 번씩' : '요청 전체를 이만큼 되풀이')), iter),
        h('div.set-row.col', h('div.set-label', h('div', '데이터 파일'), h('div.muted', '행마다 반복하고, 열 이름이 변수가 됩니다 (환경 변수보다 앞)')), dataBox, fileIn),
        h('div.set-row', h('div.set-label', h('div', '요청 사이 대기 (ms)')), delay),
        h('label.set-row.runner-check', h('div.set-label', h('div', '실패하면 멈춤'), h('div.muted', '응답을 못 받거나 확인·꺼내기가 실패하면')), stop)),
      h('div.runner-note.muted', '저장된 요청을 차례로 보냅니다. 열린 탭에서 고치고 저장하지 않은 내용은 쓰지 않고, 히스토리에도 남기지 않습니다.'),
      runBtn);
  }

  /* ---------------- 실행 ---------------- */
  async run(items) {
    if (this.running) return;
    if (!items.length) return toast('실행할 요청을 고르세요.', 'error');
    const hit = this.hit;
    const env = app.activeEnv();
    let ssh = null;
    if (app.tunnelOf(env)) {
      ssh = await app.sshConfigFor(env); // 비밀번호를 처음 한 번만 묻는다
      if (!ssh) return;
    }
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    app.controllers.set(this.tab.id, ctrl); // 탭을 닫으면 멈춘다
    this.running = true;
    this.report = null;
    this.build();
    try {
      this.report = await runAll({
        name: [...hit.path, hit.parent ? hit.item.name : null].filter(Boolean).join(' / ') || hit.item.name,
        environment: env ? env.name : '',
        items,
        iterations: this.opts.iterations,
        rows: this.data ? this.data.rows : null,
        delayMs: this.opts.delayMs,
        stopOnFailure: this.opts.stopOnFailure,
        signal: ctrl.signal,
        exec: async (item, { row }) => {
          // 저장된 요청을 모양만 맞춰 쓴다 (예전 버전에서 저장해 빠진 칸이 있어도 보낼 수 있게)
          const draft = normalizeRequest(item.request);
          const tab = { type: 'request', itemId: item.id, draft };
          if (row) tab.dataVars = Object.entries(row).map(([key, value]) => ({ key, value, enabled: true }));
          const engine = ssh ? 'curl' : app.engineOf(tab);
          const result = await app.execute(tab, { engine, ssh, env, signal: ctrl.signal });
          if (countTests(draft.tests)) result.checks = app.runChecks(tab, draft.tests, result);
          return result;
        },
        onProgress: ({ report, run }) => {
          if (this.ctrl !== ctrl) return;
          this.report = report;
          this.appendRun(run);
          this.updateProgress();
        },
      });
    } finally {
      if (app.controllers.get(this.tab.id) === ctrl) app.controllers.delete(this.tab.id);
      this.ctrl = null;
      this.running = false;
      if (this.el.isConnected || app.views.get(this.tab.id) === this) this.build();
    }
    const S = summarize(this.report);
    toast(`러너: 요청 ${S.requests}개 · 실패 ${S.failed}개${this.report.stopped ? ' · 멈춤' : this.report.stoppedOnFailure ? ' · 실패해서 멈춤' : ''}`, S.failed ? 'error' : 'success', 4000);
    return this.report;
  }

  /* ---------------- 오른쪽: 진행·결과 ---------------- */
  renderResults() {
    const box = this.resultsEl;
    clear(box);
    this.groupEls = [];
    const r = this.report;
    if (!r && !this.running) {
      box.appendChild(h('div.body-empty', icon('play', 28), h('div', '실행하면 결과가 여기에 나옵니다.'),
        h('div.muted', '요청마다 상태 코드, 시간, Tests 탭의 확인 결과를 보여 줍니다.')));
      return;
    }
    this.progressEl = h('div.runner-progress', h('div.runner-bar', this.barEl = h('div.runner-bar-fill')), this.progressText = h('span.runner-progress-text'));
    this.summaryEl = h('div.runner-summary');
    const tools = h('div.runner-tools',
      h('button.btn.btn-sm', { disabled: this.running || !r || !r.runs.length, title: '혼자 열리는 HTML 파일', onclick: () => this.export('html') }, icon('download', 13), 'HTML 보고서'),
      h('button.btn.btn-sm', { disabled: this.running || !r || !r.runs.length, title: 'CI 가 읽는 JUnit XML', onclick: () => this.export('junit') }, icon('download', 13), 'JUnit XML'));
    this.listEl = h('div.runner-runs');
    box.append(h('div.runner-top', this.summaryEl, tools), this.progressEl, this.listEl);
    if (r) r.runs.forEach((run) => this.appendRun(run));
    this.updateProgress();
  }

  updateProgress() {
    const r = this.report;
    if (!this.summaryEl) return;
    const S = r ? summarize(r) : { requests: 0, failed: 0, errors: 0, asserts: 0, assertsPassed: 0, duration: 0 };
    const total = r ? r.total : 0;
    // Element.append 는 null 을 글자 "null" 로 붙이므로 빈 것은 뺀다
    clear(this.summaryEl).append(...[
      h('span', `요청 ${S.requests}${this.running && total ? '/' + total : ''}`),
      h('span' + (S.failed ? '.bad' : '.good'), `실패 ${S.failed}`),
      S.asserts ? h('span', `확인 ${S.assertsPassed}/${S.asserts} 통과`) : null,
      r ? h('span.muted', formatMs(S.duration)) : null,
      r && r.stopped ? h('span.bad', '멈춤') : null,
      r && r.stoppedOnFailure ? h('span.bad', '실패해서 멈춤') : null,
    ].filter(Boolean));
    const pct = total ? Math.round((S.requests / total) * 100) : this.running ? 0 : 100;
    this.barEl.style.width = pct + '%';
    this.barEl.classList.toggle('bad', !!S.failed);
    this.progressText.textContent = this.running ? `${S.requests} / ${total || '…'}` : r ? '끝' : '';
    this.progressEl.classList.toggle('done', !this.running);
  }

  appendRun(run) {
    if (!this.listEl) return;
    let group = this.groupEls[run.iteration];
    if (!group) {
      const r = this.report;
      const many = r && (r.iterations > 1 || r.dataColumns.length);
      group = h('div.runner-group');
      if (many) {
        const row = run.row ? Object.entries(run.row).slice(0, 6).map(([k, v]) => h('span.runner-chip', `${k}=${String(v).length > 24 ? String(v).slice(0, 24) + '…' : v}`)) : null;
        group.appendChild(h('div.runner-group-head', `반복 ${run.iteration + 1}`, row));
      }
      this.groupEls[run.iteration] = group;
      this.listEl.appendChild(group);
    }
    const passed = run.asserts.filter((a) => a.ok).length;
    const details = h('div.runner-detail');
    const row = h('div.runner-row' + (run.failed ? '.fail' : ''),
      h('span.ck-mark.' + (run.failed ? 'ck-fail' : 'ck-ok'), icon(run.failed ? 'x' : 'check', 14)),
      h('span.tree-method.' + methodClass(run.method), methodShort(run.method)),
      h('span.runner-row-name', run.item.name, run.item.path ? h('span.runner-item-path', run.item.path) : null),
      run.ok ? h('span.runner-status.' + statusClass(run.status), String(run.status)) : h('span.runner-status.s-err', '오류'),
      h('span.runner-time', formatMs(run.time)),
      h('span.runner-checks' + (run.asserts.length ? (passed === run.asserts.length ? '.ck-good' : '.ck-bad') : ''), run.asserts.length ? `${passed}/${run.asserts.length}` : '-'));
    const lines = [];
    if (!run.ok) lines.push(h('div.ck-sub.bad', run.error));
    run.captures.forEach((c) => lines.push(h('div.ck-sub', c.ok ? `${c.name} = ${c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value} → ${c.savedTo}` : `${c.name}: ${c.error}`, c.note ? h('span.ck-note', ' · ' + c.note) : null)));
    run.asserts.forEach((a) => lines.push(h('div.ck-sub' + (a.ok ? '' : '.bad'), (a.ok ? '✓ ' : '✗ ') + a.desc, a.ok ? '' : ` · 찾은 값: ${a.actual}${a.message ? ' · ' + a.message : ''}`)));
    if (lines.length) {
      details.append(...lines);
      row.classList.add('has-detail');
      row.title = '눌러서 자세히';
      row.addEventListener('click', () => row.classList.toggle('open'));
      if (run.failed) row.classList.add('open'); // 실패한 것은 펼쳐 둔다
    }
    row.appendChild(details);
    group.appendChild(row);
  }

  export(kind) {
    const r = this.report;
    if (!r || !r.runs.length) return;
    const d = new Date(r.startedAt);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const base = `ssoda-run-${String(r.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${stamp}`;
    if (kind === 'html') download(base + '.html', toHtml(r), 'text/html;charset=utf-8');
    else download(base + '.xml', toJUnit(r), 'application/xml;charset=utf-8');
  }
}
