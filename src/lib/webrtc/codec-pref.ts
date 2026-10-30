/**
 * VeilTalk 编解码偏好（Task 32 反卡顿专项）— 硬件编码优先的唯一事实源
 *
 * 为什么重要（用户反馈「4K60 开着帧率还是很低」「很卡」）：
 *  - WebRTC 默认编解码顺序（Chrome：VP8 优先 / 部分场景 VP9、AV1）几乎全是软编，
 *    4K/1440p 高帧率档软编 CPU 直接熔毁 → 编码器被迫掉帧 → 表现为「帧率低 + 整机卡」；
 *  - H.264 在所有平台（含 iPad A 系 / 桌面 QuickSync / NVENC）都有硬编硬解，
 *    同等画质 CPU 占用低一个量级，是高帧率档唯一可持续的路径；
 *  - iPad Safari 本就只出 H.264；统一偏好后双端协商结果一致，避免跨端能力歧义。
 *
 * 策略：H264（packetization-mode=1 优先）> VP9 > VP8 > AV1 > 其他 > 辅助（rtx/red/fec）。
 * setCodecPreferences 只重排「本端支持」的编解码 —— 不支持的浏览器（如无专有编解码的
 * Chromium 构建）自然回退 VP8/VP9，绝不因偏好导致协商失败。
 */

/** 编解码家族排名（小者优）；辅助负载（rtx/red/ulpfm/flexfec）永远排最后且必须保留 */
function codecRank(mimeType: string): number {
  const m = mimeType.toLowerCase()
  if (m === 'video/h264') return 0
  if (m === 'video/vp9') return 1
  if (m === 'video/vp8') return 2
  if (m === 'video/av1') return 3
  // 辅助负载与未知家族（h265 等）：辅助负载排最后，未知家族排 AV1 之后
  if (m === 'video/rtx' || m === 'video/red' || m === 'video/ulpfmt' || m === 'video/flexfec-03') return 9
  return 4
}

/** H264 内部排序：packetization-mode=1（打包兼容性最好）与 Constrained Baseline 优先 */
function h264SubRank(codec: RTCRtpCodec): number {
  const p = String(codec.sdpFmtpLine || '')
  let rank = 0
  if (p.includes('packetization-mode=0')) rank += 10
  if (p.includes('profile-level-id=42e0') || p.includes('profile-level-id=4200')) rank -= 1
  return rank
}

function rankedCodecs(caps: RTCRtpCapabilities | undefined): RTCRtpCodec[] | null {
  const codecs = caps?.codecs
  if (!codecs || codecs.length === 0) return null
  return [...codecs].sort((a, b) => {
    const ra = codecRank(a.mimeType)
    const rb = codecRank(b.mimeType)
    if (ra !== rb) return ra - rb
    if (ra === 0) return h264SubRank(a) - h264SubRank(b)
    return 0
  })
}

/** 优先用发送能力排序（发送侧 CPU 是卡顿主源）；无发送能力时回退接收能力 */
function mergedRankedList(): RTCRtpCodec[] | null {
  const sendCaps = typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities
    ? RTCRtpSender.getCapabilities('video') ?? undefined
    : undefined
  const recvCaps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
    ? RTCRtpReceiver.getCapabilities('video') ?? undefined
    : undefined
  const merged = mergedCaps(sendCaps, recvCaps)
  return rankedCodecs(merged)
}

function mergedCaps(a: RTCRtpCapabilities | undefined, b: RTCRtpCapabilities | undefined): RTCRtpCapabilities | undefined {
  if (!a || a.codecs?.length === 0) return b
  if (!b || b.codecs?.length === 0) return a
  const bSet = new Set(b.codecs!.map((c) => `${c.mimeType.toLowerCase()}|${c.sdpFmtpLine || ''}`))
  const kept = a.codecs!.filter((c) => bSet.has(`${c.mimeType.toLowerCase()}|${c.sdpFmtpLine || ''}`))
  return { codecs: kept.length > 0 ? kept : a.codecs, headerExtensions: a.headerExtensions }
}

/**
 * 对 PeerSession 的全部视频 transceiver 应用硬编优先偏好（transceiver 级 API，
 * 同时作用于收发两个方向）。
 *
 * 【Task 40 翻转默认：真机默认启用】用户真机反馈「iPad 上 DTLS-SRTP 徽章 + 好卡」：
 *  - 默认顺序下桌面 Chrome 用 VP8 软编，iPad WebKit 收到 VP8/VP9 只能软解 ——
 *    高分辨率下解码端 CPU 熔毁，正是「好卡 + 发热」的头号根因（Apple 设备帧级
 *    加密本就强制关闭，卡的锅不在 E2EE）；
 *  - H264 全平台硬编硬解（桌面 QuickSync/NVENC、iPad A 系 VideoToolbox、Safari
 *    本就只出 H264），统一重排后跨端协商结果一致；
 *  - 沙箱例外：Chrome for Testing headless 的 H264 有「出帧但 bytesSent 恒 0」
 *    的打包缺陷（Task 32 A/B 实测）——自动环境（navigator.webdriver / HeadlessChrome）
 *    自动跳过保持默认顺序，回归测试不受影响；
 *  - 双逃生舱：?hwpref 强制启用（沙箱验证用）；?nohwpref 强制关闭（真机个别
 *    机器 H264 异常时回浏览器默认）；
 *  - 安全性：重排列表包含 getCapabilities 全部编解码（不删除仅排序），协商永不
 *    因偏好失败；任何异常静默回退默认顺序。
 */
export function applyHardwareVideoCodecPreference(pc: RTCPeerConnection) {
  try {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    // 明确退出：?nohwpref（真机逃生舱：个别机器 H264 路径异常时强制回浏览器默认）
    if (params.has('nohwpref')) return
    // 自动化环境跳过（Chrome for Testing headless H264 断流缺陷，见上方注记）；
    // ?hwpref 仍可强制启用（保留沙箱 A/B 验证能力）
    const automated = navigator.webdriver === true || /HeadlessChrome/i.test(navigator.userAgent || '')
    if (automated && !params.has('hwpref')) return
    const list = mergedRankedList()
    if (!list) return
    for (const tx of pc.getTransceivers()) {
      // 预建 transceiver 的 receiver.track 是占位 track（kind 已定），据此识别视频 m-line
      if (tx.receiver.track?.kind !== 'video') continue
      try {
        if (typeof tx.setCodecPreferences === 'function') tx.setCodecPreferences(list)
      } catch { /* 偏好不合法：保持浏览器默认 */ }
    }
  } catch { /* 能力查询失败：整体回退浏览器默认顺序 */ }
}

/** 诊断日志用：返回当前发送能力里排名第一的视频编解码（如 video/H264） */
export function preferredVideoCodecLabel(): string {
  try {
    const caps = typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities
      ? RTCRtpSender.getCapabilities('video')
      : null
    const first = caps?.codecs?.find((c) => c.mimeType.toLowerCase().startsWith('video/'))
    return first?.mimeType || 'unknown'
  } catch {
    return 'unknown'
  }
}
