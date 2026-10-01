// Key-Value 테이블 (+ Bulk Edit, form-data 파일)
import { h, clear, kvRow, uid, readFileAsDataURL, formatBytes } from '../util.js';
import { varInput } from './varinput.js';
import { icon } from './icons.js';
import { openMenu, toast } from './overlay.js';

const MAX_FILE = 20 * 1024 * 1024;

export class KVTable {
  /**
   * opts: { rows: () => array, onChange, keyPlaceholder, valuePlaceholder, description, files, bulk, keyList, title, onStructure }
   */
  constructor(opts) {
    this.opts = Object.assign({ keyPlaceholder: 'Key', valuePlaceholder: 'Value', description: true, bulk: true }, opts);
    this.bulkMode = false;
    this.el = h('div.kv');
    this.render();
  }

  get rows() {
    return this.opts.rows();
  }

  changed(structural) {
    this.opts.onChange && this.opts.onChange(structural);
  }

  render(focus) {
    clear(this.el);
    const head = h(
      'div.kv-toolbar',
      this.opts.title ? h('div.kv-title', this.opts.title) : h('div'),
      h(
        'div.kv-tools',
        this.opts.extraTools || null,
        this.opts.bulk
          ? h('button.link-btn', { onclick: () => this.toggleBulk() }, this.bulkMode ? 'Key-Value 편집' : 'Bulk Edit')
          : null
      )
    );
    this.el.appendChild(head);
    if (this.opts.beforeTable) this.el.appendChild(this.opts.beforeTable);
    if (this.bulkMode) {
      this.el.appendChild(this.renderBulk());
      return;
    }
    const table = h('div.kv-table' + (this.opts.description ? '.with-desc' : '') + (this.opts.files ? '.with-type' : ''));
    table.appendChild(
      h(
        'div.kv-row.kv-head',
        h('div.kv-cell.kv-check', this.rows.length ? this.masterCheckbox() : null),
        h('div.kv-cell', 'Key'),
        h('div.kv-cell', 'Value'),
        this.opts.description ? h('div.kv-cell', 'Description') : null,
        h('div.kv-cell.kv-act')
      )
    );
    this.rows.forEach((row, i) => table.appendChild(this.renderRow(row, i)));
    table.appendChild(this.renderNewRow());
    this.el.appendChild(table);
    if (focus) {
      const sel = `[data-row="${focus.rowId}"][data-field="${focus.field}"]`;
      const inp = this.el.querySelector(sel);
      if (inp) {
        inp.focus();
        const len = inp.value.length;
        inp.setSelectionRange(len, len);
      }
    }
  }

  masterCheckbox() {
    const all = this.rows.every((r) => r.enabled);
    const some = this.rows.some((r) => r.enabled);
    const cb = h('input.cb', { type: 'checkbox', checked: all, title: '전체 선택/해제' });
    cb.indeterminate = some && !all;
    cb.addEventListener('change', () => {
      this.rows.forEach((r) => (r.enabled = cb.checked));
      this.render();
      this.changed(true);
    });
    return cb;
  }

  renderRow(row, i) {
    const cb = h('input.cb', { type: 'checkbox', checked: row.enabled });
    cb.addEventListener('change', () => {
      row.enabled = cb.checked;
      rowEl.classList.toggle('disabled', !row.enabled);
      this.changed(true);
      this.refreshMaster();
    });
    const keyIn = varInput({
      value: row.key,
      placeholder: this.opts.keyPlaceholder,
      getScope: this.opts.getScope,
      onInput: (v) => {
        row.key = v;
        this.changed(false);
      },
    });
    keyIn.input.dataset.row = row.id;
    keyIn.input.dataset.field = 'key';
    if (this.opts.keyList) keyIn.input.setAttribute('list', this.opts.keyList);

    let valueCell;
    if (this.opts.files && row.type === 'file') {
      valueCell = this.fileCell(row);
    } else {
      const valIn = varInput({
        value: row.value,
        placeholder: this.opts.valuePlaceholder,
        getScope: this.opts.getScope,
        onInput: (v) => {
          row.value = v;
          this.changed(false);
        },
      });
      valIn.input.dataset.row = row.id;
      valIn.input.dataset.field = 'value';
      if (this.opts.valueList) {
        const setList = () => {
          const l = this.opts.valueList(row.key);
          if (l) valIn.input.setAttribute('list', l);
          else valIn.input.removeAttribute('list');
        };
        valIn.input.addEventListener('focus', setList);
      }
      valueCell = valIn.el;
    }

    const typeToggle = this.opts.files
      ? h(
          'button.kv-type',
          {
            title: '타입 변경',
            onclick: (e) => {
              openMenu(e.currentTarget, [
                { label: 'Text', checked: row.type !== 'file', onClick: () => { row.type = 'text'; row.file = null; this.render(); this.changed(true); } },
                { label: 'File', checked: row.type === 'file', onClick: () => { row.type = 'file'; row.value = ''; this.render(); this.changed(true); } },
              ]);
            },
          },
          row.type === 'file' ? 'File' : 'Text',
          icon('chevronDown', 12)
        )
      : null;

    const desc = this.opts.description
      ? h('input.kv-input', {
          value: row.description || '',
          placeholder: '',
          spellcheck: 'false',
          dataset: { row: row.id, field: 'description' },
          oninput: (e) => {
            row.description = e.target.value;
            this.changed(false);
          },
        })
      : null;

    const del = h('button.icon-btn.kv-del', { title: '삭제', onclick: () => this.removeRow(row) }, icon('x', 14));
    const rowEl = h(
      'div.kv-row' + (row.enabled ? '' : '.disabled'),
      h('div.kv-cell.kv-check', cb),
      h('div.kv-cell.kv-key', keyIn.el, typeToggle),
      h('div.kv-cell.kv-val', valueCell),
      this.opts.description ? h('div.kv-cell.kv-desc', desc) : null,
      h('div.kv-cell.kv-act', del)
    );
    return rowEl;
  }

  fileCell(row) {
    const inp = h('input', { type: 'file', style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > MAX_FILE) {
        toast(`파일이 너무 큽니다 (최대 ${formatBytes(MAX_FILE)}).`, 'error');
        return;
      }
      row.file = { name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: await readFileAsDataURL(f) };
      this.render();
      this.changed(true);
    });
    const label = row.file && !row.file.missing
      ? h('span.file-chip', icon('file', 13), h('span', row.file.name), h('span.muted', formatBytes(row.file.size)))
      : row.file && row.file.missing
      ? h('span.file-chip.missing', icon('alert', 13), h('span', row.file.name + ' (다시 선택 필요)'))
      : h('span.muted', '선택된 파일 없음');
    return h('div.file-cell', h('button.btn.btn-sm', { onclick: () => inp.click() }, '파일 선택'), label, inp);
  }

  renderNewRow() {
    // 새 행: 입력을 시작하면 실제 행으로 전환. 한글(IME) 조합 중에는 전환을 미뤄 글자가 깨지지 않게 한다.
    const inputs = {};
    let materialized = false;
    const materialize = (field, focusField) => {
      if (materialized) return;
      const v = inputs[field].value;
      if (v === '') return;
      materialized = true;
      const row = kvRow('', '', true, this.opts.files ? { type: 'text', file: null } : {});
      for (const f of Object.keys(inputs)) row[f] = inputs[f].value;
      this.rows.push(row);
      this.render(focusField ? { rowId: row.id, field: focusField } : null);
      this.changed(true);
    };
    const mk = (field, ph) => {
      const inp = h('input.kv-input.kv-new', { placeholder: ph, spellcheck: 'false', autocomplete: 'off', dataset: { field } });
      if (field === 'key' && this.opts.keyList) inp.setAttribute('list', this.opts.keyList);
      let composing = false;
      inp.addEventListener('compositionstart', () => (composing = true));
      inp.addEventListener('compositionend', () => (composing = false));
      inp.addEventListener('input', (e) => {
        if (e.isComposing || composing) return; // 조합 중: blur/Enter 시 전환
        materialize(field, field);
      });
      inp.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && inp.value !== '') {
          e.preventDefault();
          const next = e.key === 'Tab' ? (field === 'key' ? 'value' : field === 'value' && this.opts.description ? 'description' : field) : field;
          materialize(field, next);
        }
      });
      inp.addEventListener('blur', (e) => {
        if (inp.value === '') return;
        const rt = e.relatedTarget;
        const nextField = rt && rt.classList && rt.classList.contains('kv-new') && this.el.contains(rt) ? rt.dataset.field : null;
        setTimeout(() => materialize(field, nextField), 0);
      });
      inputs[field] = inp;
      return inp;
    };
    return h(
      'div.kv-row.kv-newrow',
      h('div.kv-cell.kv-check'),
      h('div.kv-cell.kv-key', mk('key', this.opts.keyPlaceholder)),
      h('div.kv-cell.kv-val', mk('value', this.opts.valuePlaceholder)),
      this.opts.description ? h('div.kv-cell.kv-desc', mk('description', 'Description')) : null,
      h('div.kv-cell.kv-act')
    );
  }

  refreshMaster() {
    const cell = this.el.querySelector('.kv-head .kv-check');
    if (cell) {
      clear(cell);
      if (this.rows.length) cell.appendChild(this.masterCheckbox());
    }
  }

  removeRow(row) {
    const i = this.rows.indexOf(row);
    if (i >= 0) this.rows.splice(i, 1);
    this.render();
    this.changed(true);
  }

  toggleBulk() {
    if (this.bulkMode && this._bulkTa) this.applyBulk(this._bulkTa.value);
    this.bulkMode = !this.bulkMode;
    this.render();
  }

  renderBulk() {
    const text = this.rows
      .filter((r) => r.type !== 'file')
      .map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`)
      .join('\n');
    const ta = h('textarea.bulk-ta', { spellcheck: 'false', placeholder: 'Key:Value 형식으로 한 줄에 하나씩 입력\n// 로 시작하면 비활성화됩니다' });
    ta.value = text;
    ta.addEventListener('input', () => {
      this.applyBulk(ta.value, true);
    });
    this._bulkTa = ta;
    setTimeout(() => ta.focus(), 0);
    return h('div.bulk-wrap', ta);
  }

  applyBulk(text, silent) {
    const files = this.rows.filter((r) => r.type === 'file');
    const old = this.rows.filter((r) => r.type !== 'file');
    const parsed = String(text)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line, i) => {
        let enabled = true;
        let l = line;
        if (l.trim().startsWith('//')) {
          enabled = false;
          l = l.trim().slice(2);
        }
        const ci = l.indexOf(':');
        const key = (ci >= 0 ? l.slice(0, ci) : l).trim();
        const value = ci >= 0 ? l.slice(ci + 1).trim() : '';
        const prev = old[i];
        return {
          id: prev ? prev.id : uid('kv'),
          key,
          value,
          enabled,
          description: prev && prev.key === key ? prev.description || '' : '',
          ...(this.opts.files ? { type: 'text', file: null } : {}),
        };
      });
    const arr = this.rows;
    arr.splice(0, arr.length, ...parsed, ...files);
    this.changed(true);
    if (!silent) this.render();
  }
}

// 헤더 이름 자동완성 목록
export const COMMON_HEADERS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Connection',
  'Content-Disposition', 'Content-Encoding', 'Content-Language', 'Content-Type', 'Cookie', 'Date', 'DNT', 'Expect',
  'Forwarded', 'From', 'If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Range', 'If-Unmodified-Since',
  'Origin', 'Pragma', 'Range', 'Referer', 'TE', 'User-Agent', 'Upgrade', 'Via', 'Warning', 'X-Api-Key',
  'X-Correlation-ID', 'X-CSRF-Token', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Request-ID',
  'X-Requested-With', 'Access-Control-Request-Headers', 'Access-Control-Request-Method',
];

export const HEADER_VALUES = {
  'content-type': ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'text/html', 'application/xml', 'text/xml', 'application/octet-stream', 'application/javascript', 'application/json; charset=utf-8'],
  accept: ['*/*', 'application/json', 'text/html', 'application/xml', 'text/plain', 'application/json, text/plain, */*'],
  'cache-control': ['no-cache', 'no-store', 'max-age=0', 'must-revalidate'],
  'accept-encoding': ['gzip, deflate, br', 'identity'],
  'accept-language': ['ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7', 'en-US,en;q=0.9'],
  authorization: ['Bearer {{token}}', 'Basic '],
  connection: ['keep-alive', 'close'],
  'x-requested-with': ['XMLHttpRequest'],
};

export function ensureDatalists() {
  if (document.getElementById('dl-headers')) return;
  const dl = h('datalist#dl-headers', COMMON_HEADERS.map((x) => h('option', { value: x })));
  document.body.appendChild(dl);
  for (const [k, vals] of Object.entries(HEADER_VALUES)) {
    document.body.appendChild(h('datalist#dl-hv-' + k, vals.map((x) => h('option', { value: x }))));
  }
}

export function headerValueList(key) {
  const k = String(key || '').toLowerCase().trim();
  return HEADER_VALUES[k] ? 'dl-hv-' + k : null;
}
