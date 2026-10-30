# VeilTalk 架构说明与代码导览

> 本文供 AI / 工程师快速接手项目。所有路径、函数名、环境变量均与仓库实际代码一一对应（校对基准：`src/lib/webrtc/`、`mini-services/signaling-service/index.ts`、`src/store/veil-store.ts`、`Caddyfile`）。
> 配套文档：`docs/E2EE.md`（加密细节与验证）、`docs/TESTING.md`（测试清单）、`docs/LOGGING.md`（台账方案）、`docs/ROADMAP.md`（路线图）、`deploy/DEPLOYMENT.md`（部署）。

---

## 1. 系统拓扑

```
                         ┌──────────────────────────────────────────────┐
   浏览器 A               │                 服务器（单机）                │               浏览器 B
┌──────────────┐         │  ┌────────────────────────────────────────┐  │          ┌──────────────┐
│  Next.js 页面 │         │  │            Caddy 网关 :81              │  │          │  Next.js 页面 │
│  (VeilApp)   │◄────────┼─►│  query XTransformPort=N → localhost:N  │◄─┼─────────►│  (VeilApp)   │
│              │  HTTP/WS │  │  其余全部请求 → localhost:3000          │  │  HTTP/WS │              │
└──────┬───────┘         │  └───┬───────────────┬───────────────┬────┘  │          └──────┬───────┘
       │                 │      │               │               │       │                 │
       │  / (页面, 静态,  │      ▼               ▼               ▼       │                 │
       │  /api/* 经网关) │  Next.js :3000    信令 :3003      运维 :3004  │                 │
       │                 │  App Router      socket.io       HTTP API    │                 │
       │                 │  /api/ice-config path:'/'       /svc/health  │                 │
       │                 │  /api/ledger    join-room/signal /svc/rooms   │                 │
       │                 │                 (JSONL 台账)    /svc/ledger   │                 │
       │                 │  ┌──────────────┐                             │                 │
       │                 │  │ coturn (TURN/STUN :3478)  ← 部署在 compose │                 │
       │                 │  └──────┬───────┘                             │                 │
       │                 └─────────┼─────────────────────────────────────┘                 │
       │                           │            STUN/TURN 辅助（仅打洞/中继，不可读内容）    │
       ▼                           ▼                                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                    P2P Mesh（浏览器 ↔ 浏览器 直连，服务器零参与）                              │
│   DTLS-SRTP 传输层加密（WebRTC 内建）                                                         │
│   ├─ 媒体：SRTP 编码帧 + Insertable Streams / RTCRtpScriptTransform 帧级 AES-256-GCM          │
│   └─ 数据：SCTP over DTLS 的 DataChannel `veiltalk-control`（加密文件块 + 加密聊天 JSON）      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **Caddy :81 是唯一入口**。带 `?XTransformPort=N` 查询参数的请求按查询参数转发到本机 `localhost:N`；其余请求转发 `localhost:3000`（Next.js）。见 `Caddyfile`（全文仅 24 行）。
- **前端 socket 连接固定写法**（禁止改路径/写端口）：`io('/?XTransformPort=3003', { transports: ['websocket', 'polling'], forceNew: true, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 10000 })`，位于 `src/lib/webrtc/room-client.ts` 的 `RoomClient.connect()`。
- **信令服务器是双端口架构**（`mini-services/signaling-service/index.ts`）：因为 socket.io `path:'/'` 会接管该端口全部 HTTP 请求，所以 3003 只跑信令，运维 HTTP API 单独监听 3004（`/svc/health`、`/svc/rooms`、`/svc/ledger`）。
- **台账读取走 Next 服务端代理**：前端 `fetch('/api/ledger?...')` → `src/app/api/ledger/route.ts` → 环境变量 `SIGNALING_HTTP`（默认 `http://127.0.0.1:3004`）→ `/svc/ledger`。不在浏览器直连 3004，利于同源与部署可移植。
- **ICE 配置注入**：`GET /api/ice-config`（`src/app/api/ice-config/route.ts`）读取环境变量 `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` 下发给浏览器；未配置 TURN 时回退公共 STUN（仅打洞）。
- **媒体/文件/聊天全部 P2P**：服务器只见公钥与密文信令，永远不会接触媒体明文、文件内容、聊天明文。

---

## 2. 目录结构

```
/home/z/my-project
├── Caddyfile                        # :81 网关（XTransformPort 转发规则）
├── src/
│   ├── app/
│   │   ├── page.tsx                 # 唯一页面路由，渲染 <VeilApp/>
│   │   └── api/
│   │       ├── ice-config/route.ts  # STUN/TURN 环境变量注入
│   │       └── ledger/route.ts      # 台账代理（SIGNALING_HTTP → /svc/ledger）
│   ├── lib/
│   │   └── webrtc/                  # ★ WebRTC 核心库（详见 §3 模块职责表）
│   ├── store/veil-store.ts          # zustand 全局状态
│   └── components/veil/             # 前端组件（详见 §5）
├── mini-services/signaling-service/
│   ├── index.ts                     # 信令 + 台账 + 运维 API（bun 运行）
│   └── package.json                 # socket.io@4.8.3
├── db/ledger/ledger-YYYY-MM-DD.jsonl# 元数据台账（按日轮转）
└── docs/                            # 本套文档
```

---

## 3. 模块职责表（src/lib/webrtc/）

| 文件 | 一行职责 | 关键导出 / 符号 |
|---|---|---|
| `types.ts` | 全部结构化类型定义（信令/密钥/诊断/传输/台账） | `PeerBrief`、`SignalData`、`RawKeySet`、`SessionKeys`、`E2EEStats`、`PeerStats`、`TransferState`、`ChatEntry`、`LogEntry`、`LedgerEntry`、`SelfTestResult`、`JoinRoomAck`、`E2EEMode` |
| `crypto-core.ts` | 密码学基础：ECDH 身份 → HKDF 派生 8 把方向隔离密钥 → AES-GCM 帧加解密；指纹/安全码/SHA-256 工具 | `generateIdentity()`、`fingerprintJwk()`、`roomSalt(roomId, passphrase?)`、`deriveSharedBits()`、`deriveRawKeys(sharedBits, salt, selfId, remoteId)`、`importSessionKeys(raw)`、`safetyNumber(fa, fb, salt)`、`encryptFrame()` / `decryptFrame()`、`sha256Hex()`、`maskRoomId()`、`bufToB64()` / `b64ToBuf()` / `toHex()`、`randomId()` |
| `e2ee.worker.ts` | Web Worker：媒体编码帧逐帧 AES-256-GCM 加解密（双路径：Chromium `createEncodedStreams` + 标准 `RTCRtpScriptTransform`）；fail-closed 丢帧；每 2s 上报统计 | 消息协议 `{op:'e2ee', mode:'encode'\|'decode', key: ArrayBuffer, readable, writable}`；`onrtctransform` 事件处理；`postMessage({op:'stats', stats})` |
| `e2ee-manager.ts` | 主线程侧接线器：worker 单例、能力检测、sender/receiver 注入、统计汇总 | `e2eeManager`（单例：`attachSender()`、`attachReceiver()`、`getStats()`、`onStats()`、`ensure()`）、`detectCapability(): E2EEMode` |
| `peer-session.ts` | 单对端 WebRTC 会话：完美协商（polite/impolite）、DataChannel、getStats 两遍扫描、弱网码率阶梯、ICE 自动重启 | `class PeerSession`（`pc`、`dc`、`rawKeys`、`e2eeVideoMode/audioMode`、`handleSignal()`、`addLocalTrack()`、`replaceVideoTrack()`、`setVideoMaxBitrate()`、`sendJson()`、`sendBinary()`、`manualRestartIce()`、`close()`）；常量 `ADAPTIVE_LADDER_KBPS=[2500,1600,1000,600,350,180]` |
| `file-transfer.ts` | DataChannel 加密文件传输协议：16KB 分块、bufferedAmount 反压、SHA-256 校验、取消/排队/**暂停恢复** | `CHUNK_SIZE=16*1024`、`class FileSender`（`enqueue()`、`cancel()`、`pause()`、`resume()`、Promise 暂停闸门 + `pausedMs` 速度修正 + `lastState` UI 同步、通道提供者模式 `getDc`）、`class FileReceiver`（`handleControl()`、`handleChunk()`）；控制消息 `file-meta` / `file-end` / `file-cancel` / `file-pause` / `file-resume` / `chat` / `chat-recall` / `typing` / `hello` |
| `quality.ts` | 统一连接质量评级（优/良/中/差四档，阈值与弱网自适应对齐）；video-tile / members-dialog 共用 | `networkGrade(rttMs, lossPct): QualityGrade`（`label`/`desc`/`dotCls`/`textCls`）、`networkGradeLabel()`（带毫秒数标签） |
| `room-client.ts` | 房间编排器：socket.io 信令、ECDH 密钥协商、媒体采集/切换/共享、会话生命周期、加密聊天/文件、信令缓冲重放 | `class RoomClient`（`connect()`、`joinRoom(roomId, name, passphrase?)`、`leave()`、`destroy()`、`acquireLocalMedia()`、`toggleTrack()`、`switchDevice()`、`toggleScreenShare()`、`sendChat()`、`sendFile()`、`cancelTransfer()`、`pauseTransfer()`、`resumeTransfer()`、`sendTyping()`、`sendChatRecall()`、`restartAllIce()`、`sessionCount`、`myFingerprint`）；类型 `SignalingState`、`RoomClientHandlers`；私有 `pendingSignals: Map<string, SignalData[]>` |
| `selftest.ts` | 浏览器内自环全链路自检（5 步），Canvas 合成视频，无摄像头/信令依赖 | `runSelfTest(onStep?) → { ok, results: SelfTestResult[] }`；内部 `LoopLink`（ICE 缓冲交换）、`randomU8()`（getRandomValues 65536B 上限分段）、`spawnWorker()` |
| `controller.ts` | RoomClient ↔ zustand store 桥接单例；组件唯一入口 | `controller.join/leave/toggleMic/toggleCam/toggleScreen/switchDevice/sendChat/sendFile/cancelTransfer/restartIce/runSelfTest/fetchLedger/retryMedia/refreshDevices`、`randomRoomId()`（9 位去混淆字符集 `abcdefghjkmnpqrstuvwxyz23456789`） |

---

## 4. 关键流程时序（文字版）

### 4.1 入房 → 密钥协商 → 建连（双人房为例）

```
浏览器A                      信令(3003)                     浏览器B
  │  1. GET /api/ice-config      │                            │
  │──►(STUN/TURN 配置)           │                            │
  │  2. io('/?XTransformPort=3003') 连接                     │
  │─────────────────────────────►│                            │
  │  3. emit join-room {roomId, peerId, name, fingerprint, pubkey(JSON JWK)} + ack 回调
  │─────────────────────────────►│ ledger('peer_join')        │
  │◄─────────────────────────────│ ack {ok, self:{socketId,peerId,roomId}, peers:[...], serverTs}
  │                              │                            │
  │  4. (B 加入)                 │  emit 'peer-joined' {socketId, peerId, name, fingerprint, pubkey}
  │                              │───────────────────────────►│
  │  5. 双方各自 createSession(peer)：                          │
  │     deriveSharedBits(ECDH P-256) → 256bit 共享秘密          │
  │     roomSalt(roomId, 口令?) → salt                          │
  │     deriveRawKeys(...) → 8 把方向隔离 AES-256 密钥           │
  │     safetyNumber(双方指纹, salt) → 安全码（UI 展示核对）      │
  │  ※ 派生是异步的：期间到达的 'signal' 先存 pendingSignals 缓冲  │
  │  6. new PeerSession({selfPeerId, remoteSocketId, ...})      │
  │     - polite = selfPeerId > remotePeerId（字典序）           │
  │     - impolite 侧 createDataChannel('veiltalk-control')     │
  │  7. addTrack → onnegotiationneeded → setLocalDescription()  │
  │     emit 'signal' {to, data:{description:{type:'offer'}}}   │
  │─────────────────────────────►│───────────────────────────►│
  │                              │  8. handleSignal: 完美协商    │
  │                              │     (冲突: polite 回滚/impolite 忽略)
  │                              │◄────────────────────────────│ answer + ICE candidate
  │◄─────────────────────────────│                             │
  │  9. ICE 打洞（host/srflx/relay）→ DTLS 握手 → connected     │
  │ 10. 会话就绪后重放 pendingSignals（顺序保持）                 │
  │ 11. DataChannel open → sendJson({t:'hello', name})          │
  │ 12. ontrack → e2eeManager.attachReceiver（第一帧媒体前接线）  │
```

### 4.2 媒体（帧级 E2EE）

1. 本地采集：`RoomClient.acquireLocalMedia()`（`getUserMedia`，audio 带 `echoCancellation/noiseSuppression/autoGainControl`，video 720p30 理想值）。失败 → `onMediaError` + 降级「仅数据模式」（文件/聊天仍可用）。
2. 每个会话 `PeerSession.addLocalTrack()`：`pc.addTrack()` 后立即 `e2eeManager.attachSender(sender, rawKeys.videoOut|audioOut)` 注入编码帧加密（必须在首个关键帧前）。
3. 远端 `pc.ontrack`：第一时间 `e2eeManager.attachReceiver(receiver, rawKeys.videoIn|audioIn)`，随后 `onRemoteStream` 上抛渲染。
4. worker 内部（`e2ee.worker.ts`）：`[12B IV | AES-GCM(明文帧) | 16B tag]`，`additionalData` = 1 字节关键帧标志（key=1/delta=0/audio=0）。解密失败 → 丢帧计数（fail-closed）。
5. 屏幕共享：`toggleScreenShare()` 用 `getDisplayMedia` 拿轨后 `replaceTrack()`，E2EE 对新轨自动生效（同一 sender/密钥）。
6. 设备切换：`switchDevice()` 重新 `getUserMedia({deviceId:{exact}})` 后逐会话 `replaceTrack`。

### 4.3 文件传输

1. `RoomClient.sendFile(file)` → 对每个 bundle 的 `FileSender.enqueue(file)`（串行队列）。
2. `sendOne()`：等 DC open（最多 10s）→ `file.arrayBuffer()` → 计算 `SHA-256` → `sendJson({t:'file-meta', id, name, size, mime, chunks, chunkSize:16384, digest})`。
3. 循环：`encryptFrame(fileOut 密钥, 16KB 明文)` → `dc.send(bin)` → `drainOnce()` 反压（`bufferedAmount > 1MB` 则等 `bufferedamountlow`，5s 超时兜底）。
4. 接收端 `FileReceiver.handleChunk()`：按唯一 transferring slot 路由 → `decryptFrame(fileIn 密钥)` → 攒块；`file-end` → `finish()` 重组 Blob → 重算 SHA-256 与 `meta.digest` 比对 → `digestOk` 写入 UI；`URL.createObjectURL` 提供下载。
5. 任一方可 `file-cancel`；发送端 `FileSender.cancel(id)`。
6. **文件名/内容不经过服务器**（走 DataChannel），服务器台账无文件事件。

### 4.4 加密聊天

`controller.sendChat(text)` → `RoomClient.sendChat()`：对每个 DC 已开的会话，`encryptFrame(chatOut, 文本)` → 拆 `iv/ct` base64 → `sendJson({t:'chat', id, ts, iv, ct})` → 对端 `decryptChat()` 用 `chatIn` 解密 → `onChat` 上抛。本端立即回显（`mine:true`）。

### 4.5 断线恢复

- 信令断开：socket.io 自动重连（`reconnectionAttempts: Infinity`）→ `connect` 事件 → `rejoin()` 重新 `join-room`（peerId 保持不变，socketId 会变）→ 重建全部 PeerSession。
- `PeerSession.connectionState === 'failed'` → `autoRecover()` → `pc.restartIce()`（一次，`iceRestarted` 防重入）；UI 亦有「ICE 重启」按钮 → `controller.restartIce()` → 全部会话 `manualRestartIce()`。
- 弱网：`pollStats()` 每 2s 采样 → 丢包 >8% 或 RTT >420ms 时每 10s 沿码率阶梯 `ADAPTIVE_LADDER_KBPS = [2500,1600,1000,600,350,180]` 降级；丢包 <2% 且 RTT <200ms 持续 30s 后逐级回升。

---

## 5. 状态管理

### 5.1 veil-store 字段一览（`src/store/veil-store.ts`）

| 分组 | 字段 | 类型 / 初始值 | 说明 |
|---|---|---|---|
| 连接与房间 | `phase` | `'lobby' \| 'joining' \| 'in-room'` | 页面主阶段 |
| | `signaling` | `'idle'\|'connecting'\|'online'\|'offline'` | 信令连接态（`SignalingState`） |
| | `roomId` / `passphrase` | string / string | 房间号与口令（口令仅存内存，参与盐派生） |
| | `socketId` / `selfPeerId` | string | 自身信令 socketId 与稳定 peerId（randomId(16)） |
| | `e2eeMode` | string | `encoded-streams` / `script-transform` / `unsupported` / `unknown` |
| 身份 | `myFingerprint` / `myName` | string | 本端公钥指纹（12 组 4 位 hex）、昵称 |
| 媒体 | `localStream` | `MediaStream \| null` | 本地流（Object 引用，不参与渲染 diff） |
| | `screenSharing` / `micOn` / `camOn` | boolean | 开关状态 |
| | `devices` | `MediaDeviceInfo[]` | 枚举设备列表 |
| | `mediaError` | `string \| null` | 采集失败原因（降级提示） |
| 成员 | `peers` | `Record<socketId, PeerUI>` | `PeerUI = PeerBrief + {connState, stats, stream, safety, e2ee:{video,audio}}` |
| 数据 | `chats` | `ChatEntry[]`（上限 300） | 聊天记录 |
| | `transfers` | `Record<id, TransferState>` | 文件传输状态 |
| | `e2eeStats` | `{encrypted, decrypted, dropped, bytes}` | worker 帧统计（2s 汇总） |
| 日志与台账 | `logs` | `LogEntry[]`（上限 400，环形截断） | `level: info\|warn\|error\|crypto\|net` |
| | `ledger` / `ledgerLoading` / `ledgerDate` / `ledgerDates` | — | 台账面板数据与可用日期 |
| UI | `activeTab` / `panelOpen` | string / boolean | 侧面板页签与开合 |
| | `selfTestRunning` / `selfTestResults` | boolean / `SelfTestResult[]` | 加密自检状态 |
| actions | `set` / `pushLog` / `upsertPeer` / `removePeer` / `upsertTransfer` / `pushChat` / `clearSensitive` | — | `clearSensitive()` 离房清空 chats/transfers/peers/localStream/e2eeStats |

### 5.2 controller 单例模式（`src/lib/webrtc/controller.ts`）

- 模块级 `let client: RoomClient | null` + `ensureClient()` 惰性创建：整个页面生命周期只有一个 `RoomClient`，其 handlers 全部闭包指向 `useVeil.getState()`（`S()`），即「WebRTC 事件 → store 写入」单向流。
- 组件只 import `controller`（和 `randomRoomId()`），**不直接触碰 RoomClient / PeerSession / Worker**。
- `e2eeManager.onStats()` 在 `ensureClient()` 里一并订阅，写入 `useVeil.setState({ e2eeStats })`。
- 特例：`controller.join()` 失败时若 `error === 'pending'`（信令尚未就绪，connect 事件会自动重试入房），**不**回退大厅。
- 离房 `onLeft` → `phase:'lobby'` + `clearSensitive()`。

### 5.3 zustand 选择器纪律（重要，历史踩坑）

zustand v5 + React 19 使用 `useSyncExternalStore`：**选择器返回新数组/新对象引用会触发 getSnapshot 无限循环**（worklog Task 2-b 第 6 条 bug）。规范：

- 选择器只取原字段：`useVeil((s) => s.peers)` ✅；`useVeil((s) => Object.values(s.peers).sort(...))` ❌
- 派生列表在组件内 `useMemo` 计算（`crypto-panel.tsx` 即范例：`Object.values(peers).map(...)` 在 JSX 内完成渲染派生而非 selector 内）。

---

## 6. 信令协议事件表

服务端：`mini-services/signaling-service/index.ts`（socket.io v4，`path:'/'`，`maxHttpBufferSize: 128KB`，`pingInterval 25s / pingTimeout 60s`）。

### 6.1 客户端 → 服务端

| 事件 | 载荷 | 行为 | ack |
|---|---|---|---|
| `join-room` | `{roomId, peerId, name, fingerprint, pubkey}`（pubkey = ECDH 公钥 JWK JSON 字符串） | 校验 `ROOM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/`；同 socket 重复加入先离开旧房（cause `rejoin`）；新建/复用房间；超员（`MAX_PEERS_PER_ROOM=8`）拒绝；向老成员广播 `peer-joined` | `JoinRoomAck { ok, error?, self?:{socketId,peerId,roomId}, peers?: PeerBrief[], serverTs? }`；失败情形：`房间号格式非法（4-64位字母数字）`、`房间已满（上限 8 人，mesh 模式）`、超时 8s 由客户端 `rejoin()` 判定 |
| `signal` | `{to, data: SignalData}`（`data.description` 或 `data.candidate`） | 校验 `to` 在同房间；`JSON.stringify(data)` 超过 `MAX_SIGNAL_BYTES=96KB` → 丢弃并记 `signal_drop_oversize`；转发 `io.to(to).emit('signal', {from, data})`；**仅 SDP 记台账**（`relay_signal`，kind=`sdp:offer/answer`，字节数），ICE candidate 不记 | 无 |
| `leave-room` | 无 | `leaveRoom(socket, 'voluntary')` → 广播 `peer-left`、空房删除并记 `room_close` | 无 |

### 6.2 服务端 → 客户端

| 事件 | 载荷 | 客户端处理 |
|---|---|---|
| `peer-joined` | `PeerBrief {socketId, peerId, name, fingerprint, pubkey, joinedTs}` | `room-client.ts`：`registerPeerKey()` 缓存公钥 → `createSession()`（ECDH + 建会话）→ `emitPeers()` |
| `peer-left` | `{socketId, peerId, name, cause}`（cause：`voluntary` / `rejoin` / `disconnect:<reason>`） | `destroySession(socketId)` → 关闭 PC/DC → `onRemoteStream(id,null)` → `emitPeers()` |
| `signal` | `{from, data}` | bundle 存在 → `session.handleSignal(data)`；不存在（密钥派生窗口）→ **压入 `pendingSignals` 缓冲，createSession 完成后按序重放**（关键竞态修复，见 §7） |

### 6.3 台账事件清单（详见 `docs/LOGGING.md`）

`service_start`、`socket_connect`、`room_create`、`peer_join`、`relay_signal`、`signal_drop_oversize`、`peer_leave`、`room_close`、`socket_disconnect`、`service_stop`。**没有**文件事件、聊天事件、密钥事件（P2P 数据不经服务器）。

---

## 7. 迭代规范（新增功能必须遵守）

这些约定来自实测踩坑（详见 worklog Task 2-b），违反任何一条都可能引入难排查的回归。

1. **选择器返回稳定引用**（§5.3）：zustand selector 不得在内部 `Object.values/sort/map` 生成新引用；派生用 `useMemo`。违反症状：React 19 + zustand v5 下 `getSnapshot` 无限循环、页面卡死。
2. **信令缓冲重放约定**：任何新信令消费者都要兼容「会话未就绪」场景——`room-client.ts` 的 `signal` handler 把无 bundle 的信令压入 `pendingSignals`，`createSession()` 完成后按序重放。若新增依赖顺序的信令（如未来的密钥轮换消息），必须同样考虑窗口期乱序/丢失，禁止假设「收到即可用」。
3. **impolite 建 DC 约定**：只有 impolite 侧（`selfPeerId < remotePeerId`）调用 `pc.createDataChannel('veiltalk-control')`，polite 侧等 `ondatachannel`。新代码不得在 polite 侧再建通道（会产生双 SCTP 通道、文件路由混乱）。同理，`onnegotiationneeded` 在自检等受控场景应使用显式一次性协商（`setLocalDescription()` 四步曲，见 `selftest.ts`），避免双触发竞态。
4. **fail-closed 加密约定**：所有加解密路径（帧/文件块/聊天）失败时一律**丢弃**并计数，绝不降级为明文发送（`e2ee.worker.ts` 的 `dropped`、`file-transfer.ts` 解密失败即 fail）。新增任何传输通道必须沿用该原则；密钥未就绪时宁可不出帧。
5. **台账最小化约定**：服务器只记「房间号 / peerId / socketId / 事件 / 字节数 / cause / ua 截断 120 字符」。绝不新增记录：密钥材料、SDP/candidate 内容、文件名、聊天内容、公钥本体。新事件先问「这条字段泄露了什么」。
6. **lint 零 error**：提交前 `bun run lint`（eslint9 + next 配置）必须 0 error。受控豁免需像 `lobby.tsx` 一样行内 `/* eslint-disable react-hooks/set-state-in-effect */` 并注释原因。
7. **改动后跑 selftest**：任何触碰 `src/lib/webrtc/` 或构建配置的改动，跑一次页面「加密自检」（`controller.runSelfTest()` → `runSelfTest()`，5 项全绿），并用双标签页做一次真实互通回归。
8. **Caddy 转发约定**：信令必须 `io('/?XTransformPort=3003')`、`path:'/'` 不许改；运维 API 走 `SIGNALING_HTTP`（默认 `http://127.0.0.1:3004`）服务端代理。不要在任何前端代码里写裸端口 URL。
9. **peerId 语义**：`peerId` 是会话稳定标识（`randomId(16)`），`socketId` 是信令连接标识（重连会变）。所有跨重连的关联用 peerId，所有实时会话路由用 socketId。

### 目录结构约定

- WebRTC 协议/密码学逻辑只进 `src/lib/webrtc/`（不 import React）；
- 状态写入只发生在 `controller.ts`（桥接层）与组件的 UI 态（局部 useState）；
- 组件放 `src/components/veil/`，一文件一组件、文件名即组件名（kebab-case）；
- 新 UI 基元优先复用 `src/components/ui/`（shadcn）。

### 命名约定

- 文件 kebab-case（`file-transfer.ts`），类型/类 PascalCase（`PeerSession`），函数/变量 camelCase，常量 SCREAMING_SNAKE（`CHUNK_SIZE`、`ADAPTIVE_LADDER_KBPS`）；
- DataChannel JSON 控制消息以 `t` 为类型字段（`file-meta` / `file-end` / `file-cancel` / `chat` / `hello`），新增消息类型必须挂进 `room-client.ts#handleControl` 的分发并保持「未知类型忽略」的向前兼容；
- 日志 level 五分类：`info / warn / error / crypto / net`，密码学事件用 `crypto`，网络事件用 `net`。

---

## 8. 前端组件清单（src/components/veil/）

| 组件 | 职责 |
|---|---|
| `veil-app.tsx` | 根骨架：header / 主区（`phase==='in-room' ? <Stage/> : <Lobby/>`）/ sticky footer；`min-h-screen flex` 布局 |
| `header-bar.tsx` | 顶栏：品牌、信令状态、E2EE 模式、主题切换 |
| `lobby.tsx` | 大厅：昵称/房间号/口令表单（房间号 ≥4 字符校验、`randomRoomId()` 骰子按钮）、URL `?room=` 邀请参数自动填入、`SelfTestCard`、能力介绍卡 |
| `self-test-card.tsx` | 「加密自检」按钮 + 5 步结果逐条渲染（S1~S5，耗时 ms） |
| `stage.tsx` | 通话主区：视频网格（本端 + `peers`） |
| `video-tile.tsx` | 单个视频瓦片：`<video>` 挂流、连接态徽标、安全码标记、分辨率/码率角标 |
| `control-bar.tsx` | 底部控制条：麦克风/摄像头开关、屏幕共享、ICE 重启、侧面板开关、离开房间 |
| `device-settings.tsx` | 设备选择（`devices` 枚举 + `switchDevice`）、媒体重试 |
| `side-panel.tsx` | 右侧面板容器（桌面侧栏 / 移动端 Sheet 抽屉，`use-mobile.ts` 判断） |
| `file-panel.tsx` | 文件：拖拽/选择发送、进度/速度、SHA-256 展示、取消、下载链接 |
| `chat-panel.tsx` | 加密聊天输入与消息流 |
| `diagnostics-panel.tsx` | 每对端 `PeerStats`（RTT/码率/丢包/抖动/候选对类型/自适应档位） |
| `crypto-panel.tsx` | 本端指纹、对端安全码核对（标记已核对）、密码学配置一览（读 `e2eeStats`） |
| `ledger-panel.tsx` | 台账：日期切换（`ledgerDates`）、条目表、导出 |
| `event-log-panel.tsx` | 客户端事件日志（`logs`）+ JSONL 导出 |
| `empty-state.tsx` | 面板空态占位（无成员/无记录时的通用提示） |
| `footer-bar.tsx` | 常驻页脚：台账摘要入口、版本信息 |

移动端：390px 宽无横向滚动；面板组件经 Sheet 抽屉呈现（Task 3-a 已验证）。

---

## 9. 运行与验证入口（速查）

```bash
# 开发（项目根）
bun install
bun run dev          # Next.js :3000（dev.log 落盘）
cd mini-services/signaling-service && bun --hot index.ts   # 信令 :3003 + 运维 :3004
caddy run --config Caddyfile   # 网关 :81（可选；直连 3000 也可开发）

# 环境变量（可选，见 deploy/.env.example）
STUN_URLS / TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL   # /api/ice-config 注入
SIGNALING_HTTP=http://127.0.0.1:3004                      # /api/ledger 代理目标
SIGNALING_PORT / SIGNALING_HTTP_PORT / LEDGER_DIR / MAX_PEERS_PER_ROOM  # 信令服务

# 验证
curl http://localhost:3004/svc/health
curl 'http://localhost:3004/svc/ledger?limit=5'
# 浏览器打开 :81（或 :3000）→ 大厅点「加密自检」→ 应 5/5 通过
```

验证历史与测试步骤见 `docs/TESTING.md`；加密原理与抓包验证见 `docs/E2EE.md`。
