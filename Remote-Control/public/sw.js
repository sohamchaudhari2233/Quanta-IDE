const CACHE_NAME = 'quanta-cache-v4';
const STATIC_ASSETS = [
  '/login.html',
  '/css/style.css',
  '/css/workspace.css',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/layouts.css',
  '/js/app.js',
  '/js/workspace-ui.js',
  '/js/login.js',
  '/js/theme-init.js',
  '/js/voiceInput.js',
  '/js/offlineQueue.js',
  '/assets/bg-paper.png',
  '/assets/bg-graphite.png',
  '/assets/antigravity.png',
  '/assets/icon-192.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('[SW] Non-fatal asset caching warning for:', asset, err.message);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key.startsWith('quanta-cache-') && key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only public static files are cacheable. Never persist session, chat, pairing,
  // command or navigation responses, including routes added in the future.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.search || !STATIC_ASSETS.includes(url.pathname)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && !response.redirected) {
          const responseToCache = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
            cache.put(event.request, responseToCache)).catch(() => {}));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || Response.error())
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Quanta IDE', body: 'AI Agent status update', icon: '/assets/antigravity.png' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {}

  const options = {
    body: data.body,
    icon: data.icon || '/assets/antigravity.png',
    badge: '/assets/antigravity.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

