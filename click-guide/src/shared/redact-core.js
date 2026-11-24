/* 공용 가리기 코어 — CleanShot Picker 와 ClickGuide 가 함께 쓴다.
 *
 * 원본은 저장소 최상위 shared/redact-core.js 하나뿐이다. 확장 폴더의 사본
 * (cleanshot-picker/shared/, click-guide/src/shared/)은 `node scripts/sync-shared.mjs` 로 만든다.
 * 사본을 직접 고치지 말 것 — npm test 가 원본과 다른 사본을 찾아낸다.
 * 확장은 빌드 없이 폴더째 로드하므로 사본도 저장소에 함께 둔다.
 *
 * export 없이 globalThis.RedactCore 하나만 만든다. 그래서 일반 스크립트(콘텐츠 스크립트,
 * importScripts)로도 ES 모듈(import '…/redact-core.js')로도 불러올 수 있다.
 * 확장마다 따로 도는 격리된 환경(isolated world)과 워커에 생기므로 페이지 스크립트는 보지 못한다.
 *
 *   1. 개인정보 패턴   findPII(text) — 주민·외국인등록번호, 카드번호(Luhn 검사), 사업자등록번호(검증 숫자),
 *                      휴대폰 번호, 이메일, 계좌번호(주변에 '계좌'·'은행' 같은 말이 있을 때만)
 *   2. 사각형 계산     intersect, hull, toPixelRects
 *   3. 그리기          paintRedactions — 검정 칠하기(기본) 또는 흐리게
 *   4. 화면 위치(DOM)  visibleRect — 요소가 실제로 보이는 부분(스크롤 영역·iframe 화면 밖은 뺌)
 *                      queryAllDeep — shadow root 안까지 선택자로 찾기
 *                      piiTargets / targetRects — 화면 글자와 입력값 속 개인정보의 위치
 */
(() => {
  'use strict';

  /* ================================================================ 1. 개인정보 패턴 */

  /* 겹치면 앞에 있는 종류가 이긴다 (예: 13자리 숫자가 주민번호이면서 계좌 모양이어도 주민번호) */
  const PII_TYPES = Object.freeze(['rrn', 'card', 'brn', 'phone', 'account', 'email']);
  const PII_LABELS = Object.freeze({
    rrn: '주민·외국인등록번호',
    card: '카드번호',
    brn: '사업자등록번호',
    phone: '휴대폰 번호',
    account: '계좌번호',
    email: '이메일'
  });

  /* 주민등록번호·외국인등록번호: 앞 6자리가 실제 날짜이고 뒷자리 첫 숫자가 1~8.
     2020년 10월부터 새로 주는 번호는 마지막 검증 숫자 규칙을 따르지 않으므로 검증 숫자는 보지 않는다.
     뒷자리를 가린 형태(900101-1******)도 생년월일·성별이 드러나므로 잡는다(이때는 '-' 가 있어야 함). */
  const RRN_RE = /(?<![\d-])(\d{2})(\d{2})(\d{2})([- ]?)([1-8])(\d{6}|[*●•xX]{6})(?!\d)/g;
  const MASKED_TAIL = /[*●•xX]{6}/;

  /* 카드번호: 흔히 보이는 묶음(4-4-4-4, 4-4-4-4-3, 4-6-5, 4-6-4)과 붙여 쓴 14~16자리. Luhn 검사를 통과해야 한다 */
  const CARD_RES = [
    /(?<![\d-])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?(?![\d-])/g,
    /(?<![\d-])\d{4}([ -])\d{6}\1\d{4,5}(?![\d-])/g,
    /(?<![\d-])\d{14,16}(?![\d-])/g
  ];

  /* 사업자등록번호: 000-00-00000 모양만 (붙여 쓴 10자리는 열 개 중 하나가 우연히 검증을 통과해 잘못 잡기 쉽다) */
  const BRN_RE = /(?<![\d-])\d{3}-\d{2}-\d{5}(?![\d-])/g;

  /* 휴대폰: 010·011·016~019, +82 형식. 구분자(공백·'-'·'.')는 앞뒤가 같아야 한다. 일반 전화(02-…)는 뺀다 */
  const PHONE_RE = /(?<![\d+])(?:\+82[ -]?(?:\(0\))?1[016789]|01[016789])([ .-]?)\d{3,4}\1\d{4}(?!\d)/g;

  const EMAIL_RE = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])/g;

  /* 계좌번호는 은행마다 모양이 달라 숫자만으로는 주문번호·문서번호와 구별할 수 없다.
     숫자 10~14자리(묶음 2~5개 또는 붙여 씀)이면서, 같은 글이나 주변(context)에 아래 말이 있을 때만 잡는다. */
  const ACCOUNT_RE = /(?<![\d-])\d{2,6}(?:-\d{2,7}){1,4}(?![\d-])|(?<![\d-])\d{10,14}(?![\d-])/g;
  const ACCOUNT_HINT = /계좌|입금|출금|송금|이체|예금|적금|은행|뱅크|금고|신협|농협|수협|우체국|증권|bank|account|acct|a\/c/i;

  const digitsOf = (s) => String(s).replace(/\D/g, '');

  /* 숫자가 min 개 이상인지 (세다가 다 차면 멈춘다) */
  function hasDigits(s, min) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57 && ++n >= min) return true;
    }
    return false;
  }

  function luhnValid(digits) {
    const d = digitsOf(digits);
    if (d.length < 12) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = d.charCodeAt(d.length - 1 - i) - 48;
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  /* 국세청 사업자등록번호 검증: 가중치 1,3,7,1,3,7,1,3,5 */
  function brnValid(digits) {
    const d = digitsOf(digits);
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (d.charCodeAt(i) - 48) * w[i];
    sum += Math.floor(((d.charCodeAt(8) - 48) * 5) / 10);
    return (10 - (sum % 10)) % 10 === d.charCodeAt(9) - 48;
  }

  /* 앞 6자리 생년월일과 성별 숫자(1·2·5·6 은 1900년대, 3·4·7·8 은 2000년대)가 말이 되는지 */
  function rrnDateValid(yymmdd, genderDigit) {
    const s = digitsOf(yymmdd);
    if (s.length !== 6) return false;
    const g = Number(genderDigit);
    if (!(g >= 1 && g <= 8)) return false;
    const yy = Number(s.slice(0, 2));
    const mm = Number(s.slice(2, 4));
    const dd = Number(s.slice(4, 6));
    if (mm < 1 || mm > 12 || dd < 1) return false;
    const year = (g === 3 || g === 4 || g === 7 || g === 8 ? 2000 : 1900) + yy;
    return dd <= new Date(Date.UTC(year, mm, 0)).getUTCDate();
  }

  function scan(re, text, fn) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      fn(m);
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  /* 개인정보가 들어 있을 수 있는 글인지 빠르게 본다.
     숫자로 된 종류는 모두 10자리 이상이고, 뒷자리를 가린 주민번호만 7자리 + 가림 문자 6개다. 이메일은 '@' 를 품는다.
     날짜·금액처럼 화면에 흔한 숫자는 여기서 걸러져 정규식을 돌리지 않는다(큰 표에서 클릭이 굼떠지지 않게). */
  function mayHavePII(text) {
    return text.includes('@') || hasDigits(text, 10) || (hasDigits(text, 7) && MASKED_TAIL.test(text));
  }

  /**
   * 글 속 개인정보를 찾는다. 겹치는 후보는 PII_TYPES 순서가 앞인 것, 같으면 긴 것을 남긴다.
   * @param {string} text
   * @param {{ types?: string[], context?: string | (() => string) }} [opts]
   *   context: 계좌번호를 가릴 때 함께 볼 주변 글(표의 머리글, 입력칸 이름 등). 함수면 필요할 때만 부른다.
   * @returns {{ type: string, start: number, end: number, text: string }[]} 시작 위치 순서
   */
  function findPII(text, opts = {}) {
    if (typeof text !== 'string' || !text || !mayHavePII(text)) return [];
    const want = new Set(Array.isArray(opts.types) && opts.types.length ? opts.types : PII_TYPES);
    const cands = [];
    const add = (type, start, end) => cands.push({ type, start, end, prio: PII_TYPES.indexOf(type) });

    if (want.has('rrn')) {
      scan(RRN_RE, text, (m) => {
        const masked = !/\d/.test(m[6]);
        if (masked && m[4] !== '-') return;
        if (rrnDateValid(m[1] + m[2] + m[3], m[5])) add('rrn', m.index, m.index + m[0].length);
      });
    }
    if (want.has('card')) {
      for (const re of CARD_RES) {
        scan(re, text, (m) => { if (luhnValid(m[0])) add('card', m.index, m.index + m[0].length); });
      }
    }
    if (want.has('brn')) {
      scan(BRN_RE, text, (m) => { if (brnValid(m[0])) add('brn', m.index, m.index + m[0].length); });
    }
    if (want.has('phone')) {
      scan(PHONE_RE, text, (m) => add('phone', m.index, m.index + m[0].length));
    }
    if (want.has('email') && text.includes('@')) {
      scan(EMAIL_RE, text, (m) => add('email', m.index, m.index + m[0].length));
    }
    if (want.has('account')) {
      let hinted = null; // 글 자체나 주변에 계좌를 뜻하는 말이 있는지 (필요할 때 한 번만 본다)
      const hasHint = () => {
        if (hinted === null) {
          let ctx = '';
          try { ctx = typeof opts.context === 'function' ? opts.context() : (opts.context || ''); } catch (_) { ctx = ''; }
          hinted = ACCOUNT_HINT.test(text) || ACCOUNT_HINT.test(String(ctx || ''));
        }
        return hinted;
      };
      scan(ACCOUNT_RE, text, (m) => {
        const s = m.index;
        const e = s + m[0].length;
        // 이미 앞선 종류(휴대폰·주민번호 등)로 잡힌 자리는 계좌 여부를 따지지 않는다 — 어차피 그 종류가 이기고,
        // 주변 글을 모으는 비용(hasHint)을 아낀다.
        if (cands.some((c) => s < c.end && c.start < e)) return;
        const n = digitsOf(m[0]).length;
        if (n >= 10 && n <= 14 && hasHint()) add('account', s, e);
      });
    }

    cands.sort((a, b) => a.prio - b.prio || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept = [];
    for (const c of cands) {
      if (kept.some((k) => c.start < k.end && k.start < c.end)) continue;
      kept.push(c);
    }
    kept.sort((a, b) => a.start - b.start);
    return kept.map((c) => ({ type: c.type, start: c.start, end: c.end, text: text.slice(c.start, c.end) }));
  }

  /* ================================================================ 2. 사각형 계산 */

  /* {x,y,w,h} 와 {x,y,width,height} 를 모두 받아 {x,y,w,h} 로. 숫자가 온전하지 않으면 null */
  function rectFrom(r) {
    if (!r) return null;
    const w = r.w !== undefined ? r.w : r.width;
    const h = r.h !== undefined ? r.h : r.height;
    if (![r.x, r.y, w, h].every(Number.isFinite)) return null;
    return { x: r.x, y: r.y, w, h };
  }

  /* 두 사각형의 겹친 부분. cx·cy 가 false 면 그 축은 자르지 않는다 */
  function intersect(a, b, cx = true, cy = true) {
    let x0 = a.x, y0 = a.y, x1 = a.x + a.w, y1 = a.y + a.h;
    if (cx) { x0 = Math.max(x0, b.x); x1 = Math.min(x1, b.x + b.w); }
    if (cy) { y0 = Math.max(y0, b.y); y1 = Math.min(y1, b.y + b.h); }
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 두 사각형을 모두 덮는 가장 작은 사각형 */
  function hull(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w);
    const y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * 화면 좌표(CSS px) 사각형을 이미지 픽셀 사각형으로. 경계는 바깥쪽으로 반올림해 반 픽셀도 덜 가리지 않고,
   * 이미지 밖은 잘라 낸다. 숫자가 온전하지 않거나 넓이가 없는 것은 버린다.
   * @param {object[]} rects  {x,y,w,h} 또는 {x,y,width,height}
   * @param {number} sx  가로 배율(이미지 픽셀 ÷ CSS px)
   * @param {number} sy  세로 배율
   * @returns {{x:number,y:number,w:number,h:number}[]} 정수 좌표
   */
  function toPixelRects(rects, sx, sy, imgW, imgH) {
    const out = [];
    if (!Array.isArray(rects) || !(sx > 0) || !(sy > 0) || !(imgW > 0) || !(imgH > 0)) return out;
    for (const raw of rects) {
      const m = rectFrom(raw);
      if (!m || m.w <= 0 || m.h <= 0) continue;
      const x0 = Math.max(0, Math.floor(m.x * sx));
      const y0 = Math.max(0, Math.floor(m.y * sy));
      const x1 = Math.min(imgW, Math.ceil((m.x + m.w) * sx));
      const y1 = Math.min(imgH, Math.ceil((m.y + m.h) * sy));
      if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return out;
  }

  /* ================================================================ 3. 그리기 */

  /**
   * 캔버스에 그려 둔 이미지 위에 가리기를 칠한다.
   * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
   * @param {{x,y,w,h}[]} rects  이미지 픽셀 좌표 (toPixelRects 결과)
   * @param {{ style?: 'box'|'blur', color?: string, source?: CanvasImageSource, width?: number, height?: number, blurPx?: number }} [opts]
   *   style 'box'(기본): 단색 사각형. 'blur': source 를 width×height 로 흐리게 그린 사본에서 그 부분만 옮겨 온다.
   *   흐리게는 숫자로 된 정보(계좌·주민번호)를 복원하는 공격에 약하므로 기본은 검정 칠하기다.
   */
  function paintRedactions(ctx, rects, opts = {}) {
    if (!ctx || !Array.isArray(rects) || !rects.length) return;
    if (opts.style === 'blur' && opts.source && opts.width > 0 && opts.height > 0) {
      const blurred = new OffscreenCanvas(opts.width, opts.height);
      const b = blurred.getContext('2d');
      b.filter = `blur(${opts.blurPx > 0 ? opts.blurPx : 14}px)`;
      b.drawImage(opts.source, 0, 0, opts.width, opts.height);
      for (const r of rects) ctx.drawImage(blurred, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      return;
    }
    ctx.save();
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = opts.color || '#000';
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /* ================================================================ 4. 화면 위치 (DOM)
   * 콘텐츠 스크립트에서만 쓴다. 좌표는 이 스크립트가 도는 문서(최상위 문서)의 화면 CSS px 이다.
   * 같은 출처 iframe 안 요소는 그 iframe 의 위치만큼 옮겨 이 문서 좌표로 돌려준다.
   * 다른 출처 iframe 은 닿을 수 없으므로, 그 안에서 도는 스크립트가 따로 재서 올려 보내야 한다(ClickGuide). */

  function topDocument() {
    return globalThis.document || null;
  }

  function styleOf(el) {
    const v = el.ownerDocument && el.ownerDocument.defaultView;
    return (v || globalThis).getComputedStyle(el);
  }

  /* shadow root 의 맨 위 요소는 parentElement 가 없다. 그 위는 호스트다. */
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const r = el.parentNode;
    return r && r.nodeType === 11 && r.host ? r.host : null;
  }

  /* 문서 doc 를 품은 iframe 요소. 이 스크립트의 문서이거나 다른 출처라 닿을 수 없으면 null */
  function frameOf(doc) {
    try {
      return (doc && doc !== topDocument() && doc.defaultView && doc.defaultView.frameElement) || null;
    } catch (_) {
      return null;
    }
  }

  /* iframe 의 내용 영역 — 안쪽 문서의 화면 — 을 iframe 이 속한 문서의 화면 좌표로 */
  function contentBox(f) {
    const r = f.getBoundingClientRect();
    const cs = styleOf(f);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    return {
      x: r.left + f.clientLeft + pl,
      y: r.top + f.clientTop + pt,
      w: Math.max(0, f.clientWidth - pl - pr),
      h: Math.max(0, f.clientHeight - pt - pb)
    };
  }

  /* 문서 doc 의 화면 원점이 이 스크립트 문서의 화면 좌표로 어디인지 */
  function docOffset(doc) {
    let x = 0;
    let y = 0;
    for (let d = doc, i = 0; d && d !== topDocument() && i < 16; i++) {
      const f = frameOf(d);
      if (!f) break;
      const b = contentBox(f);
      x += b.x;
      y += b.y;
      d = f.ownerDocument;
    }
    return { x, y };
  }

  function viewSize(doc) {
    const e = doc.compatMode === 'BackCompat' ? doc.body : doc.documentElement;
    const w = e ? e.clientWidth : 0;
    const h = e ? e.clientHeight : 0;
    const v = doc.defaultView;
    return { w: w || (v ? v.innerWidth : 0), h: h || (v ? v.innerHeight : 0) };
  }

  /* 요소의 테두리 상자를 이 스크립트 문서의 화면 좌표로 */
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    const o = docOffset(el.ownerDocument);
    return { x: r.left + o.x, y: r.top + o.y, w: r.width, h: r.height };
  }

  /* box 를 실제로 보이는 부분만 남게 자른다.
     el 의 조상 중 overflow 가 visible 이 아닌 것과, 문서마다 그 화면(iframe 내용 영역)으로 자른다.
     position 이 fixed·absolute 인 것을 만나면 그 위 조상은 따지지 않는다.
     어느 조상이 정말 자르는지 확실하지 않을 때는 자르지 않는다 — 덜 가리는 쪽으로 틀리면 안 된다. */
  function clipVisible(el, doc, box) {
    let r = box;
    let cur = el;
    let d = doc;
    for (let hop = 0; d && hop < 16; hop++) {
      const off = docOffset(d);
      if (cur) {
        const htmlClips = styleOf(d.documentElement).overflowX !== 'visible' ||
          styleOf(d.documentElement).overflowY !== 'visible';
        let pos = styleOf(cur).position;
        let p = parentOf(cur);
        while (p && p !== d.documentElement) {
          if (pos === 'fixed' || pos === 'absolute') break;
          const cs = styleOf(p);
          const hasBox = cs.display !== 'inline' && cs.display !== 'contents';
          // body 의 overflow 는 html 이 visible 이면 화면으로 넘어가고 body 자신은 자르지 않는다
          const passes = p === d.body && !htmlClips;
          if (hasBox && !passes) {
            const cx = cs.overflowX !== 'visible';
            const cy = cs.overflowY !== 'visible';
            if (cx || cy) {
              const pr = p.getBoundingClientRect();
              r = intersect(r, {
                x: pr.left + p.clientLeft + off.x,
                y: pr.top + p.clientTop + off.y,
                w: p.clientWidth,
                h: p.clientHeight
              }, cx, cy);
              if (!r) return null;
            }
          }
          if (cs.display !== 'contents') pos = cs.position;
          p = parentOf(p);
        }
      }
      const vs = viewSize(d);
      r = intersect(r, { x: off.x, y: off.y, w: vs.w, h: vs.h }, true, true);
      if (!r) return null;
      const f = frameOf(d);
      if (!f) break;
      cur = f;
      d = f.ownerDocument;
    }
    return r;
  }

  /* 요소가 지금 화면에 보이는 부분. pad 만큼 사방을 넓혀 잰다. 안 보이면 null */
  function visibleRect(el, pad = 0) {
    if (!el || !el.isConnected || !el.ownerDocument || !el.ownerDocument.defaultView) return null;
    const r = rectOf(el);
    if (!(r.w > 0 && r.h > 0)) return null;
    const box = pad > 0 ? { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 } : r;
    return clipVisible(el, el.ownerDocument, box);
  }

  /* 열린 shadow root, 그리고 콘텐츠 스크립트라면 사용자 정의 요소(이름에 '-')의 닫힌 shadow root 도.
     chrome.dom.openOrClosedShadowRoot 는 한 번에 몇 µs 라 요소 수만 개에 모두 부르면 클릭이 눈에 띄게 굼떠진다.
     페이지 내용의 닫힌 shadow root 는 대개 웹 컴포넌트(사용자 정의 요소)에 붙으므로 그것만 연다. */
  const closedRootApi = (() => {
    try {
      const d = globalThis.chrome && globalThis.chrome.dom;
      return d && typeof d.openOrClosedShadowRoot === 'function' ? d.openOrClosedShadowRoot.bind(d) : null;
    } catch (_) {
      return null;
    }
  })();

  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!closedRootApi || el.localName.indexOf('-') < 0) return null;
    try {
      return closedRootApi(el) || null;
    } catch (_) {
      return null;
    }
  }

  function nodeFilterOf(doc) {
    return (doc.defaultView && doc.defaultView.NodeFilter) || globalThis.NodeFilter;
  }

  /* TreeWalker 를 지금 노드의 안쪽을 건너뛰고 그다음 노드로 옮긴다. 끝이면 null.
     거르는 함수(acceptNode)를 쓰면 노드마다 JS 를 불러 큰 페이지에서 몇 배 느려서, 거르기는 직접 한다. */
  function skipSubtree(tw) {
    for (;;) {
      const s = tw.nextSibling();
      if (s) return s;
      if (!tw.parentNode()) return null;
    }
  }

  /* root 안의 shadow root 들(안쪽에 겹친 것까지). skip 이 true 를 돌려주는 요소 안쪽은 보지 않는다. */
  function shadowRoots(root, opts = {}) {
    const out = [];
    const skip = typeof opts.skip === 'function' ? opts.skip : null;
    const visit = (r, depth) => {
      if (depth > 16) return;
      const doc = r.nodeType === 9 ? r : r.ownerDocument;
      const tw = doc.createTreeWalker(r, nodeFilterOf(doc).SHOW_ELEMENT);
      let n = tw.nextNode();
      while (n) {
        if (skip && skip(n)) { n = skipSubtree(tw); continue; }
        const sr = shadowRootOf(n);
        if (sr) { out.push(sr); visit(sr, depth + 1); }
        n = tw.nextNode();
      }
    };
    visit(root, 0);
    return out;
  }

  /**
   * 선택자에 맞는 요소를 문서와 그 안의 shadow root 들까지 모두 찾는다(document.querySelectorAll 은 shadow root 안을 못 본다).
   * 선택자가 잘못되면 예외를 그대로 던진다.
   */
  function queryAllDeep(root, selector, opts = {}) {
    const out = [...root.querySelectorAll(selector)];
    for (const sr of shadowRoots(root, opts)) out.push(...sr.querySelectorAll(selector));
    return out;
  }

  /* ---- 화면 글자와 입력값 속 개인정보 ---- */

  const SKIP_TAGS = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED']);
  const TEXT_INPUT = /^(|text|search|tel|email|url|number)$/;
  const TEXT_PAD = 1;  // 글자 가장자리의 번짐까지 덮는다

  /* el 안의 글을 max 자까지만 모은다. 넘으면 null.
     textContent 는 큰 표의 <tbody> 처럼 글이 많은 요소에서 전부를 이어 붙여 느리므로 쓰지 않는다. */
  function boundedText(el, max) {
    const doc = el.ownerDocument;
    const tw = doc.createTreeWalker(el, nodeFilterOf(doc).SHOW_TEXT);
    let text = '';
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      text += n.data;
      if (text.length > max) return null;
    }
    return text;
  }

  /* 표의 머리글처럼 옆 칸에 있는 '계좌' 같은 말까지 보려고, 위로 세 단계까지의 글을 모은다.
     글이 200자를 넘는 조상에서 멈춘다 — 표 전체나 페이지 전체의 글까지 보면 다른 줄의 '계좌' 때문에
     주문번호 같은 숫자까지 계좌로 잡힌다. */
  function nearbyText(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    let text = '';
    for (let i = 0; el && i < 3; i++, el = parentOf(el)) {
      const t = boundedText(el, 200);
      if (t === null) break;
      text = t;
    }
    return text;
  }

  function fieldText(el) {
    const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')];
    try { if (el.labels) for (const l of el.labels) parts.push(l.textContent); } catch (_) { /* noop */ }
    return parts.filter(Boolean).join(' ');
  }

  function fieldValue(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return TEXT_INPUT.test(type) ? String(el.value || '') : '';
    }
    if (tag === 'TEXTAREA') return String(el.value || '');
    if (tag === 'SELECT') {
      const o = el.options && el.options[el.selectedIndex];
      return o ? String(o.textContent || '') : '';
    }
    return '';
  }

  /**
   * root(문서·요소·shadow root) 안에서 개인정보가 보이는 곳을 찾는다.
   * 글자는 그 부분만({ range }), 입력칸은 칸 전체({ el })를 가릴 대상으로 돌려준다.
   * shadow root 안까지 보고(shadowRootOf), iframe 안 문서는 보지 않는다(그 문서의 스크립트가 따로 본다).
   * @param {{ types?: string[], skip?: (el: Element) => boolean, limit?: number, maxNodes?: number,
   *           onRoot?: (root: Document|ShadowRoot|Element) => void }} [opts]
   *   skip: true 를 돌려주는 요소와 그 안쪽은 건너뛴다(확장 자신의 화면 등).
   *   onRoot: 훑는 뿌리(처음 root 와 지나는 shadow root 마다)를 알려 준다. 같은 김에 선택자로도 찾으라고 —
   *           따로 한 번 더 훑으면 큰 페이지에서 시간이 두 배로 든다. limit 에 닿아도 훑기는 끝까지 한다.
   * @returns {{ type: string, el: Element, range?: Range }[]}
   */
  function piiTargets(root, opts = {}) {
    const doc = root && (root.nodeType === 9 ? root : root.ownerDocument);
    if (!doc || !doc.createTreeWalker) return [];
    // 문서면 <html> 부터 본다. 스크립트가 <body> 밖(<html> 바로 아래)에 붙인 요소도 있기 때문이다.
    const start = root.nodeType === 9 ? (root.documentElement || root.body) : root;
    if (!start) return [];
    const limit = opts.limit > 0 ? opts.limit : 300;
    const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : 50000;
    const skip = typeof opts.skip === 'function' ? opts.skip : null;
    const onRoot = typeof opts.onRoot === 'function' ? opts.onRoot : null;
    const types = opts.types;
    const NF = nodeFilterOf(doc);
    const out = [];
    let seen = 0;

    const checkField = (el) => {
      if (out.length >= limit) return;
      const v = fieldValue(el);
      if (!v || !/[\d@]/.test(v)) return;
      const hit = findPII(v, { types, context: () => fieldText(el) + ' ' + nearbyText(el) });
      if (hit.length) out.push({ type: hit[0].type, el });
    };

    const walk = (top, depth) => {
      if (onRoot) onRoot(top);
      const tw = doc.createTreeWalker(top, NF.SHOW_ELEMENT | NF.SHOW_TEXT);
      let n = tw.currentNode;
      while (n && seen < maxNodes) {
        seen++;
        if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') checkField(n);
          if (n !== top && (SKIP_TAGS.has(tag) || (skip && skip(n)))) { n = skipSubtree(tw); continue; }
          const sr = depth < 16 ? shadowRootOf(n) : null;
          if (sr) walk(sr, depth + 1);
        } else if (n.nodeType === 3 && n.length >= 6 && out.length < limit) {
          // 짧은 글은 문자열을 읽지 않고 넘긴다. 읽은 뒤에도 개인정보가 있을 수 없는 글은 findPII 를 부르지 않는다.
          const text = n.data;
          if (mayHavePII(text) && n.parentElement) {
            for (const m of findPII(text, { types, context: () => nearbyText(n) })) {
              const range = doc.createRange();
              range.setStart(n, m.start);
              range.setEnd(n, m.end);
              out.push({ type: m.type, el: n.parentElement, range });
              if (out.length >= limit) break;
            }
          }
        }
        n = tw.nextNode();
      }
    };

    if (skip && start.nodeType === 1 && skip(start)) return out;
    walk(start, 0);
    return out;
  }

  /* 가릴 대상 하나가 지금 화면에 보이는 사각형들(줄이 바뀐 글자는 여러 개). 안 보이면 빈 배열 */
  function targetRects(t, pad) {
    if (!t) return [];
    if (!t.range) {
      const r = visibleRect(t.el, pad > 0 ? pad : 0);
      return r ? [r] : [];
    }
    const el = t.el;
    if (!el || !el.isConnected) return [];
    const doc = el.ownerDocument;
    const o = docOffset(doc);
    const p = pad > 0 ? pad : TEXT_PAD;
    const out = [];
    for (const cr of t.range.getClientRects()) {
      if (!(cr.width > 0 && cr.height > 0)) continue;
      const box = { x: cr.left + o.x - p, y: cr.top + o.y - p, w: cr.width + p * 2, h: cr.height + p * 2 };
      const v = clipVisible(el, doc, box);
      if (v) out.push(v);
    }
    return out;
  }

  /* root 안의 개인정보가 지금 보이는 사각형 전부 (piiTargets + targetRects) */
  function piiRects(root, opts = {}) {
    const out = [];
    for (const t of piiTargets(root, opts)) {
      for (const r of targetRects(t)) out.push({ x: r.x, y: r.y, w: r.w, h: r.h, type: t.type });
    }
    return out;
  }

  globalThis.RedactCore = Object.freeze({
    version: 1,
    PII_TYPES,
    PII_LABELS,
    findPII,
    luhnValid,
    brnValid,
    rrnDateValid,
    rectFrom,
    intersect,
    hull,
    toPixelRects,
    paintRedactions,
    styleOf,
    parentOf,
    frameOf,
    contentBox,
    docOffset,
    viewSize,
    rectOf,
    clipVisible,
    visibleRect,
    shadowRootOf,
    shadowRoots,
    queryAllDeep,
    piiTargets,
    targetRects,
    piiRects
  });
})();
