// 확장 전역 설정. chrome.storage.local 에 'cg_settings' 키로 보관한다.
// AI API 키만은 여기 두지 않고 비밀 보관소(secrets.js, 확장 출처의 IndexedDB)에 둔다.
// storage.local 은 콘텐츠 스크립트도 직접 읽을 수 있기 때문이다.
import { getApiKey, setApiKey } from './secrets.js';

export const DEFAULT_SETTINGS = {
  lang: 'ko',                  // 'ko' | 'en'  — 생성되는 설명 문장의 언어
  maxImageWidth: 1440,         // 저장 시 스크린샷 가로 최대 픽셀
  jpegQuality: 0.82,           // 0.5 ~ 0.95
  captureDelayMs: 0,           // 클릭 직후 캡처까지 대기(ms). 0 = 즉시

  recordClicks: true,
  recordInputs: true,          // 입력값 변경(change) 기록
  recordNavigation: true,      // 페이지 이동 기록
  followNewTabs: true,         // 녹화 중 새로 열린 탭도 따라가기

  maskPasswords: true,         // password 입력칸 자동 가리기
  maskSensitiveValues: true,   // 민감해 보이는 입력값(칸 이름, 개인정보 모양의 값)은 ●●●● 로 치환
  maskScreenPII: true,         // 화면 글자·입력값 속 개인정보(주민·카드·계좌·휴대폰 번호, 이메일 등)를 스크린샷에서 가리기
  redactStyle: 'box',          // 'box' 검정 칠하기 | 'blur' 흐리게. 흐리게는 숫자를 복원하는 공격에 약해 기본은 검정
  redactSelectors: [],         // 추가로 가릴 CSS 선택자 목록
  maskValueChars: 0,           // 0 = 값 전체 기록, n>0 이면 앞 n자만 남기고 마스킹

  highlight: true,             // 내보낼 때 클릭 지점 테두리 표시
  highlightColor: '#ff3b30',
  highlightWidth: 3,
  dimOutside: false,           // 하이라이트 밖 영역을 살짝 어둡게

  // AI 문장 다듬기 (선택)
  ai: {
    provider: 'none',          // 'none' | 'openai' | 'anthropic'
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: '',                // 화면에서 쓰는 자리. 저장은 비밀 보관소에 하고 cg_settings 에는 넣지 않는다
    includeScreenshots: false, // true 면 이미지도 함께 전송 (비용·유출 주의)
    extraPrompt: ''            // 톤/용어 지시 등 추가 프롬프트
  }
};

/* 숫자 설정이 비었거나 범위를 벗어나면 기본값·경계값으로 바로잡는다.
 * 예전에는 설정에서 '저장 가로 최대' 칸을 비우면 0이 저장되어 스크린샷이 1×1로 줄었다.
 * emptyIfZero: 0을 '비어 있음'으로 보고 기본값을 쓴다. */
const NUMERIC = {
  maxImageWidth: { min: 640, max: 3840, emptyIfZero: true },
  jpegQuality: { min: 0.5, max: 0.95, emptyIfZero: true },
  captureDelayMs: { min: 0, max: 2000 },
  maskValueChars: { min: 0, max: 40 },
  highlightWidth: { min: 1, max: 10, emptyIfZero: true }
};

const REDACT_STYLES = ['box', 'blur'];

export function normalizeSettings(s) {
  const out = { ...s };
  if (!REDACT_STYLES.includes(out.redactStyle)) out.redactStyle = DEFAULT_SETTINGS.redactStyle;
  for (const [key, r] of Object.entries(NUMERIC)) {
    const v = s[key];
    const n = (v === '' || v === null || v === undefined) ? NaN : Number(v);
    out[key] = (!Number.isFinite(n) || (r.emptyIfZero && n <= 0))
      ? DEFAULT_SETTINGS[key]
      : Math.min(r.max, Math.max(r.min, n));
  }
  return out;
}

const hasApiKey = (s) => !!(s && s.ai && typeof s.ai === 'object' && Object.prototype.hasOwnProperty.call(s.ai, 'apiKey'));

/* 저장할 사본: ai.apiKey 를 뺀다 */
function withoutApiKey(s) {
  if (!hasApiKey(s)) return s;
  const { apiKey, ...ai } = s.ai;
  return { ...s, ai };
}

/* 0.3.0 까지는 API 키를 cg_settings.ai.apiKey 에 두었다. 비밀 보관소로 옮기고 storage.local 에서 지운다.
 * 키를 먼저 옮긴 뒤 지우므로, 중간에 실패해도 키를 잃지 않는다(다음에 다시 옮긴다).
 * 빈 값은 옮기지 않는다: 예전 버전이 저장한 기본값('')이 보관소의 키를 지우지 않게 한다. */
async function moveLegacyApiKey(stored) {
  const key = stored.ai.apiKey;
  if (typeof key === 'string' && key) await setApiKey(key);
  // 그 사이 다른 화면에서 바꾼 설정을 덮어쓰지 않도록 다시 읽어서 키만 뺀다
  const now = await chrome.storage.local.get('cg_settings');
  if (now && hasApiKey(now.cg_settings)) await chrome.storage.local.set({ cg_settings: withoutApiKey(now.cg_settings) });
}

/** storage.local 에 남은 예전 API 키를 비밀 보관소로 옮긴다. 옮길 것이 없으면 아무것도 하지 않는다 (여러 번 불러도 됨) */
export async function migrateApiKey() {
  const got = await chrome.storage.local.get('cg_settings');
  if (got && hasApiKey(got.cg_settings)) await moveLegacyApiKey(got.cg_settings);
}

/**
 * 설정을 읽는다. ai.apiKey 는 기본으로 빈 문자열이고, withApiKey 가 참일 때만 비밀 보관소에서 채운다.
 * 키가 필요한 곳(설정 화면, 편집기의 AI 다듬기)만 달라고 해서, 설정을 다른 곳으로 넘길 때 키가 딸려 가지 않게 한다.
 */
export async function getSettings({ withApiKey = false } = {}) {
  const got = await chrome.storage.local.get('cg_settings');
  let s = got && got.cg_settings ? got.cg_settings : {};
  if (hasApiKey(s)) {
    try { await moveLegacyApiKey(s); } catch (e) { console.warn('[ClickGuide] API 키를 비밀 보관소로 옮기지 못했습니다:', e); }
    s = withoutApiKey(s);
  }
  const out = normalizeSettings({ ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } });
  out.ai.apiKey = withApiKey ? await getApiKey() : '';
  return out;
}

/**
 * 설정을 바꾼다. patch.ai 에 apiKey 가 있으면 비밀 보관소의 키를 그 값으로 바꾸고(빈 값이면 지움), 없으면 키는 그대로 둔다.
 * 돌려주는 값의 ai.apiKey 는 patch 에 키가 있을 때만 그 값이고, 아니면 빈 문자열이다 (getSettings() 와 같음).
 */
export async function setSettings(patch) {
  const p = patch || {};
  const keyGiven = hasApiKey(p);
  const cur = await getSettings();
  const next = normalizeSettings({ ...cur, ...p, ai: { ...cur.ai, ...(p.ai || {}) } });
  const key = keyGiven ? String(p.ai.apiKey ?? '') : '';
  if (keyGiven) await setApiKey(key);
  await chrome.storage.local.set({ cg_settings: withoutApiKey(next) });
  next.ai = { ...next.ai, apiKey: key };
  return next;
}

/** 모든 설정을 기본값으로 (예전처럼 API 키도 지운다) */
export async function resetSettings() {
  await chrome.storage.local.set({ cg_settings: {} });
  await setApiKey('');
  return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai } };
}
