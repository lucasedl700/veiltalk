/**
 * VeilTalk RoomClient — 房间编排器（信令 ↔ PeerSession ↔ 本地媒体 ↔ 文件/聊天）
 *
 * 模块职责：
 *  1. 信令连接：socket.io（io('/?XTransformPort=3003')），自动重连后自动重新入房
 *  2. 身份管理：会话级 ECDH P-256 身份（非持久）、公钥指纹、房间盐（口令可选）
 *  3. 密钥协商：与每个成员派生 8 把方向隔离密钥（deriveRawKeys）并注入 PeerSession
 *  4. 媒体管理：getUserMedia（失败降级为"仅数据模式"）、设备切换、屏幕共享 replaceTrack
 *  5. 会话生命周期：peer-joined/peer-left → 创建/销毁 PeerSession + FileSender/FileReceiver
 *  6. 聊天与文件：加密广播/单发；传输事件上抛（由调用方写入 store）
 *
 * 该类不持有 React 状态，通过 handlers 回调与外界解耦，便于测试与复用。
 */

import {
  bufToB64,
  b64ToBuf,
  decryptFrame,
  deriveRawKeys,
  deriveSharedBits,
  encryptFrame,
  fingerprintJwk,
  generateIdentity,
  randomId,
  roomSalt,
  safetyNumber,
} from './crypto-core'
import {
  bindPakeSecret,
  spakeComputeKey,
  spakeStart,
  spakeVerifyProof,
  type SpakeRole,
} from './spake2'
import { PeerSession } from './peer-session'
import { FileReceiver, FileSender } from './file-transfer'
import { DcKeyRing } from './dc-ratchet'
import type {
  JoinRoomAck,
  LogEntry,
  PeerBrief,
  PeerStats,
  RawKeySet,
  SignalData,
  TransferState,
} from './types'
import { detectCapability, e2eeManager } from './e2ee-manager'
import { useVeil } from '@/store/veil-store'
import { constraintsFor, isMobileUA, mobileClampActive, resolveTier, type QualityTier } from './tiers'
import { applyServerPick } from './servers'
import { FrameEnhancer } from './enhance'
import { FrameInterpolator } from './interpolate'
import { VirtualBackground, type VbgMode, type VbgGradient } from './virtual-bg'

/** 虚拟背景自定义图 dataURL → HTMLImageElement（解码失败返回 null，回退渐变预设） */
async function loadImageOrNull(dataUrl: string | null): Promise<HTMLImageElement | null> {
  if (!dataUrl) return null
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('decode'))
      img.src = dataUrl
    })
    return img
  } catch {
    return null
  }
}

/** 本地保存的自定义头像（96px JPEG dataURL；无则空串） */
function readLocalAvatar(): string {
  try {
    return localStorage.getItem('veil-avatar') || ''
  } catch {
    return ''
  }
}

export type SignalingState = 'idle' | 'connecting' | 'online' | 'offline'

export interface RoomClientHandlers {
  onLog: (level: LogEntry['level'], msg: string, detail?: string) => void
  onSignaling: (state: SignalingState) => void
  onJoined: (info: { roomId: string; socketId: string; peerId: string; e2eeMode: string }) => void
  onLeft: () => void
  onPeersChanged: (peers: PeerBrief[]) => void
  onLocalStream: (stream: MediaStream | null) => void
  onScreenStream: (stream: MediaStream | null) => void
  onMediaError: (err: string) => void
  onRemoteStream: (socketId: string, stream: MediaStream | null) => void
  onPeerState: (socketId: string, state: RTCPeerConnectionState) => void
  onPeerStats: (socketId: string, stats: PeerStats) => void
  onPeerE2EE: (socketId: string, info: { video: string; audio: string; videoRecv?: string; audioRecv?: string; safety?: string }) => void
  onTransfer: (t: TransferState) => void
  /** 对端显式回执（F-33 file-ack）：接收端重组校验后回发；socketId=回执来源对端 */
  onTransferAck: (socketId: string, transferId: string, ok: boolean) => void
  onChat: (c: { id: string; from: string; name: string; ts: number; text: string; mine: boolean }) => void
  /** 对端撤回了一条聊天消息（按 id 标记） */
  onChatRecall: (id: string) => void
  /** 房间成员事件（来自信令源头，精确于 peers diff）：加入 / 离开；left 时 cause 区分「主动退出/连接中断/被移出」 */
  onPeerEvent: (name: string, kind: 'joined' | 'left', cause?: string) => void
  onAdaptive: (socketId: string, kbps: number) => void
  /** 对端输入中状态变化（布尔 = 是否正在输入） */
  onTyping: (socketId: string, name: string, on: boolean) => void
  /** 收到对端的静音/关摄像头请求（成员治理；内容仅类型，无音视频数据） */
  onMuteRequest: (socketId: string, name: string, kind: 'audio' | 'video') => void
  /** 指纹互核：对端发来核实请求（本端已自动回发）；ok=对端声称指纹与信令公钥一致 */
  onVerifyRequest: (socketId: string, name: string, ok: boolean) => void
  /** 指纹互核：本端请求的回发结果；ok=对端声称指纹与其真实指纹一致；timeout=对端未响应 */
  onVerifyResult: (socketId: string, name: string, ok: boolean, timeout?: boolean) => void
  /** 观看端实测画质回传：对端实际解码到的我的画面（分辨率/帧率/RTT） */
  onQualityReport?: (socketId: string, q: { w: number; h: number; fps: number; rtt: number | null }) => void
  /** PAKE（SPAKE2）口令认证通过：密钥已绑入口令认证（与对端互验完成） */
  onPakeVerified: (socketId: string, name: string) => void
  /** PAKE 失败（口令不一致/中间人/超时）：fail-closed，未建立任何会话密钥 */
  onPakeFailed: (socketId: string, name: string, reason: string) => void
  /**
   * ICE 服务器可达性探测结果（connect() 拉取配置后主动探测一次）：
   * relay=TURN 可用 / srflx=STUN 可达 / none=无候选 / timeout=探测超时
   */
  onIceProbe: (result: 'relay' | 'srflx' | 'none' | 'timeout') => void
  /** 对端对某条聊天消息的表情回应变化（on=false 表示取消） */
  onChatReact: (id: string, emoji: string, on: boolean) => void
  /** 对端发送了会议级 Emoji 反应（F-41，Zoom 式舞台浮层；仅符号无内容） */
  onReaction: (socketId: string, name: string, emoji: string) => void
  /** 对端举手/放下（F-42；up=false 表示放下） */
  onHand: (socketId: string, name: string, up: boolean) => void
  /** 房间治理状态同步：锁定状态与房主（信令权威下发） */
  onRoomState: (state: { locked: boolean; hostSocketId: string | null }) => void
  /** 对端屏幕共享状态变化（控制面消息 t:'share'；UI 聚焦/徽标用） */
  onPeerShare: (socketId: string, on: boolean) => void
  /** 屏幕共享开启后检测到出流停滞（对端可能看不到共享画面） */
  onScreenShareWarn: () => void
  /** 当前浏览器/系统不支持屏幕共享采集（iOS 全系等） */
  onScreenShareUnsupported: () => void
  /** 本端被房主移出房间（自动回大厅，fail-closed） */
  onKicked: (byName: string) => void
  /** 对端麦克风/摄像头状态变化（控制面 t:'media-state' 同步） */
  onPeerMediaState: (socketId: string, state: { micOn?: boolean; camOn?: boolean }) => void
  /** 对端正在说话/停止（控制面 t:'speaking' 广播；发送端 AGC 归一化判定） */
  onPeerSpeaking: (socketId: string, speaking: boolean) => void
  /** 加入请求进入等候室（房间开启人工审核；UI 显示等待卡） */
  onAdmissionPending: () => void
  /** 加入申请被拒（房主拒绝/超时/房间解散；UI 回大厅并说明原因） */
  onAdmissionDenied: (reason: string) => void
  /** 房主端：有人申请加入（人工审核等候室；UI 审批横幅） */
  onAdmissionRequest: (socketId: string, name: string) => void
}

interface SessionBundle {
  session: PeerSession
  sender: FileSender | null
  receiver: FileReceiver | null
  peer: PeerBrief
  /** DataChannel 轮换环（聊天/文件各方向独立 epoch 链，见 dc-ratchet.ts） */
  chatOut: DcKeyRing
  chatIn: DcKeyRing
  fileOut: DcKeyRing
  fileIn: DcKeyRing
  /** 应用层 E2EE 是否对该会话生效（双方能力 + 双方开关协商；false = 仅 DTLS-SRTP 传输加密） */
  secure: boolean
  /** 上次向对端回传实测画质的时间戳（5s 节流） */
  lastQReportTs: number
  /** 上次共享重同步请求时间（观看端入站停滞节流） */
  lastResyncTs: number
  /** 上次响应共享重同步时间（发送端节流，防止风暴） */
  lastSyncRespTs: number
}
/**
 * 默认公共 STUN（ICE 提速优化，BUG 反馈「协商很久」）：
 *  - Cloudflare 优先（Anycast，全球含亚太可达性好，部分网络下 Google 不可达）；
 *  - 多服务器并行收集候选（收集是并行的，多加不增加时延，反而提高拿到 srflx 的概率）；
 *  - 自建部署务必通过环境变量配置 TURN（/api/ice-config），跨网络/对称 NAT 无中继基本必败。
 */
const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.nextcloud.com:443' },
]

/**
 * 房间密码哈希（Task 30 准入门禁）：明文不出浏览器 —— sha256(`${roomId}:${pass}`) hex。
 * 服务器只比对哈希；这是准入门禁（lightweight gate），真正的内容安全仍由 E2EE/PAKE 承担。
 */
export async function hashRoomPass(roomId: string, pass: string): Promise<string> {
  const data = new TextEncoder().encode(`${roomId}:${pass}`)
  const digest = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type RoomInfo = {
  ok: boolean
  exists: boolean
  hasPassword: boolean
  admission: 'auto' | 'manual'
  memberCount: number
  locked: boolean
}

export type JoinOpts = {
  /** 房间密码哈希（hashRoomPass 产出；创建时设置/加入时校验） */
  roomPassHash?: string
  /** 审批模式（仅创建新房间时生效） */
  admission?: 'auto' | 'manual'
  /** 显式创建语义（新房间时携带密码/审批设置） */
  create?: boolean
}

export class RoomClient {
  private socket: import('socket.io-client').Socket | null = null
  private bundles = new Map<string, SessionBundle>()
  private identity: Awaited<ReturnType<typeof generateIdentity>> | null = null
  private salt: Uint8Array | null = null
  private roomId = ''
  private displayName = '匿名访客'
  private selfPeerId = ''
  private selfSocketId = ''
  private pendingJoin = false
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private camSenderTrack: MediaStreamTrack | null = null
  /** 当前画质档位（采集约束与码率梯队共用；采集/切档时更新） */
  private currentTier: QualityTier = '720p'
  /** 屏幕共享出流健康看门狗句柄 */
  private shareWatchdog: ReturnType<typeof setTimeout> | null = null
  /** 本端共享中（broadcastShareState 维护；DC 晚开 bundle 补发 share 状态用，Task 27） */
  private sharingOn = false
  /** 共享期生命周期守卫清理器（Task 28：旋转 nudgeOffer / mute 告警；停止共享时卸载） */
  private shareLifecycleOff: (() => void) | null = null
  /** AI 画面增强器（发送侧滤镜；原始轨不动，预览/录制/设备切换不受影响） */
  private enhancer = new FrameEnhancer()
  /** 虚拟背景管线（Zoom 化）：链在增强之后（摄像头 → 增强 → 虚拟背景 → 发送） */
  private vbg = new VirtualBackground()
  /** 【Task 36】合成补帧（倍频平滑）：链在虚拟背景之后 —— 混合的是最终合成画面，避免二次分割推理 */
  private interp = new FrameInterpolator()
  handlers: RoomClientHandlers
  private iceServers: RTCIceServer[] = DEFAULT_STUN
  /** 部署下发的原始 ICE 配置（/api/ice-config）：热切换时作为「自动」档与 TURN 兜底来源 */
  private envIceServers: RTCIceServer[] = DEFAULT_STUN
  private destroyed = false
  /** 成员心跳定时器（服务端 TTL 幽灵清扫依据；连接期间每 15s 一次） */
  private hbTimer: ReturnType<typeof setInterval> | null = null
  /** 房间口令（可选）：参与 SPAKE2 PAKE 认证与 HKDF 盐派生；会话级内存持有 */
  private passcode: string | undefined
  /* ---- Task 30 准入元数据（rejoin 重连时原样重发） ---- */
  private roomPassHash = ''
  private roomAdmission: 'auto' | 'manual' = 'auto'
  private isCreate = false
  /** 等候室等待中（批准后 admission-granted 接管入房；重连时重发 join 会重新排队） */
  private waitingAdmission = false
  /**
   * PAKE 握手等待表（key = 对端 socketId）：createSession 发出共享值后等待对端 share/confirm；
   * 若对端消息先于 waiter 到达，先落在 early 缓冲，createSession 建表时回放。
   */
  private spakeWaiters = new Map<
    string,
    {
      resolveShare?: (v: Uint8Array) => void
      resolveConfirm?: (v: Uint8Array) => void
      earlyShare?: Uint8Array
      earlyConfirm?: Uint8Array
    }
  >()
  /** 会话就绪前到达的信令缓冲（key = 对端 socketId） */
  private pendingSignals = new Map<string, SignalData[]>()

  /** 等待信令就绪（socket 已 connect），最多 10s */
  private waitReady(): Promise<boolean> {
    if (this.socket?.connected) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000)
      this.socket?.once('connect', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  constructor(handlers: RoomClientHandlers) {
    this.handlers = handlers
  }

  /* ------------------------------- 生命周期 ------------------------------- */

  /**
   * ICE 服务器可达性探测：建临时 PC 触发候选收集，按首个非 host 候选判定。
   * 【Task 34 修复】原先 srflx 只记录不定论、等 gathering complete 才回报 —— 但只要名单里
   * 有一台不响应的 STUN（重传 10s+），complete 永远不来，4.5s 计时器必然误报 timeout，
   * 哪怕 srflx 候选早已到手（实测 11ms 到达仍被判超时）。现首个非 host 候选立即定论：
   * relay/srflx 谁先到用谁（TURN 可达时 relay 通常同样快，先到先判语义合理）。
   * 仅观测，不影响任何会话；失败也不阻断入房（最坏情况：跨网络无法建立媒体，UI 显式提示）。
   */
  private async probeIceServers(): Promise<void> {
    try {
      if (typeof RTCPeerConnection === 'undefined') return
      const pc = new RTCPeerConnection({ iceServers: this.iceServers })
      let done = false
      const finish = (r: 'relay' | 'srflx' | 'none' | 'timeout') => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { pc.close() } catch { /* noop */ }
        this.handlers.onIceProbe(r)
      }
      const timer = setTimeout(() => finish('timeout'), 4500)
      pc.onicecandidate = (e) => {
        const c = e.candidate
        if (!c) { finish('none'); return } // 收集完成且从未出现非 host 候选
        if (c.type === 'relay' || c.type === 'srflx') finish(c.type) // 首个非 host 候选立即定论
      }
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish('none')
      }
      pc.createDataChannel('probe')
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
    } catch {
      this.handlers.onIceProbe('none')
    }
  }

  /**
   * 预热（进房三步向导的「安全握手」步）：提前建立信令连接 + 生成临时 ECDH 身份，
   * 不入房。完成后再展示房间码步骤，用户感知为「已与服务器完成密钥交换」。
   */
  async prewarm(): Promise<{ identity: string; online: boolean; capability: string }> {
    await this.connect()
    if (!this.identity) {
      this.identity = await generateIdentity()
      this.handlers.onLog('crypto', '已生成本次会话临时身份（ECDH P-256）', `fingerprint=${this.identity.fingerprint}`)
    }
    const online = await this.waitReady()
    const capability = detectCapability()
    this.handlers.onLog('net', online ? '安全握手完成（信令已就绪）' : '信令连接超时（可稍后重试）', `e2ee=${capability}`)
    return { identity: this.identity.fingerprint, online, capability }
  }

  async connect(): Promise<void> {
    if (this.socket) return
    this.handlers.onSignaling('connecting')
    // 拉取 ICE 配置（自建 TURN/STUN 通过环境变量注入，见 /api/ice-config）
    try {
      const res = await fetch('/api/ice-config', { cache: 'no-store' })
      if (res.ok) {
        const data = (await res.json()) as { iceServers?: RTCIceServer[] }
        if (data.iceServers?.length) this.envIceServers = data.iceServers
        this.handlers.onLog('net', 'ICE 配置已加载', `${data.iceServers?.length || 0} 组服务器`)
      }
    } catch {
      this.handlers.onLog('warn', 'ICE 配置拉取失败，使用默认公共 STUN')
    }
    // 服务器选择（高级设置）：用户选定具体服务器时覆盖默认 ICE 配置（环境 TURN 保留兜底）
    this.iceServers = this.envIceServers
    try {
      const picked = applyServerPick(this.envIceServers)
      if (picked) {
        this.iceServers = picked
        this.handlers.onLog('net', '已按高级设置应用所选 ICE 服务器', `${picked.length} 组`)
      }
    } catch {
      /* 选择解析失败沿用默认配置 */
    }
    // STUN/TURN 可达性主动探测（跨网络媒体失败的显式预警，诊断面板与顶部媒体徽标展示）
    void this.probeIceServers()

    const { io } = await import('socket.io-client')
    // 本机直跑（next dev :3000，无 Caddy 网关）时直连信令端口 —— Next dev 代理不支持
    // WS 升级且会破坏长轮询；生产部署经网关（/?XTransformPort=3003）不受影响。
    const localDev =
      typeof location !== 'undefined' &&
      (location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
      location.port === '3000'
    const socketUrl = localDev ? `http://${location.hostname}:3003/` : '/?XTransformPort=3003'
    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    })
    this.socket = socket

    socket.on('connect', () => {
      this.selfSocketId = socket.id || ''
      this.handlers.onSignaling('online')
      this.handlers.onLog('net', '信令服务器已连接', `socket=${socket.id}`)
      if (this.roomId || this.pendingJoin) void this.rejoin()
    })
    // 成员心跳：房间内成员每 15s 上报，超时未心跳的成员被服务端强制离房（防幽灵会话）
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = setInterval(() => {
      if (socket.connected) socket.emit('hb')
    }, 15000)
    socket.on('disconnect', (reason) => {
      this.handlers.onSignaling('offline')
      this.handlers.onLog('warn', `信令断开：${reason}（自动重连中）`)
      // 断线期间的对端连接保留；重连成功后 rejoin 重建会话
    })
    socket.on('connect_error', (e) => {
      this.handlers.onLog('error', '信令连接失败', String(e))
    })
    socket.on('peer-joined', (p: PeerBrief) => {
      this.handlers.onLog('info', `${p.name || '访客'} 加入房间`, `peer=${p.peerId.slice(0, 8)}`)
      this.handlers.onPeerEvent(p.name || '访客', 'joined')
      if (p.pubkey) {
        try {
          this.registerPeerInfo(p.peerId, p.pubkey)
        } catch {
          this.handlers.onLog('warn', '对端公钥解析失败', p.peerId)
        }
      }
      void this.createSession(p).then(() => this.emitPeers())
    })
    socket.on('peer-left', (p: { socketId: string; peerId: string; name: string; cause: string }) => {
      this.handlers.onLog('info', `${p.name || '成员'} 离开房间`, `cause=${p.cause}`)
      // cause 贯通到 UI：voluntary=主动退出 / disconnect:*=连接中断 / kicked=被房主移出
      this.handlers.onPeerEvent(p.name || '成员', 'left', p.cause)
      this.destroySession(p.socketId)
      this.emitPeers()
    })
    socket.on('signal', ({ from, data }: { from: string; data: SignalData }) => {
      // PAKE（SPAKE2）信令：会话建立前完成口令认证，优先于 WebRTC 会话处理
      const st = data as SignalData & { t?: string; share?: string; proof?: string }
      if (st.t === 'spake-share' || st.t === 'spake-confirm') {
        this.handleSpakeSignal(from, st.t, st.share || st.proof || '')
        return
      }
      const bundle = this.bundles.get(from)
      if (bundle) {
        void bundle.session.handleSignal(data)
        return
      }
      // 会话尚未建好（密钥派生中）→ 缓冲信号，createSession 完成后重放，
      // 否则竞态窗口内的 Offer/Answer 会丢失导致协商死锁
      const arr = this.pendingSignals.get(from) || []
      arr.push(data)
      this.pendingSignals.set(from, arr)
    })
    // 房间治理：锁定状态与房主变更（信令权威，客户端只呈现）
    socket.on('room-state', (s: { locked: boolean; hostSocketId: string | null }) => {
      this.handlers.onRoomState({ locked: s.locked === true, hostSocketId: s.hostSocketId || null })
    })
    // 房间治理：被房主移出（服务器已先行移出房间，本地 fail-closed 清理）
    socket.on('peer-kicked', (p: { byName?: string }) => {
      this.handlers.onKicked(String(p.byName || '房主'))
    })

    /* ---- Task 30：人工审核等候室 ---- */
    // 房主批准 → 服务器原样入房并下发与 join ack 同构的载荷
    socket.on('admission-granted', (ack: JoinRoomAck) => {
      this.waitingAdmission = false
      this.destroyAllSessions(false)
      void this.applyJoinAck(ack)
    })
    socket.on('admission-denied', (p: { reason?: string }) => {
      this.waitingAdmission = false
      this.pendingJoin = false
      this.handlers.onAdmissionDenied(String(p.reason || 'denied'))
    })
    // 房主端：收到加入申请（UI 审批横幅；同一申请重复到达由 store 按 socketId 幂等去重）
    socket.on('admission-request', (p: { socketId?: string; name?: string }) => {
      const sid = String(p.socketId || '')
      if (sid) this.handlers.onAdmissionRequest(sid, String(p.name || '访客'))
    })
  }

  async joinRoom(roomId: string, name: string, passphrase?: string, opts?: JoinOpts): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
    await this.connect()
    // 若 socket 尚在连接中，等待就绪而不是立即报错
    const ready = await this.waitReady()
    if (!ready) return { ok: false, error: '信令服务器连接超时' }
    this.roomId = roomId
    this.displayName = name || '匿名访客'
    this.passcode = passphrase || undefined
    this.salt = await roomSalt(roomId, passphrase)
    // 准入元数据（rejoin 重连原样重发，房间密码/审批状态不断线丢失）
    this.roomPassHash = opts?.roomPassHash || ''
    this.roomAdmission = opts?.admission === 'manual' ? 'manual' : 'auto'
    this.isCreate = opts?.create === true
    if (!this.identity) {
      this.identity = await generateIdentity()
      this.handlers.onLog('crypto', '已生成本次会话临时身份（ECDH P-256）', `fingerprint=${this.identity.fingerprint}`)
    }
    this.selfPeerId = this.selfPeerId || randomId(16)
    this.pendingJoin = true
    return this.rejoin()
  }

  /** 房间信息探测（大厅防抖查询）：是否存在/需密码/审批模式/人数 */
  async queryRoomInfo(roomId: string): Promise<RoomInfo | null> {
    if (!this.socket?.connected) return null
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000)
      this.socket!.emit('room-info', { roomId }, (r: RoomInfo) => {
        clearTimeout(timer)
        resolve(r && r.ok ? r : null)
      })
    })
  }

  /** 管理员 socket 鉴权（解锁跨房踢人/免审入房；密码错误返回 false） */
  adminAuth(password: string): Promise<boolean> {
    if (!this.socket?.connected) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      this.socket!.emit('admin-auth', { password }, (r: { ok?: boolean }) => {
        clearTimeout(timer)
        resolve(r?.ok === true)
      })
    })
  }

  /** 取消等候室等待（等待页「取消」按钮）：fail-closed 回大厅 */
  cancelAdmission() {
    try {
      this.socket?.emit('admission-cancel')
    } catch {
      /* noop */
    }
    this.waitingAdmission = false
    this.pendingJoin = false
    this.roomId = ''
    this.handlers.onLeft()
    this.handlers.onLog('info', '已取消加入等待')
  }

  private async rejoin(): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
    const socket = this.socket
    if (!socket || !socket.connected || !this.roomId || !this.identity) {
      // 未就绪时静默等待 connect 事件触发重试，不报错
      return { ok: false, error: 'pending' }
    }
    // 重建会话（socketId 会变化）
    this.destroyAllSessions(false)

    const ack = (await new Promise<JoinRoomAck>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: '加入房间超时' }), 8000)
      socket.emit(
        'join-room',
        {
          roomId: this.roomId,
          peerId: this.selfPeerId,
          name: this.displayName,
          fingerprint: this.identity!.fingerprint,
          // 帧加密能力捎带在 pubkey JSON 内（信令透传不感知）：对端据此协商是否启用帧级加密。
          // e2eeEnabled 开关关闭时按 'none' 上报 —— 对端据此同步降级，双方一致走 DTLS-SRTP。
          pubkey: JSON.stringify(
            Object.assign({}, this.identity!.publicKeyJwk, {
              cap: !useVeil.getState().e2eeEnabled || detectCapability() === 'unsupported' ? 'none' : detectCapability(),
            }),
          ),
          // 自定义头像（96px JPEG dataURL；信令透传，仅房间内展示，服务器只转发不解析）
          avatar: readLocalAvatar(),
          // Task 30 准入元数据：房间密码哈希 / 审批模式 / 创建语义（重连时原样重发）
          roomPassHash: this.roomPassHash,
          admission: this.roomAdmission,
          isCreate: this.isCreate,
        },
        (r: JoinRoomAck) => {
          clearTimeout(timer)
          resolve(r)
        },
      )
    })) as JoinRoomAck

    // 等候室：人工审核模式下等待房主批准（批准后走 admission-granted → applyJoinAck）
    if (!ack.ok && (ack as { code?: string }).code === 'PENDING') {
      this.waitingAdmission = true
      this.handlers.onLog('net', '已提交加入申请，等待房主批准…', '房间开启了人工审核')
      this.handlers.onAdmissionPending()
      return { ok: true, pending: true }
    }
    if (!ack.ok || !ack.self) {
      this.handlers.onLog('error', `加入房间失败：${ack.error}`)
      return { ok: false, error: ack.error }
    }
    return this.applyJoinAck(ack)
  }

  /** join ack 标准入房（join-room 直通与 admission-granted 批准共用） */
  private async applyJoinAck(ack: JoinRoomAck): Promise<{ ok: boolean; error?: string }> {
    const socket = this.socket
    if (!socket || !ack.ok || !ack.self) return { ok: false, error: ack.error || 'invalid ack' }
    this.selfSocketId = ack.self.socketId
    this.pendingJoin = false
    // 房间治理状态随 ack 权威下发（锁定/房主），后续变更走 room-state 事件
    this.handlers.onRoomState({ locked: ack.locked === true, hostSocketId: ack.hostSocketId || null })

    // 自检一次 E2EE 能力（用户关闭开关时如实按 unsupported 上报 → UI 显示 DTLS-SRTP 模式）
    const mode = useVeil.getState().e2eeEnabled ? detectCapability() : 'unsupported'
    e2eeManager.ensure()

    this.handlers.onJoined({
      roomId: this.roomId,
      socketId: this.selfSocketId,
      peerId: this.selfPeerId,
      e2eeMode: mode,
    })

    // 虚拟背景模型空闲预热（仅本机用过虚拟背景的用户；避免首次开启时下载/编译卡顿）
    try {
      const used = localStorage.getItem('veil-vbg-mode')
      if (used && used !== 'off') {
        const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
        const idle = w.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 4000))
        idle(() => void this.vbg.preload().catch(() => {}), { timeout: 8000 })
      }
    } catch { /* noop */ }
    this.handlers.onLog(
      'crypto',
      mode === 'unsupported'
        ? useVeil.getState().e2eeEnabled
          ? 'E2EE 能力检测：浏览器不支持帧级加密（回退 DTLS-SRTP）'
          : 'E2EE 已按高级设置关闭：本会话使用 DTLS-SRTP 传输加密'
        : `E2EE 能力检测：${mode}`,
    )

    for (const p of ack.peers || []) {
      if (p.pubkey) {
        try {
          this.registerPeerInfo(p.peerId, p.pubkey)
        } catch {
          this.handlers.onLog('warn', '对端公钥解析失败', p.peerId)
        }
      }
      await this.createSession(p)
    }
    this.emitPeers()

    // 若尚无本地媒体，尝试采集（失败则进入仅数据模式）
    if (!this.localStream) {
      await this.acquireLocalMedia().catch(() => {})
    }
    return { ok: true }
  }

  leave() {
    try {
      this.socket?.emit('leave-room')
    } catch {
      /* noop */
    }
    this.destroyAllSessions(true)
    this.roomId = ''
    this.pendingJoin = false
    this.handlers.onLeft()
    this.handlers.onLog('info', '已离开房间')
  }

  destroy() {
    this.destroyed = true
    this.leave()
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
    try {
      this.socket?.disconnect()
    } catch {
      /* noop */
    }
    this.socket = null
  }

  /* ------------------------------- 媒体管理 ------------------------------- */

  async acquireLocalMedia(constraints?: MediaTrackConstraints): Promise<boolean> {
    try {
      // 画质档位解析：本机个人偏好 > 管理员全局默认（信令下发，管理员面板可设）> 720p
      const resolved = resolveTier(useVeil.getState().serverDefaultQuality)
      this.currentTier = resolved.tier
      // Task 32 移动端采集钳制：iPad/手机 4K 档实际采集压到 1080p30（防软编/发热熔毁）
      // 【Task 36】用户可在设备面板显式解除（veil-mobile-clamp-off=1 → mobileClampActive=false）
      const mobile = mobileClampActive()
      const tierCons = constraintsFor(resolved.tier, mobile)
      const clamped = mobile && resolved.tier !== '360p' && resolved.tier !== '720p' && resolved.tier !== '1080p'
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: constraints || tierCons,
      })
      this.setLocalStream(stream)
      const v = stream.getVideoTracks()[0]?.getSettings()
      this.handlers.onLog(
        'info',
        `本地媒体已就绪（画质档位 ${resolved.tier}${resolved.source === 'admin' ? ' · 管理员默认' : resolved.source === 'user' ? ' · 个人偏好' : ''}${clamped ? ' · 移动端已锦 1080p30 抗卡顿' : ''}）`,
        `${v?.width || '?'}×${v?.height || '?'}@${v?.frameRate ? Math.round(v.frameRate) : '?'}fps · ${stream.getVideoTracks().length} 视频 / ${stream.getAudioTracks().length} 音频`,
      )
      // AI 画面增强：本机开启过则采集完成后自动接管发送轨（失败回退原轨不断流）
      const enh = useVeil.getState()
      if (enh.enhanceOn && stream.getVideoTracks().length > 0) {
        await this.setEnhance(true, enh.enhanceLevel)
      }
      // 虚拟背景：本机记忆模式非 off 则入房自动生效（Zoom 化；失败回退原轨）
      if (enh.vbgMode !== 'off' && stream.getVideoTracks().length > 0) {
        void this.setVirtualBg(enh.vbgMode, { blur: enh.vbgBlur, color: enh.vbgColor, image: enh.vbgImage, gradient: enh.vbgGradient }).then((ok) => {
          useVeil.getState().set({ vbgStatus: ok ? 'ready' : 'failed' })
          if (!ok) {
            useVeil.getState().set({ vbgMode: 'off' })
            try { localStorage.setItem('veil-vbg-mode', 'off') } catch { /* noop */ }
          }
        })
      }
      // 【Task 36】合成补帧：本机记忆开启则入房自动生效（失败回退原轨）
      if (enh.interpOn && stream.getVideoTracks().length > 0) {
        void this.setInterp(true)
      }
      this.updateLocalPreview()
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.handlers.onMediaError(msg)
      this.handlers.onLog('warn', '媒体采集失败，进入"仅数据模式"（文件/聊天仍可用）', msg)
      this.setLocalStream(null)
      return false
    }
  }

  private setLocalStream(stream: MediaStream | null) {
    if (this.localStream && this.localStream !== stream) {
      this.localStream.getTracks().forEach((t) => t.stop())
    }
    this.localStream = stream
    this.camSenderTrack = stream?.getVideoTracks()[0] || null
    this.handlers.onLocalStream(stream)
    // 向已有会话补发 track（虚拟背景/增强开启时视频发送侧用加工轨）
    if (stream) {
      this.bundles.forEach((b) => {
        stream.getTracks().forEach((t) => {
          const send = t.kind === 'video' ? this.senderVideoTrack() || t : t
          const has = b.session.pc.getSenders().some((s) => s.track?.id === t.id || s.track?.id === (t.kind === 'video' ? send.id : t.id))
          if (!has && !b.session.pc.getSenders().some((s) => s.track?.kind === t.kind)) {
            b.session.addLocalTrack(send, stream)
          }
        })
      })
    }
  }

  /** 发送侧视频轨：虚拟背景 > AI 增强 > 原始摄像头轨；补帧（interp）作为末级叠加在前面任一产出之上
   *  【Task 36】链式顺序：摄像头 → AI 增强 → 虚拟背景 → 合成补帧 → 发送（补帧混合的是最终合成画面，不做二次分割推理） */
  private upstreamProcessedTrack(): MediaStreamTrack | null {
    if (this.vbg.active()) return this.vbg.processedTrack()
    if (this.enhancer.active()) return this.enhancer.processedTrack()
    return this.camSenderTrack
  }

  private senderVideoTrack(): MediaStreamTrack | null {
    if (this.interp.active()) return this.interp.processedTrack()
    return this.upstreamProcessedTrack()
  }

  /* ------------------------- 本地加工预览（Task 36） ------------------------- */

  private previewTrackId: string | null = null

  /** 同步本地预览流：有加工轨且与原始轨不同 → store.localPreviewStream = 加工流；否则清空。
   *  修复「虚拟背景/AI 增强没用」——原实现加工轨只进发送端，本地预览永远原始画面，用户看不到任何效果 */
  private updateLocalPreview() {
    const raw = this.camSenderTrack
    const t = this.senderVideoTrack()
    const live = !!t && t.readyState === 'live' && !!raw && t.id !== raw.id
    const st = useVeil.getState()
    if (!live) {
      if (this.previewTrackId !== null) {
        this.previewTrackId = null
        st.set({ localPreviewStream: null })
      }
      return
    }
    if (this.previewTrackId !== t!.id) {
      this.previewTrackId = t!.id
      st.set({ localPreviewStream: new MediaStream([t!]) })
    }
  }

  /** 把 AI 增强管线的产出接到所有会话的发送端（未开启/失败回退原轨） */
  private async applyEnhanceToSessions(): Promise<void> {
    const track = this.senderVideoTrack()
    if (!track) return
    await Promise.all(
      [...this.bundles.values()].map(async (b) => {
        const sender = b.session.pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender && sender.track !== track) await sender.replaceTrack(track).catch(() => {})
      }),
    )
    this.bundles.forEach((b) => b.session.nudgeOffer())
    // 【Task 36】管线变化同步本地加工预览
    this.updateLocalPreview()
  }

  /** 【Task 37】发送端加工管线零帧守卫：管线启用后若编码器长时间一帧未出（画布未绘制/
   *  源视频无法播放等静默失败），自动整体回退原始画面 —— 防止「连接正常但全员黑屏」。
   *  仅房间内有会话时启用（单人预览无发送端可观测，由本地加工预览直接呈现问题） */
  private pipelineWatchdog: ReturnType<typeof setTimeout> | null = null

  private disarmPipelineWatchdog() {
    if (this.pipelineWatchdog) {
      clearTimeout(this.pipelineWatchdog)
      this.pipelineWatchdog = null
    }
  }

  private armPipelineWatchdog() {
    this.disarmPipelineWatchdog()
    const raw = this.camSenderTrack
    if (!raw || raw.readyState !== 'live' || !this.bundles.size) return
    this.pipelineWatchdog = setTimeout(() => {
      this.pipelineWatchdog = null
      void (async () => {
        // 任意会话的视频编码器已出帧 → 管线健康，静默返回
        let frames = -1
        for (const b of this.bundles.values()) {
          const s = b.session.pc.getSenders().find((x) => x.track?.kind === 'video')
          if (!s) continue
          const rep = await b.session.pc.getStats().catch(() => null)
          if (!rep) continue
          rep.forEach((r) => {
            const rr = r as unknown as Record<string, unknown>
            if (rr.type === 'outbound-rtp' && rr.kind === 'video' && typeof rr.framesEncoded === 'number')
              frames = Math.max(frames, rr.framesEncoded as number)
          })
        }
        if (frames > 0) return
        if (!this.camSenderTrack || this.camSenderTrack.readyState !== 'live') return
        // 仍未出帧且原始轨健康 → 整体回退原始画面（画面优先于效果）
        this.handlers.onLog(
          'warn',
          '画面加工管线未出帧，已自动回退原始画面',
          '虚拟背景/AI 增强/补帧可能因浏览器 canvas 能力受限未绘制；可逐个重新开启以定位问题管线',
        )
        useVeil.getState().set({ enhanceOn: false, vbgMode: 'off', vbgStatus: 'idle', interpOn: false })
        try {
          localStorage.setItem('veil-enhance', '0')
          localStorage.setItem('veil-vbg-mode', 'off')
          localStorage.setItem('veil-interp', '0')
        } catch { /* noop */ }
        this.previewTrackId = null
        await this.interp.stop()
        await this.enhancer.stop()
        await this.vbg.stop()
        await this.applyEnhanceToSessions()
      })()
    }, 8000)
  }

  /** 开关/调强 AI 增强：重建加工管线并热替换发送轨；关闭时回退原轨 */
  async setEnhance(on: boolean, level: number): Promise<boolean> {
    const src = this.camSenderTrack
    if (!src || src.readyState !== 'live') return false
    if (on) {
      const proc = await this.enhancer.start(src, level)
      if (!proc) {
        this.handlers.onLog('warn', 'AI 画面增强启动失败，已回退原始画面', '当前浏览器不支持 canvas 实时处理')
        await this.rewrapVbg()
        return false
      }
      // 增强产出变了：虚拟背景在链上时改吃新产出轨重建，再统一下发发送轨
      await this.rewrapVbg()
      this.handlers.onLog('info', `AI 画面增强已开启（目标亮度 ${(level * 100).toFixed(0)}%）`, `处理分辨率 ${proc.getSettings().width || '?'}×${proc.getSettings().height || '?'}@${proc.getSettings().frameRate ? Math.round(proc.getSettings().frameRate || 0) : '?'}fps`)
      this.armPipelineWatchdog()
      return true
    }
    this.disarmPipelineWatchdog()
    await this.enhancer.stop()
    // 增强关闭后虚拟背景若在链上必须改吃原始轨重建（否则画到已停轨上冻结）
    await this.rewrapVbg()
    this.handlers.onLog('info', 'AI 画面增强已关闭，恢复原始画面')
    return true
  }

  /** 设备切换后重建增强管线（新源轨）；虚拟背景链在其后一并重建 */
  private async rewrapEnhance(): Promise<void> {
    const st = useVeil.getState()
    if (st.enhanceOn) {
      const src = this.camSenderTrack
      if (src && src.readyState === 'live') {
        const proc = await this.enhancer.start(src, st.enhanceLevel)
        if (!proc) this.handlers.onLog('warn', 'AI 画面增强在设备切换后未能重建，已回退原始画面')
      }
    }
    await this.rewrapVbg()
  }

  /** 按 params（缺省回落 store 记忆）重建/关闭虚拟背景管线（源 = 增强产出轨 > 原始轨） */
  private async rewrapVbg(params?: Partial<{ mode: VbgMode; blur: number; color: string; image: string | null; gradient: VbgGradient }>): Promise<boolean> {
    const st = useVeil.getState()
    const mode = params?.mode ?? st.vbgMode
    const blur = params?.blur ?? st.vbgBlur
    const color = params?.color ?? st.vbgColor
    const imageData = params && params.image !== undefined ? params.image : st.vbgImage
    const gradient = params?.gradient ?? st.vbgGradient
    if (mode === 'off') {
      this.disarmPipelineWatchdog()
      this.stopVbgWatch()
      await this.vbg.stop()
      await this.rewrapInterp()
      await this.applyEnhanceToSessions()
      return true
    }
    const src = this.enhancer.active() ? this.enhancer.processedTrack() : this.camSenderTrack
    if (!src || src.readyState !== 'live') return false
    const img = mode === 'image' ? await loadImageOrNull(imageData) : null
    const proc = await this.vbg.start(src, { mode, blur, color, image: img, gradient })
    // 【Task 36】补帧链在虚拟背景之后：上游产出变化 → 重建补帧源
    await this.rewrapInterp()
    await this.applyEnhanceToSessions()
    if (!proc) {
      this.handlers.onLog('warn', '虚拟背景启动失败，已回退原始画面', '分割模型加载失败或浏览器不支持 canvas 实时处理')
      return false
    }
    this.armPipelineWatchdog()
    this.startVbgWatch()
    this.handlers.onLog('info', `虚拟背景已开启（${mode === 'blur' ? `背景模糊 ${blur}px` : mode === 'color' ? '纯色背景' : '图片背景'}）`, `处理分辨率 ${proc.getSettings().width || '?'}×${proc.getSettings().height || '?'}@${proc.getSettings().frameRate ? Math.round(proc.getSettings().frameRate || 0) : '?'}fps · 本地模型推理，画面不出设备`)
    return true
  }

  /** 分割退化监视（5s 轮询）：掩码持续异常 → 透传原始画面并提示（人绝不能被虚化掉），
   *  分割恢复 → 效果自动回归。 */
  private vbgWatch: ReturnType<typeof setInterval> | null = null
  private startVbgWatch() {
    this.stopVbgWatch()
    this.vbgWatch = setInterval(() => {
      if (!this.vbg.active()) {
        this.stopVbgWatch()
        return
      }
      const d = this.vbg.isDegraded()
      if (d !== useVeil.getState().vbgDegraded) {
        useVeil.getState().set({ vbgDegraded: d })
        this.handlers.onLog(
          d ? 'warn' : 'info',
          d ? '分割异常：虚拟背景已临时停用（原始画面直出，人物不再被误虚化）' : '分割已恢复：虚拟背景重新生效',
        )
      }
    }, 5000)
  }
  private stopVbgWatch() {
    if (this.vbgWatch) {
      clearInterval(this.vbgWatch)
      this.vbgWatch = null
    }
    if (useVeil.getState().vbgDegraded) useVeil.getState().set({ vbgDegraded: false })
  }

  /** 开关/调参虚拟背景（参数自足，不依赖 store 先行更新）：热切换发送轨；off 时停管线回退原轨。
   *  【Task 36】opts 改为可选缺省回退 store —— 调用方（UI/测试/调试）漏传不再崩溃 */
  async setVirtualBg(mode: VbgMode, opts?: { blur?: number; color?: string; image?: string | null; gradient?: 'dusk' | 'ocean' | 'mint' }): Promise<boolean> {
    return this.rewrapVbg({ mode, blur: opts?.blur, color: opts?.color, image: opts?.image, gradient: opts?.gradient })
  }

  /* ------------------------- 合成补帧（Task 36「AI 插帧」） ------------------------- */

  /** 开关合成补帧：倍频平滑低帧率源（失败回退原轨不断流）；开关记忆入 store */
  async setInterp(on: boolean): Promise<boolean> {
    const st = useVeil.getState()
    st.set({ interpOn: on })
    try { localStorage.setItem('veil-interp', on ? '1' : '0') } catch { /* noop */ }
    if (!on) {
      this.disarmPipelineWatchdog()
      await this.interp.stop()
      await this.applyEnhanceToSessions()
      return true
    }
    const upstream = this.upstreamProcessedTrack()
    if (!upstream || upstream.readyState !== 'live') return false
    const proc = await this.interp.start(upstream)
    await this.applyEnhanceToSessions()
    if (!proc) {
      this.handlers.onLog('warn', '合成补帧启动失败，已回退原始画面', '当前浏览器不支持 canvas 实时处理')
      st.set({ interpOn: false })
      try { localStorage.setItem('veil-interp', '0') } catch { /* noop */ }
      return false
    }
    this.armPipelineWatchdog()
    const s = proc.getSettings()
    this.handlers.onLog(
      'info',
      `运动补偿补帧已开启（目标 ~${Math.round(s.frameRate || 0)}fps）`,
      '块匹配运动估计 + 对齐合成中间帧：源帧与合成帧交替输出（真倍频）；运动过快区域自动回退源帧，不产生叠影；非 AI 模型，浏览器实时合成，画面不出设备',
    )
    return true
  }

  /** 上游管线（增强/虚拟背景）产出变化时重建补帧源；未开启则仅同步本地预览 */
  private async rewrapInterp(): Promise<void> {
    if (!this.interp.active()) {
      this.updateLocalPreview()
      return
    }
    const upstream = this.upstreamProcessedTrack()
    if (upstream && upstream.readyState === 'live') await this.interp.start(upstream)
    else await this.interp.stop()
    this.updateLocalPreview()
  }

  toggleTrack(kind: 'audio' | 'video', enabled: boolean) {
    this.localStream?.getTracks().filter((t) => t.kind === kind).forEach((t) => {
      t.enabled = enabled
    })
    // 媒体状态广播（Task 25）：闭麦/关摄必须让对端看到 —— WebKit 跨端 track.enabled
    // 状态不可靠，用控制面布尔信号权威同步；DC 未就绪时先跳过（hello 时会补发）
    if (kind === 'audio') this.broadcastMediaState({ micOn: enabled })
    else this.broadcastMediaState({ camOn: enabled })
  }

  isTrackEnabled(kind: 'audio' | 'video'): boolean {
    const t = this.localStream?.getTracks().find((x) => x.kind === kind)
    return t ? t.enabled : false
  }

  async switchDevice(kind: 'audio' | 'video', deviceId: string): Promise<void> {
    if (!this.localStream) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: kind === 'audio' ? { deviceId: { exact: deviceId } } : false,
        video: kind === 'video' ? { deviceId: { exact: deviceId } } : false,
      })
      const newTrack = stream.getTracks().find((t) => t.kind === kind)
      if (!newTrack) return
      const old = this.localStream.getTracks().find((t) => t.kind === kind)
      if (old) {
        this.localStream.removeTrack(old)
        old.stop()
      }
      this.localStream.addTrack(newTrack)
      this.handlers.onLocalStream(this.localStream)
      await Promise.all(
        [...this.bundles.values()].map((b) =>
          kind === 'video'
            ? b.session.replaceVideoTrack(this.senderVideoTrack())
            : (async () => {
                const sender = b.session.pc.getSenders().find((s) => s.track?.kind === 'audio')
                if (sender) await sender.replaceTrack(newTrack)
              })(),
        ),
      )
      if (kind === 'video') {
        // AI 增强源已换新轨：重建加工管线（失败回退原轨）
        await this.rewrapEnhance()
        this.bundles.forEach((b) => b.session.nudgeOffer())
      }
      this.handlers.onLog('info', `已切换${kind === 'video' ? '摄像头' : '麦克风'}`, deviceId.slice(0, 12))
    } catch (e) {
      this.handlers.onLog('error', '切换设备失败', String(e))
    }
  }

  /**
   * 画质热切换（BUG 反馈「画面模糊」→ 本轮扩展至 4K60）：applyConstraints 直接修改已发送轨的
   * 分辨率约束，不断流、不重协商、E2EE 密钥不变；同时更新各会话的码率梯队（4K 不顶格必糊）。
   * 设备不支持目标分辨率/帧率时浏览器取最接近值（真实输出以 getSettings 回读为准）。
   */
  /**
   * 【Task 35】多人 mesh 上行保护：mesh 模式下每路会话独立编码+独立上行，
   * 对端越多发送压力线性放大（4K60 档 ×3 对端 ≈ 54Mbps，家庭上行直接饱和 → 全员黑屏卡顿）。
   * 对端数变化时把生效档位钉到安全档；恢复 1v1 后自动还原用户所选档。
   */
  private activeClamp: QualityTier | null = null
  private lastEffectiveTier: QualityTier | null = null

  private peerCountClampTier(n: number): QualityTier | null {
    // n = bundles.size = 对端会话数（1v1=1，3 人=2，5 人=4）
    if (n <= 1) return null // 1v1：尊重用户档位
    if (n <= 3) return '1080p' // 3-4 人：钉 1080p30（≈4Mbps×N 仍可控）
    return '720p' // 5+ 人：钉 720p30
  }

  private async applyEffectiveTier(
    effective: QualityTier,
    reason: 'user' | 'clamp-on' | 'clamp-off',
  ): Promise<boolean> {
    const track = this.localStream?.getVideoTracks()[0]
    if (!track) return false
    try {
      await track.applyConstraints(constraintsFor(effective, mobileClampActive()))
      const settings = track.getSettings()
      const real = `${settings.width}×${settings.height}@${settings.frameRate ? Math.round(settings.frameRate) : '?'}`
      if (reason === 'clamp-on')
        this.handlers.onLog(
          'info',
          `多人模式已自动调整画质为 ${effective}`,
          `${this.bundles.size} 路并行编码下原档位会打满上行导致全员卡顿黑屏；恢复 1v1 后自动还原所选档 ${this.currentTier}`,
        )
      else if (reason === 'clamp-off')
        this.handlers.onLog('info', `已恢复你选择的画质 ${effective}`, `实际输出 ${real}`)
      else this.handlers.onLog('info', `画质已切换为 ${effective}`, `实际输出 ${real}`)
      // 各会话同步新档位的码率梯队与降级偏好
      this.bundles.forEach((b) => b.session.applyTierProfile(effective))
      return true
    } catch (e) {
      this.handlers.onLog('warn', '画质切换失败（设备可能不支持该分辨率）', String(e))
      return false
    }
  }

  /** 计算+应用生效档位（多人钉制优先于用户偏好）；对端增减时由 emitPeers 驱动 */
  private async refreshEffectiveTier(force = false): Promise<boolean> {
    const clamp = this.peerCountClampTier(this.bundles.size)
    const effective: QualityTier = clamp ?? this.currentTier
    const prevClamp = this.activeClamp
    const changed = force || effective !== this.lastEffectiveTier
    this.activeClamp = clamp
    this.lastEffectiveTier = effective
    if (!changed) return false
    const reason: 'user' | 'clamp-on' | 'clamp-off' = clamp ? 'clamp-on' : prevClamp ? 'clamp-off' : 'user'
    return this.applyEffectiveTier(effective, reason)
  }

  async setCameraQuality(pref: QualityTier): Promise<boolean> {
    const track = this.localStream?.getVideoTracks()[0]
    if (!track) return false
    this.currentTier = pref
    return this.refreshEffectiveTier(true)
  }

  async toggleScreenShare(): Promise<boolean> {
    if (this.screenStream) {
      // 恢复摄像头
      this.screenStream.getTracks().forEach((t) => t.stop())
      this.screenStream = null
      this.detachShareLifecycleGuard()
      if (this.shareWatchdog) {
        clearTimeout(this.shareWatchdog)
        this.shareWatchdog = null
      }
      this.handlers.onScreenStream(null)
      await this.restoreCameraAfterShare()
      // 恢复摄像头档位的码率/降级偏好（共享期间的 share profile 退役）
      this.bundles.forEach((b) => b.session.applyTierProfile(this.currentTier))
      // 停共享黑屏根治兜底：replaceTrack 回摄像头后部分浏览器/编码器不主动推帧，
      // 显式重协商强制关键帧（幂等，Chrome 无副作用）—— 本地与对端立即恢复画面
      this.bundles.forEach((b) => b.session.nudgeOffer())
      this.broadcastShareState(false)
      this.handlers.onLog('info', '已停止屏幕共享')
      return false
    }
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        // iOS/iPadOS 全系浏览器（WebKit）不支持 getDisplayMedia：显式提示而非静默失败
        this.handlers.onLog('warn', '当前浏览器不支持屏幕共享采集', 'iOS/iPadOS 全系浏览器暂未开放该能力；桌面 Chrome/Edge/Firefox 均可')
        this.handlers.onScreenShareUnsupported()
        return false
      }
      // WebKit（Safari/iPadOS 全系）屏幕源不支持分辨率/帧率调整：显式约束
      // （尤其 frameRate max）可能直接 OverconstrainedError —— iPad 横屏共享
      // 「点了没反应」的头号嫌疑；只对 Chromium 内核应用档位约束（Task 25/27）。
      // Chrome 不给 frameRate 时默认 30fps（60 赫兹关键坑），WebKit 交系统自适应。
      const ua = navigator.userAgent
      const isWebKit = /Safari\/\d/.test(ua) && !/Chrom(e|ium)/.test(ua)
      const shareTier = useVeil.getState().shareTier
      const videoCons: MediaTrackConstraints | boolean = isWebKit
        ? true
        : shareTier === 'auto'
          ? { frameRate: { ideal: 60, max: 60 } }
          : shareTier === '1080p60'
            ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } }
            : shareTier === '8k144'
              ? { width: { ideal: 7680 }, height: { ideal: 4320 }, frameRate: { ideal: 144, max: 144 } }
              : { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 } }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoCons, audio: false })
      this.screenStream = stream
      const track = stream.getVideoTracks()[0]
      // Task 27：contentHint 'detail' 会让编码器牺牲帧率保清晰度（拖动/视频内容直接卡成幻灯片）
      // → 改 'motion' 保帧率，配合 maintain-framerate 降级偏好与 high 发送优先级
      try { track.contentHint = 'motion' } catch { /* noop */ }
      // 横竖屏旋转/窗口尺寸变化（iPad 横屏共享）：track 分辨率热变，日志留痕
      try {
        track.addEventListener('resize', () => {
          const s = track.getSettings()
          this.handlers.onLog('net', '共享画面分辨率变化', `${s.width}×${s.height}${s.frameRate ? ` @${Math.round(s.frameRate)}fps` : ''}（旋转/窗口变化自适应）`)
        })
      } catch { /* noop */ }
      // iPad 旋转/切后台韧性（Task 28「横屏还是太不行」）：系统抢占/旋转后 WebKit
      // 常见 track mute（断流）或不主动出帧 —— mute 显式告警；旋转后 nudgeOffer 兜底
      this.attachShareLifecycleGuard(track)
      track.onended = () => void this.toggleScreenShare()
      this.handlers.onScreenStream(stream)
      await Promise.all([...this.bundles.values()].map((b) => b.session.replaceVideoTrack(track)))
      // 共享档位码率/降级偏好：4K60 顶格 16Mbps + maintain-framerate —— 拖动/视频内容不糊不卡；
      // 停止共享时由恢复分支 applyShareProfile(false) 还原摄像头档
      this.bundles.forEach((b) => b.session.applyShareProfile(true))
      // WebKit 某些版本 replaceTrack 后不自动推帧/不触发远端渲染：显式重协商兜底（幂等，Chrome 无副作用）
      this.bundles.forEach((b) => b.session.nudgeOffer())
      this.broadcastShareState(true)
      this.handlers.onLog('info', isWebKit ? '屏幕共享已开启（WebKit 自适应档：分辨率/帧率交系统）' : '屏幕共享已开启（视频轨已替换，E2EE 对新轨自动生效）')
      this.watchScreenShareHealth()
      return true
    } catch (e) {
      this.handlers.onLog('warn', '屏幕共享取消或失败', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  /**
   * 共享期生命周期守卫（Task 28 iPad 横屏专项）：
   *  - 旋转（orientationchange）/窗口 resize：debounce 后对全部 bundle nudgeOffer ——
   *    WebKit 旋转后新分辨率帧不主动推的兜底（幂等，Chrome 无副作用）；
   *  - track mute：系统抢占/旋转断流，显式 toast + 日志（用户不再面对莫名黑屏）；
   *  - track unmute：恢复提示。
   * 停止共享/track 结束时统一 detachShareLifecycleGuard 清理。
   */
  private attachShareLifecycleGuard(track: MediaStreamTrack) {
    this.detachShareLifecycleGuard()
    let rotateTimer: ReturnType<typeof setTimeout> | null = null
    const onOrientation = () => {
      if (rotateTimer) clearTimeout(rotateTimer)
      rotateTimer = setTimeout(() => {
        if (!this.screenStream) return
        const s = track.getSettings()
        this.handlers.onLog('net', '设备方向变化，正在适配共享画面', `${s.width}×${s.height} · 已向对端请求重同步（若画面短暂冻结 1~2s 会自动恢复）`)
        this.bundles.forEach((b) => b.session.nudgeOffer())
      }, 800)
    }
    const onMute = () => {
      if (!this.screenStream) return
      this.handlers.onLog('warn', '共享画面被系统中断', '旋转/切后台/其他应用抢占时 iPad 会暂时断流；回到本页或重新开启共享即可恢复')
      this.handlers.onScreenShareWarn()
    }
    const onUnmute = () => {
      if (!this.screenStream) return
      this.handlers.onLog('info', '共享画面已恢复')
    }
    const onEndedFallback = () => {
      this.detachShareLifecycleGuard()
    }
    // 旋转/resize 兜底仅 WebKit 需要（Chrome 对旋转自适应无此缺陷，且每次窗口 resize
    // 触发全量重协商纯属浪费带宽与时延）：mute/unmute/ended 告警三端通用
    const isWebKit = /Safari\/\d/.test(navigator.userAgent) && !/Chrom(e|ium)/.test(navigator.userAgent)
    if (isWebKit) {
      try { window.addEventListener('orientationchange', onOrientation) } catch { /* noop */ }
      try { window.addEventListener('resize', onOrientation) } catch { /* noop */ }
    }
    try {
      track.addEventListener('mute', onMute)
      track.addEventListener('unmute', onUnmute)
      track.addEventListener('ended', onEndedFallback, { once: true })
    } catch { /* noop */ }
    this.shareLifecycleOff = () => {
      if (rotateTimer) clearTimeout(rotateTimer)
      try { window.removeEventListener('orientationchange', onOrientation) } catch { /* noop */ }
      try { window.removeEventListener('resize', onOrientation) } catch { /* noop */ }
      try {
        track.removeEventListener('mute', onMute)
        track.removeEventListener('unmute', onUnmute)
        track.removeEventListener('ended', onEndedFallback)
      } catch { /* noop */ }
    }
  }

  private detachShareLifecycleGuard() {
    this.shareLifecycleOff?.()
    this.shareLifecycleOff = null
  }

  /**
   * 停止共享后恢复摄像头发送（「苹果停共享后对方停留在最后一帧截图」根治）：
   * iPadOS 等系统在共享期间可能回收摄像头 —— 原实现检测到摄像头轨非 live 时直接
   * 跳过 replaceTrack，发送端因此一直挂着已结束的共享轨（不再出帧），对端画面
   * 就永远冻结在共享的最后一帧。现在三层兜底：
   *  1. 摄像头轨仍 live → 立即回切；
   *  2. 摄像头轨已死 → 重新采集（停共享后系统释放摄像头，立即可用）→ 回切 + camOn=true；
   *  3. 重采集失败 → replaceTrack(null) 停发死轨 + camOn=false（对端显示头像占位而非冻结画面）。
   */
  private async restoreCameraAfterShare(): Promise<void> {
    if (this.camSenderTrack && this.camSenderTrack.readyState === 'live') {
      // 【Task 36】补帧源可能还指着共享前旧轨 → 先重建补帧链再回切
      await this.rewrapInterp()
      const restore = this.senderVideoTrack()
      if (restore) {
        await Promise.all([...this.bundles.values()].map((b) => b.session.replaceVideoTrack(restore)))
      }
      this.updateLocalPreview()
      return
    }
    this.handlers.onLog('warn', '摄像头在共享期间被系统回收，正在重新采集…', 'iPadOS 等系统会在屏幕共享时暂停摄像头，停共享后自动恢复')
    const ok = await this.acquireLocalMedia().catch(() => false)
    // 重采集后原始轨全新 → 重建补帧/预览链
    await this.rewrapInterp()
    const track = this.senderVideoTrack()
    if (ok && track && track.readyState === 'live') {
      await Promise.all([...this.bundles.values()].map((b) => b.session.replaceVideoTrack(track)))
      this.broadcastMediaState({ camOn: true })
      this.handlers.onLog('info', '摄像头已恢复，画面已切回摄像头')
      return
    }
    await Promise.all([...this.bundles.values()].map((b) => b.session.replaceVideoTrack(null)))
    this.broadcastMediaState({ camOn: false })
    this.handlers.onLog('warn', '摄像头恢复失败，已停止视频发送', '对端将显示头像占位；可稍后在媒体设置里重试采集')
  }

  /** 广播共享状态（控制面消息，仅布尔，无内容）：对端聚焦布局与徽标据此呈现 */
  private broadcastShareState(on: boolean) {
    this.sharingOn = on
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'share', on })
    })
  }

  /**
   * 屏幕共享出流健康看门狗（用户真机报告「共享画面只有自己看得到」）：
   * 开启 3.5s 与 6s 两次采样视频发送端 framesSent，无增长 → 显式告警（编码器未出帧，
   * 对端大概率看不到共享画面），提示关闭重开；正常时静默。
   */
  private watchScreenShareHealth() {
    if (this.shareWatchdog) clearTimeout(this.shareWatchdog)
    const sample = async (): Promise<number | null> => {
      let total: number | null = null
      for (const b of this.bundles.values()) {
        try {
          const report = await b.session.pc.getStats()
          report.forEach((s) => {
            const r = s as unknown as Record<string, unknown>
            if (r.type === 'outbound-rtp' && r.kind === 'video' && typeof r.framesSent === 'number') {
              total = (total || 0) + (r.framesSent as number)
            }
          })
        } catch {
          /* noop */
        }
      }
      return total
    }
    this.shareWatchdog = setTimeout(async () => {
      if (!this.screenStream) return
      const first = await sample()
      this.shareWatchdog = setTimeout(async () => {
        if (!this.screenStream) return
        const second = await sample()
        if (first != null && second != null && second - first < 3) {
          this.handlers.onLog(
            'warn',
            '屏幕共享疑似未出帧（对端可能看不到你的共享画面）',
            `framesSent ${first} → ${second}（3s 内无增长）。建议关闭重开共享；若系统弹窗未选择画面也会这样`,
          )
          this.handlers.onScreenShareWarn()
        }
      }, 2500)
    }, 3500)
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices()
    } catch {
      return []
    }
  }

  /* ------------------------------- 会话管理 ------------------------------- */

  private async createSession(peer: PeerBrief): Promise<void> {
    if (!this.identity || !this.salt || this.bundles.has(peer.socketId)) return
    if (peer.peerId === this.selfPeerId) return
    try {
      // 密钥协商：ECDH 公钥经信令转发（公钥可公开），会话密钥只存在于两端内存
      const peerJwk = peer.pubkey ? (JSON.parse(peer.pubkey) as JsonWebKey) : await this.fetchPeerKey(peer)
      const sharedBits = await deriveSharedBits(this.identity.privateKey, peerJwk)

      // ── PAKE（SPAKE2，ROADMAP P0-3）：设置口令时，ECDH 秘密必须先通过口令认证才可用于派生 ──
      // 角色由双方 peerId 字典序确定性分配（两侧一致，无需协商）；
      // 互验失败（口令不一致/中间人篡改/超时）→ 抛错 → 不创建会话（fail-closed）
      let ikm = sharedBits
      if (this.passcode) {
        ikm = await this.runPakeHandshake(peer, sharedBits)
      }

      const rawKeys: RawKeySet = await deriveRawKeys(ikm, this.salt, this.selfPeerId, peer.peerId)
      const safety = await safetyNumber(this.identity.fingerprint, peer.fingerprint, this.salt)

      // 跨端帧加密能力协商（黑屏根治）：任一端不支持 insertable streams → 媒体帧不加密，
      // 回退 DTLS-SRTP 传输加密（聊天/文件 DC 加密不受影响）。修复 Safari/Chrome 混用
      // 时一端发未加密帧/另一端解密失败丢帧 → 「连接成功但双向黑屏无声」。
      // e2eeEnabled 开关（任一端关闭）与能力协商共用该降级路径，双方结论一致。
      const localCap = useVeil.getState().e2eeEnabled ? e2eeManager.capability : 'unsupported'
      const remoteCap = peer.pubkey ? this.peerCaps.get(peer.peerId) || 'none' : 'none'
      const frameE2EE = localCap !== 'unsupported' && remoteCap !== 'none'
      if (!frameE2EE) {
        rawKeys.videoOut = new ArrayBuffer(0)
        rawKeys.videoIn = new ArrayBuffer(0)
        rawKeys.audioOut = new ArrayBuffer(0)
        rawKeys.audioIn = new ArrayBuffer(0)
        this.handlers.onLog(
          'warn',
          `与 ${peer.name} 的应用层加密已降级为 DTLS-SRTP`,
          `原因：加密协商 local=${localCap === 'unsupported' && useVeil.getState().e2eeEnabled === false ? '已手动关闭' : localCap} remote=${remoteCap}（双方一致降级保互通；传输仍全程加密）`,
        )
      } else {
        this.handlers.onLog('crypto', `与 ${peer.name} 的媒体帧加密已启用（${localCap}）`, 'AES-256-GCM 逐帧加密，密钥永不上传')
      }

      const bundle: SessionBundle = {
        peer,
        session: null as unknown as PeerSession,
        sender: null,
        receiver: null,
        // 轮换环先占位、session 建好后立即填充（下方 DcKeyRing 构造）
        chatOut: null as unknown as DcKeyRing,
        chatIn: null as unknown as DcKeyRing,
        fileOut: null as unknown as DcKeyRing,
        fileIn: null as unknown as DcKeyRing,
        secure: frameE2EE,
        lastQReportTs: 0,
        lastResyncTs: 0,
        lastSyncRespTs: 0,
      }
      const session = new PeerSession({
        selfPeerId: this.selfPeerId,
        remoteSocketId: peer.socketId,
        remotePeerId: peer.peerId,
        iceServers: this.iceServers,
        rawKeys,
        // 【Task 35】多人钳制中新建的会话直接用生效档位（而非用户原始选择）
        tier: this.activeClamp ?? this.currentTier,
        cbs: {
          onSignal: (data) => this.socket?.emit('signal', { to: peer.socketId, data }),
          onRemoteStream: (stream) => this.handlers.onRemoteStream(peer.socketId, stream),
          onStateChange: (state) => this.handlers.onPeerState(peer.socketId, state),
          onStats: (stats) => {
            this.handlers.onPeerStats(peer.socketId, stats)
            // 对方看到的你的画面（实测回传，5s 节流）：对端解码出的分辨率/帧率/RTT
            const now = Date.now()
            if (
              stats.video?.width &&
              now - bundle.lastQReportTs > 5000 &&
              bundle.session.dataOpen()
            ) {
              bundle.lastQReportTs = now
              try {
                bundle.session.sendJson({
                  t: 'quality-report',
                  w: stats.video.width,
                  h: stats.video.height,
                  fps: stats.video.fps,
                  rtt: stats.rttMs,
                })
              } catch { /* noop */ }
            }
          },
          onAdaptiveChange: (kbps) => this.handlers.onAdaptive(peer.socketId, kbps),
          onDataMessage: (msg) => this.handleControl(bundle, msg),
          onFileChunk: (buf) => bundle.receiver?.handleChunk(buf),
          // 接收端加密模式在 ontrack 才能确定（建会话时尚未收到对端轨），变化时增量上报
          onRecvModeChange: () =>
            this.handlers.onPeerE2EE(peer.socketId, {
              video: session.e2eeVideoMode,
              audio: session.e2eeAudioMode,
              videoRecv: session.e2eeVideoRecvMode,
              audioRecv: session.e2eeAudioRecvMode,
            }),
          onDataOpen: () => {
            session.sendJson({ t: 'hello', name: this.displayName })
            // DC 就绪即补发当前媒体状态（新加入/重连后对端立即可见本端闭麦/关摄状态）
            const st = useVeil.getState()
            session.sendJson({ t: 'media-state', micOn: st.micOn, camOn: st.camOn })
            // 同步补发共享状态（Task 27）：DC 未就绪期间开启的共享不再丢信号 ——
            // 否则对端重连/晚加入者看不到 sharing 徽标、聚焦切换与低延迟播放档
            if (this.sharingOn) session.sendJson({ t: 'share', on: true })
          },
          // 入站视频帧停滞自愈（Task 30「另一端看不到共享」）：观看端检测到对端视频
          // 帧停止增长 → 请求发送端重发共享轨（replaceTrack + 重协商），节流 12s
          onInboundStall: () => {
            const now = Date.now()
            if (now - bundle.lastResyncTs < 12000) return
            bundle.lastResyncTs = now
            // 【Task 35】原发 'share-resync' 但发送端只处理共享轨（!sharingOn 即丢弃）——
            // 摄像头轨黑屏（多人上行饱和/单向链路死亡）时自愈环根本不闭合。改发 'media-resync'，
            // 发送端按当前活跃轨（摄像头优先/共享轨）重建编码强制关键帧。
            session.sendJson({ t: 'media-resync' })
            this.handlers.onLog('net', `观看 ${peer.name} 的画面停滞，已请求重同步…`)
          },
          onLog: (level, msg, detail) => this.handlers.onLog(level, msg, detail),
        },
      })
      bundle.session = session
      // DC 轮换环：聊天/文件各方向独立 epoch 链（种子 = HKDF 派生的原始字节）
      bundle.chatOut = new DcKeyRing(rawKeys.chatOut, 'out')
      bundle.chatIn = new DcKeyRing(rawKeys.chatIn, 'in')
      bundle.fileOut = new DcKeyRing(rawKeys.fileOut, 'out')
      bundle.fileIn = new DcKeyRing(rawKeys.fileIn, 'in')
      bundle.receiver = new FileReceiver(bundle.fileIn, {
        onTransferUpdate: (t) => this.handlers.onTransfer({ ...t, peerName: peer.name }),
        onLog: (l, m, d) => this.handlers.onLog(l, m, d),
        // 断点续传握手：接收端 → 发送端回发 file-resume-sync{have}（DC ordered，同通道控制面）
        sendControl: (m) => session.sendJson(m),
      }, bundle.secure)
      bundle.sender = new FileSender(() => session.dc, bundle.fileOut, peer.name, {
        onTransferUpdate: (t) => this.handlers.onTransfer({ ...t, peerName: peer.name }),
        onLog: (l, m, d) => this.handlers.onLog(l, m, d),
        // 对端显式回执（F-33）：file-ack 由接收端在重组校验后回发，转发给 controller 更新 UI
        onTransferAck: (id, ok) => this.handlers.onTransferAck(bundle.peer.socketId, id, ok),
      }, bundle.secure)
      this.bundles.set(peer.socketId, bundle)
      // PAKE 口令认证已在密钥派生前完成（runPakeHandshake），此处向 UI 报告验证通过
      if (this.passcode) this.handlers.onPakeVerified(peer.socketId, peer.name)

      // 重放会话就绪前缓冲的信令（顺序保持），修复密钥派生窗口内 Offer/Answer 丢失的竞态
      const queued = this.pendingSignals.get(peer.socketId)
      this.pendingSignals.delete(peer.socketId)
      if (queued && queued.length > 0) {
        this.handlers.onLog('net', `重放缓冲信令 ${queued.length} 条`, `from=${peer.name}`)
        for (const d of queued) void session.handleSignal(d)
      }

      // 本地媒体接入（有轨才会触发协商；虚拟背景/增强开启时视频发送侧用加工轨）
      if (this.localStream) {
        this.localStream.getTracks().forEach((t) => {
          const send = t.kind === 'video' ? this.senderVideoTrack() || t : t
          session.addLocalTrack(send, this.localStream!)
        })
      }
      this.handlers.onPeerE2EE(peer.socketId, {
        video: session.e2eeVideoMode,
        audio: session.e2eeAudioMode,
        videoRecv: session.e2eeVideoRecvMode,
        audioRecv: session.e2eeAudioRecvMode,
        safety,
      })
      this.handlers.onLog(
        'crypto',
        `与 ${peer.name} 的加密会话已建立（密钥协商完成${this.passcode ? ' · PAKE 口令验证通过' : ''}）`,
        `safety=${safety} · 密钥永不上传`,
      )
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const reason = raw.includes('PAKE_VERIFY_FAILED')
        ? '口令不一致或存在中间人（密钥互验失败）'
        : raw.startsWith('spake2:')
          ? '对端共享值非法（可能被篡改）'
          : raw
      this.spakeCancel(peer.socketId)
      this.handlers.onLog('error', `与 ${peer.name || '成员'} 建立会话失败`, reason)
      if (this.passcode) this.handlers.onPakeFailed(peer.socketId, peer.name || '成员', reason)
    }
  }

  /** 公钥不在信令摘要里时兜底（预留：未来版本将把公钥放入 join 摘要） */
  private peerKeys = new Map<string, JsonWebKey>()
  /** 对端帧加密能力（pubkey JSON 内捎带；未知 → 按不支持处理，保互通） */
  private peerCaps = new Map<string, 'encoded-streams' | 'script-transform' | 'none'>()

  /** 解析并登记对端公钥 + 帧加密能力（pubkey JSON 内可选 cap 字段，信令透传不感知） */
  registerPeerInfo(peerId: string, raw: string) {
    const parsed = JSON.parse(raw) as JsonWebKey & { cap?: 'encoded-streams' | 'script-transform' | 'none' }
    const { cap, ...jwk } = parsed
    this.peerKeys.set(peerId, jwk)
    // 未知/缺失 cap 的对端按不支持处理（保守降级保互通：宁可 DTLS 加密传输，不可黑屏）
    this.peerCaps.set(peerId, cap === 'encoded-streams' || cap === 'script-transform' ? cap : 'none')
  }

  registerPeerKey(peerId: string, jwk: JsonWebKey) {
    this.peerKeys.set(peerId, jwk)
  }

  private async fetchPeerKey(peer: PeerBrief): Promise<JsonWebKey> {
    const jwk = this.peerKeys.get(peer.peerId)
    if (jwk) return jwk
    throw new Error('对端公钥缺失，无法完成密钥协商')
  }

  /* ------------------------- PAKE（SPAKE2）口令认证 ------------------------- */

  /**
   * SPAKE2 握手（双方并发对等执行，无主从）：
   *  1. 双方各自计算公开共享值并经信令互换（t:'spake-share'，公钥同级可公开）
   *  2. 各自算 Z → 会话密钥 K + 本端证明，互换证明（t:'spake-confirm'）并互验
   *  3. 互验通过 → HKDF(ECDH 秘密, salt=K) 得业务密钥根：ECDH 提供前向保密，PAKE 提供口令认证
   * 任一环节失败/超时（8s）→ 抛错 → createSession 放弃建会话（fail-closed，无任何密钥产生）
   */
  private async runPakeHandshake(peer: PeerBrief, sharedBits: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.identity || !this.socket || !this.roomId) throw new Error('PAKE 上下文缺失')
    const role: SpakeRole = this.selfPeerId < peer.peerId ? 'A' : 'B'
    const context = `veiltalk:${this.roomId}`
    const started = await spakeStart(role, this.passcode!, context)

    const waiter = this.spakeWaiters.get(peer.socketId) || {}
    this.spakeWaiters.set(peer.socketId, waiter)
    this.socket.emit('signal', {
      to: peer.socketId,
      data: { t: 'spake-share', share: bufToB64(started.share) },
    })

    const peerShare = await this.spakeWaitFor(waiter, 'share')
    const kc = await spakeComputeKey({
      role,
      password: this.passcode!,
      context,
      ownSecret: started.secret,
      ownShare: started.share,
      peerShare,
      selfId: this.selfPeerId,
      peerId: peer.peerId,
      selfFp: this.identity.fingerprint,
      peerFp: peer.fingerprint,
    })
    this.socket.emit('signal', {
      to: peer.socketId,
      data: { t: 'spake-confirm', proof: bufToB64(kc.proof) },
    })

    const peerProof = await this.spakeWaitFor(waiter, 'confirm')
    const ok = await spakeVerifyProof(kc.key, kc.transcript, kc.peerRole, peerProof)
    this.spakeWaiters.delete(peer.socketId)
    if (!ok) throw new Error('PAKE_VERIFY_FAILED')
    return bindPakeSecret(sharedBits, kc.key)
  }

  /** 等待对端 PAKE 消息（早期缓冲优先返回；超时/取消拒绝） */
  private spakeWaitFor(
    waiter: { resolveShare?: (v: Uint8Array) => void; resolveConfirm?: (v: Uint8Array) => void; earlyShare?: Uint8Array; earlyConfirm?: Uint8Array },
    kind: 'share' | 'confirm',
  ): Promise<Uint8Array> {
    const early = kind === 'share' ? waiter.earlyShare : waiter.earlyConfirm
    if (early) return Promise.resolve(early)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(kind === 'share' ? 'PAKE 共享值等待超时（对端未响应）' : 'PAKE 证明等待超时（对端未响应）')),
        8000,
      )
      const wrap = (v: Uint8Array) => {
        clearTimeout(timer)
        resolve(v)
      }
      if (kind === 'share') {
        waiter.resolveShare = wrap
      } else {
        waiter.resolveConfirm = wrap
      }
    })
  }

  /** PAKE 信令到达：有等待者则交付，否则落早期缓冲（等待者建立后回放） */
  private handleSpakeSignal(from: string, type: 'spake-share' | 'spake-confirm', payload: string) {
    if (!payload) return
    let bytes: Uint8Array
    try {
      bytes = b64ToBuf(payload)
    } catch {
      return
    }
    const w = this.spakeWaiters.get(from) || {}
    this.spakeWaiters.set(from, w)
    if (type === 'spake-share') {
      if (w.resolveShare) w.resolveShare(bytes)
      else w.earlyShare = bytes
    } else {
      if (w.resolveConfirm) w.resolveConfirm(bytes)
      else w.earlyConfirm = bytes
    }
  }

  /** 取消某对端的 PAKE 握手（离开/销毁时释放等待者，避免悬挂） */
  private spakeCancel(socketId: string) {
    this.spakeWaiters.delete(socketId)
  }

  private destroySession(socketId: string) {
    const bundle = this.bundles.get(socketId)
    if (!bundle) {
      this.pendingSignals.delete(socketId)
      this.spakeCancel(socketId)
      return
    }
    bundle.session.close()
    this.bundles.delete(socketId)
    this.pendingSignals.delete(socketId)
    this.spakeCancel(socketId)
    this.handlers.onRemoteStream(socketId, null)
  }

  private destroyAllSessions(stopMedia: boolean) {
    const ids = [...this.bundles.keys()]
    this.bundles.forEach((b) => b.session.close())
    this.bundles.clear()
    // stale 远端流清理（重连 rejoin 换 socketId / 离房时）：否则残留的旧流引用会让
    // tile 复用时显示冻结末帧（「看不到对方画面」的一种成因）
    ids.forEach((id) => this.handlers.onRemoteStream(id, null))
    this.pendingSignals.clear()
    this.spakeWaiters.clear()
    if (stopMedia && this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop())
      this.localStream = null
      this.handlers.onLocalStream(null)
    }
    if (stopMedia && this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop())
      this.screenStream = null
    }
    if (stopMedia) {
      // 加工管线随媒体一并释放（增强 + 虚拟背景 + 补帧；分割 WASM 堆同步归还）；
      // rAF/轨停在 stop() 内同步生效，异步收尾 fire-and-forget（本方法保持同步签名）
      this.previewTrackId = null
      useVeil.getState().set({ localPreviewStream: null })
      void (async () => {
        await this.interp.stop()
        await this.enhancer.stop()
        await this.vbg.dispose()
      })()
    }
  }

  private emitPeers() {
    // 【Task 35】对端数量变化 → 同步多人上行保护钳制（含 1v1 恢复用户档位）
    void this.refreshEffectiveTier()
    this.handlers.onPeersChanged([...this.bundles.values()].map((b) => b.peer))
  }

  /* ------------------------------- 聊天与文件 ------------------------------- */

  private handleControl(bundle: SessionBundle, msg: Record<string, unknown>) {
    const t = msg.t
    if (t === 'hello') return
    if (t === 'typing') {
      // 输入中指示：无内容、不加密、仅布尔信号；过期由 UI 侧时间戳衰减
      this.handlers.onTyping(bundle.peer.socketId, bundle.peer.name, msg.on === true)
      return
    }
    if (t === 'chat') {
      void this.decryptChat(bundle, msg)
      return
    }
    if (t === 'media-state') {
      // 对端麦克风/摄像头状态（控制面权威同步，Task 25）：闭麦/关摄徽标与 tile 头像提示的数据源
      this.handlers.onPeerMediaState(bundle.peer.socketId, {
        micOn: typeof msg.micOn === 'boolean' ? msg.micOn : undefined,
        camOn: typeof msg.camOn === 'boolean' ? msg.camOn : undefined,
      })
      return
    }
    if (t === 'speaking') {
      // 对端说话状态（发送端 AGC 归一化后广播；远端 tile 不再各自跑 WebAudio —— 多人性能 + 低配机一致性）
      this.handlers.onPeerSpeaking(bundle.peer.socketId, msg.on === true)
      return
    }
    if (t === 'chat-recall') {
      // 撤回：仅传 id，不传内容；接收端按 id 标记（E2EE 信道内，仅发送者本人可发起）
      this.handlers.onChatRecall(String(msg.id || ''))
      return
    }
    if (t === 'mute-request') {
      // 成员治理请求：只有类型（audio/video），无任何媒体内容；接受与否完全由本端决定
      const kind = msg.kind === 'video' ? 'video' : 'audio'
      this.handlers.onMuteRequest(bundle.peer.socketId, bundle.peer.name, kind)
      return
    }
    if (t === 'verify-req') {
      // 指纹互核（2026-10）：对端按了「互核指纹」→ 本端自动回发自己的加密指纹。
      // 核心校验：对端在 E2EE DataChannel 内声称的指纹 == 信令公钥推出的真实指纹？
      // 不一致 = 密钥被调包（潜在中间人），红色告警。
      const claimed = String(msg.fp || '')
      const ok = !!claimed && claimed === bundle.peer.fingerprint
      this.handlers.onVerifyRequest(bundle.peer.socketId, bundle.peer.name, ok)
      if (this.identity) {
        bundle.session.sendJson({ t: 'verify-resp', fp: this.identity.fingerprint })
      }
      return
    }
    if (t === 'verify-resp') {
      const claimed = String(msg.fp || '')
      const ok = !!claimed && claimed === bundle.peer.fingerprint
      this.handlers.onVerifyResult(bundle.peer.socketId, bundle.peer.name, ok)
      return
    }
    if (t === 'ice-switch') {
      // 对端发起的服务器热切换：同步应用同一名单（双方候选都来自新服务器）
      const ice = msg.ice
      if (Array.isArray(ice) && ice.length > 0) {
        this.iceServers = ice as RTCIceServer[]
        bundle.session.applyIceServers(this.iceServers)
        this.handlers.onLog('net', '对端切换了 ICE 服务器，本端已同步切换（重启协商中）')
      }
      return
    }
    if (t === 'quality-report') {
      // 对端实测回传：它实际解码到的我的画面（分辨率/帧率/RTT）
      this.handlers.onQualityReport?.(bundle.peer.socketId, {
        w: Number(msg.w) || 0,
        h: Number(msg.h) || 0,
        fps: Number(msg.fps) || 0,
        rtt: typeof msg.rtt === 'number' ? msg.rtt : null,
      })
      return
    }
    if (t === 'chat-react') {
      // 表情回应：仅传消息 id + emoji + 布尔（不含消息内容，消息体本身仍是密文）
      const emoji = String(msg.emoji || '')
      if (emoji) this.handlers.onChatReact(String(msg.id || ''), emoji, msg.on !== false)
      return
    }
    if (t === 'reaction') {
      // 会议级 Emoji 反应（F-41）：与 typing 同级的最小信号 —— 仅符号，无内容、不入聊天记录
      const emoji = String(msg.emoji || '')
      if (emoji && emoji.length <= 8) this.handlers.onReaction(bundle.peer.socketId, bundle.peer.name, emoji)
      return
    }
    if (t === 'hand') {
      // 举手/放下（F-42）：仅布尔，无内容
      this.handlers.onHand(bundle.peer.socketId, bundle.peer.name, msg.up === true)
      return
    }
    if (t === 'share') {
      // 对端屏幕共享状态（控制面布尔信号）：驱动对端聚焦布局/徽标呈现 +
      // 本端观看低延迟切换（抖动缓冲 100ms→0，Task 27「共享延迟真的很高」）
      bundle.session.setSharePlaybackProfile(msg.on === true)
      this.handlers.onPeerShare(bundle.peer.socketId, msg.on === true)
      return
    }
    if (t === 'media-resync') {
      // 【Task 35】观看端检测到画面停滞 → 发送端重建当前活跃视频轨编码（强制新关键帧）。
      // 与 share-resync 的区别：不要求共享中，摄像头轨黑屏同样可自愈。
      const now = Date.now()
      if (now - bundle.lastSyncRespTs < 8000) return
      bundle.lastSyncRespTs = now
      const track =
        (this.sharingOn ? this.screenStream?.getVideoTracks()[0] : undefined) ||
        this.localStream?.getVideoTracks()[0]
      if (!track || track.readyState !== 'live') return
      this.handlers.onLog('net', '对端观看停滞，正在重建视频编码（强制关键帧）…', `轨=${this.sharingOn && this.screenStream ? '共享' : '摄像头'}`)
      void bundle.session.replaceVideoTrack(track).then(() => bundle.session.nudgeOffer())
      return
    }
    if (t === 'share-resync') {
      // 观看端检测到帧停滞 → 发送端重发共享轨 + 重协商兜底（Task 30 共享自愈环）
      const now = Date.now()
      if (now - bundle.lastSyncRespTs < 8000) return
      bundle.lastSyncRespTs = now
      if (!this.sharingOn || !this.screenStream) return
      const track = this.screenStream.getVideoTracks()[0]
      if (!track || track.readyState !== 'live') return
      this.handlers.onLog('net', '对端请求共享重同步，正在重发画面…', '观看端报告画面停滞（旋转/系统抢占可能丢帧）')
      void bundle.session.replaceVideoTrack(track).then(() => bundle.session.nudgeOffer())
      return
    }
    bundle.receiver?.handleControl(msg)
    // file-resume-sync 面向发送端（断点续传握手响应）；其余类型在发送端内静默忽略
    bundle.sender?.handleControl(msg)
  }

  private async decryptChat(bundle: SessionBundle, msg: Record<string, unknown>) {
    if (!this.identity) return
    try {
      // E2EE 关闭协商（bundle.secure=false）：对端发送明文 JSON（p 字段直读）
      if (!bundle.secure && msg.p != null) {
        this.handlers.onChat({
          id: String(msg.id),
          from: bundle.peer.peerId,
          name: bundle.peer.name,
          ts: Number(msg.ts) || Date.now(),
          text: String(msg.p),
          mine: false,
          ...(msg.dm ? { dmSocketId: bundle.peer.socketId, dmName: bundle.peer.name } : {}),
        })
        return
      }
      // DC 轮换链：聊天 JSON 携带完整 epoch 号（e 缺省视为 0，兼容旧帧）
      const key = await bundle.chatIn.inKeyForEpoch(Number(msg.e) || 0)
      const iv = b64ToBuf(String(msg.iv))
      const ct = b64ToBuf(String(msg.ct))
      const u8 = new Uint8Array(ct.length + 12)
      u8.set(iv, 0)
      u8.set(ct, 12)
      const plain = await decryptFrame(key, u8.buffer)
      const text = new TextDecoder().decode(plain)
      this.handlers.onChat({
        id: String(msg.id),
        from: bundle.peer.peerId,
        name: bundle.peer.name,
        ts: Number(msg.ts) || Date.now(),
        text,
        mine: false,
        ...(msg.dm ? { dmSocketId: bundle.peer.socketId, dmName: bundle.peer.name } : {}),
      })
    } catch (e) {
      this.handlers.onLog('error', '聊天消息解密失败', String(e))
    }
  }

  /**
   * 发送聊天（toSocketId 缺省 = 群聊广播到全部对端；指定 = 私信，仅发给该对端）。
   * 本地回显携带 dmSocketId/dmName，ChatPanel 按会话分组展示。
   */
  async sendChat(text: string, toSocketId?: string): Promise<void> {
    if (!text.trim() || !this.identity || !this.salt) return
    const entry = { id: randomId(12), ts: Date.now(), text: text.trim() }
    const targets = toSocketId
      ? [...this.bundles.values()].filter((b) => b.peer.socketId === toSocketId)
      : [...this.bundles.values()]
    for (const bundle of targets) {
      try {
        if (!bundle.session.dataOpen()) continue
        if (!bundle.secure) {
          // E2EE 关闭协商：明文 JSON 直发（p 字段），接收端按 bundle.secure 走明文路径
          bundle.session.sendJson({ t: 'chat', id: entry.id, ts: entry.ts, p: entry.text, ...(toSocketId ? { dm: 1 } : {}) })
          continue
        }
        // DC 轮换链：当前纪元密钥加密（out() 内含懒自动轮换），epoch 号随消息下发
        const { key, epoch } = await bundle.chatOut.out()
        const plain = new TextEncoder().encode(entry.text)
        const framed = await encryptFrame(key, plain.buffer as ArrayBuffer)
        const u8 = new Uint8Array(framed)
        const iv = u8.slice(0, 12)
        const ct = u8.slice(12)
        bundle.session.sendJson({ t: 'chat', id: entry.id, ts: entry.ts, e: epoch, iv: bufToB64(iv), ct: bufToB64(ct), ...(toSocketId ? { dm: 1 } : {}) })
      } catch (e) {
        this.handlers.onLog('warn', `向 ${bundle.peer.name} 发送聊天失败`, String(e))
      }
    }
    const dmBundle = toSocketId ? this.bundles.get(toSocketId) : undefined
    this.handlers.onChat({
      ...entry,
      from: this.selfPeerId,
      name: this.displayName,
      mine: true,
      ...(dmBundle ? { dmSocketId: dmBundle.peer.socketId, dmName: dmBundle.peer.name } : {}),
    })
  }

  sendFile(file: File): number {
    let queued = 0
    for (const bundle of this.bundles.values()) {
      if (bundle.sender) {
        bundle.sender.enqueue(file)
        queued++
      }
    }
    if (queued === 0) this.handlers.onLog('warn', '没有可用对端（文件未发送）')
    return queued
  }

  cancelTransfer(id: string) {
    this.bundles.forEach((b) => b.sender?.cancel(id))
  }

  /**
   * 续传失败/中断的发送（P1-6）：按登记的 File 重新入队，接收端按 digest 从断点继续。
   * 返回是否有任一对端命中可续传登记。
   */
  retryTransfer(id: string): boolean {
    let ok = false
    this.bundles.forEach((b) => {
      if (b.sender?.retry(id)) ok = true
    })
    return ok
  }

  /** 暂停发送中的传输（对端状态同步为 paused） */
  pauseTransfer(id: string): boolean {
    let ok = false
    this.bundles.forEach((b) => {
      if (b.sender?.pause(id)) ok = true
    })
    return ok
  }

  /** 恢复发送中的传输 */
  resumeTransfer(id: string): boolean {
    let ok = false
    this.bundles.forEach((b) => {
      if (b.sender?.resume(id)) ok = true
    })
    return ok
  }

  /** 广播输入中指示（true=开始，false=停止；私信与群聊共用，不区分会话） */
  sendTyping(on: boolean) {
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'typing', on })
    })
  }

  /** 撤回自己的一条聊天消息（toSocketId = 私信撤回仅发该对端；缺省群聊广播） */
  sendChatRecall(id: string, toSocketId?: string) {
    const send = (b: SessionBundle) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'chat-recall', id })
    }
    if (toSocketId) {
      const b = this.bundles.get(toSocketId)
      if (b) send(b)
    } else {
      this.bundles.forEach(send)
    }
  }

  /** 表情回应变化（toSocketId = 私信；缺省群聊广播） */
  sendChatReact(id: string, emoji: string, on: boolean, toSocketId?: string) {
    const send = (b: SessionBundle) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'chat-react', id, emoji, on })
    }
    if (toSocketId) {
      const b = this.bundles.get(toSocketId)
      if (b) send(b)
    } else {
      this.bundles.forEach(send)
    }
  }

  /** 广播本端媒体状态（闭麦/关摄；hello 后与 toggle 时发送） */
  private broadcastMediaState(state: { micOn?: boolean; camOn?: boolean }) {
    const st = useVeil.getState()
    const payload = {
      t: 'media-state',
      micOn: state.micOn ?? st.micOn,
      camOn: state.camOn ?? st.camOn,
    }
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson(payload)
    })
  }

  /** 广播说话状态（video-tile 本端 AGC 检测后经 controller 调用；边沿触发，控制器负责去抖） */
  sendSpeaking(on: boolean) {
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'speaking', on })
    })
  }

  /** 发起指纹互核：对端自动回发其加密指纹，与本端已知的真实指纹比对（6s 无响应超时） */
  requestPeerVerify(socketId: string): boolean {
    const bundle = this.bundles.get(socketId)
    if (!bundle || !bundle.session.dataOpen() || !this.identity) return false
    useVeil.getState().setVerifyPending(socketId, Date.now())
    bundle.session.sendJson({ t: 'verify-req', fp: this.identity.fingerprint })
    setTimeout(() => {
      const st = useVeil.getState()
      if (st.verifyPending[socketId]) {
        st.setVerifyPending(socketId, null)
        st.pushLog('warn', '指纹互核超时（对端未回发，可能不支持或已断线）')
        this.handlers.onVerifyResult(socketId, bundle.peer.name, false, true)
      }
    }, 6000)
    return true
  }

  /** 向指定对端发送静音/关摄像头请求（成员治理；对端可一键执行或忽略） */
  sendMuteRequest(socketId: string, kind: 'audio' | 'video') {
    const b = this.bundles.get(socketId)
    if (b?.session.dataOpen()) {
      b.session.sendJson({ t: 'mute-request', kind })
      return true
    }
    return false
  }

  /** 广播会议级 Emoji 反应（F-41；仅符号，与 typing 同级的轻量控制面消息） */
  sendReaction(emoji: string) {
    if (!emoji || emoji.length > 8) return
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'reaction', emoji })
    })
  }

  /** 广播举手/放下（F-42） */
  sendHand(up: boolean) {
    this.bundles.forEach((b) => {
      if (b.session.dataOpen()) b.session.sendJson({ t: 'hand', up })
    })
  }

  /** 房内热切换 ICE 服务器（服务器选择面板「转服务器」）：本端全部会话 setConfiguration +
   *  ICE 重启，并广播让对端同步切换（双方都换新服务器），媒体轨不断流。 */
  switchIceServer(): boolean {
    const picked = applyServerPick(this.envIceServers)
    const next = picked ?? this.envIceServers
    if (JSON.stringify(next) === JSON.stringify(this.iceServers)) return false
    this.iceServers = next
    const n = this.bundles.size
    this.bundles.forEach((b) => {
      b.session.applyIceServers(next)
      // 对端同步切换（同一条新服务器名单）：双方候选都来自新服务器，真正完成"转服"
      try {
        if (b.session.dataOpen()) b.session.sendJson({ t: 'ice-switch', ice: next })
      } catch { /* noop */ }
    })
    this.handlers.onLog('net', `ICE 服务器已热切换（${n} 条会话重启协商，不断流，已通知对端同步）`)
    if (n === 0) this.handlers.onLog('net', '当前无对端连接，新服务器将在下次连接时生效')
    return true
  }

  restartAllIce() {
    this.bundles.forEach((b) => b.session.manualRestartIce())
    this.handlers.onLog('net', '已触发全部会话 ICE 重启')
  }

  /** 手动轮换全部对端的媒体帧密钥（epoch+1；对端按帧内 epoch 自动跟随，无需信令） */
  rotateAllMediaKeys(): boolean {
    if (this.bundles.size === 0) return false
    let ok = false
    this.bundles.forEach((b) => {
      if (b.session.rotateMediaKeys()) ok = true
    })
    return ok
  }

  /**
   * 手动轮换全部 DataChannel 密钥（聊天/文件；聊天/文件各自 epoch+1）。
   * 对端按帧内 epoch 自主派生，无需信令；返回 { sessions, epoch } 供 UI 呈现。
   */
  rotateAllDataKeys(): { sessions: number; epoch: number } {
    let sessions = 0
    let epoch = 0
    this.bundles.forEach((b) => {
      const e = b.chatOut.rotate('manual')
      b.fileOut.rotate('manual')
      sessions++
      epoch = Math.max(epoch, e)
    })
    return { sessions, epoch }
  }

  /** 当前 DC 发送纪元（诊断面板展示；无会话时返回 0） */
  get dcEpoch(): number {
    let epoch = 0
    this.bundles.forEach((b) => {
      epoch = Math.max(epoch, b.chatOut.currentEpoch())
    })
    return epoch
  }

  /* ------------------------------ 房间治理 ------------------------------ */

  /** 房主/管理员：审批等候室成员（admit=true 通过入房 / false 拒绝；信令权威校验身份） */
  respondAdmission(socketId: string, admit: boolean): boolean {
    if (!this.socket?.connected) return false
    this.socket.emit('admission-respond', { socketId, admit })
    return true
  }

  /** 房主将某成员移出房间（信令侧校验房主/管理员身份与同房成员资格，台账只记 id） */
  kickPeer(socketId: string): boolean {
    if (!this.socket?.connected) return false
    this.socket.emit('kick-peer', { socketId })
    return true
  }

  /** 房主锁定/解锁房间（锁定后新人加入被拒绝，房间内成员不受影响） */
  setRoomLocked(locked: boolean): boolean {
    if (!this.socket?.connected) return false
    this.socket.emit('lock-room', { locked })
    return true
  }

  get sessionCount(): number {
    return this.bundles.size
  }

  get myFingerprint(): string {
    return this.identity?.fingerprint || ''
  }
}
