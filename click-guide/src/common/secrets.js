// 비밀 값(AI API 키) 보관소: 확장 출처의 IndexedDB.
// chrome.storage.local 은 콘텐츠 스크립트도 직접 읽을 수 있다. 콘텐츠 스크립트는 웹페이지와 같은 렌더러 프로세스에서
// 돌기 때문에, 페이지의 렌더러가 뚫리면 그 안의 키도 함께 새 나갈 수 있다. 확장 출처(chrome-extension://…)의 IndexedDB 는
// 확장 페이지와 서비스 워커만 연다(콘텐츠 스크립트가 여는 IndexedDB 는 그 웹페이지 출처의 것이다).
// storage.local 의 접근 수준을 바꾸는 setAccessLevel 은 Chromium 131 에서 storage.session 에만 있다.
// 가이드 DB(db.js)와 따로 둔다. 가이드 DB 의 버전·스키마는 바꾸지 않는다.

const DB_NAME = 'clickguide-secrets';
const DB_VERSION = 1;
const STORE = 'secrets';
const API_KEY = 'aiApiKey';

let _dbPromise = null;

function openSecrets() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); _dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

async function readSecret(name) {
  const db = await openSecrets();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/* 빈 값이면 지운다 */
async function writeSecret(name, value) {
  const db = await openSecrets();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    if (value) t.objectStore(STORE).put(value, name);
    else t.objectStore(STORE).delete(name);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/** AI API 키. 없으면 빈 문자열 */
export async function getApiKey() {
  const v = await readSecret(API_KEY);
  return typeof v === 'string' ? v : '';
}

/** AI API 키를 저장한다. 빈 문자열이면 지운다 */
export async function setApiKey(value) {
  await writeSecret(API_KEY, typeof value === 'string' ? value : '');
}
