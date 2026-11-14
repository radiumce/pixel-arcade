import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/stream-netplay.js', import.meta.url), 'utf8');
const pixelsSource = fs.readFileSync(new URL('../js/stream-pixels.js', import.meta.url), 'utf8');
function fixture(options = {}) {
  const calls = [], intervals = [], captures = [], captureCanvases = [], draws = [], sourceVideos = [], rawCaptures = [];
  const animationFrames = new Map(), videoFrames = new Map();
  let frameId = 0;
  let now = 0;
  const channel = () => ({ readyState: 'open', bufferedAmount: 0, sent: [], send(p) { this.sent.push(typeof p === 'string' ? JSON.parse(p) : p); } });
  const rawTrack = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const rawStream = { getTracks: () => [rawTrack], getVideoTracks: () => [rawTrack] };
  const emu = { isNetplay: true, frontend: { canvas: { width: 798, height: 598,
    captureStream(fps) { rawCaptures.push(fps); return rawStream; } } },
    gameManager: { functions: { simulateInput(...args) { calls.push(args); } },
      getVideoDimensions: type => ({ width: 256, height: 224, aspect: 1.3061224 })[type] } };
  const netplay = emu.netplay = {
    owner: true, players: { host: { socketId: 'host' }, guest: { socketId: 'guest' } }, peerConnections: {},
    updatePlayersTable() {},
    leaveRoom() { emu.isNetplay = false; this.localStream = null; },
    initWebRTCStream() {
      if (this.localStream) return Promise.resolve();
      if (options.failCapture) throw new Error('capture failed');
      this.localStream = emu.frontend.canvas.captureStream(30);
      return Promise.resolve();
    },
    createPeerConnection(id) {
      const reliable = channel();
      reliable.onmessage = e => { const d = JSON.parse(e.data); calls.push([d.player, d.index, d.value]); };
      const pc = { connectionState: 'connected', signalingState: 'stable', channels: {},
        close() { this.connectionState = 'closed'; },
        getStats: async () => new Map(), getSenders: () => [], addEventListener() {},
        createDataChannel(label, options) {
          const ch = this.channels[label] = Object.assign(channel(), { label, options });
          if (label === 'nes-input-state-v1') { this.fast = ch; this.options = options; }
          return ch;
        } };
      this.peerConnections[id] = { pc, dataChannel: reliable };
      return pc;
    },
  };
  const context = { document: {
    createElement(tag) {
      if (tag === 'video') {
        const video = { readyState: 0, videoWidth: 0, videoHeight: 0,
          play() { return Promise.resolve(); }, pause() { this.paused = true; } };
        if (!options.noVideoCallback) {
          video.requestVideoFrameCallback = f => { videoFrames.set(++frameId, f); return frameId; };
          video.cancelVideoFrameCallback = id => videoFrames.delete(id);
        }
        sourceVideos.push(video);
        return video;
      }
      assert.equal(tag, 'canvas');
      const canvas = { width: 300, height: 150, style: {},
        captureStream(fps) {
          captures.push(fps);
          this.captured = true;
          const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
          return this.stream = { getTracks: () => [track], getVideoTracks: () => [track] };
        } };
      const ctx = { imageSmoothingEnabled: true, drawImage(...args) {
        assert.notEqual(args[0], emu.frontend.canvas, 'Never sample the possibly cleared WebGL backbuffer');
        draws.push({ canvas, args, smoothing: this.imageSmoothingEnabled });
      },
      getImageData: (x, y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData() {} };
      canvas.getContext = () => ctx;
      captureCanvases.push(canvas);
      return canvas;
    },
    getElementById: id => id === "streamStatus" ? {} : null, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'https:' }, performance: { now: () => now },
    setInterval(f) { intervals.push(f); return intervals.length; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame(f) { animationFrames.set(++frameId, f); return frameId; },
    cancelAnimationFrame(id) { animationFrames.delete(id); } };
  context.AudioNode = options.AudioNode;
  context.window = context;
  vm.runInNewContext(pixelsSource, context);
  vm.runInNewContext(source, context);
  context.StreamNetplay.attach(emu);
  return { emu, netplay, calls, context, channel, captures, captureCanvases, draws, animationFrames, videoFrames,
    sourceVideos, rawCaptures, rawTrack,
    animate() {
      const pending = [...animationFrames.values(), ...videoFrames.values()];
      animationFrames.clear();
      videoFrames.clear();
      pending.forEach(f => f());
    },
    tick(ms) { now += ms; intervals.forEach(f => f()); } };
}
const packet = (seq, pressed = []) => ({ data: JSON.stringify({ seq, buttons: Object.fromEntries([0,2,3,4,5,6,7,8].map(b => [b, +pressed.includes(b)])) }) });

test('snapshots reject stale packets and recover dropped release; old reliable packets cannot override', () => {
  const f = fixture();
  const pc = f.netplay.createPeerConnection('guest');
  assert.equal(pc.options.ordered, false);
  assert.equal(pc.options.maxRetransmits, 0);
  pc.fast.onmessage(packet(1, [7]));
  assert.deepEqual(f.calls.find(c => c[1] === 7), [1, 7, 1]);
  f.calls.length = 0;
  pc.fast.onmessage(packet(3)); // seq 2 (release) was lost; periodic state repairs it.
  pc.fast.onmessage(packet(1, [7]));
  f.netplay.peerConnections.guest.dataChannel.onmessage({ data: JSON.stringify({ player: 1, index: 7, value: 1 }) });
  assert.deepEqual(f.calls, [[1, 7, 0]]);
});

test('arcade action buttons and legacy NES guest packets share the input channel', () => {
  const f = fixture();
  const pc = f.netplay.createPeerConnection('guest');
  pc.fast.onmessage({ data: JSON.stringify({ seq: 1,
    buttons: Object.fromEntries([0,1,2,3,4,5,6,7,8,9,10,11].map(b => [b, +[1,9,10,11].includes(b)])) }) });
  assert.deepEqual(f.calls.filter(c => c[2] === 1), [[1,1,1],[1,9,1],[1,10,1],[1,11,1]]);
  f.calls.length = 0;
  pc.fast.onmessage(packet(2, [7]));
  assert(f.calls.some(c => c[0] === 1 && c[1] === 1 && c[2] === 0), 'missing buttons release on legacy snapshot');
  assert.deepEqual(f.calls.find(c => c[1] === 7), [1,7,1]);
});

test('watchdog releases held keys, resumes on next snapshot and isolates replacement connections', () => {
  const f = fixture();
  const old = f.netplay.createPeerConnection('guest');
  old.fast.onmessage(packet(1, [0]));
  f.calls.length = 0;
  f.tick(501);
  assert.deepEqual(f.calls, [[1, 0, 0]]);
  old.fast.onmessage(packet(2, [0]));
  assert.deepEqual(f.calls.at(-1), [1, 0, 1]);
  old.fast.onclose();
  const pc = f.netplay.createPeerConnection('guest');
  pc.fast.onmessage(packet(1, [8]));
  f.calls.length = 0;
  old.fast.onmessage(packet(99, [7]));
  assert.equal(f.calls.length, 0);
  pc.fast.onclose();
  assert.deepEqual(f.calls, [[1, 8, 0]]);
});

test('departed P2 is closed and releases held input before a replacement starts sending', () => {
  const f = fixture();
  const old = f.netplay.createPeerConnection('guest');
  const oldReliable = f.netplay.peerConnections.guest.dataChannel;
  old.fast.onmessage(packet(1, [7]));
  f.calls.length = 0;
  f.netplay.players = { host: { socketId: 'host' }, next: { socketId: 'next' } };
  f.netplay.updatePlayersTable();
  assert.equal(old.connectionState, 'closed');
  assert.equal(f.netplay.peerConnections.guest, undefined);
  assert.deepEqual(f.calls, [[1, 7, 0]]);
  const next = f.netplay.createPeerConnection('next');
  next.fast.onmessage(packet(1, [7]));
  f.calls.length = 0;
  old.fast.onmessage(packet(99, [0]));
  oldReliable.onmessage({ data: JSON.stringify({ player: 1, index: 0, value: 1 }) });
  old.fast.onclose();
  f.netplay.updatePlayersTable();
  assert.deepEqual(f.calls, [], 'late old packets/close cannot change the replacement input');
  assert.equal(f.netplay.createPeerConnection('guest'), null, 'queued renegotiation cannot revive old P2');
  assert.equal(next.connectionState, 'connected');
});

test('host capture samples the exact game viewport at native size, feeds a 2x video and releases everything on leave', async () => {
  const f = fixture(), canvas = f.emu.frontend.canvas, capture = canvas.captureStream;
  await f.netplay.initWebRTCStream();
  // This fixture has no preserved WebGL context, so the grabber reads the native canvas capture.
  assert.deepEqual(f.rawCaptures, [60]);
  assert.deepEqual(f.captures, [0, 60], 'manual frames when requestFrame exists, else 60 fps capture');
  assert.equal(canvas.captureStream, capture);
  const output = f.captureCanvases.find(c => c.captured);
  assert.equal(f.videoFrames.size, 1);
  f.animate();
  assert.equal(f.draws.length, 0, 'Do not draw before the first source frame is available');
  Object.assign(f.sourceVideos[0], { readyState: 2, videoWidth: 798, videoHeight: 598 });
  f.animate();
  const sample = f.draws.find(d => d.args[0] === f.sourceVideos[0]);
  assert.equal(sample.smoothing, false);
  const [x, y, w, h, ...dest] = sample.args.slice(1);
  // 798×598 canvas, 1.306 aspect: RetroArch pillarboxes the game to ~781 px wide, ~8.5 px from the left.
  assert(Math.abs(x - 8.47) < 0.05 && y === 0 && Math.abs(w - 781.06) < 0.05 && h === 598);
  assert.deepEqual(dest, [0, 0, 256, 224], 'sample at the core resolution, not a fixed 256×240');
  const upscale = f.draws.filter(d => d.canvas === output).at(-1);
  assert.deepEqual(upscale.args.slice(1), [0, 0, 512, 448]);
  assert.equal(upscale.smoothing, false);
  assert.equal(output.width, 512);
  assert.equal(output.height, 448);
  Object.assign(f.sourceVideos[0], { videoWidth: 1200, videoHeight: 1152 });
  f.animate();
  const resized = f.draws.filter(d => d.args[0] === f.sourceVideos[0]).at(-1).args.slice(1);
  assert.deepEqual(resized.slice(0, 3), [0, 0, 1200], 'height-limited viewport is top aligned');
  assert(Math.abs(resized[3] - 1200 / 1.3061224) < 0.01);
  assert.equal(output.width, 512, 'host window size never changes the stream size');
  const canvases = f.captureCanvases.length;
  await f.netplay.initWebRTCStream();
  assert.equal(f.captureCanvases.length, canvases, 'Reuse the stream for new peers');
  const track = f.netplay.localStream.getVideoTracks()[0], count = f.draws.length;
  f.netplay.leaveRoom();
  assert.equal(track.readyState, 'ended');
  assert.equal(f.rawTrack.readyState, 'ended');
  assert.equal(f.sourceVideos[0].srcObject, null);
  f.animate();
  assert.equal(f.draws.length, count);
});

test('reset removes diagnostics and restores host canvas capture', async () => {
  const f = fixture(), canvas = f.emu.frontend.canvas, capture = canvas.captureStream;
  await f.netplay.initWebRTCStream();
  assert.equal(canvas.captureStream, capture);
  f.context.StreamNetplay.reset();
  assert.equal(f.context.__streamDebug, undefined);
});

test('failed upstream initialization restores capture and stops the temporary stream', () => {
  const f = fixture({ failCapture: true }), capture = f.emu.frontend.canvas.captureStream;
  assert.throws(() => f.netplay.initWebRTCStream(), /capture failed/);
  assert.equal(f.emu.frontend.canvas.captureStream, capture);
  assert.equal(f.captureCanvases.find(c => c.captured).stream.getVideoTracks()[0].readyState, 'ended');
  assert.equal(f.rawTrack.readyState, 'ended');
  const count = f.draws.length;
  f.animate();
  assert.equal(f.draws.length, count);
});

test('fallback reset cancels animation frames and stops both capture tracks', async () => {
  const f = fixture({ noVideoCallback: true });
  await f.netplay.initWebRTCStream();
  assert.equal(f.animationFrames.size, 1);
  const track = f.netplay.localStream.getVideoTracks()[0];
  f.context.StreamNetplay.reset();
  assert.equal(f.animationFrames.size, 0);
  assert.equal(track.readyState, 'ended');
});

test('lossless capture keeps the backup video source producing frames', async () => {
  const f = fixture();
  await f.netplay.initWebRTCStream();
  const pc = f.netplay.createPeerConnection('guest');
  pc.channels['nes-frame-v1'].onmessage({ data: JSON.stringify({ t: 'hello', v: f.context.StreamPixels.VERSION }) });
  const output = f.captureCanvases.find(c => c.captured);
  Object.assign(f.sourceVideos[0], { readyState: 2, videoWidth: 798, videoHeight: 598 });
  f.animate();
  const initial = f.draws.filter(d => d.canvas === output).length;
  assert.equal(initial, 1);
  f.tick(50);
  f.animate();
  assert.equal(f.draws.filter(d => d.canvas === output).length, initial, 'standby source skips redundant refreshes');
  f.tick(200);
  f.animate();
  assert.equal(f.draws.filter(d => d.canvas === output).length, initial + 1, 'standby source still emits a video frame');
});

test('sender tuning keeps a low-rate video backup for lossless guests and survives unsupported hints', async () => {
  const f = fixture();
  await f.netplay.initWebRTCStream();
  const pc = f.netplay.createPeerConnection('guest');
  assert.equal(pc.channels['nes-frame-v1'].options.ordered, false);
  const applied = [];
  let rejectLayers = true;
  pc.getSenders = () => [{ track: { kind: 'video' }, getParameters: () => ({ transactionId: 'native', encodings: [{ rid: 'original' }] }),
    async setParameters(p) {
      if (rejectLayers && p.encodings[0].scalabilityMode) throw new Error('unsupported');
      applied.push(p);
    } }];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(applied.at(-1).encodings[0].maxFramerate, 60);
  assert.equal(applied.at(-1).encodings[0].maxBitrate, 6000000);
  assert.equal(applied.at(-1).encodings[0].active, true);
  assert.equal(applied.at(-1).encodings[0].scalabilityMode, undefined, 'retried without the unsupported hint');
  assert.equal(applied.at(-1).degradationPreference, 'maintain-resolution');
  rejectLayers = false;
  f.netplay.adjustVideoBitrate(pc, true);
  await flush();
  assert.equal(applied.at(-1).encodings[0].maxFramerate, 60);
  assert.equal(applied.at(-1).encodings[0].maxBitrate, 2500000);
  assert.equal(applied.at(-1).encodings[0].rid, 'original');
  assert.equal(applied.at(-1).encodings[0].scaleResolutionDownBy, 1);
  assert.equal(applied.at(-1).encodings[0].scalabilityMode, 'L1T1');
  // A lossless handshake keeps a warm safety net instead of removing all video frames.
  pc.channels['nes-frame-v1'].onmessage({ data: JSON.stringify({ t: 'hello', v: f.context.StreamPixels.VERSION }) });
  await flush();
  assert.equal(applied.at(-1).encodings[0].active, true);
  assert.equal(applied.at(-1).encodings[0].maxFramerate, 5);
  assert.equal(applied.at(-1).encodings[0].maxBitrate, 250000);
  pc.channels['nes-frame-v1'].onclose();
  await flush();
  assert.equal(applied.at(-1).encodings[0].active, true, 'video stays active when the lossless channel closes');
  assert.equal(applied.at(-1).encodings[0].maxFramerate, 60, 'video resumes full rate without a lossless channel');
});

test('replacement releases old state once; late close cannot release new held buttons', () => {
  const f = fixture();
  const old = f.netplay.createPeerConnection('guest');
  old.fast.onmessage(packet(1, [7]));
  // Upstream requestRenegotiate deletes peerConnections[sender] before calling createPeerConnection(sender).
  delete f.netplay.peerConnections.guest;
  const replacement = f.netplay.createPeerConnection('guest');
  assert.equal(old.connectionState, 'closed', 'replaced peer is closed even when upstream deleted peerConnections entry first');
  replacement.fast.onmessage(packet(1, [7]));
  f.calls.length = 0;
  old.fast.onclose();
  assert.equal(f.calls.length, 0);
});


test('RWebAudio stereo output is streamed without altering local audio and is released on reset', () => {
  class AudioNode {
    constructor(context, channels) { this.context = context; this.buffer = { numberOfChannels: channels }; this.connections = []; }
    connect(destination) { this.connections.push(destination); return destination; }
  }
  const original = AudioNode.prototype.connect, outputs = [];
  const audioContext = { state: 'running', destination: {}, resume: () => Promise.resolve(),
    createMediaStreamDestination() {
      const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
      const output = { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
      outputs.push(output); return output;
    } };
  const f = fixture({ AudioNode });
  const mono = new AudioNode(audioContext, 1);
  mono.connect(audioContext.destination);
  assert.equal(outputs.length, 0, 'unrelated mono sources are not captured');
  const stereo = new AudioNode(audioContext, 2);
  assert.equal(stereo.connect(audioContext.destination), audioContext.destination);
  assert.equal(stereo.connections[0], audioContext.destination, 'local output preserved');
  assert.equal(stereo.connections[1], outputs[0]);
  assert.equal(f.netplay._captureHostAudio(), outputs[0].stream);
  stereo.connect(audioContext.destination);
  assert.equal(stereo.connections.filter(c => c === outputs[0]).length, 1, 'no duplicate stream connection');
  outputs[0].stream.getAudioTracks()[0].stop();
  assert.equal(f.netplay._captureHostAudio(), outputs[1].stream, 'capture can restart after leaving');
  const next = new AudioNode(audioContext, 2);
  next.connect(audioContext.destination);
  assert.equal(next.connections[1], outputs[1]);
  f.context.StreamNetplay.reset();
  assert.equal(AudioNode.prototype.connect, original);
  assert.equal(outputs[1].stream.getAudioTracks()[0].readyState, 'ended');
});

test('LobbySession.connectStream suppresses Left room on connection error and retries after health check', async () => {
  const lobbySource = fs.readFileSync(new URL('../js/lobby-session.js', import.meta.url), 'utf8');
  const hudMessages = [], fetches = [];
  let attempts = 0;
  const ctx = {
    URLSearchParams, AbortSignal,
    location: { search: '?room=TEST5&role=host', replace() {} },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    fetch: async url => { fetches.push(url); return { ok: true, json: async () => ({ ok: true }) }; },
    setTimeout: (fn, ms) => { if (ms < 1000) fn(); return 1; },
    clearTimeout() {},
  };
  ctx.window = ctx;
  vm.runInNewContext(lobbySource, ctx);

  const emu = {
    frontend: { displayMessage(msg) { hudMessages.push(msg); } },
    netplay: {
      extra: { sessionid: 'sess-123' },
      roomJoined() {},
      showJoinErrorDialog() {},
      leaveRoom() { emu.frontend.displayMessage('Left room'); },
      openRoom() {
        attempts++;
        if (attempts === 1) {
          emu.frontend.displayMessage('Connect error: xhr poll error');
        } else {
          this.roomJoined();
        }
      },
    },
  };

  const sessionId = await ctx.LobbySession.connectStream(emu);
  assert.equal(sessionId, 'sess-123');
  assert.equal(attempts, 2);
  assert.deepEqual(fetches, ['/api/netplay-health']);
  assert.deepEqual(hudMessages, [], 'Left room must not be displayed when cleaning up a failed openRoom');
});
