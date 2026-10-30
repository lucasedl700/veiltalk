'use client';

/**
 * EventLogPanel — 客户端事件日志（环形缓冲 400 条）+ JSON 导出
 */

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { Download, Terminal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDict } from '@/lib/i18n/use-dict'

const LEVEL_CLS: Record<string, string> = {
  info: 'text-foreground',
  warn: 'text-amber-500',
  error: 'text-red-500',
  crypto: 'text-emerald-500',
  net: 'text-cyan-600 dark:text-cyan-400',
}

const LEVEL_LABEL: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERRO',
  crypto: 'CRYP',
  net: 'NETW',
}

export function EventLogPanel() {
  const logs = useVeil((s) => s.logs)
  const set = useVeil((s) => s.set)
  const t = useDict()

  const exportLogs = () => {
    const text = logs.map((l) => JSON.stringify(l)).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `veiltalk-client-log-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.jsonl`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-8 flex-1 gap-1.5 text-[11px]" onClick={exportLogs} disabled={logs.length === 0}>
          <Download size={11} /> {t.events.export}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-red-500" onClick={() => set({ logs: [] })}>
          <Trash2 size={11} /> {t.events.clear}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-lg bg-zinc-950 pr-1 dark:bg-zinc-900">
        {logs.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center gap-1.5 text-xs text-zinc-500">
            <Terminal size={16} className="opacity-60" />
            <span>{t.events.emptyTitle}</span>
            <span className="text-[10px]">{t.events.emptyDesc}</span>
          </div>
        ) : (
          <div className="space-y-0.5 p-2 font-mono text-[10px] leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="shrink-0 text-zinc-500">{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className={cn('shrink-0 font-semibold', LEVEL_CLS[l.level])}>[{LEVEL_LABEL[l.level]}]</span>
                <span className="min-w-0 text-zinc-300">
                  {l.msg}
                  {l.detail && <span className="text-zinc-500"> — {l.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
