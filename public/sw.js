/*
 * VeilTalk Service Worker — PWA 可安装性 + 静态资源缓存
 *
 * 策略（保守优先，P2P 通话应用的网络请求必须永不缓存污染）：
 *  - /_next/static/*（内容哈希文件名，天然不可变）与 /icons/*、/logo.svg：cache-first
 *  - 导航请求（HTML）与其它一切请求：network-first，失败时若有缓存则回退
 *  - 信令 WebSocket、/api/* 一律直接放行（never cache）——加密会话与台账必须实时
 *  - 缓存按 CACHE_VERSION 命名，activate 时清理旧版本
 */

const CACHE_VERSION = 'veiltalk-v2'
const STATIC_PATTERNS = [/^\/_next\/static\//, /^\/icons\//, /^\/logo\.svg$/]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // API 与 WebSocket 握手绝不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/svc')) return

  const isStatic = STATIC_PATTERNS.some((re) => re.test(url.pathname))

  if (isStatic) {
    // cache-first：静态资源带内容哈希
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
    return
  }

  // network-first：导航与其它资源
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && req.headers.get('accept')?.includes('text/html')) {
          const copy = res.clone()
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
  )
})
