// 백업 복원 전 검사
// 1) 형식 검사·정리: 손상되거나 조작된 백업으로 복원해 앱이 열리지 않게 되는 일을 막는다.
// 2) cURL 실행 설정 요약: 공유받은 백업 속 요청의 추가 인자(--proxy, --resolve, -k 등)는 요청을 다른 서버로 보내거나
//    인증서 검사를 끌 수 있으므로, 복원하기 전에 사용자에게 보여 준다.
import { uid } from './util.js';
import { newAuth, normalizeRequest, normalizeSsh } from './model.js';
import { parseExtraArgs } from './curl-runner.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));

function list(v, what) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`백업 파일의 ${what} 항목이 목록 형식이 아닙니다.`);
  return v.filter(isObj);
}

function vars(v) {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function normItems(items, depth) {
  if (depth > 50) throw new Error('백업 파일의 폴더 구조가 너무 깊습니다.');
  return (Array.isArray(items) ? items : []).filter(isObj).map((it) => {
    if (it.type === 'folder') {
      const out = { ...it, id: str(it.id) || uid('fld'), type: 'folder', name: str(it.name, '폴더'), items: normItems(it.items, depth + 1) };
      if (it.auth !== undefined) out.auth = isObj(it.auth) ? it.auth : newAuth('inherit');
      if (it.variables !== undefined) out.variables = vars(it.variables);
      return out;
    }
    return { ...it, id: str(it.id) || uid('req'), type: 'request', name: str(it.name, '요청'), request: normalizeRequest(isObj(it.request) ? it.request : {}) };
  });
}

/** 복원할 data 를 검사하고 정리한 사본을 돌려준다. 형식이 맞지 않으면 Error */
export function sanitizeBackupData(data) {
  if (!isObj(data)) throw new Error('백업 파일의 data 항목이 올바르지 않습니다.');
  const out = {};
  const cols = list(data.collections, 'collections');
  if (cols) {
    out.collections = cols.map((c) => ({
      ...c,
      id: str(c.id) || uid('col'),
      name: str(c.name, '컬렉션'),
      description: str(c.description),
      auth: isObj(c.auth) ? c.auth : newAuth('none'),
      variables: vars(c.variables),
      items: normItems(c.items, 0),
    }));
  }
  const envs = list(data.environments, 'environments');
  if (envs) {
    out.environments = envs.map((e) => {
      const env = { ...e, id: str(e.id) || uid('env'), name: str(e.name, '환경'), variables: vars(e.variables) };
      if (e.ssh !== undefined) env.ssh = normalizeSsh(e.ssh);
      return env;
    });
  }
  if (data.globals !== undefined && data.globals !== null) {
    if (!isObj(data.globals)) throw new Error('백업 파일의 globals 항목이 올바르지 않습니다.');
    out.globals = { ...data.globals, variables: vars(data.globals.variables) };
  }
  if (data.activeEnvId !== undefined) out.activeEnvId = typeof data.activeEnvId === 'string' ? data.activeEnvId : null;
  const history = list(data.history, 'history');
  if (history) {
    out.history = history.map((x) => ({ ...x, id: str(x.id) || uid('his'), request: normalizeRequest(isObj(x.request) ? x.request : {}) }));
  }
  const jar = list(data.cookieJar, 'cookieJar');
  if (jar) out.cookieJar = jar.filter((c) => typeof c.name === 'string');
  if (data.settings !== undefined && data.settings !== null) {
    if (!isObj(data.settings)) throw new Error('백업 파일의 settings 항목이 올바르지 않습니다.');
    out.settings = data.settings;
  }
  // 열린 탭 목록(workspace)은 백업에 넣지 않으므로 복원하지 않는다.
  return out;
}

function curlNotes(req) {
  const c = (req && req.settings && req.settings.curl) || {};
  const args = parseExtraArgs(c.extra).args;
  const notes = [];
  if (args.length) notes.push(args.join(' '));
  if (c.insecure) notes.push('-k (SSL 인증서 검사 끔)');
  return notes;
}

/**
 * 정리된 data 에서 cURL 로 실행할 때 적용되는 설정이 있는 요청과 SSH 환경을 찾는다.
 * → { requests: [{ where, notes }], ssh: [{ name, server }] }
 */
export function curlSettingsSummary(data) {
  const requests = [];
  const visit = (items, path) => {
    for (const it of items || []) {
      if (it.type === 'folder') visit(it.items, path.concat(it.name));
      else {
        const notes = curlNotes(it.request);
        if (notes.length) requests.push({ where: path.concat(it.name).join(' / '), notes });
      }
    }
  };
  for (const c of data.collections || []) visit(c.items, [c.name]);
  for (const x of data.history || []) {
    const notes = curlNotes(x.request);
    if (notes.length) requests.push({ where: `히스토리 / ${x.name || `${x.request.method} ${x.request.url}`}`, notes });
  }
  const ssh = (data.environments || [])
    .filter((e) => e.ssh && e.ssh.enabled && e.ssh.host)
    .map((e) => ({ name: e.name, server: `${e.ssh.user ? e.ssh.user + '@' : ''}${e.ssh.host}:${e.ssh.port}` }));
  return { requests, ssh };
}
