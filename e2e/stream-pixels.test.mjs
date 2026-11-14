import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../js/stream-pixels.js', import.meta.url), 'utf8'));
const P = globalThis.StreamPixels;
const W = 256, H = 224;

// A deterministic NES-like frame: 1-pixel checkerboard, a moving "sprite" and text-like strokes.
function image(t = 0, colors = [[0, 0, 0], [252, 252, 252], [216, 40, 0], [0, 120, 248]]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = (x + y) & 1;
    if (x >= 40 + t && x < 56 + t && y >= 100 && y < 116) c = 2 + ((x ^ y) & 1);
    if (y === 20 && x % 3 === 0) c = 3;
    const i = (y * W + x) * 4;
    [data[i], data[i + 1], data[i + 2]] = colors[c];
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
const rgbaFromIndices = (palette, indices) => {
  const out = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((v, i) => { out.set([palette[v * 3], palette[v * 3 + 1], palette[v * 3 + 2], 255], i * 4); });
  return out;
};
function channelPair({ drop = () => false } = {}) {
  const a = { readyState: 'open', bufferedAmount: 0, sent: [], addEventListener() {} };
  const b = { readyState: 'open', bufferedAmount: 0, sent: [], addEventListener() {} };
  a.send = m => { a.sent.push(m); if (!drop(m)) b.deliver?.(m); };
  b.send = m => { b.sent.push(m); if (!drop(m)) a.deliver?.(m); };
  return [a, b];
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('key and block-delta frames round-trip bit-exactly and deltas are small', async () => {
  const palette = new P.Palette();
  const frames = [image(0), image(1)].map(img => {
    const indices = new Uint8Array(W * H);
    assert.equal(palette.index(img.data, indices), true);
    return { img, indices };
  });
  const rgb = palette.snapshot();
  const key = await P.encodeFrame({ id: 1, width: W, height: H, aspect: 8 / 7 * W / H, palette: rgb, indices: frames[0].indices });
  const delta = await P.encodeFrame({ id: 2, ref: 1, width: W, height: H, aspect: 1.3, palette: rgb,
    indices: frames[1].indices, refIndices: frames[0].indices });
  assert(key.bytes < 4000, `checkerboard key frame should deflate well (${key.bytes} B)`);
  assert(delta.bytes < key.bytes, 'delta smaller than key');
  assert(delta.stats.copyBlocks > 0);
  assert(delta.stats.rawBlocks > 0);
  const asm = new P.FrameAssembler();
  const k = asm.push(key.chunks[0].buffer);
  assert.equal(k.ref, null);
  const kd = await P.decodeFrame(k, null);
  assert.deepEqual(rgbaFromIndices(kd.palette, kd.indices), frames[0].img.data);
  const d = asm.push(delta.chunks[0].buffer);
  assert.equal(d.ref, 1);
  assert(Math.abs(d.aspect - 1.3) < 1e-3);
  const dd = await P.decodeFrame(d, kd.indices);
  assert.deepEqual(rgbaFromIndices(dd.palette, dd.indices), frames[1].img.data);
});

test('exact motion and dictionary commands compress horizontal scrolling', async () => {
  function scrolling(shift) {
    const img = image();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = (x - shift + W * 4) % W;
      const color = (Math.imul(sx + y * W + 17, 1103515245) >>> 29) & 3;
      const i = (y * W + x) * 4;
      img.data.set([[0, 0, 0], [252, 252, 252], [216, 40, 0], [0, 120, 248]][color], i);
    }
    return img;
  }
  for (const shift of [3, 8]) {
    const palette = new P.Palette();
    const frames = [scrolling(0), scrolling(shift)].map(img => {
      const indices = new Uint8Array(W * H);
      palette.index(img.data, indices);
      return { img, indices };
    });
    const rgb = palette.snapshot();
    const key = await P.encodeFrame({ id: 1, width: W, height: H, aspect: 1.3, palette: rgb, indices: frames[0].indices });
    const delta = await P.encodeFrame({ id: 2, ref: 1, width: W, height: H, aspect: 1.3, palette: rgb,
      indices: frames[1].indices, refIndices: frames[0].indices });
    assert(delta.stats.motionBlocks + delta.stats.dictionaryBlocks > 500, 'scrolling reuses shifted or repeated tiles');
    assert(delta.bytes < key.bytes * 0.5, `shift ${shift}: ${delta.bytes} B versus key ${key.bytes} B`);
    const asm = new P.FrameAssembler();
    const packet = asm.push(delta.chunks[0]);
    const decoded = await P.decodeFrame(packet, frames[0].indices);
    assert.deepEqual(rgbaFromIndices(decoded.palette, decoded.indices), frames[1].img.data);
  }
});

test('ragged frame edges and malformed block commands are handled safely', async () => {
  const width = 37, height = 19;
  const img = image();
  const source = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    source.data.set(img.data.subarray((y * W + x) * 4, (y * W + x + 1) * 4), (y * width + x) * 4);
  }
  const palette = new P.Palette(), indices = new Uint8Array(width * height);
  palette.index(source.data, indices);
  const encoded = await P.encodeFrame({ id: 1, width, height, aspect: 1, palette: palette.snapshot(), indices });
  const packet = new P.FrameAssembler().push(encoded.chunks[0]);
  assert.deepEqual((await P.decodeFrame(packet, null)).indices, indices);
  const referenceCopy = await P.encodeFrame({ id: 2, ref: 1, width, height, aspect: 1,
    palette: palette.snapshot(), indices, refIndices: indices });
  const copyPacket = new P.FrameAssembler().push(referenceCopy.chunks[0]);
  await assert.rejects(() => P.decodeFrame(copyPacket, null), /缺少参考帧/);
  const corrupt = new Uint8Array([0, 99]);
  const packed = new Uint8Array(await new Response(new Blob([corrupt]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  await assert.rejects(() => P.decodeFrame({ ...packet, width: 1, height: 1, data: packed }, null), /未知块命令/);
});

test('large frames are chunked and reassembled in any order; stale partials are discarded', async () => {
  const indices = new Uint8Array(W * H);
  let seed = 7;
  for (let i = 0; i < indices.length; i++) indices[i] = ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % 200;
  const palette = new Uint8Array(200 * 3).map((_, i) => i);
  const { chunks } = await P.encodeFrame({ id: 9, width: W, height: H, aspect: 1, palette, indices });
  assert(chunks.length > 2);
  assert(chunks.every(c => c.length <= 15020));
  const asm = new P.FrameAssembler();
  asm.push((await P.encodeFrame({ id: 5, width: W, height: H, aspect: 1, palette, indices })).chunks[0]); // partial of older frame
  const order = chunks.map((_, i) => i).reverse();
  let packet = null;
  for (const i of order) packet = asm.push(chunks[i]) || packet;
  assert.equal(asm.partial.size, 0, 'older incomplete frame dropped once a newer one completes');
  assert.deepEqual((await P.decodeFrame(packet, null)).indices, indices);
  assert.equal(asm.push(new Uint8Array([1, 2, 3])), null, 'garbage ignored');
});

test('lossy channel: guest converges via acks, key requests and repair; never shows stale frames', async () => {
  let n = 0;
  const [hostEnd, guestEnd] = channelPair({ drop: m => typeof m !== 'string' && ++n % 3 === 0 });
  const host = new P.PixelHost();
  const peer = host.attach(hostEnd);
  hostEnd.deliver = m => peer.message(m);
  const shown = [];
  const receiver = new P.PixelReceiver(guestEnd, f => shown.push(f));
  guestEnd.deliver = m => receiver.message(m);
  receiver.hello();
  assert.equal(peer.enabled, true);
  for (let t = 0; t < 30; t++) { host.frame(image(t), 1.3); await settle(); }
  for (let i = 0; i < 5; i++) { peer.lastSend = -Infinity; host.repair(); await settle(); }
  const last = shown.at(-1);
  assert.equal(last.id, host.current.id, 'latest frame delivered after repair');
  assert.deepEqual(rgbaFromIndices(last.palette, last.indices), image(29).data);
  assert(shown.every((f, i) => i === 0 || f.id > shown[i - 1].id), 'ids strictly increase');
  assert(peer.stats.keyFrames >= 1 && peer.stats.sent > peer.stats.keyFrames, 'mostly deltas');
  // Unchanged frames are not resent once acknowledged.
  const sent = peer.stats.sent;
  host.frame(image(29), 1.3); await settle();
  assert.equal(peer.stats.sent, sent);
});

test('missing reference triggers a key frame request; send buffer backlog drops instead of queueing', async () => {
  const [hostEnd, guestEnd] = channelPair();
  const host = new P.PixelHost();
  const peer = host.attach(hostEnd);
  hostEnd.deliver = m => peer.message(m);
  const receiver = new P.PixelReceiver(guestEnd, () => {});
  guestEnd.deliver = m => receiver.message(m);
  receiver.hello();
  host.frame(image(0), 1.3); await settle();
  receiver.ring.clear(); // Guest lost its reference (e.g. after an eviction).
  host.frame(image(1), 1.3); await settle(); await settle();
  assert.equal(receiver.stats.keyRequests, 1);
  host.frame(image(2), 1.3); await settle();
  assert(receiver.stats.keyFrames >= 2);
  hostEnd.bufferedAmount = 1 << 20;
  const sent = peer.stats.sent;
  host.frame(image(3), 1.3); await settle();
  assert.equal(peer.stats.sent, sent);
  assert(peer.stats.skipped > 0);
});

test('palette overflow resets once, then approximates without breaking the stream', () => {
  const palette = new P.Palette();
  const many = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  for (let i = 0; i < 1024; i++) many.data.set([i & 255, i >> 2, 7, 255], i * 4);
  const out = new Uint8Array(1024);
  assert.equal(palette.index(many.data, out), false);
  assert.equal(palette.index(many.data, out, true), true);
  assert(Math.max(...out) < 255);
  const host = new P.PixelHost();
  host.frame(image(0), 1.3);
  const epoch = host.palette.epoch;
  host.frame(many, 1);
  assert.equal(host.palette.epoch, epoch + 1);
  assert.equal(host.stats.paletteResets, 1);
  assert.equal(host.stats.approximated, 1);
});

test('viewport matches RetroArch letterboxing for wide and tall canvases', () => {
  const wide = P.viewport(798, 598, 1.3061224);
  assert(Math.abs(wide.x - 8.5) < 0.1 && wide.y === 0 && Math.abs(wide.w - 781) < 0.1);
  const tall = P.viewport(600, 900, 1.3061224);
  assert.equal(tall.x, 0);
  assert.equal(tall.w, 600);
  assert.equal(Math.abs(tall.h - 459.375) < 0.01, true);
});

test('presenter shows the newest frame even when requestAnimationFrame is paused without spinning MessageChannel', async () => {
  const output = [];
  let postMessages = 0;
  class CountingMessageChannel extends MessageChannel {
    constructor() {
      super();
      const orig = this.port2.postMessage.bind(this.port2);
      this.port2.postMessage = msg => { postMessages++; return orig(msg); };
    }
  }
  const canvas = () => ({ width: 0, height: 0, style: {}, parentElement: { clientWidth: 512, clientHeight: 448 },
    getContext: () => ({ createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData() {}, drawImage: (...args) => output.push(args) }) });
  const display = canvas();
  const context = { console, document: { createElement: canvas }, devicePixelRatio: 1,
    performance: { now: () => Date.now() }, MessageChannel: CountingMessageChannel, setTimeout, clearTimeout,
    Uint8Array, Uint8ClampedArray, Uint32Array,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  vm.runInNewContext(fs.readFileSync(new URL('../js/stream-pixels.js', import.meta.url), 'utf8'), context);
  const presenter = context.StreamPixels.createPresenter(() => display);
  const frame = id => ({ id, width: 2, height: 2, aspect: 1, palette: new Uint8Array([0, 0, 0]), indices: new Uint8Array(4) });
  presenter.queueIndexed(frame(1));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(presenter.stats.presented, 1);
  presenter.queueIndexed(frame(2));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(presenter.stats.presented, 2, 'fallback timer paints without a display refresh');
  assert(postMessages <= 4, `expected no MessageChannel spin-loop, got ${postMessages} messages`);
  presenter.stop();
  presenter.queueIndexed(frame(3));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(presenter.stats.presented, 2, 'stopped presenter releases its fallback');
});

test('long jitter exceeding ring size recovers in one sync RTT via pinned reference without keyframe flood', async () => {
  assert.deepEqual(P.CHANNEL_OPTIONS, { ordered: false, maxRetransmits: 0 });
  let blackout = false;
  const [hostEnd, guestEnd] = channelPair({ drop: () => blackout });
  const host = new P.PixelHost();
  const peer = host.attach(hostEnd);
  hostEnd.deliver = m => peer.message(m);
  const shown = [];
  const receiver = new P.PixelReceiver(guestEnd, f => shown.push(f));
  guestEnd.deliver = m => receiver.message(m);
  receiver.hello();
  host.frame(image(0), 1.3);
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(peer.acked, 1);
  assert.equal(peer.stats.keyFrames, 1);

  // Simulate >3.3s blackout (210 frames > HOST_RING=180) so frame 1 is evicted from host.ring.
  blackout = true;
  for (let t = 1; t <= 210; t++) {
    host.frame(image(t % 40), 1.3);
    await peer.flush();
  }
  assert.equal(host.ring.has(1), false, 'frame 1 evicted from rolling ring buffer');
  assert.equal(peer.ackedFrame?.id, 1, 'last acked reference frame stays pinned on peer');
  assert.equal(peer.stats.keyFrames, 1, 'no keyframe flood during blackout');

  // Network recovers; guest poll() detects stall and sends { t: "sync", ack: 1 }.
  blackout = false;
  receiver.lastMessageAt = -Infinity;
  receiver.poll();
  await settle();

  assert.equal(receiver.stats.syncRequests, 1);
  assert.equal(peer.stats.syncs, 1);
  assert.equal(peer.stats.keyFrames, 1, 'recovered using compact delta against pinned frame 1');
  assert.equal(shown.at(-1).id, host.current.id);
  assert.deepEqual(rgbaFromIndices(shown.at(-1).palette, shown.at(-1).indices), image(210 % 40).data);

  // Stale out-of-order key request with older ack watermark must be ignored.
  peer.message(JSON.stringify({ t: 'key', ack: 1 }));
  assert.equal(peer.acked, host.current.id, 'stale key request does not wipe newer acked reference');
});

test('burst of delayed delta frames after jitter skips obsolete intermediate frames', async () => {
  const [hostEnd, guestEnd] = channelPair();
  const host = new P.PixelHost();
  const peer = host.attach(hostEnd);
  hostEnd.deliver = m => peer.message(m);
  const shown = [];
  const receiver = new P.PixelReceiver(guestEnd, f => shown.push(f));
  guestEnd.deliver = m => receiver.message(m);
  receiver.hello();
  host.frame(image(0), 1.3);
  await settle();
  assert.equal(receiver.newest, 1);

  // Prepare 10 delta frames (id 2..11) all referencing frame 1, then deliver them in one synchronous burst.
  const palette = new P.Palette();
  const baseIndices = new Uint8Array(W * H);
  palette.index(image(0).data, baseIndices);
  const bursts = [];
  for (let id = 2; id <= 11; id++) {
    const indices = new Uint8Array(W * H);
    palette.index(image(id).data, indices);
    const encoded = await P.encodeFrame({
      id, ref: 1, width: W, height: H, aspect: 1.3,
      palette: palette.snapshot(), indices, refIndices: baseIndices,
    });
    bursts.push(encoded.chunks);
  }
  for (const chunks of bursts) {
    for (const chunk of chunks) receiver.message(chunk);
  }
  await settle();
  await settle();

  assert.equal(receiver.newest, 11);
  assert(receiver.stats.droppedObsolete >= 8, `expected >=8 obsolete frames skipped, got ${receiver.stats.droppedObsolete}`);
  assert.deepEqual(rgbaFromIndices(shown.at(-1).palette, shown.at(-1).indices), image(11).data);
});

test('receiver skips older ready deltas after a decoding backlog', async () => {
  const palette = new P.Palette();
  const base = new Uint8Array(W * H);
  palette.index(image(0).data, base);
  const encoded = await P.encodeFrame({ id: 1, width: W, height: H, aspect: 1.3,
    palette: palette.snapshot(), indices: base });
  const shown = [];
  const receiver = new P.PixelReceiver({ readyState: 'open', binaryType: '', send() {} }, frame => shown.push(frame));
  const decode = receiver.decode.bind(receiver);
  receiver.decode = async packet => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return decode(packet);
  };
  receiver.message(encoded.chunks[0]);
  await settle();
  for (let id = 2; id <= 8; id++) {
    const indices = new Uint8Array(W * H);
    palette.index(image(id).data, indices);
    const delta = await P.encodeFrame({ id, ref: 1, width: W, height: H, aspect: 1.3,
      palette: palette.snapshot(), indices, refIndices: base });
    for (const chunk of delta.chunks) receiver.message(chunk);
  }
  await settle();
  await settle();
  assert.equal(receiver.newest, 8);
  assert.equal(shown.at(-1).id, 8);
  assert(receiver.stats.droppedObsolete >= 3, 'obsolete backlog is discarded instead of decoded serially');
});

test('repair never emits self-referential delta and static screen pong notifies onAlive', async () => {
  let dropHostToGuest = true;
  const [hostEnd, guestEnd] = channelPair({ drop: m => dropHostToGuest && typeof m !== 'string' });
  const host = new P.PixelHost();
  const peer = host.attach(hostEnd);
  hostEnd.deliver = m => peer.message(m);
  const shown = [];
  let aliveCount = 0;
  const receiver = new P.PixelReceiver(guestEnd, f => shown.push(f));
  receiver.onAlive = () => { aliveCount++; };
  guestEnd.deliver = m => receiver.message(m);
  receiver.hello();

  // First keyframe is dropped on the wire; repair() within KEY_COOLDOWN_MS must re-send a keyframe (ref=KEY), not id===ref.
  host.frame(image(0), 1.3);
  await settle();
  assert.equal(shown.length, 0);
  dropHostToGuest = false;
  peer.lastSend = -Infinity;
  host.repair();
  await settle();
  assert.equal(shown.length, 1, 'repaired keyframe decoded without self-reference');
  assert.equal(peer.acked, 1);

  // Static screen: poll() triggers sync -> pong -> onAlive() so guest does not degrade to VP8.
  receiver.lastMessageAt = -Infinity;
  receiver.poll();
  await settle();
  assert.equal(aliveCount, 1, 'static screen pong refreshes guest liveness');

  // Proactive repair() during static screen also sends pong and keeps peer healthy when the next frame starts.
  peer.lastAckAt = -Infinity;
  peer.helloAt = -Infinity;
  peer.lastSend = -Infinity;
  host.repair();
  assert.equal(aliveCount, 2, 'proactive static repair sends pong');
  assert.equal(receiver.stats.hostCaptured, 1, 'pong carries host capture count');
  dropHostToGuest = true;
  host.frame(image(1), 1.3);
  assert.equal(peer.healthy(), true, 'peer remains healthy immediately after static screen before new ack arrives');
});
