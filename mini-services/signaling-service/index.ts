/**
 * VeilTalk Signaling Service — 自研 WebRTC 信令服务器（双端口架构）
 *
 * 职责：
 *  1. 房间管理：join / leave / 广播成员变更（mesh 拓扑，每房间上限 MAX_PEERS_PER_ROOM）
 *  2. 信令中继：SDP Offer/Answer、ICE Candidate 在成员间转发（服务器只转发，不可读内容）
 *  3. 元数据台账：以 JSONL 追加写方式记录可审计元数据（绝不记录密钥材料与媒体内容）
 *  4. HTTP API（端口 3004）：/svc/health、/svc/rooms、/svc/ledger（供台账面板与运维探针）
 *
 * 端口说明：
 *  - 3003 = socket.io 信令。path 必须是 '/'（Caddy 网关按 XTransformPort 转发，禁止改动）。
 *    由于 path='/' 时 socket.io 会接管该端口所有 HTTP 请求，运维 HTTP API 单独监听 3004。
 *  - 前端写法：信令 io('/?XTransformPort=3003')；台账 fetch('/svc/ledger?XTransformPort=3004')
 *
 * 安全边界：
 *  - 服务器被设计为"不可信中继"：E2EE 会话密钥经 ECDH 在浏览器间协商，
 *    服务器仅能看到公钥指纹（SHA-256 摘要），永远接触不到私钥/会话密钥/明文媒体。
 *  - 台账遵循"元数据最小化"：记录房间号、peerId、事件、字节数；不记录文件名、
 *    不记录公钥本体、不记录 SDP/candidate 内容。
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'
import { promises as fsp } from 'fs'
import path from 'path'

const WS_PORT = Number(process.env.SIGNALING_PORT || 3003)
const HTTP_PORT = Number(process.env.SIGNALING_HTTP_PORT || 3004)
const LEDGER_DIR = process.env.LEDGER_DIR
  ? path.resolve(process.env.LEDGER_DIR)
  : path.resolve(process.cwd(), '../../db/ledger')
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM || 8)
const ROOM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const MAX_SIGNAL_BYTES = 96 * 1024

/** 管理员密码：必须经 ADMIN_PASSWORD 环境变量设置（本地开发在 mini-services/signaling-service/.env 配置；
 *  缺失时生成随机密码并打印到控制台 —— 绝不内置默认口令，防止公开部署被默认密码接管） */
const ADMIN_PASSWORD = (() => {
  const fromEnv = String(process.env.ADMIN_PASSWORD || '').trim()
  if (fromEnv) return fromEnv
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  console.warn(`[admin] ADMIN_PASSWORD 未设置，本次运行使用临时密码: ${rand}（重启即变；请在 mini-services/signaling-service/.env 中固定）`)
  return rand
})()
/** 成员心跳超时（幽灵会话清理）：超过该时长未心跳的成员被服务端强制离房 */
const PEER_TTL_MS = Number(process.env.PEER_TTL_MS || 60_000)
const HB_SWEEP_INTERVAL_MS = 15_000
/** 台账保留天数：每日自动清理过期 JSONL（0 = 永久保留，仅手动隐私清理） */
const LEDGER_RETENTION_DAYS = Number(process.env.LEDGER_RETENTION_DAYS || 7)
/** join-room 洪水限速：单 socket 在滑动窗口内最多加入次数（防恶意 join/leave 循环刷广播/台账） */
const JOIN_RATE_WINDOW_MS = 10_000
const JOIN_RATE_MAX = 8
/** 合法画质档位（与前端 src/lib/webrtc/tiers.ts 对齐） */
const QUALITY_TIERS = ['360p', '720p', '1080p', '1080p60', '1440p60', '4k30', '4k60', '8k60', '8k144']

/* ------------------------- 服务端持久化配置（全局画质默认档） ------------------------- */

const CONFIG_FILE = path.join(path.dirname(LEDGER_DIR), 'signaling-config.json')
type ServerConfig = { defaultQuality: string; updatedAt: number }
let serverConfig: ServerConfig = { defaultQuality: '720p', updatedAt: 0 }

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ServerConfig>
    if (parsed.defaultQuality && QUALITY_TIERS.includes(parsed.defaultQuality)) {
      serverConfig = { defaultQuality: parsed.defaultQuality, updatedAt: parsed.updatedAt || Date.now() }
      console.log(`[config] loaded defaultQuality=${serverConfig.defaultQuality}`)
    }
  } catch {
    /* 首次运行无配置文件 */
  }
}

async function saveConfig(next: ServerConfig) {
  serverConfig = next
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
}

type PeerMeta = {
  socketId: string
  peerId: string
  name: string
  fingerprint: string
  /** ECDH P-256 公钥（JSON 序列化）—— 公钥本身可公开，服务器仅转发不参与协商；台账只记录指纹 */
  pubkey: string
  /** 自定义头像（96px JPEG dataURL，客户端压缩后随 join 上送；纯展示用，服务器不解析） */
  avatar: string
  joinedTs: number
  /** 最近心跳时间（幽灵会话清理：超时未心跳 → 服务端强制离房） */
  lastSeen: number
}

type Room = {
  id: string
  createdAt: number
  peers: Map<string, PeerMeta> // key = socketId
  /** 房间锁定：锁定后新成员加入被拒绝（房主治理，信令权威校验） */
  locked: boolean
  /** 房主 socketId（首个加入者；离开时迁移给最早加入的剩余成员） */
  hostSocketId: string | null
  /* ---- 准入元数据（Task 30：创建者设置；服务器只比对哈希，不接触明文密码） ---- */
  /** 房间密码哈希（客户端 sha256(roomId:pass) hex；null = 无密码） */
  passHash: string | null
  /** 加入审批模式：auto = 直接进（默认）/ manual = 房主人工批准（等候室） */
  admission: 'auto' | 'manual'
  /** 创建者 peerId（断线重连免审批免密回房） */
  creatorPeerId: string
  /** 曾被准入过的 peerId（同页面会话断线重连不重复审批） */
  knownPeerIds: Set<string>
  /** 人工审核等候队列（key = socketId） */
  pending: Map<string, PendingEntry>
}

/** 等候室条目：保留原始 join 载荷，批准后原样入房 */
type PendingEntry = {
  socketId: string
  peerId: string
  name: string
  ts: number
  payload: Record<string, unknown>
}

/** 服务端管理员 socket 集合（admin-auth 验密后加入；可跨房踢人/免审入房） */
const adminSockets = new Set<string>()
/** 等候室过期时间：超时未批准自动拒绝（防止幽灵等待） */
const PENDING_TTL_MS = 90_000

/** 规范化房间对象（旧字段缺失兼容） */
function ensureRoomMeta(room: Room): Room {
  if (!room.pending) room.pending = new Map()
  if (!room.knownPeerIds) room.knownPeerIds = new Set()
  if (room.admission !== 'manual') room.admission = 'auto'
  return room
}

const rooms = new Map<string, Room>()
const socketRoom = new Map<string, string>()
/** join-room 滑动窗口限速表：socketId → 窗口起始时间戳 + 窗口内计数（disconnect 时回收） */
const joinRate = new Map<string, { winStart: number; count: number }>()
const startedTs = Date.now()

/** 模块级离房（连接回调与管理员清场共用）：广播 peer-left → 房主迁移 → 空房回收 */
function leaveRoom(socket: Socket, cause: string) {
  const roomId = socketRoom.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  socketRoom.delete(socket.id)
  void socket.leave(roomId)
  if (!room) return
  const peer = room.peers.get(socket.id)
  room.peers.delete(socket.id)
  socket.to(roomId).emit('peer-left', {
    socketId: socket.id,
    peerId: peer?.peerId || '',
    name: peer?.name || '',
    cause,
  })
  ledger('peer_leave', { roomId, peerId: peer?.peerId, sid: socket.id, cause, roomSize: room.peers.size })
  // 房主离开 → 迁移给最早加入的剩余成员（治理权限不悬空）
  if (room.hostSocketId === socket.id) {
    const next = [...room.peers.values()].sort((a, b) => a.joinedTs - b.joinedTs)[0]
    room.hostSocketId = next?.socketId || null
    io.to(roomId).emit('room-state', { locked: room.locked, hostSocketId: room.hostSocketId })
    ledger('host_migrate', { roomId, to: room.hostSocketId })
  }
  if (room.peers.size === 0) {
    // 等候室成员随房解散一并拒绝（无人可批准）
    for (const entry of ensureRoomMeta(room).pending.values()) {
      const ps = io.sockets.sockets.get(entry.socketId)
      if (ps) ps.emit('admission-denied', { reason: 'closed' })
    }
    room.pending.clear()
    rooms.delete(roomId)
    ledger('room_close', { roomId })
  }
}

/** 通知房主与房间内管理员：有人请求加入（人工审核） */
function notifyAdmissionRequest(room: Room, entry: { socketId: string; name: string; peerId: string }) {
  const targets = new Set<string>()
  if (room.hostSocketId) targets.add(room.hostSocketId)
  for (const sid of room.peers.keys()) if (adminSockets.has(sid)) targets.add(sid)
  for (const sid of targets) {
    if (sid === entry.socketId) continue
    io.to(sid).emit('admission-request', { socketId: entry.socketId, name: entry.name, peerId: entry.peerId })
  }
}

/**
 * 台账自动保留清理：删除超过保留天数的 ledger-YYYY-MM-DD.jsonl。
 * 每 15s 的清扫 tick 里按「自然日」去重触发（每天最多执行一次磁盘扫描）。
 * 当天文件永不删除；日期取 UTC（与台账文件名生成一致）。
 */
let lastRetentionSweepDay = ''
async function sweepOldLedgerFiles(): Promise<void> {
  if (LEDGER_RETENTION_DAYS <= 0) return
  const day = new Date().toISOString().slice(0, 10)
  if (day === lastRetentionSweepDay) return
  lastRetentionSweepDay = day
  try {
    const names = await fsp.readdir(LEDGER_DIR)
    const cutoff = new Date(Date.now() - LEDGER_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
    let removed = 0
    let bytes = 0
    for (const n of names) {
      const m = /^ledger-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n)
      if (!m || m[1] >= cutoff) continue
      const p = path.join(LEDGER_DIR, n)
      const st = await fsp.stat(p).catch(() => null)
      if (!st) continue
      await fsp.unlink(p).catch(() => {})
      removed++
      bytes += st.size
    }
    if (removed > 0) {
      console.log(`[ledger-retention] removed ${removed} file(s) older than ${cutoff} (${(bytes / 1024).toFixed(1)} KB)`)
      ledger('ledger_retention', { removed, bytes, cutoff, retentionDays: LEDGER_RETENTION_DAYS })
    }
  } catch (e) {
    console.warn('[ledger-retention] sweep failed:', e instanceof Error ? e.message : e)
  }
}

function startGhostSweeper() {
  // 幽灵会话清扫器：心跳超时的成员被服务端强制离房（防「永远在协商中」的僵尸占位）
  // + 等候室过期 + 台账保留清理（三项共用同一 tick，减少空转定时器）
  return setInterval(() => {
    // 台账保留清理（自然日去重，内部自捕获异常）
    void sweepOldLedgerFiles()
    // 等候室 TTL：超时未批准自动拒绝（fail-closed，候选人可重新申请）
    const nowTs = Date.now()
    for (const room of rooms.values()) {
      for (const entry of [...ensureRoomMeta(room).pending.values()]) {
        if (nowTs - entry.ts > PENDING_TTL_MS) {
          room.pending.delete(entry.socketId)
          const ps = io.sockets.sockets.get(entry.socketId)
          if (ps) ps.emit('admission-denied', { reason: 'timeout' })
          ledger('admission_timeout', { roomId: room.id, sid: entry.socketId })
        }
      }
    }
    const now = Date.now()
    let swept = 0
    for (const room of rooms.values()) {
      for (const meta of [...room.peers.values()]) {
        if (now - meta.lastSeen > PEER_TTL_MS) {
          const s = io.sockets.sockets.get(meta.socketId)
          if (s) {
            leaveRoom(s, 'heartbeat-timeout')
            try { s.disconnect(true) } catch { /* noop */ }
          } else {
            // socket 已死但未触发 disconnect 的极端情况：直接摘除成员
            room.peers.delete(meta.socketId)
            io.to(room.id).emit('peer-left', {
              socketId: meta.socketId,
              peerId: meta.peerId,
              name: meta.name,
              cause: 'heartbeat-timeout',
            })
            if (room.peers.size === 0 && rooms.has(room.id)) {
              rooms.delete(room.id)
              ledger('room_close', { roomId: room.id })
            }
          }
          swept++
          ledger('ghost_sweep', { roomId: room.id, peerId: meta.peerId, idleSec: Math.round((now - meta.lastSeen) / 1000) })
        }
      }
    }
    if (swept > 0) console.log(`[ghost-sweeper] removed ${swept} stale peer(s)`)
  }, HB_SWEEP_INTERVAL_MS)
}

/* ---------------------------------- 台账 ---------------------------------- */

let ledgerQueue: Promise<void> = Promise.resolve()

async function appendLedgerFile(entry: Record<string, unknown>) {
  await fsp.mkdir(LEDGER_DIR, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(LEDGER_DIR, `ledger-${day}.jsonl`)
  await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
}

/** 追加一条台账（串行化写入，保证 JSONL 行完整性）。只允许元数据字段。 */
function ledger(event: string, data: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), event, ...data }
  ledgerQueue = ledgerQueue
    .then(() => appendLedgerFile(entry))
    .catch((e) => console.error('[ledger] write failed:', e))
  console.log('[LEDGER]', JSON.stringify(entry))
}

/* -------------------------- HTTP API（端口 3004） -------------------------- */

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    // 安全加固：防 MIME 嗅探（JSON 接口永不该被浏览器解释为 HTML/脚本）
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(payload)
}

/* ------------------------------- 管理员鉴权 ------------------------------- */

/** 从 header 或 body 提取管理员密码并校验 */
function checkAdmin(req: IncomingMessage, bodyPassword?: unknown): boolean {
  const header = String(req.headers['x-admin-pass'] || '')
  const pass = header || String(bodyPassword || '')
  return pass.length > 0 && pass === ADMIN_PASSWORD
}

/** 管理员总览：房间/成员明细 + 连接数 + 内存（幽灵会话排查数据源） */
function adminOverview() {
  const now = Date.now()
  return {
    ts: now,
    uptimeSec: Math.floor((Date.now() - startedTs) / 1000),
    memory: process.memoryUsage(),
    sockets: io.sockets.sockets.size,
    config: { ...serverConfig },
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      createdAt: new Date(r.createdAt).toISOString(),
      peerCount: r.peers.size,
      locked: r.locked,
      hostPeerId: r.peers.get(r.hostSocketId || '')?.peerId || null,
      peers: [...r.peers.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        fingerprint: p.fingerprint.slice(0, 16),
        joinedTs: new Date(p.joinedTs).toISOString(),
        idleSec: Math.round((now - p.lastSeen) / 1000),
      })),
    })),
  }
}

/** 一键清场：强制断开全部成员（可按房间）；返回清场统计 */
function purgeRooms(roomId?: string): { rooms: number; peers: number } {
  const targets = roomId ? [...rooms.values()].filter((r) => r.id === roomId) : [...rooms.values()]
  let peers = 0
  for (const room of targets) {
    peers += room.peers.size
    for (const sid of [...room.peers.keys()]) {
      const s = io.sockets.sockets.get(sid)
      if (s) {
        // 走标准离房流程广播 peer-left（cause=server-purge），再断开 socket
        leaveRoom(s, 'server-purge')
        try { s.disconnect(true) } catch { /* noop */ }
      }
    }
    if (rooms.has(room.id)) rooms.delete(room.id)
    ledger('admin_purge_room', { roomId: room.id, peers })
  }
  return { rooms: targets.length, peers }
}

/** 清理元数据台账文件（隐私清理：全部按日 JSONL 删除） */
async function purgeLedger(): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  try {
    const names = await fsp.readdir(LEDGER_DIR)
    for (const n of names) {
      if (!n.startsWith('ledger-') || !n.endsWith('.jsonl')) continue
      const p = path.join(LEDGER_DIR, n)
      const st = await fsp.stat(p).catch(() => null)
      if (!st) continue
      bytes += st.size
      await fsp.rm(p, { force: true })
      files++
    }
  } catch {
    /* 目录不存在视为 0 */
  }
  ledger('admin_purge_ledger', { files, bytes })
  return { files, bytes }
}

function readLedgerFile(date: string): Promise<string[]> {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10)
  const file = path.join(LEDGER_DIR, `ledger-${safe}.jsonl`)
  return fsp
    .readFile(file, 'utf8')
    .then((t) => t.split('\n').filter(Boolean))
    .catch(() => [])
}

async function listLedgerDates(): Promise<string[]> {
  try {
    const names = await fsp.readdir(LEDGER_DIR)
    return names
      .filter((n) => n.startsWith('ledger-') && n.endsWith('.jsonl'))
      .map((n) => n.slice(7, -6))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

const httpHandler = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const route = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
    })
    res.end()
    return
  }

  async function readBody(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve((JSON.parse(raw || '{}') as Record<string, unknown>) || {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  if (route === '/' || route === '/svc/health') {
    const peersTotal = [...rooms.values()].reduce((n, r) => n + r.peers.size, 0)
    return sendJson(res, 200, {
      ok: true,
      service: 'veiltalk-signaling',
      version: '1.0.0',
      uptimeSec: Math.floor((Date.now() - startedTs) / 1000),
      rooms: rooms.size,
      peers: peersTotal,
      maxPeersPerRoom: MAX_PEERS_PER_ROOM,
      ledgerDir: LEDGER_DIR,
      ts: new Date().toISOString(),
    })
  }

  if (route === '/svc/rooms') {
    const list = [...rooms.values()].map((r) => ({
      id: r.id,
      createdAt: new Date(r.createdAt).toISOString(),
      peerCount: r.peers.size,
      locked: r.locked,
      admission: ensureRoomMeta(r).admission,
      hasPassword: !!r.passHash,
      pendingCount: r.pending.size,
      peers: [...r.peers.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        fingerprint: p.fingerprint,
        joinedTs: new Date(p.joinedTs).toISOString(),
      })),
    }))
    return sendJson(res, 200, { ok: true, count: list.length, rooms: list })
  }

  if (route === '/svc/ledger') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000)
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
    const filter = url.searchParams.get('event') || ''
    const lines = await readLedgerFile(date)
    let entries = lines.map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { ts: null, event: 'parse_error', raw: l.slice(0, 200) }
      }
    })
    if (filter) entries = entries.filter((e) => String(e.event).includes(filter))
    const dates = await listLedgerDates()
    return sendJson(res, 200, {
      ok: true,
      date,
      availableDates: dates,
      total: entries.length,
      entries: entries.slice(-limit).reverse(),
    })
  }

  if (route === '/svc/config') {
    // 全局画质默认档（公开只读；写入走 /svc/admin/config）
    return sendJson(res, 200, { ok: true, defaultQuality: serverConfig.defaultQuality, updatedAt: serverConfig.updatedAt })
  }

  /* ----------------------------- 管理员 API ----------------------------- */

  if (route === '/svc/admin/login' && req.method === 'POST') {
    const body = await readBody()
    if (!checkAdmin(req, body.password)) {
      ledger('admin_login_fail', {})
      return sendJson(res, 401, { ok: false, error: 'password incorrect' })
    }
    return sendJson(res, 200, { ok: true, overview: adminOverview() })
  }

  if (route === '/svc/admin/overview') {
    if (!checkAdmin(req)) return sendJson(res, 401, { ok: false, error: 'password incorrect' })
    return sendJson(res, 200, { ok: true, overview: adminOverview() })
  }

  if (route === '/svc/admin/config' && req.method === 'POST') {
    const body = await readBody()
    if (!checkAdmin(req, body.password)) return sendJson(res, 401, { ok: false, error: 'password incorrect' })
    const tier = String(body.defaultQuality || '')
    if (!QUALITY_TIERS.includes(tier)) {
      return sendJson(res, 400, { ok: false, error: `invalid tier (allowed: ${QUALITY_TIERS.join('/')})` })
    }
    await saveConfig({ defaultQuality: tier, updatedAt: Date.now() })
    ledger('admin_config', { defaultQuality: tier })
    return sendJson(res, 200, { ok: true, config: { ...serverConfig } })
  }

  if (route === '/svc/admin/purge' && req.method === 'POST') {
    const body = await readBody()
    if (!checkAdmin(req, body.password)) return sendJson(res, 401, { ok: false, error: 'password incorrect' })
    const scope = String(body.scope || 'rooms')
    const roomId = body.roomId ? String(body.roomId) : undefined
    if (scope === 'rooms' || scope === 'all') {
      const r = purgeRooms(roomId)
      if (scope === 'rooms') return sendJson(res, 200, { ok: true, scope, ...r })
    }
    if (scope === 'ledger' || scope === 'all') {
      const l = await purgeLedger()
      if (scope === 'ledger') return sendJson(res, 200, { ok: true, scope, ...l })
      const r = purgeRooms()
      return sendJson(res, 200, { ok: true, scope, ...l, ...r })
    }
    return sendJson(res, 400, { ok: false, error: 'invalid scope (rooms/ledger/all)' })
  }

  return sendJson(res, 404, { ok: false, error: 'not found' })
}

const httpServer = createServer((req, res) => {
  void httpHandler(req, res)
})

/* ------------------------------- socket.io -------------------------------- */

const wsServer = createServer()

const io = new Server(wsServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 128 * 1024,
})

function roomSummary(room: Room) {
  return [...room.peers.values()].map((p) => ({
    socketId: p.socketId,
    peerId: p.peerId,
    name: p.name,
    fingerprint: p.fingerprint,
    pubkey: p.pubkey,
    avatar: p.avatar,
    joinedTs: p.joinedTs,
  }))
}

io.on('connection', (socket: Socket) => {
  console.log(`[ws] connected: ${socket.id}`)
  ledger('socket_connect', {
    sid: socket.id,
    ua: String(socket.handshake.headers['user-agent'] || '').slice(0, 120),
  })

  /* ------------------- Task 30：房间准入（密码 / 人工审核 / 探测） ------------------- */

  /** 房间信息探测（大厅输入房间码时防抖查询）：是否存在/有密码/审批模式/人数 */
  socket.on('room-info', (payload: unknown, ack?: (r: unknown) => void) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as { roomId?: string }
    const roomId = String(p.roomId || '')
    if (!ROOM_ID_RE.test(roomId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'bad room id' })
      return
    }
    const room = rooms.get(roomId)
    if (typeof ack === 'function') {
      ack({
        ok: true,
        exists: !!room,
        hasPassword: !!room?.passHash,
        admission: room?.admission || 'auto',
        memberCount: room?.peers.size || 0,
        locked: room?.locked || false,
      })
    }
  })

  /** 管理员 socket 鉴权（验 ADMIN_PASSWORD）：解锁跨房踢人/免审入房等管理能力 */
  socket.on('admin-auth', (payload: unknown, ack?: (r: unknown) => void) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as { password?: string }
    const ok = String(p.password || '') === ADMIN_PASSWORD
    if (ok) {
      adminSockets.add(socket.id)
      ledger('admin_socket_auth', { sid: socket.id })
    } else {
      ledger('admin_socket_auth_fail', { sid: socket.id })
    }
    if (typeof ack === 'function') ack({ ok })
  })

  /** 房主/管理员批准或拒绝等候室成员（admit=true → 原样入房流程） */
  socket.on('admission-respond', (payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as { socketId?: string; admit?: boolean }
    const targetId = String(p.socketId || '')
    if (!targetId) return
    const entryRoom = [...rooms.values()].find((r) => r.pending.has(targetId))
    if (!entryRoom) return
    const allowed = entryRoom.hostSocketId === socket.id || adminSockets.has(socket.id)
    if (!allowed) {
      ledger('admission_respond_denied_perm', { roomId: entryRoom.id, sid: socket.id, target: targetId })
      return
    }
    const entry = entryRoom.pending.get(targetId)
    entryRoom.pending.delete(targetId)
    if (p.admit === true && entry) {
      const targetSocket = io.sockets.sockets.get(targetId)
      const ackPayload = {
        ok: true,
        self: { socketId: targetId, peerId: entry.peerId, roomId: entryRoom.id },
        locked: entryRoom.locked,
        hostSocketId: entryRoom.hostSocketId,
        serverTs: Date.now(),
      }
      if (targetSocket) {
        admitSocket(targetSocket, entryRoom.id, entry.payload, ackPayload)
        // 候选人端收到该事件后走标准入房流程（与 join ack 同构）
        targetSocket.emit('admission-granted', ackPayload)
        ledger('admission_granted', { roomId: entryRoom.id, sid: targetId, name: entry.name })
      }
    } else {
      const targetSocket = io.sockets.sockets.get(targetId)
      if (targetSocket) targetSocket.emit('admission-denied', { reason: 'denied' })
      ledger('admission_denied', { roomId: entryRoom.id, sid: targetId, name: entry?.name || '' })
    }
  })

  /** 候选人取消等待（等待页「取消」按钮） */
  socket.on('admission-cancel', () => {
    for (const room of rooms.values()) {
      if (ensureRoomMeta(room).pending.delete(socket.id)) {
        ledger('admission_cancel', { roomId: room.id, sid: socket.id })
      }
    }
  })

  /** 核心入房流程（join-room 直通与等候室批准共用）：建成员/广播/ack */
  function admitSocket(
    s: Socket,
    roomId: string,
    payload: Record<string, unknown>,
    ackPayload?: Record<string, unknown>,
  ) {
    const room = ensureRoomMeta(rooms.get(roomId) || (() => { throw new Error('room missing') })())
    const peerId = String(payload.peerId || '')
    const name = String(payload.name || '匿名访客').slice(0, 32)
    const meta: PeerMeta = {
      socketId: s.id,
      peerId,
      name,
      fingerprint: String(payload.fingerprint || '').slice(0, 128),
      pubkey: String(payload.pubkey || '').slice(0, 2048),
      avatar: String(payload.avatar || '').slice(0, 8192),
      joinedTs: Date.now(),
      lastSeen: Date.now(),
    }
    room.peers.set(s.id, meta)
    room.knownPeerIds.add(peerId)
    room.pending.delete(s.id)
    socketRoom.set(s.id, roomId)
    void s.join(roomId)
    // 首个成员成为房主（房主拥有踢人/锁定权限）
    if (!room.hostSocketId || room.peers.size === 1) room.hostSocketId = s.id

    // 通知老成员
    s.to(roomId).emit('peer-joined', {
      socketId: meta.socketId,
      peerId: meta.peerId,
      avatar: meta.avatar,
      name: meta.name,
      fingerprint: meta.fingerprint,
      pubkey: meta.pubkey,
      joinedTs: meta.joinedTs,
    })

    const peers = roomSummary(room).filter((x) => x.socketId !== s.id)
    if (ackPayload) {
      ;(ackPayload as Record<string, unknown>).ok = true
      ;(ackPayload as Record<string, unknown>).self = { socketId: s.id, peerId, roomId }
      ;(ackPayload as Record<string, unknown>).peers = peers
      ;(ackPayload as Record<string, unknown>).locked = room.locked
      ;(ackPayload as Record<string, unknown>).hostSocketId = room.hostSocketId
      ;(ackPayload as Record<string, unknown>).serverTs = Date.now()
    }
    ledger('peer_join', { roomId, peerId, sid: s.id, name, roomSize: room.peers.size })
    console.log(`[room:${roomId}] ${name}(${peerId}) joined, size=${room.peers.size}`)
  }

  socket.on('join-room', (payload: unknown, ack?: (r: unknown) => void) => {
    try {
      // 洪水限速：单 socket 每 10s 最多 8 次 join-room（正常重连/换房远低于此阈值）。
      // 超限直接拒绝且不计入台账（防刷盘），socket 不断开（避免误伤同一连接上的正常用户）。
      const nowMs = Date.now()
      const rate = joinRate.get(socket.id)
      if (!rate || nowMs - rate.winStart >= JOIN_RATE_WINDOW_MS) {
        joinRate.set(socket.id, { winStart: nowMs, count: 1 })
      } else if (++rate.count > JOIN_RATE_MAX) {
        console.warn(`[rate-limit] join-room flood from ${socket.id} (${rate.count}/${JOIN_RATE_MAX})`)
        if (typeof ack === 'function') ack({ ok: false, error: '操作过于频繁，请稍后再试', code: 'RATE_LIMITED' })
        return
      }

      const p = (typeof payload === 'object' && payload !== null ? payload : {}) as {
        roomId?: string
        peerId?: string
        name?: string
        fingerprint?: string
        pubkey?: string
        avatar?: string
        roomPassHash?: string
        admission?: string
        isCreate?: boolean
      }
      const roomId = String(p.roomId || '')
      const peerId = String(p.peerId || '')
      const name = String(p.name || '匿名访客').slice(0, 32)

      if (!ROOM_ID_RE.test(roomId) || !peerId) {
        if (typeof ack === 'function') ack({ ok: false, error: '房间号格式非法（4-64位字母数字）' })
        return
      }

      // 同一 socket 重复加入：先离开旧房间
      if (socketRoom.has(socket.id)) leaveRoom(socket, 'rejoin')

      const roomPassHash = typeof p.roomPassHash === 'string' ? p.roomPassHash.slice(0, 64) : ''
      const isAdmin = adminSockets.has(socket.id)
      let room = rooms.get(roomId)
      if (!room) {
        // 新房间：创建者设置准入元数据（密码哈希 + 审批模式）
        room = {
          id: roomId,
          createdAt: Date.now(),
          peers: new Map(),
          locked: false,
          hostSocketId: null,
          passHash: p.isCreate && roomPassHash ? roomPassHash : null,
          admission: p.admission === 'manual' ? 'manual' : 'auto',
          creatorPeerId: peerId,
          knownPeerIds: new Set(),
          pending: new Map(),
        }
        rooms.set(roomId, room)
        ledger('room_create', { roomId, admission: room.admission, protected: !!room.passHash })
      } else {
        ensureRoomMeta(room)
        const isCreator = peerId === room.creatorPeerId
        const known = room.knownPeerIds.has(peerId)
        // 房间密码校验（创建者/管理员/已知成员重连豁免）
        if (room.passHash && !isCreator && !isAdmin && !known && roomPassHash !== room.passHash) {
          if (typeof ack === 'function') ack({ ok: false, error: '房间密码不正确', code: 'ROOM_PASSWORD' })
          ledger('join_reject_password', { roomId, sid: socket.id })
          return
        }
        // 人工审核：创建者/管理员/已知成员（同页会话重连）豁免，其余进等候室
        if (room.admission === 'manual' && !isCreator && !isAdmin && !known && !room.peers.has(socket.id)) {
          room.pending.set(socket.id, { socketId: socket.id, peerId, name, ts: Date.now(), payload: p as Record<string, unknown> })
          if (typeof ack === 'function') ack({ ok: false, pending: true, code: 'PENDING', error: '等待房主批准加入' })
          notifyAdmissionRequest(room, { socketId: socket.id, name, peerId })
          ledger('admission_request', { roomId, sid: socket.id, name })
          return
        }
      }
      // 房间锁定：新成员准入拒绝（已有成员重连不受影响）
      if (room.locked && !room.peers.has(socket.id) && !isAdmin) {
        if (typeof ack === 'function')
          ack({ ok: false, error: '房间已锁定：房主已开启准入锁定，暂时无法加入', code: 'ROOM_LOCKED' })
        ledger('join_reject_locked', { roomId, sid: socket.id })
        return
      }
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        if (typeof ack === 'function')
          ack({ ok: false, error: `房间已满（上限 ${MAX_PEERS_PER_ROOM} 人，mesh 模式）` })
        return
      }

      admitSocket(socket, roomId, p as Record<string, unknown>, undefined)
      // 回填 join ack（admitSocket 内部已生成标准 payload；这里用调用方的 ack 回传）
      if (typeof ack === 'function') {
        const rm = ensureRoomMeta(rooms.get(roomId)!)
        ack({
          ok: true,
          self: { socketId: socket.id, peerId, roomId },
          peers: roomSummary(rm).filter((x) => x.socketId !== socket.id),
          locked: rm.locked,
          hostSocketId: rm.hostSocketId,
          serverTs: Date.now(),
        })
      }
    } catch (e) {
      console.error('join-room error', e)
      if (typeof ack === 'function') ack({ ok: false, error: '服务器内部错误' })
    }
  })

  /** 信令中继：data = { description?: {type, sdp}, candidate?: RTCIceCandidateInit } */
  socket.on('signal', (payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      to?: string
      data?: { description?: { type?: string; sdp?: string }; candidate?: unknown }
    }
    const to = String(p.to || '')
    const roomId = socketRoom.get(socket.id)
    if (!roomId || !to || !rooms.get(roomId)?.peers.has(to)) return
    const raw = JSON.stringify(p.data || {})
    if (raw.length > MAX_SIGNAL_BYTES) {
      console.warn(`[signal] dropped oversized payload ${raw.length}B ${socket.id} -> ${to}`)
      ledger('signal_drop_oversize', { roomId, sid: socket.id, to, bytes: raw.length })
      return
    }
    const kind = p.data?.description
      ? `sdp:${p.data.description.type}`
      : p.data?.candidate
        ? 'ice'
        : 'unknown'
    io.to(to).emit('signal', { from: socket.id, data: p.data })
    // 只记元数据：类型与字节数，不记录 sdp/candidate 内容
    if (kind.startsWith('sdp')) {
      ledger('relay_signal', { roomId, kind, from: socket.id, to, bytes: raw.length })
    }
  })

  socket.on('leave-room', () => {
    if (socketRoom.has(socket.id)) leaveRoom(socket, 'voluntary')
  })

  /** 成员心跳（房间内每 15s 一次）：刷新 TTL，超时未心跳 → 幽灵清扫器强制离房 */
  socket.on('hb', () => {
    const roomId = socketRoom.get(socket.id)
    if (!roomId) return
    const room = rooms.get(roomId)
    const meta = room?.peers.get(socket.id)
    if (meta) meta.lastSeen = Date.now()
  })

  /* ------------------------- 房间治理：锁定 / 踢人 ------------------------- */

  const isHost = (roomId: string): boolean => {
    const room = rooms.get(roomId)
    return !!room && room.hostSocketId === socket.id
  }

  /** 房主锁定/解锁房间（锁定后新加入被拒绝；台账只记 sid 与状态，无内容字段） */
  socket.on('lock-room', (payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as { locked?: boolean }
    const roomId = socketRoom.get(socket.id)
    const room = roomId ? rooms.get(roomId) : undefined
    if (!roomId || !room) return
    if (!isHost(roomId)) {
      console.warn(`[governance] lock-room denied (not host): ${socket.id} @ ${roomId}`)
      return
    }
    room.locked = p.locked === true
    io.to(roomId).emit('room-state', { locked: room.locked, hostSocketId: room.hostSocketId })
    ledger('room_lock', { roomId, sid: socket.id, locked: room.locked })
    console.log(`[room:${roomId}] lock=${room.locked} by ${socket.id}`)
  })

  /** 房主/服务器管理员移出成员（Task 30：管理员 admin-auth 后可跨房踢人）；对端收到 peer-kicked 后本地清理回大厅 */
  socket.on('kick-peer', (payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as { socketId?: string; roomId?: string }
    const targetId = String(p.socketId || '')
    const isAdmin = adminSockets.has(socket.id)
    // 目标所在房间：优先请求者所在房；管理员跨房时按目标反查或显式 roomId
    const roomId = (p.roomId && rooms.has(String(p.roomId)) ? String(p.roomId) : socketRoom.get(socket.id)) || socketRoom.get(targetId)
    const room = roomId ? rooms.get(roomId) : undefined
    if (!roomId || !room) return
    if (!isHost(roomId) && !isAdmin) {
      console.warn(`[governance] kick-peer denied (not host/admin): ${socket.id} -> ${targetId} @ ${roomId}`)
      ledger('kick_denied', { roomId, sid: socket.id, target: targetId })
      return
    }
    if (!targetId || !room.peers.has(targetId) || targetId === socket.id) return
    const target = room.peers.get(targetId)
    const hostName = room.peers.get(socket.id)?.name || ''
    const targetSocket = io.sockets.sockets.get(targetId)
    // 先通知目标（本地清理带原因），再走通用离房流程（广播 peer-left cause=kicked）
    if (targetSocket) targetSocket.emit('peer-kicked', { byName: hostName })
    ledger('peer_kick', { roomId, by: socket.id, byName: hostName.slice(0, 32), target: targetId, targetName: (target?.name || '').slice(0, 32) })
    console.log(`[room:${roomId}] kick ${targetId}(${target?.name}) by ${socket.id}`)
    if (targetSocket) leaveRoom(targetSocket, 'kicked')
  })

  socket.on('disconnect', (reason: string) => {
    if (socketRoom.has(socket.id)) leaveRoom(socket, `disconnect:${reason}`)
    // 管理员身份随连接销毁；等候室条目一并清理
    adminSockets.delete(socket.id)
    for (const room of rooms.values()) ensureRoomMeta(room).pending.delete(socket.id)
    // 限速表回收（防长生命周期 Map 无限增长）
    joinRate.delete(socket.id)
    console.log(`[ws] disconnected: ${socket.id} (${reason})`)
    ledger('socket_disconnect', { sid: socket.id, reason })
  })

  socket.on('error', (e: unknown) => {
    console.error(`[ws] socket error ${socket.id}:`, e)
  })
})

wsServer.listen(WS_PORT, () => {
  console.log(`VeilTalk signaling (socket.io) on port ${WS_PORT}`)
  ledger('service_start', { wsPort: WS_PORT, ledgerDir: LEDGER_DIR, maxPeersPerRoom: MAX_PEERS_PER_ROOM })
  void loadConfig()
  startGhostSweeper()
})

httpServer.listen(HTTP_PORT, () => {
  console.log(`VeilTalk signaling HTTP API on port ${HTTP_PORT}`)
})

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...')
  ledger('service_stop', { reason: 'SIGTERM' })
  wsServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...')
  ledger('service_stop', { reason: 'SIGINT' })
  wsServer.close(() => process.exit(0))
})
