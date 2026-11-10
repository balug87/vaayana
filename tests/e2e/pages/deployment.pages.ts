import { expect, test, type Page } from '@playwright/test';
import { addManual, closeDetail, enableOnline, navigate } from '../helpers';
import { storageFootprint } from '../measurements';
import { artifact, expectRootSentinels, label, prepareRootSentinels, readScope, rootTarget, scopedUrl, target } from './helpers';

test.skip(!target, 'Pages QA runs only through its separate config with an explicit PAGES_QA_URL');

function watch(page: Page) {
  const requests: string[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  const assetResponses: { path: string; status: number; contentType: string }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === new URL(target!).origin) requests.push(url.pathname);
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() === 404) failures.push(url.pathname);
    if (url.origin === new URL(target!).origin && /semantic\.worker|ort-wasm/.test(url.pathname)) {
      assetResponses.push({ path: url.pathname, status: response.status(), contentType: response.headers()['content-type'] ?? '' });
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to|CSP/i.test(message.text())) errors.push(message.text()); });
  return { requests, failures, errors, assetResponses };
}

test('Pages shell, manifest, notices and offline diary are scoped without touching root caches', async ({ page, context }) => {
  const sentinels = await prepareRootSentinels(page);
  const observed = watch(page);
  await page.goto(scopedUrl());
  await expect(page.getByText('Make room for your first book', { exact: true })).toBeVisible();
  const base = new URL(target!);
  const assets = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[rel="stylesheet"],link[rel="icon"],link[rel="manifest"]')).map(element => 'src' in element ? element.src : element.href));
  for (const asset of assets) expect(new URL(asset).pathname).toMatch(new RegExp(`^${base.pathname}`));
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestUrl).toBeTruthy();
  const manifestResponse = await page.request.get(new URL(manifestUrl!, target!).href);
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json() as { id: string; start_url: string; scope: string; icons: { src: string }[] };
  for (const field of ['id', 'start_url', 'scope'] as const) {
    expect(typeof manifest[field]).toBe('string');
    expect(new URL(manifest[field], manifestResponse.url()).pathname).toBe(base.pathname);
  }
  for (const icon of manifest.icons) {
    const iconUrl = new URL(icon.src, manifestResponse.url());
    expect(iconUrl.pathname.startsWith(base.pathname)).toBe(true);
    const response = await page.request.get(iconUrl.href);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^image\//);
  }
  const notices = await page.request.get(scopedUrl('notices/'));
  expect(notices.status()).toBe(200);
  expect(await notices.text()).toMatch(/license|notice|copyright/i);
  await navigate(page, 'Settings & backup');
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const scope = await readScope(page);
  expect(scope.scope).toBe(target);
  expect(scope.controller).toBe(scopedUrl('sw.js'));
  expect(scope.script).toBe(scopedUrl('sw.js'));
  await expectRootSentinels(page, sentinels);
  expect(observed.requests.some(path => /semantic\.worker|ort-wasm|\.wasm$/.test(path))).toBe(false);
  await navigate(page, 'My library');
  const detail = await addManual(page, 'Pages Scope Diary', ['Physical'], undefined, 'Public QA');
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill('Synthetic note retained across scoped offline reload.');
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Pages Scope Diary', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Open Pages Scope Diary', exact: true }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Synthetic note retained across scoped offline reload.');
  await closeDetail(page);
  await addManual(page, 'Pages Offline Entry', ['Digital']);
  await closeDetail(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Pages Offline Entry', exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.locator('main').focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.page-content')).toHaveCSS('opacity', '1');
  await expect(page.locator('.book-tile').first()).toHaveCSS('opacity', '1');
  await expect(page.locator('.book-tile').last()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `docs/qa/pages/${label}-library.png`, fullPage: true });
  await expectRootSentinels(page, sentinels);
  expect(observed.requests.every(path => path.startsWith(base.pathname))).toBe(true);
  expect(observed.failures).toEqual([]);
  expect(observed.errors).toEqual([]);
  await artifact('shell', { target, assets: assets.map(url => new URL(url).pathname), manifest, scope, noticesStatus: notices.status(), rootSentinelsPreserved: true, offlineDiaryPassed: true, ...observed });
});

async function actualVectors(page: Page) {
  const worker = page.workers().find(worker => worker.url().includes('semantic.worker'));
  expect(worker).toBeTruthy();
  const vectors = await worker!.evaluate(async () => {
    const scope = self as unknown as { postMessage: (message: { id: number; type: string; vectors?: number[][]; error?: string }) => void; onmessage: ((event: MessageEvent) => void) | null };
    return new Promise<number[][]>((resolve, reject) => {
      const original = scope.postMessage.bind(scope);
      const timer = setTimeout(() => { scope.postMessage = original; reject(new Error('Scoped inference timed out')); }, 20000);
      scope.postMessage = message => {
        if (message.id !== -81001) { original(message); return; }
        clearTimeout(timer); scope.postMessage = original;
        if (message.type === 'vectors' && message.vectors) resolve(message.vectors);
        else reject(new Error(message.error ?? 'Scoped inference failed'));
      };
      scope.onmessage?.(new MessageEvent('message', { data: { id: -81001, type: 'embed', texts: ['Reasoning and decision making.', 'A public synthetic offline model test.'] } }));
    });
  });
  expect(vectors).toHaveLength(2);
  for (const vector of vectors) { expect(vector).toHaveLength(384); expect(vector.every(Number.isFinite)).toBe(true); }
  return { workerPath: new URL(worker!.url()).pathname, vectorCount: vectors.length, dimensions: vectors[0].length };
}

test('Pages real model/runtime stay scoped and work offline; removal preserves root caches and diary', async ({ page, context }) => {
  test.setTimeout(180000);
  const sentinels = await prepareRootSentinels(page);
  const observed = watch(page);
  await page.goto(scopedUrl());
  const detail = await addManual(page, 'Scoped Model Diary', ['Physical'], undefined, 'Public QA');
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill('Synthetic note survives scoped model removal.');
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  await enableOnline(page);
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
  const firstStart = Date.now();
  await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
  await expect(page.getByText('Semantic ready', { exact: true })).toBeVisible({ timeout: 120000 });
  const firstInitializationMs = Date.now() - firstStart;
  const onlineInference = await actualVectors(page);
  expect(onlineInference.workerPath.startsWith(new URL(target!).pathname)).toBe(true);
  const wasmResponse = observed.assetResponses.find(response => response.path.endsWith('.wasm'));
  const moduleResponse = observed.assetResponses.find(response => response.path.endsWith('.mjs'));
  expect(wasmResponse?.status).toBe(200);
  expect(wasmResponse?.contentType).toMatch(/^application\/wasm\b/);
  expect(moduleResponse?.status).toBe(200);
  expect(moduleResponse?.contentType).toMatch(/^(?:application|text)\/javascript\b/);
  const readyStorage = await storageFootprint(page);
  const scopedSemanticPrefix = `vaayana@${encodeURIComponent(new URL(target!).pathname)}-semantic-`;
  expect(Object.keys(readyStorage.cacheEntries).filter(name => name.startsWith(scopedSemanticPrefix))).toHaveLength(2);
  await expectRootSentinels(page, sentinels);
  await context.setOffline(true);
  await page.reload();
  await navigate(page, 'Settings & backup');
  await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
  const offlineStart = Date.now();
  await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
  await expect(page.getByText('Semantic ready', { exact: true })).toBeVisible({ timeout: 30000 });
  const offlineInitializationMs = Date.now() - offlineStart;
  const offlineInference = await actualVectors(page);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove model', exact: true }).click();
  await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
  await expectRootSentinels(page, sentinels);
  const removedStorage = await storageFootprint(page);
  expect(Object.keys(removedStorage.cacheEntries).some(name => name.startsWith(scopedSemanticPrefix))).toBe(false);
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Open Scoped Model Diary', exact: true }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Synthetic note survives scoped model removal.');
  await context.setOffline(false);
  expect(observed.requests.every(path => path.startsWith(new URL(target!).pathname))).toBe(true);
  expect(observed.failures).toEqual([]);
  expect(observed.errors).toEqual([]);
  await artifact('model', { target, actualModelMocked: false, firstInitializationMs, offlineInitializationMs, onlineInference, offlineInference, readyStorage, removedStorage, rootSentinelsPreserved: true, diaryPreserved: true, ...observed, wireTransferEstablished: false });
});

test('Published Pages HTTPS can perform real metadata lookup under its CSP', async ({ page }) => {
  test.skip(process.env.PAGES_QA_LIVE_PROVIDER !== '1', 'Opt-in actual public provider lookup');
  test.setTimeout(60000);
  await page.goto(scopedUrl());
  await enableOnline(page);
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Add a book', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a book', exact: true });
  await dialog.getByLabel('Search title, author or ISBN', { exact: true }).fill('Pride and Prejudice Jane Austen');
  const responsePromise = page.waitForResponse(response => response.url().startsWith('https://openlibrary.org/search.json'));
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(dialog.getByRole('button', { name: /Pride.*Prejudice/i }).first()).toBeVisible({ timeout: 20000 });
  await artifact('provider', { target, mocked: false, responseStatus: response.status(), visibleResults: await dialog.locator('.search-result').count() });
});

test('Default root app remains usable without a Pages prefix', async ({ page, context }) => {
  test.skip(!rootTarget, 'Root regression runs only when the lead provides the isolated root preview');
  await page.goto(rootTarget!);
  await addManual(page, 'Default Root Regression');
  await closeDetail(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Default Root Regression', exact: true })).toBeVisible();
  await navigate(page, 'Settings & backup');
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const scope = await readScope(page);
  expect(scope.scope).toBe(rootTarget);
  await context.setOffline(true);
  await page.reload();
  await navigate(page, 'My library');
  await expect(page.getByRole('button', { name: 'Open Default Root Regression', exact: true })).toBeVisible();
  await context.setOffline(false);
  await artifact('root-regression', { target: rootTarget, scope, manualReloadAndOfflinePassed: true });
});
