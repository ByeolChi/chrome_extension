// ClickGuide 가리기 E2E (공용 가리기 코어 shared/redact-core.js 사용)
// 실행: 저장소 최상위에서 node tests/e2e/click-guide/redact.mjs   (다른 사본: CG_EXT=<확장 폴더>)
// 저장된 스크린샷의 픽셀로 판정한다. 빨간 상자는 가려져야 하는 것이라 빨간 점이 남으면 실패다.
//  1) 화면 글자 속 개인정보(휴대폰·주민번호·이메일·계좌)를 검정으로 가리고, 비슷한 숫자는 그대로 둔다
//  2) 클릭한 뒤에 뜬 모달 안의 가릴 영역도 가린다 (촬영 직후 다시 잼)
//  3) 클릭과 촬영 사이에 움직인 가릴 영역도 촬영 순간의 자리까지 덮는다
//  4) iframe 안을 클릭해도 바깥 문서의 비밀번호 칸을 가리고, 다른 출처 iframe·shadow root 안의 것도 가린다
//  5) 개인정보 모양의 입력값은 ●●●● 로 기록하고 그 칸을 스크린샷에서 가린다
//  6) 설정: 흐리게, 화면 개인정보 자동 가리기 끄기
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, evaluate, sleep } from './cdp.mjs';
import { startServers } from './server.mjs';
import { tempDir } from '../lib/chromium.mjs';

const EXT = path.resolve(process.env.CG_EXT || fileURLToPath(new URL('../../../click-guide', import.meta.url)));
const PROFILE = tempDir('click-guide-redact-e2e-');
const PORT = Number(process.env.CDP_PORT) || 9301;
const A = 'http://127.0.0.1:18931';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const servers = await startServers([18931, 18932]);
const { proc, cdp } = await launchChromium({ extPath: EXT, userDataDir: PROFILE, port: PORT });

await cdp.send('Target.setDiscoverTargets', { discover: true });
let extId = null;
for (let i = 0; i < 60 && !extId; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && /service-worker\.js$/.test(t.url));
  if (sw) extId = new URL(sw.url).host;
  else await sleep(200);
}
if (!extId) throw new Error('확장 서비스 워커를 찾지 못했습니다');

async function openPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const page = { targetId, sessionId };
  const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  return page;
}
const pageEval = (page, expr) => evaluate(cdp, page.sessionId, expr);

const ext = await openPage(`chrome-extension://${extId}/src/options/options.html`);
const extEval = (expr) => pageEval(ext, expr);
const sendMsg = (msg) => extEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
const setSettings = (s) => extEval(`chrome.storage.local.set({ cg_settings: ${JSON.stringify(s)} }).then(() => true)`);

async function tabIdOf(page) {
  const info = await cdp.send('Target.getTargetInfo', { targetId: page.targetId });
  const tabs = await extEval(`chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`);
  const hit = tabs.find((x) => x.url === info.targetInfo.url);
  return hit ? hit.id : null;
}

async function activate(page) {
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  const id = await tabIdOf(page);
  if (id) await extEval(`chrome.tabs.update(${id}, { active: true }).then(() => true)`);
  await sleep(250);
}

async function click(page, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.sessionId);
}

/* 가장 최근 가이드의 단계들 */
async function steps() {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const ss = (await db.listSessions()).sort((a, b) => b.createdAt - a.createdAt);
    if (!ss.length) return [];
    return (await db.getSteps(ss[0].id)).map((s) => ({ type: s.type, title: s.title || '', description: s.description || '',
      value: s.value || '', masked: !!s.masked, shotId: s.shotId || null, shotError: s.shotError || '' }));
  })()`);
}

/* 스크린샷이 있는 단계가 n 개를 넘을 때까지 기다린다 */
async function waitShots(n, ms = 8000) {
  const t0 = Date.now();
  let list = [];
  while (Date.now() - t0 < ms) {
    list = await steps();
    if (list.filter((s) => s.shotId).length >= n) return list;
    await sleep(200);
  }
  return list;
}

/* 저장된 스크린샷에서 영역(CSS px, 가장자리 m 만큼 안쪽)의 밝기 평균·표준편차와 빨간 점 수 */
async function regions(shotId, viewportW, rects, m = 3) {
  return extEval(`(async () => {
    const db = await import('/src/common/db.js');
    const blob = await db.getShot(${JSON.stringify(shotId)});
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const k = bmp.width / ${viewportW};
    return ${JSON.stringify(rects)}.map(([x, y, w, h]) => {
      const px = Math.round((x + ${m}) * k), py = Math.round((y + ${m}) * k);
      const pw = Math.max(1, Math.round((w - ${m} * 2) * k)), ph = Math.max(1, Math.round((h - ${m} * 2) * k));
      const d = ctx.getImageData(px, py, pw, ph).data;
      let s = 0, s2 = 0, n = 0, red = 0;
      for (let i = 0; i < d.length; i += 4) {
        const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        s += L; s2 += L * L; n++;
        if (d[i] > 160 && d[i + 1] < 90 && d[i + 2] < 90) red++;
      }
      const mean = s / n;
      return { mean: Math.round(mean), std: Math.round(Math.sqrt(Math.max(0, s2 / n - mean * mean))), red };
    });
  })()`);
}

const black = (r) => !!r && r.mean < 40 && r.std < 30;
const plain = (r) => !!r && (r.std > 40 || r.mean > 120);   // 가리지 않은 글자: 흰 바탕에 검은 획
const fmt = (r) => r ? `평균 ${r.mean}·편차 ${r.std}${r.red ? `·빨강 ${r.red}` : ''}` : '없음';

try {
  await setSettings({});   // 기본값: 검정 칠하기, 화면 개인정보 자동 가리기 켬, 민감 입력값 가리기 켬
  const tab = await openPage(`${A}/redact.html`);
  await sleep(600);        // iframe 로드
  await activate(tab);
  const started = await sendMsg({ type: 'START', tabId: await tabIdOf(tab) });
  if (!started || !started.ok) throw new Error('녹화를 시작하지 못함: ' + JSON.stringify(started));
  await sleep(1000);

  const vw = await pageEval(tab, 'innerWidth');
  // 글자는 글자 영역(Range), 나머지는 요소 상자. 표 칸의 여백처럼 글자 밖은 가리지 않으므로 글자 영역으로 잰다.
  const R = await pageEval(tab, `(() => {
    const o = {};
    const TEXT = ['phone', 'rrn', 'mail', 'ctl', 'acct', 'nohint'];
    for (const id of [...TEXT, 'tel', 'pw', 'checker', 'fx']) {
      const el = document.getElementById(id);
      let b = el.getBoundingClientRect();
      if (TEXT.includes(id)) { const r = document.createRange(); r.selectNodeContents(el); b = r.getBoundingClientRect(); }
      o[id] = [b.x, b.y, b.width, b.height];
    }
    return o;
  })()`);
  const fx = R.fx;
  const F = {
    fsecret: [fx[0] + 170, fx[1] + 10, 120, 60],
    fphone: [fx[0] + 12, fx[1] + 102, 100, 22]   // 24px 글자 "010-5555-6666" 의 안쪽
  };

  /* ---- 1. 화면 글자·입력칸·다른 프레임 ---- */
  await click(tab, 460, 40);   // 그냥 버튼
  let list = await waitShots(1);
  let shot = list.filter((s) => s.shotId).pop();
  check('1-0 클릭 단계에 스크린샷이 있음', !!shot, shot ? '' : JSON.stringify(list));
  if (shot) {
    const [phone, rrn, mail, ctl, acct, nohint, pw, checker, fsecret, fphone] = await regions(shot.shotId, vw,
      [R.phone, R.rrn, R.mail, R.ctl, R.acct, R.nohint, R.pw, R.checker, F.fsecret, F.fphone]);
    check('1-1 화면 글자 속 휴대폰·주민번호·이메일이 검정으로 가려짐', black(phone) && black(rrn) && black(mail),
      `휴대폰 ${fmt(phone)} / 주민 ${fmt(rrn)} / 이메일 ${fmt(mail)}`);
    check('1-2 옆 칸에 "입금 계좌"가 있는 번호는 가리고, 같은 모양이라도 계좌라는 말이 없는 번호와 주문번호는 그대로',
      black(acct) && plain(nohint) && plain(ctl), `계좌 ${fmt(acct)} / 말 없음 ${fmt(nohint)} / 주문번호 ${fmt(ctl)}`);
    check('1-3 비밀번호 칸과 data-clickguide-redact 영역이 검정', black(pw) && black(checker), `비밀번호 ${fmt(pw)} / 지정 영역 ${fmt(checker)}`);
    check('1-4 다른 출처 iframe 안의 지정 영역과 휴대폰 번호도 가려짐 (클릭하지 않은 프레임)',
      black(fsecret) && fsecret.red < 20 && black(fphone), `지정 영역 ${fmt(fsecret)} / 휴대폰 ${fmt(fphone)}`);
    const [cpw, cphone, osecret] = await regions(shot.shotId, vw, [
      [20, 520, 200, 40],         // 닫힌 shadow root 안 비밀번호 칸
      [244, 529, 110, 18],        // 닫힌 shadow root 안 휴대폰 번호(24px 글자의 안쪽)
      [420, 520, 120, 60]         // 열린 shadow root 안 지정 영역
    ], 2);
    check('1-5 웹 컴포넌트의 닫힌 shadow root 안 비밀번호 칸·휴대폰 번호와 열린 shadow root 안의 지정 영역도 가려짐',
      black(cpw) && black(cphone) && black(osecret) && osecret.red < 20,
      `비밀번호 ${fmt(cpw)} / 휴대폰 ${fmt(cphone)} / 지정 영역 ${fmt(osecret)}`);
  }

  /* ---- 2. 클릭한 뒤에 뜬 모달 ---- */
  await click(tab, 100, 40);   // 모달 열기 → 빨간 data-clickguide-redact 상자가 생김
  list = await waitShots(2);
  shot = list.filter((s) => s.shotId)[1];
  if (shot) {
    const [modal] = await regions(shot.shotId, vw, [[20, 90, 340, 70]]);
    check('2-1 클릭한 뒤에 뜬 모달 안의 가릴 영역도 가려짐', black(modal) && modal.red < 20, fmt(modal));
  } else check('2-1 클릭한 뒤에 뜬 모달 안의 가릴 영역도 가려짐', false, '스크린샷 없음');

  /* ---- 3. 클릭과 촬영 사이에 움직인 영역 ---- */
  await click(tab, 280, 40);   // 옮기기 → 빨간 상자가 1.2초 동안 오른쪽으로 이동
  list = await waitShots(3);
  shot = list.filter((s) => s.shotId)[2];
  if (shot) {
    const [strip] = await regions(shot.shotId, vw, [[0, 196, 720, 68]], 0);
    check('3-1 움직이는 가릴 영역이 촬영 순간의 자리에서도 가려짐 (빨간 점 없음)', strip && strip.red < 30, fmt(strip));
  } else check('3-1 움직이는 가릴 영역이 촬영 순간의 자리에서도 가려짐 (빨간 점 없음)', false, '스크린샷 없음');
  await sleep(1300);

  /* ---- 4. iframe 안을 클릭 ---- */
  await click(tab, fx[0] + 70, fx[1] + 28);   // 프레임 버튼
  list = await waitShots(4);
  shot = list.filter((s) => s.shotId)[3];
  if (shot) {
    const [pw, checker, phone, fsecret] = await regions(shot.shotId, vw, [R.pw, R.checker, R.phone, F.fsecret]);
    check('4-1 iframe 안을 클릭해도 바깥 문서의 비밀번호 칸·지정 영역·개인정보가 가려짐',
      black(pw) && black(checker) && black(phone), `비밀번호 ${fmt(pw)} / 지정 영역 ${fmt(checker)} / 휴대폰 ${fmt(phone)}`);
    check('4-2 클릭한 iframe 안의 지정 영역도 가려짐', black(fsecret) && fsecret.red < 20, fmt(fsecret));
    check('4-3 iframe 안 클릭이 그 버튼 단계로 기록됨', /프레임 버튼/.test(shot.title), shot.title);
  } else check('4-1 iframe 안을 클릭해도 바깥 문서의 비밀번호 칸·지정 영역·개인정보가 가려짐', false, '스크린샷 없음');

  /* ---- 5. 개인정보 모양의 입력값 ---- */
  const tel = R.tel;
  await click(tab, tel[0] + 40, tel[1] + 20);
  await sleep(500);
  await cdp.send('Input.insertText', { text: '010-9876-5432' }, tab.sessionId);
  await sleep(200);
  const before = (await steps()).filter((s) => s.shotId).length;
  await click(tab, 460, 40);   // 다른 곳 클릭 → 입력 단계 + 클릭 단계
  list = await waitShots(before + 2);
  const input = list.filter((s) => s.type === 'input').pop();
  check('5-1 휴대폰 번호 모양의 입력값은 ●●●● 로 기록 (칸 이름이 평범해도)',
    !!input && input.masked && /●/.test(input.value) && !/9876/.test(input.value + input.title + input.description),
    input ? `값 "${input.value}" / ${input.title}` : '입력 단계 없음');
  const after = list.filter((s) => s.shotId).pop();
  if (after) {
    const [telR] = await regions(after.shotId, vw, [tel]);
    check('5-2 개인정보가 든 입력칸은 스크린샷에서 칸째 가려짐', black(telR), fmt(telR));
  }

  /* ---- 6. 흐리게 ---- */
  await setSettings({ redactStyle: 'blur' });
  await sleep(700);
  let n0 = (await steps()).filter((s) => s.shotId).length;
  await click(tab, 460, 40);
  list = await waitShots(n0 + 1);
  shot = list.filter((s) => s.shotId).pop();
  if (shot) {
    const [checker] = await regions(shot.shotId, vw, [R.checker], 8);
    check('6-1 가리는 방식을 흐리게로 바꾸면 검정 대신 흐리게 처리됨', checker && checker.mean > 60 && checker.std < 45, fmt(checker));
  }

  /* ---- 7. 화면 개인정보 자동 가리기 끄기 ---- */
  await setSettings({ maskScreenPII: false });
  await sleep(700);
  n0 = (await steps()).filter((s) => s.shotId).length;
  await click(tab, 460, 40);
  list = await waitShots(n0 + 1);
  shot = list.filter((s) => s.shotId).pop();
  if (shot) {
    const [phone, checker] = await regions(shot.shotId, vw, [R.phone, R.checker]);
    check('7-1 화면 개인정보 자동 가리기를 끄면 글자는 그대로, 지정 영역은 계속 검정', plain(phone) && black(checker),
      `휴대폰 ${fmt(phone)} / 지정 영역 ${fmt(checker)}`);
  }

  await sendMsg({ type: 'STOP', discard: true });
} catch (e) {
  check('실행 오류', false, e.stack || e.message);
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nClickGuide 가리기: ${pass} / ${results.length} 통과`);
  try { await cdp.send('Browser.close'); } catch (_) { /* noop */ }
  cdp.close();
  try { proc.kill(); } catch (_) { /* noop */ }
  for (const s of servers) s.close();
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* 잠금 해제 전일 수 있음 */ }
  process.exit(pass === results.length ? 0 : 1);
}
