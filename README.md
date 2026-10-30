# VeilTalk

端到端加密的浏览器通话与文件直传。无账号、无服务端明文——密钥只在浏览器内协商。

Next.js 16 + React 19 · socket.io 信令（Bun）· 帧级 E2EE（ECDH P-256 → HKDF-SHA256 → AES-256-GCM）

## 功能

- **音视频通话**：WebRTC mesh 多方（每房间 ≤8 人），DTLS-SRTP 传输加密之上叠加帧级端到端加密
- **文件直传与加密聊天**：DataChannel 分块传输，SHA-256 完整性校验，断点续传
- **极简进房**：登录页只有 logo 与「继续」；输入房间号即加入，房间不存在则创建；密码/审批/昵称/画质等全部收进「高级设置」
- **服务器选择**：内置按地区整理的公共 STUN/TURN 目录（全球/中国大陆/欧洲），一键测速显示各服务器连接延迟与 TURN 中继上行，按结果选择；支持自定义服务器
- **画质档位**：360p → 4K60 → **8K60 / 8K144** 顶格档（实际输出以设备上限为准，弱网自动降码率）
- **加密开关**：高级设置可关闭应用层 E2EE（与对端自动协商降级为 DTLS-SRTP 传输加密）
- **管理面板**：房间治理、全局画质默认档、服务器延迟测速、元数据台账清理（`/?view=admin`，密码经 `ADMIN_PASSWORD` 环境变量设置）

## 快速开始（开发）

```bash
# ① 根目录：安装依赖并初始化数据库
bun install
bun x prisma db push

# ② 信令服务（:3003 socket.io / :3004 运维 API）
cd mini-services/signaling-service
cp /dev/null .env && echo "ADMIN_PASSWORD=改成你的密码" >> .env   # Windows: 手动创建 .env 写入 ADMIN_PASSWORD=...
bun install && bun index.ts

# ③ Web（:3000）
cd ../.. && bun x next dev -p 3000
```

打开 `http://localhost:3000`。本机直跑无需 Caddy 网关：`next.config.ts` 内置了 `XTransformPort` 开发代理，socket.io 会自动直连 `:3003`。

> 管理面板密码：`mini-services/signaling-service/.env` 中的 `ADMIN_PASSWORD`（缺失时服务启动会生成临时密码并打印到控制台）。

## 接入免费/商用 TURN（一行配置）

在 Metered、Xirsys 等服务商注册免费 TURN 额度，把它的凭据端点填进 `TURN_API_URL` 环境变量即可（无需改代码）：

```
# .env（web 服务进程）
TURN_API_URL=https://你的应用名.metered.live/api/v1/turn/credentials?apiKey=你的key
```

服务端会拉取动态 TURN 凭据（5 分钟缓存）合入 `/api/ice-config` 下发；兼容 `{iceServers:[...]}` 与 Metered 的平铺格式。跨网络打洞成功率会显著提升。

## 生产部署

Docker Compose 一键拉起 web + signaling + coturn（TURN/STUN），见 [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md)。

## 文档

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 系统拓扑、模块职责、信令协议
- [E2EE.md](./docs/E2EE.md) — 密钥体系、威胁模型、验证方法
- [TESTING.md](./docs/TESTING.md) — 测试矩阵与功能检查单
- [LOGGING.md](./docs/LOGGING.md) — 元数据台账与隐私边界
- [ROADMAP.md](./docs/ROADMAP.md) — 迭代规划

## 一分钟架构印象

```
浏览器 ── Caddy(:81, ?XTransformPort=N 按参转发) ──┬─ Next.js(:3000)
                                                  ├─ 信令 socket.io(:3003)
                                                  └─ 运维 API(:3004)
媒体 / 文件 / 聊天：浏览器间 P2P 直连（帧级 AES-256-GCM），服务器只见密文
```
