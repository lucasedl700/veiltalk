/**
 * VeilTalk DC Ratchet — DataChannel（聊天/文件）密钥轮换链
 *
 * 设计（与媒体帧 e2ee.worker 的 epoch 链同构，ROADMAP P0-2 第二块）：
 *  - 每个（方向, 通道类型）维护一个轮换种子（seed = HKDF 派生的 fileOut/fileIn/chatOut/chatIn 种子）
 *  - epoch N 的帧密钥 = HKDF-SHA256(seed, salt=0, info="veiltalk:dc-epoch:N")，懒派生 + 缓存
 *  - 发送端：每 5 分钟未轮换则自动轮换（懒触发：下一次 out() 时检查），手动轮换立即 epoch+1
 *  - 帧自描述：文件块帧头带 1B epoch（wire = [1B epoch | 12B IV | ct | tag]），
 *    聊天 JSON 带 e 字段（完整 epoch 号）→ 接收端无需信令同步即可解密（乱序/离线安全）
 *  - 1B epoch 上限 256 回绕：接收端按「单调递增解析」还原完整 epoch
 *    （DataChannel ordered:true 保证帧序，e >= lastSeen-2 窗口内取唯一匹配）
 *  - 旧 epoch 密钥缓存限时保留（窗口外销毁），泄露窗口有限 —— 前向保密简化版
 *
 * 安全：种子只存在于本页面内存；epoch 号经信令/DataChannel 传输（仅计数，不是密钥材料）。
 */

import { dcEpochKeyRaw } from './crypto-core'

const ROTATE_INTERVAL_MS = 5 * 60 * 1000
/** 每个 epoch 缓存保留窗口：当前 ±2（轮换边界与轻微乱序容错） */
const CACHE_WINDOW = 2

export class DcKeyRing {
  /** 发送端当前 epoch（out 环专用；in 环跟随帧头） */
  private outEpoch = 0
  private rotatedAt = Date.now()
  /** 接收端最近一次见到的完整 epoch（单调棘轮基准） */
  private lastInEpoch: number | null = null
  private cache = new Map<number, CryptoKey>()
  private pending = new Map<number, Promise<CryptoKey>>()

  constructor(
    /** 轮换种子（RawKeySet 中对应方向的 32B 原始字节） */
    private readonly seed: ArrayBuffer,
    private readonly direction: 'out' | 'in',
  ) {}

  /** 发送端：取当前 epoch 的密钥（懒自动轮换后返回新纪元） */
  async out(): Promise<{ key: CryptoKey; epoch: number }> {
    if (this.direction === 'out' && Date.now() - this.rotatedAt > ROTATE_INTERVAL_MS) {
      this.rotate('auto')
    }
    return { key: await this.keyOf(this.direction === 'out' ? this.outEpoch : (this.lastInEpoch ?? 0)), epoch: this.currentEpoch() }
  }

  /** 接收端：按帧内 1B epoch 还原完整 epoch 并取密钥（monotonic 棘轮解析） */
  async inKeyForByte(b: number): Promise<{ key: CryptoKey; epoch: number }> {
    const epoch = this.resolveEpoch(b)
    return { key: await this.keyOf(epoch), epoch }
  }

  /** 接收端：聊天 JSON 直接携带完整 epoch 号 */
  async inKeyForEpoch(epoch: number): Promise<CryptoKey> {
    if (this.lastInEpoch == null || epoch > this.lastInEpoch) this.lastInEpoch = epoch
    return this.keyOf(epoch)
  }

  /** 手动/自动轮换：epoch+1 并淘汰窗口外旧密钥（仅发送端环有意义） */
  rotate(reason: 'manual' | 'auto' = 'manual'): number {
    this.outEpoch = (this.outEpoch + 1) % 256
    this.rotatedAt = Date.now()
    this.prune(this.outEpoch)
    void reason
    return this.outEpoch
  }

  currentEpoch(): number {
    return this.direction === 'out' ? this.outEpoch : (this.lastInEpoch ?? 0)
  }

  /** 1B epoch → 完整 epoch（单调不减，允许 ±2 窗口内回退匹配轮换边界重投帧） */
  private resolveEpoch(b: number): number {
    if (this.lastInEpoch == null) {
      this.lastInEpoch = b
      return b
    }
    const base = this.lastInEpoch
    for (let e = base + CACHE_WINDOW; e >= base - CACHE_WINDOW; e--) {
      if (e >= 0 && e % 256 === b) {
        if (e > this.lastInEpoch) this.lastInEpoch = e
        return e
      }
    }
    // 窗口外（理论不可达，除非对端手动狂轮换 >256 次）：按最新纪元处理
    this.lastInEpoch = base + 256
    return this.lastInEpoch
  }

  private async keyOf(epoch: number): Promise<CryptoKey> {
    const hit = this.cache.get(epoch)
    if (hit) return hit
    const inflight = this.pending.get(epoch)
    if (inflight) return inflight
    const p = dcEpochKeyRaw(this.seed, epoch).then((raw) =>
      crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    )
    this.pending.set(epoch, p)
    try {
      const key = await p
      this.cache.set(epoch, key)
      return key
    } finally {
      this.pending.delete(epoch)
    }
  }

  /** 窗口外旧纪元密钥立即销毁（泄露窗口受限的关键） */
  private prune(current: number) {
    for (const e of [...this.cache.keys()]) {
      if (Math.abs(e - current) > CACHE_WINDOW) this.cache.delete(e)
    }
  }
}
