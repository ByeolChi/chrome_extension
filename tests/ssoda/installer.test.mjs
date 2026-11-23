// ssoda 도우미 설치 파일 생성(helper-installer.js) 줄바꿈 회귀 테스트
// 저장소를 Windows(core.autocrlf=true)에서 새로 받으면 템플릿·도우미 파일이 CRLF 로 풀린다. 그 사본으로 만든
// 배포본에서도 macOS·Linux 설치 파일은 LF(bash 가 CR 이 섞인 스크립트를 실행하지 못함), Windows 설치 파일은 CRLF 여야 한다.
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SSODA = fileURLToPath(new URL('../../ssoda/', import.meta.url));
const EXT_ID = 'cnnlkogkbglbbbcefpaknbmebieabijo';
let eol = 'crlf'; // 확장 폴더의 파일을 어떤 줄바꿈으로 읽힐지

globalThis.chrome = { runtime: { id: EXT_ID, getURL: (p) => pathToFileURL(path.join(SSODA, p)).href } };
globalThis.fetch = async (u) => {
  let text = fs.readFileSync(new URL(u), 'utf8').replace(/\r\n/g, '\n');
  if (eol === 'crlf') text = text.replace(/\n/g, '\r\n');
  return { ok: true, text: async () => text };
};
const { buildInstaller } = await import(pathToFileURL(path.join(SSODA, 'js', 'helper-installer.js')).href);

test('macOS·Linux 설치 파일: 템플릿·도우미 파일이 CRLF 여도 LF 로 만들어짐', async () => {
  eol = 'crlf';
  for (const os of ['mac', 'linux']) {
    const f = await buildInstaller(os, 'install');
    assert.equal(f.name, 'ssoda-helper-install.sh');
    assert.ok(!f.content.includes('\r'), `${os}: CR 문자가 남음`);
    assert.match(f.content, /^#!\/usr\/bin\/env bash\n/);
    assert.ok(f.content.includes(`EXT_ID='${EXT_ID}'`), '확장 ID 가 들어가지 않음');
    assert.ok(!f.content.includes('__CS_HOST_SCRIPT__') && f.content.includes('HOST_VERSION = '), '도우미 코드가 들어가지 않음');
    assert.match(f.content, /\nCS_HOST_EOF\n/, 'heredoc 끝 표시가 한 줄로 남아야 함');
  }
});

test('macOS·Linux 제거 파일: 템플릿이 CRLF 여도 LF 로 만들어짐', async () => {
  eol = 'crlf';
  const f = await buildInstaller('mac', 'uninstall');
  assert.equal(f.name, 'ssoda-helper-uninstall.sh');
  assert.ok(!f.content.includes('\r'), 'CR 문자가 남음');
  assert.match(f.content, /^#!\/usr\/bin\/env bash\n/);
});

test('macOS·Linux 설치 파일: 원본이 LF 일 때도 그대로 LF (회귀)', async () => {
  eol = 'lf';
  const f = await buildInstaller('linux', 'install');
  assert.ok(!f.content.includes('\r'));
});

test('Windows 설치·제거 파일: 원본이 LF 여도 CRLF 로 만들어짐 (회귀)', async () => {
  eol = 'lf';
  for (const kind of ['install', 'uninstall']) {
    const f = await buildInstaller('windows', kind);
    assert.ok(!/[^\r]\n/.test(f.content), `${kind}: CR 없이 LF 만 있는 줄이 있음`);
  }
  const inst = await buildInstaller('windows', 'install');
  assert.ok(inst.content.includes(`$ExtId = '${EXT_ID}'`), '확장 ID 가 들어가지 않음');
  assert.ok(inst.content.includes('$HostVersion = ') && !inst.content.includes('__CS_HOST_SCRIPT__'), '도우미 스크립트가 들어가지 않음');
});
