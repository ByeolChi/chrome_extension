// {{변수}} 치환
import { uuidv4 } from './util.js';

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const DYNAMIC = {
  $guid: () => uuidv4(),
  $randomUUID: () => uuidv4(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)],
  $randomEmail: () => `user${Math.floor(Math.random() * 100000)}@example.com`,
};

export const DYNAMIC_VARIABLES = Object.keys(DYNAMIC);
const isDynamic = (k) => Object.prototype.hasOwnProperty.call(DYNAMIC, k);

/**
 * 스코프 우선순위: environment > collection > globals
 * layers: [{name:'environment', vars:[...]}, {name:'collection', ...}, {name:'globals', ...}]
 */
export function buildScope(layers) {
  const map = new Map();
  // 낮은 우선순위부터 덮어쓰기
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    for (const v of layer.vars || []) {
      if (!v || v.enabled === false || !v.key) continue;
      map.set(String(v.key).trim(), { value: String(v.value ?? ''), source: layer.name });
    }
  }
  return map;
}

export function resolveString(str, scope, depth = 0) {
  if (str == null) return '';
  const s = String(str);
  if (!s.includes('{{')) return s;
  const out = s.replace(VAR_RE, (full, name) => {
    const key = name.trim();
    if (isDynamic(key)) return DYNAMIC[key]();
    const hit = scope && scope.get(key);
    if (hit) return hit.value;
    return full;
  });
  // 변수 값 안에 다른 변수가 있는 경우 (최대 5단계)
  if (depth < 5 && out !== s && out.includes('{{')) return resolveString(out, scope, depth + 1);
  return out;
}

export function findVariables(str) {
  const names = [];
  String(str || '').replace(VAR_RE, (_, n) => {
    names.push(n.trim());
    return _;
  });
  return names;
}

export function unresolvedVariables(str, scope) {
  return findVariables(str).filter((n) => !isDynamic(n) && !(scope && scope.has(n)));
}

// 요청 전체에 대해 변수 치환 (깊은 복사된 객체를 반환)
export function resolveRequest(req, scope) {
  const r = (s) => resolveString(s, scope);
  const kv = (list) => (list || []).map((x) => ({ ...x, key: r(x.key), value: r(x.value) }));
  return {
    ...req,
    url: r(req.url),
    params: kv(req.params),
    headers: kv(req.headers),
    cookies: kv(req.cookies),
    auth: {
      ...req.auth,
      bearer: { token: r(req.auth?.bearer?.token) },
      basic: { username: r(req.auth?.basic?.username), password: r(req.auth?.basic?.password) },
      apikey: { key: r(req.auth?.apikey?.key), value: r(req.auth?.apikey?.value), in: req.auth?.apikey?.in || 'header' },
    },
    body: {
      ...req.body,
      raw: r(req.body?.raw),
      urlencoded: kv(req.body?.urlencoded),
      formdata: (req.body?.formdata || []).map((x) => ({ ...x, key: r(x.key), value: x.type === 'file' ? x.value : r(x.value) })),
    },
  };
}
