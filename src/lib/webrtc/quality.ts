/**
 * VeilTalk Network Quality — 统一连接质量评级
 *
 * 模块职责：基于 ICE RTT 与丢包率将链路质量划分为 4 档，
 * 供 video-tile 质量徽标、members-dialog 头像角标、诊断面板共用。
 * 评级阈值与弱网自适应码率阶梯（peer-session ADAPTIVE_LADDER / LOSS_DOWNGRADE_PCT）对齐：
 * 「中/差」区间即触发降码率，保证 UI 提示与实际自适应行为一致。
 *
 * i18n（F-36）：label/desc 在调用时按当前语言解析（dictFor + veil store，与
 * controller.ts 同模式），并新增稳定档位键 key —— 消费方（members-dialog 等）
 * 应按 key 映射自己的字典，绝不再以展示文案（如中文单字）作映射键。
 */

import { dictFor } from '@/lib/i18n'
import { useVeil } from '@/store/veil-store'

/** 稳定档位键：跨语言不变，UI 映射的唯一依据 */
export type GradeKey = 'good' | 'ok' | 'fair' | 'poor' | 'unknown'

export interface QualityGrade {
  /** 稳定档位键（i18n 后展示文案随语言变化，映射一律用本字段） */
  key: GradeKey
  /** 单字/短词等级（当前语言）：优/良/中/差，未知为 … */
  label: string
  /** 人类可读描述（title / aria） */
  desc: string
  /** 圆点颜色类（bg-*） */
  dotCls: string
  /** 文字颜色类（text-*） */
  textCls: string
}

/** 颜色类与语言无关，固定映射；label/desc 走字典 */
const GRADE_CLS: Record<GradeKey, { dotCls: string; textCls: string }> = {
  good: { dotCls: 'bg-emerald-400', textCls: 'text-emerald-500' },
  ok: { dotCls: 'bg-emerald-500', textCls: 'text-emerald-600 dark:text-emerald-300' },
  fair: { dotCls: 'bg-amber-500', textCls: 'text-amber-600 dark:text-amber-300' },
  poor: { dotCls: 'bg-red-500', textCls: 'text-red-500' },
  unknown: { dotCls: 'bg-zinc-400', textCls: 'text-muted-foreground' },
}

/** 按稳定键取当前语言档位（非 React 上下文模式：函数体内 getState，禁止模块顶层缓存） */
function gradeOf(key: GradeKey): QualityGrade {
  const q = dictFor(useVeil.getState().lang).quality
  const cls = GRADE_CLS[key]
  const label =
    key === 'good' ? q.goodLabel
    : key === 'ok' ? q.okLabel
    : key === 'fair' ? q.fairLabel
    : key === 'poor' ? q.poorLabel
    : q.unknownLabel
  const desc =
    key === 'good' ? q.goodDesc
    : key === 'ok' ? q.okDesc
    : key === 'fair' ? q.fairDesc
    : key === 'poor' ? q.poorDesc
    : q.unknownDesc
  return { key, label, desc, dotCls: cls.dotCls, textCls: cls.textCls }
}

export function networkGrade(rttMs: number | null | undefined, lossPct: number | null | undefined): QualityGrade {
  if (rttMs == null && lossPct == null) return gradeOf('unknown')
  const rtt = rttMs ?? 0
  const loss = lossPct ?? 0
  if (rtt > 400 || loss > 8) return gradeOf('poor')
  if (rtt > 180 || loss > 3) return gradeOf('fair')
  if (rtt > 80 || loss > 1) return gradeOf('ok')
  return gradeOf('good')
}

/** 带毫秒数的完整标签（视频块徽标用） */
export function networkGradeLabel(rttMs: number | null | undefined, lossPct: number | null | undefined): { label: string; cls: string; grade: QualityGrade } {
  const g = networkGrade(rttMs, lossPct)
  return {
    label: rttMs == null ? g.label : `${g.label} ${Math.round(rttMs)}ms`,
    cls: g.dotCls,
    grade: g,
  }
}
