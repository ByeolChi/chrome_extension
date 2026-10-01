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

  maskPasswords: true,         // password 입력칸 자동 블러
  maskSensitiveValues: true,   // 민감해 보이는 입력값은 ●●●● 로 치환
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

export async function getSettings() {
  const got = await chrome.storage.local.get('cg_settings');
  const s = got && got.cg_settings ? got.cg_settings : {};
  return { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) } };
  await chrome.storage.local.set({ cg_settings: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ cg_settings: {} });
  return { ...DEFAULT_SETTINGS };
}
