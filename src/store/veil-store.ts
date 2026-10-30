/**
 * VeilTalk 全局状态（zustand）
 * 模块职责：客户端状态唯一事实源 —— 房间/成员/媒体/传输/聊天/日志/台账。
 * 组件只读写 store；WebRTC 编排细节在 lib/webrtc（RoomClient）。
 */

import { create } from 'zustand'
import { LANG_STORAGE_KEY, langToBcp47, pageTitle } from '@/lib/i18n'
import type { Lang } from '@/lib/i18n'
import type {
  ChatEntry,
  E2EEStats,
  LedgerEntry,
  LogEntry,
  PeerBrief,
  PeerStats,
  TransferState,
} from '@/lib/webrtc/types'
import type { SignalingState } from '@/lib/webrtc/room-client'
import type { QualityTier } from '@/lib/webrtc/tiers'
import { resolveTier } from '@/lib/webrtc/tiers'

export type Phase = 'lobby' | 'joining' | 'in-room'

export interface PeerUI extends PeerBrief {
  connState: RTCPeerConnectionState | 'connecting'
  stats: PeerStats | null
  /** 网络质量历史（诊断波形图用，最多 60 个采样点） */
  history: Array<{ t: number; rtt: number | null; appRtt: number | null; loss: number | null; inKbps: number | null; outKbps: number | null }>
  stream: MediaStream | null
  safety: string
  e2ee: { video: string; audio: string }
  /** 接收方向帧加密模式（与发送分开，BUG-16 后新增；pending=尚未收到对端轨） */
  e2eeRecv: { video: string; audio: string }
  /** PAKE（SPAKE2）口令认证状态：设置口令时自动互验；off = 未设口令 */
  pake?: 'pending' | 'verified' | 'failed' | 'off'
  /** 对端屏幕共享中（控制面 t:'share' 布尔信号；聚焦布局与徽标用） */
  sharing?: boolean
  /** 自定义头像（96px JPEG dataURL；信令随 join 摘要下发） */
  avatar?: string
  /** 对端麦克风状态（控制面 t:'media-state' 同步；undefined = 未知，旧版本对端） */
  micOn?: boolean
  /** 对端摄像头状态（控制面同步；false 时 tile 显示头像+已关闭摄像头） */
  camOn?: boolean
  /** 对端正在说话（控制面 t:'speaking' 广播；发送端 AGC 归一化后判定，多端一致且省每个远端 tile 的 AudioContext） */
  speaking?: boolean
}

interface VeilState {
  /* 连接与房间 */
  phase: Phase
  signaling: SignalingState
  /**
   * ICE 服务器可达性探测结果（入房后主动探测一次）：
   *  - relay：TURN 中继可用（跨网络兜底最强）
   *  - srflx：STUN 可达（可打洞，对称 NAT 仍可能失败）
   *  - none：配置了服务器但候选收集为空 / 未配置任何 STUN
   *  - timeout：探测超时（公网 STUN 常见：网络阻断/防火墙），跨网络直连大概率失败
   *  - null：尚未探测
   */
  iceProbe: { result: 'relay' | 'srflx' | 'none' | 'timeout' | null; at: number }
  /** 摄像头画质偏好（360p→4K60 档位；applyConstraints 热切换，localStorage 记忆） */
  qualityPref: QualityTier
  /** 管理员全局默认画质档（信令 /svc/config 下发；本机个人偏好优先） */
  serverDefaultQuality: string | null
  roomId: string
  passphrase: string
  /** 口令是否包含在邀请链接的 # 片段中（hash 不经服务器） */
  passInLink: boolean
  /** 本次会话是否设置了口令（决定 PAKE 展示语义：verified/off） */
  pakeEnabled: boolean
  /** 应用层端到端加密开关（媒体帧 + 聊天/文件分块；关闭后与对端协商降级为 DTLS-SRTP 传输加密；localStorage veil-e2ee 记忆，默认开） */
  e2eeEnabled: boolean
  socketId: string
  selfPeerId: string
  e2eeMode: string
  joinedTs: number

  /* 身份 */
  myFingerprint: string
  myName: string
  /** 我的自定义头像（96px JPEG dataURL；localStorage veil-avatar，tile/成员/私信共用） */
  myAvatar: string

  /* 媒体 */
  localStream: MediaStream | null
  /** 音频输出设备（扬声器/蓝牙耳机，Chrome setSinkId；localStorage veil-audio-output 记忆） */
  audioOutputId: string
  /** 【Task 36】本地加工预览流：虚拟背景/AI 增强/补帧开启时，本地画面也显示加工后效果
   *  （原实现加工轨只进发送端，用户自己看不到任何效果 →「虚拟背景没用」主因）；null = 无加工 */
  localPreviewStream: MediaStream | null
  /** 【Task 36】合成补帧（倍频平滑）开关记忆 */
  interpOn: boolean
  /** 屏幕共享流（本地预览用；远端看到的视频轨已 replaceTrack） */
  screenStream: MediaStream | null
  screenSharing: boolean
  micOn: boolean
  camOn: boolean
  devices: MediaDeviceInfo[]
  mediaError: string | null

  /* 成员 */
  peers: Record<string, PeerUI>

  /* 数据 */
  chats: ChatEntry[]
  transfers: Record<string, TransferState>
  e2eeStats: E2EEStats
  /** DataChannel 轮换纪元（聊天/文件链；手动/自动轮换后递增，诊断面板展示） */
  dcEpoch: number
  /** 聊天未读数：非本人/非系统消息且当前不在聊天页时累计，切到聊天页清零 */
  unreadChats: number
  /** 对端输入中指示：socketId → 最近一次 typing 事件时间戳（UI 侧 4s 过期） */
  typingPeers: Record<string, { name: string; ts: number }>
  /** 待处理的静音/关摄像头请求（成员治理）：socketId → 请求详情（UI 警示条展示） */
  muteRequests: Record<string, { name: string; kind: 'audio' | 'video'; ts: number }>
  /** 加入申请已提交、等待房主批准（人工审核等候室；UI 等待卡） */
  admissionPending: boolean
  /** 房主端待处理的加入申请（人工审核）：socketId → 申请人（UI 审批横幅） */
  admissionRequests: Record<string, { name: string; ts: number }>
  /** 指纹互核结果（2026-10）：socketId → { ok, at, mine } —— mine=true 本端发起的核实，
   *  mine=false 对端发起并已自动回发（对端核实了我）。ok=false = 对端声称指纹与信令公钥
  推出的真实指纹不一致（潜在中间人），UI 红色告警 */
  peerVerified: Record<string, { ok: boolean; at: number; mine: boolean }>
  /** 指纹互核进行中（本端已发出请求等待回发）：socketId → 发起时间戳 */
  verifyPending: Record<string, number>
  /** 对端实测「看到的你的画面」（quality-report 回传）：socketId → 最近一次实测 */
  peerSeen: Record<string, { w: number; h: number; fps: number; rtt: number | null; at: number }>
  setPeerVerified: (socketId: string, v: { ok: boolean; at: number; mine: boolean }) => void
  setVerifyPending: (socketId: string, ts: number | null) => void
  setPeerSeen: (socketId: string, q: { w: number; h: number; fps: number; rtt: number | null }) => void
  /** 屏幕共享画面手动旋转（Task 30「人手自己旋转」）：tile 键（'__local__'/socketId）→ 0/90/180/270 */
  shareRotations: Record<string, number>
  /** 旋转共享画面（delta=±90；存 0~270） */
  rotateShare: (key: string, delta: number) => void
  /** 房主端：登记/清除加入申请（同 socketId 重复事件幂等刷新） */
  addAdmissionRequest: (socketId: string, name: string) => void
  dismissAdmissionRequest: (socketId: string) => void
  /** 管理员身份已解锁（admin-view 密码验证后置位；会话级，决定诊断/加密/台账等入口可见性） */
  adminUnlocked: boolean
  /** 当前私信对象 socketId；null = 群聊 */
  activeDm: string | null
  /** 私信未读：socketId → 计数 */
  dmUnread: Record<string, number>
  /** AI 画面增强（自动曝光）：localStorage veil-enhance 记忆 */
  enhanceOn: boolean
  /** 增强强度（目标亮度 0.45~0.75；localStorage veil-enhance-level） */
  enhanceLevel: number
  /** 屏幕共享画质档（auto=交系统；localStorage veil-share-tier） */
  shareTier: 'auto' | '1080p60' | '4k60' | '8k144'
  /** 虚拟背景模式（Zoom 化）：off/blur/color/image；localStorage veil-vbg-mode 记忆 */
  vbgMode: 'off' | 'blur' | 'color' | 'image'
  /** 虚拟背景：blur 模糊半径（4~28） */
  vbgBlur: number
  /** 虚拟背景：color 模式背景色 */
  vbgColor: string
  /** 虚拟背景：自定义图片 dataURL（≤720p JPEG，≤1.5MB；localStorage veil-vbg-image） */
  vbgImage: string | null
  /** 虚拟背景：内置渐变预设（未上传图时 image 模式生效） */
  vbgGradient: 'dusk' | 'ocean' | 'mint'
  /** 虚拟背景模型加载状态（UI 状态行） */
  vbgStatus: 'idle' | 'loading' | 'ready' | 'failed'
  /** 分割退化中（掩码持续异常 → 效果临时停用、原始画面直出；UI 琥珀提示） */
  vbgDegraded: boolean

  /* 录制 */
  /** 本地混合录制进行中（MediaRecorder，内容不出设备） */
  recording: boolean
  /** 已录制时长（ms）与已缓冲字节（展示用） */
  recordingMs: number
  recordingBytes: number

  /* 房间治理（信令权威同步） */
  /** 房间是否被房主锁定（锁定后新成员加入被拒绝） */
  roomLocked: boolean
  /** 房主 socketId（等于 socketId 即本端为房主，拥有踢人/锁定权限） */
  hostSocketId: string | null

  /* 舞台布局 */
  /** 舞台布局模式：grid 网格 / spotlight 聚焦（主画面 + 缩略条，localStorage 记忆） */
  stageLayout: 'grid' | 'spotlight'

  /* Zoom 化套件（F-40~F-45） */
  /** 会议级 Emoji 反应浮层（F-41）：双端推送，UI 侧动画结束后移除；本地发送 mine=true 立即上屏 */
  reactions: Array<{ id: string; name: string; emoji: string; mine: boolean; socketId: string; ts: number }>
  pushReaction: (r: { id: string; name: string; emoji: string; mine: boolean; socketId: string; ts: number }) => void
  /** 浮层动画结束/超时后移除（防止长会话累积） */
  dropReaction: (id: string) => void
  /** 举手状态（F-42）：socketId 或 '__local__' → 举手时间戳；放下/离房即清除 */
  raisedHands: Record<string, { name: string; ts: number }>
  setRaisedHand: (key: string, name: string, up: boolean) => void
  /** 活跃说话人（F-40）：各 tile 低频上报，spotlight 未钉选时主画面自动跟随；null = 无人说话 */
  activeSpeaker: string | null
  setActiveSpeaker: (key: string | null) => void
  /** 本地画面镜像（F-45）：localStorage veil-mirror 记忆，默认开（与主流会议软件一致） */
  mirrorSelf: boolean

  /* 界面语言（F-34 i18n） */
  /** 界面语言：zh 中文（默认）/ en 英文；URL ?lang= 优先于 localStorage（LangBoot 引导） */
  lang: Lang
  /** 切换语言并持久化（同时同步 <html lang> 与 document.title） */
  setLang: (lang: Lang) => void

  /* 日志与台账 */
  logs: LogEntry[]
  ledger: LedgerEntry[]
  ledgerLoading: boolean
  ledgerDate: string
  ledgerDates: string[]

  /* UI */
  activeTab: string
  panelOpen: boolean
  showShortcuts: boolean
  showMembers: boolean
  selfTestRunning: boolean
  selfTestResults: import('@/lib/webrtc/types').SelfTestResult[]
  /** PWA 安装提示是否可用（beforeinstallprompt 已捕获） */
  installReady: boolean
  /** PWA 已处于独立窗口（standalone）运行：隐藏安装入口（F-38） */
  pwaStandalone: boolean
  /** 平台类：ios = iOS/iPadOS Safari（无 beforeinstallprompt，展示「添加到主屏幕」引导）；
   *  unknown = 尚未在客户端探测（SSR）；other = 其余桌面/安卓浏览器（F-38） */
  pwaPlatform: 'unknown' | 'ios' | 'other'

  /* actions */
  set: <K extends keyof VeilState>(patch: Pick<VeilState, K> | Partial<VeilState>) => void
  pushLog: (level: LogEntry['level'], msg: string, detail?: string) => void
  upsertPeer: (socketId: string, patch: Partial<PeerUI>) => void
  removePeer: (socketId: string) => void
  upsertTransfer: (t: TransferState) => void
  /** 对端显式回执（F-33 file-ack）：按传输 id 标记 ack 结果；未知 id（刷新后旧回执）静默忽略 */
  markTransferAck: (id: string, ok: boolean) => void
  pushChat: (c: ChatEntry) => void
  /** 按消息 id 标记撤回（找不到或已撤回时静默忽略） */
  recallChat: (id: string) => void
  /** 表情回应同步（本地与对端共用；mine=true 时维护 myReactions） */
  applyReaction: (id: string, emoji: string, on: boolean, mine: boolean) => void
  setTypingPeer: (socketId: string, name: string, on: boolean) => void
  /** 记录/清除静音请求 */
  addMuteRequest: (socketId: string, name: string, kind: 'audio' | 'video') => void
  dismissMuteRequest: (socketId: string) => void
  /** 打开私信会话（清理该对象未读） */
  openDm: (socketId: string) => void
  /** 关闭私信回到群聊 */
  closeDm: () => void
  /** 仅清空聊天记录（保留传输/成员/媒体等，比 clearSensitive 温和） */
  clearChats: () => void
  clearSensitive: () => void
}

const LOG_LIMIT = 400

export const useVeil = create<VeilState>((set, get) => ({
  phase: 'lobby',
  signaling: 'idle',
  iceProbe: { result: null, at: 0 },
  qualityPref: typeof window !== 'undefined' ? resolveTier(null).tier : '720p',
  serverDefaultQuality: null,
  roomId: '',
  passphrase: '',
  passInLink: false,
  pakeEnabled: false,
  e2eeEnabled: typeof window !== 'undefined' ? localStorage.getItem('veil-e2ee') !== '0' : true,
  socketId: '',
  selfPeerId: '',
  e2eeMode: 'unknown',
  joinedTs: 0,

  myFingerprint: '',
  myName: '',
  myAvatar: typeof window !== 'undefined' ? localStorage.getItem('veil-avatar') || '' : '',

  localStream: null,
  audioOutputId: typeof window !== 'undefined' ? localStorage.getItem('veil-audio-output') || '' : '',
  localPreviewStream: null,
  interpOn: typeof window !== 'undefined' ? localStorage.getItem('veil-interp') === '1' : false,
  screenStream: null,
  screenSharing: false,
  micOn: true,
  camOn: true,
  devices: [],
  mediaError: null,

  peers: {},

  chats: [],
  transfers: {},
  e2eeStats: { encrypted: 0, decrypted: 0, dropped: 0, bytes: 0, rotations: 0, epoch: 0 },
  dcEpoch: 0,
  unreadChats: 0,
  typingPeers: {},
  muteRequests: {},
  admissionPending: false,
  admissionRequests: {},
  peerVerified: {},
  verifyPending: {},
  peerSeen: {},
  shareRotations: {},
  adminUnlocked: false,
  activeDm: null,
  dmUnread: {},
  enhanceOn: typeof window !== 'undefined' ? localStorage.getItem('veil-enhance') === '1' : false,
  enhanceLevel: typeof window !== 'undefined' ? Number(localStorage.getItem('veil-enhance-level')) || 0.58 : 0.58,
  shareTier: (typeof window !== 'undefined' && ['1080p60', '4k60', '8k144'].includes(localStorage.getItem('veil-share-tier') || '') ? localStorage.getItem('veil-share-tier') : 'auto') as 'auto' | '1080p60' | '4k60' | '8k144',
  vbgMode: (typeof window !== 'undefined' && ['blur', 'color', 'image'].includes(localStorage.getItem('veil-vbg-mode') || '') ? localStorage.getItem('veil-vbg-mode') : 'off') as 'off' | 'blur' | 'color' | 'image',
  vbgBlur: typeof window !== 'undefined' ? Math.min(28, Math.max(4, Number(localStorage.getItem('veil-vbg-blur')) || 12)) : 12,
  vbgColor: typeof window !== 'undefined' ? localStorage.getItem('veil-vbg-color') || '#14532d' : '#14532d',
  vbgImage: typeof window !== 'undefined' ? localStorage.getItem('veil-vbg-image') || null : null,
  vbgGradient: (typeof window !== 'undefined' && ['ocean', 'mint'].includes(localStorage.getItem('veil-vbg-gradient') || '') ? localStorage.getItem('veil-vbg-gradient') : 'dusk') as 'dusk' | 'ocean' | 'mint',
  vbgStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  vbgDegraded: false,

  recording: false,
  recordingMs: 0,
  recordingBytes: 0,

  roomLocked: false,
  hostSocketId: null,
  stageLayout: typeof window !== 'undefined' && localStorage.getItem('veil-stage-layout') === 'spotlight' ? 'spotlight' : 'grid',

  reactions: [],
  raisedHands: {},
  activeSpeaker: null,
  mirrorSelf: typeof window !== 'undefined' ? localStorage.getItem('veil-mirror') !== 'false' : true,

  logs: [],
  ledger: [],
  ledgerLoading: false,
  ledgerDate: '',
  ledgerDates: [],

  activeTab: 'files',
  panelOpen: true,
  showShortcuts: false,
  showMembers: false,
  selfTestRunning: false,
  selfTestResults: [],
  installReady: false,
  pwaStandalone: false,
  pwaPlatform: 'unknown',
  lang: 'zh',

  set: (patch) => set(patch),

  setLang: (lang) => {
    if (get().lang === lang) {
      // 同值也要同步 html 属性（首次 LangBoot 引导时 store 已是 zh 但 DOM 可能未设）
      if (typeof document !== 'undefined') {
        document.documentElement.lang = langToBcp47(lang)
        document.title = pageTitle(lang)
      }
      return
    }
    localStorage.setItem(LANG_STORAGE_KEY, lang)
    set({ lang })
    if (typeof document !== 'undefined') {
      document.documentElement.lang = langToBcp47(lang)
      document.title = pageTitle(lang)
    }
  },

  pushLog: (level, msg, detail) =>
    set((s) => ({
      logs: [...s.logs, { ts: Date.now(), level, msg, detail }].slice(-LOG_LIMIT),
    })),

  upsertPeer: (socketId, patch) =>
    set((s) => {
      const prev: PeerUI = s.peers[socketId] || {
        socketId,
        peerId: '',
        name: '',
        fingerprint: '',
        joinedTs: Date.now(),
        connState: 'connecting',
        stats: null,
        history: [],
        stream: null,
        safety: '',
        e2ee: { video: 'pending', audio: 'pending' },
        e2eeRecv: { video: 'pending', audio: 'pending' },
        pake: 'pending',
      }
      return { peers: { ...s.peers, [socketId]: { ...prev, ...patch } } }
    }),

  removePeer: (socketId) =>
    set((s) => {
      const peers = { ...s.peers }
      delete peers[socketId]
      return { peers }
    }),

  upsertTransfer: (t) =>
    set((s) => ({ transfers: { ...s.transfers, [t.id]: { ...(s.transfers[t.id] || {}), ...t } } })),

  markTransferAck: (id, ok) =>
    set((s) => {
      const cur = s.transfers[id]
      if (!cur) return {}
      return { transfers: { ...s.transfers, [id]: { ...cur, ack: ok ? ('ok' as const) : ('fail' as const) } } }
    }),

  pushChat: (c) =>
    set((s) => {
      // 未读计数：对端真实消息且用户当前不在聊天页时累计（系统提示不计）；
      // 私信单独计数（正在看同一个私信会话时不计）
      const inChatTab = s.activeTab === 'chat' && s.phase === 'in-room'
      const dmHit = !!c.dmSocketId && !c.mine
      const bumpUnread = !c.system && !c.mine && s.phase === 'in-room' && (!inChatTab || (dmHit && s.activeDm !== c.dmSocketId))
      const dmUnread = bumpUnread && dmHit
        ? { ...s.dmUnread, [c.dmSocketId as string]: (s.dmUnread[c.dmSocketId as string] || 0) + 1 }
        : s.dmUnread
      return {
        chats: [...s.chats, c].slice(-300),
        unreadChats: bumpUnread ? s.unreadChats + 1 : s.unreadChats,
        dmUnread,
      }
    }),

  recallChat: (id) =>
    set((s) => {
      if (!s.chats.some((c) => c.id === id && !c.recalled)) return {}
      return { chats: s.chats.map((c) => (c.id === id ? { ...c, recalled: true } : c)) }
    }),

  applyReaction: (id, emoji, on, mine) =>
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== id) return c
        const cur = c.reactions?.[emoji] || 0
        const next = Math.max(0, cur + (on ? 1 : -1))
        const reactions = { ...(c.reactions || {}) }
        if (next <= 0) delete reactions[emoji]
        else reactions[emoji] = next
        let myReactions = c.myReactions || []
        if (mine) {
          myReactions = on
            ? [...new Set([...myReactions, emoji])]
            : myReactions.filter((e) => e !== emoji)
        }
        return { ...c, reactions, myReactions }
      }),
    })),

  addMuteRequest: (socketId, name, kind) =>
    set((s) => ({ muteRequests: { ...s.muteRequests, [socketId]: { name, kind, ts: Date.now() } } })),

  dismissMuteRequest: (socketId) =>
    set((s) => {
      const next = { ...s.muteRequests }
      delete next[socketId]
      return { muteRequests: next }
    }),

  rotateShare: (key, delta) =>
    set((s) => {
      const cur = s.shareRotations[key] || 0
      const next = (((cur + delta) % 360) + 360) % 360
      return { shareRotations: { ...s.shareRotations, [key]: next } }
    }),

  addAdmissionRequest: (socketId, name) =>
    set((s) => ({ admissionRequests: { ...s.admissionRequests, [socketId]: { name, ts: Date.now() } } })),

  dismissAdmissionRequest: (socketId) =>
    set((s) => {
      if (!s.admissionRequests[socketId]) return {}
      const next = { ...s.admissionRequests }
      delete next[socketId]
      return { admissionRequests: next }
    }),

  setPeerVerified: (socketId, v) =>
    set((s) => {
      const verifyPending = { ...s.verifyPending }
      delete verifyPending[socketId]
      return { peerVerified: { ...s.peerVerified, [socketId]: v }, verifyPending }
    }),

  setVerifyPending: (socketId, ts) =>
    set((s) => {
      const verifyPending = { ...s.verifyPending }
      if (ts === null) delete verifyPending[socketId]
      else verifyPending[socketId] = ts
      return { verifyPending }
    }),

  setPeerSeen: (socketId, q) =>
    set((s) => ({ peerSeen: { ...s.peerSeen, [socketId]: { ...q, at: Date.now() } } })),

  openDm: (socketId) =>
    set((s) => {
      const dmUnread = { ...s.dmUnread }
      delete dmUnread[socketId]
      return { activeDm: socketId, dmUnread, unreadChats: Math.max(0, s.unreadChats - (useVeil.getState().dmUnread[socketId] || 0)) }
    }),

  closeDm: () => set({ activeDm: null }),

  clearChats: () => set({ chats: [] }),

  setTypingPeer: (socketId, name, on) =>
    set((s) => {
      const next = { ...s.typingPeers }
      if (on) next[socketId] = { name, ts: Date.now() }
      else delete next[socketId]
      return { typingPeers: next }
    }),

  pushReaction: (r) =>
    set((s) => ({ reactions: [...s.reactions, r].slice(-12) /* 上限防爆：动画 4s 内最多保留 12 条 */ })),

  dropReaction: (id) =>
    set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),

  setRaisedHand: (key, name, up) =>
    set((s) => {
      const next = { ...s.raisedHands }
      if (up) next[key] = { name, ts: Date.now() }
      else delete next[key]
      return { raisedHands: next }
    }),

  setActiveSpeaker: (key) =>
    set((s) => (s.activeSpeaker === key ? {} : { activeSpeaker: key })),

  clearSensitive: () =>
    set({
      chats: [],
      transfers: {},
      peers: {},
      localStream: null,
      localPreviewStream: null,
      screenStream: null,
      iceProbe: { result: null, at: 0 },
      e2eeStats: { encrypted: 0, decrypted: 0, dropped: 0, bytes: 0, rotations: 0, epoch: 0 },
      dcEpoch: 0,
      selfTestResults: [],
      typingPeers: {},
      muteRequests: {},
      admissionPending: false,
      admissionRequests: {},
      peerVerified: {},
      verifyPending: {},
      peerSeen: {},
      shareRotations: {},
      dmUnread: {},
      activeDm: null,
      joinedTs: 0,
      unreadChats: 0,
      roomLocked: false,
      hostSocketId: null,
      reactions: [],
      raisedHands: {},
      activeSpeaker: null,
    }),
}))

/* ------------------------------ 便捷选择器 ------------------------------ */
/* 注意：选择器必须返回稳定引用（不要在 selector 里 Object.values/sort），
   派生列表请在组件内用 useMemo 计算，否则会触发 useSyncExternalStore 无限循环。 */
export const usePhase = () => useVeil((s) => s.phase)
export const getStore = () => useVeil.getState()

/* 测试钩子：暴露给自动化 QA（agent-browser eval）读取内部状态；生产无副作用 */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__veilStore = useVeil
}
