/**
 * VirtualBackground — AI 虚拟背景（人像分割实时合成）处理管线
 *
 * 职责：把源视频轨接进隐藏 <video> → MediaPipe ImageSegmenter（本地模型 +
 * 本地 WASM，零外网依赖）逐帧分割人像 → canvas 合成（背景层 = 模糊/纯色/
 * 渐变/自定义图片；前景 = 原始人像软边叠加）→ captureStream 产出加工轨。
 *
 * 2026-10 重写要点（用户实测反馈「人被一起虚化」「手机看不到」「太吃算力」）：
 *  1. 掩码极性判定重写：旧版「边界投票」在人凑近镜头占满边框时必投反 →
 *     人被当背景虚化。新版取 selfie 模型的 person 类掩码（多类时取末类），
 *     并用「覆盖率 + 边界先验」双信号联合打分判定极性，凑近/远离都不误判。
 *  2. 退化保护（fail-open）：分割持续异常（掩码近空/近满）→ 自动透传原始画面
 *     （宁可没效果，绝不把人虚化掉），恢复后自动回到效果模式。
 *  3. ctx.filter 兼容：iOS Safari 不支持 canvas filter（模糊全部失效）→
 *     检测不支持时用「降采样-放大」廉价模糊替代，全平台可用。
 *  4. 降载：处理宽度桌面 960 / 移动 640（分割内部才 256×256，大画布纯浪费）；
 *     移动端输出 24fps 上限 + 基线隔帧推理；渲染 rAF+定时器双驱动（后台不冻结）。
 */

export type VbgMode = 'off' | 'blur' | 'color' | 'image'
export type VbgGradient = 'dusk' | 'ocean' | 'mint'

export interface VbgOptions {
  mode: VbgMode
  /** blur 模式背景模糊半径（px，4~28） */
  blur: number
  /** color 模式背景色（任意 CSS 颜色） */
  color: string
  /** image 模式背景图（Image 元素；与 gradient 二选一） */
  image?: HTMLImageElement | null
  /** image 模式内置渐变预设（未上传自定义图时生效） */
  gradient?: VbgGradient
}

/** 渐变预设定义（色标与方向固定，运行时按画布尺寸重建） */
const GRADIENTS: Record<VbgGradient, Array<[number, string]>> = {
  dusk: [[0, '#312e5f'], [0.55, '#7b4b6e'], [1, '#e0956b']],
  ocean: [[0, '#0b3a53'], [0.55, '#12656e'], [1, '#5fb99f']],
  mint: [[0, '#0d4a3f'], [0.6, '#1d7a5f'], [1, '#a3d9b5']],
}

/** 分割异常判定：掩码人像覆盖率连续超阈 → 透传（人绝不能被吃掉） */
const DEGEN_MIN = 0.02
const DEGEN_MAX = 0.985
const DEGEN_FRAMES = 15
const RECOVER_FRAMES = 8

export class VirtualBackground {
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private person: HTMLCanvasElement | null = null
  private personCtx: CanvasRenderingContext2D | null = null
  private mask: HTMLCanvasElement | null = null
  private maskCtx: CanvasRenderingContext2D | null = null
  private bg: HTMLCanvasElement | null = null
  private bgCtx: CanvasRenderingContext2D | null = null
  /** 廉价模糊辅助画布（ctx.filter 不支持时的降采样层） */
  private small: HTMLCanvasElement | null = null
  private smallCtx: CanvasRenderingContext2D | null = null
  private out: MediaStream | null = null
  private procTrack: MediaStreamTrack | null = null
  private srcTrack: MediaStreamTrack | null = null
  private raf = 0
  /** rAF 后台停摆兜底（与补帧同因：后台 tab rAF 暂停 → 画布冻结 → 对端黑屏） */
  private timer: ReturnType<typeof setInterval> | null = null
  private lastDraw = 0
  private lastVideoTime = -1
  private fps = 30
  private w = 0
  private h = 0
  private frameNo = 0
  private inferSkip = 1
  private inferCostEma = 0
  /** ctx.filter 是否可用（iOS Safari 不支持 → 降采样模糊替代） */
  private filterOk = true

  private static isMobileUA(): boolean {
    try {
      return typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent)
    } catch {
      return false
    }
  }

  private segmenter: import('@mediapipe/tasks-vision').ImageSegmenter | null = null
  private loading: Promise<boolean> | null = null
  private opts: VbgOptions = { mode: 'blur', blur: 12, color: '#14532d', image: null, gradient: 'dusk' }
  /** 掩码极性：1 = 掩码高值是人像；-1 = 高值是背景（需反相）；0 = 校准中 */
  private personHigh = 0
  /** 极性校准累计（覆盖率之和 / 边界均值之和 / 帧数），双信号联合打分 */
  private calCovSum = 0
  private calBorderSum = 0
  private calN = 0
  /** 校准开始时间（帧数不够但超时 3s 也要定极性，默认按模型末类=人像） */
  private calStartedAt = 0
  /** 退化检测：连续异常帧计数 / 恢复帧计数；degraded=true 时透传原始画面 */
  private degenStreak = 0
  private recoverStreak = 0
  private degraded = false

  active(): boolean {
    return !!this.procTrack
  }

  processedTrack(): MediaStreamTrack | null {
    return this.procTrack
  }

  /** 模型是否已就绪（诊断面板/UI 状态展示用） */
  ready(): boolean {
    return !!this.segmenter
  }

  /** 当前是否处于退化透传态（UI 提示"分割异常已暂停效果"用） */
  isDegraded(): boolean {
    return this.degraded
  }

  /** 更新合成参数（不重建管线；模式切换 off 由调用方走 stop） */
  setOptions(opts: Partial<VbgOptions>) {
    this.opts = { ...this.opts, ...opts }
    if (this.opts.mode === 'image' && this.bgCtx) this.paintBackground(true)
  }

  /** 预加载分割模型（入房后台空闲预热；失败不算致命，开启时再试） */
  async preload(): Promise<boolean> {
    return this.ensureModel()
  }

  /**
   * 启动虚拟背景：源轨 → 加工轨。失败/不支持返回 null（调用方回退原轨）。
   * 重复调用安全：先停旧管线再起新的。
   */
  async start(src: MediaStreamTrack, opts: Partial<VbgOptions>): Promise<MediaStreamTrack | null> {
    try {
      if (typeof document === 'undefined' || src.kind !== 'video') return null
      await this.stop()
      const ok = await this.ensureModel()
      if (!ok) return null
      this.opts = { ...this.opts, ...opts, mode: opts.mode && opts.mode !== 'off' ? opts.mode : 'blur' }

      const settings = src.getSettings()
      const mobile = VirtualBackground.isMobileUA()
      // 降载（2026-10）：分割内部 256×256，处理画布 960/640 足够；移动端 24fps 上限
      const widthCap = mobile ? 640 : 960
      this.w = Math.min(settings.width || 960, widthCap)
      this.h = Math.round((this.w * (settings.height || 540)) / (settings.width || 960))
      this.fps = Math.min(Math.round(settings.frameRate || 30), mobile ? 24 : 30)

      const v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.autoplay = true
      v.srcObject = new MediaStream([src])
      await v.play().catch(() => {})

      const canvas = document.createElement('canvas')
      canvas.width = this.w
      canvas.height = this.h
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return null
      // ctx.filter 能力检测（iOS Safari 不支持 → 模糊走降采样路径）
      try {
        ctx.filter = 'blur(2px)'
        this.filterOk = ctx.filter.includes('blur')
        ctx.filter = 'none'
      } catch {
        this.filterOk = false
      }

      const person = document.createElement('canvas')
      person.width = this.w
      person.height = this.h
      const personCtx = person.getContext('2d')
      if (!personCtx) return null

      const mask = document.createElement('canvas')
      mask.width = 256
      mask.height = 256
      const maskCtx = mask.getContext('2d', { willReadFrequently: false })
      if (!maskCtx) return null

      const bg = document.createElement('canvas')
      bg.width = this.w
      bg.height = this.h
      const bgCtx = bg.getContext('2d', { alpha: false })
      if (!bgCtx) return null

      const small = document.createElement('canvas')
      small.width = Math.max(2, Math.round(this.w / 8))
      small.height = Math.max(2, Math.round(this.h / 8))
      const smallCtx = small.getContext('2d', { alpha: false })
      if (!smallCtx) return null

      this.video = v
      this.canvas = canvas
      this.ctx = ctx
      this.person = person
      this.personCtx = personCtx
      this.mask = mask
      this.maskCtx = maskCtx
      this.bg = bg
      this.bgCtx = bgCtx
      this.small = small
      this.smallCtx = smallCtx
      this.srcTrack = src
      this.resetCalibration()
      this.frameNo = 0
      this.inferSkip = mobile ? 2 : 1
      this.inferCostEma = 0
      this.paintBackground(true)

      const interval = 1000 / this.fps
      const draw = () => {
        const now = performance.now()
        if (now - this.lastDraw < interval - 4) return
        if (v.readyState < 2) return
        this.lastDraw = now
        this.render(v)
      }
      const rafLoop = () => {
        this.raf = requestAnimationFrame(rafLoop)
        draw()
      }
      this.raf = requestAnimationFrame(rafLoop)
      this.timer = setInterval(() => draw(), Math.max(30, Math.round(interval)))

      this.out = canvas.captureStream(this.fps)
      this.procTrack = this.out.getVideoTracks()[0] || null
      try {
        this.procTrack.contentHint = 'motion'
      } catch { /* noop */ }
      return this.procTrack
    } catch {
      await this.stop()
      return null
    }
  }

  /** 停止并释放全部资源；原轨由调用方持有，不受影响 */
  async stop(): Promise<void> {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try { this.procTrack?.stop() } catch { /* noop */ }
    try { this.out?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
    if (this.video) {
      try { this.video.pause() } catch { /* noop */ }
      this.video.srcObject = null
    }
    this.video = null
    this.canvas = null
    this.ctx = null
    this.person = null
    this.personCtx = null
    this.mask = null
    this.maskCtx = null
    this.bg = null
    this.bgCtx = null
    this.small = null
    this.smallCtx = null
    this.out = null
    this.procTrack = null
    this.srcTrack = null
    this.resetCalibration()
    this.frameNo = 0
    this.inferSkip = VirtualBackground.isMobileUA() ? 2 : 1
    this.inferCostEma = 0
  }

  /** 释放分割模型（离开房间时调用，释放 WASM 堆） */
  async dispose(): Promise<void> {
    await this.stop()
    try { await this.segmenter?.close() } catch { /* noop */ }
    this.segmenter = null
    this.loading = null
  }

  /** 惰性加载模型（单飞；GPU 失败自动 CPU 重试） */
  private async ensureModel(): Promise<boolean> {
    if (this.segmenter) return true
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision')
        const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const make = (delegate: 'GPU' | 'CPU') =>
          vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: '/models/selfie_segmenter.tflite', delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          })
        try {
          this.segmenter = await make('GPU')
        } catch {
          this.segmenter = await make('CPU')
        }
        return !!this.segmenter
      } catch {
        this.segmenter = null
        return false
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  private resetCalibration() {
    this.personHigh = 0
    this.calCovSum = 0
    this.calBorderSum = 0
    this.calN = 0
    this.calStartedAt = performance.now()
    this.degenStreak = 0
    this.recoverStreak = 0
    this.degraded = false
    this.lastVideoTime = -1
  }

  /** 单帧渲染：推理 → 掩码 → 背景层 + 人像软边合成（退化时透传原始画面） */
  private render(v: HTMLVideoElement) {
    const ctx = this.ctx
    if (!ctx || !this.segmenter || !this.personCtx || !this.maskCtx || !this.bgCtx) return
    this.frameNo++
    // 背景层：blur 模式隔帧重绘（模糊层内容变化极慢）；color/image 参数变化时重绘
    if (!this.degraded && this.opts.mode === 'blur' && this.frameNo % 2 === 0) this.paintBackground(false, v)

    // 推理：同一帧不重复推理；弱设备自适应隔帧。退化态下仍低频推理（8 帧一次）以探测恢复
    const shouldInfer = this.degraded ? this.frameNo % 8 === 0 : this.frameNo % this.inferSkip === 0
    if (v.currentTime !== this.lastVideoTime && shouldInfer) {
      this.lastVideoTime = v.currentTime
      const t0 = performance.now()
      try {
        this.segmenter.segmentForVideo(v, v.currentTime * 1000, (result) => {
          const masks = result.confidenceMasks
          if (!masks || masks.length === 0) return
          // selfie 模型多类输出时末类 = 人像（首类是背景置信度 —— 旧版取 [0] 即"人被虚化"的根源之一）
          const cm = masks[masks.length - 1]
          const data = cm.getAsFloat32Array()
          const mw = cm.width || 256
          const mh = cm.height || 256
          if (this.mask && (this.mask.width !== mw || this.mask.height !== mh)) {
            this.mask.width = mw
            this.mask.height = mh
          }
          this.calibrate(data, mw, mh)
          this.writeMask(data, mw, mh)
        })
        const cost = performance.now() - t0
        this.inferCostEma = this.inferCostEma === 0 ? cost : this.inferCostEma * 0.8 + cost * 0.2
        this.inferSkip = this.inferCostEma > 30 ? 3 : this.inferCostEma > 14 ? 2 : VirtualBackground.isMobileUA() ? 2 : 1
        // 极慢推理硬保护（CPU 兜底/低端机，EMA>400ms 不可实时）：并入退化透传，恢复后回归
        if (this.personHigh !== 0) this.trackDegradation(this.inferCostEma > 400 ? -1 : 0.5, 0.5)
      } catch {
        /* 单帧推理失败：复用上一帧掩码 */
      }
    }

    // 退化透传：分割持续异常 → 原始画面直出（宁可没效果，绝不把人虚化掉）
    if (this.degraded) {
      ctx.filter = 'none'
      try {
        ctx.drawImage(v, 0, 0, this.w, this.h)
      } catch { /* noop */ }
      return
    }

    // 人像层：原帧 + destination-in 软边掩码（无 ctx.filter 时硬边，可接受）。
    // 校准期（personHigh=0）掩码为空：直接整帧为人像层 = 原画面直出 ——
    // 绝不出现「掩码空白 → 人被吃掉只剩虚化背景」的空窗（旧版用户可见 bug）
    const pc = this.personCtx
    pc.globalCompositeOperation = 'source-over'
    pc.filter = 'none'
    try {
      pc.drawImage(v, 0, 0, this.w, this.h)
    } catch {
      return
    }
    if (this.mask && this.personHigh !== 0) {
      pc.globalCompositeOperation = 'destination-in'
      if (this.filterOk) pc.filter = 'blur(2px)'
      pc.drawImage(this.mask, 0, 0, this.w, this.h)
      pc.filter = 'none'
      pc.globalCompositeOperation = 'source-over'
    }

    // 合成：背景层 + 人像
    ctx.filter = 'none'
    ctx.drawImage(this.bg!, 0, 0)
    ctx.drawImage(this.person!, 0, 0)
  }

  /**
   * 掩码极性判定（重写）：双信号联合打分 ——
   *  ① 人像覆盖率：通话场景典型 15%~70%，两端（<3% / >97%）说明极性反了或分割异常；
   *  ② 边界先验：人像很少占满四边，边界均值高 → 高值更像背景。
   * 前 8 帧累计取均值后打分一次定极性（人凑近镜头占满边框的旧版误判场景由此修复）。
   */
  private calibrate(data: Float32Array, mw: number, mh: number) {
    // 单帧统计
    let covSum = 0
    let borderSum = 0
    let borderN = 0
    const total = mw * mh
    for (let i = 0; i < total; i++) covSum += data[i] > 0.5 ? 1 : 0
    const band = 6
    for (let y = 0; y < band; y++) for (let x = 0; x < mw; x++) { borderSum += data[y * mw + x]; borderN++ }
    for (let y = mh - band; y < mh; y++) for (let x = 0; x < mw; x++) { borderSum += data[y * mw + x]; borderN++ }
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < band; x++) { borderSum += data[y * mw + x]; borderN++ }
      for (let x = mw - band; x < mw; x++) { borderSum += data[y * mw + x]; borderN++ }
    }
    const cov = covSum / total
    const border = borderN > 0 ? borderSum / borderN : 0.5
    this.calCovSum += cov
    this.calBorderSum += border
    this.calN++
    if (this.personHigh !== 0) {
      this.trackDegradation(cov, border)
      return
    }
    // 判定时机：累计 8 帧，或超时 3s（慢设备推理几秒一帧时不能让校准无限拖延）
    if (this.calN < 8 && performance.now() - this.calStartedAt < 3000) return

    const mCov = this.calCovSum / this.calN
    const mBorder = this.calBorderSum / this.calN
    // 假设 A：高值=人像。得分 = 覆盖率偏离典型区间 + 边界先验惩罚（边界均值高不像人像）
    const scoreA = Math.abs(mCov - 0.35) + (1 - mBorder) * 0.6
    // 假设 B：高值=背景（反相）
    const scoreB = Math.abs(1 - mCov - 0.35) + mBorder * 0.6
    this.personHigh = scoreA <= scoreB ? 1 : -1
    this.degenStreak = 0
    this.recoverStreak = 0
  }

  /** 退化检测：极性确定后，按当帧覆盖率持续判定掩码是否可用 */
  private trackDegradation(cov: number, border: number) {
    void border
    // 换算成本极性下的人像覆盖率
    const personCov = this.personHigh === 1 ? cov : 1 - cov
    const bad = personCov < DEGEN_MIN || personCov > DEGEN_MAX
    if (this.degraded) {
      // 已透传：覆盖率回到正常区间连续 RECOVER_FRAMES 帧 → 恢复效果
      if (!bad) {
        this.recoverStreak++
        if (this.recoverStreak >= RECOVER_FRAMES) {
          this.degraded = false
          this.recoverStreak = 0
          this.degenStreak = 0
        }
      } else {
        this.recoverStreak = 0
      }
      return
    }
    if (bad) {
      this.degenStreak++
      if (this.degenStreak >= DEGEN_FRAMES) {
        this.degraded = true
        this.degenStreak = 0
      }
    } else {
      this.degenStreak = 0
    }
  }

  /** 把置信度数组写进掩码画布（RGBA，人像 alpha=255） */
  private writeMask(data: Float32Array, mw: number, mh: number) {
    const mc = this.maskCtx
    if (!mc || this.personHigh === 0) return
    const img = mc.createImageData(mw, mh)
    const px = img.data
    const invert = this.personHigh === -1
    for (let i = 0; i < mw * mh; i++) {
      const conf = data[i]
      const person = invert ? 1 - conf : conf
      const a = person > 0.55 ? 255 : person > 0.35 ? Math.round(person * 464) : 0
      px[i * 4] = 255
      px[i * 4 + 1] = 255
      px[i * 4 + 2] = 255
      px[i * 4 + 3] = a
    }
    mc.putImageData(img, 0, 0)
  }

  /** 重绘背景层：blur=滤镜（不支持时降采样-放大廉价模糊）+ 放大盖角；其余为纯色/渐变/图片 cover 适配 */
  private paintBackground(force = false, v?: HTMLVideoElement) {
    const bg = this.bgCtx
    if (!bg || !this.bg) return
    const { mode, blur, color, image, gradient } = this.opts
    const w = this.bg.width
    const h = this.bg.height
    if (mode === 'blur') {
      if (!v) return
      const s = 1.06
      if (this.filterOk) {
        bg.filter = `blur(${Math.max(2, blur)}px)`
        const dw = w * s
        const dh = h * s
        try {
          bg.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh)
        } catch { /* 单帧失败忽略 */ }
        bg.filter = 'none'
        return
      }
      // iOS Safari 等无 ctx.filter：降采样到 1/8 再放大 = 廉价模糊（近似半径随缩放比）
      const sc = this.smallCtx
      if (!sc || !this.small) return
      try {
        sc.drawImage(v, 0, 0, this.small.width, this.small.height)
        bg.imageSmoothingEnabled = true
        bg.imageSmoothingQuality = 'low'
        const dw = w * s
        const dh = h * s
        bg.drawImage(this.small, (w - dw) / 2, (h - dh) / 2, dw, dh)
      } catch { /* 单帧失败忽略 */ }
      return
    }
    if (mode === 'color') {
      bg.filter = 'none'
      bg.fillStyle = color
      bg.fillRect(0, 0, w, h)
      return
    }
    if (mode === 'image') {
      if (image && image.complete && image.naturalWidth > 0) {
        bg.filter = 'none'
        // cover 适配：等比缩放居中裁切（放大铺满，人物保持清晰前景）
        const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight)
        const dw = image.naturalWidth * scale
        const dh = image.naturalHeight * scale
        bg.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh)
        return
      }
      const stops = GRADIENTS[gradient || 'dusk']
      const g = bg.createLinearGradient(0, 0, w, h)
      for (const [pos, col] of stops) g.addColorStop(pos, col)
      bg.fillStyle = g
      bg.fillRect(0, 0, w, h)
      return
    }
    if (force) {
      bg.filter = 'none'
      bg.fillStyle = '#0b0f14'
      bg.fillRect(0, 0, w, h)
    }
  }
}
