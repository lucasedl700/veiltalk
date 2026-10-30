'use client';

/**
 * PWA — Service Worker 注册 + 安装提示（beforeinstallprompt）捕获
 *
 * - SW 注册放 useCallback；安装事件存模块级变量（非序列化对象不入 store），
 *   store 只写 installReady 布尔；prompt() 通过 controller 侧 helper 调用。
 * - 仅浏览器环境执行；sw.js 的缓存策略见文件头注释（API/WS 永不缓存）。
 */

import { useEffect } from 'react'
import { useVeil } from '@/store/veil-store'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: InstallPromptEvent | null = null

/** iOS / iPadOS Safari 探测（iPadOS 13+ 桌面版 UA 自报 Macintosh，用触摸能力辅助判定） */
function detectIos(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)
}

/** standalone（已安装独立窗口）探测：标准 display-mode + iOS 专有 navigator.standalone */
function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** 触发 PWA 安装弹窗（footer「安装应用」按钮调用）；返回是否存在可用提示 */
export async function promptPwaInstall(): Promise<boolean> {
  if (!deferredPrompt) return false
  try {
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') useVeil.getState().set({ installReady: false })
    deferredPrompt = choice.outcome === 'accepted' ? null : deferredPrompt
    return true
  } catch {
    return false
  }
}

export function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Service Worker 仅生产环境注册：
    // dev 下 chunk 无内容哈希，cache-first 会缓存过期代码并破坏 HMR/热更新
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* 注册失败不影响应用 */
      })
    }

    // F-38 安装能力探测：standalone 已安装 → 隐藏入口；iOS Safari → 「添加到主屏幕」引导
    useVeil.getState().set({ pwaStandalone: detectStandalone(), pwaPlatform: detectIos() ? 'ios' : 'other' })
    const displayModeMq = window.matchMedia('(display-mode: standalone)')
    const onDisplayModeChange = () => useVeil.getState().set({ pwaStandalone: detectStandalone() })
    displayModeMq.addEventListener?.('change', onDisplayModeChange)

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      deferredPrompt = e as InstallPromptEvent
      useVeil.getState().set({ installReady: true })
    }
    const onInstalled = () => useVeil.getState().set({ installReady: false })

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      displayModeMq.removeEventListener?.('change', onDisplayModeChange)
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  return null
}
