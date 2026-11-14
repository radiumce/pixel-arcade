# Pixel Arcade（网页红白机与街机）

在浏览器里玩 NES / 红白机及 FinalBurn Neo 街机游戏：支持**本地同机双人**，以及两台电脑**联机房间**（画面串流）。

> **说明**：本项目仅作为个人技术实践分享供大家学习与参考，**非正式维护的开源项目**（不承诺长期更新或处理 Issue / PR）。

## 页面

| 页面 | 说明 |
|------|------|
| `index.html` | 首页，两个入口：本地同机双人 / 联机房间 |
| `local.html` | **本地同机双人**：EmulatorJS（NES 用 Nestopia，街机用 FBNeo），两人共用一台键盘或手柄 |
| `online.html` | **联机房间大厅**：P1 创建房间，P2 输入房间码加入 |
| `online-stream.html` | **画面串流**：P1 运行模拟器，经 WebRTC 推画面与音频；P2 独立接收串流并回传按键，无需 ROM 或模拟器 |

## 架构

```
浏览器 ──https──> game.example.com      ──Cloudflare Tunnel──> 127.0.0.1:8765  server.py
                                                              （静态页面、ROM 上传/列表、房间大厅 API、/api/ice）
浏览器 ──wss───> netplay.example.com   ──Cloudflare Tunnel──> 127.0.0.1:3000  netplay-node/server.js
                                                              （Socket.IO：串流房间与 WebRTC 信令，可选独立域名）
```

- `server.py`：Python 标准库实现，无依赖。提供站点、`/api/upload` 上传、`/api/roms` 列表与删除（存到 `roms/`，支持 `/api/roms/delete` 及 `DELETE /api/roms`）、大厅 `/api/lobby/*`、ICE 配置 `/api/ice`。
- `netplay-node/`：Node（express + socket.io）。EmulatorJS 联机信令改编自 EmulatorJS-Netplay（Apache-2.0，见 `netplay-node/NOTICE.md`）。
- `js/emulator-common.js`：EmulatorJS 公共加载逻辑（EmulatorJS 从 `cdn.emulatorjs.org` 加载，不在仓库内）。
- `js/lobby-session.js`：关联大厅房间、P1 的 ROM 和串流会话，自动建房／加入并处理等待与重试。
- `js/stream-guest.js`：P2 的独立 WebRTC 接收端，支持无损像素、VP8 回退、音频、键盘与手柄。
- `vendor/`：socket.io 客户端（见 `vendor/README.md`）。
- 详细联机/隧道说明见 `NETPLAY_TUNNEL.md`。

## 本地运行

依赖：Python 3.10+、Node 18+；公网访问需 `cloudflared`。

```bash
./start.sh                 # 启动 server.py(:8765) + netplay-node(:3000)，有 token 时再启动 Cloudflare Tunnel
NO_TUNNEL=1 ./start.sh     # 只在本地运行
```

或手动：

```bash
python3 server.py
cd netplay-node && npm install && node server.js
```

浏览器打开 <http://127.0.0.1:8765/>。HTTP 与 HTTPS 页面均默认通过同源代理连接联机信令；
如需指定独立信令域名，可设置 `window.EJS_NETPLAY_SERVER_OVERRIDE`（例如 `https://netplay.example.com`）。

同一局域网内两台设备测试时，在主机上运行 `SITE_HOST=0.0.0.0 LAN_NETPLAY=1 NO_TUNNEL=1 ./start.sh`，
然后在两台设备的浏览器中打开 `http://<主机局域网 IP>:8765/`。两台设备需使用相同的站点地址，会直接通过站点的同源代理连接信令服务。

联机流程：P1 在大厅创建房间，选择已保存或上传的游戏后自动建房；P2 只需在大厅输入房间码加入。
P2 直接接收 P1 的画面与音频，不下载 ROM、不加载 EmulatorJS 或模拟器核心。
玩家名固定为 P1、P2。P2 提前加入时会等待 P1 选好游戏。
同一房间始终由最新加入的 P2 接管访客席位，旧 P2 会断开并收到替换提示；P1 的连接和房主身份保留。
P2 替换或刷新重连时，P1 的游戏继续运行并保留进度。
游戏开始后切换 ROM 请返回大厅创建新房间。

串流画面默认走**无损像素直传**（`js/stream-pixels.js`）：
主机按核心实际输出尺寸（通常 256×224）从画布中游戏视口的精确位置取帧，像素中心采样，不含黑边，主机窗口尺寸不影响结果。
每帧编码为调色板 + 索引，按 8×8 块与 P2 已确认的参考帧比较，经 deflate 压缩后通过无序、50 ms 过期的 DataChannel（`nes-frame-v1`）发送；
块命令支持原位置复制、±32 像素内的精确运动复制、参考帧同步字典复用和原始像素；横版卷轴及移动精灵不必退化为整帧重传。
字典仅由已确认的参考帧确定性重建，所有复制都经过逐字节校验，不引入有损匹配。
P2 回传确认，丢包时自动改用更早的已确认帧或关键帧修复。典型码率约 0.2–2 Mbps，链路积压时跳帧而不排队。
P2 每次屏幕刷新最多显示一帧，先整数倍最近邻放大再平滑适配窗口（sharp-bilinear），字母和精灵不会出现宽窄不一或缺行。
无损传输期间主机将 VP8 降为 5 FPS 低码率热备，一旦差量链路受阻可立即回退。主机若启用着色器/滤镜导致颜色超过 255 种，会按最近颜色近似。

P2 浏览器不支持 `DecompressionStream`、或一方仍是旧版本时，自动回退到 VP8 视频：
主机以 2 倍最近邻（512×448）采集，单层时域（L1T1）、60 FPS 目标、6 Mbps 上限（中继 2.5 Mbps），P2 再按 2×2 均值还原。
回退为有损编码，细节仍可能轻微模糊。双方应刷新至同一版本。
P2 按键通过无序、不重传的 WebRTC DataChannel 立即发送完整状态，并每 50 ms 补发；
主机丢弃旧序号，后续状态修复丢包，连续 500 ms 收不到状态时释放按键。
双方应刷新至同一版本；快速通道尚未建立或浏览器不支持时沿用原可靠输入通道。切出 P2 窗口会释放按键。

接收端对音视频请求最低抖动缓冲，优先在新视频帧到达时绘制，避免重复拷贝；不支持相关 API 的浏览器自动回退。
这是低延迟偏好，不保证缓冲为零；Wi-Fi 干扰严重时仍可能短暂停顿。
状态栏显示实际 FPS、WebRTC 网络 RTT 和最近采样区间的视频缓冲均值；**RTT 不是按键到画面的总延迟**。
`window.__streamDebug.getState()` 还包含编解码耗时、丢帧、冻结次数和输入通道类型；
`pixel` 字段给出无损通道的帧尺寸、取帧方式、编解码耗时、码率与显示丢帧。状态栏会标明「无损像素直传」或「视频回退」。
诊断不再每秒回读整个画布，减少渲染线程开销。

连接成功但帧数为 0 时还没有实际视频；画面不显示时可点击「恢复画面播放」。
主机同时兼容 Nestopia 的 RWebAudio 和旧版 OpenAL 音频捕获。
P2 点击「播放画面和声音」或按游戏键可解除浏览器对音频自动播放的限制；提供音量、静音、全屏和触屏按键。
需要排查跨电脑故障时，用 `STREAM_DIAGNOSTICS=1` 启动 `netplay-node/server.js`，
`netplay.log` 中的 `[stream-diag]` 会记录帧数、延迟指标及选中的网络路径。
主机窗口被遮挡、最小化或切到其他标签页时，浏览器会停止 `requestAnimationFrame`，EmulatorJS 的 RetroArch
也会在页面隐藏时跳过运行；串流主机因此改由后台 Worker 按 60 Hz 驱动模拟器并屏蔽“隐藏”事件，
P2 在同一台电脑上全屏也不会让主机暂停（主机页面恢复可见后回到原生刷新节奏）。
两端优先连接信号良好的同一 5 GHz / 6 GHz 接入点；条件允许时给 P1 使用网线，可以减少一次无线传输的争用。

串流回归：`cd e2e && npm run test:unit` 检查乱序、丢包补偿、卡键保护、兼容回退与独立访客逻辑；
`CHROME_CHANNEL=chrome npm run test:stream` 使用本机 Chrome 运行真实双端 WebRTC 测试，
默认访问 `http://127.0.0.1:8765`，要求站点、信令服务和 EmulatorJS CDN 可访问；串流测试自动生成最小 NROM，无需下载游戏。
`npm run test:stream-hidden-host` 会打开并最小化一个本机 Chrome 窗口作为主机，检查主机真正隐藏时仍以 60 FPS 推流并接收 P2 按键。
测试输出保存至 `e2e/artifacts/stream-latency.json`。单机结果不能替代两台设备的 Wi-Fi 实测。

`LAN_NETPLAY=1` 会在 Chrome 的 `.local` 主机候选地址之外补充服务器实际观察到的客户端 IPv4，
用于有线与无线客户端之间无法解析 mDNS 的局域网；该补充只发送给同一模拟器房间内的另一位玩家。

### Cloudflare Tunnel

Tunnel token **不入库**。`start.sh` 依次读取：

1. 环境变量 `CF_TUNNEL_TOKEN`
2. 文件 `CF_TUNNEL_TOKEN_FILE`（默认 `.secrets/cf-tunnel-token`）

在 Cloudflare 控制台（Zero Trust → Networks → Tunnels）为该 tunnel 配置 Public Hostname（示例）：

- `game.example.com` → `http://127.0.0.1:8765`
- 如需独立信令域名，可将 `netplay.example.com` → `http://127.0.0.1:3000`，并在页面设置 `window.EJS_NETPLAY_SERVER_OVERRIDE`

## 键位

**本地同机双人（local.html）**

| 功能 | 玩家 1 | 玩家 2 |
|------|--------|--------|
| 方向 | ↑ ↓ ← → | W A S D |
| A | K | Z |
| B | J | X |
| Start | Enter | U |
| Select | Shift | I |

点击画面后才会捕获按键；也可在模拟器菜单里改键，支持 USB / 蓝牙手柄。

**手柄**：普通 USB / 蓝牙手柄走 EmulatorJS 自带映射（下面的面键 = B，右边的面键 = A），也可在模拟器菜单里改键；同时支持在 `/gamepad-test.html` 进行交互式 **手柄按键校准**（NES / 街机）。

**单个 Joy-Con（Switch 1）**：先用系统蓝牙配对，横握（摇杆在左、四个按键在右、侧面小按键朝上）。macOS 上 Chrome 的 Gamepad API 看不到单个 Joy-Con，所以页面提供「连接 Joy-Con」按钮（WebHID，需 Chrome/Edge，通过 `localhost` 或 https 访问；局域网 http 地址不可用）。首次点击后在弹窗里选择 Joy-Con，之后浏览器会记住授权。映射：摇杆 = 方向，下/左键 = B，右/上键 = A，Minus 或 SL = Select，Plus 或 SR = Start；多个 Joy-Con 依次作为 P1、P2。P2 串流访客页同样可用。排查与按键校准可打开 `/gamepad-test.html`。

**联机串流**：P1、P2 都使用方向键 + K(A) / J(B) + Enter(Start) / Shift(Select)；P2 的输入发送给 P1 的第二名玩家。

## ROM 政策

- 仓库**不包含任何 ROM**（`.gitignore` 排除 `roms/` 下所有文件及 `*.nes/*.unf/*.fds/*.nsf`）。
- 请自行提供合法持有的 ROM。通过网页上传的 ROM 保存在服务器的 `roms/` 目录，刷新后可在「已保存的 ROM」中直接启动，无需重复上传。
- 页面「加载测试 ROM」可使用开源自制游戏 **Super Tilt Bro.**（`roms/super-tilt-bro.nes`），请从其发布页自行下载：
  <https://github.com/sgadrat/super-tilt-bro/releases>，重命名为 `super-tilt-bro.nes` 放入 `roms/`。

## 街机 / FinalBurn Neo

- 在原机台面板上选择「街机 FBNeo」，上传**与 EmulatorJS FBNeo 核心匹配的原始 romset ZIP**；游戏和 NES 分列表显示。
- 街机 ZIP 的文件名是核心识别游戏的依据，因此不能重命名；同名文件不会自动覆盖。服务端只验证 ZIP 完整性，不解压 ROM。
- 部分克隆游戏需要 Parent ROM：在游戏列表的依赖设置中选择对应 ZIP。Neo Geo / PGM 等系统需通过「上传 BIOS ZIP」上传 `neogeo.zip` / `pgm.zip` 等对应 BIOS，保存到 `roms/bios/`；BIOS 和 Parent 选择仅保存在本机浏览器。
- 按键：P1 方向键，Shift 投币、Enter 开始，J/K/L/I/O/P 为动作 1–6；P2 为 WASD、Q 投币、U 开始、X/Z/C/V/B/N。P2 串流支持相同动作键及触屏按钮。
- 不同游戏实际使用的动作键数、Parent/BIOS 要求和 ROM 版本不同。上传上限为 256 MiB；仓库不附带街机 ROM 或 BIOS。

## E2E 测试

Playwright 双浏览器上下文（主机 + 客机）自动测试，详见 `e2e/README.md`。

```bash
cd e2e
npm install
npm run test:unit                     # 无损编码、输入、校准与独立访客回归
CHROME_CHANNEL=chrome npm test        # 复用本机 Chrome 运行大厅 + 真实串流
BASE_URL=http://127.0.0.1:8765 CHROME_CHANNEL=chrome npm run test:stream
```

覆盖：建房与凭房间码加入、真实 WebRTC 画面、无损像素与视频回退、P2 输入、替换与刷新重连；检查 P2 不请求 ROM、EmulatorJS 加载器或核心。截图与结果 JSON 写入 `e2e/artifacts/`（不入库）。

## 已知限制

- **画面串流**依赖 WebRTC，在严格 NAT / 同机多窗口 / 跨运营商时常停在 *Connecting*，需要配置 **TURN**：
  在项目根目录 `ice-servers.json`（或通过环境变量 `ICE_SERVERS_FILE` 指定路径）写入 `iceServers`（示例见 `NETPLAY_TUNNEL.md`，该文件不入库），`/api/ice` 会自动下发。
- 串流延迟取决于取帧、显示和网络状况；不同设备与 Wi-Fi 环境需实测。

## 许可证说明

本项目自有代码采用 **MIT License** 开源（见根目录 `LICENSE`），仅供学习与参考分享，不作正式维护。第三方组件许可证：EmulatorJS（GPL-3.0，CDN 加载）、EmulatorJS-Netplay（Apache-2.0，改编于 `netplay-node/`，见 `netplay-node/NOTICE.md`）、socket.io 客户端（MIT，见 `vendor/README.md`）。
