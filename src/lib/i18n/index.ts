/**
 * VeilTalk i18n — 合并入口
 *
 *  - 合并三个 pack（core = lobby/header；shell = 页面壳层；panels = 侧栏面板与
 *    对话框/controller 文案），namespace 互斥由 pack 注释约定 + code review 保证。
 *  - dicts: Record<Lang, Dict> 让 zh/en 形状在编译期对齐。
 *  - 组件内：const t = useDict() → t.lobby.title（属性访问，全自动补全/类型校验）。
 *  - 非 React（controller/store 副作用）：dictFor(useVeil.getState().lang)。
 *  - 插值：fmt(t.xxx.yyy, { name })，模板用 {name} 占位。
 */

import { core } from './packs/core'
import { shell } from './packs/shell'
import { panels } from './packs/panels'
import type { Lang, Vars } from './types'

export type { Lang, Vars }

const zh = { ...core.zh, ...shell.zh, ...panels.zh } as const
const en = { ...core.en, ...shell.en, ...panels.en } as const

export type Dict = typeof zh

export const dicts: Record<Lang, Dict> = {
  zh,
  en: en as Dict,
}

/** 非 React 上下文取字典（controller.ts / store 副作用等） */
export function dictFor(lang: Lang): Dict {
  return dicts[lang] ?? dicts.zh
}

/** 变量插值：把模板中的 {key} 替换为 vars[key]；未提供的占位原样保留 */
export function fmt(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (raw, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : raw,
  )
}

/** localStorage 持久化 key（与 veil-stage-layout 等同风格） */
export const LANG_STORAGE_KEY = 'veil-lang'

/** 语言 → BCP 47（document.documentElement.lang 同步用） */
export function langToBcp47(lang: Lang): string {
  return lang === 'zh' ? 'zh-CN' : 'en'
}

/** 页面标题（浏览器标签页；语言切换时同步） */
export function pageTitle(lang: Lang): string {
  return lang === 'zh'
    ? 'VeilTalk 纱语 · 端到端加密网页通话与文件直传'
    : 'VeilTalk · End-to-End Encrypted Calls & P2P File Transfer'
}
