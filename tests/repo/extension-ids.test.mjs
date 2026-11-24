// 확장 ID 고정 회귀 테스트: manifest 의 key 로 정해지는 ID 가 고정값, 그리고 문서에 적힌 ID 와 같은지
// key 가 바뀌거나 빠지면 ID 가 바뀌어 사용자의 저장 데이터(IndexedDB·chrome.storage)가 보이지 않게 되고,
// ssoda 는 cURL 실행 도우미 등록(allowed_origins)도 끊긴다. key 를 일부러 바꿀 때만 아래 값을 고친다.
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const PINNED = {
  ssoda: { id: 'cnnlkogkbglbbbcefpaknbmebieabijo', docs: ['README.md', 'EDGE.md'] },
  'click-guide': { id: 'aiageoiblanbjihfdogienmgjokgdhil', docs: ['README.md'] },
  'cleanshot-picker': { id: 'fdhmaehlpgpegiemhcfhffecnendgibe', docs: ['README.md'] },
};

// 확장 ID = 공개 키(DER) SHA-256 의 앞 32자리 16진수를 a~p 로 바꾼 것
function idFromKey(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

for (const [dir, { id, docs }] of Object.entries(PINNED)) {
  test(`${dir}: manifest 의 key 로 정해지는 ID 가 ${id}`, () => {
    const manifest = JSON.parse(read(`${dir}/manifest.json`));
    assert.ok(typeof manifest.key === 'string' && manifest.key.length > 0, 'manifest 에 key 가 없음');
    assert.equal(idFromKey(manifest.key), id);
  });

  test(`${dir}: 문서에 적힌 확장 ID 가 manifest 와 같음 (${docs.join(', ')})`, () => {
    const readme = read(`${dir}/README.md`);
    const m = readme.match(/ID\s*는\s*`([a-p]{32})`\s*로 고정/);
    assert.ok(m, 'README 에 "ID 는 `…` 로 고정" 문구가 없음');
    assert.equal(m[1], id);
    for (const doc of docs) {
      const ids = read(`${dir}/${doc}`).match(/\b[a-p]{32}\b/g) || [];
      assert.ok(ids.length > 0, `${doc} 에 확장 ID 가 없음`);
      assert.deepEqual([...new Set(ids)], [id], `${doc} 에 다른 ID 가 섞여 있음`);
    }
  });
}

// 망분리·관리형 PC 배포 안내서: 관리자가 정책·업데이트 XML 에 그대로 옮겨 쓰므로 ID 오타가 곧 설치 실패다
test('docs/airgap-deploy.md: 확장 ID 표와 본문의 ID 가 manifest 와 같음', () => {
  const doc = read('docs/airgap-deploy.md');
  const pinned = Object.values(PINNED).map((p) => p.id);
  const unknown = (doc.match(/\b[a-p]{32}\b/g) || []).filter((x) => !pinned.includes(x));
  assert.deepEqual([...new Set(unknown)], [], '표에 없는 ID 가 있음');
  for (const [dir, { id }] of Object.entries(PINNED)) {
    const rows = doc.split(/\r?\n/).filter((l) => l.startsWith('|') && l.includes(`\`${dir}\``) && /`[a-p]{32}`/.test(l));
    assert.equal(rows.length, 1, `확장 ID 표에 ${dir} 줄이 하나여야 함`);
    assert.ok(rows[0].includes(`\`${id}\``), `표의 ${dir} ID 가 다름`);
  }
});

test('docs/airgap-deploy.md: 정책 JSON 예시가 올바르고 세 확장을 모두 강제 설치함', () => {
  const blocks = [...read('docs/airgap-deploy.md').matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, '정책 JSON 예시(여러 줄, 한 줄)가 없음');
  const parsed = blocks.map((b) => JSON.parse(b));
  for (const policy of parsed) {
    assert.deepEqual(Object.keys(policy).sort(), Object.values(PINNED).map((p) => p.id).sort());
    for (const v of Object.values(policy)) {
      assert.equal(v.installation_mode, 'force_installed');
      assert.equal(v.override_update_url, true, 'override_update_url 이 없으면 업데이트를 사내 서버에서 받지 못함');
      assert.match(v.update_url, /^https:\/\//);
    }
  }
  for (const p of parsed.slice(1)) assert.deepEqual(p, parsed[0], '한 줄 예시가 여러 줄 예시와 다름');
});

test('scripts/install-ssoda-helper-machine.ps1: 도우미가 허용하는 확장 ID 가 ssoda 와 같음', () => {
  const ids = read('scripts/install-ssoda-helper-machine.ps1').match(/\b[a-p]{32}\b/g) || [];
  assert.deepEqual([...new Set(ids)], [PINNED.ssoda.id]);
});
