'use client';

/**
 * DeviceSettings — 摄像头/麦克风选择
 *
 * BUG-14 加固：权限未授权时 enumerateDevices() 会返回 deviceId:'' 的条目
 * （Chromium/Safari 授权前行为），直接渲染 <SelectItem value=""> 会触发
 * Radix 运行时错误（Select.Item 禁止空 value，因为空串被保留用于清空选择）。
 *
 * 四层防御：
 *  1) 过滤空 deviceId —— 空 id 本身无法用于 switchDevice，不可选
 *  2) 按 deviceId 去重 —— 部分浏览器/虚拟设备会对同一硬件返回重复条目
 *  3) 「枚举有条目但 id 全空」识别为未授权，显示专属提示（区别于"无设备"）
 *  4) localStream 由无到有时（授权成功 / retryMedia 成功）自动重新枚举，
 *     设备列表自愈，无需用户手动刷新
 *
 * 【Task 41】iPad（≥sm 走桌面 Popover）面板被屏幕顶部裁掉的修复：
 *  内容高约 900px+，Popover side="top" 从底部锚点向上弹出时超出视口上沿，
 *  且无内部滚动 → 手势全部滚动链到背后页面（用户实测「设置不作为个体上滑、
 *  麦克风/镜头完全选不了」）。修法 = 根节点自钳制高度 + 标题栏固定 + 主体
 *  内部滚动 + overscroll-contain 阻断滚动链：
 *  - Popover 形态：读 Radix 的 --radix-popover-content-available-height
 *    （弹出前已扣除 collisionPadding 的精确可用高度）；
 *  - Dialog 形态（<sm 手机）：var 不存在 → 回退 85dvh（居中定位下不会溢出）。
 *  两种形态标题栏都固定可见，主体独立滚动。
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { Camera, Mic, MonitorUp, Sparkles, Settings2, ShieldAlert, Wand2, ImageUp, X, Gauge, Bluetooth, RefreshCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import { mobileClampActive } from '@/lib/webrtc/tiers'
import { cn } from '@/lib/utils'
import { isQualityTier } from '@/lib/webrtc/tiers'
import { toast } from '@/hooks/use-toast'

/** 【Task 38】屏幕共享能力（getDisplayMedia）探测：iPhone Safari 等不支持 → 相关配置隐藏 */
const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

/** 按 deviceId 去重（保留首个出现的条目） */
function dedupeDevices(list: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const seen = new Set<string>()
  return list.filter((d) => {
    if (seen.has(d.deviceId)) return false
    seen.add(d.deviceId)
    return true
  })
}

/** 设备实时读数（诊断「读到的镜头/麦克风有点怪」）：真实分辨率/帧率/音轨状态每 2s 轮询 */
function DeviceReadout() {
  const localStream = useVeil((s) => s.localStream)
  const t = useDict()
  const [read, setRead] = useState<{ text: string; ok: boolean }>({ text: '', ok: false })

  useEffect(() => {
    const tick = () => {
      const vs = localStream?.getVideoTracks()[0]
      const as = localStream?.getAudioTracks()[0]
      if (!vs && !as) {
        setRead({ text: t.device.noStream, ok: false })
        return
      }
      const parts: string[] = []
      if (vs) {
        const s = vs.getSettings?.() || {}
        const dim = s.width && s.height ? `${s.width}×${s.height}` : '?×?'
        const fps = s.frameRate ? `${Math.round(s.frameRate)}fps` : '—'
        parts.push(`${dim} · ${fps}`)
        if (!vs.enabled || vs.readyState !== 'live') parts.push(t.device.camAbnormal)
      }
      if (as) {
        parts.push(as.enabled && as.readyState === 'live' ? t.device.audioOk : t.device.audioAbnormal)
      } else {
        parts.push(t.device.noAudioTrack)
      }
      setRead({ text: parts.join(' · '), ok: true })
    }
    tick()
    const timer = setInterval(tick, 2000)
    return () => clearInterval(timer)
  }, [localStream, t])

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium">{t.device.liveTitle}</div>
        <span
          className={cn('h-1.5 w-1.5 rounded-full', read.ok ? 'bg-emerald-500' : 'bg-amber-500')}
          aria-hidden
        />
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-muted-foreground" aria-live="polite">
        {read.text || t.device.noStream}
      </p>
    </div>
  )
}

const VB_COLORS = ['#14532d', '#0f766e', '#27272a', '#3f3f46', '#57534e', '#7c2d12', '#713f12', '#4a1942']

/** 虚拟背景图片压缩：等比缩到 ≤1280 宽 JPEG（dataURL ≤1.5MB 可入 localStorage） */
async function compressBgImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('read'))
    fr.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('decode'))
    img.src = dataUrl
  })
  const w = Math.min(img.naturalWidth, 1280)
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/** 常见蓝牙音频设备命名特征（系统枚举 label；大小写不敏感） */
const BT_DEVICE_RE = /蓝牙|bluetooth|airpods|buds|wh\d|wf\d|linkbuds|elite \d|momentum|headphone|耳机/i

export function DeviceSettings() {
  const devices = useVeil((s) => s.devices)
  const localStream = useVeil((s) => s.localStream)
  const mirrorSelf = useVeil((s) => s.mirrorSelf)
  const qualityPref = useVeil((s) => s.qualityPref)
  const serverDefaultQuality = useVeil((s) => s.serverDefaultQuality)
  const shareTier = useVeil((s) => s.shareTier)
  const enhanceOn = useVeil((s) => s.enhanceOn)
  const enhanceLevel = useVeil((s) => s.enhanceLevel)
  const interpOn = useVeil((s) => s.interpOn)
  const vbgMode = useVeil((s) => s.vbgMode)
  const vbgBlur = useVeil((s) => s.vbgBlur)
  const vbgColor = useVeil((s) => s.vbgColor)
  const vbgImage = useVeil((s) => s.vbgImage)
  const vbgGradient = useVeil((s) => s.vbgGradient)
  const vbgStatus = useVeil((s) => s.vbgStatus)
  const vbgDegraded = useVeil((s) => s.vbgDegraded)
  const t = useDict()

  // 画质偏好恢复：首次挂载时从 localStorage 读回（入房后可热切；新档位类型以外旧值忽略）
  useEffect(() => {
    try {
      const saved = localStorage.getItem('veil-quality')
      if (isQualityTier(saved)) {
        useVeil.getState().set({ qualityPref: saved })
      }
    } catch { /* noop */ }
  }, [])

  // F-45 镜像开关：store + localStorage 双写（刷新记忆）
  const setMirror = (v: boolean) => {
    useVeil.getState().set({ mirrorSelf: v })
    try {
      localStorage.setItem('veil-mirror', String(v))
    } catch { /* noop */ }
  }

  // 防线 1+2：仅保留带有效 id 的设备并去重（BUG-14：空 id 会让 SelectItem 崩溃）
  const cams = useMemo(() => dedupeDevices(devices.filter((d) => d.kind === 'videoinput' && d.deviceId)), [devices])
  const mics = useMemo(() => dedupeDevices(devices.filter((d) => d.kind === 'audioinput' && d.deviceId)), [devices])
  // 蓝牙音频设备（耳机/麦克风）：按常见蓝牙设备命名特征识别（系统需已配对并连接）
  const btDevices = useMemo(
    () => devices.filter((d) => d.kind !== 'videoinput' && d.deviceId && BT_DEVICE_RE.test(d.label || '')),
    [devices],
  )
  const audioOutputId = useVeil((s) => s.audioOutputId)

  // 防线 3：枚举返回了该类设备，但没有任何有效 id —— 判定为「未授权」而非「无设备」
  const camDenied = cams.length === 0 && devices.some((d) => d.kind === 'videoinput')
  const micDenied = mics.length === 0 && devices.some((d) => d.kind === 'audioinput')

  const [cam, setCam] = useState('')
  const [mic, setMic] = useState('')

  useEffect(() => {
    // 从设备枚举结果同步默认选中项（仅在尚未选择或已选项被拔出时）
    /* eslint-disable react-hooks/set-state-in-effect */
    const c = cams[0]?.deviceId || ''
    const m = mics[0]?.deviceId || ''
    setCam((prev) => (prev && cams.some((d) => d.deviceId === prev) ? prev : c))
    setMic((prev) => (prev && mics.some((d) => d.deviceId === prev) ? prev : m))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [cams, mics])

  // 防线 4：授权成功（localStream 由无到有，含 retryMedia 成功）后自动重新枚举
  const hadStream = useRef(false)
  useEffect(() => {
    if (localStream && !hadStream.current) {
      hadStream.current = true
      void controller.refreshDevices()
    }
    if (!localStream) hadStream.current = false
  }, [localStream])

  // 【Task 36】移动端钳制状态同步（解除后立即消失；存储变化 2s 轮询）
  const [clamped, setClamped] = useState(false)
  useEffect(() => {
    const sync = () => setClamped(mobileClampActive() && !['360p', '720p', '1080p'].includes(qualityPref))
    sync()
    const timer = setInterval(sync, 2000)
    return () => clearInterval(timer)
  }, [qualityPref])

  return (
    <div className="flex max-h-[var(--radix-popover-content-available-height,85dvh)] flex-col">
      {/* 标题栏：shrink-0 固定，主体滚动时保持可见（Task 41 iPad 裁切修复） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b px-4 py-2.5 text-xs font-medium tracking-wide text-muted-foreground">
        <Settings2 size={12} aria-hidden /> {t.control.devices}
      </div>
      {/* 主体：内部滚动 + overscroll-contain —— 面板作为独立滚动个体，手势不再链到背后页面 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <Camera size={13} /> {t.device.camera}
        </Label>
        <Select
          value={cam}
          onValueChange={(v) => {
            setCam(v)
            void controller.switchDevice('video', v)
          }}
        >
          <SelectTrigger className="h-9 text-xs" aria-label={t.device.camera}>
            <SelectValue placeholder={cams.length ? t.device.pickDevice : t.device.noDevice} />
          </SelectTrigger>
          <SelectContent>
            {cams.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} className="text-xs">
                {d.label || fmt(t.device.camFallback, { id: d.deviceId.slice(0, 8) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {camDenied && (
          <p className="flex items-start gap-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400" role="note">
            <ShieldAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
            {t.device.noPermission}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <Mic size={13} /> {t.device.mic}
        </Label>
        <Select
          value={mic}
          onValueChange={(v) => {
            setMic(v)
            void controller.switchDevice('audio', v)
          }}
        >
          <SelectTrigger className="h-9 text-xs" aria-label={t.device.mic}>
            <SelectValue placeholder={mics.length ? t.device.pickDevice : t.device.noDevice} />
          </SelectTrigger>
          <SelectContent>
            {mics.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} className="text-xs">
                {d.label || fmt(t.device.micFallback, { id: d.deviceId.slice(0, 8) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {micDenied && (
          <p className="flex items-start gap-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400" role="note">
            <ShieldAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
            {t.device.noPermission}
          </p>
        )}
      </div>

      {/* 蓝牙设备（2026-10）：检测已配对/已连接的蓝牙音频设备（耳机/麦克风），一键用作麦克风或扬声器 */}
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <Bluetooth size={12} className="text-sky-500" /> {t.device.btTitle}
          <button
            type="button"
            onClick={() => void controller.refreshDevices()}
            className="ml-auto flex h-5 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[9px] text-muted-foreground transition-colors hover:border-sky-500/50 hover:text-sky-600"
          >
            <RefreshCcw size={9} /> {t.device.btScan}
          </button>
        </div>
        {btDevices.length === 0 ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground">{t.device.btEmpty}</p>
        ) : (
          <div className="space-y-1.5">
            {btDevices.map((d) => (
              <div key={d.deviceId} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/50 bg-background px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={d.label}>{d.label}</span>
                {d.kind === 'audioinput' && (
                  <Button
                    size="sm"
                    variant={mic === d.deviceId ? 'secondary' : 'outline'}
                    className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      setMic(d.deviceId)
                      void controller.switchDevice('audio', d.deviceId)
                    }}
                  >
                    {mic === d.deviceId ? t.device.btInUse : t.device.btUseMic}
                  </Button>
                )}
                {d.kind === 'audiooutput' && (
                  <Button
                    size="sm"
                    variant={audioOutputId === d.deviceId ? 'secondary' : 'outline'}
                    className="h-6 px-2 text-[10px]"
                    onClick={() => controller.setAudioOutput(d.deviceId)}
                  >
                    {audioOutputId === d.deviceId ? t.device.btInUse : t.device.btUseSpeaker}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">{t.device.btNote}</p>
      </div>
      {/* 设备实时读数：让「读到的镜头有点怪」可见可查（真实分辨率/帧率/音轨状态） */}
      <DeviceReadout />
      {/* 画质热切换（360p→4K60 七档）：applyConstraints 不断流；个人偏好优先于管理员全局默认 */}
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <div className="text-xs font-medium">{t.device.qualityLabel}</div>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{qualityPref}</span>
        </div>
        <Select
          value={qualityPref}
          onValueChange={(v) => {
            if (isQualityTier(v)) void controller.setCameraQuality(v)
          }}
        >
          <SelectTrigger className="h-9 text-xs" aria-label={t.device.qualityLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="360p" className="text-xs">{t.device.q360}</SelectItem>
            <SelectItem value="720p" className="text-xs">{t.device.q720}</SelectItem>
            <SelectItem value="1080p" className="text-xs">{t.device.q1080}</SelectItem>
            <SelectItem value="1080p60" className="text-xs">{t.device.q1080p60}</SelectItem>
            <SelectItem value="1440p60" className="text-xs">{t.device.q1440p60}</SelectItem>
            <SelectItem value="4k30" className="text-xs">{t.device.q4k30}</SelectItem>
            <SelectItem value="4k60" className="text-xs">{t.device.q4k60}</SelectItem>
            <SelectItem value="8k60" className="text-xs">{t.device.q8k60}</SelectItem>
            <SelectItem value="8k144" className="text-xs">{t.device.q8k144}</SelectItem>
          </SelectContent>
        </Select>
        {serverDefaultQuality && (
          <div className="mt-1 text-[10px] font-medium text-sky-600 dark:text-sky-400">
            {fmt(t.device.qualityAdmin, { tier: serverDefaultQuality })}
          </div>
        )}
        {/* 【Task 36】移动端钳制透明化：原因素（防卡顿）可见可解除（用户反馈「4K 镜头连 1080 都没有」） */}
        {clamped && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
            <span className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">{t.device.clampNote}</span>
            <button
              type="button"
              onClick={() => {
                try { localStorage.setItem('veil-mobile-clamp-off', '1') } catch { /* noop */ }
                setClamped(false)
                void controller.setCameraQuality(qualityPref)
              }}
              className="h-6 shrink-0 cursor-pointer rounded-md border border-amber-500/40 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
            >
              {t.device.clampOff}
            </button>
          </div>
        )}
        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t.device.qualityDesc}</div>
      </div>
      {/* 屏幕共享画质档（Task 25「共享没得 4K60」）：auto/1080p60/4k60；下次开启共享生效
          【Task 38】仅对支持 getDisplayMedia 的浏览器渲染（iPhone Safari 不支持 → 不展示死配置） */}
      {!canShareScreen ? (
        <div className="rounded-lg bg-muted/40 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
          {t.device.shareUnsupported}
        </div>
      ) : (
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <MonitorUp size={12} className="text-violet-500" /> {t.device.shareQualityLabel}
        </div>
        <Select
          value={shareTier}
          onValueChange={(v) => {
            if (v === 'auto' || v === '1080p60' || v === '4k60' || v === '8k144') controller.setShareTier(v)
          }}
        >
          <SelectTrigger className="h-9 text-xs" aria-label={t.device.shareQualityLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto" className="text-xs">{t.device.shareAuto}</SelectItem>
            <SelectItem value="1080p60" className="text-xs">{t.device.share1080p60}</SelectItem>
            <SelectItem value="4k60" className="text-xs">{t.device.share4k60}</SelectItem>
            <SelectItem value="8k144" className="text-xs">{t.device.share8k144}</SelectItem>
          </SelectContent>
        </Select>
        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t.device.shareQualityDesc}</div>
      </div>
      )}
      {/* AI 画面增强（自动曝光）：暗光/背光自适应补光；强度可调，热切换不断流 */}
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Sparkles size={12} className={cn('shrink-0', enhanceOn ? 'text-amber-500' : 'text-muted-foreground')} />
            <div className="min-w-0">
              <div className="text-xs font-medium">{t.device.enhanceLabel}</div>
              <div className={cn('text-[10px] font-medium', enhanceOn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                {enhanceOn ? t.device.enhanceOnLabel : t.device.enhanceOffLabel}
              </div>
            </div>
          </div>
          <Switch
            checked={enhanceOn}
            onCheckedChange={(v) => void controller.setEnhance(v)}
            aria-label={t.device.enhanceLabel}
          />
        </div>
        {enhanceOn && (
          <div className="mt-2.5">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] font-medium text-muted-foreground">{t.device.enhanceLevel}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{Math.round(enhanceLevel * 100)}%</span>
            </div>
            <Slider
              value={[enhanceLevel]}
              min={0.45}
              max={0.75}
              step={0.01}
              onValueChange={(vals) => void controller.setEnhance(true, vals[0])}
              aria-label={t.device.enhanceLevel}
            />
          </div>
        )}
        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t.device.enhanceDesc}</div>
      </div>
      {/* 【Task 36】合成补帧（插帧）：低帧率源倍频平滑；链在增强/虚拟背景之后（混合最终合成画面） */}
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Gauge size={12} className={cn('shrink-0', interpOn ? 'text-cyan-600 dark:text-cyan-400' : 'text-muted-foreground')} />
            <div className="min-w-0">
              <div className="text-xs font-medium">{t.device.interpLabel}</div>
              <div className={cn('text-[10px] font-medium', interpOn ? 'text-cyan-600 dark:text-cyan-400' : 'text-muted-foreground')}>
                {interpOn ? t.device.interpOnLabel : t.device.interpOffLabel}
              </div>
            </div>
          </div>
          <Switch
            checked={interpOn}
            onCheckedChange={(v) => void controller.setInterp(v)}
            aria-label={t.device.interpLabel}
          />
        </div>
        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t.device.interpDesc}</div>
      </div>
  {/* 虚拟背景（Zoom 化）：本地分割推理，模糊/纯色/图片三模式热切换 */}
      <div className="rounded-lg bg-muted/40 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Wand2 size={12} className={cn('shrink-0', vbgMode !== 'off' ? 'text-emerald-500' : 'text-muted-foreground')} />
            <div className="min-w-0">
              <div className="text-xs font-medium">{t.device.vbgLabel}</div>
              <div className={cn(
                'text-[10px] font-medium',
                vbgStatus === 'failed'
                  ? 'text-amber-600 dark:text-amber-400'
                  : vbgMode !== 'off' && vbgStatus === 'ready'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-muted-foreground',
              )}>
                {vbgStatus === 'failed'
                  ? t.device.vbgFailed
                  : vbgMode === 'off'
                    ? t.device.vbgIdle
                    : vbgStatus === 'ready'
                      ? t.device.vbgReady
                      : t.device.vbgLoading}
              </div>
              {vbgDegraded && <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400">{t.device.vbgDegradedNote}</div>}
            </div>
          </div>
        </div>
        <div className="mt-2.5 grid grid-cols-4 gap-1.5" role="group" aria-label={t.device.vbgLabel}>
          {([
            ['off', t.device.vbgOff],
            ['blur', t.device.vbgBlur],
            ['color', t.device.vbgColor],
            ['image', t.device.vbgImage],
          ] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => void controller.setVirtualBg({ mode: m })}
              aria-pressed={vbgMode === m}
              className={cn(
                'h-7 cursor-pointer rounded-md border text-[10px] font-medium transition-colors',
                vbgMode === m
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                  : 'border-border/60 bg-background/60 text-muted-foreground hover:border-emerald-500/40 hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {vbgMode === 'blur' && (
          <div className="mt-2.5">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] font-medium text-muted-foreground">{t.device.vbgBlurLevel}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{vbgBlur}px</span>
            </div>
            <Slider
              value={[vbgBlur]}
              min={4}
              max={28}
              step={1}
              onValueChange={(vals) => void controller.setVirtualBg({ blur: vals[0] })}
              aria-label={t.device.vbgBlurLevel}
            />
          </div>
        )}
        {vbgMode === 'color' && (
          <div className="mt-2.5" role="group" aria-label={t.device.vbgColorLabel}>
            <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">{t.device.vbgColorLabel}</div>
            <div className="grid grid-cols-8 gap-1.5">
              {VB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => void controller.setVirtualBg({ color: c })}
                  aria-label={c}
                  aria-pressed={vbgColor === c}
                  className={cn(
                    'h-6 w-full cursor-pointer rounded-md border transition-transform hover:scale-105',
                    vbgColor === c ? 'border-emerald-500 ring-1 ring-emerald-500/50' : 'border-border/50',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        )}
        {vbgMode === 'image' && (
          <div className="mt-2.5 space-y-2">
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t.device.vbgLabel}>
              {([
                ['dusk', t.device.vbgPresetDusk, 'linear-gradient(135deg,#312e5f,#7b4b6e,#e0956b)'],
                ['ocean', t.device.vbgPresetOcean, 'linear-gradient(135deg,#0b3a53,#12656e,#5fb99f)'],
                ['mint', t.device.vbgPresetMint, 'linear-gradient(135deg,#0d4a3f,#1d7a5f,#a3d9b5)'],
              ] as const).map(([g, label, css]) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => void controller.setVirtualBg({ gradient: g })}
                  aria-pressed={vbgImage === null && vbgGradient === g}
                  className="group h-9 cursor-pointer overflow-hidden rounded-md border border-border/60 transition-transform hover:scale-[1.03]"
                  title={label}
                >
                  <span className="block h-full w-full" style={{ background: css }} />
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-foreground">
                <ImageUp size={11} aria-hidden />
                {t.device.vbgPickImage}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    try {
                      const dataUrl = await compressBgImage(f)
                      await controller.setVirtualBg({ image: dataUrl })
                    } catch {
                      toast({ description: t.device.vbgImageError })
                    }
                  }}
                />
              </label>
              {vbgImage && (
                <>
                  <img src={vbgImage} alt="" className="h-7 w-12 rounded-md border border-border/60 object-cover" />
                  <button
                    type="button"
                    onClick={() => void controller.setVirtualBg({ image: null })}
                    aria-label={t.device.vbgClearImage}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-red-400/60 hover:text-red-500"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{t.device.vbgDesc}</div>
      </div>
      {/* F-45 镜像我的视频（Zoom 式预览镜像；远端永远看到正向画面） */}
      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{t.device.mirror}</div>
          <div className="text-[10px] leading-relaxed text-muted-foreground">{t.device.mirrorDesc}</div>
        </div>
        <Switch
          checked={mirrorSelf}
          onCheckedChange={setMirror}
          aria-label={t.device.mirror}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t.device.note}
      </p>
      </div>
    </div>
  )
}
