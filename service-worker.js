// Cache strategy, by request type:
//   - App code (HTML/JS/CSS): network-first, cache as fallback. A deploy takes
//     effect on the next load without CACHE_NAME needing a hand-bump. That
//     manual bump was missed on several past deploys, which left people on a
//     stale app indefinitely.
//   - Everything else (icons, fonts, CDN): cache-first, since it rarely changes.
//
// CACHE_NAME still exists to evict old caches on activate, but correctness no
// longer depends on remembering to change it.
const CACHE_NAME = "purchases-v4";

// Same-origin only. A cross-origin URL here would be fatal: cache.addAll()
// rejects as a whole if any single request fails, so one CDN blip would mean
// nothing gets cached at all — the app's own files included.
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => k === CACHE_NAME ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// One of our own files, where serving a stale copy means shipping an old
// version of the app?
function isAppCode(request) {
  if (request.mode === "navigate") return true;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return /\.(html|js|css)$/i.test(url.pathname) || url.pathname.endsWith("/");
}

function cachePut(request, response) {
  const copy = response.clone();
  caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  if (isAppCode(request)) {
    // Network-first: take the fresh copy, keep it for offline, and fall back
    // to what we already had if the network is unavailable.
    event.respondWith(
      fetch(request)
        .then(resp => {
          if (resp && resp.ok) cachePut(request, resp);
          return resp;
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for static assets, filling the cache on first fetch.
  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(resp => {
      if (resp && resp.ok && new URL(request.url).origin === self.location.origin) {
        cachePut(request, resp);
      }
      return resp;
    }))
  );
});
