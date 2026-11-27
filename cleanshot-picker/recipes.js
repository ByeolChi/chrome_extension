/* CleanShot Picker — 한 번에 정리와 사이트별 레시피 (피커와 설정 화면이 함께 쓴다)
 *
 * chrome API 와 DOM 을 쓰지 않는 순수 함수와 내장 목록만 둔다. 일반 스크립트로 싣고(피커 주입 목록·<script>)
 * globalThis.CleanShotRecipes 로 쓴다. 페이지에서 요소 정보를 모으고, 선택자를 만들고, 숨기는 일은 picker.js 가 한다.
 *
 * 한 번에 정리 — 쿠키 배너·채팅 버튼·앱 설치 배너·"오늘 하루 보지 않기" 공지 팝업
 *   VENDORS               널리 쓰는 동의 관리·채팅·앱 배너 도구가 만드는 요소의 선택자
 *   classify(f)           떠 있는(fixed·sticky) 요소나 문서 맨 위 띠의 정보 f 로 분류를 정한다 (아니면 null).
 *                         f = { pos, rect, view, docTop, text, plain(링크·단추 밖 글자), textLen, attrs, frames, actions, count }
 *   popupContainer(chain) "오늘 하루 보지 않기" 글에서 위로 올라가며 모은 요소 정보 가운데 팝업 전체를 고른다
 *   isBackdrop(f)         팝업·쿠키 창 뒤에 깔린 반투명 가림막
 *   틀리게 숨기는 것보다 놓치는 쪽을 택한다: 크기·자리·단추 같은 조건을 여럿 겹쳐 본다. 숨긴 것은 한 작업이라 Ctrl+Z 한 번에 돌아온다.
 *
 * 사이트별 레시피 — chrome.storage.local 'recipes' = { [사이트]: { on, cleanup, at, items: [항목] } }
 *   사이트  hostKey(주소): 도메인(포트 포함, 앞의 www. 뺌). 로컬 파일은 모두 'file'
 *   항목    { kind: 'hide'|'mask'|'text', path: [같은 출처 iframe·shadow DOM 주인의 선택자…], sel, label,
 *            remove(hide: 빈자리까지 지웠는지), text(text: 고쳐 쓴 글) }
 *   on      켜면 그 사이트에서 선택 모드를 켤 때 바로 적용한다. cleanup 이면 한 번에 정리도 함께
 *   페이지 글자는 저장하지 않는다. 선택자, 이름표(태그#id.클래스), 사용자가 직접 고쳐 쓴 글만 남는다.
 */

(() => {
  'use strict';

  const KINDS = Object.freeze(['hide', 'mask', 'text']);
  const KIND_LABELS = Object.freeze({ hide: '지우기', mask: '가리기', text: '글 고침' });
  const CATEGORIES = Object.freeze(['cookie', 'chat', 'app', 'popup']);
  const CATEGORY_LABELS = Object.freeze({ cookie: '쿠키 배너', chat: '채팅 버튼', app: '앱 설치 배너', popup: '공지 팝업' });
  /* 저장값 한도: 사이트 수, 사이트마다 항목 수, 선택자 길이, iframe·shadow 단계, 고친 글 길이, 이름표 길이, 사이트 이름 길이 */
  const LIMITS = Object.freeze({ sites: 300, items: 200, sel: 400, path: 6, text: 2000, label: 80, host: 255 });

  /* 내장 목록. 도구가 만든 요소가 있더라도 화면에 보이지 않으면(동의를 이미 했으면) 피커가 건너뛴다. */
  const VENDORS = Object.freeze({
    cookie: Object.freeze([
      '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#ot-sdk-btn-floating',          // OneTrust
      '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',                      // Cookiebot
      '#usercentrics-root',                                                              // Usercentrics
      '#didomi-host',                                                                    // Didomi
      '.qc-cmp2-container',                                                              // Quantcast Choice
      '#truste-consent-track', '#consent_blackbar', '.truste_overlay', '.truste_box_overlay', // TrustArc
      '.cky-consent-container', '.cky-overlay', '#cookie-law-info-bar',                  // CookieYes
      '#cmplz-cookiebanner-container',                                                   // Complianz
      '#iubenda-cs-banner',                                                              // iubenda
      '[id^="sp_message_container_"]',                                                   // Sourcepoint
      '#BorlabsCookieBox',                                                               // Borlabs
      '.cc-window.cc-banner', '.cc-window.cc-floating',                                  // Cookie Consent (Osano 공개판)
      '.osano-cm-window',                                                                // Osano
      '#moove_gdpr_cookie_info_bar',                                                     // GDPR Cookie Compliance
      '#hs-eu-cookie-confirmation',                                                      // HubSpot
      '#cookiescript_injected',                                                          // CookieScript
      '.fc-consent-root',                                                                // Google 개인정보 보호·메시지
      '#axeptio_overlay',                                                                // Axeptio
      '#tarteaucitronRoot',                                                              // tarteaucitron
      '#klaro',                                                                          // Klaro
      '#cookie-notice', '.cookie-notice', '#cookie-banner', '.cookie-banner', '#cookie-consent', '.cookie-consent', '#cookieConsent'
    ]),
    chat: Object.freeze([
      '#ch-plugin',                                                                      // 채널톡
      '#intercom-container', '.intercom-lightweight-app', '#intercom-frame',             // Intercom
      'iframe#launcher', 'iframe#webWidget',                                             // Zendesk
      '#hubspot-messages-iframe-container',                                              // HubSpot
      '#drift-widget-container', '#drift-frame-controller', '#drift-frame-chat',         // Drift
      '.crisp-client',                                                                   // Crisp
      '#chat-widget-container',                                                          // LiveChat
      '#fc_frame',                                                                       // Freshchat
      '#tidio-chat',                                                                     // Tidio
      '.zsiq_floatmain',                                                                 // Zoho SalesIQ
      '#olark-wrapper',                                                                  // Olark
      'iframe[title="chat widget" i]',                                                   // tawk.to
      '#beacon-container',                                                               // Help Scout
      '#gorgias-chat-container',                                                         // Gorgias
      '#smartsupp-widget-container',                                                     // Smartsupp
      'jdiv'                                                                             // JivoChat
    ]),
    app: Object.freeze([
      '.smartbanner', '#smartbanner',                                                    // Smart App Banner 계열
      '#branch-banner-iframe', '#branch-banner'                                          // Branch
    ])
  });

  /* ---------------------------------------------------------------- 판정 */

  const COOKIE_ATTR = /cookie|consent|gdpr|ccpa|(^|[\s_-])cmp([\s_-]|$)/i;
  const COOKIE_WORD = /cookie|쿠키/i;
  const ACTION_WORD = /accept|agree|allow|okay|\bok\b|got it|understood|dismiss|close|reject|decline|deny|refuse|continue|settings|preferences|manage|customi[sz]e|동의|허용|수락|확인|닫기|거부|거절|설정|계속/i;
  const CHAT_WORD = /chat|messenger|livechat|채팅|상담|문의|talk|톡|intercom|zendesk|zopim|tawk|crisp|drift|tidio|channel-?io|ch-plugin|olark|freshchat|salesiq|zsiq|hubspot-messages|jivo|gorgias|smartsupp|happytalk/i;
  const APP_WORD = /(앱|어플)\s*(으로|에서|을|를|로)?\s*(보기|열기|이용|계속|설치|다운|받기|실행)|(open|view|continue|read|use)\s+(it\s+)?in\s+(the\s+)?app\b|\b(get|download|install|try)\s+(the\s+|our\s+)?app\b|\bapp\s+store\b|google\s+play/i;
  const APP_ATTR = /smart-?banner|app-?(banner|download|install|promo)|download-?app|install-?app|open-?(in-?)?app/i;
  const POPUP_WORD = /오늘\s*(하루\s*(동안\s*)?)?(이\s*창(을)?\s*)?(보지|열지|띄우지|표시하지)\s*않(기|음)|(\d+\s*일|일주일|한\s*주)\s*(동안\s*|간\s*)?(보지|열지)\s*않(기|음)|다시\s*(보지|열지)\s*않(기|음)|(don'?t|do\s+not)\s+show\s+(this\s+|it\s+)?(again|today)/i;

  const TOO_MUCH_TEXT = 2000; // 이보다 글자가 많으면 페이지 본문·앱 틀로 본다
  const TOO_MANY_ELS = 500;

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const str = (v) => (typeof v === 'string' ? v : '');

  /** 쿠키 배너·채팅 버튼·앱 설치 배너면 'cookie'·'chat'·'app', 아니면 null */
  function classify(f) {
    if (!f || typeof f !== 'object' || !f.rect || !f.view) return null;
    const r = f.rect;
    const v = f.view;
    if (!(num(r.w) > 0 && num(r.h) > 0 && num(v.w) > 0 && num(v.h) > 0)) return null;
    const len = num(f.textLen);
    if (len > TOO_MUCH_TEXT || num(f.count) > TOO_MANY_ELS) return null;
    const text = str(f.text);
    const plain = str(f.plain);
    const attrs = str(f.attrs);
    const actions = Array.isArray(f.actions) ? f.actions.filter((a) => typeof a === 'string') : [];
    // 쿠키 안내는 링크·단추 밖의 글(문장)이나 동의 관련 이름에 있어야 하고, 동의·닫기 같은 단추가 있어야 한다
    // (메뉴의 "쿠키 설정" 링크, 바닥글의 "쿠키 정책" 링크만 있는 것은 아니다)
    const cookie = (COOKIE_WORD.test(plain) || COOKIE_ATTR.test(attrs)) && actions.some((a) => ACTION_WORD.test(a));
    // 앱 설치 배너는 링크·단추 밖의 글이나 이름에 그 말이 있거나, 단추 하나뿐인데 그 단추가 "앱으로 보기"다.
    // 링크 여럿 가운데 "앱 다운로드"가 끼어 있으면 메뉴다 (로그인·회원가입·앱 다운로드)
    const app = APP_WORD.test(plain) || APP_ATTR.test(attrs) || (actions.length === 1 && APP_WORD.test(actions[0]));

    if (f.pos !== 'fixed' && f.pos !== 'sticky') {
      // 문서 맨 위에서 내용을 밀어내는 띠 (스크롤해도 따라오지 않는 배너)
      const topBand = num(f.docTop) < 160 && r.w >= v.w * 0.8 && r.h <= 200;
      if (!topBand) return null;
      if (cookie && len <= 800) return 'cookie';
      if (app && len <= 160 && actions.length <= 3) return 'app';
      return null;
    }

    const tallNarrow = r.h >= v.h * 0.9 && r.w < v.w * 0.5; // 화면 높이만 한 옆 메뉴
    if (cookie && !tallNarrow) return 'cookie';

    const nearBottom = r.y + r.h >= v.h * 0.6;
    const small = r.w <= v.w * 0.5 && r.h <= v.h * 0.85;
    if (small && nearBottom && len <= 150 &&
        (CHAT_WORD.test(attrs) || CHAT_WORD.test(str(f.frames)) || CHAT_WORD.test(text))) return 'chat';

    const atEdge = r.y <= v.h * 0.25 || r.y + r.h >= v.h * 0.75;
    if (app && r.w >= v.w * 0.4 && atEdge && r.h <= v.h * 0.4 && len <= 160 && actions.length <= 3) return 'app';
    return null;
  }

  function isPopupText(s) {
    return POPUP_WORD.test(str(s));
  }

  /** "오늘 하루 보지 않기" 글을 품은 요소부터 바깥쪽으로 모은 정보(chain[0] 이 가장 안쪽)에서 팝업 전체의 번호. 없으면 -1.
      띄운(fixed, 또는 화면보다 작은 absolute) 조상 가운데 가장 바깥 것을 고르되, 팝업 말고 다른 내용까지 품기 시작하면
      (글이 200자 넘게 늘어나면) 거기서 멈춘다 — 작은 페이지의 본문 틀을 통째로 숨기지 않게. */
  function popupContainer(chain) {
    if (!Array.isArray(chain)) return -1;
    let best = -1;
    let base = 0;
    for (let i = 0; i < chain.length; i++) {
      const f = chain[i];
      if (!f || typeof f !== 'object') break;
      const len = num(f.textLen);
      if (len > TOO_MUCH_TEXT || num(f.count) > TOO_MANY_ELS) break;
      if (best >= 0 && len > base + 200) break;
      const r = f.rect;
      const v = f.view;
      if (!r || !v || !(num(r.w) > 0 && num(r.h) > 0)) continue;
      if (f.pos === 'fixed' || (f.pos === 'absolute' && r.w * r.h < v.w * v.h * 0.95)) {
        best = i;
        base = len;
      }
    }
    return best;
  }

  /** 화면을 다 덮는 글자 없는 반투명 fixed 요소 (팝업·쿠키 창 뒤의 가림막) */
  function isBackdrop(f) {
    if (!f || f.pos !== 'fixed' || !f.rect || !f.view) return false;
    const a = num(f.bgAlpha);
    return f.rect.w >= f.view.w * 0.9 && f.rect.h >= f.view.h * 0.9 &&
      num(f.textLen) === 0 && num(f.count) <= 3 && a > 0.05 && a < 0.98;
  }

  /** 정리 알림: '쿠키 배너 1 · 채팅 버튼 2' */
  function countSummary(counts) {
    if (!counts || typeof counts !== 'object') return '';
    return CATEGORIES.filter((c) => num(counts[c]) > 0).map((c) => `${CATEGORY_LABELS[c]} ${counts[c]}`).join(' · ');
  }

  /* ---------------------------------------------------------------- 선택자에 쓸 이름 고르기
   * 레시피는 다음에 그 페이지를 다시 열었을 때도 같은 요소를 찾아야 한다. 사람이 붙인 id·클래스는 오래 남고,
   * 화면 틀(React·Angular·CSS-in-JS 등)이 그때그때 만든 이름·상태 클래스·숫자가 긴 이름은 다음에 바뀌기 쉬워 쓰지 않는다. */

  const RANDOM = /[a-z]\d[a-z]\d|\d[a-z]\d[a-z]/i; // a1b2 처럼 글자와 숫자가 번갈아 나오면 무작위로 만든 이름
  const ID_PREFIX = /^(ember|ext-|gwt-|yui_|j_id|jsf_|ui-id-|react-|radix-|headlessui-|mui-|tippy-|downshift-|rc-|el-id-|__bvid__)/i;
  const STATE_CLASS = /^(active|inactive|open|opened|closed|show|shown|showing|hide|hidden|visible|invisible|hover|hovered|focus|focused|focus-visible|selected|current|checked|disabled|enabled|expanded|collapsed|loading|loaded|ready|animated|animating|fade|in|out|on|off|sticky|fixed|stuck|scrolled|dragging)$/i;
  const CLASS_PREFIX = /^(is-|has-|css-|sc-|jsx-|svelte-|emotion-|ng-|tw-)/i;

  function stableId(id) {
    if (typeof id !== 'string' || !id || id.length > 60 || /\s/.test(id)) return false;
    if (/^\d/.test(id) || /\d{3,}/.test(id)) return false;
    if (ID_PREFIX.test(id) || /^:r/i.test(id) || /:$/.test(id)) return false; // React useId(':r1:')
    return !RANDOM.test(id);
  }

  function stableClass(c) {
    if (typeof c !== 'string' || c.length < 2 || c.length > 40) return false;
    if (!/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(c)) return false; // 따옴표·이스케이프 없이 쓸 수 있는 이름만 (md:flex, w-1/2 는 뺀다)
    if (/\d{3,}/.test(c) || STATE_CLASS.test(c) || CLASS_PREFIX.test(c) || RANDOM.test(c)) return false;
    const mod = c.lastIndexOf('__');
    if (mod >= 0 && /\d/.test(c.slice(mod))) return false; // CSS Modules 의 해시 꼬리 (Header_title__a1B2c)
    if (c[0] === '_' && /\d/.test(c)) return false;        // _3xYz9
    return true;
  }

  /* ---------------------------------------------------------------- 사이트와 저장값 */

  function hostKey(url) {
    let u;
    try { u = new URL(String(url)); } catch (_) { return ''; }
    if (u.protocol === 'file:') return 'file';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.host.toLowerCase().replace(/^www\./, '');
  }

  function itemKey(it) {
    return `${it.kind}\u0001${it.path.join('\u0002')}\u0001${it.sel}`;
  }

  /** 항목 하나를 믿을 수 있는 값으로. 쓸 수 없으면 null */
  function normalizeItem(it) {
    if (!it || typeof it !== 'object' || !KINDS.includes(it.kind)) return null;
    const sel = str(it.sel).trim();
    if (!sel || sel.length > LIMITS.sel) return null;
    const raw = it.path === undefined ? [] : it.path;
    if (!Array.isArray(raw) || raw.length > LIMITS.path) return null;
    const path = [];
    for (const p of raw) {
      if (typeof p !== 'string' || !p.trim() || p.length > LIMITS.sel) return null;
      path.push(p.trim());
    }
    const out = { kind: it.kind, path, sel, label: str(it.label).slice(0, LIMITS.label) };
    if (it.kind === 'hide') out.remove = it.remove === true;
    if (it.kind === 'text') {
      if (typeof it.text !== 'string') return null;
      out.text = it.text.slice(0, LIMITS.text);
    }
    return out;
  }

  /** 한 사이트의 레시피. 항목도 정리도 없으면 null */
  function normalizeRecipe(r) {
    if (!r || typeof r !== 'object') return null;
    const items = [];
    const seen = new Set();
    for (const it of Array.isArray(r.items) ? r.items : []) {
      const n = normalizeItem(it);
      if (!n) continue;
      const k = itemKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(n);
      if (items.length >= LIMITS.items) break;
    }
    const cleanup = r.cleanup === true;
    if (!items.length && !cleanup) return null;
    return { on: r.on !== false, cleanup, at: Number.isFinite(r.at) ? r.at : 0, items };
  }

  /** 저장된 레시피 전체. 최근에 저장한 사이트부터, 한도까지 */
  function normalizeStore(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const list = [];
    for (const [host, r] of Object.entries(raw)) {
      if (!host || host.length > LIMITS.host || host === '__proto__') continue;
      const n = normalizeRecipe(r);
      if (n) list.push([host, n]);
    }
    list.sort((a, b) => b[1].at - a[1].at);
    for (const [host, n] of list.slice(0, LIMITS.sites)) out[host] = n;
    return out;
  }

  /** 레시피에 항목을 더한다 (넘겨받은 레시피는 바꾸지 않는다). 같은 요소의 글 고침·지우기 방식은 새 값으로 바꾸고,
      저장하면 켜진다. opts.cleanup 이면 정리 포함 — 이미 켠 정리는 끄지 않는다. */
  function addItems(recipe, items, opts = {}) {
    const base = normalizeRecipe(recipe) || { on: true, cleanup: false, at: 0, items: [] };
    const out = {
      on: true,
      cleanup: base.cleanup || opts.cleanup === true,
      at: Number.isFinite(opts.at) ? opts.at : base.at,
      items: base.items.slice()
    };
    const index = new Map(out.items.map((it, i) => [itemKey(it), i]));
    let added = 0;
    let updated = 0;
    let full = 0;
    for (const raw of Array.isArray(items) ? items : []) {
      const it = normalizeItem(raw);
      if (!it) continue;
      const k = itemKey(it);
      if (index.has(k)) {
        const i = index.get(k);
        const cur = out.items[i];
        if ((it.kind === 'text' && cur.text !== it.text) || (it.kind === 'hide' && cur.remove !== it.remove)) {
          out.items[i] = it;
          updated++;
        }
        continue;
      }
      if (out.items.length >= LIMITS.items) { full++; continue; }
      index.set(k, out.items.length);
      out.items.push(it);
      added++;
    }
    return { recipe: out, added, updated, full };
  }

  /** '지우기 2 · 가리기 1 · 글 고침 1 · 정리 포함' */
  function summary(recipe) {
    if (!recipe || typeof recipe !== 'object') return '';
    const items = Array.isArray(recipe.items) ? recipe.items : [];
    const parts = [];
    for (const k of KINDS) {
      const n = items.filter((it) => it && it.kind === k).length;
      if (n) parts.push(`${KIND_LABELS[k]} ${n}`);
    }
    if (recipe.cleanup === true) parts.push(parts.length ? '정리 포함' : '정리');
    return parts.join(' · ');
  }

  globalThis.CleanShotRecipes = Object.freeze({
    KINDS, KIND_LABELS, CATEGORIES, CATEGORY_LABELS, LIMITS, VENDORS,
    classify, isPopupText, popupContainer, isBackdrop, countSummary,
    stableId, stableClass,
    hostKey, itemKey, normalizeItem, normalizeStore, addItems, summary
  });
})();
