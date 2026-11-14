#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

stop_pid() {
  local pid_file="$1"
  local name="$2"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "已停止 $name (pid $pid)"
    fi
    rm -f "$pid_file"
  fi
}

stop_pid server.pid server.py
stop_pid netplay.pid netplay-node
pkill -f "cloudflared tunnel run" 2>/dev/null || true
echo "所有相关服务已停止。"
