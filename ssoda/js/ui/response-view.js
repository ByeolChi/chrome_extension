// 응답 패널
// 응답 도구: Body 의 JSONPath 필터 칸, 찾기 막대(Ctrl+F), 비교 탭(이전 응답·저장한 예제와), 응답 예제(저장·보기·이름 바꾸기·지우기)
import { h, clear, formatBytes, formatMs, statusClass, guessLanguage, isTextContentType, copyText, download, escapeHtml, debounce, modKey, STATUS_TEXT } from '../util.js';
import { icon } from './icons.js';
import { openMenu, popover, toast, confirmDialog, promptDialog } from './overlay.js';
import { parseSetCookie } from '../cookiejar.js';
import { formatJson } from '../json-format.js';
import { isEventStream, parseSse } from '../sse.js';
import { describeAssert, parseJson } from '../checks.js';
import { compareResults } from '../compare.js';
import { filterJson, exampleProblem, exampleAsResult, maskResult, looksTextual } from '../resp-tools.js';
import { diffListView, diffSideView, flashPath, editIgnoreDialog, statusLine, ignoreLines } from './diff-view.js';
import { BodyCode } from './body-code.js';
import { app } from '../app.js';
import { vault, redactSecrets, MASK } from '../secrets.js';

// 화면에 보이는 요청 글(명령·보낸 머리글)에서 비밀 변수의 값을 가린다
const redact = (text) => redactSecrets(text, vault.secretValues());

const LIVE_ROWS = 1000; // 받는 중에 화면에 두는 이벤트 수 (오래된 것부터 뺌. 전체는 끝난 뒤 결과에 남음)
const MAX_EVENT_ROWS = 5000; // 끝난 응답의 Events 보기에 그리는 최대 수
const STREAM_END = {
  closed: '서버가 스트림을 끝냄',
  stopped: '멈춤',
  timeout: '타임아웃으로 끊음',
  limit: '너무 커서 멈춤',
  error: '연결 끊김',
};

export class ResponseView {
  /** tab: 이 응답의 요청 탭 (예제·비교 설정·이전 응답을 찾는 데 씀). 없으면 응답 도구 중 필터·찾기만 */
  constructor(tab = null) {
    this.tab = tab;
    this.sub = 'body';
    this.mode = 'pretty'; // pretty | raw | preview (SSE 응답은 Events | Raw)
    this.format = null; // null = auto
    this.el = h('div.resp');
    this.result = null; // 지금 보여 주는 결과 (받은 응답 또는 예제)
    this.liveResult = null; // 받은 응답 (예제를 보는 동안에도 그대로)
    this.exampleView = null; // 보고 있는 예제
    this.loading = false;
    this.live = null; // 받는 중인 SSE 스트림 (http.js onStream)
    this.blobUrl = null;
    this.filter = ''; // JSONPath 필터 (다시 보내도 그대로)
    this.findOpen = false;
    this.findQuery = '';
    this.findCase = false;
    this.findRe = false;
    this.diffMode = 'list'; // 비교 탭: list | side
    this.code = null; // 본문 글 보기 (BodyCode)
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    // 다른 탭을 보다 돌아오면 이 화면의 찾은 곳을 다시 칠한다 (칠한 곳 등록부는 문서에 하나)
    this.el.addEventListener('pointerenter', () => this.code && this.code.repaint());
    this.render();
  }

  destroy() {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    clearTimeout(this._liveTimer);
    clearInterval(this._liveTick);
    if (this.code) this.code.destroy();
  }

  setLoading(on, onCancel, engine) {
    this.loading = on;
    this.loadingEngine = engine || 'browser';
    this.waitingHost = null;
    this.live = null;
    this._live = null;
    clearTimeout(this._liveTimer);
    clearInterval(this._liveTick);
    this._liveTimer = null;
    if (onCancel) this.onCancel = onCancel;
    this.render();
  }

  // SSE 응답을 받는 중. 처음에는 받는 화면으로 바꾸고, 그 뒤로는 0.1초에 한 번만 새 이벤트를 붙인다
  setStream(s) {
    if (!this.loading || !s) return;
    const first = !this.live;
    this.live = s;
    if (first) return this.render();
    if (this._liveTimer) return;
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this.updateLive();
    }, 100);
  }

  setWaiting(host) {
    if (!this.loading || (this.waitingHost || null) === (host || null)) return;
    this.waitingHost = host || null;
    this.render();
  }

  /** 받은 응답 (app.send) */
  show(result) {
    this.liveResult = result;
    this.exampleView = null;
    this.display(result);
  }

  display(result) {
    this.result = result;
    this.loading = false;
    this.live = null;
    this._live = null;
    clearTimeout(this._liveTimer);
    clearInterval(this._liveTick);
    this._liveTimer = null;
    this.format = null;
    this._decoded = null;
    this._parsedStream = null;
    this._json = undefined;
    this._filter = null;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    if (result && !result.ok) this.sub = this.sub === 'timeline' ? 'timeline' : 'body';
    this.render();
  }

  /** 저장한 예제를 응답 자리에 보여 준다 (받은 응답은 그대로 두고, 배너의 단추로 돌아감) */
  showExample(ex) {
    if (!ex) return;
    this.exampleView = ex;
    if (!['body', 'headers', 'cookies'].includes(this.sub)) this.sub = 'body';
    this.display(exampleAsResult(ex));
  }

  backToResponse() {
    this.exampleView = null;
    this.display(this.liveResult);
  }

  decoded() {
    if (this._decoded) return this._decoded;
    const r = this.result;
    const ct = r.contentType || '';
    const charset = (ct.match(/charset=([^;]+)/i) || [])[1];
    let text = '';
    const isText = isTextContentType(ct) || looksTextual(r.body);
    if (isText) {
      try {
        text = new TextDecoder((charset || 'utf-8').trim().replace(/"/g, ''), { fatal: false }).decode(r.body);
      } catch (e) {
        text = new TextDecoder('utf-8').decode(r.body);
      }
    }
    const lang = isText ? guessLanguage(ct, text.slice(0, 2000)) : 'binary';
    let pretty = text;
    if (lang === 'json') {
      try {
        // 큰 정수(Java Long ID 등)·소수 자릿수를 바꾸지 않는 정렬
        pretty = formatJson(text, 2);
      } catch (e) {
        pretty = text;
      }
    } else if (lang === 'xml' || lang === 'html') {
      pretty = text.length < 500000 ? prettyXml(text) : text;
    }
    this._decoded = { text, pretty, lang, isText, isImage: /^\s*image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif|svg\+xml)/i.test(ct), isPdf: /^\s*application\/pdf/i.test(ct) };
    return this._decoded;
  }

  render() {
    if (this.code) this.code.destroy();
    this.code = null;
    this.bodyWrap = null;
    this.findBarEl = null;
    clear(this.el);
    if (this.loading && this.live) {
      this.renderLive();
      return;
    }
    if (this.loading) {
      this.el.appendChild(
        h('div.resp-empty.loading',
          h('div.spinner'),
          h('div.resp-empty-title', this.waitingHost ? '같은 서버로 보낸 이전 요청을 기다리는 중…' : this.loadingEngine === 'curl' ? 'curl 실행 중…' : '요청을 보내는 중…'),
          this.waitingHost
            ? h('div.resp-empty-sub', `${this.waitingHost} 로 가는 요청은 헤더가 섞이지 않도록 하나씩 보냅니다. 이전 요청이 응답 헤더를 받으면 바로 보냅니다.`)
            : this.loadingEngine === 'curl' ? h('div.resp-empty-sub', 'PC의 curl 이 요청을 실행하고 있습니다') : null,
          h('button.btn', { onclick: () => this.onCancel && this.onCancel() }, '취소'))
      );
      return;
    }
    const r = this.result;
    if (!r) {
      this.el.appendChild(
        h('div.resp-head', h('div.resp-title', 'Response')),
      );
      // 이 요청에 저장한 예제가 있으면 보내기 전에도 열어 볼 수 있다
      const exs = this.examples();
      this.el.appendChild(
        h('div.resp-empty',
          emptyIllustration(),
          h('div.resp-empty-title', 'URL을 입력하고 Send를 눌러 응답을 확인하세요'),
          h('div.resp-empty-sub', 'cURL 명령을 URL 입력창에 붙여넣으면 자동으로 변환됩니다'),
          exs.length ? h('div.ex-chips', h('span.ex-chips-label', '저장한 예제'),
            exs.map((ex) => h('button.ex-chip', { title: '예제 보기', onclick: () => this.showExample(ex) }, icon('file', 12), ex.name, h('span.ex-chip-st', String(ex.status || ''))))) : null)
      );
      return;
    }
    if (this.exampleView) this.el.appendChild(this.exampleBanner());
    if (this.sub === 'tests' && !r.checks) this.sub = 'body';
    if (this.sub === 'diff' && !this.canDiff()) this.sub = 'body';
    if (this.sub === 'timeline' && r.engine === 'example') this.sub = 'body';
    this.el.appendChild(this.renderBar());
    const body = h('div.resp-body');
    this.el.appendChild(body);
    if (!r.ok && this.sub !== 'timeline' && this.sub !== 'tests') {
      body.appendChild(this.renderError());
      return;
    }
    if (this.sub === 'body') body.appendChild(this.renderBody());
    else if (this.sub === 'headers') body.appendChild(this.renderHeaders());
    else if (this.sub === 'cookies') body.appendChild(this.renderCookies());
    else if (this.sub === 'tests') body.appendChild(this.renderChecks());
    else if (this.sub === 'diff') body.appendChild(this.renderDiff());
    else if (this.sub === 'timeline') body.appendChild(this.renderTimeline());
    // 찾기 막대가 열려 있으면 새로 그린 본문에서 다시 찾는다 (칠하기·굴리기는 화면에 붙은 뒤라야 됨)
    if (this.code && this.findOpen && this.findQuery) this.runFind(true);
  }

  /* ---------------- Tests (응답값 꺼내기·확인 결과) ---------------- */
  renderChecks() {
    const c = this.result.checks;
    const wrap = h('div.ck-wrap');
    if (c.skipped) {
      wrap.appendChild(h('div.body-empty', c.skipped));
      return wrap;
    }
    const mark = (ok) => h('span.ck-mark.' + (ok ? 'ck-ok' : 'ck-fail'), icon(ok ? 'check' : 'x', 14));
    if (c.captures.length) {
      const saved = c.captures.filter((x) => x.ok).length;
      wrap.appendChild(h('div.ck-sec', `변수로 꺼낸 값 · ${saved}/${c.captures.length}`));
      c.captures.forEach((x) => {
        wrap.appendChild(h('div.ck-row',
          mark(x.ok),
          h('div.ck-main',
            h('div.ck-desc', h('b', x.name), x.ok ? ' = ' : '', x.ok ? h('span.ck-val', x.secret ? MASK + ' (비밀 변수)' : x.value.length > 300 ? x.value.slice(0, 300) + '…' : x.value) : ''),
            h('div.ck-sub', x.ok ? `${x.savedTo || ''}에 저장` : x.error, x.note ? h('span.ck-note', ' · ' + x.note) : null))));
      });
    }
    if (c.asserts.length) {
      wrap.appendChild(h('div.ck-sec', `확인 · ${c.passed}/${c.asserts.length} 통과`));
      c.asserts.forEach((a) => {
        wrap.appendChild(h('div.ck-row' + (a.ok ? '' : '.fail'),
          mark(a.ok),
          h('div.ck-main',
            h('div.ck-desc', describeAssert(a)),
            h('div.ck-sub', '찾은 값: ', h('span.ck-val', a.actual), a.message ? h('span.ck-note', ' · ' + a.message) : null))));
      });
    }
    return wrap;
  }

  renderBar() {
    const r = this.result;
    const tabs = [
      ['body', 'Body'],
      ['cookies', 'Cookies', r.ok ? r.setCookies.length : 0],
      ['headers', 'Headers', r.ok ? r.headers.length : 0],
    ];
    // Tests: 확인 결과 (통과 수/전체, 하나라도 실패하면 빨강)
    const ck = r.checks;
    if (ck) tabs.push(['tests', 'Tests', ck.asserts.length ? `${ck.passed}/${ck.asserts.length}` : 0, ck.skipped ? '' : ck.failed || ck.captures.some((x) => !x.ok) ? '.ck-bad' : '.ck-good']);
    // 비교: 이 탭의 이전 응답이나 저장한 예제가 있을 때. 다른 곳 수는 본문이 작을 때만 미리 센다
    if (this.canDiff()) {
      const n = this.diffCount();
      tabs.push(['diff', '비교', n || 0, n == null ? '' : n ? '.rd-bad' : '.ck-good']);
    }
    if (r.engine !== 'example') tabs.push(['timeline', r.engine === 'curl' ? 'Terminal' : 'Timeline']);
    const tabEls = tabs.map(([id, label, count, cls = '']) =>
      h('button.subtab' + (this.sub === id ? '.active' : ''), { dataset: { sub: id }, onclick: () => { this.sub = id; this.render(); } },
        label, count ? h('span.count' + cls, `(${count})`) : cls ? h('span.ck-dot' + cls) : null)
    );
    const meta = h('div.resp-meta');
    if (r.ok) {
      const st = h('span.status-pill.' + statusClass(r.status), `${r.status} ${r.statusText}`.trim());
      st.title = r.statusLine || '';
      const tm = h('button.meta-item', { title: '시간 상세' }, h('span.meta-k', 'Time:'), h('span.meta-v', formatMs(r.timing.total)));
      tm.addEventListener('click', () => this.timePopover(tm));
      const sz = h('button.meta-item', { title: '크기 상세' }, h('span.meta-k', 'Size:'), h('span.meta-v', formatBytes(r.size.body + r.size.headers)));
      sz.addEventListener('click', () => this.sizePopover(sz));
      meta.append(st, tm, sz);
      if (r.redirected) meta.appendChild(h('span.meta-tag', { title: '리다이렉트됨: ' + r.url }, '↪ Redirected'));
      if (r.engine === 'curl') meta.appendChild(h('span.meta-tag.curl-tag', { title: 'PC의 curl 로 실행됨' + (r.terminal && r.terminal.curlPath ? ': ' + r.terminal.curlPath : '') }, 'cURL'));
      const ssh = r.terminal && r.terminal.ssh;
      if (ssh) meta.appendChild(h('span.meta-tag.ssh-tag', { title: `SSH 터널 ${ssh.user}@${ssh.host}:${ssh.port} 를 거쳐 실행됨` }, icon('lock', 11), 'SSH ' + (ssh.label || ssh.host)));
      const save = h('button.btn.btn-sm.btn-ghost.resp-save', { title: '응답 저장' }, icon('download', 14), '저장', icon('chevronDown', 12));
      save.addEventListener('click', () =>
        openMenu(save, [
          { label: '파일로 저장', icon: 'download', onClick: () => this.saveToFile() },
          { label: '본문 복사', icon: 'copy', onClick: () => this.copyBody() },
          { label: '응답 헤더 복사', icon: 'copy', onClick: () => copyText(r.headers.map((x) => `${x.name}: ${x.value}`).join('\n')).then(() => toast('복사했습니다.', 'success')) },
          this.exampleView || !this.tab ? null : { divider: true },
          this.exampleView || !this.tab ? null : { label: '예제로 저장…', icon: 'save', hint: '이 요청에', onClick: () => this.saveAsExample() },
        ], { alignRight: true })
      );
      meta.appendChild(save);
    } else {
      meta.appendChild(h('span.status-pill.s-err', 'Error'));
      if (r.engine === 'curl') meta.appendChild(h('span.meta-tag.curl-tag', 'cURL'));
      if (r.timing && r.timing.total != null) meta.appendChild(h('span.meta-item', h('span.meta-k', 'Time:'), h('span.meta-v.plain', formatMs(r.timing.total))));
    }
    const exs = this.examples();
    if (exs.length) meta.appendChild(this.examplesButton(exs));
    return h('div.resp-head', h('div.subtabs', tabEls), meta);
  }

  timePopover(anchor) {
    const t = this.result.timing;
    const total = t.total || 1;
    const row = (label, v, cls) =>
      h('div.tp-row',
        h('span.tp-label', label),
        h('span.tp-bar', h('span.tp-fill.' + cls, { style: { width: Math.max(2, (v / total) * 100) + '%' } })),
        h('span.tp-val', formatMs(v)));
    const curl = this.result.engine === 'curl' && t.dns != null;
    popover(anchor, h('div.tp',
      h('div.tp-title', curl ? '응답 시간 (curl 측정)' : '응답 시간', h('b', formatMs(t.total))),
      curl
        ? [row('DNS 조회', t.dns || 0, 'c1'), row('TCP 연결', t.connect || 0, 'c1'), row('TLS 핸드셰이크', t.tls || 0, 'c1'), row('서버 대기 (TTFB)', t.ttfb || 0, 'c2'), row('다운로드', t.download || 0, 'c3')]
        : [row('준비 (규칙/쿠키)', t.prepare || 0, 'c1'), row('대기 (TTFB)', t.ttfb || 0, 'c2'), row('다운로드', t.download || 0, 'c3')],
      this.result.remoteIp ? h('div.tp-foot', '원격 주소: ' + this.result.remoteIp + (this.result.fromCache ? ' (캐시)' : '')) : null,
      curl && t.process ? h('div.tp-foot', `도우미 실행 오버헤드 ${formatMs(t.process)} (위 시간에는 미포함)`) : null
    ), { alignRight: true });
  }

  sizePopover(anchor) {
    const s = this.result.size;
    popover(anchor, h('div.tp',
      h('div.tp-title', '응답 크기', h('b', formatBytes(s.body + s.headers))),
      h('div.tp-kv', h('span', '헤더'), h('span', formatBytes(s.headers))),
      h('div.tp-kv', h('span', '본문'), h('span', formatBytes(s.body))),
      h('div.tp-foot', '본문 크기는 압축 해제 후 기준입니다.')
    ), { alignRight: true });
  }

  renderError() {
    const e = this.result.error || {};
    return h('div.resp-error',
      h('div.err-icon', icon('alert', 28)),
      h('div.err-title', '요청을 완료할 수 없습니다'),
      h('div.err-msg', e.message),
      e.hint ? h('div.err-hint', e.hint) : null,
      h('div.err-detail', `${this.result.method || ''} ${this.result.sentUrl || ''}`),
      (this.result.warnings || []).length ? h('ul.warn-list', this.result.warnings.map((w) => h('li', w))) : null,
      h('div.err-actions', this.errorActions(e))
    );
  }

  errorActions(e) {
    const r = this.result;
    const helperMissing = ['NO_HOST', 'HOST_FORBIDDEN', 'HOST_EXITED', 'HOST_ERROR', 'NO_NATIVE', 'HOST_OUTDATED'].includes(e.code);
    const viaSsh = !!(r.terminal && r.terminal.ssh);
    const out = [];
    if (helperMissing) {
      out.push(h('button.btn.btn-primary', { onclick: () => app.ui.openCurlHelper() }, icon('download', 14), '도우미 설치 / 확인'));
      if (this.onRetry && !viaSsh) out.push(h('button.btn', { onclick: () => this.onRetry('browser') }, '이번만 브라우저로 보내기'));
    } else if (/^SSH_/.test(e.code || '')) {
      if (app.state.activeEnvId) out.push(h('button.btn.btn-primary', { onclick: () => app.openEnvironment(app.state.activeEnvId) }, icon('lock', 14), 'SSH 설정 열기'));
      out.push(h('button.btn', { onclick: () => { this.sub = 'timeline'; this.render(); } }, 'Terminal 보기'));
    } else {
      out.push(h('button.btn', { onclick: () => { this.sub = 'timeline'; this.render(); } }, r.engine === 'curl' ? 'Terminal 보기' : 'Timeline 보기'));
      if (r.engine === 'curl' && /^CURL_(51|60|35)$/.test(e.code) && this.onToggleInsecure) {
        out.push(h('button.btn', { onclick: () => this.onToggleInsecure() }, '-k (SSL 무시) 켜고 다시 실행'));
      }
    }
    return out;
  }

  /* ---------------- SSE (text/event-stream) ---------------- */
  // 받는 중인 화면: 상태, 이벤트 수·크기·시간, 멈춤 버튼, 이벤트 목록(맨 아래를 보고 있으면 따라 내려감)
  renderLive() {
    const s = this.live;
    const val = (k, v) => h('span.meta-item.static', h('span.meta-k', k), h('span.meta-v.plain', v));
    const count = val('이벤트', '0');
    const size = val('Size:', '0 B');
    const time = val('Time:', '0 ms');
    const status = h('span.status-pill.' + statusClass(s.status), `${s.status} ${s.statusText || STATUS_TEXT[s.status] || ''}`.trim());
    const meta = h('div.resp-meta',
      status,
      h('span.meta-tag.live-tag', { title: 'text/event-stream 응답을 받는 대로 보여 줍니다' }, h('span.live-dot'), '받는 중'),
      count, size, time,
      h('button.btn.btn-sm.sse-stop', { title: '스트림 받기를 멈춥니다. 그때까지 받은 내용이 응답으로 남습니다.', onclick: () => this.onCancel && this.onCancel() }, icon('stop', 13), '멈춤'));
    const list = h('div.sse-list');
    const box = h('div.body-content.sse-box', list);
    this.el.append(
      h('div.resp-head', h('div.subtabs', h('span.subtab.active', 'Events')), meta),
      h('div.resp-body', h('div.body-wrap',
        h('div.body-toolbar.sse-hint', '받는 대로 보여 줍니다. 멈추거나 서버가 끝내면 그때까지 받은 내용이 응답으로 남습니다.'),
        box)));
    // 이벤트가 뜸해도 시간은 1초마다 고친다
    this._live = { list, box, count, size, time, shown: 0, base: performance.now() - (s.elapsed || 0) };
    clearInterval(this._liveTick);
    this._liveTick = setInterval(() => {
      if (!this._live || !this.loading) return clearInterval(this._liveTick);
      this._live.time.lastChild.textContent = formatMs(performance.now() - this._live.base);
    }, 1000);
    this.updateLive();
  }

  updateLive() {
    const L = this._live;
    const s = this.live;
    if (!L || !s || !this.loading) return;
    const box = L.box;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const evs = s.events || [];
    const from = Math.max(L.shown, evs.length - LIVE_ROWS);
    if (from > L.shown) clear(L.list); // 한꺼번에 많이 왔으면 마지막 것만 다시 그림
    for (let i = from; i < evs.length; i++) L.list.appendChild(sseRow(evs[i]));
    while (L.list.childElementCount > LIVE_ROWS) L.list.firstElementChild.remove();
    L.shown = evs.length;
    L.count.lastChild.textContent = String(evs.length);
    L.size.lastChild.textContent = formatBytes(s.received || 0);
    L.time.lastChild.textContent = formatMs(performance.now() - L.base);
    if (!evs.length && !L.list.firstChild) L.list.appendChild(h('div.sse-empty', '아직 받은 이벤트가 없습니다.'));
    else if (evs.length) L.list.querySelector('.sse-empty')?.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  }

  // 끝난 응답의 스트림 정보. curl 로 받은 것 등 stream 이 없으면 본문에서 해석한다
  streamOf() {
    const r = this.result;
    if (!r || !r.ok) return null;
    if (r.stream) return r.stream;
    if (!isEventStream(r.contentType)) return null;
    if (!this._parsedStream) this._parsedStream = { kind: 'sse', end: 'closed', ...parseSse(this.decoded().text) };
    return this._parsedStream;
  }

  renderStreamBody(stream) {
    const r = this.result;
    const d = this.decoded();
    const mode = this.mode === 'raw' ? 'raw' : 'events';
    const toolbar = h('div.body-toolbar',
      h('div.seg', [['events', 'Events'], ['raw', 'Raw']].map(([id, label]) =>
        h('button.seg-btn' + (mode === id ? '.active' : ''), { onclick: () => { this.mode = id; this.render(); } }, label))),
      h('span.sse-summary',
        `이벤트 ${stream.events.length}개`,
        stream.duration != null ? ` · ${formatMs(stream.duration)}` : '',
        STREAM_END[stream.end] ? ` · ${STREAM_END[stream.end]}` : '',
        stream.comments ? ` · 주석 ${stream.comments}줄` : ''),
      h('div.flex1'),
      this.findButton(),
      h('button.icon-btn', { title: '본문 복사', onclick: () => this.copyBody() }, icon('copy', 16)),
      h('button.icon-btn', { title: '파일로 저장', onclick: () => this.saveToFile() }, icon('download', 16)));
    const content = h('div.body-content' + (mode === 'events' ? '.sse-box' : ''), { tabindex: '-1' });
    if (mode === 'raw') {
      // 받은 글 그대로 (찾기는 Raw 에서)
      this.bodyBox = content;
      this.code = new BodyCode(content, { onState: (s) => this.updateFindCount(s) });
      this.code.show(d.text, 'text', { wrap: true, lineNumbers: false });
      const wrapEl = h('div.body-wrap', toolbar, this.findOpen ? (this.findBarEl = this.findBar()) : null, content);
      this.bodyWrap = wrapEl;
      this.bodyAnchor = content;
      return wrapEl;
    } else if (!stream.events.length) {
      content.appendChild(h('div.body-empty', r.body.byteLength ? '이벤트로 끝난 내용이 없습니다. Raw 에서 받은 글을 볼 수 있습니다.' : '받은 내용이 없습니다.'));
    } else {
      const list = h('div.sse-list');
      stream.events.slice(0, MAX_EVENT_ROWS).forEach((ev) => list.appendChild(sseRow(ev)));
      content.appendChild(list);
      if (stream.events.length > MAX_EVENT_ROWS) content.appendChild(h('div.body-note', `이벤트가 많아 처음 ${MAX_EVENT_ROWS}개만 표시합니다. 전체는 Raw 나 파일로 저장해서 보세요.`));
    }
    if (stream.incomplete) {
      content.appendChild(h('div.body-note', '마지막 내용은 빈 줄로 끝나지 않아 이벤트로 치지 않았습니다: ' + stream.incomplete.slice(0, 200)));
    }
    return h('div.body-wrap', toolbar, content);
  }

  renderBody() {
    const stream = this.streamOf();
    if (stream) return this.renderStreamBody(stream);
    const d = this.decoded();
    const wrap = app.settings.wrapResponse;
    const lang = this.lang();
    const toolbar = h('div.body-toolbar');
    const modes = [['pretty', 'Pretty'], ['raw', 'Raw'], ['preview', 'Preview']];
    const seg = h('div.seg', modes.map(([id, label]) =>
      h('button.seg-btn' + (this.mode === id ? '.active' : ''), { onclick: () => { this.mode = id; this.render(); } }, label)));
    toolbar.appendChild(seg);
    if (this.mode === 'pretty' && d.isText) {
      const fmtBtn = h('button.btn.btn-sm.btn-ghost.fmt-btn', langLabel(lang), icon('chevronDown', 12));
      fmtBtn.addEventListener('click', () =>
        openMenu(fmtBtn, ['json', 'xml', 'html', 'javascript', 'text'].map((l) => ({
          label: langLabel(l),
          checked: l === lang,
          onClick: () => { this.format = l; this.render(); },
        })))
      );
      toolbar.appendChild(fmtBtn);
    }
    // JSONPath 필터 (JSON 을 Pretty 로 볼 때). 치는 동안에는 본문만 다시 그려 칸의 포커스를 지킨다
    if (this.filterable()) toolbar.appendChild(this.filterInput());
    toolbar.appendChild(h('div.flex1'));
    if (d.isText && this.mode !== 'preview' && this.result.body.byteLength) toolbar.appendChild(this.findButton());
    if (d.isText) {
      toolbar.appendChild(h('button.icon-btn' + (wrap ? '.on' : ''), {
        title: '줄 바꿈',
        onclick: () => {
          app.settings.wrapResponse = !app.settings.wrapResponse;
          app.store.save('settings');
          this.render();
        },
      }, icon('wrap', 16)));
    }
    toolbar.appendChild(h('button.icon-btn', { title: '본문 복사', onclick: () => this.copyBody() }, icon('copy', 16)));
    toolbar.appendChild(h('button.icon-btn', { title: '파일로 저장', onclick: () => this.saveToFile() }, icon('download', 16)));
    this.bodyBox = h('div.body-content', { tabindex: '-1' });
    this.filterSlot = h('div.filter-slot');
    this.bodyWrap = h('div.body-wrap', toolbar, this.findOpen ? (this.findBarEl = this.findBar()) : null, this.filterSlot, this.bodyBox);
    this.bodyAnchor = this.filterSlot;
    this.fillBody();
    return this.bodyWrap;
  }

  // 본문 칸과 필터 줄만 다시 그린다 (도구 막대·찾기 막대는 그대로)
  fillBody() {
    const r = this.result;
    const d = this.decoded();
    const content = this.bodyBox;
    if (this.code) this.code.destroy();
    this.code = null;
    clear(content);
    this.fillFilterBar();
    const f = this.filterResult();
    if (r.body.byteLength === 0) {
      content.appendChild(h('div.body-empty', r.opaqueRedirect ? '리다이렉트 응답입니다 (리다이렉트 자동 따라가기 꺼짐). Headers 탭에서 Location을 확인하세요.' : '응답 본문이 없습니다.'));
    } else if (this.mode === 'preview' || ((d.isImage || d.isPdf) && this.mode === 'pretty')) {
      content.appendChild(this.renderPreview(d));
    } else if (!d.isText) {
      content.appendChild(this.renderBinary(d));
    } else if (f && f.ok && !f.count) {
      content.appendChild(h('div.body-empty', `${this.filter.trim()} 에 맞는 값이 없습니다.`));
    } else {
      const raw = this.mode === 'raw' && !(f && f.ok);
      this.code = new BodyCode(content, { onState: (s) => this.updateFindCount(s) });
      this.code.show(this.displayText(), raw ? 'text' : f && f.ok ? 'json' : this.lang(), {
        wrap: raw ? true : app.settings.wrapResponse,
        lineNumbers: !raw,
        maxHighlight: app.settings.maxHighlightBytes || 1000000,
      });
      // 필터를 바꿔 본문만 다시 그린 때 (처음 그릴 때는 render 가 화면에 붙인 뒤에 찾는다)
      if (this.findOpen && this.findQuery && content.isConnected) this.runFind(true);
    }
  }

  lang() {
    const d = this.decoded();
    return this.format || (d.lang === 'binary' ? 'text' : d.lang);
  }

  // 보이는 글: 걸러 낸 결과, Raw 는 받은 글 그대로, 아니면 들여 쓴 글
  displayText() {
    const d = this.decoded();
    const f = this.filterResult();
    if (f && f.ok && f.count) return f.text;
    const lang = this.lang();
    return this.mode === 'raw' ? d.text : lang === d.lang ? d.pretty : reformat(d.text, lang);
  }

  /* ---------------- JSONPath 필터 ---------------- */
  filterable() {
    const r = this.result;
    if (!r || !r.ok || this.mode !== 'pretty' || this.streamOf()) return false;
    const d = this.decoded();
    return d.isText && this.lang() === 'json';
  }

  // 지금 필터의 결과 (같은 응답·같은 식이면 다시 계산하지 않음). 필터가 없으면 null
  filterResult() {
    const p = this.filter.trim();
    if (!p || !this.filterable()) return null;
    if (this._filter && this._filter.path === p && this._filter.result === this.result) return this._filter.value;
    let value;
    try {
      if (this._json === undefined) this._json = parseJson(this.decoded().text);
      value = filterJson(this._json, p);
    } catch (e) {
      value = { ok: false, error: '본문을 JSON 으로 읽지 못했습니다: ' + e.message };
    }
    this._filter = { path: p, result: this.result, value };
    return value;
  }

  filterInput() {
    const input = h('input.input.resp-filter', { value: this.filter, placeholder: '$.items[*].id 로 거르기', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'JSONPath 필터' });
    const apply = debounce(() => {
      if (input.value === this.filter) return;
      this.filter = input.value;
      this.fillBody();
    }, 250);
    input.addEventListener('input', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = '';
        this.filter = '';
        this.fillBody();
      }
    });
    return h('label.filter-box', { title: 'JSONPath 로 응답을 거릅니다 (Tests 탭과 같은 문법). 예: $.data.items[*].id · $..id · $.items[?(@.age > 10)]' }, icon('filter', 13), input);
  }

  fillFilterBar() {
    const slot = this.filterSlot;
    if (!slot) return;
    clear(slot);
    const f = this.filterResult();
    if (!f) return;
    const p = this.filter.trim();
    slot.appendChild(h('div.filter-bar',
      f.ok ? h('span.filter-count', f.count ? `결과 ${f.count}개` : '찾은 값이 없습니다') : h('span.filter-err', icon('alert', 13), f.error),
      f.ok ? h('span.filter-path.muted', p) : null,
      h('div.flex1'),
      f.ok && this.onAddTest ? h('button.btn.btn-sm.btn-ghost.filter-cap', { title: 'Tests 탭의 "변수로 꺼내기"에 이 경로를 넣습니다', onclick: () => this.onAddTest('extract', p, f) }, icon('plus', 13), '변수로 꺼내기') : null,
      f.ok && this.onAddTest ? h('button.btn.btn-sm.btn-ghost.filter-ast', { title: 'Tests 탭의 "확인"에 이 경로를 넣습니다 (값이 하나면 지금 값과 같은지)', onclick: () => this.onAddTest('assert', p, f) }, icon('check', 13), '확인 추가') : null,
      h('button.icon-btn.filter-clear', { title: '필터 지우기', onclick: () => { this.filter = ''; this.render(); } }, icon('x', 14))));
  }

  /* ---------------- 찾기 (Ctrl+F) ---------------- */
  findButton() {
    return h('button.icon-btn.find-btn' + (this.findOpen ? '.on' : ''), { title: '본문에서 찾기 (본문을 누른 뒤 Ctrl+F)', onclick: () => (this.findOpen ? this.closeFind() : this.openFind()) }, icon('search', 16));
  }

  findOpts() {
    return { caseSensitive: this.findCase, regex: this.findRe };
  }

  findBar() {
    const input = h('input.input.find-input', { value: this.findQuery, placeholder: '본문에서 찾기', spellcheck: 'false', autocomplete: 'off', 'aria-label': '본문에서 찾기' });
    const count = h('span.find-count');
    const later = debounce(() => this.runFind(), 150);
    input.addEventListener('input', () => {
      this.findQuery = input.value;
      later();
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const fresh = this.runFind(); // 막 친 글이면 찾기만 (첫 곳), 이미 찾았으면 다음·이전으로
        if (!fresh && this.code) this.code.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeFind();
      }
    });
    const toggle = (cls, title, label, on, flip) => {
      const b = h('button.icon-btn.find-tg.' + cls + (on ? '.on' : ''), { title, 'aria-pressed': on ? 'true' : 'false' }, label);
      b.addEventListener('click', () => {
        flip();
        const now = cls === 'find-case' ? this.findCase : this.findRe;
        b.classList.toggle('on', now);
        b.setAttribute('aria-pressed', now ? 'true' : 'false');
        this.runFind();
      });
      return b;
    };
    const bar = h('div.find-bar', icon('search', 14), input, count,
      h('button.icon-btn.find-prev', { title: '이전 (Shift+Enter)', onclick: () => this.code && this.code.step(-1) }, icon('chevronDown', 14, 'flip')),
      h('button.icon-btn.find-next', { title: '다음 (Enter)', onclick: () => this.code && this.code.step(1) }, icon('chevronDown', 14)),
      toggle('find-case', '대소문자 구분', 'Aa', this.findCase, () => { this.findCase = !this.findCase; }),
      toggle('find-re', '정규식 (줄마다 ^ $)', '.*', this.findRe, () => { this.findRe = !this.findRe; }),
      h('button.icon-btn.find-close', { title: '닫기 (Esc)', onclick: () => this.closeFind() }, icon('x', 14)));
    this.findInput = input;
    this.findCountEl = count;
    return bar;
  }

  /** 찾기 막대를 연다 (본문 탭·Pretty 또는 Raw 로). 열려 있으면 칸에 포커스만 */
  openFind() {
    const r = this.result;
    if (this.loading || !r || !r.ok || !r.body || !r.body.byteLength || !this.decoded().isText) return;
    let rebuild = false;
    if (this.sub !== 'body') {
      this.sub = 'body';
      rebuild = true;
    }
    if (this.streamOf() && this.mode !== 'raw') {
      this.mode = 'raw'; // SSE 는 Raw 에서 찾는다
      rebuild = true;
    } else if (this.mode === 'preview') {
      this.mode = 'pretty';
      rebuild = true;
    }
    this.findOpen = true;
    if (rebuild || !this.bodyWrap || !this.bodyWrap.isConnected) this.render();
    else if (!this.findBarEl) {
      this.findBarEl = this.findBar();
      this.bodyWrap.insertBefore(this.findBarEl, this.bodyAnchor);
      this.bodyWrap.querySelector('.find-btn')?.classList.add('on');
      if (this.findQuery) this.runFind(true);
    }
    if (this.findInput) {
      this.findInput.focus();
      this.findInput.select();
    }
  }

  closeFind() {
    this.findOpen = false;
    if (this.code) this.code.clearFind();
    if (this.findBarEl) this.findBarEl.remove();
    this.findBarEl = null;
    this.findInput = null;
    this.findCountEl = null;
    this.bodyWrap && this.bodyWrap.querySelector('.find-btn')?.classList.remove('on');
    if (this.bodyBox && this.bodyBox.isConnected) this.bodyBox.focus({ preventScroll: true });
  }

  /** 지금 찾는 글로 찾는다. 새로 찾았으면 true (같은 글·옵션이면 그대로 두고 false). force: 본문을 다시 그린 뒤 */
  runFind(force = false) {
    if (!this.code) return false;
    const before = this.code.find && this.code.find.key;
    if (force) this.code.find = null;
    const s = this.code.setFind(this.findQuery, this.findOpts());
    this.updateFindCount(s);
    return force || (this.code.find ? this.code.find.key : null) !== before;
  }

  updateFindCount(s) {
    const el = this.findCountEl;
    if (!el) return;
    el.classList.toggle('err', !!(s && s.error));
    if (!this.findQuery || !s) el.textContent = '';
    else if (s.error) el.textContent = s.error;
    else if (!s.total) el.textContent = '없음';
    else el.textContent = `${s.cur + 1}/${s.total}${s.capped ? '+' : ''}`;
  }

  // 응답 패널 안에서 Ctrl+F(맥은 Cmd+F)·F3: 본문에서 찾기 (다른 곳에서는 브라우저 찾기 그대로)
  onKey(e) {
    const k = String(e.key || '').toLowerCase();
    const isF = modKey(e) && !e.shiftKey && !e.altKey && k === 'f';
    if (!isF && e.key !== 'F3') return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]') && !(t.classList && t.classList.contains('find-input'))) return;
    if (this.loading || !this.result || !this.result.ok) return;
    e.preventDefault();
    if (e.key === 'F3' && this.findOpen && this.code) {
      this.code.step(e.shiftKey ? -1 : 1);
      return;
    }
    this.openFind();
  }

  /* ---------------- 비교 탭 (이전 응답·저장한 예제와) ---------------- */
  examples() {
    return this.tab ? app.examplesOf(this.tab) : [];
  }

  // 견줄 수 있는 응답: 이 탭에서 그 앞에 받은 응답, 이 요청에 저장한 예제
  diffChoices() {
    const out = [];
    if (!this.tab) return out;
    const prev = app.prevResponses.get(this.tab.id);
    if (prev && prev.ok && prev !== this.liveResult) {
      out.push({ id: 'prev', ref: prev, name: '이전 응답', label: `이전 응답 · ${clock(prev.receivedAt)} · ${statusLine(prev)} · ${formatBytes(prev.size && prev.size.body)}`, get: () => maskResult(prev, vault.secretValues()) });
    }
    for (const ex of this.examples()) {
      out.push({ id: ex.id, ref: ex, name: `예제 "${ex.name}"`, label: `예제 · ${ex.name} · ${ex.status || ''} · ${shortDate(ex.savedAt)}`, get: () => exampleAsResult(ex) });
    }
    return out;
  }

  canDiff() {
    const r = this.result;
    return !!(r && r.ok && !this.exampleView && this.tab && this.diffChoices().length);
  }

  diffOpts() {
    if (!this.tab.respDiff) this.tab.respDiff = { against: null, ignoreBody: '', ignoreHeaders: '' };
    return this.tab.respDiff;
  }

  // 고른 기준과 그 상태 열쇠 (기준·이름·뺄 곳이 같으면 같은 열쇠)
  diffState() {
    const choices = this.diffChoices();
    if (!choices.length) return null;
    const o = this.diffOpts();
    const pick = choices.find((c) => c.id === o.against) || choices[0];
    return { o, pick, key: `${pick.id}\u0000${pick.ref && pick.ref.name}\u0000${o.ignoreBody}\u0000${o.ignoreHeaders}` };
  }

  cachedDiff(st) {
    const c = this._diff;
    return c && c.result === this.result && c.ref === st.pick.ref && c.key === st.key ? c : null;
  }

  // 지금 응답과 고른 기준을 견준다 (같은 응답·기준·뺄 곳이면 다시 계산하지 않음)
  diffNow() {
    const st = this.diffState();
    if (!st) return null;
    const hit = this.cachedDiff(st);
    if (hit) return hit;
    const { o, pick } = st;
    const base = pick.get();
    const cur = maskResult(this.result, vault.secretValues()); // 기준(가린 예제·이전 응답)과 같은 방식으로 가려서 견준다
    const diff = compareResults(base, cur, { ignoreBody: ignoreLines(o.ignoreBody), ignoreHeaders: ignoreLines(o.ignoreHeaders) });
    this._diff = { result: this.result, ref: pick.ref, key: st.key, pick, base, cur, diff };
    return this._diff;
  }

  // 비교 탭에 붙일 다른 곳 수 — 두 본문이 작을 때만 바로 센다 (크면 탭을 열 때)
  diffCount() {
    const st = this.diffState();
    if (!st) return null;
    const hit = this.cachedDiff(st);
    if (hit) return hit.diff.count;
    const SMALL = 512 * 1024;
    const ref = st.pick.ref;
    const baseSize = ref && ref.body && ref.body.byteLength != null ? ref.body.byteLength : (ref && ref.size) || 0;
    if (this.result.body.byteLength > SMALL || baseSize > SMALL) return null;
    return this.diffNow().diff.count;
  }

  renderDiff() {
    const d = this.diffNow();
    const o = this.diffOpts();
    const choices = this.diffChoices();
    const sel = h('select.select.select-sm.rd-against', { 'aria-label': '견줄 응답' },
      choices.map((c) => h('option', { value: c.id, selected: c.id === d.pick.id }, c.label)));
    sel.addEventListener('change', () => {
      o.against = sel.value;
      app.saveWorkspace();
      this.render();
    });
    const nIgnore = ignoreLines(o.ignoreBody).length + ignoreLines(o.ignoreHeaders).length;
    const seg = h('div.seg.cmp-mode',
      [['list', '차이 목록'], ['side', '본문 나란히']].map(([id, label]) =>
        h('button.seg-btn' + (this.diffMode === id ? '.active' : ''), { onclick: () => { this.diffMode = id; this.render(); } }, label)));
    const ignoreBtn = h('button.btn.btn-sm.rd-ignore', {
      title: '견주지 않을 본문 경로·머리글',
      onclick: () => editIgnoreDialog({
        ignoreBody: o.ignoreBody,
        ignoreHeaders: o.ignoreHeaders,
        onSave: (v) => {
          o.ignoreBody = v.ignoreBody;
          o.ignoreHeaders = v.ignoreHeaders;
          app.saveWorkspace();
          this.render();
        },
      }),
    }, icon('settings', 13), nIgnore ? `뺄 곳 ${nIgnore}` : '뺄 곳');
    const bar = h('div.rd-bar', h('span.rd-label', '견줄 응답'), sel, h('div.flex1'), ignoreBtn, seg);
    const a = { name: d.pick.name, result: d.base };
    const b = { name: '지금 응답', result: d.cur };
    let view;
    if (this.diffMode === 'side') {
      const v = diffSideView({ a, b, diff: d.diff, ignoreBody: ignoreLines(o.ignoreBody) });
      this.diffGrid = v.grid;
      view = v.el;
    } else {
      view = diffListView({
        a, b, diff: d.diff,
        onIgnore: (kind, text) => this.addDiffIgnore(kind, text),
        onJump: (path) => {
          this.diffMode = 'side';
          this.render();
          flashPath(this.diffGrid, path);
        },
      });
    }
    return h('div.rd-wrap', bar, h('div.rd-body', view),
      h('div.rd-foot.muted', '비밀 변수 값·Set-Cookie 값·인증 머리글 값은 두 쪽 모두 가린 채로 견줍니다. 날짜·요청 ID 같은 머리글은 견주지 않습니다.'));
  }

  addDiffIgnore(kind, text) {
    const o = this.diffOpts();
    const k = kind === 'headers' ? 'ignoreHeaders' : 'ignoreBody';
    const cur = ignoreLines(o[k]);
    if (!cur.includes(text)) o[k] = [...cur, text].join('\n');
    app.saveWorkspace();
    toast(`"${text}" 은 이제 견주지 않습니다. [뺄 곳]에서 되돌릴 수 있습니다.`, 'info', 3000);
    this.render();
  }

  /* ---------------- 응답 예제 ---------------- */
  examplesButton(exs) {
    const b = h('button.btn.btn-sm.btn-ghost.resp-examples', { title: '이 요청에 저장한 응답 예제' }, icon('file', 14), `예제 ${exs.length}`, icon('chevronDown', 12));
    b.addEventListener('click', () => {
      const live = this.liveResult && this.liveResult.ok;
      openMenu(b, [
        { header: '저장한 예제' },
        ...exs.map((ex) => ({ label: ex.name, hint: `${ex.status || ''} · ${shortDate(ex.savedAt)}`, checked: !!(this.exampleView && this.exampleView.id === ex.id), onClick: () => this.showExample(ex) })),
        live ? { divider: true } : null,
        live ? { label: '지금 응답을 예제로 저장…', icon: 'plus', onClick: () => this.saveAsExample() } : null,
      ], { alignRight: true, minWidth: 240 });
    });
    return b;
  }

  exampleBanner() {
    const ex = this.exampleView;
    const live = !!(this.liveResult && this.liveResult.ok);
    return h('div.ex-banner',
      icon('file', 14),
      h('span.ex-tag', '예제'),
      h('b.ex-name', ex.name),
      ex.savedAt ? h('span.ex-when', `${fullDate(ex.savedAt)} 저장`) : null,
      ex.request ? h('span.ex-req', { title: ex.request.url }, `${ex.request.method} ${ex.request.url}`) : null,
      h('div.flex1'),
      live ? h('button.btn.btn-sm.ex-compare', { title: '받은 응답과 이 예제를 비교 탭에서 견줍니다', onclick: () => this.compareWithExample(ex) }, icon('compare', 13), '지금 응답과 비교') : null,
      h('button.btn.btn-sm.ex-rename', { onclick: () => this.renameExample(ex) }, icon('edit', 13), '이름 바꾸기'),
      h('button.btn.btn-sm.ex-delete', { onclick: () => this.deleteExample(ex) }, icon('trash', 13), '지우기'),
      h('button.btn.btn-sm.ex-close', { title: live ? '받은 응답으로 돌아가기' : '예제 닫기', onclick: () => this.backToResponse() }, icon('x', 13), live ? '응답으로' : '닫기'));
  }

  compareWithExample(ex) {
    const o = this.diffOpts();
    o.against = ex.id;
    app.saveWorkspace();
    this.exampleView = null;
    this.sub = 'diff';
    this.display(this.liveResult);
  }

  /** 받은 응답을 이 요청의 예제로 저장한다. 저장하지 않은 요청이면 요청부터 저장할지 묻는다 */
  async saveAsExample() {
    const r = this.liveResult;
    const problem = exampleProblem(r);
    if (problem) return void toast(problem, 'error', 4000);
    if (!this.tab) return;
    if (!this.tab.itemId) {
      const ok = await confirmDialog({
        title: '요청을 먼저 저장할까요?',
        message: '예제는 컬렉션에 저장한 요청에 붙습니다. 이 요청을 컬렉션에 저장한 다음, 받은 응답을 예제로 저장합니다.',
        okText: '요청 저장',
      });
      if (!ok) return;
      const saved = await app.saveTab(this.tab);
      if (!saved || !this.tab.itemId) return;
    }
    const name = await promptDialog({ title: '응답을 예제로 저장', label: '예제 이름', value: statusLine(r), okText: '저장' });
    if (name == null) return;
    try {
      const { example, masked } = app.saveExample(this.tab, r, name);
      toast(`예제 "${example.name}"을(를) 저장했습니다.${masked.length ? ` ${masked.join(' · ')}은 가렸습니다.` : ''}`, 'success', masked.length ? 4500 : 2600);
      this.render();
    } catch (e) {
      toast(e.message, 'error', 4000);
    }
  }

  async renameExample(ex) {
    const name = await promptDialog({ title: '예제 이름 바꾸기', label: '예제 이름', value: ex.name, okText: '바꾸기' });
    if (name == null || !name.trim()) return;
    app.renameExample(this.tab.itemId, ex.id, name);
    this.render();
  }

  async deleteExample(ex) {
    const ok = await confirmDialog({ title: '예제를 지울까요?', message: `"${ex.name}" 예제를 지웁니다. 되돌릴 수 없습니다.`, okText: '지우기', danger: true });
    if (!ok) return;
    app.deleteExample(this.tab.itemId, ex.id);
    if (this.tab.respDiff && this.tab.respDiff.against === ex.id) this.tab.respDiff.against = null;
    this.backToResponse();
  }

  renderPreview(d) {
    const r = this.result;
    if (d.isImage || d.isPdf) {
      if (!this.blobUrl) this.blobUrl = URL.createObjectURL(new Blob([r.body], { type: d.isPdf ? 'application/pdf' : r.contentType.split(';')[0].trim() }));
      if (d.isImage) return h('div.preview-img', h('img', { src: this.blobUrl, alt: 'response image' }));
      return h('iframe.preview-frame', { src: this.blobUrl });
    }
    if (d.isText) {
      // 스크립트 실행 없이 HTML 렌더링
      const frame = h('iframe.preview-frame', { sandbox: '', referrerpolicy: 'no-referrer' });
      if (d.lang === 'html' || d.lang === 'xml') frame.srcdoc = d.text;
      else frame.srcdoc = `<pre style="white-space:pre-wrap;font:13px/1.5 monospace;margin:12px">${escapeHtml(d.pretty)}</pre>`;
      return frame;
    }
    return this.renderBinary(d);
  }

  renderBinary() {
    const r = this.result;
    return h('div.body-empty',
      h('div', `바이너리 응답 (${r.contentType || 'unknown'}, ${formatBytes(r.body.byteLength)})`),
      h('button.btn.btn-sm', { onclick: () => this.saveToFile() }, icon('download', 14), '파일로 저장'));
  }

  renderHeaders() {
    const r = this.result;
    const rows = r.headers.map((x) =>
      h('div.ht-row', h('div.ht-k', x.name), h('div.ht-v', x.value)));
    return h('div.ht-wrap',
      h('div.ht', h('div.ht-row.ht-head', h('div.ht-k', 'Key'), h('div.ht-v', 'Value')), rows),
      h('div.ht-foot', h('button.link-btn', { onclick: () => copyText(r.headers.map((x) => `${x.name}: ${x.value}`).join('\n')).then(() => toast('복사했습니다.', 'success')) }, '전체 복사')));
  }

  renderCookies() {
    const r = this.result;
    if (!r.setCookies.length) {
      return h('div.body-empty', h('div', '응답에 Set-Cookie가 없습니다.'),
        h('button.link-btn', { onclick: () => app.ui.openCookieManager() }, '쿠키 관리자 열기'));
    }
    const cookies = r.setCookies.map((s) => parseSetCookie(s, r.url) || { name: s, value: '', domain: '', path: '' });
    const head = h('div.ct-row.ct-head', ['Name', 'Value', 'Domain', 'Path', 'Expires', 'HttpOnly', 'Secure'].map((x) => h('div', x)));
    const rows = cookies.map((c) =>
      h('div.ct-row',
        h('div', c.name), h('div.ct-val', c.value), h('div', c.domain), h('div', c.path),
        h('div', c.expires == null ? 'Session' : c.expires === 0 ? '삭제됨' : new Date(c.expires).toLocaleString('ko-KR')),
        h('div', c.httpOnly ? 'true' : 'false'), h('div', c.secure ? 'true' : 'false')));
    return h('div.ct-wrap',
      h('div.ct', head, rows),
      h('div.ht-foot', app.settings.autoSaveCookies ? '이 쿠키들은 쿠키 관리자에 자동 저장되어 같은 도메인 요청에 사용됩니다. ' : '쿠키 자동 저장이 꺼져 있습니다. ',
        h('button.link-btn', { onclick: () => app.ui.openCookieManager() }, '쿠키 관리자 열기')));
  }

  renderTerminal() {
    const r = this.result;
    const t = r.terminal || {};
    const box = h('div.timeline.term-wrap');
    (r.warnings || []).forEach((w) => box.appendChild(h('div.tl-warn', icon('alert', 14), w)));
    const pre = h('pre.term');
    const add = (text, cls) => {
      if (!text) return;
      pre.appendChild(cls ? h('span.' + cls, text) : document.createTextNode(text));
    };
    if (t.ssh) {
      // SSH 터널: 터미널에서 직접 재현할 수 있는 형태로 표시
      const s = t.ssh;
      add(`# SSH 터널${s.label ? ' (' + s.label + ')' : ''}: ${s.user}@${s.host}:${s.port}` +
        (s.failed ? ' - 연결 실패' : s.reused ? ' · 열어 둔 연결을 다시 씀' : ` · 연결 ${formatMs(s.connectMs || 0)}`) + '\n', s.failed ? 'term-err' : 'term-info');
      add(`$ ssh -N -D 127.0.0.1:${s.socksPort || 1080} -p ${s.port} ${s.user}@${s.host}\n`, 'term-cmd');
      redact(String(s.log || '')).split(/\r?\n/).filter((l) => l.trim()).forEach((l) => add(l + '\n', s.failed ? 'term-err' : 'term-info'));
      if (s.failed) {
        if (r.error) add(`\n${r.error.message}\n`, 'term-err');
      } else {
        add(`$ curl --socks5-hostname 127.0.0.1:${s.socksPort} ` + redact(String(t.command || 'curl').replace(/^curl\s+/, '')) + '\n', 'term-cmd');
      }
    } else add('$ ' + redact(t.command || 'curl') + '\n', 'term-cmd');
    const stderr = redact(String(t.stderr || '')); // curl -v 의 "> Authorization: …" 같은 보낸 머리글도 가린다
    stderr.split('\n').forEach((line, i, arr) => {
      if (i === arr.length - 1 && line === '') return;
      const cls = line.startsWith('> ') || line === '>' ? 'term-req' : line.startsWith('< ') || line === '<' ? 'term-res' : line.startsWith('* ') ? 'term-info' : line.startsWith('curl: ') ? 'term-err' : null;
      add(line + '\n', cls);
    });
    if (r.ok && t.include && t.headersText) add(t.headersText.replace(/\r\n/g, '\n'), 'term-hdr');
    if (r.ok && r.body && r.body.byteLength) {
      const d = this.decoded();
      if (d.isText) {
        const LIMIT = 200000;
        add(d.text.length > LIMIT ? d.text.slice(0, LIMIT) + `\n… (${formatBytes(r.body.byteLength)} 중 일부만 표시)` : d.text);
        if (!d.text.endsWith('\n')) add('\n');
      } else add(`[바이너리 ${formatBytes(r.body.byteLength)} - Body 탭에서 저장]\n`, 'term-info');
    }
    if (t.exitCode != null) add(`\n[종료 코드 ${t.exitCode}]`, t.exitCode === 0 ? 'term-ok' : 'term-err');
    box.appendChild(h('div.term-bar',
      h('span', icon('terminal', 14), 'curl 출력'),
      h('span.muted', t.curlPath || ''),
      h('div.flex1'),
      !t.verbose ? h('span.muted.term-tip', '요청/응답 상세를 보려면 cURL 탭에서 -v 를 켜세요') : null,
      h('button.btn.btn-sm', { onclick: () => copyText(pre.textContent).then(() => toast('터미널 출력을 복사했습니다.', 'success')) }, icon('copy', 13), '출력 복사'),
      h('button.btn.btn-sm', {
        onclick: () => {
          const cmd = redact(t.command || '');
          const hid = cmd !== (t.command || '');
          copyText(cmd).then(() => toast(hid ? '명령을 복사했습니다 · 비밀 값은 가렸습니다 (값까지 든 명령은 코드 창의 "비밀 값 넣기")' : '명령을 복사했습니다.', 'success', hid ? 4500 : 2600));
        },
      }, icon('copy', 13), '명령 복사')));
    box.appendChild(pre);
    return box;
  }

  renderTimeline() {
    const r = this.result;
    if (r.engine === 'curl') return this.renderTerminal();
    const box = h('div.timeline');
    (r.warnings || []).forEach((w) => box.appendChild(h('div.tl-warn', icon('alert', 14), w)));
    const hops = r.hops || [];
    if (!hops.length) {
      box.appendChild(h('div.tl-block', h('div.tl-line.req', `${r.method} ${r.sentUrl}`), h('div.muted', '네트워크 상세 정보를 수집하지 못했습니다.')));
    }
    hops.forEach((hop, i) => {
      const u = safeUrl(hop.url);
      const lines = [];
      lines.push(h('div.tl-line.req', `${hop.method} ${u ? u.pathname + u.search : hop.url} HTTP/1.1`));
      if (u) lines.push(h('div.tl-hdr', h('span.tl-k', 'Host: '), u.host));
      (hop.requestHeaders || []).forEach((x) => lines.push(h('div.tl-hdr', h('span.tl-k', x.name + ': '), maskValue(x.name, x.value))));
      if (i === 0 && r.requestBodyPreview) {
        lines.push(h('div.tl-body', r.requestBodyPreview));
      }
      if (hop.statusLine) {
        lines.push(h('div.tl-line.res.' + statusClass(hop.statusCode), hop.statusLine));
        (hop.responseHeaders || []).forEach((x) => lines.push(h('div.tl-hdr', h('span.tl-k', x.name + ': '), x.value)));
      }
      if (hop.redirectUrl) lines.push(h('div.tl-redirect', `↪ ${hop.redirectUrl} 로 리다이렉트`));
      box.appendChild(h('div.tl-block', h('div.tl-title', hops.length > 1 ? `요청 ${i + 1} / ${hops.length}` : '요청 / 응답'), lines));
    });
    if (r.ok) {
      box.appendChild(h('div.tl-meta',
        h('span', `원격 주소: ${r.remoteIp || '-'}`),
        h('span', `총 ${formatMs(r.timing.total)}`),
        h('span', `본문 ${formatBytes(r.size.body)}`)));
    } else if (r.error) {
      box.appendChild(h('div.tl-block', h('div.tl-line.res.s-err', r.error.message), r.error.hint ? h('div.muted', r.error.hint) : null));
    }
    box.appendChild(h('div.tl-foot', '브라우저가 자동으로 추가하는 헤더(Accept-Language, Sec-* 등)도 표시됩니다. Host / Content-Length / Connection 은 네트워크 계층에서 추가됩니다.'));
    return box;
  }

  // 보이는 것을 복사한다: 걸러 냈으면 걸러 낸 결과 (파일로 저장은 늘 받은 본문 그대로)
  copyBody() {
    const d = this.decoded();
    const f = this.filterResult();
    if (f && f.ok && f.count) return void copyText(f.text).then((ok) => toast(ok ? '걸러 낸 결과를 복사했습니다.' : '복사 실패', ok ? 'success' : 'error'));
    copyText(this.mode === 'raw' ? d.text : d.pretty).then((ok) => toast(ok ? '응답 본문을 복사했습니다.' : '복사 실패', ok ? 'success' : 'error'));
  }

  saveToFile() {
    const r = this.result;
    const d = this.decoded();
    const ext = { json: 'json', xml: 'xml', html: 'html', javascript: 'js', text: 'txt' }[d.lang] || (r.contentType.split('/')[1] || 'bin').split(';')[0];
    let name = 'response.' + ext;
    const cd = (r.headers.find((x) => x.name.toLowerCase() === 'content-disposition') || {}).value;
    const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch (e) {
        name = m[1];
      }
    }
    download(name, new Blob([r.body], { type: r.contentType || 'application/octet-stream' }));
  }
}

// SSE 이벤트 한 줄: 번호, 받은 시각(스트림 시작 기준), event 이름, data, id. JSON 인 data 는 눌러서 펼친다
function sseRow(ev) {
  const data = String(ev.data ?? '');
  const json = /^\s*[[{]/.test(data);
  const row = h('div.sse-row' + (json ? '.json' : ''),
    h('span.sse-n', String(ev.n)),
    h('span.sse-t', ev.t == null ? '' : '+' + formatMs(ev.t)),
    h('span.sse-type' + (ev.type === 'message' ? '.dim' : ''), ev.type),
    h('span.sse-data', data.length > 4000 ? data.slice(0, 4000) + '…' : data),
    ev.id ? h('span.sse-id', { title: 'id' }, ev.id) : h('span.sse-id'));
  if (json) {
    row.title = '눌러서 JSON 펼치기';
    row.addEventListener('click', () => {
      if (String(window.getSelection ? window.getSelection() : '')) return; // 글자를 고르는 중이면 펼치지 않음
      const open = row.classList.toggle('open');
      row.querySelector('.sse-json')?.remove();
      if (!open) return;
      let pretty = data;
      try {
        pretty = formatJson(data, 2);
      } catch (e) {
        /* JSON 이 아니면 그대로 */
      }
      row.appendChild(h('pre.sse-json', pretty));
    });
  }
  return row;
}

// 시각 표시: 받은 시각(14:02:11), 예제를 저장한 날(11-27 14:02 · 해가 다르면 2025-11-27)
const pad2 = (n) => String(n).padStart(2, '0');
function clock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const day = d.getFullYear() === new Date().getFullYear() ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fullDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function reformat(text, lang) {
  if (lang === 'json') {
    try {
      return formatJson(text, 2);
    } catch (e) {
      return text;
    }
  }
  if (lang === 'xml' || lang === 'html') return prettyXml(text);
  return text;
}

export function prettyXml(xml) {
  const src = String(xml).trim();
  if (!src.startsWith('<')) return xml;
  // 이미 줄바꿈이 충분하면 그대로
  if (src.split('\n').length > src.length / 200) return xml;
  const VOID = /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i;
  const tokens = src.replace(/>\s+</g, '><').split(/(<[^>]+>)/g).filter((t) => t.trim() !== '');
  let indent = 0;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^<\//.test(t)) {
      indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + t);
    } else if (/^<[^!?][^>]*[^/]>$/.test(t) && !VOID.test(t)) {
      // 여는 태그 + 짧은 텍스트 + 닫는 태그 는 한 줄로
      const next = tokens[i + 1];
      const close = tokens[i + 2];
      if (next && !next.startsWith('<') && close && /^<\//.test(close)) {
        out.push('  '.repeat(indent) + t + next.trim() + close);
        i += 2;
      } else {
        out.push('  '.repeat(indent) + t);
        indent++;
      }
    } else {
      out.push('  '.repeat(indent) + t.trim());
    }
  }
  return out.join('\n');
}

function langLabel(l) {
  return { json: 'JSON', xml: 'XML', html: 'HTML', javascript: 'JavaScript', text: 'Text' }[l] || l;
}

function safeUrl(u) {
  try {
    return new URL(u);
  } catch (e) {
    return null;
  }
}

// 타임라인의 보낸 머리글: 비밀 변수의 값(Basic 인증 안에 싼 것 포함)을 가린다
function maskValue(name, value) {
  return redact(value);
}

function emptyIllustration() {
  const el = h('div.resp-illu');
  el.innerHTML = `<svg width="120" height="90" viewBox="0 0 120 90" fill="none"><rect x="14" y="10" width="92" height="64" rx="8" stroke="currentColor" stroke-width="2" opacity=".35"/><path d="M14 24h92" stroke="currentColor" stroke-width="2" opacity=".35"/><circle cx="23" cy="17" r="2" fill="currentColor" opacity=".35"/><circle cx="30" cy="17" r="2" fill="currentColor" opacity=".35"/><path d="M40 44l-8 6 8 6M80 44l8 6-8 6M66 38l-12 24" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return el;
}
