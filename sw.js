// Service Worker - Cache app shell, but always re-fetch app code in dev
const CACHE_NAME = "runplanner-v4";
const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.json",
    "./icon.svg",
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            cache.addAll(APP_SHELL).catch(() => {})
        )
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);

    // Never cache: map tiles, routing API, elevation API
    if (
        url.hostname.includes("tile.openstreetmap.org") ||
        url.hostname.includes("router.project-osrm.org") ||
        url.hostname.includes("api.open-elevation.com")
    ) {
        return;
    }

    // Network-first for app code so updates are picked up immediately during dev
    if (url.pathname.endsWith("app.js") ||
        url.pathname.endsWith("index.html") ||
        url.pathname.endsWith("/")) {
        e.respondWith(
            fetch(e.request).then((res) => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone)).catch(() => {});
                }
                return res;
            }).catch(() => caches.match(e.request))
        );
        return;
    }

    // Cache-first for everything else (Leaflet CSS/JS from CDN, icons)
    e.respondWith(
        caches.match(e.request).then((cached) => {
            return cached || fetch(e.request).then((res) => {
                if (res.ok && e.request.method === "GET") {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone)).catch(() => {});
                }
                return res;
            });
        })
    );
});
