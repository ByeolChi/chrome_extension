// 상태 저장소 (chrome.storage.local, 없으면 localStorage)
import { debounce } from './util.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // light | dark | system
  timeout: 0, // ms, 0 = 무제한
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
};

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
    for (const k of KEYS) {
      if (data[k] !== undefined && data[k] !== null) {
        if (k === 'settings') d.settings = { ...DEFAULT_SETTINGS, ...data.settings };
        else if (k === 'workspace') d.workspace = { ...d.workspace, ...data.workspace };
        else d[k] = data[k];
      }
    }
    this.state = d;
    return this.state;
  }

  // 변경 표시 → 디바운스 후 저장
  save(...keys) {
    keys.forEach((k) => this.pending.add(k));
    this._flush();
  }

  async flush() {
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
    d.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
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
