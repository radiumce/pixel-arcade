/* Compatibility and video diagnostics for EmulatorJS's experimental netplay. */
(function (global) {
  let dispose = () => {};

  function attach(emu) {
    dispose();
    const netplay = emu && emu.netplay;
    const status = document.getElementById("streamStatus");
    if (!netplay || !status) return;

    let stopped = false;
    let timer;
    let snapshot = null;
    let lastDiagnostics = 0;
    let stopHostCapture = () => {};
    const restore = [];
    function override(name, replacement) {
      const original = netplay[name];
      netplay[name] = replacement(original);
      restore.push(() => { netplay[name] = original; });
    }

    // Recent Nestopia builds use RWebAudio, whose stereo buffer sources connect
    // directly to the destination; EmulatorJS only captures the older OpenAL graph.
    // Mirror those output connections into a stream without changing local playback.
    const audioOutputs = new Map();
    const audioPrototype = global.AudioNode?.prototype;
    const connectAudio = audioPrototype?.connect;
    let currentAudioContext = null;
    function audioOutput(context) {
      let destination = audioOutputs.get(context);
      if (!destination || destination.stream.getAudioTracks().every(track => track.readyState === "ended")) {
        destination = context.createMediaStreamDestination();
        audioOutputs.set(context, destination);
      }
      return destination;
    }
    if (connectAudio) {
      const mirrored = new WeakMap();
      const connect = function (destination, ...args) {
        const result = connectAudio.call(this, destination, ...args);
        if (!stopped && destination === this.context?.destination && this.buffer?.numberOfChannels === 2 &&
            this.context.createMediaStreamDestination) {
          try {
            currentAudioContext = this.context;
            const output = audioOutputs.get(this.context) || audioOutput(this.context);
            if (mirrored.get(this) !== output) {
              connectAudio.call(this, output);
              mirrored.set(this, output);
            }
          } catch (_) {} // Unsupported capture must not interrupt local audio.
        }
        return result;
      };
      audioPrototype.connect = connect;
      restore.push(() => {
        if (audioPrototype.connect === connect) audioPrototype.connect = connectAudio;
        for (const output of audioOutputs.values()) output.stream.getTracks().forEach(track => track.stop());
        audioOutputs.clear();
      });
    }
    override("_captureHostAudio", original => function (...args) {
      if (currentAudioContext && currentAudioContext.state !== "closed") {
        currentAudioContext.resume().catch(() => {});
        return audioOutput(currentAudioContext).stream;
      }
      return original?.apply(this, args) || null;
    });

    // Lossless frame transport (see stream-pixels.js); WebRTC video is the fallback.
    const Pixels = global.StreamPixels;
    let pixelHost = null;
    let hostGrabber = null;
    const framePeers = new Map(); // pc -> PixelPeer
    const previousPixel = new WeakMap();
    // The host must keep emulating while hidden (e.g. P2 fullscreen on the same machine).
    const hiddenTicker = Pixels?.keepRunningWhenHidden?.(() => !stopped && emu.isNetplay && netplay.owner) || null;

    // Full state snapshots let lost/reordered input packets be discarded safely.
    const buttons = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const inputPeers = new Map();
    const previousStats = new WeakMap();
    function release(state) {
      if (state.player == null) return;
      for (const index of buttons) {
        if (state.buttons[index]) emu.gameManager?.functions?.simulateInput(state.player, index, 0);
      }
      state.buttons = {};
    }
    function bindInputs(pc, peerId, channel) {
      const state = { channel, seq: -1, buttons: {}, sentButtons: [], player: null, received: 0 };
      inputPeers.set(pc, state);
      channel.onmessage = event => {
        if (!netplay.owner || stopped || !emu.isNetplay || netplay.peerConnections[peerId]?.pc !== pc) return;
        let data;
        try { data = JSON.parse(event.data); } catch (_) { return; }
        if (!Number.isSafeInteger(data.seq) || data.seq <= state.seq || !data.buttons ||
            !buttons.every(b => data.buttons[b] == null || data.buttons[b] === 0 || data.buttons[b] === 1)) return;
        const player = Object.values(netplay.players || {}).findIndex(p => p.socketId === peerId);
        if (player < 1) return;
        if (state.player !== player) release(state);
        state.player = player;
        const first = state.seq < 0;
        state.seq = data.seq;
        state.received = performance.now();
        for (const index of first ? buttons : state.sentButtons) {
          if (first || (state.buttons[index] || 0) !== data.buttons[index]) {
            emu.gameManager?.functions?.simulateInput(player, index, data.buttons[index] || 0);
          }
        }
        state.buttons = Object.fromEntries(buttons.map(index => [index, data.buttons[index] || 0]));
        state.sentButtons = Object.keys(data.buttons).map(Number);
      };
      // Ignore late reliable key packets once the snapshot protocol is active.
      const reliable = netplay.peerConnections[peerId]?.dataChannel;
      if (netplay.owner && reliable) {
        const onmessage = reliable.onmessage;
        reliable.onmessage = event => {
          if (netplay.peerConnections[peerId]?.pc !== pc) return;
          let data;
          try { data = JSON.parse(event.data); } catch (_) { return; }
          if (state.seq >= 0 && channel.readyState === "open" && buttons.includes(data.index)) return;
          onmessage?.call(reliable, event);
        };
      }
      channel.onclose = () => {
        if (inputPeers.get(pc) === state) {
          release(state);
          inputPeers.delete(pc);
        }
      };
    }
    const inputTimer = setInterval(() => {
      for (const [pc, state] of inputPeers) {
        if (netplay.owner && performance.now() - state.received > 500) release(state);
        if (pc.connectionState === "closed") { release(state); inputPeers.delete(pc); }
      }
      pixelHost?.repair(); // Resend the newest frame if the guest has not confirmed it.
    }, 50);
    const peerById = new Map();
    function cleanupPeer(pc) {
      if (!pc) return;
      clearTimeout(pc._arcadeFailTimer);
      if (inputPeers.has(pc)) {
        release(inputPeers.get(pc));
        inputPeers.delete(pc);
      }
      framePeers.get(pc)?.close();
      framePeers.delete(pc);
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.ondatachannel = null;
      try { if (pc.connectionState !== "closed") pc.close(); } catch (_) {}
    }

    // Upstream creates new peers on users-updated, but does not prune departed peers.
    override("updatePlayersTable", original => function (...args) {
      const active = new Set(Object.values(this.players || {}).map(player => player.socketId));
      for (const [id, peer] of Object.entries(this.peerConnections || {})) {
        if (active.has(id)) continue;
        cleanupPeer(peer.pc);
        cleanupPeer(peerById.get(id));
        peerById.delete(id);
        delete this.peerConnections[id];
      }
      for (const [id, pc] of [...peerById.entries()]) {
        if (active.has(id)) continue;
        cleanupPeer(pc);
        peerById.delete(id);
      }
      return original.apply(this, args);
    });
    override("leaveRoom", original => function (...args) {
      stopHostCapture();
      for (const pc of peerById.values()) cleanupPeer(pc);
      peerById.clear();
      for (const state of inputPeers.values()) release(state);
      inputPeers.clear();
      return original.apply(this, args);
    });

    // Capture the core's native frame, independent of the host window size.
    // The grabber samples the exact game viewport (not the pillarboxed canvas)
    // at console-pixel centres, so nothing is dropped or duplicated. Each frame
    // feeds the lossless channel and, while any guest still needs it, a 2x
    // nearest-neighbour WebRTC video (2x keeps 4:2:0 chroma per console pixel).
    // Upstream captures synchronously inside its Promise executor; replace only
    // the video source and retain its AudioContext capture and stream setup.
    override("initWebRTCStream", original => function (...args) {
      const canvas = emu.frontend?.canvas || emu.canvas;
      if (!canvas?.captureStream || this.localStream || !Pixels) return original.apply(this, args);
      stopHostCapture();
      const upscale = Pixels.VIDEO_UPSCALE;
      const native = document.createElement("canvas");
      const nctx = native.getContext("2d", { alpha: false });
      const captureCanvas = document.createElement("canvas");
      captureCanvas.width = 256 * upscale;
      captureCanvas.height = 240 * upscale;
      const ctx = captureCanvas.getContext("2d", { alpha: false });
      if (!ctx || !nctx) throw new Error("无法创建 NES 串流画布");
      // Frame-accurate capture: one video frame per emulator frame when supported.
      let stream = captureCanvas.captureStream(0);
      let track = stream.getVideoTracks()[0];
      const manual = typeof track?.requestFrame === "function";
      if (!manual) {
        stream.getTracks().forEach(t => t.stop());
        stream = captureCanvas.captureStream(60);
        track = stream.getVideoTracks()[0];
      }
      const host = pixelHost = new Pixels.PixelHost();
      let grabber = null;
      let lastVideoAt = -Infinity;
      const VIDEO_BACKUP_FPS = 5;
      stopHostCapture = () => {
        grabber?.stop();
        if (hostGrabber === grabber) hostGrabber = null;
        stream.getTracks().forEach(t => t.stop());
        for (const peer of framePeers.values()) peer.close();
        framePeers.clear();
        if (pixelHost === host) pixelHost = null;
        stopHostCapture = () => {};
      };
      try {
        grabber = hostGrabber = Pixels.createGrabber(emu, (image, aspect) => {
          if (stopped || track.readyState === "ended") return;
          host.frame(image, aspect);
          // Keep a low-rate VP8 safety net warm. A lossless handshake used to
          // stop this source completely, leaving no picture during a delta stall.
          if (host.allPixel(peer => !peer.closed) &&
              performance.now() - lastVideoAt < 1000 / VIDEO_BACKUP_FPS) return;
          lastVideoAt = performance.now();
          if (native.width !== image.width || native.height !== image.height) {
            native.width = image.width;
            native.height = image.height;
          }
          nctx.putImageData(image, 0, 0);
          const w = image.width * upscale, h = image.height * upscale;
          if (captureCanvas.width !== w || captureCanvas.height !== h) {
            captureCanvas.width = w;
            captureCanvas.height = h;
          }
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(native, 0, 0, w, h);
          if (manual) track.requestFrame();
        });
      } catch (error) {
        stopHostCapture();
        throw error;
      }
      const own = Object.getOwnPropertyDescriptor(canvas, "captureStream");
      canvas.captureStream = () => stream;
      try {
        const result = original.apply(this, args);
        if (!this.localStream) stopHostCapture();
        return result;
      } catch (error) {
        stopHostCapture();
        throw error;
      }
      finally {
        if (own) Object.defineProperty(canvas, "captureStream", own);
        else delete canvas.captureStream;
      }
    });
    const tuning = new WeakMap();
    const relayed = new WeakMap();
    function tuneSender(pc, relay) {
      if (relay !== undefined) relayed.set(pc, !!relay);
      const task = (tuning.get(pc) || Promise.resolve()).then(async () => {
        if (stopped || pc.connectionState === "closed") return;
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        if (!sender) return;
        if (!sender.getParameters().encodings?.length) return; // Retry once negotiation is stable.
        try { sender.track.contentHint = "detail"; } catch (_) {}
        // Keep VP8 alive at a low rate so a stalled delta stream can fall back
        // immediately, without paying the full 60 fps video bandwidth cost.
        const peer = framePeers.get(pc);
        const lossless = !!(peer && (peer.healthy ? peer.healthy() : peer.enabled));
        const configure = layers => {
          const params = sender.getParameters();
          params.degradationPreference = "maintain-resolution";
          // The source is already an integer multiple of the native frame; never
          // rescale it. The bitrate is a ceiling, not a fixed rate or a minimum.
          for (const encoding of params.encodings) {
            encoding.active = true;
            encoding.scaleResolutionDownBy = 1;
            encoding.maxFramerate = lossless ? 5 : 60;
            encoding.maxBitrate = lossless ? (relayed.get(pc) ? 250000 : 500000) :
              (relayed.get(pc) ? 2500000 : 6000000);
            // Upstream asks for L1T2; under load the guest then sees only every
            // other frame, which erases sprites that games flicker at 30 Hz.
            if (layers) encoding.scalabilityMode = "L1T1";
          }
          return params;
        };
        try {
          await sender.setParameters(configure(true));
        } catch (_) {
          await sender.setParameters(configure(false)); // Browser cannot change scalabilityMode.
        }
      }).catch(() => {}); // Unsupported hints must never break a connection.
      tuning.set(pc, task);
    }
    override("adjustVideoBitrate", () => function (pc, relay) { tuneSender(pc, relay); });

    // VP8 avoids depending on the two machines' hardware H264 encoders/decoders.
    override("_preferH264", () => function (pc) {
      const codecs = global.RTCRtpSender?.getCapabilities("video")?.codecs || [];
      const preferred = codecs.filter(c => c.mimeType.toLowerCase() === "video/vp8");
      const transceiver = pc.getTransceivers().find(t => t.sender.track?.kind === "video");
      if (preferred.length && transceiver?.setCodecPreferences) {
        transceiver.setCodecPreferences([
          ...preferred, ...codecs.filter(c => c.mimeType.toLowerCase() !== "video/vp8"),
        ]);
      }
    });

    function bindHostFrames(pc, channel) {
      framePeers.get(pc)?.close();
      const peer = pixelHost.attach(channel);
      framePeers.set(pc, peer);
      peer.onenable = () => tuneSender(pc); // Reduce the backup video to standby rate.
      channel.onmessage = event => peer.message(event.data);
      channel.onclose = () => {
        peer.close();
        if (framePeers.get(pc) === peer) {
          framePeers.delete(pc);
          tuneSender(pc); // Resume video for this guest.
        }
      };
    }

    override("createPeerConnection", original => function (peerId) {
      // A queued upstream renegotiation must not recreate a kicked guest's connection.
      if (!Object.values(this.players || {}).some(player => player.socketId === peerId)) return null;
      cleanupPeer(this.peerConnections[peerId]?.pc);
      cleanupPeer(peerById.get(peerId));
      peerById.delete(peerId);
      const pc = original.call(this, peerId);
      peerById.set(peerId, pc);
      const entry = this.peerConnections[peerId];
      if (entry) entry.createdAt = Date.now();
      const onicecandidate = pc.onicecandidate;
      pc.onicecandidate = event => {
        if (stopped || this.peerConnections[peerId]?.pc !== pc) return;
        onicecandidate?.call(pc, event);
      };
      const onconnectionstatechange = pc.onconnectionstatechange;
      pc.onconnectionstatechange = event => {
        if (stopped || this.peerConnections[peerId]?.pc !== pc) return;
        if (pc.connectionState === "failed") {
          clearTimeout(pc._arcadeFailTimer);
          pc._arcadeFailTimer = setTimeout(() => {
            if (!stopped && this.peerConnections[peerId]?.pc === pc &&
                pc.connectionState === "failed") {
              this.createPeerConnection(peerId);
            }
          }, 1500);
          return;
        }
        onconnectionstatechange?.call(pc, event);
      };
      try {
        bindInputs(pc, peerId, pc.createDataChannel("nes-input-state-v1", {
          ordered: false, maxRetransmits: 0,
        }));
      } catch (_) {} // Keep reliable input for browsers without partial reliability.
      if (pixelHost) {
        try { bindHostFrames(pc, pc.createDataChannel(Pixels.LABEL, Pixels.CHANNEL_OPTIONS)); } catch (_) {}
      }
      pc.addEventListener("signalingstatechange", () => {
        if (pc.signalingState === "stable") tuneSender(pc);
      });
      // Let the upstream initial setParameters operation finish first.
      Promise.resolve().then(() => tuneSender(pc));
      return pc;
    });

    override("requestRenegotiate", original => function (peerId, reason) {
      if (!emu.isNetplay || stopped) return;
      const entry = this.peerConnections[peerId];
      if (!entry || entry.pc.connectionState === "closed") return;
      // A timeout belonging to a discarded connection must not reset its replacement.
      if (reason === "stream-timeout" && Date.now() - entry.createdAt < 14500) return;
      const peer = framePeers.get(entry.pc);
      const input = inputPeers.get(entry.pc);
      const lastActive = Math.max(peer?.lastAckAt ?? -Infinity, input?.received ?? -Infinity);
      if (reason === "ice-disconnected" && performance.now() - lastActive < 800) return;
      if (Date.now() - (entry.lastRetry || 0) < 1500) return;
      entry.lastRetry = Date.now();
      original.call(this, peerId, reason);
    });

    async function update() {
      try {
        const peers = [];
        for (const entry of Object.values(netplay.peerConnections)) {
          const stats = await entry.pc.getStats();
          const video = [...stats.values()].find(s => s.kind === "video" && s.type === "outbound-rtp");
          const transport = [...stats.values()].find(s => s.type === "transport" && s.selectedCandidatePairId);
          const pair = transport ? stats.get(transport.selectedCandidatePairId) :
            [...stats.values()].find(s => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
          const candidate = id => {
            const c = stats.get(id);
            return c ? { type: c.candidateType, protocol: c.protocol, address: c.address, port: c.port } : null;
          };
          const previous = previousStats.get(entry.pc);
          const frames = video?.framesEncoded || 0;
          const elapsed = previous && video ? (video.timestamp - previous.timestamp) / 1000 : 0;
          const delta = key => previous && video ? video[key] - previous[key] : NaN;
          const encoded = delta("framesEncoded");
          const average = (key, count) => count > 0 && Number.isFinite(delta(key)) ? 1000 * delta(key) / count : null;
          const fps = elapsed > 0 && frames >= previous.frames ? (frames - previous.frames) / elapsed : null;
          if (video) previousStats.set(entry.pc, { ...video, frames });
          const pixelPeer = framePeers.get(entry.pc);
          let pixel = null;
          if (pixelPeer) {
            const s = pixelPeer.stats, t = performance.now();
            const count = s.sent;
            const captured = pixelHost?.stats.captured || 0;
            const healthy = pixelPeer.healthy ? pixelPeer.healthy() : pixelPeer.enabled;
            const last = previousPixel.get(pixelPeer);
            const seconds = last ? (t - last.t) / 1000 : 0;
            const countDelta = last ? count - last.count : 0;
            const capturedDelta = last && healthy ? captured - (last.captured || 0) : 0;
            previousPixel.set(pixelPeer, { t, count, bytes: s.bytes, captured });
            pixel = { ...s, enabled: pixelPeer.enabled,
              fps: seconds > 0 ? Math.max(countDelta, capturedDelta) / seconds : null,
              kbps: seconds > 0 ? 8 * (s.bytes - last.bytes) / seconds / 1000 : null };
          }
          peers.push({
            fps,
            encodeMs: average("totalEncodeTime", encoded),
            inputTransport: inputPeers.get(entry.pc)?.channel.readyState === "open" ? "unreliable-state" : "reliable-fallback",
            state: entry.pc.connectionState,
            frames,
            bytes: video?.bytesSent || 0,
            codec: video && stats.get(video.codecId)?.mimeType,
            framesSent: video?.framesSent,
            framesEncoded: video?.framesEncoded,
            keyFramesEncoded: video?.keyFramesEncoded,
            packetsLost: video?.packetsLost,
            pliCount: video?.pliCount,
            qualityLimitationReason: video?.qualityLimitationReason,
            pixel,
            path: pair ? {
              local: candidate(pair.localCandidateId), remote: candidate(pair.remoteCandidateId),
              roundTripTime: pair.currentRoundTripTime,
            } : null,
            ice: entry.pc.connectionState === "connected" ? null : (() => {
              const list = type => [...stats.values()].filter(s => s.type === type)
                .map(c => (c.candidateType || "?") + ":" + (c.address || "?") + ":" + c.port + "/" + c.protocol);
              const pairs = {};
              for (const s of stats.values()) if (s.type === "candidate-pair") pairs[s.state] = (pairs[s.state] || 0) + 1;
              return { ice: entry.pc.iceConnectionState, gathering: entry.pc.iceGatheringState,
                local: list("local-candidate").slice(0, 8), remote: list("remote-candidate").slice(0, 8), pairs };
            })(),
          });
        }
        if (stopped) return;
        snapshot = {
          role: "host", joined: !!emu.isNetplay, peers,
          pixel: {
            active: peers.some(p => p.pixel?.enabled),
            size: pixelHost?.current ? [pixelHost.current.width, pixelHost.current.height] : null,
            capture: hostGrabber ? { ...hostGrabber.stats } : null,
            hidden: document.hidden, hiddenFrames: hiddenTicker?.stats.hiddenFrames ?? null,
            host: pixelHost ? { ...pixelHost.stats } : null,
          },
        };
        if (location.protocol === "http:" && snapshot.joined && netplay.socket?.connected &&
            Date.now() - lastDiagnostics >= 3000) {
          lastDiagnostics = Date.now();
          netplay.socket.emit("stream-diagnostics", {
            room: new URLSearchParams(location.search).get("room"), ...snapshot,
          });
        }
        const metrics = peers.find(p => p.state === "connected");
        const rtt = metrics?.path?.roundTripTime != null ? " · RTT " + (metrics.path.roundTripTime * 1000).toFixed(0) + " ms" : "";
        if (!emu.isNetplay) {
          status.textContent = "串流：正在自动连接房间";
        } else if (!peers.length) {
          status.textContent = "串流：等待另一位玩家";
        } else if (snapshot.pixel.active) {
          const lossless = peers.find(p => p.pixel?.enabled)?.pixel || metrics?.pixel;
          const size = snapshot.pixel.size;
          status.textContent = "主机串流：已连接 · 无损像素直传 · 已发送 " + (lossless?.sent || 0) + " 帧" +
            (size ? " · " + size[0] + "×" + size[1] : "") +
            (lossless?.fps != null ? " · " + lossless.fps.toFixed(0) + " FPS" : "") +
            (lossless?.kbps != null ? " · " + (lossless.kbps / 1000).toFixed(2) + " Mbps" : "") + rtt;
        } else {
          const connected = peers.some(p => p.state === "connected");
          const frames = Math.max(...peers.map(p => p.frames));
          const codec = peers.find(p => p.codec)?.codec?.replace("video/", "") || "";
          status.textContent = "主机串流：" + (connected ? "已连接" : "正在连接") + " · " +
            (connected && frames ? "视频回退 · " : "") +
            "已发送 " + frames + " 帧" +
            (codec ? " · " + codec : "") +
            (metrics?.fps != null ? " · " + metrics.fps.toFixed(0) + " FPS" : "") + rtt +
            (connected && !frames ? "（等待视频画面）" : "");
          const ice = !connected && peers.find(p => p.ice)?.ice;
          if (ice) status.textContent += " · ICE " + ice.ice + " · 候选 本地 " + ice.local.length +
            " / 远端 " + ice.remote.length + " · 配对 " + JSON.stringify(ice.pairs);
        }
      } catch (error) {
        if (!stopped) status.textContent = "串流状态读取失败：" + error.message;
      }
      if (!stopped) timer = setTimeout(update, 1000);
    }
    global.__streamDebug = { getState: () => snapshot };
    dispose = () => {
      stopped = true;
      stopHostCapture();
      clearTimeout(timer);
      clearInterval(inputTimer);
      if (emu.isNetplay) netplay.leaveRoom();
      restore.forEach(fn => fn());
      delete global.__streamDebug;
    };
    update();
  }

  global.StreamNetplay = { attach, reset: () => dispose() };
})(window);
