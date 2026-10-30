'use client'

/**
 * VeilTalk i18n — React 接入
 *
 *  - useDict()：订阅 store.lang 的字典 hook（组件内唯一入口）
 *  - LangBoot()：挂载时从 URL ?lang= → localStorage → 默认 zh 引导语言，
 *    并同步 <html lang> 与 document.title（hydration 安全：首帧与服务端一致为 zh，
 *    挂载后再切换，切到 en 的用户有一帧中文属预期行为）
 */

import { useEffect } from 'react'
import { useVeil } from '@/store/veil-store'
import { dictFor, LANG_STORAGE_KEY, langToBcp47, pageTitle } from './index'
import type { Dict, Lang } from './index'

export function useDict(): Dict {
  const lang = useVeil((s) => s.lang)
  return dictFor(lang)
}

export function isLang(value: string | null | undefined): value is Lang {
  return value === 'zh' || value === 'en'
}

export function LangBoot() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('lang')
    const fromStore = localStorage.getItem(LANG_STORAGE_KEY)
    const next: Lang = isLang(fromUrl) ? fromUrl : isLang(fromStore) ? fromStore : 'zh'
    // setLang 内部处理「同值不写盘」并同步 html lang / title
    useVeil.getState().setLang(next)
  }, [])
  return null
}
