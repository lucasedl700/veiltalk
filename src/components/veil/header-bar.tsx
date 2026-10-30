'use client';

/**
 * HeaderBar — 品牌与全局状态（信令连接、E2EE 模式、房间号）+ 语言/主题切换
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useVeil } from '@/store/veil-store'
import { buildInviteUrl } from '@/lib/webrtc/controller'
import { isAppleWebKitNoFrameE2EE } from '@/lib/webrtc/e2ee-manager'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import { Copy, Check, Gauge, ShieldCheck, Timer, Sun, Moon, Monitor, Languages, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { toast } from '@/hooks/use-toast'
import { MembersDialog } from './members-dialog'
import { QRInviteDialog } from './qr-invite-dialog'

const subscribeNoop = () => () => {}
const mountedClient = () => true
const mountedServer = () => false

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const SIGNALING_CLS: Record<string, string> = {
  idle: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 border-zinc-500/30',
  connecting: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30',
  online: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
  offline: 'bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/30',
}

const THEME_ORDER = ['light', 'dark', 'system'] as const
type ThemeKind = (typeof THEME_ORDER)[number]
const THEME_ICON: Record<ThemeKind, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

export function HeaderBar() {
  const adminUnlocked = useVeil((s) => s.adminUnlocked)
  const signaling = useVeil((s) => s.signaling)
  const e2eeMode = useVeil((s) => s.e2eeMode)
  const roomId = useVeil((s) => s.roomId)
  const joinedTs = useVeil((s) => s.joinedTs)
  const peerCount = useVeil((s) => Object.keys(s.peers).length)
  const lang = useVeil((s) => s.lang)
  // 媒体链路聚合状态：信令在线 ≠ 媒体通；顶部显式区分（BUG-16 真机反馈教训）
  const mediaSummary = useVeil((s) => {
    const states = Object.values(s.peers).map((p) => p.connState)
    if (states.length === 0) return 'idle' as const
    if (states.some((st) => st === 'failed')) return 'failed' as const
    if (states.every((st) => st === 'connected')) return 'connected' as const
    return 'connecting' as const
  })
  const connectedCount = useVeil((s) => Object.values(s.peers).filter((p) => p.connState === 'connected').length)
  const iceProbeBad = useVeil((s) => s.iceProbe.result === 'timeout' || s.iceProbe.result === 'none')
  const t = useDict()
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  // 主题切换（hydration 安全：服务端不渲染具体状态）
  const mounted = useSyncExternalStore(subscribeNoop, mountedClient, mountedServer)
  const { theme, setTheme } = useTheme()
  const current = THEME_ORDER.includes((theme as ThemeKind) || 'system')
    ? ((theme || 'system') as ThemeKind)
    : 'system'
  const themeLabel = { light: t.header.themeLight, dark: t.header.themeDark, system: t.header.themeSystem }[current]
  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]
    setTheme(next)
    const nextLabel = { light: t.header.themeLight, dark: t.header.themeDark, system: t.header.themeSystem }[next]
    toast({ title: fmt(t.header.themeSwitched, { mode: nextLabel }) })
  }
  const toggleLang = () => {
    useVeil.getState().setLang(lang === 'zh' ? 'en' : 'zh')
  }

  // 通话计时器：interval 回调更新（避免 effect 内同步 setState）
  useEffect(() => {
    if (!joinedTs) return
    const iv = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [joinedTs])
  const elapsed = joinedTs ? fmtDuration(tick - joinedTs) : ''

  const sigText = {
    idle: t.header.sigIdle,
    connecting: t.header.sigConnecting,
    online: t.header.sigOnline,
    offline: t.header.sigOffline,
  }[signaling] || t.header.sigIdle
  const sigCls = SIGNALING_CLS[signaling] || SIGNALING_CLS.idle

  /* 媒体链路徽标：idle 不渲染（未入房/无对端时不添坌）；failed 红色高优先可见 */
  const mediaBadge =
    mediaSummary === 'failed'
      ? { text: t.header.mediaFailed, cls: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300 animate-pulse', icon: <WifiOff size={11} />, title: t.header.mediaFailedTitle }
      : mediaSummary === 'connecting'
        ? { text: t.header.mediaConnecting, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', icon: <Wifi size={11} className="animate-pulse" />, title: t.header.mediaConnectingTitle }
        : mediaSummary === 'connected'
          ? { text: t.header.mediaOk, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', icon: <Wifi size={11} />, title: fmt(t.header.mediaOkTitle, { n: connectedCount }) }
          : null

  const copyRoom = async () => {
    if (!roomId) return
    const url = buildInviteUrl(roomId)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast({ title: t.header.inviteCopied, description: fmt(t.header.inviteCopiedDesc, { room: roomId }) })
    } catch {
      toast({ title: t.header.copyFailed, description: url, variant: 'destructive' })
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl dark:border-white/[0.08] dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20 dark:shadow-emerald-400/15">
            <ShieldCheck className="h-4.5 w-4.5 text-white" size={18} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight">
              VeilTalk<span className="veil-lang-swap ml-1.5 text-xs font-medium text-muted-foreground">{lang === 'zh' ? '纱语' : 'Veil'}</span>
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {roomId && (
            <>
              <QRInviteDialog />
              <button
                onClick={copyRoom}
                className="group hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-mono text-xs text-emerald-600 transition-all duration-150 hover:bg-emerald-500/20 hover:shadow-md hover:shadow-emerald-500/20 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 sm:flex dark:text-emerald-300"
                title={t.header.copyInviteTitle}
                aria-label={t.header.copyInvite}
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 shadow-[0_0_6px_rgb(16_185_129/0.8)]" />
                {roomId}
                {copied ? <Check size={12} /> : <Copy size={12} className="opacity-50 group-hover:opacity-100" />}
              </button>
            </>
          )}
          <Badge variant="outline" className={`gap-1.5 text-[11px] ${sigCls}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${signaling === 'online' ? 'animate-pulse bg-emerald-500' : signaling === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-current'}`} />
            {sigText}
          </Badge>
          {/* 媒体链路徽标：信令在线 ≠ 媒体通，显式区分两层连接（点击左侧徽标无动作，纯状态） */}
          {mediaBadge && (
            <Badge
              variant="outline"
              className={`hidden gap-1 text-[11px] sm:inline-flex ${mediaBadge.cls}`}
              title={iceProbeBad && mediaSummary !== 'connected' ? `${mediaBadge.title} · ${t.header.mediaProbeBad}` : mediaBadge.title}
            >
              {mediaBadge.icon}
              {mediaBadge.text}
            </Badge>
          )}
          {joinedTs > 0 && elapsed && (
            <Badge variant="outline" className="hidden gap-1 border-teal-500/30 bg-teal-500/10 font-mono text-[11px] tabular-nums text-teal-600 sm:inline-flex dark:text-teal-300" title={t.header.callDuration}>
              <Timer size={11} />
              {elapsed}
            </Badge>
          )}
          {joinedTs > 0 && (
            <MembersDialog />
          )}
          {/* E2EE 徽标：Apple 平台的回退按设计静默（用户反馈顶部提示噪音，已移除）；
              用户主动关闭（高级设置）中性展示；仅非 Apple 旧浏览器给琥珀升级提示 */}
          {(() => {
            const applePolicy = e2eeMode === 'unsupported' && isAppleWebKitNoFrameE2EE()
            if (applePolicy) return null
            const userOff = e2eeMode === 'unsupported' && !useVeil.getState().e2eeEnabled
            const cls = userOff
              ? 'hidden gap-1 border-violet-500/30 bg-violet-500/10 text-violet-600 sm:inline-flex dark:text-violet-300'
              : e2eeMode === 'unsupported'
                ? 'hidden gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 sm:inline-flex dark:text-amber-300'
                : 'hidden gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 sm:inline-flex dark:text-emerald-300'
            const title =
              e2eeMode === 'unsupported'
                ? userOff
                  ? t.header.e2eeUserOffTitle
                  : t.header.e2eeUnsupportedTitle
                : undefined
            return (
              <Badge variant="outline" className={`gap-1 text-[11px] ${cls}`} title={title}>
                {e2eeMode === 'encoded-streams' && 'E2EE · Encoded Streams'}
                {e2eeMode === 'script-transform' && 'E2EE · ScriptTransform'}
                {e2eeMode === 'unsupported' && (userOff ? t.header.e2eeUserOff : t.header.e2eeUnsupported)}
                {(e2eeMode === 'unknown' || e2eeMode === 'pending') && t.header.e2eePending}
              </Badge>
            )
          })()}
          {/* 服务器状态入口（/?view=status）—— 仅管理员可见（Task 25：服务器诊断不对普通人暴露） */}
          {mounted && adminUnlocked && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground transition-all duration-150 hover:bg-muted/60 hover:text-foreground active:scale-90"
              onClick={() => window.open('/?view=status', '_self')}
              title={t.header.statusEntry}
              aria-label={t.header.statusEntry}
            >
              <Gauge size={15} />
            </Button>
          )}
          {/* 管理员控制台入口（/?view=admin，密码门后进入） */}
          {mounted && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground transition-all duration-150 hover:bg-amber-500/10 hover:text-amber-500 active:scale-90"
              onClick={() => window.open('/?view=admin', '_self')}
              title={t.header.adminEntry}
              aria-label={t.header.adminEntry}
            >
              <ShieldCheck size={15} />
            </Button>
          )}
          {/* F-34 语言切换（zh ⇄ en 无刷新即时生效；记忆入 localStorage） */}
          {mounted && (
            <Button
              size="icon"
              variant="ghost"
              className="veil-lang-flip h-8 w-8 text-muted-foreground transition-all duration-150 hover:bg-muted/60 hover:text-foreground active:scale-90"
              onClick={toggleLang}
              title={t.header.langTitle}
              aria-label={t.header.langAria}
            >
              <Languages size={15} />
            </Button>
          )}
          {mounted && (() => {
            const Icon = THEME_ICON[current]
            return (
              <Button
                size="icon"
                variant="ghost"
                className="veil-theme-flip h-8 w-8 text-muted-foreground transition-all duration-150 hover:bg-muted/60 hover:text-foreground active:scale-90"
                onClick={cycleTheme}
                title={fmt(t.header.themeTitle, { mode: themeLabel })}
                aria-label={fmt(t.header.themeAria, { mode: themeLabel })}
              >
                <Icon size={15} />
              </Button>
            )
          })()}
        </div>
      </div>
    </header>
  )
}
