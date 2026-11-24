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
  assert.match(bg, /importScripts\('shared\/redact-core\.js'\)/);
  assert.match(bg, /INJECT_FILES\s*=\s*\['shared\/redact-core\.js',\s*'picker\.js'\]/);
});

test('ClickGuide: 녹화 스크립트보다 공용 코어를 먼저 싣는 곳이 두 군데(주입·등록)', () => {
  const sw = read('click-guide/src/background/service-worker.js');
  const lists = sw.match(/\['src\/shared\/redact-core\.js',\s*'src\/content\/recorder\.js'\]/g) || [];
  assert.equal(lists.length, 2);
  assert.doesNotMatch(sw, /\['src\/content\/recorder\.js'\]/, '공용 코어 없이 녹화 스크립트만 싣는 곳이 남아 있음');
});

test('배포 zip 에 공용 코드 사본이 들어감 (build-zip.ps1 포함 목록)', () => {
  const ps = read('scripts/build-zip.ps1');
  const line = (name) => (ps.match(new RegExp(`'${name}'\\s*=\\s*@\\(([^)]*)\\)`)) || [])[1] || '';
  assert.match(line('cleanshot-picker'), /'shared'/);
  assert.match(line('click-guide'), /'src'/);  // click-guide/src/shared 는 src 안에 있음
  for (const { to } of COPIES) for (const p of to) assert.ok(fs.existsSync(new URL(`../../${p}`, import.meta.url)), p);
});
