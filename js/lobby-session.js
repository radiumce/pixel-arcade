/* Bridge lobby codes to the actual game session. P2 follows P1's game. */
(function (global) {
  const params = new URLSearchParams(location.search);
  const code = String(params.get("room") || "").toUpperCase().trim();
  const role = params.get("role") === "guest" ? "guest" : "host";
  const endpoint = "/api/lobby/" + encodeURIComponent(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function request(options) {
    const res = await fetch(endpoint, { cache: "no-store", ...options, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "房间连接失败");
    return data.room;
  }
  async function publish(settings) {
    const hostToken = sessionStorage.getItem("lobby-host-" + code);
    if (!hostToken) throw new Error("请返回大厅重新创建房间");
    return request({ method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, hostToken }) });
  }
  async function waitForHost(statusEl) {
    while (true) {
      const room = await request();
      if (room.streamSessionId) return room;
      EmuCommon.setStatus(statusEl, "P2：等待 P1 选择游戏并准备房间…");
      await sleep(1000);
    }
  }
  async function waitForEmulator() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const emu = global.EJS_emulator;
      if (emu?.netplay && emu.gameManager?.functions && emu.gameManager.getFrameNum() > 0) return emu;
      await sleep(100);
    }
    throw new Error("游戏加载超时，请检查网络后重试");
  }
  function attemptOpenRoom(emu) {
    const netplay = emu.netplay;
      const frontend = emu.frontend || emu;
    netplay.name = "P1";
    return new Promise((resolve, reject) => {
      const joined = netplay.roomJoined;
      const joinError = netplay.showJoinErrorDialog;
      const display = frontend.displayMessage;
      let settled = false;
      const timer = setTimeout(() => finish(new Error("联机服务连接超时，请重试")), 15000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        netplay.roomJoined = joined;
        netplay.showJoinErrorDialog = joinError;
        if (error) {
          frontend.displayMessage = () => {};
          try { netplay.leaveRoom(); } finally { frontend.displayMessage = display; }
          reject(error);
        } else {
          frontend.displayMessage = display;
          resolve(netplay.extra.sessionid);
        }
      }
      netplay.roomJoined = function (...args) {
        try { joined.apply(this, args); finish(); } catch (error) { finish(error); }
      };
      netplay.showJoinErrorDialog = function (_id, _name, _max, error) {
        finish(new Error("加入失败：" + error));
      };
      frontend.displayMessage = function (message, ...args) {
        if (/^Room error:|^Connect error:|^Socket.IO unavailable|^Network error/.test(String(message))) {
          finish(new Error(String(message)));
          return;
        }
        return display.call(this, message, ...args);
      };
      try {
        netplay.openRoom(code, 2, code);
      } catch (error) { finish(error); }
    });
  }
  async function connectStream(emu) {
    try {
      return await attemptOpenRoom(emu);
    } catch (_) {
      try { await fetch("/api/netplay-health", { cache: "no-store", signal: AbortSignal.timeout(5000) }); } catch (_) {}
      await sleep(400);
      return await attemptOpenRoom(emu);
    }
  }
  function hideGuestRomControls() {
    if (role === "guest") document.querySelectorAll("[data-host-only]").forEach(el => { el.hidden = true; });
  }
  function lockRomControls(locked = true) {
    document.querySelectorAll("[data-host-only] button:not([data-platform-choice]), [data-host-only] input").forEach(el => {
      el.disabled = locked;
    });
  }
  function fail(statusEl, error) {
    EmuCommon.setStatus(statusEl, error.message || String(error), "error");
    const retry = document.getElementById("btnRetry");
    if (retry) retry.hidden = false;
  }
  document.getElementById("btnRetry")?.addEventListener("click", () => location.reload());
  if (!code) location.replace("/online.html");
  global.LobbySession = { code, role, request, publish, waitForHost, waitForEmulator,
    connectStream, hideGuestRomControls, lockRomControls, fail };
})(window);
