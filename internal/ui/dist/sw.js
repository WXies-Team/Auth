// 只缓存带内容哈希的静态资产；HTML 与 API 永远走网络，避免登录态/配置陈旧。
const CACHE = 'auth-static-v1'
self.addEventListener('install', (e) => {
  // 离线兜底页先入缓存：导航失败时才有东西可回。
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/offline.html'])).catch(() => {}))
  self.skipWaiting()
})
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  // 导航请求离线时回固定说明页：不缓存 HTML/API，避免把登录态或旧配置端上桌。
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')))
    return
  }
  const cacheable = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icon-') || url.pathname === '/favicon.svg' || url.pathname === '/theme.js' || url.pathname === '/offline.html'
  if (!cacheable) return
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, copy))
        }
        return res
      })
    }),
  )
})
