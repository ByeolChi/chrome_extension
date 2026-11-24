// 전체 백업 / 가져오기
// 가이드는 IndexedDB 에, 설정은 chrome.storage 에 있어 둘 다 확장 ID 에 묶여 있다. 다른 PC·다른 폴더로 옮기거나
// 확장 ID 가 바뀌면(manifest key 추가 등) 새로 시작하므로, 원본 그대로 ZIP 하나로 옮길 수 있게 한다.
//   backup.json            형식, 가이드·단계 레코드, 설정(AI API 키 제외), 스크린샷 목록
//   shots/<id>.<확장자>     스크린샷 원본 (편집기에서 고친 가림·하이라이트는 단계 레코드에 그대로 있다)
import * as db from './db.js';
import { getSettings, setSettings } from './settings.js';
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

/** 모든 가이드·단계·스크린샷과 설정을 ZIP Blob 으로 → { blob, counts } */
export async function buildBackup({ onProgress } = {}) {
  const sessions = await db.listSessions();
  const steps = [];
  const shots = [];
  const files = [];
  const seen = new Set();
  let done = 0;
  for (const ses of sessions) {
    for (const st of await db.getSteps(ses.id)) {
      steps.push(st);
      if (!st.shotId || seen.has(st.shotId)) continue;
      seen.add(st.shotId);
      const blob = await db.getShot(st.shotId);
      if (!blob) continue;
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
    settings: settingsForBackup(await getSettings()),
    sessions,
    steps,
    shots
  };
  files.unshift({ name: 'backup.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
  return { blob: createZip(files), counts: { sessions: sessions.length, steps: steps.length, shots: shots.length } };
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
    const cur = await getSettings();
    await setSettings({ ...meta.settings, ai: { ...(meta.settings.ai || {}), apiKey: cur.ai.apiKey } });
  }
  return res;
}
