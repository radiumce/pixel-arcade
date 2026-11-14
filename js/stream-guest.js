/* Standalone WebRTC receiver: no ROM, emulator core, or EmulatorJS dependency. */
(function (global) {
  "use strict";
  const buttons = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const keys = { KeyJ: 0, ShiftLeft: 2, ShiftRight: 2, Enter: 3,
    ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, KeyK: 8,
    KeyL: 1, KeyI: 9, KeyO: 10, KeyP: 11 };
  const arcadeKeys = { ...keys, KeyQ: 2 };
  const now = () => performance.now();

  function create(opts) {
    const canvas = opts.canvas;
    const video = document.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    const Pixels = global.StreamPixels;
    let presenter = Pixels.createPresenter(() => canvas);
    let socket = null, peer = null, hostId = null, room = null;
    let joined = false, closed = false, focused = true, sequence = 0, closedReason = "";
    let pixelAt = -Infinity, pixelSize = null, snapshot = null, metricsTimer = 0;
    const playerId = global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
    let inputPlatform = "nes";
    const held = new Map(), listeners = [];
    function listen(target, name, fn) {
      target.addEventListener(name, fn);
      listeners.push(() => target.removeEventListener(name, fn));
    }
    function status(message, error = false) {
      opts.statusEl.textContent = message;
      opts.statusEl.className = error ? "error" : "ok";
    }
    function active(entry) { return !closed && peer === entry; }
    function state() {
      return Object.fromEntries(buttons.map(b => [b, +[...held.values()].includes(b)]));
    }
    function sendState() {
      if (!joined || !peer) return;
      const values = state(), fast = peer.fast;
      if (fast?.readyState === "open") {
        if (fast.bufferedAmount < 1024) {
          try { fast.send(JSON.stringify({ seq: ++sequence, buttons: values })); } catch (_) {}
        }
      } else if (peer.reliable?.readyState === "open") {
        for (const index of buttons) {
          if (peer.lastButtons?.[index] === values[index]) continue;
          try { peer.reliable.send(JSON.stringify({ player: 1, index, value: values[index] })); } catch (_) {}
        }
        peer.lastButtons = values;
      }
    }
    function setButton(index, value, source = "manual") {
      if (closed || !buttons.includes(index) || (value !== 0 && value !== 1)) return;
      const id = source + ":" + index;
      if (value) held.set(id, index); else held.delete(id);
      sendState();
    }
    function clearInput() { held.clear(); sendState(); }
    function resume() {
      if (closed) return;
      video.play().catch(() => {});
      audio.play().catch(() => {});
      presenter.relayout();
    }
    function closePeer() {
      const previous = peer;
      peer = null;
      if (previous) {
        clearTimeout(previous.retryTimer);
        previous.receiver?.close();
        if (previous.videoFrame != null) {
          if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(previous.videoFrame);
          else cancelAnimationFrame(previous.videoFrame);
        }
        previous.pc.close();
      }
      video.pause(); video.srcObject = null;
      audio.pause(); audio.srcObject = null;
      pixelAt = -Infinity; pixelSize = null;
      presenter.stop();
      if (!closed) presenter = Pixels.createPresenter(() => canvas);
    }
    function close(message) {
      if (closed) return;
      clearInput();
      closed = true; joined = false;
      closedReason = message || "房间已断开";
      closePeer();
      clearInterval(inputTimer); clearTimeout(metricsTimer);
      listeners.forEach(remove => remove());
      if (socket) { socket.emit("leave-room"); socket.disconnect(); }
      snapshot = { role: "guest", joined: false, peers: [], pixel: { active: false } };
      opts.streamStatusEl.textContent = "串流：已断开";
      if (message) {
        status(message, true);
        const retry = document.getElementById("btnRetry");
        if (retry) retry.hidden = false;
      }
    }
    function retry(entry) {
      if (!active(entry) || !joined || !socket?.connected || now() - (entry.lastRetry || -Infinity) < 1500) return;
      entry.lastRetry = now();
      socket.emit("webrtc-signal", { target: hostId, requestRenegotiate: true });
    }
    function drawVideo(entry) {
      const draw = () => {
        if (!active(entry)) return;
        // An open DataChannel only means the transport is alive, not that its
        // delta reference chain is making progress. Let VP8 cover a pixel stall.
        if (now() - pixelAt >= 1000 && video.readyState >= 2 && video.videoWidth) {
          presenter.drawVideo(video, room.aspect || 4 / 3);
        }
        entry.videoFrame = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
      };
      draw();
    }
    function createPeer() {
      closePeer();
      const pc = new RTCPeerConnection({ iceServers: room.iceServers });
      const entry = peer = { pc, candidates: [], chain: Promise.resolve(), receiver: null, pixelChannel: null, lastActiveAt: now() };
      function scheduleDisconnectCheck() {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout(() => {
          if (!active(entry)) return;
          const state = pc.connectionState || pc.iceConnectionState;
          if (state === "connected" || state === "completed") return;
          if (now() - (entry.lastActiveAt || -Infinity) < 800) {
            scheduleDisconnectCheck();
            return;
          }
          retry(entry);
        }, 1500);
      }
      pc.onicecandidate = event => {
        if (active(entry) && event.candidate) socket.emit("webrtc-signal", { target: hostId, candidate: event.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (!active(entry)) return;
        clearTimeout(entry.retryTimer);
        if (pc.connectionState === "connected") status("P2 已连接，正在接收 P1 的画面与声音。按键即可控制游戏。");
        else if (pc.connectionState === "failed") retry(entry);
        else if (pc.connectionState === "disconnected") scheduleDisconnectCheck();
      };
      pc.oniceconnectionstatechange = () => {
        if (!active(entry)) return;
        if (pc.iceConnectionState === "failed") {
          clearTimeout(entry.retryTimer);
          retry(entry);
        } else if (pc.iceConnectionState === "disconnected" && !entry.retryTimer) {
          scheduleDisconnectCheck();
        }
      };
      pc.ondatachannel = event => {
        if (!active(entry)) { event.channel.close(); return; }
        const channel = event.channel;
        if (channel.label === "nes-input-state-v1") {
          entry.fast = channel;
          channel.onopen = sendState;
        } else if (channel.label === Pixels.LABEL) {
          if (!Pixels.supported()) return; // Silence keeps the host's VP8 fallback enabled.
          channel.binaryType = "arraybuffer";
          entry.pixelChannel = channel;
          const receiver = entry.receiver = new Pixels.PixelReceiver(channel, frame => {
            if (!active(entry)) return;
            pixelAt = entry.lastActiveAt = now(); pixelSize = [frame.width, frame.height];
            presenter.queueIndexed(frame);
          });
          receiver.onAlive = () => {
            if (active(entry)) pixelAt = entry.lastActiveAt = now();
          };
          channel.onmessage = event => {
            if (!active(entry)) return;
            entry.lastActiveAt = now();
            receiver.message(event.data);
          };
          channel.onopen = () => { entry.helloAt = entry.lastActiveAt = now(); receiver.hello(); };
          channel.onclose = () => {
            receiver.close();
            if (active(entry)) retry(entry);
          };
        } else if (channel.label === "inputs") {
          entry.reliable = channel;
          channel.onopen = () => { entry.lastButtons = null; sendState(); };
          channel.onmessage = event => {
            if (!active(entry)) return;
            try { if (JSON.parse(event.data).type === "host-left") close("P1 已离开，请返回大厅"); } catch (_) {}
          };
        }
        if (channel.readyState === "open") channel.onopen?.();
      };
      pc.ontrack = event => {
        if (!active(entry)) return;
        for (const hint of ["jitterBufferTarget", "playoutDelayHint"]) {
          try { if (event.receiver && hint in event.receiver) event.receiver[hint] = 0; } catch (_) {}
        }
        if (event.track.kind === "audio") {
          audio.srcObject = new MediaStream([event.track]);
          audio.play().catch(() => status("画面已连接，点击「播放画面和声音」开启声音。"));
        } else if (event.track.kind === "video") {
          video.srcObject = new MediaStream([event.track]);
          video.play().catch(() => {});
          drawVideo(entry);
        }
        event.track.onended = () => retry(entry);
      };
      return entry;
    }
    function signal(data) {
      if (closed || data.sender !== hostId) return;
      const entry = data.offer && peer?.hasOffer ? createPeer() : peer || createPeer();
      if (data.offer) entry.hasOffer = true;
      entry.chain = entry.chain.then(async () => {
        if (!active(entry)) return;
        if (data.offer) {
          await entry.pc.setRemoteDescription(data.offer);
          for (const candidate of entry.candidates.splice(0)) await entry.pc.addIceCandidate(candidate).catch(() => {});
          const answer = await entry.pc.createAnswer();
          if (!active(entry)) return;
          await entry.pc.setLocalDescription(answer);
          if (active(entry)) socket.emit("webrtc-signal", { target: hostId, answer: entry.pc.localDescription });
        } else if (data.candidate) {
          if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
          else entry.candidates.push(data.candidate);
        }
      }).catch(error => { if (active(entry)) status("画面连接失败：" + error.message, true); });
    }
    async function connect(settings) {
      room = settings;
      inputPlatform = room.rom?.platform === "arcade" ? "arcade" : "nes";
      global.GamepadInput?.setPlatform(inputPlatform);
      status("正在连接 P1 的画面…");
      socket = global.io(opts.signalingUrl, { autoConnect: false, reconnection: false,
        transports: ["websocket", "polling"] });
      socket.on("users-updated", players => {
        if (closed) return;
        const host = Object.values(players).find(player => player.userid !== playerId);
        if (hostId && !Object.values(players).some(player => player.socketId === hostId)) {
          close("P1 已离开，请返回大厅"); return;
        }
        hostId = host?.socketId || hostId;
      });
      socket.on("webrtc-signal", signal);
      socket.on("room-replaced", () => close("你已被新的 P2 替换，请返回大厅"));
      socket.on("disconnect", () => { if (!closed) close("与联机服务断开，请重新连接"); });
      socket.on("data-message", data => { if (data?.type === "host-left") close("P1 已离开，请返回大厅"); });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("联机服务连接超时，请重试")), 12000);
        socket.once("connect_error", error => { clearTimeout(timer); reject(error); });
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.timeout(10000).emit("join-room", { password: room.code, extra: {
            sessionid: room.streamSessionId, userid: playerId, player_name: "P2", game_id: room.gameId,
            room_name: room.code, domain: location.host,
          } }, (timeout, error) => {
            if (timeout || error || closed) { reject(new Error(closed ? closedReason : error || timeout.message)); return; }
            joined = true;
            status("P2 已加入，正在接收 P1 的画面…");
            sendState();
            resolve();
          });
        });
        socket.connect();
      }).catch(error => { close(error.message); throw error; });
    }
    async function updateMetrics() {
      const entry = peer;
      const peers = [];
      if (entry) {
        try {
          const reports = await entry.pc.getStats();
          if (!active(entry)) {
            if (!closed) metricsTimer = setTimeout(updateMetrics, 1000);
            return;
          }
          const received = [...reports.values()].find(s => s.type === "inbound-rtp" && s.kind === "video");
          const transport = [...reports.values()].find(s => s.type === "transport" && s.selectedCandidatePairId);
          const pair = transport && reports.get(transport.selectedCandidatePairId);
          const previous = entry.previous;
          const dt = previous ? (now() - previous.time) / 1000 : 0;
          const frames = received?.framesDecoded || 0;
          const stats = entry.receiver?.stats;
          const decodedDelta = previous && stats ? stats.decoded - previous.decoded : 0;
          const hostDelta = previous && stats && now() - pixelAt < 1000 ? (stats.hostCaptured || 0) - (previous.hostCaptured || 0) : 0;
          const pixel = stats ? { ...stats, enabled: stats.decoded > 0,
            fps: dt > 0 ? Math.max(decodedDelta, hostDelta) / dt : null,
            kbps: dt > 0 ? 8 * (stats.bytes - previous.bytes) / dt / 1000 : null } : null;
          if (previous && (frames > previous.frames || (stats && stats.bytes > previous.bytes))) {
            entry.lastActiveAt = now();
          }
          entry.previous = { time: now(), frames, decoded: pixel?.decoded || 0, bytes: pixel?.bytes || 0,
            hostCaptured: stats?.hostCaptured || 0 };
          peers.push({ state: entry.pc.connectionState, frames, framesDecoded: frames,
            framesDropped: received?.framesDropped, freezeCount: received?.freezeCount,
            fps: dt > 0 ? (frames - previous.frames) / dt : null,
            codec: received && reports.get(received.codecId)?.mimeType,
            jitterBufferMs: received?.jitterBufferEmittedCount > 0 ? 1000 * received.jitterBufferDelay / received.jitterBufferEmittedCount : null,
            inputTransport: entry.fast?.readyState === "open" ? "unreliable-state" : "reliable-fallback", pixel,
            path: pair ? { roundTripTime: pair.currentRoundTripTime } : null });
        } catch (_) {} // The peer may close while stats are being sampled.
      }
      if (closed) return;
      snapshot = { role: "guest", joined, peers,
        video: { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
          paused: video.paused, currentTime: video.currentTime },
        pixel: { active: now() - pixelAt < 1000, size: pixelSize, presenter: { ...presenter.stats } } };
      const metric = peers[0], pixel = metric?.pixel;
      opts.streamStatusEl.textContent = !joined ? "串流：等待房间就绪" : !metric ? "串流：等待 P1 的画面" :
        "访客串流：" + (metric.state === "connected" ? "已连接" : "正在连接") +
        (snapshot.pixel.active ? " · 无损像素直传 · 已显示 " + presenter.stats.presented + " 帧" : " · 视频回退 · 已解码 " + metric.frames + " 帧") +
        ((pixel?.fps ?? metric.fps) != null ? " · " + (pixel?.fps ?? metric.fps).toFixed(0) + " FPS" : "") +
        (metric.path?.roundTripTime != null ? " · RTT " + (metric.path.roundTripTime * 1000).toFixed(0) + " ms" : "");
      if (joined && location.protocol === "http:") socket.emit("stream-diagnostics", { room: room.code, ...snapshot });
      metricsTimer = setTimeout(updateMetrics, 1000);
    }
    const inputTimer = setInterval(() => {
      for (const id of held.keys()) if (id.startsWith("gamepad:")) held.delete(id);
      if (focused && !document.hidden) {
        const [pressed] = global.GamepadInput?.readPlayers(1) || [[]];
        for (const button of pressed) held.set("gamepad:" + button, button);
      }
      sendState();
      const entry = peer;
      if (entry?.receiver) {
        if (entry.receiver.poll) entry.receiver.poll();
        else if (!entry.receiver.stats.decoded && now() - (entry.helloAt || 0) > 250) {
          entry.helloAt = now(); entry.receiver.hello();
        }
      }
    }, 50);
    listen(global, "keydown", event => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      const map = inputPlatform === "arcade" ? arcadeKeys : keys;
      if (map[event.code] == null) return;
      event.preventDefault(); resume(); setButton(map[event.code], 1, event.code);
    });
    listen(global, "keyup", event => {
      const map = inputPlatform === "arcade" ? arcadeKeys : keys;
      if (map[event.code] == null) return;
      event.preventDefault(); setButton(map[event.code], 0, event.code);
    });
    listen(global, "blur", () => { focused = false; clearInput(); });
    listen(global, "focus", () => { focused = true; });
    listen(document, "visibilitychange", () => { if (document.hidden) clearInput(); });
    listen(global, "pagehide", () => close());
    global.__streamDebug = { getState: () => snapshot };
    updateMetrics();
    return { connect, close, setButton, clearInput, resume, canvas, video, audio, name: "P2",
      get joined() { return joined; } };
  }
  global.StreamGuest = { create };
})(window);
