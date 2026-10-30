'use client';

/**
 * DiagnosticsPanel — 连接诊断：信令状态、逐对等连接指标、弱网自适应、ICE 重启
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { Activity, ArrowDown, ArrowUp, HeartPulse, KeyRound, MessagesSquare, RefreshCcw, Route, Signal } from 'lucide-react'
import { EmptyState } from './empty-state'
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import { currentPickSummary } from '@/lib/webrtc/servers'
import { ServerPickerPanel } from './server-latency'

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-semibold">
        {value}
        {unit && <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}

// ICE 候选类型 → 展示色（cls 是样式不是文案，保留在模块级；文案走 t.diag.pair*）
const PAIR_CLS_LABEL: Record<string, 'pairHost' | 'pairSrflx' | 'pairPrflx' | 'pairRelay'> = {
  host: 'pairHost',
  srflx: 'pairSrflx',
  prflx: 'pairPrflx',
  relay: 'pairRelay',
}

/** 网络质量波形图：RTT / 应用层 RTT（左轴）与丢包率（右轴）曲线，采样点来自 getStats + DataChannel ping 轮询历史 */
function QualityChart({ history }: { history: Array<{ t: number; rtt: number | null; appRtt: number | null; loss: number | null }> }) {
  const t = useDict()
  const data = history.map((h, i) => ({
    idx: i + 1,
    rtt: h.rtt != null ? Math.round(h.rtt) : null,
    appRtt: h.appRtt != null ? Math.round(h.appRtt) : null,
    loss: h.loss != null ? Number(h.loss.toFixed(1)) : null,
  }))
  const hasAppRtt = data.some((d) => d.appRtt != null)
  if (data.length < 2) {
    return <div className="py-3 text-center text-[10px] text-muted-foreground">{t.diag.chartSampling}</div>
  }
  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-muted/20 p-1.5">
      <div className="mb-1 flex items-center gap-3 px-1 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-emerald-500" />{t.diag.legendRtt}</span>
        {hasAppRtt && <span className="flex items-center gap-1"><span className="h-0 w-3 border-t-2 border-dashed border-violet-500" />{t.diag.legendApp}</span>}
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-amber-500" />{t.diag.legendLoss}</span>
        <span className="ml-auto tabular-nums">{fmt(t.diag.legendSamples, { count: data.length })}</span>
      </div>
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/60" />
          <XAxis dataKey="idx" tick={false} axisLine={false} tickLine={false} />
          <YAxis yAxisId="rtt" width={28} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
          <YAxis yAxisId="loss" orientation="right" width={28} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
          <ChartTooltip
            contentStyle={{ fontSize: 10, borderRadius: 8, padding: '4px 8px' }}
            labelFormatter={(v) => fmt(t.diag.tooltipSample, { n: v })}
            formatter={(value, name) => [value, name === 'rtt' ? t.diag.tooltipRtt : name === 'appRtt' ? t.diag.tooltipAppRtt : t.diag.tooltipLoss]}
          />
          <Line yAxisId="rtt" type="monotone" dataKey="rtt" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          {hasAppRtt && <Line yAxisId="rtt" type="monotone" dataKey="appRtt" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />}
          <Line yAxisId="loss" type="monotone" dataKey="loss" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function DiagnosticsPanel() {
  const peers = useVeil((s) => s.peers)
  const signaling = useVeil((s) => s.signaling)
  const socketId = useVeil((s) => s.socketId)
  const e2eeStats = useVeil((s) => s.e2eeStats)
  const dcEpoch = useVeil((s) => s.dcEpoch)
  const iceProbe = useVeil((s) => s.iceProbe)
  const peerSeen = useVeil((s) => s.peerSeen)
  const t = useDict()
  const list = Object.values(peers)
  const probeLabel =
    iceProbe.result === 'relay'
      ? t.toasts.iceProbeRelay
      : iceProbe.result === 'srflx'
        ? t.toasts.iceProbeSrflx
        : iceProbe.result === 'timeout'
          ? t.toasts.iceProbeTimeout
          : iceProbe.result === 'none'
            ? t.toasts.iceProbeNone
            : '--'

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        {/* 信令 */}
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <Signal size={13} className="text-emerald-500" />
            {t.diag.signalingTitle}
            <Badge variant="outline" className="ml-auto text-[10px]">
              {signaling === 'online' ? t.diag.sigOnline : signaling === 'connecting' ? t.diag.sigConnecting : signaling === 'offline' ? t.diag.sigOffline : t.diag.sigIdle}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="socket id" value={socketId || '--'} />
            <Stat label={t.diag.statPeers} value={list.length} />
          </div>
          {/* 当前所选 ICE 服务器（高级设置；自动 = 部署默认配置） */}
          <div className="mt-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <span className="font-medium">{t.diag.iceServerLabel}: </span>
            {(() => {
              const pick = currentPickSummary(useVeil.getState().lang)
              return pick ? `${pick.label}（${pick.region} · ${pick.kind.toUpperCase()}）` : t.lobby.serverAuto
            })()}
          </div>
          {/* 服务器热切换（转服务器）：选择即热切换（setConfiguration + ICE 重启，不断流） */}
          <details className="mt-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
            <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">{t.diag.switchServerTitle}</summary>
            <div className="mt-2">
              <ServerPickerPanel onApplied={() => void controller.switchIceServer()} />
            </div>
          </details>
          {/* ICE 服务器可达性探测（入房后自动一次；失败 = 跨网络媒体大概率不通，需部署 TURN） */}
          <div
            className={`mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed ${
              iceProbe.result === 'relay' || iceProbe.result === 'srflx'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : iceProbe.result
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'bg-muted/40 text-muted-foreground'
            }`}
          >
            <Route size={11} className="mt-0.5 shrink-0" />
            <span className={iceProbe.result === 'timeout' || iceProbe.result === 'none' ? 'flex-1' : ''}>
              <span className="font-medium">{t.diag.stunProbeTitle}: </span>
              {probeLabel}
              {(iceProbe.result === 'timeout' || iceProbe.result === 'none') && (
                <span className="ml-1 opacity-80">{iceProbe.result === 'timeout' ? t.toasts.iceProbeTimeoutDetail : t.toasts.iceProbeNoneDetail}</span>
              )}
            </span>
          </div>
        </div>

        {/* 逐对等 */}
        {list.length === 0 && (
          <EmptyState
            icon={Activity}
            title={t.diag.emptyTitle}
            desc={t.diag.emptyDesc}
            className="h-32"
          />
        )}

        {list.map((p) => (
          <div key={p.socketId} className="rounded-xl border border-border/60 bg-card p-3">
            <div className="mb-2 flex items-center gap-2">
              <HeartPulse size={13} className="text-teal-500" />
              <span className="truncate text-xs font-semibold">{p.name || t.diag.guest}</span>
              <Badge
                variant="outline"
                className={`ml-auto text-[10px] ${
                  p.connState === 'connected'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                    : p.connState === 'failed'
                      ? 'border-red-500/40 bg-red-500/10 text-red-500'
                      : 'text-muted-foreground'
                }`}
              >
                {p.connState}
              </Badge>
            </div>

            {p.stats ? (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <Stat label="RTT" value={p.stats.rttMs != null ? Math.round(p.stats.rttMs) : '--'} unit="ms" />
                  <Stat label={t.diag.statAppRtt} value={p.stats.appRttMs != null ? Math.round(p.stats.appRttMs) : '--'} unit="ms" />
                  <Stat label={t.diag.statUp} value={p.stats.outKbps ?? '--'} unit="kbps" />
                  <Stat label={t.diag.statDown} value={p.stats.inKbps ?? '--'} unit="kbps" />
                  <Stat label={t.diag.statLoss} value={p.stats.lossPct != null ? p.stats.lossPct.toFixed(1) : '--'} unit="%" />
                  <Stat label={t.diag.statJitter} value={p.stats.jitterMs != null ? p.stats.jitterMs.toFixed(0) : '--'} unit="ms" />
                  <Stat label={t.diag.statTargetBitrate} value={p.stats.adaptiveBitrateKbps ?? '--'} unit="kbps" />
                </div>
                <QualityChart history={p.history || []} />
                {p.stats.video && (p.stats.video.width || p.stats.video.fps) && (
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <ArrowUp size={10} className="text-teal-500" />
                    {fmt(t.diag.videoSend, { w: String(p.stats.video.width), h: String(p.stats.video.height), fps: p.stats.video.fps || '--' })}
                    {p.stats.video.nackCount != null && <span>· NACK {p.stats.video.nackCount}</span>}
                  </div>
                )}
                {/* 对端实测「看到的你的画面」（对方每 5s 回传一次解码实测） */}
                {peerSeen[p.socketId] && peerSeen[p.socketId].w > 0 && (
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <ArrowDown size={10} className="text-violet-500" />
                    {fmt(t.diag.peerSeen, { w: String(peerSeen[p.socketId].w), h: String(peerSeen[p.socketId].h), fps: String(peerSeen[p.socketId].fps) })}
                    {peerSeen[p.socketId].rtt != null && <span>· {Math.round(peerSeen[p.socketId].rtt as number)}ms</span>}
                  </div>
                )}
                {p.stats.pair && (
                  <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    <Route size={11} className="mt-0.5 shrink-0" />
                    <span>
                      {fmt(t.diag.pairRoute, {
                        local: PAIR_CLS_LABEL[p.stats.pair.localType] ? t.diag[PAIR_CLS_LABEL[p.stats.pair.localType]] : p.stats.pair.localType,
                        remote: PAIR_CLS_LABEL[p.stats.pair.remoteType] ? t.diag[PAIR_CLS_LABEL[p.stats.pair.remoteType]] : p.stats.pair.remoteType,
                        proto: p.stats.pair.protocol.toUpperCase(),
                      })}
                      {p.stats.pair.remoteType === 'relay' && <span className="ml-1 text-amber-500">{t.diag.viaRelay}</span>}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="py-2 text-center text-[10px] text-muted-foreground">{t.diag.statsPending}</div>
            )}
          </div>
        ))}

        {/* 帧加密统计 + 密钥轮换 + ICE 重启 */}
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold">
            <KeyRound size={13} className="text-cyan-500" />
            {t.diag.frameEncTitle}
            <span className="ml-auto text-[9px] font-normal text-muted-foreground">{t.diag.frameEncSub}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label={t.diag.statEnc} value={e2eeStats.encrypted} />
            <Stat label={t.diag.statDec} value={e2eeStats.decrypted} />
            <Stat label={t.diag.statDrop} value={e2eeStats.dropped} />
            <Stat
              label={t.diag.statMediaRotate}
              value={e2eeStats.rotations}
              unit={e2eeStats.epoch > 0 ? `· epoch ${e2eeStats.epoch}` : undefined}
            />
            <Stat
              label={t.diag.statDcEpoch}
              value={dcEpoch}
              unit={dcEpoch > 0 ? t.diag.unitRotated : t.diag.unitInitial}
            />
            <Stat label={t.diag.statDcChain} value="HKDF epoch" />
          </div>
          <p className="mt-1.5 px-0.5 text-[9px] leading-relaxed text-muted-foreground">
            {t.diag.rotateNote}
          </p>
          <Separator className="my-2.5" />
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="veil-rotate-pulse w-full gap-1.5 text-xs transition-all duration-150 hover:border-cyan-500/40 hover:text-cyan-600 active:scale-[0.98] dark:hover:text-cyan-300"
              onClick={() => controller.rotateMediaKeys()}
            >
              <KeyRound size={12} /> {t.diag.rotateMedia}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="veil-rotate-pulse w-full gap-1.5 text-xs transition-all duration-150 hover:border-violet-500/40 hover:text-violet-600 active:scale-[0.98] dark:hover:text-violet-300"
              onClick={() => controller.rotateDataKeys()}
            >
              <MessagesSquare size={12} /> {t.diag.rotateData}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-xs transition-all duration-150 hover:border-emerald-500/40 hover:text-emerald-600 active:scale-[0.98] dark:hover:text-emerald-300"
              onClick={() => controller.restartIce()}
            >
              <RefreshCcw size={12} /> {t.diag.restartIce}
            </Button>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}
