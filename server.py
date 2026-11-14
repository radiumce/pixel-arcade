#!/usr/bin/env python3
"""NES / FBNeo ROM host + same-origin reverse proxy to EmulatorJS-Netplay."""
from __future__ import annotations

import json
import io
import secrets
import os
import re
import select
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROMS_DIR = ROOT / "roms"
BIOS_DIR = ROMS_DIR / "bios"
HOST = os.environ.get("SITE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SITE_PORT", "8765"))
MAX_UPLOAD = 256 * 1024 * 1024  # Large FBNeo romsets; no archive extraction on the server.
ALLOWED_EXT = {".nes", ".unf", ".fds", ".nsf", ".zip"}
SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+")
ARCADE_BIOS_NAMES = {"neogeo.zip", "pgm.zip", "bubsys.zip", "cchip.zip", "decocass.zip",
                     "isgsm.zip", "midssio.zip", "namcoc69.zip", "namcoc70.zip", "namcoc75.zip",
                     "nmk004.zip", "skns.zip", "ym2608.zip"}

# EmulatorJS-Netplay local upstream
NETPLAY_HOST = "127.0.0.1"
NETPLAY_PORT = int(os.environ.get("NETPLAY_PORT", "3000"))
NETPLAY_FALLBACK_PORT = int(os.environ.get("NETPLAY_FALLBACK_PORT", "8766"))
PROXY_PREFIXES = ("/socket.io", "/list")

_netplay_lock = threading.Lock()
_active_netplay_port = NETPLAY_PORT
_netplay_checked_at = 0.0
_netplay_proc: subprocess.Popen | None = None


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_UPSTREAM_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def _is_port_in_use(port: int) -> bool:
    try:
        with socket.create_connection((NETPLAY_HOST, port), timeout=0.5):
            return True
    except OSError:
        return False


def _is_netplay_healthy(port: int, timeout: float = 1.5) -> bool:
    try:
        req = urllib.request.Request(
            f"http://{NETPLAY_HOST}:{port}/list?domain=health&game_id=0",
            method="GET",
        )
        with _UPSTREAM_OPENER.open(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if "application/json" not in ctype:
                return False
            data = json.loads(resp.read().decode("utf-8"))
            return isinstance(data, dict)
    except Exception:
        return False


def _pick_fallback_port() -> int:
    if not _is_port_in_use(NETPLAY_FALLBACK_PORT):
        return NETPLAY_FALLBACK_PORT
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((NETPLAY_HOST, 0))
        return s.getsockname()[1]


def _spawn_netplay_upstream(target_port: int) -> bool:
    global _netplay_proc
    server_js = ROOT / "netplay-node" / "server.js"
    if not server_js.is_file():
        return False
    env = os.environ.copy()
    env["PORT"] = str(target_port)
    env.setdefault("LAN_NETPLAY", "1")
    log_path = ROOT / "netplay.log"
    try:
        log_file = open(log_path, "ab")
        proc = subprocess.Popen(
            ["node", str(server_js)],
            cwd=str(ROOT / "netplay-node"),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            close_fds=True,
        )
        _netplay_proc = proc
        try:
            (ROOT / "netplay.pid").write_text(f"{proc.pid}\n", encoding="utf-8")
        except OSError:
            pass
    except Exception as e:
        print(f"[netplay-supervise] failed to spawn node: {e}", flush=True)
        return False

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        if _is_netplay_healthy(target_port, timeout=0.5):
            print(f"[netplay-supervise] netplay-node ready on {NETPLAY_HOST}:{target_port} (pid {proc.pid})", flush=True)
            return True
        time.sleep(0.1)
    return _is_netplay_healthy(target_port, timeout=0.5)


def _is_pid_running(pid_file: Path) -> bool:
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def _ensure_netplay_upstream(force: bool = False) -> int:
    global _active_netplay_port, _netplay_checked_at
    now = time.monotonic()
    if not force and now - _netplay_checked_at < 2.0:
        return _active_netplay_port

    with _netplay_lock:
        now = time.monotonic()
        if not force and now - _netplay_checked_at < 2.0:
            return _active_netplay_port

        if _is_netplay_healthy(_active_netplay_port):
            _netplay_checked_at = time.monotonic()
            return _active_netplay_port

        if _is_pid_running(ROOT / "netplay.pid"):
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                if _is_netplay_healthy(_active_netplay_port, timeout=0.3):
                    _netplay_checked_at = time.monotonic()
                    return _active_netplay_port
                time.sleep(0.1)

        if _active_netplay_port != NETPLAY_PORT and _is_netplay_healthy(NETPLAY_PORT):
            _active_netplay_port = NETPLAY_PORT
            _netplay_checked_at = time.monotonic()
            return _active_netplay_port

        # Upstream is either down or hijacked by another service (e.g. Next.js on :3000).
        target_port = NETPLAY_PORT if not _is_port_in_use(NETPLAY_PORT) else _pick_fallback_port()
        if _spawn_netplay_upstream(target_port):
            _active_netplay_port = target_port
            _netplay_checked_at = time.monotonic()
            return _active_netplay_port

        if target_port == NETPLAY_PORT:
            fallback_port = _pick_fallback_port()
            if _spawn_netplay_upstream(fallback_port):
                _active_netplay_port = fallback_port
                _netplay_checked_at = time.monotonic()
                return _active_netplay_port

        return _active_netplay_port

# Optional TURN/STUN override via ICE_SERVERS_FILE env var or ./ice-servers.json
# Format: { "iceServers": [ {"urls":"stun:..."}, {"urls":"turn:...","username":"...","credential":"..."} ] }
def _ice_servers_file() -> Path:
    custom = os.environ.get("ICE_SERVERS_FILE", "").strip()
    return Path(custom) if custom else (ROOT / "ice-servers.json")


DEFAULT_ICE = [
    {"urls": "stun:stun.miwifi.com:3478"},
    {"urls": "stun:stun.chat.bilibili.com:3478"},
    {"urls": "stun:stun.cloudflare.com:3478"},
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]


def load_ice_servers() -> list:
    try:
        ice_file = _ice_servers_file()
        if ice_file.is_file():
            data = json.loads(ice_file.read_text(encoding="utf-8"))
            servers = data.get("iceServers") if isinstance(data, dict) else data
            if isinstance(servers, list) and servers:
                return servers
    except Exception as e:
        print(f"ice-servers.json read error: {e}", flush=True)
    return list(DEFAULT_ICE)


# Lobby rooms: P1 runs the game; guests look up its stream by code only.
LOBBY_TTL_SEC = 2 * 60 * 60
_lobby_rooms: dict[str, dict] = {}
_lobby_lock = threading.Lock()


def _make_lobby_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(64):
        code = "".join(secrets.choice(alphabet) for _ in range(5))
        if code not in _lobby_rooms:
            return code
    raise RuntimeError("lobby code space exhausted")


def _purge_lobby() -> None:
    now = time.time()
    dead = [c for c, r in _lobby_rooms.items() if now - r.get("created", 0) > LOBBY_TTL_SEC]
    for c in dead:
        _lobby_rooms.pop(c, None)


def lobby_create(mode: str = "stream") -> dict:
    mode = (mode or "").strip().lower()
    if mode != "stream":
        raise ValueError("仅支持画面串流")
    with _lobby_lock:
        _purge_lobby()
        code = _make_lobby_code()
        room = {
            "code": code,
            "page": "/online-stream.html",
            "created": time.time(),
            "hostToken": secrets.token_urlsafe(24),
            "rom": None,
            "streamSessionId": None,
            "aspect": 4 / 3,
            "gameId": 1,
        }
        _lobby_rooms[code] = room
        return dict(room)


def lobby_get(code: str) -> dict | None:
    code = (code or "").upper().strip()
    with _lobby_lock:
        _purge_lobby()
        room = _lobby_rooms.get(code)
        return {k: v for k, v in room.items() if k != "hostToken"} if room else None


def lobby_configure(code: str, body: dict) -> dict:
    with _lobby_lock:
        _purge_lobby()
        norm_code = (code or "").upper().strip()
        room = _lobby_rooms.get(norm_code)
        host_token = str(body.get("hostToken", ""))
        if (
            not room
            and body.get("reset") is True
            and re.fullmatch(r"[A-HJ-NP-Z2-9]{5}", norm_code)
            and len(host_token) >= 16
        ):
            room = {
                "code": norm_code,
                "page": "/online-stream.html",
                "created": time.time(),
                "hostToken": host_token,
                "rom": None,
                "streamSessionId": None,
                "aspect": 4 / 3,
                "gameId": 1,
            }
            _lobby_rooms[norm_code] = room
        if not room:
            raise ValueError("房间不存在或已过期")
        if not secrets.compare_digest(host_token, room["hostToken"]):
            raise PermissionError("只有 P1 可以设置房间游戏，请从大厅重新创建房间")
        if body.get("reset") is True:
            room["rom"] = None
            room["streamSessionId"] = None
        else:
            rom = body.get("rom") or {}
            if not isinstance(rom, dict):
                raise ValueError("ROM 设置必须为对象")
            url = str(rom.get("url", ""))
            parsed = urllib.parse.urlparse(url)
            path = (ROOT / urllib.parse.unquote(parsed.path).lstrip("/")).resolve()
            if (parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or
                not parsed.path.startswith("/roms/") or path.parent != ROMS_DIR.resolve() or
                path.suffix.lower() not in ALLOWED_EXT or not path.is_file()):
                raise ValueError("请选择本站已保存的 ROM")
            session_id = str(body.get("streamSessionId") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session_id):
                raise ValueError("串流房间尚未就绪")
            aspect = float(body.get("aspect", 4 / 3))
            if not 0.5 <= aspect <= 3:
                raise ValueError("画面比例无效")
            game_id = int(body.get("gameId", 1))
            if not 1 <= game_id <= 2147483646:
                raise ValueError("游戏标识无效")
            room["rom"] = {"url": url, "name": str(rom.get("name") or path.name)[:180],
                           "platform": "arcade" if path.suffix.lower() == ".zip" else "nes"}
            room["streamSessionId"] = session_id or None
            room["aspect"] = aspect
            room["gameId"] = game_id
        return {k: v for k, v in room.items() if k != "hostToken"}


def safe_filename(name: str) -> str:
    name = os.path.basename(name or "upload.nes")
    name = SAFE_NAME.sub("_", name).strip("._") or "upload.nes"
    root, ext = os.path.splitext(name)
    if ext.lower() not in ALLOWED_EXT:
        name = root + ".nes"
    return name[:180]


def validate_rom(filename: str, data: bytes) -> None:
    if len(data) < 16:
        raise ValueError("文件太小，不像 ROM")
    if filename.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if not any(not item.is_dir() for item in archive.infolist()):
                    raise ValueError("ZIP 中没有游戏文件")
                bad_file = archive.testzip()
                if bad_file:
                    raise ValueError(f"ZIP 文件损坏：{bad_file}")
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as error:
            raise ValueError("需要未加密且有效的 FBNeo romset ZIP") from error


def list_roms() -> list[dict]:
    ROMS_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for p in sorted(ROMS_DIR.iterdir(), key=lambda x: x.name.lower()):
        if not p.is_file():
            continue
        if p.suffix.lower() not in ALLOWED_EXT:
            continue
        if p.name.startswith("."):
            continue
        items.append(
            {
                "name": p.name,
                "url": "/roms/" + urllib.parse.quote(p.name),
                "size": p.stat().st_size,
            }
        )
    return items


def delete_rom(name: str) -> dict:
    if not name or not isinstance(name, str):
        raise ValueError("缺少文件名")
    name = urllib.parse.unquote(name.strip())
    if name.startswith("/roms/"):
        name = name[len("/roms/"):]
    base = os.path.basename(name)
    if not base or base.startswith(".") or "/" in name or "\\" in name:
        raise ValueError("非法文件名")
    root, ext = os.path.splitext(base)
    if ext.lower() not in ALLOWED_EXT:
        raise ValueError("不支持或不允许删除该类型文件")

    target = (ROMS_DIR / base).resolve()
    if target.parent != ROMS_DIR.resolve():
        raise ValueError("非法文件路径")
    if not target.is_file():
        raise FileNotFoundError(f"ROM 文件 {base} 不存在")

    with _lobby_lock:
        for room in _lobby_rooms.values():
            rom_info = room.get("rom")
            if rom_info and isinstance(rom_info, dict):
                r_name = rom_info.get("name")
                r_url = rom_info.get("url", "")
                if r_name == base or r_url.endswith("/" + urllib.parse.quote(base)):
                    room["rom"] = None
                    room["streamSessionId"] = None

    target.unlink()
    return {"ok": True, "name": base, "message": "ROM 已删除"}


def delete_bios(name: str) -> dict:
    name = safe_filename(name).lower()
    if name not in ARCADE_BIOS_NAMES:
        raise ValueError("只能删除支持的 FBNeo BIOS 文件")
    path = BIOS_DIR / name
    if not path.is_file():
        raise FileNotFoundError("BIOS 不存在")
    path.unlink()
    return {"ok": True, "name": name}


def rename_rom(old_name: str, new_name: str) -> dict:
    if not old_name or not isinstance(old_name, str):
        raise ValueError("缺少原文件名")
    if not new_name or not isinstance(new_name, str):
        raise ValueError("缺少新文件名")
    old_name = urllib.parse.unquote(old_name.strip())
    if old_name.startswith("/roms/"):
        old_name = old_name[len("/roms/"):]
    old_base = os.path.basename(old_name)
    if not old_base or old_base.startswith(".") or "/" in old_name or "\\" in old_name:
        raise ValueError("非法原文件名")
    _, old_ext = os.path.splitext(old_base)
    if old_ext.lower() not in ALLOWED_EXT:
        raise ValueError("不支持重命名该类型文件")
    if old_ext.lower() == ".zip":
        raise ValueError("FBNeo 通过文件名识别游戏，不能重命名街机 romset")

    src = (ROMS_DIR / old_base).resolve()
    if src.parent != ROMS_DIR.resolve():
        raise ValueError("非法文件路径")
    if not src.is_file():
        raise FileNotFoundError(f"ROM 文件 {old_base} 不存在")

    raw_new = new_name.strip()
    if not raw_new or "/" in raw_new or "\\" in raw_new or raw_new.startswith("."):
        raise ValueError("非法新文件名")
    new_root, new_ext = os.path.splitext(raw_new)
    if new_ext.lower() not in ALLOWED_EXT:
        new_root = raw_new
    clean_root = SAFE_NAME.sub("_", new_root).strip("._")
    if not clean_root:
        raise ValueError("新文件名无效")
    new_base = (clean_root[:170] + old_ext)[:180]

    dst = (ROMS_DIR / new_base).resolve()
    if dst.parent != ROMS_DIR.resolve():
        raise ValueError("非法目标路径")
    if new_base != old_base:
        if dst.exists():
            raise ValueError(f"同名文件 {new_base} 已存在")
        src.rename(dst)

    new_url = "/roms/" + urllib.parse.quote(new_base)
    with _lobby_lock:
        for room in _lobby_rooms.values():
            rom_info = room.get("rom")
            if rom_info and isinstance(rom_info, dict):
                r_name = rom_info.get("name")
                r_url = rom_info.get("url", "")
                if r_name == old_base or r_url.endswith("/" + urllib.parse.quote(old_base)):
                    room["rom"] = {"url": new_url, "name": new_base, "platform": "nes"}

    return {
        "ok": True,
        "oldName": old_base,
        "name": new_base,
        "url": new_url,
        "size": dst.stat().st_size,
        "message": "ROM 已重命名",
    }


def parse_multipart(body: bytes, content_type: str) -> dict[str, tuple[str | None, bytes]]:
    """Minimal multipart/form-data parser. Returns field -> (filename, data)."""
    m = re.search(r"boundary=([^;]+)", content_type, flags=re.I)
    if not m:
        raise ValueError("missing boundary")
    boundary = m.group(1).strip().strip('"').encode("ascii", "ignore")
    if not boundary:
        raise ValueError("empty boundary")
    delimiter = b"--" + boundary
    parts = body.split(delimiter)
    out: dict[str, tuple[str | None, bytes]] = {}
    for part in parts:
        if not part or part in (b"--", b"--\r\n", b"--\n"):
            continue
        if part.startswith(b"--"):
            continue
        if part.startswith(b"\r\n"):
            part = part[2:]
        elif part.startswith(b"\n"):
            part = part[1:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        elif part.endswith(b"\n"):
            part = part[:-1]
        header_blob, sep, data = part.partition(b"\r\n\r\n")
        if not sep:
            header_blob, sep, data = part.partition(b"\n\n")
        if not sep:
            continue
        headers = header_blob.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]+)"', headers, flags=re.I)
        if not name_m:
            continue
        name = name_m.group(1)
        fn_m = re.search(r'filename="([^"]*)"', headers, flags=re.I)
        filename = fn_m.group(1) if fn_m else None
        out[name] = (filename, data)
    return out


def _should_proxy(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") or path.startswith(p + "?") for p in PROXY_PREFIXES)


STATIC_ROOT_FILES = {
    "/",
    "/index.html",
    "/local.html",
    "/online.html",
    "/online-stream.html",
    "/gamepad-test.html",
}
STATIC_DIRS = ("css", "js", "vendor", "roms")


def _is_allowed_static_path(raw_path: str) -> bool:
    unquoted = urllib.parse.unquote(raw_path or "")
    if not unquoted.startswith("/") or "\\" in unquoted or "\x00" in unquoted:
        return False
    if unquoted in STATIC_ROOT_FILES:
        return True
    parts = [seg for seg in unquoted.split("/") if seg]
    if len(parts) < 2 or parts[0] not in STATIC_DIRS:
        return False
    if any(seg in (".", "..") or seg.startswith(".") for seg in parts):
        return False
    resolved = (ROOT / "/".join(parts)).resolve()
    allowed_dir = (ROOT / parts[0]).resolve()
    if not resolved.is_relative_to(allowed_dir) or not resolved.is_file():
        return False
    if parts[0] == "roms" and resolved.suffix.lower() not in ALLOWED_EXT:
        return False
    return True


def _tunnel(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 60)
            if not r:
                break
            for src in r:
                dst = b if src is a else a
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/roms":
            self._json(200, {"roms": list_roms()})
            return
        if parsed.path == "/api/bios":
            items = [{"name": name, "url": "/roms/bios/" + name}
                     for name in sorted(ARCADE_BIOS_NAMES) if (BIOS_DIR / name).is_file()]
            self._json(200, {"bios": items})
            return
        if parsed.path.startswith("/api/lobby/"):
            code = parsed.path[len("/api/lobby/"):].strip("/")
            if not code or "/" in code:
                self._json(400, {"ok": False, "error": "无效房间码"})
                return
            room = lobby_get(code)
            if not room:
                self._json(404, {"ok": False, "error": "房间不存在或已过期"})
                return
            self._json(200, {"ok": True, "room": room})
            return
        if parsed.path == "/api/ice":
            servers = load_ice_servers()
            has_turn = any("turn:" in str(s.get("urls", s.get("url", ""))) for s in servers if isinstance(s, dict))
            self._json(200, {"iceServers": servers, "hasTurn": has_turn})
            return
        if parsed.path == "/api/netplay-health":
            port = _ensure_netplay_upstream()
            ok = _is_netplay_healthy(port)
            detail = "ok" if ok else "netplay upstream unavailable"
            self._json(200 if ok else 503, {"ok": ok, "upstream": f"{NETPLAY_HOST}:{port}", "detail": detail})
            return
        if _should_proxy(parsed.path):
            self._proxy()
            return
        if not _is_allowed_static_path(parsed.path):
            self.send_error(404)
            return
        return super().do_GET()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if (
            parsed.path in ("/api/roms", "/api/bios", "/api/roms/delete", "/api/roms/rename", "/api/ice", "/api/netplay-health")
            or parsed.path.startswith("/api/roms/")
            or parsed.path.startswith("/api/lobby/")
            or _should_proxy(parsed.path)
        ):
            # Avoid treating API/proxy paths as static files
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not _is_allowed_static_path(parsed.path):
            self.send_error(404)
            return
        return super().do_HEAD()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if _should_proxy(parsed.path):
            self._proxy()
            return
        if parsed.path == "/api/roms/delete":
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self._json(400, {"ok": False, "error": "JSON 无效"})
                return
            name = body.get("name", "") if isinstance(body, dict) else ""
            self._handle_delete_rom(name)
            return
        if parsed.path == "/api/roms/rename":
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self._json(400, {"ok": False, "error": "JSON 无效"})
                return
            old_name = body.get("oldName", "") if isinstance(body, dict) else ""
            new_name = body.get("newName", "") if isinstance(body, dict) else ""
            self._handle_rename_rom(old_name, new_name)
            return
        if parsed.path == "/api/bios/delete":
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
                res = delete_bios(body.get("name", "") if isinstance(body, dict) else "")
                self._json(200, res)
            except (json.JSONDecodeError, ValueError) as e:
                self._json(400, {"ok": False, "error": str(e) or "JSON 无效"})
            except FileNotFoundError as e:
                self._json(404, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/lobby/create":
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self._json(400, {"ok": False, "error": "JSON 无效"})
                return
            try:
                room = lobby_create(
                    (body or {}).get("mode", "stream"),
                )
            except ValueError as e:
                self._json(400, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
                return
            self._json(200, {"ok": True, "room": room})
            return
        if parsed.path.startswith("/api/lobby/"):
            code = parsed.path[len("/api/lobby/"):].strip("/")
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
                if not 0 < length <= 8192:
                    raise ValueError("房间设置大小无效")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("JSON 必须为对象")
                room = lobby_configure(code, body)
            except PermissionError as e:
                self._json(403, {"ok": False, "error": str(e)})
                return
            except (ValueError, TypeError) as e:
                self._json(400, {"ok": False, "error": str(e)})
                return
            self._json(200, {"ok": True, "room": room})
            return
        if parsed.path not in ("/api/upload", "/api/bios/upload"):
            self.send_error(404, "Not Found")
            return

        ctype = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            self._json(400, {"ok": False, "error": f"文件大小无效（上限 {MAX_UPLOAD} 字节）"})
            return
        if "multipart/form-data" not in ctype.lower():
            self._json(400, {"ok": False, "error": "需要 multipart/form-data"})
            return

        body = self.rfile.read(length)
        try:
            fields = parse_multipart(body, ctype)
        except Exception as e:
            self._json(400, {"ok": False, "error": f"解析上传失败: {e}"})
            return

        if "file" not in fields or not fields["file"][0]:
            self._json(400, {"ok": False, "error": "缺少 file 字段"})
            return

        orig_name, data = fields["file"]
        is_bios = parsed.path == "/api/bios/upload"
        filename = safe_filename(orig_name)
        if not is_bios and filename.lower() in ARCADE_BIOS_NAMES:
            self._json(400, {"ok": False, "error": "这是系统 BIOS，请使用「上传 BIOS ZIP」"})
            return
        if is_bios:
            filename = filename.lower()
            if filename not in ARCADE_BIOS_NAMES:
                self._json(400, {"ok": False, "error": "BIOS 文件名必须是 FBNeo 要求的名称，例如 neogeo.zip 或 pgm.zip"})
                return
        if len(data) > MAX_UPLOAD:
            self._json(400, {"ok": False, "error": "文件过大"})
            return
        try:
            validate_rom(filename, data)
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return

        warn = None
        if filename.lower().endswith(".nes") and data[:4] not in (b"NES\x1a", b"FDS\x1a"):
            warn = "未检测到标准 iNES 头，仍已保存"

        dest_dir = BIOS_DIR if is_bios else ROMS_DIR
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename
        if dest.exists():
            if is_bios or dest.suffix.lower() == ".zip":
                self._json(409, {"ok": False, "error": "同名文件已存在；街机 ZIP 必须保留原文件名"})
                return
            stem, ext = os.path.splitext(filename)
            n = 2
            while True:
                candidate = ROMS_DIR / f"{stem}_{n}{ext}"
                if not candidate.exists():
                    dest = candidate
                    filename = candidate.name
                    break
                n += 1

        dest.write_bytes(data)
        payload = {
            "ok": True,
            "name": filename,
            "url": "/roms/" + urllib.parse.quote(filename),
            "size": len(data),
        }
        if warn:
            payload["warning"] = warn
        if is_bios:
            payload["url"] = "/roms/bios/" + urllib.parse.quote(filename)
        self._json(200, payload)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/roms" or parsed.path.startswith("/api/roms/"):
            name = ""
            if parsed.path.startswith("/api/roms/"):
                name = parsed.path[len("/api/roms/"):].strip("/")
            if not name:
                query = urllib.parse.parse_qs(parsed.query)
                name = query.get("name", [""])[0]
            if not name:
                length = int(self.headers.get("Content-Length", "0") or 0)
                if 0 < length <= 4096:
                    try:
                        body = json.loads(self.rfile.read(length).decode("utf-8"))
                        if isinstance(body, dict):
                            name = body.get("name", "")
                    except Exception:
                        pass
            self._handle_delete_rom(name)
            return
        if _should_proxy(parsed.path):
            self._proxy()
            return
        self.send_error(405, "Method Not Allowed")

    def _handle_delete_rom(self, name: str):
        if not name:
            self._json(400, {"ok": False, "error": "缺少 ROM 名称"})
            return
        try:
            res = delete_rom(name)
            self._json(200, res)
        except FileNotFoundError as e:
            self._json(404, {"ok": False, "error": str(e)})
        except ValueError as e:
            self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            self._json(500, {"ok": False, "error": f"删除失败: {e}"})

    def _handle_rename_rom(self, old_name: str, new_name: str):
        if not old_name or not new_name:
            self._json(400, {"ok": False, "error": "缺少原名称或新名称"})
            return
        try:
            res = rename_rom(old_name, new_name)
            self._json(200, res)
        except FileNotFoundError as e:
            self._json(404, {"ok": False, "error": str(e)})
        except ValueError as e:
            self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            self._json(500, {"ok": False, "error": f"重命名失败: {e}"})

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        if _should_proxy(parsed.path):
            self._proxy()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_PUT(self):
        if _should_proxy(urllib.parse.urlparse(self.path).path):
            self._proxy()
            return
        self.send_error(405, "Method Not Allowed")

    def _proxy(self):
        """Reverse-proxy HTTP + WebSocket Upgrade to netplay upstream."""
        upgrade = (self.headers.get("Upgrade") or "").lower()
        connection = (self.headers.get("Connection") or "").lower()
        has_ws_key = bool(self.headers.get("Sec-WebSocket-Key"))
        is_ws = upgrade == "websocket" or has_ws_key or ("upgrade" in connection and "websocket" in upgrade)

        if is_ws:
            self._proxy_websocket()
            return
        self._proxy_http()

    def _build_upstream_request(self, port: int, body: bytes | None) -> urllib.request.Request:
        url = f"http://{NETPLAY_HOST}:{port}{self.path}"
        req = urllib.request.Request(url, data=body, method=self.command)
        hop_by_hop = {
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length", "x-arcade-client-ip",
        }
        for k, v in self.headers.items():
            if k.lower() in hop_by_hop:
                continue
            req.add_header(k, v)
        req.add_header("Host", f"{NETPLAY_HOST}:{port}")
        req.add_header("X-Arcade-Client-IP", self.client_address[0])
        return req

    def _proxy_http(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length > 0 else None
        port = _ensure_netplay_upstream()

        for attempt in range(2):
            req = self._build_upstream_request(port, body)
            try:
                with _UPSTREAM_OPENER.open(req, timeout=30) as resp:
                    ctype = (resp.headers.get("Content-Type") or "").lower()
                    data = resp.read()
                    if (
                        attempt == 0
                        and self.path.startswith("/socket.io")
                        and "text/html" in ctype
                        and not (self.command == "POST" and data == b"ok")
                    ):
                        new_port = _ensure_netplay_upstream(force=True)
                        if new_port != port:
                            port = new_port
                            continue
                    self.send_response(resp.status)
                    for k, v in resp.headers.items():
                        if k.lower() in ("transfer-encoding", "connection", "content-encoding", "link"):
                            continue
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            except urllib.error.HTTPError as e:
                data = e.read()
                ctype = (e.headers.get("Content-Type") or "").lower()
                if attempt == 0 and (
                    e.code in (301, 302, 303, 307, 308)
                    or (self.path.startswith("/socket.io") and "text/html" in ctype)
                ):
                    new_port = _ensure_netplay_upstream(force=True)
                    if new_port != port:
                        port = new_port
                        continue
                self.send_response(e.code)
                self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                if attempt == 0:
                    port = _ensure_netplay_upstream(force=True)
                    continue
                msg = f"netplay upstream unavailable: {e}".encode()
                self.send_response(502)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return

    def _proxy_websocket(self):
        try:
            print(f"[ws-upgrade] {self.path}", flush=True)
        except OSError:
            pass
        port = _ensure_netplay_upstream()
        try:
            upstream = socket.create_connection((NETPLAY_HOST, port), timeout=10)
        except OSError:
            port = _ensure_netplay_upstream(force=True)
            try:
                upstream = socket.create_connection((NETPLAY_HOST, port), timeout=10)
            except OSError as e:
                self.send_error(502, f"netplay upstream: {e}")
                return

        # Rebuild request line + headers for upstream
        lines = [f"{self.command} {self.path} HTTP/1.1"]
        # Prefer Host of upstream
        seen_host = False
        for k, v in self.headers.items():
            if k.lower() == "x-arcade-client-ip":
                continue
            if k.lower() == "host":
                lines.append(f"Host: {NETPLAY_HOST}:{port}")
                seen_host = True
            else:
                lines.append(f"{k}: {v}")
        if not seen_host:
            lines.append(f"Host: {NETPLAY_HOST}:{port}")
        lines.append(f"X-Arcade-Client-IP: {self.client_address[0]}")
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace")
        upstream.sendall(raw)

        # Read upstream handshake response
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = upstream.recv(4096)
            if not chunk:
                upstream.close()
                self.send_error(502, "netplay closed during upgrade")
                return
            buf += chunk
            if len(buf) > 65536:
                upstream.close()
                self.send_error(502, "netplay handshake too large")
                return

        header_blob, _, rest = buf.partition(b"\r\n\r\n")
        # Write handshake back to client
        self.connection.sendall(header_blob + b"\r\n\r\n")
        if rest:
            self.connection.sendall(rest)

        # Bidirectional tunnel; hand off sockets so BaseHTTPRequestHandler won't close early issues
        client = self.connection
        self.close_connection = True
        t = threading.Thread(target=_tunnel, args=(client, upstream), daemon=True)
        t.start()
        # Keep request handler alive until tunnel ends
        t.join()

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        try:
            print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)
        except OSError:
            pass


def main():
    ROMS_DIR.mkdir(parents=True, exist_ok=True)
    port = _ensure_netplay_upstream()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"Serving {ROOT} on http://{HOST}:{PORT} "
        f"(proxy /socket.io /list -> {NETPLAY_HOST}:{port})",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
