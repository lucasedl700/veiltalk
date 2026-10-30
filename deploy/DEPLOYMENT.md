# VeilTalk 部署文档（Docker Compose + coturn）

> 端到端加密 WebRTC 通话与文件传输站点 · 生产部署指南
> 配套文件：`docker-compose.yml`、`Dockerfile.web`、`Dockerfile.signaling`、`coturn/turnserver.conf`、`deploy.sh`、`.env.example`、`nginx-notes.md`

---

## 1. 架构总览与关键约束

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| web（Next.js 16） | 3000/tcp | 页面 + API：`/api/ice-config`（下发 STUN/TURN）、`/api/ledger`（台账代理） |
| signaling（自研信令） | 3003/tcp | socket.io 信令，`path='/'`（Caddy 网关按 `?XTransformPort=3003` 转发） |
| signaling（运维 API） | 3004/tcp | `/svc/health`、`/svc/rooms`、`/svc/ledger`，仅供内网/运维探针 |
| coturn（TURN/STUN） | 3478 tcp+udp、5349 tcp+udp、49152-49255 tcp+udp | 打洞与中继（媒体数据不出自研服务器，coturn 仅转发加密流量） |
| 元数据台账 | —（文件） | JSONL 按日轮转，宿主机 `db/ledger/` 挂载进信令容器 `/data/ledger` |

**三条硬性约束（决定部署拓扑，务必先读）：**

1. **必须前置支持 XTransformPort 路由的反向代理。** 前端信令连接写死为同源
   `io('/?XTransformPort=3003')`，即浏览器向"当前页面域名"发起 WebSocket，由网关按查询参数
   `XTransformPort` 决定转发到 3003/3004，其余请求转发到 3000。若直接暴露 3000 端口访问，
   信令握手会打到 Next.js 上返回 HTML，通话无法建立。因此 **3000/3003/3004 建议只监听
   内网/localhost，公网仅开放 80/443 与 TURN 相关端口**（Caddy 配置见第 5 节）。
2. **WebRTC 要求安全上下文。** `getUserMedia`（摄像头/麦克风）只在 **HTTPS** 或 `localhost`
   下可用；自签名证书会被浏览器拒绝（见第 7 节）。生产环境必须配置可信证书（推荐 Caddy 自动
   HTTPS）。
3. **coturn 需要正确通告公网地址。** 云服务器普遍是"公网 IP 绑在云网关、网卡只有内网 IP"的
   NAT 结构，必须配置 `external-ip=<公网IP>/<内网IP>`，否则中继候选不可达（见第 6 节）。

数据面：媒体/文件为 P2P（浏览器间 DTLS-SRTP + 应用层 E2EE），coturn 仅在打洞失败时中继加密
包；信令服务器只转发 SDP/ICE 元数据，接触不到密钥与明文，日志台账已做元数据最小化。

---

## 2. 前置要求

- 一台 2 核 2G 以上的云服务器（Ubuntu 22.04/Debian 12 等主流发行版均可），**建议境外或无需
  备案的域名**，并已把域名 A 记录指向服务器公网 IP。
- Docker Engine ≥ 24，且带 **Compose v2 插件**（`docker compose version` 可用）。
- 服务器具备访问 Docker Hub 的网络（拉取 `oven/bun`、`node:22-alpine`、`coturn/coturn` 镜像）。
- 项目源码（git clone 或上传），目录内含 `deploy/` 交付包。
- 云厂商安全组/防火墙编辑权限（端口清单见第 4 节）。

一键检查：`bash deploy/deploy.sh` 会在开头校验 docker 与 compose 插件，缺什么会直接提示。

---

## 3. 一键部署

```bash
cd /opt/veiltalk            # 项目根目录
bash deploy/deploy.sh       # 或 chmod +x deploy/deploy.sh && ./deploy/deploy.sh
```

脚本会依次完成：

1. 校验 docker daemon 与 compose（v2 插件或旧版 docker-compose 均可）；
2. **若项目根没有 `.env`**：生成 `.env`（权限 600）——随机 hex TURN 凭据
   （`TURN_USERNAME`/`TURN_CREDENTIAL`）、自动探测公网 IP 写入 `TURN_URLS`、
   `SIGNALING_HTTP=http://signaling:3004`；
3. 把 `.env` 中的长期凭证**同步改写**进 `deploy/coturn/turnserver.conf` 的 `user=` 行
   （coturn 不读 .env，由脚本保证两端一致）；
4. 若项目根没有 `.dockerignore`：生成一份（排除 node_modules/.next/.git/db/.env 等）；
5. `docker compose up -d --build` 构建三个镜像并启动；
6. 输出访问地址、端口清单与后续（HTTPS 反代）提醒。

验证：

```bash
docker compose -f deploy/docker-compose.yml ps          # 三服务 Up (healthy)
curl http://127.0.0.1:3000/api/ice-config               # 返回 iceServers（含 hasTurn:true）
curl http://127.0.0.1:3004/svc/health                   # 信令健康（rooms/peers/ledgerDir）
curl -s "http://127.0.0.1:3004/svc/ledger?limit=3"      # 台账最近 3 条
docker compose -f deploy/docker-compose.yml logs -f coturn
```

> 若用手工方式部署：`cp deploy/.env.example .env` 并填写，再
> `docker compose -f deploy/docker-compose.yml up -d --build`。

---

## 4. 云服务器安全组端口清单

| 端口 | 协议 | 用途 | 是否开放 |
| --- | --- | --- | --- |
| 80 | tcp | Caddy ACME http-01 验证 / HTTP 跳转 | 建议（配 HTTPS 必开） |
| 443 | tcp | 主入口：页面 + 信令 WebSocket（经反代） | **必须（生产）** |
| 3478 | tcp + udp | TURN/STUN 监听 | **必须（udp 优先级最高）** |
| 5349 | tcp + udp | TURN over TLS/DTLS | 可选（配证书后使用） |
| 49152-49255 | tcp + udp | TURN relay 中继端口段 | **必须（媒体出口）** |
| 3000 | tcp | Web 直连调试 | 可选（仅调试；生产可关闭，经反代访问） |
| 3003 | tcp | 信令直连 | 不建议（应经反代，见第 1 节约束 1） |
| 3004 | tcp | 运维 API | 不建议（仅内网/SSH 隧道访问） |

提示：UDP 是打洞主力，`3478/udp` 与 `49152-49255/udp` 任何一个漏放行，都会导致弱网环境下
"能连上但频繁断流/高丢包"。把 3000/3003/3004 的公网入口关掉、只走 443，是最干净的拓扑。

---

## 5. HTTPS 与反向代理（WebRTC 硬性要求）

浏览器规定：`getUserMedia` 等能力只在**安全上下文**可用——即 `https://` 页面，或
`http://localhost`/`http://127.0.0.1`。生产环境走公网 IP 的 `http://` 无法开启摄像头/麦克风。

推荐 **Caddy**（自动申请/续期 Let's Encrypt 证书，且原生支持 WebSocket 透传）。在服务器上
安装 Caddy 后，编辑 `/etc/caddy/Caddyfile`：

```caddyfile
# 最小可用版（与项目根 Caddyfile 的 :81 写法同构，把网关从 81 换成域名+443）
veiltalk.example.com {
    @p query XTransformPort=*
    handle @p { reverse_proxy 127.0.0.1:{query.XTransformPort} }
    handle    { reverse_proxy 127.0.0.1:3000 }
}
```

生产推荐**显式白名单版**（避免把 `{query.XTransformPort}` 动态转发到任意本地端口）：

```caddyfile
veiltalk.example.com {
    @sig query XTransformPort=3003
    handle @sig { reverse_proxy 127.0.0.1:3003 }   # 信令 WebSocket

    @svc query XTransformPort=3004
    handle @svc { reverse_proxy 127.0.0.1:3004 }   # 运维 API（也可不对外）

    handle { reverse_proxy 127.0.0.1:3000 }        # Next.js 页面
}
```

`systemctl reload caddy` 后，直接访问 `https://veiltalk.example.com` 即可（Caddy 自动 HTTPS）。
若 compose 里 3000/3003/3004 映射的是 `127.0.0.1`（推荐），以上 `127.0.0.1` 无需改动。

说明：

- Caddy 的 `reverse_proxy` 自动处理 WebSocket Upgrade 与 `X-Forwarded-*` 头，无需额外配置。
- `.env` 中 `TURN_URLS` 建议同时写 `turn:<IP或域名>:3478?transport=udp` 与
  `?transport=tcp`； TURN URL 的 host 可以是域名（不需要证书）也可以是 IP。
- 若用户使用 nginx，见本目录 `nginx-notes.md`（含 WebSocket upgrade 头与端口白名单 map）。

---

## 6. TURN 配置与进阶

### 6.1 external-ip（最容易踩的坑）

编辑 `deploy/coturn/turnserver.conf`：

- 服务器网卡直接持有公网 IP：`external-ip=203.0.113.10`
- 云服务器（网卡只有内网 IP，绝大多数情况）：
  `external-ip=203.0.113.10/10.0.0.5`（公网IP/内网IP 形式）

改完 `docker compose -f deploy/docker-compose.yml restart coturn`。验证中继是否真的可用：

```bash
# 本机无浏览器时的粗验：STUN 绑定应返回 srv 地址
docker exec veiltalk-coturn turnutils_stunclient <服务器公网IP>
# 浏览器端：进入页面 → 诊断面板 → 检查 ICE 候选是否出现 type=relay
```

### 6.2 进阶：静态鉴权 secret（REST 临时凭证）✅ 已原生支持（第 15 轮；第 16 轮支持一键配置）

默认的 long-term credential（`.env` 的 `TURN_USERNAME/TURN_CREDENTIAL`）把固定密码下发给每个
浏览器，泄露后需要全局换密码。coturn 支持 **REST API 机制**：服务器只持有 secret，浏览器每次
拿到的是**带过期时间的短时凭证**。`/api/ice-config` 现在**开箱支持**该模式。

**一键配置（推荐，第 16 轮 F-35）**：`bash deploy.sh up --turn-rest` 自动完成双侧配置——
`.env` 追加随机 `TURN_SHARED_SECRET`（web 容器经 env_file 自动注入）+ coturn 配置切换为
`use-auth-secret` + `static-auth-secret=<同一随机串>`（原长期凭证配置自动备份为
`turnserver.conf.lt-cred.bak`，回退时还原并重启 coturn 即可）。幂等：重复执行复用已有 secret。

手动配置（等价）：

1. `deploy/coturn/turnserver.conf`：注释掉 `lt-cred-mech` 与 `user=` 两行（**两种机制互斥，
   同时开启会启动报错**），取消注释：

   ```
   use-auth-secret
   static-auth-secret=<一段随机串>
   ```

2. `.env` 追加 `TURN_SHARED_SECRET=<同一随机串>`（可选 `TURN_CREDENTIAL_TTL=3600` 调整有效期，
   单位秒，范围 60~86400）；
3. 无需任何代码改造：`/api/ice-config` 检测到 `TURN_SHARED_SECRET` 即自动切换 REST 模式，按
   coturn 约定签发短时凭证并随响应返回 `turnMode:"rest"` 与 `ttl` 字段（长期凭证模式下为
   `turnMode:"long-term"`）。签发逻辑（服务端）：

   ```ts
   // src/app/api/ice-config/route.ts（已实现）
   const username = `${Math.floor(Date.now() / 1000) + ttl}:veiltalk`     // <过期时间戳>:<归因标识>
   const credential = createHmac('sha1', secret).update(username).digest('base64')
   ```

这样凭证每小时过期、secret 永不出服务器、响应 `Cache-Control: no-store` 防中间层缓存，
是多人部署的推荐姿势。抓包验证：凭证中的过期时间戳到期后 ICE 中继将鉴权失败。

---

## 7. 常见问题排查

**1) 打洞失败 / 通话经常走"中继"或直接卡死**
- 检查安全组：`3478/udp`、`49152-49255/udp`（以及 tcp）是否放行——漏 relay 段是最常见原因；
- 检查 `external-ip` 是否按第 6.1 节配置（云 NAT 服务器必配）；
- 浏览器诊断面板看候选类型：只有 `srflx/host` 说明 TURN 没被用上（`/api/ice-config` 是否
  返回 `hasTurn: true`、TURN URL 是否可达）；`relay` 候选存在但连不通，基本就是防火墙/external-ip；
- 双 NAT / 对称型 NAT（公司网络、部分 4G/5G）：纯 STUN 打洞天然会失败，属正常现象，TURN
  中继兜底即可；两端都走 relay 时延迟升高，属预期行为；
- 同机部署时确认 relay 段未被其它进程占用：`ss -lntup | grep 49152`。

**2) 自签名证书导致摄像头被禁**
- 浏览器对自签名 HTTPS 会先弹"不安全"，即便点了继续，`getUserMedia` 也会报
  `NotAllowedError`——**自签名不可用于 WebRTC 生产**。用 Caddy/certbot 申请可信证书；
- 本机调试用 `http://localhost:3000`（或经 :81 网关）即可满足安全上下文；
- 临时需要"裸 HTTP + 域名"测试：Chrome 地址栏加
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 白名单（仅自用调试，勿推广）。

**3) 信令连不上（页面能开，进房无响应/反复重连）**
- 确认存在第 5 节的反代：直接访问 `https://域名/?XTransformPort=3003&EIO=4&transport=polling`
  应回复 socket.io 握手文本（形如 `0{"sid":...}`），返回 HTML 说明网关规则没生效；
- nginx 用户：检查 `Upgrade/Connection` 头与 `proxy_read_timeout`（见 nginx-notes.md）；
- 检查 `docker compose logs signaling`：3003 与 3004 都应打印监听成功。

**4) 台账面板为空**
- `db/ledger` 挂载是否生效：`ls db/ledger/` 应有 `ledger-YYYY-MM-DD.jsonl`；
- 宿主机目录权限：容器默认 root 写入；若自定义了 `user:`，需 `chown` 对应 UID；
- `/api/ledger` 走 web → signaling:3004 内网链路，确认 signaling 容器 healthy。

**5) coturn 容器重启/不健康**
- `docker compose logs coturn` 看具体行号报错（conf 语法错误会直接退出）；
- 端口被宿主服务占用（如 3478 被其它 STUN）：换端口需同步改 conf、compose、TURN_URLS；
- 健康检查用 `turnutils_stunclient 127.0.0.1`，若镜像裁剪了该工具，可将 compose healthcheck
  换成 `nc -z 127.0.0.1 3478`。

**6) 时间不同步**
- 长期凭证/REST 临时凭证都依赖时间戳，NTP 失步会导致鉴权随机失败：`timedatectl` 检查。

---

## 8. 升级与回滚

升级（保持数据）：

```bash
cd /opt/veiltalk
git pull                       # 或上传新代码
bash deploy/deploy.sh          # up -d --build：仅重建变更镜像，.env 与 db/ledger 均保留
```

回滚到历史版本：

```bash
git log --oneline              # 找到要回滚的 tag/commit
git checkout <tag>             # deploy.sh 幂等，不会覆盖你已生成的 .env
bash deploy/deploy.sh
```

- 回滚只影响代码镜像；`db/ledger`（台账）与 `.env`（凭据）在宿主机上，不受容器重建影响。
- 想彻底重置运行状态：`bash deploy/deploy.sh down` 后再 `up`（容器内无持久状态，房间/连接
  本就随进程消失，这正是 P2P 架构的无状态特性）。

---

## 9. 备份与恢复

需要备份的只有两样（都很小）：

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 元数据台账 | `db/ledger/*.jsonl` | 按日轮转的审计日志，唯一持久化业务数据 |
| 环境凭据 | `.env` | 含 TURN 凭据/TURN_SECRET，**加密保管，勿入 git** |

```bash
# 手动备份（deploy.sh 内置同款逻辑）
bash deploy/deploy.sh backup          # → backups/ledger-<时间戳>.tar.gz

# 每日 3 点自动备份（crontab -e）
0 3 * * * cd /opt/veiltalk && tar -czf backups/ledger-$(date +\%F).tar.gz db/ledger && find backups -mtime +30 -delete

# 恢复
tar -xzf backups/ledger-2026-09-16.tar.gz -C /opt/veiltalk/
```

---

## 10. 附录

- 端到端自检：页面内"自检"卡片可跑 5 步加密自检，部署后建议先跑一遍；
- 跨浏览器验证清单与 E2EE 验证方法见 `docs/`（Task 4-b 文档包）；
- nginx 反代等价配置：`deploy/nginx-notes.md`；
- 构建细节（为何 node:22-alpine + bun、standalone 处理方式）见两个 Dockerfile 头部注释；
- compose 常用命令：
  ```bash
  docker compose -f deploy/docker-compose.yml ps
  docker compose -f deploy/docker-compose.yml logs -f [web|signaling|coturn]
  docker compose -f deploy/docker-compose.yml restart coturn
  docker compose -f deploy/docker-compose.yml down
  ```
