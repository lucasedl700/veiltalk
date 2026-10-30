/**
 * VeilTalk File Transfer — DataChannel 实时点对点加密文件传输协议
 *
 * 协议设计（单通道多路复用，发送端按会话串行排队，接收端按 fileId 路由）：
 *  - 控制消息（JSON 字符串）：
 *      { t:'file-meta', id, name, size, mime, chunks, chunkSize, digest, resumable? }  // 发起（digest=SHA-256 hex）
 *      { t:'file-end',  id }                                               // 传输完成
 *      { t:'file-cancel', id, reason? }                                    // 任一方取消
 *      { t:'file-pause', id } / { t:'file-resume', id }                    // 发送端暂停/继续（双端状态同步）
 *      { t:'file-resume-sync', id, have }                                  // 接收端上报断点字节数（P1-6 续传握手）
 *      { t:'file-ack', id, ok }                                            // 接收端显式回执（F-33）：重组 SHA-256 校验后回发，
 *                                                                          //   ok=对端校验通过；发送端据此把「已发送」升级为「对端已确认」
 *      { t:'chat', id, ts, e, iv, ct }                                     // 加密聊天（e=DC epoch，base64）
 *      { t:'typing', on }                                                  // 输入中指示（不加密，无内容泄露）
 *      { t:'hello', name }                                                 // 通道问候
 *  - 二进制帧：[1B epoch | 12B IV | AES-256-GCM 密文 | 16B tag]，密钥 = DC 轮换链
 *    （dc-ratchet.ts：HKDF(seed, "veiltalk:dc-epoch:N")，接收端按帧内 epoch 自主派生）
 *  - 反压控制：bufferedAmount 超过高水位即挂起，等待 bufferedamountlow 事件（带 5s 超时兜底）
 *  - 完整性：接收端重组后重算 SHA-256 并与 meta.digest 比对，结果写入台账与 UI
 *  - 断点续传（P1-6，第 15 轮）：meta.resumable=true 时接收端按 digest 查本地 IndexedDB
 *    暂存（transfer-db.ts），有则回 file-resume-sync{have}；发送端对齐到块边界后跳过已收
 *    分片继续发。无响应/旧端 → 自动退化为从头传，协议向前兼容。
 *
 * 安全：文件名不经过服务器（走 DataChannel），服务器台账只记录字节数（且台账在信令层根本看不到文件事件）。
 */

import { decryptFrame, encryptFrame } from './crypto-core'
import type { DcKeyRing } from './dc-ratchet'
import { deletePartial, loadPartial, savePartial } from './transfer-db'
import type { TransferState } from './types'

export const CHUNK_SIZE = 16 * 1024
const HIGH_WATER = 1 * 1024 * 1024
const DRAIN_TIMEOUT_MS = 5000
/** 发送端等待接收端断点上报的窗口（无响应视为从头传；不阻塞旧端互操作） */
const RESUME_SYNC_WAIT_MS = 800
/** 接收端每收多少块落盘一次暂存（16 块 = 256KB；兼顾写放大与断点粒度） */
const PERSIST_EVERY_CHUNKS = 16
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 断点对齐：have 向下取整到块边界（接收端暂存保证连续，但块可能不完整）。
 * 独立导出供自检 S9 验证。
 */
export function alignResumeOffset(have: number, chunkSize: number = CHUNK_SIZE): number {
  if (!Number.isFinite(have) || have <= 0) return 0
  return Math.floor(have / chunkSize) * chunkSize
}

type Hooks = {
  onTransferUpdate: (t: TransferState) => void
  onChat?: (msg: { id: string; ts: number; text: string }) => void
  onLog: (level: 'info' | 'warn' | 'error' | 'crypto' | 'net', msg: string, detail?: string) => void
  /** 接收端回发控制消息（file-resume-sync / file-ack）；通道未就绪时返回 false */
  sendControl?: (msg: Record<string, unknown>) => boolean
  /** 发送端收到对端 file-ack 显式回执（F-33）：id=传输 id，ok=对端 SHA-256 校验是否通过 */
  onTransferAck?: (id: string, ok: boolean) => void
}

async function sha256HexOf(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function drainOnce(ch: RTCDataChannel): Promise<void> {
  if (ch.bufferedAmount <= HIGH_WATER) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      ch.removeEventListener('bufferedamountlow', finish)
      clearTimeout(timer)
      resolve()
    }
    ch.addEventListener('bufferedamountlow', finish)
    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
  })
}

/* -------------------------------- 发送端 -------------------------------- */

export class FileSender {
  private queue: Array<{ file: File; id: string }> = []
  private sending = false
  private cancelledIds = new Set<string>()
  /** 已暂停的传输：resolve 挂起 Promise，resume 时释放（发送循环 await 此处） */
  private paused = new Map<string, { promise: Promise<void>; resolve: () => void; pausedAt: number }>()
  /** 每个传输累计暂停毫秒数（修正速度统计，暂停时间不计入吞吐） */
  private pausedMs = new Map<string, number>()
  /** 最近一次上报的传输状态（pause/resume 同步 UI 用） */
  private lastState = new Map<string, TransferState>()
  /** 可续传文件登记（id → File）：失败后保留引用供「续传」重试；完成/取消即清除 */
  private resumableFiles = new Map<string, File>()
  /** 等待对端 file-resume-sync 的 waiter（id → resolve(have)） */
  private resumeWaiters = new Map<string, (have: number) => void>()

  constructor(
    /** 通道提供者：会话建立初期 dc 可能为 null（等 ondatachannel），每次发送时动态获取 */
    private readonly getDc: () => RTCDataChannel | null,
    /** 文件发送方向轮换环（fileOut 种子；out() 懒自动轮换，rotate() 手动推进） */
    private readonly ring: DcKeyRing,
    private readonly peerName: string,
    private readonly hooks: Hooks,
    /** 应用层分块加密开关（双方协商一致；false = 明文分块，仍受 DTLS 传输加密保护） */
    private readonly secure = true,
  ) {}

  enqueue(file: File): string {
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    this.queue.push({ file, id })
    void this.pump()
    return id
  }

  cancel(id: string) {
    this.cancelledIds.add(id)
    // 若正处于暂停等待，先释放让其进入取消分支
    this.releasePause(id)
    this.resumableFiles.delete(id)
    const dc = this.getDc()
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ t: 'file-cancel', id, reason: 'sender_cancelled' }))
    }
  }

  /**
   * 接收端 → 发送端：断点续传握手响应（have = 对端已连续收到的字节数）。
   * 无 waiter（旧传输/从头传）时静默忽略。
   */
  handleControl(msg: Record<string, unknown>) {
    if (msg.t === 'file-ack') {
      // 对端显式回执（F-33）：只有传输 id 与布尔校验结果，无内容泄露面；未知 id（重连后旧回执）静默忽略
      this.hooks.onTransferAck?.(String(msg.id || ''), msg.ok === true)
      return
    }
    if (msg.t !== 'file-resume-sync') return
    const id = String(msg.id || '')
    const waiter = this.resumeWaiters.get(id)
    if (waiter) {
      this.resumeWaiters.delete(id)
      waiter(Math.max(0, Number(msg.have) || 0))
    }
  }

  /**
   * 续传失败/中断的传输：按登记的 File 重新入队（新 id、新握手）。
   * 接收端以 digest 匹配本地暂存，自动从断点继续；返回是否找到可续传的登记。
   */
  retry(id: string): boolean {
    const file = this.resumableFiles.get(id)
    if (!file) return false
    this.resumableFiles.delete(id)
    this.enqueue(file)
    return true
  }

  /** 暂停发送：本端 UI + 对端状态同步为 paused，发送循环在下一块前挂起 */
  pause(id: string): boolean {
    if (this.paused.has(id) || this.cancelledIds.has(id)) return false
    let release!: () => void
    const promise = new Promise<void>((r) => (release = r))
    this.paused.set(id, { promise, resolve: release, pausedAt: Date.now() })
    const dc = this.getDc()
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ t: 'file-pause', id }))
    }
    const last = this.lastState.get(id)
    if (last) this.hooks.onTransferUpdate({ ...last, status: 'paused' })
    return true
  }

  /** 继续发送：累计暂停时长后本端与对端恢复 */
  resume(id: string): boolean {
    const p = this.paused.get(id)
    if (!p) return false
    this.pausedMs.set(id, (this.pausedMs.get(id) || 0) + (Date.now() - p.pausedAt))
    this.releasePause(id)
    const dc = this.getDc()
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ t: 'file-resume', id }))
    }
    const last = this.lastState.get(id)
    if (last) this.hooks.onTransferUpdate({ ...last, status: 'transferring' })
    return true
  }

  private releasePause(id: string) {
    const p = this.paused.get(id)
    if (p) {
      this.paused.delete(id)
      p.resolve()
    }
  }

  /** 发送循环内的暂停闸门：cancelled 同样会释放暂停 Promise */
  private async waitIfPaused(id: string) {
    const p = this.paused.get(id)
    if (p) await p.promise
  }

  /** 通道未就绪时等待 open（最多 10s），避免入队即发送抛错 */
  private async waitOpen(): Promise<RTCDataChannel | null> {
    let dc = this.getDc()
    if (dc && dc.readyState === 'open') return dc
    const t0 = Date.now()
    while (Date.now() - t0 < 10000) {
      await sleep(100)
      dc = this.getDc()
      if (dc && dc.readyState === 'open') return dc
    }
    return null
  }

  private async pump() {
    if (this.sending) return
    this.sending = true
    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      try {
        await this.sendOne(item.file, item.id)
      } catch (e) {
        this.hooks.onLog('error', `文件发送失败：${item.file.name}`, String(e))
        this.hooks.onTransferUpdate({
          id: item.id,
          direction: 'send',
          peerName: this.peerName,
          name: item.file.name,
          size: item.file.size,
          mime: item.file.type || 'application/octet-stream',
          received: 0,
          chunks: 0,
          receivedChunks: 0,
          speedBps: 0,
          startedTs: Date.now(),
          status: 'failed',
          resumable: true,
          error: String(e),
        })
        // 保留文件引用：UI「续传」按钮 → retry(id) 重新入队（接收端按 digest 从断点继续）
        this.resumableFiles.set(item.id, item.file)
      }
    }
    this.sending = false
  }

  private async sendOne(file: File, id: string) {
    const dc = await this.waitOpen()
    if (!dc) {
      this.hooks.onTransferUpdate({
        id,
        direction: 'send',
        peerName: this.peerName,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        received: 0,
        chunks: 0,
        receivedChunks: 0,
        speedBps: 0,
        startedTs: Date.now(),
        status: 'failed',
        resumable: true,
        error: '数据通道未就绪（10s 超时）',
      })
      this.resumableFiles.set(id, file)
      return
    }
    const base: TransferState = {
      id,
      direction: 'send',
      peerName: this.peerName,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      received: 0,
      chunks: Math.ceil(file.size / CHUNK_SIZE) || 1,
      receivedChunks: 0,
      speedBps: 0,
      startedTs: Date.now(),
      status: 'transferring',
      resumable: true,
    }
    this.hooks.onTransferUpdate({ ...base })
    this.lastState.set(id, base)

    const buffer = await file.arrayBuffer()
    const digest = await sha256HexOf(buffer)
    const chunks = Math.ceil(buffer.byteLength / CHUNK_SIZE) || 1

    // ---- 断点续传握手（P1-6）：宣告可续传 → 等对端上报 have → 对齐到块边界 ----
    dc.send(
      JSON.stringify({
        t: 'file-meta',
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        chunks,
        chunkSize: CHUNK_SIZE,
        digest,
        resumable: true,
      }),
    )
    let startChunk = 0
    const resumedHave = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        this.resumeWaiters.delete(id)
        resolve(0)
      }, RESUME_SYNC_WAIT_MS)
      this.resumeWaiters.set(id, (have) => {
        clearTimeout(timer)
        resolve(have)
      })
    })
    let resumedFrom = 0
    if (resumedHave > 0) {
      resumedFrom = alignResumeOffset(resumedHave)
      startChunk = Math.min(Math.floor(resumedFrom / CHUNK_SIZE), chunks)
    }
    if (startChunk > 0) {
      this.hooks.onLog(
        'info',
        `断点续传：${file.name} 从 ${Math.round((resumedFrom / Math.max(1, file.size)) * 100)}% 处继续`,
        `digest=${digest.slice(0, 12)}… · offset=${resumedFrom}`,
      )
    }

    let sent = resumedFrom
    const started = performance.now()
    const pausedTotal = () => this.pausedMs.get(id) || 0
    for (let i = startChunk; i < chunks; i++) {
      if (this.cancelledIds.has(id)) {
        this.hooks.onTransferUpdate({ ...base, received: sent, status: 'cancelled' })
        this.cancelledIds.delete(id)
        this.pausedMs.delete(id)
        this.resumableFiles.delete(id)
        return
      }
      // 暂停闸门：pause() 挂起、resume()/cancel() 释放
      await this.waitIfPaused(id)
      if (this.cancelledIds.has(id)) {
        this.hooks.onTransferUpdate({ ...base, received: sent, status: 'cancelled' })
        this.cancelledIds.delete(id)
        this.pausedMs.delete(id)
        this.resumableFiles.delete(id)
        return
      }
      const plain = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      if (!this.secure) {
        // E2EE 关闭协商：明文分块直发（无 1B epoch 帧头；接收端按同样协商走明文路径）
        dc.send(plain)
      } else {
        // DC 轮换链：当前纪元密钥加密，帧头带 1B epoch（接收端自主派生，无需信令同步）
        const { key, epoch } = await this.ring.out()
        const framed = await encryptFrame(key, plain)
        const wire = new Uint8Array(1 + framed.byteLength)
        wire[0] = epoch % 256
        wire.set(framed, 1)
        dc.send(wire.buffer as ArrayBuffer)
      }
      sent += plain.byteLength
      // 暂停时间不计入速度统计
      const elapsed = (performance.now() - started - pausedTotal()) / 1000
      if (i % 4 === 0 || i === chunks - 1) {
        const snap = { ...base, received: sent, resumedFrom, speedBps: elapsed > 0 ? sent / elapsed : 0 }
        this.lastState.set(id, snap)
        this.hooks.onTransferUpdate(snap)
      }
      await drainOnce(dc)
    }

    dc.send(JSON.stringify({ t: 'file-end', id, digest }))
    this.pausedMs.delete(id)
    this.lastState.delete(id)
    this.resumableFiles.delete(id)
    this.hooks.onTransferUpdate({
      ...base,
      received: buffer.byteLength,
      status: 'done',
      digestOk: true,
      digest,
      resumedFrom,
      speedBps: buffer.byteLength / Math.max(0.001, (performance.now() - started - pausedTotal()) / 1000),
    })
    this.hooks.onLog('info', `文件已发送：${file.name}`, `${(file.size / 1024).toFixed(1)} KB → ${this.peerName}`)
  }
}

/* -------------------------------- 接收端 -------------------------------- */

interface RecvSlot {
  state: TransferState
  parts: ArrayBuffer[]
  started: number
  /** 断点续传：本次会话前已落盘的明文（来自 IndexedDB；定期落盘时向前合并） */
  preBlob: Blob | null
  /** preBlob 的字节数（始终为块边界对齐） */
  preHave: number
  /** 已入盘暂存的块序号水位（避免重复写 IndexedDB） */
  savedChunks: number
  /** 落盘串行链：并发触发（阂值/暂停/取消）时按序合并，保证 have 单调不回退 */
  persistChain: Promise<void>
  /** finish 已启动：拦截迟到的阂值落盘（异步解密续延）在删除后重建陈旧记录 */
  finishing: boolean
  /** 已按明文兼容接收过（兼容对端加密模式差异；只提示一次） */
  plainCompatLogged?: boolean
}

/** 本端总接收字节 = 已落盘前缀 + 未落盘分片（单一事实源，避免双计数漂移） */
function totalReceived(slot: RecvSlot): number {
  let bytes = slot.preHave
  for (const p of slot.parts) bytes += p.byteLength
  return bytes
}

export class FileReceiver {
  private slots = new Map<string, RecvSlot>()

  constructor(
    private readonly ring: DcKeyRing,
    private readonly hooks: Hooks,
    /** 应用层分块加密开关（与发送端协商一致；false = 明文分块直收） */
    private readonly secure = true,
  ) {}

  /** 暂存当前进度到 IndexedDB（preBlob + 未落盘分片合并为连续 Blob；串行链防并发回退） */
  private persistSlot(slot: RecvSlot) {
    slot.persistChain = slot.persistChain.then(() => this.persistOnce(slot))
    return slot.persistChain
  }

  private async persistOnce(slot: RecvSlot) {
    // 执行器级守卫：finish 已启动后，任何早前入队的阈值落盘一律跳过（防删除后重建陈旧记录）；
    // 失败分支的最后落盘会先重置 finishing 再入队，不受此守卫影响
    if (slot.finishing) return
    const digest = slot.state.digest
    if (!digest) return
    if (slot.parts.length === 0 && !slot.preBlob) return
    // 关键（分片丢失修复）：同步接管 parts 所有权后再异步写盘 ——
    // await savePartial 期间新到的分片会 push 进新 parts 数组而绝不会被丢弃；
    // 旧实现「合并后 await → 再清空 parts」会把写盘窗口内到达的分片整组丢失
    const snapshot = slot.parts
    slot.parts = []
    const merged = new Blob([slot.preBlob ?? new Blob(), ...snapshot])
    if (merged.size === 0) {
      slot.parts = snapshot
      return
    }
    const okSaved = await savePartial({
      digest,
      name: slot.state.name,
      size: slot.state.size,
      mime: slot.state.mime,
      chunks: slot.state.chunks,
      chunkSize: CHUNK_SIZE,
      have: merged.size,
      updatedTs: Date.now(),
      blob: merged,
    })
    if (okSaved) {
      // 前缀推进：preBlob 吞并快照；快照期间新到的分片已在新 parts 中，下一轮继续
      slot.preBlob = merged
      slot.preHave = merged.size
      slot.savedChunks = slot.state.receivedChunks
    } else {
      // 写盘失败：归还快照（新到分片仍在其后），水位不变，下次重试
      slot.parts = snapshot.concat(slot.parts)
    }
  }

  handleControl(msg: Record<string, unknown>) {
    const t = msg.t
    if (t === 'file-meta') {
      const id = String(msg.id)
      const metaChunks = Number(msg.chunks || 0)
      const metaChunkSize = Number(msg.chunkSize || CHUNK_SIZE)
      const digest = String(msg.digest || '')
      const resumable = msg.resumable === true
      const slot: RecvSlot = {
        state: {
          id,
          direction: 'recv',
          peerName: '',
          name: String(msg.name || '未命名文件'),
          size: Number(msg.size || 0),
          mime: String(msg.mime || 'application/octet-stream'),
          received: 0,
          chunks: metaChunks,
          receivedChunks: 0,
          speedBps: 0,
          startedTs: Date.now(),
          status: 'transferring',
          digest,
          resumable,
        },
        parts: [],
        started: performance.now(),
        preBlob: null,
        preHave: 0,
        savedChunks: 0,
        persistChain: Promise.resolve(),
        finishing: false,
      }
      this.slots.set(id, slot)
      this.hooks.onTransferUpdate({ ...slot.state })
      this.hooks.onLog('crypto', `接收文件：${slot.state.name}`, `${(slot.state.size / 1024).toFixed(1)} KB（AES-GCM 加密块流）`)
      // ---- 断点续传握手（P1-6）：按 digest 查本地暂存，命中则上报 have 让发送端跳过 ----
      if (resumable && digest) {
        void (async () => {
          const partial = await loadPartial(digest)
          // 兼容性校验：块数/块大小一致才可续传（CHUNK_SIZE 版本变化时旧暂存作废）
          if (partial && partial.have > 0 && partial.chunks === metaChunks && partial.chunkSize === metaChunkSize) {
            slot.preBlob = partial.blob
            slot.preHave = partial.have
            slot.savedChunks = Math.floor(partial.have / metaChunkSize)
            slot.state.received = partial.have
            slot.state.receivedChunks = slot.savedChunks
            slot.state.resumedFrom = partial.have
            this.hooks.onTransferUpdate({ ...slot.state })
            this.hooks.onLog(
              'info',
              `发现本地断点：${slot.state.name} 已暂存 ${Math.round((partial.have / Math.max(1, slot.state.size)) * 100)}%`,
              `等待发送端从 offset=${partial.have} 继续（digest=${digest.slice(0, 12)}…）`,
            )
            this.hooks.sendControl?.({ t: 'file-resume-sync', id, have: partial.have })
          } else if (partial) {
            // 参数不一致的陈旧暂存：直接清除，从头接收
            void deletePartial(digest)
          }
        })()
      }
    } else if (t === 'file-end') {
      void this.finish(String(msg.id))
    } else if (t === 'file-cancel') {
      const id = String(msg.id)
      const slot = this.slots.get(id)
      if (slot) {
        // 取消：保留已收暂存供后续续传（发送端登记同样保留）
        void this.persistSlot(slot)
        this.hooks.onTransferUpdate({ ...slot.state, received: totalReceived(slot), status: 'cancelled', resumable: true })
        this.slots.delete(id)
      }
    } else if (t === 'file-pause') {
      // 发送端暂停：接收侧同步状态（数据流本身也会停，这里只是 UI 即时反馈）+ 顺手落盘
      const id = String(msg.id)
      const slot = this.slots.get(id)
      if (slot && slot.state.status === 'transferring') {
        void this.persistSlot(slot)
        this.hooks.onTransferUpdate({ ...slot.state, received: totalReceived(slot), status: 'paused' })
      }
    } else if (t === 'file-resume') {
      const id = String(msg.id)
      const slot = this.slots.get(id)
      if (slot && slot.state.status === 'paused') {
        this.hooks.onTransferUpdate({ ...slot.state, received: totalReceived(slot), status: 'transferring' })
      }
    }
  }

  async handleChunk(framed: ArrayBuffer) {
    // 当前只有一个进行中的接收流（发送端按会话串行），按唯一 slot 路由
    const entry = [...this.slots.entries()].find(([, s]) => s.state.status === 'transferring')
    if (!entry) return
    const [, slot] = entry
    try {
      if (!this.secure) {
        // E2EE 关闭协商：明文分块直收（无 epoch 帧头）
        slot.parts.push(framed)
      } else {
        // 帧内 1B epoch → 轮换环自主派生对应纪元密钥（跨纪元帧均可解，旧密钥窗口外销毁）
        const u8 = new Uint8Array(framed)
        if (u8.byteLength > 1 + 12 + 16) {
          const { key } = await this.ring.inKeyForByte(u8[0])
          const plain = await decryptFrame(key, u8.slice(1).buffer as ArrayBuffer)
          slot.parts.push(plain)
        } else {
          // 长度不足以构成密文帧：对端按明文发送（新旧版本/E2EE 开关差异）——按明文兼容收
          slot.parts.push(framed)
          this.hooks.onLog('warn', '收到明文分块（对端与本地加密模式不一致），已按兼容模式接收', `len=${u8.byteLength}`)
        }
      }
      slot.state.receivedChunks++
      const total = totalReceived(slot)
      const elapsed = (performance.now() - slot.started) / 1000
      if (slot.state.receivedChunks % 4 === 0) {
        this.hooks.onTransferUpdate({
          ...slot.state,
          received: total,
          speedBps: elapsed > 0 ? total / elapsed : 0,
        })
      }
      // 断点续传：每 PERSIST_EVERY_CHUNKS 块把连续进度写入 IndexedDB（页面刷新/断连后可续）
      // finishing 拦截：finish 排空后迟到的续延不得再入队（防删除后重建陈旧记录）
      if (
        !slot.finishing &&
        slot.state.digest &&
        slot.state.receivedChunks - slot.savedChunks >= PERSIST_EVERY_CHUNKS
      ) {
        void this.persistSlot(slot)
      }
    } catch (e) {
      // 兼容回退：期望密文但解密失败（GCM 校验不过）≈ 对端实际在发明文
      // （旧版本窗口 / E2EE 开关状态差异）。按明文收下，最终 SHA-256 仍会把关：
      // 真被篡改的数据过不了终验，不会静默出错文件。
      if (slot.state.status === 'transferring') {
        slot.parts.push(framed)
        if (!slot.plainCompatLogged) {
          slot.plainCompatLogged = true
          this.hooks.onLog('warn', '分块解密失败，已切换明文兼容接收（对端加密模式与本地不一致）', String(e).slice(0, 120))
        }
        return
      }
      this.hooks.onLog('error', '文件块解密失败（密钥不匹配或数据被篡改）', String(e))
      this.hooks.onTransferUpdate({ ...slot.state, status: 'failed', error: '解密失败', resumable: true })
      void this.persistSlot(slot)
      this.slots.delete(slot.state.id)
    }
  }

  private async finish(id: string) {
    const slot = this.slots.get(id)
    if (!slot) return
    this.slots.delete(id)
    slot.finishing = true
    this.hooks.onTransferUpdate({ ...slot.state, status: 'verifying' })
    // 先排空串行落盘链（阈值触发的 persist 可能仍在队列），避免「删除后又被旧 persist 写回」
    try {
      await slot.persistChain
    } catch {
      /* 落盘失败不阻塞校验 */
    }
    const blob = new Blob([slot.preBlob ?? new Blob(), ...slot.parts], { type: slot.state.mime })
    const digest = await sha256HexOf(await blob.arrayBuffer())
    const ok = !slot.state.digest || digest === slot.state.digest
    const url = URL.createObjectURL(blob)
    if (ok) {
      // 校验通过：暂存使命完成，立即擦除
      if (slot.state.digest) void deletePartial(slot.state.digest)
    } else {
      // 校验失败：保留暂存供重试续传（摘要不一致说明内容被篡改，续传会重新校验）；
      // 临时解除 finishing 让这一次刻意的落盘可以入队执行
      slot.finishing = false
      void this.persistSlot(slot)
    }
    this.hooks.onTransferUpdate({
      ...slot.state,
      received: blob.size,
      status: ok ? 'done' : 'failed',
      digestOk: ok,
      digest,
      downloadUrl: url,
      error: ok ? undefined : 'SHA-256 校验不一致',
      speedBps: blob.size / Math.max(0.001, (performance.now() - slot.started) / 1000),
    })
    this.hooks.onLog(
      ok ? 'crypto' : 'error',
      `文件接收完成：${slot.state.name}`,
      `SHA-256 ${ok ? '校验通过' : '校验失败'} · ${(blob.size / 1024).toFixed(1)} KB${slot.preHave > 0 ? ` · 断点续传 offset=${slot.preHave}` : ''}`,
    )
    // 显式回执（F-33）：把本端校验结果告知发送端（走同一加密 DataChannel 控制面），
    // 发送端 UI 由此把乐观的「对端已收到」升级为真回执「对端已确认」
    this.hooks.sendControl?.({ t: 'file-ack', id, ok })
  }
}
