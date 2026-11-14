import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const gamepadSource = fs.readFileSync(new URL('../js/gamepad-input.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../js/stream-guest.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(lossless = true) {
  const events = new Map(), documentEvents = new Map(), intervals = [], sent = [], pcs = [], receivers = [], painted = [];
  const media = [], timeouts = new Map(), rafs = [];
  let clock = 1000, nextTimeout = 1;
  const listenable = map => ({
    addEventListener(name, fn) { map.set(name, fn); },
    removeEventListener(name, fn) { if (map.get(name) === fn) map.delete(name); },
  });
  const socket = {
    connected: false, handlers: {},
    on(name, fn) { this.handlers[name] = fn; return this; },
    once(name, fn) { return this.on(name, fn); }, timeout() { return this; },
    emit(name, data, cb) {
      sent.push({ name, data });
      if (name === 'join-room') {
        this.fire('users-updated', { host: { userid: 'host', socketId: 'host-socket' }, guest: { userid: 'guest', socketId: 'guest-socket' } });
        cb(null, null);
      }
    },
    connect() { this.connected = true; this.fire('connect'); },
    disconnect() { this.connected = false; this.fire('disconnect'); },
    fire(name, data) { this.handlers[name]?.(data); },
  };
  const context = {
    ...listenable(events),
    document: { ...listenable(documentEvents), hidden: false, getElementById: () => null,
      createElement(tag) {
        assert(['video', 'audio'].includes(tag), 'receiver never creates an emulator loader');
        const el = { videoWidth: 512, videoHeight: 448, readyState: 2, srcObject: null,
          play: () => Promise.resolve(), pause() { this.paused = true; } };
        media.push(el); return el;
      } },
    crypto: { randomUUID: () => 'guest' }, performance: { now: () => clock },
    location: { host: 'localhost', protocol: 'https:' }, navigator: { getGamepads: () => [] },
    setTimeout(fn, ms) { const id = nextTimeout++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { intervals.push(fn); return 1; }, clearInterval() {},
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length; }, cancelAnimationFrame() {},
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    RTCPeerConnection: class {
      constructor() { this.connectionState = 'new'; this.remoteDescription = null; this.candidates = []; pcs.push(this); }
      async setRemoteDescription(d) { this.remoteDescription = d; }
      async addIceCandidate(d) { this.candidates.push(d); }
      async createAnswer() { return { type: 'answer', sdp: 'standalone' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    },
    io: () => socket,
    StreamPixels: { LABEL: 'nes-frame-v1', supported: () => lossless,
      createPresenter() { return { stats: { presented: 0 }, queueIndexed(f) { painted.push(f); },
        drawVideo() { painted.push('video'); }, relayout() {}, stop() {} }; },
      PixelReceiver: class {
        constructor(channel, deliver) { this.channel = channel; this.deliver = deliver; this.stats = { decoded: 0, bytes: 0 }; receivers.push(this); }
        hello() { this.channel.send('hello'); } poll() { this.polled = (this.polled || 0) + 1; } message() {} close() { this.closed = true; }
      },
    },
  };
  context.window = context;
  vm.runInNewContext(gamepadSource, context);
  vm.runInNewContext(source, context);
  const status = {}, streamStatus = {};
  const guest = context.StreamGuest.create({ canvas: {}, statusEl: status, streamStatusEl: streamStatus, signalingUrl: 'http://localhost' });
  return { context, guest, socket, status, streamStatus, sent, events, documentEvents, pcs, receivers, painted, media, timeouts, rafs,
    advance(ms) { clock += ms; },
    tick() { intervals.forEach(fn => fn()); },
    offer() { socket.fire('webrtc-signal', { sender: 'host-socket', offer: { type: 'offer', sdp: 'host' } }); },
  };
}
const room = { code: 'ABCDE', streamSessionId: 'session', gameId: 123, aspect: 1.3, iceServers: [] };
const channel = label => ({ label, readyState: 'open', bufferedAmount: 0, sent: [], send(data) { this.sent.push(data); }, close() {} });

test('standalone guest joins using signaling metadata with no emulator or ROM access', async () => {
  const f = fixture();
  await f.guest.connect(room);
  assert.equal(f.guest.joined, true);
  assert.equal(f.context.EJS_emulator, undefined);
  assert.equal(f.sent.find(e => e.name === 'join-room').data.extra.game_id, 123);
  f.socket.fire('webrtc-signal', { sender: 'stranger', offer: {} });
  assert.equal(f.pcs.length, 0);
  f.socket.fire('webrtc-signal', { sender: 'host-socket', candidate: { candidate: 'early' } });
  f.offer(); await flush();
  assert.equal(f.pcs.length, 1, 'early ICE is retained on the first offered connection');
  assert.equal(f.pcs[0].candidates[0].candidate, 'early');
  assert.equal(f.sent.filter(e => e.name === 'webrtc-signal' && e.data.answer).length, 1);
  f.guest.close();
});

test('keyboard and gamepad send complete snapshots; blur releases all held buttons', async () => {
  const f = fixture(); await f.guest.connect(room); f.offer(); await flush();
  const fast = channel('nes-input-state-v1'); f.pcs[0].ondatachannel({ channel: fast });
  f.events.get('keydown')({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(JSON.parse(fast.sent.at(-1)).buttons[7], 1);
  f.events.get('keydown')({ code: 'KeyP', preventDefault() {} });
  assert.equal(JSON.parse(fast.sent.at(-1)).buttons[11], 1, 'arcade sixth action key');
  f.events.get('keyup')({ code: 'KeyP', preventDefault() {} });
  assert.equal(JSON.parse(fast.sent.at(-1)).buttons[11], 0);
  f.context.navigator.getGamepads = () => [{ index: 0, id: 'Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)', connected: true,
    buttons: [{}, { pressed: true }, {}, {}, {}, { pressed: true }], axes: [0, -1] }];
  f.tick();
  const pressed = JSON.parse(fast.sent.at(-1)).buttons;
  assert.equal(pressed[8], 1, 'Joy-Con right face button is A');
  assert.equal(pressed[3], 1, 'Joy-Con SR is Start');
  assert.equal(pressed[4], 1, 'Joy-Con stick up is Up');
  f.events.get('blur')(); f.tick();
  assert(Object.values(JSON.parse(fast.sent.at(-1)).buttons).every(v => v === 0));
  const packetCount = fast.sent.length;
  f.events.get('keydown')({ code: 'KeyK', target: { tagName: 'INPUT' }, preventDefault() {} });
  assert.equal(fast.sent.length, packetCount, 'editing controls cannot press game buttons');
  f.guest.close();
});

test('reliable fallback preserves independently held keys mapping to the same button', async () => {
  const f = fixture(); await f.guest.connect(room); f.offer(); await flush();
  const reliable = channel('inputs'); f.pcs[0].ondatachannel({ channel: reliable });
  for (const code of ['ShiftLeft', 'ShiftRight']) f.events.get('keydown')({ code, preventDefault() {} });
  f.events.get('keyup')({ code: 'ShiftLeft', preventDefault() {} });
  const packets = () => reliable.sent.map(JSON.parse).filter(p => p.index === 2);
  assert.equal(packets().at(-1).value, 1);
  f.events.get('keyup')({ code: 'ShiftRight', preventDefault() {} });
  assert.deepEqual(packets().at(-1), { player: 1, index: 2, value: 0 });
  f.guest.close();
});

test('arcade guest enables P2 coin without changing NES keyboard behavior', async () => {
  const f = fixture(); await f.guest.connect({...room, rom:{name:'game.zip',platform:'arcade'}}); f.offer(); await flush();
  const fast = channel('nes-input-state-v1'); f.pcs[0].ondatachannel({ channel: fast });
  f.events.get('keydown')({ code: 'KeyQ', preventDefault() {} });
  assert.equal(JSON.parse(fast.sent.at(-1)).buttons[2], 1);
  f.events.get('keyup')({ code: 'KeyQ', preventDefault() {} });
  assert.equal(JSON.parse(fast.sent.at(-1)).buttons[2], 0);
  f.guest.close();
  const nes = fixture(); await nes.guest.connect(room); nes.offer(); await flush();
  const nesFast = channel('nes-input-state-v1'); nes.pcs[0].ondatachannel({ channel: nesFast });
  const before = nesFast.sent.length;
  nes.events.get('keydown')({ code: 'KeyQ', preventDefault() {} });
  assert.equal(nesFast.sent.length, before, 'Q is not a NES coin shortcut');
  nes.guest.close();
});

test('renegotiation disposes previous media and ignores its late decoded frames and ICE', async () => {
  const f = fixture(); await f.guest.connect(room); f.offer(); await flush();
  const previous = f.pcs[0], frame = channel('nes-frame-v1'); previous.ondatachannel({ channel: frame });
  previous.ontrack({ track: { kind: 'audio' }, receiver: {} });
  assert.equal(f.media[1].srcObject.tracks[0].kind, 'audio');
  f.offer(); await flush();
  assert.equal(previous.connectionState, 'closed');
  assert.equal(f.receivers[0].closed, true);
  assert.equal(f.media[1].srcObject, null);
  f.receivers[0].deliver({ id: 1, width: 256, height: 224 });
  previous.onicecandidate({ candidate: { candidate: 'late' } });
  assert.equal(f.painted.length, 0);
  assert(!f.sent.some(e => e.data?.candidate?.candidate === 'late'));
  f.guest.close();
});

test('unsupported lossless decoding keeps the video fallback without sending a hello', async () => {
  const f = fixture(false); await f.guest.connect(room); f.offer(); await flush();
  const frame = channel('nes-frame-v1'); f.pcs[0].ondatachannel({ channel: frame });
  f.pcs[0].ontrack({ track: { kind: 'video' }, receiver: {} });
  assert.equal(frame.sent.length, 0);
  assert.deepEqual(f.painted, ['video']);
  f.guest.close();
});

test('replacement stops the guest and input listeners; P1 departure also terminates reception', async () => {
  for (const reason of ['room-replaced', 'users-updated']) {
    const f = fixture(); await f.guest.connect(room); f.offer(); await flush();
    f.socket.fire(reason, reason === 'users-updated' ? { guest: { userid: 'guest', socketId: 'guest-socket' } } : undefined);
    assert.equal(f.guest.joined, false);
    assert.equal(f.socket.connected, false);
    assert.equal(f.events.size, 0);
    assert.match(f.status.textContent, reason === 'room-replaced' ? /已被新的 P2 替换/ : /P1 已离开/);
    assert.equal(f.context.__streamDebug.getState().joined, false);
  }
});

test('transient disconnected state skips renegotiation when frames are flowing; failed state retries immediately', async () => {
  const f = fixture(); await f.guest.connect(room); f.offer(); await flush();
  const pc = f.pcs[0], frame = channel('nes-frame-v1');
  pc.ondatachannel({ channel: frame });
  pc.ontrack({ track: { kind: 'video' }, receiver: {} });
  f.painted.length = 0;

  // Deliver a lossless pixel frame so pixel streaming is active.
  f.receivers[0].stats.decoded = 1;
  f.receivers[0].deliver({ id: 1, width: 256, height: 224 });
  assert.equal(f.painted.length, 1);

  // 50ms timer invokes receiver.poll().
  f.tick();
  assert.equal(f.receivers[0].polled, 1);

  // During short jitter keep the lossless frame instead of showing an older video frame.
  f.advance(500);
  f.rafs.at(-1)?.();
  assert.equal(f.painted.includes('video'), false, 'short pixel jitter must not overwrite the lossless canvas');

  // A still-open channel does not prove that the delta chain is making progress.
  // Once no new frame has arrived for a second, the video fallback may take over.
  f.advance(1500);
  f.rafs.at(-1)?.();
  assert.equal(f.painted.includes('video'), true, 'stalled pixel stream falls back to video');

  // WebRTC enters transient "disconnected", but a frame arrives 1200ms later (before the 1500ms check).
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  const disconnectTimers = () => [...f.timeouts.values()].filter(t => t.ms === 1500);
  assert.equal(disconnectTimers().length, 1);
  f.advance(1200);
  f.receivers[0].deliver({ id: 2, width: 256, height: 224 });
  f.advance(300);
  disconnectTimers()[0].fn();
  assert.equal(f.sent.filter(e => e.data?.requestRenegotiate).length, 0, 'active data flow suppresses false-positive renegotiation');

  // Now no frames arrive for another 1500ms while still disconnected -> renegotiates.
  f.advance(1500);
  disconnectTimers()[0].fn();
  assert.equal(f.sent.filter(e => e.data?.requestRenegotiate).length, 1, 'stalled disconnected peer renegotiates');

  // Hard "failed" state retries immediately without waiting for a timer.
  f.advance(2000);
  pc.connectionState = 'failed';
  pc.onconnectionstatechange();
  assert.equal(f.sent.filter(e => e.data?.requestRenegotiate).length, 2, 'failed state triggers immediate renegotiation');
  f.guest.close();
});
