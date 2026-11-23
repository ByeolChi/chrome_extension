// 시험용 로컬 서버: 정적 페이지(두 포트 = 서로 다른 출처) + 가짜 LLM 엔드포인트
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');

export const llm = {
  delayMs: 0,
  requests: [],
  reply: null   // (body) => string (assistant content)
};

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let json = null;
      try { json = JSON.parse(body); } catch (_) { /* noop */ }
      llm.requests.push(json);
      await new Promise((r) => setTimeout(r, llm.delayMs));
      let content = '[]';
      try { content = llm.reply ? llm.reply(json) : '[]'; } catch (e) { console.error('가짜 LLM 응답 오류:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET' });
    res.end();
    return;
  }
  // SPA: /spa/ 아래 모든 경로는 spa.html
  let file = u.pathname === '/' ? '/a.html' : u.pathname;
  if (file.startsWith('/spa')) file = '/spa.html';
  const p = path.join(SITE, path.normalize(file).replace(/^([/\\])+/, ''));
  if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}

export function startServers(ports) {
  return Promise.all(ports.map((port) => new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  })));
}
