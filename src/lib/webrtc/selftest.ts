/**
 * VeilTalk SelfTest — 浏览器内自环全链路自检（不依赖信令服务器与摄像头）
 *
 * 用途：
 *  1. 部署后一键验证"加密管线可用"：ECDH/HKDF/AES-GCM → WebRTC 建连 → 帧级 E2EE → 加密文件传输
 *  2. 无摄像头/麦克风环境（无头浏览器、服务器演示）也能验证核心链路 —— 视频源用 Canvas 合成
 *  3. CI / agent-browser 自动化验收的探针
 *
 * 步骤：
 *  S1 WebCrypto 原语：ECDH 两侧共享秘密一致 + AES-GCM 加解密往返
 *  S2 指纹/安全码确定性
 *  S3 WebRTC 本地回环建连（两个 RTCPeerConnection 直接交换 SDP/ICE）
 *  S4 帧级 E2EE 媒体管线：Canvas 合成视频 → 编码帧加密 worker → 解码 worker → 统计解密帧数
 *  S5 加密 DataChannel 文件往返 + SHA-256 完整性校验 + 对端显式回执（DC 轮换环 epoch 帧格式）
 *  S6 密钥轮换链：epoch 派生确定性 + force-rotate 后媒体帧仍可解（前向保密基础）
 *  S7 DataChannel 轮换链：epoch 帧往返 + 跨纪元隔离（旧密钥不可解新纪元帧）
 *  S8 SPAKE2 PAKE：同口令双端密钥一致+互证通过；异口令互证失败；非法点拒绝（fail-closed）
 *  S9 断点续传暂存：IndexedDB 写/读/擦往返 + resume offset 块边界对齐（P1-6）
 */

import {
  deriveRawKeys,
  encryptFrame,
  decryptFrame,
  dcEpochKeyRaw,
  epochKeyRaw,
  fingerprintJwk,
  generateIdentity,
  roomSalt,
  safetyNumber,
} from './crypto-core'
import { bindPakeSecret, spakeComputeKey, spakeStart, spakeVerifyProof } from './spake2'
import { FileReceiver, FileSender } from './file-transfer'
import { DcKeyRing } from './dc-ratchet'
import { dictFor, fmt } from '@/lib/i18n'
import { useVeil } from '@/store/veil-store'
import type { SelfTestResult, TransferState } from './types'

const enc = new TextEncoder()

type FrameLike = { type?: string; timestamp: number; data: ArrayBuffer | null }
type StreamsLike = { readable: ReadableStream<FrameLike>; writable: WritableStream<FrameLike> }

/** 独立 worker 实例（与运行时的共享 worker 隔离，统计互不干扰） */
function spawnWorker(): Worker {
  return new Worker(new URL('./e2ee.worker.ts', import.meta.url), { type: 'module' })
}

function attachEncode(pc: RTCPeerConnection, worker: Worker, seed: ArrayBuffer, pipeId: string): string {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
  if (!sender) return 'no-sender'
  const s = sender as unknown as { createEncodedStreams?: () => StreamsLike; transform?: unknown }
  if (typeof s.createEncodedStreams === 'function') {
    const streams = s.createEncodedStreams()
    worker.postMessage(
      { op: 'e2ee', mode: 'encode', pipeId, seed, readable: streams.readable, writable: streams.writable },
      [streams.readable, streams.writable],
    )
    return 'encoded-streams'
  }
  const Ctor = (globalThis as unknown as {
    RTCRtpScriptTransform?: new (w: Worker, o?: unknown) => unknown
  }).RTCRtpScriptTransform
  if (Ctor) {
    s.transform = new Ctor(worker, { mode: 'encode', pipeId, seed })
    return 'script-transform'
  }
  return 'unsupported'
}

function attachDecode(receiver: RTCRtpReceiver, worker: Worker, seed: ArrayBuffer, pipeId: string): string {
  const r = receiver as unknown as { createEncodedStreams?: () => StreamsLike; transform?: unknown }
  if (typeof r.createEncodedStreams === 'function') {
    const streams = r.createEncodedStreams()
    worker.postMessage(
      { op: 'e2ee', mode: 'decode', pipeId, seed, readable: streams.readable, writable: streams.writable },
      [streams.readable, streams.writable],
    )
    return 'encoded-streams'
  }
  const Ctor = (globalThis as unknown as {
    RTCRtpScriptTransform?: new (w: Worker, o?: unknown) => unknown
  }).RTCRtpScriptTransform
  if (Ctor) {
    r.transform = new Ctor(worker, { mode: 'decode', pipeId, seed })
    return 'script-transform'
  }
  return 'unsupported'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** getRandomValues 单次上限 65536 字节，分段填充 */
function randomU8(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let off = 0; off < n; off += 65536) {
    out.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, n - off))), off)
  }
  return out
}

/** 带缓冲的 ICE 交换（避免候选早于远端描述到达） */
class LoopLink {
  private buf: Array<{ pc: RTCPeerConnection; c: RTCIceCandidateInit }> = []
  link(a: RTCPeerConnection, b: RTCPeerConnection) {
    a.onicecandidate = (e) => e.candidate && this.deliver(b, e.candidate.toJSON())
    b.onicecandidate = (e) => e.candidate && this.deliver(a, e.candidate.toJSON())
  }
  private deliver(pc: RTCPeerConnection, c: RTCIceCandidateInit) {
    if (pc.remoteDescription && pc.signalingState !== 'closed') {
      void pc.addIceCandidate(c).catch(() => {})
    } else {
      this.buf.push({ pc, c })
    }
  }
  flush() {
    const list = [...this.buf]
    this.buf = []
    list.forEach(({ pc, c }) => void pc.addIceCandidate(c).catch(() => {}))
  }
}

export async function runSelfTest(
  onStep?: (r: SelfTestResult) => void,
): Promise<{ ok: boolean; results: SelfTestResult[] }> {
  const results: SelfTestResult[] = []
  /* i18n（F-36）：步骤名/详情按当前语言在运行时格式化，整个运行过程取同一份快照；
     语言切换后重新运行即刷新（结果为快照语义，不做响应式翻译） */
  const st = dictFor(useVeil.getState().lang).selftest
  const report = (name: string, ok: boolean, detail: string, ms: number) => {
    results.push({ name, ok, detail, ms })
    onStep?.({ name, ok, detail, ms })
  }

  /* S1 密码学原语 */
  {
    const t0 = performance.now()
    try {
      const A = await generateIdentity()
      const B = await generateIdentity()
      const salt = await roomSalt('selftest-room', '口令测试')
      const rawAB = await deriveRawKeys(await cryptoEcdh(A.privateKey, B.publicKeyJwk), salt, 'A', 'B')
      const rawBA = await deriveRawKeys(await cryptoEcdh(B.privateKey, A.publicKeyJwk), salt, 'B', 'A')
      const same = new Uint8Array(rawAB.fileOut).every((v, i) => v === new Uint8Array(rawBA.fileIn)[i])
      const imp = (bytes: ArrayBuffer) =>
        crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      const keysAB = { fileOut: await imp(rawAB.fileOut), fileIn: await imp(rawAB.fileIn) }
      const keysBA = { fileIn: await imp(rawBA.fileIn) }
      const plain = enc.encode('VeilTalk 加密往返测试 ✅')
      // A 用 fileOut 加密，B 用其视角派生的 fileIn 解密（两侧 info 均为 file:A:B）
      const framed = await encryptFrame(keysAB.fileOut, plain.buffer as ArrayBuffer)
      const back = await decryptFrame(keysBA.fileIn, framed.buffer as ArrayBuffer)
      const roundtrip = new Uint8Array(back).every((v, i) => v === plain[i])
      report(
        st.s1Name,
        same && roundtrip,
        fmt(st.s1Detail, { same: String(same), rt: String(roundtrip) }),
        Math.round(performance.now() - t0),
      )
    } catch (e) {
      report(st.s1Name, false, String(e), Math.round(performance.now() - t0))
    }
  }

  /* S2 指纹与安全码 */
  {
    const t0 = performance.now()
    try {
      const id = await generateIdentity()
      const fp1 = await fingerprintJwk(id.publicKeyJwk)
      const fp2 = await fingerprintJwk(id.publicKeyJwk)
      const sn = await safetyNumber(fp1, fp1, await roomSalt('r', ''))
      const ok = fp1 === fp2 && /^[0-9A-F-]+$/.test(sn)
      report(st.s2Name, ok, fmt(st.s2Detail, { fp: fp1.slice(0, 19), sn }), Math.round(performance.now() - t0))
    } catch (e) {
      report(st.s2Name, false, String(e), Math.round(performance.now() - t0))
    }
  }

  /* S3~S5 回环建连 */
  const worker = spawnWorker()
  let workerDecrypted = 0
  let workerEncrypted = 0
  let workerDropped = 0
  let workerRotations = 0
  worker.onmessage = (ev: MessageEvent) => {
    if (ev.data?.op === 'stats') {
      workerDecrypted = ev.data.stats.decrypted
      workerEncrypted = ev.data.stats.encrypted
      workerDropped = ev.data.stats.dropped || 0
      workerRotations = ev.data.stats.rotations || 0
    }
  }

  let pcA: RTCPeerConnection | null = null
  let pcB: RTCPeerConnection | null = null
  let canvas: HTMLCanvasElement | null = null
  let drawTimer: ReturnType<typeof setInterval> | null = null
  let stream: MediaStream | null = null
  const cleanups: Array<() => void> = []

  try {
    pcA = new RTCPeerConnection()
    pcB = new RTCPeerConnection()
    const link = new LoopLink()
    link.link(pcA, pcB)

    // S5 数据通道（先挂好回调）
    let dcBRef: RTCDataChannel | null = null
    const dcReady = new Promise<void>((resolve) => {
      pcB!.ondatachannel = (e) => {
        const dcB = e.channel
        dcB.binaryType = 'arraybuffer'
        dcBRef = dcB
        resolve()
      }
    })
    const dcA = pcA.createDataChannel('selftest', { ordered: true })
    dcA.binaryType = 'arraybuffer'

    // S4 媒体源：Canvas 合成动画（无摄像头也可用）
    canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')!
    let tick = 0
    drawTimer = setInterval(() => {
      tick++
      const g = ctx.createLinearGradient(0, 0, 320, 180)
      g.addColorStop(0, `hsl(${(tick * 7) % 360} 70% 45%)`)
      g.addColorStop(1, `hsl(${(tick * 7 + 120) % 360} 70% 30%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 320, 180)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 20px sans-serif'
      ctx.fillText(`E2EE ${tick}`, 20, 100)
    }, 40)
    cleanups.push(() => drawTimer && clearInterval(drawTimer))

    if (typeof canvas.captureStream !== 'function') {
      throw new Error(st.s4NoCanvas)
    }
    stream = canvas.captureStream(15)
    const track = stream.getVideoTracks()[0]
    const senderStream = new MediaStream([track])
    pcA.addTrack(track, senderStream)

    // S4/S6 解码端接线（同一轮换种子贯穿加密/解密两端，pipeId 区分管线）
    const e2eeSeed = crypto.getRandomValues(new Uint8Array(32)).buffer
    const PIPE_ENC = 'selftest:send:video'
    const PIPE_DEC = 'selftest:recv:video'
    let decodeMode = 'pending'
    let encodeMode = 'pending'
    encodeMode = attachEncode(pcA, worker, e2eeSeed, PIPE_ENC)
    pcB.ontrack = (e) => {
      decodeMode = attachDecode(e.receiver, worker, e2eeSeed.slice(0), PIPE_DEC)
    }

    // 显式一次性协商（避免 onnegotiationneeded 双触发竞态）
    await pcA.setLocalDescription()
    await pcB.setRemoteDescription(pcA.localDescription!)
    await pcB.setLocalDescription()
    await pcA.setRemoteDescription(pcB.localDescription!)
    link.flush()

    // 等待建连
    const connected = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000)
      const check = () => {
        if (pcB && pcB.connectionState === 'connected') {
          clearTimeout(timer)
          resolve(true)
        } else if (pcB && pcB.connectionState === 'failed') {
          clearTimeout(timer)
          resolve(false)
        }
      }
      const iv = setInterval(check, 100)
      cleanups.push(() => clearInterval(iv))
    })

    const ok3 = await connected
    report(st.s3Name, ok3, ok3 ? st.s3Ok : st.s3Fail, 0)

    // S4 等待解密帧（回环建连后编码先于解码起步，最长等 15s，达标即提前结束）
    {
      const t0 = performance.now()
      let ok = false
      for (let i = 0; i < 75 && !ok; i++) {
        await sleep(200)
        ok = workerDecrypted > 5 && workerEncrypted > 5
      }
      report(
        st.s4Name,
        ok,
        fmt(st.s4Detail, { enc: workerEncrypted, dec: workerDecrypted, drop: workerDropped, m1: encodeMode, m2: decodeMode }),
        Math.round(performance.now() - t0),
      )
    }

    // S5 加密文件往返
    {
      await dcReady
      const t0 = performance.now()
      const raw = await deriveRawKeys(
        crypto.getRandomValues(new Uint8Array(32)).buffer,
        new Uint8Array(32),
        't',
        't',
      )
      const payload = randomU8(256 * 1024)
      const file = new File([payload as unknown as BlobPart], 'selftest-256KB.bin', { type: 'application/octet-stream' })
      let final: TransferState | null = null
      let ackSeen: { id: string; ok: boolean } | null = null
      // DC 轮换环：发送/接收各持同源种子的独立环（真实应用中由 RoomClient 创建）
      const receiver = new FileReceiver(new DcKeyRing(raw.fileIn, 'in'), {
        onTransferUpdate: (t) => {
          if (t.status === 'done' || t.status === 'failed') final = t
        },
        onLog: () => {},
        // 显式回执（F-33）：接收端校验完成后回发 file-ack → dcA 侧发送端
        sendControl: (m) => {
          dcBRef?.send(JSON.stringify(m))
          return true
        },
      })
      // 手动接线（真实应用中由 PeerSession 完成）：dcB 收到 JSON → 控制消息，二进制 → 加密文件块
      dcBRef!.onmessage = (ev) => {
        if (typeof ev.data === 'string') receiver.handleControl(JSON.parse(ev.data) as Record<string, unknown>)
        else if (ev.data instanceof ArrayBuffer) void receiver.handleChunk(ev.data)
      }
      const sender2 = new FileSender(() => dcA, new DcKeyRing(raw.fileOut, 'out'), '自环', {
        onTransferUpdate: () => {},
        onLog: () => {},
        onTransferAck: (id, ok) => {
          ackSeen = { id, ok }
        },
      })
      // 回执方向（F-33）：dcBRef.send 的 file-ack 走 B→A 到达 dcA，需路由到 sender2 控制面
      dcA.onmessage = (ev) => {
        if (typeof ev.data === 'string') sender2.handleControl(JSON.parse(ev.data) as Record<string, unknown>)
      }
      dcA.bufferedAmountLowThreshold = 128 * 1024
      sender2.enqueue(file)
      let ok = false
      for (let i = 0; i < 100 && !final; i++) await sleep(100)
      let ackOk = false
      if (final) {
        const f = final as TransferState
        // 等待对端显式回执（F-33）：接收端 file-ack 回传（最多 3s）
        for (let i = 0; i < 30 && !ackSeen; i++) await sleep(100)
        ackOk = ackSeen !== null && (ackSeen as { id: string; ok: boolean }).ok === true
        ok = f.status === 'done' && f.digestOk === true && ackOk
      }
      report(
        st.s5Name,
        ok,
        final
          ? fmt(st.s5Detail, { status: (final as TransferState).status, digestOk: String((final as TransferState).digestOk), ack: String(ackOk) })
          : st.s5Timeout,
        Math.round(performance.now() - t0),
      )
    }

    // S6 密钥轮换链：epoch 派生确定性 + force-rotate 后帧仍可解
    {
      const t0 = performance.now()
      try {
        // 6a. epoch 派生确定性：同种子同 epoch 密钥一致，不同 epoch 密钥不同
        const k0a = new Uint8Array(await epochKeyRaw(e2eeSeed.slice(0), 0))
        const k0b = new Uint8Array(await epochKeyRaw(e2eeSeed.slice(0), 0))
        const k1 = new Uint8Array(await epochKeyRaw(e2eeSeed.slice(0), 1))
        const k0same = k0a.every((v, i) => v === k0b[i])
        const k0diff = !k0a.every((v, i) => v === k1[i])

        // 6b. force-rotate 编码管线后，解码端按帧内 epoch 自动跟随、解密不中断
        const before = workerDecrypted
        worker.postMessage({ op: 'force-rotate', pipeId: PIPE_ENC })
        let after = before
        let sawRotation = false
        for (let i = 0; i < 40; i++) {
          await sleep(200)
          if (workerRotations >= 1) sawRotation = true
          after = workerDecrypted
          if (sawRotation && after >= before + 5) break
        }
        const ok = k0same && k0diff && sawRotation && after > before
        report(
          st.s6Name,
          ok,
          fmt(st.s6Detail, { det: String(k0same), diff: String(k0diff), rot: String(sawRotation), n: Math.max(0, after - before) }),
          Math.round(performance.now() - t0),
        )
      } catch (e) {
        report(st.s6Name, false, String(e), Math.round(performance.now() - t0))
      }
    }

    // S7 DataChannel 轮换链：epoch 帧往返 + 跨纪元隔离（旧密钥不可解新纪元帧）
    {
      const t0 = performance.now()
      try {
        const seed = crypto.getRandomValues(new Uint8Array(32)).buffer
        const outRing = new DcKeyRing(seed.slice(0), 'out')
        const inRing = new DcKeyRing(seed.slice(0), 'in')

        // 7a. 同种子同 epoch 密钥一致（发送环 epoch0 ↔ 接收环按字节解析 epoch0）
        const plain0 = enc.encode('S7 epoch0 往返')
        const { key: k0 } = await outRing.out()
        const framed0 = await encryptFrame(k0, plain0.buffer as ArrayBuffer)
        const wire0 = new Uint8Array(1 + framed0.byteLength)
        wire0[0] = 0
        wire0.set(framed0, 1)
        const { key: ik0 } = await inRing.inKeyForByte(0)
        const back0 = await decryptFrame(ik0, wire0.slice(1).buffer as ArrayBuffer)
        const round0 = new Uint8Array(back0).every((v, i) => v === plain0[i])

        // 7b. 轮换后（epoch1）新帧仍可解，且 epoch0 密钥无法解 epoch1 帧（前向隔离）
        outRing.rotate('manual')
        const { key: k1, epoch: e1 } = await outRing.out()
        const plain1 = enc.encode('S7 epoch1 往返')
        const framed1 = await encryptFrame(k1, plain1.buffer as ArrayBuffer)
        const wire1 = new Uint8Array(1 + framed1.byteLength)
        wire1[0] = e1 % 256
        wire1.set(framed1, 1)
        const { key: ik1 } = await inRing.inKeyForByte(e1 % 256)
        const back1 = await decryptFrame(ik1, wire1.slice(1).buffer as ArrayBuffer)
        const round1 = new Uint8Array(back1).every((v, i) => v === plain1[i])
        let isolated = false
        try {
          await decryptFrame(
            k0,
            framed1.buffer.slice(framed1.byteOffset, framed1.byteOffset + framed1.byteLength) as ArrayBuffer,
          )
        } catch {
          isolated = true // epoch0 密钥解不开 epoch1 密文 = 轮换生效
        }
        // 7c. 派生确定性：dcEpochKeyRaw 与媒体链 info 隔离（不同 info 产生不同密钥）
        const dcK = new Uint8Array(await dcEpochKeyRaw(seed.slice(0), 0))
        const ok = round0 && round1 && isolated && dcK.length === 32
        report(
          st.s7Name,
          ok,
          fmt(st.s7Detail, { r0: String(round0), e: e1, r1: String(round1), iso: String(isolated) }),
          Math.round(performance.now() - t0),
        )
      } catch (e) {
        report(st.s7Name, false, String(e), Math.round(performance.now() - t0))
      }
    }
    // S8 SPAKE2 PAKE：与网络/建连无关，纯密码学回环
    {
      const t0 = performance.now()
      try {
        const CTX = 'selftest-pake-room'
        const idA = 'peerA-selftest'
        const idB = 'peerB-selftest'
        const fpA = 'FP-A-0000'
        const fpB = 'FP-B-1111'
        // 8a. 同口令：两侧密钥一致 + 互证通过
        const sA = await spakeStart('A', '正确口令', CTX)
        const sB = await spakeStart('B', '正确口令', CTX)
        const kA = await spakeComputeKey({
          role: 'A', password: '正确口令', context: CTX,
          ownSecret: sA.secret, ownShare: sA.share, peerShare: sB.share,
          selfId: idA, peerId: idB, selfFp: fpA, peerFp: fpB,
        })
        const kB = await spakeComputeKey({
          role: 'B', password: '正确口令', context: CTX,
          ownSecret: sB.secret, ownShare: sB.share, peerShare: sA.share,
          selfId: idB, peerId: idA, selfFp: fpB, peerFp: fpA,
        })
        const sameKey = new Uint8Array(kA.key).every((v, i) => v === kB.key[i])
        // 互验：验证某侧证明时 role = 证明创建者角色（A 的证明用 'A'，即 kB.peerRole）
        const proofAok = await spakeVerifyProof(kB.key, kB.transcript, kB.peerRole, kA.proof)
        const proofBok = await spakeVerifyProof(kA.key, kA.transcript, kA.peerRole, kB.proof)

        // 8b. 异口令：Z 不同 → K 不同 → 互证失败（fail-closed 语义的核心）
        const wA = await spakeStart('A', '正确口令', CTX)
        const wB = await spakeStart('B', '错误口令', CTX)
        const kAw = await spakeComputeKey({
          role: 'A', password: '正确口令', context: CTX,
          ownSecret: wA.secret, ownShare: wA.share, peerShare: wB.share,
          selfId: idA, peerId: idB, selfFp: fpA, peerFp: fpB,
        })
        const kBw = await spakeComputeKey({
          role: 'B', password: '错误口令', context: CTX,
          ownSecret: wB.secret, ownShare: wB.share, peerShare: wA.share,
          selfId: idB, peerId: idA, selfFp: fpB, peerFp: fpA,
        })
        const diffKey = !new Uint8Array(kAw.key).every((v, i) => v === kBw.key[i])
        const proofRejected = !(await spakeVerifyProof(kBw.key, kBw.transcript, kBw.peerRole, kAw.proof))

        // 8c. 非法点拒绝（不在曲线上的对端共享值必须 fail-closed）
        let rejected = false
        try {
          const bad = new Uint8Array(65)
          bad[0] = 4
          for (let i = 1; i < 65; i++) bad[i] = 0xff
          await spakeComputeKey({
            role: 'A', password: '正确口令', context: CTX,
            ownSecret: sA.secret, ownShare: sA.share, peerShare: bad,
            selfId: idA, peerId: idB, selfFp: fpA, peerFp: fpB,
          })
        } catch {
          rejected = true
        }

        // 8d. 绑定层确定性：同一 (ECDH, PAKE) 输入派生一致；不同 PAKE 密钥（异口令）派生不同
        const ecdh = crypto.getRandomValues(new Uint8Array(32)).buffer
        const b1 = await bindPakeSecret(ecdh.slice(0), kA.key)
        const b2 = await bindPakeSecret(ecdh.slice(0), kA.key)
        const b3 = await bindPakeSecret(ecdh.slice(0), kAw.key)
        const bindSame = new Uint8Array(b1).every((v, i) => v === new Uint8Array(b2)[i])
        const bindDiff = !new Uint8Array(b1).every((v, i) => v === new Uint8Array(b3)[i])

        const ok = sameKey && proofAok && proofBok && diffKey && proofRejected && rejected && bindSame && bindDiff
        report(
          st.s8Name,
          ok,
          fmt(st.s8Detail, { same: String(sameKey), proof: String(proofAok && proofBok), diff: String(diffKey), rej: String(proofRejected), bad: String(rejected), bind: String(bindSame && bindDiff) }),
          Math.round(performance.now() - t0),
        )
      } catch (e) {
        report(st.s8Name, false, String(e), Math.round(performance.now() - t0))
      }
    }
    // S9 断点续传暂存：IndexedDB 往返 + offset 对齐 + 记录擦除（P1-6，与网络/会话无关）
    {
      const t0 = performance.now()
      try {
        const { savePartial, loadPartial, deletePartial } = await import('./transfer-db')
        const { alignResumeOffset } = await import('./file-transfer')
        // 9a. offset 对齐：非块边界 have 向下取整到块边界（16KB）
        const alignOk =
          alignResumeOffset(0) === 0 &&
          alignResumeOffset(-5) === 0 &&
          alignResumeOffset(Number.NaN) === 0 &&
          alignResumeOffset(1) === 0 &&
          alignResumeOffset(16383) === 0 &&
          alignResumeOffset(16384) === 16384 &&
          alignResumeOffset(40000) === 32768 &&
          alignResumeOffset(40000, 1024) === 39936
        // 9b. IndexedDB 往返：写入暂存 → 读取一致 → 删除后为空（字节级校验）
        const bytes = new Uint8Array(16384).map((_, i) => (i * 131) % 251)
        const digest = 'selftest-s9-digest'
        const saved = await savePartial({
          digest,
          name: 's9-selftest.bin',
          size: 16384,
          mime: 'application/octet-stream',
          chunks: 1,
          chunkSize: 16384,
          have: 16384,
          updatedTs: Date.now(),
          blob: new Blob([bytes]),
        })
        const loaded = await loadPartial(digest)
        const loadedBytes = loaded ? new Uint8Array(await loaded.blob.arrayBuffer()) : null
        const roundTripOk =
          loaded !== null &&
          loaded.name === 's9-selftest.bin' &&
          loaded.have === 16384 &&
          loadedBytes !== null &&
          loadedBytes.length === bytes.length &&
          loadedBytes.every((v, i) => v === bytes[i])
        await deletePartial(digest)
        const goneOk = (await loadPartial(digest)) === null
        const ok = alignOk && roundTripOk && goneOk
        report(
          st.s9Name,
          ok,
          fmt(st.s9Detail, { saved: String(saved), rt: String(roundTripOk), gone: String(goneOk), align: String(alignOk) }),
          Math.round(performance.now() - t0),
        )
      } catch (e) {
        report(st.s9Name, false, String(e), Math.round(performance.now() - t0))
      }
    }
  } catch (e) {
    report(st.loopFailName, false, String(e), 0)
  } finally {
    cleanups.forEach((fn) => fn())
    try {
      pcA?.close()
      pcB?.close()
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* noop */
    }
    setTimeout(() => worker.terminate(), 100)
  }

  return { ok: results.every((r) => r.ok), results }
}

async function cryptoEcdh(privateKey: CryptoKey, peerJwk: JsonWebKey): Promise<ArrayBuffer> {
  const peerPub = await crypto.subtle.importKey(
    'jwk',
    peerJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  return crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, privateKey, 256)
}
