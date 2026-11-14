import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/gamepad-input.js', import.meta.url), 'utf8');
function load(navigator = {}) {
  const context = { navigator };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.GamepadInput;
}
const names = set => Array.from(set).sort((a, b) => a - b);
const sorted = (...xs) => xs.sort((a, b) => a - b);

// Report bytes were captured from a real Joy-Con (R) held sideways (see gamepad-input.js).
test('Joy-Con simple report: face buttons, shoulders and menu keys', () => {
  const g = load();
  assert.deepEqual(names(g.joyconNesState(0, 0, 8)), []);
  assert.deepEqual(names(g.joyconNesState(0x01, 0, 8)), [g.NES.B]);
  assert.deepEqual(names(g.joyconNesState(0x04, 0, 8)), [g.NES.B]);
  assert.deepEqual(names(g.joyconNesState(0x02, 0, 8)), [g.NES.A]);
  assert.deepEqual(names(g.joyconNesState(0x08, 0, 8)), [g.NES.A]);
  assert.deepEqual(names(g.joyconNesState(0x10, 0, 8)), [g.NES.SELECT]);
  assert.deepEqual(names(g.joyconNesState(0x20, 0, 8)), [g.NES.START]);
  assert.deepEqual(names(g.joyconNesState(0, 0x01, 8)), [g.NES.SELECT]);
  assert.deepEqual(names(g.joyconNesState(0, 0x02, 8)), [g.NES.START]);
  assert.deepEqual(names(g.joyconNesState(0, 0x08, 8)), [], 'stick click is unused');
});

test('arcade gamepads expose six actions while NES mapping remains unchanged', () => {
  const g = load();
  const pad = { id: 'Xbox Controller', index: 0, axes: [0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: [0,1,2,3,4,5,8,9,12].includes(i) })) };
  assert.deepEqual(names(g.padButtons(pad)), sorted(g.NES.B,g.NES.A,g.NES.SELECT,g.NES.START,g.NES.UP));
  g.setPlatform('arcade');
  assert.deepEqual(names(g.padButtons(pad)), sorted(g.NES.B,g.NES.A,g.NES.Y,g.NES.X,g.NES.L,g.NES.R,g.NES.SELECT,g.NES.START,g.NES.UP));
});

test('Joy-Con hat decodes four directions and diagonals; 8 is neutral', () => {
  const g = load(), { UP, RIGHT, DOWN, LEFT } = g.NES;
  const dir = hat => names(g.joyconNesState(0, 0, hat));
  assert.deepEqual(dir(0), [UP]);
  assert.deepEqual(dir(2), [RIGHT]);
  assert.deepEqual(dir(4), [DOWN]);
  assert.deepEqual(dir(6), [LEFT]);
  assert.deepEqual(dir(1), sorted(UP, RIGHT));
  assert.deepEqual(dir(3), sorted(RIGHT, DOWN));
  assert.deepEqual(dir(5), sorted(DOWN, LEFT));
  assert.deepEqual(dir(7), sorted(UP, LEFT));
  assert.deepEqual(dir(8), []);
});

test('WebHID Joy-Con reports are read after request(), per device', async () => {
  const handlers = [];
  const device = { vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { device.opened = true; }, addEventListener: (type, fn) => handlers.push([type, fn]) };
  const hid = { requestDevice: async ({ filters }) => {
      assert.deepEqual(Array.from(filters, f => f.productId), [0x2006, 0x2007]); return [device]; },
    getDevices: async () => [], addEventListener() {} };
  const nav = { hid, getGamepads: () => [] };
  const g = load(nav);
  assert.equal(await g.JoyConHID.request(), 1);
  assert(device.opened);
  const report = (id, ...bytes) => handlers.find(([t]) => t === 'inputreport')[1](
    { reportId: id, data: new DataView(new Uint8Array(bytes).buffer) });
  report(0x3f, 0x02, 0x00, 0x00); // right button + stick up
  assert.deepEqual(names(g.JoyConHID.states()[0]), sorted(g.NES.UP, g.NES.A));
  assert.deepEqual(names(g.readPlayers(1)[0]), sorted(g.NES.UP, g.NES.A));
  const virtualPad = nav.getGamepads()[0];
  assert.equal(virtualPad.id, 'Joy-Con (R) (WebHID)');
  assert.equal(virtualPad.index, 0);
  assert.equal(virtualPad.buttons[1].pressed, true, 'BUTTON_2 (A) pressed on virtual Gamepad');
  assert.equal(virtualPad.buttons[12].pressed, true, 'DPAD_UP pressed on virtual Gamepad');
  // 0x30 full input report: byte 2 = bR (0x08 = A), bytes 8..10 = right stick neutral (2048)
  report(0x30, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x80);
  assert.deepEqual(names(g.JoyConHID.states()[0]), [g.NES.A]);
  report(0x3f, 0, 0, 8);
  assert.deepEqual(names(g.readPlayers(2)[0]), []);
  assert.equal(nav.getGamepads()[0].buttons[1].pressed, false);
});

test('re-pairing a Joy-Con replaces the previous pairing of the same model at index 0', async () => {
  let forgotOld = false;
  const oldDevice = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { oldDevice.opened = true; },
    close: () => { oldDevice.opened = false; },
    forget: async () => { forgotOld = true; },
    addEventListener() {},
  };
  const newHandlers = [];
  const newDevice = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { newDevice.opened = true; },
    addEventListener: (type, fn) => newHandlers.push([type, fn]),
  };
  let selected = [oldDevice];
  const hid = {
    requestDevice: async () => selected,
    getDevices: async () => [],
    addEventListener() {},
  };
  const nav = { hid, getGamepads: () => [] };
  const g = load(nav);

  assert.equal(await g.JoyConHID.request(), 1);
  assert.equal(nav.getGamepads()[0].index, 0);

  selected = [newDevice];
  assert.equal(await g.JoyConHID.request(), 1, 'stale pairing is replaced, count stays 1');
  assert.equal(forgotOld, true);
  assert.equal(nav.getGamepads()[0].index, 0, 're-paired Joy-Con stays at player 1 (index 0)');
});

test('without WebHID the Joy-Con button path is unavailable but nothing throws', async () => {
  const g = load({ getGamepads: () => [] });
  assert.equal(g.JoyConHID.supported, false);
  assert.equal(await g.JoyConHID.restore(), 0);
  await assert.rejects(() => g.JoyConHID.request(), /WebHID/);
  assert.deepEqual(Array.from(g.readPlayers(2), s => s.size), [0, 0]);
});

test('syncEmulatorGamepads injects Connect Joy-Con button into Control Settings and repairs cleared bindings', async () => {
  const emuCommonSource = fs.readFileSync(new URL('../js/emulator-common.js', import.meta.url), 'utf8');
  const device = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { device.opened = true; }, addEventListener() {},
  };
  const hid = {
    requestDevice: async () => [device],
    getDevices: async () => [device],
    addEventListener() {},
  };
  const appended = [];
  const section = {
    querySelector: sel => appended.find(el => sel === '[data-joycon-button]' && el.dataset?.joyconButton) || null,
    appendChild: el => appended.push(el),
  };
  const document = {
    readyState: 'complete',
    querySelectorAll: () => [],
    getElementById: () => ({ querySelectorAll: sel => sel === '.ejs_gamepad_section' ? [section] : [] }),
    createElement: tag => ({ tagName: tag.toUpperCase(), dataset: {}, style: {}, addEventListener() {} }),
  };
  const context = { navigator: { hid, getGamepads: () => [] }, document };
  context.window = context;
  vm.runInNewContext(source, context);
  vm.runInNewContext(emuCommonSource, context);

  await context.GamepadInput.JoyConHID.restore();
  let labelsUpdated = 0;
  const emu = {
    gamepad: {
      gamepads: [],
      updateGamepadState() { this.gamepads = Array.from(context.navigator.getGamepads()).filter(Boolean); },
    },
    getGamepadSelectionValue(idx) {
      const p = this.gamepad.gamepads.find(c => c.index === idx);
      return p ? `${p.id}_${p.index}` : '';
    },
    frontend: {
      gamepadSelection: ['', '', '', ''],
      gamepadLabels: [{ options: [{ value: 'notconnected' }] }],
      updateGamepadLabels() { labelsUpdated++; },
      checkGamepadInputs() {},
    },
    controls: { 0: {}, 1: {} },
    setupKeys() {},
    saveSettings() {},
  };

  context.EmuCommon.syncEmulatorGamepads(emu, false);
  assert.equal(appended.length, 1, 'injected Connect Joy-Con button into .ejs_gamepad_section');
  assert.equal(emu.frontend.gamepadSelection[0], 'Joy-Con (R) (WebHID)_0');
  assert.equal(labelsUpdated, 1);
  assert.equal(emu.controls[0][8].value2, 'BUTTON_2', 'restored NES A gamepad binding');
  assert.equal(emu.controls[0][4].value2, 'DPAD_UP', 'restored NES UP gamepad binding');
});

test('calibration steps follow Up, Down, Left, Right, A, B, Start, Select and persist per Joy-Con (R)/(L) model', () => {
  const store = new Map();
  const localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const ctx1 = { navigator: { getGamepads: () => [] }, localStorage };
  ctx1.window = ctx1;
  vm.runInNewContext(source, ctx1);
  const g1 = ctx1.GamepadInput;

  assert.deepEqual(
    Array.from(g1.CALIBRATION_STEPS, s => s.key),
    ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT']
  );

  // Invert Joy-Con (R) orientation and swap A/B, while keeping Joy-Con (L) with a distinct rule
  g1.JoyConHID.setCalibration('Joy-Con (R)', {
    [g1.NES.UP]: ['hat:4'],
    [g1.NES.DOWN]: ['hat:0'],
    [g1.NES.LEFT]: ['hat:2'],
    [g1.NES.RIGHT]: ['hat:6'],
    [g1.NES.A]: ['b1:1'],
    [g1.NES.B]: ['b1:2'],
    [g1.NES.START]: ['b1:16'],
    [g1.NES.SELECT]: ['b1:32'],
  });
  g1.JoyConHID.setCalibration('Joy-Con (L)', {
    [g1.NES.UP]: ['hat:0'],
    [g1.NES.DOWN]: ['hat:4'],
    [g1.NES.LEFT]: ['hat:6'],
    [g1.NES.RIGHT]: ['hat:2'],
    [g1.NES.A]: ['b1:8'],
    [g1.NES.B]: ['b1:4'],
    [g1.NES.START]: ['b2:1'],
    [g1.NES.SELECT]: ['b1:16'],
  });

  // Reload in a fresh VM sharing the same localStorage to verify persistence
  const ctx2 = { navigator: { getGamepads: () => [] }, localStorage };
  ctx2.window = ctx2;
  vm.runInNewContext(source, ctx2);
  const g2 = ctx2.GamepadInput;

  assert.equal(g2.JoyConHID.hasCalibration('Joy-Con (R)'), true);
  assert.equal(g2.JoyConHID.hasCalibration('Joy-Con (L)'), true);
  assert.deepEqual(names(g2.joyconNesState(0x01, 0, 4, 'Joy-Con (R)')), sorted(g2.NES.UP, g2.NES.A));
  assert.deepEqual(names(g2.joyconNesState(0x08, 0x01, 0, 'Joy-Con (L)')), sorted(g2.NES.UP, g2.NES.A, g2.NES.START));
});

test('multiple connected controllers are calibrated independently per slot', async () => {
  const handlers1 = [], handlers2 = [];
  const dev1 = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { dev1.opened = true; },
    addEventListener: (t, fn) => handlers1.push([t, fn]),
  };
  const dev2 = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { dev2.opened = true; },
    addEventListener: (t, fn) => handlers2.push([t, fn]),
  };
  let pick = [dev1];
  const hid = {
    requestDevice: async () => pick,
    getDevices: async () => [],
    addEventListener() {},
  };
  const nav = { hid, getGamepads: () => [] };
  const g = load(nav);

  assert.equal(await g.JoyConHID.request({ addNew: true }), 1);
  pick = [dev2];
  assert.equal(await g.JoyConHID.request({ addNew: true }), 2, 'both Joy-Cons stay connected as P1 and P2');

  // Calibrate P1 (slot 0) so b1:1 = A, and P2 (slot 1) so b1:1 = B
  g.JoyConHID.setCalibration('Joy-Con (R)', {
    ...g.DEFAULT_JOYCON_RULES,
    [g.NES.A]: ['b1:1'],
    [g.NES.B]: ['b1:2'],
  }, 'Joy-Con (R)#0');

  g.JoyConHID.setCalibration('Joy-Con (R)', {
    ...g.DEFAULT_JOYCON_RULES,
    [g.NES.A]: ['b1:2'],
    [g.NES.B]: ['b1:1'],
  }, 'Joy-Con (R)#1');

  // Send the exact same physical button press (b1=0x01) on both controllers
  const send = (hs, b1) => hs.find(([t]) => t === 'inputreport')[1](
    { reportId: 0x3f, data: new DataView(new Uint8Array([b1, 0, 8]).buffer) }
  );
  send(handlers1, 0x01);
  send(handlers2, 0x01);

  const players = g.readPlayers(2);
  assert.deepEqual(names(players[0]), [g.NES.A], 'P1 maps b1:1 to NES A');
  assert.deepEqual(names(players[1]), [g.NES.B], 'P2 independently maps b1:1 to NES B');
});

test('deleteButtonMapping, deleteSavedKey, and deleteCalibration remove mappings cleanly', () => {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const ctx = { navigator: { getGamepads: () => [] }, localStorage };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const g = ctx.GamepadInput;

  // Delete SELECT button mapping on Joy-Con (R)
  g.JoyConHID.deleteButtonMapping('Joy-Con (R)', g.NES.SELECT, 'Joy-Con (R)#0');
  assert.deepEqual([...g.JoyConHID.getEffectiveRule('Joy-Con (R)', 'Joy-Con (R)#0')[g.NES.SELECT]], []);
  // SL (0x10) should no longer trigger SELECT on Joy-Con (R)#0, while SR (0x20) still triggers START
  assert.deepEqual(names(g.joyconNesState(0x30, 0, 8, 'Joy-Con (R)', 'Joy-Con (R)#0')), [g.NES.START]);

  // Also save a Joy-Con (L) rule
  g.JoyConHID.setCalibration('Joy-Con (L)', { ...g.DEFAULT_JOYCON_RULES, [g.NES.A]: ['b1:1'] });
  assert.equal(g.JoyConHID.listSavedMappings().includes('Joy-Con (R)#0'), true);
  assert.equal(g.JoyConHID.listSavedMappings().includes('Joy-Con (L)'), true);

  // Delete only the slot key 'Joy-Con (R)#0'
  assert.equal(g.JoyConHID.deleteSavedKey('Joy-Con (R)#0'), true);
  assert.equal(g.JoyConHID.listSavedMappings().includes('Joy-Con (R)#0'), false);

  // Delete all Joy-Con (R) mappings and verify default SELECT is restored
  g.JoyConHID.deleteCalibration('Joy-Con (R)');
  assert.equal(g.JoyConHID.hasCalibration('Joy-Con (R)'), false);
  assert.deepEqual(names(g.joyconNesState(0x10, 0, 8, 'Joy-Con (R)')), [g.NES.SELECT]);
  // Joy-Con (L) remains untouched until clear-all
  assert.equal(g.JoyConHID.hasCalibration('Joy-Con (L)'), true);
  g.JoyConHID.deleteCalibration();
  assert.deepEqual([...g.JoyConHID.listSavedMappings()], []);
});

test('Joy-Con arcade mode maps 4 face buttons, 2 shoulders, Start, and Coin without overlap', async () => {
  const handlers = [];
  const device = {
    vendorId: 0x057e, productId: 0x2007, productName: 'Joy-Con (R)', opened: false,
    open: async () => { device.opened = true; },
    addEventListener: (type, fn) => handlers.push([type, fn]),
  };
  const hid = {
    requestDevice: async () => [device],
    getDevices: async () => [],
    addEventListener() {},
  };
  const nav = { hid, getGamepads: () => [] };
  const g = load(nav);
  g.setPlatform('arcade');
  assert.equal(g.getPlatform(), 'arcade');

  // 4 distinct face buttons -> B (Action 1), A (Action 2), Y (Action 3), X (Action 4)
  assert.deepEqual(names(g.joyconNesState(0x01, 0, 8)), [g.NES.B]);
  assert.deepEqual(names(g.joyconNesState(0x02, 0, 8)), [g.NES.A]);
  assert.deepEqual(names(g.joyconNesState(0x04, 0, 8)), [g.NES.Y]);
  assert.deepEqual(names(g.joyconNesState(0x08, 0, 8)), [g.NES.X]);

  // Top SL/SR & side L/R/ZL/ZR -> L (Action 5) and R (Action 6)
  assert.deepEqual(names(g.joyconNesState(0x10, 0, 8)), [g.NES.L]);
  assert.deepEqual(names(g.joyconNesState(0x20, 0, 8)), [g.NES.R]);
  assert.deepEqual(names(g.joyconNesState(0, 0x40, 8)), [g.NES.L]);
  assert.deepEqual(names(g.joyconNesState(0, 0x80, 8)), [g.NES.R]);

  // Start (+ on R, Capture on L) and Select/Coin (- on L, Home on R, Stick Click)
  assert.deepEqual(names(g.joyconNesState(0, 0x02, 8)), [g.NES.START]);
  assert.deepEqual(names(g.joyconNesState(0, 0x20, 8)), [g.NES.START]);
  assert.deepEqual(names(g.joyconNesState(0, 0x01, 8)), [g.NES.SELECT]);
  assert.deepEqual(names(g.joyconNesState(0, 0x10, 8)), [g.NES.SELECT]);
  assert.deepEqual(names(g.joyconNesState(0, 0x04, 8)), [g.NES.SELECT]);
  assert.deepEqual(names(g.joyconNesState(0, 0x08, 8)), [g.NES.SELECT]);

  // Verify connected WebHID virtual Gamepad exposes all 6 arcade actions + Coin/Start and switches cleanly with setPlatform
  await g.JoyConHID.request();
  const report = (b1, b2, hat = 8) => handlers.find(([t]) => t === 'inputreport')[1](
    { reportId: 0x3f, data: new DataView(new Uint8Array([b1, b2, hat]).buffer) }
  );
  report(0x04 | 0x10, 0x10, 2); // Y + SL(L) + Home(Coin) + Right
  assert.deepEqual(
    names(g.readPlayers(1)[0]),
    sorted(g.NES.Y, g.NES.L, g.NES.SELECT, g.NES.RIGHT)
  );
  const vpad = nav.getGamepads()[0];
  assert.equal(vpad.buttons[2].pressed, true, 'BUTTON_3 (Y) pressed on virtual pad');
  assert.equal(vpad.buttons[4].pressed, true, 'LEFT_SHOULDER (L) pressed on virtual pad');
  assert.equal(vpad.buttons[8].pressed, true, 'SELECT (Coin) pressed on virtual pad');
  assert.equal(vpad.buttons[15].pressed, true, 'DPAD_RIGHT pressed on virtual pad');

  // Switching back to NES mode dynamically re-evaluates the held buttons under NES rules
  g.setPlatform('nes');
  assert.deepEqual(
    names(g.readPlayers(1)[0]),
    sorted(g.NES.B, g.NES.SELECT, g.NES.RIGHT),
    'in NES mode 0x04 is B and 0x10 (SL) is SELECT'
  );
});

test('arcade 12-button calibration persists independently from NES calibration for Joy-Con and standard gamepads', () => {
  const store = new Map();
  const localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  const ctx1 = { navigator: { getGamepads: () => [] }, localStorage };
  ctx1.window = ctx1;
  vm.runInNewContext(source, ctx1);
  const g1 = ctx1.GamepadInput;

  assert.deepEqual(
    Array.from(g1.ARCADE_CALIBRATION_STEPS, s => s.key),
    ['UP', 'DOWN', 'LEFT', 'RIGHT', 'B', 'A', 'Y', 'X', 'L', 'R', 'START', 'SELECT']
  );

  // Save a NES rule where b1:1 -> A
  g1.setPlatform('nes');
  g1.JoyConHID.setCalibration('Joy-Con (R)', {
    ...g1.DEFAULT_JOYCON_RULES,
    [g1.NES.A]: ['b1:1'],
    [g1.NES.B]: ['b1:2'],
  });

  // Switch to Arcade mode and save a custom 12-button Arcade rule where SL (b1:16) is Coin and SR (b1:32) is Start
  g1.setPlatform('arcade');
  assert.equal(g1.JoyConHID.hasCalibration('Joy-Con (R)'), false, 'arcade calibration starts clean');
  g1.JoyConHID.setCalibration('Joy-Con (R)', {
    ...g1.DEFAULT_JOYCON_ARCADE_RULES,
    [g1.NES.Y]: ['b1:8'],
    [g1.NES.X]: ['b1:4'],
    [g1.NES.L]: ['b2:64'],
    [g1.NES.R]: ['b2:128'],
    [g1.NES.SELECT]: ['b1:16'],
    [g1.NES.START]: ['b1:32'],
  });
  assert.equal(g1.JoyConHID.hasCalibration('Joy-Con (R)'), true);

  // Also calibrate a Standard Gamepad in Arcade mode
  const pad = {
    id: 'Pro Controller', index: 0, connected: true, axes: [0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 4 || i === 2 })),
  };
  g1.JoyConHID.setCalibration('gp:Pro Controller', {
    ...g1.DEFAULT_GAMEPAD_ARCADE_RULES,
    [g1.NES.SELECT]: ['gpbtn:4'],
    [g1.NES.L]: ['gpbtn:6'],
    [g1.NES.Y]: ['gpbtn:2'],
  }, 'gp:Pro Controller#0');
  assert.deepEqual(names(g1.padButtons(pad)), sorted(g1.NES.SELECT, g1.NES.Y));

  // Reload in a fresh VM sharing localStorage
  const ctx2 = { navigator: { getGamepads: () => [] }, localStorage };
  ctx2.window = ctx2;
  vm.runInNewContext(source, ctx2);
  const g2 = ctx2.GamepadInput;

  g2.setPlatform('arcade');
  assert.deepEqual(names(g2.joyconNesState(0x08 | 0x10, 0x40, 8, 'Joy-Con (R)')), sorted(g2.NES.Y, g2.NES.SELECT, g2.NES.L));
  g2.setPlatform('nes');
  assert.deepEqual(names(g2.joyconNesState(0x01, 0, 8, 'Joy-Con (R)')), [g2.NES.A], 'NES calibration remains intact');
});


