'use client';

/**
 * EmptyState — 空状态插画（纯展示组件）：
 * 中心渐变徽章 + 同心虚线装饰环（外环慢旋）+ 漂浮卫星图标，不引入图片资源
 */

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Chip = {
  icon: LucideIcon
  /** 卫星图标配色（text-*） */
  cls?: string
  /** 相对中心徽章的定位（absolute 工具类） */
  pos: string
  /** 浮动动画延迟（任意值类，如 [animation-delay:-1.6s]） */
  delay?: string
}

export function EmptyState({
  icon: Icon,
  title,
  desc,
  chips = [],
  className,
}: {
  icon: LucideIcon
  title: string
  desc?: string
  chips?: Chip[]
  className?: string
}) {
  return (
    <div className={cn('relative flex h-44 select-none flex-col items-center justify-center', className)}>
      <div className="relative">
        {/* 内环（静态）与外环（慢旋）虚线装饰 */}
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-border/70 dark:border-white/10"
        />
        <div
          aria-hidden
          className="veil-spin-slow absolute left-1/2 top-1/2 h-40 w-40 rounded-full border border-dashed border-border/40 dark:border-white/[0.06]"
        />
        {/* 漂浮卫星图标 */}
        {chips.map((c, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'veil-float absolute flex h-6 w-6 items-center justify-center rounded-lg border border-border/60 bg-card/90 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-zinc-900/90',
              c.pos,
              c.cls,
              c.delay,
            )}
          >
            <c.icon size={12} />
          </span>
        ))}
        {/* 中心徽章 */}
        <div className="relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/15 to-teal-500/10 text-emerald-500 ring-1 ring-emerald-500/20 dark:from-emerald-400/15 dark:to-teal-400/10 dark:text-emerald-300 dark:ring-emerald-400/25">
          <Icon size={22} />
        </div>
      </div>
      <div className="relative z-10 mt-2 text-xs font-semibold text-foreground/85">{title}</div>
      {desc && (
        <div className="relative z-10 mt-0.5 max-w-[230px] text-center text-[10px] leading-relaxed text-muted-foreground">{desc}</div>
      )}
    </div>
  )
}
