# VeilTalk 跨浏览器 / 跨网络测试清单与结果记录

> 执行环境说明（如实）：本沙箱验证使用 **agent-browser + Chromium headless（HeadlessChrome/152）**，经 Caddy :81 网关全链路进行；无法覆盖真实摄像头/麦克风、真实移动设备与非 Chromium 内核浏览器。未覆盖项全部标注「**待真机跨浏览器执行**」并在文末给出执行步骤。

---

## 1. 测试矩阵（计划覆盖）

图例：✅ 已验证 · 🟡 部分验证（代理/headless 限制）· ⬜ 待真机执行

| # | 浏览器 \ 网络 | 同网 host 直连 | 跨网 srflx（打洞） | 严格 NAT relay（TURN） | 仅数据模式（无摄像头） |
|---|---|---|---|---|---|
| 1 | Chrome（最新 stable） | ✅（host，headless） | ⬜ 待真机 | ⬜ 待真机（需公网 coturn） | ✅ |
| 2 | Edge（最新 stable） | ⬜ 待真机 | ⬜ 待真机 | ⬜ 待真机 | ⬜（Chromium 内核，预期同 Chrome） |
| 3 | Firefox（117+） | ⬜ 待真机（script-transform 路径） | ⬜ 待真机 | ⬜ 待真机 | ⬜ 待真机 |
| 4 | Safari（15.4+，macOS/iOS） | ⬜ 待真机（script-transform 路径） | ⬜ 待真机 | ⬜ 待真机 | ⬜ 待真机 |

补充矩阵维度：mesh 多人（3~8 人）、双端同时收发文件、口令房间一致性、断线恢复。以上在 Chromium 已抽验，其余浏览器待真机。

---

## 2. 功能检查单（26 条）

### 房间与信令
| # | 检查项 | 预期 | 状态 |
|---|---|---|---|
| 1 | 创建房间（骰子按钮 `randomRoomId()`） | 生成 9 位小写字母数字房间号 | ✅ |
| 2 | 手动输入房间号加入 | `roomId.length < 4` 前端拦截；服务端 `ROOM_ID_RE ^[A-Za-z0-9_-]{4,64}$` 兜底 | ✅ |
| 3 | 非法房间号（含空格/中文/`%` 等） | ack 返回 `房间号格式非法（4-64位字母数字）`，`phase` 回 lobby | ✅ |
| 4 | URL 邀请 `?room=xxxx` | lobby 自动填入房间号 + toast 提示 | ✅ |
| 5 | 口令房间（双方同口令） | 安全码一致；不一致口令 → 安全码不一致 | ✅ |
| 6 | 房间满 8 人 | 第 9 人 ack 报 `房间已满（上限 8 人，mesh 模式）` | ⬜ 待真机（需 9 个真实端） |
| 7 | 对端入房通知 | 老成员收到 `peer-joined`，成员列表 +1 | ✅ |
| 8 | 对端离房 | `peer-left` → 瓦片移除、流清理、台账 `peer_leave` | ✅ |
| 9 | 主动离开（leave-room） | 回 lobby、`clearSensitive()`、台账 cause=voluntary | ✅ |

### 媒体
| # | 检查项 | 预期 | 状态 |
|---|---|---|---|
| 10 | 摄像头/麦克风采集 | 720p30 理想值；AGC/NS/EC 开启 | 🟡（headless 无设备 → 走降级路径验证） |
| 11 | 静音/关摄像头（toggleTrack） | `track.enabled=false`，对端黑帧/静音 | ⬜ 待真机 |
| 12 | 屏幕共享（getDisplayMedia + replaceTrack） | 视频轨替换，E2EE 对新轨自动生效，停止后恢复摄像头 | ⬜ 待真机（headless 无显示器） |
| 13 | 设备切换（switchDevice） | `replaceTrack` 热切换不重协商 | ⬜ 待真机（需多设备） |
| 14 | 采集失败降级「仅数据模式」 | `mediaError` 提示，文件/聊天仍可用 | ✅（headless 即此路径） |
| 15 | 弱网自适应降码率 | 丢包 >8% 或 RTT >420ms → 沿 [2500,1600,1000,600,350,180] 阶梯降；30s 稳定后回升 | 🟡（代码路径存在，弱网注入见 §5，待注入实测） |

### 文件传输
| # | 检查项 | 预期 | 状态 |
|---|---|---|---|
| 16 | 小文件双向传输 | 完成、可下载 | ✅（256KB，自检 S5） |
| 17 | 1MB 文件 SHA-256 一致 | `digestOk=true`，哈希 `1adec23c…`（实测样例） | ✅ |
| 18 | 大文件（>100MB） | 反压正常（1MB 高水位 + bufferedamountlow + 5s 兜底）、速度稳定 | ⬜ 待真机（headless 内存受限） |
| 19 | 并发/排队多文件 | `FileSender` 串行队列逐个发送 | ✅（排队逻辑 + 单并发验证） |
| 20 | 传输中途取消 | `file-cancel` → 双端 status=cancelled | ✅ |
| 21 | 解密失败处理（口令不一致） | 块解密失败 → status=failed + 错误日志，不产出损坏文件 | ✅（fail-closed 逻辑验证） |

### 聊天与台账
| # | 检查项 | 预期 | 状态 |
|---|---|---|---|
| 22 | 加密聊天互通 | 明文仅两端可见；信令/台账无聊天事件 | ✅ |
| 23 | 台账可查（面板 + API） | `/svc/ledger` 与面板日期切换、导出正常 | ✅ |

### 连接健壮性
| # | 检查项 | 预期 | 状态 |
|---|---|---|---|
| 24 | 信令断线重连 | 自动重连（Infinity 次）→ `rejoin()` 重建会话；窗口期信令经 `pendingSignals` 重放 | ✅（重放逻辑验证） |
| 25 | ICE 重启（手动按钮 + failed 自动 restartIce） | 连接恢复 | 🟡（代码路径验证，弱网实况待测） |
| 26 | 页面刷新重连 | 刷新 = 新身份（会话级密钥）+ 自动重入房（peerId 重新生成、socket 重连） | ✅ |

> 状态口径：✅ = 本沙箱已验证或代码路径 + 行为断言验证；🟡 = 部分验证；⬜ = 待真机执行。

---

## 3. 已执行结果记录（本沙箱，如实）

环境：agent-browser + Chromium headless（HeadlessChrome/152，Linux x86_64），Next.js dev :3000 + 信令 :3003/:3004，经 Caddy :81 网关；台账样例 `db/ledger/ledger-2026-09-16.jsonl` 可交叉印证。

| 日期 | 项目 | 结果 | 证据 |
|---|---|---|---|
| 2026-09-16 | 加密自检 5/5（S1 密码原语 / S2 指纹安全码 / S3 回环建连 / S4 帧级 E2EE 31 加密/26 解密帧 / S5 256KB 加密文件往返 SHA-256 一致） | ✅ 全部通过 | worklog Task 2-b；页面 SelfTestCard 渲染 |
| 2026-09-16 | 双标签页 P2P 互通 | ✅ `connectionState=connected`，视频瓦片渲染 | worklog Task 2-b |
| 2026-09-16 | 双端安全码一致 | ✅ `BBE9-C9F3-4A7F-4753-4CDA-D7F5` | worklog Task 2-b |
| 2026-09-16 | 1MB 文件 SHA-256 一致 | ✅ `1adec23c…`（digestOk=true） | 验证记录（本任务归档） |
| 2026-09-16 | 加密聊天互通 | ✅ 双端收到对方消息 | worklog Task 2-b |
| 2026-09-16 | 无设备环境降级 | ✅ headless 无摄像头 → 「仅数据模式」提示，文件/聊天不受影响 | 台账 ua=HeadlessChrome |
| 2026-09-16 | 移动端 390px 布局 | ✅ 无横向滚动，面板走 Sheet 抽屉 | `download/verify-mobile.png` |
| 2026-09-16 | 桌面布局截图 | ✅ | `download/verify-desktop.png` |
| 2026-09-16 | 台账可查 | ✅ `/svc/ledger` 返回 peer_join/relay_signal/peer_leave 等真实条目 | `db/ledger/ledger-2026-09-16.jsonl` |
| 2026-09-16 | lint | ✅ 0 error | worklog Task 3-a |
| 2026-09-16 | Caddy :81 网关全链路 | ✅ 页面/信令/台账均经网关可用 | worklog Task 3-a |
| 2026-09-16 | 双 SDP offer/answer 中继 | ✅ 台账 `relay_signal kind=sdp:offer/answer bytes=533` | ledger JSONL |

---

## 4. 待真机执行清单与步骤

**目标浏览器**：Chrome / Edge / Firefox 117+ / Safari 15.4+（含 iOS Safari）；**目标网络**：同网 / 跨网（手机热点 vs 家庭宽带）/ 严格 NAT（公司网络）/ TURN 中继强制。

执行步骤：

1. 部署：按 `deploy/DEPLOYMENT.md` 启动 Docker Compose（web + signaling + coturn），配置 `STUN_URLS/TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL`，确保 HTTPS（getUserMedia 需要 secure context）。
2. 每种浏览器 × 网络组合，两人一组跑 §2 检查单 #1~#26；Firefox/Safari 重点验证 `e2eeMode === 'script-transform'`（「加密」面板·帧级路径一栏）。
3. 强制走 TURN 验证：`/api/ice-config` 临时只返回 TURN（或浏览器侧 `iceTransportPolicy:'relay'` 实验开关），确认 `diagnostics-panel` 候选对类型 `local=relay / remote=relay`。
4. 每项结果按 §3 表格格式追加记录（日期/结果/证据截图），证据截图存 `download/`。

---

## 5. 弱网模拟方法

### 5.1 Chrome DevTools（无需 root，桌面）

- DevTools → Network → Throttling 预设 `Fast 3G / Slow 3G`（影响 fetch/WS/媒体全部请求）。
- `chrome://webrtc-internals` → 对应 peer connection → `googCpu/Network` 相关图表观察码率与丢包。
- 精确注入丢包/延迟：DevTools Console 不可控 RTP 层 → 用系统级 `tc netem`（见下）。

### 5.2 Linux `tc netem`（网关机或本机出口）

```bash
# 添加 100ms 延迟 ±20ms 抖动、2% 丢包（对 UDP 32768-60999 即 WebRTC 端口段）
sudo tc qdisc add dev eth0 root handle 1: netem delay 100ms 20ms loss 2%
sudo tc filter add dev eth0 parent 1: protocol ip u32 match ip protocol 17 0xff \
     match ip dport 32768 0xfff8 flowid 1:1

# 更苛刻：50ms 延迟、5% 丢包、25ms 抖动（预期触发码率阶梯 2500→1600→1000…）
sudo tc qdisc change dev eth0 root netem delay 50ms 25ms loss 5%

# 模拟严格 NAT 不可达（观察 ICE 自动重启 / relay 兜底）
sudo tc qdisc change dev eth0 root netem loss 100%

# 恢复
sudo tc qdisc del dev eth0 root
```

验证点：`diagnostics-panel` 的 RTT/丢包/码率曲线；日志 `弱网自适应：视频码率 → N kbps`；连接 failed 后 `ICE 重启恢复…` 日志。

### 5.3 macOS / Windows 速配

- macOS：`Network Link Conditioner`（Additional Tools for Xcode），预设 3G / High Latency DNS。
- Windows：` clumsy`（UDP 延迟/丢包/节流）。

---

## 6. 回归最小集（每次发版必跑，< 3 分钟）

1. 大厅「加密自检」→ 5/5。
2. 双端入房 → `connected` + 安全码一致。
3. 1MB 文件互传 → `digestOk=true`。
4. 一条加密聊天互达。
5. `bun run lint` 0 error；`curl /svc/health` 与 `/svc/ledger?limit=5` 正常。

## 7. Round 9 迭代回归记录（webDevReview 第 3 轮）

**环境**：agent-browser（Chromium headless，经 Caddy :81 网关）+ 双 --session 浏览器会话（3 端 mesh）。

**开始时 QA 回归（确认无产品 bug 后转入功能开发）**：
| 项目 | 结果 |
| --- | --- |
| 加密自检 | 5/5（S4 帧加密 31/解密 12，S5 digestOk=true） |
| 双标签页 P2P | 已连接 · RTT 1ms · 仅数据模式自动降级（headless 无设备） |
| 安全码带外核对 | 双端一致 CF40-7D80-EED6-12C6-ADF3-52DC |
| 加密聊天 t1→t2 | 内容/署名/时间戳完整 |
| 文件传输 t2→t1 256KB | SHA-256 d85187ff… 双端一致 |
| header 徽章 | 房间胶囊 / 计时器 00:36 / 成员数 / E2EE · Encoded Streams 全部在位 |
| 移动端 390px | 无横向溢出，FAB/Sheet 正常 |

**新功能验证**：
| 功能 | 方法 | 结果 |
| --- | --- | --- |
| F-10 暂停/恢复 | 24MB 文件上传后即刻 `pause()`（经 `__veilClient` 调试钩子），2.5s 后 `resume()` | 发送端暂停于 70% ↔ 接收端 1071/1536 块，双端 status=paused 同步；恢复后完成，SHA-256 09ada583… 与源文件一致（双接收端 digestOk） |
| F-11 typing 指示器 | 对端 250ms 间隔模拟击键，本端查 store.typingPeers + `[role=status]` DOM | `final-b 正在输入…` + `.veil-typing-dot` 动画点渲染；2.2s 无击键自动停止、4s 衰减熄灭 |
| F-12 Web Share | 检查 `[role=dialog]` 内分享按钮 | 无 `navigator.share` 环境（headless 桌面）按钮优雅隐藏，移动端才显示 |
| F-13 质量四档 | 视频块徽标文本 | 「优 1ms」正确渲染（`networkGrade` 阈值生效） |
| F-9 PWA 资产 | curl 检查 | manifest/sw/图标 4 尺寸全部 200；HTML 含 manifest/apple-touch-icon/theme-color/#0d9488 |

**本轮踩坑记录（自动化测试注意事项，非产品 bug）**：
1. Radix Tabs 激活在 pointer 事件链上，`el.click()` 无效 —— 必须用 agent-browser 原生 `click`。
2. `offsetParent` 判可见性对 `position:fixed` 元素恒为 null（移动端 FAB 会误判为隐藏）。
3. 后台标签页定时器被节流（headless 下尤为激进）：跨标签页验证 typing/心跳类行为，
   须用两个 `--session` 浏览器实例，或直接向 `window.__veilStore` 注入状态渲染 UI。
4. dev 模式下 Service Worker 的 cache-first 会缓存无内容哈希的 dev chunk 导致旧代码——
   SW 已改为仅生产注册；测试前务必 `navigator.serviceWorker.getRegistrations()` 全量 unregister。
5. Next dev 进程在多轮 HMR 后可能崩溃（本轮出现一次 502），重启后需重跑自检最小集。

## 8. Round 13 迭代回归记录（第 13 轮，F-27/F-28/F-29）

**环境**：agent-browser（Chromium headless，经 Caddy :81 网关）+ 多 --session 浏览器会话。

**开始时 QA 回归**：
| 项目 | 结果 |
| --- | --- |
| 加密自检 | 6/6（修复前基线）→ 新增 S7 后 7/7 全过 |
| 双端 P2P | 已连接 · RTT 0~1ms · 仅数据模式自动降级 |
| 安全码带外核对 | 双端一致 88E4-803C-999D-C7D1-B77D-BD3F，指纹交叉匹配 |
| 加密聊天 + 未读徽标 | 内容完整，徽标计数 1 |
| 文件传输 128KB | 双端 SHA-256 前缀 ea9d0fd0… 一致 |
| 移动端 390px | 大厅/房间内均无横向溢出 |

**本轮新功能验证**：
| 功能 | 方法 | 结果 |
| --- | --- | --- |
| F-27 自检 S7 | 大厅一键自检 | S7 DataChannel 轮换链：epoch0 往返=true epoch1 往返=true 旧密钥隔离=true（7/7） |
| F-27 聊天 epoch 帧 | t2 发消息 → t1 收（轮换前） | 内容完整 + 未读徽标 1 |
| F-27 手动 DC 轮换 | 诊断面板「轮换传输密钥」 | dcEpoch 0→1，UI「1· 已轮换」 |
| F-27 跨纪元聊天 | 轮换后 t1 发 → t2 解密 | 按帧内 epoch 自主派生解密成功（无需信令同步） |
| F-27 文件 epoch 帧 | t1→t2 64KB | 双端 done + digestOk=true |
| F-28 房主视图 | t1 成员面板 | 「你是本房间房主」+ 锁定卡片 + 房主标记 |
| F-28 锁定房间 | t1 锁定 → t3 加入 | t3 toast「房间已锁定：房主已开启准入锁定」phase 停留 lobby；台账 join_reject_locked |
| F-28 解锁 | t1 解锁 → t3 加入成功 | phase=in-room |
| F-28 踢人 | t1 两段确认（移出→确认移出？）→ t3 被踢 | t3 自动回大厅 phase=lobby；t1 成员列表 -1；台账 peer_kick qa13host→qa13intruder |
| F-29 聚焦布局 | 舞台右上角 radiogroup 切换 | spotlight：主画面 .veil-stage-swap + 缩略条 .veil-thumb-in 渲染；grid 可切回 |
| 布局记忆 | localStorage veil-stage-layout | 刷新后保持（store 懒初始化） |

**修复记录**：
| 问题 | 修复 |
| --- | --- |
| rejoin 后 hostSocketId/locked 未同步（治理 UI 不出现） | joinRoom ack 补 onRoomState 下发 |
| 成员行治理按钮文字换行挤压 | 按钮 whitespace-nowrap + 外层 flex-wrap |
| Next dev 进程静默崩溃（多轮 HMR 后，已知模式） | 重启 dev server 后复测通过 |

**本轮踩坑记录（QA 操作注意，非产品 bug）**：
1. QA 必须经 Caddy :81 网关访问（XTransformPort 机制在 :3000 直连下不生效，socket.io 连不上信令）。
2. reload 后 store 清空回大厅属预期（会话级密钥设计），需重新走邀请链接入房。
3. 被邀请页房间号框保留 URL 预填值，加入前务必确认房间号是目标房间（本轮 t2 曾误入旧房间）。
4. headless 下聊天输入框在无对端时 disabled —— 发送测试须在对端入房后进行。

## 9. Round 14 迭代回归记录（第 14 轮，F-30 PAKE / SPAKE2）

**环境**：agent-browser（Chromium headless，经 Caddy :81 网关）+ 多标签页会话。

**开始时 QA 回归（开局全绿，无遗留产品 bug）**：
| 项目 | 结果 |
| --- | --- |
| 服务健康 | 信令 3003/3004（uptime 1293s）、Next 3000、Caddy :81 全部正常，dev.log 无错误 |
| 加密自检 | 7/7（S1-S7 全过，含 S4 加密 32/解密 35/丢弃 0） |
| 双端 P2P | 已连接 · RTT 1ms · 安全码双端一致 E016-4B5E-2C6B-F47C-833B-287F |
| 加密聊天 + 未读徽标 | 互通；t2 切到文件 tab 后收消息 unread=1（徽标逻辑正确） |
| 文件传输 128KB | 双端 done + digestOk=true |
| 移动端 390px | scrollWidth=390 无溢出；暗色模式正常 |

**本轮开发中发现并修复的缺陷**：
| 问题 | 定位 | 修复 |
| --- | --- | --- |
| BUG-9（致命）SPAKE2 点加公式缺因子：`r = S2-S1` 应为 `r = 2*(S2-S1)`（EFD add-1998-cmo 公式族配套要求） | 自检 S8「对端共享值不在曲线上」→ 独立 bun 脚本二分定位：1G/2G（纯 doubling 与无穷远捷径）正确掩盖了问题，首个真实点加 3G 即错 | spake2.ts jAdd 修正为 `r = 2*(s2-s1)`；修复后随机标量/分配律/SPAKE2 Z 一致性全部通过（独立脚本 8 断言 + 浏览器 S8） |
| S8d 测试逻辑错误：同口令下 kA.key === kB.key，"不同 PAKE 密钥派生不同" 断言恒 false | 代码审查 | b3 改用异口令握手产生的 kAw.key |
| S8 互证 role 参数错位：验证证明时 role 应为「证明创建者」角色 | 代码审查 | proofAok 用 kB.peerRole（='A'）、proofBok 用 kA.peerRole（='B'） |
| tsconfig target ES2017 拒绝 BigInt 字面量 | tsc TS2737 | 升级 target 至 ES2020 |
| runPakeHandshake 调用缺 sharedBits 参数 | tsc TS2554 | 传入 sharedBits |

**本轮新功能验证（F-30 SPAKE2 PAKE）**：
| 场景 | 方法 | 结果 |
| --- | --- | --- |
| 自检 S8 | 大厅一键自检 | 8/8：同口令密钥一致=true 双向互证=true 异口令密钥不同=true 证明拒绝=true 非法点拒绝=true 绑定层确定=true（26ms） |
| 同口令握手 | t1/t2 同口令 "pake-pass-14" 入房 | 双端 peers.pake='verified'，加密面板绿色「PAKE 已验证」徽标（veil-pake-pop/lock 动效） |
| PAKE 密钥下聊天 | t2 → t1 | 内容完整 + 未读徽标 1 |
| PAKE 密钥下文件 | t1→t2 64KB | 双端 done + digestOk=true |
| 异口令 fail-closed | t3 "right-pass" + t4 "WRONG-pass" 同房 | 两侧均无会话（peers=[]）+ 系统提示「口令验证失败：口令不一致或存在中间人（密钥互验失败）」+ error 日志；加密面板红色警示卡（veil-pake-fail 呼吸） |
| 无口令回归 | t1/t2 无口令入房 | pakeEnabled=false、徽标「未设口令」、配置行「未启用」；聊天/文件（32KB）digestOk=true 行为与旧版一致 |
| 台账 | /svc/ledger | relay_signal 只记类型/字节数（SPAKE2 消息走 unknown 类别，无内容字段），最小化原则保持 |

**样式存档**：download/round14-pake-verified.png（PAKE 已验证面板）、round14-pake-verified2.png、round14-pake-off.png（未设口令态）、round14-mobile-pake.png（390px 无溢出）、round14-dark-pake.png、round14-qa-mobile.png / round14-qa-dark.png（开局基线）。

**本轮踩坑记录（QA 操作注意，非产品 bug）**：
1. agent-browser `tab t1` 切换后引用（ref）失效，需重新 snapshot 获取。
2. store `set()` 同步返回值为更新前快照（React 批处理），断言需在下一轮 eval 或 snapshot 读取。
3. 表单填写优先用原生 setter + input 事件（agent-browser fill 对非受控/受控混合输入在部分时机不稳）。
4. Next dev 偶发「页面 200 但快照为空」→ `agent-browser close --all` 后重开即可（已知模式，非编译错误）。

---

## 10. Round 15 迭代回归记录（第 15 轮，F-31 断点续传 / F-32 TURN 短期凭证）

**开局状态评估（全部通过）**：
| 项 | 结果 |
| --- | --- |
| 服务健康 | 信令 3003/3004 ok（uptime 3787s）、Next 3000、:81 网关正常、台账持续写入 |
| 自检 | 8/8（修复前基线） |
| 双端 P2P | t1+t2 入房互连「已连接 优 1ms」E2EE |
| 安全码 | 双端尾段一致（1605-91F8-8C75-2B33），前三段为各自指纹（预期） |
| 聊天 | A→B（含未读徽标）+ B→A 双向 |
| 文件 | 128KB A→B 双端 SHA-256 一致（digestOk） |
| 环境 | 390px 无溢出、暗色正常、控制台无错误 |

**本轮新功能验证（F-31 断点续传，4MB 确定性内容文件）**：
| 场景 | 方法 | 结果 |
| --- | --- | --- |
| 取消中断 | A 发送 → 1200ms 后自动点取消 | A 状态「已取消」；B 端 IndexedDB 暂存 have=82%（旧实现仅 16 块/256KB，修复后为取消前全部已收分片） |
| 续传握手 | A 重发同一文件 | B 日志「发现本地断点 … 已暂存 82%」；A 日志「断点续传 … 从 82% 处继续」；B 回 `file-resume-sync{have}`，A 跳过至 offset 后续传 |
| 续传完成 | 双端核对 | A/B 均「SHA-256 校验通过」+ B「已续传 82%」徽标（veil-resume-badge）；sha256 与原文件一致 |
| 暂存清理 | 传输成功后查 IDB | partials=0（finish 排空串行链 + finishing 守卫后自动删除，无重建） |
| 全新传输回归 | 1MB 新文件 | 双端 digestOk、无「已续传」徽标（偏移 0 不显示） |
| 自检 S9 | 大厅一键自检 | 9/9：S9 写入=true 往返一致=true 擦除后为空=true offset 对齐=true（14ms） |
| 暂存页脚 | 取消后观察 | 「本地断点暂存：1 个未完成文件」+「清除」按钮；清除后 IDB 归零 |
| 移动端/暗色 | 390px + 暗色切换 | 无溢出；暗色下续传徽标/页脚配色正常 |

**本轮发现并修复的 bug（均为开发+QA 过程中定位）**：
| Bug | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| BUG-10（严重，数据丢失） | 快速传输后暂存 have 远小于实际已收（4MB 只剩 1MB），最终 SHA-256 失败 | persistOnce「合并 → await 写盘 → 清空 parts」窗口内到达的分片被整组丢弃 | 所有权转移：同步接管 parts（snapshot）后再 await；写盘窗口新分片进新数组；失败回滚归还快照 |
| BUG-11（竞态） | 传输成功后暂存记录复活/残留 | finish 删除后，迟到的阈值 persist（异步解密续延）重建陈旧记录 | finish 设置 finishing 标志 + persistOnce 执行器级守卫；失败分支显式重置 finishing 再落盘 |
| BUG-12（UI） | 暂存页脚计数不刷新 | useEffect 只依赖 transfers.length，落盘发生在列表长度不变时 | 改为「id:status」签名依赖（cacheSig），状态跃迁才触发 IndexedDB 扫描 |
| 教训 | 测试脚本每次 getRandomValues 生成新内容 → digest 不同 → 续传不触发（误判协议失效） | — | 断点续传测试必须复用同一份字节（window 缓存 buf），以 digest 为唯一身份 |

**本轮新功能验证（F-32 TURN REST 短期凭证）**：
| 项 | 方法 | 结果 |
| --- | --- | --- |
| 签发正确性 | bun 脚本直跑 `issueTurnRestCredential` | username=`<ts>:veiltalk`、credential=28 字符标准 base64；与 node crypto HMAC-SHA1 参照实现交叉一致 |
| TTL 钳制 | clampTurnTtl 边界 | undefined→3600、1→60、999999→86400、1800→1800 |
| secret 敏感性 | 不同 secret 签发 | 凭证不同 |
| 向后兼容 | curl /api/ice-config（未配 TURN） | `turnMode:"none"`、`ttl:0`，行为与旧版一致 |
| 文档 | DEPLOYMENT.md §6.2 / turnserver.conf | REST 模式开箱即用步骤已更新（coturn 侧仍需手工切 use-auth-secret） |

**样式存档**：download/round15-selftest-9of9.png（9/9）、round15-resume-mobile.png（390px）、round15-resume-dark.png（暗色传输列表）、round15-qa-mobile.png / round15-qa-dark.png（开局基线）。

**QA 踩坑补充（下轮直接可用）**：
1. Radix Tabs 的 tab 必须用 agent-browser 原生 `click @ref`（eval 内 `el.click()` 不触发切换）。
2. `agent-browser console` 缓冲会被 HMR/Fast-Refresh 日志冲刷，长流程探针应写入 `window.__qaDbLog` 数组而非 console。
3. Hot Reload 后页面内单例（RoomClient/bundles）会重建——运行时探针在 reload 后必须重挂。
4. 同源双标签页共享 IndexedDB：发送端页脚也会显示接收端的暂存计数（设计使然，真实跨设备部署各自独立）。

## 11. Round 16 迭代回归记录（第 16 轮，F-33 file-ack / F-34 i18n / F-35 --turn-rest）

**开局 QA（改动前基线）**：自检 9/9、双端 P2P（E2EE + PAKE 已验证 + 安全码双端一致 636B-…-6942）、
聊天互通 + 未读徽标、128KB 文件双端 SHA-256 一致、390px 无溢出（ow=390=iw）→ 无遗留产品 bug，转入功能迭代。

### F-33 file-ack 显式回执（乐观标签 → 真回执）
| 验证点 | 方法 | 结果 |
|---|---|---|
| 协议回执 | 自检 S5 扩展断言 | `status=done digestOk=true 对端回执=true`（920ms） |
| 发送端徽标 | A 上传 64KB/128KB → 观察 | `等待对端回执…`（呼吸态）→ `对端已确认`（盖章弹入） |
| 日志留痕 | A 端日志面板 | 「对端回执：SHA-256 校验一致，文件已确认」crypto 级 |
| 回执泄露面 | 协议审查 | `file-ack {id, ok}` 仅传输 id + 布尔，走同一加密 DC 控制面 |

**S5 首跑失败排查记录**：对端回执=false —— 自检回环只接了 dcB→receiver 方向，
dcA 侧无 onmessage 导致 ack 无人接收；补 `dcA.onmessage → sender2.handleControl` 后全过。
教训：DataChannel 是双向的，自检两端都要接控制面路由。

### F-34 i18n（zh/en 双语）
| 验证点 | 方法 | 结果 |
|---|---|---|
| 切换生效 | header 语言按钮 | 大厅/房间/面板全量无刷新切换，veil-lang-swap 淡入 |
| 持久化 | localStorage `veil-lang` | 刷新后保持；`?lang=en` URL 参数优先级最高 |
| DOM 同步 | eval 检查 | `documentElement.lang='en'` + document.title 切换 |
| 字典形状 | tsc | en `typeof zh` 编译期强制；~470 key × 2 语言 0 漂移 |
| EN 房间 | ?lang=en 入房 | stage/控制条/面板/空态全英文；hydration 首帧 zh 属预期 |
| 双标签独立 | t1(en)+t2(zh) | 语言为纯客户端状态，互不干扰 |
| 残留检查 | 脚本扫描 | 用户可见文案 0 中文残留（注释/selftest detail 除外，已记录） |

### F-35 deploy.sh --turn-rest
| 验证点 | 方法 | 结果 |
|---|---|---|
| 脚本语法 | bash -n | 通过 |
| 双侧切换 | /tmp 沙箱环境实跑函数 | .env 追加 secret（48 hex）+ conf 切 use-auth-secret/static-auth-secret + lt-cred-mech/user= 禁用注释 |
| 幂等 | 二次执行 | secret 复用不变；backup 仅首次创建 |
| 捕获纯净 | `$(ensure_turn_rest_secret)` | 48 字符无日志污染（log/warn 已改走 stderr） |
| 文档 | DEPLOYMENT.md §6.2 / turnserver.conf 注释 | 一键配置说明已加 |

### 治理回归（覆盖 i18n 后 controller toast 路径）
锁定 → 新成员加入被拒（toast「房间已锁定…」+ 留在大厅）→ 解锁 → 加入成功（3 人 mesh 内 A/C 双端验证）。

**门禁**：bun run lint 0 error；tsc --noEmit（src/）0 error；dev.log 无错误。
**截图存档**：download/round16-selftest-9of9.png、round16-ack-badge.png（对端已确认徽标）、
round16-crypto-panel.png、round16-mobile-room.png、round16-dark-room.png、round16-en-room.png。

**QA 踩坑补充（下轮直接可用）**：
1. `agent-browser close`（不带 --all）会关闭整个浏览器会话/全部标签 —— 单关一个 tab 慎用；
   多标签测试误关后，被关端的房间成员会清空（对端 peers 变空、聊天框禁用属正确行为，勿误判为 bug）。
2. MultiEdit 在复杂多编辑点偶发「部分应用后报错」——同文件多编辑后必须重读文件核实实际状态，
   必要时用 python 单点修复（本项目 lobby.tsx 依赖数组曾出现半应用损坏 `}, yName, setStore])`）。
3. 页面 200 但快照为空除了「close --all 重开」外，也可能因 Fast-Refresh 重编译中，等待 3~5s 再试。
4. 自检回环类测试：DataChannel 双向都要接 onmessage 路由，只接一端会漏掉反向控制消息（本轮 S5 教训）。

## 12. Round 18 回归记录（BUG-14 用户上报：Select.Item 空值崩溃）

**用户上报**：房间内打开「设备与画质」Popover 时运行时错误
`A <Select.Item /> must have a value prop that is not an empty string`（Radix 直接抛错，Stage 子树崩溃）。

| 项 | 内容 |
|---|---|
| 根因 | 权限未授权时 `enumerateDevices()` 返回 `deviceId:''` 的条目（Chromium/Safari 授权前行为），DeviceSettings 直接把它渲染成 `<SelectItem value="">`。Radix 保留空串语义为「清空选择/显示占位」，故禁止 Item 空 value |
| 修复 | 四层防御（device-settings.tsx）：① 过滤空 deviceId（空 id 本身无法用于 switchDevice）② 按 deviceId 去重 ③ 「枚举有条目但 id 全空」识别为未授权 → 显示专属提示（i18n `device.noPermission`，区别于「无可用设备」）④ localStream 由无到有（授权/retryMedia 成功）自动重新枚举，列表自愈 |
| 同源防御 | ledger-panel.tsx 日期下拉 `filter(Boolean)`（SelectItem 全站仅 3 处，全部防守） |
| 严格复现 | `download/inject-empty-devices.js`（--init-script 覆盖 enumerateDevices 返回 3 条空 id）→ 修复前必崩路径：修复后 Popover 正常，占位「无可用设备」+ 琥珀未授权提示，控制台 0 error |
| 混合场景 | `download/inject-mixed-devices.js`（真实 id ×2 重复 + 空 id ×1 + 麦克风 ×1）→ 摄像头下拉仅 1 项「FaceTime HD Camera」（去重+过滤），麦克风正常，无未授权提示（有有效 id 即判已授权），0 error |
| 边界说明 | 防线④（自愈）需真机授权弹窗路径，headless 无法覆盖，TESTING.md §4 真机清单覆盖 |
| 门禁 | bun run lint 0 error 0 warning；tsc --noEmit（src/）0 error；dev.log 尾部无错误 |
| 截图 | download/round18-device-settings-fixed.png |

**复现探针（下轮回归可复用）**：`agent-browser open <url> --init-script download/inject-empty-devices.js`，
进房 → 点「设备与画质」→ 应见未授权提示而非崩溃。

**i18n 行为说明（F-36 后自检输出的正确形态，替代 Round 16 "selftest detail 除外"记录）**：
自检结果为**运行时语言快照**——S1~S9 步骤名与详情按执行瞬间的界面语言输出（中文界面 → 全中文、
`?lang=en` → 全英文，两份均 9/9）。切换语言后旧结果不回译（结果含布尔值快照，重跑即刷新）；
英文环境下 `quality.ts` 档位徽标同步为 Great/Good/Fair/Poor。Round 16 残留检查中
「selftest detail 中文除外」自本轮起作废，扫描残留时 S1~S9 文案不算中文残留。

## 13. Round 19 迭代回归记录（第 19 轮，Zoom 化套件 F-40~F-45 + BUG-15）

**需求来源**：用户指令「让它变得跟 Zoom 一样」→ 本轮落地 Zoom 标志性体验六件套。

### 新功能验证（agent-browser 双端 E2E，t1 主持人 / t2 参会者）
| 功能 | 验证点 | 方法 | 结果 |
|---|---|---|---|
| F-41 Emoji 反应 | 面板 8 emoji | t2 点 Reactions → 🎉 | 本地浮层 + store（mine=true） |
| F-41 跨端广播 | DataChannel 控制面 `{t:'reaction'}` | t2 发 🎉 → t1 | t1 浮层出现 + 日志「参会者Zoom 发送了反应 🎉」 |
| F-41 tile 气泡 | 3s 窗口最新反应 | t2 发 ❤️ → t1 | 对端 tile 右上 `.veil-bubble-pop` 显示 ❤️ |
| F-42 举手 | 本端状态/按钮 | t2 点举手 | store `__local__` + 按钮变「放下手」 |
| F-42 跨端 | 徽标 + toast + 日志 | t2 举手 → t1 | t1 对端 tile ✋ 徽标 + 日志留痕（toast 快照时已过期，同 handler 日志确证） |
| F-40 Speaker View | activeSpeaker 上报链 | t1 注入白噪声音轨（oscillator→MediaStreamDestination） | 2.5s 内 `activeSpeaker="__local__"`；本机 tile `veil-tile-speaking` 光环点亮 |
| F-40 spotlight 跟随 | 主画面选择链 | t1 切聚焦布局 | `.veil-stage-swap` 主画面 = 本机 tile（说话人优先级生效） |
| F-44 全屏 | Fullscreen API | 原生 click 全屏按钮 | `document.fullscreenElement` = `.veil-stage-root`（eval 程序化点击无 user activation 会失败，必须原生 click） |
| F-45 镜像 | Switch 三重确认 | 设备面板切换 | store mirrorSelf 翻转 + localStorage `veil-mirror` 记忆 + video `-scale-x-100` 类增减 |
| 更多菜单（桌面） | 收纳逻辑 | t1 打开 | 仅「键盘快捷键」1 项（录制/设备/邀请已平铺） |
| 更多菜单（移动） | 收纳逻辑 | t2 390px 打开 | 4 项：录制/设备与画质/复制邀请/快捷键 |
| 移动端 Dialog | 设备面板双形态 | t2 菜单 → 设备与画质 | Dialog 渲染完整 DeviceSettings（Select + 镜像 Switch） |
| 移动端 7 键 | 不溢出 | 390×844 | ow=390=iw 无溢出；控制条 330px 居中（7 键可见） |
| 回归-聊天 | E2EE DataChannel 未被新协议破坏 | `__veilClient.sendChat` | t1→t2 送达（unread=1，文本一致） |
| 回归-i18n | 新按钮双语 | 切 en | aria-label="Reactions" 可点开面板；语言切回 zh 正常 |
| 暗色 | 移动端暗色 | t2 切 dark | 无样式断裂（round19-mobile-dark.png） |

### F-40 测试方法论（重要踩坑）
- **纯振荡器测不出说话高亮**：正弦波能量集中在单频点（maxBin≈244），经 `sum/128bins/96` 归一后平均电平
  仅 0.099 < 0.24 阈值；真实语音为宽带能量分布。**测试须用白噪声**（AudioBufferSourceNode 循环 +
  gain 0.35）模拟语音能量谱 → 电平超阈值。
- **AudioContext suspended 排查**：先 eval 建 `await ctx.resume()` 的诊断链路读 `ctx.state` 与实时电平，
  确认 running 且电平达标后再怀疑上报逻辑。

### BUG-15（本轮 QA 发现并修复）：移动端控制条右侧按钮被遮挡
| 项 | 内容 |
|---|---|
| 症状 | 390px 下「更多」按钮点击报 covered —— SidePanel 移动端悬浮按钮（`fixed bottom-24 right-4 z-30`）覆盖控制条（z-20）右侧按钮区域，「离开房间」同样被挡（既有冲突，本轮引入「更多」按钮后经可点性检查暴露） |
| 修复 | 控制条容器 z-20 → z-40（高于面板按钮 z-30；低于 Sheet/Popover portal z-50，弹层不受影响） |
| 验证 | elementFromPoint 确认中心点回到按钮自身（clickable=true）；菜单正常打开 |

**门禁**：bun run lint 0 error 0 warning；tsc --noEmit（src/）0 error；dev.log 尾部无错误。
**截图存档**：download/round19-speaker-view.png（说话光环+spotlight）、round19-zoom-bar.png（新控制条）、
round19-mobile-dark.png（390px 暗色）。

**QA 踩坑补充**：
1. Fullscreen API 必须用 agent-browser 原生 click（真实输入带 user activation）；eval `.click()` 会
   requestFullscreen 静默失败（被 catch 吞掉）。
2. Radix DropdownMenu 触发同样只认原生 click @ref；且 Popover 开着时兄弟按钮会被其 portal 遮挡，
   先 Escape 再操作。
3. 反应浮层 `onAnimationEnd` 出栈依赖 CSS 动画完成——reduced-motion 降级改为纯 opacity 动画（不能直接
   animation:none，否则元素永不消失）。

---

## 14. Round 20 修复记录（BUG-16 用户上报：真机「对方已连接但看不到对方视频」）

### 复现与定位方法论（重要资产：假摄像头 CDP 全链路测试）
**本 round 建立了首个「真实媒体帧全链路」headless 测试能力**（此前 19 轮 headless 均无摄像头，远端视频
从未端到端验证过——BUG-16 正是漏网之鱼）：
- 启动 Chrome 自带假摄像头：`chrome --headless=new --use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream --remote-debugging-port=9333`（注意 sandbox 会在 Bash 调用结束时
  回收后台进程 → Chrome 启动与测试脚本必须在**同一次调用**内执行；`agent-browser --cdp` 连不上
  非白名单端口，改用 bun 脚本直连 CDP WebSocket）
- 测试脚本：`download/cdp-drive.ts`（双 tab 入房 → 诊断 store/PC stats/E2EE stats → 截图落盘），
  下轮回归直接复用；应用必须走 `http://localhost:81` 网关（3000 直连信令不通）
- 判据：`getStats()` inbound `framesDecoded>0` + `frameWidth>0`（真出画）+ E2EE `decrypted>0, dropped=0`

### BUG-16 根因链（三层叠加）
1. **Chromium 遗留 API 时序炸弹**：`receiver.createEncodedStreams()` 在首帧流动后调用抛
   `InvalidStateError: Too late to create encoded streams`（原代码 catch 后静默返回 unsupported，
   无任何日志）。localhost/快网 DTLS 握手仅 1~3ms，ontrack 任务派发晚于首帧时必然中招
2. **Chromium 152 标准 API 缺陷**：`RTCRtpScriptTransform` 对 SENDER 生效、对 RECEIVER 被**静默忽略**
   （transform 赋值无异常、worker 收到 transformer 但帧绕过管线直达解码器）——首版「标准优先」修复
   因此反而全黑，实测数据抓出
3. **msid 丢失**：预建 transceiver + `sender.replaceTrack()` 喂轨不携带流关联 → 音/视频 ontrack 各自
   `new MediaStream([track])` → store 后到覆盖前到 → 远端流只剩视频（1v/0a），声音丢失

### 修复（peer-session.ts / e2ee-manager.ts / video-tile.tsx / room-client.ts / controller.ts）
| # | 修复 | 说明 |
|---|---|---|
| 1 | **构造期预接线** | PeerSession 构造时 addTransceiver(audio/video, sendrecv) 并立刻对收/发四条管线注入 worker（此时传输未启动，遗留 API 必不 Too late）；轨道后续用 `tx.sender.replaceTrack()` 喂入（显式复用，杜绝 Chromium addTrack 不复用导致的 m-line 翻倍） |
| 2 | **ontrack 幂等跳过** | preWiredReceivers WeakSet 标记；意外新增 receiver 走遗留优先兜底 |
| 3 | **远端流聚合** | 无 msid 时按对端惰性聚合单一 MediaStream（addTrack 去重），音视频同流（1v/1a） |
| 4 | **协商排程** | scheduleOffer() 60ms 防抖合并构造期 addTransceiver 与 replaceTrack 的协商需求；makeOffer 增加 stable/have-remote-offer 状态守卫 |
| 5 | **自动播放兜底** | video-tile：play() 被策略拦截 → 静音先出画 + 「点击开启画面」覆盖层 + 全局 pointerdown 重试（iOS Safari/严格策略第二诱因） |
| 6 | **fail-closed 加固** | 能力存在但接线失败 → console.error + lastAttachError 留档 + 加密日志告警 + 停发该轨（绝不回退明文） |
| 7 | **诊断增强** | e2eeVideoMode 拆分收/发方向（e2eeVideoRecvMode 等）；e2eeManager.lastAttachError；worker 增 transformEvents/pipesEnc/pipesDec 计数；成员面板显示「发送/接收」双行模式；新 QA 钩子 `__veilStore` |

### 验证结果（Chrome 152 headless 双端，两轮独立运行）
| 指标 | T1（主持人） | T2（参会者） |
|---|---|---|
| PC/ICE | connected | connected |
| 发送加密 | 426 帧 | 389 帧 |
| 接收解密 | 422 帧 / **0 丢帧** | 406 帧 / **0 丢帧** |
| 远端视频 | framesDecoded 137 @480×270 | framesDecoded 142 @480×270 |
| 远端流 | 1v/1a（音视频齐） | 1v/1a |
| 接线异常 | 无 | 无 |
| 回归-聊天 | `__veilClient.sendChat` → 对端 store 收到并解密 ✔（dc=true） |
| 门禁 | lint 0/0；tsc（src/）0 error；dev.log 无错误 |

**截图存档**：download/round20-bug16-fixed-t1.png、round20-bug16-fixed-t2.png（远端画面实际渲染中）。
**遗留观察（不影响功能）**：worker pipesDec 计数为 4（预接线 2 + ontrack 兜底 2，Chromium 在重协商时
会替换 receiver 对象）；头部「E2EE · ScriptTransform」徽标显示的是能力检测结果而非实际管线模式
（实际为 encoded-streams）——后续可统一从 per-peer 实际模式取值。
**真机清单（TESTING.md §4）建议追加**：双端真实摄像头互看 → 画面延迟 <1s、声音正常；快速入房/退房
反复 5 次无黑屏残留；iOS Safari 入房 → 若出现「点击开启画面」浮层点击后出画有声。
