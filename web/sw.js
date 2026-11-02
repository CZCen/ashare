// 只缓存静态资源（网络优先，离线时用缓存）；data/*.json 一律走网络，不缓存
const C = 'ashare-static-v1';
const ASSETS = ['./', 'index.html', 'app.js', 'style.css', 'lwc.js', 'manifest.json', 'icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.includes('/data/') || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request)));
});
