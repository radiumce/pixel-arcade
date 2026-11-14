/* Shared EmulatorJS helpers for local + online pages */
(function (global) {
  const EJS_CDN = "https://cdn.emulatorjs.org/nightly/data/";

  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = kind || "";
  }

  function formatSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function stripRomExt(name) {
    return String(name || "").replace(/\.(nes|unf|fds|nsf|zip)$/i, "");
  }

  /** Stable positive numeric hash for EJS_gameID (netplay requires a number). */
  function gameIdFromName(name) {
    const s = String(name || "nes");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const id = (h >>> 0) % 2147483646;
    return id === 0 ? 1 : id;
  }

  const CART_PALETTES = [
    { top: "#f7c926", bottom: "#d99a00", stripe: "#c81d32" }, // Classic Famicom Yellow
    { top: "#ff3b56", bottom: "#c4142d", stripe: "#f4b942" }, // Famicom Crimson
    { top: "#3898ff", bottom: "#165bc7", stripe: "#2ecc71" }, // Cobalt Arcade Blue
    { top: "#2ee57d", bottom: "#109848", stripe: "#3898ff" }, // Emerald Green
    { top: "#a855f7", bottom: "#6d28d9", stripe: "#f7c926" }, // Cyber Purple
    { top: "#ff7828", bottom: "#c94608", stripe: "#3898ff" }, // Sunset Orange
  ];

  function switchTab(tabId) {
    const buttons = document.querySelectorAll('[role="tab"][data-tab]');
    const panels = document.querySelectorAll('[role="tabpanel"][data-tab-panel]');
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tabId;
    });
  }

  function initTabs(defaultTab = "play") {
    const buttons = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
    buttons.forEach((btn, idx) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const visibleBtns = buttons.filter((b) => !b.hidden);
        const curIdx = visibleBtns.indexOf(btn);
        if (curIdx < 0) return;
        const nextIdx = (curIdx + (e.key === "ArrowRight" ? 1 : visibleBtns.length - 1)) % visibleBtns.length;
        const nextBtn = visibleBtns[nextIdx];
        if (nextBtn) {
          switchTab(nextBtn.dataset.tab);
          nextBtn.focus();
        }
      });
    });
    switchTab(defaultTab);
  }

  let currentLoadedRom = null;
  let currentPlatform = "nes";
  let runningPlatform = null;
  const loadedGames = { nes: null, arcade: null };
  const platformListeners = new Set();

  function isArcadeName(name) { return /\.zip$/i.test(String(name || "")); }
  function platformForRom(name) { return isArcadeName(name) ? "arcade" : "nes"; }
  function getPlatform() { return currentPlatform; }
  function setPlatform(platform) {
    currentPlatform = platform === "arcade" ? "arcade" : "nes";
    document.body.dataset.platform = currentPlatform;
    global.GamepadInput?.setPlatform(runningPlatform || currentPlatform);
    document.querySelectorAll("[data-platform-choice]").forEach(btn => {
      const active = btn.dataset.platformChoice === currentPlatform;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-platform-content]").forEach(el => {
      const role = global.LobbySession?.role;
      const hiddenForRole = (role === "guest" && el.hasAttribute("data-host-only")) ||
        (role === "host" && el.hasAttribute("data-guest-only"));
      el.hidden = el.dataset.platformContent !== currentPlatform || hiddenForRole;
    });
    const arcade = currentPlatform === "arcade";
    document.querySelectorAll("[data-rom-accept]").forEach(el => {
      el.accept = arcade ? ".zip,application/zip" : ".nes,.unf,.fds,.nsf,application/octet-stream";
    });
    document.querySelectorAll("[data-rom-upload-label]").forEach(el => { el.textContent = arcade ? "上传街机 ZIP" : "上传 NES ROM"; });
    document.querySelectorAll("[data-nes-only]").forEach(el => { el.hidden = arcade; });
    renderRomList();
    renderConsoleState();
    platformListeners.forEach(fn => fn(currentPlatform));
    const testButton = document.getElementById("btnTestRom");
    if (testButton) testButton.hidden = currentPlatform === "arcade" ||
      (allRoms.length > 0 && !allRoms.some(rom => rom.url === "/roms/super-tilt-bro.nes"));
    return currentPlatform;
  }
  function onPlatformChange(fn) { platformListeners.add(fn); return () => platformListeners.delete(fn); }

  function renderConsoleState() {
    const deck = document.querySelector(".famicom-deck-card");
    if (!deck) return;
    const arcade = currentPlatform === "arcade";
    const name = loadedGames[currentPlatform];
    deck.dataset.platform = currentPlatform;
    deck.dataset.loaded = String(!!name);
    const status = document.getElementById("fcStatusText");
    const pill = document.getElementById("fcStatusPill");
    const button = document.getElementById("btnOpenRomTab");
    if (status) {
      status.textContent = name ? (arcade ? "已投币就绪：" : "已插卡：") + stripRomExt(name) : (arcade ? "等待装载游戏" : "未插卡");
      status.title = name || "";
    }
    pill?.classList.toggle("loaded", !!name);
    if (button) button.textContent = name ? (arcade ? "更换游戏" : "更换卡带") : (arcade ? "选择游戏" : "选择卡带");
    const title = document.getElementById(arcade ? "arcadeCabinetTitle" : "fcCartTitle");
    if (title && name) { title.textContent = stripRomExt(name); title.title = name; }
  }

  function arcadeCabinetSvg(canSwitchTab) {
    return `<svg class="arcade-svg" viewBox="0 0 640 220" role="img" aria-label="双人街机机台">
      <defs>
        <linearGradient id="arcadeBody" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#30394b"/><stop offset="1" stop-color="#121927"/></linearGradient>
        <linearGradient id="arcadePanel" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#394255"/><stop offset="1" stop-color="#202838"/></linearGradient>
        <linearGradient id="arcadeScreen" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#17283a"/><stop offset="1" stop-color="#080e16"/></linearGradient>
      </defs>
      <ellipse cx="320" cy="207" rx="230" ry="10" fill="rgba(0,0,0,.5)"/>
      <path d="M174 15H466L486 88 453 201H187L154 88Z" fill="url(#arcadeBody)" stroke="#65718a" stroke-width="2"/>
      <path d="M182 15H458L465 40H175Z" fill="#e34c3f"/>
      <text x="320" y="33" text-anchor="middle" fill="#fff3cd" font-size="13" font-weight="900" letter-spacing="4">FINALBURN NEO</text>
      <path d="M191 49H449L459 112H181Z" fill="#080d15" stroke="#55647e" stroke-width="3"/>
      <path d="M202 57H438L445 103H195Z" fill="url(#arcadeScreen)"/>
      <text id="arcadeCabinetTitle" x="320" y="78" text-anchor="middle" fill="#75d9ff" font-size="12" font-weight="700">${canSwitchTab ? "选择 ZIP 游戏开始" : "等待 P1 选择游戏"}</text>
      <text x="320" y="95" text-anchor="middle" fill="#65859d" font-size="7" letter-spacing="2">INSERT COIN · 2 PLAYERS</text>
      <path d="M172 115H468L491 157 466 177H174L149 157Z" fill="url(#arcadePanel)" stroke="#68758e" stroke-width="2"/>
      <path d="M174 177H466L453 201H187Z" fill="#a93232"/>
      <text x="320" y="193" text-anchor="middle" fill="#f7d998" font-size="9" font-weight="800" letter-spacing="3">ARCADE CONTROL DECK</text>
      <g stroke="#0a0e14" stroke-width="4" stroke-linecap="round"><path d="M235 140v-20"/><path d="M405 140v-20"/></g>
      <g fill="#e9554b" stroke="#ff9a83"><circle cx="235" cy="117" r="8"/><circle cx="405" cy="117" r="8"/></g>
      <g fill="#efb93f" stroke="#ffe19a"><circle cx="270" cy="132" r="7"/><circle cx="289" cy="127" r="7"/><circle cx="308" cy="132" r="7"/><circle cx="440" cy="132" r="7"/><circle cx="459" cy="127" r="7"/></g>
      <g fill="#4db7d8" stroke="#a5eaff"><circle cx="270" cy="150" r="7"/><circle cx="289" cy="145" r="7"/><circle cx="308" cy="150" r="7"/><circle cx="421" cy="132" r="7"/><circle cx="440" cy="150" r="7"/><circle cx="459" cy="145" r="7"/></g>
      <g fill="#111927" stroke="#77859e"><rect x="205" y="161" width="40" height="7" rx="3"/><rect x="395" y="161" width="40" height="7" rx="3"/></g>
      <text x="225" y="166" text-anchor="middle" fill="#d9e3f1" font-size="5">1P START</text><text x="415" y="166" text-anchor="middle" fill="#d9e3f1" font-size="5">2P START</text>
    </svg>`;
  }

  function renderFamicomDeck(containerEl, opts = {}) {
    if (!containerEl) return;
    const canSwitchTab = opts.canSwitchTab !== false;
    containerEl.classList.add("card", "famicom-deck-card");
    containerEl.dataset.loaded = "false";
    containerEl.innerHTML = `
      <div class="platform-tabs" role="tablist" aria-label="游戏机类型" data-host-only>
        <button type="button" role="tab" class="platform-tab" data-platform-choice="nes" aria-selected="true">红白机 <span>NES</span></button>
        <button type="button" role="tab" class="platform-tab" data-platform-choice="arcade" aria-selected="false">街机 <span>FBNeo</span></button>
      </div>
      <div class="famicom-deck-header">
        <div class="famicom-status-pill" id="fcStatusPill">
          <span class="famicom-led-dot"></span>
          <span class="pill-text" id="fcStatusText">未插卡</span>
        </div>
        <div class="row" style="gap:8px">
          ${canSwitchTab ? '<button type="button" class="secondary" id="btnOpenRomTab" style="padding:5px 12px;font-size:0.82rem">选择卡带</button>' : ""}
        </div>
      </div>
      <div data-platform-content="nes">
      <div class="famicom-stage" id="fcStage" title="${canSwitchTab ? "点击前往游戏列表选择卡带" : "红白机状态"}">
        <svg class="famicom-svg" viewBox="0 0 640 210" role="img" aria-label="红白机主机与卡带插槽">
          <defs>
            <linearGradient id="fcBodyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#f8f4e9"/>
              <stop offset="65%" stop-color="#e8e0cd"/>
              <stop offset="100%" stop-color="#cfc5ae"/>
            </linearGradient>
            <linearGradient id="fcRedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#c91f37"/>
              <stop offset="60%" stop-color="#9c1426"/>
              <stop offset="100%" stop-color="#700b19"/>
            </linearGradient>
            <linearGradient id="fcGoldGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f6df8b"/>
              <stop offset="50%" stop-color="#d4af37"/>
              <stop offset="100%" stop-color="#9e7a18"/>
            </linearGradient>
            <linearGradient id="fcCartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" id="fcCartStop1" stop-color="#f7c926"/>
              <stop offset="100%" id="fcCartStop2" stop-color="#d99a00"/>
            </linearGradient>
          </defs>

          <!-- Console Shadow -->
          <ellipse cx="320" cy="196" rx="250" ry="10" fill="rgba(0,0,0,0.45)"/>

          <!-- Coiled Controller Cables -->
          <path d="M 105 150 C 65 150, 58 120, 92 115 C 62 110, 65 85, 105 90" fill="none" stroke="#1e2430" stroke-width="6" stroke-linecap="round"/>
          <path d="M 535 150 C 575 150, 582 120, 548 115 C 578 110, 575 85, 535 90" fill="none" stroke="#1e2430" stroke-width="6" stroke-linecap="round"/>

          <!-- Maroon Base Chassis -->
          <rect x="130" y="138" width="380" height="54" rx="14" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="2"/>
          <!-- Side Controller Holsters -->
          <rect x="92" y="88" width="52" height="96" rx="10" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="2"/>
          <rect x="496" y="88" width="52" height="96" rx="10" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="2"/>

          <!-- Main Ivory Upper Deck -->
          <rect x="142" y="74" width="356" height="96" rx="12" fill="url(#fcBodyGrad)" stroke="#b8ae96" stroke-width="2"/>
          <!-- Molded Deck Lines -->
          <line x1="158" y1="90" x2="482" y2="90" stroke="#cfc5ae" stroke-width="1.5"/>
          <line x1="210" y1="74" x2="210" y2="170" stroke="#d5cbb4" stroke-width="1.5"/>
          <line x1="430" y1="74" x2="430" y2="170" stroke="#d5cbb4" stroke-width="1.5"/>

          <!-- Left Docked Controller (Player I) -->
          <g transform="translate(97, 74)">
            <rect x="0" y="0" width="42" height="102" rx="8" fill="url(#fcRedGrad)" stroke="#4a0710" stroke-width="1.5"/>
            <rect x="4" y="6" width="34" height="90" rx="5" fill="url(#fcGoldGrad)"/>
            <!-- D-Pad -->
            <path d="M17 20 h8 v7 h7 v8 h-7 v7 h-8 v-7 h-7 v-8 h7 z" fill="#1d2026" stroke="#c8bfa8" stroke-width="0.8"/>
            <!-- Select / Start -->
            <rect x="12" y="52" width="7" height="3" rx="1.5" fill="#2b2f36"/>
            <rect x="23" y="52" width="7" height="3" rx="1.5" fill="#2b2f36"/>
            <!-- B / A Buttons -->
            <circle cx="15" cy="74" r="5.5" fill="#c91f37" stroke="#590813" stroke-width="1"/>
            <circle cx="28" cy="68" r="5.5" fill="#c91f37" stroke="#590813" stroke-width="1"/>
            <text x="21" y="91" text-anchor="middle" font-size="8" font-weight="800" fill="#4a0710">I</text>
          </g>

          <!-- Right Docked Controller (Player II) -->
          <g transform="translate(501, 74)">
            <rect x="0" y="0" width="42" height="102" rx="8" fill="url(#fcRedGrad)" stroke="#4a0710" stroke-width="1.5"/>
            <rect x="4" y="6" width="34" height="90" rx="5" fill="url(#fcGoldGrad)"/>
            <!-- D-Pad -->
            <path d="M17 20 h8 v7 h7 v8 h-7 v7 h-8 v-7 h-7 v-8 h7 z" fill="#1d2026" stroke="#c8bfa8" stroke-width="0.8"/>
            <!-- Mic Grill -->
            <rect x="13" y="50" width="16" height="5" rx="2" fill="#2b2f36"/>
            <!-- B / A Buttons -->
            <circle cx="15" cy="74" r="5.5" fill="#c91f37" stroke="#590813" stroke-width="1"/>
            <circle cx="28" cy="68" r="5.5" fill="#c91f37" stroke="#590813" stroke-width="1"/>
            <text x="21" y="91" text-anchor="middle" font-size="8" font-weight="800" fill="#4a0710">II</text>
          </g>

          <!-- Power Switch & LED (Left Deck) -->
          <text x="176" y="106" text-anchor="middle" font-size="7.5" font-weight="800" fill="#6b6252" letter-spacing="0.06em">POWER</text>
          <circle class="fc-power-led" cx="176" cy="115" r="4" />
          <rect x="166" y="123" width="20" height="28" rx="4" fill="#252830" stroke="#b8ae96" stroke-width="1"/>
          <g class="fc-power-knob">
            <rect x="168" y="135" width="16" height="13" rx="3" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="1"/>
            <line x1="171" y1="141" x2="181" y2="141" stroke="#f8f4e9" stroke-width="1.5"/>
          </g>

          <!-- Reset Button (Right Deck) -->
          <text x="464" y="114" text-anchor="middle" font-size="7.5" font-weight="800" fill="#6b6252" letter-spacing="0.06em">RESET</text>
          <rect x="452" y="122" width="24" height="14" rx="4" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="1"/>

          <!-- Cartridge Slot Housing (Center Top) -->
          <rect x="220" y="64" width="200" height="50" rx="8" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="2"/>
          <!-- Inner Dark Slot Well -->
          <rect x="230" y="72" width="180" height="28" rx="4" fill="#13161d" stroke="#42060e" stroke-width="1.5"/>
          <!-- Slot Closed Flap (fades when cartridge is inserted) -->
          <g class="fc-slot-flap">
            <rect x="233" y="74" width="174" height="24" rx="3" fill="#851222"/>
            <text x="320" y="89" text-anchor="middle" font-size="9" font-weight="800" fill="#f3d97d" letter-spacing="0.16em">CASSETTE</text>
          </g>

          <!-- Empty State Hint Outline (above slot when unloaded) -->
          <g class="fc-empty-hint">
            <rect x="252" y="16" width="136" height="46" rx="7" fill="rgba(61,156,240,0.06)" stroke="#3d9cf0" stroke-width="1.5" stroke-dasharray="5 4"/>
            <text x="320" y="43" text-anchor="middle" font-size="11.5" font-weight="700" fill="#7cc0ff">${canSwitchTab ? "点击插卡" : "等待插卡"}</text>
          </g>

          <!-- Inserted Game Cartridge (slides into slot when loaded) -->
          <g class="fc-cartridge" id="fcCartridgeGroup">
            <!-- Cartridge Outer Shell -->
            <path d="M 236 14 H 404 A 8 8 0 0 1 412 22 V 96 H 228 V 22 A 8 8 0 0 1 236 14 Z" fill="url(#fcCartGrad)" stroke="#1b2230" stroke-width="2"/>
            <!-- Cartridge Grip Ribs (Left & Right) -->
            <line x1="233" y1="24" x2="244" y2="24" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <line x1="233" y1="30" x2="244" y2="30" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <line x1="233" y1="36" x2="244" y2="36" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <line x1="396" y1="24" x2="407" y2="24" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <line x1="396" y1="30" x2="407" y2="30" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <line x1="396" y1="36" x2="407" y2="36" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
            <!-- Cartridge White Label Sticker -->
            <rect x="248" y="22" width="144" height="58" rx="5" fill="#f9f8f3" stroke="rgba(0,0,0,0.2)" stroke-width="1"/>
            <!-- Label Top Accent Band -->
            <rect id="fcCartStripe" x="248" y="22" width="144" height="12" rx="4" fill="#c81d32"/>
            <text x="320" y="31" text-anchor="middle" font-size="7.5" font-weight="800" fill="#ffffff" letter-spacing="0.14em">FAMICOM CARTRIDGE</text>
            <!-- Game Title ForeignObject for clean CJK + Ellipsis -->
            <foreignObject x="250" y="35" width="140" height="43">
              <div xmlns="http://www.w3.org/1999/xhtml" class="fc-cart-sticker-wrap">
                <div class="fc-cart-sticker-title" id="fcCartTitle">NES</div>
                <div class="fc-cart-sticker-sub" id="fcCartSub">8-BIT ROM</div>
              </div>
            </foreignObject>
          </g>

          <!-- Front Lip of Slot (overlaps bottom of inserted cartridge for realistic depth) -->
          <rect x="226" y="93" width="188" height="9" rx="3" fill="#9c1426" stroke="#590813" stroke-width="1"/>

          <!-- EJECT Lever (Center Deck) -->
          <rect x="292" y="120" width="56" height="14" rx="4" fill="#cfc5ae" stroke="#b0a58c" stroke-width="1"/>
          <rect x="304" y="118" width="32" height="18" rx="4" fill="url(#fcRedGrad)" stroke="#590813" stroke-width="1"/>
          <text x="320" y="146" text-anchor="middle" font-size="7.5" font-weight="800" fill="#6b6252" letter-spacing="0.12em">EJECT</text>

          <!-- Front Badge: FAMILY COMPUTER -->
          <rect x="236" y="156" width="168" height="22" rx="4" fill="#181a20" stroke="url(#fcGoldGrad)" stroke-width="1.5"/>
          <text x="320" y="170" text-anchor="middle" font-size="9.5" font-weight="800" fill="#f3d97d" letter-spacing="0.14em">FAMILY COMPUTER</text>
        </svg>
      </div>
      </div>
      <div class="arcade-stage" data-platform-content="arcade" hidden>${arcadeCabinetSvg(canSwitchTab)}</div>
    `;

    containerEl.querySelectorAll("[data-platform-choice]").forEach(btn => {
      btn.addEventListener("click", () => setPlatform(btn.dataset.platformChoice));
      btn.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = btn.dataset.platformChoice === "nes" ? "arcade" : "nes";
        setPlatform(next);
        containerEl.querySelector(`[data-platform-choice="${next}"]`)?.focus();
      });
    });

    const openRomTab = () => {
      if (canSwitchTab) switchTab("roms");
    };
    containerEl.querySelector("#btnOpenRomTab")?.addEventListener("click", openRomTab);
    containerEl.querySelector("#fcStage")?.addEventListener("click", () => {
      if (canSwitchTab && !loadedGames.nes) openRomTab();
    });
    containerEl.querySelector(".arcade-stage")?.addEventListener("click", () => {
      if (canSwitchTab && !loadedGames.arcade) openRomTab();
    });
    if (!canSwitchTab) containerEl.querySelector(".platform-tabs")?.remove();
    setPlatform(currentPlatform);

    if (currentLoadedRom) {
      setFamicomCartridge(currentLoadedRom);
    }
  }

  function setFamicomCartridge(gameName) {
    currentLoadedRom = gameName || null;
    if (gameName) loadedGames[platformForRom(gameName)] = gameName;
    const deck = document.querySelector(".famicom-deck-card");
    if (!deck) return;
    const titleEl = document.getElementById("fcCartTitle");
    const subEl = document.getElementById("fcCartSub");
    if (!gameName) {
      renderConsoleState();
      return;
    }
    const cleanTitle = stripRomExt(gameName);
    const hash = gameIdFromName(gameName);
    const palette = CART_PALETTES[hash % CART_PALETTES.length];

    document.getElementById("fcCartStop1")?.setAttribute("stop-color", palette.top);
    document.getElementById("fcCartStop2")?.setAttribute("stop-color", palette.bottom);
    document.getElementById("fcCartStripe")?.setAttribute("fill", palette.stripe);

    if (titleEl) {
      titleEl.textContent = cleanTitle;
      titleEl.title = gameName;
    }
    if (subEl) {
      subEl.textContent = "ID #" + String(hash).slice(0, 5);
    }
    renderConsoleState();
  }

  function defaultControls(platform = "nes") {
    // Keyboard — P1: arrows + K/J ; P2: WASD + Z/X.
    // Gamepad (value2, EmulatorJS native) uses Nintendo's physical layout: the bottom face
    // button is B and the right one is A. Single Joy-Cons (WebHID) go through startJoyConDriver().
    const controls = {
      0: {
        0: { value: "j", value2: "BUTTON_1" },
        2: { value: "shift", value2: "SELECT" },
        3: { value: "enter", value2: "START" },
        4: { value: "up arrow", value2: "DPAD_UP" },
        5: { value: "down arrow", value2: "DPAD_DOWN" },
        6: { value: "left arrow", value2: "DPAD_LEFT" },
        7: { value: "right arrow", value2: "DPAD_RIGHT" },
        8: { value: "k", value2: "BUTTON_2" },
        ...(platform === "arcade" ? {
          1: { value: "l", value2: "BUTTON_3" },
          9: { value: "i", value2: "BUTTON_4" },
          10: { value: "o", value2: "LEFT_SHOULDER" },
          11: { value: "p", value2: "RIGHT_SHOULDER" },
        } : {}),
      },
      1: {
        0: { value: "x", value2: "BUTTON_1" },
        2: { value: platform === "arcade" ? "q" : "i", value2: "SELECT" },
        3: { value: "u", value2: "START" },
        4: { value: "w", value2: "DPAD_UP" },
        5: { value: "s", value2: "DPAD_DOWN" },
        6: { value: "a", value2: "DPAD_LEFT" },
        7: { value: "d", value2: "DPAD_RIGHT" },
        8: { value: "z", value2: "BUTTON_2" },
        ...(platform === "arcade" ? {
          1: { value: "c", value2: "BUTTON_3" },
          9: { value: "v", value2: "BUTTON_4" },
          10: { value: "b", value2: "LEFT_SHOULDER" },
          11: { value: "n", value2: "RIGHT_SHOULDER" },
        } : {}),
      },
      2: {},
      3: {},
    };
    return controls;
  }

  /** Default ICE: China-reachable STUN first; Google as fallback. TURN optional via /api/ice. */
  function defaultIceServers() {
    return [
      { urls: "stun:stun.miwifi.com:3478" },
      { urls: "stun:stun.chat.bilibili.com:3478" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
  }

  const NETPLAY_KEYS = [
    "EJS_netplayServer",
    "EJS_netplayICEServers",
    "EJS_gameID",
    "EJS_DEBUG_XX",
  ];

  const BASE_KEYS = [
    "EJS_player", "EJS_core", "EJS_gameUrl", "EJS_pathtodata", "EJS_gameName",
    "EJS_startOnLoaded", "EJS_language", "EJS_defaultControls", "EJS_Buttons",
    "EJS_emulator", "EJS_READY", "EJS_ready", "EJS_onGameStart", "EJS_controlScheme",
    "EJS_biosUrl", "EJS_gameParentUrl", "EJS_externalFiles", "EJS_dontExtractBIOS",
  ];

  function clearEjsGlobals(extra) {
    const keys = BASE_KEYS.concat(NETPLAY_KEYS).concat(extra || []);
    keys.forEach((k) => {
      try { delete window[k]; } catch (_) { window[k] = undefined; }
    });
  }

  function resetGameContainer() {
    global.StreamNetplay?.reset();
    const shell = document.getElementById("game-shell");
    if (shell) shell.innerHTML = '<div id="game"></div>';
    document.querySelectorAll("script[data-ejs-loader]").forEach((s) => s.remove());
    clearEjsGlobals();
  }

  let cachedIce = null;
  async function loadIceServers() {
    if (cachedIce) return cachedIce;
    try {
      const res = await fetch("/api/ice", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) {
          cachedIce = data.iceServers;
          return cachedIce;
        }
      }
    } catch (_) {}
    cachedIce = defaultIceServers();
    return cachedIce;
  }

  // Game keys (arrows, space, paging keys) would otherwise also scroll the page.
  // Only the browser default is cancelled; EmulatorJS still receives the event.
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Spacebar",
    "PageUp", "PageDown", "Home", "End"]);
  let scrollGuard = false;
  function installScrollGuard() {
    if (scrollGuard) return;
    scrollGuard = true;
    window.addEventListener("keydown", event => {
      if (!SCROLL_KEYS.has(event.key) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const t = event.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
      if (!document.querySelector("#game canvas")) return;
      event.preventDefault();
    }, { capture: true, passive: false });
  }

  /**
   * EmulatorJS's GamepadHandler polls navigator.getGamepads() (which gamepad-input.js extends
   * with virtual Standard Gamepad snapshots for WebHID Joy-Cons). However, GamepadHandler runs
   * its first poll inside its constructor BEFORE EmulatorJS attaches its `connected` listener,
   * so any gamepad that was already connected before the ROM booted is left unselected ("Not
   * Connected") in the Control Settings dropdown. Sync selection + dropdown labels on start and
   * whenever WebHID Joy-Cons connect or disconnect.
   */
  let stopJoyConSync = null;
  function syncEmulatorGamepads(emu, netplay) {
    const frontend = emu?.frontend || emu;
    if (!emu?.gamepad || !frontend) return;

    // Inject a "连接 Joy-Con" button directly inside EmulatorJS's Control Settings popup
    // right next to the "Connected Gamepad" dropdown so users can authorize/re-authorize
    // after Bluetooth re-pairing without leaving the modal or fullscreen view.
    const root = emu.elements?.parent || document.getElementById("game");
    if (root && global.GamepadInput?.JoyConHID?.supported) {
      root.querySelectorAll(".ejs_gamepad_section").forEach((section, idx) => {
        if (section.querySelector("[data-joycon-button]")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary";
        btn.dataset.joyconButton = "1";
        btn.dataset.joyconSlot = String(idx);
        btn.style.cssText = "margin-left:8px;padding:3px 8px;font-size:12px;vertical-align:middle;cursor:pointer;";
        btn.textContent = getPlatform() === "arcade" ? "连接街机手柄" : "连接 Joy-Con";
        ["mousedown", "touchstart"].forEach(evt => btn.addEventListener(evt, e => e.stopPropagation()));
        section.appendChild(btn);
        global.GamepadInput.bindJoyConButton(btn);
      });
    }

    emu.gamepad.updateGamepadState?.();
    const pads = (emu.gamepad.gamepads || []).filter(Boolean);
    const selection = frontend.gamepadSelection;
    if (Array.isArray(selection)) {
      const validIds = new Set(
        pads.map(p => emu.getGamepadSelectionValue?.(p.index) || (p.id + "_" + p.index))
      );
      let changed = false;
      for (let i = 0; i < selection.length; i++) {
        if (selection[i] && !validIds.has(selection[i])) {
          selection[i] = "";
          changed = true;
        }
      }
      const maxPlayers = netplay ? 1 : selection.length;
      for (const id of validIds) {
        if (selection.includes(id)) continue;
        for (let i = 0; i < maxPlayers; i++) {
          if (selection[i] === "") {
            selection[i] = id;
            changed = true;
            break;
          }
        }
      }
      const firstSelect = frontend.gamepadLabels?.[0];
      const expectedOptionCount = validIds.size + 1;
      if (changed || (firstSelect && firstSelect.options?.length !== expectedOptionCount)) {
        frontend.updateGamepadLabels?.();
      }
    }

    // Migrate legacy LEFT_STICK/RIGHT_STICK bindings or old builds where all gamepad bindings were missing,
    // but only once per emulator boot so user-deleted ("Clear") mappings in Control Settings are preserved.
    if (emu.controls && !emu._controlsMigrated) {
      emu._controlsMigrated = true;
      const defaults = defaultControls(runningPlatform || currentPlatform);
      let repaired = false;
      for (const player of [0, 1]) {
        const pControls = emu.controls[player] = emu.controls[player] || {};
        const defEntries = Object.entries(defaults[player]);
        const hasAnyGamepadBinding = defEntries.some(([ idx ]) => {
          const v = pControls[idx]?.value2;
          return v && !/^(LEFT|RIGHT)_STICK/.test(String(v));
        });
        for (const [index, def] of defEntries) {
          const existed = Boolean(pControls[index]);
          const slot = pControls[index] || (pControls[index] = { value: def.value });
          const v = slot.value2;
          if (!existed || /^(LEFT|RIGHT)_STICK/.test(String(v)) || (!hasAnyGamepadBinding && !v)) {
            slot.value2 = def.value2;
            repaired = true;
          }
        }
      }
      if (repaired) {
        emu.setupKeys?.();
        frontend.checkGamepadInputs?.();
        emu.saveSettings?.();
      }
    }
  }

  function attachGamepadSync(netplay) {
    stopJoyConSync?.();
    stopJoyConSync = null;
    const tick = () => {
      if (window.EJS_emulator) syncEmulatorGamepads(window.EJS_emulator, netplay);
    };
    tick();
    const unsub = global.GamepadInput?.JoyConHID?.onChange?.(tick);
    const timer = setInterval(tick, 300);
    stopJoyConSync = () => {
      clearInterval(timer);
      unsub?.();
    };
  }

  /**
   * @param {object} opts
   * @param {string} opts.romUrl
   * @param {string} [opts.gameName]
   * @param {boolean} [opts.netplay]
   * @param {HTMLElement} [opts.statusEl]
   */
  async function startEmulator(opts) {
    const romUrl = opts.romUrl;
    const gameName = opts.gameName || "NES";
    const netplay = !!opts.netplay;
    const statusEl = opts.statusEl;
    const platform = opts.platform || platformForRom(gameName);
    const arcade = platform === "arcade";
    if (!arcade && isArcadeName(gameName)) throw new Error("ZIP 游戏请在「街机」平台启动");
    if (arcade && !isArcadeName(gameName)) throw new Error("街机平台需要 FBNeo romset ZIP 文件");

    switchTab("play");
    runningPlatform = platform;
    setPlatform(platform);
    setFamicomCartridge(gameName);

    stopJoyConSync?.();
    stopJoyConSync = null;
    resetGameContainer();
    installScrollGuard();
    attachGamepadSync(netplay);

    window.EJS_player = "#game";
    window.EJS_core = arcade ? "fbneo" : "nestopia";
    window.EJS_controlScheme = arcade ? "arcade" : "nes";
    if (arcade && opts.biosUrl) {
      window.EJS_biosUrl = opts.biosUrl;
      window.EJS_dontExtractBIOS = true;
    }
    if (arcade && opts.parentUrl) window.EJS_gameParentUrl = opts.parentUrl;
    window.EJS_gameUrl = romUrl;
    window.EJS_pathtodata = EJS_CDN;
    window.EJS_gameName = gameName;
    window.EJS_startOnLoaded = true;
    window.EJS_language = "zh-CN";
    window.EJS_defaultControls = defaultControls(platform);
    window.EJS_onGameStart = () => syncEmulatorGamepads(window.EJS_emulator, netplay);
    window.EJS_Buttons = {
      netplay: !netplay,
      playPause: true,
      restart: true,
      mute: true,
      settings: true,
      fullscreen: true,
      saveState: true,
      loadState: true,
      screenRecord: false,
      gamepad: true,
      cheat: true,
      volume: true,
      saveSavFiles: true,
      loadSavFiles: true,
      quickSave: true,
      quickLoad: true,
      screenshot: true,
      cacheManager: false,
    };

    if (netplay) {
      window.EJS_ready = () => global.StreamNetplay?.attach(window.EJS_emulator);
      window.EJS_gameID = gameIdFromName(gameName);
      // Default to the site's same-origin signaling proxy; override via window.EJS_NETPLAY_SERVER_OVERRIDE if hosted separately.
      window.EJS_netplayServer = window.EJS_NETPLAY_SERVER_OVERRIDE || location.origin;
      window.EJS_netplayICEServers = await loadIceServers();
      window.EJS_DEBUG_XX = true;
    }

    const script = document.createElement("script");
    script.src = EJS_CDN + "loader.js";
    script.dataset.ejsLoader = "1";
    script.onerror = () => setStatus(statusEl, "加载 EmulatorJS CDN 失败", "error");
    document.body.appendChild(script);
    setStatus(statusEl, (arcade ? "FBNeo 正在运行：" : "正在运行：") + stripRomExt(gameName), "ok");
  }

  async function fetchRomList() {
    const res = await fetch("/api/roms", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data.roms || [];
  }

  async function fetchBiosList() {
    const res = await fetch("/api/bios", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()).bios || [];
  }

  async function uploadBios(file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch("/api/bios/upload", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ("BIOS 上传失败 HTTP " + res.status));
    return data;
  }

  async function deleteBios(name) {
    const res = await fetch("/api/bios/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ("BIOS 删除失败 HTTP " + res.status));
    return data;
  }

  async function uploadRom(file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || ("上传失败 HTTP " + res.status));
    }
    return data;
  }

  async function deleteRom(name) {
    const res = await fetch("/api/roms/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || ("删除失败 HTTP " + res.status));
    }
    return data;
  }

  async function renameRom(oldName, newName) {
    const res = await fetch("/api/roms/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldName, newName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || ("重命名失败 HTTP " + res.status));
    }
    if (currentLoadedRom && (currentLoadedRom === oldName || currentLoadedRom === data.oldName)) {
      setFamicomCartridge(data.name);
    }
    return data;
  }

  let romListOptions = null;
  let allRoms = [];
  async function refreshRoms() {
    allRoms = await fetchRomList();
    renderRomList();
    return allRoms;
  }
  function renderRomList(romListEl, roms, onStart, onDelete, onRename) {
    if (romListEl) romListOptions = { romListEl, onStart, onDelete, onRename };
    if (!romListOptions) return;
    ({ romListEl, onStart, onDelete, onRename } = romListOptions);
    if (!roms) roms = allRoms.filter(r => platformForRom(r.name) === currentPlatform);
    document.querySelectorAll("[data-rom-count]").forEach((el) => {
      el.textContent = String(roms.length);
    });
    if (!roms.length) {
      romListEl.innerHTML = `<li class="rom-meta">${currentPlatform === "arcade" ? "暂无街机游戏，请上传 FBNeo romset ZIP" : "暂无 NES ROM"}</li>`;
      return;
    }
    romListEl.innerHTML = "";
    roms.forEach((r) => {
      const li = document.createElement("li");

      const left = document.createElement("div");
      left.className = "rom-info";

      const icon = document.createElement("div");
      icon.className = "rom-cart-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z"/><path d="M8 4v5h8V4"/><line x1="7" y1="15" x2="17" y2="15"/></svg>';

      const textWrap = document.createElement("div");
      textWrap.className = "rom-text";

      const titleEl = document.createElement("strong");
      titleEl.className = "rom-title";
      titleEl.textContent = r.name;
      titleEl.title = r.name;

      const metaEl = document.createElement("div");
      metaEl.className = "rom-meta";
      metaEl.textContent = (currentPlatform === "arcade" ? "FBNeo romset · " : "NES · ") + formatSize(r.size);

      textWrap.appendChild(titleEl);
      textWrap.appendChild(metaEl);
      left.appendChild(icon);
      left.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "rom-actions";

      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.textContent = "启动";
      startBtn.addEventListener("click", () => onStart(r));
      actions.appendChild(startBtn);

      const openInlineRename = () => {
        if (li.dataset.editing === "1") return;
        li.dataset.editing = "1";
        textWrap.innerHTML = "";
        actions.hidden = true;

        const editRow = document.createElement("div");
        editRow.className = "rom-rename-row";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "rom-rename-input";
        input.value = stripRomExt(r.name);
        input.maxLength = 80;
        input.setAttribute("aria-label", "新游戏名称");

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "good";
        saveBtn.style.padding = "5px 10px";
        saveBtn.style.fontSize = "0.82rem";
        saveBtn.textContent = "保存";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "secondary";
        cancelBtn.style.padding = "5px 10px";
        cancelBtn.style.fontSize = "0.82rem";
        cancelBtn.textContent = "取消";

        const restore = () => {
          delete li.dataset.editing;
          textWrap.innerHTML = "";
          textWrap.appendChild(titleEl);
          textWrap.appendChild(metaEl);
          actions.hidden = false;
        };

        const commit = async () => {
          const nextVal = input.value.trim();
          if (!nextVal || nextVal === stripRomExt(r.name) || nextVal === r.name) {
            restore();
            return;
          }
          saveBtn.disabled = true;
          input.disabled = true;
          try {
            if (typeof onRename === "function") {
              await onRename(r, nextVal);
            } else {
              await renameRom(r.name, nextVal);
            }
          } catch (_) {
            restore();
          }
        };

        saveBtn.addEventListener("click", commit);
        cancelBtn.addEventListener("click", restore);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); restore(); }
        });

        editRow.appendChild(input);
        editRow.appendChild(saveBtn);
        editRow.appendChild(cancelBtn);
        textWrap.appendChild(editRow);
        input.focus();
        input.select();
      };

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "secondary";
      renameBtn.textContent = "重命名";
      renameBtn.addEventListener("click", openInlineRename);
      titleEl.addEventListener("dblclick", openInlineRename);
      actions.appendChild(renameBtn);
      if (currentPlatform === "arcade") {
        renameBtn.hidden = true;
        titleEl.title = r.name + "（FBNeo 要求保留 romset 原始文件名）";
      }

      if (typeof onDelete === "function") {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => onDelete(r));
        actions.appendChild(delBtn);
      }

      li.appendChild(left);
      li.appendChild(actions);
      romListEl.appendChild(li);
    });
  }

  global.EmuCommon = {
    EJS_CDN,
    TEST_ROM_URL: "/roms/super-tilt-bro.nes",
    TEST_ROM_NAME: "Super Tilt Bro.",
    setStatus,
    formatSize,
    stripRomExt,
    gameIdFromName,
    defaultControls,
    getPlatform,
    setPlatform,
    onPlatformChange,
    platformForRom,
    refreshRoms,
    defaultIceServers,
    loadIceServers,
    resetGameContainer,
    clearEjsGlobals,
    syncEmulatorGamepads,
    startEmulator,
    fetchRomList,
    fetchBiosList,
    uploadBios,
    deleteBios,
    uploadRom,
    deleteRom,
    renameRom,
    renderRomList,
    switchTab,
    initTabs,
    renderFamicomDeck,
    setFamicomCartridge,
  };
})(window);
