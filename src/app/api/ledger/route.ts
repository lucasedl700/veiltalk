/**
 * 元数据台账代理 API —— 前端经同源 /api/ledger 读取信令服务的 JSONL 台账。
 *
 * 为什么走 Next 服务端代理而非前端直连 ?XTransformPort=3004：
 *  - 同源策略简化 + 生产部署可移植（docker-compose 中 web 经内部网络访问 signaling:3004）
 *  - 代理层可追加访问控制/脱敏（当前：透传，台账本身已最小化）
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const base = process.env.SIGNALING_HTTP || 'http://127.0.0.1:3004'
  const sp = req.nextUrl.searchParams
  const qs = new URLSearchParams()
  const limit = sp.get('limit')
  const date = sp.get('date')
  const event = sp.get('event')
  if (limit) qs.set('limit', limit)
  if (date) qs.set('date', date)
  if (event) qs.set('event', event)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${base}/svc/ledger?${qs.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timer)
    const data = await res.json()
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `信令服务不可达（${String(e)}）`,
        entries: [],
        date: date || '',
        availableDates: [],
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
