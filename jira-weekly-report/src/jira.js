// Jira Cloud REST 클라이언트 (GET 전용 — 쿠키 로그인에서도 XSRF 문제 없음)

export class JiraError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // 'auth' | 'network' | 'http' | 'config'
    this.status = status;
  }
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Jira 보드 주소 → { baseUrl, projectKey, boardId }
 * 예) https://raoncorp.atlassian.net/jira/software/c/projects/SAN/boards/281
 *     https://raoncorp.atlassian.net/secure/RapidBoard.jspa?rapidView=281&projectKey=SAN
 */
export function parseBoardUrl(str) {
  let u;
  try {
    u = new URL(String(str || '').trim());
  } catch {
    return null;
  }
  const proj = u.pathname.match(/\/projects\/([A-Za-z][A-Za-z0-9_]*)/);
  const board = u.pathname.match(/\/boards\/(\d+)/);
  const boardId = board?.[1] || u.searchParams.get('rapidView') || '';
  const projectKey = (proj?.[1] || u.searchParams.get('projectKey') || '').toUpperCase();
  if (!boardId && !projectKey) return null;
  return { baseUrl: u.origin, projectKey, boardId };
}

export class JiraClient {
  constructor(settings, fetchImpl) {
    this.s = settings;
    this.base = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    if (!/^https:\/\//.test(this.base)) {
      throw new JiraError('config', 'Jira 주소는 https:// 로 시작해야 합니다. 설정을 확인해 주세요.');
    }
  }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    const headers = { Accept: 'application/json' };
    const useToken = this.s.authMode === 'token';
    if (useToken) {
      if (!this.s.email || !this.s.apiToken) {
        throw new JiraError('config', 'API 토큰 방식은 이메일과 토큰이 필요합니다. 설정을 확인해 주세요.');
      }
      headers.Authorization = 'Basic ' + toBase64(`${this.s.email.trim()}:${this.s.apiToken.trim()}`);
    }

    let res;
    try {
      res = await this.fetch(url.toString(), {
        method: 'GET',
        headers,
        credentials: useToken ? 'omit' : 'include',
      });
    } catch (e) {
      throw new JiraError('network', `Jira(${this.base})에 연결할 수 없습니다. 네트워크/VPN 상태를 확인해 주세요.`);
    }

    if (res.status === 401) {
      throw new JiraError(
        'auth',
        useToken
          ? 'API 토큰 인증에 실패했습니다. 이메일/토큰을 확인해 주세요.'
          : 'Jira에 로그인되어 있지 않습니다. Jira를 열어 로그인한 뒤 다시 시도해 주세요.',
        401
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join(' ');
      } catch {
        /* 무시 */
      }
      throw new JiraError('http', `Jira 오류 (${res.status})${detail ? ': ' + detail : ''}`, res.status);
    }
    return res.json();
  }

  myself() {
    return this.get('/rest/api/3/myself');
  }

  statuses() {
    return this.get('/rest/api/3/status');
  }

  fields() {
    return this.get('/rest/api/3/field');
  }

  /** JQL 검색 (신규 /search/jql 엔드포인트, nextPageToken 페이지네이션) */
  async search(jql, fields, { expand, pageSize = 100, max = 2000 } = {}) {
    const out = [];
    let nextPageToken;
    for (let guard = 0; guard < 100; guard++) {
      const data = await this.get('/rest/api/3/search/jql', {
        jql,
        fields: fields.join(','),
        maxResults: pageSize,
        nextPageToken,
        expand,
      });
      out.push(...(data.issues || []));
      nextPageToken = data.nextPageToken;
      if (data.isLast || !nextPageToken || out.length >= max) break;
    }
    return out.slice(0, max);
  }

  async _agilePaged(path, params = {}) {
    const out = [];
    let startAt = 0;
    for (let guard = 0; guard < 50; guard++) {
      const data = await this.get(path, { ...params, startAt, maxResults: 50 });
      const values = data.values || [];
      out.push(...values);
      if (data.isLast || values.length === 0) break;
      startAt += values.length;
    }
    return out;
  }

  boards(projectKey) {
    return this._agilePaged('/rest/agile/1.0/board', { projectKeyOrId: projectKey });
  }

  sprints(boardId) {
    return this._agilePaged(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`, {
      state: 'active,closed,future',
    });
  }
}
