// chrome.storage.local 래퍼 (API 토큰이 있어 sync 대신 local 사용)
import { DEFAULT_SETTINGS } from './defaults.js';

const area = () => chrome.storage.local;

// 이전 버전의 기본값 — 저장된 값이 예전 기본값 그대로면 새 기본값으로 바꿔준다
const TPL_V2 = DEFAULT_SETTINGS.template.replace('{{내작업목록_키}}', '{{작업목록_키}}');
const TPL_V1 = TPL_V2.replace('{{지난주실적}}', '{{이전스프린트실적}}');
const OLD_DEFAULTS = {
  template: [TPL_V1, TPL_V2],
  mainJql: ['project = {{프로젝트}} AND sprint = {{스프린트ID}}'],
  totalJql: ['project = {{프로젝트}} AND sprint is not EMPTY'],
  progressSource: ['status'],
  progressField: [''],
  boardId: [''],
};

export const SETTINGS_VERSION = 3;

export function migrateSettings(saved) {
  const out = { ...(saved || {}) };
  // 이 버전 이후에 저장한 설정은 사용자가 고른 값이므로 건드리지 않는다
  if (!(out.settingsVersion >= SETTINGS_VERSION)) {
    for (const [k, olds] of Object.entries(OLD_DEFAULTS)) {
      if (k in out && olds.includes(out[k])) delete out[k];
    }
    delete out.sortByStatus;
  }
  return { ...DEFAULT_SETTINGS, ...out, settingsVersion: SETTINGS_VERSION };
}

export async function loadSettings() {
  const { settings } = await area().get('settings');
  return migrateSettings(settings);
}

export async function saveSettings(settings) {
  await area().set({ settings: { ...settings, settingsVersion: SETTINGS_VERSION } });
}

export async function loadState() {
  const { history, lastResult } = await area().get(['history', 'lastResult']);
  return { history: history || {}, lastResult: lastResult || null };
}

export async function saveHistory(history) {
  await area().set({ history });
}

export async function saveLastResult(lastResult) {
  await area().set({ lastResult });
}

/** 설정한 Jira 주소에 대한 접근 권한 확인/요청 (기본 raoncorp 외 주소로 바꿨을 때) */
export async function ensureHostPermission(baseUrl, request = false) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + '/*';
  } catch {
    return false;
  }
  // request는 사용자 클릭 직후 바로 호출해야 하므로 contains를 먼저 await 하지 않는다.
  // (이미 허용된 주소면 창 없이 true 반환)
  if (request) return chrome.permissions.request({ origins: [origin] });
  return chrome.permissions.contains({ origins: [origin] });
}
