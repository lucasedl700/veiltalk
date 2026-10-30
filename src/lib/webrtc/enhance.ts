/**
 * FrameEnhancer — AI 画面增强（自动曝光）实时处理管线
 *
 * 职责：把摄像头原始轨接进隐藏 <video> → 逐帧绘制到 canvas（ctx.filter 自适应
 * 亮度/对比度/饱和度）→ captureStream 产出加工轨交给发送管线。原始轨不动：
 * 本地预览/录制/设备切换仍用原轨，增强只是「发送侧滤镜」。
 *
 * 曝光策略（用户反馈「4K 拍出来模糊/曝光看不到程度」）：
 *  - 每 600ms 在 32×18 缩略图上采样平均亮度 luma；
 *  - 目标亮度 target（用户可调 0.45~0.75）→ brightness 系数 = target / luma，
 *    平滑收敛（防闪烁），钳制 [0.75, 1.9]（过暗提亮、过曝不硬压）；
 *  - 固定 +6% 对比度、+4% 饱和度补偿滤镜带来的灰感。
 *
 * 性能：处理分辨率钳制在 1920 宽（4K 档也以 1080p 级别处理发送 —— 低配设备的
 * 4K canvas 逐帧绘制是幻灯片制造机）；帧率跟随源轨设置（≤30 稳妥）。
 * 任何环节失败 start() 返回 null，调用方回退原始轨（绝不因增强断流）。
 */
export class FrameEnhancer {
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private sample: HTMLCanvasElement | null = null
  private out: MediaStream | null = null
  private procTrack: MediaStreamTrack | null = null
  private srcTrack: MediaStreamTrack | null = null
  private raf = 0
  private lumaTimer: ReturnType<typeof setInterval> | null = null
  private targetLuma = 0.58
  private brightness = 1
  private lastDraw = 0
  private fps = 30

  active(): boolean {
    return !!this.procTrack
  }

  processedTrack(): MediaStreamTrack | null {
    return this.procTrack
  }

  /** 当前生效的亮度系数（诊断面板可读） */
  currentBrightness(): number {
    return Math.round(this.brightness * 100) / 100
  }

  /**
   * 启动增强：源轨 → 加工轨。失败/不支持返回 null（调用方回退原轨）。
   * 重复调用安全：先停旧管线再起新的（设备切换/档位切换复用）。
   */
  async start(src: MediaStreamTrack, targetLuma: number): Promise<MediaStreamTrack | null> {
    try {
      if (typeof document === 'undefined' || src.kind !== 'video') return null
      await this.stop()
      const settings = src.getSettings()
      // 处理分辨率钳制：桌面 1920 / 移动 1280（Task 32：iPad 4K 档 canvas 逐帧绘制是
      // 幻灯片制造机）；帧率钳制 30（canvas 逐帧绘制成本）
      const isMobile = /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent)
      const wCap = isMobile ? 1280 : 1920
      const w = Math.min(settings.width || 1280, wCap)
      const h = Math.round(w * (settings.height || 720) / (settings.width || 1280))
      this.fps = Math.min(Math.round(settings.frameRate || 30), 30)
      this.targetLuma = targetLuma

      const v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.autoplay = true
      v.srcObject = new MediaStream([src])
      await v.play().catch(() => {})

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return null

      const sample = document.createElement('canvas')
      sample.width = 32
      sample.height = 18
      const sctx = sample.getContext('2d', { willReadFrequently: true })
      if (!sctx) return null

      this.video = v
      this.canvas = canvas
      this.sample = sample
      this.srcTrack = src

      const draw = (ts: number) => {
        this.raf = requestAnimationFrame(draw)
        if (ts - this.lastDraw < 1000 / this.fps - 4) return
        this.lastDraw = ts
        if (v.readyState < 2) return
        try {
          ctx.filter = `brightness(${this.brightness.toFixed(3)}) contrast(1.06) saturate(1.04)`
          ctx.drawImage(v, 0, 0, w, h)
        } catch {
          /* 单帧失败忽略 */
        }
      }
      this.raf = requestAnimationFrame(draw)

      // 亮度采样：600ms 一次，平滑收敛到目标亮度
      this.lumaTimer = setInterval(() => {
        try {
          if (v.readyState < 2) return
          sctx.drawImage(v, 0, 0, 32, 18)
          const d = sctx.getImageData(0, 0, 32, 18).data
          let sum = 0
          for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
          const luma = sum / (d.length / 4) / 255
          if (luma > 0.01) {
            const want = Math.min(1.9, Math.max(0.75, this.targetLuma / luma))
            // 平滑：每次向目标收敛 35%，避免画面闪烁
            this.brightness = this.brightness + (want - this.brightness) * 0.35
          }
        } catch {
          /* 采样失败保持现状 */
        }
      }, 600)

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
    if (this.lumaTimer) clearInterval(this.lumaTimer)
    this.lumaTimer = null
    try { this.procTrack?.stop() } catch { /* noop */ }
    try { this.out?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
    if (this.video) {
      try { this.video.pause() } catch { /* noop */ }
      this.video.srcObject = null
    }
    this.video = null
    this.canvas = null
    this.sample = null
    this.out = null
    this.procTrack = null
    this.srcTrack = null
    this.brightness = 1
  }
}
