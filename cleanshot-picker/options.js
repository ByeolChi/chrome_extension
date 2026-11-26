/* CleanShot Picker — 설정 화면 (options.html)
 * 저장 형식·크기·파일 이름 양식·저장 위치 묻기·주소와 시각 띠를 chrome.storage.sync 에 둔다.
 * 값의 뜻과 기본값, 파일 이름 만들기는 settings.js(서비스 워커와 같은 파일)를 쓴다. 바꾸면 바로 저장한다.
 */
(() => {
  'use strict';

  const CS = globalThis.CleanShotSettings;
  const $ = (id) => document.getElementById(id);
  const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];
  const nameInput = $('nameTemplate');
  const EXAMPLE = { url: 'https://www.example.com/docs/page?id=1', title: '사용 설명서 · 예시' };

  let current = CS.normalize(null);
  let savedTimer = 0;

  function paint(v) {
    radios('outFormat').forEach((r) => { r.checked = r.value === v.outFormat; });
    radios('outScale').forEach((r) => { r.checked = r.value === v.outScale; });
    if (document.activeElement !== nameInput) nameInput.value = v.nameTemplate;
    $('askWhere').checked = v.askWhere;
    $('stamp').checked = v.stamp;
    paintPreview();
  }

  /* 이 화면의 배율을 알려 준다 (확장을 쓰는 탭과 같은 모니터라면 같은 값) */
  function paintDpr() {
    const d = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    $('dprNote').textContent = ` · 지금 이 화면은 ${d}배`;
  }

  function paintPreview() {
    const tpl = nameInput.value;
    const ext = CS.FORMATS[current.outFormat].ext;
    const at = new Date();
    const name = CS.fileName(tpl, { ...EXAMPLE, at, suffix: '', ext });
    const full = CS.fileName(tpl, { ...EXAMPLE, at, suffix: '-full', ext });
    const box = $('namePreview');
    const line = (label, text) => {
      const div = document.createElement('div');
      const code = document.createElement('code');
      code.textContent = text;
      div.append(label, code);
      return div;
    };
    box.replaceChildren(line('예: ', name), line('전체 페이지: ', full));

    const warns = [];
    const trimmed = tpl.trim();
    if (!trimmed) warns.push('비어 있어 기본 양식을 씁니다.');
    else {
      const { unknown } = CS.fillTemplate(trimmed, { ...EXAMPLE, at });
      if (unknown.length) warns.push(`모르는 칸은 글자 그대로 들어갑니다: ${unknown.map((k) => `{${k}}`).join(' ')}`);
      if (!/\{(time|title)\}/.test(trimmed)) warns.push('{time} 이나 {title} 이 없으면 이름이 겹치기 쉽습니다. 겹치면 Chrome 이 끝에 (1), (2)… 를 붙입니다.');
    }
    const w = $('nameWarn');
    w.textContent = warns.join(' ');
    w.hidden = !warns.length;
  }

  async function write(patch) {
    current = CS.normalize({ ...current, ...patch });
    try {
      await chrome.storage.sync.set(patch);
      const s = $('saved');
      s.textContent = '저장했습니다';
      s.classList.add('on');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => s.classList.remove('on'), 1200);
    } catch (err) {
      const s = $('saved');
      s.textContent = `저장하지 못했습니다 · ${(err && err.message) || err}`;
      s.classList.add('on');
    }
    paintPreview();
  }

  radios('outFormat').forEach((r) => r.addEventListener('change', () => { if (r.checked) write({ outFormat: r.value }); }));
  radios('outScale').forEach((r) => r.addEventListener('change', () => { if (r.checked) write({ outScale: r.value }); }));
  $('askWhere').addEventListener('change', (e) => write({ askWhere: e.target.checked }));
  $('stamp').addEventListener('change', (e) => write({ stamp: e.target.checked }));

  // 파일 이름: 쓰는 동안 미리 보기만, 칸을 떠나거나 Enter 를 누르면 저장한다 (빈 값이면 기본 양식으로 되돌림)
  nameInput.addEventListener('input', paintPreview);
  const commitName = () => {
    const v = nameInput.value.trim();
    if (!v) nameInput.value = CS.DEFAULTS.nameTemplate;
    const next = nameInput.value.trim().slice(0, 200);
    if (next !== current.nameTemplate) write({ nameTemplate: next });
    else paintPreview();
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); } });
  $('nameReset').addEventListener('click', () => {
    nameInput.value = CS.DEFAULTS.nameTemplate;
    write({ nameTemplate: CS.DEFAULTS.nameTemplate });
  });

  // 다른 기기·다른 탭에서 바꾼 값도 보이게
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const k of Object.keys(CS.DEFAULTS)) if (changes[k]) patch[k] = changes[k].newValue;
    if (!Object.keys(patch).length) return;
    current = CS.normalize({ ...current, ...patch });
    paint(current);
  });

  paintDpr();
  chrome.storage.sync.get(CS.DEFAULTS).then((v) => {
    current = CS.normalize(v);
    paint(current);
  }).catch(() => paint(current));
})();
