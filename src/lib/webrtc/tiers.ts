/**
 * VeilTalk 画质档位（tiers）— 摄像头采集/编码档位的唯一事实源
 *
 * 职责：
 *  - 定义 360p → 4K 的全部档位（分辨率/帧率/基准码率/降级偏好）
 *  - getUserMedia 约束与 applyConstraints 热切换共用一套定义
 *  - 管理员全局默认档（信令 /svc/config 下发）与本机个人偏好的解析（个人偏好优先）
 *
 * 帧率说明：4k60 档 frameRate 以 60 为 ideal、120 为 max —— 浏览器/硬件能给多少给多少
 * （绝大多数摄像头上限 30~60fps，实际输出以 getSettings 回读为准，UI 诚实显示真实值）。
 */

export type QualityTier = '360p' | '720p' | '1080p' | '1080p60' | '1440p60' | '4k30' | '4k60' | '8k60' | '8k144'

export const QUALITY_TIERS: QualityTier[] = ['360p', '720p', '1080p', '1080p60', '1440p60', '4k30', '4k60', '8k60', '8k144']

export interface TierProfile {
  /** 采集宽度（ideal） */
  w: number
  /** 采集高度（ideal） */
  h: number
  /** 目标帧率（ideal；4k60 档另设 max=120 交给硬件上限决定） */
  fps: number
  /** 视频基准码率 kbps（弱网自适应梯队的顶格值） */
  kbps: number
  /** 高帧率档：弱网降级时优先保帧率（degradationPreference = maintain-framerate） */
  maintainFps: boolean
}

export const TIER_MAP: Record<QualityTier, TierProfile> = {
  '360p': { w: 640, h: 360, fps: 24, kbps: 700, maintainFps: false },
  '720p': { w: 1280, h: 720, fps: 30, kbps: 2500, maintainFps: false },
  '1080p': { w: 1920, h: 1080, fps: 30, kbps: 4000, maintainFps: false },
  '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 6000, maintainFps: true },
  '1440p60': { w: 2560, h: 1440, fps: 60, kbps: 9000, maintainFps: true },
  '4k30': { w: 3840, h: 2160, fps: 30, kbps: 12000, maintainFps: false },
  '4k60': { w: 3840, h: 2160, fps: 60, kbps: 18000, maintainFps: true },
  '8k60': { w: 7680, h: 4320, fps: 60, kbps: 40000, maintainFps: true },
  '8k144': { w: 7680, h: 4320, fps: 144, kbps: 100000, maintainFps: true },
}

export function isQualityTier(v: unknown): v is QualityTier {
  return typeof v === 'string' && (QUALITY_TIERS as string[]).includes(v)
}

/** getUserMedia / applyConstraints 共用的采集约束（max 帧率交给硬件封顶）
 *  Task 32 移动端钳制：iPad/手机把 4K/1440p 档的采集压到 1080p30 —— 移动端硬编
 *  WebRTC 实时 4K 本就不稳（掉帧/发热/整机卡），高帧率档在移动端同样钳 30fps；
 *  UI 档位选择保持不变，实际输出以 getSettings 回读为准（诚实显示）。 */
export function constraintsFor(tier: QualityTier, mobile = false): MediaTrackConstraints {
  const p = TIER_MAP[tier]
  if (mobile) {
    const w = Math.min(p.w, 1920)
    const h = Math.min(p.h, 1080)
    const fps = Math.min(p.fps, 30)
    return {
      width: { ideal: w },
      height: { ideal: h },
      frameRate: { ideal: fps, max: fps },
    }
  }
  return {
    width: { ideal: p.w },
    height: { ideal: p.h },
    frameRate: { ideal: p.fps, max: p.fps >= 120 ? 144 : p.fps >= 60 ? 120 : p.fps },
  }
}

/** 移动端（含 iPad）UA 检测：采集钳制与 AI 管线降载共用 */
export function isMobileUA(): boolean {
  try {
    return typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent)
  } catch {
    return false
  }
}

/**
 * 【Task 36】移动端采集钳制是否生效：用户可在设备面板显式解除（localStorage veil-mobile-clamp-off=1）。
 * 默认仍钳制（移动端 4K 采集+编码熔毁是「好卡」主因）；解除后按所选档位诚实采集，卡顿自负。
 */
export function mobileClampActive(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('veil-mobile-clamp-off') === '1') return false
  } catch {
    /* noop */
  }
  return isMobileUA()
}

/** 弱网自适应码率梯队：顶格 = 档位基准码率，逐级降到 180kbps 保底 */
export function ladderFor(tier: QualityTier): number[] {
  const base = TIER_MAP[tier].kbps
  return [base, Math.round(base * 0.62), Math.round(base * 0.38), Math.round(base * 0.2), 350, 180]
}

const LOCAL_PREF_KEY = 'veil-quality'

function readLocalPref(): QualityTier | null {
  try {
    const v = localStorage.getItem(LOCAL_PREF_KEY)
    return isQualityTier(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 解析当前生效档位：本机个人偏好（用户显式选择过）> 管理员全局默认（信令下发）> 720p 兜底。
 * localStorage 里旧的非法值（360p/720p/1080p 之外）视为未选择，交给管理员默认。
 */
export function resolveTier(serverDefault?: string | null): { tier: QualityTier; source: 'user' | 'admin' | 'default' } {
  const local = readLocalPref()
  if (local) return { tier: local, source: 'user' }
  if (isQualityTier(serverDefault)) return { tier: serverDefault, source: 'admin' }
  return { tier: '720p', source: 'default' }
}

export function saveLocalTierPref(tier: QualityTier) {
  try {
    localStorage.setItem(LOCAL_PREF_KEY, tier)
  } catch {
    /* noop */
  }
}
