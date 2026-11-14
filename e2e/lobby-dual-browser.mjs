// Stream-only lobby: code-based joins, an independent guest, and removed endpoints.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.env.BASE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', channel: process.env.CHROME_CHANNEL || undefined });
const host = await browser.newPage(), guest = await browser.newPage();
try {
  // An already-running older backend requires an explicit mode in create requests.
  await host.route('**/api/lobby/create', async route => {
    if (route.request().postDataJSON()?.mode !== 'stream') {
      await route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'mode 必须是 stream 或 sync' }) });
      return;
    }
    await route.continue();
  });
  await host.goto(base + '/online.html');
  assert.equal(await host.locator('input[name=mode], #delayFrames').count(), 0);
  await Promise.all([host.waitForURL('**/online-stream.html?**'), host.click('#btnCreate')]);
  const code = new URL(host.url()).searchParams.get('room');
  await guest.goto(base + '/online.html');
  await guest.fill('#joinCode', code);
  await Promise.all([guest.waitForURL('**/online-stream.html?**'), guest.click('#btnJoin')]);
  assert.equal(new URL(guest.url()).searchParams.get('role'), 'guest');
  await guest.waitForFunction(() => document.querySelector('#status').textContent.includes('等待 P1'));
  assert.equal(await guest.locator('[data-host-only]:visible').count(), 0);
  assert.equal(await guest.evaluate(() => typeof EJS_emulator), 'undefined');
  assert.equal((await fetch(base + '/sync.html')).status, 404);
  const removed = await fetch(base + '/api/lobby/create', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'sync' }) });
  assert.equal(removed.status, 400);
  fs.mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true });
  await host.screenshot({ path: new URL('./artifacts/lobby-host.png', import.meta.url).pathname });
  await guest.screenshot({ path: new URL('./artifacts/lobby-guest.png', import.meta.url).pathname });
  console.log('PASS: stream-only lobby; P2 waits without loading an emulator; removed mode is unavailable');
} finally { await browser.close(); }
