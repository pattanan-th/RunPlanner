// Service Worker - Cache app shell, but always re-fetch app code in dev
const CACHE_NAME = "runplanner-v5";
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

    // Never cache: map tiles + live routing/elevation APIs (must always hit the network so
    // re-tracing the same coords returns fresh results, not a stale cached response).
    if (
        url.hostname.includes("tile.openstreetmap.org") ||
        url.hostname.includes("brouter.de") ||          // primary routing (BRouter)
        url.hostname.includes("api.open-meteo.com") ||  // primary elevation
        url.hostname.includes("api.open-elevation.com") || // elevation fallback
        url.hostname.includes("maps.googleapis.com") ||  // Google Directions/Elevation/Maps SDK
        url.hostname.endsWith(".supabase.co")            // auth/routes REST + future Edge Functions
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
