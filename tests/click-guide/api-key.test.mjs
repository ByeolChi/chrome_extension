// ClickGuide AI API 키 보관: chrome.storage.local(콘텐츠 스크립트도 읽을 수 있음)이 아니라 확장 출처의 IndexedDB 에 둔다.
// 예전 버전이 storage.local 에 둔 키를 옮기는지, 설정 저장·초기화·백업 가져오기가 키를 어떻게 다루는지 확인한다.
// (실제 브라우저에서 확장 새로고침 뒤에도 남는지, 웹페이지 쪽 스크립트가 읽는 저장소에 없는지는 tests/e2e/click-guide/e2e.mjs 가 확인)
// 실행: 저장소 최상위에서 npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* chrome.storage.local 메모리 가짜 */
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (typeof k === 'string' ? { [k]: structuredClone(store[k]) } : structuredClone(store)),
      set: async (o) => { Object.assign(store, structuredClone(o)); },
    },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

/* IndexedDB 최소 가짜: open(onupgradeneeded·onsuccess), transaction().objectStore().get/put/delete, oncomplete */
const idb = new Map(); // DB 이름 → { version, stores: Map(이름 → Map) }
const later = (fn) => setTimeout(fn, 0);
globalThis.indexedDB = {
  open(name, version) {
    const req = {};
    later(() => {
      let rec = idb.get(name);
      const upgrade = !rec || rec.version < version;
      if (!rec) { rec = { version: 0, stores: new Map() }; idb.set(name, rec); }
      const db = {
        objectStoreNames: { contains: (n) => rec.stores.has(n) },
        createObjectStore: (n) => { rec.stores.set(n, new Map()); },
        close() {},
        transaction(storeName) {
          const t = {
            objectStore(n) {
              const m = rec.stores.get(n);
              const op = (fn) => { const r = {}; later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); }); return r; };
              return {
                get: (k) => op(() => structuredClone(m.get(k))),
                put: (v, k) => op(() => { m.set(k, structuredClone(v)); return k; }),
                delete: (k) => op(() => { m.delete(k); }),
              };
            },
          };
          if (!rec.stores.has(storeName)) throw new Error('없는 저장소: ' + storeName);
          later(() => later(() => { if (t.oncomplete) t.oncomplete(); }));
          return t;
        },
      };
      req.result = db;
      if (upgrade) { rec.version = version; if (req.onupgradeneeded) req.onupgradeneeded(); }
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  },
};

const COMMON = new URL('../../click-guide/src/common/', import.meta.url);
const settings = await import(new URL('settings.js', COMMON).href);
const secrets = await import(new URL('secrets.js', COMMON).href);
const backup = await import(new URL('backup.js', COMMON).href);

const storedKey = () => {
  const rec = idb.get('clickguide-secrets');
  return rec && rec.stores.get('secrets') ? rec.stores.get('secrets').get('aiApiKey') : undefined;
};
const storageText = () => JSON.stringify(store);

beforeEach(async () => {
  for (const k of Object.keys(store)) delete store[k];
  await secrets.setApiKey('');
});

test('설정 화면처럼 키를 넣어 저장하면 키는 비밀 보관소에만, storage.local 에는 없음', async () => {
  await settings.setSettings({ lang: 'en', ai: { provider: 'openai', model: 'm', apiKey: 'sk-test-SECRET' } });
  assert.equal(storedKey(), 'sk-test-SECRET');
  assert.ok(!storageText().includes('sk-test-SECRET'), storageText());
  assert.equal('apiKey' in store.cg_settings.ai, false);
  assert.equal(store.cg_settings.ai.provider, 'openai');
  assert.equal(store.cg_settings.lang, 'en');
});

test('getSettings() 는 키를 주지 않고, withApiKey 일 때만 줌', async () => {
  await settings.setSettings({ ai: { provider: 'openai', apiKey: 'sk-only-when-asked' } });
  assert.equal((await settings.getSettings()).ai.apiKey, '');
  assert.equal((await settings.getSettings({ withApiKey: true })).ai.apiKey, 'sk-only-when-asked');
  assert.equal((await settings.getSettings()).ai.provider, 'openai');
});

test('키 없이 다른 설정만 바꾸면 키는 그대로, 빈 키로 저장하면 지움', async () => {
  await settings.setSettings({ ai: { apiKey: 'sk-keep' } });
  await settings.setSettings({ maxImageWidth: 1920, ai: { model: 'other' } });
  assert.equal(storedKey(), 'sk-keep');
  assert.equal((await settings.getSettings()).ai.model, 'other');
  await settings.setSettings({ ai: { apiKey: '' } });
  assert.equal(storedKey(), undefined);
  assert.equal((await settings.getSettings({ withApiKey: true })).ai.apiKey, '');
});

test('예전 버전이 storage.local 에 둔 키를 옮기고 지움 (다른 설정은 그대로, 여러 번 불러도 같음)', async () => {
  store.cg_settings = { lang: 'en', redactSelectors: ['.x'], ai: { provider: 'openai', endpoint: 'http://llm', apiKey: 'sk-legacy-123' } };
  await settings.migrateApiKey();
  assert.equal(storedKey(), 'sk-legacy-123');
  assert.ok(!storageText().includes('sk-legacy-123'), storageText());
  assert.deepEqual(store.cg_settings, { lang: 'en', redactSelectors: ['.x'], ai: { provider: 'openai', endpoint: 'http://llm' } });
  await settings.migrateApiKey();
  assert.equal(storedKey(), 'sk-legacy-123');
  assert.deepEqual(store.cg_settings.ai, { provider: 'openai', endpoint: 'http://llm' });
});

test('getSettings() 만 불러도 예전 키를 옮기고, 돌려주는 값에도 키가 없음', async () => {
  store.cg_settings = { ai: { provider: 'openai', apiKey: 'sk-legacy-get' } };
  const s = await settings.getSettings();
  assert.equal(s.ai.apiKey, '');
  assert.equal(storedKey(), 'sk-legacy-get');
  assert.ok(!storageText().includes('sk-legacy-get'));
});

test('예전 버전이 저장한 빈 키("")는 보관소의 키를 지우지 않음', async () => {
  await secrets.setApiKey('sk-already-moved');
  store.cg_settings = { ai: { provider: 'openai', apiKey: '' } };
  await settings.migrateApiKey();
  assert.equal(storedKey(), 'sk-already-moved');
  assert.equal('apiKey' in store.cg_settings.ai, false);
});

test('기본값으로 되돌리면 키도 지움 (예전과 같음)', async () => {
  await settings.setSettings({ lang: 'en', ai: { apiKey: 'sk-reset' } });
  const r = await settings.resetSettings();
  assert.equal(storedKey(), undefined);
  assert.deepEqual(store.cg_settings, {});
  assert.equal(r.ai.apiKey, '');
  assert.notEqual(r.ai, settings.DEFAULT_SETTINGS.ai, '기본값 객체를 그대로 넘기지 않음');
});

test('cg_settings 를 쓰는 곳은 settings.js 뿐이고, 웹페이지 쪽 녹화 스크립트는 키·비밀 보관소를 다루지 않음', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SRC = fileURLToPath(new URL('../../click-guide/src/', import.meta.url));
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(SRC);
  for (const f of files) {
    if (path.basename(f) === 'settings.js') continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /storage\.local\.set\(\s*\{\s*cg_settings/, f);
  }
  const recorder = fs.readFileSync(path.join(SRC, 'content', 'recorder.js'), 'utf8');
  assert.doesNotMatch(recorder, /apiKey|secrets|clickguide-secrets|getSettings/);
});

test('백업에서 설정을 가져와도 키는 지금 값 그대로 (백업에 키가 들어 있어도 쓰지 않음)', async () => {
  await settings.setSettings({ ai: { provider: 'none', apiKey: 'sk-mine' } });
  const plan = {
    zip: { has: () => false },
    meta: { format: backup.BACKUP_FORMAT, sessions: [], steps: [], shots: [], settings: { lang: 'en', ai: { provider: 'openai', model: 'gpt-x', apiKey: 'sk-from-backup' } } },
    newSessions: [],
  };
  await backup.applyBackup(plan, { settings: true });
  assert.equal(storedKey(), 'sk-mine');
  const s = await settings.getSettings({ withApiKey: true });
  assert.equal(s.lang, 'en');
  assert.equal(s.ai.provider, 'openai');
  assert.equal(s.ai.model, 'gpt-x');
  assert.equal(s.ai.apiKey, 'sk-mine');
  assert.ok(!storageText().includes('sk-from-backup') && !storageText().includes('sk-mine'), storageText());
});
