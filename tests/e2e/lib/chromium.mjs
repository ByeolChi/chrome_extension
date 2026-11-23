// 브라우저 시험 공용: 확장을 올릴 수 있는 Chromium 찾기, 임시 폴더
// 일반 Google Chrome(137 이상)은 --load-extension 을 받지 않으므로 Playwright 의 Chromium 을 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Playwright 브라우저 폴더 안의 실행 파일 위치 (버전에 따라 폴더 이름이 다르다)
const CANDIDATES = {
  win32: [['chrome-win', 'chrome.exe'], ['chrome-win64', 'chrome.exe']],
  darwin: [
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ],
  linux: [['chrome-linux', 'chrome'], ['chrome-linux64', 'chrome']],
};

function playwrightRoots() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return [process.env.PLAYWRIGHT_BROWSERS_PATH];
  if (process.platform === 'win32') return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')];
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')];
  return [path.join(os.homedir(), '.cache', 'ms-playwright')];
}

/** CHROMIUM_PATH 환경 변수, 없으면 Playwright 가 설치한 Chromium 중 가장 새 버전 */
export function findChromium() {
  const env = process.env.CHROMIUM_PATH;
  if (env) {
    if (!fs.existsSync(env)) throw new Error(`CHROMIUM_PATH 에 지정한 파일이 없습니다: ${env}`);
    return env;
  }
  const rels = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const root of playwrightRoots()) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
    } catch (e) {
      continue;
    }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const rel of rels) {
        const exe = path.join(root, d, ...rel);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  throw new Error('확장을 올릴 Chromium 을 찾지 못했습니다. `npx playwright install chromium` 으로 설치하거나, CHROMIUM_PATH 에 실행 파일 경로를 지정하세요.');
}

/** OS 임시 폴더 안에 새 폴더를 만들어 경로를 돌려준다 (브라우저 프로필·다운로드용) */
export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
