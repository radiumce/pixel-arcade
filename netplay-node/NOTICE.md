# netplay-node 说明 / Notice

`server.js` 的 EmulatorJS 联机信令部分（`open-room` / `join-room` / `/list` 等）参考并改编自
[EmulatorJS/EmulatorJS-Netplay](https://github.com/EmulatorJS/EmulatorJS-Netplay)（Apache License 2.0，
许可证全文见 `LICENSE-EmulatorJS-Netplay`）。

本项目的修改：

- 仅监听 `127.0.0.1:3000`（由站点反向代理或经 Cloudflare Tunnel 对外提供服务）
