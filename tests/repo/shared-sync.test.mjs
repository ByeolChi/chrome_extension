// 공용 코드 사본 검사: 확장 폴더의 사본이 원본(shared/)과 같은지, 확장이 실제로 그 사본을 싣는지
// 원본만 고치고 node scripts/sync-shared.mjs 를 잊으면 여기서 실패한다.
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COPIES, staleCopies } from '../../scripts/sync-shared.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('확장 폴더의 공용 코드 사본이 원본과 같음', () => {
  const stale = staleCopies().map((s) => s.to);
  assert.deepEqual(stale, [], `node scripts/sync-shared.mjs 를 실행하세요: ${stale.join(', ')}`);
});

test('CleanShot: 피커보다 공용 코어를 먼저 주입하고, 워커도 불러옴', () => {
  const bg = read('cleanshot-picker/background.js');
  assert.match(bg, /importScripts\('shared\/redact-core\.js'(,\s*'[^']+')*\)/); // 공용 코어를 맨 먼저 (뒤에 다른 파일이 더 있어도 됨)
  assert.match(bg, /INJECT_FILES\s*=\s*\['shared\/redact-core\.js',\s*'picker\.js'\]/);
});

test('ClickGuide: 녹화·따라하기 스크립트보다 공용 코어와 요소 단서를 먼저 싣고, 주입·등록이 같은 목록을 씀', () => {
  const sw = read('click-guide/src/background/service-worker.js');
  // 공용 가리기 코어 → 요소 단서(cues.js, 녹화·따라하기 공용) → 녹화 / 따라하기
  assert.match(sw, /const RECORDER_FILES = \['src\/shared\/redact-core\.js',\s*'src\/content\/cues\.js',\s*'src\/content\/recorder\.js'\];/);
  assert.match(sw, /const PLAYER_FILES = \['src\/shared\/redact-core\.js',\s*'src\/content\/cues\.js',\s*'src\/content\/player\.js'\];/);
  assert.equal((sw.match(/files: RECORDER_FILES/g) || []).length, 1, '녹화 스크립트 주입(executeScript)');
  assert.equal((sw.match(/js: RECORDER_FILES/g) || []).length, 1, '녹화 스크립트 등록(registerContentScripts)');
  assert.equal((sw.match(/files: PLAYER_FILES/g) || []).length, 1, '따라하기 스크립트 주입');
  assert.equal((sw.match(/js: PLAYER_FILES/g) || []).length, 1, '따라하기 스크립트 등록');
  // 목록을 거치지 않고 녹화·따라하기 스크립트를 따로 싣는 곳이 없어야 한다
  assert.equal((sw.match(/'src\/content\/(recorder|player)\.js'/g) || []).length, 2);
});

test('배포 zip 에 공용 코드 사본이 들어감 (build-zip.ps1 포함 목록)', () => {
  const ps = read('scripts/build-zip.ps1');
  const line = (name) => (ps.match(new RegExp(`'${name}'\\s*=\\s*@\\(([^)]*)\\)`)) || [])[1] || '';
  assert.match(line('cleanshot-picker'), /'shared'/);
  assert.match(line('click-guide'), /'src'/);  // click-guide/src/shared 는 src 안에 있음
  for (const { to } of COPIES) for (const p of to) assert.ok(fs.existsSync(new URL(`../../${p}`, import.meta.url)), p);
});
