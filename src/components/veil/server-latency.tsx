'use client';

/**
 * ServerLatency — ICE 服务器选择与延迟测速（大厅高级设置 + 管理员面板共用）
 *
 *  - ServerPickerPanel：大厅高级设置内嵌版（单选行 + 测速 + 自定义服务器输入）
 *  - ServerLatencyTable：管理员面板版（目录全表 + 信令服务延迟 + 一键测速）
 *  - useServerProbe：测速状态与执行（结果按服务器 id 存 latencies/upload，支持增量刷新）
 *
 * 测量逻辑在 src/lib/webrtc/servers.ts（延迟 = 候选出现耗时；TURN 上行 = 强制中继回环）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import type { Lang } from '@/lib/i18n'
import {
  AUTO_SERVER_ID,
  CUSTOM_SERVER_ID,
  SERVER_CATALOG,
  latencyTone,
  probeAll,
  probeSignalingLatency,
  readCustomServer,
  readServerPick,
  saveCustomServer,
  saveServerPick,
  type ProbeResult,
} from '@/lib/webrtc/servers'
import { Gauge, Loader2, Radio, Server, Wifi, WifiOff } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useVeil } from '@/store/veil-store'

interface ProbeState {
  latencies: Record<string, ProbeResult | undefined>
  testing: boolean
  run: () => Promise<void>
  reset: () => void
}

function useServerProbe(includeCustom: boolean): ProbeState {
  const [latencies, setLatencies] = useState<Record<string, ProbeResult | undefined>>({})
  const [testing, setTesting] = useState(false)
  const run = useCallback(async () => {
    setTesting(true)
    try {
      await probeAll(
        (id, r) => setLatencies((prev) => ({ ...prev, [id]: r || { latencyMs: null } })),
        { upload: true },
      )
    } finally {
      setTesting(false)
    }
  }, [])
  const reset = useCallback(() => setLatencies({}), [])
  void includeCustom
  return { latencies, testing, run, reset }
}

function fmtMs(ms: number | null | undefined, timeoutText: string): string {
  if (ms === undefined) return '—'
  if (ms === null) return timeoutText
  return `${ms} ms`
}

function fmtUpload(up: ProbeResult['upload'], timeoutText: string): string {
  if (up === undefined) return '—'
  if (up === null) return timeoutText
  return `${up.rttMs} ms · ${up.kbps} KB/s`
}

/* ------------------------- 大厅高级设置内嵌版 ------------------------- */

export function ServerPickerPanel({ onApplied }: { onApplied?: () => void } = {}) {
  const t = useDict()
  const lang = useDictLang()
  const [pick, setPick] = useState<string>(AUTO_SERVER_ID)
  const [customUrl, setCustomUrl] = useState('')
  const [customUser, setCustomUser] = useState('')
  const [customCred, setCustomCred] = useState('')
  const { latencies, testing, run } = useServerProbe(true)

  useEffect(() => {
    setPick(readServerPick())
    const c = readCustomServer()
    if (c) {
      setCustomUrl(c.urls)
      setCustomUser(c.username || '')
      setCustomCred(c.credential || '')
    }
  }, [])

  const choose = (id: string) => {
    setPick(id)
    saveServerPick(id)
    onApplied?.()
  }

  const saveCustom = () => {
    const url = customUrl.trim()
    if (!/^(stun|turn):/i.test(url)) {
      toast({ title: t.lobby.serverCustomInvalid, variant: 'destructive' })
      return
    }
    saveCustomServer({ urls: url, username: customUser.trim() || undefined, credential: customCred.trim() || undefined })
    if (pick !== CUSTOM_SERVER_ID) {
      setPick(CUSTOM_SERVER_ID)
      saveServerPick(CUSTOM_SERVER_ID)
    }
    onApplied?.()
    toast({ title: t.lobby.serverCustomSaved })
  }

  const rows = [
    { id: AUTO_SERVER_ID, label: t.lobby.serverAuto, region: '', kind: '' as '' | 'stun' | 'turn', entry: null },
    ...SERVER_CATALOG.map((e) => ({
      id: e.id,
      label: lang === 'zh' ? e.label : e.labelEn,
      region: lang === 'zh' ? e.region : e.regionEn,
      kind: e.kind,
      entry: e,
    })),
    { id: CUSTOM_SERVER_ID, label: t.lobby.serverCustom, region: '', kind: '' as '' | 'stun' | 'turn', entry: null },
  ]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{t.lobby.advServer}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={testing}
          onClick={() => void run()}
          className="h-7 gap-1 px-2 text-[10px]"
        >
          {testing ? <Loader2 size={11} className="animate-spin" /> : <Gauge size={11} />}
          {testing ? t.lobby.serverTesting : t.lobby.serverTest}
        </Button>
      </div>
      <div className="space-y-1">
        {rows.map((r) => {
          const active = pick === r.id
          const res = latencies[r.id]
          return (
            <div key={r.id}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => choose(r.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-all duration-150 active:scale-[0.99]',
                  active
                    ? 'border-emerald-500/60 bg-emerald-500/[0.08] shadow-sm shadow-emerald-500/10'
                    : 'border-border/60 bg-background hover:border-emerald-500/30',
                )}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                    active ? 'border-emerald-500 bg-emerald-500' : 'border-muted-foreground/40',
                  )}
                >
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[11px] font-semibold', active && 'text-emerald-600 dark:text-emerald-300')}>{r.label}</span>
                  {r.region && <span className="block text-[9px] leading-snug text-muted-foreground">{r.region}</span>}
                </span>
                {r.kind && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 font-mono text-[8px] font-bold uppercase',
                      r.kind === 'turn' ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300' : 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
                    )}
                  >
                    {r.kind}
                  </span>
                )}
                <span className={cn('shrink-0 font-mono text-[10px] tabular-nums', latencyTone(res?.latencyMs ?? undefined))}>
                  {r.id === AUTO_SERVER_ID ? '' : fmtMs(res?.latencyMs, t.lobby.serverTimeout)}
                </span>
              </button>
              {r.kind === 'turn' && res?.upload !== undefined && (
                <div className="ml-6 mt-0.5 text-[9px] text-muted-foreground">
                  {t.lobby.serverUpload}: {fmtUpload(res.upload, t.lobby.serverTimeout)}
                </div>
              )}
              {r.id === CUSTOM_SERVER_ID && active && (
                <div className="mt-1.5 space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2">
                  <Input
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    placeholder={t.lobby.serverCustomUrl}
                    className="h-7 font-mono text-[10px]"
                    spellCheck={false}
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      value={customUser}
                      onChange={(e) => setCustomUser(e.target.value)}
                      placeholder={t.lobby.serverCustomUser}
                      className="h-7 text-[10px]"
                      autoComplete="off"
                    />
                    <Input
                      value={customCred}
                      onChange={(e) => setCustomCred(e.target.value)}
                      placeholder={t.lobby.serverCustomCred}
                      className="h-7 text-[10px]"
                      type="password"
                      autoComplete="off"
                    />
                  </div>
                  <Button type="button" size="sm" onClick={saveCustom} className="h-7 w-full text-[10px]">
                    {t.lobby.serverCustomSave}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-[9px] leading-relaxed text-muted-foreground/80">{t.lobby.advServerNote}</p>
    </div>
  )
}

/* ------------------------- 管理员面板全表版 ------------------------- */

export function ServerLatencyTable() {
  const t = useDict()
  const lang = useDictLang()
  const { latencies, testing, run } = useServerProbe(false)
  const [sigMs, setSigMs] = useState<number | null | undefined>(undefined)

  const runAll = useCallback(async () => {
    setSigMs(undefined)
    void probeSignalingLatency().then(setSigMs)
    await run()
  }, [run])

  const sorted = [...SERVER_CATALOG].sort((a, b) => {
    const la = latencies[a.id]?.latencyMs
    const lb = latencies[b.id]?.latencyMs
    if (la === undefined && lb === undefined) return 0
    if (la === undefined) return 1
    if (lb === undefined) return -1
    if (la === null && lb === null) return 0
    if (la === null) return 1
    if (lb === null) return -1
    return la - lb
  })

  return (
    <section className="mb-6 rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm" aria-label={t.admin.serversTitle}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <Radio size={15} className="text-teal-500" /> {t.admin.serversTitle}
        </h2>
        <Button size="sm" variant="outline" disabled={testing} onClick={() => void runAll()} className="ml-auto h-7 gap-1.5 text-[11px]">
          {testing ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />}
          {testing ? t.admin.serversRunning : t.admin.serversRun}
        </Button>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{t.admin.serversDesc}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="border-b border-border/60 text-[9px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-2 font-medium">{t.admin.serversName}</th>
              <th className="py-1.5 pr-2 font-medium">{t.admin.serversRegion}</th>
              <th className="py-1.5 pr-2 font-medium">Type</th>
              <th className="py-1.5 pr-2 text-right font-medium">{t.admin.serversLatency}</th>
              <th className="py-1.5 text-right font-medium">{t.admin.serversUpload}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/40">
              <td className="py-1.5 pr-2 font-semibold">
                <span className="flex items-center gap-1.5">
                  <Server size={11} className="text-emerald-500" /> {t.admin.serversSignaling}
                </span>
                <span className="block text-[9px] font-normal text-muted-foreground">{t.admin.serversSignalingDesc}</span>
              </td>
              <td className="py-1.5 pr-2 text-muted-foreground">—</td>
              <td className="py-1.5 pr-2 font-mono text-[9px] uppercase text-muted-foreground">http</td>
              <td className={cn('py-1.5 pr-2 text-right font-mono tabular-nums', latencyTone(sigMs ?? undefined))}>
                {sigMs === undefined ? '—' : sigMs === null ? t.admin.serversTimeout : `${sigMs} ms`}
              </td>
              <td className="py-1.5 text-right text-muted-foreground">—</td>
            </tr>
            {sorted.map((e) => {
              const res = latencies[e.id]
              return (
                <tr key={e.id} className="border-b border-border/40">
                  <td className="py-1.5 pr-2 font-medium">{lang === 'zh' ? e.label : e.labelEn}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{lang === 'zh' ? e.region : e.regionEn}</td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 font-mono text-[8px] font-bold uppercase',
                        e.kind === 'turn' ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300' : 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
                      )}
                    >
                      {e.kind === 'turn' ? t.admin.serversKindTurn : t.admin.serversKindStun}
                    </span>
                  </td>
                  <td className={cn('py-1.5 pr-2 text-right font-mono tabular-nums', latencyTone(res?.latencyMs ?? undefined))}>
                    <span className="inline-flex items-center gap-1">
                      {res?.latencyMs === null ? <WifiOff size={10} className="text-red-500" /> : res?.latencyMs !== undefined ? <Wifi size={10} className="opacity-50" /> : null}
                      {fmtMs(res?.latencyMs, t.admin.serversTimeout)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                    {e.kind === 'turn' ? fmtUpload(res?.upload, t.admin.serversTimeout) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {testing && <p className="mt-2 text-[10px] text-muted-foreground">{t.admin.serversRunning}</p>}
    </section>
  )
}

/* 当前界面语言（zh/en）：目录文案按语言取 label/region 的对应版本 */
function useDictLang(): Lang {
  return useVeil((s) => s.lang)
}
