/**
 * /api/status — 服务器状态快照（运维视图 /?view=status 的数据源）
 *
 * 内容：
 *  - 系统负载：loadavg L1/L2/L3（1/5/15 分钟）、CPU 核数、运行时长
 *  - 内存：物理内存总量/可用、Node 进程 RSS/Heap
 *  - 缓存真实性：信令服务的房间缓存（rooms Map）与连接数、Next 进程台账文件大小
 *  - 信令服务：:3004 /svc/health + /svc/rooms（本机回环直连，不经网关）
 */

import { NextResponse } from 'next/server'
import os from 'os'
import { promises as fsp } from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

const SIGNALING_HTTP = `http://127.0.0.1:${process.env.SIGNALING_HTTP_PORT || 3004}`

async function fetchSignaling(): Promise<{
  online: boolean
  health?: { rooms?: number; peers?: number; uptimeSec?: number }
  rooms?: Array<{ id: string; peerCount: number; locked?: boolean; createdAt?: string }>
}> {
  try {
    const [hRes, rRes] = await Promise.all([
      fetch(`${SIGNALING_HTTP}/svc/health`, { cache: 'no-store', signal: AbortSignal.timeout(2500) }),
      fetch(`${SIGNALING_HTTP}/svc/rooms`, { cache: 'no-store', signal: AbortSignal.timeout(2500) }),
    ])
    const health = hRes.ok ? ((await hRes.json()) as Record<string, unknown>) : undefined
    const roomsJson = rRes.ok ? ((await rRes.json()) as { rooms?: Array<{ id: string; peerCount: number; locked?: boolean; createdAt?: string }> }) : undefined
    return { online: hRes.ok, health, rooms: roomsJson?.rooms }
  } catch {
    return { online: false }
  }
}

async function ledgerSize(): Promise<number | null> {
  try {
    const dir = process.env.LEDGER_DIR ? path.resolve(process.env.LEDGER_DIR) : path.resolve(process.cwd(), 'db/ledger')
    const files = await fsp.readdir(dir).catch(() => [] as string[])
    let total = 0
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f)).catch(() => null)
      if (st) total += st.size
    }
    return total
  } catch {
    return null
  }
}

export async function GET() {
  const load = os.loadavg()
  const cpus = os.cpus()?.length || 1
  const mem = { total: os.totalmem(), free: os.freemem() }
  const proc = process.memoryUsage()
  const [sig, ledger] = await Promise.all([fetchSignaling(), ledgerSize()])

  return NextResponse.json({
    ts: Date.now(),
    system: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      osUptimeSec: Math.round(os.uptime()),
      cpus,
      // L1/L2/L3：1/5/15 分钟负载均值（归一化到每核，>1 表示过载）
      loadL1: load[0],
      loadL2: load[1],
      loadL3: load[2],
      loadPerCoreL1: load[0] / cpus,
      loadPerCoreL2: load[1] / cpus,
      loadPerCoreL3: load[2] / cpus,
    },
    memory: {
      totalMb: Math.round(mem.total / 1024 / 1024),
      freeMb: Math.round(mem.free / 1024 / 1024),
      usedPct: Math.round(((mem.total - mem.free) / mem.total) * 100),
      rssMb: Math.round(proc.rss / 1024 / 1024),
      heapUsedMb: Math.round(proc.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(proc.heapTotal / 1024 / 1024),
    },
    signaling: {
      online: sig.online,
      rooms: sig.health?.rooms ?? sig.rooms?.length ?? 0,
      peers: sig.health?.peers ?? (sig.rooms || []).reduce((n, r) => n + (r.peerCount || 0), 0),
      uptimeSec: sig.health?.uptimeSec ?? null,
      // 缓存真实性：信令内存中的房间对象明细（真实缓存内容，不是摆设指标）
      roomCache: (sig.rooms || []).map((r) => ({ id: r.id, peers: r.peerCount, locked: !!r.locked, createdAt: r.createdAt })),
    },
    cache: {
      ledgerBytes: ledger,
      processResidentMb: Math.round(proc.rss / 1024 / 1024),
    },
  })
}
