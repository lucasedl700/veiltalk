'use client';

/**
 * ControlBar — 悬浮控制条：麦克风/摄像头/屏幕共享/表情反应/举手/设备设置/复制邀请/更多/离房
 *
 * Zoom 化（F-41/F-42）：
 *  - Reactions：Popover emoji 网格 → DataChannel 广播 → 舞台浮起动画（双方）
 *  - 举手：状态徽标 + 对端 toast 提醒
 *  - 更多菜单：移动端收纳 [录制/设备/邀请]，全尺寸保留 [键盘快捷键]；
 *    移动端平铺压缩到 7 键（40px 档）不溢出 390px 视口
 *  - 设备与画质：桌面 Popover / 移动端 Dialog（同一 DeviceSettings 组件双形态复用）
 */

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useVeil } from '@/store/veil-store'
import { controller, buildInviteUrl } from '@/lib/webrtc/controller'
import { DeviceSettings } from './device-settings'
import {
  Check, Circle, Copy, Hand, Keyboard, LogOut, Mic, MicOff, MonitorUp, MoreVertical,
  Settings2, SmilePlus, Square, Video, VideoOff,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

/** 【Task 38】屏幕共享能力（getDisplayMedia）探测：iPhone Safari 等不支持 → 共享按钮与相关配置隐藏 */
const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

/** 控制条统一按钮尺寸：移动端 40px 保证 7 键不溢出，≥sm 恢复 44px 触控目标 */
const CTRL_SIZE = 'h-10 w-10 sm:h-11 sm:w-11'

/** F-41 反应面板 emoji 集（Zoom 式高频反应；纯符号，控制面仅传符号无内容） */
const REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '😮', '🎉', '👋', '✨'] as const

function fmtRecMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function ControlBar() {
  const micOn = useVeil((s) => s.micOn)
  const camOn = useVeil((s) => s.camOn)
  const screenSharing = useVeil((s) => s.screenSharing)
  const roomId = useVeil((s) => s.roomId)
  const recording = useVeil((s) => s.recording)
  const recordingMs = useVeil((s) => s.recordingMs)
  const recordingBytes = useVeil((s) => s.recordingBytes)
  const handRaised = useVeil((s) => !!s.raisedHands.__local__)
  const set = useVeil((s) => s.set)
  const t = useDict()
  const [copied, setCopied] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [devicesDialog, setDevicesDialog] = useState(false)

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(buildInviteUrl(roomId))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast({ title: t.control.inviteCopied })
    } catch {
      toast({ title: t.control.copyFailed, variant: 'destructive' })
    }
  }

  const leave = () => {
    controller.leave()
    toast({ title: t.control.leftRoom })
  }

  return (
    <TooltipProvider delayDuration={200}>
      {/* BUG-15 修复：z-40 高于移动端面板悬浮按钮（z-30），否则 390px 下「更多/离开」被遮挡；
          低于 Sheet/Popover portal（z-50），弹层不受影响。
          safe-area 底部内边距（Task 28）：iPad Safari 横屏底部地址栏 / iOS 全面屏
          home indicator 也会压缩底部可视区，env() 防止控制栏贴边被遮挡 */}
      <div className="pointer-events-none sticky bottom-2 z-40 flex flex-col items-center gap-2 pb-[calc(4px+env(safe-area-inset-bottom))]">
        {/* 录制状态 pill（录制中显示） */}
        {recording && (
          <div
            role="status"
            aria-label={fmt(t.control.recAria, { time: fmtRecMs(recordingMs) })}
            className="veil-rec-pill pointer-events-auto flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-[11px] font-semibold text-red-600 shadow-lg shadow-red-500/15 backdrop-blur-xl dark:text-red-300"
          >
            <span aria-hidden className="veil-rec-dot relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            REC {fmtRecMs(recordingMs)}
            {recordingBytes > 0 && (
              <span className="font-normal tabular-nums opacity-75">{(recordingBytes / 1024 / 1024).toFixed(1)} MB</span>
            )}
          </div>
        )}
        <div className="pointer-events-auto relative flex items-center gap-1.5 overflow-hidden rounded-2xl border border-white/50 bg-background/80 p-1.5 shadow-2xl shadow-black/15 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/75 dark:shadow-black/60">
          {/* 毛玻璃顶部高光渐变边 + 内层渐变光泽 */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent dark:via-white/25" />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.07] to-transparent dark:from-white/[0.05]" />
          <CtrlBtn onClick={controller.toggleMic} label={micOn ? t.control.micOff : t.control.micOn} danger={!micOn}>
            {micOn ? <Mic size={18} /> : <MicOff size={18} className="text-red-500" />}
          </CtrlBtn>
          <CtrlBtn onClick={controller.toggleCam} label={camOn ? t.control.camOff : t.control.camOn} danger={!camOn}>
            {camOn ? <Video size={18} /> : <VideoOff size={18} className="text-red-500" />}
          </CtrlBtn>
          {/* 【Task 38】屏幕共享能力检测：iPhone Safari 等不支持 getDisplayMedia → 按钮不渲染（点了也是报错） */}
          {(canShareScreen || screenSharing) && (
            <CtrlBtn onClick={() => void controller.toggleScreen()} label={screenSharing ? t.control.shareStop : t.control.shareStart} tone="violet">
              <MonitorUp size={18} className={screenSharing ? 'text-violet-500' : ''} />
            </CtrlBtn>
          )}

          {/* 录制（≥sm 平铺；移动端收进「更多」） */}
          <CtrlBtn
            onClick={() => void controller.toggleRecording()}
            label={recording ? t.control.recStop : t.control.recStart}
            danger={recording}
            className="hidden sm:inline-flex"
          >
            {recording ? (
              <Square size={16} className="fill-red-500 text-red-500" />
            ) : (
              <Circle size={16} className="text-red-500/80 transition-colors hover:text-red-500" />
            )}
          </CtrlBtn>

          {/* 设备与画质（≥sm 平铺 Popover；移动端收进「更多」以 Dialog 打开） */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn(CTRL_SIZE, 'hidden rounded-xl sm:inline-flex')} aria-label={t.control.devices}>
                    <Settings2 size={18} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t.control.devices}</TooltipContent>
            </Tooltip>
            {/* 【Task 41】iPad 面板裁切修复：overflow-hidden 配合 DeviceSettings 根节点自钳制
                （max-h=Radix 可用高度），圆角内裁不外溢；sm:w-80 桌面/iPad 稍加宽提升密度可读性 */}
            <PopoverContent align="center" side="top" collisionPadding={8} className="w-72 overflow-hidden p-0 sm:w-80">
              <DeviceSettings />
            </PopoverContent>
          </Popover>

          {/* F-41 表情反应 */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn(CTRL_SIZE, 'rounded-xl text-amber-600 hover:text-amber-700 dark:text-amber-400')} aria-label={t.control.reactions}>
                    <SmilePlus size={18} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t.control.reactions}</TooltipContent>
            </Tooltip>
            <PopoverContent align="center" side="top" className="w-56 p-3">
              <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t.control.reactions}>
                {REACTION_EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => controller.sendReaction(e)}
                    className="veil-emoji-btn flex h-11 w-full items-center justify-center rounded-xl text-2xl transition-transform active:scale-[0.88]"
                    aria-label={e}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-center text-[10px] leading-relaxed text-muted-foreground">{t.tile.e2eeBadge}</p>
            </PopoverContent>
          </Popover>

          {/* F-42 举手/放下（举起时琥珀高亮） */}
          <CtrlBtn onClick={controller.toggleHand} label={handRaised ? t.control.lowerHand : t.control.raiseHand} tone={handRaised ? 'amber' : undefined}>
            <Hand size={18} className={handRaised ? 'veil-hand-wave text-amber-500' : ''} />
          </CtrlBtn>

          <div className="mx-1 hidden h-7 w-px bg-border/70 sm:block" />

          {/* 复制邀请（≥sm 平铺；移动端收进「更多」——header 房间号已是快捷复制入口） */}
          <CtrlBtn onClick={copyInvite} label={t.control.copyInvite} className="hidden sm:inline-flex">
            {copied ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
          </CtrlBtn>

          {/* 更多菜单（Zoom 式收纳：移动端 [录制/设备/邀请/快捷键]，桌面 [快捷键]） */}
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn(CTRL_SIZE, 'rounded-xl')} aria-label={t.control.more}>
                    <MoreVertical size={18} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t.control.more}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="center" side="top" className="w-52">
              {/* 移动端专属收纳项 */}
              <DropdownMenuItem className="sm:hidden" onClick={() => void controller.toggleRecording()}>
                {recording ? <Square size={15} className="fill-red-500 text-red-500" /> : <Circle size={15} className="text-red-500/80" />}
                {recording ? t.control.recStop : t.control.recStart}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="sm:hidden"
                onSelect={() => {
                  setMoreOpen(false)
                  setTimeout(() => setDevicesDialog(true), 60) /* 等 menu 关闭再弹 Dialog，避免 portal 竞态 */
                }}
              >
                <Settings2 size={15} /> {t.control.devices}
              </DropdownMenuItem>
              <DropdownMenuItem className="sm:hidden" onSelect={() => { setMoreOpen(false); void copyInvite() }}>
                {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />} {t.control.copyInvite}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => set({ showShortcuts: true })}>
                <Keyboard size={15} /> {t.control.shortcuts}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={leave}
                size="icon"
                className={cn(
                  CTRL_SIZE,
                  'rounded-xl bg-red-600 text-white shadow-lg shadow-red-600/25 transition-transform duration-150 hover:scale-105 hover:bg-red-700 active:scale-[0.93] dark:bg-red-600/90 dark:shadow-red-500/20',
                )}
                aria-label={t.control.leave}
              >
                <LogOut size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.control.leave}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 移动端「设备与画质」Dialog（与桌面 Popover 复用同一 DeviceSettings） */}
      <Dialog open={devicesDialog} onOpenChange={setDevicesDialog}>
        <DialogContent className="max-w-sm p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{t.control.devices}</DialogTitle>
          </DialogHeader>
          <DeviceSettings />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

function CtrlBtn({
  onClick,
  label,
  danger,
  tone,
  className,
  children,
}: {
  onClick: () => void
  label: string
  danger?: boolean
  /** 高亮色调：violet = 屏幕共享，amber = 举手 */
  tone?: 'violet' | 'amber'
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label={label}
          className={cn(
            CTRL_SIZE,
            'rounded-xl transition-all duration-150 hover:bg-muted active:scale-[0.93]',
            danger && 'bg-red-500/10 hover:bg-red-500/15',
            tone === 'violet' && 'bg-violet-500/10 hover:bg-violet-500/15',
            tone === 'amber' && 'bg-amber-500/15 hover:bg-amber-500/20',
            className,
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
