// Server-Sent Events(text/event-stream) 해석
// HTML 표준 "Interpreting an event stream" 규칙을 따른다.
// - 줄 끝은 CRLF·LF·CR 모두. 빈 줄에서 이벤트 하나를 내보낸다
// - ":" 로 시작하는 줄은 주석(연결 유지용 ping 등) → 이벤트로 내보내지 않고 개수만 센다
// - "필드: 값" 에서 값 앞 공백 하나는 뺀다. 필드는 event·data·id·retry 만 쓴다
// - data 가 없는 이벤트는 내보내지 않는다. 스트림이 빈 줄 없이 끝나면 마지막 이벤트는 내보내지 않는다(incomplete 로 따로 돌려줌)

export const SSE_CONTENT_TYPE = /^\s*text\/event-stream\b/i;

export function isEventStream(contentType) {
  return SSE_CONTENT_TYPE.test(String(contentType || ''));
}

/**
 * 조금씩 들어오는 글을 이어서 해석한다.
 * push(text, t): 새로 끝난 이벤트 목록. t 는 이벤트에 붙일 시각(ms, 스트림 시작 기준)
 * end(): 스트림이 끝났을 때 빈 줄을 못 받아 내보내지 않은 내용 { incomplete: string | null }
 * 이벤트: { n, t, type, data, id, retry }
 */
export function createSseParser() {
  let buf = '';
  let first = true;
  let data = null; // 문자열 배열 (data 줄마다 하나)
  let type = '';
  let lastId = '';
  let retry = null;
  let raw = []; // 아직 내보내지 않은 이벤트의 원래 줄 (incomplete 용)
  let n = 0;
  let comments = 0;

  const dispatch = (t, out) => {
    raw = [];
    if (data === null) {
      type = '';
      retry = null;
      return;
    }
    n += 1;
    const ev = { n, t: t == null ? null : Math.round(t), type: type || 'message', data: data.join('\n'), id: lastId };
    if (retry != null) ev.retry = retry;
    out.push(ev);
    data = null;
    type = '';
    retry = null;
  };

  const line = (l, t, out) => {
    if (l === '') return dispatch(t, out);
    if (l[0] === ':') {
      comments += 1;
      return;
    }
    raw.push(l);
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') (data || (data = [])).push(value);
    else if (field === 'event') type = value;
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  };

  return {
    push(text, t = null) {
      const out = [];
      buf += String(text || '');
      if (first && buf) {
        if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
        first = false;
      }
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        // CR 로 끝났으면 다음 조각이 LF 로 시작할 수 있으니(CRLF) 기다린다
        if (c === 13 && i === buf.length - 1) break;
        line(buf.slice(start, i), t, out);
        if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
      }
      buf = buf.slice(start);
      return out;
    },
    end() {
      const rest = buf.replace(/\r$/, '');
      const pending = [...raw, ...(rest ? [rest] : [])].filter((l) => l !== '');
      buf = '';
      return { incomplete: pending.length ? pending.join('\n') : null };
    },
    get count() {
      return n;
    },
    get comments() {
      return comments;
    },
  };
}

/** 한 번에 받은 글 전체 → { events, comments, incomplete } */
export function parseSse(text) {
  const p = createSseParser();
  const events = p.push(text);
  const { incomplete } = p.end();
  return { events, comments: p.comments, incomplete };
}
