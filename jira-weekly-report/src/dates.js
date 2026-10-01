// 날짜 유틸 (브라우저 로컬 시간대 기준)

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');

/** Jira 날짜 문자열 → Date. "+0900" 형태의 오프셋도 처리 */
export function parseJiraDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const fixed = String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return isNaN(d) ? null : d;
}

/** "YYYY-MM-DD" (input[type=date] 값) → 로컬 자정 Date */
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 기준일이 속한 주 (월요일 시작) */
export function weekRange(ref) {
  const day = startOfDay(ref);
  const diffToMon = (day.getDay() + 6) % 7; // 월=0 … 일=6
  const monday = addDays(day, -diffToMon);
  const friday = addDays(monday, 4);
  const sunday = addDays(monday, 6);
  const nextMonday = addDays(monday, 7);
  return { monday, friday, sunday, nextMonday };
}

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const yymmdd = (d) => `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const mdDow = (d) => `${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${DOW[d.getDay()]})`;
export const md = (d) => `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
