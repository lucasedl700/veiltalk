/**
 * VeilTalk CallRecorder — 本地混合录制（内容不出设备，服务器不可见）
 *
 * 设计：
 *  - 视频：把本地画面（屏幕共享优先）与全部远端画面绘制到一张 Canvas 网格，
 *    以 canvas.captureStream(24) 作为录制视频源；无视频轨的会话绘制
 *    「名字首字 + 主题色」占位卡，保证 headless / 仅数据模式下仍可录制。
 *  - 音频：AudioContext 把本地麦克风与全部远端音轨混音到 MediaStreamDestination。
 *  - 合成：video track + mixed audio track → MediaRecorder（webm/opus）。
 *    MIME 按支持度降级探测（vp9 → vp8 → 默认）。
 *  - 隐私：录制产物仅存在本地内存，stop 后由调用方触发浏览器下载；
 *    录制期间不产生任何网络上传。
 */

export interface RecorderSources {
  local: MediaStream | null
  /** 屏幕共享流（优先作为本地大画面） */
  screen: MediaStream | null
  /** 远端流列表（key 用于占位名显示） */
  remotes: Array<{ name: string; stream: MediaStream | null }>
  /** 房间号（仅用于文件名与占位水印） */
  roomId: string
  myName: string
}

export interface RecorderTick {
  ms: number
  bytes: number
}

function pickMime(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ]
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

interface Tile {
  name: string
  stream: MediaStream | null
  video: HTMLVideoElement | null
  local: boolean
}

export class CallRecorder {
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private audioCtx: AudioContext | null = null
  private tiles: Tile[] = []
  private startedTs = 0
  private tickIv: ReturnType<typeof setInterval> | null = null
  private onTick: (t: RecorderTick) => void
  private onLog: (level: 'info' | 'warn' | 'error' | 'crypto', msg: string, detail?: string) => void
  private lastDraw = 0

  constructor(opts: { onTick: (t: RecorderTick) => void; onLog: (l: 'info' | 'warn' | 'error' | 'crypto', m: string, d?: string) => void }) {
    this.onTick = opts.onTick
    this.onLog = opts.onLog
  }

  get active(): boolean {
    return !!this.rec && this.rec.state !== 'inactive'
  }

  start(src: RecorderSources): boolean {
    if (this.active) return false
    if (typeof MediaRecorder === 'undefined') {
      this.onLog('error', '当前浏览器不支持 MediaRecorder，无法录制')
      return false
    }

    // ---- 收集画面 tile：屏幕共享优先作为本地图 ----
    const localShown = src.screen || src.local
    this.tiles = []
    if (localShown || src.local === null) {
      this.tiles.push({ name: src.myName || '我', stream: localShown, video: null, local: true })
    }
    for (const r of src.remotes) {
      this.tiles.push({ name: r.name || '访客', stream: r.stream, video: null, local: false })
    }

    // ---- Canvas 视频合成 ----
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1280
    this.canvas.height = 720
    this.ctx = this.canvas.getContext('2d')
    for (const t of this.tiles) {
      if (t.stream && t.stream.getVideoTracks().length > 0) {
        const v = document.createElement('video')
        v.srcObject = new MediaStream(t.stream.getVideoTracks())
        v.muted = true
        v.playsInline = true
        void v.play().catch(() => {})
        t.video = v
      }
    }
    const canvasStream = this.canvas.captureStream(24)

    // ---- 音频混音 ----
    // 注意：MediaStreamAudioDestinationNode 即使没有接入任何源也会返回 1 条音频轨，
    // 而「空音频轨 + 视频轨」组合会让 MediaRecorder 的封装器永远等不到音频帧，
    // 整个录制零输出（headless / 无麦克风权限场景实测复现）。因此只在成功接入
    // 至少一路源后才把混音轨加入录制流。
    let audioTracks: MediaStreamTrack[] = []
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioCtx = new AC()
      void this.audioCtx.resume().catch(() => {})
      const dest = this.audioCtx.createMediaStreamDestination()
      let wired = 0
      const allStreams: Array<MediaStream | null> = [src.screen, src.local, ...src.remotes.map((r) => r.stream)]
      for (const st of allStreams) {
        if (!st) continue
        for (const track of st.getAudioTracks()) {
          try {
            const node = this.audioCtx.createMediaStreamSource(new MediaStream([track]))
            node.connect(dest)
            wired++
          } catch {
            /* 单轨失败不影响整体 */
          }
        }
      }
      if (wired > 0) {
        audioTracks = dest.stream.getAudioTracks()
        this.onLog('info', `录制混音就绪：${wired} 路音频已混合`)
      } else {
        this.onLog('info', '没有可用音轨，录制为无声视频')
        try {
          void this.audioCtx.close()
        } catch {
          /* noop */
        }
        this.audioCtx = null
      }
    } catch (e) {
      this.onLog('warn', '音频混音不可用，录制将不含声音', String(e))
    }

    const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks])
    const mime = pickMime()
    try {
      this.rec = mime ? new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 2_500_000 }) : new MediaRecorder(mixed)
    } catch (e) {
      this.onLog('error', 'MediaRecorder 创建失败', String(e))
      this.cleanup()
      return false
    }
    this.chunks = []
    this.rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data)
    }
    this.rec.start(1000)
    this.startedTs = Date.now()

    this.raf = requestAnimationFrame(this.drawLoop)
    this.tickIv = setInterval(() => {
      const bytes = this.chunks.reduce((a, b) => a + b.size, 0)
      this.onTick({ ms: Date.now() - this.startedTs, bytes })
    }, 1000)

    this.onLog('crypto', '开始本地录制（内容不出设备）', `${mime || '默认编码'} · ${this.tiles.length} 画面`)
    return true
  }

  private drawLoop = (ts: number) => {
    if (!this.ctx || !this.canvas) return
    // 限帧 ~24fps
    if (ts - this.lastDraw < 40) {
      this.raf = requestAnimationFrame(this.drawLoop)
      return
    }
    this.lastDraw = ts

    const { width: W, height: H } = this.canvas
    const ctx = this.ctx
    // 背景：深色渐变
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#0b1512')
    grad.addColorStop(1, '#101d1a')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    const n = Math.max(1, this.tiles.length)
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
    const rows = Math.ceil(n / cols)
    const gap = 8
    const cw = (W - gap * (cols + 1)) / cols
    const ch = (H - gap * (rows + 1)) / rows

    this.tiles.forEach((t, i) => {
      const cx = gap + (i % cols) * (cw + gap)
      const cy = gap + Math.floor(i / cols) * (ch + gap)
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(cx, cy, cw, ch, 12)
      ctx.clip()

      const hasVideo = t.video && t.video.readyState >= 2 && t.video.videoWidth > 0
      if (hasVideo) {
        const v = t.video as HTMLVideoElement
        const vr = v.videoWidth / v.videoHeight
        const cr = cw / ch
        let dw = cw
        let dh = ch
        if (vr > cr) {
          dh = cw / vr
        } else {
          dw = ch * vr
        }
        const dx = cx + (cw - dw) / 2
        const dy = cy + (ch - dh) / 2
        if (t.local) {
          // 本地画面镜像（与 video-tile 预览一致）
          ctx.translate(cx + cw, 0)
          ctx.scale(-1, 1)
          ctx.drawImage(v, cx + cw - dx - dw, dy, dw, dh)
        } else {
          ctx.drawImage(v, dx, dy, dw, dh)
        }
      } else {
        // 占位卡：主题色渐变 + 名字首字
        const pg = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch)
        pg.addColorStop(0, t.local ? '#0d9488' : '#155e52')
        pg.addColorStop(1, '#134e4a')
        ctx.fillStyle = pg
        ctx.fillRect(cx, cy, cw, ch)
        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        ctx.font = `bold ${Math.min(cw, ch) * 0.28}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText((t.name || '?').slice(0, 1).toUpperCase(), cx + cw / 2, cy + ch / 2)
      }
      ctx.restore()

      // 名字角标
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(cx + 8, cy + 8, Math.min(cw - 16, 24 + t.name.length * 12), 22, 6)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${t.local ? '★ ' : ''}${t.name}`, cx + 16, cy + 19)
      ctx.restore()
    })

    // 顶部水印 + REC 标记
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = 'bold 13px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`VeilTalk E2EE · REC ${this.fmt(Date.now() - this.startedTs)}`, W - 12, 10)
    ctx.restore()

    this.raf = requestAnimationFrame(this.drawLoop)
  }

  private fmt(ms: number): string {
    const s = Math.floor(ms / 1000)
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  /** 停止并返回录制产物（webm Blob）；无有效数据时返回 null */
  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') {
        this.cleanup()
        resolve(null)
        return
      }
      this.rec.onstop = () => {
        const bytes = this.chunks.reduce((a, b) => a + b.size, 0)
        const blob = bytes > 0 ? new Blob(this.chunks, { type: this.rec?.mimeType || 'video/webm' }) : null
        this.cleanup()
        resolve(blob)
      }
      try {
        this.rec.stop()
      } catch {
        this.cleanup()
        resolve(null)
      }
    })
  }

  private cleanup() {
    cancelAnimationFrame(this.raf)
    if (this.tickIv) clearInterval(this.tickIv)
    this.tickIv = null
    this.tiles.forEach((t) => {
      if (t.video) {
        try {
          t.video.pause()
          t.video.srcObject = null
        } catch {
          /* noop */
        }
      }
    })
    this.tiles = []
    try {
      this.audioCtx?.close()
    } catch {
      /* noop */
    }
    this.audioCtx = null
    this.canvas = null
    this.ctx = null
    this.rec = null
  }
}
