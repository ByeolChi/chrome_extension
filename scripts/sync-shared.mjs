// 공용 코드(shared/)를 쓰는 확장 폴더로 복사한다.
// 확장은 빌드 없이 폴더째 로드하고, 압축 해제 로드에서는 폴더 밖을 가리키는 링크가 불안정하므로
// 사본을 각 확장 안에 두고 저장소에도 함께 올린다. 원본(shared/)을 고친 뒤 이 스크립트를 실행한다.
//   node scripts/sync-shared.mjs          사본을 원본과 같게 만든다
//   node scripts/sync-shared.mjs --check  다른 사본이 있으면 이름을 출력하고 종료 코드 1 (고치지 않음)
// 사본이 원본과 다르면 npm test 도 실패한다 (tests/repo/shared-sync.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 원본 → 사본 위치. 확장의 manifest·주입 목록·build-zip.ps1 의 포함 목록도 이 경로를 쓴다.
export const COPIES = [
  { from: 'shared/redact-core.js', to: ['cleanshot-picker/shared/redact-core.js', 'click-guide/src/shared/redact-core.js'] }
];

// 줄바꿈은 git 설정(core.autocrlf)에 따라 달라질 수 있으므로 LF 로 맞춰 비교한다
const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

export function staleCopies() {
  const stale = [];
  for (const { from, to } of COPIES) {
    const src = norm(fs.readFileSync(path.join(ROOT, from)));
    for (const dest of to) {
      const p = path.join(ROOT, dest);
      if (!fs.existsSync(p) || norm(fs.readFileSync(p)) !== src) stale.push({ from, to: dest });
    }
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stale = staleCopies();
  if (process.argv.includes('--check')) {
    for (const s of stale) console.log(`원본과 다름: ${s.to} (원본 ${s.from})`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const s of stale) {
    const p = path.join(ROOT, s.to);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(ROOT, s.from), p);
    console.log(`복사: ${s.from} -> ${s.to}`);
  }
  if (!stale.length) console.log('사본이 모두 원본과 같습니다.');
}
