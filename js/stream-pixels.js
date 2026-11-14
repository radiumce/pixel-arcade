/* Lossless NES frame streaming for LAN play.
 *
 * Host: read the emulator's own WebGL frame (kept readable with
 * preserveDrawingBuffer), sample the exact game viewport at the centre of every
 * console pixel to recover the core's native frame, convert it to palette
 * indices, then codes it as exact block commands against a frame the guest has
 * acknowledged: unchanged blocks, shifted blocks, dictionary tiles or raw data.
 * Frames travel over an unordered, partially reliable DataChannel: a lost frame
 * is never waited for; the next frame is simply coded against the last
 * acknowledged one. Guest: inflate, rebuild the frame bit-exactly, present at
 * most one frame per display refresh (so 30 Hz sprite flicker survives
 * network jitter) and scale with integer nearest-neighbour + a final smooth
 * fit ("sharp bilinear"), which keeps every console pixel the same size.
 */
(function (global) {
  "use strict";
  const LABEL = "nes-frame-v1";
  // Unordered, zero-retransmit datagrams: no SCTP head-of-line blocking or T3-rtx
  // backoff stall after jitter; lost frames are superseded by the next delta/repair.
  const CHANNEL_OPTIONS = { ordered: false, maxRetransmits: 0 };
  const MAGIC = 0x4e, VERSION = 2, HEADER = 20, CHUNK = 15000, KEY = 0xffffffff;
  const BLOCK = 8, MOTION_RANGE = 32;
  const CMD_COPY = 0, CMD_DICTIONARY = 1, CMD_MOTION = 2, CMD_RAW = 3;
  const ASPECT_SCALE = 10000, MAX_PALETTE = 255, HOST_RING = 180, GUEST_RING = 180;
  const SEND_BUFFER_LIMIT = 48 * 1024, REPAIR_MS = 40, KEY_REQUEST_MS = 60, KEY_COOLDOWN_MS = 120;
  const HELLO_MS = 250, SYNC_STALL_MS = 60, SYNC_INTERVAL_MS = 50, MAX_IN_FLIGHT = 4;
  const VIDEO_UPSCALE = 2; // fallback video: one console pixel = one 2x2 chroma block
  const now = () => (global.performance ? global.performance.now() : Date.now());

  // ---------------------------------------------------------------- capture
  // Must run before EmulatorJS creates its WebGL context (load this script
  // first). Only the emulator canvas is affected.
  const glContexts = new WeakMap();
  (function preserveEmulatorFrames() {
    const proto = global.HTMLCanvasElement && global.HTMLCanvasElement.prototype;
    if (!proto || !proto.getContext || proto.getContext.nesPreserve) return;
    const original = proto.getContext;
    const patched = function (type, attrs) {
      const emulator = /^(webgl2?|experimental-webgl)$/.test(type) &&
        !!(this.classList && this.classList.contains("ejs_canvas"));
      const ctx = original.call(this, type, emulator ? Object.assign({}, attrs, { preserveDrawingBuffer: true }) : attrs);
      if (emulator && ctx) glContexts.set(this, ctx);
      return ctx;
    };
    patched.nesPreserve = true;
    proto.getContext = patched;
  })();

  function readable(canvas) {
    try { return !!glContexts.get(canvas)?.getContextAttributes()?.preserveDrawingBuffer; } catch (_) { return false; }
  }

  function coreGeometry(emu) {
    const dims = type => {
      try { return Number(emu?.gameManager?.getVideoDimensions(type)) || 0; } catch (_) { return 0; }
    };
    let width = Math.round(dims("width")), height = Math.round(dims("height"));
    if (!(width >= 64 && width <= 1024 && height >= 64 && height <= 1024)) { width = 256; height = 240; }
    let aspect = dims("aspect");
    if (!(aspect > 0.25 && aspect < 4)) aspect = width / height;
    return { width, height, aspect };
  }

  // RetroArch letterboxes the core output inside the canvas: centred
  // horizontally, and top-aligned when height-limited (video_top_portrait_viewport).
  function viewport(sw, sh, aspect) {
    if (sw / sh > aspect) {
      const w = sh * aspect;
      return { x: (sw - w) / 2, y: 0, w, h: sh };
    }
    return { x: 0, y: 0, w: sw, h: sw / aspect };
  }

  // A macrotask that, unlike setTimeout, is not clamped to 1 Hz in hidden pages.
  const afterFrame = (() => {
    let channel = null;
    const queue = [];
    return fn => {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.unref?.();
        channel.port2.unref?.();
        channel.port1.onmessage = () => { const job = queue.shift(); if (job && !job.cancelled) job.fn(); };
      }
      const job = { fn, cancelled: false, cancel() { this.cancelled = true; } };
      queue.push(job);
      channel.port2.postMessage(0);
      return job;
    };
  })();

  /* Browsers stop requestAnimationFrame in hidden or fully occluded windows (another app or a
   * fullscreen window on top, e.g. P2 fullscreen on the same Mac). The emulator's main loop runs on
   * rAF, so the host game - and with it the stream and P2's input - would freeze. While the page is
   * hidden and isActive() holds:
   *  - pending rAF callbacks are run from a dedicated worker's 60 Hz ticks instead (worker timers
   *    and message events are not background-throttled);
   *  - the "hidden" visibilitychange event is stopped at window (capture phase) before it reaches
   *    document: EmulatorJS's RetroArch listens for it there and drops every main-loop iteration
   *    while it believes the page is hidden (platform_emscripten_should_drop_iter).
   * Visible pages keep using the native rAF unchanged; the "visible" event is never stopped. */
  function keepRunningWhenHidden(isActive) {
    if (global.__nesHiddenTicker) return global.__nesHiddenTicker;
    if (typeof Worker !== "function" || typeof Blob !== "function") return null;
    let worker = null;
    try {
      const source = "let h=null;onmessage=e=>{clearInterval(h);h=e.data>0?setInterval(()=>postMessage(0),e.data):null}";
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    } catch (_) { return null; }
    const nativeRAF = global.requestAnimationFrame.bind(global);
    const nativeCAF = global.cancelAnimationFrame.bind(global);
    const pending = new Map();
    let nextId = 1e9; // never collides with native ids requested before installation
    const stats = { hiddenFrames: 0, hiddenEventsStopped: 0 };
    global.requestAnimationFrame = function (callback) {
      const id = nextId++;
      const entry = { callback, native: 0 };
      entry.native = nativeRAF(t => { if (pending.get(id) === entry) { pending.delete(id); callback(t); } });
      pending.set(id, entry);
      return id;
    };
    global.cancelAnimationFrame = function (id) {
      const entry = pending.get(id);
      if (entry) { pending.delete(id); nativeCAF(entry.native); } else nativeCAF(id);
    };
    // Fine 4 ms ticks, flushed on a 60 Hz schedule: low jitter, exact average rate.
    const FRAME_MS = 1000 / 60;
    let nextDue = 0;
    worker.onmessage = () => {
      if (!document.hidden || !isActive()) return;
      const t = now();
      if (t < nextDue) return;
      nextDue = t - nextDue > 4 * FRAME_MS ? t + FRAME_MS : nextDue + FRAME_MS;
      const due = [...pending.values()];
      pending.clear();
      stats.hiddenFrames++;
      for (const entry of due) {
        nativeCAF(entry.native);
        try { entry.callback(t); } catch (error) { setTimeout(() => { throw error; }); }
      }
    };
    const sync = () => worker.postMessage(document.hidden ? 4 : 0);
    global.addEventListener("visibilitychange", event => {
      sync();
      if (document.hidden && isActive()) {
        stats.hiddenEventsStopped++;
        event.stopImmediatePropagation();
      }
    }, true);
    sync();
    return (global.__nesHiddenTicker = { stats, sync });
  }

  /** Calls onFrame(ImageData, aspect) once per new emulator frame at native resolution. */
  function createGrabber(emu, onFrame) {
    const canvas = emu.frontend.canvas;
    const direct = readable(canvas);
    let video = null, rawStream = null;
    if (!direct) {
      // Fallback: browser-native canvas capture always contains a complete frame.
      rawStream = canvas.captureStream(60);
      video = document.createElement("video");
      video.muted = true; video.autoplay = true; video.playsInline = true;
      video.srcObject = rawStream;
      video.play().catch(() => {});
    }
    const work = document.createElement("canvas");
    const ctx = work.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("无法创建 NES 采样画布");
    const stats = { mode: direct ? "webgl-direct" : "canvas-capture", frames: 0, grabMs: null };
    let running = true, raf = null, timer = null, vfc = null, lastFrame = null;
    const frameNumber = () => { try { return emu.gameManager.getFrameNum(); } catch (_) { return null; } };
    function grab() {
      const sw = direct ? canvas.width : video.videoWidth;
      const sh = direct ? canvas.height : video.videoHeight;
      if (!sw || !sh || (!direct && video.readyState < 2)) return;
      const started = now();
      const g = coreGeometry(emu);
      if (work.width !== g.width || work.height !== g.height) { work.width = g.width; work.height = g.height; }
      const v = viewport(sw, sh, g.aspect);
      // Nearest-neighbour from the exact viewport samples the centre of each
      // console pixel, so a non-integer host scale still yields the native frame.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(direct ? canvas : video, v.x, v.y, v.w, v.h, 0, 0, g.width, g.height);
      const image = ctx.getImageData(0, 0, g.width, g.height);
      stats.frames++;
      stats.grabMs = stats.grabMs == null ? now() - started : stats.grabMs * 0.9 + (now() - started) * 0.1;
      onFrame(image, g.aspect);
    }
    function schedule() {
      if (!running) return;
      if (direct) {
        // The task runs after every rAF callback of this refresh, i.e. after the
        // emulator rendered; the preserved buffer is still readable then.
        raf = requestAnimationFrame(() => {
          raf = null;
          timer = afterFrame(() => {
            timer = null;
            if (!running) return;
            const n = frameNumber();
            if (n == null || n !== lastFrame) { lastFrame = n; try { grab(); } catch (_) {} }
            schedule();
          });
        });
      } else if (typeof video.requestVideoFrameCallback === "function") {
        vfc = video.requestVideoFrameCallback(() => { vfc = null; try { grab(); } catch (_) {} schedule(); });
      } else {
        raf = requestAnimationFrame(() => { raf = null; try { grab(); } catch (_) {} schedule(); });
      }
    }
    schedule();
    return {
      stats,
      stop() {
        running = false;
        if (raf != null) cancelAnimationFrame(raf);
        if (timer != null) timer.cancel();
        if (vfc != null && video) video.cancelVideoFrameCallback(vfc);
        if (video) { video.pause(); video.srcObject = null; }
        rawStream?.getTracks().forEach(track => track.stop());
      },
    };
  }

  // ---------------------------------------------------------------- palette
  class Palette {
    constructor() { this.reset(); this.epoch = 0; this.resetAt = -Infinity; }
    reset() {
      this.map = new Map(); this.rgb = new Uint8Array(MAX_PALETTE * 3); this.size = 0;
      this.epoch = (this.epoch || 0) + 1; this.resetAt = now();
    }
    nearest(color) {
      let best = 0, bestDistance = Infinity;
      const r = color & 255, g = (color >> 8) & 255, b = (color >> 16) & 255;
      for (let i = 0; i < this.size; i++) {
        const dr = this.rgb[i * 3] - r, dg = this.rgb[i * 3 + 1] - g, db = this.rgb[i * 3 + 2] - b;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
      return best;
    }
    /** Writes palette indices; returns false when the palette is full. */
    index(rgba, out, approximate = false) {
      const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
      let last = -1, lastIndex = 0;
      for (let i = 0; i < pixels.length; i++) {
        const color = pixels[i] & 0xffffff;
        if (color !== last) {
          let index = this.map.get(color);
          if (index === undefined) {
            if (this.size < MAX_PALETTE) {
              index = this.size++;
              this.rgb[index * 3] = color & 255;
              this.rgb[index * 3 + 1] = (color >> 8) & 255;
              this.rgb[index * 3 + 2] = (color >> 16) & 255;
              this.map.set(color, index);
            } else if (approximate) {
              index = this.nearest(color); // Not cached: the exact colour may get a slot after a reset.
              this.approximated = true;
            } else {
              return false;
            }
          }
          last = color; lastIndex = index;
        }
        out[i] = lastIndex;
      }
      return true;
    }
    snapshot() { return this.rgb.slice(0, this.size * 3); }
  }

  // ------------------------------------------------------------------ codec
  const supported = () => typeof global.CompressionStream === "function" &&
    typeof global.DecompressionStream === "function" &&
    typeof global.Response === "function" && typeof global.Blob === "function";
  async function transform(bytes, Stream) {
    const stream = new global.Blob([bytes]).stream().pipeThrough(new Stream("deflate-raw"));
    return new Uint8Array(await new global.Response(stream).arrayBuffer());
  }

  function stripHash(a, start) {
    const w0 = a[start] | (a[start + 1] << 8) | (a[start + 2] << 16) | (a[start + 3] << 24);
    const w1 = a[start + 4] | (a[start + 5] << 8) | (a[start + 6] << 16) | (a[start + 7] << 24);
    return (Math.imul(w0 ^ 0x811c9dc5, 0x01000193) ^ Math.imul(w1, 0x85ebca6b)) | 0;
  }

  function hashBlock(indices, width, x, y, bw, bh) {
    if (bw === BLOCK && bh === BLOCK) {
      let hash = 0x811c9dc5 | 0, start = y * width + x;
      for (let row = 0; row < BLOCK; row++, start += width) {
        hash = Math.imul(hash ^ stripHash(indices, start), 0x01000193);
      }
      return hash >>> 0;
    }
    let hash = 0x811c9dc5;
    for (let row = 0; row < bh; row++) {
      const start = (y + row) * width + x;
      for (let col = 0; col < bw; col++) hash = Math.imul(hash ^ indices[start + col], 0x01000193);
    }
    return hash >>> 0;
  }

  function blockEqual(a, b, width, ax, ay, bx, by, bw, bh) {
    let ai = ay * width + ax, bi = by * width + bx;
    if (bw === BLOCK) {
      for (let row = 0; row < bh; row++, ai += width, bi += width) {
        if (a[ai] !== b[bi] || a[ai + 1] !== b[bi + 1] || a[ai + 2] !== b[bi + 2] || a[ai + 3] !== b[bi + 3] ||
            a[ai + 4] !== b[bi + 4] || a[ai + 5] !== b[bi + 5] || a[ai + 6] !== b[bi + 6] || a[ai + 7] !== b[bi + 7]) {
          return false;
        }
      }
      return true;
    }
    for (let row = 0; row < bh; row++, ai += width, bi += width) {
      for (let col = 0; col < bw; col++) if (a[ai + col] !== b[bi + col]) return false;
    }
    return true;
  }

  function copyBlock(dst, src, width, x, y, sx, sy, bw, bh) {
    for (let row = 0; row < bh; row++) {
      const from = (sy + row) * width + sx, to = (y + row) * width + x;
      dst.set(src.subarray(from, from + bw), to);
    }
  }

  /* Both peers derive this state solely from an acknowledged reference frame.
   * Hash buckets only locate candidates; every emitted copy is byte-verified.
   * Dictionary and motion tables are built lazily into flat typed arrays so
   * unchanged frames pay zero indexing cost and moving frames avoid GC churn. */
  const DICT_BUCKETS = 2048, DICT_MASK = DICT_BUCKETS - 1;
  const MOTION_BUCKETS = 8192, MOTION_MASK = MOTION_BUCKETS - 1;

  function buildReference(indices, width, height) {
    const cached = referenceCache.get(indices);
    if (cached && cached.width === width && cached.height === height) return cached;
    const columns = Math.floor(width / BLOCK), rows = Math.floor(height / BLOCK);
    let dictHead = null, dictNext = null;
    let motionHead = null, motionNext = null, stripHashes = null, stripReady = null, rowIndexed = null;
    function ensureDict() {
      if (dictHead) return;
      dictHead = new Int16Array(DICT_BUCKETS).fill(-1);
      dictNext = new Int16Array(columns * rows).fill(-1);
      for (let ry = 0; ry < rows; ry++) {
        const y = ry * BLOCK;
        for (let rx = 0; rx < columns; rx++) {
          const x = rx * BLOCK, id = ry * columns + rx;
          const b = hashBlock(indices, width, x, y, BLOCK, BLOCK) & DICT_MASK;
          let cur = dictHead[b], prev = -1, dup = false;
          while (cur !== -1) {
            const ox = (cur % columns) * BLOCK, oy = Math.floor(cur / columns) * BLOCK;
            if (blockEqual(indices, indices, width, x, y, ox, oy, BLOCK, BLOCK)) { dup = true; break; }
            prev = cur; cur = dictNext[cur];
          }
          if (!dup) {
            if (prev === -1) dictHead[b] = id;
            else dictNext[prev] = id;
          }
        }
      }
    }
    function ensureMotionRows(minY, maxY) {
      if (!motionHead) {
        motionHead = new Int32Array(MOTION_BUCKETS).fill(-1);
        motionNext = new Int32Array(width * height);
        stripHashes = new Int32Array(width * height);
        stripReady = new Uint8Array(height);
        rowIndexed = new Uint8Array(height);
      }
      const maxX = width - BLOCK;
      if (maxX < 0) return;
      const stripEnd = Math.min(height - 1, maxY + BLOCK - 1);
      for (let r = minY; r <= stripEnd; r++) {
        if (stripReady[r]) continue;
        stripReady[r] = 1;
        const rowOff = r * width;
        for (let x = 0; x <= maxX; x++) stripHashes[rowOff + x] = stripHash(indices, rowOff + x);
      }
      for (let sy = minY; sy <= maxY; sy++) {
        if (rowIndexed[sy]) continue;
        rowIndexed[sy] = 1;
        for (let sx = maxX; sx >= 0; sx--) {
          if (!(sx % BLOCK) && !(sy % BLOCK)) continue; // Grid-aligned blocks are already in dictionary.
          let h = 0x811c9dc5 | 0, off = sy * width + sx;
          for (let r = 0; r < BLOCK; r++, off += width) {
            h = Math.imul(h ^ stripHashes[off], 0x01000193);
          }
          const b = (h >>> 0) & MOTION_MASK;
          const pos = sy * width + sx;
          motionNext[pos] = motionHead[b];
          motionHead[b] = pos;
        }
      }
    }
    const reference = {
      indices, width, height, columns, rows,
      ensureDict, ensureMotionRows,
      get dictHead() { return dictHead; },
      get dictNext() { return dictNext; },
      get motionHead() { return motionHead; },
      get motionNext() { return motionNext; },
    };
    referenceCache.set(indices, reference);
    return reference;
  }
  const referenceCache = new WeakMap();

  function dictionaryMatch(ref, indices, x, y, hash = hashBlock(indices, ref.width, x, y, BLOCK, BLOCK)) {
    if (!ref.columns || !ref.rows) return -1;
    ref.ensureDict();
    for (let id = ref.dictHead[hash & DICT_MASK]; id !== -1; id = ref.dictNext[id]) {
      const sx = (id % ref.columns) * BLOCK, sy = Math.floor(id / ref.columns) * BLOCK;
      if (blockEqual(indices, ref.indices, ref.width, x, y, sx, sy, BLOCK, BLOCK)) return id;
    }
    return -1;
  }

  function motionMatch(ref, indices, x, y, bw, bh, hash = hashBlock(indices, ref.width, x, y, bw, bh)) {
    const maxX = ref.width - bw, maxY = ref.height - bh;
    if (maxX < 0 || maxY < 0) return null;
    const minY = Math.max(0, y - MOTION_RANGE), hiY = Math.min(maxY, y + MOTION_RANGE);
    ref.ensureMotionRows(minY, hiY);
    let bestX = -1, bestY = -1, distance = Infinity, steps = 0;
    for (let pos = ref.motionHead[hash & MOTION_MASK]; pos !== -1 && steps < 96; pos = ref.motionNext[pos]) {
      const sy = Math.floor(pos / ref.width), sx = pos - sy * ref.width;
      const dy = sy - y;
      if (dy < -MOTION_RANGE || dy > MOTION_RANGE) continue;
      const dx = sx - x;
      if (dx < -MOTION_RANGE || dx > MOTION_RANGE) continue;
      steps++;
      const d = dx * dx + dy * dy;
      if (d >= distance) continue;
      if (blockEqual(indices, ref.indices, ref.width, x, y, sx, sy, bw, bh)) {
        bestX = sx; bestY = sy; distance = d;
        if (d <= 2) break;
      }
    }
    return bestX >= 0 ? { x: bestX, y: bestY } : null;
  }

  /** Returns DataChannel messages containing exact per-block commands. */
  async function encodeFrame(frame) {
    const { id, width, height, aspect, palette, indices, refIndices } = frame;
    const count = palette.length / 3, pixels = width * height;
    // Raw pixels plus five command bytes per block cover the worst case without
    // growing a large JS number array on every frame.
    const body = new Uint8Array(pixels + Math.ceil(pixels / (BLOCK * BLOCK)) * 5);
    let bodyLength = 0;
    const stats = { blocks: 0, copyBlocks: 0, dictionaryBlocks: 0, motionBlocks: 0, rawBlocks: 0 };
    const ref = refIndices ? buildReference(refIndices, width, height) : null;
    let lastDx = 0, lastDy = 0, altDx = 0, altDy = 0;
    for (let y = 0; y < height; y += BLOCK) for (let x = 0; x < width; x += BLOCK) {
      const bw = Math.min(BLOCK, width - x), bh = Math.min(BLOCK, height - y);
      stats.blocks++;
      if (ref && blockEqual(indices, refIndices, width, x, y, x, y, bw, bh)) {
        body[bodyLength++] = CMD_COPY; stats.copyBlocks++; continue;
      }
      if (ref && bw === BLOCK && bh === BLOCK) {
        const hash = hashBlock(indices, width, x, y, BLOCK, BLOCK);
        const id = dictionaryMatch(ref, indices, x, y, hash);
        if (id >= 0) {
          body[bodyLength++] = CMD_DICTIONARY;
          body[bodyLength++] = id & 255; body[bodyLength++] = id >>> 8;
          stats.dictionaryBlocks++; continue;
        }
        let moved = null;
        if (lastDx || lastDy) {
          const sx = x + lastDx, sy = y + lastDy;
          if (sx >= 0 && sx + BLOCK <= width && sy >= 0 && sy + BLOCK <= height &&
              blockEqual(indices, refIndices, width, x, y, sx, sy, BLOCK, BLOCK)) {
            moved = { x: sx, y: sy };
          }
        }
        if (!moved && (altDx || altDy) && (altDx !== lastDx || altDy !== lastDy)) {
          const sx = x + altDx, sy = y + altDy;
          if (sx >= 0 && sx + BLOCK <= width && sy >= 0 && sy + BLOCK <= height &&
              blockEqual(indices, refIndices, width, x, y, sx, sy, BLOCK, BLOCK)) {
            moved = { x: sx, y: sy };
          }
        }
        if (!moved) moved = motionMatch(ref, indices, x, y, bw, bh, hash);
        if (moved) {
          const dx = moved.x - x, dy = moved.y - y;
          if (dx !== lastDx || dy !== lastDy) { altDx = lastDx; altDy = lastDy; lastDx = dx; lastDy = dy; }
          body[bodyLength++] = CMD_MOTION;
          body[bodyLength++] = moved.x & 255; body[bodyLength++] = moved.x >>> 8;
          body[bodyLength++] = moved.y & 255; body[bodyLength++] = moved.y >>> 8;
          stats.motionBlocks++; continue;
        }
      }
      body[bodyLength++] = CMD_RAW; stats.rawBlocks++;
      for (let row = 0; row < bh; row++) {
        const start = (y + row) * width + x;
        body.set(indices.subarray(start, start + bw), bodyLength); bodyLength += bw;
      }
    }
    const raw = new Uint8Array(1 + palette.length + bodyLength);
    raw[0] = count;
    raw.set(palette, 1);
    raw.set(body.subarray(0, bodyLength), 1 + palette.length);
    const packed = await transform(raw, global.CompressionStream);
    const chunkCount = Math.max(1, Math.ceil(packed.length / CHUNK));
    const chunks = [];
    for (let c = 0; c < chunkCount; c++) {
      const part = packed.subarray(c * CHUNK, (c + 1) * CHUNK);
      const message = new Uint8Array(HEADER + part.length);
      const view = new DataView(message.buffer);
      message[0] = MAGIC; message[1] = VERSION;
      view.setUint16(2, c, true); view.setUint16(4, chunkCount, true);
      view.setUint16(6, width, true); view.setUint16(8, height, true);
      view.setUint16(10, Math.round(aspect * ASPECT_SCALE), true);
      view.setUint32(12, id, true);
      view.setUint32(16, refIndices ? frame.ref : KEY, true);
      message.set(part, HEADER);
      chunks.push(message);
    }
    return { chunks, bytes: packed.length, stats };
  }

  class FrameAssembler {
    constructor() { this.partial = new Map(); }
    push(data, minId = 0) {
      const message = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (message.length < HEADER || message[0] !== MAGIC || message[1] !== VERSION) return null;
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const index = view.getUint16(2, true), count = view.getUint16(4, true);
      const width = view.getUint16(6, true), height = view.getUint16(8, true);
      const id = view.getUint32(12, true), ref = view.getUint32(16, true);
      if (!count || index >= count || !width || !height || width * height > 1 << 20 || id <= minId) return null;
      let entry = this.partial.get(id);
      if (!entry) {
        entry = { id, ref: ref === KEY ? null : ref, width, height,
          aspect: view.getUint16(10, true) / ASPECT_SCALE, parts: new Array(count), received: 0, size: 0 };
        this.partial.set(id, entry);
        if (this.partial.size > 32) this.partial.delete(this.partial.keys().next().value);
      }
      if (entry.parts.length !== count || entry.parts[index]) return null;
      entry.parts[index] = message.subarray(HEADER);
      entry.received++;
      entry.size += message.length - HEADER;
      if (entry.received < count) return null;
      this.partial.delete(id);
      for (const key of [...this.partial.keys()]) {
        if (key <= minId || (key < id && key !== entry.ref)) this.partial.delete(key); // stale, never completes in time
      }
      const packed = new Uint8Array(entry.size);
      let offset = 0;
      for (const part of entry.parts) { packed.set(part, offset); offset += part.length; }
      return { id, ref: entry.ref, width, height, aspect: entry.aspect, data: packed };
    }
  }

  async function decodeFrame(packet, refIndices) {
    const raw = await transform(packet.data, global.DecompressionStream);
    if (!raw.length || 1 + raw[0] * 3 > raw.length) throw new Error("调色板不完整");
    const count = raw[0], pixels = packet.width * packet.height;
    const body = raw.subarray(1 + count * 3);
    const indices = new Uint8Array(pixels);
    // Decoding only needs the reference pixels and dimensions. Building the
    // encoder's motion/dictionary indexes here would double the guest's work.
    const ref = refIndices ? { columns: Math.floor(packet.width / BLOCK),
      rows: Math.floor(packet.height / BLOCK) } : null;
    let at = 0;
    const byte = () => {
      if (at >= body.length) throw new Error("块命令不完整");
      return body[at++];
    };
    for (let y = 0; y < packet.height; y += BLOCK) for (let x = 0; x < packet.width; x += BLOCK) {
      const bw = Math.min(BLOCK, packet.width - x), bh = Math.min(BLOCK, packet.height - y);
      const command = byte();
      if (command === CMD_COPY || command === CMD_DICTIONARY || command === CMD_MOTION) {
        if (!ref) throw new Error("缺少参考帧");
        let sx = x, sy = y;
        if (command === CMD_DICTIONARY) {
          if (bw !== BLOCK || bh !== BLOCK) throw new Error("边缘块不能使用字典");
          const id = byte() | byte() << 8;
          if (id >= ref.columns * ref.rows) throw new Error("字典块越界");
          sx = (id % ref.columns) * BLOCK; sy = Math.floor(id / ref.columns) * BLOCK;
        } else if (command === CMD_MOTION) {
          sx = byte() | byte() << 8; sy = byte() | byte() << 8;
          if (sx + bw > packet.width || sy + bh > packet.height ||
              Math.abs(sx - x) > MOTION_RANGE || Math.abs(sy - y) > MOTION_RANGE) throw new Error("运动块越界");
        }
        copyBlock(indices, refIndices, packet.width, x, y, sx, sy, bw, bh);
      } else if (command === CMD_RAW) {
        for (let row = 0; row < bh; row++) {
          const to = (y + row) * packet.width + x;
          if (at + bw > body.length) throw new Error("原始块不完整");
          indices.set(body.subarray(at, at + bw), to); at += bw;
        }
      } else throw new Error("未知块命令");
    }
    if (at !== body.length) throw new Error("块命令长度不符");
    return { palette: raw.slice(1, 1 + count * 3), indices };
  }

  // ------------------------------------------------------------------- host
  class PixelHost {
    constructor() {
      this.palette = new Palette(); this.ring = new Map(); this.peers = new Set();
      this.current = null; this.nextId = 1;
      this.stats = { frames: 0, captured: 0, approximated: 0, paletteResets: 0, colors: 0 };
    }
    frame(image, aspect) {
      this.stats.captured++;
      const { width, height, data } = image;
      const indices = new Uint8Array(width * height);
      const palette = this.palette;
      if (!palette.index(data, indices)) {
        if (now() - palette.resetAt > 1000) {
          palette.reset(); this.stats.paletteResets++;
        }
        palette.approximated = false;
        palette.index(data, indices, true);
        if (palette.approximated) this.stats.approximated++;
      }
      const current = this.current;
      if (current && current.epoch === palette.epoch && current.width === width && current.height === height &&
          current.colors === palette.size && equalBytes(current.indices, indices)) {
        for (const peer of this.peers) {
          if (peer.acked === current.id) peer.caughtUpAt = now();
        }
        return; // Nothing changed; repair() still resends to peers that missed it.
      }
      for (const peer of this.peers) {
        if (current && peer.acked === current.id) peer.caughtUpAt = now();
      }
      const frame = { id: this.nextId++, width, height, aspect, indices, epoch: palette.epoch,
        colors: palette.size, palette: palette.snapshot() };
      this.ring.set(frame.id, frame);
      while (this.ring.size > HOST_RING) this.ring.delete(this.ring.keys().next().value);
      this.current = frame;
      this.stats.frames++; this.stats.colors = palette.size;
      for (const peer of this.peers) peer.offer(frame);
    }
    attach(channel) {
      const peer = new PixelPeer(this, channel);
      this.peers.add(peer);
      return peer;
    }
    repair() { for (const peer of this.peers) peer.repair(); }
    /** True when every connected guest receives lossless frames (video can pause). */
    allPixel(isLive) {
      const live = [...this.peers].filter(p => isLive(p));
      return live.length > 0 && live.every(p => p.healthy ? p.healthy() : p.enabled);
    }
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    const n = a.length >> 2;
    if (!(a.byteOffset & 3) && !(b.byteOffset & 3)) {
      const a32 = new Uint32Array(a.buffer, a.byteOffset, n), b32 = new Uint32Array(b.buffer, b.byteOffset, n);
      for (let i = 0; i < n; i++) if (a32[i] !== b32[i]) return false;
      for (let i = n << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  class PixelPeer {
    constructor(host, channel) {
      this.host = host; this.channel = channel; this.enabled = false; this.closed = false;
      this.acked = null; this.ackedFrame = null; this.sentKeyFrame = null; this.sentKeyAt = -Infinity;
      this.pending = null; this.busy = false; this.lastSend = -Infinity;
      this.unackedSent = 0; this.lastAckAt = -Infinity; this.helloAt = -Infinity; this.caughtUpAt = -Infinity; this.wasHealthy = false;
      this.stats = { sent: 0, keyFrames: 0, skipped: 0, bytes: 0, encodeMs: null, acked: 0, syncs: 0,
        copyBlocks: 0, dictionaryBlocks: 0, motionBlocks: 0, rawBlocks: 0 };
      channel.binaryType = "arraybuffer";
      try { channel.bufferedAmountLowThreshold = 0; } catch (_) {}
      channel.addEventListener?.("bufferedamountlow", () => this.flush());
    }
    healthy() {
      if (!this.enabled || this.closed) return false;
      if (!this.host.current || this.acked === this.host.current.id) {
        this.caughtUpAt = now();
        return true;
      }
      return now() - Math.max(this.lastAckAt, this.helloAt, this.caughtUpAt) < 1500;
    }
    checkHealth() {
      const h = this.healthy();
      if (h !== this.wasHealthy) {
        this.wasHealthy = h;
        this.onenable?.();
      }
    }
    send(msg) {
      if (this.closed || this.channel.readyState !== "open") return;
      try { this.channel.send(JSON.stringify(msg)); } catch (_) {}
    }
    ackFrame(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      if (this.acked != null && id < this.acked) return false;
      const frame = this.host.ring.get(id) ||
        (this.ackedFrame && this.ackedFrame.id === id ? this.ackedFrame : null) ||
        (this.sentKeyFrame && this.sentKeyFrame.id === id ? this.sentKeyFrame : null);
      if (!frame) return false;
      this.acked = id;
      this.ackedFrame = frame;
      this.unackedSent = 0;
      this.lastAckAt = now();
      if (this.host.current && id === this.host.current.id) this.caughtUpAt = this.lastAckAt;
      this.checkHealth();
      return true;
    }
    message(data) {
      if (typeof data !== "string") return;
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.t === "hello" && msg.v === VERSION) {
        this.helloAt = this.lastAckAt = this.caughtUpAt = now();
        if (!this.enabled) { this.enabled = true; this.wasHealthy = true; this.onenable?.(); }
        else this.checkHealth();
        if (this.host.current) this.offer(this.host.current);
      } else if (msg.t === "ack" && Number.isSafeInteger(msg.id)) {
        this.ackFrame(msg.id);
        this.stats.acked++;
      } else if (msg.t === "sync") {
        this.stats.syncs++;
        if (Number.isSafeInteger(msg.ack) && msg.ack > 0) {
          if (!this.ackFrame(msg.ack) && (this.acked == null || msg.ack >= this.acked)) {
            this.acked = null; this.ackedFrame = null; this.sentKeyFrame = null; this.sentKeyAt = -Infinity;
          }
        } else if (msg.ack === 0) {
          this.acked = null; this.ackedFrame = null; this.sentKeyFrame = null; this.sentKeyAt = -Infinity;
        }
        this.unackedSent = 0;
        if (this.host.current) {
          if (this.acked !== this.host.current.id) this.offer(this.host.current);
          else {
            this.lastSend = now();
            this.send({ t: "pong", id: this.host.current.id, captured: this.host.stats.captured });
          }
        }
      } else if (msg.t === "key") {
        if (Number.isSafeInteger(msg.ack) && this.acked != null && msg.ack < this.acked) return;
        this.acked = null;
        this.ackedFrame = null;
        this.sentKeyFrame = null;
        this.sentKeyAt = -Infinity;
        this.unackedSent = 0;
        if (this.host.current) this.offer(this.host.current);
      }
    }
    offer(frame) {
      if (!this.enabled || this.closed || this.channel.readyState !== "open") return;
      this.pending = frame;
      this.flush();
    }
    repair() {
      this.checkHealth();
      const current = this.host.current;
      if (!current || !this.enabled || this.closed) return;
      if (this.acked !== current.id) {
        if (now() - this.lastSend > REPAIR_MS) this.offer(current);
      } else if (now() - this.lastSend >= 200) {
        this.lastSend = now();
        this.send({ t: "pong", id: current.id, captured: this.host.stats.captured });
      }
    }
    async flush() {
      if (this.busy || !this.pending || this.closed) return;
      if (this.channel.bufferedAmount > SEND_BUFFER_LIMIT ||
          (this.unackedSent >= MAX_IN_FLIGHT && this.channel.bufferedAmount > 0)) {
        this.stats.skipped++;
        return; // Drop, never queue latency.
      }
      const frame = this.pending;
      this.pending = null;
      if (frame.id === this.acked) return;
      this.busy = true;
      try {
        const t = now();
        const ref = (this.acked != null ? (this.host.ring.get(this.acked) || this.ackedFrame) : null) ||
          (t - this.sentKeyAt < KEY_COOLDOWN_MS ? this.sentKeyFrame : null);
        const usable = ref && ref.id < frame.id && ref.epoch === frame.epoch &&
          ref.width === frame.width && ref.height === frame.height;
        const started = now();
        const { chunks, bytes, stats: blocks } = await encodeFrame({ ...frame, ref: usable ? ref.id : null, refIndices: usable ? ref.indices : null });
        const spent = now() - started;
        this.stats.encodeMs = this.stats.encodeMs == null ? spent : this.stats.encodeMs * 0.9 + spent * 0.1;
        if (this.closed || this.channel.readyState !== "open") return;
        for (const chunk of chunks) this.channel.send(chunk);
        this.lastSend = now();
        this.unackedSent++;
        this.stats.sent++; this.stats.bytes += bytes;
        for (const kind of ["copyBlocks", "dictionaryBlocks", "motionBlocks", "rawBlocks"]) this.stats[kind] += blocks[kind];
        if (!usable) {
          this.stats.keyFrames++;
          this.sentKeyFrame = frame;
          this.sentKeyAt = this.lastSend;
        }
      } catch (_) {
        // A failed send is repaired by the next frame or the periodic repair.
      } finally {
        this.busy = false;
        if (this.pending) this.flush();
      }
    }
    close() { this.closed = true; this.host.peers.delete(this); }
  }

  // ------------------------------------------------------------------ guest
  class PixelReceiver {
    constructor(channel, onFrame) {
      this.channel = channel; this.onFrame = onFrame; this.closed = false;
      this.assembler = new FrameAssembler(); this.ring = new Map(); this.newest = 0;
      this.pending = new Map(); this.decoding = false; this.decodingId = 0;
      this.lastKeyRequest = -Infinity; this.lastMessageAt = now(); this.lastSyncAt = -Infinity; this.lastHelloAt = -Infinity;
      this.stats = { decoded: 0, keyFrames: 0, bytes: 0, keyRequests: 0, decodeMs: null, errors: 0, droppedObsolete: 0, syncRequests: 0, hostCaptured: 0 };
      channel.binaryType = "arraybuffer";
    }
    hello() {
      this.lastHelloAt = now();
      this.send({ t: "hello", v: VERSION });
    }
    send(msg) {
      if (this.closed || this.channel.readyState !== "open") return;
      try { this.channel.send(JSON.stringify(msg)); } catch (_) {}
    }
    requestKey() {
      const t = now();
      if (t - this.lastKeyRequest < KEY_REQUEST_MS) return;
      this.lastKeyRequest = t;
      this.stats.keyRequests++;
      this.send({ t: "key", ack: this.newest });
    }
    poll() {
      if (this.closed || this.channel.readyState !== "open") return;
      const t = now();
      if (!this.stats.decoded) {
        if (t - this.lastHelloAt >= HELLO_MS) this.hello();
        return;
      }
      if (!this.decoding && t - this.lastMessageAt >= SYNC_STALL_MS && t - this.lastSyncAt >= SYNC_INTERVAL_MS) {
        this.lastSyncAt = t;
        this.stats.syncRequests++;
        this.send({ t: "sync", ack: this.newest });
      }
    }
    message(data) {
      if (this.closed) return;
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg && msg.t === "pong") {
            this.lastMessageAt = now();
            if (Number.isSafeInteger(msg.captured) && msg.captured > this.stats.hostCaptured) {
              this.stats.hostCaptured = msg.captured;
            }
            if (Number.isSafeInteger(msg.id) && msg.id > this.newest) {
              this.send({ t: "sync", ack: this.newest });
            } else if (this.stats.decoded > 0) {
              this.onAlive?.();
            }
          }
        } catch (_) {}
        return;
      }
      const packet = this.assembler.push(data, this.newest);
      if (!packet) return;
      this.lastMessageAt = now();
      this.stats.bytes += packet.data.length;
      this.pending.set(packet.id, packet);
      this.prunePending();
      this.pump();
    }
    prunePending() {
      for (const id of [...this.pending.keys()]) {
        if (id <= this.newest) {
          this.pending.delete(id);
          this.stats.droppedObsolete++;
        }
      }
      if (this.pending.size <= 1) return;
      let bestId = 0;
      let bestKeep = null;
      for (const [id, pkt] of this.pending) {
        if (id <= bestId) continue;
        const chain = new Set();
        let cur = pkt;
        let ok = false;
        while (cur && !chain.has(cur.id)) {
          chain.add(cur.id);
          if (cur.ref == null || this.ring.has(cur.ref) || cur.ref === this.decodingId) {
            ok = true;
            break;
          }
          cur = this.pending.get(cur.ref);
        }
        if (ok) {
          bestId = id;
          bestKeep = chain;
        }
      }
      if (!bestKeep) return;
      for (const id of [...this.pending.keys()]) {
        if (!bestKeep.has(id)) {
          this.pending.delete(id);
          this.stats.droppedObsolete++;
        }
      }
    }
    async pump() {
      if (this.decoding || this.closed) return;
      this.decoding = true;
      try {
        while (!this.closed && this.pending.size) {
          this.prunePending();
          if (!this.pending.size) break;
          const ids = [...this.pending.keys()].sort((a, b) => a - b);
          // When decoding cannot keep up, spend time on the newest frame whose
          // reference is available instead of accumulating a visible delay.
          const nextId = ids.findLast(id => {
            const p = this.pending.get(id);
            return p.ref == null || this.ring.has(p.ref);
          }) ?? ids[ids.length - 1];
          const next = this.pending.get(nextId);
          this.pending.delete(nextId);
          this.decodingId = next.id;
          try {
            await this.decode(next);
          } catch (_) {
            this.stats.errors++;
          } finally {
            this.decodingId = 0;
          }
        }
      } finally {
        this.decoding = false;
      }
    }
    async decode(packet) {
      if (this.closed) return;
      if (this.ring.has(packet.id)) { this.send({ t: "ack", id: packet.id }); return; }
      if (packet.id <= this.newest) { this.send({ t: "ack", id: this.newest }); return; }
      let ref = null;
      if (packet.ref != null) {
        if (packet.ref === packet.id) { this.requestKey(); return; }
        ref = this.ring.get(packet.ref);
        if (!ref || ref.width !== packet.width || ref.height !== packet.height) {
          if (!this.assembler.partial.has(packet.ref)) this.requestKey();
          return;
        }
      }
      const started = now();
      const { palette, indices } = await decodeFrame(packet, ref && ref.indices);
      const spent = now() - started;
      this.stats.decodeMs = this.stats.decodeMs == null ? spent : this.stats.decodeMs * 0.9 + spent * 0.1;
      if (this.closed) return;
      this.ring.set(packet.id, { indices, width: packet.width, height: packet.height });
      this.send({ t: "ack", id: packet.id });
      this.stats.decoded++;
      if (packet.ref == null) this.stats.keyFrames++;
      if (packet.id > this.newest) {
        this.newest = packet.id;
        this.onFrame({ id: packet.id, width: packet.width, height: packet.height, aspect: packet.aspect, palette, indices });
      }
      while (this.ring.size > GUEST_RING) {
        let victim = null;
        for (const k of this.ring.keys()) {
          if (k !== this.newest) { victim = k; break; }
        }
        if (victim == null) break;
        this.ring.delete(victim);
      }
    }
    close() { this.closed = true; this.pending.clear(); this.ring.clear(); }
  }

  // -------------------------------------------------------------- presenter
  const MAX_PRESCALE = 3072;
  /** Displays native frames with uniform pixel sizes on any window size. */
  function createPresenter(getCanvas) {
    const native = document.createElement("canvas");
    const nctx = native.getContext("2d", { alpha: false });
    const lut = new Uint32Array(256);
    let image = null, queue = [], raf = null, timer = null, scheduledAt = -Infinity;
    let layout = "", laidOut = null, stopped = false, lastId = 0;
    const stats = { presented: 0, dropped: 0, gaps: 0 };
    function fit(canvas, width, height, aspect) {
      const parent = canvas.parentElement;
      if (!parent) return false;
      const pw = parent.clientWidth, ph = parent.clientHeight;
      if (!pw || !ph) return false;
      const dpr = global.devicePixelRatio || 1;
      let cw = pw, ch = pw / aspect;
      if (ch > ph) { ch = ph; cw = ph * aspect; }
      const dw = Math.max(1, Math.round(cw * dpr)), dh = Math.max(1, Math.round(ch * dpr));
      // Integer nearest-neighbour first, then one smooth downscale to the box (buffer edge ≤ MAX_PRESCALE).
      const kx = Math.max(1, Math.min(Math.ceil(dw / width - 1e-3), Math.floor(MAX_PRESCALE / width)));
      const ky = Math.max(1, Math.min(Math.ceil(dh / height - 1e-3), Math.floor(MAX_PRESCALE / height)));
      if (canvas.width !== width * kx || canvas.height !== height * ky) {
        canvas.width = width * kx; canvas.height = height * ky;
      }
      const key = [dw, dh, pw, ph, dpr].join();
      if (key !== layout || canvas !== laidOut) {
        layout = key; laidOut = canvas;
        Object.assign(canvas.style, {
          width: dw / dpr + "px", height: dh / dpr + "px",
          left: (pw - dw / dpr) / 2 + "px", top: (ph - dh / dpr) / 2 + "px",
          objectFit: "fill", imageRendering: "auto",
        });
      }
      return true;
    }
    function blit(width, height, aspect) {
      const canvas = getCanvas();
      if (!canvas || !fit(canvas, width, height, aspect)) return false;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return false;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(native, 0, 0, canvas.width, canvas.height);
      stats.presented++;
      return true;
    }
    function paintIndexed(frame) {
      const { width, height, palette, indices } = frame;
      if (lastId && frame.id !== lastId + 1) stats.gaps++;
      lastId = frame.id;
      if (native.width !== width || native.height !== height) { native.width = width; native.height = height; image = null; }
      if (!image) image = nctx.createImageData(width, height);
      lut.fill(0xff000000);
      for (let i = 0, n = palette.length / 3; i < n; i++) {
        lut[i] = 0xff000000 | (palette[i * 3 + 2] << 16) | (palette[i * 3 + 1] << 8) | palette[i * 3];
      }
      const out = new Uint32Array(image.data.buffer);
      for (let i = 0; i < indices.length; i++) out[i] = lut[indices[i]];
      nctx.putImageData(image, 0, 0);
      blit(width, height, frame.aspect);
    }
    function schedule() {
      if (stopped || !queue.length) return;
      // rAF may be paused or delayed independently of DataChannel delivery.
      // Arm a one-shot 24 ms fallback timer (never a 0 ms MessageChannel spin-loop)
      // so an occluded P2 cannot accumulate stale frames or starve the main thread.
      if (raf == null) {
        scheduledAt = now();
        raf = requestAnimationFrame(tick);
      }
      if (timer == null) {
        if (typeof global.setTimeout === "function") {
          const id = global.setTimeout(() => { timer = null; tick(); }, 24);
          id?.unref?.();
          timer = { cancel() { if (typeof global.clearTimeout === "function") global.clearTimeout(id); } };
        } else {
          timer = afterFrame(() => { timer = null; tick(); });
        }
      }
    }
    function tick() {
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      if (timer != null) timer.cancel();
      timer = null;
      if (stopped || !queue.length) return;
      // Bounded jitter queue: one frame per refresh, at most two frames behind.
      while (queue.length > 2) { queue.shift(); stats.dropped++; }
      paintIndexed(queue.shift());
      schedule();
    }
    return {
      stats,
      queueIndexed(frame) {
        if (stopped) return;
        while (queue.length >= 2) { queue.shift(); stats.dropped++; }
        queue.push(frame);
        if (raf != null && now() - scheduledAt >= 24) tick();
        else schedule();
      },
      /** Video fallback: undo the host's 2x upscale with a box filter, then present. */
      drawVideo(video, aspect) {
        const width = Math.max(1, Math.round(video.videoWidth / VIDEO_UPSCALE));
        const height = Math.max(1, Math.round(video.videoHeight / VIDEO_UPSCALE));
        if (native.width !== width || native.height !== height) { native.width = width; native.height = height; image = null; }
        nctx.imageSmoothingEnabled = true;
        nctx.drawImage(video, 0, 0, width, height);
        return blit(width, height, aspect);
      },
      relayout() { layout = ""; },
      stop() {
        stopped = true; queue = [];
        if (raf != null) cancelAnimationFrame(raf);
        if (timer != null) timer.cancel();
        raf = timer = null;
      },
    };
  }

  global.StreamPixels = {
    LABEL, CHANNEL_OPTIONS, VERSION, VIDEO_UPSCALE, supported, readable, coreGeometry, viewport,
    createGrabber, createPresenter, keepRunningWhenHidden, Palette, encodeFrame, decodeFrame, FrameAssembler,
    PixelHost, PixelReceiver,
  };
})(typeof window !== "undefined" ? window : globalThis);
