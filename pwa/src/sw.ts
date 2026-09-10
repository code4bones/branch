/// <reference lib="webworker" />

import { pwaReleaseVersion } from "./app/pwa-release.js";

declare const self: ServiceWorkerGlobalScope;

// Bump on every shell-affecting release so activate() drops the previous cache
// instead of serving a stale mix of old and new assets.
const SHELL_CACHE_NAME = `branch-pwa-shell-${pwaReleaseVersion}`;

const SHELL_ASSETS: readonly string[] = [
  "/pwa/",
  "/pwa/index.html",
  "/pwa/manifest.json",
  "/pwa/branch_logo4.png",
  "/pwa/pwa-app.css",
  "/pwa/pwa.css",
  "/pwa/pwa-app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE_NAME);
      await cache.addAll([...SHELL_ASSETS]);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== SHELL_CACHE_NAME)
          .map(async (cacheName) => { await caches.delete(cacheName); })
      );
      await self.clients.claim();
    })()
  );
});

// Only the static app shell under /pwa/ is ever cached here. Carrier search
// (api.github.com, gitlab.com) and relay WSS traffic are cross-origin or
// non-GET/non-fetch and never pass through this handler, so discovery and
// live transport always hit the network per the relay non-durable boundary.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/pwa/")) {
    return;
  }

  event.respondWith(handleShellRequest(request));
});

async function handleShellRequest(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(request);

  if (cached !== undefined) {
    void refreshInBackground(cache, request);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const fallback = await cache.match("/pwa/index.html");
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function refreshInBackground(cache: Cache, request: Request): Promise<void> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response);
    }
  } catch {
    // Offline or mirror unreachable: keep serving the cached shell until a
    // network fetch succeeds again. Never treat this as a fatal error.
  }
}
