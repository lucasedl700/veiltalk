'use client';

/**
 * SidePanel — 侧面板：文件 / 聊天 / 诊断 / 加密 / 台账 / 日志 六个标签页
 * 桌面端常驻右侧；移动端经 Sheet 抽屉打开。
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useVeil } from '@/store/veil-store'
import { fmt } from '@/lib/i18n'
import { useDict } from '@/lib/i18n/use-dict'
import { FilePanel } from './file-panel'
import { ChatPanel } from './chat-panel'
import { DiagnosticsPanel } from './diagnostics-panel'
import { CryptoPanel } from './crypto-panel'
import { LedgerPanel } from './ledger-panel'
import { EventLogPanel } from './event-log-panel'
import { FileText, MessageSquare, PanelRightOpen, Activity, ShieldCheck, ScrollText, Terminal } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { cn } from '@/lib/utils'

// 标签文案走字典（labelKey → t.panel[labelKey]）；value/icon 属逻辑配置不动。
// admin: true 的标签仅管理员可见（Task 25：服务器诊断/加密自检/台账/日志不对普通人暴露）
const TABS = [
  { value: 'files', labelKey: 'tabFiles', icon: FileText, admin: false },
  { value: 'chat', labelKey: 'tabChat', icon: MessageSquare, admin: false },
  { value: 'diag', labelKey: 'tabDiag', icon: Activity, admin: true },
  { value: 'crypto', labelKey: 'tabCrypto', icon: ShieldCheck, admin: true },
  { value: 'ledger', labelKey: 'tabLedger', icon: ScrollText, admin: true },
  { value: 'logs', labelKey: 'tabLogs', icon: Terminal, admin: true },
] as const

/** 聊天未读徽标：数字弹入动画，超过 99 显示 99+ */
function UnreadBadge() {
  const unread = useVeil((s) => s.unreadChats)
  const t = useDict()
  if (unread <= 0) return null
  return (
    <span
      className="veil-badge-pop absolute -right-0.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[8px] font-bold leading-none text-white shadow-sm"
      aria-label={fmt(t.panel.unreadAria, { count: unread })}
    >
      {unread > 99 ? '99+' : unread}
    </span>
  )
}

function PanelBody({ compact }: { compact?: boolean }) {
  const activeTab = useVeil((s) => s.activeTab)
  const set = useVeil((s) => s.set)
  const adminUnlocked = useVeil((s) => s.adminUnlocked)
  const t = useDict()
  // 普通成员只保留 文件/聊天 两个标签；管理员解锁后显示全部六标签
  const tabs = useMemo(() => TABS.filter((tab) => !tab.admin || adminUnlocked), [adminUnlocked])
  // 非管理员时若停留在被隐藏的管理标签（如管理员退出后），回退到聊天
  useEffect(() => {
    if (!tabs.some((tab) => tab.value === activeTab)) {
      set({ activeTab: 'chat', unreadChats: 0 })
    }
  }, [tabs, activeTab, set])
  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        set({ activeTab: v, ...(v === 'chat' ? { unreadChats: 0 } : {}) })
      }}
      className="flex h-full flex-col"
    >
      <TabsList className="mx-1 mt-1 grid h-9 w-auto bg-muted/60 p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="relative h-7 gap-1 px-1 text-[11px] transition-all duration-150 hover:bg-background/60 hover:text-foreground active:scale-[0.95] data-[state=active]:bg-background data-[state=active]:shadow-sm dark:hover:bg-white/[0.04]"
          >
            <tab.icon size={12} />
            <span className={compact ? '' : 'hidden xl:inline'}>{t.panel[tab.labelKey]}</span>
            {tab.value === 'chat' && <UnreadBadge />}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="files" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <FilePanel />
      </TabsContent>
      <TabsContent value="chat" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <ChatPanel />
      </TabsContent>
      <TabsContent value="diag" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <DiagnosticsPanel />
      </TabsContent>
      <TabsContent value="crypto" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <CryptoPanel />
      </TabsContent>
      <TabsContent value="ledger" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <LedgerPanel />
      </TabsContent>
      <TabsContent value="logs" className="mt-1 min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
        <EventLogPanel />
      </TabsContent>
    </Tabs>
  )
}

export function SidePanel() {
  const peers = useVeil((s) => s.peers)
  const unreadChats = useVeil((s) => s.unreadChats)
  const set = useVeil((s) => s.set)
  const t = useDict()

  // 首次进入房间自动拉取台账
  useEffect(() => {
    void import('@/lib/webrtc/controller').then(({ controller }) => controller.fetchLedger())
  }, [])

  const badgeCount = Object.keys(peers).length

  return (
    <>
      {/* 桌面端常驻面板 */}
      <aside className="hidden w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 shadow-xl shadow-black/[0.02] backdrop-blur-md lg:flex xl:w-[380px] dark:border-white/[0.08] dark:bg-card/50 dark:shadow-black/40">
        <PanelBody />
      </aside>

      {/* 移动端抽屉 */}
      <Sheet>
        <SheetTrigger asChild>
          <Button
            size="sm"
            className={cn(
              'fixed bottom-24 right-4 z-30 h-11 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-4 font-medium text-white shadow-xl shadow-emerald-500/25 transition-all duration-150 hover:shadow-2xl hover:shadow-emerald-500/35 active:scale-[0.94] lg:hidden',
            )}
          >
            <PanelRightOpen size={16} className="mr-1" />
            {t.panel.open}
            {badgeCount > 0 && <span className="ml-1 rounded-full bg-white/20 px-1.5 text-[10px]">{badgeCount}</span>}
            {unreadChats > 0 && (
              <span className="veil-badge-pop ml-1 rounded-full bg-white px-1.5 text-[10px] font-bold text-emerald-700">
                {unreadChats > 99 ? '99+' : unreadChats}
              </span>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="flex w-[320px] flex-col gap-0 p-0 sm:w-[400px]">
          <SheetHeader className="border-b border-border/60 px-4 py-3 dark:border-white/[0.08]">
            <SheetTitle className="text-sm">{t.panel.title}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <PanelBody compact />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
