/**
 * VeilTalk TURN REST 短期凭证签发（P2-1，coturn use-auth-secret 配套）
 *
 * coturn REST API 约定（https://github.com/coturn/coturn/wiki/turnserver#rest-api）：
 *   username   = `<unix 过期时间戳>:<可选归因标识>`
 *   credential = base64(HMAC-SHA1(sharedSecret, username))
 * 共享密钥只存在服务端（/api/ice-config 与 coturn 的 static-auth-secret 一致），
 * 浏览器拿到的凭证自带过期时间，泄露窗口从「永久」收窄到 TTL。
 * 独立成纯函数模块：便于脚本化验证与后续 TURN 用量归因扩展。
 */

import { createHmac } from 'crypto'

/** TTL 边界约束：最短 1 分钟（避免时钟抖动立即过期），最长 24 小时（控制泄露窗口） */
export const TURN_TTL_MIN_SEC = 60
export const TURN_TTL_MAX_SEC = 24 * 3600
export const TURN_TTL_DEFAULT_SEC = 3600

export function clampTurnTtl(ttlSec: number | undefined): number {
  const n = Number(ttlSec)
  if (!Number.isFinite(n) || n <= 0) return TURN_TTL_DEFAULT_SEC
  return Math.min(TURN_TTL_MAX_SEC, Math.max(TURN_TTL_MIN_SEC, Math.round(n)))
}

/** 按 coturn REST 约定签发一对短时凭证 */
export function issueTurnRestCredential(
  sharedSecret: string,
  ttlSec: number = TURN_TTL_DEFAULT_SEC,
): { username: string; credential: string; expireTs: number; ttl: number } {
  const ttl = clampTurnTtl(ttlSec)
  const expireTs = Math.floor(Date.now() / 1000) + ttl
  // 归因标识段：coturn 允许 `<ts>:<id>` 格式，仅作用量归因，不含任何用户隐私
  const username = `${expireTs}:veiltalk`
  const credential = createHmac('sha1', sharedSecret).update(username).digest('base64')
  return { username, credential, expireTs, ttl }
}
