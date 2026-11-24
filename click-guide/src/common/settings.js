// 확장 전역 설정. chrome.storage.local 에 'cg_settings' 키로 보관한다.

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
    apiKey: '',
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

export async function getSettings() {
  const got = await chrome.storage.local.get('cg_settings');
  const s = got && got.cg_settings ? got.cg_settings : {};
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } });
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = normalizeSettings({ ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) } });
  await chrome.storage.local.set({ cg_settings: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ cg_settings: {} });
  return { ...DEFAULT_SETTINGS };
}
