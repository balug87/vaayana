/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches, getCacheKeyForURL } from 'workbox-precaching';
import { SEMANTIC_RUNTIME_CACHE } from './services/semantic-info';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string | null }> };
const manifest = self.__WB_MANIFEST;
precacheAndRoute(manifest);
cleanupOutdatedCaches();
self.skipWaiting();
clientsClaim();

// Optional runtime assets are cached only when consent constructs the real worker.
// They are deliberately absent from initial precaching and use the model-removal prefix.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
    !url.pathname.startsWith(new URL('assets/', self.registration.scope).pathname) ||
    !/\/assets\/(?:semantic\.worker-[^/]+\.js|ort-wasm-[^/]+\.(?:wasm|mjs))$/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SEMANTIC_RUNTIME_CACHE);
    const saved = await cache.match(event.request);
    if (saved) return saved;
    const response = await fetch(event.request);
    if (response.ok) {
      event.waitUntil((async () => {
        try {
          await cache.put(event.request, response.clone());
          const keys = await cache.keys();
          for (const old of keys.slice(0, Math.max(0, keys.length - 6))) await cache.delete(old);
        } catch { /* Quota failure must not break a successful online inference. */ }
      })());
    }
    return response;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CHECK_OFFLINE') return;
  event.waitUntil((async () => {
    const present = await Promise.all(manifest.map(async (entry) => {
      const url = typeof entry === 'string' ? entry : entry.url;
      const key = getCacheKeyForURL(url);
      return key ? Boolean(await caches.match(key)) : false;
    }));
    event.ports[0]?.postMessage({ ready: present.length > 0 && present.every(Boolean), assets: present.length });
  })());
});
