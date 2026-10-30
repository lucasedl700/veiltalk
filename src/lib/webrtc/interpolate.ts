'use client';

/**
 * FrameInterpolator — 运动补偿补帧（MEMC-lite，2026-10 重写）
 *
 * 旧版问题（用户反馈「八只手残影」「开了等于没开」）：prev 直接以 45% 透明度叠加
 * 在 curr 上 —— 那是叠影不是插帧：运动区域新旧位置同时可见（重影），且从未生成
 * 任何「中间时刻」的画面（帧率感知无提升）。
 *
 * 新版原理（电视芯片 MEMC 的浏览器实时版）：
 *  1. 运动估计：源帧对降采样到 ~192px 灰度图，按 8px 块两段搜索（粗 ±6 步长 2 →
 *     细 ±1）求每块运动向量 mv（prev→curr）与匹配置信度（SAD）。
 *  2. 运动补偿合成中间帧：M(x) = 0.5·P(x−mv/2) + 0.5·C(x+mv/2)——沿运动路径把
 *     前后帧对齐后混合，生成真正的 t_mid 画面（对齐 ⇒ 无重影）。
 *  3. 分区回退（诚实降级）：低置信块（运动过快/匹配失败）保持原始 curr 不混合
 *     ——宁可不插也不叠影；整帧运动极小走纯混合捷径；场景切换（全局 SAD 爆表）
 *     该周期直接透传源帧。
 *  4. 输出节奏：源帧（相位 A）与合成中间帧（相位 B）严格交替 → 时间轴上真的
 *     多出一倍采样点，而非同样的帧拖脏。
 *
 * 诚实定位：非 AI 光流模型（RIFE 等在浏览器实时跑不可行），是块匹配运动补偿的
 * 轻量实现 —— 中低速运动（谈话/手势/缓慢平移）显著平滑且无重影；超快运动按
 * 设计回退原帧。原始轨不动：与 FrameEnhancer/VirtualBackground 同构，失败回退
 * 原轨不断流。纯函数部分（灰度化/运动估计）不依赖 DOM，供单测直接导入。
 */

/* ---------------------------- 纯函数：运动估计 ---------------------------- */

/** RGBA ImageData → 单通道灰度（w*h，行主序） */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec.601 亮度，整数近似（视觉差可忽略，追求速度）
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8
  }
  return out
}

export interface MotionField {
  /** 网格尺寸（块数） */
  gw: number
  gh: number
  /** 每块运动向量 (dx,dy)，est 像素单位，行主序 [gy*gw+gx] */
  mvs: Int8Array
  /** 每块置信度 = 平均每像素 SAD（0 完美匹配，越大越差） */
  sads: Float32Array
  /** 全局平均每像素 SAD（静态判定/场景切换判定用） */
  globalSad: number
  /** 有实际运动（|mv|>0.5px）且匹配可信的块占比 */
  motionFrac: number
}

export interface EstimateOpts {
  /** est 尺度下的搜索半径（px） */
  search?: number
  /** 块边长（est px） */
  block?: number
}

/**
 * 块匹配运动估计：锚定 prev 块 (ox,oy)，在 curr 中搜索位移 (mvx,mvy) 使
 * SAD(prev[ox,oy], curr[ox+mvx, oy+mvy]) 最小；两段搜索（粗 ±search 步长 2 →
 * 以最优点为中心细 ±1）。平局规则：SAD 相同取位移更小的候选（运动平滑先验，
 * 纯色/无纹理块存在多个等价最小值，否则会随机偏向大位移产生伪运动）。
 * 纯函数、无 DOM。
 */
export function estimateMotion(prev: Uint8Array, curr: Uint8Array, w: number, h: number, opts?: EstimateOpts): MotionField {
  const BLOCK = opts?.block ?? 8
  const SEARCH = opts?.search ?? 6
  const gw = Math.max(1, Math.floor(w / BLOCK))
  const gh = Math.max(1, Math.floor(h / BLOCK))
  const mvs = new Int8Array(gw * gh * 2)
  const sads = new Float32Array(gw * gh)
  let sadSum = 0
  let motionBlocks = 0

  /** SAD(prev 块 @ (ox,oy), curr 块 @ (ox+mvx, oy+mvy))，超过 cap 提前退出（返回 cap+1） */
  const sad = (ox: number, oy: number, mvx: number, mvy: number, cap: number): number => {
    if (ox + mvx < 0 || oy + mvy < 0 || ox + mvx + BLOCK > w || oy + mvy + BLOCK > h) return -1
    let s = 0
    for (let y = 0; y < BLOCK; y++) {
      const pr = (oy + y) * w + ox
      const cr = (oy + mvy + y) * w + ox + mvx
      for (let x = 0; x < BLOCK; x++) {
        s += Math.abs(prev[pr + x] - curr[cr + x])
      }
      if (s > cap) return cap + 1
    }
    return s
  }

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const ox = gx * BLOCK
      const oy = gy * BLOCK
      // 零向量基准（块贴近边界时无效 → 整块标不可信）
      let best = sad(ox, oy, 0, 0, Infinity)
      let bdx = 0
      let bdy = 0
      if (best < 0) best = Infinity
      /** 接受条件：严格更小 SAD；或 SAD 相同且位移更小（无纹理块的平局裁决） */
      const accept = (s: number, dx: number, dy: number) =>
        s >= 0 && (s < best || (s === best && Math.abs(dx) + Math.abs(dy) < Math.abs(bdx) + Math.abs(bdy)))
      // 粗搜（步长 2，含 0 点重复无害）
      for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
          if (dx === 0 && dy === 0) continue
          const s = sad(ox, oy, dx, dy, best)
          if (accept(s, dx, dy)) {
            best = s
            bdx = dx
            bdy = dy
          }
        }
      }
      // 细搜（最优点 ±1，步长 1）
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const s = sad(ox, oy, bdx + dx, bdy + dy, best)
          if (accept(s, bdx + dx, bdy + dy)) {
            best = s
            bdx = bdx + dx
            bdy = bdy + dy
          }
        }
      }

      const mean = best === Infinity ? 255 : best / (BLOCK * BLOCK)
      const idx = gy * gw + gx
      mvs[idx * 2] = bdx
      mvs[idx * 2 + 1] = bdy
      sads[idx] = mean
      sadSum += mean
      if (mean < 6 && (bdx !== 0 || bdy !== 0)) motionBlocks++
    }
  }
  const n = gw * gh
  return { gw, gh, mvs, sads, globalSad: sadSum / n, motionFrac: motionBlocks / n }
}

/* ---------------------------- 合成器（DOM 部分） ---------------------------- */

/** est 尺度运动场 → 输出尺度渲染参数（每输出块取中心对应的 est 块 MV） */
function mvAt(field: MotionField, gx: number, gy: number): { dx: number; dy: number; conf: number } {
  const cx = Math.min(field.gw - 1, Math.max(0, gx))
  const cy = Math.min(field.gh - 1, Math.max(0, gy))
  const idx = cy * field.gw + cx
  return { dx: field.mvs[idx * 2], dy: field.mvs[idx * 2 + 1], conf: field.sads[idx] }
}

const CONF_OK = 7 // 平均每像素 SAD ≤ 7 视为匹配可信（8bit 灰度）
const STATIC_SAD = 1.2 // 全局低于此值视为静止画面（纯混合捷径，对齐无影）
const CUT_SAD = 30 // 全局高于此值视为场景切换（该周期透传，防闪混）
const STALE_MS = 400 // prev 超龄即不作中间帧

export class FrameInterpolator {
  private out: MediaStream | null = null
  private procTrack: MediaStreamTrack | null = null
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  /** rAF 停摆兜底驱动（后台 tab/无头遮挡时保住出帧不冻结） */
  private timer: ReturnType<typeof setInterval> | null = null
  private stopRvfc: (() => void) | null = null
  private ready = false
  private stopping = false

  /** prev/curr 两帧位图与时间戳（performance.now 基准） */
  private prev: { bmp: ImageBitmap; ts: number } | null = null
  private curr: { bmp: ImageBitmap; ts: number } | null = null
  private lastDrawTs = 0
  /** 输出相位：true = 下一个 tick 画合成中间帧 */
  private midPhase = false

  /* 运动估计上下文（est 小画布 + 最近一次运动场） */
  private estCanvas: HTMLCanvasElement | null = null
  private estCtx: CanvasRenderingContext2D | null = null
  private estW = 192
  private estH = 108
  private prevGray: Uint8Array | null = null
  private field: MotionField | null = null
  /** est→输出 缩放比（MV 换算用） */
  private scale = 1
  /** 渲染块边长（输出 px）：60 块量级，每中间帧 ≤120 次 drawImage */
  private blockOut = 64

  active(): boolean {
    return this.ready && !!this.procTrack && this.procTrack.readyState === 'live'
  }

  processedTrack(): MediaStreamTrack | null {
    return this.active() ? this.procTrack : null
  }

  async start(src: MediaStreamTrack): Promise<MediaStreamTrack | null> {
    if (typeof document === 'undefined' || src.readyState !== 'live') return null
    await this.stop()
    this.stopping = false
    try {
      const settings = src.getSettings()
      const srcFps = Math.max(5, Math.round(settings.frameRate || 15))
      const outFps = Math.min(60, srcFps * 2)
      const width = Math.max(160, settings.width || 640)
      const height = Math.max(120, settings.height || 360)

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return null
      this.canvas = canvas
      this.ctx = ctx

      // 估计小画布（固定 192 宽，等比高）
      this.estW = 192
      this.estH = Math.max(2, Math.round((192 * height) / width))
      const estCanvas = document.createElement('canvas')
      estCanvas.width = this.estW
      estCanvas.height = this.estH
      this.estCtx = estCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
      this.estCanvas = estCanvas
      this.scale = width / this.estW
      this.blockOut = Math.max(32, Math.round(64 * (width / 640)))
      this.prevGray = null
      this.field = null

      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = new MediaStream([src])
      await video.play().catch(() => {})
      this.video = video

      // 逐源帧捕获：新帧到达 → curr 降级为 prev（400ms 内有效），新位图成为 curr；
      // 同时在低分辨率上跑一次运动估计（更新运动场供中间帧合成用）
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
      if (typeof v.requestVideoFrameCallback === 'function') {
        let alive = true
        const loop = () => {
          if (!alive || this.stopping) return
          this.captureFrame()
          v.requestVideoFrameCallback!(loop)
        }
        v.requestVideoFrameCallback!(loop)
        this.stopRvfc = () => {
          alive = false
        }
      } else {
        const t = setInterval(() => this.captureFrame(), 33) // 无 rvfc 环境兜底采样
        this.stopRvfc = () => clearInterval(t)
      }

      this.out = canvas.captureStream(outFps)
      this.procTrack = this.out.getVideoTracks()[0] || null
      if (!this.procTrack) {
        await this.stop()
        return null
      }
      this.lastDrawTs = performance.now()
      this.midPhase = false
      this.renderLoop(outFps)
      this.ready = true
      return this.procTrack
    } catch {
      await this.stop()
      return null
    }
  }

  private captureFrame() {
    if (this.stopping || !this.video || this.video.readyState < 2) return
    const video = this.video
    if (typeof createImageBitmap !== 'function') return
    createImageBitmap(video)
      .then((bmp) => {
        if (this.stopping) {
          bmp.close()
          return
        }
        const now = performance.now()
        this.prev = this.curr && now - this.curr.ts < STALE_MS ? this.curr : null
        this.curr = { bmp, ts: now }
        this.estimate()
      })
      .catch(() => {})
  }

  /** 低分辨率灰度块匹配：每个源帧对更新一次运动场（~192px，成本可忽略） */
  private estimate() {
    const ec = this.estCtx
    const prev = this.prev
    const curr = this.curr
    if (!ec || !this.estCanvas || !prev || !curr) return
    const t0 = performance.now()
    try {
      ec.drawImage(curr.bmp, 0, 0, this.estW, this.estH)
      const data = ec.getImageData(0, 0, this.estW, this.estH).data
      const currGray = toGray(data, this.estW, this.estH)
      if (this.prevGray && this.prevGray.length === currGray.length) {
        this.field = estimateMotion(this.prevGray, currGray, this.estW, this.estH)
      }
      this.prevGray = currGray
    } catch {
      /* 位图偶发不可读：跳过本帧估计，沿用上一场 */
    }
    void t0
  }

  /** 渲染循环：源帧（A）与运动补偿中间帧（B）严格交替 —— 时间轴真倍频。
   *  双驱动：rAF 为主（前台满帧率）；rAF 停摆（标签页切后台/无头遮挡，rAF 会被暂停
   *  → 画布停帧 → 本地预览与对端全部黑屏冻结）时由 setInterval 兜底继续出帧
   *  （后台 tab 定时器被节流到 ~1Hz，也远好于完全冻结）。draw 幂等可安全双触发。 */
  private renderLoop(outFps: number) {
    const interval = 1000 / outFps
    const draw = () => {
      if (this.stopping) return
      const now = performance.now()
      if (now - this.lastDrawTs < interval - 2) return
      this.lastDrawTs = now
      const ctx = this.ctx
      const v = this.video
      if (!ctx || !this.canvas || !v || v.readyState < 2) return
      this.midPhase = !this.midPhase
      if (!this.midPhase) {
        // 相位 A：源帧原样输出（最低延迟）
        ctx.globalAlpha = 1
        ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height)
        return
      }
      // 相位 B：合成中间帧
      this.drawMidpoint()
    }
    const rafLoop = () => {
      if (this.stopping) return
      this.raf = requestAnimationFrame(rafLoop)
      draw()
    }
    this.raf = requestAnimationFrame(rafLoop)
    this.timer = setInterval(() => {
      if (this.stopping) return
      draw()
      // rAF 恢复运转时无需处理（draw 幂等，时间戳节流防双画）
    }, Math.max(30, Math.round(interval)))
  }

  /**
   * 运动补偿中间帧：
   *   M(x) = 0.5·P(x−mv/2) + 0.5·C(x+mv/2)
   * 分层绘制 —— 底图 curr 不透明（缝隙/低置信块兜底）→ 高置信块先铺 curr 位移采样、
   * 再以 α=0.5 叠 prev 反向位移采样（对齐混合 ⇒ 无重影）。静态画面走纯混合捷径。
   */
  private drawMidpoint() {
    const ctx = this.ctx
    const canvas = this.canvas
    const prev = this.prev
    const curr = this.curr
    if (!ctx || !canvas || !curr) return
    const W = canvas.width
    const H = canvas.height

    // 无可比对（首帧/prev 超龄）或场景切换：透传源帧（不混合，防闪影）
    const field = this.field
    if (!prev || !field || field.globalSad >= CUT_SAD) {
      ctx.globalAlpha = 1
      ctx.drawImage(curr.bmp, 0, 0, W, H)
      return
    }
    // 静止画面：无运动块且残差极低 → 纯混合即是无影中间帧（最便宜路径）。
    // 注意不能只看 globalSad —— 运动被运动补偿完美捕捉时残差同样≈0，须同时要求运动块占比为 0。
    if (field.globalSad <= STATIC_SAD && field.motionFrac < 0.02) {
      ctx.globalAlpha = 1
      ctx.drawImage(curr.bmp, 0, 0, W, H)
      ctx.globalAlpha = 0.5
      ctx.drawImage(prev.bmp, 0, 0, W, H)
      ctx.globalAlpha = 1
      return
    }

    // 运动补偿：底图 + 逐块对齐混合（dest 外扩 1px 盖缝）
    ctx.globalAlpha = 1
    ctx.drawImage(curr.bmp, 0, 0, W, H)
    const B = this.blockOut
    const half = this.scale * 0.5 // est px → 输出 px（取半：mv/2）
    const bw = Math.ceil(W / B)
    const bh = Math.ceil(H / B)
    const egw = field.gw
    const egh = field.gh
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x = bx * B
        const y = by * B
        // 输出块中心 → est 网格坐标
        const gx = Math.floor(((x + B / 2) / W) * egw)
        const gy = Math.floor(((y + B / 2) / H) * egh)
        const { dx, dy, conf } = mvAt(field, gx, gy)
        if (conf > CONF_OK) continue // 匹配不可信：保持底图（不叠影）
        const sx = dx * half
        const sy = dy * half
        // curr 沿运动前向采样 + prev 沿运动后向采样（float 源坐标，亚像素由浏览器插值）
        const csx = x + sx
        const csy = y + sy
        const psx = x - sx
        const psy = y - sy
        if (csx < 0 || csy < 0 || csx + B > W || csy + B > H) continue
        if (psx < 0 || psy < 0 || psx + B > W || psy + B > H) continue
        ctx.globalAlpha = 1
        ctx.drawImage(curr.bmp, csx, csy, B, B, x - 1, y - 1, B + 2, B + 2)
        ctx.globalAlpha = 0.5
        ctx.drawImage(prev.bmp, psx, psy, B, B, x - 1, y - 1, B + 2, B + 2)
      }
    }
    ctx.globalAlpha = 1
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.ready = false
    cancelAnimationFrame(this.raf)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stopRvfc?.()
    this.stopRvfc = null
    try { this.video?.pause() } catch { /* noop */ }
    this.video = null
    this.prev?.bmp.close()
    this.curr?.bmp.close()
    this.prev = null
    this.curr = null
    this.prevGray = null
    this.field = null
    this.estCanvas = null
    this.estCtx = null
    try { this.procTrack?.stop() } catch { /* noop */ }
    this.procTrack = null
    this.out = null
    this.canvas = null
    this.ctx = null
  }
}
