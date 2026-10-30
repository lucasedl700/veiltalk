/**
 * VeilTalk WebRTC 核心类型定义
 * 模块职责：为信令、密钥协商、文件传输、诊断提供统一的结构化类型。
 */

/** 信令服务器返回的房间成员摘要（pubkey = 对端 ECDH 公钥 JSON，公钥可公开） */
export interface PeerBrief {
  socketId: string
  peerId: string
  name: string
  fingerprint: string
  pubkey?: string
  /** 自定义头像（96px JPEG dataURL；信令透传，仅房间内展示） */
  avatar?: string
  /** 帧级加密能力（pubkey JSON 内捎带，信令不感知）：none = 不支持 insertable streams（如 Safari） */
  cap?: 'encoded-streams' | 'script-transform' | 'none'
  joinedTs: number
}

/** 信令通道中继的载荷（服务器只透传，不理解内容） */
export interface SignalData {
  description?: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp: string }
  candidate?: RTCIceCandidateInit
}

/** 主线程使用的会话密钥（文件/聊天加解密；媒体帧密钥以原始字节交给 worker） */
export interface SessionKeys {
  fileOut: CryptoKey
  fileIn: CryptoKey
  chatOut: CryptoKey
  chatIn: CryptoKey
}

/**
 * 8 把方向隔离的原始密钥材料（HKDF 派生，供 worker / importKey 使用）。
 * 其中 video 与 audio 四把为「媒体帧轮换种子」：worker 内以 HKDF(seed, "veiltalk:epoch:N")
 * 逐 epoch 派生帧密钥（见 e2ee.worker.ts）；
 * file 与 chat 四把为「DC 轮换种子」：dc-ratchet.ts 内以 HKDF(seed, "veiltalk:dc-epoch:N")
 * 逐 epoch 派生聊天/文件帧密钥（P0-2 前向保密简化版，DataChannel 部分不再静态）。
 */
export interface RawKeySet {
  /** 本端→对端视频帧轮换种子 */
  videoOut: ArrayBuffer
  /** 对端→本端视频帧轮换种子 */
  videoIn: ArrayBuffer
  /** 本端→对端音频帧轮换种子 */
  audioOut: ArrayBuffer
  /** 对端→本端音频帧轮换种子 */
  audioIn: ArrayBuffer
  fileOut: ArrayBuffer
  fileIn: ArrayBuffer
  chatOut: ArrayBuffer
  chatIn: ArrayBuffer
}

/** E2EE 实现路径 */
export type E2EEMode = 'encoded-streams' | 'script-transform' | 'unsupported'

/** 媒体帧加密统计（worker 上报；rotations=密钥轮换次数，epoch=最新纪元号） */
export interface E2EEStats {
  encrypted: number
  decrypted: number
  dropped: number
  bytes: number
  rotations: number
  epoch: number
}

/** 单个远端节点的实时诊断指标 */
export interface PeerStats {
  ts: number
  connState: RTCPeerConnectionState
  iceState: RTCIceConnectionState
  rttMs: number | null
  /** DataChannel 应用层 ping-pong RTT（区分网络路径 RTT 与端到端处理时延） */
  appRttMs: number | null
  outKbps: number | null
  inKbps: number | null
  lossPct: number | null
  jitterMs: number | null
  video: {
    width: number | null
    height: number | null
    fps: number | null
    targetKbps: number | null
    nackCount: number | null
    framesDecoded: number | null
  } | null
  pair: {
    localType: string
    remoteType: string
    protocol: string
    nominated: boolean
  } | null
  adaptiveBitrateKbps: number | null
}

/** 文件传输状态（paused 仅存在于发送端主动暂停期间，双端协议同步） */
export interface TransferState {
  id: string
  direction: 'send' | 'recv'
  peerName: string
  name: string
  size: number
  mime: string
  received: number
  chunks: number
  receivedChunks: number
  speedBps: number
  startedTs: number
  status: 'pending' | 'transferring' | 'paused' | 'done' | 'failed' | 'cancelled' | 'verifying'
  digestOk?: boolean
  digest?: string
  error?: string
  downloadUrl?: string
  /** 断点续传（P1-6）：发送端失败可「续传」重试；接收端失败/取消保留本地暂存 */
  resumable?: boolean
  /** 本次传输从多少字节断点处继续（0 = 从头传） */
  resumedFrom?: number
  /** 对端显式回执（F-33 file-ack）：接收端重组校验后回发，ok=对端 SHA-256 校验通过；
   *  未定义 = 尚未收到回执（对端为旧版本或传输进行中）。回执走同一加密 DataChannel。 */
  ack?: 'ok' | 'fail'
}

/** 端到端加密聊天消息（system=true 为房间事件提示，不可撤回、无密文） */
export interface ChatEntry {
  id: string
  from: string
  name: string
  ts: number
  text: string
  mine: boolean
  verified?: boolean
  /** 已被发送者撤回（本地与对端同步标记，内容不可再读） */
  recalled?: boolean
  /** 系统提示（加入/离开等房间事件，居中弱化展示） */
  system?: boolean
  /** 私信标记：dmSocketId = 会话对象 socketId（群聊消息无此字段） */
  dmSocketId?: string
  /** 私信对方展示名（本地回显用，防 socketId 漂移后无法取名） */
  dmName?: string
  /** 表情回应聚合：emoji → 计数（含自己；经 DataChannel 控制信令同步） */
  reactions?: Record<string, number>
  /** 自己已点亮的表情集合（再次点击 = 取消） */
  myReactions?: string[]
}

/** 客户端事件日志（浏览器侧环形缓冲） */
export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'crypto' | 'net'
  msg: string
  detail?: string
}

/** 服务器元数据台账条目 */
export interface LedgerEntry {
  ts: string
  event: string
  [key: string]: unknown
}

/** 自检结果 */
export interface SelfTestResult {
  name: string
  ok: boolean
  detail: string
  ms: number
}

/** 信令服务器 join-room 的 ack */
export interface JoinRoomAck {
  ok: boolean
  error?: string
  /** 结构化错误码（如 ROOM_LOCKED，供 UI 精确提示） */
  code?: string
  self?: { socketId: string; peerId: string; roomId: string }
  peers?: PeerBrief[]
  /** 房间治理状态：锁定标志与房主 socketId（信令权威） */
  locked?: boolean
  hostSocketId?: string | null
  serverTs?: number
}
