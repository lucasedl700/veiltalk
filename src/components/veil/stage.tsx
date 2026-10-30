'use client';

/**
 * Stage — 通话舞台：媒体错误告警 + 视频网格/聚焦布局 + 控制条 + 侧面板
 *
 * 布局模式（F-29，localStorage 记忆）：
 *  - grid：所有画面等权网格（默认）
 *  - spotlight：聚焦布局 —— 主画面（屏幕共享 > 远端画面 > 本地）+ 底部缩略条，点击缩略可置主
 */

import { Button } from '@/components/ui/button'
import { useVeil } from '@/store/veil-store'
import { VideoTile } from './video-tile'
import { ControlBar } from './control-bar'
import { SidePanel } from './side-panel'
import { AlertTriangle, Check, LayoutGrid, Maximize2, MicOff, Focus, Minimize2, RefreshCw, UserPlus, Users, VideoOff, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { controller } from '@/lib/webrtc/controller'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { useDict } from '@/lib/i18n/use-dict'

export function Stage() {
  const localStream = useVeil((s) => s.localStream)
  const localPreviewStream = useVeil((s) => s.localPreviewStream)
  const screenStream = useVeil((s) => s.screenStream)
  const peers = useVeil((s) => s.peers)
  const micOn = useVeil((s) => s.micOn)
  const camOn = useVeil((s) => s.camOn)
  const screenSharing = useVeil((s) => s.screenSharing)
  const myName = useVeil((s) => s.myName)
  const mediaError = useVeil((s) => s.mediaError)
  const muteRequests = useVeil((s) => s.muteRequests)
  const admissionRequests = useVeil((s) => s.admissionRequests)
  const shareRotations = useVeil((s) => s.shareRotations)
  const rotateShare = useVeil((s) => s.rotateShare)
  const stageLayout = useVeil((s) => s.stageLayout)
  const reactions = useVeil((s) => s.reactions)
  const raisedHands = useVeil((s) => s.raisedHands)
  const activeSpeaker = useVeil((s) => s.activeSpeaker)
  const set = useVeil((s) => s.set)
  const openDm = useVeil((s) => s.openDm)
  const t = useDict()
  const [pinned, setPinned] = useState<string | null>(null) // spotlight 手动钉选的 socketId
  const stageRef = useRef<HTMLDivElement>(null) // F-44 全屏根元素

  const peerList = useMemo(() => Object.values(peers), [peers])
  const tileCount = 1 + peerList.length

  // 首次进入房间拉取设备列表；设备热插拔/授权变化时自动重新枚举（F-39，防抖合并连发事件）
  useEffect(() => {
    void controller.refreshDevices()
    const md = navigator.mediaDevices
    if (!md || typeof md.addEventListener !== 'function') return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void controller.refreshDevices(), 400)
    }
    md.addEventListener('devicechange', onChange)
    return () => {
      md.removeEventListener('devicechange', onChange)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // F-44 全屏：能力检测 + fullscreenchange 同步（Esc 退出也保持图标/文案正确）
  const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    if (!canFullscreen) return undefined
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [canFullscreen])
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {
      /* 用户拒绝或环境限制：静默 */
    }
  }, [])

  // F 快捷键桥接：veil-app 全局监听键盘，此处负责真正的全屏切换（stageRef 在本组件）
  useEffect(() => {
    if (!canFullscreen) return undefined
    const onToggle = () => void toggleFullscreen()
    window.addEventListener('veil:toggle-fullscreen', onToggle)
    return () => window.removeEventListener('veil:toggle-fullscreen', onToggle)
  }, [canFullscreen, toggleFullscreen])

  /* ------- 聚焦布局：主画面选择（手动钉选 > 本地共享 > 远端共享 > 活跃说话人 F-40 > 远端有流 > 本地） ------- */
  const spotlightOn = stageLayout === 'spotlight'
  const firstRemoteWithStream = peerList.find((p) => p.stream)
  const firstRemoteSharing = peerList.find((p) => p.sharing && p.stream)
  // F-40 Speaker View：未手动钉选时主画面自动跟随当前说话人（必须是有效且有流的目标）
  const speakerValid =
    activeSpeaker === '__local__' ||
    (activeSpeaker && peers[activeSpeaker] && !!peers[activeSpeaker].stream)
  const mainSocketId =
    pinned && peers[pinned]
      ? pinned
      : screenSharing
        ? '__local__'
        : firstRemoteSharing
          ? firstRemoteSharing.socketId
          : speakerValid && activeSpeaker
            ? activeSpeaker
            : firstRemoteWithStream
              ? firstRemoteWithStream.socketId
              : '__local__'

  // F-41：反应气泡 —— 每个成员键（socketId 或 '__local__'）最近 3s 内最新一次反应
  const bubbleMap = useMemo(() => {
    const now = Date.now()
    const m = new Map<string, string>()
    for (let i = reactions.length - 1; i >= 0; i--) {
      const r = reactions[i]
      if (now - r.ts < 3000 && !m.has(r.socketId)) m.set(r.socketId, r.emoji)
    }
    return m
  }, [reactions])

  const localTile = (
    <VideoTile
      /* 【Task 36】本地加工预览优先：虚拟背景/AI 增强/补帧开启时本地也看到加工后效果
         （原实现只有对端能看到，用户自己看不出任何变化 →「没用」主因）；共享中仍优先展示共享画面 */
      stream={!screenSharing && localPreviewStream ? localPreviewStream : screenSharing && screenStream ? screenStream : localStream}
      name={myName || t.stage.me}
      isLocal
      muted={micOn ? false : true}
      camOff={!camOn}
      screenSharing={screenSharing}
      speakKey="__local__"
      handRaised={!!raisedHands.__local__}
      bubbleEmoji={bubbleMap.get('__local__') || null}
      avatar={useVeil.getState().myAvatar || undefined}
      rotation={shareRotations['__local__'] || 0}
      onRotate={(d) => rotateShare('__local__', d)}
    />
  )

  const remoteTile = (socketId: string) => {
    const p = peers[socketId]
    if (!p) return null
    return (
      <VideoTile
        key={p.socketId}
        stream={p.stream}
        name={p.name || t.stage.guest}
        connState={p.connState}
        stats={p.stats}
        peerId={p.peerId}
        speakKey={p.socketId}
        screenSharing={p.sharing}
        handRaised={!!raisedHands[p.socketId]}
        bubbleEmoji={bubbleMap.get(p.socketId) || null}
        frameE2EE={p.e2ee ? p.e2ee.video !== 'off' : true}
        avatar={p.avatar}
        remoteMicOn={p.micOn}
        remoteCamOn={p.camOn}
        remoteSpeaking={p.speaking}
        rotation={shareRotations[p.socketId] || 0}
        onRotate={(d) => rotateShare(p.socketId, d)}
        onDm={() => {
          openDm(p.socketId)
          set({ activeTab: 'chat', panelOpen: true })
        }}
      />
    )
  }

  return (
    <div ref={stageRef} className="veil-stage-root mx-auto flex w-full max-w-[1600px] flex-1 gap-4 px-4 py-4 sm:px-6">
      {/* 主舞台 */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {mediaError && (
          <div className="flex animate-in fade-in slide-in-from-top-1 flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm duration-300">
            <AlertTriangle size={16} className="shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1 leading-relaxed">
              <span className="font-medium">{t.stage.mediaFail}</span>
              <span className="text-muted-foreground">{mediaError}</span>
              <span className="ml-1 text-muted-foreground">{t.stage.dataModeNote}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void controller.retryMedia()}>
              <RefreshCw size={14} /> {t.stage.retryMedia}
            </Button>
          </div>
        )}

        {/* E2EE 平台回退说明横幅已按需求移除（用户反馈顶部提示噪音）——
            当前加密模式仍可在「加密」面板与诊断中查看，功能不受影响 */}

        {/* 成员治理警示条：静音/关摄像头请求（可一键执行或忽略） */}
        {Object.entries(muteRequests).map(([socketId, req]) => (
          <div
            key={socketId}
            role="alert"
            className="veil-mutebar-in flex flex-wrap items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/[0.08] px-4 py-2.5 text-sm"
          >
            {req.kind === 'audio' ? (
              <MicOff size={16} className="shrink-0 text-violet-500" />
            ) : (
              <VideoOff size={16} className="shrink-0 text-violet-500" />
            )}
            <div className="min-w-0 flex-1 text-xs leading-relaxed">
              <span className="font-semibold">{req.name}</span>
              <span className="text-muted-foreground">{req.kind === 'audio' ? t.stage.muteReqAudio : t.stage.muteReqVideo}</span>
            </div>
            <Button
              size="sm"
              className="h-7 bg-violet-600 px-3 text-[11px] text-white transition-all hover:bg-violet-700 active:scale-[0.96]"
              onClick={() => controller.acceptMuteRequest(socketId, req.kind)}
            >
              {req.kind === 'audio' ? t.stage.muteNowAudio : t.stage.muteNowVideo}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
              onClick={() => controller.dismissMuteRequest(socketId)}
              aria-label={t.stage.ignoreReq}
            >
              <X size={13} /> {t.stage.ignore}
            </Button>
          </div>
        ))}

        {/* 人工审核审批横幅（房主/管理员）：批准即入房 / 拒绝回大厅 */}
        {Object.entries(admissionRequests).map(([socketId, req]) => (
          <div
            key={socketId}
            role="alert"
            className="veil-mutebar-in flex flex-wrap items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/[0.08] px-4 py-2.5 text-sm"
          >
            <UserPlus size={16} className="shrink-0 text-violet-500" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed">
              <span className="font-semibold">{req.name}</span>
              <span className="text-muted-foreground">{t.stage.admissionReq}</span>
            </div>
            <Button
              size="sm"
              className="h-7 bg-emerald-600 px-3 text-[11px] text-white transition-all hover:bg-emerald-700 active:scale-[0.96]"
              onClick={() => controller.respondAdmission(socketId, true)}
            >
              <Check size={12} /> {t.stage.admissionApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-red-500/40 px-3 text-[11px] text-red-500 transition-all hover:bg-red-500/10 active:scale-[0.96]"
              onClick={() => controller.respondAdmission(socketId, false)}
            >
              <X size={12} /> {t.stage.admissionDeny}
            </Button>
          </div>
        ))}

        {/* 布局切换 + 全屏（浮于舞台右上角；仅有一个画面时无意义仍可切换记忆偏好） */}
        <div className="relative min-h-0 flex-1">
          <div
            role="radiogroup"
            aria-label={t.stage.layoutGroup}
            className="absolute right-2 top-2 z-10 flex overflow-hidden rounded-lg border border-border/60 bg-background/70 shadow-sm backdrop-blur-sm"
          >
            <button
              role="radio"
              aria-checked={stageLayout === 'grid'}
              title={t.stage.layoutGrid}
              onClick={() => {
                useVeil.getState().set({ stageLayout: 'grid' })
                try {
                  localStorage.setItem('veil-stage-layout', 'grid')
                } catch { /* noop */ }
              }}
              className={cn(
                'flex h-7 w-8 items-center justify-center text-muted-foreground transition-all hover:text-foreground',
                stageLayout === 'grid' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
              )}
            >
              <LayoutGrid size={13} />
            </button>
            <button
              role="radio"
              aria-checked={stageLayout === 'spotlight'}
              title={t.stage.layoutSpotlight}
              onClick={() => {
                useVeil.getState().set({ stageLayout: 'spotlight' })
                try {
                  localStorage.setItem('veil-stage-layout', 'spotlight')
                } catch { /* noop */ }
              }}
              className={cn(
                'flex h-7 w-8 items-center justify-center text-muted-foreground transition-all hover:text-foreground',
                stageLayout === 'spotlight' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
              )}
            >
              <Focus size={13} />
            </button>
            {/* F-44 全屏（能力检测：不支持 Fullscreen API 的环境如 iOS Safari 隐藏） */}
            {canFullscreen && (
              <button
                onClick={() => void toggleFullscreen()}
                title={isFullscreen ? t.control.exitFullscreen : t.control.fullscreen}
                aria-label={isFullscreen ? t.control.exitFullscreen : t.control.fullscreen}
                aria-pressed={isFullscreen}
                className="flex h-7 w-8 items-center justify-center border-l border-border/60 text-muted-foreground transition-all hover:text-foreground"
              >
                {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            )}
          </div>

          {/* F-41 Emoji 反应浮层：底部向上飘起，动画结束自动出栈 */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-14 z-30 overflow-hidden">
            {reactions.map((r) => {
              // 由 id 稳定 hash 出水平落点（20%~68%），同一反应重放不跳动
              let h = 0
              for (let i = 0; i < r.id.length; i++) h = (h * 31 + r.id.charCodeAt(i)) >>> 0
              const left = 20 + (h % 49)
              const scale = 1 + ((h >> 3) % 3) * 0.18
              return (
                <span
                  key={r.id}
                  onAnimationEnd={() => useVeil.getState().dropReaction(r.id)}
                  className="veil-reaction-float absolute bottom-0 text-4xl leading-none drop-shadow-lg"
                  style={{ left: `${left}%`, fontSize: `${Math.round(36 * scale)}px` }}
                >
                  {r.emoji}
                </span>
              )
            })}
          </div>

          {spotlightOn ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {/* 主画面 */}
              <div key={mainSocketId} className="veil-stage-swap min-h-0 flex-1">
                {mainSocketId === '__local__' ? (
                  localTile
                ) : (
                  remoteTile(mainSocketId)
                )}
              </div>
              {/* 缩略条（其余画面；点击置主，再点取消钉选） */}
              {(() => {
                const thumbs: Array<{ key: string; node: React.ReactNode; id: string; label: string }> = []
                if (mainSocketId !== '__local__') thumbs.push({ key: '__local__', node: localTile, id: '__local__', label: t.stage.me })
                peerList.forEach((p) => {
                  if (p.socketId !== mainSocketId) thumbs.push({ key: p.socketId, node: remoteTile(p.socketId), id: p.socketId, label: p.name })
                })
                if (thumbs.length === 0) return null
                return (
                  <div className="flex shrink-0 gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
                    {thumbs.map((th) => {
                      const pinnedNow = pinned === th.id
                      const pinIt = () => setPinned(pinnedNow || th.id === '__local__' ? null : th.id)
                      return (
                        /* div[role=button] 而非 <button>：缩略图内部含 VideoTile 的
                           私信/播放/重试等 <button>，HTML 禁止 button 嵌套 button
                           （React 19 水合校验直接报错）；div + 键盘事件保持可达性 */
                        <div
                          key={th.key}
                          role="button"
                          tabIndex={0}
                          aria-pressed={pinnedNow}
                          aria-label={`${pinnedNow ? t.stage.unpin : t.stage.pin} · ${th.label}`}
                          onClick={pinIt}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              pinIt()
                            }
                          }}
                          title={pinnedNow ? t.stage.unpin : t.stage.pin}
                          className={cn(
                            'veil-thumb-in h-20 w-32 shrink-0 cursor-pointer select-none overflow-hidden rounded-xl border-2 bg-card transition-all hover:scale-[1.03] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 sm:h-24 sm:w-40',
                            pinnedNow
                              ? 'veil-spot-ring border-emerald-500/80'
                              : 'border-transparent opacity-80 hover:opacity-100',
                          )}
                        >
                          <div className="pointer-events-none h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover">
                            {th.node}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          ) : (
            <div
              className={`grid min-h-0 h-full gap-3 ${
                tileCount <= 1
                  ? 'grid-cols-1'
                  : tileCount <= 2
                    ? 'grid-cols-1 lg:grid-cols-2'
                    : tileCount <= 4
                      ? 'grid-cols-1 sm:grid-cols-2'
                      : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
              }`}
            >
              {localTile}
              {peerList.map((p) => remoteTile(p.socketId))}

              {peerList.length === 0 && (
                <div className="flex min-h-[240px] animate-in fade-in flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-card/30 p-8 text-center duration-500">
                  <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                    <span aria-hidden className="veil-ping-soft absolute inset-0 rounded-full border border-emerald-500/40" />
                    <Users size={24} className="relative text-emerald-500" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{t.stage.waitingTitle}</div>
                    <div className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                      {t.stage.waitingDesc}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <ControlBar />
      </div>

      <SidePanel />
    </div>
  )
}

export function notifyStageToast(title: string, description?: string) {
  toast({ title, description })
}
