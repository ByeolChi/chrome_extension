// 응답 둘의 차이 보기 — 환경 비교 탭과 응답의 비교 탭이 같이 쓴다
//   a: 기준 { name, result }, b: 견줄 쪽 { name, result }, diff: compareResults(a.result, b.result) 결과
import { h, formatBytes, STATUS_TEXT } from '../util.js';
import { icon } from './icons.js';
import { openModal } from './overlay.js';
import { makeIgnore, prettyJsonLines, sideBySide, lineHunks, showValue, ignorePathOf, DEFAULT_IGNORE_HEADERS } from '../compare.js';
import { responseContext } from '../checks.js';

export const SIDE_LIMIT = 4000; // 나란히 보기에서 한쪽에 펴는 줄 수
export const LIST_LIMIT = 300; // 차이 목록에 보여 줄 줄 수 (본문)

export const statusLine = (r) => `${r.status} ${r.statusText || STATUS_TEXT[r.status] || ''}`.trim();
export const ignoreLines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/**
 * 차이 목록: 상태 코드, 응답 머리글, 본문(JSON 은 경로마다, 글은 줄마다)
 * onIgnore(kind: 'headers'|'body', text): 그 자리를 뺄 곳에 더함, onJump(path): 나란히 보기의 그 자리로
 */
export function diffListView({ a, b, diff, onIgnore, onJump }) {
  const A = a.name;
  const B = b.name;
  const out = h('div.cmp-list');
  if (diff.same) {
    out.append(h('div.cmp-same', icon('check', 16), `${A} · ${B} 응답이 같습니다`, h('span.muted', ' (뺀 곳은 견주지 않음)')));
  }
  // 상태 코드
  out.append(h('div.cmp-sec',
    h('div.cmp-sec-head', '상태 코드', diff.status ? h('span.cmp-ok', '같음') : h('span.cmp-bad', '다름')),
    diff.status ? null : h('div.cmp-kv', h('span.cmp-old', statusLine(a.result)), h('span.cmp-arrow', '→'), h('span.cmp-new', statusLine(b.result)))));
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
        h('td.cmp-act', h('button.link-btn', { title: '이 머리글은 견주지 않기', onclick: () => onIgnore('headers', x.name) }, '빼기')))))) : null));
  // 본문
  const bd = diff.body;
  const bodyHead = h('div.cmp-sec-head', '본문',
    bd.mode === 'json' ? h('span.cmp-tag', 'JSON · 경로마다') : bd.mode === 'text' ? h('span.cmp-tag', '글 · 줄마다') : h('span.cmp-tag', '바이너리'),
    bd.count ? h('span.cmp-bad', bd.mode === 'json' ? `다른 곳 ${bd.count}${bd.truncated ? '+' : ''}개` : bd.mode === 'text' && !bd.tooBig ? `다른 줄 ${bd.count}개` : '다름') : h('span.cmp-ok', '같음'));
  const sec = h('div.cmp-sec', bodyHead);
  if (bd.mode === 'json' && bd.diffs.length) {
    const shown = bd.diffs.slice(0, LIST_LIMIT);
    sec.append(h('table.cmp-table',
      h('thead', h('tr', h('th', '경로'), h('th', A), h('th', B), h('th'))),
      h('tbody', shown.map((x) => h('tr.k-' + x.kind,
        h('td.cmp-path', h('button.link-btn.cmp-jump', { title: '본문 나란히 보기에서 이 자리로', onclick: () => onJump(x.path) }, x.path)),
        h('td.cmp-old', showValue(x.a)),
        h('td.cmp-new', showValue(x.b)),
        h('td.cmp-act', h('button.link-btn', { title: '이 경로는 견주지 않기 (뺄 곳에 더함)', onclick: () => onIgnore('body', ignorePathOf(x.path)) }, '빼기')))))));
    if (bd.diffs.length > shown.length || bd.truncated) sec.append(h('div.muted.cmp-more', `처음 ${shown.length}개만 보여 줍니다.`));
    sec.append(h('div.muted.cmp-hint', '배열은 같은 번째끼리 견줍니다. 번째마다 달라지는 값은 [*] 로 뺄 수 있습니다 (예: $.items[*].updatedAt). 키 이름만 쓰면 어느 깊이든 뺍니다.'));
  } else if (bd.mode === 'text' && bd.count) {
    if (bd.tooBig) sec.append(h('div.muted', '줄이 너무 많거나 다른 줄이 너무 많아 줄마다 견주지 않았습니다. 본문이 다릅니다.'));
    else {
      const hunks = lineHunks(bd.ops, 2);
      const pre = h('div.cmp-hunks');
      let n = 0;
      for (const hk of hunks) {
        if (n > LIST_LIMIT) break;
        const blk = h('div.cmp-hunk');
        for (const o of hk) {
          n++;
          const text = o.t === '+' ? bd.b[o.b] : bd.a[o.a];
          blk.appendChild(h('div.cmp-hl.k-' + (o.t === '+' ? 'added' : o.t === '-' ? 'removed' : 'same'),
            h('span.cmp-ln', o.a === undefined ? '' : String(o.a + 1)), h('span.cmp-ln', o.b === undefined ? '' : String(o.b + 1)),
            h('span.cmp-sign', o.t === '=' ? ' ' : o.t), h('span.cmp-tx', text)));
        }
        pre.appendChild(blk);
      }
      sec.append(pre);
    }
  } else if (bd.mode === 'binary' && bd.count) {
    sec.append(h('div.muted', `바이트가 다릅니다 (${formatBytes(a.result.size && a.result.size.body)} → ${formatBytes(b.result.size && b.result.size.body)}).`));
  }
  out.append(sec);
  return out;
}

/**
 * 본문 나란히: JSON 은 같은 경로끼리 같은 행, 글은 같은 줄끼리. 다른 곳은 색, 뺀 곳은 회색.
 * ignoreBody: 뺄 곳 줄들. 반환 { el, grid(행이 든 상자, flashPath 에 넘김) }
 */
export function diffSideView({ a, b, diff, ignoreBody = [] }) {
  const bd = diff.body;
  const box = h('div.cmp-side');
  if (bd.mode === 'binary') {
    box.append(h('div.muted', '바이너리 응답은 나란히 볼 수 없습니다.'));
    return { el: box, grid: null };
  }
  let L;
  let R;
  let truncated = false;
  if (bd.mode === 'json') {
    const ig = makeIgnore(ignoreBody);
    const left = new Set(bd.diffs.filter((x) => x.kind !== 'added').map((x) => x.path));
    const right = new Set(bd.diffs.filter((x) => x.kind !== 'removed').map((x) => x.path));
    const pl = prettyJsonLines(responseContext(a.result).json(), { ignore: ig, marks: left, limit: SIDE_LIMIT });
    const pr = prettyJsonLines(responseContext(b.result).json(), { ignore: ig, marks: right, limit: SIDE_LIMIT });
    L = pl.lines;
    R = pr.lines;
    truncated = pl.truncated || pr.truncated;
  } else {
    const ta = responseContext(a.result).text().split(/\r?\n/);
    const tb = responseContext(b.result).text().split(/\r?\n/);
    truncated = ta.length > SIDE_LIMIT || tb.length > SIDE_LIMIT;
    L = ta.slice(0, SIDE_LIMIT).map((t) => ({ text: t, key: t }));
    R = tb.slice(0, SIDE_LIMIT).map((t) => ({ text: t, key: t }));
  }
  const { rows, aligned } = sideBySide(L, R);
  // 글 모드: 짝이 없는 줄과 짝지은 줄 중 글이 다른 줄이 다른 곳
  if (bd.mode !== 'json') {
    for (const row of rows) {
      if (row.l && (!row.r || row.r.text !== row.l.text)) row.l = { ...row.l, mark: true };
      if (row.r && (!row.l || row.l.text !== row.r.text)) row.r = { ...row.r, mark: true };
    }
  }
  const table = h('div.cmp-grid', h('div.cmp-grid-head', h('div', a.name, h('span.cmp-base-tag', '기준')), h('div', b.name)));
  const cell = (x, i, side) => (x
    ? h('div.cmp-cell' + (x.mark ? (side === 'l' ? '.del' : '.add') : '') + (x.ignored ? '.ign' : ''), { dataset: { key: x.key || '' }, title: x.ignored ? '뺀 곳 (견주지 않음)' : null },
      h('span.cmp-ln', String(i + 1)), h('span.cmp-tx', x.text))
    : h('div.cmp-cell.blank'));
  const frag = document.createDocumentFragment();
  for (const row of rows) frag.appendChild(h('div.cmp-row', cell(row.l, row.li, 'l'), cell(row.r, row.ri, 'r')));
  const grid = h('div.cmp-grid-body', frag);
  table.appendChild(grid);
  if (!aligned) box.append(h('div.muted.cmp-more', '다른 줄이 너무 많아 같은 줄끼리 맞추지 못했습니다. 줄 번호대로 놓았습니다.'));
  if (truncated) box.append(h('div.muted.cmp-more', `한쪽에 ${SIDE_LIMIT}줄까지만 보여 줍니다.`));
  box.append(table);
  const marks = rows.filter((r) => (r.l && r.l.mark) || (r.r && r.r.mark)).length;
  if (!marks) box.prepend(h('div.cmp-same', icon('check', 16), '본문이 같습니다', h('span.muted', ' (뺀 곳은 회색)')));
  return { el: box, grid };
}

/** 나란히 보기에서 경로 자리로 가서 잠깐 빛낸다 */
export function flashPath(grid, path) {
  const cell = grid && [...grid.querySelectorAll('.cmp-cell')].find((c) => c.dataset.key === path);
  if (!cell) return;
  cell.scrollIntoView({ block: 'center' });
  cell.parentElement.classList.add('flash');
  setTimeout(() => cell.parentElement && cell.parentElement.classList.remove('flash'), 1200);
}

/** 견주지 않을 곳을 고치는 창. onSave({ ignoreBody, ignoreHeaders }) */
export function editIgnoreDialog({ ignoreBody = '', ignoreHeaders = '', onSave }) {
  const body = h('textarea.input.cmp-ig-input', { rows: 7, spellcheck: 'false', placeholder: 'updatedAt\n$.meta.requestId\n$.items[*].createdAt\n$..traceId' });
  body.value = ignoreBody || '';
  const hdr = h('textarea.input.cmp-ig-input', { rows: 3, spellcheck: 'false', placeholder: 'X-Version\nETag' });
  hdr.value = ignoreHeaders || '';
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
          m.close();
          onSave({ ignoreBody: body.value.trim(), ignoreHeaders: hdr.value.trim() });
        },
      }, '저장'),
    ],
  });
}
