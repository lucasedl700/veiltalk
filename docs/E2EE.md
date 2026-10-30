# VeilTalk 端到端加密（E2EE）说明与验证方法

> 实现基准：`src/lib/webrtc/crypto-core.ts`（主线程密码学）、`src/lib/webrtc/spake2.ts`（SPAKE2 PAKE，第 14 轮新增）、`src/lib/webrtc/e2ee.worker.ts`（帧级加解密 Worker）、`src/lib/webrtc/e2ee-manager.ts`（接线）、`src/lib/webrtc/room-client.ts`（协商编排）、`src/lib/webrtc/file-transfer.ts`（文件/聊天）。文中所有常量与函数名均为真实代码符号。

---

## 1. 密钥体系全图

```
会话级临时身份（页面生命周期，非持久，不落盘不上传）
  generateIdentity(): ECDH P-256 密钥对
  指纹 fingerprint = SHA-256("P-256|x|y") 取前 48 个十六进制字符（192 bit）→ 12 组 4 位 hex（fingerprintJwk）

                 对端公钥 JWK（经信令明文转发——公钥本就公开）
                          │
  ECDH deriveBits(256)    ▼          deriveSharedBits(myPriv, peerJwk)
  共享秘密 sharedBits（256 bit，服务器不可知：缺任一方私钥无法推得）
                          │
  （设置口令时）SPAKE2 PAKE 口令认证（spake2.ts，第 14 轮新增）
    双方经信令互换公开共享值 X = x·G + w·M / Y = y·G + w·N（w 由口令+roomId 派生）
    各自算 Z = x·y·G → K = SHA-256(Z ‖ transcript)；互换 HMAC 证明并互验
    互验失败（口令不一致/中间人篡改/超时 8s）→ 抛错 → 不建立任何会话（fail-closed）
    绑定层 bindPakeSecret：HKDF(ikm=sharedBits, salt=K, info="veiltalk:pake-bind:v1") → 32B ikm
    （ECDH 提供前向保密，SPAKE2 提供口令认证；两者缺一会话都无法建立）
                          │
  房间盐 salt = SHA-256("veiltalk-salt:" + roomId + ":" + 口令)   ← roomSalt()；口令可选
                          │
  HKDF-SHA256（salt = 房间盐；8 次派生，每次 256 bit）            ← deriveRawKeys()
  info = "veiltalk:<kind>:<from>:<to>"   （from/to = 发送方/接收方 peerId）
  ┌─────────────────────────────────────────────────────────────────────┐
  │ veiltalk:video:A:B → videoOut(A 发 B 收)   veiltalk:video:B:A → videoIn│
  │ veiltalk:audio:A:B → audioOut              veiltalk:audio:B:A → audioIn│
  │ veiltalk:file :A:B → fileOut               veiltalk:file :B:A → fileIn │
  │ veiltalk:chat :A:B → chatOut               veiltalk:chat :B:A → chatIn │
  └─────────────────────────────────────────────────────────────────────┘
  8 把方向隔离密钥（RawKeySet，32B/把）：
    · 媒体（videoOut/videoIn/audioOut/audioIn）：原始字节 postMessage 进 Worker
      → crypto.subtle.importKey('raw', …, 'AES-GCM')（worker 内 ensureKey）
    · 文件/聊天（fileOut/fileIn/chatOut/chatIn）：importSessionKeys() 在主线程导入
      → SessionKeys { fileOut, fileIn, chatOut, chatIn }

方向隔离的意义：A→B 与 B→A 使用不同密钥，且视频/音频/文件/聊天互不共享，
单把密钥泄露不影响其他流；info 绑定 peerId 防止跨房间/跨对端密钥混用。
```

安全码（带外核对，`safetyNumber(fa, fb, salt)`）：
`SHA-256( sort(指纹A,指纹B) 以":"拼接 + ":" + toHex(salt) )` 取前 24 hex → 6 组 4 位大写（如 `BBE9-C9F3-4A7F-4753-4CDA-D7F5`）。双方独立计算结果必然一致；口令参与盐派生，因此**同一口令 + 同一对端才有相同安全码**，可用于人肉识别中间人。

---

## 2. 帧格式与文件块格式

### 2.1 通用封装（`encryptFrame` / `decryptFrame`，crypto-core.ts）

```
┌──────────┬────────────────────────────┬──────────┐
│ 12 B IV  │        AES-256-GCM 密文      │  16 B tag │
│ (random) │  (= 明文长度，GCM 为流密码)   │ (认证标签) │
└──────────┴────────────────────────────┴──────────┘
```

- IV 每次 `crypto.getRandomValues(12B)` 随机生成，不复用。
- GCM tag 提供机密性 + 完整性 + 认证（篡改即解密失败）。

### 2.2 媒体编码帧（e2ee.worker.ts `transformEncode/transformDecode`，v2 轮换链）

- 帧格式：`[1B epoch | 12B IV | ct | 16B tag]`。
- additionalData 1 字节 = **帧内 epoch 字节**（双端从同一帧头读取，必然一致）。
  ⚠️ 不要用关键帧标志作 AD：实测 Chromium 发送端/接收端的 `frame.type` 不对称
  （发送侧 key 帧的 type 字段在发/收两端不一致），用 type 作 AD 会导致关键帧全量解密失败
  （v1 时代潜伏问题，第 12 轮修复；详见 worklog BUG-8）。
- 帧长 ≤29B（epoch+IV+tag 最小长度）或 `empty` 帧直接放行不加密。
- 解密失败（密钥不匹配 / 被篡改 / 注入）→ **丢帧 + `dropped++`**，密文永不进入解码器（fail-closed）。
  解码端按帧内 epoch 解密；失败再试 `epoch-1`（轮换边界在途帧容错），仍失败才丢弃。
- **每条管线（pipe）独立密钥上下文**：pipeId = `<对端socketId>:<send|recv>:<video|audio>`，
  `onmessage {op:'e2ee', mode, pipeId, seed, readable, writable}` 或 `onrtctransform`（options 携带
  `{mode, pipeId, seed}`）注入；不访问网络、不缓存到任何存储。
  （v1 的全局单 `mediaKey` 在音视频同开时会被后接入者覆盖 → 全部媒体解密失败，第 12 轮修复 BUG-7）
- **密钥轮换链（前向保密简化版，第 12 轮新增）**：
  - 主线程注入 32B 轮换种子（HKDF 派生的 videoOut/videoIn/audioOut/audioIn）；
  - epoch N 的帧密钥 = HKDF(seed, info=`veiltalk:epoch:N`)，worker 内懒派生 + 缓存；
  - 编码端每 1024 帧或 5 分钟自动推进 epoch（`maybeRotate`），也可由主线程
    `forceRotate(pipeId)` 手动推进（诊断面板「立即轮换密钥」/ 自检 S6）；
  - 解码端按帧内 epoch 自主派生对应密钥 —— **无需信令同步**，乱序/丢帧安全；
  - 旧 epoch 密钥保留最近 3 个（`EPOCH_WINDOW`）用于边界容错，超窗即销毁 → 泄露窗口有限。

### 2.3 文件块与聊天（file-transfer.ts + dc-ratchet.ts，v2 轮换链）

- 明文分块 `CHUNK_SIZE = 16KB`；每块走 DC 轮换链：`wire = [1B epoch | 12B IV | ct | 16B tag]`，
  其中 epoch N 块密钥 = HKDF(fileOut 种子, info=`veiltalk:dc-epoch:N`）。
- **DataChannel 密钥轮换链（前向保密简化版，第 13 轮新增，`dc-ratchet.ts`）**：
  - 聊天/文件各方向独立轮换环（chatOut/chatIn/fileOut/fileIn 种子）；
  - 发送端每 5 分钟未轮换则在下一次 `out()` 时懒自动推进，也可手动轮换
    （诊断面板「轮换传输密钥」→ 聊天/文件链各自 epoch+1）；
  - 帧自描述：文件块帧头带 1B epoch，聊天 JSON 携带完整 `e` 字段 →
    接收端按帧内 epoch **自主派生**对应密钥，无需信令同步（乱序/离线安全）；
  - 1B epoch 以 256 为模回绕，接收端按「单调棘轮」还原完整 epoch（DC ordered 保帧序）；
  - 旧 epoch 密钥缓存保留当前 ±2 窗口，超窗即销毁 → 泄露窗口有限。
- 控制面（JSON 明文走 DataChannel，不涉密）：`file-meta {id,name,size,mime,chunks,chunkSize,digest,resumable?}`、`file-end {id,digest}`、`file-cancel {id,reason}`、`file-resume-sync {id,have}`、`file-ack {id,ok}`（F-33 显式回执：接收端重组校验后回发，发送端把「已发送」升级为「对端已确认」）、`chat {id,ts,e,iv,ct}`、`hello {name}`。
  - `file-meta/file-end` 中的 `digest` 为整文件 SHA-256 hex——哈希本身不泄密内容，用于接收端完整性校验。
  - 聊天体加密后拆分：`iv = base64(前12B)`、`ct = base64(其余)`，`e` 为发送端 DC epoch（缺省视为 0）。
- **断点续传（P1-6，第 15 轮，`transfer-db.ts` + 发送/接收握手）**：
  - 接收端把已收明文分片按 `digest`（SHA-256）为键定期暂存到本地 IndexedDB（每 16 块/256KB 一次，
    暂停/取消/失败时也落盘）；传输完成（校验通过）后立即擦除该记录；
  - 发送端重试时 meta 带 `resumable:true` → 接收端按 digest 查暂存，命中则回
    `file-resume-sync {id, have}` → 发送端把 have 对齐到块边界（`alignResumeOffset`）后跳过已收分片；
    无响应（旧端）自动退化为从头传，协议向前兼容；
  - **隐私边界**：暂存的是「本端本来就要收下的文件」的明文分片，等效于浏览器磁盘缓存；密钥/会话
    材料永不落盘；文件面板提供「清除本地暂存」一键擦除；SHA-256 校验是最终防线 ——
    续传偏移与对端状态不一致时必然导致 digest 不匹配而被拒绝（不会静默产出坏文件）。
- 反压：`bufferedAmount > 1MB`（HIGH_WATER）挂起等 `bufferedamountlow`（阈值 256KB），5s 超时兜底（`drainOnce`）。
- 接收完成：重组 Blob → 重算 SHA-256 → 与 `meta.digest` 比对 → `digestOk` 写入 TransferState 与 UI。

---

## 3. 威胁模型

### 3.1 各角色可见性

| 角色 | 能看到 | 不能看到 |
|---|---|---|
| 信令服务器（:3003） | 房间号、peerId、昵称、**公钥与公钥指纹**、SDP/candidate 元数据（长度/类型，`relay_signal` 只记字节数）、连接时间线、UA 前 120 字符 | 私钥、ECDH 共享秘密、8 把会话密钥、媒体明文帧、文件明文/文件名、聊天明文。SDP 内容虽经服务器转发，但 SDP 不含应用层密钥材料（ICE 凭证为 DTLS 层临时值） |
| TURN 中继（coturn :3478） | 加密后的 SRTP 包/SCTP 包的地址与流量特征（大小/时序） | 任何应用层明文（DTLS-SRTP + 帧级 GCM 双层加密） |
| 网络路径攻击者（被动窃听） | 同上流量特征 | 明文内容（两层加密：DTLS-SRTP 传输层 + AES-256-GCM 应用层） |
| 页面 XSS / 本地攻击者 | 页面内存中的密钥（这是端点威胁，超出 E2EE 防护范围） | —（E2EE 不防端点沦陷） |

### 3.2 MITM 防护与**局限（必须明示）**

- **当前机制是“可验证 + 口令认证”的双层密钥协商**：
  - ECDH 是匿名 Diffie-Hellman，信令层中间人理论上可分别与两端协商（_public key substitution_）。
  - 缓解一（自动，第 14 轮新增）：**SPAKE2 PAKE 口令认证**（`spake2.ts`）——设置房间口令后，双方在密钥派生前
    完成零知识口令互证（同口令 → 同密钥；异口令/中间人替换共享值 → 互证失败 → **拒绝建立会话** fail-closed，
    UI 弹窗 + 聊天系统提示 + 加密面板红色徽标）。口令公开值 X/Y 不泄露口令（离线字典攻击不可行，Z 含双方随机数）。
  - 缓解二：**安全码带外核对**——双方通过电话/见面比对 `safetyNumber` 输出；中间人替换公钥必然导致两侧安全码不一致。
  - 缓解三：**房间口令参与盐派生**——`roomSalt` 把口令混入 HKDF salt（与 PAKE 双重独立绑定口令）。
- **明示局限**：
  1. **未设口令时无自动认证**：无共享秘密即无 PAKE 语义；此场景必须人工核对安全码（缓解二）。
  2. SPAKE2 为自研 BigInt 参考实现（JS BigInt 非常量时间）：作为教学/参考实现可接受，
     生产化建议替换为经审计的常量时间库（见 ROADMAP P3）。
  3. 前向保密为**简化版**（P0-2 已落地，第 12/13 轮）：媒体帧与 DataChannel（聊天/文件）均已是
     epoch 轮换链（HKDF 链 + 帧内 epoch 自描述），单帧密钥泄露不影响后续纪元；但仍非 Signal 式
     双棘轮（无每消息 DH 新鲜度），DH 轮换演进见 ROADMAP。
  4. mesh 房间内口令是**共享房间级**认证（同一 roomId+口令），不是每对端独立身份认证。
  5. **断点续传的本地暂存为明文分片**（第 15 轮新增）：接收端把未完成文件的已收分片存 IndexedDB，
     等效于浏览器磁盘缓存；不存密钥/会话材料；可一键清除；跨设备不会同步。若不接受，
     可在隐私浏览模式使用（IndexedDB 随会话丢弃）。

---

## 4. 验证方法（分四层）

### 4.1 页面「加密自检」按钮（无摄像头/无信令依赖，selftest.ts）

大厅页 `SelfTestCard` → `controller.runSelfTest()` → `runSelfTest()`（`src/lib/webrtc/selftest.ts`）。9 个步骤各验证什么：

| 步骤 | 名称 | 验证内容 | 通过判据 |
|---|---|---|---|
| S1 | 密码学原语（ECDH/HKDF/AES-GCM） | 两个临时身份 A/B 各自派生方向密钥：`rawAB.fileOut === rawBA.fileIn`（同一 info `veiltalk:file:A:B` 两侧独立推导一致）；A 用 `fileOut` 加密 → B 用其视角 `fileIn` 解密往返一致 | `same && roundtrip` |
| S2 | 指纹与安全码确定性 | 同一 JWK 两次 `fingerprintJwk` 结果一致；`safetyNumber` 输出匹配 `/^[0-9A-F-]+$/` | 两个断言同时成立 |
| S3 | WebRTC 本地回环建连 | 两个 RTCPeerConnection 经 `LoopLink`（ICE 候选缓冲，防候选早于远端描述）直连交换 SDP/ICE；显式一次性协商避开 `onnegotiationneeded` 双触发竞态 | 8s 内 `pcB.connectionState === 'connected'` |
| S4 | 帧级 E2EE 媒体管线 | Canvas 合成动画（320×180@15fps，无摄像头）→ `captureStream` → 编码帧经 worker `transformEncode`（随机 32B 轮换种子，pipeId 隔离）→ 对端 `transformDecode` → 统计帧数 | 15s 内 `workerEncrypted > 5 && workerDecrypted > 5`（丢弃应为 0），报告 `mode=encoded-streams/script-transform` |
| S5 | 加密 DataChannel 文件往返 + 显式回执 | 独立派生文件种子 → `DcKeyRing` 轮换环 → `FileSender`（256KB 随机数据，`randomU8` 分段规避 getRandomValues 65536B 上限）→ DC 传输（epoch 帧头）→ `FileReceiver` 解密重组 → SHA-256 比对 → `file-ack` 回执返回发送端 | `status==='done' && digestOk===true && 对端回执===true` |
| S6 | 密钥轮换链（epoch 推进后往返） | ① `epochKeyRaw(seed,0)` 两次派生一致且与 epoch1 不同（HKDF 链确定性）；② `forceRotate` 编码管线后解码端按帧内 epoch 自动跟随，解密不中断 | `k0same && k0diff && sawRotation && 轮换后新解密帧 > 0` |
| S7 | DataChannel 轮换链（epoch 帧往返，第 13 轮新增） | ① 发送环 epoch0 加密 → 接收环按帧内字节解析派生解密往返；② `rotate()` 后 epoch1 新帧仍可解；③ **跨纪元隔离**：epoch0 旧密钥解不开 epoch1 密文（前向隔离） | `round0 && round1 && isolated` |
| S8 | SPAKE2 PAKE（口令认证密钥协商，第 14 轮新增） | ① 同口令：A/B 两侧 K 一致且双向互证通过；② 异口令：K 不同 + 证明被拒（fail-closed 核心）；③ 非法点（不在曲线上）拒绝；④ 绑定层 HKDF 确定性/差异 | `sameKey && proofAok && proofBok && diffKey && proofRejected && rejected && bindSame && bindDiff` |
| S9 | 断点续传暂存（IndexedDB 往返 + offset 对齐，第 15 轮新增） | ① `alignResumeOffset` 块边界对齐（非边界向下取整/非法值归零/自定义块大小）；② 写入暂存 → 读回字节级一致（含元数据）；③ 删除后读回为空 | `alignOk && roundTripOk && goneOk`（写入暂存成功与否均可，写入失败时逐字段验证降级） |

预期输出：`9/9 通过`（第 15 轮沙箱实测：S4 加密 31/解密 42/丢弃 0、S5 digestOk=true + 对端回执=true、S6 轮换后 30 帧新解密、S7 epoch0/1 往返 true + 旧密钥隔离 true、S8 六断言全 true 26ms、S9 写入 true/往返 true/擦除后空 true/对齐 true 14ms）。

### 4.2 双端安全码核对（操作步骤）

1. 两个浏览器（或两个标签页）分别打开站点，**用相同房间号、相同口令**（如都填 `test1234`）入房。
2. 各自打开右侧面板 →「加密」页签（`crypto-panel.tsx`）。
3. 双方各自核对：对方卡片下方的 6 组安全码（如 `BBE9-C9F3-4A7F-4753-4CDA-D7F5`）是否与自己界面上对端安全码一致（理想方式：电话/其他即时通道人工比对）。
4. 一致 → 点「标记已核对」（本地 UI 标记，不上传）。
5. 反向验证中间人效应（教学用）：让其中一方用**不同口令**重进房间 → 双方安全码必然不一致 → 说明口令确实参与密钥派生。

### 4.3 抓包与浏览器内证

**a) 服务器视角（信令层）**

```bash
# 台账里只有元数据：确认没有任何密钥/SDP 内容/文件事件
curl -s 'http://localhost:3004/svc/ledger?limit=50' | python3 -m json.tool
# 观察信令 WebSocket 帧（内容为密文 SDP/公钥，不含会话密钥）：
tcpdump -i lo -A 'tcp port 3003' | grep -a 'join-room\|signal'   # 仅示意，生产用 wscat 代理
```

**b) 网络视角（媒体层，P2P 流量无明文）**

```bash
# 找到 WebRTC 使用的 UDP 端口（浏览器随机高位端口）
sudo tcpdump -i any udp and portrange 30000-60000 -w capture.pcap
# Wireshark 打开 capture.pcap：
#   - 过滤 rtp：payload 全部为密文（帧级 GCM 之后 SRTP 再次加密），看不到视频明文特征
#   - 若走 TURN 中继：仅见与 coturn :3478 的加密 ChannelData
```

**c) 浏览器内部证**

- 打开 `chrome://webrtc-internals` → 找到 outbound-rtp / inbound-rtp：
  - 帧正常解码（`framesDecoded` 持续增长）证明 worker 管线在跑；
  - `codec` 统计中可见 Insertable Streams 生效（帧负载被替换为密文）；
  - 断开对端密钥（如一方换口令重进）→ 对端 `framesDecoded` 停止增长、页面 E2EE 统计 `dropped` 上涨 → 直接证明 fail-closed。
- 页面「加密」面板：`帧统计 加密 N · 解密 M · 丢弃 K` 持续增长即帧级 E2EE 生效（数据来自 `e2eeManager.onStats`，源头是 worker 每 2s 的 `postMessage({op:'stats'})`）。

### 4.4 agent-browser 可脚本化验证（示例片段）

```bash
# 1) 打开页面并触发自检，读取结果（Chromium headless 亦无摄像头依赖）
agent-browser eval "
  (async () => {
    const { runSelfTest } = await import('/src/lib/webrtc/selftest.ts'); // 或经 window 暴露
    const r = await runSelfTest();
    return r.results.map(x => x.name + '=' + x.ok).join(' | ');
  })()"

# 2) 双标签页互通 + 安全码一致性（两份 context 各开一页，读 store）
agent-browser eval "JSON.stringify({
  phase:    useVeil.getState().phase,                 // 'in-room'
  e2eeMode: useVeil.getState().e2eeMode,              // 'encoded-streams'
  peers:    Object.values(useVeil.getState().peers).map(p => ({
              name: p.name, connState: p.connState,   // 'connected'
              safety: p.safety,                        // 与对端页面比对
              e2ee: p.e2ee }))})"                      // {video:'encoded-streams',...}

# 3) 帧统计增长断言（间隔 3s 两次采样）
agent-browser eval "
  const s1 = useVeil.getState().e2eeStats;
  await new Promise(r => setTimeout(r, 3000));
  const s2 = useVeil.getState().e2eeStats;
  (s2.encrypted > s1.encrypted && s2.decrypted > s1.decrypted) ? 'E2EE-ACTIVE' : 'E2EE-IDLE'"
```

> 注：片段中 `useVeil` 需在页面可访问（调试挂载或经组件注入）；生产自动化可改为读取 DOM 中安全码/统计文本。

---

## 5. 浏览器兼容矩阵

| 浏览器 | 帧级 E2EE 路径 | 检测方式（`detectCapability()`） | 结果 |
|---|---|---|---|
| Chrome / Edge / 其他 Chromium（Chrome 86+，Encoded Transform） | `RTCRtpSender/Receiver.createEncodedStreams()` → 流转移进 worker | `RTCRtpSender.prototype.createEncodedStreams` 存在 → `'encoded-streams'` | ✅ 完整帧级 E2EE（本沙箱 HeadlessChromium 152 实测） |
| Firefox 117+ / Safari 15.4+（标准 W3C RTCRtpScriptTransform） | `sender/receiver.transform = new RTCRtpScriptTransform(worker, {mode, key})`；worker 侧 `onrtctransform` 接管 | `'RTCRtpScriptTransform' in window` → `'script-transform'` | ✅ 完整帧级 E2EE（代码路径已实现，待真机回归，见 TESTING.md） |
| 不支持两者的旧浏览器 | 无帧级加密，**自动降级** | 两者皆无 → `'unsupported'` | ⚠️ 降级为 DTLS-SRTP 传输层加密（仍是 WebRTC 默认加密，但非端到端）；UI 与日志明确提示，页面仍可文件/聊天（DataChannel 侧与浏览器无关，始终 AES-GCM 加密） |

补充：

- 降级是**按浏览器能力**整体判定（`room-client.ts` rejoin 时记录 `e2eeMode`，`peer-session.ts` 中若 `rawKeys` 为空字节（byteLength 0）则跳过接线——媒体密钥不可用时 attach 不执行）。
- `bundlePolicy: 'max-bundle'`：单端口复用全部媒体，利于防火墙放行。
- DataChannel（SCTP over DTLS）在所有现代浏览器行为一致，文件/聊天加密不依赖上述两条路径。

---

## 6. 常见问题（排障速查）

| 现象 | 可能原因 | 定位 |
|---|---|---|
| 双端画面花屏/黑屏，`dropped` 上涨 | 双方口令不一致 → 密钥不同 → 解密失败 | 核对口令；`crypto-panel` 帧统计；日志 `crypto` 级 |
| 仅 key 帧解密失败（delta 正常） | 帧内 AD 与发端不一致（v1 遗留，已修复） | 确认双方为同一部署版本（v2 帧格式 `[epoch|iv|ct|tag]`） |
| 安全码不一致 | 口令不同或（理论）中间人 | §4.2 步骤 5 复核 |
| 自检 S4 一直 0 帧 | 浏览器不支持两条帧加密路径 | `detectCapability()` 返回 `unsupported`；换 Chromium/Firefox 新版 |
| 文件传输卡在 transferring | DC 反压未释放或对端未确认 | 日志 `net`；`bufferedAmount` 观察；5s 兜底会继续 |
| 换口令后旧消息仍可读 | 聊天密钥按会话缓存（`chatKeysCache`） | 属预期；重进房间重建会话即用新盐 |
