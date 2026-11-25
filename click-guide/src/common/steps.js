/* 단계 다루기
 * - 녹화를 끝낼 때, 입력란을 클릭한 단계 바로 뒤에 그 칸에 값을 넣은 단계가 있으면 클릭 단계를 뺀다.
 *   ("이름 입력란 클릭" + "이름 입력란에 홍길동 입력" → 입력 단계 하나. 입력 단계도 같은 칸을 하이라이트한다)
 * - 편집기의 "위 단계와 합치기"도 같은 판단으로 문장을 정한다. */

// 글자를 넣는 칸으로 보는 input 종류 (체크박스·라디오·버튼은 클릭 자체가 동작이라 빼지 않는다)
const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

export function isFieldClick(step) {
  if (!step || step.type !== 'click' || !step.el) return false;
  const tag = step.el.tag;
  return (tag === 'input' && TEXT_TYPES.has(String(step.el.type || '').toLowerCase())) || tag === 'textarea' || tag === 'select';
}

export function sameField(a, b) {
  const ea = a && a.el;
  const eb = b && b.el;
  if (!ea || !eb || ea.tag !== eb.tag) return false;
  if (ea.selector && eb.selector) return ea.selector === eb.selector;
  if (ea.id && eb.id) return ea.id === eb.id;
  return !!(ea.name && ea.name === eb.name && (ea.label || '') === (eb.label || ''));
}

/** 값 단계(input·select) 바로 앞에 같은 칸을 클릭한 단계들 → 뺄 클릭 단계 목록 (값 단계에 스크린샷이 있을 때만) */
export function fieldClicksToMerge(steps) {
  const out = [];
  for (let i = 1; i < steps.length; i++) {
    const v = steps[i];
    if ((v.type !== 'input' && v.type !== 'select') || !v.shotId) continue;
    for (let j = i - 1; j >= 0; j--) {
      const c = steps[j];
      if (!isFieldClick(c) || !sameField(c, v) || (c.url && v.url && c.url !== v.url)) break;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.sort((a, b) => steps.indexOf(a) - steps.indexOf(b));
}

/** 위 단계(upper)와 이 단계(lower)를 합칠 때의 설명: 같은 칸의 클릭+입력이면 입력 단계 설명만, 아니면 두 설명을 잇는다 */
export function mergedDescription(upper, lower) {
  if (isFieldClick(upper) && sameField(upper, lower)) return lower.description || '';
  return [upper.description, lower.description].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}
