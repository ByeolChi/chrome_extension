/* CleanShot Picker — 저장 설정 (서비스 워커와 설정 화면이 함께 쓴다)
 *
 * chrome API 를 쓰지 않는 순수 함수만 둔다. 일반 스크립트로 싣고(importScripts·<script>) globalThis.CleanShotSettings 로 쓴다.
 * 설정은 chrome.storage.sync 에 아래 이름으로 둔다 (빈자리 제거 forceRemove·툴바 위치 barTop 은 picker.js 가 다룬다).
 *   outFormat    'png' | 'jpeg' | 'webp'            저장 형식. 클립보드 복사는 늘 PNG
 *   outScale     'device' | '1' | '2'               크기: 화면 그대로(장치 픽셀) / CSS 픽셀의 1배 / 2배
 *   nameTemplate 'cleanshot/{host}-{date}-{time}'   파일 이름 양식. / 로 폴더를 나누고, 끝의 -full·-area 와 확장자는 붙여 준다
 *   askWhere     boolean                            저장할 때마다 위치와 이름 묻기
 *   stamp        boolean                            그림 아래에 페이지 주소와 찍은 시각을 적은 띠
 */

(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    outFormat: 'png',
    outScale: 'device',
    nameTemplate: 'cleanshot/{host}-{date}-{time}',
    askWhere: false,
    stamp: false
  });

  const FORMATS = Object.freeze({
    png: { mime: 'image/png', ext: 'png' },
    jpeg: { mime: 'image/jpeg', ext: 'jpg' },
    webp: { mime: 'image/webp', ext: 'webp' }
  });

  const SCALES = ['device', '1', '2'];
  const TOKENS = ['host', 'title', 'date', 'time'];
  const QUALITY = 0.92;          // JPEG·WebP 품질
  const TEMPLATE_MAX = 200;      // 양식 글자 수 한도
  const SEGMENT_MAX = 80;        // 폴더·파일 이름 한 칸의 글자 수 한도
  const PATH_MAX = 180;          // 다운로드 폴더 아래 경로 전체의 글자 수 한도 (Windows 경로 길이 260자를 넘지 않게)

  /* 저장된 값을 믿을 수 있는 설정으로. 모르는 값은 기본값 */
  function normalize(v) {
    const o = { ...DEFAULTS };
    if (!v || typeof v !== 'object') return o;
    if (Object.prototype.hasOwnProperty.call(FORMATS, v.outFormat)) o.outFormat = v.outFormat;
    if (SCALES.includes(String(v.outScale))) o.outScale = String(v.outScale);
    if (typeof v.nameTemplate === 'string' && v.nameTemplate.trim()) o.nameTemplate = v.nameTemplate.trim().slice(0, TEMPLATE_MAX);
    o.askWhere = v.askWhere === true;
    o.stamp = v.stamp === true;
    return o;
  }

  /* 출력 배율(이미지 픽셀 ÷ CSS px). 화면 그대로면 찍힌 배율 cur */
  function outFactor(scale, cur) {
    if (scale === '1') return 1;
    if (scale === '2') return 2;
    return cur;
  }

  const pad = (n) => String(n).padStart(2, '0');
  // Windows 가 파일 이름에 받지 않는 글자와 제어 문자
  const BAD = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  function hostOf(url) {
    let host = '';
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./, '') || (u.protocol === 'file:' ? 'file' : '');
    } catch (_) { /* 주소가 아니다 */ }
    return host.replace(/[^a-z0-9.-]+/gi, '-').slice(0, 40) || 'page';
  }

  /* 칸에 넣을 값. 폴더를 나누지 못하게 / 도 바꾸고, 공백은 하나로 */
  function tokenValue(s, max) {
    return String(s || '').replace(BAD, '_').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  }

  /* 경로 한 칸: 앞뒤의 공백·점을 떼고(숨김 파일·Windows 가 지우는 끝 점), 예약된 이름(CON, NUL…)을 피한다 */
  function segment(s) {
    let t = String(s).replace(BAD, '_').replace(/^[\s.]+|[\s.]+$/g, '');
    t = t.slice(0, SEGMENT_MAX).replace(/[\s.]+$/g, '');
    if (RESERVED.test(t)) t = '_' + t;
    return t;
  }

  /* 양식의 칸을 채운다. 쓴 값과 모르는 칸 이름을 함께 돌려준다 */
  function fillTemplate(template, info) {
    const at = info.at instanceof Date ? info.at : new Date();
    const values = {
      host: hostOf(info.url),
      title: tokenValue(info.title, 60) || 'untitled',
      date: `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
      time: `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    };
    const unknown = [];
    const text = String(template).replace(/\{([^{}]*)\}/g, (m, k) => {
      if (Object.prototype.hasOwnProperty.call(values, k)) return values[k];
      if (!unknown.includes(k)) unknown.push(k);
      return m;
    });
    return { text, unknown };
  }

  /* 파일 이름(다운로드 폴더 기준 상대 경로).
     info: { url, title, at: Date, suffix: '' | '-full' | '-area', ext: 'png' | 'jpg' | 'webp' }
     양식이 비거나 쓸 수 없는 이름이 되면 기본 양식을 쓴다. */
  function fileName(template, info) {
    const tpl = typeof template === 'string' && template.trim() ? template.trim().slice(0, TEMPLATE_MAX) : DEFAULTS.nameTemplate;
    const parts = fillTemplate(tpl, info).text
      .split(/[\\/]+/)
      .map(segment)
      .filter((p) => p !== '');
    if (!parts.length) return tpl === DEFAULTS.nameTemplate ? `page${info.suffix || ''}.${info.ext || 'png'}` : fileName(DEFAULTS.nameTemplate, info);
    let path = parts.join('/');
    if (path.length > PATH_MAX) path = path.slice(0, PATH_MAX).replace(/[\s./]+$/g, '');
    return `${path}${info.suffix || ''}.${info.ext || 'png'}`;
  }

  /* 띠에 적을 주소와 시각.
     주소는 ? 뒤(검색어)와 # 뒤를 뺀다 — 로그인 토큰·개인정보가 자주 들어간다. 로컬 파일은 폴더 경로 없이 파일 이름만.
     시각은 이 컴퓨터의 시간대로, 시간대를 함께 적는다. */
  function stampText(url, at) {
    let shown = String(url || '');
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') {
        const name = u.pathname.split('/').filter(Boolean).pop() || '';
        shown = 'file:///…/' + name;
      } else {
        shown = u.origin + u.pathname;
      }
      try { shown = decodeURI(shown); } catch (_) { /* 잘못 인코딩된 주소는 그대로 */ }
    } catch (_) { /* 주소가 아니면 그대로 */ }
    const d = at instanceof Date ? at : new Date();
    const off = -d.getTimezoneOffset();
    const tz = `UTC${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tz})`;
    return { url: shown, when };
  }

  globalThis.CleanShotSettings = Object.freeze({
    DEFAULTS, FORMATS, SCALES, TOKENS, QUALITY,
    normalize, outFactor, hostOf, fillTemplate, fileName, stampText
  });
})();
