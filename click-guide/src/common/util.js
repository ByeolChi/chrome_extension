export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function slugify(s, fallback = 'guide') {
  const out = String(s || '').trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return out || fallback;
}

export function formatDate(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 주소를 사람에게 보여 줄 때 ----------
 * 웹 주소의 경로·쿼리에는 토큰이나 개인정보가 있을 수 있고, 로컬 파일(file://) 경로에는 사용자 이름(C:\Users\홍길동\…)이
 * 들어 있다. 그래서 문장·내보내기에는 웹 주소는 호스트만, 로컬 파일은 파일 이름만 쓴다. */

function fileUrlName(u) {
  if (u.pathname.endsWith('/')) return '';   // 폴더는 이름을 쓰지 않는다 (사용자 폴더 이름일 수 있음)
  let name = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch (_) { /* 그대로 */ }
  return name;
}

/** 장소 이름: 웹 주소는 호스트(www. 뺌), 로컬 파일은 파일 이름(폴더면 빈 문자열), 읽을 수 없으면 빈 문자열 */
export function placeName(url) {
  let u;
  try { u = new URL(url); } catch (_) { return ''; }
  if (u.protocol === 'file:') return fileUrlName(u);
  return u.hostname.replace(/^www\./, '');
}

/** 내보내는 파일에 넣을 주소: 로컬 파일은 폴더 경로를 지워 file:///…/파일이름 으로, 그 밖에는 그대로 */
export function shareableUrl(url) {
  if (typeof url !== 'string' || !/^file:/i.test(url)) return url;
  let u;
  try { u = new URL(url); } catch (_) { return 'file:///…/'; }
  return 'file:///…/' + fileUrlName(u);
}

/** 로컬 파일 페이지의 제목에 그 파일이 있는 폴더 경로가 들어 있으면(폴더 목록 'C:\Users\…\의 색인' 등) 파일 이름으로 바꾼다 */
export function localPageTitle(title, url) {
  if (!title || !/^file:/i.test(url || '')) return title || '';
  let u;
  try { u = new URL(url); } catch (_) { return ''; }
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (_) { /* 그대로 */ }
  const dir = p.slice(0, p.lastIndexOf('/'));                // '/C:/Users/me/문서' 또는 '/home/me/docs'
  const bare = dir.replace(/^\/([A-Za-z]:)/, '$1');           // 'C:/Users/me/문서'
  if (bare.replace(/^[A-Za-z]:/, '').length < 2) return title; // 드라이브 바로 아래 파일은 경로에 사용자 이름이 없다
  const t = String(title).toLowerCase();
  for (const form of [dir, bare, bare.replace(/\//g, '\\')]) {
    if (t.includes(form.toLowerCase())) return fileUrlName(u);
  }
  return title;
}

export function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
