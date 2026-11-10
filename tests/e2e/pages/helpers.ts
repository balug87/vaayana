import { expect, type Page } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';

export const target = process.env.PAGES_QA_URL;
export const label = process.env.PAGES_QA_LABEL ?? 'local-pages';
export const rootTarget = process.env.PAGES_QA_ROOT_URL;

export function scopedUrl(path = '') {
  if (!target) throw new Error('Set PAGES_QA_URL to the exact scoped app URL');
  return new URL(path, target).href;
}

export async function artifact(name: string, value: unknown) {
  await mkdir('docs/qa/pages', { recursive: true });
  await writeFile(`docs/qa/pages/${label}-${name}.json`, JSON.stringify(value, null, 2));
}

export async function seedRootSentinels(page: Page) {
  return page.evaluate(async () => {
    const names = [
      `workbox-precache-v2-${location.origin}/`,
      'vaayana-semantic-root-qa-sentinel',
      'vaayana-semantic-751bff37182d3f1213fa05d7196b954e230abad9',
    ];
    for (const name of names) {
      const cache = await caches.open(name);
      await cache.put(`${location.origin}/qa-root-sentinel`, new Response('Root cache must remain untouched'));
    }
    return names;
  });
}

export async function prepareRootSentinels(page: Page) {
  if (!target) throw new Error('PAGES_QA_URL missing');
  const probe = new URL('/qa-pages-origin-fixture.html', target).href;
  await page.route(probe, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated Pages cache fixture</title>' }));
  await page.goto(probe);
  const names = await seedRootSentinels(page);
  await page.unroute(probe);
  return names;
}

export async function expectRootSentinels(page: Page, names: string[]) {
  const values = await page.evaluate(async (names) => {
    const current = await caches.keys();
    const values: Record<string, string | null> = {};
    for (const name of names) {
      if (!current.includes(name)) { values[name] = null; continue; }
      const response = await (await caches.open(name)).match(`${location.origin}/qa-root-sentinel`);
      values[name] = response ? await response.text() : null;
    }
    return values;
  }, names);
  for (const name of names) expect(values[name], `Pages must not delete root-owned cache ${name}`).toBe('Root cache must remain untouched');
}

export async function readScope(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration(location.href);
    return { controller: navigator.serviceWorker.controller?.scriptURL, scope: registration?.scope, script: registration?.active?.scriptURL };
  });
}
