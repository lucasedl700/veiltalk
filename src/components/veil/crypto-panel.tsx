'use client';

/**
 * CryptoPanel — 加密透明度面板：我的指纹、各对端安全码（带外核对 + 一键互核）、密钥体系说明
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { isAppleWebKitNoFrameE2EE } from '@/lib/webrtc/e2ee-manager'
import { Check, Copy, Fingerprint, KeyRound, Loader2, Lock, ScanSearch, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

export function CryptoPanel() {
  const myFingerprint = useVeil((s) => s.myFingerprint)
  const peers = useVeil((s) => s.peers)
  const e2eeMode = useVeil((s) => s.e2eeMode)
  /** Apple 平台按设计回退：加密面板帧路径行显示人话而非原始模式串（Task 40） */
  const appleE2EEPolicy = isAppleWebKitNoFrameE2EE()
  const e2eeStats = useVeil((s) => s.e2eeStats)
  const pakeEnabled = useVeil((s) => s.pakeEnabled)
  const peerVerified = useVeil((s) => s.peerVerified)
  const verifyPending = useVeil((s) => s.verifyPending)
  const t = useDict()
  const [copied, setCopied] = useState(false)
  const [verified, setVerified] = useState<Record<string, boolean>>({})

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(myFingerprint)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: t.crypto.copyFailed, variant: 'destructive' })
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        {/* 我的指纹 */}
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <Fingerprint size={13} className="text-emerald-500" />
            {t.crypto.myFingerprint}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
              {myFingerprint || t.crypto.fingerprintPending}
            </code>
            {myFingerprint && (
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 transition-transform duration-150 active:scale-90" onClick={copy} aria-label={t.crypto.copyFingerprint}>
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {t.crypto.fingerprintNote}
          </p>
        </div>

        {/* 安全码核对 */}
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck size={13} className="text-teal-500" />
            {t.crypto.peerSafety}
          </div>
          {Object.values(peers).length === 0 ? (
            <div className="py-3 text-center text-[11px] text-muted-foreground">{t.crypto.waitingPeers}</div>
          ) : (
            <div className="space-y-2">
              {Object.values(peers).map((p) => {
                const pv = peerVerified[p.socketId]
                const pending = !!verifyPending[p.socketId]
                const verifiedOk = verified[p.socketId] || p.pake === 'verified' || pv?.ok === true
                return (
                <div key={p.socketId} className={cn(
                  'rounded-lg border p-2.5',
                  p.pake === 'failed' || pv?.ok === false
                    ? 'veil-pake-fail border-red-500/40 bg-red-500/[0.06]'
                    : verifiedOk
                      ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                      : 'border-border/60 bg-muted/30',
                )}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[11px] font-medium">{p.name || t.crypto.guest}</span>
                    {pakeEnabled ? (
                      p.pake === 'verified' ? (
                        <Badge variant="outline" className="veil-pake-pop ml-auto gap-1 border-emerald-500/40 text-[9px] text-emerald-600 dark:text-emerald-300">
                          <Lock size={9} className="veil-pake-check" /> {t.crypto.pakeVerified}
                        </Badge>
                      ) : p.pake === 'failed' ? (
                        <Badge variant="outline" className="ml-auto gap-1 border-red-500/40 text-[9px] text-red-600 dark:text-red-300">
                          <ShieldAlert size={9} /> {t.crypto.pakeFailed}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="ml-auto gap-1 border-amber-500/40 text-[9px] text-amber-600 dark:text-amber-300">
                          {t.crypto.pakePending}
                        </Badge>
                      )
                    ) : (
                      <Badge variant="outline" className="ml-auto text-[9px] text-muted-foreground">{t.crypto.pakeOff}</Badge>
                    )}
                    {pv?.ok === false && (
                      <Badge variant="outline" className="gap-1 border-red-500/40 text-[9px] text-red-600 dark:text-red-300">
                        <ShieldAlert size={9} /> {t.crypto.verifyFailBadge}
                      </Badge>
                    )}
                    {pv?.ok === true && p.pake !== 'verified' && (
                      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[9px] text-emerald-600 dark:text-emerald-300">
                        <ScanSearch size={9} /> {pv.mine ? t.crypto.verifyOkBadge : t.crypto.verifyByPeerBadge}
                      </Badge>
                    )}
                    {verified[p.socketId] && !pv && p.pake !== 'verified' && (
                      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[9px] text-emerald-600 dark:text-emerald-300">
                        <Check size={9} /> {t.crypto.verified}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1.5 text-center font-mono text-sm font-bold tracking-widest text-emerald-600 dark:text-emerald-300">{p.safety || t.crypto.safetyPending}</div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[9px] text-muted-foreground" title={p.fingerprint}>
                      {fmt(t.crypto.peerFingerprint, { fp: p.fingerprint.slice(0, 24) })}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {p.safety && pv?.ok !== false && p.pake !== 'verified' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          className="h-6 px-2 text-[10px] transition-all duration-150 hover:border-emerald-500/50 hover:text-emerald-600 active:scale-[0.96] dark:hover:text-emerald-300"
                          onClick={() => controller.requestPeerVerify(p.socketId)}
                        >
                          {pending ? <Loader2 size={10} className="animate-spin" /> : <ScanSearch size={10} />}
                          {pending ? t.crypto.verifyPendingLabel : t.crypto.verifyBtn}
                        </Button>
                      )}
                      {!verified[p.socketId] && !pv && p.safety && p.pake !== 'verified' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground" onClick={() => setVerified((v) => ({ ...v, [p.socketId]: true }))}>
                          {t.crypto.markVerified}
                        </Button>
                      )}
                    </span>
                  </div>
                </div>
                )
              })}
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            {t.crypto.verifyNote}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {t.crypto.spakeNote}
          </p>
        </div>

        {/* 密码学配置 */}
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <KeyRound size={13} className="text-cyan-500" />
            {t.crypto.configTitle}
          </div>
          <dl className="space-y-1.5 text-[11px] leading-relaxed">
            {[
              [t.crypto.kIdentity, t.crypto.vIdentity],
              [t.crypto.kPake, pakeEnabled ? t.crypto.vPakeOn : t.crypto.vPakeOff],
              [t.crypto.kKdf, t.crypto.vKdf],
              [t.crypto.kMedia, t.crypto.vMedia],
              [t.crypto.kData, t.crypto.vData],
              [t.crypto.kTransport, t.crypto.vTransport],
              [t.crypto.kFramePath, e2eeMode === 'encoded-streams' ? t.crypto.vFrameInsertable : e2eeMode === 'script-transform' ? t.crypto.vFrameScript : e2eeMode === 'unsupported' ? (appleE2EEPolicy ? t.header.e2eeApplePolicy : t.header.e2eeUnsupported) : e2eeMode],
              [t.crypto.kStats, fmt(t.crypto.vStats, { enc: e2eeStats.encrypted, dec: e2eeStats.decrypted, drop: e2eeStats.dropped })],
            ].map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">{k}</dt>
                <dd className="truncate text-right font-medium" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </ScrollArea>
  )
}
