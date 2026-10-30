/**
 * VeilTalk Transfer DB — 文件断点续传的本地暂存层（IndexedDB）
 *
 * 设计（ROADMAP P1-6，第 15 轮）：
 *  - 接收端把「进行中/失败」文件的已收明文分片按 digest（SHA-256）为键暂存到 IndexedDB，
 *    会话断开/页面刷新后仍可依据 digest 匹配续传（发送端重试时按对端上报的 have 字节偏移跳过已收部分）。
 *  - 键选择 digest 而非传输 id：发送端重试会生成新 id，只有文件内容摘要才是稳定身份。
 *  - 隐私边界（E2EE.md §3.2 同步说明）：暂存的是「本端本来就要收下的文件」的明文分片，
 *    等效于浏览器磁盘缓存；密钥/会话材料永不落盘。UI 提供「清除本地暂存」一键擦除，
 *    传输完成（digestOk）后记录也会立即删除。
 *  - 全部 API 对 IndexedDB 缺失（隐私模式/旧内核）优雅降级：写入静默跳过、读取返回 null，
 *    续传协议自动退化为「从头传」，不影响传输可用性。
 */

const DB_NAME = 'veiltalk-transfers'
const DB_VERSION = 1
const STORE = 'partials'

/** 暂存记录：blob 保存从文件起点到 have 字节处的连续明文（DataChannel ordered 保证连续性） */
export interface PartialRecord {
  /** 文件 SHA-256（hex）——稳定身份键 */
  digest: string
  name: string
  size: number
  mime: string
  /** 元数据里的总块数（用于兼容性校验：CHUNK_SIZE 版本变化时旧暂存作废） */
  chunks: number
  chunkSize: number
  /** 已连续收到的字节数（始终为 chunkSize 整数倍，由对齐函数保证） */
  have: number
  updatedTs: number
  /** 已收明文（连续）；不可结构化克隆的运行环境不会走到这里（写入前有 Blob 检查） */
  blob: Blob
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'digest' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('indexeddb aborted'))
  })
}

/** 写入/合并一条暂存记录（不可用时静默跳过，返回是否真正落库） */
export async function savePartial(rec: PartialRecord): Promise<boolean> {
  if (typeof Blob === 'undefined') return false
  try {
    const db = await openDb()
    if (!db) return false
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ ...rec, updatedTs: Date.now() })
    await txDone(tx)
    db.close()
    return true
  } catch {
    return false
  }
}

/** 按 digest 读取暂存；不存在/不可用返回 null */
export async function loadPartial(digest: string): Promise<PartialRecord | null> {
  try {
    const db = await openDb()
    if (!db) return null
    const out = await new Promise<PartialRecord | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(digest)
      req.onsuccess = () => resolve((req.result as PartialRecord) || null)
      req.onerror = () => resolve(null)
    })
    db.close()
    return out
  } catch {
    return null
  }
}

/** 删除一条暂存（传输完成/校验通过后立即调用） */
export async function deletePartial(digest: string): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(digest)
    await txDone(tx)
    db.close()
  } catch {
    /* 降级：删除失败不影响主流程 */
  }
}

/** 暂存条目摘要列表（UI「本地暂存」页脚展示用，不含 blob 内容） */
export async function listPartials(): Promise<Array<Omit<PartialRecord, 'blob'>>> {
  try {
    const db = await openDb()
    if (!db) return []
    const out = await new Promise<Array<Omit<PartialRecord, 'blob'>>>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => {
        const rows = (req.result as PartialRecord[]) || []
        resolve(rows.map(({ blob: _blob, ...rest }) => rest))
      }
      req.onerror = () => resolve([])
    })
    db.close()
    return out
  } catch {
    return []
  }
}

/** 一键擦除全部本地暂存（UI「清除本地暂存」按钮） */
export async function clearPartials(): Promise<number> {
  try {
    const before = await listPartials()
    const db = await openDb()
    if (!db) return 0
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
    db.close()
    return before.length
  } catch {
    return 0
  }
}
