# NES streaming regressions

The host runs EmulatorJS/Nestopia. P2 is an independent WebRTC receiver and never downloads a ROM, EmulatorJS loader, or emulator core. Browser tests use an original generated NROM.

## Run

Start the site and signaling service first. Python 3.10+, Node 18+, and access to the EmulatorJS CDN are needed for host browser tests.

```bash
cd e2e
npm install
npm run test:unit
BASE_URL=http://127.0.0.1:8765 CHROME_CHANNEL=chrome npm test
```

| Command | Coverage |
|---------|----------|
| `npm run test:lobby` | Create/join by code, P2 waits for P1, no mode selector, retired endpoints unavailable |
| `npm run test:unit` | Lossless frame codec, host input cleanup, standalone P2 signaling/input/renegotiation/media lifecycle |
| `npm run test:stream` | Unit codec/input tests, WebGL capture, real WebRTC host/guest, lossless fidelity, resize, live P2 replacement, VP8 fallback, refresh rejoin, real audio playback, mute/volume/fullscreen/touch controls, and absence of guest ROM/core downloads |
| `npm run test:stream-hidden-host` | Minimize a real Chrome host window and verify uninterrupted frames and P2 input |
| `npm test` | Lobby and complete streaming regression |

`BASE_URL` defaults to `http://127.0.0.1:8765`. `CHROME_CHANNEL=chrome` uses system Chrome; omit it to use Playwright Chromium. `SIGNALING_URL` overrides the signaling URL in the streaming probe. `CHROME_PATH` overrides Chrome's binary for the hidden-host probe.

Screenshots and results go to `artifacts/` and are ignored by Git. Frame fidelity, per-frame presentation, input routing, replacement key release, single-host-peer cleanup, and continued P1 progress are asserted. An original ROM pulse tone is checked in the received audio waveform. Guest network requests are checked through initial joins, replacement, and fallback reloads.

Signaling regressions: `cd ../netplay-node && npm test`. Lobby metadata/ROM ownership: `python3 -m unittest discover -s ../tests`.

Manual check: P1 creates a room and selects a saved/uploaded game; P2 joins using the code, sees streamed frames, enables audio with “播放画面和声音”, and uses arrows/K/J/Enter/Shift or a gamepad. A new P2 takes the existing visitor slot while P1 continues the game.
