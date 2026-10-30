'use client';

/**
 * FilePanel — 拖拽/选择发送文件，展示双向传输进度、速度、SHA-256 校验与下载；
 * 断点续传（P1-6）：失败发送可一键续传，接收端进度落 IndexedDB 暂存可跨断连/刷新恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { listPartials } from '@/lib/webrtc/transfer-db'
import { toast } from '@/hooks/use-toast'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import { EmptyState } from './empty-state'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  CloudUpload,
  DatabaseZap,
  FileText,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  Trash2,
  X,
  CheckCheck,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '--'
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

export function FilePanel() {
  const transfersMap = useVeil((s) => s.transfers)
  // 排序在渲染体内完成（选择器必须返回稳定引用，否则触发 useSyncExternalStore 无限循环）
  const transfers = useMemo(
    () => Object.values(transfersMap).sort((a, b) => b.startedTs - a.startedTs),
    [transfersMap],
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [cacheCount, setCacheCount] = useState(0)
  const hasPeers = useVeil((s) => Object.keys(s.peers).length > 0)
  // 字典变量名用 d（下方传输项回调参数 t 已被占用）
  const d = useDict()

  // 本地暂存计数（断点续传 IndexedDB）：传输状态签名变化时刷新（新建/终止态都会变；
  // 传输中每 4 块的进度更新不改变签名，避免频繁扫描 IndexedDB）
  const cacheSig = useMemo(
    () => transfers.map((t) => `${t.id}:${t.status}`).join('|'),
    [transfers],
  )
  useEffect(() => {
    void listPartials().then((rows) => setCacheCount(rows.length))
  }, [cacheSig])

  /* F-37 回执超时降级：发送完成后 ACK_WAIT_MS 仍未收到 file-ack → 诚实提示「可能为旧版本」。
     计时状态组件本地维护（不进 store）；ack 到达或状态离开 done 后签名变化即重建/清理计时器。 */
  const ACK_WAIT_MS = 8000
  const [ackTimedOut, setAckTimedOut] = useState<Record<string, true>>({})
  const ackTimedOutRef = useRef<Record<string, true>>({})
  const ackSig = useMemo(
    () => transfers.map((t) => `${t.id}:${t.direction}:${t.status}:${t.ack ?? '-'}`).join('|'),
    [transfers],
  )
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    transfers.forEach((t) => {
      if (t.status === 'done' && t.direction === 'send' && !t.ack && !ackTimedOutRef.current[t.id]) {
        timers.push(
          setTimeout(() => {
            ackTimedOutRef.current[t.id] = true
            setAckTimedOut((prev) => (prev[t.id] ? prev : { ...prev, [t.id]: true }))
          }, ACK_WAIT_MS),
        )
      }
    })
    return () => timers.forEach(clearTimeout)
    // 依赖 ackSig（ack/状态跃迁才重建计时器）；transfers 为 useMemo 派生引用，随 ackSig 一并更新
  }, [ackSig])

  const clearCache = useCallback(async () => {
    await controller.clearTransferCache()
    setCacheCount(0)
  }, [])

  const send = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      if (!hasPeers) {
        toast({ title: d.files.toastNoPeers, description: d.files.toastNoPeersDesc, variant: 'destructive' })
        return
      }
      Array.from(files).forEach((f) => controller.sendFile(f))
      toast({ title: fmt(d.files.toastQueued, { count: files.length }), description: d.files.toastQueuedDesc })
    },
    [hasPeers, d],
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {/* 拖拽区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          send(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'group flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-5 text-center transition-all duration-150',
          dragging
            ? 'scale-[1.01] border-emerald-500 bg-emerald-500/10'
            : 'border-border/70 bg-muted/20 hover:border-emerald-500/50 hover:bg-emerald-500/[0.04]',
          'active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50',
        )}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        aria-label={d.files.dropzoneAria}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 transition-transform duration-200 group-hover:scale-110">
          <CloudUpload size={20} className="text-emerald-500" />
        </div>
        <div className="text-xs font-medium">{d.files.dropHint}</div>
        <div className="text-[10px] text-muted-foreground">{d.files.dropSub}</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          suppressHydrationWarning
          onChange={(e) => {
            send(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {/* 传输列表 */}
      <ScrollArea className="min-h-0 flex-1 pr-1">
        {transfers.length === 0 ? (
          <EmptyState
            icon={CloudUpload}
            title={d.files.emptyTitle}
            desc={d.files.emptyDesc}
            chips={[
              { icon: ShieldCheck, cls: 'text-emerald-500', pos: '-left-8 top-0', delay: '[animation-delay:-1.2s]' },
              { icon: FileText, cls: 'text-teal-500', pos: '-right-8 -top-1' },
              { icon: ArrowDownToLine, cls: 'text-cyan-500', pos: 'left-7 -bottom-7', delay: '[animation-delay:-2.6s]' },
            ]}
          />
        ) : (
          <div className="space-y-2 pb-2">
            {transfers.map((t) => {
              const pct = t.size > 0 ? Math.min(100, Math.round((t.received / t.size) * 100)) : 0
              const inFlight = t.status === 'transferring' || t.status === 'verifying' || t.status === 'pending' || t.status === 'paused'
              return (
                <div key={t.id} className="rounded-xl border border-border/60 bg-card p-3 transition-shadow duration-200 hover:shadow-md dark:border-white/[0.06] dark:hover:shadow-black/40">
                  <div className="flex items-start gap-2.5">
                    <div
                      className={cn(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                        t.direction === 'send' ? 'bg-teal-500/10 text-teal-500' : 'bg-cyan-500/10 text-cyan-500',
                      )}
                    >
                      {t.direction === 'send' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium">{t.name}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>{fmtSize(t.size)}</span>
                        <span>· {t.direction === 'send' ? `→ ${t.peerName}` : `← ${t.peerName}`}</span>
                        {(t.status === 'transferring' || t.status === 'paused') && <span>· {fmtSpeed(t.speedBps)}</span>}
                      </div>
                      {inFlight && t.size > 0 && (
                        <Progress value={pct} className={cn('mt-2 h-1.5', t.status === 'paused' && 'veil-progress-paused')} />
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {t.status === 'transferring' && (
                          <Badge variant="outline" className="gap-1 border-teal-500/30 bg-teal-500/10 text-[10px] text-teal-600 dark:text-teal-300">
                            <Loader2 size={9} className="animate-spin" /> {pct}%
                          </Badge>
                        )}
                        {t.status === 'paused' && (
                          <Badge variant="outline" className="veil-badge-paused gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300">
                            <Pause size={9} /> {fmt(d.files.pausedBadge, { pct })}
                          </Badge>
                        )}
                        {t.status === 'verifying' && (
                          <Badge variant="outline" className="text-[10px] text-amber-500">
                            <ShieldCheck size={9} /> {d.files.verifying}
                          </Badge>
                        )}
                        {t.status === 'done' && t.digestOk && (
                          <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300">
                            <CheckCircle2 size={9} /> {d.files.digestOk}
                          </Badge>
                        )}
                        {t.status === 'failed' && (
                          <Badge variant="outline" className="gap-1 border-red-500/30 bg-red-500/10 text-[10px] text-red-500">
                            <XCircle size={9} /> {t.error || d.files.failed}
                          </Badge>
                        )}
                        {t.status === 'failed' && t.resumable && t.direction === 'send' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="veil-resume-btn h-6 gap-1 border-amber-500/40 bg-amber-500/10 px-2 text-[10px] text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                            onClick={() => controller.retryTransfer(t.id)}
                            aria-label={fmt(d.files.resumeAria, { name: t.name })}
                          >
                            <RotateCcw size={10} /> {d.files.resume}
                          </Button>
                        )}
                        {(t.status === 'transferring' || t.status === 'done') && (t.resumedFrom ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="veil-resume-badge gap-1 border-amber-500/30 bg-amber-500/[0.07] text-[10px] text-amber-600 dark:text-amber-300"
                            title={fmt(d.files.resumedTitle, { size: fmtSize(t.resumedFrom!) })}
                          >
                            <RotateCcw size={9} /> {fmt(d.files.resumedBadge, { pct: Math.round((t.resumedFrom! / Math.max(1, t.size)) * 100) })}
                          </Badge>
                        )}
                        {t.status === 'cancelled' && (
                          <Badge variant="outline" className="text-[10px] text-zinc-500">
                            {d.files.cancelled}
                          </Badge>
                        )}
                        {t.status === 'done' && t.direction === 'send' && t.ack === 'ok' && (
                          <Badge
                            variant="outline"
                            className="veil-ack-badge gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300"
                            title={d.files.ackOkTitle}
                          >
                            <CheckCheck size={9} /> {d.files.ackOk}
                          </Badge>
                        )}
                        {t.status === 'done' && t.direction === 'send' && t.ack === 'fail' && (
                          <Badge variant="outline" className="gap-1 border-red-500/30 bg-red-500/10 text-[10px] text-red-500" title={d.files.ackFailTitle}>
                            <XCircle size={9} /> {d.files.ackFail}
                          </Badge>
                        )}
                        {t.status === 'done' && t.direction === 'send' && !t.ack &&
                          (ackTimedOut[t.id] ? (
                            <span
                              className="veil-ack-stale text-[10px] text-amber-600 dark:text-amber-300"
                              title={d.files.ackStaleTitle}
                            >
                              {d.files.ackStale}
                            </span>
                          ) : (
                            <span
                              className="veil-ack-wait text-[10px] text-muted-foreground"
                              title={d.files.ackWaitTitle}
                            >
                              {d.files.ackWait}
                            </span>
                          ))}
                        {t.downloadUrl && (
                          <a href={t.downloadUrl} download={t.name}>
                            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]">
                              <ArrowDownToLine size={10} /> {d.files.save}
                            </Button>
                          </a>
                        )}
                        {inFlight && t.direction === 'send' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 gap-1 px-2 text-[10px] text-red-500 hover:text-red-600"
                            onClick={() => controller.cancelTransfer(t.id)}
                          >
                            <X size={10} /> {d.files.cancel}
                          </Button>
                        )}
                        {t.direction === 'send' && (t.status === 'transferring' || t.status === 'paused') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 gap-1 px-2 text-[10px] transition-colors hover:text-amber-600 dark:hover:text-amber-300"
                            onClick={() =>
                              t.status === 'paused' ? controller.resumeTransfer(t.id) : controller.pauseTransfer(t.id)
                            }
                            aria-label={t.status === 'paused' ? fmt(d.files.playAria, { name: t.name }) : fmt(d.files.pauseAria, { name: t.name })}
                          >
                            {t.status === 'paused' ? <Play size={10} /> : <Pause size={10} />}
                            {t.status === 'paused' ? d.files.play : d.files.pause}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  {t.status === 'done' && t.digest && (
                    <div className="mt-2 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[9px] text-muted-foreground" title={t.digest}>
                      sha256: {t.digest}
                    </div>
                  )}
                  {t.direction === 'recv' && t.status === 'failed' && t.resumable && (
                    <div className="mt-2 flex items-center gap-1.5 rounded bg-amber-500/[0.06] px-2 py-1 text-[9px] text-amber-600 dark:text-amber-300">
                      <DatabaseZap size={9} className="shrink-0" />
                      {d.files.recvResumedHint}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* 本地断点暂存页脚（隐私透明化：明文分片等效浏览器缓存，可一键擦除） */}
      {cacheCount > 0 && (
        <div className="veil-cache-foot flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-300">
            <DatabaseZap size={11} className="shrink-0" />
            <span className="truncate">{fmt(d.files.cacheFoot, { count: cacheCount })}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-red-500"
            onClick={() => void clearCache()}
            aria-label={d.files.cacheClearAria}
          >
            <Trash2 size={10} /> {d.files.cacheClear}
          </Button>
        </div>
      )}
    </div>
  )
}
