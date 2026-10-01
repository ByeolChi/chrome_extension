// 가벼운 구문 강조 (HTML 이스케이프 포함)
import { escapeHtml } from './util.js';

function build(rules) {
  const src = rules.map(([name, re]) => `(?<${name}>${re.source})`).join('|');
  return new RegExp(src, 'g');
}

function run(re, text, classify) {
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    const g = m.groups;
    let type = null;
    for (const k in g) {
      if (g[k] !== undefined) {
        type = k;
        break;
      }
    }
    const cls = classify ? classify(type, m[0], text, re.lastIndex) : type;
    out += cls ? `<span class="tk-${cls}">${type === 'var' ? escapeHtml(m[0]) : innerVars(m[0])}</span>` : escapeHtml(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

// 문자열 토큰 안의 {{변수}} 강조
function innerVars(s) {
  if (!s.includes('{{')) return escapeHtml(s);
  return s
    .split(/(\{\{[^{}\n]*\}\})/g)
    .map((p, i) => (i % 2 ? `<span class="tk-var">${escapeHtml(p)}</span>` : escapeHtml(p)))
    .join('');
}

const VAR = /\{\{[^{}\n]*\}\}/;

const JSON_RE = build([
  ['var', VAR],
  ['str', /"(?:\\.|[^"\\\n])*"?/],
  ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ['lit', /\b(?:true|false|null)\b/],
  ['punct', /[{}\[\],:]/],
]);

export function highlightJSON(text) {
  return run(JSON_RE, text, (type, tok, full, end) => {
    if (type === 'str') {
      // 뒤에 ':' 가 오면 키
      const rest = full.slice(end, end + 40);
      return /^\s*:/.test(rest) ? 'key' : 'str';
    }
    return type;
  });
}

const XML_RE = build([
  ['var', VAR],
  ['comment', /<!--[\s\S]*?(?:-->|$)/],
  ['cdata', /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/],
  ['meta', /<[!?][^>]*>?/],
  ['tag', /<\/?[A-Za-z][\w:.-]*(?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/],
  ['entity', /&[#\w]+;/],
]);

export function highlightXML(text) {
  let out = '';
  let last = 0;
  XML_RE.lastIndex = 0;
  let m;
  while ((m = XML_RE.exec(text))) {
    if (m[0] === '') {
      XML_RE.lastIndex++;
      continue;
    }
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    const g = m.groups;
    if (g.tag) out += highlightTag(g.tag);
    else if (g.var) out += `<span class="tk-var">${escapeHtml(g.var)}</span>`;
    else if (g.comment) out += `<span class="tk-comment">${escapeHtml(g.comment)}</span>`;
    else if (g.cdata) out += `<span class="tk-str">${escapeHtml(g.cdata)}</span>`;
    else if (g.meta) out += `<span class="tk-meta">${escapeHtml(g.meta)}</span>`;
    else if (g.entity) out += `<span class="tk-lit">${escapeHtml(g.entity)}</span>`;
    last = XML_RE.lastIndex;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

function highlightTag(tag) {
  const m = tag.match(/^(<\/?)([^\s\/>]+)([\s\S]*?)(\/?>)$/);
  if (!m) return escapeHtml(tag);
  const attrs = m[3].replace(/([^\s=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s>]+)?/g, (all, name, eq, val) => {
    let s = `\u0001attr\u0002${name}\u0003`;
    if (eq) s += eq;
    if (val) s += `\u0001str\u0002${val}\u0003`;
    return s;
  });
  const esc = escapeHtml(attrs).replace(/\u0001(\w+)\u0002([\s\S]*?)\u0003/g, (_, c, v) => `<span class="tk-${c}">${v}</span>`);
  return `<span class="tk-punct">${escapeHtml(m[1])}</span><span class="tk-tag">${escapeHtml(m[2])}</span>${esc}<span class="tk-punct">${escapeHtml(m[4])}</span>`;
}

const KEYWORDS = {
  javascript: 'const let var function return if else for while do switch case break continue new try catch finally throw class extends import from export default async await of in typeof instanceof this null undefined true false require',
  python: 'import from as def return if elif else for while in not and or is None True False with open print try except finally class lambda pass raise',
  go: 'package import func return if else for range var const type struct interface map chan go defer nil true false err',
  shell: 'curl http printf echo export',
  powershell: 'New-Object Invoke-WebRequest Invoke-RestMethod Get-Item',
};

const codeCache = {};
function codeRe(lang) {
  if (codeCache[lang]) return codeCache[lang];
  const kw = (KEYWORDS[lang] || '').split(' ').filter(Boolean).map((w) => w.replace(/[-]/g, '\\-')).join('|');
  const rules = [['var', VAR]];
  if (lang === 'python') rules.push(['str', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/]);
  if (lang === 'powershell') rules.push(['str', /@'[\s\S]*?(?:'@|$)/]);
  if (lang === 'shell' || lang === 'python' || lang === 'powershell') rules.push(['comment', /#[^\n]*/]);
  else rules.push(['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/]);
  rules.push(['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`[^`]*`?/]);
  if (lang === 'shell') rules.push(['attr', /(?<=\s)--?[A-Za-z][\w-]*/]);
  if (lang === 'powershell') rules.push(['attr', /(?<=\s)-[A-Za-z]+/], ['lit', /\$[A-Za-z_]\w*/]);
  rules.push(['num', /\b\d+(?:\.\d+)?\b/]);
  if (kw) rules.push(['kw', new RegExp(`(?<![\\w-])(?:${kw})(?![\\w-])`)]);
  codeCache[lang] = build(rules);
  return codeCache[lang];
}

export function highlightCode(text, lang) {
  return run(codeRe(lang), text);
}

export function highlight(text, lang, maxBytes = 1000000) {
  const s = String(text ?? '');
  if (s.length > maxBytes) return escapeHtml(s);
  switch (lang) {
    case 'json':
      return highlightJSON(s);
    case 'xml':
    case 'html':
      return highlightXML(s);
    case 'javascript':
    case 'python':
    case 'go':
    case 'shell':
    case 'powershell':
      return highlightCode(s, lang);
    default:
      return highlightVarsOnly(s);
  }
}

export function highlightVarsOnly(s) {
  return innerVars(String(s ?? ''));
}
