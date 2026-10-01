// 인증 설정 편집기 (요청/폴더/컬렉션 공용)
import { h, clear } from '../util.js';
import { varInput } from './varinput.js';
import { icon } from './icons.js';

export const AUTH_TYPES = [
  { id: 'inherit', label: 'Inherit auth from parent' },
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
];

/**
 * auth: 편집 대상 객체 (직접 수정)
 * opts: { allowInherit, inheritInfo: () => ({label, from}) | null, onChange }
 */
export function authEditor(auth, opts = {}) {
  const el = h('div.auth');
  const render = () => {
    clear(el);
    const types = AUTH_TYPES.filter((t) => opts.allowInherit || t.id !== 'inherit');
    if (!opts.allowInherit && auth.type === 'inherit') auth.type = 'none';
    const sel = h('select.select', { 'aria-label': 'Auth Type' }, types.map((t) => h('option', { value: t.id, selected: auth.type === t.id }, t.label)));
    sel.addEventListener('change', () => {
      auth.type = sel.value;
      opts.onChange && opts.onChange();
      render();
    });
    const left = h(
      'div.auth-left',
      h('div.field-label', 'Auth Type'),
      sel,
      h('p.auth-help', helpText(auth.type))
    );
    const right = h('div.auth-right');
    const field = (label, obj, key, ph, type = 'text') => {
      const vi = varInput({
        value: obj[key] || '',
        placeholder: ph,
        getScope: opts.getScope,
        onInput: (v) => {
          obj[key] = v;
          opts.onChange && opts.onChange();
        },
      });
      if (type === 'password') {
        vi.el.classList.add('vi-secret');
        const eye = h('button.icon-btn.vi-eye', { title: '보기/숨기기', onclick: () => vi.el.classList.toggle('show') }, icon('eye', 14));
        vi.el.appendChild(eye);
      }
      return h('div.auth-field', h('label.field-label', label), vi.el);
    };
    if (auth.type === 'inherit') {
      const info = opts.inheritInfo ? opts.inheritInfo() : null;
      right.appendChild(
        h('div.auth-empty', info
          ? [h('div', '이 요청은 ', h('b', info.label), ' 인증을 사용합니다.'), h('div.muted', `상속 위치: ${info.from}`)]
          : [h('div', '상위 폴더/컬렉션에 설정된 인증이 없습니다.'), h('div.muted', '저장되지 않은 요청은 인증 없이 전송됩니다.')])
      );
    } else if (auth.type === 'none') {
      right.appendChild(h('div.auth-empty', h('div', '이 요청은 인증을 사용하지 않습니다.')));
    } else if (auth.type === 'bearer') {
      right.appendChild(field('Token', auth.bearer, 'token', 'Token', 'password'));
      right.appendChild(h('div.auth-note', 'Authorization: Bearer <token> 헤더로 전송됩니다.'));
    } else if (auth.type === 'basic') {
      right.appendChild(field('Username', auth.basic, 'username', 'Username'));
      right.appendChild(field('Password', auth.basic, 'password', 'Password', 'password'));
      right.appendChild(h('div.auth-note', 'Authorization: Basic base64(username:password) 헤더로 전송됩니다.'));
    } else if (auth.type === 'apikey') {
      right.appendChild(field('Key', auth.apikey, 'key', 'Key'));
      right.appendChild(field('Value', auth.apikey, 'value', 'Value', 'password'));
      const inSel = h('select.select', h('option', { value: 'header', selected: auth.apikey.in !== 'query' }, 'Header'), h('option', { value: 'query', selected: auth.apikey.in === 'query' }, 'Query Params'));
      inSel.addEventListener('change', () => {
        auth.apikey.in = inSel.value;
        opts.onChange && opts.onChange();
      });
      right.appendChild(h('div.auth-field', h('label.field-label', 'Add to'), inSel));
    }
    el.appendChild(left);
    el.appendChild(right);
  };
  render();
  return { el, render };
}

function helpText(type) {
  switch (type) {
    case 'inherit':
      return '상위 폴더 또는 컬렉션에 설정된 인증 방식을 그대로 사용합니다.';
    case 'none':
      return '인증 헤더를 추가하지 않습니다.';
    case 'bearer':
      return '토큰 값에 {{변수}}를 사용할 수 있습니다. 민감한 값은 환경 변수로 관리하세요.';
    case 'basic':
      return '사용자 이름과 비밀번호를 Base64로 인코딩해 전송합니다.';
    case 'apikey':
      return '지정한 헤더 또는 쿼리 파라미터로 API Key를 전송합니다.';
    default:
      return '';
  }
}

export function authLabel(type) {
  const t = AUTH_TYPES.find((x) => x.id === type);
  return t ? t.label : type;
}
