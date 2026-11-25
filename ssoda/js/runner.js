// 컬렉션 러너: 컬렉션·폴더의 요청을 트리 순서대로 실행하고, 데이터 파일(CSV·JSON)의 행마다 반복한다.
// 결과는 화면 표, HTML 보고서, JUnit XML(CI 가 읽는 형식)로 낸다. 요청 하나의 실행은 부르는 쪽(app.execute)이 한다.
// 내보내는 보고서에는 꺼낸 변수 값과 데이터 행의 값을 넣지 않는다 (토큰·테스트 계정 비밀번호가 들어 있기 쉬움).
import { describeAssert, parseJson, valueText, JsonNum } from './checks.js';

/** 컬렉션·폴더 안의 요청을 트리 순서대로 → [{ id, name, path: '폴더 / 하위 폴더', request }] */
export function collectRequests(node) {
  const out = [];
  const walk = (items, path) => {
    for (const it of items || []) {
      if (!it) continue;
      if (it.type === 'folder') walk(it.items, [...path, it.name]);
      else if (it.request) out.push({ id: it.id, name: it.name, path: path.join(' / '), request: it.request });
    }
  };
  walk(node && node.items, []);
  return out;
}

/* ------------------------------------------------------------------ */
/* 데이터 파일                                                           */
/* ------------------------------------------------------------------ */

// 첫 줄(따옴표 밖)에서 가장 많이 나온 구분자: 쉼표·탭·세미콜론
function guessDelimiter(s) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) break;
    else if (!q && c in counts) counts[c]++;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
}

/** CSV(RFC 4180: 따옴표 안의 구분자·줄바꿈, "" 는 따옴표 하나) → 행 배열(칸 문자열 배열). 빈 줄은 뺀다 */
export function parseCsv(text, delimiter) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const d = delimiter || guessDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false; // 이 줄에 무엇이든 있었는지
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === d) {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new Error('CSV 에 닫히지 않은 따옴표가 있습니다');
  if (started || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/**
 * 데이터 파일 → { kind: 'csv'|'json', columns: [열 이름], rows: [{열: 값(문자열)}] }
 * - CSV: 첫 줄이 열 이름. 칸이 모자란 행은 빈 값
 * - JSON: 객체의 배열 (객체 하나면 한 행). 값은 글로 (숫자는 원문 그대로 — 19자리 ID 도 바뀌지 않음, 객체·배열은 JSON)
 */
export function parseDataFile(text, name = '') {
  const t = String(text ?? '').replace(/^﻿/, '');
  if (!t.trim()) throw new Error('파일이 비어 있습니다');
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(t)) {
    let v;
    try {
      v = parseJson(t);
    } catch (e) {
      throw new Error('JSON 을 읽을 수 없습니다: ' + e.message);
    }
    const list = Array.isArray(v) ? v : [v];
    if (!list.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof JsonNum))) {
      throw new Error('JSON 은 객체의 배열이어야 합니다 (예: [{"id": 1}, {"id": 2}])');
    }
    const columns = [];
    const rows = list.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) {
        if (!columns.includes(k)) columns.push(k);
        out[k] = valueText(r[k]);
      }
      return out;
    });
    return { kind: 'json', columns, rows };
  }
  const table = parseCsv(t);
  if (!table.length) throw new Error('파일이 비어 있습니다');
  const head = table[0].map((x) => x.trim());
  const columns = [];
  head.forEach((k) => {
    if (k && !columns.includes(k)) columns.push(k);
  });
  if (!columns.length) throw new Error('CSV 첫 줄에 열 이름이 있어야 합니다');
  const rows = table.slice(1).map((cells) => {
    const out = {};
    head.forEach((k, i) => {
      if (k && !(k in out)) out[k] = cells[i] ?? '';
    });
    return out;
  });
  return { kind: 'csv', columns, rows };
}

/* ------------------------------------------------------------------ */
/* 실행                                                                 */
/* ------------------------------------------------------------------ */

const wait = (ms, signal) =>
  new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** 요청 하나의 결과(app.execute + 확인)를 보고서 한 줄로 */
export function summarizeRun(item, iteration, row, result) {
  const c = result.checks && !result.checks.skipped ? result.checks : null;
  // 설명은 변수를 바꾸기 전의 식으로 (Bearer {{token}} 이 실제 토큰으로 보고서에 찍히지 않게)
  const asserts = c
    ? c.asserts.map((a) => ({ desc: describeAssert({ ...a, path: a.tplPath ?? a.path, expected: a.tplExpected ?? a.expected }), ok: a.ok, actual: a.actual, message: a.message || '' }))
    : [];
  const captures = c ? c.captures.map((x) => ({ name: x.name, ok: x.ok, value: x.ok ? x.value : undefined, error: x.ok ? '' : x.error, savedTo: x.savedTo || '', note: x.note || '' })) : [];
  return {
    iteration,
    row,
    item: { id: item.id, name: item.name, path: item.path, url: item.request ? item.request.url : '' },
    method: result.method || (item.request && item.request.method) || 'GET',
    url: result.sentUrl || '',
    ok: !!result.ok,
    status: result.ok ? result.status : 0,
    statusText: result.ok ? result.statusText || '' : '',
    error: result.ok ? '' : (result.error && result.error.message) || '오류',
    code: result.ok ? '' : (result.error && result.error.code) || 'ERROR',
    time: Math.round((result.timing && result.timing.total) || 0),
    size: result.ok && result.size ? result.size.body : 0,
    asserts,
    captures,
    // 실패: 응답을 못 받았거나, 확인이 틀렸거나, 꺼내려던 값이 없었을 때 (상태 코드만으로는 실패로 치지 않음 — 확인으로 정한다)
    failed: !result.ok || asserts.some((a) => !a.ok) || captures.some((x) => !x.ok),
  };
}

/**
 * 요청들을 차례로 실행한다 (반복마다 전체를 한 번씩).
 * opts: { name, environment, items, iterations, rows(데이터 행 | null), delayMs, stopOnFailure, signal,
 *         exec(item, { iteration, row }) → result, onProgress({ done, total, run, report }) }
 * 데이터 행이 있으면 반복 수는 행 수다.
 */
export async function runAll(opts) {
  const { items, rows = null, delayMs = 0, stopOnFailure = false, signal, exec, onProgress } = opts;
  const n = rows && rows.length ? rows.length : Math.max(1, Math.floor(Number(opts.iterations) || 1));
  const report = {
    name: opts.name || '',
    environment: opts.environment || '',
    startedAt: Date.now(),
    finishedAt: null,
    iterations: n,
    dataColumns: rows && rows.length ? Object.keys(rows[0]) : [],
    total: n * items.length,
    runs: [],
    stopped: false,
    stoppedOnFailure: false,
  };
  let done = 0;
  outer: for (let it = 0; it < n; it++) {
    const row = rows && rows.length ? rows[it] : null;
    for (const item of items) {
      if (signal && signal.aborted) {
        report.stopped = true;
        break outer;
      }
      const result = await exec(item, { iteration: it, row });
      const run = summarizeRun(item, it, row, result);
      // 멈춤 버튼으로 끊긴 요청은 결과에 넣지 않는다
      if (signal && signal.aborted && !result.ok && result.error && result.error.code === 'ABORTED') {
        report.stopped = true;
        break outer;
      }
      report.runs.push(run);
      done++;
      if (onProgress) onProgress({ done, total: report.total, run, report });
      if (run.failed && stopOnFailure) {
        report.stoppedOnFailure = true;
        break outer;
      }
      if (delayMs > 0 && done < report.total) await wait(delayMs, signal);
    }
  }
  report.finishedAt = Date.now();
  return report;
}

/** 합계 */
export function summarize(report) {
  const runs = report.runs || [];
  const asserts = runs.reduce((n, r) => n + r.asserts.length, 0);
  const assertsFailed = runs.reduce((n, r) => n + r.asserts.filter((a) => !a.ok).length, 0);
  return {
    requests: runs.length,
    failed: runs.filter((r) => r.failed).length,
    errors: runs.filter((r) => !r.ok).length,
    asserts,
    assertsPassed: asserts - assertsFailed,
    assertsFailed,
    duration: (report.finishedAt || Date.now()) - report.startedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 보고서                                                               */
/* ------------------------------------------------------------------ */

// XML 1.0 에 넣을 수 없는 글자는 빼고 특수 문자는 바꾼다
const xml = (s) =>
  String(s ?? '')
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const sec = (ms) => ((ms || 0) / 1000).toFixed(3);
const runLabel = (report, r) => `${r.item.path ? r.item.path + ' / ' : ''}${r.item.name}${report.iterations > 1 ? ` (반복 ${r.iteration + 1})` : ''}`;
const clip = (s, n = 300) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

/** JUnit XML: 요청마다 testsuite, 확인·꺼내기마다 testcase. 응답을 못 받으면 error */
export function toJUnit(report) {
  const S = summarize(report);
  let tests = 0;
  const suites = report.runs.map((r) => {
    const cls = xml([report.name, r.item.path, r.item.name].filter(Boolean).join('.'));
    const cases = [];
    let failures = 0;
    if (!r.ok) cases.push(`    <testcase name="요청" classname="${cls}" time="${sec(r.time)}">\n      <error type="${xml(r.code)}" message="${xml(r.error)}">${xml(`${r.method} ${r.item.url}`)}</error>\n    </testcase>`);
    for (const c of r.captures) {
      if (c.ok) cases.push(`    <testcase name="${xml(`변수 꺼내기: ${c.name}`)}" classname="${cls}" time="0.000"/>`);
      else {
        failures++;
        cases.push(`    <testcase name="${xml(`변수 꺼내기: ${c.name}`)}" classname="${cls}" time="0.000">\n      <failure message="${xml(c.error)}"/>\n    </testcase>`);
      }
    }
    for (const a of r.asserts) {
      if (a.ok) cases.push(`    <testcase name="${xml(a.desc)}" classname="${cls}" time="0.000"/>`);
      else {
        failures++;
        const msg = `찾은 값: ${clip(a.actual)}${a.message ? ' · ' + a.message : ''}`;
        cases.push(`    <testcase name="${xml(a.desc)}" classname="${cls}" time="0.000">\n      <failure message="${xml(msg)}"/>\n    </testcase>`);
      }
    }
    if (r.ok && !cases.length) cases.push(`    <testcase name="${xml(`응답 받음 (${r.status})`)}" classname="${cls}" time="${sec(r.time)}"/>`);
    tests += cases.length;
    return `  <testsuite name="${xml(runLabel(report, r))}" tests="${cases.length}" failures="${failures}" errors="${r.ok ? 0 : 1}" time="${sec(r.time)}" timestamp="${new Date(report.startedAt).toISOString().slice(0, 19)}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  const failures = report.runs.reduce((n, r) => n + r.asserts.filter((a) => !a.ok).length + r.captures.filter((c) => !c.ok).length, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(`Ssoda: ${report.name}`)}" tests="${tests}" failures="${failures}" errors="${S.errors}" time="${sec(S.duration)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 혼자 열리는 HTML 보고서 (바깥 파일·스크립트 없음) */
export function toHtml(report) {
  const S = summarize(report);
  const when = new Date(report.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  const groups = [];
  for (const r of report.runs) {
    if (!groups[r.iteration]) groups[r.iteration] = [];
    groups[r.iteration].push(r);
  }
  const rowHtml = (r) => {
    const details = [];
    if (!r.ok) details.push(`<li class="bad">요청 실패: ${esc(r.error)}</li>`);
    for (const c of r.captures) details.push(c.ok ? `<li class="ok">변수 꺼내기 ${esc(c.name)} → ${esc(c.savedTo || '')}</li>` : `<li class="bad">변수 꺼내기 ${esc(c.name)}: ${esc(c.error)}</li>`);
    for (const a of r.asserts) details.push(`<li class="${a.ok ? 'ok' : 'bad'}">${a.ok ? '✓' : '✗'} ${esc(a.desc)}${a.ok ? '' : ` <span class="muted">· 찾은 값: ${esc(clip(a.actual))}${a.message ? ' · ' + esc(a.message) : ''}</span>`}</li>`);
    const passed = r.asserts.filter((a) => a.ok).length;
    return `<tr class="${r.failed ? 'fail' : ''}">
<td class="mark">${r.failed ? '✗' : '✓'}</td>
<td><b>${esc(r.method)}</b> ${esc(r.item.name)}${r.item.path ? `<div class="muted">${esc(r.item.path)}</div>` : ''}${details.length ? `<ul>${details.join('')}</ul>` : ''}</td>
<td class="${r.ok ? (r.status >= 400 ? 'bad' : '') : 'bad'}">${r.ok ? esc(`${r.status} ${r.statusText}`.trim()) : '오류'}</td>
<td class="num">${r.time} ms</td>
<td class="num">${r.asserts.length ? `${passed}/${r.asserts.length}` : '-'}</td>
</tr>`;
  };
  const body = groups
    .map((g, i) => (g ? `${report.iterations > 1 ? `<h2>반복 ${i + 1}${report.dataColumns.length ? ` <span class="muted">(데이터 ${i + 1}번째 행)</span>` : ''}</h2>` : ''}<table><thead><tr><th></th><th>요청</th><th>상태</th><th>시간</th><th>확인</th></tr></thead><tbody>${g.map(rowHtml).join('')}</tbody></table>` : ''))
    .join('');
  const end = report.stopped ? ' · 중간에 멈춤' : report.stoppedOnFailure ? ' · 실패해서 멈춤' : '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Ssoda 러너 보고서 - ${report.name}`)}</title>
<style>
:root{--fg:#212121;--muted:#6b6b6b;--bg:#fff;--line:#e6e6e6;--ok:#007f31;--bad:#c3281a;--badbg:#fdecea;--head:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--muted:#a0a0a0;--bg:#1b1b1b;--line:#333;--ok:#4cc27a;--bad:#ff7b6b;--badbg:#3a1f1c;--head:#242424}}
body{margin:0;padding:24px 16px 48px;font:14px/1.5 -apple-system,'Segoe UI','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:1000px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}
.muted{color:var(--muted);font-weight:400}.ok{color:var(--ok)}.bad{color:var(--bad)}
.summary{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.summary div{border:1px solid var(--line);border-radius:6px;padding:8px 12px;min-width:110px}.summary b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;border:1px solid var(--line)}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{background:var(--head);font-size:12px;color:var(--muted)}
tr.fail td{background:var(--badbg)}td.mark{width:16px;font-weight:700}tr.fail td.mark{color:var(--bad)}tr:not(.fail) td.mark{color:var(--ok)}td.num{white-space:nowrap;text-align:right}
ul{margin:6px 0 0;padding-left:0;list-style:none;font-size:13px}code{font-family:Consolas,monospace}
</style></head><body><main>
<h1>Ssoda 러너 보고서 · ${esc(report.name)}</h1>
<div class="muted">${esc(stamp)} · 환경: ${esc(report.environment || '선택 안 함')} · 반복 ${report.iterations}${end}</div>
<div class="summary">
<div>요청<b>${S.requests}</b></div>
<div class="${S.failed ? 'bad' : 'ok'}">실패<b>${S.failed}</b></div>
<div>확인 통과<b>${S.assertsPassed}/${S.asserts}</b></div>
<div>걸린 시간<b>${(S.duration / 1000).toFixed(1)} s</b></div>
</div>
${body || '<p class="muted">실행한 요청이 없습니다.</p>'}
<p class="muted">꺼낸 변수의 값과 데이터 파일의 값은 보고서에 넣지 않았습니다.</p>
</main></body></html>
`;
}
