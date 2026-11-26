// 환경 간 응답 비교 화면 (탭)
// 같은 요청을 고른 환경마다 한꺼번에 보내고, 기준 환경의 응답과 상태 코드·머리글·본문을 견준다.
// 응답은 이 탭의 메모리에만 두고 저장하지 않는다(히스토리에도 남기지 않음). 고른 환경·기준·뺄 곳만 탭에 저장한다.
import { h, clear, formatBytes, formatMs, methodClass, methodShort, statusClass, copyText, STATUS_TEXT } from '../util.js';
import { icon } from './icons.js';
import { toast, openModal, confirmDialog } from './overlay.js';
import { compareResults, makeIgnore, prettyJsonLines, sideBySide, lineHunks, showValue, ignorePathOf, DEFAULT_IGNORE_HEADERS } from '../compare.js';
import { responseContext } from '../checks.js';
import { redactSecrets, vault } from '../secrets.js';
import { app } from '../app.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SIDE_LIMIT = 4000; // 나란히 보기에서 한쪽에 펴는 줄 수
const LIST_LIMIT = 300; // 차이 목록에 보여 줄 줄 수 (본문)

const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const statusLine = (r) => `${r.status} ${r.statusText || STATUS_TEXT[r.status] || ''}`.trim();

export class CompareView {
  constructor(tab) {
    this.tab = tab;
    if (!tab.compare) tab.compare = { envIds: [], baseId: null, ignoreBody: '', ignoreHeaders: '' };
    this.el = h('div.compare');
    this.got = null; // 환경 id → { env, engine, ssh, unresolved, result } (마지막으로 보낸 것)
    this.pending = new Set(); // 보내는 중인 환경 id
    this.running = false;
    this.ctrl = null;
    this.engine = null;
    this.targetId = null; // 아래에서 기준과 견줄 환경
    this.mode = 'list'; // 'list' 차이 목록 | 'side' 나란히 보기
    this.build();
  }

  get opts() {
    return this.tab.compare;
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

  // 고른 환경 (기준이 맨 앞). 지워진 환경은 뺀다
  pickedEnvs() {
    const all = app.state.environments;
    const envs = all.filter((e) => this.opts.envIds.includes(e.id));
    const base = envs.find((e) => e.id === this.opts.baseId) || envs[0];
    return base ? [base, ...envs.filter((e) => e !== base)] : [];
  }

  // 고른 환경 순서(기준이 맨 앞)의 받은 응답. 아직 안 보냈으면 null, 받지 않은 환경은 null 칸.
  // 기준이나 고른 환경을 바꾸면 다시 보내지 않고 받은 응답끼리 다시 견준다
  get runs() {
    if (!this.got) return null;
    return this.pickedEnvs().map((e) => this.got.get(e.id) || null);
  }

  ignoreOpts() {
    return { ignoreBody: lines(this.opts.ignoreBody), ignoreHeaders: lines(this.opts.ignoreHeaders) };
  }

  /* ---------------- 그리기 ---------------- */
  build() {
    clear(this.el);
    const src = app.compareSource(this.tab);
    const d = src && src.draft;
    const where = d
      ? h('div.runner-where.cmp-where', { title: d.url || '' }, h('span.tree-method.' + methodClass(d.method), methodShort(d.method)), ' ', d.url || '(URL 없음)')
      : h('div.runner-where', '원래 요청을 찾을 수 없습니다');
    const runBtn = this.running
      ? h('button.btn.cmp-go', { onclick: () => this.ctrl && this.ctrl.abort() }, icon('stop', 14), '멈춤')
      : h('button.btn.btn-primary.cmp-go', { disabled: !src, onclick: () => this.run() }, icon('play', 14), this.runs ? '다시 보내기' : '보내기');
    const nIgnore = lines(this.opts.ignoreBody).length + lines(this.opts.ignoreHeaders).length;
    this.el.append(
      h('div.ev-head.runner-head.cmp-head',
        h('div.cv-kind', icon('compare', 18)),
        h('div.runner-title', h('div', '환경 비교'), where),
        h('div.flex1'),
        src ? h('span.cmp-src', { title: src.live ? '열린 요청 탭의 지금 내용(저장하지 않은 것 포함)으로 보냅니다' : '요청 탭이 닫혀 있어 저장된 요청으로 보냅니다' },
          src.live ? '요청 탭의 지금 내용' : '저장된 요청') : null,
        src && src.tab ? h('button.btn.btn-sm', { title: '요청 탭으로 가기', onclick: () => app.setActive(src.tab.id) }, icon('edit', 13), '요청 고치기') : null,
        h('button.btn.btn-sm', { title: '견주지 않을 본문 경로·머리글', onclick: () => this.editIgnore() }, icon('settings', 13), nIgnore ? `뺄 곳 ${nIgnore}` : '뺄 곳'),
        runBtn),
      this.envBar(),
      this.body = h('div.cmp-body'));
    this.renderBody();
  }

  // 환경 고르기: 칩을 눌러 넣고 빼고, 기준은 목록에서
  envBar() {
    const all = app.state.environments;
    if (all.length < 2) {
      return h('div.cmp-envs.cmp-envs-empty', icon('info', 14),
        h('span', '환경이 둘 이상 있어야 견줄 수 있습니다. 같은 요청을 보낼 환경(예: 개발·운영)을 만들고 변수에 서버 주소를 넣으세요.'),
        h('button.btn.btn-sm', { onclick: () => app.ui.newEnvironment() }, icon('plus', 13), '환경 만들기'));
    }
    const picked = this.pickedEnvs();
    const baseId = picked[0] ? picked[0].id : null;
    const chips = all.map((e) => {
      const on = this.opts.envIds.includes(e.id);
      const tunnel = app.tunnelOf(e);
      const chip = h('button.cmp-chip' + (on ? '.on' : '') + (e.id === baseId ? '.base' : ''), {
        disabled: this.running,
        'aria-pressed': on ? 'true' : 'false',
        title: (on ? '빼기' : '넣기') + (tunnel ? ` · SSH 터널 ${tunnel.user}@${tunnel.host}:${tunnel.port}` : ''),
        onclick: () => {
          this.opts.envIds = on ? this.opts.envIds.filter((id) => id !== e.id) : [...this.opts.envIds, e.id];
          if (on && this.opts.baseId === e.id) this.opts.baseId = null;
          this.save();
          this.build();
        },
      }, icon(on ? 'check' : 'plus', 12), e.name, tunnel ? h('span.cmp-ssh', { title: 'SSH 터널' }, icon('lock', 11), 'SSH') : null,
      e.id === baseId ? h('span.cmp-base-tag', '기준') : null);
      return chip;
    });
    const sel = h('select.select.select-sm', { disabled: this.running || picked.length < 1, 'aria-label': '기준 환경' },
      picked.map((e) => h('option', { value: e.id, selected: e.id === baseId }, e.name)));
    sel.addEventListener('change', () => {
      this.opts.baseId = sel.value;
      this.save();
      this.build();
    });
    return h('div.cmp-envs', h('span.cmp-envs-label', '보낼 환경'), h('div.cmp-chips', chips),
      h('label.cmp-base', '기준', sel));
  }

  renderBody() {
    const box = clear(this.body);
    if (!this.runs || !this.runs.length) {
      box.appendChild(h('div.body-empty', icon('compare', 28), h('div', '보내기를 누르면 고른 환경마다 이 요청을 한꺼번에 보내고, 기준 환경의 응답과 견줍니다.'),
        h('div.muted', '상태 코드, 응답 머리글, 본문(JSON 은 경로마다)을 견줍니다. 날짜·요청 ID 같은 머리글은 견주지 않고, 더 뺄 곳은 [뺄 곳]에서 정합니다.'),
        h('div.muted', '히스토리에는 남기지 않습니다. Tests 탭의 확인은 하지만, 꺼낸 값을 변수에 저장하지는 않습니다.')));
      return;
    }
    box.append(this.cards());
    if (this.engine) {
      box.append(h('div.cmp-engine.muted', icon(this.engine === 'curl' ? 'terminal' : 'globe', 12),
        this.engine === 'curl' ? 'PC의 cURL 로 보냈습니다' : '브라우저로 보냈습니다',
        this.forced ? ' · SSH 터널을 쓰는 환경이 있어 모든 환경을 같은 방식(cURL)으로 보냈습니다' : ''));
    }
    const runs = this.runs;
    const others = runs.slice(1);
    if (!others.length) return;
    if (!runs[0] && !this.running) {
      box.append(h('div.cmp-note', icon('info', 14), `기준 환경(${this.pickedEnvs()[0].name})의 응답이 없습니다. 다시 보내면 견줍니다.`));
      return;
    }
    const ready = runs[0] && others.some(Boolean);
    if (!ready) return;
    if (!others.some((x) => x && x.env.id === this.targetId)) {
      const firstDiff = others.find((x) => x && this.diffOf(x).count);
      this.targetId = (firstDiff || others.find(Boolean)).env.id;
    }
    box.append(this.detail());
  }

  // 기준과 견준 결과 (환경 하나)
  diffOf(run) {
    const base = this.runs[0];
    if (!base || !run) return null;
    if (!run._cmp || run._cmpKey !== this.cmpKey) {
      run._cmp = compareResults(base.result, run.result, this.ignoreOpts());
      run._cmpKey = this.cmpKey;
    }
    return run._cmp;
  }

  get cmpKey() {
    return `${this.opts.ignoreBody}\u0000${this.opts.ignoreHeaders}\u0000${this.runs && this.runs[0] ? this.runs[0].env.id : ''}`;
  }

  // 환경마다 한 장: 상태 코드·시간·크기·Tests·기준과 다른 곳 수
  cards() {
    const wrap = h('div.cmp-cards');
    const envs = this.pickedEnvs();
    this.runs.forEach((run, i) => {
      const env = envs[i];
      const card = h('div.cmp-card' + (i === 0 ? '.base' : '') + (run && i > 0 && run.env.id === this.targetId ? '.active' : ''));
      const head = h('div.cmp-card-head', h('span.cmp-card-name', env.name), i === 0 ? h('span.cmp-base-tag', '기준') : null,
        run && run.ssh ? h('span.cmp-ssh', { title: 'SSH 터널' }, icon('lock', 11), 'SSH') : null);
      card.appendChild(head);
      if (!run) {
        card.append(this.pending.has(env.id)
          ? h('div.cmp-card-wait', h('span.spinner'), '보내는 중…')
          : h('div.cmp-card-wait', '아직 보내지 않았습니다 (다시 보내면 나옵니다)'));
        wrap.appendChild(card);
        return;
      }
      const r = run.result;
      const url = redactSecrets(r.sentUrl || '', vault.secretValues());
      if (r.ok) {
        card.append(
          h('div.cmp-card-stat', h('span.status-pill.' + statusClass(r.status), statusLine(r)),
            h('span.cmp-card-num', formatMs(r.timing && r.timing.total)), h('span.cmp-card-num', formatBytes(r.size && r.size.body))),
        );
      } else {
        card.append(h('div.cmp-card-stat', h('span.status-pill.s-err', '응답 없음'), h('span.cmp-card-err', { title: r.error && r.error.hint }, (r.error && r.error.message) || '')));
      }
      card.append(h('div.cmp-card-url', { title: url }, url));
      if (run.unresolved && run.unresolved.length) {
        card.append(h('div.cmp-card-warn', icon('alert', 12), `정의되지 않은 변수: ${run.unresolved.map((v) => `{{${v}}}`).join(', ')}`));
      }
      const c = r.checks;
      if (c && !c.skipped && c.asserts.length) {
        const bad = c.asserts.filter((a) => !a.ok);
        const tip = bad.map((a) => `✗ ${a.target}${a.tplPath ? ' ' + a.tplPath : ''} ${a.op}${a.tplExpected ? ' ' + a.tplExpected : ''}${a.message ? ' — ' + a.message : ''}`).join('\n');
        card.append(h('div.cmp-card-tests' + (bad.length ? '.bad' : '.good'), { title: tip || '모두 통과' },
          `Tests ${c.passed}/${c.asserts.length} 통과`));
      }
      if (i > 0) {
        const diff = this.diffOf(run);
        const txt = !diff ? '' : diff.failed ? (diff.failed === 'other' ? '응답을 받지 못해 견주지 못함' : '기준이 응답을 받지 못해 견주지 못함') : diff.same ? '기준과 같음' : `기준과 다른 곳 ${diff.count}개`;
        const cls = !diff ? '' : diff.failed ? '.warn' : diff.same ? '.same' : '.diff';
        const b = h('button.cmp-card-diff' + cls, {
          disabled: !diff,
          onclick: () => {
            this.targetId = run.env.id;
            this.renderBody();
          },
        }, diff && !diff.failed && diff.same ? icon('check', 12) : null, txt);
        card.append(b);
      }
      wrap.appendChild(card);
    });
    return wrap;
  }

  /* ---------------- 자세히: 기준 ↔ 고른 환경 ---------------- */
  detail() {
    const base = this.runs[0];
    const run = this.runs.find((x) => x && x.env.id === this.targetId);
    const diff = this.diffOf(run);
    const tabs = h('div.cmp-targets', this.runs.slice(1).filter(Boolean).map((x) => {
      const d = this.diffOf(x);
      const n = d.failed ? '!' : d.count;
      return h('button.cmp-target' + (x.env.id === this.targetId ? '.active' : ''), {
        onclick: () => {
          this.targetId = x.env.id;
          this.renderBody();
        },
      }, `${base.env.name} ↔ ${x.env.name}`, h('span.cmp-target-n' + (d.failed ? '.warn' : d.count ? '.diff' : '.same'), String(n)));
    }));
    const seg = h('div.seg.cmp-mode',
      h('button.seg-btn' + (this.mode === 'list' ? '.active' : ''), { onclick: () => { this.mode = 'list'; this.renderBody(); } }, '차이 목록'),
      h('button.seg-btn' + (this.mode === 'side' ? '.active' : ''), { onclick: () => { this.mode = 'side'; this.renderBody(); } }, '본문 나란히'));
    const copyBtn = h('button.btn.btn-sm', { title: '모든 환경의 차이를 글로 복사', onclick: () => this.copyReport() }, icon('copy', 13), '차이 복사');
    const box = h('div.cmp-detail', h('div.cmp-detail-bar', tabs, h('div.flex1'), seg, copyBtn));
    if (diff.failed) {
      const who = diff.failed === 'base' ? base : diff.failed === 'other' ? run : null;
      box.append(h('div.cmp-failed', icon('alert', 16),
        h('div', diff.failed === 'both' ? '두 환경 모두 응답을 받지 못했습니다.' : `${who.env.name} 환경이 응답을 받지 못해 견줄 수 없습니다.`,
          ...[base, run].filter((x) => x && !x.result.ok).map((x) => h('div.muted', `${x.env.name}: ${x.result.error ? x.result.error.message : ''}`)))));
      return box;
    }
    box.append(this.mode === 'side' ? this.sideView(base, run, diff) : this.listView(base, run, diff));
    return box;
  }

  listView(base, run, diff) {
    const A = base.env.name;
    const B = run.env.name;
    const out = h('div.cmp-list');
    if (diff.same) {
      out.append(h('div.cmp-same', icon('check', 16), `${A} 와 ${B} 의 응답이 같습니다`, h('span.muted', ' (뺀 곳은 견주지 않음)')));
    }
    // 상태 코드
    out.append(h('div.cmp-sec',
      h('div.cmp-sec-head', '상태 코드', diff.status ? h('span.cmp-ok', '같음') : h('span.cmp-bad', '다름')),
      diff.status ? null : h('div.cmp-kv', h('span.cmp-old', statusLine(base.result)), h('span.cmp-arrow', '→'), h('span.cmp-new', statusLine(run.result)))));
    // 머리글
    const hs = diff.headers;
    out.append(h('div.cmp-sec',
      h('div.cmp-sec-head', '응답 머리글', hs.length ? h('span.cmp-bad', `다른 곳 ${hs.length}개`) : h('span.cmp-ok', '같음'),
        h('span.cmp-sec-note.muted', { title: DEFAULT_IGNORE_HEADERS.join(', ') }, '날짜·요청 ID 등은 견주지 않음')),
      hs.length ? h('table.cmp-table',
        h('thead', h('tr', h('th', '이름'), h('th', A), h('th', B), h('th'))),
        h('tbody', hs.map((x) => h('tr.k-' + x.kind,
          h('td.cmp-path', x.name),
          h('td.cmp-old', x.a === undefined ? h('span.muted', '(없음)') : x.a),
          h('td.cmp-new', x.b === undefined ? h('span.muted', '(없음)') : x.b),
          h('td.cmp-act', h('button.link-btn', { title: '이 머리글은 견주지 않기', onclick: () => this.addIgnore('headers', x.name) }, '빼기')))))) : null));
    // 본문
    const b = diff.body;
    const bodyHead = h('div.cmp-sec-head', '본문',
      b.mode === 'json' ? h('span.cmp-tag', 'JSON · 경로마다') : b.mode === 'text' ? h('span.cmp-tag', '글 · 줄마다') : h('span.cmp-tag', '바이너리'),
      b.count ? h('span.cmp-bad', b.mode === 'json' ? `다른 곳 ${b.count}${b.truncated ? '+' : ''}개` : b.mode === 'text' && !b.tooBig ? `다른 줄 ${b.count}개` : '다름') : h('span.cmp-ok', '같음'));
    const sec = h('div.cmp-sec', bodyHead);
    if (b.mode === 'json' && b.diffs.length) {
      const shown = b.diffs.slice(0, LIST_LIMIT);
      sec.append(h('table.cmp-table',
        h('thead', h('tr', h('th', '경로'), h('th', A), h('th', B), h('th'))),
        h('tbody', shown.map((x) => h('tr.k-' + x.kind,
          h('td.cmp-path', h('button.link-btn.cmp-jump', { title: '본문 나란히 보기에서 이 자리로', onclick: () => this.jumpTo(x.path) }, x.path)),
          h('td.cmp-old', showValue(x.a)),
          h('td.cmp-new', showValue(x.b)),
          h('td.cmp-act', h('button.link-btn', { title: '이 경로는 견주지 않기 (뺄 곳에 더함)', onclick: () => this.addIgnore('body', ignorePathOf(x.path)) }, '빼기')))))));
      if (b.diffs.length > shown.length || b.truncated) sec.append(h('div.muted.cmp-more', `처음 ${shown.length}개만 보여 줍니다.`));
      sec.append(h('div.muted.cmp-hint', '배열은 같은 번째끼리 견줍니다. 번째마다 달라지는 값은 [*] 로 뺄 수 있습니다 (예: $.items[*].updatedAt). 키 이름만 쓰면 어느 깊이든 뺍니다.'));
    } else if (b.mode === 'text' && b.count) {
      if (b.tooBig) sec.append(h('div.muted', '줄이 너무 많거나 다른 줄이 너무 많아 줄마다 견주지 않았습니다. 본문이 다릅니다.'));
      else {
        const hunks = lineHunks(b.ops, 2);
        const pre = h('div.cmp-hunks');
        let n = 0;
        for (const hk of hunks) {
          if (n > LIST_LIMIT) break;
          const blk = h('div.cmp-hunk');
          for (const o of hk) {
            n++;
            const text = o.t === '+' ? b.b[o.b] : b.a[o.a];
            blk.appendChild(h('div.cmp-hl.k-' + (o.t === '+' ? 'added' : o.t === '-' ? 'removed' : 'same'),
              h('span.cmp-ln', o.a === undefined ? '' : String(o.a + 1)), h('span.cmp-ln', o.b === undefined ? '' : String(o.b + 1)),
              h('span.cmp-sign', o.t === '=' ? ' ' : o.t), h('span.cmp-tx', text)));
          }
          pre.appendChild(blk);
        }
        sec.append(pre);
      }
    } else if (b.mode === 'binary' && b.count) {
      sec.append(h('div.muted', `바이트가 다릅니다 (${formatBytes(base.result.size && base.result.size.body)} → ${formatBytes(run.result.size && run.result.size.body)}).`));
    }
    out.append(sec);
    return out;
  }

  // 본문 나란히 보기: JSON 은 같은 경로끼리 같은 행, 글은 같은 줄끼리
  sideView(base, run, diff) {
    const b = diff.body;
    const box = h('div.cmp-side');
    if (b.mode === 'binary') {
      box.append(h('div.muted', '바이너리 응답은 나란히 볼 수 없습니다.'));
      return box;
    }
    let L;
    let R;
    let truncated = false;
    if (b.mode === 'json') {
      const ig = makeIgnore(this.ignoreOpts().ignoreBody);
      const left = new Set(b.diffs.filter((x) => x.kind !== 'added').map((x) => x.path));
      const right = new Set(b.diffs.filter((x) => x.kind !== 'removed').map((x) => x.path));
      const pl = prettyJsonLines(responseContext(base.result).json(), { ignore: ig, marks: left, limit: SIDE_LIMIT });
      const pr = prettyJsonLines(responseContext(run.result).json(), { ignore: ig, marks: right, limit: SIDE_LIMIT });
      L = pl.lines;
      R = pr.lines;
      truncated = pl.truncated || pr.truncated;
    } else {
      const ta = responseContext(base.result).text().split(/\r?\n/);
      const tb = responseContext(run.result).text().split(/\r?\n/);
      truncated = ta.length > SIDE_LIMIT || tb.length > SIDE_LIMIT;
      L = ta.slice(0, SIDE_LIMIT).map((t) => ({ text: t, key: t }));
      R = tb.slice(0, SIDE_LIMIT).map((t) => ({ text: t, key: t }));
    }
    const { rows, aligned } = sideBySide(L, R);
    // 글 모드: 짝이 없는 줄과 짝지은 줄 중 글이 다른 줄이 다른 곳
    if (b.mode !== 'json') {
      for (const row of rows) {
        if (row.l && (!row.r || row.r.text !== row.l.text)) row.l = { ...row.l, mark: true };
        if (row.r && (!row.l || row.l.text !== row.r.text)) row.r = { ...row.r, mark: true };
      }
    }
    const table = h('div.cmp-grid', h('div.cmp-grid-head', h('div', base.env.name, h('span.cmp-base-tag', '기준')), h('div', run.env.name)));
    const cell = (x, i, side) => (x
      ? h('div.cmp-cell' + (x.mark ? (side === 'l' ? '.del' : '.add') : '') + (x.ignored ? '.ign' : ''), { dataset: { key: x.key || '' }, title: x.ignored ? '뺀 곳 (견주지 않음)' : null },
        h('span.cmp-ln', String(i + 1)), h('span.cmp-tx', x.text))
      : h('div.cmp-cell.blank'));
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(h('div.cmp-row', cell(row.l, row.li, 'l'), cell(row.r, row.ri, 'r')));
    this.gridBody = h('div.cmp-grid-body', frag);
    table.appendChild(this.gridBody);
    if (!aligned) box.append(h('div.muted.cmp-more', '다른 줄이 너무 많아 같은 줄끼리 맞추지 못했습니다. 줄 번호대로 놓았습니다.'));
    if (truncated) box.append(h('div.muted.cmp-more', `한쪽에 ${SIDE_LIMIT}줄까지만 보여 줍니다.`));
    box.append(table);
    const marks = rows.filter((r) => (r.l && r.l.mark) || (r.r && r.r.mark)).length;
    if (!marks) box.prepend(h('div.cmp-same', icon('check', 16), '본문이 같습니다', h('span.muted', ' (뺀 곳은 회색)')));
    return box;
  }

  jumpTo(path) {
    this.mode = 'side';
    this.renderBody();
    const cell = this.gridBody && [...this.gridBody.querySelectorAll('.cmp-cell')].find((c) => c.dataset.key === path);
    if (cell) {
      cell.scrollIntoView({ block: 'center' });
      cell.parentElement.classList.add('flash');
      setTimeout(() => cell.parentElement && cell.parentElement.classList.remove('flash'), 1200);
    }
  }

  addIgnore(kind, text) {
    const k = kind === 'headers' ? 'ignoreHeaders' : 'ignoreBody';
    const cur = lines(this.opts[k]);
    if (!cur.includes(text)) this.opts[k] = [...cur, text].join('\n');
    this.save();
    toast(`"${text}" 은 이제 견주지 않습니다. [뺄 곳]에서 되돌릴 수 있습니다.`, 'info', 3500);
    this.build();
  }

  editIgnore() {
    const body = h('textarea.input.cmp-ig-input', { rows: 7, spellcheck: 'false', placeholder: 'updatedAt\n$.meta.requestId\n$.items[*].createdAt\n$..traceId' });
    body.value = this.opts.ignoreBody || '';
    const hdr = h('textarea.input.cmp-ig-input', { rows: 3, spellcheck: 'false', placeholder: 'X-Version\nETag' });
    hdr.value = this.opts.ignoreHeaders || '';
    const err = h('div.field-err');
    const check = () => {
      const bad = makeIgnore(body.value).errors;
      err.textContent = bad.length ? bad.map((e) => `${e.line}번째 줄 "${e.text}": ${e.message}`).join(' · ') : '';
      return !bad.length;
    };
    body.addEventListener('input', check);
    const m = openModal({
      title: '견주지 않을 곳',
      subtitle: '요청마다 달라지는 값(시각·요청 ID 등)을 빼면 진짜 차이만 남습니다',
      width: 560,
      body: h('div.cmp-ig',
        h('label.field', h('span.field-label', '본문 (한 줄에 하나)'), body,
          h('div.muted', h('code', 'updatedAt'), ' 처럼 이름만 쓰면 어느 깊이든 그 키를 뺍니다. ', h('code', '$'), ' 로 시작하면 경로: ',
            h('code', '$.meta.requestId'), ' · ', h('code', '$.items[*].at'), '(아무 번째) · ', h('code', '$.data.*.ts'), '(아무 이름) · ', h('code', '$..traceId'), '(아무 깊이). ',
            h('code', '#'), ' 로 시작하는 줄은 메모.')),
        err,
        h('label.field', h('span.field-label', '응답 머리글 이름 (한 줄에 하나)'), hdr,
          h('div.muted', '이것들은 늘 뺍니다: ', DEFAULT_IGNORE_HEADERS.join(', ')))),
      footer: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.btn-primary', {
          onclick: () => {
            if (!check()) return;
            this.opts.ignoreBody = body.value.trim();
            this.opts.ignoreHeaders = hdr.value.trim();
            this.save();
            m.close();
            this.build();
          },
        }, '저장'),
      ],
    });
  }

  /* ---------------- 보내기 ---------------- */
  async run() {
    if (this.running) return;
    const src = app.compareSource(this.tab);
    if (!src) return toast('원래 요청을 찾을 수 없습니다. 요청 탭에서 다시 여세요.', 'error');
    if (!String(src.draft.url || '').trim()) return toast('요청에 URL을 넣으세요.', 'error');
    const envs = this.pickedEnvs();
    if (envs.length < 2) return toast('견줄 환경을 둘 이상 고르세요.', 'error');
    const method = String(src.draft.method || 'GET').toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const ok = await confirmDialog({
        title: `${method} 요청을 ${envs.length}곳에 보낼까요?`,
        message: `${envs.map((e) => e.name).join(', ')} 환경에 같은 ${method} 요청을 한꺼번에 보냅니다. 서버의 데이터가 바뀔 수 있습니다.`,
        okText: '보내기',
        danger: true,
      });
      if (!ok) return;
    }
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    app.controllers.set(this.tab.id, ctrl); // 탭을 닫으면 멈춘다
    this.running = true;
    const prevGot = this.got;
    const prevEngine = [this.engine, this.forced];
    this.got = new Map();
    this.pending = new Set(envs.map((e) => e.id));
    this.engine = null;
    this.build();
    let out = null;
    try {
      out = await app.compareAcross(src, envs, {
        signal: ctrl.signal,
        onStart: ({ engine, forced }) => {
          this.engine = engine;
          this.forced = forced;
        },
        onResult: (i, x) => {
          if (this.ctrl !== ctrl) return;
          this.got.set(x.env.id, x);
          this.pending.delete(x.env.id);
          this.renderBody();
        },
      });
    } finally {
      if (app.controllers.get(this.tab.id) === ctrl) app.controllers.delete(this.tab.id);
      this.ctrl = null;
      this.running = false;
      this.pending = new Set();
    }
    if (!out) {
      // 비밀번호 창을 취소했으면 앞의 결과로 되돌린다
      this.got = prevGot;
      [this.engine, this.forced] = prevEngine;
      this.build();
      return;
    }
    this.build();
    const runs = this.runs;
    const nDiff = runs.slice(1).map((x) => this.diffOf(x)).filter((d) => d && !d.failed && !d.same).length;
    const nFail = runs.filter((x) => x && !x.result.ok).length;
    toast(nFail ? `환경 비교: 응답을 받지 못한 환경이 ${nFail}곳 있습니다` : nDiff ? `환경 비교: 기준과 다른 환경 ${nDiff}곳` : '환경 비교: 모든 환경의 응답이 기준과 같습니다',
      nFail ? 'error' : nDiff ? 'info' : 'success', 3500);
  }

  // 모든 환경의 차이를 글로 (메신저·이슈에 붙여 넣기).
  // 서버가 받은 비밀 값을 응답에 돌려주기도 하므로(에코·로그인 응답) 주소만이 아니라 글 전체에서 비밀 변수 값을 가린다
  async copyReport() {
    const src = app.compareSource(this.tab);
    const base = this.runs[0];
    const out = [];
    const d = src && src.draft;
    out.push(`환경 비교: ${d ? `${String(d.method || 'GET').toUpperCase()} ${d.url}` : ''}${src ? ` (${src.name})` : ''}`);
    const head = (x) => (x.result.ok ? `${statusLine(x.result)} · ${formatMs(x.result.timing && x.result.timing.total)}` : `응답 없음: ${x.result.error ? x.result.error.message : ''}`);
    out.push(`기준 ${base.env.name}: ${head(base)} · ${base.result.sentUrl || ''}`);
    for (const x of this.runs.slice(1)) {
      if (!x) continue;
      const diff = this.diffOf(x);
      out.push('');
      out.push(`${x.env.name}: ${head(x)} · ${x.result.sentUrl || ''}`);
      if (diff.failed) {
        out.push('  견주지 못함 (응답 없음)');
        continue;
      }
      if (diff.same) {
        out.push('  기준과 같음');
        continue;
      }
      if (!diff.status) out.push(`  상태 코드: ${statusLine(base.result)} → ${statusLine(x.result)}`);
      for (const hd of diff.headers) out.push(`  머리글 ${hd.name}: ${hd.a ?? '(없음)'} → ${hd.b ?? '(없음)'}`);
      const b = diff.body;
      if (b.mode === 'json') {
        for (const y of b.diffs.slice(0, LIST_LIMIT)) out.push(`  본문 ${y.path}: ${showValue(y.a)} → ${showValue(y.b)}`);
        if (b.diffs.length > LIST_LIMIT || b.truncated) out.push('  …');
      } else if (b.count) {
        out.push(b.mode === 'text' && !b.tooBig ? `  본문: 다른 줄 ${b.count}개` : '  본문: 다름');
      }
    }
    const ig = this.ignoreOpts();
    if (ig.ignoreBody.length || ig.ignoreHeaders.length) out.push('', `뺀 곳: ${[...ig.ignoreBody, ...ig.ignoreHeaders].join(', ')}`);
    const raw = out.join('\n');
    const text = redactSecrets(raw, vault.secretValues());
    const ok = await copyText(text);
    toast(!ok ? '복사 실패' : text !== raw ? '차이를 복사했습니다. 비밀 변수 값은 •••• 로 가렸습니다.' : '차이를 복사했습니다.', ok ? 'success' : 'error', text !== raw ? 4000 : 2600);
  }
}
