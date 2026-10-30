/**
 * 服务端配置与管理员 API 客户端（信令服务 :3004 HTTP，经 Caddy 网关 XTransformPort）
 *
 * - fetchServerConfig：公开只读接口（全局画质默认档），应用启动/入房前拉取
 * - 管理员接口（login/overview/config/purge）：密码经 X-Admin-Pass 头携带，不落 URL
 */

import { isQualityTier } from '@/lib/webrtc/tiers'

const BASE = '/svc'

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}?XTransformPort=3004`, {
    cache: 'no-store',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const data = (await res.json()) as T & { ok?: boolean; error?: string }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

/** 拉取全局画质默认档（失败返回 null，前端走本地兜底 720p） */
export async function fetchServerConfig(): Promise<string | null> {
  try {
    const data = await jfetch<{ defaultQuality?: string }>('/config')
    return isQualityTier(data.defaultQuality) ? data.defaultQuality : null
  } catch {
    return null
  }
}

/* ------------------------------- 管理员 API ------------------------------- */

export interface AdminRoomPeer {
  peerId: string
  name: string
  fingerprint: string
  joinedTs: string
  idleSec: number
}

export interface AdminOverview {
  ts: number
  uptimeSec: number
  memory: { rss: number; heapUsed: number; heapTotal: number }
  sockets: number
  config: { defaultQuality: string; updatedAt: number }
  rooms: Array<{
    id: string
    createdAt: string
    peerCount: number
    locked: boolean
    hostPeerId: string | null
    peers: AdminRoomPeer[]
  }>
}

function adminHeaders(pass: string): RequestInit['headers'] {
  return { 'X-Admin-Pass': pass }
}

export async function adminLogin(pass: string): Promise<AdminOverview> {
  const data = await jfetch<{ overview: AdminOverview }>('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: pass }),
  })
  return data.overview
}

export async function adminOverview(pass: string): Promise<AdminOverview> {
  const data = await jfetch<{ overview: AdminOverview }>('/admin/overview', {
    headers: adminHeaders(pass),
  })
  return data.overview
}

export async function adminSaveConfig(pass: string, defaultQuality: string): Promise<void> {
  await jfetch('/admin/config', {
    method: 'POST',
    body: JSON.stringify({ password: pass, defaultQuality }),
  })
}

export async function adminPurge(pass: string, scope: 'rooms' | 'ledger' | 'all', roomId?: string): Promise<{ rooms?: number; peers?: number; files?: number; bytes?: number }> {
  return await jfetch('/admin/purge', {
    method: 'POST',
    body: JSON.stringify({ password: pass, scope, roomId }),
  })
}
