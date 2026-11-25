// 응답 패널
import { h, clear, formatBytes, formatMs, statusClass, guessLanguage, isTextContentType, copyText, download, escapeHtml, STATUS_TEXT } from '../util.js';
import { codeView } from './code-editor.js';
import { icon } from './icons.js';
import { openMenu, popover, toast } from './overlay.js';
import { parseSetCookie } from '../cookiejar.js';
import { formatJson } from '../json-format.js';
import { isEventStream, parseSse } from '../sse.js';
import { describeAssert } from '../checks.js';
import { app } from '../app.js';

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
  constructor() {
    this.sub = 'body';
    this.mode = 'pretty'; // pretty | raw | preview (SSE 응답은 Events | Raw)
    this.format = null; // null = auto
    this.el = h('div.resp');
    this.result = null;
    this.loading = false;
    this.live = null; // 받는 중인 SSE 스트림 (http.js onStream)
    this.blobUrl = null;
    this.render();
  }

  destroy() {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    clearTimeout(this._liveTimer);
    clearInterval(this._liveTick);
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

  show(result) {
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
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    if (result && !result.ok) this.sub = this.sub === 'timeline' ? 'timeline' : 'body';
    this.render();
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
      this.el.appendChild(
        h('div.resp-empty',
          emptyIllustration(),
          h('div.resp-empty-title', 'URL을 입력하고 Send를 눌러 응답을 확인하세요'),
          h('div.resp-empty-sub', 'cURL 명령을 URL 입력창에 붙여넣으면 자동으로 변환됩니다'))
      );
      return;
    }
    if (this.sub === 'tests' && !r.checks) this.sub = 'body';
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
    else if (this.sub === 'timeline') body.appendChild(this.renderTimeline());
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
            h('div.ck-desc', h('b', x.name), x.ok ? ' = ' : '', x.ok ? h('span.ck-val', x.value.length > 300 ? x.value.slice(0, 300) + '…' : x.value) : ''),
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
    tabs.push(['timeline', r.engine === 'curl' ? 'Terminal' : 'Timeline']);
    const tabEls = tabs.map(([id, label, count, cls = '']) =>
      h('button.subtab' + (this.sub === id ? '.active' : ''), { onclick: () => { this.sub = id; this.render(); } },
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
      const save = h('button.btn.btn-sm.btn-ghost', { title: '응답 저장' }, icon('download', 14), '저장', icon('chevronDown', 12));
      save.addEventListener('click', () =>
        openMenu(save, [
          { label: '파일로 저장', icon: 'download', onClick: () => this.saveToFile() },
          { label: '본문 복사', icon: 'copy', onClick: () => this.copyBody() },
          { label: '응답 헤더 복사', icon: 'copy', onClick: () => copyText(r.headers.map((x) => `${x.name}: ${x.value}`).join('\n')).then(() => toast('복사했습니다.', 'success')) },
        ], { alignRight: true })
      );
      meta.appendChild(save);
    } else {
      meta.appendChild(h('span.status-pill.s-err', 'Error'));
      if (r.engine === 'curl') meta.appendChild(h('span.meta-tag.curl-tag', 'cURL'));
      if (r.timing && r.timing.total != null) meta.appendChild(h('span.meta-item', h('span.meta-k', 'Time:'), h('span.meta-v.plain', formatMs(r.timing.total))));
    }
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
      h('button.icon-btn', { title: '본문 복사', onclick: () => this.copyBody() }, icon('copy', 16)),
      h('button.icon-btn', { title: '파일로 저장', onclick: () => this.saveToFile() }, icon('download', 16)));
    const content = h('div.body-content' + (mode === 'events' ? '.sse-box' : ''));
    if (mode === 'raw') {
      content.appendChild(codeView(d.text, 'text', { wrap: true, lineNumbers: false }));
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
    const r = this.result;
    const stream = this.streamOf();
    if (stream) return this.renderStreamBody(stream);
    const d = this.decoded();
    const wrap = app.settings.wrapResponse;
    const lang = this.format || (d.lang === 'binary' ? 'text' : d.lang);
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
    toolbar.appendChild(h('div.flex1'));
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
    const content = h('div.body-content');
    if (r.body.byteLength === 0) {
      content.appendChild(h('div.body-empty', r.opaqueRedirect ? '리다이렉트 응답입니다 (리다이렉트 자동 따라가기 꺼짐). Headers 탭에서 Location을 확인하세요.' : '응답 본문이 없습니다.'));
    } else if (this.mode === 'preview' || ((d.isImage || d.isPdf) && this.mode === 'pretty')) {
      content.appendChild(this.renderPreview(d));
    } else if (!d.isText) {
      content.appendChild(this.renderBinary(d));
    } else {
      const text = this.mode === 'raw' ? d.text : lang === d.lang ? d.pretty : reformat(d.text, lang);
      const maxHl = app.settings.maxHighlightBytes || 1000000;
      const MAX_RENDER = 5 * 1024 * 1024;
      let shown = text;
      let truncated = false;
      if (shown.length > MAX_RENDER) {
        shown = shown.slice(0, MAX_RENDER);
        truncated = true;
      }
      content.appendChild(codeView(shown, this.mode === 'raw' ? 'text' : lang, { wrap: this.mode === 'raw' ? true : wrap, maxHighlight: maxHl, lineNumbers: this.mode !== 'raw' }));
      if (truncated) content.appendChild(h('div.body-note', `응답이 커서 처음 ${formatBytes(MAX_RENDER)}만 표시합니다. 전체는 파일로 저장하세요.`));
    }
    return h('div.body-wrap', toolbar, content);
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
        (s.failed ? ' - 연결 실패' : ` · 연결 ${formatMs(s.connectMs || 0)}`) + '\n', s.failed ? 'term-err' : 'term-info');
      add(`$ ssh -N -D 127.0.0.1:${s.socksPort || 1080} -p ${s.port} ${s.user}@${s.host}\n`, 'term-cmd');
      String(s.log || '').split(/\r?\n/).filter((l) => l.trim()).forEach((l) => add(l + '\n', s.failed ? 'term-err' : 'term-info'));
      if (s.failed) {
        if (r.error) add(`\n${r.error.message}\n`, 'term-err');
      } else {
        add(`$ curl --socks5-hostname 127.0.0.1:${s.socksPort} ` + String(t.command || 'curl').replace(/^curl\s+/, '') + '\n', 'term-cmd');
      }
    } else add('$ ' + (t.command || 'curl') + '\n', 'term-cmd');
    const stderr = String(t.stderr || '');
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
      h('button.btn.btn-sm', { onclick: () => copyText(t.command || '').then(() => toast('명령을 복사했습니다.', 'success')) }, icon('copy', 13), '명령 복사')));
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

  copyBody() {
    const d = this.decoded();
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

function looksTextual(bytes) {
  const n = Math.min(bytes.length, 512);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n < 0.05;
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

function maskValue(name, value) {
  return value;
}

function emptyIllustration() {
  const el = h('div.resp-illu');
  el.innerHTML = `<svg width="120" height="90" viewBox="0 0 120 90" fill="none"><rect x="14" y="10" width="92" height="64" rx="8" stroke="currentColor" stroke-width="2" opacity=".35"/><path d="M14 24h92" stroke="currentColor" stroke-width="2" opacity=".35"/><circle cx="23" cy="17" r="2" fill="currentColor" opacity=".35"/><circle cx="30" cy="17" r="2" fill="currentColor" opacity=".35"/><path d="M40 44l-8 6 8 6M80 44l8 6-8 6M66 38l-12 24" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return el;
}
