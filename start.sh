#!/usr/bin/env bash
# 启动站点 (server.py :8765) + 联机信令 (netplay-node :3000)，可选启动 Cloudflare Tunnel。
# Tunnel token 不入库：通过环境变量 CF_TUNNEL_TOKEN 或文件 CF_TUNNEL_TOKEN_FILE 提供
# （默认 .secrets/cf-tunnel-token）。设置 NO_TUNNEL=1 可跳过隧道。
set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE="${CF_TUNNEL_TOKEN_FILE:-.secrets/cf-tunnel-token}"

running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

if [ ! -d netplay-node/node_modules ]; then
  (cd netplay-node && npm install --omit=dev)
fi

export SITE_HOST="${SITE_HOST:-0.0.0.0}"
export LAN_NETPLAY="${LAN_NETPLAY:-1}"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

LAN_IP="$({ ipconfig getifaddr en0 || ipconfig getifaddr en1 || hostname -I | awk '{print $1}' || ifconfig | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}'; } 2>/dev/null || true)"

if running netplay.pid; then
  echo "netplay-node 已在运行 (pid $(cat netplay.pid))"
else
  nohup node netplay-node/server.js >> netplay.log 2>&1 &
  echo $! > netplay.pid
  echo "netplay-node 已启动 -> http://127.0.0.1:3000 (pid $!)"
fi

if running server.pid; then
  echo "server.py 已在运行 (pid $(cat server.pid))"
else
  nohup python3 server.py >> server.log 2>&1 &
  echo $! > server.pid
  echo "server.py 已启动 -> http://127.0.0.1:8765 (pid $!)"
  if [ -n "$LAN_IP" ]; then
    echo "局域网访问地址 -> http://${LAN_IP}:8765"
  fi
fi

if [ "${NO_TUNNEL:-0}" = "1" ]; then
  echo "跳过 Cloudflare Tunnel (NO_TUNNEL=1)"; exit 0
fi

if pgrep -f "cloudflared tunnel run" >/dev/null; then
  echo "cloudflared 已在运行"; exit 0
fi

TOKEN="${CF_TUNNEL_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi
if [ -z "$TOKEN" ]; then
  echo "未找到 tunnel token（CF_TUNNEL_TOKEN 或 ${TOKEN_FILE}），仅本地运行。"; exit 0
fi

# 通过环境变量传 token，避免出现在命令行参数里
TUNNEL_TOKEN="$TOKEN" nohup cloudflared tunnel run >> tunnel.log 2>&1 &
echo "cloudflared 已启动 (pid $!)"
