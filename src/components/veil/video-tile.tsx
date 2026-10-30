'use client';

/**
 * VideoTile — 单个视频块：本地镜像 / 远端流、连接质量徽标、音量条、状态覆盖层
 *
 * Zoom 化套件（F-40~F-45）：
 *  - speakKey：本 tile 的说话人键（'__local__' 或对端 socketId），每 250ms 把
 *    「是否在说话」低频上报 store.activeSpeaker，驱动 spotlight 主画面自动跟随
 *  - handRaised：举手徽标（左上角 ✋，veil-hand-pop 弹入）
 *  - bubbleEmoji：最近反应气泡（右上角，veil-bubble-pop 弹出）
 *  - mirrorSelf：本地画面镜像可开关（store 持久化，默认开）
 */

import { useEffect, useRef, useState } from 'react'
import { useVeil } from '@/store/veil-store'
import type { PeerStats } from '@/lib/webrtc/types'
import { networkGradeLabel } from '@/lib/webrtc/quality'
import { controller } from '@/lib/webrtc/controller'
import { Hand, MessageCircle, MicOff, MonitorUp, Play, RefreshCcw, RotateCcw, RotateCw, ShieldCheck, VideoOff, Volume2, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

type Props = {
  stream: MediaStream | null
  name: string
  isLocal?: boolean
  muted?: boolean
  camOff?: boolean
  screenSharing?: boolean
  connState?: RTCPeerConnectionState | 'connecting'
  stats?: PeerStats | null
  peerId?: string
  /** 本 tile 的活跃说话人键（F-40）：'__local__' 或对端 socketId；不传则不上报 */
  speakKey?: string
  /** 举手徽标（F-42） */
  handRaised?: boolean
  /** 最近反应气泡 emoji（F-41，3s 窗口内该成员最新一次反应） */
  bubbleEmoji?: string | null
  /** 帧级加密协商结果：false = 已降级 DTLS-SRTP（对端不支持帧级加密） */
  frameE2EE?: boolean
  /** 自定义头像（96px dataURL；无则首字母徽章） */
  avatar?: string
  /** 对端麦克风状态（控制面同步；undefined = 旧版本对端未知） */
  remoteMicOn?: boolean
  /** 对端摄像头状态（控制面同步；false 时强制显示头像+已关闭摄像头） */
  remoteCamOn?: boolean
  /** 对端正在说话（控制面 t:'speaking' 广播；远端光环的数据源） */
  remoteSpeaking?: boolean
  /** 共享画面手动旋转角度（Task 30：0/90/180/270；仅共享 tile 显示旋转按钮） */
  rotation?: number
  /** 旋转回调（delta=±90；不传则不显示按钮） */
  onRotate?: (delta: number) => void
  /** 点击私信按钮（仅远端 tile 传入）：打开与该成员的私信会话 */
  onDm?: () => void
}

/**
 * 说话判定（AGC 归一化后）：本地电平经滚动噪声底/峰值归一化，低配设备/小音量麦克风也能
 * 稳定点亮说话光环（用户反馈：荣耀 MagicBook 开麦别人看不到他说话）。
 */
const SPEAK_THRESHOLD = 0.22
const REPORT_MS = 250

export function VideoTile({ stream, name, isLocal, muted, camOff, screenSharing, connState, stats, peerId, speakKey, handRaised, bubbleEmoji, frameE2EE, avatar, remoteMicOn, remoteCamOn, remoteSpeaking, rotation, onRotate, onDm }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  /** 远端专用音频元素（iOS 修复核心）：视频元素全程静音只负责画面，声音从这里出 */
  const audioRef = useRef<HTMLAudioElement>(null)
  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)
  const myStream = useVeil((s) => s.localStream)
  const micOn = useVeil((s) => s.micOn)
  const mirrorSelf = useVeil((s) => s.mirrorSelf)
  const t = useDict()
  /* ---- Task 30：共享画面手动旋转（ResizeObserver 量尺寸 → 90/270° 时宽高互换适配） ---- */
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBoxSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const rot = (((rotation ?? 0) % 360) + 360) % 360
  const rotated = rot === 90 || rot === 270
  /** 自动播放被浏览器策略拦截（视频元素：即使静音也罕见地被拦的兑底提示） */
  const [playBlocked, setPlayBlocked] = useState(false)
  /** 远端音频未解锁（iOS/严格策略：非手势下 play() 被拒，等待任意点击解锁） */
  const [audioBlocked, setAudioBlocked] = useState(false)

  // 本地麦克风电平表（WebAudio Analyser）
  const audioTrack = isLocal ? myStream?.getAudioTracks()[0] : stream?.getAudioTracks()[0]
  const audioEnabled = isLocal ? micOn : true

  // 接流 + 自动播放兜底（BUG-16 伴生修复）：play() 被策略拦截时提供手势重试与全局点击恢复
  // WebKit 韧性包（「看不到对方画面」根治）：两端均用预建 transceiver（无 msid）→ 接收端
  // 聚合流里音频轨先到、视频轨后到；srcObject 已挂载后再 addTrack 的轨道，WebKit 的
  // <video> 元素不感知 → 永远黑屏（Chrome 原生感知，故桌面互看正常、iPad 看人黑屏）。
  // 同理：共享停止 replaceTrack 回摄像头后轨道 mute→unmute 恢复出帧，WebKit 也可能
  // 停留在最后一帧。监听轨道增删 + 解静音事件：WebKit 强制重挂 srcObject，全平台轻推 play()。
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (v.srcObject !== stream) {
      v.srcObject = stream || null
    }
    if (!stream) {
      // 无流时覆盖层由 showOff 分支隐藏，无需额外状态重置
      return
    }
    const tryPlay = () => {
      v.play()
        .then(() => setPlayBlocked(false))
        .catch(() => {
          v.muted = true
          v.play()
            .then(() => setPlayBlocked(true))
            .catch(() => setPlayBlocked(true))
        })
    }
    tryPlay()
    const onMeta = () => tryPlay()
    v.addEventListener('loadedmetadata', onMeta)
    const isWebKit = typeof navigator !== 'undefined' && /Safari\/\d/.test(navigator.userAgent) && !/Chrom(e|ium)/.test(navigator.userAgent)
    // 解静音 = 对端恢复出帧（摄像头回切/旋转恢复）：轻推播放即可，不重挂（避免闪烁）
    const onTrackUnmute = (ev: Event) => {
      if ((ev.target as MediaStreamTrack | undefined)?.kind !== 'video') return
      tryPlay()
    }
    const bindUnmute = (tr: MediaStreamTrack) => {
      if (tr.kind !== 'video') return
      try { tr.removeEventListener('unmute', onTrackUnmute) } catch { /* noop */ }
      try { tr.addEventListener('unmute', onTrackUnmute) } catch { /* noop */ }
    }
    stream.getVideoTracks().forEach(bindUnmute)
    // 轨道后加入（音频先到、视频后到的聚合窗口）：WebKit 必须重挂 srcObject 才能渲染
    const onTracksChanged = (e: MediaStreamTrackEvent) => {
      if (e.track.kind !== 'video') return
      bindUnmute(e.track)
      if (isWebKit && e.type === 'addtrack') {
        try {
          v.srcObject = null
          v.srcObject = stream
        } catch { /* noop */ }
      }
      tryPlay()
    }
    stream.addEventListener('addtrack', onTracksChanged)
    stream.addEventListener('removetrack', onTracksChanged)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      stream.removeEventListener('addtrack', onTracksChanged)
      stream.removeEventListener('removetrack', onTracksChanged)
      stream.getVideoTracks().forEach((tr) => {
        try { tr.removeEventListener('unmute', onTrackUnmute) } catch { /* noop */ }
      })
    }
  }, [stream])

  // 远端音频专用元素（「一边说话另一边完全听不到」修复核心）：
  //  - 视频/音频分离：视频元素静音显示，音频从这里出 —— iOS 上静音视频可自动播放，
  //    但「先静音播放再程序化取消静音」永远无声（必须在手势内重新 play）；
  //  - play() 被策略拒绝 → audioBlocked=true → 任意全局 pointerdown/touchstart/keydown 在
  //    capture 阶段同步重试（iOS 要求 play() 在手势调用栈内）；
  //  - 桌面端同样受益：入房点击已具备 sticky 激活，音频元素基本即刻出声。
  //  - WebKit 韧性：音频轨可能晚于首帧挂载到达（聚合流 addtrack）——监听 addtrack
  //    补挂 + 播放，否则该端永远无声（与视频黑屏同根因的 WebKit 感知缺陷）。
  useEffect(() => {
    if (isLocal) return
    const a = audioRef.current
    if (!a) return
    if (a.srcObject !== stream) {
      a.srcObject = stream || null
    }
    if (!stream) return
    const isWebKit = typeof navigator !== 'undefined' && /Safari\/\d/.test(navigator.userAgent) && !/Chrom(e|ium)/.test(navigator.userAgent)
    a.muted = false
    a.volume = 1
    const tryAudio = () => {
      a.play()
        .then(() => setAudioBlocked(false))
        .catch(() => setAudioBlocked(true))
    }
    const ensureAudio = () => {
      if (stream.getAudioTracks().length === 0) return
      if (isWebKit) {
        // 音频轨后加入：WebKit 需重挂才能出声
        try {
          a.srcObject = null
          a.srcObject = stream
        } catch { /* noop */ }
      }
      tryAudio()
    }
    ensureAudio()
    const onMeta = () => tryAudio()
    a.addEventListener('loadedmetadata', onMeta)
    const onTracksChanged = (e: MediaStreamTrackEvent) => {
      if (e.track.kind === 'audio' && e.type === 'addtrack') ensureAudio()
    }
    stream.addEventListener('addtrack', onTracksChanged)
    const onGesture = () => {
      if (a.paused || a.muted) tryAudio()
    }
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('touchstart', onGesture, true)
    document.addEventListener('keydown', onGesture, true)
    return () => {
      a.removeEventListener('loadedmetadata', onMeta)
      stream.removeEventListener('addtrack', onTracksChanged)
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('touchstart', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
    }
  }, [stream, isLocal])

  useEffect(() => {
    if (!audioTrack || !audioEnabled) return
    // 仅本地电平表：远端说话状态由发送端 AGC 检测后经控制面广播（video-tile 远端不再各跑
    // WebAudio —— 多人时省 N 个 AudioContext + Analyser，且低配机/WebKit 行为一致）
    if (!isLocal) return
    let ctx: AudioContext | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    try {
      ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)
      let lastPushed = -1
      // AGC 归一化：滚动噪声底（慢速上浮）与峰值（快速跟随）→ 小音量/低增益麦克风可检出
      let noiseFloor = 0.02
      let peak = 0.12
      // 卡顿优化：电平采样从 rAF（~60fps setState → 渲染风暴）降频到 100ms + 变化阈值过滤，
      // 只有变化超过 0.04 才触发 React 重渲染（多个 tile 同屏时尤明显）
      timer = setInterval(() => {
        analyser.getByteFrequencyData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i]
        const raw = Math.min(1, sum / buf.length / 96)
        noiseFloor = Math.max(0.01, noiseFloor * 0.995 + raw * 0.005)
        peak = Math.max(raw, peak * 0.985, noiseFloor + 0.08)
        const span = Math.max(0.06, peak - noiseFloor)
        const lv = Math.min(1, Math.max(0, (raw - noiseFloor) / span))
        levelRef.current = lv
        if (Math.abs(lv - lastPushed) > 0.04 || (lv === 0 && lastPushed !== 0)) {
          lastPushed = lv
          setLevel(lv)
        }
      }, 100)
    } catch {
      /* AudioContext 不可用时静默 */
    }
    return () => {
      if (timer) clearInterval(timer)
      void ctx?.close()
    }
  }, [audioTrack, audioEnabled])

  // F-40：低频上报活跃说话人 + 说话状态控制面广播（250ms 采样；store 内同值幂等不触发重渲染）
  useEffect(() => {
    if (!speakKey) return
    const timer = setInterval(() => {
      const speaking = !!isLocal && levelRef.current > SPEAK_THRESHOLD
      // 本端说话状态广播（边沿去抖在 controller.sendSpeaking 内）：远端 tile 光环的数据源
      if (isLocal) controller.sendSpeaking(speaking)
      const store = useVeil.getState()
      if (speaking) {
        store.setActiveSpeaker(speakKey)
      } else if (store.activeSpeaker === speakKey) {
        store.setActiveSpeaker(null)
      }
    }, REPORT_MS)
    return () => {
      clearInterval(timer)
      // 卸载时若本 tile 正是活跃说话人，让位（避免 spotlight 钉在已卸载画面上）
      if (isLocal && useVeil.getState().activeSpeaker === speakKey) useVeil.getState().setActiveSpeaker(null)
    }
  }, [speakKey, isLocal])

  // 渲染期推导：当前流没有音轨时音频解锁提示无意义
  const noAudio = !isLocal && !!stream && stream.getAudioTracks().length === 0
  const q = networkGradeLabel(stats?.rttMs, stats?.lossPct)
  // 电平表：无有效音轨时直接渲染为 0，避免在 effect 内同步 setState
  const displayLevel = audioEnabled ? level : 0
  // 说话者高亮：本地 = AGC 归一化电平；远端 = 控制面广播状态（两端看到的光环永远一致）
  const speaking = isLocal ? displayLevel > SPEAK_THRESHOLD : !!remoteSpeaking
  // 远端闭麦/关摄（控制面权威；undefined = 旧版本对端，回退轨道推断）
  const remoteMuted = !isLocal && remoteMicOn === false
  const remoteCamOff = !isLocal && remoteCamOn === false
  const hasLiveVideo = !!stream && stream.getVideoTracks().some((tr) => tr.readyState === 'live' && tr.enabled)
  const showOff = isLocal
    ? (camOff || !hasLiveVideo) && !screenSharing
    : remoteCamOff || !hasLiveVideo
  // 连接状态呼吸光圈：connecting 琥珀脉冲 / connected 翡翠微光 / failed 红色描边（仅远端块）
  const ringCls = speaking
    ? 'veil-tile-speaking border-emerald-400'
    : isLocal
      ? ''
      : connState === 'connected'
        ? 'veil-tile-connected border-emerald-500/40'
        : connState === 'failed'
          ? 'border-red-500/50'
          : connState
            ? 'veil-tile-connecting border-amber-500/50'
            : ''
  const connLabel =
    !connState || connState === 'connecting'
      ? t.tile.negotiating
      : connState === 'connected'
        ? t.tile.connected
        : connState === 'failed'
          ? t.tile.connFailed
          : connState

  return (
    <div
      className={cn(
        'group relative aspect-video w-full animate-in overflow-hidden rounded-2xl border bg-zinc-950 shadow-lg shadow-black/10 fade-in zoom-in-[0.98] duration-300 dark:shadow-black/50',
        ringCls || 'border-border/60',
      )}
    >
      {/* 视频（全程静音只管画面；远端声音走下方专用 audio 元素，iOS 手势解锁）
          共享流 object-contain：屏幕画面必须完整可见（iPad 横屏共享/任意比例内容
          旋转自适应不被裁切），人物摄像头流仍 object-cover 铺满；
          手动旋转（Task 30）：90/270° 时宽高互换（盒子高作元素宽），居中旋转铺满不裁切 */}
      <div ref={boxRef} className="absolute inset-0 overflow-hidden">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={
            rotated
              ? {
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: boxSize.h || '100%',
                  height: boxSize.w || '100%',
                  transform: `translate(-50%, -50%) rotate(${rot}deg)`,
                }
              : rot
                ? { transform: `rotate(${rot}deg)` }
                : undefined
          }
          className={cn(
            'h-full w-full transition-opacity',
            screenSharing ? 'object-contain' : 'object-cover',
            isLocal && !screenSharing && mirrorSelf && '-scale-x-100',
            showOff ? 'opacity-0' : 'opacity-100',
          )}
        />
        {/* 旋转控制（仅共享 tile；触屏无 hover 常显，桌面半透明） */}
        {screenSharing && onRotate && !showOff && (
          <div className="absolute right-2 top-11 z-10 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onRotate(-90)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900/75 text-zinc-100 opacity-80 shadow-md backdrop-blur transition-all hover:scale-110 hover:bg-zinc-900 hover:opacity-100 active:scale-90"
              aria-label={t.tile.rotateLeft}
              title={t.tile.rotateLeft}
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              onClick={() => onRotate(90)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900/75 text-zinc-100 opacity-80 shadow-md backdrop-blur transition-all hover:scale-110 hover:bg-zinc-900 hover:opacity-100 active:scale-90"
              aria-label={t.tile.rotateRight}
              title={t.tile.rotateRight}
            >
              <RotateCw size={13} />
            </button>
          </div>
        )}
      </div>
      {/* 远端专用音频出口（视频元素静音后，iOS 上音频必须独立元素才能可靠播放） */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline className="hidden" aria-hidden />}

      {/* 关摄/仅数据 占位（自定义头像优先；远端主动关摄时给出明确文案） */}
      {showOff && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-900 to-zinc-800">
          {avatar ? (
            <img
              src={avatar}
              alt={fmt(t.tile.avatarAlt, { name })}
              className="h-16 w-16 rounded-full border-2 border-emerald-500/30 object-cover shadow-lg"
              draggable={false}
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-2xl font-bold text-emerald-400">
              {(name || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <VideoOff size={12} />
            {isLocal ? t.tile.camOffLocal : remoteCamOff ? t.tile.camOffRemoteBadge : peerId ? t.tile.camOffRemote : t.tile.waitingVideo}
          </div>
        </div>
      )}

      {/* 自动播放被拦截：一键重试（仅恢复画面；声音由音频元素独立管理） */}
      {playBlocked && !showOff && (
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current
            if (!v) return
            v.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true))
          }}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 text-xs font-medium text-white backdrop-blur-[2px] transition-colors hover:bg-black/30"
          aria-label={t.tile.tapToPlay}
        >
          <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5">
            <Play size={12} /> {t.tile.tapToPlay}
          </span>
        </button>
      )}

      {/* 远端音频未解锁：点击即解锁（iOS 严格自动播放策略的显式兜底入口） */}
      {audioBlocked && !noAudio && !showOff && (
        <button
          type="button"
          onClick={() => {
            const a = audioRef.current
            if (!a) return
            a.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true))
          }}
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 text-xs font-medium text-white backdrop-blur-[2px] transition-colors hover:bg-black/35"
          aria-label={t.tile.tapForAudio}
        >
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/90 px-3 py-1.5 shadow-lg shadow-emerald-900/40">
            <Volume2 size={13} /> {t.tile.tapForAudio}
          </span>
        </button>
      )}

      {/* 连接失败显式覆盖层（BUG-16 教训：信令在线 ≠ 媒体通；failed 必须高可见 + 给出修复动作） */}
      {!isLocal && connState === 'failed' && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-red-950/60 to-black/70 backdrop-blur-[2px]"
          role="alert"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/20 text-red-300">
            <WifiOff size={18} />
          </span>
          <p className="max-w-[85%] text-center text-[11px] leading-relaxed text-red-100">{t.tile.failedHint}</p>
          <button
            type="button"
            onClick={() => controller.restartIce()}
            className="mt-0.5 flex items-center gap-1.5 rounded-full bg-red-500/85 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg shadow-red-900/40 transition-all hover:bg-red-500 active:scale-95"
          >
            <RefreshCcw size={11} /> {t.tile.retryConn}
          </button>
        </div>
      )}

      {/* 顶部状态行 */}
      <div className="absolute left-3 top-3 flex items-center gap-1.5">
        {handRaised && (
          <span
            className="veil-hand-pop flex h-7 w-7 items-center justify-center rounded-full bg-amber-400 text-base shadow-lg shadow-amber-500/40"
            title={t.control.raiseHand}
            aria-label={t.control.raiseHand}
          >
            <Hand size={13} className="text-amber-950" strokeWidth={2.5} />
          </span>
        )}
        {screenSharing && (
          <span className="flex items-center gap-1 rounded-full bg-violet-500/85 px-2 py-0.5 text-[10px] font-medium text-white">
            <MonitorUp size={10} /> {t.tile.screenShare}
          </span>
        )}
        {isLocal ? (
          <span className="rounded-full bg-zinc-900/70 px-2 py-0.5 text-[10px] text-zinc-200 backdrop-blur">{t.tile.local}</span>
        ) : (
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur', connState === 'connected' ? 'bg-emerald-600/80' : 'bg-amber-600/80')}>
            {connLabel}
          </span>
        )}
      </div>

      {/* 质量徽标（优/良/中/差 四档 + 点微光） */}
      {!isLocal && stats && (
        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-zinc-900/70 px-2 py-0.5 text-[10px] text-zinc-200 backdrop-blur" title={q.grade.desc}>
          <span className={cn('veil-qdot h-1.5 w-1.5 rounded-full text-inherit', q.cls)} />
          {q.label}
          {stats.video?.fps ? <span className="text-zinc-400">· {stats.video.fps}fps</span> : null}
        </div>
      )}

      {/* F-41 反应气泡：右上角弹出（覆盖质量徽标上方，避免遮挡） */}
      {bubbleEmoji && (
        <span
          key={bubbleEmoji}
          className="veil-bubble-pop pointer-events-none absolute right-2 top-9 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-lg shadow-lg shadow-black/20 dark:bg-zinc-900/95"
          aria-label={`${name} ${bubbleEmoji}`}
        >
          {bubbleEmoji}
        </span>
      )}

      {/* E2EE 盾标（帧加密协商降级时显示 DTLS 传输加密徽标，诚实呈现实际加密层级） */}
      {!isLocal && (
        frameE2EE === false ? (
          <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-300 backdrop-blur" title={t.tile.dtlsBadge}>
            <ShieldCheck size={10} /> DTLS
          </span>
        ) : (
          <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 backdrop-blur" title={t.tile.e2eeBadge}>
            <ShieldCheck size={10} /> E2EE
          </span>
        )
      )}

      {/* 底部信息条 */}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2.5 pt-8">
        <span className="truncate text-xs font-medium text-white">{name}</span>
        {/* 闭麦徽标：本地直接读状态；远端用控制面同步的 micOn（undefined=旧版对端不显示） */}
        {(isLocal ? !micOn : remoteMuted) && (
          <span className="flex items-center gap-1 rounded bg-red-500/85 px-1.5 py-0.5 text-[10px] text-white">
            <MicOff size={10} /> {t.tile.muted}
          </span>
        )}
        <div className="ml-auto flex h-3 items-end gap-0.5">
          {[0.25, 0.5, 0.75, 1].map((th) => (
            <span
              key={th}
              className={cn(
                'w-0.5 rounded-sm transition-colors',
                (isLocal ? displayLevel : remoteSpeaking ? 1 : 0) >= th ? 'bg-emerald-400' : 'bg-white/20',
              )}
              style={{ height: `${4 + th * 8}px` }}
            />
          ))}
        </div>
      </div>

      {/* 私信入口（仅远端 tile；hover 浮现） */}
      {onDm && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDm()
          }}
          className="absolute bottom-2.5 right-3 z-10 flex h-7 items-center gap-1 rounded-full bg-emerald-600/90 px-2.5 text-[10px] font-medium text-white opacity-0 shadow-lg shadow-emerald-900/40 transition-all duration-150 hover:bg-emerald-500 active:scale-95 group-hover:opacity-100"
          aria-label={`${t.tile.dmOpen} ${name}`}
          title={t.tile.dmOpen}
        >
          <MessageCircle size={11} /> {t.tile.dmOpen}
        </button>
      )}
    </div>
  )
}
