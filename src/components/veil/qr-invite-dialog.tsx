'use client';

/**
 * QRInviteDialog — 邀请链接二维码：本地生成，不经任何网络；
 * 若勾选"口令包含在链接中"，二维码同样携带 #pass 片段并给出醒目提示。
 */

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useVeil } from '@/store/veil-store'
import { buildInviteUrl } from '@/lib/webrtc/controller'
import { Check, Copy, KeyRound, QrCode, Share2 } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from '@/hooks/use-toast'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

/** Web Share 能力检测：服务端 false，客户端真实值（hydration 安全） */
const subscribeNoop = () => () => {}
const canShareSnapshot = () => typeof navigator !== 'undefined' && !!navigator.share
const canShareServer = () => false

export function QRInviteDialog() {
  const roomId = useVeil((s) => s.roomId)
  const passInLink = useVeil((s) => s.passInLink)
  const passphrase = useVeil((s) => s.passphrase)
  const t = useDict()
  const [copied, setCopied] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const canShare = useSyncExternalStore(subscribeNoop, canShareSnapshot, canShareServer)

  // 打开弹窗时才派生（buildInviteUrl 依赖 window.location，仅客户端）
  const url = open && roomId ? buildInviteUrl(roomId) : ''
  // passInLink/passphrase 参与依赖跟踪（构建器内部读取）
  void passInLink
  void passphrase

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: t.invite.copyFailed, variant: 'destructive' })
    }
  }

  const share = async () => {
    if (!url) return
    try {
      await navigator.share({
        title: t.invite.shareTitle,
        text: fmt(t.invite.shareText, { room: roomId }),
        url,
      })
    } catch {
      /* 用户取消分享不需要提示 */
    }
  }

  const withPass = url.includes('#pass=')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 transition-all duration-150 hover:bg-emerald-500/15 hover:text-emerald-600 active:scale-90 dark:hover:text-emerald-300"
          title={t.invite.triggerTitle}
          aria-label={t.invite.triggerTitle}
        >
          <QrCode size={15} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <QrCode size={15} className="text-emerald-500" />
            {t.invite.title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t.invite.desc}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          {/* 房间码大字展示：发链接的人能直接看到对方将加入的房间（解决「别人不知道我的房间码」） */}
          <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-300">{t.invite.roomCode}</div>
              <div className="truncate font-mono text-lg font-bold tracking-wider text-foreground" aria-label={t.invite.roomCode}>{roomId}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(roomId)
                  setCodeCopied(true)
                  setTimeout(() => setCodeCopied(false), 1500)
                  toast({ title: t.invite.roomCodeCopied, description: roomId })
                } catch {
                  toast({ title: t.invite.copyFailed, variant: 'destructive' })
                }
              }}
            >
              {codeCopied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {codeCopied ? t.invite.copied : t.invite.copyRoomCode}
            </Button>
          </div>
          {withPass && (
            <div className="flex w-full items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
              <KeyRound size={12} className="mt-0.5 shrink-0" />
              <span>{t.invite.passWarning}</span>
            </div>
          )}
          <div className="veil-qr-frame relative overflow-hidden rounded-2xl border border-border/60 bg-white p-4">
            {url ? (
              <QRCodeSVG
                value={url}
                size={196}
                level="M"
                marginSize={1}
                bgColor="#ffffff"
                fgColor="#0f172a"
                className="animate-in fade-in zoom-in-[0.96] duration-300"
              />
            ) : (
              <div className="h-[196px] w-[196px] animate-pulse rounded-lg bg-zinc-100" />
            )}
          </div>
          <div className="w-full rounded-lg bg-muted/50 px-2.5 py-2">
            <div className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground">{url || t.invite.generating}</div>
          </div>
          <div className="flex w-full gap-2">
            <Button size="sm" variant="outline" className="w-full gap-1.5 transition-all hover:border-emerald-500/40 hover:text-emerald-600 active:scale-[0.98] dark:hover:text-emerald-300" onClick={copy} disabled={!url}>
              {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              {copied ? t.invite.copied : t.invite.copyLink}
            </Button>
            {canShare && (
              <Button
                size="sm"
                className="veil-shine w-full gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white transition-all active:scale-[0.98]"
                onClick={share}
                disabled={!url}
                aria-label={t.invite.shareAria}
              >
                <Share2 size={13} />
                {t.invite.share}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
