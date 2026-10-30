/**
 * VeilTalk E2EE Worker — 媒体编码帧级端到端加密（W3C WebRTC Insertable Streams / Encoded Transform）
 *
 * 兼容两条标准路径：
 *  1. Chromium 系（Chrome/Edge/百基于 Chromium）：RTCRtpSender/Receiver.createEncodedStreams()
 *     → 主线程拿到 ReadableStream/WritableStream，postMessage 转移到本 worker
 *  2. 标准路径（Firefox 117+/Safari 15.4+）：RTCRtpScriptTransform
 *     → 主线程设置 sender/receiver.transform = new RTCRtpScriptTransform(worker, options)
 *     → 本 worker 通过 onrtctransform 事件获取 transformer
 *
 * 加密设计（v2 —— per-pipe 密钥上下文 + epoch 轮换链）：
 *  - AES-256-GCM，逐帧加密；帧格式 [1B epoch | 12B IV | 密文 | 16B tag]
 *  - additionalData 1 字节：帧内 epoch 字节（双端从同一帧头读取，必然一致）。
 *    注意：不要用关键帧标志作 AD —— Chromium 发送端/接收端的 frame.type 不对称
 *    （实测发送端 key 帧在接收端才是 'key'，发送侧 type 不可靠），会导致全量解密失败
 *  - **每条管线（pipe = 某对端的某方向 × 某媒体类型）持有独立密钥上下文**：
 *    不同对端/不同轨互不干扰（v1 的全局单 key 会在音视频同开时互相覆盖，已修复）
 *  - 密钥轮换链（前向保密简化版）：主线程注入 32B 轮换种子（HKDF 派生），
 *    epoch N 的帧密钥 = HKDF(seed, info="veiltalk:epoch:N")；
 *    编码端每 1024 帧或 5 分钟自动推进 epoch（也可由主线程 force-rotate），
 *    解码端按帧内 epoch 字节自主派生对应密钥 —— 无需信令同步，乱序/丢帧安全
 *  - 旧 epoch 密钥保留最近 3 个用于轮换边界容错，用后淘汰 → 泄露窗口有限
 *  - 解密失败的帧直接丢弃（计数上报），不进入解码器 → 天然抗篡改/抗注入
 *  - 种子与派生密钥只存在于 worker 内存，不落盘、不上报
 *
 * 该 worker 是纯计算单元：不访问 DOM、不发送网络请求（统计仅 postMessage 回主线程）。
 */

/// <reference lib="webworker" />

type FrameLike = {
  type?: 'key' | 'delta' | 'empty' | string
  timestamp: number
  data: ArrayBuffer | null
}

type StreamsLike = {
  readable: ReadableStream<FrameLike>
  writable: WritableStream<FrameLike>
}

type Mode = 'encode' | 'decode'

/** 轮换阈值：1024 帧（30fps 视频约 34s）或 5 分钟，先到先轮换 */
const RATCHET_MAX_FRAMES = 1024
const RATCHET_MAX_MS = 5 * 60 * 1000
/** 解码端保留的旧 epoch 密钥个数（轮换边界容错窗口） */
const EPOCH_WINDOW = 3

/** 帧头长度：1B epoch + 12B IV（密文另含 16B tag） */
const HEADER_LEN = 1 + 12

type PipeCtx = {
  pipeId: string
  mode: Mode
  /** 32B 轮换种子（HKDF 链根） */
  seed: Uint8Array
  /** 编码端：当前 epoch；解码端：最近观察到的 epoch */
  epoch: number
  /** epoch → 已导入的帧密钥（两端各自缓存） */
  keys: Map<number, CryptoKey>
  /** 编码端：自上次轮换以来的帧计数 */
  frames: number
  /** 编码端：上次轮换时间戳 */
  lastRotate: number
}

let stats = { encrypted: 0, decrypted: 0, dropped: 0, bytes: 0, rotations: 0, epoch: 0, lastError: '', transformEvents: 0, transformNoOpts: 0, pipesEnc: 0, pipesDec: 0 }
const pipes = new Map<string, PipeCtx>()

/** HKDF 链：seed → epoch N 的 32B 帧密钥原始字节 */
async function epochKey(ctx: PipeCtx, epoch: number): Promise<CryptoKey | null> {
  const cached = ctx.keys.get(epoch)
  if (cached) return cached
  try {
    const base = await crypto.subtle.importKey('raw', ctx.seed.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(`veiltalk:epoch:${epoch}`) },
      base,
      256,
    )
    const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt'])
    ctx.keys.set(epoch, key)
    // 淘汰超出窗口的旧 epoch 密钥（前向保密：老密钥尽快销毁）
    for (const e of ctx.keys.keys()) {
      if (e < epoch - EPOCH_WINDOW) ctx.keys.delete(e)
    }
    return key
  } catch {
    return null
  }
}

/** 编码端轮换判定：帧数或时间到达阈值 → epoch++（旧 epoch 密钥延迟淘汰） */
function maybeRotate(ctx: PipeCtx) {
  if (ctx.mode !== 'encode') return
  const now = Date.now()
  if (ctx.frames >= RATCHET_MAX_FRAMES || now - ctx.lastRotate >= RATCHET_MAX_MS) {
    ctx.epoch++
    ctx.frames = 0
    ctx.lastRotate = now
    stats.rotations++
    stats.epoch = Math.max(stats.epoch, ctx.epoch)
    for (const e of ctx.keys.keys()) {
      if (e < ctx.epoch - EPOCH_WINDOW) ctx.keys.delete(e)
    }
  }
}

async function transformEncode(ctx: PipeCtx, frame: FrameLike, controller: TransformStreamDefaultController<FrameLike>) {
  const data = frame.data
  if (!data || data.byteLength === 0 || frame.type === 'empty') {
    controller.enqueue(frame)
    return
  }
  try {
    maybeRotate(ctx)
    const key = await epochKey(ctx, ctx.epoch)
    if (!key) throw new Error('key not ready')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const epochByte = ctx.epoch & 0xff
    // AD 绑定帧内 epoch 字节（双端从同一帧头读取，不依赖 frame.type —— 见头部注释）
    const ad = new Uint8Array([epochByte])
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, data)
    const out = new Uint8Array(HEADER_LEN + ct.byteLength)
    out[0] = epochByte
    out.set(iv, 1)
    out.set(new Uint8Array(ct), HEADER_LEN)
    frame.data = out.buffer
    ctx.frames++
    stats.encrypted++
    stats.bytes += out.byteLength
    controller.enqueue(frame)
  } catch (e) {
    stats.dropped++
    stats.lastError = `enc:${String(e instanceof Error ? e.message : e).slice(0, 120)}`
    // 密文帧异常一律丢弃（fail-closed：宁可丢帧不可明文泄露）
  }
}

async function transformDecode(ctx: PipeCtx, frame: FrameLike, controller: TransformStreamDefaultController<FrameLike>) {
  const data = frame.data
  if (!data || data.byteLength <= HEADER_LEN + 16 || frame.type === 'empty') {
    controller.enqueue(frame)
    return
  }
  try {
    const u8 = new Uint8Array(data)
    const epoch = u8[0]
    const iv = u8.slice(1, 13)
    const body = u8.slice(HEADER_LEN)
    let pt: ArrayBuffer | null = null
    // 先按帧内 epoch 解密；失败再试上一个 epoch（轮换边界在途帧容错）。
    // AD 同步尝试对应 epoch 字节：加密端绑定的是它写出帧时的 epoch，与帧头一致
    for (const e of [epoch, epoch - 1]) {
      if (e < 0) continue
      const key = await epochKey(ctx, e)
      if (!key) continue
      try {
        pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([e & 0xff]) }, key, body)
        stats.epoch = Math.max(stats.epoch, e)
        break
      } catch {
        /* 尝试下一个 epoch */
      }
    }
    if (!pt) {
      // 诊断信息：记录失败帧的 type/epoch/长度分布（仅统计，不含内容）
      throw new Error(`epochkeys|t=${String(frame.type)}e=${u8[0]}l=${data.byteLength}`)
    }
    frame.data = pt
    stats.decrypted++
    controller.enqueue(frame)
  } catch (e) {
    stats.dropped++
    const msg = String(e instanceof Error ? e.message : e)
    // 采样式诊断：epochkeys 失败帧保留最近几条 type/epoch/长度样本
    if (msg.startsWith('epochkeys|')) {
      const prev = stats.lastError.startsWith('dec:samples:') ? stats.lastError.slice('dec:samples:'.length) : ''
      const parts = (prev + ' ' + msg.slice('epochkeys|'.length)).trim().split(' ').slice(-8)
      stats.lastError = 'dec:samples:' + parts.join(' ')
    } else {
      stats.lastError = `dec:${msg.slice(0, 120)}`
    }
    // 解密失败（密钥不匹配/被篡改/乱序注入）→ 丢弃
  }
}

function pipe(ctx: PipeCtx, streams: StreamsLike) {
  const t = new TransformStream<FrameLike, FrameLike>({
    transform: ctx.mode === 'encode' ? (f, c) => transformEncode(ctx, f, c) : (f, c) => transformDecode(ctx, f, c),
  })
  streams.readable
    .pipeThrough(t)
    .pipeTo(streams.writable)
    .catch(() => {
      /* 流被关闭（如会话结束）属于正常 */
    })
}

/** 创建或复用管线上下文（幂等：同一 pipeId 重复接线时保留原 epoch 状态） */
function ensureCtx(pipeId: string, mode: Mode, seed: ArrayBuffer | undefined | null): PipeCtx {
  const existing = pipes.get(pipeId)
  if (existing) return existing
  const s = seed instanceof ArrayBuffer ? new Uint8Array(seed.slice(0)) : new Uint8Array(32)
  const ctx: PipeCtx = {
    pipeId,
    mode,
    seed: s,
    epoch: 0,
    keys: new Map(),
    frames: 0,
    lastRotate: Date.now(),
  }
  pipes.set(pipeId, ctx)
  return ctx
}

type E2EEMsg = {
  op?: string
  mode?: Mode
  pipeId?: string
  seed?: ArrayBuffer
  readable?: ReadableStream<FrameLike>
  writable?: WritableStream<FrameLike>
}

self.onmessage = async (ev: MessageEvent<E2EEMsg>) => {
  const d = ev.data
  if (d?.op === 'e2ee' && d.pipeId && d.mode) {
    const ctx = ensureCtx(d.pipeId, d.mode, d.seed)
    if (d.readable && d.writable) {
      if (d.mode === 'encode') stats.pipesEnc++
      else stats.pipesDec++
      pipe(ctx, { readable: d.readable, writable: d.writable })
    }
    return
  }
  if (d?.op === 'force-rotate' && d.pipeId) {
    const ctx = pipes.get(d.pipeId)
    if (ctx && ctx.mode === 'encode') {
      ctx.epoch++
      ctx.frames = 0
      ctx.lastRotate = Date.now()
      stats.rotations++
      stats.epoch = Math.max(stats.epoch, ctx.epoch)
    }
    return
  }
  if (d?.op === 'drop-pipe' && d.pipeId) {
    pipes.delete(d.pipeId)
  }
}

// 标准路径（Firefox / Safari）：transformer.options 携带 { mode, pipeId, seed }
const wself = self as unknown as {
  onrtctransform: ((ev: { transformer: { readable: ReadableStream<FrameLike>; writable: WritableStream<FrameLike>; options?: E2EEMsg } }) => void) | null
}
wself.onrtctransform = (ev) => {
  const { readable, writable, options } = ev.transformer
  stats.transformEvents++
  void (async () => {
    if (!options?.mode || !options?.pipeId) {
      stats.transformNoOpts++
      return
    }
    const ctx = ensureCtx(options.pipeId, options.mode, options.seed)
    if (options.mode === 'encode') stats.pipesEnc++
    else stats.pipesDec++
    pipe(ctx, { readable, writable })
  })()
}

// 统计上报（每 2s 汇总一次回主线程）
setInterval(() => {
  if (stats.encrypted || stats.decrypted || stats.dropped || stats.rotations || stats.transformEvents) {
    self.postMessage({ op: 'stats', stats: { ...stats } })
  }
}, 2000)
