'use client';

/**
 * MembersDialog — 房间成员列表：成员状态、连接质量、应用层 RTT、E2EE 模式、安全码快捷核对
 * 房间治理（F-28）：房主可锁定房间（拒绝新成员）与移出成员（两段确认）；状态由信令权威同步
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { useVeil, type PeerUI } from '@/store/veil-store'
import { networkGrade } from '@/lib/webrtc/quality'
import { controller } from '@/lib/webrtc/controller'
import { Check, Copy, Crown, Lock, LockOpen, MessageSquarePlus, MicOff, Monitor, ShieldCheck, UserMinus, Users, Video, VideoOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmt, type Dict } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

/** 连接状态 → 展示色（cls 是样式不是文案，保留在模块级；文案走 t.members.st*） */
const STATE_CLS: Record<string, string> = {
  connected: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  connecting: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-500',
  disconnected: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  closed: 'text-muted-foreground',
  new: 'text-muted-foreground',
  checking: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
}

/** 连接状态文案映射（字典），回退协商中（与旧 STATE_LABEL 回退行为一致） */
function stateText(t: Dict['members'], connState: string | undefined): string {
  const m: Record<string, string> = {
    connected: t.stConnected,
    connecting: t.stConnecting,
    failed: t.stFailed,
    disconnected: t.stDisconnected,
    closed: t.stClosed,
    new: t.stNew,
    checking: t.stChecking,
  }
  return m[connState || ''] || t.stConnecting
}

/** 网络质量文案：按 networkGrade 的稳定档位键（quality.ts F-36）映射到字典；展示文案随语言变化，不作映射键 */
function qualityLabel(p: PeerUI, t: Dict['members']): { text: string; cls: string } {
  const g = networkGrade(p.stats?.rttMs, p.stats?.lossPct)
  const text =
    g.key === 'good' ? t.qGood : g.key === 'ok' ? t.qOk : g.key === 'fair' ? t.qFair : g.key === 'poor' ? t.qPoor : t.qSampling
  return { text, cls: g.dotCls }
}

function MemberRow({
  name,
  isSelf,
  peer,
  verified,
  onVerify,
  isHost,
  hostView,
  avatar,
  onDm,
  dmActive,
}: {
  name: string
  isSelf?: boolean
  peer?: PeerUI
  verified: boolean
  onVerify: () => void
  /** 该成员是否是房主（皇冠标记） */
  isHost?: boolean
  /** 本端是否房主（决定是否显示治理按钮） */
  hostView?: boolean
  /** 自定义头像（96px dataURL） */
  avatar?: string
  /** 发起私信（非自己成员传入） */
  onDm?: () => void
  /** 当前私信会话对象高亮 */
  dmActive?: boolean
}) {
  const t = useDict()
  const st = { text: stateText(t.members, peer?.connState), cls: STATE_CLS[peer?.connState || ''] || STATE_CLS.connecting }
  const q = peer ? qualityLabel(peer, t.members) : null
  const [copied, setCopied] = useState(false)
  // 两段式移出确认：第一次点击进入待确认态，3s 内再点生效（避免误触且不引入额外交互组件）
  const [kickArmed, setKickArmed] = useState(false)
  const kickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (kickTimer.current) clearTimeout(kickTimer.current)
  }, [])

  const armKick = () => {
    setKickArmed(true)
    if (kickTimer.current) clearTimeout(kickTimer.current)
    kickTimer.current = setTimeout(() => setKickArmed(false), 3000)
  }

  const doKick = () => {
    if (kickTimer.current) clearTimeout(kickTimer.current)
    setKickArmed(false)
    if (peer) {
      controller.kickPeer(peer.socketId, name)
      toast({ title: t.members.toastKicked, description: fmt(t.members.toastKickedDesc, { name }) })
    }
  }

  const copySafety = async () => {
    if (!peer?.safety) return
    try {
      await navigator.clipboard.writeText(peer.safety)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast({ title: t.members.safetyCopied, description: t.members.safetyCopiedDesc })
    } catch {
      toast({ title: t.members.copyFailed, variant: 'destructive' })
    }
  }

  return (
    <div
      style={{ animationDelay: isSelf ? '0ms' : undefined }}
      className={cn(
        'veil-member-row rounded-xl border p-3 transition-colors',
        isSelf ? 'border-emerald-500/30 bg-emerald-500/[0.05]' : 'border-border/60 bg-card hover:bg-muted/30',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold',
            isSelf ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/25' : 'bg-muted text-foreground',
          )}
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            (name || '?').slice(0, 1).toUpperCase()
          )}
          {q && <span className={cn('veil-qdot absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background', q.cls)} title={q.text} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold">{name}</span>
            {isSelf && (
              <Badge variant="outline" className="gap-0.5 border-emerald-500/40 px-1 text-[9px] text-emerald-600 dark:text-emerald-300">
                <Crown size={8} /> {t.members.me}
              </Badge>
            )}
            {isHost && !isSelf && (
              <Badge variant="outline" className="veil-lock-pop gap-0.5 border-amber-500/40 px-1 text-[9px] text-amber-600 dark:text-amber-300">
                <Crown size={8} /> {t.members.host}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            {peer ? (
              <>
                <span className={cn('font-medium', q?.cls.replace('bg-', 'text-'))}>{q?.text}</span>
                {peer.stats?.rttMs != null && <span className="tabular-nums">RTT {Math.round(peer.stats.rttMs)}ms</span>}
                {peer.stats?.appRttMs != null && <span className="tabular-nums">{fmt(t.members.appRttMs, { ms: Math.round(peer.stats.appRttMs) })}</span>}
              </>
            ) : (
              <span>{useVeil.getState().signaling === 'online' ? t.members.selfSigOnline : t.members.selfSigOffline}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onDm && (
            <button
              onClick={onDm}
              className={cn(
                'flex h-6 items-center gap-1 rounded-md px-1.5 text-[9px] font-medium transition-all active:scale-95',
                dmActive
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                  : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-300',
              )}
              title={t.chat.dmWith.replace('{name}', name)}
              aria-label={t.chat.dmWith.replace('{name}', name)}
            >
              <MessageSquarePlus size={11} /> {t.chat.dmBadge}
            </button>
          )}
          {peer && (
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/60 text-muted-foreground" title={peer.stream ? t.members.videoOn : t.members.videoOff}>
              {peer.stream ? <Video size={12} className="text-emerald-500" /> : <VideoOff size={12} />}
            </span>
          )}
          {peer && peer.micOn === false && (
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-red-500/15 text-red-500" title={t.tile.muted}>
              <MicOff size={12} />
            </span>
          )}
          {peer && (
            <Badge variant="outline" className={cn('text-[9px]', st.cls)}>
              {st.text}
            </Badge>
          )}
        </div>
      </div>

      {/* 对端安全码快捷核对 */}
      {peer && (
        <>
          <Separator className="my-2.5" />
          <div className="flex items-center gap-2">
            <ShieldCheck size={12} className="shrink-0 text-teal-500" />
            <span className="truncate font-mono text-[10px] font-bold tracking-wider text-teal-600 dark:text-teal-300" title={peer.safety}>
              {peer.safety || t.members.safetyPending}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {peer.safety && (
                <Button size="icon" variant="ghost" className="h-6 w-6 transition-transform active:scale-90" onClick={copySafety} aria-label={t.members.copySafety}>
                  {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                </Button>
              )}
              {peer.safety && !verified && (
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] transition-all hover:border-emerald-500/50 hover:text-emerald-600 active:scale-[0.96] dark:hover:text-emerald-300" onClick={onVerify}>
                  {t.members.markVerified}
                </Button>
              )}
              {verified && (
                <Badge variant="outline" className="gap-0.5 border-emerald-500/40 text-[9px] text-emerald-600 dark:text-emerald-300">
                  <Check size={8} /> {t.members.verified}
                </Badge>
              )}
            </div>
          </div>
          {/* E2EE 模式 + 成员治理 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground">
            <Monitor size={9} className="shrink-0" />
            <span className="whitespace-nowrap">{fmt(t.members.e2eeInfo, { video: peer.e2ee.video, audio: peer.e2ee.audio })}</span>
            <span className="whitespace-nowrap">{fmt(t.members.e2eeRecvInfo, { video: peer.e2eeRecv?.video || 'pending', audio: peer.e2eeRecv?.audio || 'pending' })}</span>
            <span className="ml-auto flex items-center gap-1">
              {hostView && (
                <button
                  onClick={kickArmed ? doKick : armKick}
                  className={cn(
                    'veil-gov-btn inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border px-1.5 text-[9px] transition-all active:scale-95',
                    kickArmed
                      ? 'veil-kick-arm border-red-500/60 bg-red-500/15 font-semibold text-red-600 dark:text-red-300'
                      : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-red-500/40 hover:text-red-500',
                  )}
                  aria-label={kickArmed ? fmt(t.members.kickConfirmAria, { name }) : fmt(t.members.kickAria, { name })}
                  title={kickArmed ? t.members.kickConfirmTitle : t.members.kickTitle}
                >
                  <UserMinus size={9} /> {kickArmed ? t.members.kickConfirm : t.members.kick}
                </button>
              )}
              <button
                onClick={() => controller.requestMute(peer.socketId, 'audio')}
                className="veil-gov-btn inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-border/60 bg-muted/40 px-1.5 text-[9px] text-muted-foreground transition-all hover:border-red-500/40 hover:text-red-500 active:scale-95"
                aria-label={fmt(t.members.muteAria, { name })}
                title={t.members.muteTitle}
              >
                <MicOff size={9} /> {t.members.mute}
              </button>
              <button
                onClick={() => controller.requestMute(peer.socketId, 'video')}
                className="veil-gov-btn inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-border/60 bg-muted/40 px-1.5 text-[9px] text-muted-foreground transition-all hover:border-red-500/40 hover:text-red-500 active:scale-95"
                aria-label={fmt(t.members.camOffAria, { name })}
                title={t.members.camOffTitle}
              >
                <VideoOff size={9} /> {t.members.camOff}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

export function MembersDialog() {
  const peers = useVeil((s) => s.peers)
  const myName = useVeil((s) => s.myName)
  const myAvatar = useVeil((s) => s.myAvatar)
  const activeDm = useVeil((s) => s.activeDm)
  const openDm = useVeil((s) => s.openDm)
  const open = useVeil((s) => s.showMembers)
  const setOpen = useVeil((s) => s.set)
  const socketId = useVeil((s) => s.socketId)
  const hostSocketId = useVeil((s) => s.hostSocketId)
  const roomLocked = useVeil((s) => s.roomLocked)
  const t = useDict()
  const isHostView = !!hostSocketId && hostSocketId === socketId
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const list = Object.values(peers)

  return (
    <Dialog open={open} onOpenChange={(v) => setOpen({ showMembers: v })}>
      <DialogTrigger asChild>
        <Badge
          variant="outline"
          className="hidden cursor-pointer gap-1 border-violet-500/30 bg-violet-500/10 text-[11px] text-violet-600 transition-all hover:bg-violet-500/20 hover:shadow-md hover:shadow-violet-500/20 active:scale-[0.96] sm:inline-flex dark:text-violet-300"
          title={isHostView ? t.members.hostTriggerTitle : t.members.viewTitle}
        >
          {isHostView ? <Crown size={11} className="text-amber-500" /> : <Users size={11} />}
          {list.length + 1}
        </Badge>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-md overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users size={15} className="text-violet-500" />
            {fmt(t.members.title, { count: list.length + 1 })}
            {isHostView && (
              <Badge variant="outline" className="gap-0.5 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300">
                <Crown size={9} /> {t.members.youAreHost}
              </Badge>
            )}
            {roomLocked && (
              <Badge variant="outline" className="veil-lock-pop gap-0.5 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300">
                <Lock size={9} /> {t.members.locked}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t.members.desc}
            {isHostView && t.members.descHost}
          </DialogDescription>
        </DialogHeader>

        {/* 房间治理：房主可锁定/解锁（信令权威校验，非房主不可见） */}
        {isHostView && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
            {roomLocked ? <Lock size={14} className="shrink-0 text-amber-500" /> : <LockOpen size={14} className="shrink-0 text-amber-500" />}
            <div className="min-w-0 flex-1 leading-snug">
              <div className="text-[11px] font-semibold">{roomLocked ? t.members.admissionLocked : t.members.admissionOpen}</div>
              <div className="text-[10px] text-muted-foreground">
                {roomLocked ? t.members.lockedHint : t.members.openHint}
              </div>
            </div>
            <Button
              size="sm"
              variant={roomLocked ? 'default' : 'outline'}
              className={cn(
                'h-7 px-3 text-[11px] transition-all active:scale-[0.96]',
                roomLocked
                  ? 'bg-amber-600 text-white hover:bg-amber-700'
                  : 'border-amber-500/40 text-amber-600 hover:border-amber-500/60 hover:text-amber-700 dark:text-amber-300',
              )}
              onClick={() => controller.toggleRoomLock(!roomLocked)}
            >
              {roomLocked ? t.members.unlock : t.members.lock}
            </Button>
          </div>
        )}
        {!isHostView && roomLocked && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            <Lock size={13} className="shrink-0" />
            {t.members.lockedByHost}
          </div>
        )}

        <div className="-mx-1 max-h-[55vh] space-y-2 overflow-y-auto px-1 pb-1 [scrollbar-width:thin]">
          <MemberRow name={myName || t.members.me} isSelf isHost={isHostView} hostView={false} verified={false} onVerify={() => {}} avatar={myAvatar || undefined} />
          {list.map((p, i) => (
            <div key={p.socketId} style={{ animationDelay: `${(i + 1) * 45}ms` }} className="veil-member-row">
              <MemberRow
                name={p.name || t.members.guest}
                peer={p}
                isHost={p.socketId === hostSocketId}
                hostView={isHostView}
                verified={!!verified[p.socketId]}
                onVerify={() => setVerified((v) => ({ ...v, [p.socketId]: true }))}
                avatar={p.avatar}
                dmActive={activeDm === p.socketId}
                onDm={() => {
                  openDm(p.socketId)
                  setOpen({ activeTab: 'chat', showMembers: false })
                }}
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
