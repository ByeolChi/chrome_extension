// 규칙 기반 단계 설명 생성기.
// 콘텐츠 스크립트가 수집한 DOM 메타데이터(step.el)만으로 제목/설명 문장을 만든다.
import { placeName } from './util.js';

/* ---------- 한국어 조사 처리 ---------- */

const DIGIT_BATCHIM = { '0': true, '1': true, '3': true, '6': true, '7': true, '8': true, '2': false, '4': false, '5': false, '9': false };
// 받침이 ㄹ인 숫자 읽기 (일, 칠, 팔)
const DIGIT_RIEUL = { '1': true, '7': true, '8': true };
// 영문 알파벳 낱자 읽기에 받침이 있는지 (엘, 엠, 엔, 알 …)
const ALPHA_BATCHIM = { l: true, m: true, n: true, r: true, g: false, b: false, c: false, d: false, e: false, f: false, h: false, i: false, j: false, k: false, o: false, p: false, q: false, s: false, t: false, u: false, v: false, w: false, x: false, y: false, z: false, a: false };
// 받침이 ㄹ인 낱자 읽기 (엘, 알)
const ALPHA_RIEUL = { l: true, r: true };
const JONG_RIEUL = 8;   // 종성 ㄹ의 순번

// 끝 글자의 받침: 'none'(없음) | 'rieul'(ㄹ) | 'other'(그 밖의 받침)
function finalConsonant(word) {
  if (!word) return 'none';
  // 끝의 괄호·따옴표·마침표 등은 발음에 영향이 없으므로 떼어낸다
  const base = String(word).trim().replace(/[^\uac00-\ud7a30-9A-Za-z]+$/, '');
  if (!base) return 'none';
  const ch = base.slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (jong === 0) return 'none';
    return jong === JONG_RIEUL ? 'rieul' : 'other';
  }
  if (/[0-9]/.test(ch)) return DIGIT_BATCHIM[ch] ? (DIGIT_RIEUL[ch] ? 'rieul' : 'other') : 'none';
  if (/[a-zA-Z]/.test(ch)) {
    const c = ch.toLowerCase();
    return ALPHA_BATCHIM[c] ? (ALPHA_RIEUL[c] ? 'rieul' : 'other') : 'none';
  }
  return 'none'; // 기호 등은 받침 없음으로 처리
}

export function hasBatchim(word) {
  return finalConsonant(word) !== 'none';
}

// josa('버튼', '을/를') -> '을'
// '으로/로'는 받침이 ㄹ이면 받침이 없을 때처럼 '로'를 쓴다 (서울로, 7로, Excel로).
export function josa(word, pair) {
  const [withB, withoutB] = pair.split('/');
  const fc = finalConsonant(word);
  if (withB.startsWith('으로')) return fc === 'other' ? withB : withoutB;
  return fc !== 'none' ? withB : withoutB;
}

/* ---------- 요소 역할 이름 ---------- */

const ROLE_KO = {
  button: '버튼', link: '링크', textbox: '입력란', textarea: '입력란', combobox: '드롭다운',
  listbox: '목록', checkbox: '체크박스', radio: '라디오 버튼', file: '파일 선택',
  tab: '탭', menuitem: '메뉴 항목', option: '항목', image: '이미지', heading: '제목',
  row: '행', cell: '칸', slider: '슬라이더', switch: '스위치', element: '영역'
};
const ROLE_EN = {
  button: 'button', link: 'link', textbox: 'field', textarea: 'text area', combobox: 'dropdown',
  listbox: 'list', checkbox: 'checkbox', radio: 'radio button', file: 'file picker',
  tab: 'tab', menuitem: 'menu item', option: 'item', image: 'image', heading: 'heading',
  row: 'row', cell: 'cell', slider: 'slider', switch: 'switch', element: 'area'
};

// 콘텐츠 스크립트가 넘겨준 tag/type/role 로 의미 역할 하나를 고른다.
export function resolveRole(el) {
  if (!el) return 'element';
  const r = (el.role || '').toLowerCase();
  const known = ['button', 'link', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'slider', 'heading'];
  if (known.includes(r)) return r;

  const tag = (el.tag || '').toLowerCase();
  const type = (el.type || '').toLowerCase();

  if (tag === 'a') return el.href ? 'link' : 'button';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'img') return 'image';
  if (tag === 'summary') return 'button';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') {
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return 'element';
}

export function roleName(role, lang) {
  return (lang === 'en' ? ROLE_EN : ROLE_KO)[role] || (lang === 'en' ? 'area' : '영역');
}

/* ---------- 라벨 정리 ---------- */

export function cleanLabel(raw, max = 48) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

function quote(s) { return '‘' + s + '’'; }

// 주소에서 사이트 이름(호스트)만 꺼낸다. 경로·쿼리에는 토큰이나 개인정보가 들어 있을 수 있다.
// 로컬 파일(file://)은 파일 이름만 쓴다. 폴더 경로에는 사용자 이름이 들어 있다.
const hostOf = placeName;

/* ---------- 본체 ---------- */

export function describeStep(step, lang = 'ko') {
  const en = lang === 'en';
  const el = step.el || {};
  const role = resolveRole(el);
  const rn = roleName(role, lang);
  const label = cleanLabel(el.label || '');

  switch (step.type) {
    case 'navigate': {
      // 문장에는 전체 주소를 넣지 않는다. 내보내기는 주소를 숨기는데, 문장에 들어가면 그대로 나간다.
      // 제목이 없는 페이지는 호스트 이름으로 부른다.
      const t = cleanLabel(step.title || hostOf(step.url || ''), 60);
      if (en) return { title: `Open ${t || 'the page'}`, description: `The ${t ? `"${t}" ` : ''}page opens.` };
      return {
        title: `${t || '페이지'}${josa(t || '페이지', '으로/로')} 이동`,
        description: `${t ? quote(t) + ' ' : ''}페이지가 열립니다.`
      };
    }

    case 'input': {
      const target = label ? `${quote(label)} ${rn}` : rn;
      if (step.masked) {
        if (en) return { title: `Fill in ${label || 'the field'}`, description: `Enter your value in the ${label ? `"${label}" ` : ''}field.` };
        return { title: `${label ? quote(label) + ' ' : ''}입력란에 값 입력`, description: `${target}에 값을 입력합니다.` };
      }
      const v = cleanLabel(step.value || '', 60);
      if (en) return { title: `Type into ${label || 'the field'}`, description: `Type "${v}" into the ${label ? `"${label}" ` : ''}field.` };
      return {
        title: `${label ? quote(label) + ' ' : ''}입력란에 값 입력`,
        description: `${target}에 ${quote(v)}${josa(v, '을/를')} 입력합니다.`
      };
    }

    case 'select': {
      const v = cleanLabel(step.value || '', 60);
      const target = label ? `${quote(label)} ${rn}` : rn;
      if (en) return { title: `Choose ${v || 'an option'}`, description: `In the ${label ? `"${label}" ` : ''}dropdown, choose "${v}".` };
      return {
        title: `${label ? quote(label) + ' ' : ''}드롭다운에서 ${quote(v)} 선택`,
        description: `${target}에서 ${quote(v)}${josa(v, '을/를')} 선택합니다.`
      };
    }

    case 'note':
      return { title: step.title || (en ? 'Note' : '메모'), description: step.description || '' };

    case 'click':
    default: {
      if (en) {
        return {
          title: label ? `Click ${label}` : (role === 'element' ? 'Click the highlighted area' : `Click the ${rn}`),
          description: label ? `Click the "${label}" ${rn}.` : `Click the highlighted ${rn === 'area' ? 'area' : rn} on the screen.`
        };
      }
      if (!label) {
        if (role === 'element') {
          return { title: '표시된 영역 클릭', description: '화면에 표시된 영역을 클릭합니다.' };
        }
        return { title: `${rn} 클릭`, description: `화면에 표시된 ${rn}${josa(rn, '을/를')} 클릭합니다.` };
      }
      return {
        title: `${quote(label)} ${rn} 클릭`,
        description: `${quote(label)} ${rn}${josa(rn, '을/를')} 클릭합니다.`
      };
    }
  }
}

// 가이드 전체 제목 후보
export function suggestGuideTitle(steps, lang = 'ko') {
  const first = steps.find((s) => s.type !== 'note');
  const host = hostOf(first && first.url ? first.url : '');
  const last = [...steps].reverse().find((s) => s.type === 'click' && s.el && s.el.label);
  const lastLabel = last ? cleanLabel(last.el.label, 24) : '';
  if (lang === 'en') return `${host || 'Web'} guide${lastLabel ? ` — ${lastLabel}` : ''}`;
  return `${host || '웹'} 사용 가이드${lastLabel ? ` — ${lastLabel}까지` : ''}`;
}
