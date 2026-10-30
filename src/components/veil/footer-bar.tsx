'use client';

/**
 * FooterBar — 一行式页脚（2026-10 精简：仅版本号 + PWA 安装入口）
 * PWA 可安装时展示「安装应用」；iOS Safari 展示「添加到主屏幕」引导；
 * 已处于 standalone 独立窗口则隐藏安装入口；底部安全区适配 iOS 主屏指示条。
 */

import { useVeil } from '@/store/veil-store'
import { promptPwaInstall } from './pwa-register'
import { Download, Share } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { useDict } from '@/lib/i18n/use-dict'

export function FooterBar() {
  const installReady = useVeil((s) => s.installReady)
  const pwaStandalone = useVeil((s) => s.pwaStandalone)
  const pwaPlatform = useVeil((s) => s.pwaPlatform)
  const t = useDict()

  const install = async () => {
    const ok = await promptPwaInstall()
    if (!ok) toast({ title: t.footer.installUnsupported, description: t.footer.installUnsupportedDesc })
  }

  const iosGuide = () => {
    toast({ title: t.footer.iosInstallTitle, description: t.footer.iosInstallDesc })
  }

  /* 安装入口三态：Chromium 提示可用 / iOS 引导 / standalone 或不支持时不展示 */
  const showChromiumInstall = installReady && !pwaStandalone
  const showIosGuide = !installReady && !pwaStandalone && pwaPlatform === 'ios'

  return (
    <footer className="mt-auto border-t border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 text-[11px] text-muted-foreground sm:h-12 sm:flex-row sm:px-6 sm:py-0">
        <span className="font-medium">VeilTalk v1.1</span>
        <div className="flex items-center gap-3">
          {showChromiumInstall && (
            <Button
              size="sm"
              variant="outline"
              className="veil-install-pop h-7 gap-1.5 rounded-full border-emerald-500/40 bg-emerald-500/10 px-3 text-[11px] text-emerald-600 transition-all hover:bg-emerald-500/20 hover:shadow-md hover:shadow-emerald-500/20 active:scale-[0.96] dark:text-emerald-300"
              onClick={install}
              aria-label={t.footer.installAria}
            >
              <Download size={12} />
              {t.footer.installApp}
            </Button>
          )}
          {showIosGuide && (
            <Button
              size="sm"
              variant="outline"
              className="veil-install-pop h-7 gap-1.5 rounded-full border-emerald-500/40 bg-emerald-500/10 px-3 text-[11px] text-emerald-600 transition-all hover:bg-emerald-500/20 hover:shadow-md hover:shadow-emerald-500/20 active:scale-[0.96] dark:text-emerald-300"
              onClick={iosGuide}
              aria-label={t.footer.iosInstallAria}
            >
              <Share size={12} />
              {t.footer.installApp}
            </Button>
          )}
        </div>
      </div>
    </footer>
  )
}
