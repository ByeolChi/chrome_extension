// ClickGuide 전체 백업: ZIP 쓰기·읽기, 백업 형식 검사, API 키 제외
// (IndexedDB 에 저장·복원하는 부분은 tests/e2e/click-guide/backup.mjs 가 브라우저에서 확인한다)
// 실행: 저장소 최상위에서 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const LIB = new URL('../../click-guide/src/lib/', import.meta.url);
const { createZip, crc32 } = await import(new URL('zip.js', LIB).href);
const { readZip } = await import(new URL('unzip.js', LIB).href);
const { validateBackup, settingsForBackup, BACKUP_FORMAT } = await import(new URL('../common/backup.js', LIB).href);

const enc = new TextEncoder();
const bytes = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

test('ZIP 왕복: 이 확장이 만든 ZIP(store)을 그대로 읽음 (한글 이름, 빈 파일, 바이너리)', async () => {
  const files = [
    { name: 'backup.json', data: enc.encode('{"a":"한글"}') },
    { name: 'shots/shot_1.jpg', data: bytes(70000) },
    { name: '빈 파일.txt', data: new Uint8Array(0) },
  ];
  const zip = await readZip(createZip(files));
  assert.deepEqual(zip.names, files.map((f) => f.name));
  for (const f of files) assert.deepEqual(await zip.read(f.name), f.data, f.name);
  assert.equal(zip.has('없음.txt'), false);
  await assert.rejects(zip.read('없음.txt'), /없습니다/);
});

test('ZIP: 내용이 손상되면 CRC 불일치로 거부', async () => {
  const buf = new Uint8Array(await createZip([{ name: 'a.bin', data: bytes(1000) }]).arrayBuffer());
  buf[30 + 'a.bin'.length + 500] ^= 0xff; // 데이터 가운데 한 바이트
  const zip = await readZip(buf);
  await assert.rejects(zip.read('a.bin'), /CRC/);
});

test('ZIP: ZIP 이 아닌 파일, 잘린 파일은 거부', async () => {
  await assert.rejects(readZip(enc.encode('not a zip at all, definitely not')), /ZIP 파일이 아닙니다/);
  const buf = new Uint8Array(await createZip([{ name: 'a.bin', data: bytes(5000) }]).arrayBuffer());
  await assert.rejects(readZip(buf.subarray(0, 2000)), /ZIP/);
});

// 압축 도구로 다시 묶은 ZIP 처럼 deflate 로 저장한 ZIP 을 직접 만든다
function deflateZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(Buffer.from(f.data));
    const crc = crc32(f.data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(f.data.length), u16(name.length), u16(0), name, comp]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    parts.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

test('ZIP: deflate 로 다시 묶은 ZIP 도 읽음', async () => {
  const files = [
    { name: 'backup.json', data: enc.encode(JSON.stringify({ format: BACKUP_FORMAT, x: 'y'.repeat(5000) })) },
    { name: 'shots/s1.png', data: bytes(30000, 3) },
  ];
  const zip = await readZip(deflateZip(files));
  for (const f of files) assert.deepEqual(await zip.read(f.name), f.data, f.name);
});

const valid = () => ({
  format: BACKUP_FORMAT, sessions: [{ id: 'ses_1', name: 'G' }], steps: [{ id: 'stp_1', sessionId: 'ses_1', shotId: 'shot_1' }],
  shots: [{ id: 'shot_1', file: 'shots/shot_1.jpg', type: 'image/jpeg' }], settings: { lang: 'ko', ai: {} },
});

test('백업 형식 검사: 올바른 백업은 통과, 틀리면 이유와 함께 거부', () => {
  validateBackup(valid());
  validateBackup({ ...valid(), settings: undefined });
  const bad = [
    [{ ...valid(), format: 'clickguide/v1' }, /전체 백업 파일이 아닙니다/],
    [null, /전체 백업 파일이 아닙니다/],
    [{ ...valid(), sessions: {} }, /sessions/],
    [{ ...valid(), steps: 'x' }, /steps/],
    [{ ...valid(), sessions: [{ name: 'id 없음' }] }, /가이드/],
    [{ ...valid(), steps: [{ id: 'a' }] }, /단계/],
    [{ ...valid(), shots: [{ id: 'a' }] }, /스크린샷/],
    [{ ...valid(), settings: [] }, /설정/],
  ];
  for (const [meta, re] of bad) assert.throws(() => validateBackup(meta), re);
});

test('백업의 설정에서 AI API 키를 뺌 (다른 설정은 그대로)', () => {
  const s = { lang: 'en', maxImageWidth: 1920, ai: { provider: 'openai', endpoint: 'http://x', model: 'm', apiKey: 'sk-secret', extraPrompt: 'p' } };
  const out = settingsForBackup(s);
  assert.equal('apiKey' in out.ai, false);
  assert.deepEqual(out.ai, { provider: 'openai', endpoint: 'http://x', model: 'm', extraPrompt: 'p' });
  assert.equal(out.lang, 'en');
  assert.equal(out.maxImageWidth, 1920);
  assert.equal(s.ai.apiKey, 'sk-secret'); // 원본은 건드리지 않음
});
