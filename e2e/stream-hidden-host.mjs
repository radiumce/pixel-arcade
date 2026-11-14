// Regression: the stream host keeps running while its window is really hidden (minimized), e.g. when
// P2 goes fullscreen on the same computer. Playwright emulates page focus/visibility, so the host is
// the system Chrome driven over raw CDP (a small window opens and is minimized); the guest is a normal
// headless Playwright page. Requires the local site and CDN access; generates its own NROM.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detailRom } from './generated-rom.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:8765';
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nes-hidden-host-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--window-size=800,600', 'about:blank'], { stdio: 'ignore' });

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waits = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  };
  const ready = new Promise(r => { ws.onopen = r; });
  return {
    ready, close: () => ws.close(),
    send: (method, params = {}) => new Promise((res, rej) => {
      const n = ++id;
      waits.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
  };
}

const guestBrowser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
const guest = await guestBrowser.newPage();
let page, browser, saved;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); }
  }
  const target = targets.find(t => t.type === 'page');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  page = cdp(target.webSocketDebuggerUrl);
  browser = cdp(version.webSocketDebuggerUrl);
  await page.ready; await browser.ready;
  const evaluate = async expr => (await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expr, ms = 120000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evaluate(expr)) return; } catch {} await sleep(250); }
    throw new Error('timeout: ' + expr);
  };

  const form = new FormData();
  form.append('file', new Blob([detailRom]), 'netplay-detail-' + Date.now() + '.nes');
  saved = await (await fetch(base + '/api/upload', { method: 'POST', body: form })).json();
  assert.equal(saved.ok, true);
  await page.send('Page.navigate', { url: base + '/online.html' });
  await waitFor('!!document.querySelector("#btnCreate")');
  await evaluate('document.querySelector("#btnCreate").click()');
  await waitFor('location.pathname === "/online-stream.html" && !!document.querySelector("#romList li")');
  const code = await evaluate('new URL(location.href).searchParams.get("room")');
  await guest.goto(base + '/online.html');
  await guest.fill('#joinCode', code);
  await Promise.all([guest.waitForURL('**/online-stream.html?**'), guest.click('#btnJoin')]);
  await evaluate(`[...document.querySelectorAll('#romList li')].find(li => li.textContent.includes(${JSON.stringify(saved.name)}))
    .querySelectorAll('button').forEach(b => { if (b.textContent.trim() === '启动') b.click(); })`);
  await guest.waitForFunction(() => window.__streamDebug?.getState()?.pixel?.active &&
    __streamDebug.getState().peers.some(p => p.pixel?.decoded > 60 && p.inputTransport === 'unreliable-state'),
  null, { timeout: 120000 });

  const sample = async label => {
    const g0 = await guest.evaluate(() => __streamDebug.getState().pixel.presenter.presented);
    const h0 = await evaluate('({ f: EJS_emulator.gameManager.getFrameNum(), v: document.visibilityState })');
    const t0 = Date.now();
    await sleep(3000);
    const g1 = await guest.evaluate(() => __streamDebug.getState().pixel.presenter.presented);
    const h1 = await evaluate('EJS_emulator.gameManager.getFrameNum()');
    const s = (Date.now() - t0) / 1000;
    const result = { visibility: h0.v, hostFps: +((h1 - h0.f) / s).toFixed(1), guestFps: +((g1 - g0) / s).toFixed(1) };
    console.log(label, JSON.stringify(result));
    return result;
  };
  await sample('host visible  ');
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: target.id });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(1500);
  const hidden = await sample('host minimized');
  assert.equal(hidden.visibility, 'hidden', 'the host page must really be hidden for this test');
  assert(hidden.hostFps > 55, 'hidden host keeps emulating at full speed');
  assert(hidden.guestFps > 55, 'P2 keeps receiving every frame while the host is hidden');

  await evaluate(`(() => {
    window.inputLog = [];
    const fn = EJS_emulator.gameManager.functions.simulateInput;
    EJS_emulator.gameManager.functions.simulateInput = (...a) => { inputLog.push(a); return fn(...a); };
  })()`);
  await guest.evaluate(() => streamGuest.setButton(7, 1));
  await sleep(300);
  await guest.evaluate(() => streamGuest.setButton(7, 0));
  await sleep(300);
  const inputs = await evaluate('inputLog.filter(v => v[0] === 1 && v[1] === 7).map(v => v[2])');
  assert.deepEqual(inputs.slice(0, 2), [1, 0], 'P2 input reaches the hidden host');
  console.log('hidden ticker', JSON.stringify(await evaluate('window.__nesHiddenTicker.stats')));

  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await sleep(1000);
  const restored = await sample('host restored ');
  assert.equal(restored.visibility, 'visible');
  assert(restored.hostFps > 55 && restored.guestFps > 55, 'normal rAF pacing after the window is restored');
  console.log('PASS: hidden stream host keeps running and accepts P2 input');
} finally {
  try {
    if (typeof saved !== 'undefined' && saved?.name) {
      await fetch(base + '/api/roms/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saved.name }),
      }).catch(() => {});
    }
  } catch {}
  page?.close(); browser?.close();
  await guestBrowser.close();
  chrome.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000).unref();
}
