/**
 * VeilTalk Crypto Core — 端到端加密的密码学基础（主线程使用）
 *
 * 密钥体系（全部基于 WebCrypto，密钥材料不落盘、不上传）：
 *   1. 身份密钥：每个浏览器会话生成临时 ECDH P-256 密钥对（非持久，页面关闭即销毁）
 *   2. 密钥协商：与每个远端节点 ECDH 派生 256bit 共享秘密（信令服务器只看到公钥指纹）
 *   3. 密钥派生：HKDF-SHA256 按 (salt, info) 派生 8 个方向隔离的密钥材料：
 *        videoOut/videoIn/audioOut/audioIn（媒体帧「轮换种子」，worker 内逐 epoch 派生帧密钥）
 *        fileOut/fileIn/chatOut/chatIn（DataChannel 静态会话密钥）
 *      info 编码 `veiltalk:<用途>:<发送方peerId>:<接收方peerId>`，两侧可独立推出一致密钥
 *   4. 房间口令（可选）：PBKDF2 口令 → 参与盐值派生，可抵抗"信令层中间人"，提升安全码可验证性
 *   5. 安全码：SHA-256(排序后的双方指纹 + 盐) → 展示给用户带外核对（类似 Signal 安全数字）
 *
 * 帧加密格式（媒体帧 / 文件块 / 聊天通用）：
 *   媒体帧：[ 1B epoch | 12B IV(random) | AES-GCM 密文 | 16B GCM tag ]（epoch 支持轮换链）
 *   文件/聊天：[ 12B IV(random) | AES-GCM 密文 | 16B GCM tag ]
 *   媒体帧 additionalData 绑定帧内 epoch 字节（双端从同一帧头读取，必然一致；
 *   不用关键帧标志 —— Chromium 发/收端 frame.type 不对称，会导致解密失败）
 */

const te = new TextEncoder()

/* ------------------------------ 编码小工具 ------------------------------ */

export function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function b64ToBuf(s: string): Uint8Array {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return toHex(bytes).slice(0, len)
}

/* ------------------------------ 身份与协商 ------------------------------ */

export interface Identity {
  privateKey: CryptoKey
  publicKeyJwk: JsonWebKey
  fingerprint: string
}

/** 生成会话级 ECDH P-256 身份密钥对并计算指纹 */
export async function generateIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const fingerprint = await fingerprintJwk(publicKeyJwk)
  return { privateKey: pair.privateKey, publicKeyJwk, fingerprint }
}

/** 公钥指纹：SHA-256(标准化的 x+y 坐标) → 分组大写十六进制 */
export async function fingerprintJwk(jwk: JsonWebKey): Promise<string> {
  const material = `${jwk.crv}|${jwk.x}|${jwk.y}`
  const digest = await crypto.subtle.digest('SHA-256', te.encode(material))
  const hex = toHex(digest).toUpperCase()
  return (hex.match(/.{1,4}/g) || []).slice(0, 12).join('-')
}

/** 房间盐：SHA-256("veiltalk-salt:" + roomId + ":" + 口令)（口令参与 KDF，可对抗信令层 MITM） */
export async function roomSalt(roomId: string, passphrase?: string): Promise<Uint8Array> {
  const material = `veiltalk-salt:${roomId}:${passphrase || ''}`
  const digest = await crypto.subtle.digest('SHA-256', te.encode(material))
  return new Uint8Array(digest)
}

/** ECDH 共享秘密（256 bit） */
export async function deriveSharedBits(
  privateKey: CryptoKey,
  peerPublicKeyJwk: JsonWebKey,
): Promise<ArrayBuffer> {
  const peerPub = await crypto.subtle.importKey(
    'jwk',
    peerPublicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  return crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, privateKey, 256)
}

/**
 * 与某个远端节点派生全部 8 把方向隔离的原始密钥字节（32B/把）。
 * out* = 我发他收（info: from=self, to=remote）；in* = 他发我收（info: from=remote, to=self）。
 * 返回原始字节：媒体帧密钥直接交给 worker；文件/聊天密钥经 importSessionKeys 导入主线程。
 */
export async function deriveRawKeys(
  sharedBits: ArrayBuffer,
  salt: Uint8Array,
  selfId: string,
  remoteId: string,
): Promise<import('./types').RawKeySet> {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits'])
  const bits = async (info: string) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as BufferSource, info: te.encode(info) },
      base,
      256,
    )
  const [videoOut, videoIn, audioOut, audioIn, fileOut, fileIn, chatOut, chatIn] =
    await Promise.all([
      bits(`veiltalk:video:${selfId}:${remoteId}`),
      bits(`veiltalk:video:${remoteId}:${selfId}`),
      bits(`veiltalk:audio:${selfId}:${remoteId}`),
      bits(`veiltalk:audio:${remoteId}:${selfId}`),
      bits(`veiltalk:file:${selfId}:${remoteId}`),
      bits(`veiltalk:file:${remoteId}:${selfId}`),
      bits(`veiltalk:chat:${selfId}:${remoteId}`),
      bits(`veiltalk:chat:${remoteId}:${selfId}`),
    ])
  return { videoOut, videoIn, audioOut, audioIn, fileOut, fileIn, chatOut, chatIn }
}

/**
 * 媒体帧密钥轮换：从轮换种子派生 epoch N 的帧密钥原始字节。
 * 与 worker 内部实现保持一致（HKDF-SHA256, info="veiltalk:epoch:N"），
 * 供自检 S6 验证「轮换后两端密钥仍一致且旧纪元帧可解」。
 */
export async function epochKeyRaw(seed: ArrayBuffer, epoch: number): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(`veiltalk:epoch:${epoch}`) },
    base,
    256,
  )
}

/**
 * DataChannel（聊天/文件）密钥轮换：从 DC 轮换种子派生 epoch N 的帧密钥原始字节。
 * info 与媒体帧链隔离（"veiltalk:dc-epoch:N"），供 dc-ratchet.ts 与自检 S7 使用。
 */
export async function dcEpochKeyRaw(seed: ArrayBuffer, epoch: number): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(`veiltalk:dc-epoch:${epoch}`) },
    base,
    256,
  )
}

/** 从原始字节导入主线程所需的 AES-GCM 密钥（文件/聊天） */
export async function importSessionKeys(
  raw: import('./types').RawKeySet,
): Promise<import('./types').SessionKeys> {
  const imp = (bytes: ArrayBuffer) =>
    crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const [fileOut, fileIn, chatOut, chatIn] = await Promise.all([
    imp(raw.fileOut),
    imp(raw.fileIn),
    imp(raw.chatOut),
    imp(raw.chatIn),
  ])
  return { fileOut, fileIn, chatOut, chatIn }
}

/** 双方安全码：SHA-256(字典序拼接的指纹 + 盐) → 6 组 4 位大写十六进制（带外核对用） */
export async function safetyNumber(fa: string, fb: string, salt: Uint8Array): Promise<string> {
  const [a, b] = [fa, fb].sort()
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`${a}:${b}:${toHex(salt)}`))
  const hex = toHex(digest).toUpperCase().slice(0, 24)
  return (hex.match(/.{1,4}/g) || []).join('-')
}

/* ------------------------------ 对称加解密 ------------------------------ */

/** 通用帧加密：输出 [iv(12) | ct | tag(16)] */
export async function encryptFrame(key: CryptoKey, plaintext: ArrayBuffer): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return out
}

/** 通用帧解密：输入 [iv(12) | ct | tag(16)] */
export async function decryptFrame(key: CryptoKey, framed: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(framed)
  if (u8.byteLength <= 12 + 16) throw new Error('ciphertext too short')
  const iv = u8.slice(0, 12)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, u8.slice(12))
}

/** SHA-256 → 小写十六进制（文件完整性校验） */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as ArrayBuffer)
  return toHex(digest)
}

/** 掩码房间号（用于台账展示，避免完整房间号外泄） */
export function maskRoomId(roomId: string): string {
  if (roomId.length <= 6) return roomId.slice(0, 2) + '**'
  return `${roomId.slice(0, 3)}…${roomId.slice(-3)}`
}
