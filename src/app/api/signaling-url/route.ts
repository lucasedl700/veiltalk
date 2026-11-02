/**
 * 信令服务直连地址（隧道/生产部署用）：
 * - 本地开发不设 SIGNALING_URL → 返回 null → 客户端走同源反代/直连
 * - 隧道/生产设 SIGNALING_URL=<信令服务公网地址> → 客户端直连该地址（绕过 Next.js 代理，
 *   因为 Next.js rewrites 不支持 WebSocket 代理）
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { url: process.env.SIGNALING_URL || null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
