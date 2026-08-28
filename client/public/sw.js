// Service worker CleanLab Pro (PWA, этап 1: установка + устойчивость оболочки).
// Навигация (HTML) — network-first с fallback на кэш: всегда свежая версия,
// при кратковременной потере сети открывается закэшированная оболочка.
// Статика Next — cache-first (immutable-ассеты с хэшем в имени файла).
// /api/** не перехватываем — данные всегда живые.
// Кэширование API и офлайн-очередь действий — следующий этап, расширение этого файла.
// При изменении логики поднять CACHE_VERSION — старые кэши сотрутся в activate.

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `cleanlab-static-${CACHE_VERSION}`;
const PAGES_CACHE = `cleanlab-pages-${CACHE_VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, PAGES_CACHE];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !KNOWN_CACHES.includes(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // данные — всегда из сети

  // Навигация: network-first, кэш страниц как fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGES_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // Статика (JS/CSS/шрифты/иконки): cache-first с дозаписью в кэш
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
      )
    );
  }
});
