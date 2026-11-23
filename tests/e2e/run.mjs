// 브라우저 시험 실행기
// 사용: 저장소 최상위에서 npm run test:e2e   (또는 node tests/e2e/run.mjs [ssoda] [click-guide] [cleanshot-picker])
// 시험을 하나씩 차례로 실행하고, 하나라도 실패하면 종료 코드 1 로 끝낸다.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = {
  ssoda: [{ file: 'ssoda/e2e.mjs' }],
  'click-guide': [{ file: 'click-guide/e2e.mjs' }],
  'cleanshot-picker': [
    { file: 'cleanshot-picker/e2e.mjs', env: { DPR: '1' }, label: '화면 배율 1' },
    { file: 'cleanshot-picker/e2e.mjs', env: { DPR: '2' }, label: '화면 배율 2' },
  ],
};

const picked = process.argv.slice(2);
const unknown = picked.filter((n) => !SUITES[n]);
if (unknown.length) {
  console.error(`모르는 시험: ${unknown.join(', ')} (가능: ${Object.keys(SUITES).join(', ')})`);
  process.exit(2);
}

const summary = [];
for (const name of picked.length ? picked : Object.keys(SUITES)) {
  for (const run of SUITES[name]) {
    const title = run.label ? `${name} (${run.label})` : name;
    console.log(`\n===== ${title}`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(HERE, run.file)], { stdio: 'inherit', env: { ...process.env, ...(run.env || {}) } });
    summary.push({ title, ok: r.status === 0, sec: Math.round((Date.now() - t0) / 1000) });
  }
}

console.log('\n===== 요약');
for (const s of summary) console.log(`${s.ok ? '통과' : '실패'}  ${s.title}  (${s.sec}초)`);
process.exit(summary.every((s) => s.ok) ? 0 : 1);
