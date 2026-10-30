'use client';

/**
 * ChatPanel — 端到端加密聊天（消息经 chatKey AES-GCM 加密后走 DataChannel）
 *
 * 增量：
 * - typing 输入中指示（2.2s 无击键自动停止，对端 4s 时间戳衰减熄灭）
 * - 消息撤回：自己的消息 hover 出现撤回按钮，双端同步标记为「已撤回」（仅传 id 不传内容）
 * - 系统消息：成员加入/离开等房间事件，居中弱化 pill 展示
 * - 剪贴板粘贴图片：直接作为加密文件发送（与文件面板同管线）
 * - 表情回应：hover 出现 emoji 快捷条，双端同步计数（仅传 id+emoji，不含消息内容）
 * - 记录导出：JSONL 下载（明文导出到本地，仅限本机操作）与一键清空
 */

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useVeil } from '@/store/veil-store'
import { controller } from '@/lib/webrtc/controller'
import { Download, KeyRound, Lock, MessageSquare, Send, ShieldCheck, SmilePlus, Trash2, Undo2, Users, X, ImageIcon } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { EmptyState } from './empty-state'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'

const TYPING_STOP_MS = 2200
const TYPING_STALE_MS = 4000
const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const

export function ChatPanel() {
  const chats = useVeil((s) => s.chats)
  const myName = useVeil((s) => s.myName)
  const typingPeers = useVeil((s) => s.typingPeers)
  const peers = useVeil((s) => s.peers)
  const activeDm = useVeil((s) => s.activeDm)
  const dmUnread = useVeil((s) => s.dmUnread)
  const openDm = useVeil((s) => s.openDm)
  const closeDm = useVeil((s) => s.closeDm)
  const t = useDict()
  const dmPeer = activeDm ? peers[activeDm] : undefined
  const myAvatar = useVeil((s) => s.myAvatar)
  const [text, setText] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const bottomRef = useRef<HTMLDivElement>(null)
  const hasPeers = useVeil((s) => Object.keys(s.peers).length > 0)
  const typingSentRef = useRef(false)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatRef = useRef(0)

  // 会话分组：群聊显示无 dm 标记的消息；私信只显示与该对象的往来
  const visibleChats = activeDm
    ? chats.filter((c) => c.dmSocketId === activeDm)
    : chats.filter((c) => !c.dmSocketId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visibleChats.length])

  // typing 指示器过期衰减（4s 无刷新即熄灭；仅有人在输入时才轮询，空闲零开销）
  const typingActive = Object.values(typingPeers).some((p) => now - p.ts < TYPING_STALE_MS)
  useEffect(() => {
    if (!typingActive) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [typingActive])

  const stopTyping = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (typingSentRef.current) {
      typingSentRef.current = false
      controller.sendTyping(false)
    }
  }, [])

  // 卸载时兜底停止输入指示
  useEffect(() => () => stopTyping(), [stopTyping])

  const onTextInput = (value: string) => {
    setText(value)
    if (!value.trim()) {
      stopTyping()
      return
    }
    const nowMs = Date.now()
    if (!typingSentRef.current) {
      typingSentRef.current = true
      controller.sendTyping(true)
      heartbeatRef.current = nowMs
    } else if (nowMs - heartbeatRef.current > 1800) {
      // 长时间连续输入的心跳刷新（对端 4s 过期窗口内续期）
      heartbeatRef.current = nowMs
    }
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    stopTimerRef.current = setTimeout(stopTyping, TYPING_STOP_MS)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    stopTyping()
    controller.sendChat(text, activeDm || undefined)
    setText('')
  }

  /** 剪贴板粘贴：文件（截图/图片）直接进入加密文件传输管线 */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(e.clipboardData?.files || [])
    if (files.length === 0) return
    e.preventDefault()
    if (!hasPeers) {
      toast({ title: t.chat.toastNoPeers, description: t.chat.toastNoPeersDesc, variant: 'destructive' })
      return
    }
    files.forEach((f) => controller.sendFile(f))
    toast({
      title: fmt(t.chat.toastPasted, { count: files.length }),
      description: t.chat.toastPastedDesc,
    })
  }

  const typingNames = Object.values(typingPeers)
    .filter((p) => now - p.ts < TYPING_STALE_MS)
    .map((p) => p.name)

  const roomId = useVeil((s) => s.roomId)
  const [reactBarFor, setReactBarFor] = useState<string | null>(null)

  /** 导出聊天记录为 JSONL（明文，仅落在本机；不含密钥/密文） */
  const exportChats = () => {
    const list = useVeil.getState().chats.filter((c) => !c.system)
    if (list.length === 0) {
      toast({ title: t.chat.toastNothingToExport })
      return
    }
    const lines = list.map((c) =>
      JSON.stringify({ ts: new Date(c.ts).toISOString(), from: c.name, mine: c.mine, recalled: !!c.recalled, reactions: c.reactions || {}, text: c.text }),
    )
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/jsonl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `veiltalk-chat-${roomId || 'room'}-${new Date().toISOString().slice(0, 10)}.jsonl`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 15000)
    toast({ title: fmt(t.chat.toastExported, { count: list.length }), description: t.chat.toastExportedDesc })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      {/* 工具行：加密标识 + 导出 / 清空 */}
      <div className="flex items-center gap-1 px-1 text-[9px] text-muted-foreground/70">
        <Lock size={9} className="text-emerald-500" />
        <span className="flex-1">{t.chat.encLabel}</span>
        <button
          onClick={exportChats}
          className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t.chat.exportAria}
          title={t.chat.exportTitle}
        >
          <Download size={10} /> {t.chat.export}
        </button>
        <button
          onClick={() => {
            controller.clearChats()
            toast({ title: t.chat.toastCleared, description: t.chat.toastClearedDesc })
          }}
          className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 transition-colors hover:bg-red-500/10 hover:text-red-500"
          aria-label={t.chat.clearAria}
          title={t.chat.clearTitle}
        >
          <Trash2 size={10} /> {t.chat.clear}
        </button>
      </div>
      {/* 会话切换：群聊 + 各成员私信（点头像/tile 私信按钮也会切到这里） */}
      <div className="flex items-center gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]" role="tablist" aria-label={t.chat.dmGroupAria}>
        <button
          role="tab"
          aria-selected={!activeDm}
          onClick={() => closeDm()}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-all active:scale-95',
            !activeDm
              ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
              : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-emerald-500/40 hover:text-emerald-600',
          )}
        >
          <Users size={11} /> {t.chat.dmGroup}
        </button>
        {Object.values(peers).map((p) => {
          const unread = dmUnread[p.socketId] || 0
          const act = activeDm === p.socketId
          return (
            <button
              key={p.socketId}
              role="tab"
              aria-selected={act}
              onClick={() => openDm(p.socketId)}
              title={fmt(t.chat.dmWith, { name: p.name || t.chat.anonymous })}
              className={cn(
                'relative flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-1 text-[11px] font-medium transition-all active:scale-95',
                act
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                  : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-emerald-500/40 hover:text-emerald-600',
              )}
            >
              <span className="relative">
                {p.avatar ? (
                  <img src={p.avatar} alt="" className="h-5 w-5 rounded-full object-cover" draggable={false} />
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-[9px] font-bold text-emerald-600 dark:text-emerald-300">
                    {(p.name || '?').slice(0, 1).toUpperCase()}
                  </span>
                )}
                {unread > 0 && !act && (
                  <span className="veil-badge-pop absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-emerald-600 px-0.5 text-[8px] font-bold leading-none text-white">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </span>
              <span className="max-w-[88px] truncate">{p.name || t.chat.anonymous}</span>
            </button>
          )
        })}
      </div>

      {/* 私信上下文条 */}
      {activeDm && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <MessageSquare size={11} className="shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1 truncate">{t.chat.dmHint}</span>
          <button
            onClick={() => closeDm()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t.chat.dmGroupAria}
          >
            <X size={11} />
          </button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 pr-1">
        {visibleChats.length === 0 ? (
          <EmptyState
            icon={activeDm ? MessageSquare : Lock}
            title={activeDm ? fmt(t.chat.dmWith, { name: dmPeer?.name || t.chat.anonymous }) : t.chat.emptyTitle}
            desc={activeDm ? fmt(t.chat.dmEmpty, { name: dmPeer?.name || t.chat.anonymous }) : t.chat.emptyDesc}
            chips={[
              { icon: Send, cls: 'text-teal-500', pos: '-left-8 top-1', delay: '[animation-delay:-1.8s]' },
              { icon: KeyRound, cls: 'text-emerald-500', pos: '-right-8 -top-1' },
              { icon: ShieldCheck, cls: 'text-cyan-500', pos: 'left-7 -bottom-7', delay: '[animation-delay:-3.2s]' },
            ]}
          />
        ) : (
          <div className="space-y-2 pb-2">
            {visibleChats.map((c) =>
              c.system ? (
                /* 系统提示：居中弱化 pill */
                <div key={c.id} className="veil-sys-msg flex justify-center">
                  <span className="rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[10px] text-muted-foreground">
                    {c.text}
                  </span>
                </div>
              ) : (
                <div key={c.id} className={cn('veil-chat-row flex', c.mine ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'veil-msg-bubble group relative max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-sm',
                      c.mine
                        ? 'rounded-br-sm bg-gradient-to-br from-emerald-600 to-teal-600 text-white'
                        : 'rounded-bl-sm border border-border/60 bg-card',
                      c.recalled && 'veil-msg-recalled border-dashed opacity-70',
                    )}
                  >
                    {!c.mine && !c.recalled && (
                      <div className="mb-0.5 text-[10px] font-semibold text-emerald-500">{c.name}</div>
                    )}
                    {c.recalled ? (
                      <div className={cn('flex items-center gap-1 text-[11px] italic', c.mine ? 'text-white/70' : 'text-muted-foreground')}>
                        <Undo2 size={10} />
                        {t.chat.recalled}
                      </div>
                    ) : (
                      <div className="break-words whitespace-pre-wrap">{c.text}</div>
                    )}
                    {/* 表情回应徽标（双端同步计数；自己已点的高亮） */}
                    {c.reactions && Object.keys(c.reactions).length > 0 && (
                      <div className={cn('mt-1 flex flex-wrap gap-1', c.mine && 'justify-end')}>
                        {Object.entries(c.reactions).map(([emoji, count]) => (
                          <button
                            key={emoji}
                            onClick={() => {
                              const mine = !!c.myReactions?.includes(emoji)
                              controller.reactChat(c.id, emoji, !mine)
                            }}
                            className={cn(
                              'veil-react-pop inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] leading-none transition-all active:scale-90',
                              c.myReactions?.includes(emoji)
                                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                                : 'border-border/60 bg-muted/50 text-muted-foreground hover:border-emerald-500/30 hover:text-emerald-600',
                            )}
                            aria-label={c.myReactions?.includes(emoji) ? fmt(t.chat.reactionAriaCancel, { emoji, count }) : fmt(t.chat.reactionAria, { emoji, count })}
                          >
                            <span aria-hidden>{emoji}</span>
                            <span className="tabular-nums">{count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className={cn('mt-1 text-right text-[9px]', c.mine ? 'text-white/60' : 'text-muted-foreground')}>
                      {new Date(c.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                    </div>
                    {/* hover 按钮区：表情回应（全部消息）+ 撤回（自己的消息） */}
                    {!c.recalled && (
                      <div
                        className={cn(
                          'veil-hover-actions absolute top-1/2 flex -translate-y-1/2 items-center gap-1',
                          c.mine ? '-left-[52px] flex-row-reverse' : '-right-[52px] flex-row',
                        )}
                      >
                        <button
                          onClick={() => setReactBarFor(reactBarFor === c.id ? null : c.id)}
                          className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-muted-foreground transition-all hover:bg-emerald-500/15 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:scale-90"
                          aria-label={fmt(t.chat.reactAria, { text: c.text.slice(0, 12) })}
                          title={t.chat.reactTitle}
                        >
                          <SmilePlus size={11} />
                        </button>
                        {c.mine && (
                          <button
                            onClick={() => controller.recallChat(c.id, c.dmSocketId)}
                            className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-muted-foreground transition-all hover:bg-red-500/15 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 active:scale-90"
                            aria-label={fmt(t.chat.recallAria, { text: c.text.slice(0, 12) })}
                            title={t.chat.recallTitle}
                          >
                            <Undo2 size={11} />
                          </button>
                        )}
                      </div>
                    )}
                    {/* emoji 快捷条（上浮弹出） */}
                    {reactBarFor === c.id && !c.recalled && (
                      <div
                        className={cn(
                          'veil-react-bar absolute z-10 flex items-center gap-0.5 rounded-full border border-border/70 bg-background/95 p-1 shadow-xl backdrop-blur-xl',
                          c.mine ? '-left-2 bottom-full mb-1' : '-right-2 bottom-full mb-1',
                        )}
                        role="menu"
                        aria-label={t.chat.reactBarAria}
                      >
                        {QUICK_EMOJIS.map((em) => {
                          const mine = !!c.myReactions?.includes(em)
                          return (
                            <button
                              key={em}
                              onClick={() => {
                                controller.reactChat(c.id, em, !mine)
                                setReactBarFor(null)
                              }}
                              className={cn(
                                'flex h-7 w-7 items-center justify-center rounded-full text-sm transition-all hover:scale-125 hover:bg-muted active:scale-95',
                                mine && 'bg-emerald-500/15',
                              )}
                              role="menuitem"
                              aria-label={mine ? fmt(t.chat.reactEmojiAriaCancel, { emoji: em }) : fmt(t.chat.reactEmojiAria, { emoji: em })}
                            >
                              {em}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </ScrollArea>

      {/* 输入中指示器（三点跳动） */}
      {typingNames.length > 0 && (
        <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground" aria-live="polite" role="status">
          <span className="flex items-center gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="veil-typing-dot inline-block h-1 w-1 rounded-full bg-emerald-500"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </span>
          {typingNames.length === 1
            ? fmt(t.chat.typingOne, { name: typingNames[0] })
            : fmt(t.chat.typingMany, {
                names: typingNames.slice(0, 2).join(t.chat.typingJoin),
                more: typingNames.length > 2 ? fmt(t.chat.typingMore, { count: typingNames.length }) : '',
              })}
        </div>
      )}

      <div className="flex items-center gap-1 px-1 text-[9px] text-muted-foreground/70">
        <ImageIcon size={9} />
        {t.chat.pasteHint}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => onTextInput(e.target.value)}
          onBlur={stopTyping}
          onPaste={onPaste}
          placeholder={!hasPeers ? t.chat.placeholderWaiting : activeDm ? fmt(t.chat.dmPlaceholder, { name: dmPeer?.name || t.chat.anonymous }) : fmt(t.chat.placeholderAs, { name: myName || t.chat.anonymous })}
          disabled={!hasPeers}
          maxLength={2000}
          className="h-9 text-xs"
          aria-label={t.chat.inputAria}
        />
        <Button type="submit" size="icon" disabled={!hasPeers || !text.trim()} className="h-9 w-9 shrink-0 bg-gradient-to-r from-emerald-600 to-teal-600 text-white transition-all duration-150 hover:shadow-lg hover:shadow-emerald-500/25 active:scale-[0.92]">
          <Send size={14} />
        </Button>
      </form>
    </div>
  )
}
