// 최소 CDP 클라이언트 + Chromium 실행기 (Node 24 전역 WebSocket 사용)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { findChromium } from '../lib/chromium.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChromium({ extPath, userDataDir, port, headless = true }) {
  const exe = findChromium();
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extPath}`,
    `--disable-extensions-except=${extPath}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--window-size=1280,900',
    headless ? '--headless=new' : '',
    'about:blank'
  ].filter(Boolean);
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch (_) { /* 아직 */ }
  }
  if (!wsUrl) { try { proc.kill(); } catch (_) {} throw new Error('Chromium 디버깅 포트에 연결하지 못했습니다'); }
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  return { proc, cdp };
}

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
        return;
      }
      for (const l of this.listeners) { try { l(msg); } catch (_) { /* noop */ } }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method}: 시간 초과`)); }
      }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((x) => x !== fn); }; }
  waitFor(pred, ms = 10000) {
    return new Promise((res, rej) => {
      const off = this.on((m) => { if (pred(m)) { off(); clearTimeout(t); res(m); } });
      const t = setTimeout(() => { off(); rej(new Error('이벤트 대기 시간 초과')); }, ms);
    });
  }
  close() { try { this.ws.close(); } catch (_) { /* noop */ } }
}

/* 세션 하나에서 식을 평가하고 값을 돌려준다 */
export async function evaluate(cdp, sessionId, expression, { contextId } = {}) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  if (contextId) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('평가 실패: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
}
