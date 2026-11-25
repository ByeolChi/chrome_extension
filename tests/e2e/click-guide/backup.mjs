// ClickGuide 전체 백업·가져오기와 확장 ID 고정 E2E
// 실행: 저장소 최상위에서 node tests/e2e/click-guide/backup.mjs   (다른 사본: CG_EXT=<확장 폴더>)
// 1) manifest 에서 key 를 뺀 사본(= ID 고정 전 버전)을 올려 가이드를 만들고, 설정 화면의 버튼으로 전체 백업을 내려받는다
// 2) 새 프로필에 key 가 든 확장을 올려 ID 가 고정값인지 보고, 백업을 가져와 가이드·스크린샷·설정이 그대로인지 확인한다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium, evaluate, sleep } from './cdp.mjs';
import { tempDir } from '../lib/chromium.mjs';

const EXT = path.resolve(process.env.CG_EXT || fileURLToPath(new URL('../../../click-guide', import.meta.url)));
const PORT = Number(process.env.CDP_PORT) || 9301;
const WORK = tempDir('click-guide-backup-e2e-');
const { readZip } = await import(pathToFileURL(path.join(EXT, 'src', 'lib', 'unzip.js')).href);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const pinnedId = manifest.key ? idFromKey(manifest.key) : null;
function idFromKey(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/* ---------------- 브라우저 한 벌 띄우기 ---------------- */
async function browser(extPath, name) {
  const { proc, cdp } = await launchChromium({ extPath, userDataDir: path.join(WORK, 'profile-' + name), port: PORT });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  let extId = null;
  for (let i = 0; i < 60 && !extId; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && /service-worker\.js$/.test(t.url));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  if (!extId) throw new Error('확장 서비스 워커를 찾지 못했습니다');
  const dialogs = [];
  let answer = () => true;
  cdp.on((m) => {
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: answer(m.params) }, m.sessionId).catch(() => {});
    }
  });
  async function open(rel) {
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/${rel}` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    for (let i = 0; i < 50; i++) {
      if (await evaluate(cdp, sessionId, 'document.readyState').catch(() => '') === 'complete') break;
      await sleep(100);
    }
    await sleep(300);
    const ev = (expr) => evaluate(cdp, sessionId, expr);
    // 실제 마우스 클릭 (사용자 동작으로 다운로드가 허용되도록)
    async function click(selector) {
      // 긴 설정 화면의 아래쪽 버튼도 누를 수 있도록 먼저 화면 안으로 스크롤한다
      const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      await sleep(150);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }, sessionId);
      }
    }
    async function setFile(selector, file) {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId);
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] }, sessionId);
    }
    async function waitText(selector, re, ms = 20000) {
      const t0 = Date.now();
      let text = '';
      while (Date.now() - t0 < ms) {
        text = await ev(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`).catch(() => '');
        if (re.test(text)) return text;
        await sleep(150);
      }
      return text;
    }
    return { sessionId, ev, click, setFile, waitText, close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}) };
  }
  async function close() {
    try { await cdp.send('Browser.close'); } catch (_) { /* noop */ }
    cdp.close();
    try { proc.kill(); } catch (_) { /* noop */ }
    await sleep(600);
  }
  return { cdp, extId, open, dialogs, setAnswer: (fn) => { answer = fn; }, close };
}

// 확장 페이지에서 저장소 내용을 요약한다 (스크린샷은 SHA-256 으로)
const SNAPSHOT = `(async () => {
  const db = await import('/src/common/db.js');
  const st = await import('/src/common/settings.js');
  const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))).map((x) => x.toString(16).padStart(2, '0')).join('');
  const out = { sessions: [], settings: await st.getSettings({ withApiKey: true }), storage: JSON.stringify(await chrome.storage.local.get(null)) };
  for (const s of await db.listSessions()) {
    const steps = await db.getSteps(s.id);
    const shots = {};
    for (const x of steps) if (x.shotId) { const b = await db.getShot(x.shotId); shots[x.shotId] = b ? { type: b.type, hash: await hex(b) } : null; }
    out.sessions.push({ id: s.id, name: s.name, description: s.description, steps: steps.map((x) => ({ id: x.id, index: x.index, title: x.title, description: x.description, redactions: x.redactions || null, nrect: x.nrect || null, shotId: x.shotId || null })), shots });
  }
  out.sessions.sort((a, b) => a.id.localeCompare(b.id));
  return out;
})()`;

const SEED = `(async () => {
  const db = await import('/src/common/db.js');
  const st = await import('/src/common/settings.js');
  const img = async (w, h, color, type) => {
    const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(color, 10, 30);
    return c.convertToBlob({ type, quality: 0.8 });
  };
  const mk = async (name, n, color) => {
    const s = await db.createSession({ name, startUrl: 'https://intranet.example.com/' + name });
    for (let i = 0; i < n; i++) {
      const shotId = db.uid('shot');
      await db.putShot(shotId, await img(320 + i * 10, 200, color, i === 0 ? 'image/png' : 'image/jpeg'));
      await db.putStep({ id: db.uid('stp'), sessionId: s.id, index: i, type: 'click', title: name + ' 단계 ' + (i + 1) + ' (고친 문장)', description: '설명 ' + (i + 1),
        shotId, nrect: { x: 0.1 * i, y: 0.2, w: 0.3, h: 0.1 }, redactions: i === 1 ? [{ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }] : [] });
    }
    await db.updateSession(s.id, { stepCount: n, description: name + ' 가이드 설명' });
    return s.id;
  };
  await mk('주문 조회', 3, '#3366cc');
  await mk('정산 확인', 2, '#cc6633');
  await st.setSettings({ lang: 'en', redactSelectors: ['.secret', '#account'], maxImageWidth: 1920, ai: { provider: 'openai', model: 'gpt-x', apiKey: 'sk-test-SECRET-123' } });
  return true;
})()`;

let exitCode = 0;
try {
  /* ---------------- 1) ID 고정 전 버전: 가이드를 만들고 백업 ---------------- */
  const oldDir = path.join(WORK, 'old', 'click-guide');
  fs.cpSync(EXT, oldDir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules)([\\/]|$)/.test(p) });
  const oldManifest = JSON.parse(fs.readFileSync(path.join(oldDir, 'manifest.json'), 'utf8'));
  delete oldManifest.key;
  fs.writeFileSync(path.join(oldDir, 'manifest.json'), JSON.stringify(oldManifest, null, 2));

  const A = await browser(oldDir, 'old');
  check('ID 고정 전 사본은 폴더 위치로 정해진 다른 ID 로 올라감', !pinnedId || A.extId !== pinnedId, `사본 ID ${A.extId}`);
  const downloads = path.join(WORK, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  await A.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  let optA = await A.open('src/options/options.html');
  await optA.ev(SEED);
  const before = await optA.ev(SNAPSHOT);
  await optA.close();
  optA = await A.open('src/options/options.html');
  await optA.click('#backup-export');
  const stateA = await optA.waitText('#backup-state', /백업했습니다|실패/);
  let zipFile = null;
  for (let i = 0; i < 100 && !zipFile; i++) {
    const f = fs.readdirSync(downloads).find((x) => /^clickguide-backup-.*\.zip$/.test(x));
    if (f) zipFile = path.join(downloads, f);
    else await sleep(150);
  }
  check('설정 화면의 "전체 백업 내보내기"로 ZIP 이 내려받아짐', !!zipFile && /가이드 2개 · 단계 5개 · 스크린샷 5개/.test(stateA), stateA);
  await A.close();

  /* ---------------- 백업 ZIP 내용 ---------------- */
  const zip = await readZip(new Uint8Array(fs.readFileSync(zipFile)));
  const meta = JSON.parse(new TextDecoder().decode(await zip.read('backup.json')));
  const hashes = {};
  for (const s of meta.shots) hashes[s.id] = crypto.createHash('sha256').update(await zip.read(s.file)).digest('hex');
  const seededHashes = Object.assign({}, ...before.sessions.map((s) => Object.fromEntries(Object.entries(s.shots).map(([k, v]) => [k, v.hash]))));
  check('백업에 가이드 2개·단계 5개·스크린샷 5개 원본이 그대로 들어감',
    meta.format === 'clickguide-backup/v1' && meta.sessions.length === 2 && meta.steps.length === 5 && meta.shots.length === 5 &&
    JSON.stringify(hashes) === JSON.stringify(Object.fromEntries(Object.keys(hashes).map((k) => [k, seededHashes[k]]))),
    `sessions=${meta.sessions.length} steps=${meta.steps.length} shots=${meta.shots.length}`);
  check('백업의 설정에 AI API 키가 없음 (다른 설정은 들어감)',
    meta.settings && meta.settings.lang === 'en' && !('apiKey' in (meta.settings.ai || {})) && !JSON.stringify(meta).includes('sk-test-SECRET'),
    JSON.stringify(meta.settings.ai));

  /* ---------------- 2) ID 고정 버전: 가져오기 ---------------- */
  const B = await browser(EXT, 'new');
  check('key 가 든 확장은 고정 ID 로 올라감', !!pinnedId && B.extId === pinnedId, `ID ${B.extId}, 기대 ${pinnedId}`);
  let optB = await B.open('src/options/options.html');
  const empty = await optB.ev(SNAPSHOT);
  check('새 ID 에서는 처음에 가이드가 없음 (이전 ID 의 저장소와 분리)', empty.sessions.length === 0, `가이드 ${empty.sessions.length}개`);

  // 손상된 백업: backup.json 안의 한 바이트를 바꾼다 → 거부, 아무것도 가져오지 않음
  const buf = fs.readFileSync(zipFile);
  const bad = Buffer.from(buf);
  bad[30 + 'backup.json'.length + 20] ^= 0x55;
  const badFile = path.join(WORK, 'corrupted.zip');
  fs.writeFileSync(badFile, bad);
  B.dialogs.length = 0;
  await optB.setFile('#backup-file', badFile);
  const badState = await optB.waitText('#backup-state', /가져오기 실패|가져왔습니다/);
  const afterBad = await optB.ev(SNAPSHOT);
  check('손상된 백업은 거부하고 아무것도 가져오지 않음', /가져오기 실패/.test(badState) && afterBad.sessions.length === 0, badState);

  // 정상 백업 가져오기: 가이드 → 예, 설정 → 예 (새 쪽에 미리 넣어 둔 API 키는 그대로 남아야 한다)
  await optB.ev(`import('/src/common/settings.js').then((st) => st.setSettings({ ai: { apiKey: 'sk-new-KEEP' } })).then(() => true)`);
  B.dialogs.length = 0;
  B.setAnswer(() => true);
  await optB.setFile('#backup-file', zipFile);
  const stateB = await optB.waitText('#backup-state', /가져왔습니다|실패/);
  const after = await optB.ev(SNAPSHOT);
  check('가져오기 확인창에 가이드 수와 설정 질문이 나옴',
    B.dialogs.length === 2 && /새로 가져올 가이드: 2개/.test(B.dialogs[0]) && /설정도 백업 파일의 값으로/.test(B.dialogs[1]), JSON.stringify(B.dialogs));
  const strip = (snap) => JSON.stringify(snap.sessions);
  check('가이드·단계(고친 문장·가림·하이라이트)·스크린샷이 바이트까지 그대로 들어옴',
    /가이드 2개 · 단계 5개 · 스크린샷 5개/.test(stateB) && strip(after) === strip(before), stateB);
  check('설정은 백업의 값으로 바뀌고 AI API 키는 새 쪽에 넣어 둔 값이 그대로 남음',
    after.settings.lang === 'en' && JSON.stringify(after.settings.redactSelectors) === JSON.stringify(['.secret', '#account']) &&
    after.settings.maxImageWidth === 1920 && after.settings.ai.provider === 'openai' && after.settings.ai.model === 'gpt-x' &&
    after.settings.ai.apiKey === 'sk-new-KEEP',
    JSON.stringify({ lang: after.settings.lang, ai: after.settings.ai }));
  check('가져온 뒤에도 API 키는 storage.local(웹페이지 쪽 스크립트도 읽음)에 없음',
    !before.storage.includes('sk-test-SECRET') && !after.storage.includes('sk-new-KEEP'), after.storage.slice(0, 200));

  // 같은 백업을 다시 가져와도 겹치지 않음
  B.dialogs.length = 0;
  B.setAnswer((p) => p.type !== 'confirm'); // 설정 질문(confirm)은 아니오
  await optB.setFile('#backup-file', zipFile);
  await sleep(1500);
  const again = await optB.ev(SNAPSHOT);
  check('같은 백업을 다시 가져와도 가이드가 겹치지 않음', again.sessions.length === 2 && /모두 이미 있어서/.test(B.dialogs[0] || ''), JSON.stringify(B.dialogs));

  // 편집기에서 가져온 가이드가 열리고 스크린샷이 보임
  const first = after.sessions.find((s) => s.name === '주문 조회');
  const ed = await B.open(`src/editor/editor.html?session=${first.id}`);
  await sleep(800);
  const view = await ed.ev(`(() => { const imgs = [...document.querySelectorAll('li.step img')]; return { steps: document.querySelectorAll('li.step').length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, title: (document.querySelector('#guide-title') || {}).value }; })()`);
  check('편집기에서 가져온 가이드가 열리고 스크린샷이 보임', view.steps === 3 && view.loaded === 3 && view.title === '주문 조회', JSON.stringify(view));
  await B.close();
} catch (e) {
  check('실행 오류', false, (e && e.stack) || String(e));
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nClickGuide 백업·ID 고정: ${pass} / ${results.length} 통과`);
  exitCode = pass === results.length ? 0 : 1;
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) { /* 브라우저가 아직 파일을 잡고 있을 수 있음 */ }
  process.exit(exitCode);
}
