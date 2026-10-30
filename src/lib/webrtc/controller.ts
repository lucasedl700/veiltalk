/**
 * VeilTalk Controller — RoomClient 与 zustand store 之间的桥接单例
 * 组件只调用 controller.* 方法，不直接触碰 WebRTC 细节。
 */

import { RoomClient, hashRoomPass, type JoinOpts, type RoomInfo } from './room-client'
import { runSelfTest } from './selftest'
import { e2eeManager } from './e2ee-manager'
import { randomId } from './crypto-core'
import { CallRecorder } from './recorder'
import { useVeil } from '@/store/veil-store'
import { pushRecentRoom } from '@/lib/recent-rooms'
import { dictFor, fmt } from '@/lib/i18n'
import { toast } from '@/hooks/use-toast'
import type { LedgerEntry } from './types'
import type { QualityTier } from './tiers'
import { saveLocalTierPref } from './tiers'

let client: RoomClient | null = null
let recorder: CallRecorder | null = null
/** 说话广播去抖状态（边沿触发：只在 on/off 翻转时真正发包） */
let speakLast = false
/** 弱网降档提示节流（30s 内只 toast 一次） */
let lastAdaptiveToastTs = 0
/** 共享画质实测回传提示节流 */
let lastQualityToastTs = 0

function S() {
  return useVeil.getState()
}

/** 非 React 上下文取当前语言字典（事件回调/方法体内调用，语言可随时切换，禁止模块顶层缓存） */
function T() {
  return dictFor(S().lang)
}

/**
 * 安全字典读取（BUG 修复）：真机曾报 `undefined is not an object (evaluating 't.logs.iceProbeSrflx')`
 * —— 字典命名空间在部分环境/旧缓存下可能缺失。读取前判空，缺失时自动回退中文内置文案，
 * 绝不让文案缺失中断 ICE 探测流程。
 */
function toastText(t: unknown, key: string, fallback: string): string {
  try {
    const ns = (t as { toasts?: Record<string, string>; logs?: Record<string, string> }) || {}
    const merged: Record<string, string> = { ...(ns.logs || {}), ...(ns.toasts || {}) }
    return merged[key] || fallback
  } catch {
    return fallback
  }
}

function ensureClient(): RoomClient {
  if (client) return client
  // 同窗口强制单例（修复双模块图/构建分片产生两个 RoomClient：双 socket、双 ECDH 身份、
  // 日志成对、算力翻倍 —— 用户反馈"网站太吃算力"的实测肇因之一）
  const w = typeof window !== 'undefined' ? (window as unknown as { __veilClient?: RoomClient }) : undefined
  if (w?.__veilClient) {
    client = w.__veilClient
    return client
  }
  client = new RoomClient({
    onLog: (level, msg, detail) => S().pushLog(level, msg, detail),
    onSignaling: (signaling) => S().set({ signaling }),
    onJoined: ({ roomId, socketId, peerId, e2eeMode }) =>
      S().set({ phase: 'in-room', roomId, socketId, selfPeerId: peerId, e2eeMode, joinedTs: Date.now() }),
    onLeft: () => {
      S().set({ phase: 'lobby', roomId: '', screenSharing: false })
      S().clearSensitive()
    },
    onPeersChanged: (peers) => {
      const cur = S().peers
      // 纯成员同步：加入/离开的系统提示由 onPeerEvent（信令源头）负责，此处不做 diff 文案
      Object.keys(cur).forEach((id) => {
        if (!peers.find((p) => p.socketId === id)) S().removePeer(id)
      })
      peers.forEach((p) => S().upsertPeer(p.socketId, p))
    },
    onLocalStream: (stream) => {
      const micOn = stream ? (stream.getAudioTracks().every((t) => t.enabled) || stream.getAudioTracks().length === 0) : true
      const camOn = stream ? (stream.getVideoTracks().every((t) => t.enabled) || stream.getVideoTracks().length === 0) : true
      S().set({ localStream: stream, micOn, camOn })
    },
    onScreenStream: (stream) =>
      S().set({
        screenStream: stream,
        // 共享流清空 = 共享必然已结束（system UI 停止/轨道 ended 会绕过 toggleScreen
        // 直接走 client 路径）：在此权威归位 screenSharing，修复徽标/聚焦/控制栏
        // 卡在「共享中」的状态泄漏
        ...(stream ? {} : { screenSharing: false }),
      }),
    onMediaError: (mediaError) => S().set({ mediaError }),
    onRemoteStream: (socketId, stream) => S().upsertPeer(socketId, { stream }),
    onPeerState: (socketId, connState) => S().upsertPeer(socketId, { connState }),
    onPeerStats: (socketId, stats) => {
      S().upsertPeer(socketId, { stats })
      // 追加历史采样（诊断波形图，上限 60 点）
      const cur = S().peers[socketId]
      if (cur) {
        const history = [
          ...(cur.history || []),
          { t: stats.ts, rtt: stats.rttMs, appRtt: stats.appRttMs, loss: stats.lossPct, inKbps: stats.inKbps, outKbps: stats.outKbps },
        ].slice(-60)
        S().upsertPeer(socketId, { history })
      }
    },
    onPeerE2EE: (socketId, info) =>
      S().upsertPeer(socketId, {
        e2ee: { video: info.video, audio: info.audio },
        ...(info.videoRecv || info.audioRecv ? { e2eeRecv: { video: info.videoRecv || 'pending', audio: info.audioRecv || 'pending' } } : {}),
        ...(info.safety ? { safety: info.safety } : {}),
      }),
    onTransfer: (t) => S().upsertTransfer(t),
    // 对端显式回执（F-33）：把乐观的「对端已收到」升级为真回执；日志留痕可审计
    onTransferAck: (_socketId, transferId, ok) => {
      const t = T()
      S().markTransferAck(transferId, ok)
      S().pushLog(
        ok ? 'crypto' : 'warn',
        ok ? t.toasts.ackLogOk : t.toasts.ackLogFail,
        fmt(t.toasts.ackDetail, { id: transferId }),
      )
    },
    onChat: (c) => S().pushChat(c),
    onChatRecall: (id) => S().recallChat(id),
    onPeerMediaState: (socketId, state) => S().upsertPeer(socketId, state),
    onPeerSpeaking: (socketId, speaking) => {
      S().upsertPeer(socketId, { speaking })
      // spotlight 跟随：与本地 tile 的 activeSpeaker 语义一致
      if (speaking) S().setActiveSpeaker(socketId)
      else if (S().activeSpeaker === socketId) S().setActiveSpeaker(null)
    },
    onPeerEvent: (name, kind, cause) => {
      const t = T()
      // 离开状态真实化（BUG：主动退出与断线显示混淆）：按信令 cause 区分文案
      const text =
        kind === 'joined'
          ? fmt(t.toasts.peerJoined, { name })
          : cause === 'voluntary'
            ? fmt(t.toasts.peerLeftVoluntary, { name })
            : cause === 'kicked'
              ? fmt(t.toasts.peerLeftKicked, { name })
              : cause && cause.startsWith('disconnect')
                ? fmt(t.toasts.peerLeftDropped, { name })
                : fmt(t.toasts.peerLeft, { name })
      S().pushChat({
        id: `sys-${kind}-${randomId(10)}`,
        from: '',
        name: '',
        ts: Date.now(),
        text,
        mine: false,
        system: true,
      })
    },
    onTyping: (socketId, name, on) => S().setTypingPeer(socketId, name, on),
    onPakeVerified: (socketId, name) => {
      const t = T()
      S().upsertPeer(socketId, { pake: 'verified' })
      S().pushLog('crypto', fmt(t.toasts.pakeOkLog, { name }), t.toasts.pakeOkDetail)
    },
    onPakeFailed: (socketId, name, reason) => {
      const t = T()
      S().upsertPeer(socketId, { pake: 'failed' })
      S().pushChat({
        id: `sys-pake-${randomId(10)}`,
        from: '',
        name: '',
        ts: Date.now(),
        text: fmt(t.toasts.pakeFailChat, { name, reason }),
        mine: false,
        system: true,
      })
      toast({
        title: fmt(t.toasts.pakeFailTitle, { name }),
        description: t.toasts.pakeFailDesc,
        variant: 'destructive',
      })
    },
    onIceProbe: (result) => {
      // STUN/TURN 可达性探测结果（观测性质；失败时给出部署 TURN 的明确指引）
      // 防御性判空：字典缺失时自动回退内置文案，绝不中断 ICE 流程（真机 Safari 曾因此抛 TypeError）
      S().set({ iceProbe: { result, at: Date.now() } })
      const t = T()
      if (result === 'relay')
        S().pushLog('net', toastText(t, 'iceProbeRelay', '媒体中继可用（TURN）'), toastText(t, 'iceProbeRelayDetail', '将通过 TURN 服务器转发媒体，兼容性最佳'))
      else if (result === 'srflx')
        S().pushLog('net', toastText(t, 'iceProbeSrflx', 'STUN 探测通过'), toastText(t, 'iceProbeSrflxDetail', '可获取公网候选，多数网络可直连'))
      else if (result === 'timeout')
        S().pushLog('warn', toastText(t, 'iceProbeTimeout', 'STUN 探测超时'), toastText(t, 'iceProbeTimeoutDetail', '当前网络可能限制 UDP，建议自建 TURN'))
      else
        S().pushLog('warn', toastText(t, 'iceProbeNone', 'STUN 探测未通过'), toastText(t, 'iceProbeNoneDetail', '跨网络通话可能失败，建议部署 TURN'))
    },
    onMuteRequest: (socketId, name, kind) => {
      const t = T()
      S().addMuteRequest(socketId, name, kind)
      S().pushLog('info', fmt(kind === 'audio' ? t.toasts.muteReqLogAudio : t.toasts.muteReqLogVideo, { name }))
      toast({
        title: fmt(kind === 'audio' ? t.toasts.muteReqTitleAudio : t.toasts.muteReqTitleVideo, { name }),
        description: t.toasts.muteReqDesc,
      })
    },
    onVerifyRequest: (socketId, name, ok) => {
      const t = T()
      S().setPeerVerified(socketId, { ok, at: Date.now(), mine: false })
      S().pushLog('crypto', fmt(t.toasts.verifyRequestedLog, { name }), ok ? t.toasts.verifyMatchDetail : t.toasts.verifyMismatchDetail)
      toast({
        title: fmt(t.toasts.verifyRequestedTitle, { name }),
        description: ok ? t.toasts.verifyAutoReplyOk : t.toasts.verifyMismatchDanger,
        variant: ok ? undefined : 'destructive',
      })
    },
    onVerifyResult: (socketId, name, ok, timeout) => {
      const t = T()
      S().setPeerVerified(socketId, { ok, at: Date.now(), mine: true })
      if (timeout) {
        toast({ title: fmt(t.toasts.verifyTimeoutTitle, { name }), description: t.toasts.verifyTimeoutDesc, variant: 'destructive' })
        return
      }
      S().pushLog(ok ? 'crypto' : 'error', ok ? fmt(t.toasts.verifyOkLog, { name }) : fmt(t.toasts.verifyFailLog, { name }), ok ? t.toasts.verifyMatchDetail : t.toasts.verifyMismatchDetail)
      toast({
        title: ok ? fmt(t.toasts.verifyOkTitle, { name }) : fmt(t.toasts.verifyFailTitle, { name }),
        description: ok ? t.toasts.verifyOkDesc : t.toasts.verifyMismatchDanger,
        variant: ok ? undefined : 'destructive',
      })
    },
    onChatReact: (id, emoji, on) => S().applyReaction(id, emoji, on, false),
    onReaction: (socketId, name, emoji) => {
      // F-41：对端反应入浮层（不 toast，不打断；日志留痕可审计）
      S().pushReaction({ id: `re-${socketId}-${Date.now()}-${randomId(4)}`, name, emoji, mine: false, socketId, ts: Date.now() })
      S().pushLog('info', fmt(T().toasts.reactionLog, { name, emoji }))
    },
    onHand: (socketId, name, up) => {
      // F-42：举手 toast 提醒（放下静默）；状态入 tile 徽标与成员列表
      const t = T()
      S().setRaisedHand(socketId, name, up)
      S().pushLog('info', fmt(up ? t.toasts.handUpLog : t.toasts.handDownLog, { name }))
      if (up) toast({ title: `✋ ${fmt(t.toasts.handUpTitle, { name })}` })
    },
    onRoomState: ({ locked, hostSocketId }) => S().set({ roomLocked: locked, hostSocketId }),
    onPeerShare: (socketId, on) => {
      // 对端屏幕共享状态（控制面布尔信号）：徽标 + 聚焦布局跟随（Task 24 iPad 共享修复配套）
      S().upsertPeer(socketId, { sharing: on })
    },
    onScreenShareWarn: () => {
      const t = T()
      toast({ title: t.toasts.shareWarnTitle, description: t.toasts.shareWarnDesc, variant: 'destructive' })
    },
    onScreenShareUnsupported: () => {
      const t = T()
      toast({ title: t.toasts.shareUnsupportedTitle, description: t.toasts.shareUnsupportedDesc, variant: 'destructive' })
    },
    onKicked: (byName) => {
      const t = T()
      S().pushLog('warn', fmt(t.toasts.kickedLog, { name: byName }))
      toast({ title: t.toasts.kickedTitle, description: fmt(t.toasts.kickedDesc, { name: byName }), variant: 'destructive' })
      // fail-closed：立即离房清理（leave 内部会触发 onLeft → clearSensitive）
      client?.leave()
    },
    onAdmissionPending: () => {
      // 人工审核等候室：保持 joining 阶段 + 等待标记（Lobby 渲染等待卡）
      S().set({ admissionPending: true, phase: 'joining' })
    },
    onAdmissionDenied: (reason) => {
      const t = T()
      S().set({ admissionPending: false, phase: 'lobby' })
      const why = reason === 'timeout' ? t.toasts.admissionTimeout : reason === 'closed' ? t.toasts.admissionClosed : t.toasts.admissionDenied
      toast({ title: t.toasts.admissionDeniedTitle, description: why, variant: 'destructive' })
      S().pushLog('warn', t.toasts.admissionDeniedLog, why)
    },
    onAdmissionRequest: (socketId, name) => {
      // 房主端：加入申请（幂等：同 socketId 重复事件只刷新时间戳）；审批横幅在舞台展示
      const t = T()
      S().addAdmissionRequest(socketId, name)
      S().pushLog('info', fmt(t.toasts.admissionReqLog, { name }))
      toast({ title: t.toasts.admissionReqTitle, description: fmt(t.toasts.admissionReqDesc, { name }) })
    },
    onAdaptive: (socketId, kbps) => {
      const t = T()
      S().pushLog('net', fmt(t.toasts.adaptiveLog, { kbps }))
      const stats = S().peers[socketId]?.stats
      if (stats) S().upsertPeer(socketId, { stats: { ...stats, adaptiveBitrateKbps: kbps } })
      // 弱网自适应可视化（用户反馈"有这功能但看不见"）：码率被调低时明确提示一次（30s 节流）
      const cur = stats?.adaptiveBitrateKbps ?? 0
      const now = Date.now()
      if (kbps < cur && now - lastAdaptiveToastTs > 30_000) {
        lastAdaptiveToastTs = now
        toast({
          title: t.toasts.adaptiveDownTitle,
          description: fmt(t.toasts.adaptiveDownDesc, { kbps }),
        })
      }
    },
    onQualityReport: (socketId, q) => {
      const st = S()
      st.setPeerSeen(socketId, q)
      const p = st.peers[socketId]
      const name = p?.name || T().toasts.guest
      st.pushLog(
        'net',
        fmt(T().toasts.qualityReportLog, { name }),
        `${q.w}×${q.h}@${q.fps}fps${q.rtt != null ? ` · RTT ${Math.round(q.rtt)}ms` : ''}`,
      )
      // 共享中第一份实测回传 → toast 告知发送者"对方到底看得清不清楚"
      const nowMs = Date.now()
      if (st.screenSharing && nowMs - lastQualityToastTs > 20_000) {
        lastQualityToastTs = nowMs
        toast({ title: fmt(T().toasts.qualityReportTitle, { w: q.w, h: q.h, fps: q.fps }) })
      }
    },
  })
  e2eeManager.onStats((s) => useVeil.setState({ e2eeStats: s }))
  /* 测试钩子：暴露 E2EE worker 给自动化 QA（手工管线验证帧格式/轮换） */
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__veilE2EE = e2eeManager
  }
  /* 测试钩子：暴露 RoomClient 给自动化 QA（检查 bundles/dc 状态、手工发消息） */
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__veilClient = client
  }
  /* 测试钩子：暴露 controller 给自动化 QA（store+client 联动入口，与 UI 同路径） */
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__veilCtl = controller
  }
  /* 测试钩子：暴露 store 给自动化 QA（直读 chats/peers/e2ee 等状态，免 DOM 断言） */
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__veilStore = useVeil
  }
  return client
}

export const controller = {
  /** 进房向导「安全握手」步：提前建信令 + 生成 ECDH 身份（不入房） */
  async prewarm() {
    const c = ensureClient()
    return c.prewarm()
  },
  async join(roomId: string, name: string, passphrase?: string, opts?: JoinOpts & { roomPass?: string }) {
    S().set({ phase: 'joining', admissionPending: false, myName: name })
    const c = ensureClient()
    // 房间密码哈希：明文不出浏览器（sha256(roomId:pass)；Task 30 准入门禁）
    let roomPassHash = opts?.roomPassHash || ''
    if (!roomPassHash && opts?.roomPass) roomPassHash = await hashRoomPass(roomId, opts.roomPass)
    const r = await c.joinRoom(roomId, name, passphrase, {
      roomPassHash: roomPassHash || undefined,
      admission: opts?.admission,
      create: opts?.create,
    })
    // 'pending' 有两种：① 信令未就绪（connect 事件自动重试）；② 人工审核等候室（admissionPending 已置位）。
    // 均不回退大厅。
    if (!r.ok && r.error !== 'pending') S().set({ phase: 'lobby' })
    else {
      S().set({ myFingerprint: c.myFingerprint })
      // 加入成功（非等候室）→ 记录最近房间历史（纯本地 localStorage）
      if (r.ok && !r.pending) pushRecentRoom(roomId)
    }
    return r
  },
  /** 大厅房间码探测（防抖调用）：存在/需密码/审批模式/人数 */
  async queryRoomInfo(roomId: string): Promise<RoomInfo | null> {
    const c = ensureClient()
    return c.queryRoomInfo(roomId)
  },
  /** 取消等候室等待：回大厅 fail-closed */
  cancelAdmission() {
    client?.cancelAdmission()
    S().set({ phase: 'lobby', admissionPending: false })
  },
  /** 房主/管理员审批等候室成员 */
  respondAdmission(socketId: string, admit: boolean) {
    if (client?.respondAdmission(socketId, admit)) {
      S().dismissAdmissionRequest(socketId)
      const t = T()
      S().pushLog('info', admit ? t.toasts.admittedLog : t.toasts.rejectedLog)
    }
  },
  /** 管理员 socket 鉴权（解锁跨房踢人/免审入房）：解锁入口调用，socket 每次重连后需重验 */
  async notifyAdminUnlock(password: string): Promise<boolean> {
    const c = ensureClient()
    // socket 可能仍在连接中：预热后再鉴权
    await c.prewarm().catch(() => {})
    return c.adminAuth(password)
  },
  leave() {
    client?.leave()
  },
  async retryMedia() {
    await client?.acquireLocalMedia()
  },
  toggleMic() {
    const st = S()
    const next = !st.micOn
    client?.toggleTrack('audio', next)
    st.set({ micOn: next })
  },
  toggleCam() {
    const st = S()
    const next = !st.camOn
    client?.toggleTrack('video', next)
    st.set({ camOn: next })
  },
  async toggleScreen() {
    const on = await client?.toggleScreenShare()
    S().set({ screenSharing: !!on })
  },
  /** 发送会议级 Emoji 反应（F-41）：本地立即上屏 + 广播对端 */
  sendReaction(emoji: string) {
    const st = S()
    const ts = Date.now()
    st.pushReaction({ id: `re-local-${ts}-${Math.random().toString(36).slice(2, 6)}`, name: st.myName, emoji, mine: true, socketId: '__local__', ts })
    st.pushLog('info', fmt(T().toasts.reactionLog, { name: st.myName, emoji }))
    client?.sendReaction(emoji)
  },
  /** 举手/放下（F-42）：本地状态即时变化 + 广播；无对端时也保留本地状态 */
  toggleHand() {
    const st = S()
    const up = !st.raisedHands.__local__
    st.setRaisedHand('__local__', st.myName, up)
    st.pushLog('info', fmt(up ? T().toasts.handUpLog : T().toasts.handDownLog, { name: st.myName }))
    client?.sendHand(up)
  },
  async refreshDevices() {
    const devices = await client?.listDevices()
    if (devices) S().set({ devices })
  },
  async switchDevice(kind: 'audio' | 'video', deviceId: string) {
    await client?.switchDevice(kind, deviceId)
  },
  /** 音频输出（扬声器/蓝牙耳机）切换：Chrome/Edge setSinkId；立即应用到页面全部音频元素 */
  setAudioOutput(deviceId: string) {
    S().set({ audioOutputId: deviceId })
    try {
      localStorage.setItem('veil-audio-output', deviceId)
    } catch { /* noop */ }
    applyAudioOutput(deviceId)
  },
  /** 画质热切换（360p→4K60 七档）：applyConstraints 不断流；成功后记忆个人偏好 */
  async setCameraQuality(pref: QualityTier) {
    const ok = (await client?.setCameraQuality(pref)) ?? false
    if (ok) {
      S().set({ qualityPref: pref })
      saveLocalTierPref(pref)
    }
    return ok
  },
  /** 屏幕共享画质档（auto/1080p60/4k60/8k144）：下次开启共享生效；本机偏好记忆 */
  setShareTier(tier: 'auto' | '1080p60' | '4k60' | '8k144') {
    S().set({ shareTier: tier })
    try {
      localStorage.setItem('veil-share-tier', tier)
    } catch { /* noop */ }
  },
  /** AI 画面增强（自动曝光）开关与目标亮度；立即热切换发送轨 */
  async setEnhance(on: boolean, level?: number) {
    const st = S()
    const lv = typeof level === 'number' ? Math.min(0.75, Math.max(0.45, level)) : st.enhanceLevel
    const wasOn = st.enhanceOn
    st.set({ enhanceOn: on, enhanceLevel: lv })
    try {
      localStorage.setItem('veil-enhance', on ? '1' : '0')
      localStorage.setItem('veil-enhance-level', String(lv))
    } catch { /* noop */ }
    // 强度调整且已开启：重建管线；开关状态变化：切换管线
    if (client && (wasOn !== on || wasOn)) {
      const ok = await client.setEnhance(on, lv)
      if (on && !ok) {
        st.set({ enhanceOn: false })
        try { localStorage.setItem('veil-enhance', '0') } catch { /* noop */ }
      }
    }
  },
  /** 【Task 36】合成补帧（倍频平滑）开关：热切换发送轨，失败回退原轨 */
  async setInterp(on: boolean) {
    S().set({ interpOn: on })
    try { localStorage.setItem('veil-interp', on ? '1' : '0') } catch { /* noop */ }
    const ok = (await client?.setInterp(on)) ?? false
    if (on && !ok) {
      S().set({ interpOn: false })
      try { localStorage.setItem('veil-interp', '0') } catch { /* noop */ }
    }
  },
  /** 虚拟背景（Zoom 化）：off/blur/color/image 热切换；参数即时生效，模式切换重建管线 */
  async setVirtualBg(patch?: { mode?: 'off' | 'blur' | 'color' | 'image'; blur?: number; color?: string; image?: string | null; gradient?: 'dusk' | 'ocean' | 'mint' }) {
    const st = S()
    const next = {
      mode: patch?.mode ?? st.vbgMode,
      blur: Math.min(28, Math.max(4, patch?.blur ?? st.vbgBlur)),
      color: patch?.color ?? st.vbgColor,
      image: patch?.image !== undefined ? patch.image : st.vbgImage,
      gradient: patch?.gradient ?? st.vbgGradient,
    }
    st.set({
      vbgMode: next.mode,
      vbgBlur: next.blur,
      vbgColor: next.color,
      vbgImage: next.image,
      vbgGradient: next.gradient,
      vbgStatus: next.mode === 'off' ? 'idle' : 'loading',
    })
    try {
      localStorage.setItem('veil-vbg-mode', next.mode)
      localStorage.setItem('veil-vbg-blur', String(next.blur))
      localStorage.setItem('veil-vbg-color', next.color)
      localStorage.setItem('veil-vbg-gradient', next.gradient)
      if (next.image && next.image.length > 1_572_864) throw new Error('image too large')
      if (next.image) localStorage.setItem('veil-vbg-image', next.image)
      else localStorage.removeItem('veil-vbg-image')
    } catch { /* 配额/隐私模式：仅会话内生效 */ }
    if (!client) {
      // 未入房：仅记忆偏好，入房采集后自动生效
      if (next.mode !== 'off') st.set({ vbgStatus: 'idle' })
      return true
    }
    const ok = await client.setVirtualBg(next.mode, next)
    if (ok) {
      if (next.mode !== 'off') st.set({ vbgStatus: 'ready' })
    } else {
      st.set({ vbgMode: 'off', vbgStatus: 'failed' })
      try { localStorage.setItem('veil-vbg-mode', 'off') } catch { /* noop */ }
    }
    return ok
  },
  sendChat(text: string, toSocketId?: string) {
    void client?.sendChat(text, toSocketId)
  },
  /** 私信开关/发送侧共用：去抖后的说话广播（video-tile 本端 AGC 检测调用，边沿触发） */
  sendSpeaking(on: boolean) {
    const c = client
    if (!c) return
    if (speakLast === on) return
    speakLast = on
    c.sendSpeaking(on)
  },
  sendFile(file: File) {
    return client?.sendFile(file) ?? 0
  },
  cancelTransfer(id: string) {
    client?.cancelTransfer(id)
  },
  pauseTransfer(id: string) {
    if (client?.pauseTransfer(id)) S().pushLog('info', T().toasts.pausedLog)
  },
  resumeTransfer(id: string) {
    if (client?.resumeTransfer(id)) S().pushLog('info', T().toasts.resumedLog)
  },
  /** 断点续传（P1-6）：重试失败/中断的发送，接收端按 digest 从已收断点继续 */
  retryTransfer(id: string) {
    if (client?.retryTransfer(id)) {
      const t = T()
      S().pushLog('info', t.toasts.resumeLog, t.toasts.resumeDetail)
    } else {
      toast({ title: T().toasts.resumeFailTitle, description: T().toasts.resumeFailDesc, variant: 'destructive' })
    }
  },
  /** 一键擦除本地断点暂存（IndexedDB 明文分片；见 E2EE.md §3.2 隐私边界说明） */
  async clearTransferCache() {
    const { clearPartials } = await import('./transfer-db')
    const n = await clearPartials()
    const t = T()
    S().pushLog('info', t.toasts.cacheClearedLog, n > 0 ? fmt(t.toasts.cacheClearedDetail, { n }) : t.toasts.cacheNone)
    toast({ title: t.toasts.cacheClearedTitle, description: n > 0 ? fmt(t.toasts.cacheClearedToastDesc, { n }) : t.toasts.cacheNone })
  },
  sendTyping(on: boolean) {
    client?.sendTyping(on)
  },
  /** 撤回自己的一条聊天消息（id 来自 chats；非本人/系统消息由 UI 层拦截；dm 私信定向撤回） */
  recallChat(id: string, toSocketId?: string) {
    S().recallChat(id)
    client?.sendChatRecall(id, toSocketId)
    S().pushLog('info', T().toasts.recalledLog)
  },
  /** 切换自己某条消息的表情回应（再次点击同一 emoji = 取消）并同步对端；dm 私信定向 */
  reactChat(id: string, emoji: string, on: boolean, toSocketId?: string) {
    S().applyReaction(id, emoji, on, true)
    client?.sendChatReact(id, emoji, on, toSocketId)
  },
  /** 发起指纹互核（加密面板按钮）：对端自动回发指纹并与真实值比对 */
  requestPeerVerify(socketId: string) {
    if (!client?.requestPeerVerify(socketId)) {
      toast({ title: T().toasts.verifyNoChannelTitle, description: T().toasts.verifyNoChannelDesc, variant: 'destructive' })
    }
  },
  /** 请求对端静音/关摄像头（成员治理；对端可忽略） */
  requestMute(socketId: string, kind: 'audio' | 'video') {
    if (client?.sendMuteRequest(socketId, kind)) {
      const t = T()
      S().pushLog('info', kind === 'audio' ? t.toasts.muteSentLogAudio : t.toasts.muteSentLogVideo)
      toast({ title: t.toasts.muteSentTitle, description: t.toasts.muteSentDesc })
    } else {
      toast({ title: T().toasts.muteSendFailTitle, description: T().toasts.muteSendFailDesc, variant: 'destructive' })
    }
  },
  /** 接受静音请求：立即执行并回发日志（对端状态由其自身 UI 呈现） */
  acceptMuteRequest(socketId: string, kind: 'audio' | 'video') {
    if (kind === 'audio') {
      client?.toggleTrack('audio', false)
      S().set({ micOn: false })
    } else {
      client?.toggleTrack('video', false)
      S().set({ camOn: false })
    }
    S().dismissMuteRequest(socketId)
    const t = T()
    S().pushLog('info', kind === 'audio' ? t.toasts.muteAcceptedLogAudio : t.toasts.muteAcceptedLogVideo)
    toast({ title: kind === 'audio' ? t.toasts.micOffTitle : t.toasts.camOffTitle })
  },
  dismissMuteRequest(socketId: string) {
    S().dismissMuteRequest(socketId)
  },
  clearChats() {
    S().clearChats()
    S().pushLog('info', T().toasts.chatsClearedLog)
  },
  /** 开始/停止本地混合录制；停止后自动触发浏览器下载 webm */
  async toggleRecording() {
    const st = S()
    if (st.recording) {
      const blob = await recorder?.stop()
      recorder = null
      st.set({ recording: false })
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `veiltalk-${st.roomId || 'room'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 30000)
        const t = T()
        const mb = (blob.size / 1024 / 1024).toFixed(2)
        st.pushLog('crypto', t.toasts.recDoneLog, `${mb} MB · webm`)
        toast({ title: t.toasts.recDoneTitle, description: fmt(t.toasts.recDoneDesc, { size: mb }) })
      } else {
        toast({ title: T().toasts.recEndTitle, description: T().toasts.recEndDesc, variant: 'destructive' })
      }
      return
    }
    if (!client || client.sessionCount === 0) {
      toast({ title: T().toasts.recNothingTitle, description: T().toasts.recNothingDesc, variant: 'destructive' })
      return
    }
    recorder = new CallRecorder({
      onTick: ({ ms, bytes }) => useVeil.setState({ recordingMs: ms, recordingBytes: bytes }),
      onLog: (l, m, d) => S().pushLog(l === 'error' ? 'error' : l === 'warn' ? 'warn' : 'info', m, d),
    })
    const cur = S()
    const ok = recorder.start({
      local: cur.localStream,
      screen: cur.screenStream,
      remotes: Object.values(cur.peers).map((p) => ({ name: p.name || T().toasts.guest, stream: p.stream })),
      roomId: cur.roomId,
      myName: cur.myName,
    })
    if (ok) {
      cur.set({ recording: true, recordingMs: 0, recordingBytes: 0 })
      // 测试钩子：暴露录制器内部状态给自动化 QA（chunks 生产情况排查用）
      if (typeof window !== 'undefined') {
        ;(window as unknown as Record<string, unknown>).__veilRecorder = recorder
      }
    } else {
      recorder = null
    }
  },
  restartIce() {
    client?.restartAllIce()
  },
  /** 房内热切换 ICE 服务器（服务器选择面板）：不断流，重启协商 */
  switchIceServer() {
    return client?.switchIceServer() ?? false
  },
  /** 手动轮换媒体帧密钥（epoch+1）；仅数据模式下无媒体管线会返回 false */
  rotateMediaKeys() {
    if (client?.rotateAllMediaKeys()) {
      const t = T()
      S().pushLog('crypto', t.toasts.mediaRotatedLog)
      toast({ title: t.toasts.mediaRotatedTitle, description: t.toasts.mediaRotatedDesc })
    } else {
      toast({ title: T().toasts.noMediaPipelineTitle, description: T().toasts.noMediaPipelineDesc, variant: 'destructive' })
    }
  },
  /** 手动轮换 DataChannel 密钥（聊天/文件链各自 epoch+1，对端按帧内 epoch 自主跟随） */
  rotateDataKeys() {
    const r = client?.rotateAllDataKeys()
    if (r && r.sessions > 0) {
      const t = T()
      S().set({ dcEpoch: r.epoch })
      S().pushLog('crypto', fmt(t.toasts.dataRotatedLog, { epoch: r.epoch }), fmt(t.toasts.dataRotatedDetail, { n: r.sessions }))
      toast({ title: t.toasts.dataRotatedTitle, description: fmt(t.toasts.dataRotatedDesc, { epoch: r.epoch }) })
    } else {
      toast({ title: T().toasts.noSessionsTitle, description: T().toasts.noSessionsDesc, variant: 'destructive' })
    }
  },
  /** 房主：将成员移出房间（信令侧校验房主身份；被踢端自动回大厅） */
  kickPeer(socketId: string, name: string) {
    if (client?.kickPeer(socketId)) {
      S().pushLog('warn', fmt(T().toasts.kickSentLog, { name }))
    } else {
      toast({ title: T().toasts.opFailTitle, description: T().toasts.opFailDesc, variant: 'destructive' })
    }
  },
  /** 房主：锁定/解锁房间（锁定后新成员加入被信令拒绝） */
  toggleRoomLock(locked: boolean) {
    if (client?.setRoomLocked(locked)) {
      const t = T()
      S().pushLog('info', locked ? t.toasts.lockLogOn : t.toasts.lockLogOff)
      toast({ title: locked ? t.toasts.lockOnTitle : t.toasts.lockOffTitle, description: locked ? t.toasts.lockOnDesc : t.toasts.lockOffDesc })
    }
  },
  async runSelfTest() {
    S().set({ selfTestRunning: true, selfTestResults: [] })
    try {
      const { ok, results } = await runSelfTest((r) =>
        useVeil.setState((s) => ({ selfTestResults: [...s.selfTestResults, r] })),
      )
      const t = T()
      S().pushLog(ok ? 'crypto' : 'error', ok ? t.toasts.selfTestLogOk : t.toasts.selfTestLogFail, fmt(t.toasts.selfTestDetail, { n: results.length }))
      return ok
    } finally {
      S().set({ selfTestRunning: false })
    }
  },
  async fetchLedger(date?: string) {
    S().set({ ledgerLoading: true })
    try {
      const qs = new URLSearchParams({ limit: '300' })
      const d = date || S().ledgerDate
      if (d) qs.set('date', d)
      const res = await fetch(`/api/ledger?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as {
        entries: LedgerEntry[]
        date: string
        availableDates: string[]
      }
      S().set({ ledger: data.entries, ledgerDate: data.date, ledgerDates: data.availableDates || [] })
    } catch (e) {
      S().pushLog('error', T().toasts.ledgerFailLog, String(e))
      S().set({ ledger: [] })
    } finally {
      S().set({ ledgerLoading: false })
    }
  },
}

/** 把音频输出设备应用到页面全部音频元素（setSinkId，Chrome/Edge；不支持的浏览器静默忽略） */
function applyAudioOutput(deviceId: string) {
  if (typeof document === 'undefined' || !deviceId) return
  document.querySelectorAll('audio').forEach((a) => {
    const el = a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    try {
      el.setSinkId?.(deviceId).catch(() => {})
    } catch { /* noop */ }
  })
}

/** 生成人类友好的房间号（去混淆字符） */
export function randomRoomId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('')
}

/**
 * 构造邀请链接。若用户勾选"口令包含在链接中"，口令放 #hash 片段 —— 浏览器不会把
 * fragment 发给服务器，信令服务器与访问日志均不可见（详见 docs/E2EE.md）。
 */
export function buildInviteUrl(roomId: string): string {
  const st = useVeil.getState()
  const frag = st.passInLink && st.passphrase ? `#pass=${encodeURIComponent(st.passphrase)}` : ''
  return `${window.location.origin}/?room=${roomId}${frag}`
}
