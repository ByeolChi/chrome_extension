// Ssoda background service worker
// - 툴바 아이콘 클릭 시 앱을 전체 탭으로 열거나 이미 열린 탭으로 이동
// - 선택한 텍스트(cURL 명령)를 우클릭 메뉴로 바로 가져오기

const APP_URL = chrome.runtime.getURL('app.html');

async function findAppTab() {
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const hit = ctxs.find((c) => c.documentUrl && c.documentUrl.startsWith(APP_URL) && c.tabId >= 0);
      if (hit) return { tabId: hit.tabId, windowId: hit.windowId };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function openApp() {
  const existing = await findAppTab();
  if (existing) {
    try {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    } catch (e) {
      /* tab may have closed; fall through */
    }
  }
  await chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ssoda-import-selection',
      title: 'Ssoda로 열기: "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'ssoda-open-link',
      title: 'Ssoda로 이 링크 요청하기',
      contexts: ['link'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  let payload = null;
  if (info.menuItemId === 'ssoda-import-selection' && info.selectionText) {
    payload = { kind: 'text', text: info.selectionText, ts: Date.now() };
  } else if (info.menuItemId === 'ssoda-open-link' && info.linkUrl) {
    payload = { kind: 'url', text: info.linkUrl, ts: Date.now() };
  }
  if (!payload) return;
  await chrome.storage.local.set({ pendingImport: payload });
  await openApp();
});

// 브라우저 재시작 후 남아있을 수 있는 임시 헤더 규칙 정리
chrome.runtime.onStartup.addListener(async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
    }
  } catch (e) {
    /* ignore */
  }
});
