// Real EmulatorJS + WebRTC smoke/fidelity probe. Requires the local site and CDN access; generates its own NROM.
// The ROM draws a 1-pixel checkerboard whose colour toggles every frame: any resampling error breaks the
// checkerboard and any dropped/duplicated frame shows up as a gap in the presented frame sequence.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.env.BASE_URL || 'http://127.0.0.1:8765';
import { detailRom } from './generated-rom.mjs';
const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || undefined, args: [
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
] });
const host = await browser.newPage();
let guest = await browser.newPage();
let saved;
const guestRequests = [];
const watchGuest = page => {
  page.on('pageerror', error => console.error('Guest page error:', error.message));
  page.on('request', request => {
  const url = request.url();
  if (/\/roms\/|cdn\.emulatorjs\.org|\.wasm(?:\?|$)|\/cores\//.test(url)) guestRequests.push(url);
  });
};
watchGuest(guest);
// Score the guest's displayed canvas: sample the centre of every console pixel.
const fidelity = page => page.evaluate(() => {
  const state = __streamDebug.getState();
  const c = streamGuest.canvas;
  const [W, H] = state.pixel.size || [Math.round(state.video.width / 2), Math.round(state.video.height / 2)];
  const kx = c.width / W, ky = c.height / H;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const on = new Set(), off = new Set();
  let bad = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (Math.floor((y + 0.5) * ky) * c.width + Math.floor((x + 0.5) * kx)) * 4;
    const bright = d[i] + d[i + 1] + d[i + 2] > 150;
    if (bright !== ((x + y) % 2 === 0)) bad++;
    (bright ? on : off).add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
  }
  const box = c.getBoundingClientRect();
  return { W, H, kx, ky, bad, badRatio: bad / (W * H), onColors: on.size, offColors: off.size,
    css: [box.width, box.height], imageRendering: getComputedStyle(c).imageRendering };
});
try {
  if (process.env.SIGNALING_URL) {
    for (const page of [host, guest]) await page.addInitScript(url => {
      window.EJS_NETPLAY_SERVER_OVERRIDE = url;
    }, process.env.SIGNALING_URL);
  }
  const form = new FormData();
  form.append('file', new Blob([detailRom]), 'netplay-detail-' + Date.now() + '.nes');
  const upload = await fetch(base + '/api/upload', { method: 'POST', body: form });
  saved = await upload.json();
  assert.equal(saved.ok, true);
  await host.goto(base + '/online.html');
  await Promise.all([host.waitForURL('**/online-stream.html?**'), host.click('#btnCreate')]);
  const code = new URL(host.url()).searchParams.get('room');
  await guest.goto(base + '/online.html');
  await guest.fill('#joinCode', code);
  await Promise.all([guest.waitForURL('**/online-stream.html?**'), guest.click('#btnJoin')]);
  assert.equal(await guest.locator('#btnTestRom').isVisible(), false);
  await guest.waitForFunction(() => document.querySelector('#status').textContent.includes('等待 P1'));
  console.log('P2 joined before P1 selected a game; waiting automatically');
  if (await host.locator('#tabBtnRoms').count()) await host.click('#tabBtnRoms');
  await host.locator('#romList li').filter({ hasText: saved.name }).getByRole('button', { name: '启动', exact: true }).click();
  await host.waitForFunction(() => window.EJS_emulator?.isNetplay, null, { timeout: 120000 });
  await guest.waitForFunction(() => window.streamGuest?.joined || document.querySelector('#status').classList.contains('error'),
    null, { timeout: 120000 });
  assert.equal(await guest.evaluate(() => streamGuest.joined), true, await guest.locator('#status').textContent());
  assert.equal(await host.evaluate(() => EJS_emulator.netplay.name), 'P1');
  assert.equal(await guest.evaluate(() => streamGuest.name), 'P2');
  console.log('Waiting for lossless frames and fast input channel');
  await guest.waitForFunction(() => window.__streamDebug?.getState()?.pixel?.active &&
    __streamDebug.getState().peers.some(p => p.pixel?.decoded > 60 && p.inputTransport === 'unreliable-state'), null, { timeout: 60000 });
  await host.evaluate(() => {
    window.inputLog = [];
    const fn = EJS_emulator.gameManager.functions.simulateInput;
    EJS_emulator.gameManager.functions.simulateInput = (...args) => { inputLog.push(args); return fn(...args); };
  });
  await guest.keyboard.down('ArrowRight');
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 1));
  await guest.keyboard.up('ArrowRight');
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 0));

  // The receiver owns media playback and screen controls without an emulator UI.
  await guest.waitForFunction(() => streamGuest.audio.srcObject?.getAudioTracks().length === 1);
  await guest.click('#btnResumeStream');
  await guest.waitForFunction(() => !streamGuest.audio.paused && streamGuest.audio.currentTime > 0);
  const audioPeak = await guest.evaluate(async () => {
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(streamGuest.audio.srcObject);
    const analyser = context.createAnalyser();
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 16));
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    source.disconnect(); await context.close();
    return peak;
  });
  assert(audioPeak > 0.01, 'the generated ROM tone reaches P2');
  console.log('P2 received audible stream; peak:', audioPeak);
  await guest.click('#btnGuestMute');
  assert.equal(await guest.evaluate(() => streamGuest.audio.muted), true);
  await guest.click('#btnGuestMute');
  assert.equal(await guest.evaluate(() => streamGuest.audio.muted), false);
  await guest.evaluate(() => {
    const volume = document.querySelector('#guestVolume');
    volume.value = '0.4'; volume.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await guest.evaluate(() => streamGuest.audio.volume), 0.4);
  await guest.click('#btnGuestFullscreen');
  await guest.waitForFunction(() => document.fullscreenElement?.id === 'gameCard');
  await guest.click('#btnGuestFullscreen');
  await guest.waitForFunction(() => !document.fullscreenElement);

  // Lossless: every console pixel exact, exactly two colours per frame, video encoder at 5 fps warm backup.
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await guest.waitForTimeout(1100);
    samples.push({ fidelity: await fidelity(guest), state: await guest.evaluate(() => __streamDebug.getState()) });
  }
  const hostState = await host.evaluate(() => __streamDebug.getState());
  const sender = await host.evaluate(() => {
    const pc = Object.values(EJS_emulator.netplay.peerConnections)[0].pc;
    const s = pc.getSenders().find(s => s.track?.kind === 'video');
    return { encodings: s.getParameters().encodings, settings: s.track.getSettings() };
  });
  for (const { fidelity: f } of samples) {
    assert.equal(f.bad, 0, 'checkerboard must survive capture, transport and scaling bit-exactly');
    assert.equal(f.onColors, 1);
    assert.equal(f.offColors, 1);
    assert.equal(Number.isInteger(f.kx) && Number.isInteger(f.ky), true, 'integer pre-scale');
  }
  assert.deepEqual([samples[0].fidelity.W, samples[0].fidelity.H], hostState.pixel.size);
  assert.equal(hostState.pixel.capture.mode, 'webgl-direct', 'host reads the preserved WebGL frame directly');
  assert.equal(sender.encodings[0].active, true, 'warm backup video stays active for a lossless guest');
  assert.equal(sender.encodings[0].maxFramerate, 5, 'video encoder throttled to 5 fps warm backup for lossless guest');
  const p0 = samples[0].state, p1 = samples.at(-1).state;
  const presented = p1.pixel.presenter.presented - p0.pixel.presenter.presented;
  const gaps = p1.pixel.presenter.gaps - p0.pixel.presenter.gaps;
  console.log(JSON.stringify({ hostCapture: hostState.pixel.capture, hostPeer: hostState.peers[0].pixel,
    guestPeer: p1.peers[0].pixel, presented, gaps, fidelity: samples.at(-1).fidelity }, null, 2));
  assert(presented > 150, 'about 60 frames per second presented');
  assert(gaps / presented < 0.1, 'per-frame changes (flicker) reach the screen');

  // Non-integer, portrait-ish host window: the viewport math must still recover exact pixels.
  await host.setViewportSize({ width: 640, height: 720 });
  await guest.waitForTimeout(1500);
  const resized = await fidelity(guest);
  assert.equal(resized.bad, 0, 'exact after host resize');
  assert.equal(resized.onColors, 1);

  fs.mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true });
  await guest.screenshot({ path: new URL('./artifacts/stream-lossless-guest.png', import.meta.url).pathname });

  // A new live guest takes P2 even when the previous page has not closed or timed out.
  const previousGuest = guest;
  await host.evaluate(() => { inputLog.length = 0; });
  await previousGuest.evaluate(() => streamGuest.setButton(7, 1));
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 1));
  const hostFrame = await host.evaluate(() => EJS_emulator.gameManager.getFrameNum());
  guest = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  watchGuest(guest);
  if (process.env.SIGNALING_URL) await guest.addInitScript(url => {
    window.EJS_NETPLAY_SERVER_OVERRIDE = url;
  }, process.env.SIGNALING_URL);
  await guest.goto(previousGuest.url());
  await previousGuest.waitForFunction(() => document.querySelector('#status').textContent.includes('已被新的 P2 替换'),
    null, { timeout: 120000 });
  assert.equal(await previousGuest.evaluate(() => streamGuest.joined), false);
  await guest.waitForFunction(() => window.__streamDebug?.getState()?.pixel?.active &&
    __streamDebug.getState().peers.some(p => p.pixel?.decoded > 60), null, { timeout: 120000 });
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 0));
  assert.equal(await host.evaluate(() => Object.keys(EJS_emulator.netplay.peerConnections).length), 1);
  assert(await host.evaluate(() => EJS_emulator.gameManager.getFrameNum()) > hostFrame, 'P1 game keeps running');
  assert.equal((await fidelity(guest)).bad, 0, 'replacement P2 receives exact frames');
  await host.evaluate(() => { inputLog.length = 0; });
  assert.equal(await guest.locator('#guestTouch').isVisible(), true);
  await guest.tap('[data-guest-button="7"]');
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 1));
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 0));
  await guest.locator('#guestTouch').scrollIntoViewIfNeeded();
  await guest.screenshot({ path: new URL('./artifacts/stream-mobile-guest.png', import.meta.url).pathname });
  await host.evaluate(() => { inputLog.length = 0; });
  await guest.evaluate(() => streamGuest.setButton(7, 1));
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 1));
  await guest.evaluate(() => streamGuest.setButton(7, 0));
  await host.waitForFunction(() => inputLog.some(v => v[0] === 1 && v[1] === 7 && v[2] === 0));

  // Video fallback (guest without CompressionStream): host resumes VP8; still pixel-aligned.
  await guest.addInitScript(() => { delete window.DecompressionStream; });
  await guest.reload();
  await guest.waitForFunction(() => window.__streamDebug?.getState()?.peers.some(p =>
    p.framesDecoded > 120 && p.inputTransport === 'unreliable-state'), null, { timeout: 120000 });
  assert.equal(await guest.evaluate(() => __streamDebug.getState().pixel.active), false);
  const fallback = await fidelity(guest);
  const fallbackSender = await host.evaluate(() => {
    const pc = Object.values(EJS_emulator.netplay.peerConnections)[0].pc;
    const s = pc.getSenders().find(s => s.track?.kind === 'video');
    return { encodings: s.getParameters().encodings, settings: s.track.getSettings() };
  });
  console.log(JSON.stringify({ fallback, fallbackSender }, null, 2));
  assert.equal(fallbackSender.encodings[0].active, true);
  assert.equal(fallbackSender.encodings[0].maxFramerate, 60);
  assert.equal(fallbackSender.settings.width, 2 * samples[0].fidelity.W, 'fallback video is the native frame at 2x');
  assert(fallback.badRatio < 0.01, 'fallback video keeps the checkerboard');
  await guest.screenshot({ path: new URL('./artifacts/stream-fallback-guest.png', import.meta.url).pathname });
  fs.writeFileSync(new URL('./artifacts/stream-latency.json', import.meta.url),
    JSON.stringify({ hostState, sender, samples, resized, fallback, fallbackSender }, null, 2));
  assert.equal(await guest.evaluate(() => streamGuest.name), 'P2');
  assert.deepEqual(guestRequests, [], 'P2 must never download ROMs, EmulatorJS or cores');
  assert.equal(await guest.evaluate(() => typeof window.EJS_emulator), 'undefined');
  console.log('PASS: standalone P2, lossless pixels, audible stream, playback controls, keyboard/touch input, live P2 replacement, resize, VP8 fallback and refresh');
} catch (error) {
  for (const page of [host, guest]) {
    console.error(await page.evaluate(() => ({ url: location.href, status: document.querySelector('#status')?.textContent,
      stream: window.__streamDebug?.getState(), frame: window.EJS_emulator?.gameManager?.getFrameNum(), text: document.body.innerText.slice(-1500) })).catch(() => 'page unavailable'));
  }
  throw error;
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
  await browser.close();
}
