// 상태 저장소 (chrome.storage.local, 없으면 localStorage)
import { debounce } from './util.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // light | dark | system
  timeout: 60000, // ms, 0 = 무제한. 응답이 오지 않는 요청이 끝없이 기다리지 않게 60초
  followRedirects: true,
  removeOrigin: true, // curl처럼 Origin 헤더 제거
  autoSaveCookies: true, // 응답 Set-Cookie를 쿠키 관리자에 저장
  historyEnabled: true,
  historyLimit: 300,
  maxHighlightBytes: 1000000,
  wrapResponse: false,
  layout: 'horizontal', // horizontal: 요청 위/응답 아래, vertical: 좌/우
  fontSize: 13,
  defaultEngine: 'browser', // browser | curl (요청별로 변경 가능)
  curlPath: '', // curl 실행 파일 경로 (비우면 자동 탐색)
  curlShell: 'bash', // bash | cmd (명령어 표시 형식)
  curlMultiline: true, // 줄바꿈으로 정렬
  settingsRev: 2, // 저장된 설정의 형식 판 (migrateSettings 참고)
};

/**
 * 저장된(또는 백업의) 설정을 지금 형식으로 맞춘다.
 * 반환: { settings, notes: 사용자에게 알릴 바뀐 점(['timeout'] 등), changed: 다시 저장해야 하면 true }
 */
export function migrateSettings(saved) {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const settings = { ...DEFAULT_SETTINGS, ...src };
  const rev = Number(src.settingsRev) || 1;
  const notes = [];
  // 2판: 기본 타임아웃 0(무제한) → 60초.
  // 예전 판의 0 은 대부분 처음 값 그대로이므로 한 번 60초로 바꾸고 알린다. 직접 넣은 값(0 보다 큰 값)은 그대로 둔다.
  if (rev < 2 && !(Number(src.timeout) > 0)) {
    settings.timeout = DEFAULT_SETTINGS.timeout;
    notes.push('timeout');
  }
  settings.settingsRev = DEFAULT_SETTINGS.settingsRev;
  return { settings, notes, changed: rev < DEFAULT_SETTINGS.settingsRev };
}

const KEYS = ['collections', 'environments', 'globals', 'activeEnvId', 'history', 'cookieJar', 'settings', 'workspace'];

const DEFAULTS = () => ({
  collections: [],
  environments: [],
  globals: { variables: [] },
  activeEnvId: null,
  history: [],
  cookieJar: [],
  settings: { ...DEFAULT_SETTINGS },
  workspace: {
    tabs: [],
    activeTabId: null,
    sidebar: 'collections',
    sidebarWidth: 300,
    split: 0.48,
    expanded: {},
    codeLang: 'curl',
    rightPanel: null,
  },
});

const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

class Store {
  constructor() {
    this.state = DEFAULTS();
    this.listeners = new Map();
    this.pending = new Set();
    this._flush = debounce(() => this.flush(), 300);
  }

  async load() {
    let data = {};
    if (hasChromeStorage) {
      data = await chrome.storage.local.get(KEYS);
    } else {
      for (const k of KEYS) {
        try {
          const v = localStorage.getItem('cs:' + k);
          if (v != null) data[k] = JSON.parse(v);
        } catch (e) {
          /* ignore */
        }
      }
    }
    const d = DEFAULTS();
    this.notes = [];
    let migrated = false;
    for (const k of KEYS) {
      if (data[k] !== undefined && data[k] !== null) {
        if (k === 'settings') {
          const m = migrateSettings(data.settings);
          d.settings = m.settings;
          this.notes = m.notes;
          migrated = m.changed;
        } else if (k === 'workspace') d.workspace = { ...d.workspace, ...data.workspace };
        else d[k] = data[k];
      }
    }
    this.state = d;
    if (migrated) {
      this.pending.add('settings');
      await this.flush();
    }
    return this.state;
  }

  // 변경 표시 → 디바운스 후 저장
  save(...keys) {
    keys.forEach((k) => this.pending.add(k));
    this._flush();
  }

  async flush() {
    // 다른 탭에서 Ssoda 를 새로 열어 이 탭이 저장을 멈춘 상태 (main.js 의 watchOtherInstances 참고)
    if (this.suspended) return;
    const keys = [...this.pending];
    this.pending.clear();
    if (!keys.length) return;
    const obj = {};
    keys.forEach((k) => (obj[k] = this.state[k]));
    try {
      if (hasChromeStorage) await chrome.storage.local.set(obj);
      else for (const k of keys) localStorage.setItem('cs:' + k, JSON.stringify(obj[k]));
    } catch (e) {
      console.error('저장 실패', e);
      this.emit('error', '저장 실패: ' + e.message);
    }
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }

  emit(evt, payload) {
    (this.listeners.get(evt) || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }

  // 변경 알림 + 저장
  changed(key, payload) {
    this.save(key);
    this.emit(key, payload);
  }

  async replaceAll(data) {
    const d = DEFAULTS();
    for (const k of KEYS) if (data[k] !== undefined) d[k] = data[k];
    // 예전 판에서 만든 백업도 지금 판으로 올린 것처럼 맞춘다 (기본 타임아웃 등)
    d.settings = migrateSettings(data.settings).settings;
    // curl 실행 파일 경로는 백업에서 가져오지 않는다 (조작된 백업으로 다른 프로그램을 실행시키지 못하게)
    d.settings.curlPath = this.state.settings.curlPath || '';
    // 예전 버전 백업의 SSH 비밀번호는 버린다
    for (const e of d.environments || []) {
      if (e && e.ssh) {
        delete e.ssh.password;
        delete e.ssh.savePassword;
      }
    }
    this.state = d;
    KEYS.forEach((k) => this.pending.add(k));
    await this.flush();
  }

  async clearAll() {
    if (hasChromeStorage) await chrome.storage.local.remove(KEYS);
    else KEYS.forEach((k) => localStorage.removeItem('cs:' + k));
    this.state = DEFAULTS();
  }
}

export const store = new Store();
