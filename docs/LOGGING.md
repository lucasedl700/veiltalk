# VeilTalk 服务器运行日志（元数据台账）方案

> 实现基准：`mini-services/signaling-service/index.ts`（写入与查询 API）、`src/app/api/ledger/route.ts`（前端代理）、`src/lib/webrtc/controller.ts` 的 `fetchLedger()`、面板 `src/components/veil/ledger-panel.tsx`。台账文件：`db/ledger/ledger-YYYY-MM-DD.jsonl`（按 UTC 日轮转）。

---

## 1. 当前实现

### 1.1 写入机制

- `ledger(event, data)`：构造 `{ ts: ISO8601, event, ...data }`，经 **Promise 队列串行化**（`ledgerQueue`）后 `fsp.appendFile` 追加写当日文件——保证每行 JSON 完整、无交错写坏。
- 同时 `console.log('[LEDGER]', ...)` 打到 stdout（容器/进程管理器可二次采集）。
- 轮转：**按日期自动切文件**（`ledger-<day>.jsonl`），无进程内压缩/清理——由外部 logrotate 处理（见 §3）。
- 启停钩子：`service_start`（监听成功时）/ `service_stop`（SIGTERM/SIGINT 优雅退出）写入台账。

### 1.2 查询 API（运维 HTTP :3004）

| 端点 | 参数 | 返回 |
|---|---|---|
| `GET /svc/health` | — | `{ok, service:'veiltalk-signaling', version, uptimeSec, rooms, peers, maxPeersPerRoom, ledgerDir, ts}` |
| `GET /svc/rooms` | — | `{ok, count, rooms:[{id, createdAt, peerCount, peers:[{peerId, name, fingerprint, joinedTs}]}]}` |
| `GET /svc/ledger` | `limit`（默认 200，上限 1000）、`date`（`YYYY-MM-DD`，默认今天，格式非法回退今天）、`event`（子串过滤） | `{ok, date, availableDates:[…逆序], total, entries:[…按时间倒序]}` |

前端访问链路：浏览器 → `fetch('/api/ledger?limit=300&date=…')` → Next 代理（`SIGNALING_HTTP`，默认 `http://127.0.0.1:3004`，5s 超时）→ `/svc/ledger`。面板支持日期切换（`availableDates`）与 JSONL 导出。

### 1.3 字段字典（每个 event 的字段含义）

通用字段：`ts`（ISO 时间戳）、`event`（事件名）。

| event | 触发时机 | 字段 |
|---|---|---|
| `service_start` | ws 监听成功 | `wsPort`（信令端口）、`ledgerDir`（台账绝对路径）、`maxPeersPerRoom`（mesh 上限，默认 8） |
| `service_stop` | SIGTERM/SIGINT | `reason`（'SIGTERM'/'SIGINT'） |
| `socket_connect` | 任意 socket.io 连接建立 | `sid`（socket id）、`ua`（User-Agent 截断 120 字符） |
| `socket_disconnect` | 连接断开 | `sid`、`reason`（socket.io 断开原因，如 `transport close`/`ping timeout`） |
| `room_create` | 首个成员创建房间 | `roomId` |
| `room_close` | 最后一人离开 | `roomId` |
| `peer_join` | join-room 成功 | `roomId`、`peerId`（客户端会话稳定 ID）、`sid`、`name`（昵称，≤32 字符）、`roomSize`（加入后人数） |
| `peer_leave` | 主动离开/重连/disconnect | `roomId`、`peerId`、`sid`、`cause`（`voluntary` / `rejoin` / `disconnect:<reason>`）、`roomSize` |
| `relay_signal` | **仅 SDP** 信令转发成功 | `roomId`、`kind`（`sdp:offer` / `sdp:answer`）、`from`、`to`（双方 socketId）、`bytes`（JSON 序列化后字节数） |
| `signal_drop_oversize` | 载荷 >96KB 被拒 | `roomId`、`sid`、`to`、`bytes` |

样例行（真实文件摘录）：

```json
{"ts":"2026-09-16T14:43:59.088Z","event":"relay_signal","roomId":"54a5p92em","kind":"sdp:offer","from":"y6BP_pcdWkgbx-jIAAAC","to":"OCXLA9SRrZFXdyUHAAAD","bytes":533}
{"ts":"2026-09-16T14:49:01.790Z","event":"relay_signal","roomId":"ye92tbadd","kind":"sdp:answer","from":"mcGRf7WZrvD92JHqAAAF","to":"9NO88VbCkPO9dzGmAAAE","bytes":533}
```

### 1.4 最小化原则（设计红线）

- **只记**：房间号、peerId/socketId、事件名、字节数、人数、cause、UA 前 120 字符。
- **绝不记**：密钥材料（公钥本体/私钥/会话密钥——join-room 里 `pubkey` 只在内存转发，不落台账）、SDP/candidate 内容（只记类型与字节数）、文件名与文件事件（P2P 不经服务器）、聊天内容、IP 地址。
- ICE candidate 转发**不**写台账（频次高且元数据价值低）；只有 SDP 记 `relay_signal`。
- 面板侧展示对 `roomId` 做截断（`ledger-panel.tsx` 的 `eventMeta()`：`room=` 只显示前 12 字符、`peer=` 前 8 字符）；`crypto-core.ts` 还导出了 `maskRoomId()`（`abc…xyz` 掩码）供后续接入面板/导出使用。

---

## 2. 查看方式

### 2.1 API / 面板

```bash
# 健康
curl -s http://localhost:3004/svc/health | python3 -m json.tool
# 今日台账最近 20 条
curl -s 'http://localhost:3004/svc/ledger?limit=20' | python3 -m json.tool
# 指定日期 + 事件过滤
curl -s 'http://localhost:3004/svc/ledger?date=2026-09-16&event=peer_join&limit=50'
# 走 Next 代理（同源，生产推荐）
curl -s 'http://localhost:3000/api/ledger?limit=5'
```

页面：右上/页脚入口 → 台账面板（`ledger-panel.tsx`）：日期下拉（`availableDates`）、条目表格、导出按钮。

### 2.2 grep 速查

```bash
cd /home/z/my-project/db/ledger
# 某房间全生命周期
grep '"roomId":"54a5p92em"' ledger-2026-09-16.jsonl
# 谁、何时加入/离开（含 cause）
grep -E '"event":"peer_(join|leave)"' ledger-2026-09-16.jsonl
# 超大信令（安全告警源，见 §3）
grep 'signal_drop_oversize' ledger-*.jsonl
# 服务重启次数
grep -c '"event":"service_start"' ledger-2026-09-16.jsonl
# 按小时统计 join 量（jq）
jq -r 'select(.event=="peer_join") | .ts[0:13]' ledger-2026-09-16.jsonl | sort | uniq -c
```

---

## 3. 运维

### 3.1 轮转与压缩（cron 脚本示例）

台账按日成文件，天然适配「次月归档上月」：

```bash
#!/usr/bin/env bash
# /etc/cron.weekly/veiltalk-ledger-archive —— 每周归档 7 天前的台账
set -euo pipefail
DIR=/home/z/my-project/db/ledger
CUTOFF=$(date -d '7 days ago' +%F)
find "$DIR" -name 'ledger-*.jsonl' | while read -r f; do
  d=$(basename "$f" .jsonl); d=${d#ledger-}
  if [[ "$d" < "$CUTOFF" && ! -f "$f.gz" ]]; then
    gzip -9 "$f"   # ledger-2026-09-01.jsonl → .jsonl.gz（不可变文件，安全压缩）
  fi
done
# 可选：本地保留 90 天后删除
find "$DIR" -name 'ledger-*.jsonl.gz' -mtime +90 -delete
```

### 3.2 接入 journald / logrotate

- **journald**：进程 stdout 已含 `[LEDGER] {json}` 行，用 systemd unit 直接收编：

```ini
# /etc/systemd/system/veiltalk-signaling.service（节选）
[Service]
ExecStart=/usr/local/bin/bun /home/z/my-project/mini-services/signaling-service/index.ts
Restart=always
StandardOutput=journal
StandardError=journal

# 查询：journalctl -u veiltalk-signaling -o cat | grep LEDGER | jq -r .event | sort | uniq -c
```

- **logrotate**（不想自写脚本时）：

```
# /etc/logrotate.d/veiltalk-ledger
/home/z/my-project/db/ledger/ledger-*.jsonl {
    weekly
    rotate 26
    compress
    delaycompress
    missingok
    notifempty
    dateext
    # 事件在写入端按日期切文件，copytruncate 避免干扰 appendFile 句柄
    copytruncate
}
```

### 3.3 告警建议

| 信号 | 含义 | 建议 |
|---|---|---|
| `signal_drop_oversize` 频发（如 5 分钟 >10 条） | 某端产生了异常 SDP（畸形/被篡改/版本不匹配）或有人滥用信令通道 | Prometheus `rate(ledger_signal_drop_oversize[5m])`；临时用 `grep -c 'signal_drop_oversize' ledger-$(date +%F).jsonl` |
| `peer_leave cause=disconnect:ping timeout` 占比突增 | 网络质量劣化或信令服务过载（pingInterval 25s / pingTimeout 60s） | 结合 `/svc/health` 的 peers/rooms 判断 |
| `room_create` 速率异常 | 房间扫描/滥用探测 | 结合 UA 聚类（`socket_connect.ua`）封禁 |
| `service_start` 频繁 | 进程崩溃循环 | systemd `Restart=always` + crash 日志排查 |
| `relay_signal bytes` 持续逼近 96KB | 接近 `MAX_SIGNAL_BYTES` 阈值，可能丢信令 | 关注 mDNS candidate 数量异常的客户端 |

---

## 4. 隐私合规说明

**记录什么**（全部为运行元数据）：连接时间线（谁/何时/因何加入离开哪个房间）、信令转发的类型与字节数、服务生命周期事件。

**绝不记录**：

- 任何密钥材料（公钥本体、私钥、派生密钥、口令）；
- SDP / ICE candidate 内容（只记 kind 与字节数）；
- 媒体内容、文件名与文件内容、聊天内容（这些流量根本不经过服务器）；
- 客户端 IP（`socket.handshake.address` 不入台账；如需反滥用，建议在网关层限流而非台账记 IP）。

**保留期建议**：

- 热数据（未压缩 JSONL）：30 天，满足排障与日内审计；
- 归档（.gz）：180 天（安全事件回溯窗口）；涉及合规审计的组织可延长至 1 年，到期删除；
- 台账文件权限 `0640`，属主为服务账号；`LEDGER_DIR` 可环境变量重定向到专用数据盘。

**面向用户的声明要点**（可直接用于隐私页）：「服务器只保存『谁在何时加入/离开房间、信令包大小』等运行元数据，用于连接编排与安全审计；通话画面、声音、文件、聊天内容端到端加密，服务器无法读取，也不保存。」
