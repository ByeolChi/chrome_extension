// 모달 다이얼로그: 가져오기, 저장, 설정, 쿠키 관리자, 단축키 등
import { h, clear, readFileAsText, download, isMac } from '../util.js';
import { icon } from './icons.js';
import { openModal, toast, confirmDialog, popover } from './overlay.js';
import { groupByDomain, parseCookieInput, cookieToString, storeCookie, isExpired } from '../cookiejar.js';
import { DEFAULT_SETTINGS } from '../store.js';
import { detectOS, downloadInstaller } from '../helper-installer.js';
import { app } from '../app.js';

const MOD = isMac() ? '⌘' : 'Ctrl';

/* ---------------- 가져오기 ---------------- */
export function openImport(initialText = '') {
  const ta = h('textarea.import-ta', {
    placeholder: 'cURL 명령, Postman Collection / Environment JSON, 또는 URL을 붙여넣으세요\n\n예) curl -X POST https://api.example.com/login -H "Content-Type: application/json" -d \'{"id":"kim"}\'',
    spellcheck: 'false',
    autofocus: true,
  });
  ta.value = initialText;
  const fileIn = h('input', { type: 'file', accept: '.json,.txt,.sh,.curl,application/json,text/plain', multiple: true, style: { display: 'none' } });
  const status = h('div.import-status');
  const drop = h('div.dropzone',
    icon('import', 28),
    h('div.dz-title', '파일을 여기로 끌어다 놓거나'),
    h('button.btn.btn-sm', { onclick: () => fileIn.click() }, '파일 선택'),
    h('div.dz-sub', 'Postman Collection v2.0/v2.1, Environment, Ssoda 백업(.json) 지원'),
    fileIn);
  const handleFiles = async (files) => {
    const results = [];
    for (const f of files) {
      try {
        const text = await readFileAsText(f);
        results.push(await doImport(text, f.name));
      } catch (e) {
        results.push({ error: `${f.name}: ${e.message}` });
      }
    }
    showResults(results);
  };
  fileIn.addEventListener('change', () => handleFiles([...fileIn.files]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleFiles([...e.dataTransfer.files]);
  });
  const showResults = (results) => {
    clear(status);
    let okCount = 0;
    for (const r of results) {
      if (r.error) status.appendChild(h('div.imp-err', icon('alert', 14), r.error));
      else if (r.cancelled) continue;
      else {
        okCount++;
        status.appendChild(h('div.imp-ok', icon('check', 14), r.message));
        (r.warnings || []).forEach((w) => status.appendChild(h('div.imp-warn', '· ' + w)));
      }
    }
    if (okCount && !results.some((r) => r.error || (r.warnings && r.warnings.length))) {
      m.close();
      results.forEach((r) => r.message && toast(r.message, 'success'));
    }
  };
  const doImport = async (text, label) => {
    const res = app.importText(text);
    if (res.kind === 'backup') {
      const ok = await confirmDialog({
        title: '백업 복원',
        message: '현재 모든 데이터(컬렉션, 환경, 히스토리, 쿠키, 설정)를 백업 파일의 데이터로 교체합니다. 계속할까요?',
        okText: '복원',
        danger: true,
      });
      if (!ok) return { cancelled: true };
      await app.store.replaceAll(res.data);
      location.reload();
      return { message: '복원 완료' };
    }
    return res;
  };
  const importBtn = h('button.btn.btn-primary', {
    onclick: async () => {
      const text = ta.value.trim();
      if (!text) return toast('가져올 내용을 입력하세요.', 'error');
      try {
        showResults([await doImport(text)]);
      } catch (e) {
        showResults([{ error: e.message }]);
      }
    },
  }, '가져오기');
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') importBtn.click();
  });
  const m = openModal({
    title: '가져오기',
    subtitle: 'cURL · Postman Collection · Environment · URL',
    width: 680,
    body: h('div.import', ta, drop, status),
    footer: [h('span.foot-hint', `${MOD}+Enter 로 가져오기`), h('div.flex1'), h('button.btn', { onclick: () => m.close() }, '닫기'), importBtn],
  });
}

/* ---------------- 다른 이름으로 저장 ---------------- */
export function saveAsDialog(tab) {
  return new Promise((resolve) => {
    let result = null;
    let selected = tab.itemId ? (app.ancestors(tab.itemId).slice(-1)[0] || {}).id : null;
    if (!selected && app.state.collections.length === 1) selected = app.state.collections[0].id;
    const nameIn = h('input.input', { value: tab.name === 'Untitled Request' ? '' : tab.name, placeholder: '요청 이름', spellcheck: 'false', autofocus: true });
    const treeBox = h('div.save-tree');
    const saveBtn = h('button.btn.btn-primary', { onclick: () => submit() }, '저장');
    const newColIn = h('input.input.input-sm', { placeholder: '새 컬렉션 이름', spellcheck: 'false' });
    const renderTree = () => {
      clear(treeBox);
      if (!app.state.collections.length) treeBox.appendChild(h('div.muted.pad', '컬렉션이 없습니다. 아래에서 새 컬렉션을 만드세요.'));
      const walk = (items, depth) => {
        for (const it of items) {
          if (it.type === 'request') continue;
          const row = h('div.save-row' + (selected === it.id ? '.sel' : ''), { style: { paddingLeft: 10 + depth * 16 + 'px' } },
            icon(depth === 0 ? 'collections' : 'folder', 15), h('span', it.name));
          row.addEventListener('click', () => {
            selected = it.id;
            renderTree();
          });
          row.addEventListener('dblclick', () => {
            selected = it.id;
            submit();
          });
          treeBox.appendChild(row);
          walk(it.items || [], depth + 1);
        }
      };
      walk(app.state.collections, 0);
      saveBtn.disabled = !selected;
      saveBtn.textContent = selected ? `저장` : '저장할 위치를 선택하세요';
    };
    const addCol = () => {
      const name = newColIn.value.trim() || '새 컬렉션';
      const c = app.createCollection(name);
      selected = c.id;
      newColIn.value = '';
      app.ui.renderSidebar();
      renderTree();
    };
    newColIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        addCol();
      }
    });
    const submit = () => {
      if (!selected) return toast('저장할 컬렉션 또는 폴더를 선택하세요.', 'error');
      result = { name: nameIn.value.trim() || tab.name || '새 요청', parentId: selected };
      m.close();
    };
    nameIn.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && submit());
    const m = openModal({
      title: '요청 저장',
      width: 520,
      body: h('div.save-dlg',
        h('label.field', h('span.field-label', '요청 이름'), nameIn),
        h('div.field-label', '저장 위치'),
        treeBox,
        h('div.save-newcol', newColIn, h('button.btn.btn-sm', { onclick: addCol }, icon('plus', 13), '새 컬렉션'))),
      footer: [h('div.flex1'), h('button.btn', { onclick: () => m.close() }, '취소'), saveBtn],
      onClose: () => resolve(result),
    });
    renderTree();
  });
}

/* ---------------- 저장 안 된 변경사항 ---------------- */
export function askSaveChanges(tab) {
  return new Promise((resolve) => {
    let result = 'cancel';
    const m = openModal({
      title: '변경사항을 저장할까요?',
      width: 440,
      body: h('div.confirm-msg', `"${tab.name}" 탭에 저장하지 않은 변경사항이 있습니다. 저장하지 않으면 변경사항이 사라집니다.`),
      footer: [
        h('button.btn.btn-danger-ghost', { onclick: () => { result = 'discard'; m.close(); } }, '저장 안 함'),
        h('div.flex1'),
        h('button.btn', { onclick: () => { result = 'cancel'; m.close(); } }, '취소'),
        h('button.btn.btn-primary', { onclick: () => { result = 'save'; m.close(); } }, '저장'),
      ],
      onClose: () => resolve(result),
    });
  });
}

/* ---------------- 설정 ---------------- */
export function openSettings() {
  const s = app.settings;
  const row = (label, sub, control) => h('div.set-row', h('div.set-label', h('div', label), sub ? h('div.muted', sub) : null), control);
  const toggle = (key, onChange) => {
    const cb = h('input.switch', { type: 'checkbox', checked: !!s[key] });
    cb.addEventListener('change', () => {
      s[key] = cb.checked;
      app.store.changed('settings');
      onChange && onChange();
    });
    return cb;
  };
  const select = (key, opts, onChange) => {
    const sel = h('select.select', opts.map(([v, l]) => h('option', { value: v, selected: String(s[key]) === String(v) }, l)));
    sel.addEventListener('change', () => {
      s[key] = sel.value;
      app.store.changed('settings');
      onChange && onChange();
    });
    return sel;
  };
  const num = (key, ph) => {
    const inp = h('input.input.input-num', { type: 'number', min: '0', value: s[key] || '', placeholder: ph });
    inp.addEventListener('change', () => {
      s[key] = Math.max(0, parseInt(inp.value, 10) || 0);
      app.store.changed('settings');
    });
    return inp;
  };
  const restoreIn = h('input', { type: 'file', accept: '.json', style: { display: 'none' } });
  restoreIn.addEventListener('change', async () => {
    const f = restoreIn.files[0];
    if (!f) return;
    try {
      const text = await readFileAsText(f);
      const obj = JSON.parse(text);
      if (obj.app !== 'ssoda' && obj.app !== 'curl-studio') throw new Error('Ssoda 백업 파일이 아닙니다.');
      if (await confirmDialog({ title: '백업 복원', message: '현재 모든 데이터를 백업 파일의 데이터로 교체할까요?', okText: '복원', danger: true })) {
        await app.store.replaceAll(obj.data);
        location.reload();
      }
    } catch (e) {
      toast('복원 실패: ' + e.message, 'error');
    }
  });
  const body = h('div.settings',
    h('div.set-sec', '일반'),
    row('테마', null, select('theme', [['system', '시스템 설정 따르기'], ['light', '라이트'], ['dark', '다크']], () => app.ui.applyTheme())),
    row('레이아웃', '요청과 응답 패널 배치', select('layout', [['horizontal', '위/아래'], ['vertical', '왼쪽/오른쪽']], () => app.ui.applySplitAll())),
    h('div.set-sec', '요청'),
    row('기본 타임아웃 (ms)', '0 또는 빈 값 = 무제한', num('timeout', '0')),
    row('리다이렉트 자동으로 따라가기', 'curl의 -L 옵션', toggle('followRedirects')),
    row('Origin 헤더 제거', 'curl처럼 Origin 헤더 없이 전송합니다 (끄면 chrome-extension:// Origin이 전송됨)', toggle('removeOrigin')),
    h('div.set-sec', 'cURL 실행'),
    row('기본 실행 방식', '요청별로 Send ▾ 메뉴나 cURL 탭에서 바꿀 수 있습니다', select('defaultEngine', [['browser', '브라우저 (fetch)'], ['curl', 'cURL (PC의 curl 실행)']], () => app.ui.refreshEngines && app.ui.refreshEngines())),
    row('cURL 실행 도우미', '실제 curl 로 실행하려면 한 번 설치가 필요합니다', h('button.btn', { onclick: () => openCurlHelper() }, icon('terminal', 14), '도우미 설정 열기')),
    h('div.set-sec', '쿠키 & 히스토리'),
    row('응답 쿠키 자동 저장', '응답의 Set-Cookie를 쿠키 관리자에 저장하고 같은 도메인 요청에 자동으로 보냅니다', toggle('autoSaveCookies')),
    row('히스토리 기록', null, toggle('historyEnabled')),
    row('최대 히스토리 개수', null, num('historyLimit', '300')),
    h('div.set-sec', '데이터'),
    h('div.set-data',
      h('button.btn', { title: 'SSH 비밀번호는 저장하지 않으므로 백업에도 들어가지 않습니다', onclick: () => download(`ssoda-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(app.backupData(), null, 2)) }, icon('download', 14), '전체 백업 내보내기'),
      h('button.btn', { onclick: () => restoreIn.click() }, icon('upload', 14), '백업에서 복원'),
      h('button.btn.btn-danger-ghost', {
        onclick: async () => {
          if (await confirmDialog({ title: '모든 데이터 삭제', message: '컬렉션, 환경, 히스토리, 쿠키, 설정이 모두 삭제됩니다. 되돌릴 수 없습니다.', okText: '모두 삭제', danger: true })) {
            await app.store.clearAll();
            location.reload();
          }
        },
      }, icon('trash', 14), '모든 데이터 삭제'),
      restoreIn),
    h('div.set-about', `Ssoda v${chrome?.runtime?.getManifest ? chrome.runtime.getManifest().version : '1.0.0'} · 데이터는 이 브라우저(chrome.storage.local)에만 저장됩니다.`)
  );
  const m = openModal({ title: '설정', width: 640, body, footer: [h('button.btn', { onclick: () => { Object.assign(s, DEFAULT_SETTINGS, { theme: s.theme }); app.store.changed('settings'); m.close(); openSettings(); } }, '기본값으로'), h('div.flex1'), h('button.btn.btn-primary', { onclick: () => m.close() }, '완료')] });
}

/* ---------------- 쿠키 관리자 ---------------- */
export function openCookieManager(prefDomain) {
  let selected = prefDomain || null;
  const body = h('div.cm');
  const render = () => {
    clear(body);
    const jar = app.state.cookieJar.filter((c) => !isExpired(c));
    const groups = groupByDomain(jar);
    if (!selected && groups.length) selected = groups[0][0];
    const domIn = h('input.input', { placeholder: '도메인 입력 (예: api.example.com)', spellcheck: 'false' });
    const addDom = () => {
      const d = domIn.value.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      if (!d) return;
      selected = d;
      editCookie(d, null);
    };
    domIn.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && addDom());
    const fromChrome = h('button.btn', {
      title: 'Chrome 브라우저에 저장된 이 도메인의 쿠키를 쿠키 관리자로 복사',
      onclick: async () => {
        const d = domIn.value.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || selected;
        if (!d) return toast('도메인을 입력하세요.', 'error');
        try {
          const list = await chrome.cookies.getAll({ domain: d });
          if (!list.length) return toast(`Chrome에 ${d} 쿠키가 없습니다.`, 'info');
          list.forEach((c) =>
            storeCookie(app.state.cookieJar, {
              name: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), hostOnly: !!c.hostOnly, path: c.path,
              expires: c.expirationDate ? Math.round(c.expirationDate * 1000) : null, secure: c.secure, httpOnly: c.httpOnly,
              sameSite: c.sameSite || '', created: Date.now(),
            })
          );
          app.store.changed('cookieJar');
          toast(`Chrome 쿠키 ${list.length}개를 가져왔습니다.`, 'success');
          selected = d;
          render();
        } catch (e) {
          toast('가져오기 실패: ' + e.message, 'error');
        }
      },
    }, icon('download', 14), 'Chrome에서 가져오기');
    body.appendChild(h('div.cm-top', domIn, h('button.btn', { onclick: addDom }, '도메인 추가'), fromChrome));
    if (!groups.length && !selected) {
      body.appendChild(h('div.cm-empty', icon('cookie', 32), h('div', '저장된 쿠키가 없습니다.'), h('div.muted', '응답의 Set-Cookie는 자동으로 여기에 저장되어 같은 도메인 요청에 전송됩니다.')));
      return;
    }
    const domains = h('div.cm-domains', groups.map(([d, list]) => {
      const chip = h('div.cm-domain' + (d === selected ? '.sel' : ''), h('span', d), h('span.tree-count', String(list.length)),
        h('button.icon-btn', {
          title: '도메인 쿠키 모두 삭제',
          onclick: (e) => {
            e.stopPropagation();
            app.state.cookieJar = app.state.cookieJar.filter((c) => c.domain !== d);
            app.store.changed('cookieJar');
            if (selected === d) selected = null;
            render();
          },
        }, icon('x', 12)));
      chip.addEventListener('click', () => {
        selected = d;
        render();
      });
      return chip;
    }));
    body.appendChild(domains);
    if (selected) {
      const list = jar.filter((c) => c.domain === selected);
      const cookieList = h('div.cm-cookies',
        h('div.cm-sub', h('b', selected), ` 의 쿠키 ${list.length}개`, h('div.flex1'),
          h('button.btn.btn-sm', { onclick: () => editCookie(selected, null) }, icon('plus', 13), '쿠키 추가')),
        list.map((c) =>
          h('div.cm-cookie',
            h('div.cm-cookie-main', { onclick: () => editCookie(selected, c) },
              h('span.cm-name', c.name), h('span.cm-val', c.value),
              h('span.cm-meta', `${c.path}${c.httpOnly ? ' · HttpOnly' : ''}${c.secure ? ' · Secure' : ''}${c.expires ? ' · ' + new Date(c.expires).toLocaleString('ko-KR') : ' · Session'}`)),
            h('button.icon-btn', {
              title: '삭제',
              onclick: () => {
                const i = app.state.cookieJar.indexOf(c);
                if (i >= 0) app.state.cookieJar.splice(i, 1);
                app.store.changed('cookieJar');
                render();
              },
            }, icon('trash', 14))))
      );
      if (!list.length) cookieList.appendChild(h('div.muted.pad', '쿠키가 없습니다. "쿠키 추가"를 눌러 추가하세요.'));
      body.appendChild(cookieList);
    }
  };
  const editCookie = (domain, cookie) => {
    const ta = h('textarea.input.cm-edit', { spellcheck: 'false' });
    ta.value = cookie ? cookieToString(cookie) : 'name=value; Path=/';
    const em = openModal({
      title: cookie ? '쿠키 수정' : '쿠키 추가',
      subtitle: domain,
      width: 520,
      body: h('div', h('div.field-label', 'Set-Cookie 형식으로 입력 (name=value; Path=/; Expires=...; HttpOnly)'), ta),
      footer: [
        h('div.flex1'),
        h('button.btn', { onclick: () => em.close() }, '취소'),
        h('button.btn.btn-primary', {
          onclick: () => {
            const c = parseCookieInput(ta.value, domain);
            if (!c || !c.name) return toast('쿠키 형식이 올바르지 않습니다.', 'error');
            if (cookie) {
              const i = app.state.cookieJar.indexOf(cookie);
              if (i >= 0) app.state.cookieJar.splice(i, 1);
            }
            storeCookie(app.state.cookieJar, c);
            app.store.changed('cookieJar');
            selected = c.domain;
            em.close();
            render();
          },
        }, '저장'),
      ],
    });
  };
  render();
  const m = openModal({
    title: '쿠키 관리자',
    subtitle: '요청에 자동으로 포함되는 쿠키 (Chrome 브라우저 쿠키와 별도로 관리)',
    width: 720,
    body,
    footer: [
      h('button.btn.btn-danger-ghost', {
        onclick: async () => {
          if (await confirmDialog({ title: '쿠키 모두 삭제', message: '쿠키 관리자의 모든 쿠키를 삭제할까요?', okText: '삭제', danger: true })) {
            app.state.cookieJar = [];
            app.store.changed('cookieJar');
            selected = null;
            render();
          }
        },
      }, '모두 삭제'),
      h('div.flex1'),
      h('button.btn.btn-primary', { onclick: () => m.close() }, '닫기'),
    ],
  });
}

/* ---------------- 단축키 ---------------- */
export function openShortcuts() {
  const rows = [
    [`${MOD} + Enter`, '요청 보내기'],
    [`${MOD} + S`, '저장'],
    [`${MOD} + Shift + S`, '다른 이름으로 저장'],
    ['Alt + N', '새 요청 탭'],
    ['Alt + W', '현재 탭 닫기'],
    ['Alt + I', '가져오기 (cURL / Postman)'],
    [`${MOD} + K`, '요청 검색'],
    ['Alt + ← / →', '이전 / 다음 탭'],
    ['Alt + Shift + U', '툴바 아이콘 없이 Ssoda 열기'],
    ['Send 옆 ▾ → cURL로 실행', 'PC의 실제 curl 로 실행 (도우미 필요)'],
    ['URL 입력창에 cURL 붙여넣기', '자동으로 요청으로 변환'],
    ['웹페이지에서 cURL 선택 후 우클릭', '"Ssoda로 열기"'],
  ];
  const m = openModal({
    title: '단축키 & 팁',
    width: 520,
    body: h('div.shortcuts', rows.map(([k, d]) => h('div.sc-row', h('kbd', k), h('span', d)))),
    footer: [h('div.flex1'), h('button.btn.btn-primary', { onclick: () => m.close() }, '닫기')],
  });
}

/* ---------------- 환경 빠른 보기 ---------------- */
export function envQuickLook(anchor) {
  const env = app.activeEnv();
  const section = (title, vars, onEdit) =>
    h('div.ql-sec',
      h('div.ql-head', h('b', title), onEdit ? h('button.link-btn', { onclick: onEdit }, '편집') : null),
      vars && vars.length
        ? h('div.ql-table', vars.map((v) => h('div.ql-row' + (v.enabled ? '' : '.disabled'), h('span.ql-k', v.key), h('span.ql-v', v.value))))
        : h('div.muted.ql-empty', '변수가 없습니다.'));
  popover(anchor, h('div.ql',
    env ? section(env.name, env.variables, () => { app.openEnvironment(env.id); document.body.click(); }) : h('div.ql-sec', h('div.ql-head', h('b', '활성 환경 없음')), h('div.muted.ql-empty', '오른쪽 위 드롭다운에서 환경을 선택하세요.')),
    section('Globals', app.state.globals.variables, () => app.openEnvironment('globals'))
  ), { alignRight: true, className: 'ql-pop' });
}

/* ---------------- 요청 검색 (Ctrl+K) ---------------- */
export function openSearch() {
  const input = h('input.input.search-big', { placeholder: '컬렉션의 요청, 히스토리 검색…', spellcheck: 'false', autofocus: true });
  const list = h('div.search-list');
  let items = [];
  let idx = 0;
  const all = [];
  const walk = (col, items2, path) => {
    for (const it of items2 || []) {
      if (it.type === 'request') all.push({ kind: 'req', id: it.id, name: it.name, method: it.request.method, url: it.request.url, path: path.join(' / ') });
      else walk(col, it.items, path.concat(it.name));
    }
  };
  app.state.collections.forEach((c) => walk(c, c.items, [c.name]));
  app.state.history.slice(0, 100).forEach((e) => all.push({ kind: 'his', entry: e, name: e.name || e.request.url, method: e.request.method, url: e.request.url, path: '히스토리' }));
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = all.filter((x) => !q || `${x.name} ${x.url} ${x.method} ${x.path}`.toLowerCase().includes(q)).slice(0, 50);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    clear(list);
    items.forEach((x, i) => {
      const row = h('div.search-row' + (i === idx ? '.active' : ''),
        h('span.tree-method.m-' + (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(x.method) ? x.method.toLowerCase() : 'other'), x.method),
        h('span.search-name', x.name),
        h('span.search-path', x.path));
      row.addEventListener('click', () => pick(x));
      list.appendChild(row);
    });
    if (!items.length) list.appendChild(h('div.muted.pad', '결과가 없습니다.'));
    const act = list.querySelector('.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const pick = (x) => {
    m.close();
    if (x.kind === 'req') app.openItem(x.id);
    else app.openHistory(x.entry);
  };
  input.addEventListener('input', () => {
    idx = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(items.length - 1, idx + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
      render();
    } else if (e.key === 'Enter' && !e.isComposing && items[idx]) pick(items[idx]);
  });
  const m = openModal({ title: '요청 검색', width: 640, body: h('div.search-dlg', input, list), className: 'modal-search' });
  render();
}

/* ---------------- cURL 실행 도우미 ---------------- */
export function openCurlHelper() {
  const detected = detectOS();
  let os = detected;
  const statusBox = h('div.helper-status');
  const body = h('div.helper-dlg');
  const renderStatus = async (force) => {
    clear(statusBox);
    statusBox.className = 'helper-status checking';
    statusBox.append(h('div.spinner.sm'), h('span', '도우미 연결을 확인하는 중…'));
    const st = await app.ui.helperStatus({ force });
    clear(statusBox);
    if (st.ok) {
      statusBox.className = 'helper-status ok';
      statusBox.append(icon('check', 18), h('div',
        h('div.hs-title', '도우미가 연결되었습니다. 이제 cURL 로 실행할 수 있습니다.'),
        h('div.hs-sub', st.curl || 'curl 을 찾지 못했습니다'),
        h('div.hs-sub', `${st.path || ''}  ·  도우미 v${st.hostVersion || '?'}`)));
    } else {
      statusBox.className = 'helper-status bad';
      statusBox.append(icon('alert', 18), h('div',
        h('div.hs-title', st.code === 'NO_HOST' ? '도우미가 아직 설치되지 않았습니다.' : st.message || '도우미에 연결할 수 없습니다.'),
        st.code !== 'NO_HOST' ? h('div.hs-sub', st.hint || '') : h('div.hs-sub', '아래 설치 방법대로 한 번만 설치하면 됩니다.')));
    }
    statusBox.appendChild(h('button.btn.btn-sm', { onclick: () => renderStatus(true) }, icon('refresh', 13), '다시 확인'));
  };
  const curlPath = h('input.input.mono-input', { value: app.settings.curlPath || '', placeholder: os === 'windows' ? '비우면 자동: C:\\Windows\\System32\\curl.exe' : '비우면 자동: /usr/bin/curl', spellcheck: 'false' });
  curlPath.addEventListener('change', () => {
    app.settings.curlPath = curlPath.value.trim();
    app.store.changed('settings');
    renderStatus(true);
  });
  const dl = async (kind) => {
    try {
      const name = await downloadInstaller(os, kind);
      toast(`${name} 을(를) 다운로드했습니다.`, 'success', 4000);
    } catch (e) {
      toast('파일 생성 실패: ' + e.message, 'error');
    }
  };
  const renderBody = () => {
    clear(body);
    const osSeg = h('div.seg',
      h('button.seg-btn' + (os === 'windows' ? '.active' : ''), { onclick: () => { os = 'windows'; renderBody(); } }, 'Windows'),
      h('button.seg-btn' + (os !== 'windows' ? '.active' : ''), { onclick: () => { os = detected === 'mac' ? 'mac' : 'linux'; renderBody(); } }, 'macOS / Linux'));
    const steps = os === 'windows'
      ? [
          h('li', h('b', '설치 파일 다운로드'), ' 버튼을 누릅니다. ', h('code', 'ssoda-helper-install.bat'), h('span.muted', ' (Chrome 이 "위험할 수 있는 파일" 경고를 띄우면 [유지]를 누르세요)')),
          h('li', '다운로드 폴더에서 파일을 ', h('b', '더블클릭'), '합니다. 관리자 권한은 필요 없습니다. ', h('span.muted', '"Windows의 PC 보호" 창이 뜨면 [추가 정보] → [실행]')),
          h('li', '검은 창에 "설치가 완료되었습니다" 가 보이면 아무 키나 눌러 닫고, 아래 ', h('b', '연결 확인'), '을 누릅니다.'),
        ]
      : [
          h('li', h('b', '설치 파일 다운로드'), ' 버튼을 누릅니다. ', h('code', 'ssoda-helper-install.sh')),
          h('li', '터미널에서 실행합니다: ', h('code', 'bash ~/Downloads/ssoda-helper-install.sh'), h('span.muted', ' (python3 필요, sudo 불필요)')),
          h('li', '"설치가 완료되었습니다" 가 보이면 아래 ', h('b', '연결 확인'), '을 누릅니다.'),
        ];
    body.append(
      statusBox,
      h('div.helper-why', icon('info', 14), h('div',
        '크롬 확장 프로그램은 보안상 PC 프로그램을 직접 실행할 수 없습니다. Chrome 공식 기능(Native Messaging)으로 ',
        h('b', '이 확장 프로그램만 호출할 수 있는'), ' 작은 도우미를 한 번 설치하면, 요청을 PC의 curl 로 실행합니다. 도우미는 요청받은 curl 명령만 실행하며 인터넷에서 아무것도 내려받지 않습니다.')),
      h('div.helper-head', h('div.field-label', '설치 방법'), osSeg),
      h('ol.helper-steps', steps),
      h('div.helper-actions', h('button.btn.btn-primary', { onclick: () => dl('install') }, icon('download', 14), '설치 파일 다운로드'), h('button.btn', { onclick: () => renderStatus(true) }, icon('refresh', 14), '연결 확인')),
      h('div.helper-meta',
        os === 'windows'
          ? [h('div', '설치 위치: ', h('code', '%LOCALAPPDATA%\\Ssoda\\helper')), h('div', '등록: ', h('code', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.ssoda.runner'), ' (Edge · Whale · Brave · Chromium 도 함께)')]
          : [h('div', '설치 위치: ', h('code', os === 'mac' ? '~/Library/Application Support/Ssoda' : '~/.local/share/ssoda'))],
        h('div', '확장 프로그램 ID: ', h('code', chrome.runtime.id), h('span.muted', ' — 확장 프로그램 폴더를 옮기거나 다시 설치해 ID가 바뀌면 설치 파일을 다시 받아 실행하세요.'))),
      h('label.field.helper-path', h('span.field-label', 'curl 실행 파일 경로 (선택)'), curlPath)
    );
  };
  renderBody();
  renderStatus(false);
  const m = openModal({
    title: 'cURL 실행 도우미',
    subtitle: 'PC에 설치된 curl 로 요청을 실행하기 위한 연결 프로그램',
    width: 680,
    body,
    footer: [
      h('button.btn.btn-danger-ghost', { onclick: () => dl('uninstall') }, '제거 파일 다운로드'),
      h('div.flex1'),
      h('button.btn.btn-primary', { onclick: () => m.close() }, '닫기'),
    ],
  });
}
