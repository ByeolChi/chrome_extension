// IndexedDB 래퍼. 서비스 워커와 확장 페이지(편집기)가 같은 오리진에서 공유한다.
// sessions: 녹화 세션 메타  /  steps: 단계  /  shots: 스크린샷 Blob

const DB_NAME = 'clickguide';
const DB_VERSION = 1;

let _dbPromise = null;

export function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('steps')) {
        const s = db.createObjectStore('steps', { keyPath: 'id' });
        s.createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('shots')) {
        db.createObjectStore('shots', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); _dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
  return { t, done };
}

function reqToPromise(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/* ---------------- sessions ---------------- */

export async function createSession(data) {
  const db = await openDb();
  const session = {
    id: uid('ses'),
    name: data.name || '새 가이드',
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startUrl: data.startUrl || '',
    stepCount: 0,
    lang: data.lang || 'ko',
    ...data
  };
  const { t, done } = tx(db, ['sessions'], 'readwrite');
  t.objectStore('sessions').put(session);
  await done;
  return session;
}

export async function getSession(id) {
  const db = await openDb();
  const { t } = tx(db, ['sessions'], 'readonly');
  return reqToPromise(t.objectStore('sessions').get(id));
}

export async function listSessions() {
  const db = await openDb();
  const { t } = tx(db, ['sessions'], 'readonly');
  const all = await reqToPromise(t.objectStore('sessions').getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateSession(id, patch) {
  const db = await openDb();
  const { t, done } = tx(db, ['sessions'], 'readwrite');
  const store = t.objectStore('sessions');
  const cur = await reqToPromise(store.get(id));
  if (!cur) { await done.catch(() => {}); return null; }
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  store.put(next);
  await done;
  return next;
}

export async function deleteSession(id) {
  const steps = await getSteps(id);
  const db = await openDb();
  const { t, done } = tx(db, ['sessions', 'steps', 'shots'], 'readwrite');
  t.objectStore('sessions').delete(id);
  for (const s of steps) {
    t.objectStore('steps').delete(s.id);
    if (s.shotId) t.objectStore('shots').delete(s.shotId);
  }
  await done;
}

/* ---------------- steps ---------------- */

export async function putStep(step) {
  const db = await openDb();
  const { t, done } = tx(db, ['steps'], 'readwrite');
  t.objectStore('steps').put(step);
  await done;
  return step;
}

export async function putSteps(steps) {
  const db = await openDb();
  const { t, done } = tx(db, ['steps'], 'readwrite');
  const store = t.objectStore('steps');
  for (const s of steps) store.put(s);
  await done;
}

export async function getSteps(sessionId) {
  const db = await openDb();
  const { t } = tx(db, ['steps'], 'readonly');
  const idx = t.objectStore('steps').index('sessionId');
  const all = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
  return all.sort((a, b) => a.index - b.index);
}

export async function deleteStep(step) {
  const db = await openDb();
  const { t, done } = tx(db, ['steps', 'shots'], 'readwrite');
  t.objectStore('steps').delete(step.id);
  if (step.shotId) t.objectStore('shots').delete(step.shotId);
  await done;
}

/* ---------------- shots ---------------- */

export async function putShot(id, blob) {
  const db = await openDb();
  const { t, done } = tx(db, ['shots'], 'readwrite');
  t.objectStore('shots').put({ id, blob });
  await done;
  return id;
}

export async function getShot(id) {
  if (!id) return null;
  const db = await openDb();
  const { t } = tx(db, ['shots'], 'readonly');
  const rec = await reqToPromise(t.objectStore('shots').get(id));
  return rec ? rec.blob : null;
}

export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    try { return await navigator.storage.estimate(); } catch (_) { /* noop */ }
  }
  return null;
}
