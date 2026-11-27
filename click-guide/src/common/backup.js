// 전체 백업 / 가져오기
// 가이드는 IndexedDB 에, 설정은 chrome.storage 에 있어 둘 다 확장 ID 에 묶여 있다. 다른 PC·다른 폴더로 옮기거나
// 확장 ID 가 바뀌면(manifest key 추가 등) 새로 시작하므로, 원본 그대로 ZIP 하나로 옮길 수 있게 한다.
// AI API 키(비밀 보관소, secrets.js)는 백업에 넣지 않고, 가져올 때도 바꾸지 않는다.
//   backup.json            형식, 가이드·단계 레코드, 설정(AI API 키 제외), 스크린샷 목록
//   shots/<id>.<확장자>     스크린샷 원본 (편집기에서 고친 가림·하이라이트는 단계 레코드에 그대로 있다)
// 가이드 파일(buildGuideFile)은 같은 형식의 가이드 하나짜리 ZIP 이다. 남에게 보내는 파일이라 설정은 빼고,
// 편집기에서 더 가린 곳은 스크린샷에 칠해서 넣는다.
import * as db from './db.js';
import { getSettings, setSettings } from './settings.js';
import { paintStep } from './annotate.js';
import { createZip } from '../lib/zip.js';
import { readZip } from '../lib/unzip.js';

export const BACKUP_FORMAT = 'clickguide-backup/v1';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** 설정에서 AI API 키를 뺀 사본. 백업 파일은 다른 사람에게 넘어갈 수 있다 */
export function settingsForBackup(s) {
  const { apiKey, ...ai } = (s && s.ai) || {};
  return { ...s, ai };
}

const fileName = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');

/**
 * 모든 가이드·단계·스크린샷과 설정을 ZIP Blob 으로 → { blob, counts }
 * sessionIds: 이 가이드만, includeSettings: false 면 설정을 넣지 않는다
 * paintShot(blob, redactions): 편집기에서 더 가린 곳이 있는 스크린샷을 바꿔 넣는다 (가이드 파일). 없으면 원본 그대로
 */
export async function buildBackup({ onProgress, sessionIds = null, includeSettings = true, paintShot = null } = {}) {
  const want = Array.isArray(sessionIds) ? new Set(sessionIds) : null;
  const sessions = (await db.listSessions()).filter((s) => !want || want.has(s.id));
  const steps = [];
  const shots = [];
  const files = [];
  const seen = new Set();
  let done = 0;
  for (const ses of sessions) {
    const list = await db.getSteps(ses.id);
    // 스크린샷마다 그 스크린샷을 쓰는 단계들의 가림을 모두 모은다
    const redsByShot = new Map();
    if (paintShot) {
      for (const st of list) {
        if (!st.shotId || !Array.isArray(st.redactions) || !st.redactions.length) continue;
        redsByShot.set(st.shotId, (redsByShot.get(st.shotId) || []).concat(st.redactions));
      }
    }
    for (const st of list) {
      steps.push(st);
      if (!st.shotId || seen.has(st.shotId)) continue;
      seen.add(st.shotId);
      let blob = await db.getShot(st.shotId);
      if (!blob) continue;
      if (redsByShot.has(st.shotId)) blob = await paintShot(blob, redsByShot.get(st.shotId));
      const file = `shots/${fileName(st.shotId)}.${EXT[blob.type] || 'bin'}`;
      files.push({ name: file, data: new Uint8Array(await blob.arrayBuffer()) });
      shots.push({ id: st.shotId, file, type: blob.type || '' });
    }
    done++;
    if (onProgress) onProgress(done, sessions.length);
  }
  const meta = {
    format: BACKUP_FORMAT,
    app: 'ClickGuide',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    scope: want ? 'guide' : 'all',
    sessions,
    steps,
    shots
  };
  if (includeSettings) meta.settings = settingsForBackup(await getSettings());
  files.unshift({ name: 'backup.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
  return { blob: createZip(files), counts: { sessions: sessions.length, steps: steps.length, shots: shots.length } };
}

/* 가림을 칠한 스크린샷. 편집기·문서 내보내기와 같은 방법(설정의 검정/흐리게)으로 칠하고 형식은 원래대로 둔다 */
async function paintRedactedShot(blob, redactions, settings) {
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    paintStep(canvas.getContext('2d'), bmp, { redactions }, settings, { width: bmp.width, height: bmp.height });
    const type = /^image\/(png|webp)$/.test(blob.type) ? blob.type : 'image/jpeg';
    // 한 번 더 저장하며 흐려지지 않게 높은 품질로
    return await canvas.convertToBlob(type === 'image/png' ? { type } : { type, quality: 0.92 });
  } finally {
    try { bmp.close(); } catch (_) { /* noop */ }
  }
}

/**
 * 가이드 파일: 가이드 하나를 남에게 보내는 ZIP → { blob, counts }
 * 설정은 넣지 않는다. 편집기에서 더 가린 곳(step.redactions)은 스크린샷에 칠해서 넣어, 받는 사람이 ZIP 을 풀어
 * 그림만 꺼내 봐도 가린 곳 아래가 보이지 않게 한다. 가림 상자는 단계에 그대로 두어 받는 쪽 편집기에서도 보인다.
 * (전체 백업은 내가 옮겨 쓰는 파일이라 원본 그대로 둔다 — 가림을 나중에 고칠 수 있게)
 */
export async function buildGuideFile(sessionId) {
  const settings = await getSettings();
  return buildBackup({
    sessionIds: [sessionId],
    includeSettings: false,
    paintShot: (blob, reds) => paintRedactedShot(blob, reds, settings)
  });
}

/** backup.json 형식 검사. 맞지 않으면 Error */
export function validateBackup(meta) {
  if (!meta || typeof meta !== 'object' || meta.format !== BACKUP_FORMAT) throw new Error('ClickGuide 전체 백업 파일이 아닙니다.');
  for (const k of ['sessions', 'steps', 'shots']) {
    if (!Array.isArray(meta[k])) throw new Error(`백업 파일의 ${k} 항목이 올바르지 않습니다.`);
  }
  for (const s of meta.sessions) if (!s || typeof s.id !== 'string' || !s.id) throw new Error('id 가 없는 가이드가 있습니다.');
  for (const s of meta.steps) if (!s || typeof s.id !== 'string' || typeof s.sessionId !== 'string') throw new Error('id 가 없는 단계가 있습니다.');
  for (const s of meta.shots) if (!s || typeof s.id !== 'string' || typeof s.file !== 'string') throw new Error('스크린샷 목록이 올바르지 않습니다.');
  if (meta.settings != null && (typeof meta.settings !== 'object' || Array.isArray(meta.settings))) throw new Error('백업 파일의 설정이 올바르지 않습니다.');
}

/**
 * 백업 ZIP 을 읽고 검사해 무엇을 가져올지 정한다 (아직 저장하지 않는다).
 * 같은 id 의 가이드가 이미 있으면 건너뛴다 → { zip, meta, newSessions, skipped }
 */
export async function readBackup(file) {
  let zip;
  try {
    zip = await readZip(file);
  } catch (e) {
    throw new Error('백업 파일을 열 수 없습니다: ' + e.message);
  }
  if (!zip.has('backup.json')) throw new Error('ClickGuide 전체 백업 파일이 아닙니다 (backup.json 없음).');
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(await zip.read('backup.json')));
  } catch (e) {
    throw new Error('backup.json 을 읽을 수 없습니다: ' + e.message);
  }
  validateBackup(meta);
  const existing = new Set((await db.listSessions()).map((s) => s.id));
  const newSessions = meta.sessions.filter((s) => !existing.has(s.id));
  return { zip, meta, newSessions, skipped: meta.sessions.length - newSessions.length };
}

/**
 * readBackup 의 결과대로 저장한다. 가이드 하나(단계·스크린샷 포함)씩 한 트랜잭션으로 넣는다.
 * settings: true 면 설정도 백업의 값으로 바꾼다 (AI API 키는 지금 값을 그대로 둔다)
 */
export async function applyBackup(plan, { settings = false, onProgress } = {}) {
  const { zip, meta, newSessions } = plan;
  const shotById = new Map(meta.shots.map((s) => [s.id, s]));
  const res = { sessions: 0, steps: 0, shots: 0 };
  for (const ses of newSessions) {
    const steps = meta.steps.filter((st) => st.sessionId === ses.id);
    const blobs = [];
    for (const st of steps) {
      const sh = st.shotId ? shotById.get(st.shotId) : null;
      if (!sh || !zip.has(sh.file) || blobs.some((b) => b.id === sh.id)) continue;
      blobs.push({ id: sh.id, blob: new Blob([await zip.read(sh.file)], { type: sh.type || 'image/jpeg' }) });
    }
    await db.importSession(ses, steps, blobs);
    res.sessions++;
    res.steps += steps.length;
    res.shots += blobs.length;
    if (onProgress) onProgress(res.sessions, newSessions.length);
  }
  if (settings && meta.settings) {
    // 백업에 키가 들어 있더라도 쓰지 않는다. setSettings 는 ai.apiKey 가 없으면 지금 키를 그대로 둔다
    await setSettings(settingsForBackup(meta.settings));
  }
  return res;
}

/**
 * 가이드 파일(또는 전체 백업)의 가이드를 가져온다. 설정은 바꾸지 않는다.
 * replace: true 면 이미 있는 같은 가이드를 지우고 파일의 것으로 바꾼다 (만든 사람이 고쳐서 다시 보낸 가이드)
 * → { sessions, steps, shots, ids: 가져온 가이드 id }
 */
export async function applyGuideFile(plan, { replace = false } = {}) {
  const { zip, meta } = plan;
  const existing = new Set((await db.listSessions()).map((s) => s.id));
  const shotById = new Map(meta.shots.map((s) => [s.id, s]));
  const res = { sessions: 0, steps: 0, shots: 0, ids: [] };
  for (const ses of meta.sessions) {
    if (existing.has(ses.id) && !replace) continue;
    const steps = meta.steps.filter((st) => st.sessionId === ses.id);
    // 스크린샷을 모두 읽은 뒤에 원래 가이드를 지운다 (파일이 깨져 읽다 멈춰도 원래 가이드는 남게)
    const blobs = [];
    for (const st of steps) {
      const sh = st.shotId ? shotById.get(st.shotId) : null;
      if (!sh || !zip.has(sh.file) || blobs.some((b) => b.id === sh.id)) continue;
      blobs.push({ id: sh.id, blob: new Blob([await zip.read(sh.file)], { type: sh.type || 'image/jpeg' }) });
    }
    if (existing.has(ses.id)) await db.deleteSession(ses.id);
    await db.importSession(ses, steps, blobs);
    res.sessions++;
    res.steps += steps.length;
    res.shots += blobs.length;
    res.ids.push(ses.id);
  }
  return res;
}
