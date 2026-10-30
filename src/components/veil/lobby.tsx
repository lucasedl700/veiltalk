'use client';

/**
 * Lobby — 极简登录 + 房间向导（2026-10 精简改版）
 *
 * 流程：
 *  1. intro  登录页：logo + 「继续」按钮（仅两个元素；营销文案全部移除）
 *  2. room   房间页：房间号输入 + 探测标签（新房间将创建 / 进行中 N 人 / 需密码 / 需批准）
 *            + 高级设置折叠区（房间密码 / 入会审批 / 昵称头像 / 画质 / E2EE 开关 / 服务器选择）
 *
 * 昵称自动生成（访客-xxxx，可在高级设置修改）；原「起名」「握手动画」两步移除 ——
 * ECDH 身份 + 信令连接 + 帧加密能力探测（controller.prewarm）在进入房间页时后台静默执行。
 * 邀请链接（?room=xxx）仍直达房间页；历史 #pass= 链接仍兼容解析。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { motion, MotionConfig } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/hooks/use-toast'
import { useVeil } from '@/store/veil-store'
import { controller, randomRoomId } from '@/lib/webrtc/controller'
import { QUALITY_TIERS, saveLocalTierPref, type QualityTier } from '@/lib/webrtc/tiers'
import {
  subscribeRecentRooms,
  getRecentRoomsSnapshot,
  getRecentRoomsServerSnapshot,
  removeRecentRoom,
  type RecentRoom,
} from '@/lib/recent-rooms'
import { cn } from '@/lib/utils'
import { fmt, type Dict } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import type { RoomInfo } from '@/lib/webrtc/room-client'
import { ServerPickerPanel } from './server-latency'
import {
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  Dices,
  History,
  Hourglass,
  KeyRound,
  Loader2,
  LogIn,
  Plus,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'

type WizardStep = 'intro' | 'room'

/** 画质档位 → i18n 标签（与设备面板共用 device 命名空间文案） */
function tierLabel(t: Dict, tier: QualityTier): string {
  const map: Record<QualityTier, string> = {
    '360p': t.device.q360,
    '720p': t.device.q720,
    '1080p': t.device.q1080,
    '1080p60': t.device.q1080p60,
    '1440p60': t.device.q1440p60,
    '4k30': t.device.q4k30,
    '4k60': t.device.q4k60,
    '8k60': t.device.q8k60,
    '8k144': t.device.q8k144,
  }
  return map[tier]
}

/** 自动访客昵称：访客-xxxx（4 位小写字母数字，会话内稳定） */
function autoGuestName(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${suffix}`
}

/** 头像压缩：任意图片 → 96×96 JPEG dataURL（≤3KB，信令 join 摘要可承载） */
function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = 96
        c.height = 96
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('canvas unavailable')
        // cover 裁切居中
        const side = Math.min(img.width, img.height)
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 96, 96)
        const data = c.toDataURL('image/jpeg', 0.72)
        URL.revokeObjectURL(url)
        resolve(data)
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

/** 品牌标志（内联 SVG：盾形声波 — E2EE 语音隐喻） */
function BrandMark({ size = 84 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden className="drop-shadow-xl">
      <defs>
        <linearGradient id="vt-g" x1="0" y1="0" x2="96" y2="96">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="55%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <path d="M48 6 86 22v26c0 22-16 36-38 42C26 84 10 70 10 48V22L48 6Z" fill="url(#vt-g)" opacity="0.16" />
      <path d="M48 6 86 22v26c0 22-16 36-38 42C26 84 10 70 10 48V22L48 6Z" stroke="url(#vt-g)" strokeWidth="4" strokeLinejoin="round" />
      <rect x="42" y="36" width="5" height="24" rx="2.5" fill="url(#vt-g)" />
      <rect x="52" y="28" width="5" height="40" rx="2.5" fill="url(#vt-g)" />
      <rect x="62" y="40" width="5" height="16" rx="2.5" fill="url(#vt-g)" />
      <rect x="32" y="42" width="5" height="12" rx="2.5" fill="url(#vt-g)" />
    </svg>
  )
}

export function Lobby() {
  const phase = useVeil((s) => s.phase)
  const myName = useVeil((s) => s.myName)
  const e2eeEnabled = useVeil((s) => s.e2eeEnabled)
  const qualityPref = useVeil((s) => s.qualityPref)
  const t = useDict()
  const [step, setStep] = useState<WizardStep>('intro')
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [roomId, setRoomId] = useState('')
  /** 口令 UI 已按需求移除；保留状态兼容旧 #pass= 链接（握手语义不变，不展示输入框） */
  const [passphrase, setPassphrase] = useState('')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [roomPass, setRoomPass] = useState('')
  const [admissionChoice, setAdmissionChoice] = useState<'auto' | 'manual'>('auto')
  const admissionPending = useVeil((s) => s.admissionPending)
  const passInLink = useVeil((s) => s.passInLink)
  const setStore = useVeil((s) => s.set)
  const fileRef = useRef<HTMLInputElement>(null)
  // 最近房间历史（localStorage 纯本地；useSyncExternalStore 保证 hydration 一致且响应移除操作）
  const recentRooms: RecentRoom[] = useSyncExternalStore(
    subscribeRecentRooms,
    getRecentRoomsSnapshot,
    getRecentRoomsServerSnapshot,
  )

  useEffect(() => {
    // 从外部系统（localStorage/URL）同步初始状态 —— 仅在挂载时执行一次
    const savedName = localStorage.getItem('veil-name') || ''
    const savedAvatar = localStorage.getItem('veil-avatar') || ''
    setAvatar(savedAvatar)
    setName(myName || savedName)
    setRoomId(randomRoomId())
    const params = new URLSearchParams(window.location.search)
    const urlRoom = params.get('room')
    if (urlRoom) {
      setRoomId(urlRoom)
      toast({ title: t.lobby.inviteDetected, description: fmt(t.lobby.inviteDetectedDesc, { room: urlRoom }) })
    }
    // #pass=xxx 片段：浏览器不会把 fragment 发给服务器，口令不经信令/日志（历史链接兼容）
    const hash = window.location.hash
    const m = hash.match(/^#pass=(.+)$/)
    if (m) {
      try {
        const pass = decodeURIComponent(m[1])
        setPassphrase(pass)
        setStore({ passInLink: true })
        history.replaceState(null, '', window.location.pathname + window.location.search)
        toast({ title: t.lobby.passFromLink, description: t.lobby.passFromLinkDesc })
      } catch {
        /* 忽略非法片段 */
      }
    }
  }, [])

  /** 登录页「继续」：昵称缺省自动生成，进入房间页；握手（身份/信令/能力探测）后台静默执行 */
  const continueFromIntro = useCallback(() => {
    let n = name.trim() || localStorage.getItem('veil-name') || ''
    if (!n) {
      n = autoGuestName(t.lobby.autoGuest)
      setName(n)
    }
    localStorage.setItem('veil-name', n)
    setStore({ myName: n, myAvatar: avatar })
    setStep('room')
    void controller.prewarm().catch(() => {})
  }, [name, avatar, t, setStore])

  /** 昵称/头像即时保存（高级设置内修改即生效，无需确认按钮） */
  const applyProfile = (n: string, a: string) => {
    const final = n.trim() || autoGuestName(t.lobby.autoGuest)
    localStorage.setItem('veil-name', final)
    if (a) localStorage.setItem('veil-avatar', a)
    setStore({ myName: final, myAvatar: a })
  }

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return
    try {
      const data = await compressAvatar(file)
      setAvatar(data)
      localStorage.setItem('veil-avatar', data)
      setStore({ myAvatar: data })
      toast({ title: t.lobby.avatarUpdated })
    } catch {
      toast({ title: t.lobby.avatarTooLarge, variant: 'destructive' })
    }
  }

  const removeAvatar = () => {
    setAvatar('')
    try {
      localStorage.removeItem('veil-avatar')
    } catch { /* noop */ }
    setStore({ myAvatar: '' })
  }

  const join = async (createOverride?: boolean) => {
    const id = roomId.trim()
    const n = (name.trim() || localStorage.getItem('veil-name') || t.lobby.anonymous)
    if (id.length < 4) {
      toast({ title: t.lobby.roomTooShort, description: t.lobby.roomTooShortDesc, variant: 'destructive' })
      return
    }
    // 已有房间设置了密码：未填则直接提示（不白跑一趟信令）
    if (roomInfo?.exists && roomInfo.hasPassword && !roomPass) {
      toast({ title: t.lobby.roomPassRequired, description: t.lobby.roomPassRequiredDesc, variant: 'destructive' })
      setShowAdvanced(true)
      return
    }
    localStorage.setItem('veil-name', n)
    if (avatar) localStorage.setItem('veil-avatar', avatar)
    setStore({ myName: n, myAvatar: avatar, passphrase, passInLink, pakeEnabled: !!passphrase })
    // 创建语义：探测得知房间不存在（或显式指定）→ 携带高级设置（密码/审批模式）创建房间
    // 探测未完成（roomInfo=null）绝不能按「加入」语义静默发送 —— 此处实时探测重试 ~2s，
    // 仍拿不到结果按创建语义兜底（设置不丢；对已存在房间无害，服务端会正常走校验路径）。
    let info = roomInfo
    if (!info && !createOverride) {
      for (let i = 0; i < 6 && !info; i++) {
        info = (await controller.queryRoomInfo(id).catch(() => null)) || null
        if (!info) await new Promise((r) => setTimeout(r, 300))
      }
    }
    const create = createOverride ?? (info ? !info.exists : true)
    const r = await controller.join(id, n, passphrase || undefined, {
      roomPass: roomPass || undefined,
      admission: admissionChoice,
      create,
    })
    if (!r.ok && r.error !== 'pending') {
      // 密码错误 → 自动展开高级设置聚焦密码输入
      if (r.error?.includes('密码')) setShowAdvanced(true)
      toast({ title: t.lobby.joinFailed, description: r.error, variant: 'destructive' })
    }
  }

  const newRoom = () => {
    setRoomId(randomRoomId())
    toast({ title: t.lobby.newRoomGenerated, description: t.lobby.newRoomGeneratedDesc })
    void join(true)
  }

  // 房间码变化防抖探测房间信息（是否存在/需密码/审批模式/人数）→ 状态行 + 创建/加入语义自动切换
  // 拿不到结果（信令未就绪/超时）时每 1.6s 自动重试，直到拿到真实状态
  const [probeTick, setProbeTick] = useState(0)
  useEffect(() => {
    if (step !== 'room') return
    const id = roomId.trim()
    // 补发幂等 prewarm 加速信令就绪（?room= 直达场景探测不空转）
    void controller.prewarm().catch(() => {})
    if (id.length < 4) {
      setRoomInfo(null)
      return
    }
    const timer = setTimeout(() => {
      void controller
        .queryRoomInfo(id)
        .then((info) => {
          // 竞态防御：仅当房间码未被继续编辑时采纳结果
          if (useVeil.getState().phase === 'lobby' && id === roomId.trim()) setRoomInfo(info)
        })
        .catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [roomId, step, probeTick])
  useEffect(() => {
    if (step !== 'room' || roomInfo) return undefined
    const t = setInterval(() => setProbeTick((n) => n + 1), 1600)
    return () => clearInterval(t)
  }, [step, roomInfo])

  /* ---------------- 登录页：logo + 继续（仅两个元素） ---------------- */
  if (step === 'intro') {
    return (
      <div className="mx-auto flex min-h-[72vh] w-full max-w-xl animate-in fade-in slide-in-from-bottom-2 flex-col items-center justify-center px-4 py-10 text-center duration-500">
        <div className="relative mb-10">
          <span className="veil-ping-soft absolute -inset-4 rounded-full border border-emerald-500/30" aria-hidden />
          <BrandMark />
        </div>
        <Button
          onClick={continueFromIntro}
          className="veil-shine h-12 w-56 bg-gradient-to-r from-emerald-600 to-teal-600 text-base font-semibold text-white shadow-lg shadow-emerald-500/25 transition-transform duration-150 hover:scale-[1.03] active:scale-[0.97] dark:shadow-emerald-500/30"
        >
          {t.lobby.introContinue} <ArrowRight size={17} />
        </Button>
      </div>
    )
  }

  const roomExists = roomInfo?.exists === true

  /* ---------------- 房间页：房间号 + 高级设置 ---------------- */
  return (
    /* MotionConfig：尊重系统「减弱动态效果」偏好（无障碍） */
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex w-full max-w-xl animate-in fade-in slide-in-from-bottom-2 justify-center px-4 py-8 duration-300 sm:px-6 sm:py-12">
        <motion.div
          key="step-room"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
          className="w-full"
        >
          <Card className="border-border/70 shadow-xl shadow-black/[0.03] dark:shadow-black/40">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/20">
                  <LogIn size={16} />
                </span>
                {t.lobby.roomTitle}
              </CardTitle>
              <CardDescription>{t.lobby.roomDesc}</CardDescription>
            </CardHeader>

            {admissionPending ? (
              /* 等候室：等待房主批准（fail-closed 可取消回大厅） */
              <CardContent className="space-y-5">
                <div className="flex flex-col items-center gap-4 py-4">
                  <div className="relative flex h-20 w-20 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-violet-500/20" style={{ animationDuration: '2s' }} />
                    <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/30">
                      <Hourglass size={24} className="animate-pulse" />
                    </span>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold">{t.lobby.waitingTitle}</div>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{t.lobby.waitingDesc}</p>
                  </div>
                  <Button variant="outline" className="h-9 px-5 text-xs font-semibold" onClick={() => controller.cancelAdmission()}>
                    {t.lobby.waitingCancel}
                  </Button>
                </div>
              </CardContent>
            ) : (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="room" className="flex items-center gap-1.5 text-xs">
                    <KeyRound size={13} /> {t.lobby.roomLabel}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="room"
                      value={roomId}
                      onChange={(e) => setRoomId(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && join()}
                      placeholder={t.lobby.roomPlaceholder}
                      className="font-mono"
                      maxLength={64}
                      autoFocus
                    />
                    <Button variant="outline" size="icon" onClick={() => setRoomId(randomRoomId())} title={t.lobby.randomRoom} aria-label={t.lobby.randomRoom} className="transition-transform duration-150 hover:rotate-12 active:scale-90">
                      <Dices size={16} />
                    </Button>
                  </div>
                  {/* 房间状态探测行：新房间 / 进行中人数 / 需密码 / 需房主批准 */}
                  {roomInfo && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5" aria-live="polite">
                      {!roomInfo.exists ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                          <Sparkles size={10} /> {t.lobby.roomNew}
                        </span>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-300">
                            <Users size={10} /> {fmt(t.lobby.roomLive, { n: roomInfo.memberCount })}
                          </span>
                          {roomInfo.hasPassword && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
                              <KeyRound size={10} /> {t.lobby.roomNeedPass}
                            </span>
                          )}
                          {roomInfo.admission === 'manual' && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
                              <ShieldQuestion size={10} /> {t.lobby.roomNeedApprove}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {recentRooms.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5" aria-label={t.lobby.recentAria}>
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                        <History size={10} /> {t.lobby.recent}
                      </span>
                      {recentRooms.map((r) => (
                        <span
                          key={r.id}
                          className="veil-chip-in group/chip inline-flex items-center overflow-hidden rounded-full border border-border/60 bg-muted/40 transition-all duration-150 hover:border-emerald-500/50 hover:bg-emerald-500/10"
                        >
                          <button
                            onClick={() => {
                              setRoomId(r.id)
                              toast({ title: t.lobby.fillRecent, description: r.id })
                            }}
                            className="max-w-[140px] truncate px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-emerald-600 dark:hover:text-emerald-300"
                            title={fmt(t.lobby.backfill, { id: r.id })}
                          >
                            {r.id}
                          </button>
                          <button
                            onClick={() => removeRecentRoom(r.id)}
                            className="flex h-5 w-5 items-center justify-center border-l border-border/40 text-[9px] text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-500"
                            aria-label={fmt(t.lobby.removeHistory, { id: r.id })}
                          >
                            <X size={9} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 高级设置（折叠）：密码 / 审批 / 昵称头像 / 画质 / 加密开关 / 服务器选择 */}
                <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    aria-expanded={showAdvanced}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold transition-colors hover:bg-muted/40"
                  >
                    <ShieldCheck size={13} className="text-emerald-500" />
                    {t.lobby.advTitle}
                    {roomInfo?.exists && roomInfo.hasPassword && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-300">{t.lobby.roomNeedPass}</span>
                    )}
                    <span className="ml-auto text-muted-foreground">{showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                  </button>
                  {showAdvanced && (
                    <div className="space-y-3.5 border-t border-border/50 px-3 py-3">
                      {/* 房间密码：创建=设置门禁（可选）；加入受密房间=必填 */}
                      <div className="space-y-1.5">
                        <Label htmlFor="room-pass" className="text-[11px] text-muted-foreground">
                          {roomInfo?.exists && roomInfo.hasPassword ? t.lobby.advPassJoin : t.lobby.advPassCreate}
                        </Label>
                        <Input
                          id="room-pass"
                          type="password"
                          value={roomPass}
                          onChange={(e) => setRoomPass(e.target.value)}
                          placeholder={t.lobby.advPassPlaceholder}
                          className="h-8 font-mono text-xs"
                          maxLength={64}
                          autoComplete="off"
                        />
                        <p className="text-[10px] leading-relaxed text-muted-foreground/80">{t.lobby.advPassHint}</p>
                      </div>

                      {/* 昵称 + 头像（登录页不再询问；自动生成的访客名可在此修改） */}
                      <div className="flex items-center gap-3">
                        <div className="relative shrink-0">
                          {avatar ? (
                            <img src={avatar} alt={name || 'avatar'} className="h-10 w-10 rounded-xl border-2 border-emerald-500/40 object-cover shadow" />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/70 to-teal-600/70 text-sm font-black text-white shadow">
                              {(name.trim() || 'V').slice(0, 1).toUpperCase()}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => fileRef.current?.click()}
                            className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-md transition-transform hover:scale-110 active:scale-90"
                            aria-label={t.lobby.avatarUpload}
                            title={t.lobby.avatarUpload}
                          >
                            <Camera size={10} />
                          </button>
                          {avatar && (
                            <button
                              type="button"
                              onClick={removeAvatar}
                              className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white shadow-md transition-transform hover:scale-110 active:scale-90"
                              aria-label={t.lobby.avatarRemove}
                              title={t.lobby.avatarRemove}
                            >
                              <Trash2 size={8} />
                            </button>
                          )}
                          <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              void pickAvatar(e.target.files?.[0])
                              e.currentTarget.value = ''
                            }}
                          />
                        </div>
                        <div className="flex-1 space-y-1">
                          <Label htmlFor="adv-name" className="text-[11px] text-muted-foreground">
                            {t.lobby.nameLabel}
                          </Label>
                          <Input
                            id="adv-name"
                            value={name}
                            onChange={(e) => {
                              setName(e.target.value)
                              applyProfile(e.target.value, avatar)
                            }}
                            placeholder={t.lobby.namePlaceholder}
                            className="h-8 text-xs"
                            maxLength={32}
                          />
                          <p className="text-[10px] text-muted-foreground/80">{t.lobby.avatarHint}</p>
                        </div>
                      </div>

                      {/* 画质（含 8K144 顶格档）：入房采集与设备面板共用；个人偏好优先于管理员默认 */}
                      <div className="space-y-1.5">
                        <Label htmlFor="adv-quality" className="text-[11px] text-muted-foreground">
                          {t.device.qualityLabel}
                        </Label>
                        <Select
                          value={qualityPref}
                          onValueChange={(v) => {
                            const tier = v as QualityTier
                            setStore({ qualityPref: tier })
                            saveLocalTierPref(tier)
                          }}
                        >
                          <SelectTrigger id="adv-quality" className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {QUALITY_TIERS.map((tier) => (
                              <SelectItem key={tier} value={tier} className="text-xs">
                                {tierLabel(t, tier)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* 端到端加密开关：关闭后与对端协商降级 DTLS-SRTP（传输仍加密） */}
                      <div className="flex items-start justify-between gap-3 rounded-lg border border-border/50 bg-background px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium">{t.lobby.advE2ee}</div>
                          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/80">{t.lobby.advE2eeDesc}</p>
                        </div>
                        <Switch
                          checked={e2eeEnabled}
                          onCheckedChange={(on) => {
                            setStore({ e2eeEnabled: on })
                            try {
                              localStorage.setItem('veil-e2ee', on ? '1' : '0')
                            } catch { /* noop */ }
                          }}
                          aria-label={t.lobby.advE2ee}
                          className="mt-0.5 shrink-0 data-[state=checked]:bg-emerald-600"
                        />
                      </div>

                      {/* 服务器选择（按地区）：延迟/上行测速 + 单选应用 + 自定义 */}
                      <ServerPickerPanel />

                      {/* 加入审批：仅创建语义（房间不存在）时可选 */}
                      {(!roomInfo || !roomInfo.exists) && (
                        <div className="space-y-1.5">
                          <span className="text-[11px] font-medium text-muted-foreground">{t.lobby.advAdmission}</span>
                          <div className="grid grid-cols-2 gap-2">
                            {(
                              [
                                { key: 'auto', label: t.lobby.advAdmissionAuto, desc: t.lobby.advAdmissionAutoDesc },
                                { key: 'manual', label: t.lobby.advAdmissionManual, desc: t.lobby.advAdmissionManualDesc },
                              ] as const
                            ).map((opt) => {
                              const active = admissionChoice === opt.key
                              return (
                                <button
                                  key={opt.key}
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  onClick={() => setAdmissionChoice(opt.key)}
                                  className={cn(
                                    'rounded-lg border px-2.5 py-2 text-left transition-all duration-150 active:scale-[0.98]',
                                    active
                                      ? 'border-emerald-500/60 bg-emerald-500/[0.08] shadow-sm shadow-emerald-500/10'
                                      : 'border-border/60 bg-background hover:border-emerald-500/30',
                                  )}
                                >
                                  <span className={cn('block text-[11px] font-semibold', active && 'text-emerald-600 dark:text-emerald-300')}>{opt.label}</span>
                                  <span className="mt-0.5 block text-[9px] leading-snug text-muted-foreground">{opt.desc}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <Button onClick={() => join()} disabled={phase === 'joining'} className="veil-shine h-11 w-full bg-gradient-to-r from-emerald-600 to-teal-600 font-semibold text-white shadow-lg shadow-emerald-500/20 transition-transform duration-150 hover:scale-[1.02] active:scale-[0.97] dark:shadow-emerald-500/30">
                  {phase === 'joining' ? <Loader2 size={16} className="animate-spin" /> : roomExists ? <LogIn size={16} /> : <Plus size={16} />}
                  {phase === 'joining' ? t.lobby.joining : roomExists ? t.lobby.enterRoom : t.lobby.createBtn}
                </Button>

                {!roomExists && (
                  <div className="flex items-center justify-center">
                    <button
                      onClick={newRoom}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-emerald-600 dark:hover:text-emerald-300"
                    >
                      <Dices size={11} /> {t.lobby.quickNewRoom}
                    </button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        </motion.div>
      </div>
    </MotionConfig>
  )
}
