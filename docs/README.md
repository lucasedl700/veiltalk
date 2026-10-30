# VeilTalk 文档导航

> VeilTalk：端到端加密 WebRTC 通话与 P2P 文件传输。Next.js 16 + 自研 socket.io 信令 + 帧级 E2EE（ECDH P-256 → HKDF-SHA256 → AES-256-GCM）。

## 文档索引

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统拓扑图、目录结构、`src/lib/webrtc/` 模块职责表、关键流程时序、veil-store 状态表、信令协议事件表、**迭代规范（改码前必读）** | 接手代码前 |
| [E2EE.md](./E2EE.md) | 密钥体系全图、帧/文件块格式、威胁模型（含无 PAKE 局限明示）、四层验证方法（自检按钮 / 安全码核对 / 抓包 / agent-browser 脚本）、浏览器兼容矩阵 | 改加密相关代码、或要向用户解释安全性时 |
| [TESTING.md](./TESTING.md) | 浏览器×网络测试矩阵、26 条功能检查单、已执行结果记录（本沙箱）、弱网模拟（DevTools / tc netem）、发版回归最小集 | 发版前、跨浏览器验收 |
| [ROADMAP.md](./ROADMAP.md) | P0（SFU/密钥轮换/PAKE）、P1（录制/PWA/i18n/#pass 口令等）、P2（TURN REST/Prometheus/Redis 集群/Electron/台账签名链），每项含拆解步骤、验收标准、工作量、依赖排序 | 规划下一个迭代 |
| [LOGGING.md](./LOGGING.md) | JSONL 台账实现、字段字典、查询方式（API/面板/grep）、轮转压缩与 journald/logrotate、告警建议、隐私合规边界 | 运维部署、安全审计 |
| [DEPLOYMENT.md](../deploy/DEPLOYMENT.md) | Docker Compose 一键部署、coturn TURN/STUN 配置、环境变量清单 | 上线部署 |

## 快速开始（开发模式，三条命令）

```bash
bun install                                            # ① 安装依赖（根目录）
bun run dev                                            # ② Next.js :3000
cd mini-services/signaling-service && bun --hot index.ts   # ③ 信令 :3003 + 运维 API :3004
```

打开 `http://localhost:3000`（或经网关 `:81`）→ 大厅点「**加密自检**」，应 5/5 通过。可选环境变量（STUN/TURN 等）见 [ARCHITECTURE.md §9](./ARCHITECTURE.md)。

## 最小部署（生产）

见 [deploy/DEPLOYMENT.md](../deploy/DEPLOYMENT.md)：`docker compose up -d` 一键拉起 web + signaling + coturn；上线前先跑一遍 [TESTING.md §6 回归最小集](./TESTING.md)。

## 一分钟架构印象

浏览器 ↔ Caddy(:81, `?XTransformPort=N` 按参转发) ↔ Next.js(:3000) / 信令(:3003) / 运维 API(:3004)；媒体、文件、聊天全部浏览器 P2P 直连（DTLS-SRTP 之上再叠帧级 AES-256-GCM），服务器只做信令中继与元数据台账。
