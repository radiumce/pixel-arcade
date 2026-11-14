// Exercise native-frame recovery from a real WebGL canvas and the lossless loopback, without the site or CDN.
// The scene imitates RetroArch: a 256×224 checkerboard texture drawn with NEAREST filtering into a pillarboxed,
// non-integer-scaled viewport. Both grab paths are covered: the preserved WebGL buffer (normal case, hook
// installed before the context exists) and native canvas capture (context created before the hook).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pixels = fs.readFileSync(new URL('../js/stream-pixels.js', import.meta.url), 'utf8');
const netplay = fs.readFileSync(new URL('../js/stream-netplay.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'] });

async function scene(page, size) {
  await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'ejs_canvas';
    canvas.width = w; canvas.height = h;
    document.body.appendChild(canvas);
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: false });
    const W = 256, H = 224, aspect = 1.3061224;
    const program = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x, -p.y) * 0.5 + 0.5; gl_Position = vec4(p, 0, 1); }'],
      [gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }']]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(program, s);
    }
    gl.linkProgram(program); gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    const texels = new Uint8Array(W * H * 4);
    window.frameNo = 0;
    const render = () => {
      const on = frameNo % 2 ? [216, 40, 0] : [252, 252, 252];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        texels.set((x + y) % 2 ? [0, 0, 0, 255] : [...on, 255], (y * W + x) * 4);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      // RetroArch viewport: centred pillarbox, or top-aligned when height-limited (GL origin is bottom-left).
      const cw = canvas.width, ch = canvas.height;
      const vw = cw / ch > aspect ? Math.round(ch * aspect) : cw, vh = cw / ch > aspect ? ch : Math.round(cw / aspect);
      gl.viewport(Math.round((cw - vw) / 2), ch - vh, vw, vh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frameNo++;
      window.renderFrame = requestAnimationFrame(render);
    };
    render();
    window.emu = { isNetplay: true, frontend: { canvas },
      gameManager: { getFrameNum: () => frameNo, functions: {},
        getVideoDimensions: type => ({ width: W, height: H, aspect })[type] },
      netplay: { owner: true, players: { guest: { socketId: "guest" } }, peerConnections: {}, roomJoined() {}, leaveRoom() { emu.isNetplay = false; },
        initWebRTCStream() { this.localStream = emu.frontend.canvas.captureStream(30); return Promise.resolve(); },
        createPeerConnection(id) {
          const pc = new RTCPeerConnection({ iceServers: [] });
          this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
          this.peerConnections[id] = { pc };
          return pc;
        } } };
  }, size);
}

try {
  for (const direct of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent('<div id="streamStatus"></div><div id="parent" style="position:relative;width:900px;height:600px"></div>');
    if (direct) await page.addScriptTag({ content: pixels }); // Hook first: the context will be preserved.
    await scene(page, [800, 600]);
    if (!direct) await page.addScriptTag({ content: pixels }); // Hook too late: native capture path.
    await page.addScriptTag({ content: netplay });
    await page.evaluate(async () => {
      StreamNetplay.attach(emu);
      await emu.netplay.initWebRTCStream();
      const host = emu.netplay.createPeerConnection('guest');
      const guest = window.guestPc = new RTCPeerConnection({ iceServers: [] });
      host.onicecandidate = e => e.candidate && guest.addIceCandidate(e.candidate);
      guest.onicecandidate = e => e.candidate && host.addIceCandidate(e.candidate);
      // Guest side: lossless receiver + presenter on its own canvas.
      const display = window.display = document.createElement('canvas');
      display.style.position = 'absolute';
      document.querySelector('#parent').appendChild(display);
      const presenter = window.presenter = StreamPixels.createPresenter(() => display);
      window.video = document.createElement('video');
      video.muted = true;
      guest.ontrack = e => { video.srcObject = e.streams[0]; video.play().catch(() => {}); };
      guest.ondatachannel = e => {
        if (e.channel.label !== StreamPixels.LABEL) return;
        window.frames = e.channel;
        const receiver = window.receiver = new StreamPixels.PixelReceiver(e.channel, f => presenter.queueIndexed(f));
        e.channel.onmessage = m => receiver.message(m.data);
        e.channel.onopen = () => receiver.hello();
      };
      await host.setLocalDescription(await host.createOffer());
      await guest.setRemoteDescription(host.localDescription);
      await guest.setLocalDescription(await guest.createAnswer());
      await host.setRemoteDescription(guest.localDescription);
      window.score = () => {
        const kx = display.width / 256, ky = display.height / 224;
        const d = display.getContext('2d').getImageData(0, 0, display.width, display.height).data;
        const on = new Set(), off = new Set();
        let bad = 0;
        for (let y = 0; y < 224; y++) for (let x = 0; x < 256; x++) {
          const i = (Math.floor((y + 0.5) * ky) * display.width + Math.floor((x + 0.5) * kx)) * 4;
          const bright = d[i] + d[i + 1] + d[i + 2] > 150;
          if (bright !== ((x + y) % 2 === 0)) bad++;
          (bright ? on : off).add(d.slice(i, i + 3).join());
        }
        return { bad, on: on.size, off: off.size, kx, ky };
      };
    });
    await page.waitForFunction(() => window.receiver?.stats.decoded > 60 && presenter.stats.presented > 30, null, { timeout: 20000 });
    const lossless = await page.evaluate(() => ({ score: score(), state: __streamDebug.getState(),
      presenter: { ...presenter.stats }, css: [display.style.width, display.style.height] }));
    await page.waitForFunction(() => __streamDebug.getState()?.pixel?.capture);
    const capture = await page.evaluate(() => __streamDebug.getState().pixel.capture);
    assert.equal(capture.mode, direct ? 'webgl-direct' : 'canvas-capture');
    assert.equal(lossless.score.bad, 0, 'checkerboard recovered and delivered exactly');
    assert.equal(lossless.score.on, 1);
    assert.equal(lossless.score.off, 1);
    assert.deepEqual([lossless.score.kx, lossless.score.ky], [4, 3], 'integer pre-scale for a 784×600 box');
    // Host resized to a portrait canvas: the top-aligned viewport must still be recovered exactly.
    await page.evaluate(() => { emu.frontend.canvas.width = 500; emu.frontend.canvas.height = 700; });
    await page.waitForTimeout(500);
    const portrait = await page.evaluate(() => score());
    assert.equal(portrait.bad, 0, 'exact after resize to a portrait host canvas');
    // Guest closes the lossless channel: the host resumes the 2x VP8 fallback video.
    await page.evaluate(() => frames.close());
    await page.waitForFunction(() => video.videoWidth === 512 && video.videoHeight === 448 && video.readyState >= 2, null, { timeout: 15000 });
    await page.waitForTimeout(1000);
    const fallback = await page.evaluate(() => {
      presenter.drawVideo(video, 1.3061224);
      const sender = Object.values(emu.netplay.peerConnections)[0].pc.getSenders().find(s => s.track?.kind === 'video');
      return { score: score(), active: sender.getParameters().encodings[0].active };
    });
    assert.equal(fallback.active, true);
    assert(fallback.score.bad < 256 * 224 * 0.01, `fallback keeps the checkerboard (${fallback.score.bad} bad)`);
    await page.evaluate(() => { StreamNetplay.reset(); cancelAnimationFrame(renderFrame); guestPc.close(); });
    console.log(`PASS: ${capture.mode} → lossless exact (resize exact), 2x fallback bad=${fallback.score.bad}`);
    await page.close();
  }
} finally {
  await browser.close();
}
