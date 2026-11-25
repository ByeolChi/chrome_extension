// OpenAPI 3.x · Swagger 2.0 문서 → Ssoda 컬렉션
// - 서버 주소는 컬렉션 변수 {{baseUrl}}, 경로의 {id} 는 /:id 경로 변수(Params 탭 Path Variables)로
// - 태그마다 폴더. 요청 이름은 summary → operationId → "METHOD 경로"
// - 매개변수: 경로 → Path Variables, 쿼리 → Params, 헤더 → Headers, 쿠키 → Cookies (필수인 것만 켬)
// - 본문: JSON 은 예시(example·examples, 없으면 스키마로 만든 예시)를 raw JSON 으로, 폼은 필드로
// - 인증: securitySchemes → 컬렉션 인증(Bearer {{token}} · Basic {{username}}/{{password}} · API Key {{apiKey}}). 요청마다 다르면 그 요청에
// - $ref 는 같은 문서 안(#/…)만 따라간다. 숫자는 원문 그대로 둔 값(JsonNum)도 받는다 (19자리 예시 ID)
import { newCollection, newFolder, newRequestItem, newRequest, newAuth, syncPathVars, buildUrlFromParams } from './model.js';
import { kvRow } from './util.js';
import { JsonNum, valueText } from './checks.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum);
// OpenAPI 에서 매개변수로 적어도 무시하는 헤더 (본문 형식·인증으로 정해짐)
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

export function isOpenApi(obj) {
  return isObj(obj) && (has(obj, 'openapi') || has(obj, 'swagger')) && isObj(obj.paths);
}

/** JSON 글 (숫자 원문·프로토타입 없는 객체 그대로, 2칸 들여쓰기) */
export function prettyJson(v, ind = '') {
  const next = ind + '  ';
  if (v instanceof JsonNum) return v.text;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => next + prettyJson(x, next)).join(',\n') + '\n' + ind + ']' : '[]';
  const keys = Object.keys(v);
  return keys.length ? '{\n' + keys.map((k) => next + JSON.stringify(k) + ': ' + prettyJson(v[k], next)).join(',\n') + '\n' + ind + '}' : '{}';
}

function pointer(doc, p) {
  let o = doc;
  for (const part of p.split('/').slice(1)) {
    let k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    try {
      k = decodeURIComponent(k);
    } catch (e) {
      /* 그대로 */
    }
    if (!has(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

const STRING_EXAMPLES = {
  'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', time: '00:00:00', email: 'user@example.com', uuid: '00000000-0000-0000-0000-000000000000',
  uri: 'https://example.com', url: 'https://example.com', hostname: 'example.com', ipv4: '127.0.0.1', ipv6: '::1', byte: 'U3NvZGE=', binary: '', password: '',
};

/** 문서 하나를 다루는 도구: $ref 따라가기, 스키마로 예시 만들기 */
function context(spec, warnings) {
  const deref = (node) => {
    let n = node;
    const seen = new Set();
    while (isObj(n) && typeof n.$ref === 'string') {
      const ref = n.$ref;
      if (seen.has(ref)) return {};
      seen.add(ref);
      if (!ref.startsWith('#')) {
        warnings.add(`다른 파일을 가리키는 $ref 는 따라가지 않았습니다: ${ref}`);
        return {};
      }
      const next = pointer(spec, ref.slice(1));
      if (next === undefined) {
        warnings.add(`$ref 가 가리키는 곳을 찾지 못했습니다: ${ref}`);
        return {};
      }
      n = next;
    }
    return n;
  };
  // forRequest: 요청 본문용이면 readOnly 속성은 뺀다
  const example = (schema, forRequest, depth = 0, refs = new Set()) => {
    if (!isObj(schema)) return null;
    if (typeof schema.$ref === 'string') {
      if (refs.has(schema.$ref) || depth > 8) return null; // 자기 자신을 가리키는 스키마
      const next = new Set(refs).add(schema.$ref);
      return example(deref(schema), forRequest, depth + 1, next);
    }
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.default !== undefined) return schema.default;
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (Array.isArray(schema.allOf) && schema.allOf.length) {
      const parts = schema.allOf.map((s) => example(s, forRequest, depth + 1, refs));
      const objs = parts.filter(isObj);
      if (objs.length) return Object.assign({}, ...objs);
      return parts.find((x) => x !== null && x !== undefined) ?? null;
    }
    const alt = schema.oneOf || schema.anyOf;
    if (Array.isArray(alt) && alt.length) return example(alt[0], forRequest, depth + 1, refs);
    let type = schema.type;
    if (Array.isArray(type)) type = type.find((t) => t !== 'null') || type[0];
    if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : undefined;
    if (depth > 8) return type === 'array' ? [] : type === 'object' ? {} : null;
    switch (type) {
      case 'object': {
        const o = {};
        const props = isObj(schema.properties) ? schema.properties : {};
        for (const k of Object.keys(props).slice(0, 60)) {
          const ps = deref(props[k]);
          if (forRequest && isObj(ps) && ps.readOnly) continue;
          if (!forRequest && isObj(ps) && ps.writeOnly) continue;
          o[k] = example(props[k], forRequest, depth + 1, refs);
        }
        return o;
      }
      case 'array': {
        const it = example(schema.items, forRequest, depth + 1, refs);
        return it === null || it === undefined ? [] : [it];
      }
      case 'string':
        return STRING_EXAMPLES[schema.format] ?? 'string';
      case 'integer':
      case 'number':
        return schema.minimum ?? 0;
      case 'boolean':
        return true;
      default:
        return null;
    }
  };
  return { deref, example };
}

// 매개변수·필드의 값으로 쓸 글 (예시 → 스키마 예시 → 기본값 → 목록의 첫 값)
function paramValue(p, ctx) {
  let v = p.example;
  if (v === undefined && isObj(p.examples)) {
    const first = Object.values(p.examples)[0];
    v = isObj(first) ? ctx.deref(first).value : undefined;
  }
  if (v === undefined) v = p['x-example'];
  if (v === undefined && isObj(p.schema)) {
    const s = ctx.deref(p.schema);
    v = s.example ?? s.default ?? (Array.isArray(s.enum) ? s.enum[0] : undefined);
  }
  if (v === undefined) v = p.default ?? (Array.isArray(p.enum) ? p.enum[0] : undefined);
  return v === undefined || v === null ? '' : valueText(v);
}

function descOf(...parts) {
  return parts.filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
}

// 서버 주소 (3.x servers / 2.0 schemes·host·basePath). 상대 주소는 문서를 받은 주소 기준으로
function baseUrlOf(spec, swagger2, sourceUrl, warnings) {
  let src = null;
  try {
    src = sourceUrl ? new URL(sourceUrl) : null;
  } catch (e) {
    src = null;
  }
  if (swagger2) {
    const host = spec.host || (src ? src.host : '');
    if (!host) {
      warnings.add('문서에 서버 주소(host)가 없어 컬렉션 변수 {{baseUrl}} 을 직접 채워야 합니다.');
      return '';
    }
    const scheme = (Array.isArray(spec.schemes) && spec.schemes[0]) || (src ? src.protocol.replace(':', '') : 'https');
    return `${scheme}://${host}${spec.basePath && spec.basePath !== '/' ? spec.basePath : ''}`.replace(/\/+$/, '');
  }
  const server = Array.isArray(spec.servers) ? spec.servers.find((s) => isObj(s) && s.url) : null;
  if (server) {
    let url = String(server.url).replace(/\{([^}]+)\}/g, (m, name) => {
      const v = isObj(server.variables) ? server.variables[name] : null;
      const d = isObj(v) ? v.default ?? (Array.isArray(v.enum) ? v.enum[0] : undefined) : undefined;
      return d !== undefined && d !== null ? valueText(d) : m;
    });
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      if (src) url = new URL(url, src).href;
      else warnings.add(`서버 주소가 상대 주소(${url})라 {{baseUrl}} 의 앞부분(https://호스트)을 직접 채워야 합니다.`);
    }
    return url.replace(/\/+$/, '');
  }
  if (src) return src.origin;
  warnings.add('문서에 서버 주소가 없어 컬렉션 변수 {{baseUrl}} 을 직접 채워야 합니다.');
  return '';
}

// 보안 방식 하나 → Ssoda 인증. vars: 컬렉션 변수로 만들 이름
function authOf(def, name, warnings) {
  if (!isObj(def)) return null;
  const type = String(def.type || '').toLowerCase();
  const bearer = () => ({ auth: { ...newAuth('bearer'), bearer: { token: '{{token}}' } }, vars: ['token'] });
  if (type === 'http') {
    const sch = String(def.scheme || '').toLowerCase();
    if (sch === 'bearer') return bearer();
    if (sch === 'basic') return { auth: { ...newAuth('basic'), basic: { username: '{{username}}', password: '{{password}}' } }, vars: ['username', 'password'] };
    warnings.add(`인증 ${name}: HTTP ${def.scheme} 방식은 직접 설정해야 합니다.`);
    return null;
  }
  if (type === 'basic') return { auth: { ...newAuth('basic'), basic: { username: '{{username}}', password: '{{password}}' } }, vars: ['username', 'password'] };
  if (type === 'apikey') {
    if (def.in !== 'header' && def.in !== 'query') {
      warnings.add(`인증 ${name}: 쿠키로 보내는 API Key(${def.name})는 Cookies 탭에 직접 넣으세요.`);
      return null;
    }
    return { auth: { ...newAuth('apikey'), apikey: { key: String(def.name || 'X-API-Key'), value: '{{apiKey}}', in: def.in } }, vars: ['apiKey'] };
  }
  if (type === 'oauth2' || type === 'openidconnect') {
    warnings.add(`인증 ${name}: OAuth2·OpenID Connect 는 토큰을 받아 컬렉션 변수 {{token}} 에 넣으면 Bearer 로 보냅니다.`);
    return bearer();
  }
  return null;
}

/**
 * OpenAPI·Swagger 문서 → { collection, warnings }
 * opts.sourceUrl: 문서를 받은 주소 (서버 주소가 상대 주소일 때 기준)
 */
export function importOpenApi(spec, { sourceUrl = '' } = {}) {
  const warnings = new Set();
  const swagger2 = has(spec, 'swagger') && !has(spec, 'openapi');
  const ctx = context(spec, warnings);
  const info = isObj(spec.info) ? spec.info : {};
  const col = newCollection(String(info.title || 'OpenAPI').trim() || 'OpenAPI');
  col.description = descOf(info.description, info.version != null ? `버전: ${valueText(info.version)}` : '');
  const vars = new Map([['baseUrl', baseUrlOf(spec, swagger2, sourceUrl, warnings)]]);

  // 인증
  const schemes = ctx.deref(swagger2 ? spec.securityDefinitions : spec.components && spec.components.securitySchemes) || {};
  const authFor = (requirements) => {
    if (!Array.isArray(requirements)) return undefined;
    if (!requirements.length || requirements.every((r) => isObj(r) && !Object.keys(r).length)) return { auth: newAuth('none'), vars: [], key: '' };
    for (const req of requirements) {
      for (const name of Object.keys(isObj(req) ? req : {})) {
        const a = authOf(ctx.deref(schemes[name]), name, warnings);
        if (a) return { ...a, key: name };
      }
    }
    return null;
  };
  const global = authFor(spec.security);
  col.auth = global ? global.auth : newAuth('none');
  for (const v of (global && global.vars) || []) vars.set(v, '');

  // 태그 → 폴더 (문서의 tags 순서, 그 뒤로 처음 나온 순서)
  const folders = new Map();
  const folderOf = (tag) => {
    if (!folders.has(tag)) {
      const f = newFolder(tag);
      const t = Array.isArray(spec.tags) ? spec.tags.find((x) => isObj(x) && x.name === tag) : null;
      if (t && t.description) f.description = String(t.description);
      folders.set(tag, f);
    }
    return folders.get(tag);
  };
  if (Array.isArray(spec.tags)) spec.tags.forEach((t) => isObj(t) && t.name && folderOf(String(t.name)));
  const rootItems = [];
  let count = 0;
  const partialParams = new Set();

  for (const path of Object.keys(spec.paths)) {
    const item = ctx.deref(spec.paths[path]);
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      if (!isObj(item[method])) continue;
      const op = item[method];
      count++;
      // 매개변수: 경로 수준 + 동작 수준 (같은 이름·위치는 동작 쪽이 이김)
      const params = new Map();
      for (const p of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const d = ctx.deref(p);
        if (isObj(d) && d.name && d.in) params.set(`${d.in}:${d.name}`, d);
      }
      // 경로: {id} 가 칸 전체면 /:id 경로 변수, 칸 일부면 {{id}} 변수
      let urlPath = String(path).split('/').map((seg) => {
        const m = seg.match(/^\{([^{}]+)\}$/);
        if (m) return ':' + m[1].replace(/[^A-Za-z0-9_-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
        return seg.replace(/\{([^{}]+)\}/g, (x, n) => {
          partialParams.add(n);
          return `{{${n}}}`;
        });
      }).join('/');
      const req = newRequest({ method: method.toUpperCase(), url: '{{baseUrl}}' + urlPath });
      const pathVals = [];
      const query = [];
      for (const p of params.values()) {
        const value = paramValue(p, ctx);
        const on = !!p.required;
        const desc = typeof p.description === 'string' ? p.description : '';
        if (p.in === 'path') {
          const key = String(p.name).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
          pathVals.push(kvRow(key, value, true, { description: desc }));
        } else if (p.in === 'query') query.push(kvRow(String(p.name), value, on, { description: desc }));
        else if (p.in === 'header') {
          if (!IGNORED_HEADERS.has(String(p.name).toLowerCase())) req.headers.push(kvRow(String(p.name), value, on, { description: desc }));
        } else if (p.in === 'cookie') req.cookies.push(kvRow(String(p.name), value, on, { description: desc }));
      }
      req.pathVars = syncPathVars(req.url, pathVals);
      req.params = query;
      req.url = buildUrlFromParams(req.url, query);

      // 본문
      if (swagger2) body2(req, op, spec, params, ctx, warnings);
      else body3(req, ctx.deref(op.requestBody), ctx, warnings);

      // 인증: 문서 전체와 다르면 이 요청에
      if (Array.isArray(op.security)) {
        const a = authFor(op.security);
        if (a && (!global || a.key !== global.key)) {
          req.auth = a.auth;
          for (const v of a.vars) if (!vars.has(v)) vars.set(v, '');
        }
      }
      req.description = descOf(op.summary && op.description ? op.summary : '', op.description, op.deprecated ? '⚠ 지원 중단(deprecated)된 API 입니다.' : '');
      const name = String(op.summary || op.operationId || `${method.toUpperCase()} ${path}`).trim().slice(0, 120);
      const ri = newRequestItem(name, req);
      const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : null;
      if (tag) folderOf(tag).items.push(ri);
      else rootItems.push(ri);
      if (isObj(op.callbacks) && Object.keys(op.callbacks).length) warnings.add('콜백(callbacks)은 가져오지 않았습니다.');
    }
  }
  if (!count) warnings.add('문서에 API(paths 의 get·post 등)가 없습니다.');
  if (partialParams.size) warnings.add(`경로 칸의 일부인 매개변수 ${[...partialParams].map((n) => `{${n}}`).join(', ')} 는 {{변수}} 로 바꿨습니다. 환경이나 컬렉션 변수에 값을 넣으세요.`);
  if (has(spec, 'webhooks')) warnings.add('웹훅(webhooks)은 가져오지 않았습니다.');
  col.items = [...[...folders.values()].filter((f) => f.items.length), ...rootItems];
  col.variables = [...vars].map(([k, v]) => kvRow(k, v, true, { description: k === 'baseUrl' ? 'OpenAPI 서버 주소' : '인증 값 (직접 넣으세요)' }));
  return { collection: col, warnings: [...warnings], count };
}

// 미디어 형식 하나의 예시 (examples 의 첫 값 → example → 스키마로 만든 예시)
function mediaExample(media, ctx) {
  if (!isObj(media)) return undefined;
  if (media.example !== undefined) return media.example;
  if (isObj(media.examples)) {
    const first = Object.values(media.examples)[0];
    const ex = isObj(first) ? ctx.deref(first) : null;
    if (ex && ex.value !== undefined) return ex.value;
  }
  return media.schema ? ctx.example(media.schema, true) : undefined;
}

function jsonBody(ex) {
  if (typeof ex === 'string') {
    const t = ex.trim();
    if (t.startsWith('{') || t.startsWith('[')) return ex; // 예시를 JSON 글로 적은 문서
    return JSON.stringify(ex);
  }
  return ex === undefined ? '{}' : prettyJson(ex);
}

function formFields(schema, ctx, required = []) {
  const s = ctx.deref(schema);
  const props = isObj(s) && isObj(s.properties) ? s.properties : {};
  const req = new Set(Array.isArray(s && s.required) ? s.required : required);
  return Object.keys(props).map((k) => {
    const ps = ctx.deref(props[k]);
    const file = isObj(ps) && (ps.format === 'binary' || ps.type === 'file' || (ps.type === 'array' && isObj(ps.items) && ctx.deref(ps.items).format === 'binary'));
    const ex = file ? '' : valueText(ctx.example(props[k], true) ?? '');
    return { key: k, value: ex, file, on: req.has(k) || !req.size, desc: isObj(ps) && typeof ps.description === 'string' ? ps.description : '' };
  });
}

// OpenAPI 3.x requestBody
function body3(req, rb, ctx, warnings) {
  if (!isObj(rb) || !isObj(rb.content)) return;
  const types = Object.keys(rb.content);
  if (!types.length) return;
  const pick = types.find((t) => /^application\/json\b/i.test(t)) || types.find((t) => /[/+]json\b/i.test(t))
    || types.find((t) => /x-www-form-urlencoded/i.test(t)) || types.find((t) => /multipart\/form-data/i.test(t))
    || types.find((t) => /xml/i.test(t)) || types.find((t) => /^text\//i.test(t)) || types[0];
  const media = rb.content[pick];
  if (/json/i.test(pick)) {
    req.body.mode = 'raw';
    req.body.rawLanguage = 'json';
    req.body.raw = jsonBody(mediaExample(media, ctx));
    if (!/^application\/json\b/i.test(pick)) req.headers.push(kvRow('Content-Type', pick));
  } else if (/x-www-form-urlencoded/i.test(pick) || /multipart\/form-data/i.test(pick)) {
    const multi = /multipart/i.test(pick);
    const fields = formFields(media && media.schema, ctx);
    req.body.mode = multi ? 'formdata' : 'urlencoded';
    const rows = fields.map((f) => (multi && f.file
      ? kvRow(f.key, '', f.on, { type: 'file', file: null, description: f.desc })
      : kvRow(f.key, f.value, f.on, multi ? { type: 'text', file: null, description: f.desc } : { description: f.desc })));
    if (multi) req.body.formdata = rows;
    else req.body.urlencoded = rows;
    if (multi && fields.some((f) => f.file)) warnings.add('파일을 올리는 form-data 칸은 Body 탭에서 파일을 골라야 합니다.');
  } else if (/xml|^text\//i.test(pick)) {
    const ex = mediaExample(media, ctx);
    req.body.mode = 'raw';
    req.body.rawLanguage = /xml/i.test(pick) ? 'xml' : 'text';
    req.body.raw = typeof ex === 'string' ? ex : '';
    req.headers.push(kvRow('Content-Type', pick));
  } else {
    req.body.mode = 'binary';
    req.body.binary = null;
    req.headers.push(kvRow('Content-Type', pick));
    warnings.add(`${pick} 본문은 Body 탭에서 파일을 골라야 합니다.`);
  }
}

// Swagger 2.0: in: body 매개변수 → JSON, in: formData → 폼
function body2(req, op, spec, params, ctx, warnings) {
  const consumes = (Array.isArray(op.consumes) && op.consumes) || (Array.isArray(spec.consumes) && spec.consumes) || [];
  const bodyParam = [...params.values()].find((p) => p.in === 'body');
  const form = [...params.values()].filter((p) => p.in === 'formData');
  if (bodyParam) {
    const ct = consumes.find((t) => /json/i.test(t)) || 'application/json';
    req.body.mode = 'raw';
    req.body.rawLanguage = 'json';
    const ex = bodyParam['x-example'] !== undefined ? bodyParam['x-example'] : ctx.example(bodyParam.schema, true);
    req.body.raw = jsonBody(ex);
    if (!/^application\/json\b/i.test(ct)) req.headers.push(kvRow('Content-Type', ct));
  } else if (form.length) {
    const multi = consumes.some((t) => /multipart/i.test(t)) || form.some((p) => p.type === 'file');
    req.body.mode = multi ? 'formdata' : 'urlencoded';
    const rows = form.map((p) => (multi && p.type === 'file'
      ? kvRow(String(p.name), '', !!p.required, { type: 'file', file: null, description: p.description || '' })
      : kvRow(String(p.name), paramValue(p, ctx), !!p.required, multi ? { type: 'text', file: null, description: p.description || '' } : { description: p.description || '' })));
    if (multi) req.body.formdata = rows;
    else req.body.urlencoded = rows;
    if (form.some((p) => p.type === 'file')) warnings.add('파일을 올리는 form-data 칸은 Body 탭에서 파일을 골라야 합니다.');
  }
}
