/**
 * VeilTalk SPAKE2 — 口令认证密钥协商（PAKE，ROADMAP P0-3）
 *
 * 协议：SPAKE2（RFC 9383 思路的 P-256 实现，BigInt 纯 JS）
 *   双方共享低熵口令 pw，无需额外信任即可完成「双向身份认证 + 抗中间人」的密钥交换：
 *     A（发起方）：x 随机，X = x·G + w·M，发送 X
 *     B（响应方）：y 随机，Y = y·G + w·N，发送 Y
 *     A 计算 Z = x·(Y − w·N) = x·y·G；B 计算 Z = y·(X − w·M) = x·y·G
 *     会话密钥 K = H(Z ‖ X ‖ Y ‖ 身份与房间上下文)
 *     密钥确认：proof = HMAC(K, role‖transcript)，双方互验 → 口令不一致/中间人立即失败
 *
 * 安全语义：
 *   - 口令零知识：X/Y 公开值不泄露 pw（离线字典攻击不可行，Z 含 x/y 未知随机数）
 *   - 错误口令 → Z 不一致 → 互证失败 → fail-closed（不建立任何会话密钥）
 *   - 中间人替换 X/Y → 无法算出正确 proof → 失败；转发则学不到任何密钥
 *   - transcript 绑定 roomId + 双方 peerId + 指纹，防未知密钥共享/反射攻击
 *
 * 实现说明：
 *   - M/N 常量用 hash-and-check 从域分隔字符串确定性派生（nothing-up-my-sleeve，
 *     不依赖记忆的 RFC 常量；两端同源派生即可，互操作性只要求两端一致）
 *   - P-256 雅可比坐标标量乘；JS BigInt 非常量时间 —— 作为参考实现对时序侧信道
 *     不做承诺（详见 docs/E2EE.md 局限性章节），密钥确认失败会整体放弃会话
 *   - 密钥确认使用 WebCrypto HMAC-SHA256；Z 派生使用 WebCrypto SHA-256
 */

import { toHex } from './crypto-core'

/* ------------------------------ P-256 域参数 ------------------------------ */

/** 素数 p（P-256） */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
/** 群阶 n */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
/** 曲线系数 a = -3（mod p）与 b */
const A = P - 3n
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
/** 基点 G */
const G: JacPoint = { x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n, z: 1n }

/** 雅可比坐标点（z = 0 表示无穷远） */
interface JacPoint {
  x: bigint
  y: bigint
  z: bigint
}

const mod = (v: bigint, m: bigint = P): bigint => {
  const r = v % m
  return r < 0n ? r + m : r
}

/** 模逆（费马小定理，p 为素数） */
const modInv = (v: bigint): bigint => {
  const r = mod(v, P)
  if (r === 0n) throw new Error('spake2: 模零不可逆')
  return powMod(r, P - 2n)
}

/** 模幂（平方-乘） */
function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }
  return result
}

/** 雅可比点加倍（a = -3 优化公式） */
function jDouble(pt: JacPoint): JacPoint {
  if (pt.z === 0n || pt.y === 0n) return { x: 0n, y: 1n, z: 0n }
  const delta = mod(pt.z * pt.z)
  const gamma = mod(pt.y * pt.y)
  const beta = mod(pt.x * gamma)
  const alpha = mod(3n * (pt.x - delta) * (pt.x + delta))
  const x3 = mod(alpha * alpha - 8n * beta)
  const z3 = mod(2n * pt.y * pt.z)
  const y3 = mod(alpha * (4n * beta - x3) - 8n * (gamma * gamma))
  return { x: x3, y: y3, z: z3 }
}

/** 雅可比点相加（一般公式） */
function jAdd(p1: JacPoint, p2: JacPoint): JacPoint {
  if (p1.z === 0n) return p2
  if (p2.z === 0n) return p1
  const z1z1 = mod(p1.z * p1.z)
  const z2z2 = mod(p2.z * p2.z)
  const u1 = mod(p1.x * z2z2)
  const u2 = mod(p2.x * z1z1)
  const s1 = mod(p1.y * p2.z * z2z2)
  const s2 = mod(p2.y * p1.z * z1z1)
  const h = mod(u2 - u1)
  // EFD add-1998-cmo：r = 2*(S2-S1)（此公式族要求 r 带因子 2，与 I=(2H)²、X3=r²-J-2V 配套；
  // 若漏掉因子 2，X3 少乘 4 —— 纯 doubling/无穷远捷径不受影响，极易被小标量测试掩盖）
  const r = mod(2n * (s2 - s1))
  if (h === 0n) {
    return r === 0n ? jDouble(p1) : { x: 0n, y: 1n, z: 0n }
  }
  const i = mod(4n * h * h)
  const j = mod(h * i)
  const v = mod(u1 * i)
  const x3 = mod(r * r - j - 2n * v)
  const y3 = mod(r * (v - x3) - 2n * s1 * j)
  const z3 = mod((p1.z + p2.z) * (p1.z + p2.z) - z1z1 - z2z2) * h
  return { x: x3, y: y3, z: mod(z3) }
}

/** 标量乘（double-and-add，MSB→LSB） */
function jMul(k0: bigint, pt: JacPoint): JacPoint {
  let k = mod(k0, N)
  if (k === 0n) return { x: 0n, y: 1n, z: 0n }
  let acc: JacPoint = { x: 0n, y: 1n, z: 0n }
  let addend = pt
  while (k > 0n) {
    if (k & 1n) acc = jAdd(acc, addend)
    addend = jDouble(addend)
    k >>= 1n
  }
  return acc
}

/** 雅可比 → 仿射 */
function toAffine(pt: JacPoint): { x: bigint; y: bigint } | null {
  if (pt.z === 0n) return null
  const zInv = modInv(pt.z)
  const zInv2 = mod(zInv * zInv)
  return { x: mod(pt.x * zInv2), y: mod(pt.y * zInv2 * zInv) }
}

/** 点是否在曲线上（仿射坐标） */
function isOnCurve(x: bigint, y: bigint): boolean {
  if (x < 0n || x >= P || y < 0n || y >= P) return false
  const lhs = mod(y * y)
  const rhs = mod(x * x * x + A * x + B)
  return lhs === rhs
}

/** 64B 大端序编码 BigInt */
function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let x = v
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

/** 65B 未压缩点编码（0x04 ‖ x ‖ y） */
function encodePoint(pt: JacPoint): Uint8Array {
  const aff = toAffine(pt)
  if (!aff) throw new Error('spake2: 无法编码无穷远点')
  const out = new Uint8Array(65)
  out[0] = 0x04
  out.set(be32(aff.x), 1)
  out.set(be32(aff.y), 33)
  return out
}

/** 解析并校验 65B 未压缩点：格式、范围、在曲线上、非无穷远 */
function decodePoint(bytes: Uint8Array): JacPoint {
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('spake2: 对端共享值格式非法')
  const x = BigInt('0x' + [...bytes.slice(1, 33)].map((b) => b.toString(16).padStart(2, '0')).join(''))
  const y = BigInt('0x' + [...bytes.slice(33, 65)].map((b) => b.toString(16).padStart(2, '0')).join(''))
  if (!isOnCurve(x, y)) throw new Error('spake2: 对端共享值不在曲线上（可能被篡改）')
  return { x, y, z: 1n }
}

/* --------------------- M/N 常量：hash-and-check 确定性派生 --------------------- */

/**
 * 从域分隔字符串确定性派生曲线上的一点（try-and-increment 的简洁版）：
 * h = SHA-256(domain ‖ counter) → x 候选 → 求解 y（p ≡ 3 (mod 4)，开方 = ((p+1)/4) 次幂）
 * → 有效即取用。仅用于公开常量，非常量时间无碍。
 */
async function deriveCurvePoint(domain: string): Promise<JacPoint> {
  const te = new TextEncoder()
  const pPlus1Div4 = (P + 1n) / 4n
  for (let counter = 0; counter < 4096; counter++) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', te.encode(`${domain}:${counter}`)),
    )
    // x < p 概率 ~50%，取前 32B 作 x 候选；二次剩余失败则换 counter
    let x = BigInt('0x' + toHex(digest))
    if (x >= P) continue
    const rhs = mod(x * x * x + A * x + B)
    let y = powMod(rhs, pPlus1Div4)
    if (mod(y * y) !== rhs) continue
    // 用哈希末字节奇偶性确定 y/p-y，保证确定性
    const wantOdd = (digest[31] & 1) === 1
    const yIsOdd = (y & 1n) === 1n
    if (yIsOdd !== wantOdd) y = P - y
    if (!isOnCurve(x, y)) continue
    return { x, y, z: 1n }
  }
  throw new Error('spake2: 常量点派生失败（不应发生）')
}

let pointM: JacPoint | null = null
let pointN: JacPoint | null = null
async function ensureConstants(): Promise<{ M: JacPoint; N: JacPoint }> {
  if (!pointM) pointM = await deriveCurvePoint('veiltalk:spake2:M')
  if (!pointN) pointN = await deriveCurvePoint('veiltalk:spake2:N')
  return { M: pointM, N: pointN }
}

/* -------------------------------- 协议主体 -------------------------------- */

const te = new TextEncoder()

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    merged.set(p, off)
    off += p.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', merged))
}

async function hmac(keyBytes: Uint8Array, ...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const msg = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    msg.set(p, off)
    off += p.length
  }
  const key = await crypto.subtle.importKey('raw', keyBytes as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg as unknown as BufferSource))
}

/** 口令 → 群阶内标量 w（域分隔 + 房间上下文） */
async function passwordScalar(password: string, context: string): Promise<bigint> {
  const digest = await sha256(te.encode(`veiltalk:spake2:w:${context}:${password}`))
  const w = BigInt('0x' + toHex(digest)) % N
  return w === 0n ? 1n : w
}

export type SpakeRole = 'A' | 'B'

export interface SpakeStart {
  /** 私有随机标量（仅在 finish 前使用，不落盘不上传） */
  secret: bigint
  /** 65B 公开共享值（经信令发送） */
  share: Uint8Array
}

/**
 * 启动 SPAKE2：生成随机标量并计算公开共享值。
 * role 由双方 peerId 字典序确定性分配，无需额外协商。
 */
export async function spakeStart(role: SpakeRole, password: string, context: string): Promise<SpakeStart> {
  const { M, N: ptN } = await ensureConstants()
  const w = await passwordScalar(password, context)
  // 32B 随机标量，拒绝 0 与 ≥n
  let secret = 0n
  while (secret === 0n || secret >= N) {
    secret = BigInt('0x' + toHex(crypto.getRandomValues(new Uint8Array(32)))) % N
  }
  const base = jMul(secret, G)
  const blind = jMul(w, role === 'A' ? M : ptN)
  const share = jAdd(base, blind)
  return { secret, share: encodePoint(share) }
}

export interface SpakeKey {
  /** 32B 会话绑定密钥（不直接用于业务加密，仅作 ECDH 与业务密钥之间的绑定层） */
  key: Uint8Array
  /** 本端密钥确认证明（发给对端验证） */
  proof: Uint8Array
  /** transcript 字节（供互验重算对端证明；含双方身份/指纹/共享值绑定） */
  transcript: Uint8Array
  /** 对端角色（由双方 peerId 确定性推导，供互验使用） */
  peerRole: SpakeRole
}

/**
 * 收到对端共享值后计算会话密钥与本端证明。
 * 口令不一致或对端共享值被篡改时：两侧算出不同 Z → 互证必然失败（不在此处抛错）。
 * 对端共享值非法（格式/不在曲线上）→ 立即抛错（fail-closed）。
 */
export async function spakeComputeKey(params: {
  role: SpakeRole
  password: string
  context: string
  ownSecret: bigint
  ownShare: Uint8Array
  peerShare: Uint8Array
  selfId: string
  peerId: string
  selfFp: string
  peerFp: string
}): Promise<SpakeKey> {
  const { M, N: ptN } = await ensureConstants()
  const peerRole: SpakeRole = params.role === 'A' ? 'B' : 'A'
  const peerPt = decodePoint(params.peerShare) // 非法点直接抛错（fail-closed）
  const w = await passwordScalar(params.password, params.context)
  // 我方盲化点（重新计算，避免传输 ownShare 的信任问题）
  const ownBlind = jMul(w, params.role === 'A' ? M : ptN)
  // Z = ownSecret · (peerShare − w·(peer 的盲化常量))
  const peerBlind = jMul(w, peerRole === 'A' ? M : ptN)
  const negPeerBlind: JacPoint = { x: peerBlind.x, y: mod(P - peerBlind.y), z: peerBlind.z }
  const zPoint = jMul(params.ownSecret, jAdd(peerPt, negPeerBlind))
  const zAff = toAffine(zPoint)
  if (!zAff) throw new Error('spake2: Z 为无穷远点（口令或共享值异常）')
  // transcript：房间上下文 + 双方身份/指纹 + 双方共享值（字节序 A 在前）
  const shareA = params.role === 'A' ? params.ownShare : params.peerShare
  const shareB = params.role === 'A' ? params.peerShare : params.ownShare
  const idA = params.role === 'A' ? params.selfId : params.peerId
  const idB = params.role === 'A' ? params.peerId : params.selfId
  const fpA = params.role === 'A' ? params.selfFp : params.peerFp
  const fpB = params.role === 'A' ? params.peerFp : params.selfFp
  const transcript = await sha256(
    te.encode('veiltalk:spake2:transcript'),
    te.encode(params.context),
    te.encode(`A:${idA}:${fpA}`),
    shareA,
    te.encode(`B:${idB}:${fpB}`),
    shareB,
  )
  // K = H("Z" ‖ Z ‖ transcript)；Z 同时受随机数与口令保护
  const k = await sha256(
    te.encode('veiltalk:spake2:key'),
    be32(zAff.x),
    be32(zAff.y),
    transcript,
  )
  // 本端证明：HMAC(K, "confirm:" ‖ role ‖ transcript)；对端用同构输入重算互验
  const proof = await hmac(k, te.encode(`veiltalk:spake2:confirm:${params.role}`), transcript)
  return { key: k, proof, transcript, peerRole }
}

/**
 * 校验对端证明：用同一把 K 重算「对端角色」的期望证明并比较。
 * 口令不一致/共享值被篡改 → 双方 Z 不同 → K 不同 → 期望与收到必然不等 → 返回 false。
 */
export async function spakeVerifyProof(
  key: Uint8Array,
  transcript: Uint8Array,
  peerRole: SpakeRole,
  proof: Uint8Array,
): Promise<boolean> {
  const expect = await hmac(key, te.encode(`veiltalk:spake2:confirm:${peerRole}`), transcript)
  if (expect.length !== proof.length) return false
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ proof[i]
  return diff === 0
}

/**
 * PAKE 绑定层：把 SPAKE2 会话密钥作为 HKDF salt，把 ECDH 共享秘密作为 IKM，
 * 派生 32B 绑定密钥材料 —— 后续 8 把方向隔离密钥从它继续派生（见 crypto-core.deriveRawKeys）。
 * 语义：ECDH 提供前向保密，SPAKE2 提供口令认证；两者缺一会话都无法建立。
 */
export async function bindPakeSecret(sharedBits: ArrayBuffer, pakeKey: Uint8Array): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: pakeKey as unknown as BufferSource,
      info: te.encode('veiltalk:pake-bind:v1'),
    },
    base,
    256,
  )
}
