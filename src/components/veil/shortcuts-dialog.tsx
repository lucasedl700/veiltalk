'use client';

/**
 * ShortcutsDialog — 键盘快捷键帮助浮层（? 键或控制条键盘按钮触发）
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useVeil } from '@/store/veil-store'
import { Keyboard } from 'lucide-react'
import { useDict } from '@/lib/i18n/use-dict'

export function ShortcutsDialog() {
  const open = useVeil((s) => s.showShortcuts)
  const set = useVeil((s) => s.set)
  const t = useDict()

  // 快捷键清单（keys 为纯逻辑按键，label/hint 走字典）
  const SHORTCUTS: Array<{ keys: string[]; label: string; hint: string }> = [
    { keys: ['M'], label: t.shortcuts.mic, hint: t.shortcuts.micHint },
    { keys: ['V'], label: t.shortcuts.cam, hint: t.shortcuts.camHint },
    { keys: ['S'], label: t.shortcuts.share, hint: t.shortcuts.shareHint },
    { keys: ['R'], label: t.shortcuts.rec, hint: t.shortcuts.recHint },
    { keys: ['N'], label: t.shortcuts.members, hint: t.shortcuts.membersHint },
    { keys: ['H'], label: t.shortcuts.hand, hint: t.shortcuts.handHint },
    { keys: ['F'], label: t.shortcuts.fullscreen, hint: t.shortcuts.fullscreenHint },
    { keys: ['G'], label: t.shortcuts.view, hint: t.shortcuts.viewHint },
    { keys: ['?'], label: t.shortcuts.help, hint: t.shortcuts.helpHint },
    { keys: ['Esc'], label: t.shortcuts.close, hint: t.shortcuts.closeHint },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => set({ showShortcuts: v })}>
      <DialogContent className="w-[92vw] max-w-md gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Keyboard size={17} className="text-emerald-500" />
            {t.shortcuts.title}
          </DialogTitle>
          <DialogDescription className="text-xs">{t.shortcuts.desc}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
              <div className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-background px-1.5 font-mono text-[11px] font-semibold shadow-sm"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium">{s.label}</div>
                <div className="text-[10px] text-muted-foreground">{s.hint}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t.shortcuts.tip}
        </p>
      </DialogContent>
    </Dialog>
  )
}
