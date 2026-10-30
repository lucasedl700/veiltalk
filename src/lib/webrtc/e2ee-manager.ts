/**
 * VeilTalk E2EE Manager — 主线程侧的帧加密接线器（单例 worker 复用）
 *
 * 模块职责：
 *  - 创建/持有唯一的 E2EE Worker
 *  - 检测浏览器能力并选择标准路径（RTCRtpScriptTransform）或 Chromium 路径（createEncodedStreams）
 *  - 将 sender/receiver 接入 worker 并按「管线 ID」注入轮换种子
 *    （pipeId = <对端socketId>:<send|recv>:<video|audio>，每条管线独立密钥上下文）
 *  - 支持手动 force-rotate（诊断面板「立即轮换媒体密钥」）
 *  - 汇总 worker 上报的帧加密统计
 */

import type { E2EEStats, E2EEMode } from './types'

type StreamsLike = { readable: ReadableStream; writable: WritableStream }

type SenderLike = {
  track?: MediaStreamTrack | null
  createEncodedStreams?: () => StreamsLike
  transform?: unknown
}

type ReceiverLike = {
  track?: MediaStreamTrack
  createEncodedStreams?: () => StreamsLike
  transform?: unknown
}

type WorkerMsg = { op: string; stats?: E2EEStats }

class E2EEManager {
  private worker: Worker | null = null
  private listeners = new Set<(s: E2EEStats) => void>()
  private lastStats: E2EEStats = { encrypted: 0, decrypted: 0, dropped: 0, bytes: 0, rotations: 0, epoch: 0 }
  capability: E2EEMode = 'unsupported'
  /** 接线失败诊断（BUG-16 排查）：最后一次 attach 异常的管线与错误信息 */
  lastAttachError = ''

  getStats(): E2EEStats {
    return { ...this.lastStats }
  }

  onStats(cb: (s: E2EEStats) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./e2ee.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<WorkerMsg>) => {
      if (ev.data?.op === 'stats' && ev.data.stats) {
        this.lastStats = ev.data.stats
        this.listeners.forEach((cb) => cb(this.lastStats))
      }
    }
    this.worker = w
    this.capability = detectCapability()
    return w
  }

  /**
   * 发送方向接线：遗留 createEncodedStreams 优先（历史确定性路径，协商前/后均可）；
   * 标准 RTCRtpScriptTransform 仅作回退（Chromium 对 sender 生效但不稳定，见 BUG-16 实测）。
   * pipeId 唯一标识一条管线（对端×方向×媒体类型），密钥互不干扰。
   */
  attachSender(sender: RTCRtpSender, seedBytes: ArrayBuffer, pipeId: string): E2EEMode {
    const w = this.ensureWorker()
    const s = sender as unknown as SenderLike
    if (typeof s.createEncodedStreams === 'function') {
      try {
        const streams = s.createEncodedStreams()
        w.postMessage(
          { op: 'e2ee', mode: 'encode', pipeId, seed: seedBytes, readable: streams.readable, writable: streams.writable },
          [streams.readable, streams.writable],
        )
        return 'encoded-streams'
      } catch (e) {
        this.lastAttachError = `send:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachSender（遗留）失败', this.lastAttachError)
        // 落到标准路径尝试
      }
    }
    const RTCRtpScriptTransformCtor = (
      globalThis as unknown as {
        RTCRtpScriptTransform?: new (worker: Worker, options?: unknown, transfer?: Transferable[]) => unknown
      }
    ).RTCRtpScriptTransform
    if (RTCRtpScriptTransformCtor) {
      try {
        s.transform = new RTCRtpScriptTransformCtor(w, { mode: 'encode', pipeId, seed: seedBytes })
        return 'script-transform'
      } catch (e) {
        this.lastAttachError = `send-std:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachSender（标准）失败', this.lastAttachError)
      }
    }
    return 'unsupported'
  }

  /**
   * 发送方向构造期预接线（BUG-16 终极修复）：传输启动前挂 transform，后续 replaceTrack
   * 喂入的轨道自动流经加密管线（屏幕共享热替换同享此保障）。遗留 API 优先。
   */
  attachSenderEarly(sender: RTCRtpSender, seedBytes: ArrayBuffer, pipeId: string): E2EEMode {
    const w = this.ensureWorker()
    const s = sender as unknown as SenderLike
    if (typeof s.createEncodedStreams === 'function') {
      try {
        const streams = s.createEncodedStreams()
        w.postMessage(
          { op: 'e2ee', mode: 'encode', pipeId, seed: seedBytes, readable: streams.readable, writable: streams.writable },
          [streams.readable, streams.writable],
        )
        return 'encoded-streams'
      } catch (e) {
        this.lastAttachError = `send-early:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachSenderEarly（遗留）失败', this.lastAttachError)
      }
    }
    const RTCRtpScriptTransformCtor = (
      globalThis as unknown as {
        RTCRtpScriptTransform?: new (worker: Worker, options?: unknown, transfer?: Transferable[]) => unknown
      }
    ).RTCRtpScriptTransform
    if (RTCRtpScriptTransformCtor) {
      try {
        s.transform = new RTCRtpScriptTransformCtor(w, { mode: 'encode', pipeId, seed: seedBytes })
        return 'script-transform'
      } catch (e) {
        this.lastAttachError = `send-early-std:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachSenderEarly（标准）失败', this.lastAttachError)
      }
    }
    return 'unsupported'
  }

  /** 接收方向接线（ontrack 兜底用）：遗留优先（Chromium receiver 标准路径不生效，见 BUG-16 实测）；
   * 构造期预接线的 receiver 不会走到这里（幂等跳过）。 */
  attachReceiver(receiver: RTCRtpReceiver, seedBytes: ArrayBuffer, pipeId: string): E2EEMode {
    const w = this.ensureWorker()
    const r = receiver as unknown as ReceiverLike
    if (typeof r.createEncodedStreams === 'function') {
      try {
        const streams = r.createEncodedStreams()
        w.postMessage(
          { op: 'e2ee', mode: 'decode', pipeId, seed: seedBytes, readable: streams.readable, writable: streams.writable },
          [streams.readable, streams.writable],
        )
        return 'encoded-streams'
      } catch (e) {
        this.lastAttachError = `recv:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachReceiver（遗留）失败', this.lastAttachError)
        // 落到标准路径尝试
      }
    }
    const RTCRtpScriptTransformCtor = (
      globalThis as unknown as {
        RTCRtpScriptTransform?: new (worker: Worker, options?: unknown, transfer?: Transferable[]) => unknown
      }
    ).RTCRtpScriptTransform
    if (RTCRtpScriptTransformCtor) {
      try {
        r.transform = new RTCRtpScriptTransformCtor(w, { mode: 'decode', pipeId, seed: seedBytes })
        return 'script-transform'
      } catch (e) {
        this.lastAttachError = `recv-std:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachReceiver（标准）失败', this.lastAttachError)
      }
    }
    return 'unsupported'
  }

  /**
   * 接收方向接线（构造期预接线专用，BUG-16 终极修复）：
   * 遗留 createEncodedStreams 优先 —— Chromium 152 实测：标准 RTCRtpScriptTransform 对
   * RECEIVER 不生效（transform 被静默忽略，帧绕过管线），仅对 SENDER 生效；
   * 而遗留 API 只要早于首帧调用即可靠 —— 构造期预接线必然早于首帧。
   */
  attachReceiverEarly(receiver: RTCRtpReceiver, seedBytes: ArrayBuffer, pipeId: string): E2EEMode {
    const w = this.ensureWorker()
    const r = receiver as unknown as ReceiverLike
    if (typeof r.createEncodedStreams === 'function') {
      try {
        const streams = r.createEncodedStreams()
        w.postMessage(
          { op: 'e2ee', mode: 'decode', pipeId, seed: seedBytes, readable: streams.readable, writable: streams.writable },
          [streams.readable, streams.writable],
        )
        return 'encoded-streams'
      } catch (e) {
        this.lastAttachError = `recv-early:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachReceiverEarly（遗留）失败', this.lastAttachError)
        // 落到标准路径尝试
      }
    }
    const RTCRtpScriptTransformCtor = (
      globalThis as unknown as {
        RTCRtpScriptTransform?: new (worker: Worker, options?: unknown, transfer?: Transferable[]) => unknown
      }
    ).RTCRtpScriptTransform
    if (RTCRtpScriptTransformCtor) {
      try {
        r.transform = new RTCRtpScriptTransformCtor(w, { mode: 'decode', pipeId, seed: seedBytes })
        return 'script-transform'
      } catch (e) {
        this.lastAttachError = `recv-early-std:${pipeId}:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        console.error('[E2EE] attachReceiverEarly（标准）失败', this.lastAttachError)
      }
    }
    return 'unsupported'
  }

  /** 手动推进某条编码管线的 epoch（诊断面板/自检用；对端按帧内 epoch 自动跟随） */
  forceRotate(pipeId: string): boolean {
    if (!this.worker) return false
    this.worker.postMessage({ op: 'force-rotate', pipeId })
    return true
  }

  /** 会话销毁时清理管线上下文（密钥随 ctx 释放） */
  dropPipe(pipeId: string): void {
    if (!this.worker) return
    this.worker.postMessage({ op: 'drop-pipe', pipeId })
  }

  /** 原始密钥字节（供自检等场景复用同一 worker 统计通道） */
  ensure(): Worker {
    return this.ensureWorker()
  }

  /** 测试钩子：暴露底层 worker（QA 用手工管线验证帧格式/轮换逻辑） */
  debugWorker(): Worker {
    return this.ensureWorker()
  }
}

/**
 * Apple 全平台（iOS/iPadOS 所有浏览器 = WebKit 内核，含 CriOS；macOS Safari）强制关闭帧级加密。
 *
 * 依据（用户真机 iPad 10 + iPadOS 26 + Chrome 最新版实测症状）：
 *  - WebKit 暴露 RTCRtpScriptTransform → detectCapability 会误报「支持」；
 *  - 但真机上帧管线不可靠：接收方向或可解（能看到电脑端画面），发送方向产出对端无法
 *    解码的帧（电脑端听不到 iPad 声音 / 看不到 iPad 屏幕共享，而反向全部正常 —— 方向不对称）；
 *  - 统一回退 DTLS-SRTP（传输层全程加密，密钥协商与数据通道 E2EE 不受影响），
 *    换取音视频/屏幕共享全功能互通。
 */
export function isAppleWebKitNoFrameE2EE(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  // macOS Safari：含 Safari 标识且排除一切 Chromium/Firefox 变体 UA
  const isDesktopSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|FxiOS|Firefox/i.test(ua)
  return isIOS || isDesktopSafari
}

let capabilityCache: E2EEMode | null = null

export function detectCapability(): E2EEMode {
  if (typeof window === 'undefined') return 'unsupported'
  if (capabilityCache) return capabilityCache
  // Apple WebKit 优先短路（在任何 API 探测之前，避免 WebKit 半残实现被误判为可用）
  if (isAppleWebKitNoFrameE2EE()) {
    capabilityCache = 'unsupported'
    return capabilityCache
  }
  // 标准路径优先（BUG-16）：RTCRtpScriptTransform（Chrome 137+/Firefox/Safari）无 "Too late" 时序限制
  // 注意：用 globalThis 判断而非 `in window`——TS 对 window 的属性收窄会把后续分支窄化成 never
  const hasScriptTransform =
    typeof (globalThis as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined'
  if (hasScriptTransform) {
    capabilityCache = 'script-transform'
    return capabilityCache
  }
  const senderProto = window.RTCRtpSender?.prototype as unknown as {
    createEncodedStreams?: () => StreamsLike
  } | undefined
  capabilityCache = senderProto && typeof senderProto.createEncodedStreams === 'function' ? 'encoded-streams' : 'unsupported'
  return capabilityCache
}

export const e2eeManager = new E2EEManager()
