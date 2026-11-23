// 무손실 JSON 정렬
// JSON.parse → JSON.stringify 로 정렬하면 값이 바뀐다.
//   - 큰 정수: 1234567890123456789 → 1234567890123456800 (Java Long ID 등)
//   - 소수: 0.10000000000000000555 → 0.1, 1.0 → 1
//   - 이스케이프: "<" → "<", "\/" → "/"
// 여기서는 값을 해석하지 않고 토큰 원문을 그대로 둔 채 공백만 다시 넣는다.
// 결과 모양은 JSON.stringify(value, null, 2) 와 같다 (빈 {} [] 는 한 줄, 콜론 뒤 공백 하나).

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
// 숫자·리터럴 토큰이 끝나는 문자: 공백, , : { } [ ] "
const isDelim = (c) => isWs(c) || c === 44 || c === 58 || c === 123 || c === 125 || c === 91 || c === 93 || c === 34;

/** 문자열 토큰 끝(닫는 따옴표 다음 위치) */
function stringEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) j += 2; // 백슬래시 이스케이프
    else if (c === 34) return j + 1;
    else j++;
  }
  return n;
}

/**
 * JSON 텍스트를 들여쓰기해 돌려준다. 숫자·문자열은 원문 그대로 유지한다.
 * 올바른 JSON 이 아니면 JSON.parse 와 같은 SyntaxError 를 던진다.
 */
export function formatJson(text, indent = 2) {
  const src = String(text);
  JSON.parse(src); // 형식 검사만 (결과 값은 쓰지 않음)
  const pad = typeof indent === 'number' ? ' '.repeat(indent) : String(indent);
  const out = [];
  const n = src.length;
  let depth = 0;
  let i = 0;
  const nl = () => '\n' + pad.repeat(depth);
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isWs(c)) {
      i++;
    } else if (c === 34) {
      const j = stringEnd(src, i);
      out.push(src.slice(i, j));
      i = j;
    } else if (c === 123 || c === 91) {
      // { 또는 [ — 비어 있으면 {} / [] 로 붙여 쓴다
      let j = i + 1;
      while (j < n && isWs(src.charCodeAt(j))) j++;
      const close = c === 123 ? 125 : 93;
      if (src.charCodeAt(j) === close) {
        out.push(src[i] + src[j]);
        i = j + 1;
      } else {
        depth++;
        out.push(src[i] + nl());
        i++;
      }
    } else if (c === 125 || c === 93) {
      depth--;
      out.push(nl() + src[i]);
      i++;
    } else if (c === 44) {
      out.push(',' + nl());
      i++;
    } else if (c === 58) {
      out.push(': ');
      i++;
    } else {
      let j = i + 1;
      while (j < n && !isDelim(src.charCodeAt(j))) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out.join('');
}

// 숫자 원문 → 부호 + 유효 숫자 + 지수 (1.50 · 1.5 · 15e-1 은 같은 값으로 본다)
function numKey(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', exp = '0'] = m;
  let digits = int + frac;
  let e = parseInt(exp, 10) + int.length;
  const lead = /^0*/.exec(digits)[0].length;
  digits = digits.slice(lead).replace(/0+$/, '');
  e -= lead;
  if (!digits) return '0';
  return sign + digits + 'e' + e;
}

/** JavaScript 숫자(double)로 바꾸면 값이 달라지는 숫자 원문인지 */
export function isLossyNumber(tok) {
  const n = Number(tok);
  if (!Number.isFinite(n)) return true;
  return numKey(String(tok)) !== numKey(String(n));
}

/** JSON 텍스트 안에 JSON.parse 로 읽으면 값이 바뀌는 숫자가 있는지 (예: 19자리 ID) */
export function hasLossyNumbers(text) {
  const src = String(text);
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 34) {
      i = stringEnd(src, i);
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i + 1;
      while (j < n && !isDelim(src.charCodeAt(j))) j++;
      if (isLossyNumber(src.slice(i, j))) return true;
      i = j;
    } else {
      i++;
    }
  }
  return false;
}
