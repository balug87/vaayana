import type { Page } from '@playwright/test';

/**
 * Chromium-only network accounting for the opt-in actual model smoke.
 * CDP encoded bytes are observed response transfer bytes, not an install-size
 * promise. Local storage estimates include all origin storage and are estimates.
 */
export async function observeTransfer(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  const requests = new Map<string, { host: string; status?: number; cached: boolean }>();
  const totals = new Map<string, { responseBytes: number; responses: number; failed: number; cached: number }>();
  session.on('Network.requestWillBeSent', (event) => {
    try {
      const url = new URL(event.request.url);
      if (url.protocol === 'https:') requests.set(event.requestId, { host: url.hostname, cached: false });
    } catch { /* data/blob URLs have no remote host. */ }
  });
  session.on('Network.responseReceived', (event) => {
    const request = requests.get(event.requestId);
    if (request) {
      request.status = event.response.status;
      request.cached = Boolean(event.response.fromDiskCache || event.response.fromServiceWorker);
    }
  });
  session.on('Network.loadingFinished', (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    const total = totals.get(request.host) ?? { responseBytes: 0, responses: 0, failed: 0, cached: 0 };
    total.responseBytes += event.encodedDataLength;
    total.responses++;
    if (request.cached) total.cached++;
    if ((request.status ?? 0) >= 400) total.failed++;
    totals.set(request.host, total);
    requests.delete(event.requestId);
  });
  session.on('Network.loadingFailed', (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    const total = totals.get(request.host) ?? { responseBytes: 0, responses: 0, failed: 0, cached: 0 };
    total.failed++;
    totals.set(request.host, total);
    requests.delete(event.requestId);
  });
  return {
    snapshot: () => Object.fromEntries(totals),
    stop: () => session.detach(),
  };
}

export async function storageFootprint(page: Page) {
  return page.evaluate(async () => {
    const estimate = await navigator.storage?.estimate?.();
    const cacheEntries: Record<string, number> = {};
    const cachePayloadBytes: Record<string, number> = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      cacheEntries[name] = keys.length;
      let bytes = 0;
      for (const request of keys) {
        const response = await cache.match(request);
        if (response) bytes += (await response.arrayBuffer()).byteLength;
      }
      cachePayloadBytes[name] = bytes;
    }
    return { usageBytes: estimate?.usage, quotaBytes: estimate?.quota, cacheEntries, cachePayloadBytes, totalCachePayloadBytes: Object.values(cachePayloadBytes).reduce((sum, bytes) => sum + bytes, 0) };
  });
}
