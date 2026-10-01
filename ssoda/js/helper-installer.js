// cURL 실행 도우미 설치/제거 스크립트 생성 (확장 프로그램 ID 를 넣어 바로 실행 가능한 파일로 다운로드)
import { download } from './util.js';

async function loadText(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(path + ' 을(를) 읽을 수 없습니다.');
  return res.text();
}

export function detectOS() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/win/i.test(p)) return 'windows';
  if (/mac/i.test(p)) return 'mac';
  return 'linux';
}

const toCRLF = (s) => s.replace(/\r?\n/g, '\r\n');

export async function buildInstaller(os, kind = 'install') {
  const id = chrome.runtime.id;
  if (os === 'windows') {
    const tpl = await loadText(`native-host/${kind}-windows.bat.tpl`);
    let out = tpl.replace('__CS_EXT_ID__', () => id);
    if (kind === 'install') {
      const host = await loadText('native-host/ssoda-host.ps1');
      out = out.replace('__CS_HOST_SCRIPT__', () => host.trimEnd());
    }
    return { name: kind === 'install' ? 'ssoda-helper-install.bat' : 'ssoda-helper-uninstall.bat', content: toCRLF(out), type: 'application/x-bat' };
  }
  const tpl = await loadText(`native-host/${kind}-unix.sh.tpl`);
  let out = tpl.replace('__CS_EXT_ID__', () => id);
  if (kind === 'install') {
    const host = await loadText('native-host/ssoda-host.py');
    // 첫 줄(shebang)은 설치 스크립트가 python3 절대경로로 다시 씀
    out = out.replace('__CS_HOST_SCRIPT__', () => host.replace(/^#![^\n]*\n/, '').trimEnd());
  }
  return { name: kind === 'install' ? 'ssoda-helper-install.sh' : 'ssoda-helper-uninstall.sh', content: out, type: 'text/x-shellscript' };
}

export async function downloadInstaller(os, kind = 'install') {
  const f = await buildInstaller(os, kind);
  download(f.name, new Blob([f.content], { type: 'application/octet-stream' }));
  return f.name;
}
