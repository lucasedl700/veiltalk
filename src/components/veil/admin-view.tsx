'use client';

/**
 * AdminView — 管理员控制台（/?view=admin）
 *
 * 用户需求原文：「再搞一个管理员面板，输入密码进去……管理员把现在所有的通话清除，
 * 服务器数据一次清掉（幽灵服务器/协商中的僵尸账号），顺便全局默认画质强切 1080p60/4K60」。
 *
 * 能力：
 *  1. 密码门（POST /svc/admin/login；密码仅存 sessionStorage，关页即遗忘）
 *  2. 服务器概览：运行时长 / 房间 / 通话成员 / 活跃连接 / 内存 / 当前全局画质档
 *  3. 房间治理：逐房间解散 + 一键清场（含「一直在协商中」的幽灵会话）
 *  4. 全局画质默认档：360p → 4K60 七档，持久化在信令服务端（重启不丢）
 *  5. 数据清理：元数据台账文件清除 + 无账号体系说明
 *
 * 服务端配套：mini-services/signaling-service（心跳 TTL 幽灵清扫 60s，成员每 15s 心跳）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { fmt, type Lang } from '@/lib/i18n'
import { dictFor } from '@/lib/i18n'
import { useVeil } from '@/store/veil-store'
import { adminLogin, adminOverview, adminPurge, adminSaveConfig, type AdminOverview } from '@/lib/admin-client'
import { controller } from '@/lib/webrtc/controller'
import { QUALITY_TIERS, isQualityTier } from '@/lib/webrtc/tiers'
import { ServerLatencyTable } from './server-latency'
import { SelfTestCard } from './self-test-card'
import {
  ArrowLeft,
  DoorOpen,
  Eraser,
  Gauge,
  Info,
  KeyRound,
  Lock,
  Monitor,
  RefreshCcw,
  Server,
  ShieldCheck,
  Timer,
  Trash2,
  Users,
  Video,
} from 'lucide-react'

const SESSION_KEY = 'veil-admin-pass'

function fmtUptime(sec: number, t: ReturnType<typeof dictFor>): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return fmt(t.status.uptimeDays, { d, h, m })
  if (h > 0) return fmt(t.status.uptimeHours, { h, m })
  return fmt(t.status.uptimeMin, { m })
}

export function AdminView() {
  const lang = useVeil((s) => s.lang) as Lang
  const t = dictFor(lang)
  const serverDefaultQuality = useVeil((s) => s.serverDefaultQuality)

  const [pass, setPass] = useState('')
  const [authed, setAuthed] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 全局画质设置选择值（独立于服务端当前值，保存成功后同步） */
  const [tierPick, setTierPick] = useState<string>('720p')

  const load = useCallback(
    async (p: string) => {
      setBusy(true)
      try {
        const ov = await adminOverview(p)
        setData(ov)
        setAuthed(true)
        setError(null)
        if (isQualityTier(ov.config.defaultQuality)) setTierPick(ov.config.defaultQuality)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  // 会话内已解锁 → 直接进入（密码校验失败则重新弹门）
  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY)
    if (saved) void load(saved)
  }, [load])

  const unlock = async () => {
    if (!pass.trim()) return
    setAuthBusy(true)
    setAuthError(false)
    try {
      const ov = await adminLogin(pass.trim())
      sessionStorage.setItem(SESSION_KEY, pass.trim())
      // 管理员身份写入全局 store：诊断/加密/台账/状态页等管理入口随之解锁（Task 25）
      useVeil.getState().set({ adminUnlocked: true })
      // Task 30：socket 级管理员鉴权 —— 房间内跨房踢人/免审入房等信令侧管理能力
      void controller.notifyAdminUnlock(pass.trim()).catch(() => {})
      setAuthed(true)
      setData(ov)
      if (isQualityTier(ov.config.defaultQuality)) setTierPick(ov.config.defaultQuality)
    } catch {
      setAuthError(true)
    } finally {
      setAuthBusy(false)
    }
  }

  const exit = () => {
    history.replaceState(null, '', '/')
    location.reload()
  }

  const doPurgeRooms = async (roomId?: string) => {
    const saved = sessionStorage.getItem(SESSION_KEY) || ''
    const target = roomId
      ? fmt(t.admin.roomKickConfirm, { id: roomId })
      : fmt(t.admin.purgeAllConfirm, { n: data?.rooms.length || 0 })
    if (!window.confirm(target)) return
    setBusy(true)
    try {
      const r = await adminPurge(saved, 'rooms', roomId)
      setNotice(fmt(t.admin.purgeDone, { rooms: r.rooms ?? 0, peers: r.peers ?? 0 }))
      await load(saved)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const doPurgeLedger = async () => {
    if (!window.confirm(t.admin.dataLedgerConfirm)) return
    const saved = sessionStorage.getItem(SESSION_KEY) || ''
    setBusy(true)
    try {
      const r = await adminPurge(saved, 'ledger')
      setNotice(fmt(t.admin.dataLedgerDone, { files: r.files ?? 0, kb: ((r.bytes ?? 0) / 1024).toFixed(1) }))
      await load(saved)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveTier = async () => {
    const saved = sessionStorage.getItem(SESSION_KEY) || ''
    setBusy(true)
    try {
      await adminSaveConfig(saved, tierPick)
      setNotice(fmt(t.admin.qualitySaved, { tier: tierPick }))
      useVeil.getState().set({ serverDefaultQuality: tierPick })
      await load(saved)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------ 密码门 ------------------------------ */
  if (!authed) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 animate-in flex-col justify-center fade-in slide-in-from-bottom-2 px-4 py-12 duration-300">
        <div className="rounded-3xl border border-border/60 bg-card/70 p-8 shadow-xl shadow-black/5 backdrop-blur">
          <div className="mb-6 flex items-center gap-3">
            <Button variant="outline" size="icon" onClick={exit} aria-label={t.status.back} className="h-9 w-9 shrink-0">
              <ArrowLeft size={15} />
            </Button>
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
              <ShieldCheck size={22} />
            </span>
            <div>
              <h1 className="text-lg font-black tracking-tight">{t.admin.gateTitle}</h1>
              <p className="text-[11px] text-muted-foreground">{t.admin.title}</p>
            </div>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{t.admin.gateDesc}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
            className="space-y-3"
          >
            <Input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder={t.admin.gatePlaceholder}
              aria-label={t.admin.gatePlaceholder}
              autoComplete="off"
              className="h-11 font-mono"
            />
            {authError && (
              <p className="text-xs text-red-500" role="alert">
                {t.admin.gateError}
              </p>
            )}
            <Button type="submit" disabled={authBusy || !pass.trim()} className="h-11 w-full gap-2 bg-amber-500 font-semibold text-amber-950 transition-all hover:bg-amber-400">
              <KeyRound size={15} />
              {authBusy ? '…' : t.admin.gateUnlock}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  /* ------------------------------ 控制台 ------------------------------ */
  const rooms = data?.rooms || []
  const totalPeers = rooms.reduce((n, r) => n + r.peerCount, 0)

  const statCards = [
    { icon: Timer, label: t.admin.ovUptime, value: data ? fmtUptime(data.uptimeSec, t) : '—' },
    { icon: Video, label: t.admin.ovRooms, value: String(rooms.length) },
    { icon: Users, label: t.admin.ovPeers, value: String(totalPeers) },
    { icon: Server, label: t.admin.ovSockets, value: String(data?.sockets ?? '—') },
    { icon: Gauge, label: t.admin.ovRss, value: data ? `${Math.round(data.memory.rss / 1024 / 1024)} MB` : '—' },
    { icon: Monitor, label: t.admin.ovTier, value: data?.config.defaultQuality || '—' },
  ]

  return (
    <div className="mx-auto w-full max-w-[1100px] animate-in fade-in slide-in-from-bottom-2 px-4 py-8 duration-300 sm:px-6 sm:py-10">
      {/* 顶栏 */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="icon" onClick={exit} aria-label={t.status.back} className="h-9 w-9 shrink-0">
          <ArrowLeft size={15} />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-black tracking-tight">
            <ShieldCheck size={20} className="text-amber-500" />
            {t.admin.title}
          </h1>
          <p className="text-xs text-muted-foreground">{t.admin.desc}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            sessionStorage.removeItem(SESSION_KEY)
            setAuthed(false)
            setData(null)
            setPass('')
          }}
          className="gap-1.5"
        >
          <Lock size={13} /> {t.admin.exit}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void load(sessionStorage.getItem(SESSION_KEY) || '')} disabled={busy} className="gap-1.5">
          <RefreshCcw size={13} className={busy ? 'animate-spin' : ''} />
          {t.admin.refresh}
        </Button>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-4 py-3 text-sm text-red-600 dark:text-red-300" role="alert">
          {t.admin.loadFail} · {error}
        </div>
      )}
      {notice && (
        <div className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300" role="status">
          {notice}
        </div>
      )}

      {/* 概览 */}
      <section className="mb-6" aria-label={t.admin.ovTitle}>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold">
          <Server size={15} className="text-emerald-500" /> {t.admin.ovTitle}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {statCards.map((c) => (
            <div key={c.label} className="rounded-2xl border border-border/60 bg-card/60 px-4 py-3.5 shadow-sm">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                <c.icon size={11} /> {c.label}
              </div>
              <div className="mt-1 truncate font-mono text-base font-black leading-tight">{c.value}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Info size={11} className="shrink-0" /> {t.admin.heartbeat}
        </p>
      </section>

      {/* 房间治理 */}
      <section className="mb-6" aria-label={t.admin.roomsTitle}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <DoorOpen size={15} className="text-violet-500" /> {t.admin.roomsTitle}
          </h2>
          {rooms.length > 0 && (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void doPurgeRooms()}
              className="ml-auto gap-1.5"
            >
              <Trash2 size={13} /> {t.admin.purgeAll}
            </Button>
          )}
        </div>
        {rooms.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
            {t.admin.roomsEmpty}
          </p>
        ) : (
          <div className="space-y-3">
            {rooms.map((r) => (
              <div key={r.id} className="rounded-2xl border border-border/60 bg-card/60 p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-black">{r.id}</span>
                  {r.locked && (
                    <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">
                      {t.admin.lockedHint}
                    </Badge>
                  )}
                  <Badge variant="outline" className="h-4 gap-1 px-1.5 text-[9px]">
                    <Users size={8} /> {r.peerCount}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void doPurgeRooms(r.id)}
                    className="ml-auto h-7 gap-1 border-red-500/30 px-2 text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-300"
                  >
                    <Trash2 size={11} /> {t.admin.roomKick}
                  </Button>
                </div>
                <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto veil-scroll">
                  {r.peers.map((p) => (
                    <div key={p.peerId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                      <span className="text-xs font-semibold">{p.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{p.fingerprint}</span>
                      {r.hostPeerId === p.peerId && (
                        <Badge variant="outline" className="h-4 px-1 text-[8px]">
                          {t.admin.roomHost}
                        </Badge>
                      )}
                      <span className={cn('ml-auto font-mono text-[10px]', p.idleSec > 45 ? 'text-amber-500' : 'text-muted-foreground')}>
                        {fmt(t.admin.roomIdle, { s: p.idleSec })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 服务器延迟测速：各 ICE 服务器（目录全表）+ 信令服务本机实测延迟 */}
      <ServerLatencyTable />

      {/* 加密自检（原大厅入口移入管理面板，仍仅管理员可见） */}
      <div className="mb-6">
        <SelfTestCard />
      </div>

      {/* 全局画质 + 数据清理 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.admin.qualityTitle}>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-bold">
            <Monitor size={15} className="text-sky-500" /> {t.admin.qualityTitle}
          </h2>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{t.admin.qualityDesc}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={tierPick} onValueChange={setTierPick}>
              <SelectTrigger className="h-9 w-full text-xs sm:w-56" aria-label={t.admin.qualityTitle}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUALITY_TIERS.map((tier) => (
                  <SelectItem key={tier} value={tier} className="text-xs">
                    {tier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={busy} onClick={() => void saveTier()} className="h-9 gap-1.5 bg-sky-600 hover:bg-sky-700">
              <ShieldCheck size={13} /> {t.admin.qualitySave}
            </Button>
          </div>
          {serverDefaultQuality && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">server → {serverDefaultQuality}</p>
          )}
        </section>

        <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.admin.dataTitle}>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-bold">
            <Eraser size={15} className="text-rose-500" /> {t.admin.dataTitle}
          </h2>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{t.admin.noAccounts}</p>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void doPurgeLedger()} className="gap-1.5">
            <Trash2 size={13} /> {t.admin.dataLedger}
          </Button>
        </section>
      </div>

      <p className="mt-6 text-center text-[10px] text-muted-foreground/70">
        {t.status.updatedAt}: {data ? new Date(data.ts).toLocaleTimeString() : '—'}
      </p>
    </div>
  )
}
