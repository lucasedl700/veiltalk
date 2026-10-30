/**
 * VeilTalk PeerSession — 单个远端节点的 WebRTC 会话（完美协商 + E2EE + 数据通道 + 诊断）
 *
 * 模块职责：
 *  1. 完美协商（Perfect Negotiation，W3C 推荐模式）：处理 Offer 冲突/glare
 *     - polite = 本端 peerId 字典序 > 对端 peerId；冲突时 polite 回滚让路，impolite 坚持己见
 *  2. E2EE 接线：track 添加/接收瞬间注入 worker 帧加密（按媒体类型/方向使用派生密钥原始字节）
 *  3. 数据通道：`veiltalk-control`（有序可靠）承载 JSON 控制消息 + 加密文件块
 *  4. 诊断：getStats 轮询（RTT/码率/丢包/分辨率/候选对类型）+ 弱网自适应码率 + ICE 自动重启
 *
 * 边界：本类不理解房间语义，仅与一个远端 socketId 一一对应；房间逻辑在 room-client。
 */

import type { PeerStats, RawKeySet, SignalData } from './types'
import { e2eeManager } from './e2ee-manager'
import { ladderFor, TIER_MAP, type QualityTier } from './tiers'
import { applyHardwareVideoCodecPreference } from './codec-pref'

export interface PeerSessionCallbacks {
  onSignal: (data: SignalData) => void
  onRemoteStream?: (stream: MediaStream) => void
  onStateChange?: (state: RTCPeerConnectionState) => void
  onStats?: (stats: PeerStats) => void
  onDataMessage?: (msg: Record<string, unknown>) => void
  onFileChunk?: (buf: ArrayBuffer) => void
  onDataOpen?: () => void
  /** 接收端加密模式变化（ontrack 后已知 recv 管线状态，供 UI 增量上报） */
  onRecvModeChange?: () => void
  onLog?: (level: 'info' | 'warn' | 'error' | 'crypto' | 'net', msg: string, detail?: string) => void
  onAdaptiveChange?: (kbps: number) => void
  /** 入站视频帧停滞（已连接但对端视频帧不增长；Task 30 共享自愈环触发源，内部已节流） */
  onInboundStall?: () => void
}

const STATS_INTERVAL_MS = 2000
const APP_PING_INTERVAL_MS = 3000
const APP_PONG_STALE_MS = 12000
/** 弱网降档门槛（Task 32 锐化：等 RTT 破 420ms 才动作时队列早就胀满了 —— 用户体感「很卡」） */
const LOSS_DOWNGRADE_PCT = 5
const RTT_DOWNGRADE_MS = 260
/** 降档冷却：降要快（5s）；升要慢（UPGRADE_AFTER_MS）—— 振荡比略低更伤体感 */
const DOWNGRADE_COOLDOWN_MS = 5000
const UPGRADE_AFTER_MS = 30000
/** 共享期门槛放宽（共享需要吞吐，轻微抖动不牺牲码率）但比旧版更早介入 */
const SHARE_LOSS_DOWNGRADE_PCT = 10
const SHARE_RTT_DOWNGRADE_MS = 400
const SHARE_DOWNGRADE_COOLDOWN_MS = 10000
/** 饿死检测：实际发送 < 编码器目标 55%（诊断信号，不做强制降档 —— 静态画面会误报） */
const STARVE_RATIO = 0.55
const STARVE_STREAK = 3
/** 低帧率诚实告警：网络不差但 fps 长期 < 18 → 设备/处理管线跟不上，提示降档 */
const LOW_FPS_THRESHOLD = 18
const LOW_FPS_STREAK = 15

export class PeerSession {
  readonly pc: RTCPeerConnection
  dc: RTCDataChannel | null = null
  readonly remoteSocketId: string
  readonly remotePeerId: string
  rawKeys: RawKeySet
  /** 发送方向加密模式（仅 addLocalTrack/replaceVideoTrack 路径写入） */
  e2eeVideoMode: string = 'pending'
  e2eeAudioMode: string = 'pending'
  /** 接收方向加密模式（仅 ontrack 写入；与发送分开，避免互相覆盖导致诊断失真） */
  e2eeVideoRecvMode: string = 'pending'
  e2eeAudioRecvMode: string = 'pending'

  private readonly selfPeerId: string
  private readonly polite: boolean
  /** 已预接线接收器的标记（ontrack 幂等跳过；避免重复 createEncodedStreams 抛 Too late） */
  private preWiredReceivers = new WeakSet<RTCRtpReceiver>()
  /** 无 msid 场景（构造期预建 transceiver + replaceTrack 喂轨）按对端聚合的单一远端流 */
  private remoteStream: MediaStream | null = null
  private remoteTracks = new Set<MediaStreamTrack>()
  private makingOffer = false
  private ignoreOffer = false
  private offerQueued = false
  /** 本端该会话是否正在共享屏幕（applyShareProfile 置位；共享期降档阈值放宽 + 发送优先级 high） */
  private sharingActive = false
  private cbs: PeerSessionCallbacks
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastBytesSent = 0
  private lastBytesReceived = 0
  private lastPacketsLost = 0
  private lastPacketsRecv = 0
  private lastStatsTs = 0
  private currentBitrateIdx = 0
  private lastAdaptiveTs = 0
  /** 画质档位与对应自适应梯队（弱网降级不低于档位顶格码率太多） */
  private tier: QualityTier
  private ladder: number[]
  /** 首次 connected 后一次性顶格码率（4K/1080p60 档必需；否则浏览器默认上限 ≈2.5Mbps） */
  private initialBitrateApplied = false
  /** 自动 ICE 重启次数（fail 后自动恢复，最多 2 次；手动重试会清零） */
  private iceRestarted = 0
  /** 连接看门狗：connecting/disconnected 停留超时则主动 restartIce（不要长时间卡住） */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /* 应用层 ping-pong RTT 测量 */
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastAppRttMs: number | null = null
  private lastPongTs = 0
  /** 黑屏健康监测：首次 connected 时间与是否已告警（帧停滞诊断，一次性） */
  private connectedAt = 0
  private stallWarned = false
  /* ---- Task 30：入站帧停滞检测（自愈环触发源） + 高 RTT 帧率上限 ---- */
  private lastInFrames = -1
  private lastInFramesChangeTs = 0
  private lastStallNotifyTs = 0
  private stallEscalations = 0 // 【Task 35】连续停滞通知计数 → ×3 升级 ICE 重启
  /** 连续高 RTT 采样数（≥350ms 计 1，低 RTT 清零；≥3 触发帧率上限） */
  private highRttStreak = 0
  /** 低 RTT 连续采样数（恢复判据） */
  private lowRttStreak = 0
  /** 帧率上限已生效（延迟模式） */
  private fpsCapped = false
  /** 饿死连续采样计数（编码器目标与实际发出严重背离 = 链路拥堵先兆） */
  private starveStreak = 0
  /** 低帧率连续采样计数与一次性告警标志（诚实提示：设备/管线跟不上当前档位） */
  private lowFpsStreak = 0
  private lowFpsWarned = false
  /** 实际协商编解码一次性落账标志 */
  private codecLogged = false

  constructor(opts: {
    selfPeerId: string
    remoteSocketId: string
    remotePeerId: string
    iceServers: RTCIceServer[]
    rawKeys: RawKeySet
    cbs: PeerSessionCallbacks
    /** 画质档位（弱网自适应梯队顶格值随档位走；4K 档不顶格码率必然糊） */
    tier?: QualityTier
  }) {
    this.selfPeerId = opts.selfPeerId
    this.remoteSocketId = opts.remoteSocketId
    this.remotePeerId = opts.remotePeerId
    this.rawKeys = opts.rawKeys
    this.cbs = opts.cbs
    this.polite = this.selfPeerId > this.remotePeerId
    this.tier = opts.tier || '720p'
    this.ladder = ladderFor(this.tier)

    // ICE 提速：候选池预热（提前预收集 host/srflx 候选，减少首次协商等待）；max-bundle 降端口/资源开销
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    })

    // BUG-16 终极修复：预建音/视频 transceiver（sendrecv），并在构造期立刻预接线接收端
    // 解密管线 —— 此时尚未协商、零帧流动，遗留 createEncodedStreams 必然不会 Too late；
    // 后续 addTrack 会复用这两个 transceiver（方向已符合），m-line 数量恒定为 2
    const audioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' })
    const videoTx = this.pc.addTransceiver('video', { direction: 'sendrecv' })
    // Task 32 反卡顿：视频硬编优先（H264 > VP9 > VP8 > AV1）——4K/高帧率档软编是
    // 「帧率低 + 整机卡」的头号根因；不支持的浏览器自动回退默认顺序
    applyHardwareVideoCodecPreference(this.pc)
    this.wireReceiverEarly(audioTx.receiver, 'audio')
    this.wireReceiverEarly(videoTx.receiver, 'video')
    this.wireSenderEarly(audioTx.sender, 'audio')
    this.wireSenderEarly(videoTx.sender, 'video')

    this.pc.onnegotiationneeded = () => {
      this.scheduleOffer()
    }
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.cbs.onSignal({ candidate: e.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => {
      this.cbs.onStateChange?.(this.pc.connectionState)
      if (this.pc.connectionState === 'connected') {
        this.clearConnectWatchdog()
        // 首次连通后立即顶格码率（不依赖弱网事件；4K 档浏览器默认上限会严重压画质）
        if (!this.initialBitrateApplied) {
          this.initialBitrateApplied = true
          void this.setVideoMaxBitrate(this.ladder[0])
        }
      } else if (this.pc.connectionState === 'connecting' || this.pc.connectionState === 'disconnected') {
        this.armConnectWatchdog()
      } else if (this.pc.connectionState === 'failed') {
        this.clearConnectWatchdog()
        this.autoRecover()
      }
    }
    this.pc.ontrack = (e) => {
      const kind = e.track.kind
      // 构造期已预接线的 receiver 直接跳过（幂等）；仅处理意外新增的 receiver（如重协商新增 m-line）
      if (!this.preWiredReceivers.has(e.receiver)) {
        const raw = kind === 'video' ? this.rawKeys.videoIn : this.rawKeys.audioIn
        const rawCopy = raw.slice(0)
        if (rawCopy.byteLength > 0 && e.receiver) {
          const mode = e2eeManager.attachReceiver(e.receiver, rawCopy, `${this.remoteSocketId}:recv:${kind}`)
          if (kind === 'video') this.e2eeVideoRecvMode = mode
          else this.e2eeAudioRecvMode = mode
          if (mode === 'unsupported' && e2eeManager.capability !== 'unsupported') {
            this.cbs.onLog?.(
              'warn',
              `${kind === 'video' ? '视频' : '音频'}解密管线接线失败，画面可能无法显示`,
              e2eeManager.lastAttachError,
            )
          } else {
            this.cbs.onLog?.(
              'crypto',
              `接收端 E2EE 已接线（${kind}）`,
              `mode=${mode} peer=${this.remotePeerId.slice(0, 8)}`,
            )
          }
        }
        this.preWiredReceivers.add(e.receiver)
        this.cbs.onRecvModeChange?.()
      }
      // 有 msid（标准 addTrack 关联）→ 直接用对端流；无 msid（预建 transceiver + replaceTrack）
      // → 惰性聚合到同一 MediaStream，避免音/视频各自新建流导致音频轨被覆盖丢失
      // 音频调试日志（真机排障：听不到声音时先看这条：track 是否 live/enabled）
      if (kind === 'audio') {
        this.cbs.onLog?.(
          'net',
          '远端音频轨到达',
          `id=${e.track.id.slice(0, 8)} readyState=${e.track.readyState} enabled=${e.track.enabled} muted=${e.track.muted} streams=${e.streams.length}`,
        )
      }
      const msStream = e.streams[0]
      if (msStream) {
        this.cbs.onRemoteStream?.(msStream)
      } else {
        if (!this.remoteStream) this.remoteStream = new MediaStream()
        if (!this.remoteTracks.has(e.track)) {
          this.remoteTracks.add(e.track)
          this.remoteStream.addTrack(e.track)
        }
        this.cbs.onRemoteStream?.(this.remoteStream)
      }
      this.cbs.onRecvModeChange?.()
    }
    this.pc.ondatachannel = (e) => this.wireDataChannel(e.channel)

    // 帧加密能力协商结果落位：媒体密钥为零（协商关闭）→ 显式上报 'off'，诊断不再显示 pending
    if (this.rawKeys.videoOut.byteLength === 0 && this.rawKeys.videoIn.byteLength === 0) {
      this.e2eeVideoMode = 'off'
      this.e2eeAudioMode = 'off'
      this.e2eeVideoRecvMode = 'off'
      this.e2eeAudioRecvMode = 'off'
    }

    // 完美协商约定：impolite 侧负责创建数据通道（polite 侧等 ondatachannel），
    // 避免双端各自建通道产生两条冗余 SCTP 通道
    if (!this.polite) {
      this.wireDataChannel(this.pc.createDataChannel('veiltalk-control', { ordered: true }))
    }

    this.startStatsLoop()
  }

  /* ----------------------------- 媒体与 E2EE ----------------------------- */

  /** 构造期预接线接收端解密管线（必然早于首帧；遗留优先 —— Chromium receiver 标准路径不生效） */
  private wireReceiverEarly(receiver: RTCRtpReceiver, kind: 'audio' | 'video') {
    this.preWiredReceivers.add(receiver)
    // 低延迟：收紧抖动缓冲（100ms；不支持的老浏览器静默跳过），配合 P2P 直连降低端到端时延
    try {
      const jitter = receiver as RTCRtpReceiver & { jitterBufferTarget?: number }
      if (typeof jitter.jitterBufferTarget === 'number' || 'jitterBufferTarget' in receiver) jitter.jitterBufferTarget = 100
    } catch { /* noop */ }
    const raw = kind === 'video' ? this.rawKeys.videoIn : this.rawKeys.audioIn
    if (raw.byteLength === 0) return
    const mode = e2eeManager.attachReceiverEarly(receiver, raw.slice(0), `${this.remoteSocketId}:recv:${kind}`)
    if (kind === 'video') this.e2eeVideoRecvMode = mode
    else this.e2eeAudioRecvMode = mode
    if (mode === 'unsupported' && e2eeManager.capability !== 'unsupported') {
      this.cbs.onLog?.('warn', `${kind === 'video' ? '视频' : '音频'}解密管线预接线失败`, e2eeManager.lastAttachError)
    } else {
      this.cbs.onLog?.('crypto', `接收端 E2EE 已预接线（${kind}）`, `mode=${mode}`)
    }
  }

  /** 构造期预接线发送端加密管线（传输启动前挂 transform，replaceTrack 喂轨自动流经加密） */
  private wireSenderEarly(sender: RTCRtpSender, kind: 'audio' | 'video') {
    const raw = kind === 'video' ? this.rawKeys.videoOut : this.rawKeys.audioOut
    if (raw.byteLength === 0) return
    const mode = e2eeManager.attachSenderEarly(sender, raw.slice(0), `${this.remoteSocketId}:send:${kind}`)
    if (kind === 'video') this.e2eeVideoMode = mode
    else this.e2eeAudioMode = mode
    if (mode === 'unsupported' && e2eeManager.capability !== 'unsupported') {
      this.cbs.onLog?.('warn', `${kind === 'video' ? '视频' : '音频'}加密管线预接线失败`, e2eeManager.lastAttachError)
    } else {
      this.cbs.onLog?.('crypto', `发送端 E2EE 已预接线（${kind}）`, `mode=${mode}`)
    }
  }

  addLocalTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    // BUG-16：显式复用构造期预建的 transceiver（Chromium 的 addTrack 不会复用 addTransceiver
    // 创建的 transceiver，实测会产生双份 m-line 导致媒体走在新接收器上绕过解密管线）。
    // 发送端 transform 已在构造期预接线（attachSenderEarly），此处仅需喂入轨道。
    let sender: RTCRtpSender | null = null
    const tx = this.pc
      .getTransceivers()
      .find(
        (x) =>
          !(x as RTCRtpTransceiver & { stopping?: boolean }).stopping &&
          (x.sender.track === null || x.sender.track === undefined) &&
          x.receiver.track?.kind === track.kind,
      )
    if (tx) {
      try {
        void tx.sender.replaceTrack(track)
        sender = tx.sender
      } catch (e) {
        e2eeManager.lastAttachError = `reuse-replaceTrack:${track.kind}:${e instanceof Error ? e.message : String(e)}`
        console.error('[PeerSession] replaceTrack 复用失败，回退 addTrack', e2eeManager.lastAttachError)
        sender = null
      }
    }
    if (!sender) {
      sender = this.pc.addTrack(track, stream)
      // addTrack 兜底路径：新 sender 未预接线，补一次 attach（可能 Too late，日志可见）
      const mode =
        track.kind === 'video'
          ? e2eeManager.attachSender(sender, this.rawKeys.videoOut.slice(0), `${this.remoteSocketId}:send:video`)
          : e2eeManager.attachSender(sender, this.rawKeys.audioOut.slice(0), `${this.remoteSocketId}:send:audio`)
      if (track.kind === 'video') this.e2eeVideoMode = mode
      else this.e2eeAudioMode = mode
    }
    if (track.kind === 'video') {
      if (this.e2eeVideoMode === 'unsupported' && e2eeManager.capability !== 'unsupported') {
        // fail-closed：无法加密 → 停发该轨，绝不回退明文（E2EE 优先原则）
        void sender.replaceTrack(null).catch(() => {})
        this.cbs.onLog?.('warn', '视频加密管线接线失败，已停止发送该轨（防明文泄露）', e2eeManager.lastAttachError)
      }
    } else if (track.kind === 'audio') {
      if (this.e2eeAudioMode === 'unsupported' && e2eeManager.capability !== 'unsupported') {
        void sender.replaceTrack(null).catch(() => {})
        this.cbs.onLog?.('warn', '音频加密管线接线失败，已停止发送该轨（防明文泄露）', e2eeManager.lastAttachError)
      }
    }
    // replaceTrack 不触发 negotiationneeded（方向未变）——显式排程协商，确保后补轨道进入 Offer
    this.scheduleOffer()
    return sender
  }

  /** 手动推进本端发送管线的轮换 epoch（对端按帧内 epoch 字节自动跟随） */
  rotateMediaKeys(): boolean {
    let ok = false
    // 仅当对应媒体轨真实接入过 worker（mode 非 pending/unsupported）才有管线可轮换
    if (this.e2eeVideoMode === 'encoded-streams' || this.e2eeVideoMode === 'script-transform') {
      if (e2eeManager.forceRotate(`${this.remoteSocketId}:send:video`)) ok = true
    }
    if (this.e2eeAudioMode === 'encoded-streams' || this.e2eeAudioMode === 'script-transform') {
      if (e2eeManager.forceRotate(`${this.remoteSocketId}:send:audio`)) ok = true
    }
    if (ok) {
      this.cbs.onLog?.('crypto', '媒体帧密钥已手动轮换（epoch+1）', `peer=${this.remotePeerId.slice(0, 8)}`)
    }
    return ok
  }

  replaceVideoTrack(newTrack: MediaStreamTrack | null): Promise<void> {
    // 发送器定位兼容无轨场景（仅数据模式开共享 / 摄像头轨被系统回收后）:
    // 预建 transceiver 的 sender.track 可能为 null，按 sender.track 匹配会漏 →
    // 共享/回切静默失败；按 transceiver 的接收轨类型定位必中
    const tx = this.pc
      .getTransceivers()
      .find((x) => !(x as RTCRtpTransceiver & { stopping?: boolean }).stopping && x.receiver.track?.kind === 'video')
    const sender = tx?.sender || this.pc.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) return Promise.resolve()
    return sender
      .replaceTrack(newTrack)
      .then(() => undefined)
      .catch((e) => {
        this.cbs.onLog?.('warn', '视频轨替换失败', e instanceof Error ? e.message : String(e))
      })
  }

  async setVideoMaxBitrate(kbps: number): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      ;(params.encodings[0] as { maxBitrate?: number }).maxBitrate = kbps * 1000
      // 高帧率档弱网时优先保帧率（Zoom 式顺滑优先）；普通档画质/帧率平衡
      ;(params as { degradationPreference?: string }).degradationPreference = TIER_MAP[this.tier].maintainFps
        ? 'maintain-framerate'
        : 'balanced'
      await sender.setParameters(params)
      this.cbs.onLog?.('net', `视频目标码率调整为 ${kbps} kbps`, `peer=${this.remotePeerId.slice(0, 8)} · tier=${this.tier}`)
    } catch (e) {
      this.cbs.onLog?.('warn', '码率调整失败', String(e))
    }
  }

  /**
   * 帧率上限（Task 30「网络延迟高一点就卡」延迟模式）：持续高 RTT 时压低发送帧率，
   * 显著降低带宽占用与解码端追赶时间（低延迟网络下解除）。旧浏览器不支持则静默。
   */
  private async setVideoMaxFramerate(fps: number | null): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      const enc = params.encodings[0] as { maxFramerate?: number }
      if (fps == null) delete enc.maxFramerate
      else enc.maxFramerate = fps
      await sender.setParameters(params)
    } catch {
      /* 老浏览器/WebKit 不支持 maxFramerate：静默 */
    }
  }

  /** 画质档位热切换（画质 Select 变更时调用）：重置自适应梯队并立即重新顶格 */
  applyTierProfile(tier: QualityTier) {
    this.tier = tier
    this.ladder = ladderFor(tier)
    this.currentBitrateIdx = 0
    this.lastAdaptiveTs = 0
    void this.setVideoMaxBitrate(this.ladder[0])
  }

  /**
   * 屏幕共享编码档（Task 25/27「共享卡/延迟高/没得 4K60」）：
   *  - on=true：临时切换 4K60 档梯队（顶格 18Mbps，弱网梯队整体抬高），弱网优先保帧率；
   *    共享内容多为高动态文档/视频，维持帧率比保分辨率更抗卡顿（主观延迟显著降低）
   *  - 编码/队列优先级 high：共享流在与摄像头/音频争抢带宽时优先通过（降低拖动卡顿）
   *  - 接收端（本端作为观看方）同步切零缓冲低延迟播放（setSharePlaybackProfile）
   *  - on=false：恢复当前摄像头档位（applyTierProfile 语义）
   * 与 setVideoMaxBitrate 的 tier 状态联动：degradationPreference 随 maintainFps 正确切换。
   */
  applyShareProfile(on: boolean) {
    this.sharingActive = on
    if (on) {
      this.tier = '4k60'
      this.ladder = ladderFor('4k60')
      this.currentBitrateIdx = 0
      this.lastAdaptiveTs = 0
      void this.setVideoMaxBitrate(this.ladder[0])
      void this.setVideoPriority('high')
    } else {
      void this.setVideoPriority('medium')
    }
    // off 分支：恢复由 RoomClient 显式 applyTierProfile(摄像头当前档) 完成，避免猜测档位
  }

  /**
   * 发送队列优先级（Task 27「共享卡/延迟高」）：DSCP/pacing 层面的权重提示。
   * 共享画面拖动/视频播放对带宽突发最敏感，high 让共享流优先于其他流出队。
   */
  private async setVideoPriority(priority: 'low' | 'medium' | 'high' | 'very-low') {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      const enc = params.encodings[0] as { priority?: string; networkPriority?: string }
      enc.priority = priority
      enc.networkPriority = priority
      await sender.setParameters(params)
    } catch {
      /* 老浏览器不支持 priority 字段：静默跳过 */
    }
  }

  /**
   * 共享观看端低延迟播放（Task 27「共享延迟真的很高」）：对端开共享时，本端把
   * 视频接收器抖动缓冲压到 50ms（低延迟但不为零 —— 零缓冲在任何抖动下直接卡帧，
   * Task 32 用 50ms 换平滑度，延迟增量不可感知）；关闭共享时恢复 100ms。
   * 仅动视频接收器；音频通话的 100ms 缓冲保持不变（防爆音）。
   */
  setSharePlaybackProfile(peerSharing: boolean) {
    try {
      for (const receiver of this.pc.getReceivers()) {
        if (receiver.track?.kind !== 'video') continue
        const jitter = receiver as RTCRtpReceiver & { jitterBufferTarget?: number }
        if (typeof jitter.jitterBufferTarget === 'number' || 'jitterBufferTarget' in receiver) {
          jitter.jitterBufferTarget = peerSharing ? 50 : 100
        }
      }
    } catch { /* noop */ }
  }

  /** 显式排程一次协商（replaceTrack 后 WebKit 出帧兜底；stable 态幂等，Chrome 无副作用） */
  nudgeOffer() {
    if (this.closed) return
    // 仅在 stable/have-remote-offer 才有意义；makeOffer 内部有同款守卫，这里直接复用排程防抖
    this.scheduleOffer()
  }

  /**
   * 协商完成后重放当前档编码参数（Task 28）：
   * 实测 replaceTrack/nudgeOffer 触发的重协商会把 sender.encodings 重置为默认
   * （priority→low、maxBitrate 丢失）—— 共享期 high 优先级与顶格码率随之丢失，
   * 表现为「共享开着开着变糊变卡」。sharingActive 时幂等重放 maxBitrate+priority。
   */
  private reapplyEncodingProfile() {
    if (this.closed || !this.sharingActive) return
    void this.setVideoMaxBitrate(this.ladder[0])
    void this.setVideoPriority('high')
  }

  /** 协商排程（防抖合并）：Task 30「协商很慢」—— 60ms→15ms，同帧内多次请求合并为一次 Offer */
  private scheduleOffer() {
    if (this.offerQueued) return
    this.offerQueued = true
    setTimeout(() => {
      this.offerQueued = false
      if (this.closed) return
      if (this.makingOffer) {
        this.scheduleOffer()
        return
      }
      void this.makeOffer()
    }, 15)
  }

  /* --------------------------- 完美协商与信令 --------------------------- */

  private async makeOffer() {
    try {
      if (this.makingOffer || this.closed) return
      // 已有本地 Offer 在途（等对端应答）时不重复发；have-remote-offer 时无参调用会生成 Answer（glare 让路语义）
      const st = this.pc.signalingState
      if (st !== 'stable' && st !== 'have-remote-offer') return
      this.makingOffer = true
      await this.pc.setLocalDescription()
      if (this.pc.localDescription) {
        this.cbs.onSignal({
          description: {
            type: this.pc.localDescription.type as 'offer' | 'answer' | 'pranswer' | 'rollback',
            sdp: this.pc.localDescription.sdp || '',
          },
        })
      }
    } catch (e) {
      this.cbs.onLog?.('error', '创建 Offer 失败', String(e))
    } finally {
      this.makingOffer = false
      // Task 28 实测：replaceTrack + 重协商后 Chrome 会重置 encodings（priority 回默认 low、
      // maxBitrate 丢失）—— 共享「开一会又变糊变卡」的隐藏根因；协商动作完成后重放
      this.reapplyEncodingProfile()
    }
  }

  /**
   * 信令处理串行链：offer/answer 与 candidate 必须按到达顺序完成处理 ——
   * 否则 candidate 会在 setRemoteDescription 在途时被 addIceCandidate 拒绝丢失
   * （InvalidStateError），ICE 候选不全 → 部分网络下永远连不上 →「看不到对方画面」。
   * 每条信令入队串行执行；单条失败不断链。
   */
  private signalChain: Promise<void> = Promise.resolve()

  handleSignal(data: SignalData): Promise<void> {
    const run = this.signalChain.then(() => this.processSignal(data))
    this.signalChain = run.catch(() => {})
    return run
  }

  private async processSignal(data: SignalData) {
    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable')
        this.ignoreOffer = !this.polite && offerCollision
        if (this.ignoreOffer) {
          this.cbs.onLog?.('net', '忽略对端 Offer（协商冲突，本端为 impolite）')
          return
        }
        if (offerCollision && this.polite) {
          await this.pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit)
          this.cbs.onLog?.('net', '回滚本地 Offer（polite 让路）')
        }
        await this.pc.setRemoteDescription(data.description as RTCSessionDescriptionInit)
        if (data.description.type === 'offer') {
          await this.pc.setLocalDescription()
          if (this.pc.localDescription) {
            this.cbs.onSignal({
              description: {
                type: this.pc.localDescription.type as 'offer' | 'answer' | 'pranswer' | 'rollback',
                sdp: this.pc.localDescription.sdp || '',
              },
            })
          }
        }
        // 对端 Answer 应用完成：协商收尾点，重放共享编码参数（幂等；详见 reapplyEncodingProfile）
        if (data.description.type === 'answer') this.reapplyEncodingProfile()
      } else if (data.candidate) {
        try {
          await this.pc.addIceCandidate(data.candidate)
        } catch (e) {
          if (!this.ignoreOffer) throw e
        }
      }
    } catch (e) {
      this.cbs.onLog?.('error', '处理信令失败', String(e))
    }
  }

  /**
   * 连接失败自动恢复：最多 2 次自动 ICE 重启（第 1 次立即、第 2 次隔 6s），
   * 两次都失败则停留 failed 态交由 UI 显式提示（tile 覆盖层 + 顶部媒体徽标），用户可手动重试。
   * restartIce 会触发 negotiationneeded 重新协商（scheduleOffer 有状态守卫防并发）。
   */
  private autoRecover() {
    if (this.closed) return
    if (this.iceRestarted >= 2) return
    this.iceRestarted++
    const attempt = this.iceRestarted
    const delay = attempt === 1 ? 300 : 6000
    this.cbs.onLog?.('warn', `连接失败，${delay}ms 后第 ${attempt} 次自动 ICE 重启…`)
    setTimeout(() => {
      if (this.closed || this.pc.connectionState !== 'failed') return
      try {
        this.pc.restartIce()
      } catch {
        /* 旧浏览器无 restartIce */
      }
    }, delay)
  }

  manualRestartIce(): void {
    this.iceRestarted = 0
    this.autoRecover()
  }

  /** 房内热切换 ICE 服务器（服务器选择）：更新 PC 配置并 ICE 重启 —— 媒体轨不断流，
   *  协商期间画面短暂冻结后自动恢复；用于「快速从一个服务器转到另一个」。
   *  setConfiguration 在部分信令状态下可能被拒（InvalidStateError）：降级为仅重启协商
   *  并如实记录，连接不中断。 */
  applyIceServers(iceServers: RTCIceServer[]): void {
    if (this.closed) return
    try {
      this.pc.setConfiguration({ iceServers })
    } catch (e) {
      this.cbs.onLog?.('warn', 'ICE 配置更新被浏览器拒绝（当前信令状态），本次仅重启协商', String(e))
    }
    try {
      this.pc.restartIce()
    } catch {
      /* 旧浏览器无 restartIce：新配置在下次协商时生效 */
    }
    this.iceRestarted = 0
  }

  /** 看门狗：停留 connecting/disconnected 超 12s → 记日志并 restartIce（计入自动重启上限） */
  private armConnectWatchdog() {
    if (this.watchdogTimer || this.closed) return
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      if (this.closed) return
      const st = this.pc.connectionState
      if (st === 'connected') return
      this.cbs.onLog?.('warn', `连接停留 ${st} 超时（12s），主动 ICE 重启提速恢复`)
      try {
        this.pc.restartIce()
      } catch { /* 旧浏览器无 restartIce */ }
    }, 12000)
  }

  private clearConnectWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /* ------------------------------ 数据通道 ------------------------------ */

  private wireDataChannel(ch: RTCDataChannel) {
    this.dc = ch
    ch.binaryType = 'arraybuffer'
    ch.bufferedAmountLowThreshold = 256 * 1024
    ch.onopen = () => {
      this.cbs.onLog?.('net', '数据通道已建立（SCTP over DTLS）', `peer=${this.remotePeerId.slice(0, 8)}`)
      this.startAppPing()
      this.cbs.onDataOpen?.()
    }
    ch.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as Record<string, unknown>
          // 应用层 ping-pong：传输层诊断消息，在业务路由之前拦截，不进入聊天/文件管线
          if (msg.t === '__ping') {
            this.sendJson({ t: '__pong', ts: msg.ts })
            return
          }
          if (msg.t === '__pong') {
            const sent = Number(msg.ts)
            if (Number.isFinite(sent)) {
              this.lastAppRttMs = Math.max(0, Math.round(performance.now() - sent))
              this.lastPongTs = Date.now()
            }
            return
          }
          this.cbs.onDataMessage?.(msg)
        } catch {
          /* 忽略非法 JSON */
        }
      } else if (ev.data instanceof ArrayBuffer) {
        this.cbs.onFileChunk?.(ev.data)
      }
    }
    ch.onerror = () => this.cbs.onLog?.('warn', '数据通道错误')
    ch.onclose = () => {
      this.stopAppPing()
      this.cbs.onLog?.('net', '数据通道关闭')
    }
  }

  /** 双端独立测量各自的端到端 RTT（3s 一次，12s 无 pong 视为失效） */
  private startAppPing() {
    this.stopAppPing()
    this.pingTimer = setInterval(() => {
      if (!this.dataOpen()) return
      this.sendJson({ t: '__ping', ts: performance.now() })
    }, APP_PING_INTERVAL_MS)
    this.sendJson({ t: '__ping', ts: performance.now() })
  }

  private stopAppPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  sendJson(msg: Record<string, unknown>): boolean {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  sendBinary(buf: ArrayBuffer): boolean {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(buf)
      return true
    }
    return false
  }

  dataOpen(): boolean {
    return !!this.dc && this.dc.readyState === 'open'
  }

  /* ------------------------------- 诊断统计 ------------------------------- */

  private startStatsLoop() {
    this.statsTimer = setInterval(() => void this.pollStats(), STATS_INTERVAL_MS)
  }

  private async pollStats() {
    if (this.closed) return
    try {
      const report = await this.pc.getStats()
      const now = Date.now()
      const dt = this.lastStatsTs ? (now - this.lastStatsTs) / 1000 : 0
      const stats: PeerStats = {
        ts: now,
        connState: this.pc.connectionState,
        iceState: this.pc.iceConnectionState,
        rttMs: null,
        appRttMs: this.lastPongTs && now - this.lastPongTs > APP_PONG_STALE_MS ? null : this.lastAppRttMs,
        outKbps: null,
        inKbps: null,
        lossPct: null,
        jitterMs: null,
        video: null,
        pair: null,
        adaptiveBitrateKbps: this.ladder[this.currentBitrateIdx],
      }
      const candidates = new Map<string, { candidateType?: string; protocol?: string }>()
      const pairs: Array<Record<string, unknown>> = []
      const codecNames = new Map<string, string>()
      let outCodecId: string | null = null
      let bytesSent = 0
      let bytesReceived = 0
      let packetsLost = 0
      let packetsRecv = 0

      // 第一遍：先收集 local/remote candidate 与字节统计（报告内条目顺序不保证）
      report.forEach((s) => {
        const r = s as unknown as Record<string, unknown>
        if (r.type === 'candidate-pair') pairs.push(r)
        if (r.type === 'codec' && typeof r.id === 'string' && typeof r.mimeType === 'string') {
          codecNames.set(r.id, r.mimeType)
        }
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
          candidates.set(String(r.id), {
            candidateType: typeof r.candidateType === 'string' ? r.candidateType : undefined,
            protocol: typeof r.protocol === 'string' ? r.protocol : undefined,
          })
        }
        if (r.type === 'outbound-rtp' && !r.isRemote) {
          if (typeof r.bytesSent === 'number') bytesSent += r.bytesSent
          if (r.kind === 'video') {
            if (typeof r.codecId === 'string') outCodecId = r.codecId
            stats.video = {
              width: typeof r.frameWidth === 'number' ? r.frameWidth : null,
              height: typeof r.frameHeight === 'number' ? r.frameHeight : null,
              fps: typeof r.framesPerSecond === 'number' ? Math.round(r.framesPerSecond) : null,
              targetKbps: typeof r.targetBitrate === 'number' ? Math.round(r.targetBitrate / 1000) : null,
              nackCount: typeof r.nackCount === 'number' ? r.nackCount : null,
              framesDecoded: null,
            }
          }
        }
        if (r.type === 'inbound-rtp' && !r.isRemote) {
          if (typeof r.bytesReceived === 'number') bytesReceived += r.bytesReceived
          if (typeof r.packetsLost === 'number') packetsLost += Math.max(0, r.packetsLost)
          if (typeof r.packetsReceived === 'number') packetsRecv += r.packetsReceived
          if (typeof r.jitter === 'number') stats.jitterMs = r.jitter * 1000
          if (r.kind === 'video' && stats.video) {
            if (typeof r.framesDecoded === 'number') stats.video.framesDecoded = r.framesDecoded
          }
        }
      })

      // 第二遍：匹配被选中的候选对
      for (const r of pairs) {
        const isNominated = r.selected === true || r.nominated === true
        if ((isNominated || r.state === 'succeeded') && typeof r.currentRoundTripTime === 'number') {
          const local = candidates.get(String(r.localCandidateId))
          const remote = candidates.get(String(r.remoteCandidateId))
          stats.pair = {
            localType: local?.candidateType || 'unknown',
            remoteType: remote?.candidateType || 'unknown',
            protocol: local?.protocol || '?',
            nominated: true,
          }
          stats.rttMs = r.currentRoundTripTime * 1000
          if (isNominated) break
        }
      }

      if (dt > 0) {
        stats.outKbps = Math.round(((bytesSent - this.lastBytesSent) * 8) / dt / 1000)
        stats.inKbps = Math.round(((bytesReceived - this.lastBytesReceived) * 8) / dt / 1000)
        const lostDelta = packetsLost - this.lastPacketsLost
        const recvDelta = packetsRecv - this.lastPacketsRecv
        if (recvDelta + lostDelta > 0) {
          stats.lossPct = Math.max(0, (lostDelta / (recvDelta + lostDelta)) * 100)
        }
      }
      this.lastBytesSent = bytesSent
      this.lastBytesReceived = bytesReceived
      this.lastPacketsLost = packetsLost
      this.lastPacketsRecv = packetsRecv
      this.lastStatsTs = now

      // 黑屏健康监测（连接后 12s 仍无解码帧 → 显式提示，帮真机定位「看得到连接却看不到画面」）
      // 【Task 37】升级为自动分诊：按入站字节流速区分「网络单向受阻」与「解码/加密异常」，
      // 不再罗列可能性 —— 数据到了解不开 vs 数据根本没到，处置路径完全不同
      if (this.pc.connectionState === 'connected') {
        if (!this.connectedAt) this.connectedAt = now
        if (!this.stallWarned && now - this.connectedAt > 12000) {
          const hasLiveRemoteVideo = this.pc
            .getReceivers()
            .some((r) => r.track.kind === 'video' && r.track.readyState === 'live')
          const decoded = stats.video?.framesDecoded ?? null
          if (hasLiveRemoteVideo && (decoded === null || decoded === 0)) {
            this.stallWarned = true
            const dataFlowing = (stats.inKbps ?? 0) > 2
            this.cbs.onLog?.(
              'warn',
              dataFlowing
                ? '远端画面迟迟未渲染（数据已到达但 12 秒仍无解码帧）'
                : '远端画面迟迟未渲染（已连接 12 秒，未收到任何媒体数据）',
              dataFlowing
                ? `入站 ≈${stats.inKbps}kbps 但无法解码 —— 多为帧加密/双端版本不匹配或解码器异常；重同步已自动进行（画面停滞自愈环），若持续黑屏请双端刷新页面`
                : '媒体包完全未到达 —— ① 对端摄像头可能被系统暂停（iPadOS 共享/切后台会挂起采集）；② 网络单向受阻：同一 Wi-Fi 检查对端设备，跨网络需自建 TURN 中继（见部署文档）；自愈环会持续请求重同步与 ICE 重启',
            )
          }
        }
      } else {
        this.connectedAt = 0
      }

      this.adaptBitrate(stats)
      this.detectInboundStall(stats, now)
      this.cbs.onStats?.(stats)
      // 实际协商编解码一次性落账（硬编优先是否生效，看这条日志即可验证）
      if (!this.codecLogged && outCodecId && codecNames.has(outCodecId) && (stats.video?.fps ?? 0) > 0) {
        this.codecLogged = true
        this.cbs.onLog?.('net', `视频编解码已协商：${codecNames.get(outCodecId)}`, '硬编优先策略已生效（H264 > VP9 > VP8 > AV1；不支持时回退默认顺序）')
      }
    } catch {
      /* getStats 失败可忽略 */
    }
  }

  /** 弱网自适应：高丢包/高 RTT/码率饿死时快速逐级降码率，网络稳定 30s 后逐级回升（梯队随档位缩放） */
  private adaptBitrate(stats: PeerStats) {
    if (!this.pc.getSenders().some((s) => s.track?.kind === 'video')) return
    const now = Date.now()
    // 共享期降档更保守（共享需要高吞吐才能不糊不卡），但比旧版更早介入：
    // 旧版等丢包 8%/RTT 420ms 才动作，此时链路队列早已胀满 —— 用户体感就是「很卡」
    const lossGate = this.sharingActive ? SHARE_LOSS_DOWNGRADE_PCT : LOSS_DOWNGRADE_PCT
    const rttGate = this.sharingActive ? SHARE_RTT_DOWNGRADE_MS : RTT_DOWNGRADE_MS
    const coolMs = this.sharingActive ? SHARE_DOWNGRADE_COOLDOWN_MS : DOWNGRADE_COOLDOWN_MS
    const bad = (stats.lossPct ?? 0) > lossGate || (stats.rttMs ?? 0) > rttGate
    if (bad && now - this.lastAdaptiveTs > coolMs && this.currentBitrateIdx < this.ladder.length - 1) {
      this.currentBitrateIdx++
      this.lastAdaptiveTs = now
      this.starveStreak = 0
      void this.setVideoMaxBitrate(this.ladder[this.currentBitrateIdx])
      this.cbs.onAdaptiveChange?.(this.ladder[this.currentBitrateIdx])
    } else if (
      !bad &&
      (stats.lossPct ?? 0) < 1.5 &&
      (stats.rttMs ?? 0) < 180 &&
      now - this.lastAdaptiveTs > UPGRADE_AFTER_MS &&
      this.currentBitrateIdx > 0
    ) {
      // 升档加门槛：链路要真能把当前目标送出去（否则升上去马上又饱和振荡）
      const target = stats.video?.targetKbps ?? null
      const delivering = target == null || target < 300 || (stats.outKbps ?? 0) >= target * 0.8
      if (delivering) {
        this.currentBitrateIdx--
        this.lastAdaptiveTs = now
        void this.setVideoMaxBitrate(this.ladder[this.currentBitrateIdx])
        this.cbs.onAdaptiveChange?.(this.ladder[this.currentBitrateIdx])
      }
    }
    // 饿死检测（Task 32，诊断日志 only）：out << target 有两种成因 —— 链路拥堵
    // （此时 RTT/丢包门槛已能兜住）或 静态画面/低帧源（合法低发送）。实测健康
    // headless 链路也会触发（强降档造成误伤：700→434kbps），故不做强制降档，
    // 仅节流落账供诊断面板观察。
    const target = stats.video?.targetKbps ?? null
    const out = stats.outKbps ?? null
    if (target != null && target > 300 && out != null && out < target * STARVE_RATIO) {
      this.starveStreak++
      if (this.starveStreak === STARVE_STREAK && now - this.lastAdaptiveTs > 30000) {
        this.lastAdaptiveTs = now
        this.cbs.onLog?.('net', `发送吞吐低于编码目标（目标 ${target}kbps 实发 ${out}kbps）`, '若同时伴随延迟升高，系统会按弱网策略自动降档；静态画面属正常现象')
      }
    } else if (out != null && target != null && out >= target * STARVE_RATIO) {
      this.starveStreak = 0
    }
    // 延迟模式（Task 30）：持续高 RTT → 压帧率降带宽/解码压力；恢复低延迟 → 解除。
    // 共享期不启用（共享已有独立宽阈值 + maintain-framerate，压帧率会直接卡成幻灯片）
    const rtt = stats.rttMs ?? 0
    if (!this.sharingActive) {
      if (rtt > 350) {
        this.highRttStreak++
        this.lowRttStreak = 0
      } else if (rtt < 160) {
        this.lowRttStreak++
        this.highRttStreak = 0
      }
      if (!this.fpsCapped && this.highRttStreak >= 3) {
        this.fpsCapped = true
        this.cbs.onLog?.('net', '网络延迟持续偏高，已临时降低发送帧率（恢复低延迟后自动解除）')
        void this.setVideoMaxFramerate(20)
      } else if (this.fpsCapped && this.lowRttStreak >= 5) {
        this.fpsCapped = false
        this.highRttStreak = 0
        this.lowRttStreak = 0
        this.cbs.onLog?.('net', '网络延迟已恢复，解除帧率限制')
        void this.setVideoMaxFramerate(null)
      }
    }
    // 低帧率诚实告警（Task 32「4K60 帧率还是很低」）：网络不差但 fps 长期偏低 →
    // 设备编码能力/本地处理管线跟不上当前档位，一次性提示降档或关闭虚拟背景/增强
    const fps = stats.video?.fps ?? null
    if (!this.sharingActive && this.tier !== '360p' && fps != null && rtt < 120) {
      if (fps < LOW_FPS_THRESHOLD) {
        this.lowFpsStreak++
        if (this.lowFpsStreak >= LOW_FPS_STREAK && !this.lowFpsWarned) {
          this.lowFpsWarned = true
          this.cbs.onLog?.(
            'warn',
            `当前档位 ${this.tier} 实际帧率仅 ${fps}fps（网络正常）`,
            '设备编码能力或本地 AI 处理跟不上：建议在「设备」里降低画质档位，或关闭虚拟背景/画面增强后再试',
          )
        }
      } else if (fps >= LOW_FPS_THRESHOLD + 6) {
        this.lowFpsStreak = 0
      }
    }
  }

  /**
   * 入站视频帧停滞检测（Task 30 共享自愈环触发源）：已连接且存在远端视频轨，
   * framesDecoded 连续 6s 无增长 → 通知上层（room-client 发 t:'share-resync' 请求
   * 发送端重发画面，12s 节流）。旋转/系统抢占/replaceTrack 静默失败等场景自愈。
   */
  private detectInboundStall(stats: PeerStats, now: number) {
    if (this.pc.connectionState !== 'connected') {
      this.lastInFrames = -1
      return
    }
    const hasRemoteVideo = this.pc.getReceivers().some((r) => r.track.kind === 'video' && r.track.readyState === 'live')
    if (!hasRemoteVideo) return
    const decoded = stats.video?.framesDecoded ?? null
    if (decoded == null) return
    if (decoded !== this.lastInFrames) {
      this.lastInFrames = decoded
      this.lastInFramesChangeTs = now
      this.stallEscalations = 0 // 【Task 35】帧恢复流动 → 停滞升级计数归零
      return
    }
    if (this.lastInFramesChangeTs === 0) {
      this.lastInFramesChangeTs = now
      return
    }
    if (now - this.lastInFramesChangeTs > 6000 && now - this.lastStallNotifyTs > 12000) {
      this.lastStallNotifyTs = now
      this.stallEscalations++
      // 【Task 35】三次重同步仍黑 → 链路大概率单向死亡（连接态却是 connected），
      // ICE 重启重建：新候选+新流+新关键帧，完美协商保证两端状态收敛
      if (this.stallEscalations >= 3) {
        this.stallEscalations = 0
        this.lastInFramesChangeTs = now
        this.cbs.onLog?.('warn', '多次重同步画面仍停滞，正在重启 ICE 链路自愈…', '重同步 ×3 无效；若重启后仍黑，需自建 TURN（见部署文档）')
        try { this.pc.restartIce() } catch { /* noop */ }
        void this.scheduleOffer()
        return
      }
      this.cbs.onLog?.('warn', '远端视频帧停滞（6s 无新帧），已请求对端重同步')
      this.cbs.onInboundStall?.()
    }
  }

  close() {
    this.closed = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.stopAppPing()
    this.clearConnectWatchdog()
    // 清理 worker 内的管线上下文（轮换种子与派生密钥随之释放）
    for (const p of [
      `${this.remoteSocketId}:send:video`,
      `${this.remoteSocketId}:send:audio`,
      `${this.remoteSocketId}:recv:video`,
      `${this.remoteSocketId}:recv:audio`,
    ]) {
      e2eeManager.dropPipe(p)
    }
    try {
      this.dc?.close()
    } catch {
      /* noop */
    }
    try {
      this.pc.close()
    } catch {
      /* noop */
    }
  }
}
