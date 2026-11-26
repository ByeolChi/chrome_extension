// 비밀 변수 보관함
//
// 환경·글로벌·컬렉션 변수 가운데 비밀로 표시한 행(secret: true)은 값을 행에 두지 않고 이 보관함에 둔다.
// 행의 value 는 늘 빈 문자열이다. 그래서 전체 백업·Postman 내보내기·히스토리처럼 상태를 그대로 쓰는 곳에는
// 비밀 값이 아예 들어가지 않는다(앞으로 생길 내보내기도 마찬가지).
//
// 저장: chrome.storage.local 의 'vault' 키 (없으면 localStorage 'cs:vault')
//   { v: 1, plain: { [행 id]: 값 } }                               비밀번호 없음 — 화면·백업·내보내기·히스토리에서만 빠진다
//   { v: 1, enc: { alg, kdf, iter, salt, iv, data } }             비밀번호로 암호화 (AES-GCM 256, 키는 PBKDF2-SHA256)
// 잠금을 푼 키는 chrome.storage.session(메모리에만, 브라우저를 닫으면 사라짐)에 두어 같은 브라우저 세션 동안은 다시 묻지 않는다.
// 앱 탭이 여러 개면 마지막에 연 탭만 저장한다(store.suspended 를 따른다).
import { store } from './store.js';
import { debounce, uid } from './util.js';

const KEY = 'vault';
const SESSION_KEY = 'ssodaVaultKey';
export const PBKDF2_ITER = 600000; // OWASP 권장(2023, PBKDF2-HMAC-SHA256)
export const MASK = '••••••••';
const MIN_REDACT = 4; // 이보다 짧은 비밀 값은 화면 글에서 찾아 가리지 않는다 (흔한 글자를 망가뜨리지 않게)

const te = new TextEncoder();
const td = new TextDecoder();

export function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s) {
  return Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
}

/* ---------------- 암호화 (순수 함수 — 시험에서 바로 부른다) ---------------- */

/** 비밀번호와 소금으로 AES-GCM 키를 만든다 (세션에 두려고 내보낼 수 있게 만든다) */
export async function deriveKey(password, salt, iter = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/** 값 묶음(객체)을 암호화한다. 매번 새 iv */
export async function sealValues(values, key, salt, iter) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(values || {}))));
  return { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

/** 암호문을 푼다. 키가 틀리면 예외 (AES-GCM 이 위조·잘못된 키를 알아챈다) */
export async function openValues(enc, key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, key, fromB64(enc.data));
  const obj = JSON.parse(td.decode(plain));
  return obj && typeof obj === 'object' ? obj : {};
}

/* ---------------- 가리기 도우미 (순수 함수) ---------------- */

/** 이름만 보고 비밀일 것 같은 변수 (Tests 탭이 새로 만드는 변수의 기본값) */
export function looksSecretName(name) {
  return /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|session|cookie|jwt|bearer|otp)/i.test(String(name || ''));
}

/** 글 속의 비밀 값을 가린다. values: 비밀 값들. 짧은 값(4글자 미만)은 건드리지 않는다.
    Basic 인증 머리글처럼 base64 로 싼 값 안에 비밀 값이 있으면 그 덩어리를 통째로 가린다 */
export function redactSecrets(text, values) {
  let s = String(text ?? '');
  const list = [...new Set([...(values || [])].map(String).filter((v) => v.length >= MIN_REDACT))].sort((a, b) => b.length - a.length);
  if (!list.length || !s) return s;
  s = s.replace(/(Basic\s+)([A-Za-z0-9+/=]{8,})/gi, (all, head, b64) => {
    let plain = '';
    try { plain = atob(b64); } catch (_) { return all; }
    return list.some((v) => plain.includes(v)) ? head + MASK : all;
  });
  for (const v of list) s = s.split(v).join(MASK);
  return s;
}

/* 히스토리에 남기지 않을 머리글 (값을 직접 쓴 경우) */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token', 'x-access-token']);

/** 값에 {{변수}} 말고 직접 쓴 비밀이 있는가. "Bearer {{token}}" 은 아니고 "Bearer eyJ…" 는 그렇다 */
export function hasLiteralSecret(value) {
  const rest = String(value ?? '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/^\s*(bearer|basic|token|digest|apikey|api-key)\b/i, '')
    .trim();
  return rest.length >= MIN_REDACT;
}

/** 히스토리에 넣을 요청에서 직접 쓴 비밀(인증 칸, 인증 머리글·쿠키 머리글)을 지운다. 지운 곳 이름 목록을 돌려준다 */
export function stripLiteralSecrets(req) {
  const out = [];
  const a = req && req.auth;
  if (a) {
    if (a.bearer && hasLiteralSecret(a.bearer.token)) { a.bearer.token = ''; out.push('Bearer 토큰'); }
    if (a.basic && hasLiteralSecret(a.basic.password)) { a.basic.password = ''; out.push('Basic 비밀번호'); }
    if (a.apikey && hasLiteralSecret(a.apikey.value)) { a.apikey.value = ''; out.push('API Key 값'); }
  }
  for (const row of (req && req.headers) || []) {
    if (SECRET_HEADERS.has(String(row.key || '').trim().toLowerCase()) && hasLiteralSecret(row.value)) {
      row.value = '';
      out.push(`${row.key} 머리글`);
    }
  }
  return out;
}

/* ---------------- 저장소 ---------------- */

const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

async function readStored() {
  if (hasChrome) return (await chrome.storage.local.get(KEY))[KEY] || null;
  try {
    const v = localStorage.getItem('cs:' + KEY);
    return v ? JSON.parse(v) : null;
  } catch (_) {
    return null;
  }
}

async function writeStored(data) {
  if (hasChrome) await chrome.storage.local.set({ [KEY]: data });
  else localStorage.setItem('cs:' + KEY, JSON.stringify(data));
}

async function rememberSessionKey(key) {
  try {
    if (!(chrome && chrome.storage && chrome.storage.session)) return;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    await chrome.storage.session.set({ [SESSION_KEY]: toB64(raw) });
  } catch (_) { /* 세션 저장이 없으면 탭을 새로 열 때마다 묻는다 */ }
}

async function sessionKey() {
  try {
    if (!(chrome && chrome.storage && chrome.storage.session)) return null;
    const v = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    return v ? await crypto.subtle.importKey('raw', fromB64(v), 'AES-GCM', true, ['encrypt', 'decrypt']) : null;
  } catch (_) {
    return null;
  }
}

async function forgetSessionKey() {
  try {
    if (chrome && chrome.storage && chrome.storage.session) await chrome.storage.session.remove(SESSION_KEY);
  } catch (_) { /* 무시 */ }
}

/* ---------------- 보관함 ---------------- */

class Vault {
  constructor() {
    this.values = new Map(); // 행 id → 값 (잠겨 있으면 비어 있다)
    this.enc = null; // 암호화해 저장하면 { iter, salt, … } (잠겨 있을 때는 저장된 암호문 그대로)
    this.key = null; // 잠금을 푼 키
    this.listeners = new Set();
    this._save = debounce(() => this.flush(), 300);
  }

  /** 비밀번호로 암호화해 두었는가 */
  get encrypted() {
    return !!this.enc;
  }

  /** 암호화해 두었고 아직 열지 않았다 (값을 모른다) */
  get locked() {
    return !!this.enc && !this.key;
  }

  async load() {
    const raw = await readStored();
    this.values = new Map();
    this.enc = null;
    this.key = null;
    if (raw && raw.enc) {
      this.enc = raw.enc;
      const k = await sessionKey(); // 같은 브라우저 세션에서 이미 열었으면 다시 묻지 않는다
      if (k) {
        try {
          this.values = new Map(Object.entries(await openValues(this.enc, k)));
          this.key = k;
        } catch (_) {
          await forgetSessionKey(); // 비밀번호를 바꾼 뒤의 낡은 키
        }
      }
    } else if (raw && raw.plain && typeof raw.plain === 'object') {
      this.values = new Map(Object.entries(raw.plain).map(([k, v]) => [k, String(v ?? '')]));
    }
    this.emit();
  }

  get(id) {
    return this.values.get(id);
  }

  set(id, value) {
    if (this.locked) throw new Error('비밀 변수 보관함이 잠겨 있습니다.');
    this.values.set(id, String(value ?? ''));
    this._save();
  }

  delete(id) {
    if (this.locked) return;
    if (this.values.delete(id)) this._save();
  }

  /** 지금 아는 비밀 값들 (화면 글에서 가릴 때) */
  secretValues() {
    return [...this.values.values()];
  }

  async flush() {
    // 다른 Ssoda 탭이 새로 열려 이 탭이 저장을 멈췄거나, 잠겨 있으면(값을 모른다) 저장된 것을 그대로 둔다
    if (store.suspended || this.locked) return;
    const obj = Object.fromEntries(this.values);
    let data;
    if (this.enc) {
      const enc = await sealValues(obj, this.key, fromB64(this.enc.salt), this.enc.iter);
      this.enc = enc;
      data = { v: 1, enc };
    } else {
      data = { v: 1, plain: obj };
    }
    try {
      await writeStored(data);
    } catch (e) {
      console.error('비밀 변수 저장 실패', e);
    }
  }

  async flushNow() {
    await this.flush();
  }

  /** 비밀번호를 정하거나 바꾼다 (열려 있어야 한다). 새 소금으로 다시 암호화한다 */
  async setPassword(password) {
    if (this.locked) throw new Error('먼저 잠금을 푸세요.');
    if (!password) throw new Error('비밀번호를 입력하세요.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(password, salt, PBKDF2_ITER);
    this.enc = { iter: PBKDF2_ITER, salt: toB64(salt) };
    await this.flush();
    await rememberSessionKey(this.key);
    this.emit();
  }

  /** 비밀번호로 연다. 틀리면 false */
  async unlock(password) {
    if (!this.locked) return true;
    let key;
    let values;
    try {
      key = await deriveKey(password, fromB64(this.enc.salt), this.enc.iter);
      values = await openValues(this.enc, key);
    } catch (_) {
      return false;
    }
    this.key = key;
    this.values = new Map(Object.entries(values));
    await rememberSessionKey(key);
    this.emit();
    return true;
  }

  /** 잠근다: 키와 값을 메모리에서 지운다 (저장된 암호문은 그대로) */
  async lock() {
    if (!this.enc) return;
    await this.flush();
    this.key = null;
    this.values = new Map();
    await forgetSessionKey();
    this.emit();
  }

  /** 비밀번호를 없앤다 (열려 있어야 한다). 이제 평문으로 저장한다 */
  async removePassword() {
    if (this.locked) throw new Error('먼저 잠금을 푸세요.');
    this.enc = null;
    this.key = null;
    await this.flush();
    await forgetSessionKey();
    this.emit();
  }

  /** 비밀번호를 잊었을 때: 보관함을 비운다 (비밀 변수의 값이 모두 사라진다) */
  async reset() {
    this.enc = null;
    this.key = null;
    this.values = new Map();
    await this.flush();
    await forgetSessionKey();
    this.emit();
  }

  /**
   * 변수 행과 보관함을 맞춘다.
   * - 비밀 행의 값이 행에 남아 있으면(가져오기·복원·예전 판) 보관함으로 옮긴다
   * - 복제로 id 가 겹친 비밀 행은 새 id 를 주고 값을 복사한다
   * - 어느 행도 쓰지 않는 값은 지운다
   * 잠겨 있으면 값을 모르므로 옮기기·복사·지우기를 하지 않고, 행에 남은 비밀 값 수만 센다(waiting).
   * 반환: { changed: 다시 저장할 store 키(Set), waiting }
   */
  reconcile(state) {
    const lists = [
      ['globals', (state.globals && state.globals.variables) || []],
      ...(state.environments || []).map((e) => ['environments', e.variables || []]),
      ...(state.collections || []).map((c) => ['collections', c.variables || []]),
    ];
    const changed = new Set();
    let waiting = 0;
    if (this.locked) {
      for (const [, vars] of lists) for (const r of vars) if (r && r.secret && r.value) waiting++;
      return { changed, waiting };
    }
    const seen = new Set();
    for (const [key, vars] of lists) {
      for (const row of vars) {
        if (!row || !row.secret) continue;
        if (!row.id || seen.has(row.id)) {
          const nid = uid('kv');
          if (row.id && this.values.has(row.id)) this.values.set(nid, this.values.get(row.id));
          row.id = nid;
          changed.add(key);
        }
        seen.add(row.id);
        if (row.value) {
          this.values.set(row.id, String(row.value));
          row.value = '';
          changed.add(key);
        }
      }
    }
    let dropped = false;
    for (const id of [...this.values.keys()]) {
      if (!seen.has(id)) {
        this.values.delete(id);
        dropped = true;
      }
    }
    if (changed.size || dropped) this._save();
    return { changed, waiting };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export const vault = new Vault();
