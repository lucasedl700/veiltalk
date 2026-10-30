/**
 * ICE 配置 API —— 把自建 TURN/STUN（环境变量注入）下发给浏览器。
 *
 * 凭证模式（二选一，由环境变量决定）：
 *  1. REST 短期凭证（推荐，P2-1，第 15 轮落地）：设置 TURN_SHARED_SECRET 后，
 *     按 coturn REST API 约定签发时间限凭证：
 *       username   = `${unixExpireTs}`（coturn 约定：用户名即过期时间戳，可带 `:id` 后缀做用量归因）
 *       credential = base64(HMAC-SHA1(secret, username))
 *     secret 永不出服务器，凭证默认 1 小时过期（TURN_CREDENTIAL_TTL 可调，单位秒），
 *     泄露窗口从「永久」收窄到 TTL；coturn 侧开启 use-auth-secret + static-auth-secret
 *     （见 deploy/coturn/turnserver.conf 进阶方案注释）。
 *  2. 长期凭证（兼容回退）：仅配置 TURN_USERNAME/TURN_CREDENTIAL 时按原样下发。
 * 未配置任何 TURN 时回退公共 STUN（仅打洞，无中继）。
 *
 * 环境变量（见 deploy/.env.example 与 deploy.sh）：
 *   STUN_URLS             逗号分隔，如 stun:coturn.local:3478
 *   TURN_URLS             逗号分隔，如 turn:coturn.local:3478?transport=udp
 *   TURN_SHARED_SECRET    REST 短期凭证共享密钥（与 coturn static-auth-secret 一致）
 *   TURN_CREDENTIAL_TTL   短期凭证有效期秒数（默认 3600）
 *   TURN_USERNAME         长期凭证用户名（回退模式）
 *   TURN_CREDENTIAL       长期凭证密码（回退模式）
 *   TURN_API_URL          商用 TURN API 端点（如 Metered免费档：
 *                         https://yourapp.metered.live/api/v1/turn/credentials?apiKey=xxx
 *                         或任意返回 {iceServers:[...]} / {username,credential,urls:[...]}
 *                         的端点）。服务端拉取并缓存 5 分钟后合入下发配置 —— 注册免费
 *                         TURN 服务后只需填这一个变量，无需改代码。
 */

import { NextResponse } from 'next/server'
import { issueTurnRestCredential } from '@/lib/turn-credentials'

export const dynamic = 'force-dynamic'

/* ---- TURN API 拉取缓存（进程内，5 分钟 TTL；失败沿用上次结果） ---- */
let apiCache: { at: number; servers: RTCIceServer[] } | null = null

function normalizeApiPayload(data: unknown): RTCIceServer[] {
  const out: RTCIceServer[] = []
  const push = (s: unknown) => {
    if (!s || typeof s !== 'object') return
    const o = s as { urls?: unknown; username?: unknown; credential?: unknown }
    const urls = Array.isArray(o.urls) ? o.urls.filter((u): u is string => typeof u === 'string') : typeof o.urls === 'string' ? [o.urls] : []
    if (urls.length === 0) return
    const entry: RTCIceServer = { urls }
    if (typeof o.username === 'string') entry.username = o.username
    if (typeof o.credential === 'string') entry.credential = o.credential
    out.push(entry)
  }
  if (Array.isArray((data as { iceServers?: unknown })?.iceServers)) {
    for (const s of (data as { iceServers: unknown[] }).iceServers) push(s)
  } else {
    // Metered 风格平铺：{username, credential, urls:[...]}（含 expiry 等多余字段忽略）
    push(data)
  }
  return out
}

async function fetchTurnApi(): Promise<RTCIceServer[]> {
  const url = process.env.TURN_API_URL
  if (!url) return []
  if (apiCache && Date.now() - apiCache.at < 5 * 60 * 1000) return apiCache.servers
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`TURN API HTTP ${res.status}`)
  const servers = normalizeApiPayload(await res.json())
  if (servers.length > 0) apiCache = { at: Date.now(), servers }
  return servers
}

export async function GET() {
  // 默认 STUN 名单（Task 34 重排，全部经 download/stun-probe.ts 实测存活）：
  //  1) stun.miwifi.com      小米公共 STUN —— 国内网络可达性最佳（大陆访问 Google STUN 被墙是
  //     「STUN 不可达」警告的主因）；2) nextcloud:443 —— 443 端口在受限防火墙下更易穿透；
  //  3) twilio/google/cloudflare —— 全球兜底。浏览器并行收集候选，多列只增加命中率。
  const stun = (
    process.env.STUN_URLS ||
    'stun:stun.miwifi.com:3478,stun:stun.nextcloud.com:443,stun:global.stun.twilio.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const iceServers: RTCIceServer[] = [{ urls: stun }]

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  let turnMode: 'rest' | 'long-term' | 'none' = 'none'
  let ttl = 0
  const sharedSecret = process.env.TURN_SHARED_SECRET || ''
  if (turnUrls.length > 0 && sharedSecret) {
    // REST 短期凭证：secret 只存在服务端；每次请求签发新凭证，凭证自带过期时间
    const issued = issueTurnRestCredential(
      sharedSecret,
      Number(process.env.TURN_CREDENTIAL_TTL) || undefined,
    )
    iceServers.push({ urls: turnUrls, username: issued.username, credential: issued.credential })
    turnMode = 'rest'
    ttl = issued.ttl
  } else if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    })
    turnMode = 'long-term'
  }

  // 商用/免费 TURN API（TURN_API_URL）：服务端拉取动态凭据合入（5 分钟缓存，失败不阻塞）
  let turnApi = false
  if (process.env.TURN_API_URL) {
    try {
      const apiServers = await fetchTurnApi()
      if (apiServers.length > 0) {
        iceServers.push(...apiServers)
        turnApi = true
        if (turnMode === 'none') turnMode = 'long-term'
      }
    } catch {
      /* API 拉取失败：沿用静态配置与公共 STUN，不阻塞响应 */
    }
  }

  return NextResponse.json(
    {
      iceServers,
      iceTransportPolicy: 'all',
      hasTurn: turnUrls.length > 0 || turnApi,
      /** 凭证模式：rest=短期 HMAC 凭证 / long-term=静态凭证 / none=未配置 TURN */
      turnMode,
      /** TURN_API_URL 动态凭据是否生效 */
      turnApi,
      /** REST 凭证剩余有效期（秒）；long-term 模式为 0 */
      ttl,
      ts: new Date().toISOString(),
    },
    // 凭证不可缓存/不可被中间层存储：每次请求都应 freshly 签发
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
