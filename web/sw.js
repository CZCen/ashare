// 静态资源网络优先（离线用缓存）；lwc.js（图表库，体积大、内容不变）缓存优先，首次按需加载后即缓存；data/*.json 一律走网络、不缓存
const C = 'ashare-static-v5';
const ASSETS = ['./', 'index.html', 'app.js', 'style.css', 'manifest.json', 'icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== 'ashare-lwc').map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.includes('/data/') || e.request.method !== 'GET') return;
  if (u.pathname.endsWith('/lwc.js')) {
    e.respondWith(caches.open('ashare-lwc').then(c => c.match(e.request, { ignoreSearch: true }).then(hit => hit ||
      fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request)));
});
