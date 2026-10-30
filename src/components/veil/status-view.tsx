'use client';

/**
 * StatusView — 服务器状态仪表（/?view=status）
 *
 * 用户需求原文：「新增一个斜杠网页，可以看到当前服务器 L1/L2/L3 负载，
 * 以及当前缓存是真实有用的缓存」。
 *
 * 数据源：/api/status（os.loadavg + 内存 + 信令 :3004 /svc/health、/svc/rooms 房间缓存明细）
 * 自动 5s 刷新；所有缓存数据均为服务端真实对象（信令 rooms Map 内容、台账文件字节），非装饰指标。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { fmt, type Lang } from '@/lib/i18n'
import { dictFor } from '@/lib/i18n'
import { useVeil } from '@/store/veil-store'
import {
  Activity,
  ArrowLeft,
  CircuitBoard,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Info,
  MemoryStick,
  RefreshCcw,
  Server,
  Users,
} from 'lucide-react'

interface StatusData {
  ts: number
  system: {
    hostname: string
    platform: string
    node: string
    uptimeSec: number
    osUptimeSec: number
    cpus: number
    loadL1: number
    loadL2: number
    loadL3: number
    loadPerCoreL1: number
    loadPerCoreL2: number
    loadPerCoreL3: number
  }
  memory: {
    totalMb: number
    freeMb: number
    usedPct: number
    rssMb: number
    heapUsedMb: number
    heapTotalMb: number
  }
  signaling: {
    online: boolean
    rooms: number
    peers: number
    uptimeSec: number | null
    roomCache: Array<{ id: string; peers: number; locked: boolean; createdAt?: string }>
  }
  cache: {
    ledgerBytes: number | null
    processResidentMb: number
  }
}

/** 负载档位着色（归一化每核：<0.7 健康 / <1 偏高 / ≥1 过载） */
function loadColor(v: number): string {
  if (v < 0.7) return 'bg-emerald-500'
  if (v < 1) return 'bg-amber-500'
  return 'bg-red-500'
}

function fmtUptime(sec: number, t: ReturnType<typeof dictFor>): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return fmt(t.status.uptimeDays, { d, h, m })
  if (h > 0) return fmt(t.status.uptimeHours, { h, m })
  return fmt(t.status.uptimeMin, { m })
}

export function StatusView() {
  const lang = useVeil((s) => s.lang) as Lang
  const t = dictFor(lang)
  const [data, setData] = useState<StatusData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as StatusData)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  const exit = () => {
    history.replaceState(null, '', '/')
    location.reload()
  }

  const s = data?.system
  const m = data?.memory
  const g = data?.signaling

  const loadRows = s
    ? [
        { label: t.status.l1, raw: s.loadL1, per: s.loadPerCoreL1 },
        { label: t.status.l2, raw: s.loadL2, per: s.loadPerCoreL2 },
        { label: t.status.l3, raw: s.loadL3, per: s.loadPerCoreL3 },
      ]
    : []

  return (
    <div className="mx-auto w-full max-w-[1100px] animate-in fade-in slide-in-from-bottom-2 px-4 py-8 duration-300 sm:px-6 sm:py-10">
      {/* 顶栏 */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="icon" onClick={exit} aria-label={t.status.back} className="h-9 w-9 shrink-0">
          <ArrowLeft size={15} />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-black tracking-tight">
            <Gauge size={20} className="text-emerald-500" />
            {t.status.title}
          </h1>
          <p className="text-xs text-muted-foreground">{t.status.desc}</p>
        </div>
        <Badge variant="outline" className={cn('gap-1.5', g?.online ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', g?.online ? 'animate-pulse bg-emerald-500' : 'bg-red-500')} />
          {g?.online ? t.status.sigOnline : t.status.sigOffline}
        </Badge>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy} className="gap-1.5">
          <RefreshCcw size={13} className={busy ? 'animate-spin' : ''} />
          {t.status.refresh}
        </Button>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-4 py-3 text-sm text-red-600 dark:text-red-300" role="alert">
          {t.status.loadFail} · {error}
        </div>
      )}

      {!data && !error && (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl border border-border/60 bg-muted/30" />
          ))}
        </div>
      )}

      {data && s && m && g && (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* ── L1/L2/L3 负载 ── */}
          <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.status.loadTitle}>
            <header className="mb-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                <Activity size={16} />
              </span>
              <div>
                <h2 className="text-sm font-bold">{t.status.loadTitle}</h2>
                <p className="text-[10px] text-muted-foreground">{s.hostname} · {s.platform} · {s.cpus} {t.status.cpus}</p>
              </div>
            </header>
            <div className="space-y-3">
              {loadRows.map((r) => (
                <div key={r.label}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="font-semibold">{r.label}</span>
                    <span className="font-mono text-muted-foreground">{r.raw.toFixed(2)} <span className="text-[10px]">({r.per.toFixed(2)}/core)</span></span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={r.per} aria-valuemin={0} aria-valuemax={Math.max(2, r.per)}>
                    <div className={cn('h-full rounded-full transition-all duration-500', loadColor(r.per))} style={{ width: `${Math.min(100, (r.per / 2) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <footer className="mt-4 flex gap-4 border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
              <span>Node {s.node}</span>
              <span>{t.status.procUptime}: {fmtUptime(s.uptimeSec, t)}</span>
              <span>OS: {fmtUptime(s.osUptimeSec, t)}</span>
            </footer>
          </section>

          {/* ── 内存 ── */}
          <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.status.memTitle}>
            <header className="mb-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
                <MemoryStick size={16} />
              </span>
              <div>
                <h2 className="text-sm font-bold">{t.status.memTitle}</h2>
                <p className="text-[10px] text-muted-foreground">{t.status.memHost}: {m.totalMb} MB</p>
              </div>
            </header>
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-semibold">{t.status.memHostUse}</span>
                  <span className="font-mono text-muted-foreground">{m.usedPct}% · {m.freeMb} MB {t.status.memFree}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={m.usedPct} aria-valuemin={0} aria-valuemax={100}>
                  <div className={cn('h-full rounded-full transition-all duration-500', loadColor(m.usedPct / 100))} style={{ width: `${m.usedPct}%` }} />
                </div>
              </div>
              {/* VeilTalk 进程占用（Task 27）：直观看到应用本身只占宿主内存的极小比例 */}
              {(() => {
                const procPct = Math.max(1, Math.round((m.rssMb / Math.max(1, m.totalMb)) * 100))
                return (
                  <div>
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <span className="font-semibold text-cyan-600 dark:text-cyan-400">{t.status.memProcUse}</span>
                      <span className="font-mono text-muted-foreground">{m.rssMb} / {m.totalMb} MB</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={procPct} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full rounded-full bg-cyan-500/80 transition-all duration-500" style={{ width: `${procPct}%` }} />
                    </div>
                    <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
                      <Info size={11} className="mt-0.5 shrink-0 text-cyan-500/70" />
                      {fmt(t.status.memProcSub, { pct: procPct })}
                    </p>
                  </div>
                )
              })()}
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { icon: HardDrive, label: 'RSS', v: `${m.rssMb} MB` },
                  { icon: Cpu, label: 'Heap used', v: `${m.heapUsedMb} MB` },
                  { icon: CircuitBoard, label: 'Heap total', v: `${m.heapTotalMb} MB` },
                ].map((x) => (
                  <div key={x.label} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground"><x.icon size={10} /> {x.label}</div>
                    <div className="mt-0.5 font-mono text-xs font-bold">{x.v}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── 信令服务 ── */}
          <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.status.sigTitle}>
            <header className="mb-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                <Server size={16} />
              </span>
              <div>
                <h2 className="text-sm font-bold">{t.status.sigTitle}</h2>
                <p className="text-[10px] text-muted-foreground">:3003 WebSocket · :3004 HTTP</p>
              </div>
            </header>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2.5 text-center">
                <Users size={13} className="mx-auto text-muted-foreground" />
                <div className="mt-1 font-mono text-lg font-black leading-none">{g.peers}</div>
                <div className="mt-1 text-[9px] text-muted-foreground">{t.status.sigPeers}</div>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2.5 text-center">
                <Database size={13} className="mx-auto text-muted-foreground" />
                <div className="mt-1 font-mono text-lg font-black leading-none">{g.rooms}</div>
                <div className="mt-1 text-[9px] text-muted-foreground">{t.status.sigRooms}</div>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2.5 text-center">
                <Activity size={13} className="mx-auto text-muted-foreground" />
                <div className="mt-1 font-mono text-sm font-black leading-none pt-1">{g.uptimeSec != null ? fmtUptime(g.uptimeSec, t) : '—'}</div>
                <div className="mt-1 text-[9px] text-muted-foreground">{t.status.sigUptime}</div>
              </div>
            </div>
          </section>

          {/* ── 缓存明细（真实缓存内容） ── */}
          <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.status.cacheTitle}>
            <header className="mb-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                <Database size={16} />
              </span>
              <div>
                <h2 className="text-sm font-bold">{t.status.cacheTitle}</h2>
                <p className="text-[10px] text-muted-foreground">{t.status.cacheDesc}</p>
              </div>
            </header>
            <div className="max-h-44 space-y-1.5 overflow-y-auto veil-scroll" role="list">
              {g.roomCache.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">{t.status.cacheEmpty}</p>
              ) : (
                g.roomCache.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5" role="listitem">
                    <span className="font-mono text-[11px] font-bold">{r.id}</span>
                    {r.locked && <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">{t.status.locked}</Badge>}
                    <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground"><Users size={9} /> {r.peers}</span>
                  </div>
                ))
              )}
            </div>
            <footer className="mt-3 flex items-center justify-between border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
              <span>{t.status.ledgerCache}</span>
              <span className="font-mono">{data.cache.ledgerBytes != null ? `${(data.cache.ledgerBytes / 1024).toFixed(1)} KB` : '—'}</span>
            </footer>
          </section>
        </div>
      )}

      <p className="mt-6 text-center text-[10px] text-muted-foreground/70">
        {t.status.updatedAt}: {data ? new Date(data.ts).toLocaleTimeString() : '—'} · 5s {t.status.autoRefresh}
      </p>
    </div>
  )
}
