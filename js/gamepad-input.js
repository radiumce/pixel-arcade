/* Gamepad helpers: Standard Gamepad API pads, and single Joy-Cons over WebHID with
 * multi-controller support and independent calibration per controller + remembered rules
 * for Joy-Con (R) and Joy-Con (L) across NES and Arcade (FBNeo) modes.
 *
 * Button indices (EmulatorJS):
 *   0=B(1) 1=Y(3) 2=Select(Coin) 3=Start 4=Up 5=Down 6=Left 7=Right 8=A(2) 9=X(4) 10=L(5) 11=R(6).
 *
 * Why WebHID: on macOS, Chrome's Gamepad API does not expose a lone Joy-Con even though the
 * OS sees it, but WebHID can read its raw input reports. A Joy-Con paired over Bluetooth sends
 * "simple HID" report 0x3F by default, or full report 0x30/0x21 if macOS gamecontrollerd
 * switches its input mode. Both report formats are normalized into (b1, b2, hat) here.
 *
 * Calibration rules are persisted in localStorage per platform ("nes" and "arcade"), both per
 * controller slot (e.g. "Joy-Con (R)#0", "arcade:Joy-Con (R)#0") and per controller model
 * ("Joy-Con (R)", "arcade:Joy-Con (R)").
 */
(function (global) {
  const DEADZONE = 0.5;
  const NES = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
  const STORAGE_KEY = "nes_joycon_calibration_v1";
  let inputPlatform = "nes";

  // NES 8-button sequential calibration order: 上 -> 下 -> 左 -> 右 -> A -> B -> Start -> Select
  const CALIBRATION_STEPS = [
    { nes: NES.UP, key: "UP", label: "上 (↑)", short: "↑" },
    { nes: NES.DOWN, key: "DOWN", label: "下 (↓)", short: "↓" },
    { nes: NES.LEFT, key: "LEFT", label: "左 (←)", short: "←" },
    { nes: NES.RIGHT, key: "RIGHT", label: "右 (→)", short: "→" },
    { nes: NES.A, key: "A", label: "A 键", short: "A" },
    { nes: NES.B, key: "B", label: "B 键", short: "B" },
    { nes: NES.START, key: "START", label: "Start 键", short: "Start" },
    { nes: NES.SELECT, key: "SELECT", label: "Select 键", short: "Select" },
  ];

  // Arcade 12-button sequential calibration order: 4 directions + 6 actions + Start + Coin
  const ARCADE_CALIBRATION_STEPS = [
    { nes: NES.UP, key: "UP", label: "上 (↑)", short: "↑" },
    { nes: NES.DOWN, key: "DOWN", label: "下 (↓)", short: "↓" },
    { nes: NES.LEFT, key: "LEFT", label: "左 (←)", short: "←" },
    { nes: NES.RIGHT, key: "RIGHT", label: "右 (→)", short: "→" },
    { nes: NES.B, key: "B", label: "动作 1 (B)", short: "1/B" },
    { nes: NES.A, key: "A", label: "动作 2 (A)", short: "2/A" },
    { nes: NES.Y, key: "Y", label: "动作 3 (Y)", short: "3/Y" },
    { nes: NES.X, key: "X", label: "动作 4 (X)", short: "4/X" },
    { nes: NES.L, key: "L", label: "动作 5 (L)", short: "5/L" },
    { nes: NES.R, key: "R", label: "动作 6 (R)", short: "6/R" },
    { nes: NES.START, key: "START", label: "开始 (Start)", short: "Start" },
    { nes: NES.SELECT, key: "SELECT", label: "投币 (Select)", short: "投币" },
  ];

  function stepsForPlatform(platform = inputPlatform) {
    return platform === "arcade" ? ARCADE_CALIBRATION_STEPS : CALIBRATION_STEPS;
  }

  const MODELS = ["Joy-Con (R)", "Joy-Con (L)"];

  // Default sideways Joy-Con mapping for NES (stick on left, 4 face buttons paired as A/B, SL/SR on top)
  const DEFAULT_JOYCON_RULES = {
    [NES.UP]: ["hat:0"],
    [NES.DOWN]: ["hat:4"],
    [NES.LEFT]: ["hat:6"],
    [NES.RIGHT]: ["hat:2"],
    [NES.A]: ["b1:2", "b1:8"],       // right or top face button
    [NES.B]: ["b1:1", "b1:4"],       // bottom or left face button
    [NES.START]: ["b1:32", "b2:2"],  // SR or Plus
    [NES.SELECT]: ["b1:16", "b2:1"], // SL or Minus
  };

  // Default sideways Joy-Con mapping for Arcade (4 independent face actions + 2 shoulder actions + Start + Coin)
  const DEFAULT_JOYCON_ARCADE_RULES = {
    [NES.UP]: ["hat:0"],
    [NES.DOWN]: ["hat:4"],
    [NES.LEFT]: ["hat:6"],
    [NES.RIGHT]: ["hat:2"],
    [NES.B]: ["b1:1"],                                // bottom face -> Action 1 (B)
    [NES.A]: ["b1:2"],                                // right face -> Action 2 (A)
    [NES.Y]: ["b1:4"],                                // left face -> Action 3 (Y)
    [NES.X]: ["b1:8"],                                // top face -> Action 4 (X)
    [NES.L]: ["b1:16", "b2:64"],                      // SL or L/R bumper -> Action 5 (L)
    [NES.R]: ["b1:32", "b2:128"],                     // SR or ZL/ZR trigger -> Action 6 (R)
    [NES.START]: ["b2:2", "b2:32"],                   // Plus (R) or Capture (L) -> Start
    [NES.SELECT]: ["b2:1", "b2:16", "b2:4", "b2:8"],  // Minus (L), Home (R), or Stick click -> Coin
  };

  const DEFAULT_GAMEPAD_RULES = {
    [NES.UP]: ["gpbtn:12", "gpaxis:1:-"],
    [NES.DOWN]: ["gpbtn:13", "gpaxis:1:+"],
    [NES.LEFT]: ["gpbtn:14", "gpaxis:0:-"],
    [NES.RIGHT]: ["gpbtn:15", "gpaxis:0:+"],
    [NES.A]: ["gpbtn:1", "gpbtn:3"],
    [NES.B]: ["gpbtn:0", "gpbtn:2"],
    [NES.START]: ["gpbtn:9"],
    [NES.SELECT]: ["gpbtn:8"],
  };

  const DEFAULT_GAMEPAD_ARCADE_RULES = {
    [NES.UP]: ["gpbtn:12", "gpaxis:1:-"],
    [NES.DOWN]: ["gpbtn:13", "gpaxis:1:+"],
    [NES.LEFT]: ["gpbtn:14", "gpaxis:0:-"],
    [NES.RIGHT]: ["gpbtn:15", "gpaxis:0:+"],
    [NES.B]: ["gpbtn:0"],
    [NES.A]: ["gpbtn:1"],
    [NES.Y]: ["gpbtn:2"],
    [NES.X]: ["gpbtn:3"],
    [NES.L]: ["gpbtn:4"],
    [NES.R]: ["gpbtn:5"],
    [NES.START]: ["gpbtn:9"],
    [NES.SELECT]: ["gpbtn:8"],
  };

  const TOKEN_LABELS = {
    "hat:0": "摇杆 ↑",
    "hat:1": "摇杆 ↗",
    "hat:2": "摇杆 →",
    "hat:3": "摇杆 ↘",
    "hat:4": "摇杆 ↓",
    "hat:5": "摇杆 ↙",
    "hat:6": "摇杆 ←",
    "hat:7": "摇杆 ↖",
    "b1:1": "下方键 (0x01)",
    "b1:2": "右侧键 (0x02)",
    "b1:4": "左侧键 (0x04)",
    "b1:8": "上方键 (0x08)",
    "b1:16": "SL 键",
    "b1:32": "SR 键",
    "b2:1": "－ 键",
    "b2:2": "＋ 键",
    "b2:4": "左摇杆下压",
    "b2:8": "右摇杆下压",
    "b2:16": "Home 键",
    "b2:32": "截图键",
    "b2:64": "L/R 肩键",
    "b2:128": "ZL/ZR 键",
    "gpaxis:0:-": "左摇杆 ←",
    "gpaxis:0:+": "左摇杆 →",
    "gpaxis:1:-": "左摇杆 ↑",
    "gpaxis:1:+": "左摇杆 ↓",
  };

  function formatToken(token) {
    if (!token) return "未设置";
    if (TOKEN_LABELS[token]) return TOKEN_LABELS[token];
    if (token.startsWith("gpbtn:")) return "按键 #" + token.slice(6);
    if (token.startsWith("gpaxis:")) return "轴 " + token.slice(7);
    return token;
  }

  function formatTokens(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return "未设置";
    return tokens.map(formatToken).join(" / ");
  }

  function modelForDevice(productId, productName) {
    if (productId === 0x2006 || /joy-?con\s*\(l\)/i.test(String(productName || ""))) {
      return "Joy-Con (L)";
    }
    if (productId === 0x2007 || /joy-?con\s*\(r\)/i.test(String(productName || ""))) {
      return "Joy-Con (R)";
    }
    return productName || "Joy-Con (R)";
  }

  function stripPlatformPrefix(key) {
    return String(key || "").replace(/^(arcade|nes):/, "");
  }

  function platformFromKey(key, fallbackPlatform = inputPlatform) {
    const s = String(key || "");
    if (s.startsWith("arcade:")) return "arcade";
    if (s.startsWith("nes:")) return "nes";
    return fallbackPlatform === "arcade" ? "arcade" : "nes";
  }

  function normalizeStorageKey(key, platform = inputPlatform) {
    if (!key || typeof key !== "string") return "";
    const p = platformFromKey(key, platform);
    const raw = stripPlatformPrefix(key);
    return p === "arcade" ? `arcade:${raw}` : raw;
  }

  function defaultRuleForKey(key, platform = inputPlatform) {
    const p = platformFromKey(key, platform);
    const raw = stripPlatformPrefix(key);
    if (raw.startsWith("gp:")) {
      return p === "arcade" ? DEFAULT_GAMEPAD_ARCADE_RULES : DEFAULT_GAMEPAD_RULES;
    }
    return p === "arcade" ? DEFAULT_JOYCON_ARCADE_RULES : DEFAULT_JOYCON_RULES;
  }

  function cloneRule(rule, fallback, platform = inputPlatform) {
    const p = platform === "arcade" ? "arcade" : "nes";
    const fb = fallback || (p === "arcade" ? DEFAULT_JOYCON_ARCADE_RULES : DEFAULT_JOYCON_RULES);
    const out = {};
    for (const step of stepsForPlatform(p)) {
      const list = rule?.[step.nes] ?? rule?.[String(step.nes)];
      out[step.nes] = Array.isArray(list) ? [...list] : [...(fb[step.nes] || [])];
    }
    for (const step of ARCADE_CALIBRATION_STEPS) {
      if (out[step.nes] !== undefined) continue;
      const list = rule?.[step.nes] ?? rule?.[String(step.nes)];
      if (Array.isArray(list)) out[step.nes] = [...list];
    }
    return out;
  }

  const savedMappings = {};
  function loadSavedMappings() {
    try {
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val === "object") {
          const p = platformFromKey(key, "nes");
          savedMappings[key] = cloneRule(val, defaultRuleForKey(key, p), p);
        }
      }
    } catch (_) {}
  }

  function persistSavedMappings() {
    try {
      global.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(savedMappings));
    } catch (_) {}
  }

  loadSavedMappings();

  function getCalibration(key, platform = inputPlatform) {
    const p = platformFromKey(key, platform);
    const storageKey = normalizeStorageKey(key, p);
    const m = savedMappings[storageKey];
    return m ? cloneRule(m, defaultRuleForKey(storageKey, p), p) : null;
  }

  /**
   * Resolve effective mapping rule for the given platform ("nes" or "arcade"):
   * - If `modelOrRule` is a rule object, clone and return it.
   * - If `slotKey` (e.g. "Joy-Con (R)#0") has an independent calibration for this platform, prefer it.
   * - Otherwise check `modelKey` (e.g. "Joy-Con (R)" or "Joy-Con (L)") for this platform.
   * - Otherwise return platform defaults.
   */
  function getEffectiveRule(modelOrRule, slotKey, platform = inputPlatform) {
    const p = (typeof modelOrRule === "string" && modelOrRule.startsWith("arcade:")) ||
      (typeof slotKey === "string" && slotKey.startsWith("arcade:"))
      ? "arcade"
      : (platform === "arcade" ? "arcade" : "nes");
    const fallback = defaultRuleForKey(slotKey || (typeof modelOrRule === "string" ? modelOrRule : ""), p);
    if (modelOrRule && typeof modelOrRule === "object") {
      return cloneRule(modelOrRule, fallback, p);
    }
    const normSlot = slotKey ? normalizeStorageKey(slotKey, p) : "";
    if (normSlot && savedMappings[normSlot]) {
      return cloneRule(savedMappings[normSlot], fallback, p);
    }
    const normModel = typeof modelOrRule === "string" ? normalizeStorageKey(modelOrRule, p) : "";
    if (normModel && savedMappings[normModel]) {
      return cloneRule(savedMappings[normModel], fallback, p);
    }
    return cloneRule(fallback, fallback, p);
  }

  /* ---------- Standard Gamepad API ---------- */

  const STANDARD = {
    buttons: {
      0: NES.B, 1: NES.A, 2: NES.B, 3: NES.A,
      8: NES.SELECT, 9: NES.START,
      12: NES.UP, 13: NES.DOWN, 14: NES.LEFT, 15: NES.RIGHT,
    },
  };
  const ARCADE = {
    buttons: {
      0: NES.B, 1: NES.A, 2: NES.Y, 3: NES.X,
      4: NES.L, 5: NES.R, 8: NES.SELECT, 9: NES.START,
      12: NES.UP, 13: NES.DOWN, 14: NES.LEFT, 15: NES.RIGHT,
    },
  };
  // Single Joy-Con in NES mode: SL/SR (4/5) are the top shoulder keys within reach, so use them for Select/Start.
  const JOYCON_SINGLE = { buttons: { ...STANDARD.buttons, 4: NES.SELECT, 5: NES.START } };
  // Single Joy-Con in Arcade mode: 0..3 = B/A/Y/X, 4/5 (SL/SR) & 6/7 (ZL/L) = L/R, 8/10/11 = Select(Coin), 9/16 = Start.
  const JOYCON_SINGLE_ARCADE = {
    buttons: {
      ...ARCADE.buttons,
      6: NES.L, 7: NES.R,
      10: NES.SELECT, 11: NES.SELECT, 16: NES.START,
    },
  };
  const STANDARD_ARCADE = ARCADE;

  function isSingleJoyCon(pad) {
    const id = String(pad.id || "");
    return /joy-?con\s*\((l|r)\)/i.test(id) || /057e.*product:\s*200[67]/i.test(id) ||
      /^057e-200[67]/i.test(id);
  }

  function profileFor(pad, platform = inputPlatform) {
    if (platform === "arcade") {
      return isSingleJoyCon(pad) ? JOYCON_SINGLE_ARCADE : STANDARD_ARCADE;
    }
    return isSingleJoyCon(pad) ? JOYCON_SINGLE : STANDARD;
  }

  function gpTokenMatches(token, pad) {
    if (typeof token !== "string" || !pad) return false;
    if (token.startsWith("gpbtn:")) {
      const idx = Number(token.slice(6));
      return !!pad.buttons?.[idx]?.pressed;
    }
    if (token.startsWith("gpaxis:")) {
      const parts = token.split(":");
      const axisIdx = Number(parts[1]);
      const sign = parts[2];
      const val = pad.axes?.[axisIdx] || 0;
      return sign === "+" ? val > DEADZONE : val < -DEADZONE;
    }
    return false;
  }

  function detectActiveGamepadToken(pad) {
    if (!pad) return null;
    for (let i = 0; i < (pad.buttons?.length || 0); i++) {
      if (pad.buttons[i]?.pressed) return "gpbtn:" + i;
    }
    for (let a = 0; a < (pad.axes?.length || 0); a++) {
      const v = pad.axes[a] || 0;
      if (v > 0.6) return `gpaxis:${a}:+`;
      if (v < -0.6) return `gpaxis:${a}:-`;
    }
    return null;
  }

  function gamepadKeys(pad) {
    const id = String(pad?.id || "Gamepad").trim();
    const modelKey = isSingleJoyCon(pad)
      ? (/joy-?con\s*\(l\)|2006/i.test(id) ? "Joy-Con (L)" : "Joy-Con (R)")
      : ("gp:" + id);
    const slotKey = `${modelKey}#${pad?.index ?? 0}`;
    return { modelKey, slotKey };
  }

  /** Returns the set of button indices currently pressed on one pad for `platform`. */
  function padButtons(pad, platform = inputPlatform) {
    if (!pad) return new Set();
    const p = platform === "arcade" ? "arcade" : "nes";
    if (pad._webhidJoyCon) {
      if (pad._nes instanceof Set && p === inputPlatform) {
        return new Set(pad._nes);
      }
      const out = new Set();
      for (const [i, nes] of Object.entries(ARCADE.buttons)) {
        if (pad.buttons?.[i]?.pressed) out.add(nes);
      }
      return out;
    }
    const { modelKey, slotKey } = gamepadKeys(pad);
    const customRule = getCalibration(slotKey, p) || getCalibration(modelKey, p);
    if (customRule) {
      const out = new Set();
      for (const step of stepsForPlatform(p)) {
        const tokens = customRule[step.nes] || [];
        if (Array.isArray(tokens) && tokens.some(t => gpTokenMatches(t, pad))) {
          out.add(step.nes);
        }
      }
      return out;
    }
    const out = new Set();
    const profile = profileFor(pad, p);
    for (const [i, nes] of Object.entries(profile.buttons)) {
      if (pad.buttons?.[i]?.pressed) out.add(nes);
    }
    const x = pad.axes?.[0] || 0, y = pad.axes?.[1] || 0;
    if (x < -DEADZONE) out.add(NES.LEFT);
    if (x > DEADZONE) out.add(NES.RIGHT);
    if (y < -DEADZONE) out.add(NES.UP);
    if (y > DEADZONE) out.add(NES.DOWN);
    return out;
  }

  /* ---------- Single Joy-Con over WebHID ---------- */

  const JC_VENDOR = 0x057e;
  const JC_PRODUCTS = [0x2006, 0x2007]; // Joy-Con (L), Joy-Con (R)
  const SIMPLE_REPORT = 0x3f;
  const FULL_REPORTS = new Set([0x30, 0x21]);
  const STICK_CENTER = 2048;
  const STICK_THRESHOLD = 600;
  const hidEntries = new Map(); // HIDDevice -> { device, productId, name, modelKey, slotKey, b1, b2, hat, nes: Set, index: number|null }
  const listeners = new Set();
  const rawListeners = new Set();
  let hadFailedRestore = false;
  let calibrationModalOpen = false;
  let modalPlatform = "nes";
  const notify = () => listeners.forEach(fn => { try { fn(); } catch (_) {} });
  const notifyRaw = entry => rawListeners.forEach(fn => { try { fn(entry); } catch (_) {} });

  function tokenMatches(token, b1, b2, hat) {
    if (typeof token !== "string") return false;
    if (token.startsWith("b1:")) {
      const mask = Number(token.slice(3));
      return (b1 & mask) !== 0;
    }
    if (token.startsWith("b2:")) {
      const mask = Number(token.slice(3));
      return (b2 & mask) !== 0;
    }
    if (token.startsWith("hat:")) {
      const dir = Number(token.slice(4));
      if (hat < 0 || hat > 7 || Number.isNaN(dir)) return false;
      if (dir % 2 === 0) {
        return hat === dir || hat === (dir + 1) % 8 || hat === (dir + 7) % 8;
      }
      return hat === dir;
    }
    return false;
  }

  /** Detect a single active input token from (b1, b2, hat) for calibration capture. */
  function detectActiveToken(b1, b2, hat) {
    for (const bit of [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
      if (b1 & bit) return "b1:" + bit;
    }
    for (const bit of [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
      if (b2 & bit) return "b2:" + bit;
    }
    if (hat >= 0 && hat <= 7) return "hat:" + hat;
    return null;
  }

  /**
   * Pure decoder for a simple-HID 0x3F report (or normalized full report).
   * Optional `modelOrRule` can be "Joy-Con (R)", "Joy-Con (L)", or a custom rule object.
   * Optional `slotKey` can be e.g. "Joy-Con (R)#0" for per-controller independent calibration.
   * Optional `platform` ("nes" | "arcade") defaults to `inputPlatform`.
   */
  function joyconNesState(b1, b2, hat, modelOrRule, slotKey, platform = inputPlatform) {
    const p = (typeof modelOrRule === "string" && modelOrRule.startsWith("arcade:")) ||
      (typeof slotKey === "string" && slotKey.startsWith("arcade:"))
      ? "arcade"
      : (platform === "arcade" ? "arcade" : "nes");
    const defaultRule = p === "arcade" ? DEFAULT_JOYCON_ARCADE_RULES : DEFAULT_JOYCON_RULES;
    const rule = (modelOrRule || slotKey) ? getEffectiveRule(modelOrRule, slotKey, p) : defaultRule;
    const nes = new Set();
    for (const step of stepsForPlatform(p)) {
      const tokens = rule[step.nes] ?? defaultRule[step.nes];
      if (Array.isArray(tokens) && tokens.some(t => tokenMatches(t, b1, b2, hat))) {
        nes.add(step.nes);
      }
    }
    return nes;
  }

  /**
   * Convert a 0x30 / 0x21 full input report into normalized (b1, b2, hat) matching 0x3F layout
   * for a single Joy-Con (L or R) held sideways with SL/SR on top.
   */
  function fullReportToSimple(dataView, productId) {
    if (!dataView || dataView.byteLength < 11) return { b1: 0, b2: 0, hat: 8 };
    const bR = dataView.getUint8(2);
    const bShared = dataView.getUint8(3);
    const bL = dataView.getUint8(4);
    const isLeft = productId === 0x2006;

    let b1 = 0, b2 = 0, up = false, down = false, left = false, right = false;
    if (isLeft) {
      b1 = ((bL & 0x08) ? 0x01 : 0) |
           ((bL & 0x01) ? 0x02 : 0) |
           ((bL & 0x02) ? 0x04 : 0) |
           ((bL & 0x04) ? 0x08 : 0) |
           ((bL & 0x20) ? 0x10 : 0) |
           ((bL & 0x10) ? 0x20 : 0);
      b2 = ((bShared & 0x01) ? 0x01 : 0) |
           ((bShared & 0x02) ? 0x02 : 0) |
           ((bShared & 0x08) ? 0x04 : 0) |
           ((bShared & 0x20) ? 0x20 : 0) |
           ((bL & 0x40) ? 0x40 : 0) |
           ((bL & 0x80) ? 0x80 : 0);
      const lx = dataView.getUint8(5) | ((dataView.getUint8(6) & 0x0f) << 8);
      const ly = (dataView.getUint8(6) >> 4) | (dataView.getUint8(7) << 4);
      up = lx > STICK_CENTER + STICK_THRESHOLD;
      down = lx < STICK_CENTER - STICK_THRESHOLD;
      left = ly > STICK_CENTER + STICK_THRESHOLD;
      right = ly < STICK_CENTER - STICK_THRESHOLD;
    } else {
      b1 = ((bR & 0x02) ? 0x01 : 0) |
           ((bR & 0x08) ? 0x02 : 0) |
           ((bR & 0x01) ? 0x04 : 0) |
           ((bR & 0x04) ? 0x08 : 0) |
           ((bR & 0x20) ? 0x10 : 0) |
           ((bR & 0x10) ? 0x20 : 0);
      b2 = ((bShared & 0x01) ? 0x01 : 0) |
           ((bShared & 0x02) ? 0x02 : 0) |
           ((bShared & 0x04) ? 0x08 : 0) |
           ((bShared & 0x10) ? 0x10 : 0) |
           ((bR & 0x40) ? 0x40 : 0) |
           ((bR & 0x80) ? 0x80 : 0);
      const rx = dataView.getUint8(8) | ((dataView.getUint8(9) & 0x0f) << 8);
      const ry = (dataView.getUint8(9) >> 4) | (dataView.getUint8(10) << 4);
      up = rx < STICK_CENTER - STICK_THRESHOLD;
      down = rx > STICK_CENTER + STICK_THRESHOLD;
      left = ry < STICK_CENTER - STICK_THRESHOLD;
      right = ry > STICK_CENTER + STICK_THRESHOLD;
    }
    let hat = 8;
    if (up && right) hat = 1;
    else if (right && down) hat = 3;
    else if (down && left) hat = 5;
    else if (left && up) hat = 7;
    else if (up) hat = 0;
    else if (right) hat = 2;
    else if (down) hat = 4;
    else if (left) hat = 6;
    return { b1, b2, hat };
  }

  /**
   * Pure decoder for a 0x30 / 0x21 full input report (bytes after the report id),
   * respecting any saved calibration rule for the Joy-Con model / slot.
   */
  function joyconFullReportNesState(dataView, productId, modelOrRule, slotKey, platform = inputPlatform) {
    if (!dataView || dataView.byteLength < 11) return new Set();
    const { b1, b2, hat } = fullReportToSimple(dataView, productId);
    const key = modelOrRule || modelForDevice(productId);
    return joyconNesState(b1, b2, hat, key, slotKey, platform);
  }

  function slotKeyForEntry(entry) {
    return `${entry.modelKey}#${entry.index ?? 0}`;
  }

  function refreshEntriesNes() {
    for (const entry of hidEntries.values()) {
      entry.slotKey = slotKeyForEntry(entry);
      entry.nes = joyconNesState(entry.b1, entry.b2, entry.hat, entry.modelKey, entry.slotKey, inputPlatform);
    }
  }

  /**
   * Save calibration rule.
   * @param {string} modelOrKey - e.g. "Joy-Con (R)", "Joy-Con (L)", or a slot key "Joy-Con (R)#0"
   * @param {object} rule - mapping from button index to array of input tokens
   * @param {string} [slotKey] - optional specific controller slot key (e.g. "Joy-Con (R)#1") for independent multi-gamepad calibration
   * @param {string} [platform] - "nes" | "arcade" (defaults to current `inputPlatform`)
   */
  function setCalibration(modelOrKey, rule, slotKey, platform = inputPlatform) {
    if (!modelOrKey || typeof modelOrKey !== "string") {
      throw new Error("无效的手柄标识");
    }
    const p = platformFromKey(slotKey || modelOrKey, platform);
    const normModel = normalizeStorageKey(modelOrKey, p);
    const normSlot = slotKey ? normalizeStorageKey(slotKey, p) : "";
    const fallback = defaultRuleForKey(normSlot || normModel, p);
    savedMappings[normModel] = cloneRule(rule, fallback, p);
    if (normSlot) {
      savedMappings[normSlot] = cloneRule(rule, fallback, p);
    } else {
      const rawModel = stripPlatformPrefix(modelOrKey);
      if (MODELS.includes(rawModel)) {
        // If setting by model name and only one controller of this model is connected, sync its slot too
        const matching = [...hidEntries.values()].filter(e => e.modelKey === rawModel);
        if (matching.length === 1) {
          const autoSlot = normalizeStorageKey(slotKeyForEntry(matching[0]), p);
          savedMappings[autoSlot] = cloneRule(rule, fallback, p);
        }
      }
    }
    persistSavedMappings();
    refreshEntriesNes();
    notify();
  }

  function resetCalibration(modelOrKey, slotKey, platform = inputPlatform) {
    if (!modelOrKey && !slotKey) {
      for (const k of Object.keys(savedMappings)) delete savedMappings[k];
    } else {
      const p = platformFromKey(slotKey || modelOrKey, platform);
      if (slotKey) {
        delete savedMappings[normalizeStorageKey(slotKey, p)];
      }
      if (modelOrKey) {
        const normModel = normalizeStorageKey(modelOrKey, p);
        delete savedMappings[normModel];
        if (!slotKey) {
          for (const k of Object.keys(savedMappings)) {
            if (k.startsWith(normModel + "#")) delete savedMappings[k];
          }
        }
      }
    }
    persistSavedMappings();
    refreshEntriesNes();
    notify();
  }

  const deleteCalibration = resetCalibration;

  function deleteSavedKey(key) {
    if (!key || !(key in savedMappings)) return false;
    delete savedMappings[key];
    persistSavedMappings();
    refreshEntriesNes();
    notify();
    return true;
  }

  function deleteButtonMapping(modelOrKey, nesButton, slotKey, platform = inputPlatform) {
    if (!modelOrKey || typeof modelOrKey !== "string") {
      throw new Error("无效的手柄标识");
    }
    const p = platformFromKey(slotKey || modelOrKey, platform);
    const rule = getEffectiveRule(modelOrKey, slotKey, p);
    rule[nesButton] = [];
    setCalibration(modelOrKey, rule, slotKey, p);
    return rule;
  }

  function listSavedMappings() {
    return Object.keys(savedMappings);
  }

  function hasCalibration(modelOrKey, slotKey, platform = inputPlatform) {
    const p = platformFromKey(slotKey || modelOrKey, platform);
    if (slotKey) {
      const normSlot = normalizeStorageKey(slotKey, p);
      if (savedMappings[normSlot]) return true;
    }
    if (modelOrKey) {
      const normModel = normalizeStorageKey(modelOrKey, p);
      if (savedMappings[normModel]) return true;
    }
    return false;
  }

  /** Build a fresh standard-mapped Gamepad snapshot for a connected WebHID Joy-Con. */
  function joyconToGamepad(entry) {
    const nes = calibrationModalOpen ? new Set() : entry.nes;
    const b2 = calibrationModalOpen ? 0 : entry.b2;
    const pressed = Array.from({ length: 16 }, (_, i) => {
      if (i === 0) return nes.has(NES.B);
      if (i === 1) return nes.has(NES.A);
      if (i === 2) return nes.has(NES.Y);
      if (i === 3) return nes.has(NES.X);
      if (i === 4) return nes.has(NES.L);
      if (i === 5) return nes.has(NES.R);
      if (i === 8) return nes.has(NES.SELECT);
      if (i === 9) return nes.has(NES.START);
      if (i === 10) return !!(b2 & 0x04);
      if (i === 11) return !!(b2 & 0x08);
      if (i === 12) return nes.has(NES.UP);
      if (i === 13) return nes.has(NES.DOWN);
      if (i === 14) return nes.has(NES.LEFT);
      if (i === 15) return nes.has(NES.RIGHT);
      return false;
    });
    return {
      index: entry.index ?? 0,
      id: entry.name + " (WebHID)",
      connected: true,
      mapping: "standard",
      timestamp: global.performance?.now?.() || Date.now(),
      axes: [0, 0, 0, 0],
      buttons: pressed.map(p => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
      _webhidJoyCon: true,
      _modelKey: entry.modelKey,
      _slotKey: entry.slotKey,
      _nes: new Set(nes),
    };
  }

  /** Wrap a calibrated Standard Gamepad so EmulatorJS also sees its calibrated button layout. */
  function calibratedStandardGamepad(pad) {
    const nes = calibrationModalOpen ? new Set() : padButtons(pad, inputPlatform);
    const pressed = Array.from({ length: Math.max(16, pad.buttons?.length || 16) }, (_, i) => {
      if (i === 0) return nes.has(NES.B);
      if (i === 1) return nes.has(NES.A);
      if (i === 2) return nes.has(NES.Y);
      if (i === 3) return nes.has(NES.X);
      if (i === 4) return nes.has(NES.L);
      if (i === 5) return nes.has(NES.R);
      if (i === 8) return nes.has(NES.SELECT);
      if (i === 9) return nes.has(NES.START);
      if (i === 12) return nes.has(NES.UP);
      if (i === 13) return nes.has(NES.DOWN);
      if (i === 14) return nes.has(NES.LEFT);
      if (i === 15) return nes.has(NES.RIGHT);
      return false;
    });
    return {
      index: pad.index,
      id: pad.id,
      connected: pad.connected,
      mapping: "standard",
      timestamp: pad.timestamp || (global.performance?.now?.() || Date.now()),
      axes: [0, 0, 0, 0],
      buttons: pressed.map(p => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
    };
  }

  function fireGamepadEvent(type, entry) {
    if (typeof global.dispatchEvent !== "function" || typeof global.Event !== "function") return;
    try {
      const ev = new global.Event(type);
      ev.gamepad = joyconToGamepad(entry);
      global.dispatchEvent(ev);
    } catch (_) {}
  }

  function detachHid(device) {
    const entry = hidEntries.get(device);
    if (!entry) return;
    hidEntries.delete(device);
    try { if (device.opened) device.close?.(); } catch (_) {}
    fireGamepadEvent("gamepaddisconnected", entry);
  }

  async function attachHid(device, { replaceSameProduct = false, replaceSlotIndex = null } = {}) {
    // Always clean up any closed/stale entries or explicitly targeted slot/product
    for (const [oldDev, oldEntry] of [...hidEntries.entries()]) {
      if (oldDev === device) continue;
      const isClosed = !oldDev.opened;
      const isTargetSlot = replaceSlotIndex != null && oldEntry.index === replaceSlotIndex;
      const isSameProductReplace = replaceSameProduct && oldEntry.productId === device.productId;
      if (isClosed || isTargetSlot || isSameProductReplace) {
        detachHid(oldDev);
        try { await oldDev.forget?.(); } catch (_) {}
      }
    }
    if (hidEntries.has(device)) {
      if (!device.opened) {
        try { await device.open(); } catch (error) {
          detachHid(device);
          throw error;
        }
      }
      notify();
      return;
    }
    const modelKey = modelForDevice(device.productId, device.productName);
    const entry = {
      device,
      productId: device.productId,
      name: device.productName || modelKey,
      modelKey,
      slotKey: modelKey + "#0",
      b1: 0, b2: 0, hat: 8, nes: new Set(), index: replaceSlotIndex,
    };
    hidEntries.set(device, entry);
    device.addEventListener("inputreport", event => {
      const d = event.data;
      if (!d) return;
      if (event.reportId === SIMPLE_REPORT && d.byteLength >= 3) {
        entry.b1 = d.getUint8(0);
        entry.b2 = d.getUint8(1);
        entry.hat = d.getUint8(2);
        entry.slotKey = slotKeyForEntry(entry);
        entry.nes = joyconNesState(entry.b1, entry.b2, entry.hat, entry.modelKey, entry.slotKey, inputPlatform);
        notifyRaw(entry);
      } else if (FULL_REPORTS.has(event.reportId) && d.byteLength >= 11) {
        const simple = fullReportToSimple(d, entry.productId);
        entry.b1 = simple.b1;
        entry.b2 = simple.b2;
        entry.hat = simple.hat;
        entry.slotKey = slotKeyForEntry(entry);
        entry.nes = joyconNesState(entry.b1, entry.b2, entry.hat, entry.modelKey, entry.slotKey, inputPlatform);
        notifyRaw(entry);
      }
    });
    try {
      if (!device.opened) {
        if (typeof global.setTimeout === "function") {
          let timer;
          try {
            await Promise.race([
              device.open(),
              new Promise((_, rej) => { timer = global.setTimeout(() => rej(new Error("打开蓝牙 HID 超时")), 2500); }),
            ]);
          } finally {
            global.clearTimeout?.(timer);
          }
        } else {
          await device.open();
        }
      }
    } catch (error) {
      hidEntries.delete(device);
      try { await device.forget?.(); } catch (_) {}
      throw error;
    }
    hadFailedRestore = false;
    getGamepadsWithHid(); // assign entry.index and entry.slotKey
    entry.slotKey = slotKeyForEntry(entry);
    fireGamepadEvent("gamepadconnected", entry);
    notify();
  }

  const nativeGetGamepads = typeof global.navigator?.getGamepads === "function"
    ? global.navigator.getGamepads.bind(global.navigator)
    : null;

  function getGamepadsWithHid() {
    const raw = nativeGetGamepads ? Array.from(nativeGetGamepads() || []) : [];
    const used = new Set();
    raw.forEach((p, i) => {
      if (p && p.connected && !p._webhidJoyCon) {
        used.add(i);
        const { modelKey, slotKey } = gamepadKeys(p);
        if (calibrationModalOpen || hasCalibration(modelKey, slotKey, inputPlatform)) {
          raw[i] = calibratedStandardGamepad(p);
        }
      }
    });
    if (!hidEntries.size || raw.some(p => p && p.connected && !p._webhidJoyCon && isSingleJoyCon(p))) {
      return raw;
    }
    for (const entry of hidEntries.values()) {
      if (entry.index != null && !used.has(entry.index)) {
        used.add(entry.index);
      } else {
        let idx = 0;
        while (used.has(idx)) idx++;
        entry.index = idx;
        used.add(idx);
      }
      entry.slotKey = slotKeyForEntry(entry);
      entry.nes = joyconNesState(entry.b1, entry.b2, entry.hat, entry.modelKey, entry.slotKey, inputPlatform);
      raw[entry.index] = joyconToGamepad(entry);
    }
    return raw;
  }

  if (global.navigator && nativeGetGamepads) {
    try {
      Object.defineProperty(global.navigator, "getGamepads", {
        value: getGamepadsWithHid, configurable: true, writable: true,
      });
    } catch (_) {
      try { global.navigator.getGamepads = getGamepadsWithHid; } catch (_) {}
    }
  }

  function connectedPads() {
    const getter = global.navigator?.getGamepads;
    const list = typeof getter === "function" ? getter.call(global.navigator) : getGamepadsWithHid();
    return [...(list || [])].filter(p => p && p.connected).sort((a, b) => a.index - b.index);
  }

  const JoyConHID = {
    get supported() { return !!global.navigator?.hid; },
    /**
     * Must run from a user gesture. Resolves to the number of Joy-Cons now connected.
     * @param {object} [opts]
     * @param {boolean} [opts.addNew] - if true, keep existing open Joy-Cons of the same model so multiple Joy-Cons can be connected
     * @param {number|null} [opts.replaceSlotIndex] - if set, replace the controller at this player slot
     */
    async request(opts = {}) {
      if (!this.supported) {
        throw new Error("此浏览器不支持 WebHID（请用 Chrome/Edge，并通过 localhost 或 https 访问）");
      }
      const devices = await global.navigator.hid.requestDevice({
        filters: JC_PRODUCTS.map(productId => ({ vendorId: JC_VENDOR, productId })),
      });
      const replaceSameProduct = opts.addNew ? false : (opts.replaceSlotIndex == null);
      for (const device of devices) {
        await attachHid(device, {
          replaceSameProduct,
          replaceSlotIndex: opts.replaceSlotIndex ?? null,
        });
      }
      return hidEntries.size;
    },
    /** Re-open Joy-Cons the user already granted, and follow plug/unplug events. */
    async restore() {
      if (!this.supported) return 0;
      if (!JoyConHID._watching) {
        JoyConHID._watching = true;
        global.navigator.hid.addEventListener("connect", e => {
          attachHid(e.device, { replaceSameProduct: false }).catch(() => {});
        });
        global.navigator.hid.addEventListener("disconnect", e => {
          if (hidEntries.has(e.device)) {
            detachHid(e.device);
            notify();
          }
        });
      }
      const granted = await global.navigator.hid.getDevices();
      for (const device of granted) {
        if (device.vendorId === JC_VENDOR && JC_PRODUCTS.includes(device.productId)) {
          await attachHid(device, { replaceSameProduct: false }).catch(() => {
            hadFailedRestore = true;
          });
        }
      }
      if (hadFailedRestore && !hidEntries.size) notify();
      return hidEntries.size;
    },
    disconnectSlot(slotIndex) {
      for (const [dev, entry] of [...hidEntries.entries()]) {
        if (entry.index === slotIndex) {
          detachHid(dev);
          notify();
          return true;
        }
      }
      return false;
    },
    entries() {
      getGamepadsWithHid();
      return [...hidEntries.values()].map(e => ({
        index: e.index ?? 0,
        name: e.name,
        modelKey: e.modelKey,
        slotKey: slotKeyForEntry(e),
        productId: e.productId,
      }));
    },
    names() { return [...hidEntries.values()].map(e => e.name); },
    models() { return [...hidEntries.values()].map(e => e.modelKey); },
    /** One set of pressed buttons per connected Joy-Con, in connection order. */
    states() {
      refreshEntriesNes();
      return calibrationModalOpen ? [...hidEntries.values()].map(() => new Set()) : [...hidEntries.values()].map(e => e.nes);
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onRawReport(fn) { rawListeners.add(fn); return () => rawListeners.delete(fn); },
    getCalibration,
    getEffectiveRule,
    setCalibration,
    resetCalibration,
    deleteCalibration,
    deleteSavedKey,
    deleteButtonMapping,
    listSavedMappings,
    hasCalibration,
  };

  /* ---------- Interactive Multi-Controller Connection & Calibration Modal (NES + Arcade) ---------- */

  let modalEl = null;
  // Current calibration target: { kind: "hid"|"gamepad"|"model", modelKey, slotKey, slotIndex, label }
  let activeTarget = { kind: "model", modelKey: "Joy-Con (R)", slotKey: null, slotIndex: null, label: "Joy-Con (R)" };
  let stepIndex = 0;
  let draftRule = null;
  let waitingForNeutral = true;
  let neutralSince = 0;
  let pendingToken = null;
  let pendingTimer = null;
  let gpPollTimer = null;

  /** List all calibration targets: every connected controller (P1, P2, ...) + model presets. */
  function listCalibrationTargets() {
    const targets = [];
    const seenModels = new Set();

    // 1. Connected WebHID Joy-Cons
    getGamepadsWithHid();
    const sortedHid = [...hidEntries.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const entry of sortedHid) {
      const idx = entry.index ?? 0;
      const slotKey = slotKeyForEntry(entry);
      seenModels.add(entry.modelKey);
      targets.push({
        id: "slot:" + slotKey,
        kind: "hid",
        modelKey: entry.modelKey,
        slotKey,
        slotIndex: idx,
        label: `P${idx + 1} · ${entry.modelKey}`,
      });
    }

    // 2. Connected Standard Gamepads (non-WebHID)
    const rawPads = nativeGetGamepads ? Array.from(nativeGetGamepads() || []) : [];
    rawPads.forEach((pad, idx) => {
      if (!pad || !pad.connected || pad._webhidJoyCon) return;
      const { modelKey, slotKey } = gamepadKeys(pad);
      seenModels.add(modelKey);
      targets.push({
        id: "slot:" + slotKey,
        kind: "gamepad",
        modelKey,
        slotKey,
        slotIndex: pad.index ?? idx,
        label: `P${(pad.index ?? idx) + 1} · ${pad.id.slice(0, 24)}`,
      });
    });

    // 3. Always include Joy-Con (R) and Joy-Con (L) model presets if not already represented
    for (const m of MODELS) {
      if (!seenModels.has(m)) {
        targets.push({
          id: "model:" + m,
          kind: "model",
          modelKey: m,
          slotKey: null,
          slotIndex: null,
          label: `${m}（预设）`,
        });
      }
    }
    return targets;
  }

  function formatSavedKeyLabel(key) {
    const p = platformFromKey(key, "nes");
    const prefix = p === "arcade" ? "[街机] " : "[NES] ";
    const raw = stripPlatformPrefix(key);
    const hashIdx = raw.lastIndexOf("#");
    if (hashIdx > 0) {
      const base = raw.slice(0, hashIdx).replace(/^gp:/, "");
      const slotNum = Number(raw.slice(hashIdx + 1));
      const pLabel = Number.isFinite(slotNum) ? `P${slotNum + 1}` : raw.slice(hashIdx + 1);
      return `${prefix}${pLabel} · ${base.slice(0, 20)}`;
    }
    return `${prefix}${raw.replace(/^gp:/, "").slice(0, 20)}`;
  }

  function ensureModalStyles() {
    const doc = global.document;
    if (!doc?.head || doc.getElementById("joycon-cal-styles")) return;
    const style = doc.createElement("style");
    style.id = "joycon-cal-styles";
    style.textContent = `
      .jc-modal-backdrop {
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(8, 12, 20, 0.82); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center; padding: 16px;
        font-family: system-ui, -apple-system, sans-serif; color: #e8eef7;
      }
      .jc-modal {
        width: 100%; max-width: 640px; background: #182232; border: 1px solid #31435f;
        border-radius: 12px; padding: 16px 18px; box-shadow: 0 18px 48px rgba(0,0,0,0.55);
      }
      .jc-modal h3 { margin: 0 0 10px; font-size: 1.08rem; color: #fff; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
      .jc-mode-switch { display: inline-flex; background: #0f1722; border: 1px solid #2d4263; border-radius: 8px; padding: 2px; gap: 2px; }
      .jc-mode-btn {
        border: none; background: transparent; color: #95a9c6; font-size: 0.8rem; font-weight: 600;
        padding: 4px 10px; border-radius: 6px; cursor: pointer;
      }
      .jc-mode-btn.active { background: #2563eb; color: #fff; }
      .jc-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
      .jc-model-tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; margin-bottom: 10px; }
      .jc-tab {
        padding: 7px 10px; border-radius: 8px; border: 1px solid #364968;
        background: #101824; color: #cfe0f5; cursor: pointer; text-align: left; font-size: 0.84rem;
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
      }
      .jc-tab.active { border-color: #4da3ff; background: #1b3150; color: #fff; font-weight: 600; }
      .jc-badge {
        display: inline-flex; align-items: center; gap: 4px; font-size: 0.72rem; padding: 2px 6px; border-radius: 999px;
        background: #2b3c56; color: #b8cce8; font-weight: 500; white-space: nowrap;
      }
      .jc-badge.saved { background: #1e5b3a; color: #9ef0be; }
      .jc-saved-bar {
        background: #101824; border: 1px solid #26354d; border-radius: 8px;
        padding: 6px 10px; margin-bottom: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
      }
      .jc-saved-chip {
        display: inline-flex; align-items: center; gap: 5px; font-size: 0.74rem;
        padding: 2px 8px; border-radius: 999px; background: #1d324d; color: #d5e6fb; border: 1px solid #35547c;
      }
      .jc-chip-del {
        background: transparent; border: none; color: #fca5a5; cursor: pointer;
        font-size: 0.82rem; line-height: 1; padding: 0 2px; border-radius: 4px;
      }
      .jc-chip-del:hover { background: rgba(239, 68, 68, 0.25); color: #fff; }
      .jc-prompt {
        background: #0f1722; border: 1px solid #2d4263; border-radius: 10px;
        padding: 10px 12px; margin-bottom: 10px; text-align: center;
      }
      .jc-prompt-title { font-size: 1rem; font-weight: 700; color: #ffd166; margin-bottom: 3px; }
      .jc-prompt-title.done { color: #52d681; }
      .jc-prompt-hint { font-size: 0.78rem; color: #95a9c6; }
      .jc-steps {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-bottom: 10px;
      }
      .jc-step {
        position: relative; background: #111926; border: 1px solid #29384f; border-radius: 8px;
        padding: 7px 6px; cursor: pointer; text-align: center; transition: border-color 0.15s;
      }
      .jc-step:hover { border-color: #4da3ff; }
      .jc-step.current { border-color: #ffd166; background: #262318; }
      .jc-step.done { border-color: #2d6a4f; }
      .jc-step.unmapped { border-color: #523438; opacity: 0.85; }
      .jc-step-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
      .jc-step-name { font-size: 0.8rem; font-weight: 700; color: #fff; flex: 1; text-align: center; padding-left: 12px; }
      .jc-step-del {
        background: transparent; border: none; color: #94a3b8; cursor: pointer;
        font-size: 0.85rem; line-height: 1; padding: 1px 4px; border-radius: 4px;
      }
      .jc-step-del:hover { background: #7f1d1d; color: #fecaca; }
      .jc-step-val { font-size: 0.73rem; color: #9bb0cd; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .jc-live {
        background: #101722; border: 1px solid #26354d; border-radius: 8px;
        padding: 7px 10px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px;
      }
      .jc-live-label { font-size: 0.78rem; color: #95a9c6; }
      .jc-live-pills { display: flex; gap: 5px; flex-wrap: wrap; }
      .jc-pill {
        font-size: 0.74rem; padding: 2px 7px; border-radius: 6px;
        background: #1d2a3d; color: #8ea4c2; border: 1px solid #2d3f5b;
      }
      .jc-pill.on { background: #22c55e; color: #081c0f; border-color: #4ade80; font-weight: 700; }
      .jc-actions { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .jc-btn {
        padding: 6px 11px; border-radius: 7px; border: 1px solid #3c5275;
        background: #273750; color: #fff; font-size: 0.82rem; cursor: pointer;
      }
      .jc-btn:hover { background: #324766; }
      .jc-btn.primary { background: #2563eb; border-color: #3b82f6; font-weight: 600; }
      .jc-btn.primary:hover { background: #1d4ed8; }
      .jc-btn.good { background: #16a34a; border-color: #22c55e; font-weight: 600; }
      .jc-btn.danger { background: #7f1d1d; border-color: #991b1b; }
      .jc-btn.danger:hover { background: #991b1b; }
      .jc-btn-xs { padding: 3px 8px; font-size: 0.74rem; margin-top: 5px; }
    `;
    doc.head.appendChild(style);
  }

  function selectTarget(target, startAt = 0) {
    if (target) activeTarget = target;
    draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    stepIndex = startAt;
    waitingForNeutral = true;
    neutralSince = 0;
    pendingToken = null;
    if (pendingTimer) { global.clearTimeout?.(pendingTimer); pendingTimer = null; }
    renderCalibrationModal();
  }

  function selectModalPlatform(platform) {
    modalPlatform = platform === "arcade" ? "arcade" : "nes";
    draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    stepIndex = 0;
    waitingForNeutral = true;
    neutralSince = 0;
    pendingToken = null;
    if (pendingTimer) { global.clearTimeout?.(pendingTimer); pendingTimer = null; }
    renderCalibrationModal();
  }

  function commitStepToken(token) {
    const steps = stepsForPlatform(modalPlatform);
    if (!token || stepIndex < 0 || stepIndex >= steps.length) return;
    const step = steps[stepIndex];
    // Remove token from other buttons in draftRule so rebound keys never collide with secondary defaults
    for (const s of steps) {
      if (s.nes !== step.nes && Array.isArray(draftRule[s.nes])) {
        draftRule[s.nes] = draftRule[s.nes].filter(t => t !== token);
      }
    }
    draftRule[step.nes] = [token];
    // Persist both for this specific controller slot AND for the controller's model on `modalPlatform`
    setCalibration(activeTarget.modelKey, draftRule, activeTarget.slotKey, modalPlatform);
    waitingForNeutral = true;
    neutralSince = 0;
    pendingToken = null;
    stepIndex += 1;
    renderCalibrationModal();
  }

  function clearStepMappingAt(idx, advance = false) {
    const steps = stepsForPlatform(modalPlatform);
    if (idx < 0 || idx >= steps.length) return;
    const step = steps[idx];
    draftRule = draftRule || getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    draftRule[step.nes] = [];
    setCalibration(activeTarget.modelKey, draftRule, activeTarget.slotKey, modalPlatform);
    if (advance) {
      stepIndex = idx + 1;
    }
    renderCalibrationModal();
  }

  function processCalibrationToken(token, isStickHat) {
    const steps = stepsForPlatform(modalPlatform);
    const now = global.performance?.now?.() || Date.now();
    if (stepIndex >= 0 && stepIndex < steps.length) {
      if (!token) {
        if (pendingTimer) { global.clearTimeout?.(pendingTimer); pendingTimer = null; }
        pendingToken = null;
        if (!neutralSince) neutralSince = now;
        if (now - neutralSince >= 90) {
          waitingForNeutral = false;
        }
      } else if (!waitingForNeutral) {
        neutralSince = 0;
        const normalizedToken = (isStickHat && pendingToken?.startsWith("hat:"))
          ? ((Number(token.slice(4)) % 2 === 0) ? token : pendingToken)
          : token;
        if (pendingToken !== normalizedToken) {
          pendingToken = normalizedToken;
          if (pendingTimer) global.clearTimeout?.(pendingTimer);
          if (typeof global.setTimeout === "function") {
            pendingTimer = global.setTimeout(() => {
              pendingTimer = null;
              if (calibrationModalOpen && !waitingForNeutral && pendingToken) {
                let finalToken = pendingToken;
                if (finalToken.startsWith("hat:") && stepIndex < 4) {
                  const h = Number(finalToken.slice(4));
                  if (h % 2 === 1) finalToken = "hat:" + ((h + 7) % 8);
                }
                commitStepToken(finalToken);
              }
            }, 55);
          } else {
            commitStepToken(pendingToken);
          }
        }
      }
    }
  }

  function handleRawForCalibration(entry) {
    if (!calibrationModalOpen || !modalEl) return;
    if (activeTarget.slotIndex != null) {
      if ((entry.index ?? 0) !== activeTarget.slotIndex) {
        updateLivePills();
        return;
      }
    } else if (entry.modelKey !== activeTarget.modelKey) {
      if (hidEntries.size === 1) {
        const targets = listCalibrationTargets();
        const found = targets.find(t => t.slotIndex === (entry.index ?? 0));
        if (found) activeTarget = found;
        draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
      } else {
        updateLivePills();
        return;
      }
    }

    const token = detectActiveToken(entry.b1, entry.b2, entry.hat);
    processCalibrationToken(token, token?.startsWith("hat:"));
    updateLivePills();
  }

  function pollStandardGamepadForCalibration() {
    if (!calibrationModalOpen || !modalEl) return;
    if (activeTarget.kind === "gamepad" && activeTarget.slotIndex != null) {
      const rawPads = nativeGetGamepads ? Array.from(nativeGetGamepads() || []) : [];
      const pad = rawPads.find(p => p && p.connected && !p._webhidJoyCon && p.index === activeTarget.slotIndex);
      if (pad) {
        const token = detectActiveGamepadToken(pad);
        processCalibrationToken(token, false);
        updateLivePills();
      }
    }
  }

  function updateLivePills() {
    if (!modalEl) return;
    const activeNes = new Set();
    if (activeTarget.kind === "gamepad" && activeTarget.slotIndex != null) {
      const rawPads = nativeGetGamepads ? Array.from(nativeGetGamepads() || []) : [];
      const pad = rawPads.find(p => p && p.connected && !p._webhidJoyCon && p.index === activeTarget.slotIndex);
      if (pad) {
        for (const n of padButtons(pad, modalPlatform)) activeNes.add(n);
      }
    } else {
      for (const entry of hidEntries.values()) {
        const matchesSlot = activeTarget.slotIndex != null
          ? (entry.index ?? 0) === activeTarget.slotIndex
          : (entry.modelKey === activeTarget.modelKey || hidEntries.size === 1);
        if (matchesSlot) {
          const s = joyconNesState(entry.b1, entry.b2, entry.hat, entry.modelKey, slotKeyForEntry(entry), modalPlatform);
          for (const n of s) activeNes.add(n);
        }
      }
    }
    modalEl.querySelectorAll("[data-nes-pill]").forEach(el => {
      const nes = Number(el.getAttribute("data-nes-pill"));
      el.classList.toggle("on", activeNes.has(nes));
    });
  }

  function renderCalibrationModal() {
    if (!modalEl) return;
    const doc = global.document;
    const steps = stepsForPlatform(modalPlatform);
    const targets = listCalibrationTargets();
    const matched = targets.find(t =>
      (activeTarget.slotKey && t.slotKey === activeTarget.slotKey) ||
      (!activeTarget.slotKey && t.modelKey === activeTarget.modelKey)
    ) || targets[0];
    if (matched) {
      activeTarget = matched;
      draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    }

    modalEl.querySelectorAll("[data-jc-platform]").forEach(btn => {
      const active = btn.getAttribute("data-jc-platform") === modalPlatform;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    const entries = JoyConHID.entries();
    const connStatusEl = modalEl.querySelector("[data-jc-conn-status]");
    if (connStatusEl) {
      connStatusEl.textContent = entries.length
        ? "已连接：" + entries.map(e => `P${e.index + 1} ${e.modelKey}`).join("、")
        : "未连接 WebHID Joy-Con";
    }

    const tabsContainer = modalEl.querySelector("[data-jc-tabs]");
    if (tabsContainer) {
      tabsContainer.innerHTML = "";
      targets.forEach(t => {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "jc-tab" + (t.id === activeTarget.id ? " active" : "");
        const saved = hasCalibration(t.modelKey, t.slotKey, modalPlatform);
        const spanName = doc.createElement("span");
        spanName.textContent = t.label;
        const badge = doc.createElement("span");
        badge.className = "jc-badge" + (saved ? " saved" : "");
        badge.textContent = saved ? "已保存映射" : "默认映射";
        if (saved) {
          const delSpan = doc.createElement("span");
          delSpan.className = "jc-chip-del";
          delSpan.title = "删除此手柄映射";
          delSpan.textContent = "×";
          delSpan.addEventListener("click", e => {
            e.stopPropagation();
            resetCalibration(t.modelKey, t.slotKey, modalPlatform);
            if (t.id === activeTarget.id) {
              draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
            }
            renderCalibrationModal();
          });
          badge.appendChild(delSpan);
        }
        btn.appendChild(spanName);
        btn.appendChild(badge);
        btn.addEventListener("click", () => selectTarget(t, 0));
        tabsContainer.appendChild(btn);
      });
    }

    const savedBar = modalEl.querySelector("[data-jc-saved-bar]");
    if (savedBar) {
      const savedKeys = listSavedMappings();
      savedBar.innerHTML = "";
      const titleSpan = doc.createElement("span");
      titleSpan.className = "jc-live-label";
      titleSpan.textContent = "已保存：";
      savedBar.appendChild(titleSpan);
      if (!savedKeys.length) {
        const emptySpan = doc.createElement("span");
        emptySpan.className = "jc-live-label";
        emptySpan.textContent = "无（使用默认键位）";
        savedBar.appendChild(emptySpan);
      } else {
        savedKeys.forEach(k => {
          const chip = doc.createElement("span");
          chip.className = "jc-saved-chip";
          chip.dataset.savedKey = k;
          const label = doc.createElement("span");
          label.textContent = formatSavedKeyLabel(k);
          const delBtn = doc.createElement("button");
          delBtn.type = "button";
          delBtn.className = "jc-chip-del";
          delBtn.dataset.jcDelSaved = k;
          delBtn.title = `删除 ${k}`;
          delBtn.textContent = "×";
          delBtn.addEventListener("click", e => {
            e.stopPropagation();
            deleteSavedKey(k);
            draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
            renderCalibrationModal();
          });
          chip.appendChild(label);
          chip.appendChild(delBtn);
          savedBar.appendChild(chip);
        });
      }
    }

    const promptTitle = modalEl.querySelector("[data-jc-prompt-title]");
    const promptHint = modalEl.querySelector("[data-jc-prompt-hint]");
    const clearCurrBtn = modalEl.querySelector("[data-jc-clear-current]");
    const restartBtn = modalEl.querySelector("[data-jc-restart]");
    if (restartBtn) {
      restartBtn.textContent = `重新校准 (1~${steps.length})`;
    }
    if (promptTitle && promptHint) {
      const modeLabel = modalPlatform === "arcade" ? "街机" : "NES";
      if (stepIndex >= 0 && stepIndex < steps.length) {
        const st = steps[stepIndex];
        promptTitle.textContent = `[${modeLabel}] ${activeTarget.label} · 第 ${stepIndex + 1}/${steps.length} 步：按【${st.label}】`;
        promptTitle.classList.remove("done");
        promptHint.textContent = waitingForNeutral
          ? "请先松开所有按键与摇杆…"
          : `请按【${st.label}】（可点下方按钮跳过）`;
        if (clearCurrBtn) {
          clearCurrBtn.hidden = false;
          clearCurrBtn.textContent = `删除【${st.label}】并跳过`;
        }
      } else {
        promptTitle.textContent = `✓ 已保存 [${modeLabel}] ${activeTarget.label} 映射`;
        promptTitle.classList.add("done");
        promptHint.textContent = "可按键测试，或点击任意格子单独重设";
        if (clearCurrBtn) clearCurrBtn.hidden = true;
      }
    }

    const rule = draftRule || getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    const stepsContainer = modalEl.querySelector("[data-jc-steps-grid]");
    if (stepsContainer) {
      if (stepsContainer.dataset.renderedPlatform !== modalPlatform) {
        stepsContainer.dataset.renderedPlatform = modalPlatform;
        stepsContainer.innerHTML = steps.map((st, idx) => `
          <div class="jc-step" data-jc-step="${idx}" title="点击单独校准【${st.label}】">
            <div class="jc-step-head">
              <div class="jc-step-name">${idx + 1}. ${st.label}</div>
              <button type="button" class="jc-step-del" data-jc-clear-step="${idx}" title="删除【${st.label}】映射">×</button>
            </div>
            <div class="jc-step-val"></div>
          </div>
        `).join("");
        stepsContainer.querySelectorAll("[data-jc-clear-step]").forEach(delBtn => {
          delBtn.addEventListener("click", e => {
            e.stopPropagation();
            const idx = Number(delBtn.getAttribute("data-jc-clear-step"));
            clearStepMappingAt(idx, false);
          });
        });
        stepsContainer.querySelectorAll("[data-jc-step]").forEach(cell => {
          cell.addEventListener("click", () => {
            const idx = Number(cell.getAttribute("data-jc-step"));
            stepIndex = idx;
            waitingForNeutral = false;
            neutralSince = 0;
            pendingToken = null;
            renderCalibrationModal();
          });
        });
      }
      stepsContainer.querySelectorAll("[data-jc-step]").forEach(cell => {
        const idx = Number(cell.getAttribute("data-jc-step"));
        const st = steps[idx];
        if (!st) return;
        const tokens = rule[st.nes];
        const isUnmapped = Array.isArray(tokens) && tokens.length === 0;
        cell.classList.toggle("current", idx === stepIndex);
        cell.classList.toggle("done", !isUnmapped && (idx < stepIndex || stepIndex >= steps.length));
        cell.classList.toggle("unmapped", isUnmapped);
        const valEl = cell.querySelector(".jc-step-val");
        if (valEl) {
          valEl.textContent = idx === stepIndex ? "等待按下…" : formatTokens(tokens);
        }
      });
    }

    const pillsContainer = modalEl.querySelector("[data-jc-live-pills]");
    if (pillsContainer && pillsContainer.dataset.renderedPlatform !== modalPlatform) {
      pillsContainer.dataset.renderedPlatform = modalPlatform;
      pillsContainer.innerHTML = steps.map(st => `
        <span class="jc-pill" data-nes-pill="${st.nes}">${st.short}</span>
      `).join("");
    }

    updateLivePills();
  }

  function closeCalibrationModal() {
    calibrationModalOpen = false;
    if (pendingTimer) { global.clearTimeout?.(pendingTimer); pendingTimer = null; }
    if (gpPollTimer) { global.clearInterval?.(gpPollTimer); gpPollTimer = null; }
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    refreshEntriesNes();
    notify();
  }

  /**
   * Open the interactive connection & calibration modal.
   * @param {string|object} [opts] - model name ("Joy-Con (R)"/"Joy-Con (L)") or { slotIndex, modelKey, platform }
   */
  function openCalibrationModal(opts) {
    const doc = global.document;
    if (!doc?.body) return;
    ensureModalStyles();

    const prefPlatform = typeof opts === "object" && opts?.platform ? opts.platform : inputPlatform;
    modalPlatform = prefPlatform === "arcade" ? "arcade" : "nes";

    const targets = listCalibrationTargets();
    const prefModel = typeof opts === "string" ? opts : opts?.modelKey;
    const prefSlot = typeof opts === "object" && opts ? opts.slotIndex : null;

    let chosen = null;
    if (prefSlot != null) {
      chosen = targets.find(t => t.slotIndex === prefSlot);
    }
    if (!chosen && prefModel) {
      chosen = targets.find(t => t.modelKey === prefModel);
    }
    if (!chosen) {
      chosen = targets[0];
    }
    activeTarget = chosen;
    draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
    stepIndex = 0;
    waitingForNeutral = false;
    neutralSince = 0;
    pendingToken = null;
    calibrationModalOpen = true;

    if (!gpPollTimer && typeof global.setInterval === "function") {
      gpPollTimer = global.setInterval(pollStandardGamepadForCalibration, 30);
    }

    if (!modalEl) {
      modalEl = doc.createElement("div");
      modalEl.className = "jc-modal-backdrop";
      modalEl.addEventListener("mousedown", e => {
        e.stopPropagation();
        if (e.target === modalEl) closeCalibrationModal();
      });
      modalEl.addEventListener("keydown", e => {
        if (e.key === "Escape") closeCalibrationModal();
      });
      modalEl.innerHTML = `
        <div class="jc-modal" role="dialog" aria-modal="true" aria-label="手柄连接与按键校准">
          <h3>
            <span>手柄连接与按键校准</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="jc-mode-switch" role="group" aria-label="校准模式">
                <button type="button" class="jc-mode-btn" data-jc-platform="nes">红白机 NES</button>
                <button type="button" class="jc-mode-btn" data-jc-platform="arcade">街机 FBNeo</button>
              </div>
              <button type="button" class="jc-btn" data-jc-close>关闭</button>
            </div>
          </h3>
          <div class="jc-toolbar">
            <span class="jc-live-label" data-jc-conn-status style="flex:1"></span>
            <button type="button" class="jc-btn primary" data-jc-add>＋ 连接 Joy-Con</button>
            <button type="button" class="jc-btn" data-jc-reconnect title="蓝牙重配对后替换当前槽位">重连当前槽位</button>
          </div>
          <div class="jc-model-tabs" data-jc-tabs></div>
          <div class="jc-saved-bar" data-jc-saved-bar></div>
          <div class="jc-prompt">
            <div class="jc-prompt-title" data-jc-prompt-title></div>
            <div class="jc-prompt-hint" data-jc-prompt-hint></div>
            <button type="button" class="jc-btn danger jc-btn-xs" data-jc-clear-current>删除此键并跳过</button>
          </div>
          <div class="jc-steps" data-jc-steps-grid></div>
          <div class="jc-live">
            <span class="jc-live-label">实时测试：</span>
            <div class="jc-live-pills" data-jc-live-pills></div>
          </div>
          <div class="jc-actions">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="jc-btn primary" data-jc-restart>重新校准</button>
              <button type="button" class="jc-btn danger" data-jc-reset title="恢复当前手柄在当前模式下的默认映射">恢复默认</button>
              <button type="button" class="jc-btn danger" data-jc-clear-all title="清空所有已保存映射">清空全部</button>
            </div>
            <button type="button" class="jc-btn good" data-jc-done>完成</button>
          </div>
        </div>
      `;

      modalEl.querySelectorAll("[data-jc-platform]").forEach(btn => {
        btn.addEventListener("click", () => selectModalPlatform(btn.getAttribute("data-jc-platform")));
      });
      modalEl.querySelector("[data-jc-close]").addEventListener("click", closeCalibrationModal);
      modalEl.querySelector("[data-jc-done]").addEventListener("click", closeCalibrationModal);
      modalEl.querySelector("[data-jc-add]").addEventListener("click", async () => {
        try {
          const prevCount = JoyConHID.entries().length;
          await JoyConHID.request({ addNew: true });
          const updated = listCalibrationTargets();
          const newest = updated.find(t => t.slotIndex === prevCount) || updated[0];
          if (newest) {
            selectTarget(newest, 0);
            return;
          }
        } catch (err) {
          if (err?.name !== "NotFoundError") {
            const st = modalEl?.querySelector("[data-jc-conn-status]");
            if (st) st.textContent = "连接失败：" + (err?.message || err);
          }
        }
        renderCalibrationModal();
      });
      modalEl.querySelector("[data-jc-reconnect]").addEventListener("click", async () => {
        try {
          const targetSlot = activeTarget.slotIndex ?? 0;
          await JoyConHID.request({ replaceSlotIndex: targetSlot });
          const updated = listCalibrationTargets();
          const found = updated.find(t => t.slotIndex === targetSlot) || updated[0];
          if (found) {
            selectTarget(found, 0);
            return;
          }
        } catch (err) {
          if (err?.name !== "NotFoundError") {
            const st = modalEl?.querySelector("[data-jc-conn-status]");
            if (st) st.textContent = "重连失败：" + (err?.message || err);
          }
        }
        renderCalibrationModal();
      });
      modalEl.querySelector("[data-jc-clear-current]").addEventListener("click", () => {
        clearStepMappingAt(stepIndex, true);
      });
      modalEl.querySelector("[data-jc-restart]").addEventListener("click", () => {
        selectTarget(activeTarget, 0);
      });
      modalEl.querySelector("[data-jc-reset]").addEventListener("click", () => {
        resetCalibration(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
        draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
        stepIndex = stepsForPlatform(modalPlatform).length;
        renderCalibrationModal();
      });
      modalEl.querySelector("[data-jc-clear-all]").addEventListener("click", () => {
        resetCalibration();
        draftRule = getEffectiveRule(activeTarget.modelKey, activeTarget.slotKey, modalPlatform);
        stepIndex = stepsForPlatform(modalPlatform).length;
        renderCalibrationModal();
      });
    }

    const host = doc.fullscreenElement || doc.body;
    if (modalEl.parentElement !== host) host.appendChild(modalEl);
    renderCalibrationModal();
  }

  JoyConHID.onRawReport(handleRawForCalibration);
  JoyConHID.onChange(() => { if (calibrationModalOpen) renderCalibrationModal(); });

  /**
   * Wire a "connect Joy-Con" button and automatically attach a companion "校准手柄" button
   * next to it so the user can connect multiple controllers and calibrate each independently.
   */
  const boundButtons = new WeakSet();
  function bindJoyConButton(button) {
    if (!button || boundButtons.has(button)) return;
    boundButtons.add(button);
    const doc = global.document;
    const status = doc?.getElementById?.("status");
    const slotAttr = button.dataset?.joyconSlot;
    const slotIndex = slotAttr != null && slotAttr !== "" ? Number(slotAttr) : null;

    const report = (text, kind = "error") => {
      if (status) { status.textContent = text; status.className = kind; }
      else if (kind === "error") global.alert?.(text);
    };
    const refresh = () => {
      const n = hidEntries.size;
      if (slotIndex != null) {
        const hasSlot = [...hidEntries.values()].some(e => e.index === slotIndex);
        button.textContent = hasSlot ? `P${slotIndex + 1} Joy-Con 已连接 · 重连` : `连接 P${slotIndex + 1} Joy-Con`;
      } else {
        button.textContent = n ? `Joy-Con 已连接（${n}）· 添加/重连` : (inputPlatform === "arcade" ? "连接街机手柄" : "连接 Joy-Con");
      }
      if (hadFailedRestore && !n) {
        report("检测到 Joy-Con 蓝牙重新配对或已断开，请点击「连接 Joy-Con」重新授权。", "warn");
      }
    };
    if (!JoyConHID.supported) {
      button.disabled = true;
      button.title = "需要 Chrome/Edge，并通过 localhost 或 https 访问";
      return;
    }
    button.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        const count = await JoyConHID.request(
          slotIndex != null ? { replaceSlotIndex: slotIndex } : { addNew: true }
        );
        if (count > 0) {
          report("Joy-Con 已连接（" + JoyConHID.names().join("、") + "）· 可点「校准手柄」设置 NES/街机 键位", "ok");
        }
      } catch (error) {
        if (error?.name !== "NotFoundError") report("连接 Joy-Con 失败：" + (error?.message || error));
      }
      refresh();
    });

    // Inject companion "校准手柄" button right after the Connect button if in DOM
    if (doc?.createElement && button.parentElement && !button.parentElement.querySelector("[data-joycon-calibrate]")) {
      const calBtn = doc.createElement("button");
      calBtn.type = "button";
      calBtn.className = button.className || "secondary";
      calBtn.dataset.joyconCalibrate = "1";
      if (button.getAttribute("style")) {
        calBtn.setAttribute("style", button.getAttribute("style"));
      }
      calBtn.textContent = slotIndex != null ? `校准 P${slotIndex + 1} 手柄` : "校准手柄";
      calBtn.title = "独立校准 NES / 街机 手柄键位";
      ["mousedown", "touchstart"].forEach(evt => calBtn.addEventListener(evt, e => e.stopPropagation()));
      calBtn.addEventListener("click", event => {
        event.stopPropagation();
        openCalibrationModal(slotIndex != null ? { slotIndex } : undefined);
      });
      if (button.nextSibling) {
        button.parentElement.insertBefore(calBtn, button.nextSibling);
      } else {
        button.parentElement.appendChild(calBtn);
      }
    }

    JoyConHID.onChange(refresh);
    JoyConHID.restore().then(refresh, refresh);
  }

  /** Array indexed by player (0-based): pads sorted by index, extras merged into the last player. */
  function readPlayers(maxPlayers) {
    const players = Array.from({ length: maxPlayers }, () => new Set());
    if (calibrationModalOpen) return players;
    const pads = connectedPads();
    pads.forEach((pad, n) => {
      for (const b of padButtons(pad, inputPlatform)) players[Math.min(n, maxPlayers - 1)].add(b);
    });
    // Fallback when navigator.getGamepads was replaced after load and didn't include WebHID pads.
    if (!pads.some(p => p._webhidJoyCon || isSingleJoyCon(p))) {
      JoyConHID.states().forEach((set, n) => {
        for (const b of set) players[Math.min(pads.length + n, maxPlayers - 1)].add(b);
      });
    }
    return players;
  }

  function setPlatform(platform) {
    const next = platform === "arcade" ? "arcade" : "nes";
    const changed = inputPlatform !== next;
    inputPlatform = next;
    if (!calibrationModalOpen) {
      modalPlatform = inputPlatform;
    }
    refreshEntriesNes();
    if (changed) notify();
    return inputPlatform;
  }

  function getPlatform() {
    return inputPlatform;
  }

  if (typeof global.document?.querySelectorAll === "function") {
    const bind = () => global.document.querySelectorAll("[data-joycon-button]").forEach(bindJoyConButton);
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", bind);
    else bind();
  }

  global.GamepadInput = {
    NES,
    CALIBRATION_STEPS,
    ARCADE_CALIBRATION_STEPS,
    stepsForPlatform,
    DEFAULT_JOYCON_RULES,
    DEFAULT_JOYCON_ARCADE_RULES,
    DEFAULT_GAMEPAD_RULES,
    DEFAULT_GAMEPAD_ARCADE_RULES,
    isSingleJoyCon,
    padButtons,
    readPlayers,
    connectedPads,
    JoyConHID,
    joyconNesState,
    joyconFullReportNesState,
    fullReportToSimple,
    detectActiveToken,
    bindJoyConButton,
    openCalibrationModal,
    closeCalibrationModal,
    setPlatform,
    getPlatform,
  };
})(window);
