'use client';

/**
 * VeilApp — 根组件：布局骨架（header / 主区 / sticky footer）+ 全局键盘快捷键 + 全屏拖拽投递
 *  - lobby 阶段：大厅（创建/加入房间 + 自检 + 能力介绍）
 *  - in-room 阶段：通话舞台（视频网格 + 控制条 + 侧面板）
 *
 * 快捷键（输入框聚焦时自动跳过）：M 麦克风 / V 摄像头 / S 屏幕共享 / R 录制 / N 成员列表 / ? 帮助
 * 拖拽：房间内向窗口任意位置拖入文件 → 全屏加密投递 overlay → 松手即走加密文件管线
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, UploadCloud, WifiOff } from 'lucide-react'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { toast } from '@/hooks/use-toast'
import { LangBoot, useDict } from '@/lib/i18n/use-dict'
import { fmt } from '@/lib/i18n'
import { HeaderBar } from './header-bar'
import { Lobby } from './lobby'
import { Stage } from './stage'
import { StatusView } from './status-view'
import { AdminView } from './admin-view'
import { FooterBar } from './footer-bar'
import { ShortcutsDialog } from './shortcuts-dialog'
import { PWARegister } from './pwa-register'

/**
 * AudioOutputBoot：音频输出设备（扬声器/蓝牙耳机）全局应用 —— store.audioOutputId 变化
 * 或新对端音频元素挂载（peers 数量变化）时，对页面全部 <audio> 调 setSinkId（Chrome/Edge）。
 */
function AudioOutputBoot() {
  const audioOutputId = useVeil((s) => s.audioOutputId)
  const peerCount = useVeil((s) => Object.keys(s.peers).length)
  useEffect(() => {
    if (!audioOutputId || typeof document === 'undefined') return
    document.querySelectorAll('audio').forEach((a) => {
      const el = a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
      try {
        el.setSinkId?.(audioOutputId).catch(() => {})
      } catch { /* noop */ }
    })
  }, [audioOutputId, peerCount])
  return null
}

/**
 * ConnectionGuard（Task 30「媒体连接失败时全页提示正在重连」）：
 * 房间内任意对端媒体连接 disconnected/failed 或信令断开 → 顶部居中浮层提示，
 * 并自动触发一次 ICE 重启（15s 冷却，防风暴）；全部恢复后自动消失。
 */
function ConnectionGuard() {
  const phase = useVeil((s) => s.phase)
  const signaling = useVeil((s) => s.signaling)
  const peers = useVeil((s) => s.peers)
  const t = useDict()
  const lastKickRef = useRef(0)
  const list = Object.values(peers)
  const mediaBad = list.some((p) => p.connState === 'disconnected' || p.connState === 'failed')
  const sigBad = signaling === 'offline'
  const active = phase === 'in-room' && list.length > 0 && (mediaBad || sigBad)

  useEffect(() => {
    if (!active || !mediaBad) return
    const now = Date.now()
    if (now - lastKickRef.current < 15000) return
    lastKickRef.current = now
    controller.restartIce()
  }, [active, mediaBad])

  if (!active) return null
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed left-1/2 top-3 z-[75] flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-amber-500/40 bg-amber-500/95 px-4 py-2 shadow-xl shadow-amber-900/20 backdrop-blur dark:bg-amber-600/90"
    >
      {mediaBad ? <WifiOff size={14} className="shrink-0 text-amber-950" /> : <Loader2 size={14} className="shrink-0 animate-spin text-amber-950" />}
      <span className="text-xs font-bold text-amber-950">{t.app.reconnecting}</span>
      <span className="hidden text-[10px] text-amber-900/80 sm:inline">{t.app.reconnectingDesc}</span>
    </div>
  )
}

export function VeilApp() {
  const phase = useVeil((s) => s.phase)
  const t = useDict()
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)
  /** 服务器状态视图（/?view=status）：独立仪表页，不依赖房间/大厅状态 */
  const [statusView, setStatusView] = useState(false)
  /** 管理员控制台视图（/?view=admin）：密码门后进入，不依赖房间/大厅状态 */
  const [adminView, setAdminView] = useState(false)

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('view') === 'status') setStatusView(true)
    if (p.get('view') === 'admin') setAdminView(true)
    // 管理员身份恢复：本会话曾通过密码门（sessionStorage）→ 管理入口全程解锁 + socket 管理员鉴权（跨房踢人/免审入房）
    if (sessionStorage.getItem('veil-admin-pass')) {
      useVeil.getState().set({ adminUnlocked: true })
      const saved = sessionStorage.getItem('veil-admin-pass')
      if (saved) void controller.notifyAdminUnlock(saved).catch(() => {})
    }
  }, [])

  // 应用启动即拉取管理员全局画质默认档（信令 /svc/config；失败静默走本地兜底）
  useEffect(() => {
    void (async () => {
      const { fetchServerConfig } = await import('@/lib/admin-client')
      const tier = await fetchServerConfig()
      if (tier) useVeil.getState().set({ serverDefaultQuality: tier })
    })()
  }, [])

  // 全局：离开页面前通知信令服务器（台账记录优雅离场）
  useEffect(() => {
    const handler = () => {
      // sendBeacon 语义不可用于 socket.io，这里依赖 disconnect 事件兜底
      window.dispatchEvent(new CustomEvent('veil:unload'))
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // 全局键盘快捷键（输入控件聚焦时跳过，避免干扰打字）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT')
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const st = useVeil.getState()
      switch (e.key) {
        case 'm':
        case 'M':
          if (st.phase === 'in-room' && st.localStream) {
            e.preventDefault()
            controller.toggleMic()
          }
          break
        case 'v':
        case 'V':
          if (st.phase === 'in-room' && st.localStream) {
            e.preventDefault()
            controller.toggleCam()
          }
          break
        case 's':
        case 'S':
          if (st.phase === 'in-room') {
            e.preventDefault()
            void controller.toggleScreen()
          }
          break
        case 'r':
        case 'R':
          if (st.phase === 'in-room') {
            e.preventDefault()
            void controller.toggleRecording()
          }
          break
        case 'n':
        case 'N':
          if (st.phase === 'in-room') {
            e.preventDefault()
            st.set({ showMembers: !st.showMembers })
          }
          break
        case 'h':
        case 'H':
          if (st.phase === 'in-room') {
            e.preventDefault()
            controller.toggleHand()
          }
          break
        case 'f':
        case 'F':
          if (st.phase === 'in-room') {
            e.preventDefault()
            // 全屏根元素在 Stage 组件内部（stageRef），跨组件用事件桥接
            window.dispatchEvent(new CustomEvent('veil:toggle-fullscreen'))
          }
          break
        case 'g':
        case 'G':
          if (st.phase === 'in-room') {
            e.preventDefault()
            const nextLayout = st.stageLayout === 'grid' ? 'spotlight' : 'grid'
            st.set({ stageLayout: nextLayout })
            try {
              localStorage.setItem('veil-stage-layout', nextLayout)
            } catch { /* noop */ }
          }
          break
        case '?':
          e.preventDefault()
          st.set({ showShortcuts: !st.showShortcuts })
          break
        case 'Escape':
          if (st.showShortcuts) st.set({ showShortcuts: false })
          if (st.showMembers) st.set({ showMembers: false })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ------- F-26 全屏拖拽加密投递（仅房间内启用；dragenter 计数防子元素闪烁） ------- */
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (!hasFiles(e) || useVeil.getState().phase !== 'in-room') return
      e.preventDefault()
      dragDepth.current++
      setDropActive(true)
    },
    [],
  )

  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e) || useVeil.getState().phase !== 'in-room') return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    if (useVeil.getState().phase !== 'in-room') return
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length === 0) return
    let queued = 0
    for (const f of files) queued += controller.sendFile(f)
    const total = files.reduce((n, f) => n + f.size, 0)
    if (queued > 0) {
      toast({
        title: fmt(t.app.dropQueued, { count: files.length }),
        description: `${(total / 1024).toFixed(0)} KB · ${t.app.dropQueuedDesc}`,
      })
      useVeil.getState().pushLog('crypto', `拖拽投递 ${files.length} 个文件`, `queued=${queued}`)
      useVeil.setState({ activeTab: 'files' })
    } else {
      toast({ title: t.app.dropNoPeer, description: t.app.dropNoPeerDesc, variant: 'destructive' })
    }
  }, [t])

  useEffect(() => {
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [onDragEnter, onDragOver, onDragLeave, onDrop])

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      {/* 背景装饰层（光斑缓慢漂浮） */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="veil-blob-a absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl dark:bg-emerald-400/10" />
        <div className="veil-blob-b absolute bottom-0 right-0 h-[320px] w-[420px] rounded-full bg-teal-500/5 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.14)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      </div>

      {statusView ? (
        <main className="flex w-full flex-1 flex-col">
          <StatusView />
        </main>
      ) : adminView ? (
        <main className="flex w-full flex-1 flex-col">
          <AdminView />
        </main>
      ) : (
        <>
          <HeaderBar />
          <main className="flex w-full flex-1 flex-col">{phase === 'in-room' ? <Stage /> : <Lobby />}</main>
        </>
      )}

      <FooterBar />
      <ConnectionGuard />
      <AudioOutputBoot />
      <ShortcutsDialog />
      <PWARegister />
      <LangBoot />

      {/* 全屏拖拽投递 overlay（房间内拖入文件时出现） */}
      {dropActive && (
        <div
          className="veil-drop-overlay fixed inset-0 z-[80] flex items-center justify-center bg-emerald-500/10 backdrop-blur-sm"
          role="region"
          aria-label={t.app.dropAria}
        >
          <div className="veil-drop-box flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-emerald-500/70 bg-background/80 px-10 py-8 shadow-2xl shadow-emerald-500/20">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <UploadCloud size={28} />
            </span>
            <span className="text-base font-bold text-foreground">{t.app.dropTitle}</span>
            <span className="max-w-[260px] text-center text-xs leading-relaxed text-muted-foreground">
              {t.app.dropDesc}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
