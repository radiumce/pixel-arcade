# Netplay tunnel notes

## Architecture

- Site: `https://game.example.com/` → tunnel → `http://127.0.0.1:8765` (`server.py`)
- Netplay signaling: `https://netplay.example.com/` (or same-origin `/socket.io` proxy) → tunnel → `http://127.0.0.1:3000` (Node `EmulatorJS-Netplay`)
- Client defaults to same-origin (`location.origin`); set `window.EJS_NETPLAY_SERVER_OVERRIDE = 'https://netplay.example.com/'` if exposing signaling on a separate hostname
- ICE via `GET /api/ice` (defaults to China-reachable STUN; optional TURN file below)

## Why dedicated netplay hostname (optional)

Socket.IO needs reliable WebSocket upgrades. If your reverse proxy handles WebSocket cleanly, same-origin works out of the box; otherwise pointing a separate tunnel hostname directly to Node is simpler.

## Optional TURN (for strict NAT / mobile)

Create `./ice-servers.json` (or set `ICE_SERVERS_FILE`):

```json
{
  "iceServers": [
    { "urls": "stun:stun.miwifi.com:3478" },
    {
      "urls": [
        "turn:global.relay.metered.ca:80",
        "turn:global.relay.metered.ca:443"
      ],
      "username": "YOUR_METERED_USER",
      "credential": "YOUR_METERED_PASS"
    }
  ]
}
```

Or enable Cloudflare Realtime TURN (dashboard → Realtime → TURN) and put generated iceServers there. Restart not required for `/api/ice` (read on each cold cache; restart `server.py` or wait for process recycle if you change file while server caches — currently no server-side cache).

## Processes

- `python3 server.py` on `127.0.0.1:8765` (pid in `server.pid`)
- `node server.js` in `netplay-node/` on `127.0.0.1:3000` (pid in `netplay.pid`)
- `cloudflared tunnel run` with token in `.secrets/cf-tunnel-token` (or env `CF_TUNNEL_TOKEN`)
