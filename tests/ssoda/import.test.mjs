// OpenAPI·Swagger·HAR 가져오기, 경로 변수(/:id), Postman url.variable 테스트
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const mod = (f) => import(new URL(f, JS).href);
const { detectImport, exportRequest } = await mod('postman.js');
const { pathVarNames, syncPathVars, fillPathVars, newRequest } = await mod('model.js');
const { prepareRequest } = await mod('prepare.js');

const PET_YAML = `# 시험용 문서
openapi: 3.0.3
info:
  title: 펫 API
  version: 1.2.0
  description: 시험용
servers:
  - url: /api/v1
tags:
  - name: pets
    description: 동물
security:
  - bearerAuth: []
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    apiKey: { type: apiKey, in: header, name: X-API-Key }
  parameters:
    Limit: { name: limit, in: query, schema: { type: integer, default: 20 } }
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        id: { type: integer, format: int64, readOnly: true, example: 1234567890123456789 }
        name: { type: string, example: 바둑이 }
        born: { type: string, format: date }
        tags: { type: array, items: { $ref: '#/components/schemas/Tag' } }
        parent: { $ref: '#/components/schemas/Pet' }
    Tag:
      type: object
      properties:
        label: { type: string }
paths:
  /pets:
    get:
      tags: [pets]
      summary: 목록
      parameters:
        - $ref: '#/components/parameters/Limit'
        - { name: q, in: query, required: true, schema: { type: string }, example: 개 }
        - { name: X-Trace, in: header, schema: { type: string } }
        - { name: Accept, in: header, schema: { type: string } }
    post:
      tags: [pets]
      operationId: createPet
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, schema: { type: integer }, example: 7 }
    get:
      tags: [pets]
      summary: 하나
      security: [{ apiKey: [] }]
    delete:
      tags: [pets]
      summary: 지우기
      deprecated: true
      security: []
  /files/{name}.json:
    put:
      summary: 파일
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
                note: { type: string, example: 메모 }
  /health:
    get: {}
`;

const flat = (items, out = []) => {
  for (const it of items) it.type === 'folder' ? flat(it.items, out) : out.push(it);
  return out;
};
const kv = (list) => list.map((x) => [x.key, x.value, x.enabled]);

test('OpenAPI 3 YAML: 서버(상대 주소는 받은 주소 기준)·태그 폴더·매개변수·경로 변수·인증·본문 예시', () => {
  const r = detectImport(PET_YAML, { sourceUrl: 'https://api.test/docs/openapi.yaml' });
  assert.equal(r.kind, 'collection');
  assert.equal(r.source, 'openapi');
  assert.equal(r.count, 6);
  const c = r.collection;
  assert.equal(c.name, '펫 API');
  assert.match(c.description, /시험용[\s\S]*버전: 1\.2\.0/);
  assert.deepEqual(kv(c.variables), [['baseUrl', 'https://api.test/api/v1', true], ['token', '', true], ['apiKey', '', true]]);
  assert.deepEqual([c.auth.type, c.auth.bearer.token], ['bearer', '{{token}}']);
  assert.deepEqual(c.items.map((x) => x.name), ['pets', '파일', 'GET /health']);
  assert.equal(c.items[0].description, '동물');
  const [list, create, one, del] = c.items[0].items;
  assert.equal(list.name, '목록');
  assert.equal(list.request.url, '{{baseUrl}}/pets?q=개');
  assert.deepEqual(kv(list.request.params), [['limit', '20', false], ['q', '개', true]]);
  assert.deepEqual(kv(list.request.headers), [['X-Trace', '', false]]); // Accept 는 무시
  assert.equal(list.request.auth.type, 'inherit');
  assert.equal(create.name, 'createPet');
  assert.equal(create.request.method, 'POST');
  assert.equal(create.request.body.rawLanguage, 'json');
  const body = JSON.parse(create.request.body.raw);
  assert.deepEqual(body, { name: '바둑이', born: '2024-01-01', tags: [{ label: 'string' }], parent: null }); // readOnly id 는 뺌, 자기 참조는 멈춤
  assert.equal(one.request.url, '{{baseUrl}}/pets/:petId');
  assert.deepEqual(kv(one.request.pathVars), [['petId', '7', true]]);
  assert.deepEqual([one.request.auth.type, one.request.auth.apikey.key, one.request.auth.apikey.value, one.request.auth.apikey.in], ['apikey', 'X-API-Key', '{{apiKey}}', 'header']);
  assert.equal(del.request.auth.type, 'none');
  assert.match(del.request.description, /지원 중단/);
  const file = c.items[1].request;
  assert.equal(file.url, '{{baseUrl}}/files/{{name}}.json');
  assert.equal(file.body.mode, 'formdata');
  assert.deepEqual(file.body.formdata.map((f) => [f.key, f.type, f.value]), [['file', 'file', ''], ['note', 'text', '메모']]);
  assert.ok(r.warnings.some((w) => /\{name\}/.test(w) && /\{\{변수\}\}/.test(w)), r.warnings.join(' / '));
  assert.ok(r.warnings.some((w) => /파일을 골라야/.test(w)));
});

test('OpenAPI JSON: 본문 예시의 19자리 숫자가 바뀌지 않음, 서버 변수 기본값, 예시 목록(examples)', () => {
  const spec = '{"openapi":"3.1.0","info":{"title":"T"},"servers":[{"url":"https://{env}.api.test","variables":{"env":{"default":"dev"}}}],'
    + '"paths":{"/o":{"post":{"requestBody":{"content":{"application/json":{"examples":{"a":{"value":{"orderId":1234567890123456789,"amount":10.10}}}}}}}}}}';
  const r = detectImport(spec);
  const req = flat(r.collection.items)[0].request;
  assert.equal(r.collection.variables[0].value, 'https://dev.api.test');
  assert.ok(req.body.raw.includes('"orderId": 1234567890123456789'), req.body.raw);
  assert.ok(req.body.raw.includes('"amount": 10.10'), req.body.raw);
  assert.throws(() => detectImport('openapi: 3.0.0\ninfo:\n  title: x\n'), /paths/);
  assert.throws(() => detectImport('openapi: 3.0.0\npaths:\n  /a: [\n'), /YAML 을 읽을 수 없습니다/);
});

test('Swagger 2.0: host·basePath·schemes, Basic 인증, 폼·body 매개변수', () => {
  const spec = {
    swagger: '2.0', info: { title: '구 API', version: '1' }, host: 'old.test', basePath: '/v2', schemes: ['http'],
    securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }],
    paths: { '/users/{id}': {
      post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'id', in: 'path', required: true, type: 'string', 'x-example': 'u1' }, { name: 'email', in: 'formData', type: 'string', required: true, default: 'a@b.c' }] },
      put: { parameters: [{ in: 'body', name: 'body', schema: { type: 'object', properties: { n: { type: 'integer', example: 5 } } } }] },
    } },
  };
  const r = detectImport(JSON.stringify(spec));
  const reqs = flat(r.collection.items).map((x) => x.request);
  const post = reqs.find((x) => x.method === 'POST');
  const put = reqs.find((x) => x.method === 'PUT');
  assert.equal(r.collection.variables[0].value, 'http://old.test/v2');
  assert.deepEqual([r.collection.auth.type, r.collection.auth.basic.username], ['basic', '{{username}}']);
  assert.equal(post.url, '{{baseUrl}}/users/:id');
  assert.deepEqual(kv(post.pathVars), [['id', 'u1', true]]);
  assert.equal(post.body.mode, 'urlencoded');
  assert.deepEqual(kv(post.body.urlencoded), [['email', 'a@b.c', true]]);
  assert.equal(put.body.raw, '{\n  "n": 5\n}');
});

test('HAR: XHR·fetch 만, 브라우저가 정하는 헤더는 빼고, 호스트별 폴더, 본문, 비밀 헤더 알림', () => {
  const har = { log: { creator: { name: 'WebInspector', version: '537.36' }, pages: [{ startedDateTime: '2026-11-25T10:00:00.000Z' }], entries: [
    { _resourceType: 'document', request: { method: 'GET', url: 'https://app.test/', headers: [] } },
    { _resourceType: 'script', request: { method: 'GET', url: 'https://app.test/main.js', headers: [] } },
    { _resourceType: 'fetch', request: { method: 'POST', url: 'https://api.test/login?v=1', headers: [
      { name: ':authority', value: 'api.test' }, { name: 'content-type', value: 'application/json' }, { name: 'Cookie', value: 'sid=1' },
      { name: 'sec-ch-ua', value: 'x' }, { name: 'Content-Length', value: '10' }, { name: 'Accept-Encoding', value: 'gzip' }],
      postData: { mimeType: 'application/json', text: '{"id":"kim"}' } } },
    { _resourceType: 'xhr', request: { method: 'POST', url: 'https://app.test/form', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a', value: '1' }] } } },
  ] } };
  const r = detectImport(JSON.stringify(har));
  assert.equal(r.source, 'har');
  assert.equal(r.count, 2);
  assert.equal(r.collection.name, 'HAR 가져오기 2026-11-25 10:00');
  assert.deepEqual(r.collection.items.map((f) => f.name), ['api.test', 'app.test']);
  const login = r.collection.items[0].items[0];
  assert.equal(login.name, 'POST /login?…');
  assert.deepEqual(login.request.headers.map((x) => x.key), ['content-type', 'Cookie']);
  assert.deepEqual([login.request.body.mode, login.request.body.rawLanguage, login.request.body.raw], ['raw', 'json', '{"id":"kim"}']);
  assert.deepEqual(kv(login.request.params), [['v', '1', true]]);
  assert.deepEqual(kv(r.collection.items[1].items[0].request.body.urlencoded), [['a', '1', true]]);
  assert.ok(r.warnings.some((w) => /2개는 뺐습니다/.test(w)));
  assert.ok(r.warnings.some((w) => /Cookie·Authorization/.test(w)));
});

test('경로 변수: 이름 찾기(포트·시각·글자 섞인 칸은 아님), 표 맞추기, 값 넣기와 빈 값 알림', () => {
  assert.deepEqual(pathVarNames('{{base}}/users/:id/posts/:postId?x=:no#:no'), ['id', 'postId']);
  assert.deepEqual(pathVarNames('http://host:8080/at/12:30/:a.json/:x/:x'), ['x']);
  const old = [{ id: 'k1', key: 'id', value: '42', enabled: true, description: 'd' }, { id: 'k2', key: 'gone', value: 'x', enabled: true, description: '' }];
  const synced = syncPathVars('/u/:new/:id', old);
  assert.deepEqual(synced.map((x) => [x.key, x.value]), [['new', ''], ['id', '42']]);
  assert.equal(synced[1].id, 'k1'); // 있던 줄은 그대로
  const missing = [];
  assert.equal(fillPathVars('/u/:id/:pid?q=:id', new Map([['id', '7'], ['pid', '']]), missing), '/u/7/:pid?q=:id');
  assert.deepEqual(missing, ['pid']);
  const p = prepareRequest(newRequest({ url: '{{base}}/u/:id', pathVars: [{ key: 'id', value: '{{uid}}' }] }), { scope: new Map([['base', { value: 'https://h.test' }], ['uid', { value: '9' }]]) });
  assert.equal(p.url, 'https://h.test/u/9');
  assert.deepEqual(p.warnings, []);
});

test('Postman: url.variable → Path Variables 로 가져오고(주소의 :id 는 그대로), 내보낼 때 url.variable 로', () => {
  const pm = { info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [
    { name: 'one', request: { method: 'GET', url: { raw: '{{base}}/users/:id', host: ['{{base}}'], path: ['users', ':id'], variable: [{ key: 'id', value: '5', description: '사용자' }] } } },
  ] };
  const r = detectImport(JSON.stringify(pm));
  const req = r.collection.items[0].request;
  assert.equal(req.url, '{{base}}/users/:id');
  assert.deepEqual(req.pathVars.map((x) => [x.key, x.value, x.description]), [['id', '5', '사용자']]);
  const out = exportRequest(req);
  assert.deepEqual(out.url.variable, [{ key: 'id', value: '5', description: '사용자' }]);
  assert.deepEqual(out.url.path, ['users', ':id']);
});
