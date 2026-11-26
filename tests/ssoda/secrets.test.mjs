// 비밀 변수 보관함(ssoda/js/secrets.js)·스코프(variables.js) 테스트
// 실행: 저장소 최상위에서 npm test
// 화면(가린 입력칸·잠금 해제 창)과 chrome.storage 에 실제로 무엇이 남는지는 브라우저 시험(tests/e2e/ssoda)이 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const JS = new URL('../../ssoda/js/', import.meta.url);
const mod = (f) => import(new URL(f, JS).href);
const {
  deriveKey, sealValues, openValues, looksSecretName, redactSecrets, hasLiteralSecret, stripLiteralSecrets, vault, MASK, toB64,
} = await mod('secrets.js');
const { buildScope, resolveString } = await mod('variables.js');
const { store } = await mod('store.js');
const { exportPostmanEnvironment, importPostmanEnvironment } = await mod('postman.js');

store.suspended = true; // 시험에서는 저장하지 않는다 (보관함의 debounce 저장이 Node 에서 localStorage 를 찾지 않게)

test('암호화: 같은 비밀번호로만 열리고, 암호문에 값이 보이지 않으며, 매번 iv 가 다름', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey('correct horse', salt, 1000);
  const values = { kv_a: 'eyJhbGciOiJIUzI1NiJ9.secret-token', kv_b: '비밀번호123' };
  const e1 = await sealValues(values, key, salt, 1000);
  const e2 = await sealValues(values, key, salt, 1000);
  assert.notEqual(e1.iv, e2.iv);
  assert.ok(!JSON.stringify(e1).includes('secret-token') && !JSON.stringify(e1).includes('비밀번호'));
  assert.deepEqual(await openValues(e1, key), values);
  const wrong = await deriveKey('wrong horse', salt, 1000);
  await assert.rejects(() => openValues(e1, wrong));
  assert.equal(e1.salt, toB64(salt));
  assert.equal(e1.iter, 1000);
});

test('비밀처럼 보이는 이름 (Tests 탭이 새로 만드는 변수의 기본값)', () => {
  for (const n of ['token', 'accessToken', 'access_token', 'refresh-token', 'apiKey', 'API_KEY', 'password', 'passwd', 'pwd', 'clientSecret', 'sessionId', 'jwt', 'otp'])
    assert.ok(looksSecretName(n), n);
  for (const n of ['userId', 'baseUrl', 'orderNo', 'name', 'count', 'keyword']) assert.ok(!looksSecretName(n), n);
});

test('화면 글에서 비밀 값을 가림: 긴 값부터, 짧은 값은 그대로, Basic 인증 안에 싼 값도', () => {
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abc.def.ghi" https://x', ['abc.def.ghi']), `curl -H "Authorization: Bearer ${MASK}" https://x`);
  assert.equal(redactSecrets('pw=hunter2hunter2&p=hunter2', ['hunter2', 'hunter2hunter2']), `pw=${MASK}&p=${MASK}`);
  assert.equal(redactSecrets('id=abc', ['abc']), 'id=abc'); // 4글자 미만은 건드리지 않는다
  const basic = 'Basic ' + Buffer.from('admin:s3cr3t!pw').toString('base64');
  assert.equal(redactSecrets(`> Authorization: ${basic}`, ['s3cr3t!pw']), `> Authorization: Basic ${MASK}`);
  assert.equal(redactSecrets(`> Authorization: ${basic}`, ['other-secret']), `> Authorization: ${basic}`);
  assert.equal(redactSecrets('그대로', []), '그대로');
});

test('히스토리: 직접 쓴 토큰·비밀번호·인증 머리글은 지우고 {{변수}} 는 남김', () => {
  assert.ok(hasLiteralSecret('eyJhbGciOiJIUzI1NiJ9.x'));
  assert.ok(hasLiteralSecret('Bearer eyJhbGci'));
  assert.ok(!hasLiteralSecret('Bearer {{token}}'));
  assert.ok(!hasLiteralSecret('{{token}}'));
  assert.ok(!hasLiteralSecret(''));
  const req = {
    auth: { type: 'bearer', bearer: { token: 'eyJhbGciOiJIUzI1NiJ9.payload' }, basic: { username: 'kim', password: '{{pw}}' }, apikey: { key: 'X-Key', value: 'live_1234567890' } },
    headers: [
      { key: 'Authorization', value: 'Bearer {{token}}' },
      { key: 'Cookie', value: 'SESSION=abcdef123456' },
      { key: 'X-Api-Key', value: 'k-0987654321' },
      { key: 'Accept', value: 'application/json' },
    ],
  };
  const removed = stripLiteralSecrets(req);
  assert.deepEqual(removed, ['Bearer 토큰', 'API Key 값', 'Cookie 머리글', 'X-Api-Key 머리글']);
  assert.equal(req.auth.bearer.token, '');
  assert.equal(req.auth.basic.password, '{{pw}}');
  assert.equal(req.auth.apikey.value, '');
  assert.deepEqual(req.headers.map((h) => h.value), ['Bearer {{token}}', '', '', 'application/json']);
});

test('스코프: 비밀 값은 보관함에서, 잠긴 비밀은 아래 단계 값도 쓰지 않음, 가린 스코프는 {{이름}}', () => {
  const env = [{ id: 'e1', key: 'token', value: '', secret: true, enabled: true }, { id: 'e2', key: 'host', value: 'api.local', enabled: true }];
  const globals = [{ id: 'g1', key: 'token', value: 'global-token', enabled: true }];
  const layers = [{ name: 'environment', vars: env }, { name: 'globals', vars: globals }];
  const store1 = new Map([['e1', 'env-secret-token']]);
  const open = buildScope(layers, { secret: (v) => store1.get(v.id) ?? '' });
  assert.equal(resolveString('Bearer {{token}} @ {{host}}', open), 'Bearer env-secret-token @ api.local');
  assert.equal(open.get('token').secret, true);
  assert.equal(open.locked.size, 0);
  const locked = buildScope(layers, { secret: () => undefined });
  assert.equal(resolveString('Bearer {{token}}', locked), 'Bearer {{token}}'); // 글로벌의 다른 토큰이 조용히 나가지 않는다
  assert.ok(locked.locked.has('token'));
  const masked = buildScope(layers, { secret: (v) => `{{${v.key}}}` });
  assert.equal(resolveString('Bearer {{token}}', masked), 'Bearer {{token}}');
  // 더 높은 단계에 평범한 같은 이름이 있으면 잠김이 풀린다
  const over = buildScope([{ name: 'data', vars: [{ id: 'd', key: 'token', value: 'row-token', enabled: true }] }, ...layers], { secret: () => undefined });
  assert.equal(resolveString('{{token}}', over), 'row-token');
  assert.ok(!over.locked.has('token'));
});

test('보관함 맞추기: 행에 남은 비밀 값은 보관함으로, 복제로 겹친 id 는 새 id·값 복사, 쓰지 않는 값은 지움', () => {
  vault.values = new Map([['orphan', 'old'], ['kv_dup', 'dup-secret']]);
  vault.enc = null;
  vault.key = null;
  const state = {
    globals: { variables: [{ id: 'kv_new', key: 'apiKey', value: 'imported-secret', secret: true, enabled: true }] },
    environments: [
      { variables: [{ id: 'kv_dup', key: 'token', value: '', secret: true, enabled: true }] },
      { variables: [{ id: 'kv_dup', key: 'token', value: '', secret: true, enabled: true }, { id: 'kv_plain', key: 'host', value: 'h', enabled: true }] },
    ],
    collections: [],
  };
  const r = vault.reconcile(state);
  assert.deepEqual([...r.changed].sort(), ['environments', 'globals']);
  assert.equal(state.globals.variables[0].value, '');
  assert.equal(vault.get('kv_new'), 'imported-secret');
  const copyId = state.environments[1].variables[0].id;
  assert.notEqual(copyId, 'kv_dup');
  assert.equal(vault.get('kv_dup'), 'dup-secret');
  assert.equal(vault.get(copyId), 'dup-secret');
  assert.ok(!vault.values.has('orphan'));
  assert.equal(state.environments[1].variables[1].value, 'h'); // 비밀이 아닌 행은 그대로
});

test('잠긴 보관함은 맞추기에서 아무것도 옮기지 않고 행에 남은 값 수만 셈', () => {
  vault.values = new Map();
  vault.enc = { iter: 1000, salt: 'AAAA', iv: 'AAAA', data: 'AAAA' };
  vault.key = null;
  assert.ok(vault.locked);
  const state = { globals: { variables: [{ id: 'x', key: 'pw', value: 'from-import', secret: true }] }, environments: [], collections: [] };
  const r = vault.reconcile(state);
  assert.equal(r.waiting, 1);
  assert.equal(r.changed.size, 0);
  assert.equal(state.globals.variables[0].value, 'from-import');
  assert.throws(() => vault.set('x', 'v'));
  vault.enc = null;
});

test('Postman 환경: 비밀 변수는 type: secret 에 값 없이, 가져올 때 type: secret 은 비밀 행으로', () => {
  const out = exportPostmanEnvironment({ name: 'dev', variables: [{ key: 'token', value: '', secret: true, enabled: true }, { key: 'host', value: 'h', enabled: true }] });
  assert.deepEqual(out.values.map((v) => [v.key, v.value, v.type]), [['token', '', 'secret'], ['host', 'h', 'default']]);
  const env = importPostmanEnvironment({ name: 'p', values: [{ key: 'token', value: 'abc', type: 'secret', enabled: true }, { key: 'u', value: 'x', type: 'default' }] });
  assert.equal(env.variables[0].secret, true);
  assert.equal(env.variables[0].value, 'abc'); // 앱이 가져온 뒤 reconcile 로 보관함에 옮긴다
  assert.ok(!env.variables[1].secret);
});
