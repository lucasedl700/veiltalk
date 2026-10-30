/**
 * VeilTalk 服务器目录与测速 — ICE（STUN/TURN）服务器选择 + 延迟/上传测速
 *
 * 职责：
 *  - 维护按地区整理的公共 STUN/TURN 目录（用户按自己所在地区挑选）
 *  - 延迟测量：临时 RTCPeerConnection 触发候选收集，首个 srflx（STUN）/ relay（TURN）
 *    候选出现耗时即为该服务器的连接延迟
 *  - 上传测速：对 TURN 服务器强制中继（iceTransportPolicy='relay'）建立本机回环
 *    DataChannel，3×32KB 往返测量上行延迟与吞吐；STUN 仅做地址发现，不适用（显示 —）
 *  - 信令服务延迟：/svc/health 三次取平均
 *  - 选择持久化（localStorage veil-server-pick / veil-server-custom），入房时由
 *    room-client 应用到所有 PeerSession（自动档 = 沿用 /api/ice-config 下发配置）
 *
 * 目录事实核对（2026-10）：
 *  - Cloudflare / Google / Twilio STUN 为全球任播（Anycast），亚太可达性好
 *  - 小米 / 腾讯 STUN 面向中国大陆网络
 *  - Nextcloud / 1&1 STUN 位于欧洲（德国）
 *  - OpenRelay（metered.ca）免费公共 TURN：静态凭据 openrelayproject，约 20GB/月额度；
 *    区域中继（美/欧/亚）为付费功能，免费档仅全球任播入口 —— 如需更近的中继请用「自定义」
 */

export type ServerKind = 'stun' | 'turn'

export interface ServerEntry {
  /** 稳定 id（持久化用） */
  id: string
  /** zh 展示名 */
  label: string
  /** en 展示名 */
  labelEn: string
  /** zh 地区标注 */
  region: string
  /** en 地区标注 */
  regionEn: string
  kind: ServerKind
  ice: RTCIceServer
}

export const AUTO_SERVER_ID = 'auto'
export const CUSTOM_SERVER_ID = 'custom'

const OPENRELAY_USER = 'openrelayproject'
const OPENRELAY_PASS = 'openrelayproject'

export const SERVER_CATALOG: ServerEntry[] = [
  {
    id: 'cf-global',
    label: 'Cloudflare STUN',
    labelEn: 'Cloudflare STUN',
    region: '全球任播（含亚太）',
    regionEn: 'Global anycast (APAC friendly)',
    kind: 'stun',
    ice: { urls: 'stun:stun.cloudflare.com:3478' },
  },
  {
    id: 'google-global',
    label: 'Google STUN',
    labelEn: 'Google STUN',
    region: '全球任播',
    regionEn: 'Global anycast',
    kind: 'stun',
    ice: { urls: 'stun:stun.l.google.com:19302' },
  },
  {
    id: 'twilio-global',
    label: 'Twilio STUN',
    labelEn: 'Twilio STUN',
    region: '全球任播',
    regionEn: 'Global anycast',
    kind: 'stun',
    ice: { urls: 'stun:global.stun.twilio.com:3478' },
  },
  {
    id: 'mi-cn',
    label: '小米 STUN',
    labelEn: 'Xiaomi STUN',
    region: '中国大陆',
    regionEn: 'Mainland China',
    kind: 'stun',
    ice: { urls: 'stun:stun.miwifi.com:3478' },
  },
  {
    id: 'qq-cn',
    label: '腾讯 STUN',
    labelEn: 'Tencent STUN',
    region: '中国大陆',
    regionEn: 'Mainland China',
    kind: 'stun',
    ice: { urls: 'stun:stun.qq.com:3478' },
  },
  {
    id: 'nextcloud-eu',
    label: 'Nextcloud STUN',
    labelEn: 'Nextcloud STUN',
    region: '欧洲（德国）',
    regionEn: 'Europe (Germany)',
    kind: 'stun',
    ice: { urls: 'stun:stun.nextcloud.com:443' },
  },
  {
    id: 'und1-eu',
    label: '1&1 STUN',
    labelEn: '1&1 STUN',
    region: '欧洲（德国）',
    regionEn: 'Europe (Germany)',
    kind: 'stun',
    ice: { urls: 'stun:stun.1und1.de:3478' },
  },
  {
    id: 'openrelay-udp',
    label: 'OpenRelay TURN（UDP）',
    labelEn: 'OpenRelay TURN (UDP)',
    region: '全球 · 免费 20GB/月',
    regionEn: 'Global · free 20GB/mo',
    kind: 'turn',
    ice: { urls: 'turn:openrelay.metered.ca:80', username: OPENRELAY_USER, credential: OPENRELAY_PASS },
  },
  {
    id: 'openrelay-tcp',
    label: 'OpenRelay TURN（TCP 443）',
    labelEn: 'OpenRelay TURN (TCP 443)',
    region: '全球 · 防火墙友好',
    regionEn: 'Global · firewall friendly',
    kind: 'turn',
    ice: { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: OPENRELAY_USER, credential: OPENRELAY_PASS },
  },
]

/* ------------------------------ 选择持久化 ------------------------------ */

const PICK_KEY = 'veil-server-pick'
const CUSTOM_KEY = 'veil-server-custom'

export interface CustomServer {
  urls: string
  username?: string
  credential?: string
}

export function readServerPick(): string {
  try {
    return localStorage.getItem(PICK_KEY) || AUTO_SERVER_ID
  } catch {
    return AUTO_SERVER_ID
  }
}

export function saveServerPick(id: string) {
  try {
    localStorage.setItem(PICK_KEY, id)
  } catch {
    /* noop */
  }
}

export function readCustomServer(): CustomServer | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CustomServer
    if (!parsed.urls) return null
    return parsed
  } catch {
    return null
  }
}

export function saveCustomServer(c: CustomServer) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(c))
  } catch {
    /* noop */
  }
}

/**
 * 应用用户选择：返回入房实际使用的 iceServers。
 *  - 自动（默认）→ null（沿用 /api/ice-config 下发配置，行为与旧版一致）
 *  - 目录项 → 该服务器 + 环境下发 TURN 兜底（自建中继仍可用）
 *  - 自定义 → 解析用户输入（stun:/turn: URL，可带凭据）
 */
export function applyServerPick(envIceServers: RTCIceServer[]): RTCIceServer[] | null {
  const pick = readServerPick()
  if (pick === AUTO_SERVER_ID) return null
  const envTurns = envIceServers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
    return urls.some((u) => String(u).startsWith('turn'))
  })
  if (pick === CUSTOM_SERVER_ID) {
    const c = readCustomServer()
    if (!c) return null
    const urls = c.urls.split(/[,\s]+/).map((u) => u.trim()).filter(Boolean)
    if (urls.length === 0) return null
    const entry: RTCIceServer = { urls }
    if (c.username) entry.username = c.username
    if (c.credential) entry.credential = c.credential
    const hasTurn = urls.some((u) => u.startsWith('turn'))
    return hasTurn ? [entry, ...envTurns] : [...(envTurns.length ? envTurns : []), entry]
  }
  const found = SERVER_CATALOG.find((s) => s.id === pick)
  if (!found) return null
  return found.kind === 'turn' ? [found.ice, ...envTurns.filter((t) => JSON.stringify(t) !== JSON.stringify(found.ice))] : [...found.ice ? [found.ice] : [], ...envTurns]
}

/** 当前选择条目的展示信息（诊断面板/管理面板共用；auto 返回 null） */
export function currentPickSummary(lang: 'zh' | 'en'): { id: string; label: string; region: string; kind: ServerKind } | null {
  const pick = readServerPick()
  if (pick === AUTO_SERVER_ID) return null
  if (pick === CUSTOM_SERVER_ID) {
    const c = readCustomServer()
    return {
      id: pick,
      label: c ? c.urls.split(/[,\s]+/)[0] : 'custom',
      region: lang === 'zh' ? '自定义' : 'Custom',
      kind: (c?.urls.startsWith('turn') ? 'turn' : 'stun') as ServerKind,
    }
  }
  const found = SERVER_CATALOG.find((s) => s.id === pick)
  if (!found) return null
  return {
    id: found.id,
    label: lang === 'zh' ? found.label : found.labelEn,
    region: lang === 'zh' ? found.region : found.regionEn,
    kind: found.kind,
  }
}

/* ------------------------------ 延迟与测速 ------------------------------ */

export interface ProbeResult {
  latencyMs: number | null
  /** TURN 专属：中继回环 DataChannel 上行往返与吞吐；STUN 不适用 */
  upload?: { rttMs: number; kbps: number } | null
}

/**
 * ICE 服务器延迟：临时 PC 候选收集，首个 srflx/relay 候选出现耗时。
 * 与 room-client 的可达性探测同思路，但按单服务器计时（可排序比较）。
 */
export function probeIceServerLatency(ice: RTCIceServer, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === 'undefined') return resolve(null)
    let done = false
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: [ice] })
    } catch {
      return resolve(null)
    }
    const started = performance.now()
    const finish = (v: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        pc.close()
      } catch {
        /* noop */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    pc.onicecandidate = (e) => {
      const c = e.candidate
      if (!c) return finish(null) // 收集完成仍未出现非 host 候选
      if (c.type === 'srflx' || c.type === 'relay') finish(Math.round(performance.now() - started))
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish(null)
    }
    pc.createDataChannel('latency-probe')
    void pc
      .createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish(null))
  })
}

/**
 * TURN 上传测速：两个本机 PC 均只配该 TURN 且强制中继（iceTransportPolicy='relay'），
 * 经 DataChannel 发 3×32KB 并回显，测往返延迟与吞吐。全程流量经 TURN 中继
 * （浏览器 → TURN → 浏览器），反映真实中继上行质量。
 */
export async function measureTurnUpload(ice: RTCIceServer, timeoutMs = 10000): Promise<{ rttMs: number; kbps: number } | null> {
  if (typeof RTCPeerConnection === 'undefined') return null
  let pc1: RTCPeerConnection | null = null
  let pc2: RTCPeerConnection | null = null
  try {
    const conf: RTCConfiguration = { iceServers: [ice], iceTransportPolicy: 'relay' }
    pc1 = new RTCPeerConnection(conf)
    pc2 = new RTCPeerConnection(conf)
    pc1.onicecandidate = (e) => e.candidate && void pc2!.addIceCandidate(e.candidate).catch(() => {})
    pc2.onicecandidate = (e) => e.candidate && void pc1!.addIceCandidate(e.candidate).catch(() => {})
    const dc = pc1.createDataChannel('upload-probe')
    const opened = new Promise<void>((r) => {
      dc.onopen = () => r()
    })
    pc2.ondatachannel = (e) => {
      e.channel.onmessage = (ev) => {
        // 回显：原样发回
        e.channel.send(ev.data)
      }
    }
    const offer = await pc1.createOffer()
    await pc1.setLocalDescription(offer)
    await pc2.setRemoteDescription(offer)
    const answer = await pc2.createAnswer()
    await pc2.setLocalDescription(answer)
    await pc1.setRemoteDescription(answer)
    // 等中继链路 + DC 就绪
    await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('dc timeout')), timeoutMs))])
    const payload = new Uint8Array(32 * 1024)
    const rtts: number[] = []
    const started = performance.now()
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      await new Promise<void>((r, rej) => {
        const to = setTimeout(() => rej(new Error('echo timeout')), 4000)
        const orig = dc.onmessage
        dc.onmessage = () => {
          clearTimeout(to)
          dc.onmessage = orig
          r()
        }
        dc.send(payload.buffer as ArrayBuffer)
      })
      rtts.push(performance.now() - t0)
    }
    const rttMs = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)
    const totalBytes = payload.byteLength * 3 * 2 // 去 + 回
    const kbps = Math.round((totalBytes / 1024) / ((performance.now() - started) / 1000))
    return { rttMs, kbps }
  } catch {
    return null
  } finally {
    try {
      pc1?.close()
    } catch {
      /* noop */
    }
    try {
      pc2?.close()
    } catch {
      /* noop */
    }
  }
}

/** 信令服务延迟：/svc/health 三次取平均（ms；失败 null） */
export async function probeSignalingLatency(): Promise<number | null> {
  const samples: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    try {
      const res = await fetch(`/svc/health?XTransformPort=3004&t=${Date.now()}-${i}`, { cache: 'no-store' })
      if (!res.ok) break
      samples.push(performance.now() - t0)
    } catch {
      break
    }
  }
  if (samples.length === 0) return null
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
}

/** 完整测速：延迟必测；TURN 追加中继上行（并发跑目录，concurrency 限制防 PC 泛滥） */
export async function probeAll(
  onEntry: (id: string, r: ProbeResult | null) => void,
  opts?: { upload?: boolean; signal?: 'en' | 'zh' },
): Promise<void> {
  const entries = [
    ...SERVER_CATALOG.map((e) => ({ id: e.id, ice: e.ice, kind: e.kind })),
    ...(readServerPick() === CUSTOM_SERVER_ID && readCustomServer()
      ? [{ id: CUSTOM_SERVER_ID, ice: customToIce(readCustomServer()!), kind: (readCustomServer()!.urls.startsWith('turn') ? 'turn' : 'stun') as ServerKind }]
      : []),
  ]
  const CONC = 3
  let idx = 0
  const worker = async () => {
    while (idx < entries.length) {
      const e = entries[idx++]
      const latencyMs = await probeIceServerLatency(e.ice)
      let upload: ProbeResult['upload'] = undefined
      if (e.kind === 'turn' && latencyMs !== null && opts?.upload !== false) {
        upload = await measureTurnUpload(e.ice)
      }
      onEntry(e.id, { latencyMs, upload })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, entries.length) }, worker))
}

function customToIce(c: CustomServer): RTCIceServer {
  const urls = c.urls.split(/[,\s]+/).map((u) => u.trim()).filter(Boolean)
  const ice: RTCIceServer = { urls }
  if (c.username) ice.username = c.username
  if (c.credential) ice.credential = c.credential
  return ice
}

/** 延迟分档着色（与 quality.ts 网络分档阈值风格一致） */
export function latencyTone(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'text-muted-foreground'
  if (ms < 80) return 'text-emerald-600 dark:text-emerald-300'
  if (ms < 200) return 'text-sky-600 dark:text-sky-300'
  if (ms < 400) return 'text-amber-600 dark:text-amber-300'
  return 'text-red-600 dark:text-red-300'
}
