// 주간보고 생성 로직: Jira 데이터 수집 → 진척률 계산 → 템플릿 렌더
import { parseJiraDate, startOfDay, addDays, weekRange, ymd, yymmdd, mdDow, md } from './dates.js';

/* ───────────── JQL ───────────── */

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function fillJqlTokens(src, vars) {
  return String(src || '').replace(TOKEN_RE, (all, name) =>
    vars[name] === undefined || vars[name] === null ? all : String(vars[name])
  );
}

export function splitOrderBy(jql) {
  const m = jql.match(/\s*\border\s+by\b[\s\S]*$/i);
  if (!m) return { where: jql.trim(), order: '' };
  return { where: jql.slice(0, m.index).trim(), order: ' ' + m[0].trim() };
}

/** 사용자 JQL + 공통 필터(하위작업 제외, 내 이슈만) + 정렬 */
export function buildJql(src, s, vars, withOrder = true, extra = []) {
  const filled = fillJqlTokens(src, vars).trim();
  const unresolved = filled.match(TOKEN_RE);
  if (unresolved) {
    throw new Error(`JQL에 채울 수 없는 항목이 있습니다: ${unresolved.join(', ')}`);
  }
  const { where, order } = splitOrderBy(filled);
  const parts = [];
  if (where) parts.push(`(${where})`);
  if (!s.includeSubtasks) parts.push('issuetype not in subTaskIssueTypes()');
  if (s.onlyMine) parts.push('assignee = currentUser()');
  parts.push(...extra.filter(Boolean));
  let q = parts.join(' AND ');
  if (withOrder) q += order || ' ORDER BY Rank ASC';
  return q.trim();
}

/** customfield_10053 → cf[10053] (JQL용) */
export function jqlFieldRef(id) {
  const m = /^customfield_(\d+)$/.exec(String(id || ''));
  return m ? `cf[${m[1]}]` : id;
}

/**
 * 이번 주 작업 선정 조건:
 *  작업시작일이 이번 주(월~일)에 있으면 포함, 아니면 종료일이 이번 주에 있으면 포함
 */
export function weekDateCondition(s, monday, sunday) {
  if (!s.useDateFilter || !s.startField) return null;
  const a = ymd(monday);
  const b = ymd(sunday);
  const range = (f) => `(${jqlFieldRef(f)} >= "${a}" AND ${jqlFieldRef(f)} <= "${b}")`;
  return s.endField ? `(${range(s.startField)} OR ${range(s.endField)})` : range(s.startField);
}

/** 이번 주(from ≤ t < to)에 진행률(진척률 필드 모드) 또는 상태가 바뀐 적이 있는지 */
export function progressChangedBetween(raw, s, from, to) {
  const match =
    s.progressSource === 'field' && s.progressField
      ? (it) => it.fieldId === s.progressField
      : (it) => it.fieldId === 'status' || it.field === 'status';
  return (raw.changelog?.histories || []).some((h) => {
    const t = parseJiraDate(h.created);
    return t && t >= from && t < to && (h.items || []).some(match);
  });
}

/** 날짜/일시 값 → "YYYY-MM-DD" (없으면 null) */
export function dateOnly(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = parseJiraDate(v);
  return d ? ymd(d) : null;
}

/* ───────────── 스프린트 ───────────── */

export function sprintNumber(name) {
  const m = String(name || '').match(/(\d+)(?!.*\d)/);
  return m ? m[1] : name || '';
}

/** 기준일이 속한 스프린트와 그 직전 스프린트 */
export function pickSprints(sprints, ref) {
  const dayStart = startOfDay(ref);
  const dayEnd = addDays(dayStart, 1);
  const list = (sprints || []).map((sp) => ({
    ...sp,
    _start: parseJiraDate(sp.startDate),
    _end: parseJiraDate(sp.endDate),
    _complete: parseJiraDate(sp.completeDate),
  }));

  const covering = list.filter(
    (sp) => sp._start && sp._end && sp._start < dayEnd && sp._end >= dayStart && sp.state !== 'future'
  );
  let current =
    covering.find((sp) => sp.state === 'active') ||
    covering[0] ||
    list.find((sp) => sp.state === 'active') ||
    null;

  const pivot = current?._start || dayEnd;
  const previous =
    list
      .filter((sp) => sp.state === 'closed' && sp.id !== current?.id && sp._start && sp._start < pivot)
      .sort((a, b) => b._start - a._start)[0] || null;

  return { current, previous };
}

/* ───────────── 진척률 ───────────── */

export function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.length ? parseNum(v[0]) : null;
  if (typeof v === 'object') return parseNum(v.value ?? v.name ?? null);
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function parsePct(v) {
  let n = parseNum(v);
  if (n === null) return null;
  if (n > 0 && n < 1 && !Number.isInteger(n)) n *= 100; // 0.8 → 80
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** "진행 중=50" 형태의 줄들 → Map(소문자 상태명 → %) */
export function parseStatusMap(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*[=:]\s*(\d+(?:\.\d+)?)\s*%?\s*$/);
    if (m) map.set(m[1].toLowerCase(), parsePct(m[2]));
  }
  return map;
}

function timePctOf(f) {
  const p = f.progress;
  if (p && p.total > 0) return Math.max(0, Math.min(100, Math.round((p.progress / p.total) * 100)));
  return null;
}

/** 이슈 한 건의 진척률 결정 규칙 */
export function computePct({ fieldRaw, statusName, cat, timePct }, s, statusMap) {
  if (s.doneIs100 && cat === 'done') return 100;
  const mapped = statusMap.get(String(statusName || '').toLowerCase());
  if (s.progressSource === 'field' && s.progressField) {
    const v = parsePct(fieldRaw);
    if (v !== null) return v;
  } else if (s.progressSource === 'timetracking') {
    if (timePct !== null && timePct !== undefined) return timePct;
  }
  if (mapped !== undefined && mapped !== null) return mapped;
  return cat === 'done' ? 100 : null;
}

/** changelog에서 특정 시점(at)의 필드 값 */
export function fieldValueAt(histories, match, at) {
  let before = null;
  let firstAfter = null;
  for (const h of histories) {
    const t = parseJiraDate(h.created);
    for (const it of h.items || []) {
      if (!match(it)) continue;
      if (t < at) before = it;
      else if (!firstAfter) firstAfter = it;
    }
  }
  if (before) return { found: true, id: before.to, text: before.toString };
  if (firstAfter) return { found: true, id: firstAfter.from, text: firstAfter.fromString };
  return { found: false };
}

const isStatusItem = (it) => it.fieldId === 'status' || it.field === 'status';

function sortedHistories(raw) {
  const hs = raw.changelog?.histories || [];
  return [...hs].sort((a, b) => parseJiraDate(a.created) - parseJiraDate(b.created));
}

/** 이슈의 특정 시점 상태/진척률 (at 없으면 현재) */
export function stateAt(raw, at, ctx, timeFallback = 'snapshot') {
  const { s } = ctx;
  const f = raw.fields || {};
  const curId = f.status?.id != null ? String(f.status.id) : null;
  let statusName = f.status?.name || '';
  let cat = f.status?.statusCategory?.key || ctx.statusCat.get(curId) || 'new';
  let fieldRaw = s.progressField ? f[s.progressField] : null;
  let timePct = timePctOf(f);

  if (at) {
    const hs = sortedHistories(raw);
    const st = fieldValueAt(hs, isStatusItem, at);
    if (st.found) {
      const id = st.id != null ? String(st.id) : null;
      statusName = st.text || '';
      cat = ctx.statusCat.get(id) || ctx.statusCatByName.get(statusName.toLowerCase()) || 'new';
    }
    if (s.progressField) {
      const fv = fieldValueAt(hs, (it) => it.fieldId === s.progressField, at);
      if (fv.found) fieldRaw = fv.text ?? fv.id;
    }
    if (timeFallback === 'snapshot') timePct = ctx.snapshot?.[raw.key] ?? null;
  }
  return { cat, statusName, pct: computePct({ fieldRaw, statusName, cat, timePct }, s, ctx.statusMap) };
}

export function normalizeIssue(raw, ctx) {
  const { s } = ctx;
  const f = raw.fields || {};
  const cur = stateAt(raw, null, ctx);
  const created = parseJiraDate(f.created);
  const prevPct = created && created >= ctx.compareAt ? null : stateAt(raw, ctx.compareAt, ctx).pct;
  const type = f.issuetype?.name || '';
  return {
    key: raw.key,
    summary: String(f.summary || '').trim(),
    status: f.status?.name || '',
    cat: cur.cat,
    type,
    isBug: ctx.bugSet.has(type.toLowerCase()),
    assignee: f.assignee?.displayName || '',
    assigneeId: f.assignee?.accountId || null,
    start: s.startField ? dateOnly(f[s.startField]) : null,
    end: s.endField ? dateOnly(f[s.endField]) : null,
    due: dateOnly(f[s.dueField || 'duedate']),
    resolvedAt: parseJiraDate(f.resolutiondate),
    pct: cur.pct,
    prevPct,
    points: s.pointsField ? parseNum(f[s.pointsField]) : null,
    url: `${ctx.base}/browse/${raw.key}`,
  };
}

/** 여러 이슈의 진척률 (%) — items: {pct, cat, points} */
export function aggregatePct(items, s) {
  if (!items || !items.length) return null;
  if (s.sprintCalc === 'count') {
    return Math.round((items.filter((i) => i.cat === 'done').length / items.length) * 100);
  }
  if (s.sprintCalc === 'points') {
    const pts = items.filter((i) => i.points > 0);
    const total = pts.reduce((a, i) => a + i.points, 0);
    if (total > 0) {
      return Math.round(pts.reduce((a, i) => a + i.points * (i.pct ?? 0), 0) / total);
    }
  }
  return Math.round(items.reduce((a, i) => a + (i.pct ?? 0), 0) / items.length);
}

export function progressText(prev, now) {
  if (now === null || now === undefined) return '';
  if (prev !== null && prev !== undefined && prev !== now) return ` (${prev}% -> ${now}%)`;
  if (now > 0 && now < 100) return ` (${now}%)`;
  return '';
}

/* ───────────── 템플릿 ───────────── */

export const LIST_NAMES = ['작업목록', '버그목록', '지연목록', '완료목록', '진행목록', '예정목록', '전체목록'];

// {{작업목록}}, {{작업목록_키}}, {{내작업목록}}(내가 담당인 것만), {{내작업목록_키}} …
function parseListToken(tok) {
  const m = tok.match(/^(내)?(.+?)(_키)?$/);
  return m && LIST_NAMES.includes(m[2]) ? { name: (m[1] || '') + m[2], withKey: !!m[3] } : null;
}

export function formatItem(it, fmt) {
  const values = {
    키: it.key,
    요약: it.summary,
    진척: progressText(it.prevPct, it.pct),
    진척률: it.pct ?? '',
    상태: it.status,
    담당자: it.assignee || '미지정',
    마감일: it.due ? md(parseJiraDate(it.due)) : '',
    시작일: it.start ? md(parseJiraDate(it.start)) : '',
    종료일: it.end ? md(parseJiraDate(it.end)) : '',
    유형: it.type,
    링크: it.url,
  };
  return fmt.replace(/\{(키|요약|진척률|진척|상태|담당자|마감일|시작일|종료일|유형|링크)\}/g, (_, k) => String(values[k]));
}

/**
 * 템플릿 렌더링.
 * 목록 항목({{작업목록}} 등)이 있는 줄은 이슈마다 그 줄을 복제한다.
 * 예) "   - {{작업목록}}" → "   - 이슈A", "   - 이슈B" …  (이슈가 없으면 "   -")
 */
export function renderTemplate(template, scalars, lists, formats) {
  const replaceScalars = (str) =>
    str.replace(TOKEN_RE, (all, name) => {
      if (!(name in scalars)) return all;
      const v = scalars[name];
      return v === null || v === undefined || v === '' ? '-' : String(v);
    });

  const out = [];
  for (const line of String(template).replace(/\r\n/g, '\n').split('\n')) {
    let hit = null;
    for (const m of line.matchAll(TOKEN_RE)) {
      const p = parseListToken(m[1]);
      if (p) {
        hit = { m, p };
        break;
      }
    }
    if (!hit) {
      out.push(replaceScalars(line));
      continue;
    }
    const before = replaceScalars(line.slice(0, hit.m.index));
    const after = replaceScalars(line.slice(hit.m.index + hit.m[0].length));
    const items = lists[hit.p.name] || [];
    if (!items.length) {
      out.push((before + after).trimEnd());
      continue;
    }
    const fmt = hit.p.withKey ? formats.key : formats.plain;
    for (const it of items) out.push(before + formatItem(it, fmt) + after);
  }
  return out.join('\n');
}

/* ───────────── 전체 흐름 ───────────── */

const CAT_ORDER = { done: 0, indeterminate: 1, new: 2 };

export function sortIssues(issues, mode) {
  const arr = [...issues]; // JQL이 준 보드 순서(Rank)를 동점 처리 기준으로 유지 (stable sort)
  if (mode === 'start') {
    arr.sort((a, b) => (a.start || '9999-99-99').localeCompare(b.start || '9999-99-99') || (a.end || '9999-99-99').localeCompare(b.end || '9999-99-99'));
  } else if (mode === 'status') {
    arr.sort((a, b) => (CAT_ORDER[a.cat] ?? 3) - (CAT_ORDER[b.cat] ?? 3) || (b.pct ?? -1) - (a.pct ?? -1));
  }
  return arr;
}

const pointsOf = (s, r) => (s.pointsField ? parseNum(r.fields?.[s.pointsField]) : null);

/**
 * @param {object} p
 * @param {object} p.settings  설정
 * @param {Date}   p.refDate   기준일
 * @param {object} p.client    JiraClient (또는 동일 인터페이스의 mock)
 * @param {object} p.history   이전 실행 기록 (시간추적 모드 비교용)
 * @param {Date}   [p.now]     현재 시각 (테스트용)
 */
export async function generateReport({ settings: s, refDate, client, history = {}, now = new Date(), onProgress = () => {} }) {
  const warnings = [];
  const { monday, friday, sunday, nextMonday } = weekRange(refDate);
  const weekKey = ymd(monday);
  const weekStart = ymd(monday);
  const weekEnd = ymd(sunday);
  const refIsToday = ymd(refDate) === ymd(now);
  const refMoment = refIsToday ? now : addDays(startOfDay(refDate), 1);
  const compareAt = s.compareBase === '7days' ? new Date(refMoment.getTime() - 7 * 86400000) : monday;

  onProgress('Jira 로그인 확인 중…');
  const me = await client.myself();

  let statusList = [];
  try {
    statusList = await client.statuses();
  } catch (e) {
    if (e.kind === 'auth') throw e;
    warnings.push('상태 목록을 불러오지 못해 일부 진척 비교가 부정확할 수 있습니다.');
  }
  const statusCat = new Map(statusList.map((st) => [String(st.id), st.statusCategory?.key]));
  const statusCatByName = new Map(statusList.map((st) => [String(st.name).toLowerCase(), st.statusCategory?.key]));

  onProgress('스프린트 확인 중…');
  let boardId = String(s.boardId || '').trim();
  let sprints = [];
  try {
    if (!boardId) {
      const boards = await client.boards(s.projectKey);
      const b = boards.find((x) => x.type === 'scrum') || boards[0];
      if (b) boardId = String(b.id);
    }
    if (boardId) sprints = await client.sprints(boardId);
  } catch (e) {
    if (e.kind === 'auth') throw e;
    warnings.push(`스프린트 정보를 불러오지 못했습니다 (${e.message})`);
  }
  const { current, previous } = pickSprints(sprints, refDate);

  const vars = {
    프로젝트: s.projectKey,
    스프린트ID: current?.id,
    이전스프린트ID: previous?.id,
    주간시작일: weekStart,
    주간종료일: weekEnd,
    기준일: ymd(refDate),
  };

  const fields = [
    'summary', 'status', 'issuetype', 'assignee', 'duedate', 'resolutiondate', 'created', 'progress',
    s.progressField, s.pointsField, s.startField, s.endField, s.dueField,
  ].filter((f, i, arr) => f && arr.indexOf(f) === i);

  const ctx = {
    s,
    base: client.base,
    statusCat,
    statusCatByName,
    statusMap: parseStatusMap(s.statusPctMap),
    bugSet: new Set(String(s.bugTypes || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
    compareAt,
    snapshot: previousSnapshot(history, weekKey),
  };

  /* ── 1. 이번 주 작업 (작업시작일 → 없으면 종료일 기준) ── */
  const TOKEN_SPRINT = /\{\{\s*스프린트ID\s*\}\}/;
  let mainSrc = s.mainJql;
  if (!current && TOKEN_SPRINT.test(mainSrc)) {
    mainSrc = s.fallbackJql;
    warnings.push('기준일에 진행 중인 스프린트가 없어 "스프린트 없을 때 JQL"로 이슈를 모았습니다.');
  }
  const dateCond = weekDateCondition(s, monday, sunday);
  // 진행률이 이번 주에 바뀐 작업도 후보로 (정확한 판단은 아래에서 변경 이력으로)
  const selectCond = dateCond && s.includeProgressChanged ? `(${dateCond} OR updated >= "${weekStart}")` : dateCond;

  onProgress('이번 주 작업 불러오는 중…');
  const mainJql = buildJql(mainSrc, s, vars, true, [selectCond]);
  const raw = await client.search(mainJql, fields, { expand: 'changelog', pageSize: 100, max: 500 });
  let issues = raw.map((r) => normalizeIssue(r, ctx));
  if (dateCond) {
    // 규칙: ① 작업시작일이 이번 주 ② 아니면 종료일이 이번 주 ③ 아니면 이번 주에 진행률이 바뀐 작업
    const inWeek = (d) => d && d >= weekStart && d <= weekEnd;
    issues = issues
      .map((i, idx) => ({
        ...i,
        selectedBy: inWeek(i.start)
          ? 'start'
          : inWeek(i.end)
            ? 'end'
            : s.includeProgressChanged && progressChangedBetween(raw[idx], s, monday, nextMonday)
              ? 'progress'
              : null,
      }))
      .filter((i) => i.selectedBy);
  }
  issues = sortIssues(issues, s.sortBy);

  /* ── 2. 현재 스프린트 실적 ── */
  let sprintIssues = [];
  let sprintRaw = [];
  const sprintSrc = String(s.sprintJql || '').trim();
  if (sprintSrc && (current || !TOKEN_SPRINT.test(sprintSrc))) {
    onProgress('스프린트 실적 계산 중…');
    try {
      sprintRaw = await client.search(buildJql(sprintSrc, s, vars, true), fields, { expand: 'changelog', pageSize: 100, max: 500 });
      sprintIssues = sprintRaw.map((r) => normalizeIssue(r, ctx));
    } catch (e) {
      if (e.kind === 'auth') throw e;
      warnings.push(`스프린트 실적을 계산하지 못했습니다 (${e.message})`);
    }
  }
  const sprintPct = aggregatePct(sprintIssues, s);
  // 비교 기준 시점(이번 주 월요일 0시) 실적 — 그 이후 생성된 이슈는 제외
  const lastWeekPct = aggregatePct(
    sprintRaw
      .filter((r) => {
        const c = parseJiraDate(r.fields?.created);
        return !c || c < compareAt;
      })
      .map((r) => ({ ...stateAt(r, compareAt, ctx), points: pointsOf(s, r) })),
    s
  );

  /* ── 3. 직전 스프린트 (종료 시점 기준) ── */
  let prevPct = null;
  if (previous && sprintSrc) {
    onProgress('직전 스프린트 계산 중…');
    try {
      const prevSrc = TOKEN_SPRINT.test(sprintSrc)
        ? sprintSrc.replace(/\{\{\s*스프린트ID\s*\}\}/g, String(previous.id))
        : `project = {{프로젝트}} AND sprint = ${previous.id}`;
      const prevRaw = await client.search(buildJql(prevSrc, s, vars, false), fields, {
        expand: 'changelog', pageSize: 100, max: 1000,
      });
      const endAt = previous._complete || previous._end;
      prevPct = aggregatePct(prevRaw.map((r) => ({ ...stateAt(r, endAt, ctx, 'current'), points: pointsOf(s, r) })), s);
    } catch (e) {
      if (e.kind === 'auth') throw e;
      warnings.push(`직전 스프린트 진척률을 계산하지 못했습니다 (${e.message})`);
    }
  }

  /* ── 4. 전체 진척률 ── */
  let totalPct = null;
  if (String(s.totalJql || '').trim()) {
    onProgress('전체 진척률 계산 중…');
    try {
      const totalRaw = await client.search(
        buildJql(s.totalJql, s, vars, false),
        ['status', 'issuetype', 'progress', s.progressField, s.pointsField].filter(Boolean),
        { pageSize: 1000, max: 5000 }
      );
      totalPct = aggregatePct(totalRaw.map((r) => ({ ...stateAt(r, null, ctx), points: pointsOf(s, r) })), s);
      if (totalRaw.length >= 5000) warnings.push('전체 진척률은 최대 5,000건까지만 계산했습니다.');
    } catch (e) {
      if (e.kind === 'auth') throw e;
      warnings.push(`전체 진척률을 계산하지 못했습니다 (${e.message})`);
    }
  }

  /* ── 5. 목록 ── */
  const today = ymd(refDate);
  const union = new Map();
  for (const i of [...issues, ...sprintIssues]) if (!union.has(i.key)) union.set(i.key, i);
  const delayed = [...union.values()]
    .filter((i) => i.due && i.due < today && i.cat !== 'done' && (i.pct ?? 0) < 100)
    .sort((a, b) => a.due.localeCompare(b.due));

  const lists = {
    작업목록: issues.filter((i) => !i.isBug),
    버그목록: issues.filter((i) => i.isBug),
    지연목록: delayed,
    완료목록: issues.filter((i) => i.cat === 'done' && i.resolvedAt && i.resolvedAt >= monday && i.resolvedAt < nextMonday),
    진행목록: issues.filter((i) => i.cat === 'indeterminate'),
    예정목록: issues.filter((i) => i.cat === 'new'),
    전체목록: issues,
  };
  const myId = me?.accountId;
  for (const name of LIST_NAMES) lists['내' + name] = lists[name].filter((i) => myId && i.assigneeId === myId);

  const counts = {
    total: issues.length,
    byStart: issues.filter((i) => i.selectedBy === 'start').length,
    byEnd: issues.filter((i) => i.selectedBy === 'end').length,
    byProgress: issues.filter((i) => i.selectedBy === 'progress').length,
    mine: lists.내전체목록.length,
    done: issues.filter((i) => i.cat === 'done').length,
    inProgress: issues.filter((i) => i.cat === 'indeterminate').length,
    todo: issues.filter((i) => i.cat === 'new').length,
    delayed: delayed.length,
    sprintTotal: sprintIssues.length,
  };

  const scalars = {
    기준일: today,
    작성자: me?.displayName,
    주간시작: mdDow(monday),
    주간종료: mdDow(friday),
    스프린트: current?.name,
    스프린트번호: current ? sprintNumber(current.name) : null,
    스프린트시작: current?._start ? yymmdd(current._start) : null,
    스프린트종료: current?._end ? yymmdd(current._end) : null,
    스프린트실적: sprintPct,
    지난주실적: lastWeekPct,
    이전스프린트: previous?.name,
    이전스프린트번호: previous ? sprintNumber(previous.name) : null,
    이전스프린트실적: prevPct,
    전체실적: totalPct,
    이슈수: counts.total,
    완료수: counts.done,
    진행수: counts.inProgress,
    예정수: counts.todo,
  };

  const text = renderTemplate(s.template, scalars, lists, { plain: s.itemFormat, key: s.itemFormatKey });

  // 기록 갱신 (시간추적 모드에서 다음 주 비교용)
  const snap = {};
  for (const i of union.values()) if (i.pct !== null) snap[i.key] = i.pct;
  const weeks = { ...(history.weeks || {}), [weekKey]: snap };
  const keep = Object.keys(weeks).sort().slice(-12);
  const newHistory = { weeks: Object.fromEntries(keep.map((k) => [k, weeks[k]])) };

  return {
    text,
    warnings,
    history: newHistory,
    issues,
    meta: {
      user: me?.displayName || '',
      boardId,
      sprint: current?.name || '',
      previousSprint: previous?.name || '',
      sprintPct,
      lastWeekPct,
      prevPct,
      totalPct,
      week: `${mdDow(monday)} ~ ${mdDow(friday)}`,
      jql: mainJql,
      ...counts,
    },
  };
}

function previousSnapshot(history, weekKey) {
  const weeks = history?.weeks || {};
  const prior = Object.keys(weeks).filter((k) => k < weekKey).sort().pop();
  return prior ? weeks[prior] : {};
}
