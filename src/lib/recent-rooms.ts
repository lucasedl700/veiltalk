'use client';

/**
 * RecentRooms — 最近房间历史（localStorage，纯本地、不上传）
 *
 * 模块职责：记录最近加入的房间号（最多 5 个），大厅提供一键回填与移除。
 * 设计为可订阅的最小存储：useSyncExternalStore 消费（getSnapshot 返回稳定引用，
 * 变更时更新 cache 并通知监听者），避免 effect 内 setState 触发的级联渲染。
 */

const KEY = 'veil-recent-rooms'
const LIMIT = 5

export interface RecentRoom {
  id: string
  ts: number
}

let cache: RecentRoom[] | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function readRaw(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as RecentRoom[]
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.id === 'string') : []
  } catch {
    return []
  }
}

function ensureCache(): RecentRoom[] {
  if (cache === null) cache = readRaw()
  return cache
}

/** useSyncExternalStore 订阅句柄 */
export function subscribeRecentRooms(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 客户端快照（稳定引用，仅在数据变化时更换） */
export function getRecentRoomsSnapshot(): RecentRoom[] {
  return ensureCache()
}

/** 服务端快照（恒为空数组，保证 hydration 一致） */
const EMPTY: RecentRoom[] = []
export function getRecentRoomsServerSnapshot(): RecentRoom[] {
  return EMPTY
}

/** 加入成功后记录/提升房间号 */
export function pushRecentRoom(id: string) {
  if (!id || typeof window === 'undefined') return
  const next = [{ id, ts: Date.now() }, ...ensureCache().filter((r) => r.id !== id)].slice(0, LIMIT)
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存储满/隐私模式忽略 */
  }
  emit()
}

/** 移除单条历史 */
export function removeRecentRoom(id: string) {
  const next = ensureCache().filter((r) => r.id !== id)
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 忽略 */
  }
  emit()
}
