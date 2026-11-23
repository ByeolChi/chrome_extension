// ssoda cURL 실행 도우미 시험 실행기
// 사용: 저장소 최상위에서 npm run test:helper   (또는 node tests/ssoda-helper/run.mjs [helper] [curl-path] [ssh])
// 차례로 실행하고, 하나라도 실패하면 종료 코드 1. 준비가 안 된 시험(예: paramiko 없음)은 "준비 안 됨"으로 표시하고 실패로 치지 않는다.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = { helper: 'helper.mjs', 'curl-path': 'curl-path.mjs', ssh: 'ssh.mjs' };

const picked = process.argv.slice(2);
const unknown = picked.filter((n) => !SUITES[n]);
if (unknown.length) {
  console.error(`모르는 시험: ${unknown.join(', ')} (가능: ${Object.keys(SUITES).join(', ')})`);
  process.exit(2);
}

const summary = [];
for (const name of picked.length ? picked : Object.keys(SUITES)) {
  console.log(`\n===== ${name}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, SUITES[name])], { stdio: 'inherit' });
  summary.push({ name, status: r.status, sec: Math.round((Date.now() - t0) / 1000) });
}

console.log('\n===== 요약');
for (const s of summary) console.log(`${s.status === 0 ? '통과' : s.status === 2 ? '준비 안 됨' : '실패'}  ${s.name}  (${s.sec}초)`);
process.exit(summary.some((s) => s.status !== 0 && s.status !== 2) ? 1 : 0);
