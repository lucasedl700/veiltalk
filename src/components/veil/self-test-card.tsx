'use client';

/**
 * SelfTestCard — 浏览器内全链路加密自检（不依赖设备/信令）
 */

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { CheckCircle2, FlaskConical, Loader2, XCircle } from 'lucide-react'
import { useDict } from '@/lib/i18n/use-dict'

export function SelfTestCard() {
  const running = useVeil((s) => s.selfTestRunning)
  const results = useVeil((s) => s.selfTestResults)
  const t = useDict()
  const allOk = results.length > 0 && results.every((r) => r.ok)

  return (
    <Card className="border-border/70">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical size={16} className="text-teal-500" />
          {t.selftest.title}
        </CardTitle>
        {results.length > 0 && (
          <Badge variant="outline" className={allOk ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'}>
            {allOk ? t.selftest.allPass : t.selftest.hasFailed}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => void controller.runSelfTest()} disabled={running} variant="outline" size="sm" className="w-full border-teal-500/40 text-teal-600 hover:bg-teal-500/10 dark:text-teal-300">
          {running ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
          {running ? t.selftest.running : t.selftest.run}
        </Button>
        {results.length > 0 && (
          <ol className="space-y-1.5">
            {results.map((r, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed">
                {r.ok ? (
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle size={13} className="mt-0.5 shrink-0 text-red-500" />
                )}
                <div className="min-w-0">
                  <span className="font-medium">{r.name}</span>
                  <span className="ml-1.5 text-muted-foreground">{r.detail}</span>
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">{r.ms}ms</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
