'use client';

/**
 * LedgerPanel — 服务器元数据台账（来自信令服务的 JSONL 文件，经 /api/ledger 代理）
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { Download, FileClock, Loader2, ScrollText } from 'lucide-react'
import { useMemo } from 'react'
import { EmptyState } from './empty-state'
import { useDict } from '@/lib/i18n/use-dict'

/** 事件类型 → 展示色（cls 是样式不是文案，保留在模块级；文案走 t.ledger.ev*） */
const EVENT_CLS: Record<string, string> = {
  service_start: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  service_stop: 'border-zinc-500/30',
  room_create: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300',
  room_close: 'border-zinc-500/30',
  peer_join: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300',
  peer_leave: 'border-zinc-500/30',
  relay_signal: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
  socket_connect: 'border-zinc-500/30',
  socket_disconnect: 'border-zinc-500/30',
  signal_drop_oversize: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
}

/** 事件类型 key → 字典 key（evServiceStart 等，见 packs/panels.ts ledger 命名空间） */
const EVENT_DICT_KEY: Record<
  string,
  | 'evServiceStart'
  | 'evServiceStop'
  | 'evRoomCreate'
  | 'evRoomClose'
  | 'evPeerJoin'
  | 'evPeerLeave'
  | 'evRelay'
  | 'evSocketConnect'
  | 'evSocketDisconnect'
  | 'evOversize'
> = {
  service_start: 'evServiceStart',
  service_stop: 'evServiceStop',
  room_create: 'evRoomCreate',
  room_close: 'evRoomClose',
  peer_join: 'evPeerJoin',
  peer_leave: 'evPeerLeave',
  relay_signal: 'evRelay',
  socket_connect: 'evSocketConnect',
  socket_disconnect: 'evSocketDisconnect',
  signal_drop_oversize: 'evOversize',
}

function eventMeta(e: Record<string, unknown>): string {
  const parts: string[] = []
  if (e.roomId) parts.push(`room=${String(e.roomId).slice(0, 12)}`)
  if (e.peerId) parts.push(`peer=${String(e.peerId).slice(0, 8)}`)
  if (e.name) parts.push(`name=${String(e.name)}`)
  if (e.kind) parts.push(`kind=${String(e.kind)}`)
  if (e.bytes != null) parts.push(`${e.bytes}B`)
  if (e.roomSize != null) parts.push(`size=${e.roomSize}`)
  if (e.cause) parts.push(`cause=${String(e.cause).slice(0, 24)}`)
  if (e.wsPort != null) parts.push(`ws:${e.wsPort}`)
  return parts.join(' ')
}

export function LedgerPanel() {
  const ledger = useVeil((s) => s.ledger)
  const ledgerLoading = useVeil((s) => s.ledgerLoading)
  const ledgerDate = useVeil((s) => s.ledgerDate)
  const ledgerDates = useVeil((s) => s.ledgerDates)
  const t = useDict()

  // 事件类型 → 字典文案；未知事件回退原始 event 名（与旧 EVENT_STYLE 回退行为一致）
  const eventLabel = (ev: string): string => {
    const key = EVENT_DICT_KEY[ev]
    return key ? t.ledger[key] : ev
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    ledger.forEach((e) => m.set(e.event, (m.get(e.event) || 0) + 1))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [ledger])

  const exportJsonl = () => {
    const text = ledger.map((e) => JSON.stringify(e)).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `veiltalk-ledger-${ledgerDate}.jsonl`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Select value={ledgerDate} onValueChange={(d) => void controller.fetchLedger(d)}>
          <SelectTrigger className="h-8 flex-1 text-[11px]">
            <SelectValue placeholder={t.ledger.selectDate} />
          </SelectTrigger>
          <SelectContent>
            {(ledgerDates.length ? ledgerDates : [ledgerDate || new Date().toISOString().slice(0, 10)])
              .filter(Boolean) /* BUG-14 同源防御：SelectItem 禁止空 value，脏数据直接丢弃 */
              .map((d) => (
                <SelectItem key={d} value={d} className="text-[11px]">
                  {d}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => void controller.fetchLedger()} aria-label={t.ledger.refreshAria} disabled={ledgerLoading}>
          {ledgerLoading ? <Loader2 size={12} className="animate-spin" /> : <FileClock size={12} />}
        </Button>
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={exportJsonl} aria-label={t.ledger.exportAria} disabled={ledger.length === 0}>
          <Download size={12} />
        </Button>
      </div>

      {counts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {counts.map(([ev, n]) => (
            <Badge key={ev} variant="outline" className={`text-[9px] ${EVENT_CLS[ev] || ''}`}>
              {eventLabel(ev)} {n}
            </Badge>
          ))}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 pr-1">
        {ledger.length === 0 ? (
          ledgerLoading ? (
            <div className="flex h-28 flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
              <Loader2 size={15} className="animate-spin opacity-50" /> {t.ledger.loading}
            </div>
          ) : (
            <EmptyState
              icon={ScrollText}
              title={t.ledger.emptyTitle}
              desc={t.ledger.emptyDesc}
              chips={[
                { icon: FileClock, cls: 'text-teal-500', pos: '-left-8 top-1', delay: '[animation-delay:-1.6s]' },
                { icon: Download, cls: 'text-emerald-500', pos: '-right-8 -top-1', delay: '[animation-delay:-3.4s]' },
              ]}
              className="h-36"
            />
          )
        ) : (
          <div className="space-y-1 pb-2">
            {ledger.map((e, i) => {
              const cls = EVENT_CLS[e.event] || ''
              return (
                <div key={i} className="flex items-start gap-2 rounded-lg bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
                  <span className="shrink-0 text-muted-foreground/70">{String(e.ts || '').slice(11, 23)}</span>
                  <span className={`shrink-0 rounded border px-1 text-[9px] font-sans ${cls}`}>{eventLabel(e.event)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={eventMeta(e)}>
                    {eventMeta(e) || '-'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t.ledger.note}
      </p>
    </div>
  )
}
