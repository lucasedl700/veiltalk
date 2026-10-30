# VeilTalk 后续发展路线图

> 每项按「目标 / 价值 / 拆解步骤 / 验收标准 / 预估工作量」描述。优先级：P0（安全与扩展性的根本瓶颈）→ P1（产品体验）→ P2（运维与工程化）。依赖关系见 §4。

---

## P0-1 SFU 多方架构迁移（mediasoup）

- **目标**：把 mesh（每房间 ≤8 人，上行 = N-1 路）升级为 SFU 转发，支持 20+ 人房间，客户端上行恒为 1 路。
- **价值**：mesh 上行带宽随人数线性膨胀（8 人 ≈ 7×上行），移动端不可用；SFU 是所有规模化视频产品的标准形态。E2EE 端到端属性可保留（SFU 只转发密文帧，密钥仍双端协商）。
- **选型理由（mediasoup）**：Node.js 生态与现有信令服务（socket.io）同语言；成熟（GitHub 万级 star）；支持 Simulcast/SVC/码率控制； librtp 层面透传字节，**不解析媒体内容**，兼容 Insertable Streams 帧级 E2EE（对比：Janus/GStreamer 管线同样可行但集成面更大；LiveKit Go 技术栈不一致且自带 SFU 侧密钥体系，与自研 E2EE 冲突）。
- **拆解步骤**：
  1. 新增 `mini-services/sfu-service`（mediasoup，announced IP / RTC_MIN_MAX_PORT 配置进 compose）；信令服务增加 `sfu-router` 事件：`produce / consume / pause / resume` 转发。
  2. `room-client.ts` 抽象 `Transport` 接口：`mesh`（现 `PeerSession`）与 `sfu` 两实现；`createSession` 改为工厂。
  3. 帧级 E2EE 保持：SFU 模式下每端仍与每个消费者 ECDH 协商（公钥经 SFU 信令转发，mediasoup 只见密文 RTP），或简化为房间级群密钥（配合 P0-2 轮换）。
  4. Simulcast 三层编码 + 接收端按需切层（`diagnostics-panel` 增加层选择）。
  5. 台账新增 `sfu_produce/sfu_consume` 元数据事件（字节数/层，不含内容）。
- **验收标准**：8 人房间每端上行 ≤1.2×单流码率；20 人房间 CPU/带宽达标；帧级 E2EE 统计（`e2eeStats`）在 SFU 模式下仍增长；mesh/SFU 可配置切换（`NEXT_PUBLIC_TRANSPORT=mesh|sfu`）。
- **预估工作量**：3~4 周（1 人；其中 E2EE 与 SFU 的组合调试约 40%）。

## P0-2 E2EE 密钥轮换与前向保密（双棘轮简化版）

> **进度：已完成（简化版，第 12/13 轮）** —— 媒体帧部分（第 12 轮）：e2ee.worker v2 per-pipe
> 轮换链（epoch 帧 + HKDF 链 + 1024 帧/5 分钟自动轮换 + force-rotate + 自检 S6）。
> DataChannel 部分（第 13 轮）：`dc-ratchet.ts` 聊天/文件四方向独立轮换环（HKDF(seed,
> "veiltalk:dc-epoch:N")），文件块帧头 1B epoch / 聊天 JSON `e` 字段自描述，接收端自主派生
> 无需信令；5 分钟懒自动轮换 + 手动轮换（诊断面板「轮换传输密钥」）；旧纪元密钥窗口外销毁；
> 自检 S7 验证跨纪元往返与旧密钥隔离。剩余演进：Signal 式双棘轮 DH 轮换（每消息新鲜 DH）。

- **目标**：会话密钥从「一次 ECDH 派生、全程不变」升级为周期轮换 + 单向链式推进，泄露窗口最小化。
- **价值**：当前一把方向密钥用整个会话（见 `crypto-core.ts` `deriveRawKeys`）；引入 KDF 链后，即使某一帧密钥泄露也无法解密后续帧（前向保密），也无法回溯既往帧（后向保护）。
- **拆解步骤**：
  1. 新增 `src/lib/webrtc/ratchet.ts`：每（方向,媒体类型）维护 `chainKey`，`messageKey = HKDF(chainKey, info="step:N")`，用后即弃；每 1024 帧 / 5 分钟执行 `chainKey = HKDF(chainKey, "epoch")`。
  2. `e2ee.worker.ts` 消息协议扩展：`{op:'e2ee', key, epoch}` 支持热替换密钥（现 `ensureKey` 已支持重复注入，天然兼容）；帧头（明文 IV 前）附 1 字节 epoch 序号，解密端按 epoch 选 key。
  3. DataChannel（文件/聊天）同步：`file-meta` 增加 `epoch` 字段；`RoomClient` 定时 `emit('key-rotate')`（经信令只传 epoch 序号，不传密钥）。
  4. 双棘轮简化：DH 轮换每 N 分钟以新临时 ECDH（`generateIdentity()` 复用）替换 chain root；信令服务器只见新公钥。
  5. 兼容：epoch 缺失（旧端）→ 回退静态密钥路径；台账不新增敏感字段。
- **验收标准**：双端长会话中每 5 分钟 epoch 递增；中途录制密文流量用旧密钥不可解；丢帧率（`dropped`）无异常上涨；自检扩展 S6「轮换后往返」通过。
- **预估工作量**：1.5~2 周（1 人）。

## P0-3 PAKE 口令认证（SPAKE2）✅ 已完成（第 14 轮）

- **实现结果**（`src/lib/webrtc/spake2.ts` + `room-client.ts`）：
  1. 自研 SPAKE2（P-256 BigInt 雅可比坐标，RFC 9383 语义）：`spakeStart`（X=x·G+w·M / Y=y·G+w·N）→
     `spakeComputeKey`（Z=x·y·G，K=SHA-256(Z‖transcript)，HMAC 证明）→ `spakeVerifyProof`（互证）；
     M/N 常量用 hash-and-check 从域分隔字符串确定性派生（nothing-up-my-sleeve，两端同源即安全）。
  2. 握手接入：设口令时 ECDH 秘密必须先过 PAKE 互证才可派生会话密钥 —— 绑定层
     `bindPakeSecret` = HKDF(ikm=sharedBits, salt=SPAKE2-K, info="veiltalk:pake-bind:v1")；
     互证失败/非法点/超时 8s → 不建立会话（fail-closed），toast + 聊天系统提示 + 加密面板红色徽标。
  3. 信令零改动（SPAKE2 共享值/证明走 signal 通道 `t:'spake-share'/'spake-confirm'` 透传，公钥同级公开值）。
  4. UI：加密面板每对端 PAKE 状态徽标（已验证/验证中/验证失败/未设口令）+ 密码学配置「口令认证」行。
- **验收（已实测）**：自检 S8 六断言全过（同口令密钥一致+双向互证/异口令密钥不同+证明拒绝/非法点拒绝/绑定层确定）；
  双端同口令 → PAKE verified + 聊天文件互通；双端异口令 → 两侧均 fail-closed 无会话 + 明确提示；无口令房间行为不变。
- **残余演进**（非阻塞）：JS BigInt 非常量时间（参考实现可接受，生产化可换审计库）；OPAQUE（含 OPRF）
  适合未来账号体系；每消息 DH 双棘轮见 P0-2 残余。

---

## P1-1 通话录制（本地 MediaRecorder + 加密存储）

- **目标**：任一端可本地录制（含远端画面混流），落盘前 AES-GCM 加密。
- **价值**：合规留档需求；加密存储避免本地泄露。
- **拆解**：① `MediaRecorder(new MediaStream([本地轨, ...远端轨]))`（canvas 合成或 AudioContext 混音）② 录制 chunk 经 `encryptFrame(recordOut 密钥)` 追加写 ③ 密钥 = 现有 HKDF 增加 `veiltalk:record:<from>:<to>` 派生（不改 `RawKeySet` 结构亦可复用 fileOut，但建议独立）④ 录制清单写入 `veil-store.transfers` 类似结构。
- **验收**：录制文件仅本端密钥可解；停止后可下载、SHA-256 可校验；对方无感知差异。
- **工作量**：1 周。

## P1-2 虚拟背景与降噪（WebAssembly / Insertable Streams 处理）

- **目标**：帧级管线里加处理插件：背景分割（MediaPipe Selfie Segmentation WASM）+ RNNoise 降噪（WASM）。
- **价值**：隐私保护（居家环境遮蔽）+ 弱麦克风质量提升；复用现有 worker 架构。
- **拆解**：① `e2ee.worker.ts` 前增加 `transform.worker.ts` 处理链（encode 前：帧 → 模型推理 → 合成）② 音频用 AudioWorklet + RNNoise WASM ③ 设置面板开关 + 模型懒加载（CDN 或本地 public）④ 性能预算：1080p 帧处理 ≤8ms。
- **验收**：开启背景后端到端画面正常、E2EE 统计不中断；CPU 增幅 <30%；开关即时生效（`replaceTrack` 或参数热切）。
- **工作量**：2 周（模型调优另计）。

## P1-3 移动端 PWA

- **目标**：可安装到主屏、离线壳、横竖屏适配；iOS Safari 15.4+ 兼容。
- **拆解**：① `manifest.json`（name/theme/icon 192+512）② Service Worker（壳缓存，`/` 与静态资源 stale-while-revalidate；**不缓存** `/api/ice-config`、信令 WS）③ `display: standalone` + viewport 收尾（已有 390px 基础）④ iOS 特有：`webkit-playsinline`、屏幕共享不可用时的按钮隐藏（能力检测）。
- **验收**：Lighthouse PWA 四项通过；断网打开有壳页；iOS 真机通话 10 分钟无断流。
- **工作量**：3~5 天。

## P1-4 i18n（国际化） ✅ 已完成（第 16 轮）

> **实现结果**（自研轻量方案而非 next-intl，理由：单路由 App Router 无 locale 路由诉求、
> 客户端无刷新即时切换、零依赖、字典即对象属性访问获得完全类型安全）：
> 1. `src/lib/i18n/`：types（Lang/Vars）→ packs/core|shell|panels（zh 事实源 + en `typeof zh`
>    编译期强制形状一致，共 ~470 key × 2 语言）→ index（合并 + dictFor + fmt 插值 + pageTitle）
>    → use-dict（useDict hook + LangBoot 引导：URL ?lang= > localStorage `veil-lang` > zh）
> 2. `veil-store`：`lang` + `setLang`（持久化 + 同步 `<html lang>` 与 document.title）
> 3. header-bar：语言切换按钮（zh ⇄ en 无刷新，veil-lang-flip 图标动效 + veil-lang-swap 文案淡入）
> 4. 全组件文案字典化（20 组件 + controller.ts 副作用 toast/pushLog/系统聊天全部走 t.toasts）；
>    注释保持中文；selftest.ts 的 S1~S9 detail 技术串与 quality.ts 网络档位 label 暂保留中文（下轮可收尾）
> 5. 台账事件名保持英文 key 不翻译（机器可读优先，符合原拆解）
> - **验收**：`?lang=en` 全站英文 ✓；lint/tsc 0 error ✓；组件用户可见文案无中文残留 ✓

## P1-5 房间口令改链接片段（`#pass`，不经服务器）

> **进度：已完成并验证（第 12 轮 QA）** —— 大厅读取 `#pass=` 自动填入口令并清除 URL 片段；
> 创建侧勾选「把口令包含在邀请链接中」后邀请链接/QR 携带 `#pass=`；服务器与台账无口令痕迹。
- **目标**：邀请链接形如 `https://host/?room=xxxx#pass=yyyy`——`#` 后内容浏览器**永不上传**（HTTP 请求不含 fragment），口令分发彻底绕开服务器与网络日志。
- **拆解**：① `lobby.tsx` 读取 `location.hash` 填入口令框（现只读 `?room=`）② 创建成功后生成含 `#pass=` 的邀请链接复制按钮 ③ `veil-store.passphrase` 保持仅内存 ④ 文档同步（`E2EE.md` §3.2 口令分发面收窄）。
- **验收**：服务器 access log / 台账 / `relay_signal` 中均无口令痕迹；带 `#pass` 链接打开自动入对口令房间。
- **工作量**：1 天。

---

## P1-6 文件断点续传 ✅ 已完成（第 15 轮）

- **实现结果**（`src/lib/webrtc/transfer-db.ts` + `file-transfer.ts` 握手扩展 + 文件面板 UI）：
  1. 接收端把已收明文分片按文件 SHA-256（digest）为键定期暂存 IndexedDB（每 16 块/256KB，
     暂停/取消/失败时也落盘）；传输校验通过后立即擦除；IndexedDB 不可用时优雅降级（从头传）；
  2. 续传握手：`file-meta.resumable:true` → 接收端按 digest 查暂存 → 回 `file-resume-sync{have}` →
     发送端 `alignResumeOffset` 对齐块边界后跳过已收分片；无响应自动退化为从头传（向前兼容）；
  3. 发送端失败保留 File 登记，UI「续传」按钮一键重发（重发内容变化则 digest 不匹配自动失效）；
  4. 正确性核心：persistOnce 同步接管 parts 所有权后再异步写盘（`await` 窗口内到达的分片
     进新数组不丢）；finish 排空串行链 + finishing 执行器守卫（防删除后重建陈旧记录）；
  5. UI：失败发送「续传」按钮（琥珀脉冲）、「已续传 X%」徽标、接收端暂存提示条、
     本地暂存计数页脚 + 一键清除；自检 S9（IndexedDB 往返 + offset 对齐）。
- **验收（已实测）**：发送 4MB → 中途取消 → 暂存 82%；重发同文件 → 「已续传 82%」徽标 +
  双端 SHA-256 一致 + 暂存自动清零；全新文件传输/聊天行为不变；自检 9/9。
- **残余演进**：发送端页面刷新后 File 引用丢失不可续传（需重新选择文件）；「对端已收到」标签
  为发送端乐观推断（无对端 ack 协议），可演进为显式 file-ack。

---

## P2-1 TURN REST API 时间限凭证 ✅ 已完成（第 15 轮）

- **实现结果**（`src/lib/turn-credentials.ts` + `/api/ice-config`）：
  1. `issueTurnRestCredential(secret, ttl)`：coturn REST 约定签发（`username=<过期时间戳>:veiltalk`，
     `credential=base64(HMAC-SHA1(secret, username))`）；TTL 边界钳制 60s~24h（默认 3600s）；
  2. `/api/ice-config` 检测到 `TURN_SHARED_SECRET` 即自动切 REST 模式（响应带 `turnMode:"rest"`
     与 `ttl`）；未配置时回退长期凭证（`turnMode:"long-term"`）或纯 STUN（`none`），完全向后兼容；
  3. 响应 `Cache-Control: no-store` 防中间层缓存凭证；secret 永不出服务器；
  4. 部署侧：coturn 开 `use-auth-secret + static-auth-secret`（两种机制互斥），
     `deploy/coturn/turnserver.conf` 与 `DEPLOYMENT.md §6.2` 已同步。
- **验收**：签发函数与 node crypto 参照实现交叉验证一致（格式/base64 长度/TTL 钳制/secret 敏感性）；
  未配 secret 时 ice-config 响应 `turnMode:"none"` 行为不变；生产启用步骤见 DEPLOYMENT.md §6.2。

---

## P2-2 Prometheus 指标

- **目标**：信令/SFU 暴露 `/metrics`：房间数、peer 数、`signal_drop_oversize` 计数、relay 字节、台账写入延迟。
- **拆解**：`signaling-service` 加 prom-client → 指标与台账同源统计 → Grafana 面板模板 → compose 增 prometheus + grafana 可选 profile。
- **验收**：`/svc/health` 语义不变；Grafana 看板呈现房间/peer 曲线；告警规则示例（见 LOGGING.md §3）可导入。
- **工作量**：3~4 天。

## P2-3 信令集群（Redis adapter）

- **目标**：socket.io 多实例水平扩展（`@socket.io/redis-adapter`），房间跨实例广播。
- **拆解**：compose 增 redis → adapter 接入（emit 广播自动跨实例）→ 房间状态仍单实例内存（`rooms Map`）需改 Redis 存储或粘性会话（sticky by roomId）→ 压测 1k 连接。
- **验收**：两实例下跨实例互通；kill 单实例，成员自动重连重组（现有 rejoin 逻辑直接受益）。
- **工作量**：1 周（含房间状态外置重构）。

## P2-4 Electron 壳

- **目标**：桌面端安装包（Win/macOS/Linux），获得真实设备枚举更稳的权限与开机自启。
- **拆解**：electron + 打包现有 Next standalone（或远程加载 :81）→ `session.setPermissionRequestHandler` 预授权媒体 → 自动更新（electron-updater）→ 代码签名。
- **验收**：三平台安装即用；与 Web 版互通；帧级 E2EE 生效（Chromium 内核走 encoded-streams）。
- **工作量**：1 周。

## P2-5 审计台账签名链

- **目标**：台账 JSONL 每行附 `prevHash + hash`（SHA-256 链），实现防篡改审计。
- **拆解**：`appendLedgerFile` 前计算 `hash = SHA256(prevHash + JSON.stringify(entry))` 写入行尾字段 → `/svc/ledger` 返回链校验接口 `?verify=1` → 日轮转时封存 `ledger-<date>.jsonl.sha256`。
- **验收**：篡改任意一行后续校验全部失败；回放脚本可离线验证整日台账。
- **工作量**：2~3 天。

---

## 优先级排序建议与依赖关系

```
P0-3 PAKE ✅─────────┤（口令认证已落地：SPAKE2 自动互证 + fail-closed；OPAQUE/双棘轮为后续演进）
P0-2 密钥轮换 ✅────┼→ epoch 机制已定型（媒体帧 + DataChannel 双链），P0-1 群密钥可在此基础上设计
P0-1 SFU(mediasoup)─┘（最大工程量；依赖轮换机制定型后一并设计群密钥）

P1-6 断点续传 ✅ ── P2-1 TURN 短期凭证 ✅（第 15 轮：产品层 + 运维安全各进一步）
P1-3 PWA ── P1-4 i18n（无依赖，可并行）
P1-1 录制 ── P1-2 背景降噪（都挂在帧处理链上，建议 P1-2 的 worker 管线先落）
                 ↓
P2-* 运维向（Prometheus 依赖 P2-3 集群前的单机指标基线；TURN 凭证已落地）
```

推荐节奏：~~P1-5 → P0-3 → P0-2 → P1-6 → P2-1 → P1-4~~（均已完成）→ **P1-3 PWA 收尾 → P0-1 SFU（3~4 周，最大单项）→ P1-1/P1-2 → P2 按运维需求拉动**。

判断依据：安全短板（无 PAKE、无前向保密）已修复，E2EE 核心机制（认证 + 轮换 + 帧加密）已定型；产品层 i18n ✅ / 续传 ✅ / file-ack ✅（第 16 轮），仅剩 PWA 细节；规模化（SFU）迁移工程量大且会重塑信令协议，放在密钥机制定型之后可避免二次返工。
