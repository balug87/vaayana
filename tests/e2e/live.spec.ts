import { expect, test } from '@playwright/test';
import { closeDetail, enableOnline, navigate, addManual } from './helpers';
import { deepenFixture, expandFixture } from './fixtures';
import { observeTransfer, storageFootprint } from './measurements';
import { writeFile } from 'node:fs/promises';

test('LIVE real Open Library lookup and both discovery lanes show sourced results', async ({ page }, testInfo) => {
  test.skip(process.env.VAAYANA_LIVE_METADATA !== '1', 'Opt-in real provider request, not part of deterministic tests');
  test.setTimeout(90000);
  const queryDiagnostics: Record<string, unknown>[] = [];
  const diagnosticReads: Promise<void>[] = [];
  page.on('response', response => {
    if (!response.url().startsWith('https://openlibrary.org/search.json')) return;
    diagnosticReads.push(response.json().then((data: { numFound?: number; docs?: { key?: string; title?: string; subject?: string[] }[] }) => {
      const query = new URL(response.url()).searchParams.get('q');
      queryDiagnostics.push({
        query, status: response.status(), numFound: data.numFound, returnedDocuments: data.docs?.length,
        ...(query?.includes('cognitive anthropology') ? {
          candidates: data.docs?.map(doc => ({
            workId: doc.key, title: doc.title, subjectCount: doc.subject?.length ?? 0,
            bridgeFirstSubjectIndex: doc.subject?.findIndex(subject => /cognitive anthropology/i.test(subject)) ?? -1,
          })),
        } : {}),
      });
    }).catch(() => {}));
  });
  await page.goto('/');
  await enableOnline(page);
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Add a book', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a book', exact: true });
  await dialog.getByLabel('Search title, author or ISBN', { exact: true }).fill('Thinking Fast and Slow Daniel Kahneman');
  const request = page.waitForResponse(response => response.url().startsWith('https://openlibrary.org/search.json'));
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const response = await request;
  expect(response.ok()).toBe(true);
  await expect(dialog.getByRole('button', { name: /Thinking.*Fast.*Slow/i }).first()).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: 'docs/qa/live-metadata.png', fullPage: true });
  const report: Record<string, unknown> = { source: 'Open Library', status: response.status(), userVisibleMetadataResults: await dialog.locator('.search-result').count(), mocked: false, interest: 'Psychology', language: 'English', noPrivateDiarySent: true };
  await writeFile('docs/qa/live-provider-measurements.json', JSON.stringify(report, null, 2));
  await closeDetail(page);
  await navigate(page, 'Discover');
  await page.getByLabel('Interests', { exact: true }).fill('Psychology');
  await page.getByRole('combobox', { name: 'Book language', exact: true }).selectOption({ label: 'English' });
  await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find my next read', exact: true })).toBeEnabled({ timeout: 40000 });
  await Promise.allSettled(diagnosticReads);
  report.providerQueryDiagnostics = queryDiagnostics;
  report.deepenResultCount = await page.locator('.recommendation-card').count();
  await writeFile('docs/qa/live-provider-measurements.json', JSON.stringify(report, null, 2));
  await expect(page.locator('.recommendation-card').first()).toBeVisible();
  report.deepenSourceUrls = await page.getByRole('link', { name: 'Source', exact: true }).evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  await expect(page.locator('.recommendation-reason').first()).toContainText(/psychology/i);
  await page.screenshot({ path: 'docs/qa/live-discovery-deepen.png', fullPage: true });
  await page.getByRole('tab', { name: /^Expand your interests/ }).click();
  report.expandResultCount = await page.locator('.recommendation-card').count();
  await writeFile('docs/qa/live-provider-measurements.json', JSON.stringify(report, null, 2));
  await expect(page.locator('.recommendation-card').first()).toBeVisible();
  report.expandSourceUrls = await page.getByRole('link', { name: 'Source', exact: true }).evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  report.expandBridge = await page.locator('.recommendation-reason').first().textContent();
  await expect(page.locator('.recommendation-reason').first()).toContainText(/From psychology to (?:cognitive )?anthropology:/i);
  if (/From psychology to anthropology:/i.test(String(report.expandBridge))) {
    expect(report.expandBridge).toContain('a broader curated bridge because cognitive anthropology returned no eligible candidates');
  }
  for (const url of [...report.deepenSourceUrls as string[], ...report.expandSourceUrls as string[]]) expect(url).toMatch(/^https:\/\/openlibrary\.org\/works\/OL\d+W$/);
  await page.screenshot({ path: 'docs/qa/live-discovery-expand.png', fullPage: true });
  await writeFile('docs/qa/live-provider-measurements.json', JSON.stringify(report, null, 2));
  await testInfo.attach('live-provider', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});

test('LIVE consented MiniLM initialization, real local rerank, cached re-enable and removal', async ({ page, context }, testInfo) => {
  test.skip(process.env.VAAYANA_LIVE_MODEL !== '1', 'Opt-in actual optional model download, not part of deterministic tests');
  test.setTimeout(180000);
  // Real model assets/inference; only candidate retrieval is explicitly synthetic.
  await page.route('https://openlibrary.org/search.json?**', route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ json: q.includes('cognitive anthropology') ? expandFixture : deepenFixture });
  });
  await page.route('https://covers.openlibrary.org/**', route => route.abort());
  const transfers = await observeTransfer(page);
  const bodies: { host: string; artifact: string; bytes: number; fromServiceWorker: boolean; responseBodyBytes?: number; responseHeaderBytes?: number }[] = [];
  const bodyReads: Promise<void>[] = [];
  context.on('response', response => {
    const url = new URL(response.url());
    if (/huggingface|hf\.co|xethub|cdn-lfs/.test(url.hostname) || /semantic\.worker|onnx|transformers|\.wasm(?:\?|$)/i.test(url.pathname)) {
      bodyReads.push((async () => {
        const body = await response.body();
        const sizes = await response.request().sizes().catch(() => undefined);
        const artifact = /xethub|cdn-lfs/.test(url.hostname) ? 'redirected model binary' : url.pathname.split('/').pop() || 'model asset';
        bodies.push({ host: url.hostname, artifact, bytes: body.length, fromServiceWorker: response.fromServiceWorker(), responseBodyBytes: sizes?.responseBodySize, responseHeaderBytes: sizes?.responseHeadersSize });
      })().catch(() => {}));
    }
  });
  const report: Record<string, unknown> = { modelAssetsMocked: false, candidateRetrievalMocked: true, inferenceDevice: 'local Chromium WASM', qualityOrPerformanceGateEstablished: false };
  try {
    await page.goto('/');
    const diary = await addManual(page, 'Local Model Smoke Diary');
    await diary.getByRole('tab', { name: 'Notes', exact: true }).click();
    await diary.getByRole('textbox', { name: 'Notes', exact: true }).fill('A public synthetic note retained after optional model removal.');
    await diary.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('notes are saved');
    await closeDetail(page);
    await enableOnline(page);
    report.browserVersion = context.browser()?.version();
    report.buildAssets = await page.evaluate(() => ({
      scripts: Array.from(document.scripts).filter(script => script.src).map(script => new URL(script.src).pathname.split('/').pop()),
      styles: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map(link => new URL(link.href).pathname.split('/').pop()),
    }));
    report.profile = 'fresh isolated Playwright browser context; no pre-existing origin caches';
    const before = await storageFootprint(page);
    report.before = before;
    expect(Object.keys(before.cacheEntries).some(name => name.startsWith('vaayana-semantic-'))).toBe(false);
    await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
    const started = Date.now();
    await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
    await expect(page.getByText('Semantic ready', { exact: true })).toBeVisible({ timeout: 140000 });
    report.firstInitializationWallMs = Date.now() - started;
    const initialized = await storageFootprint(page);
    report.afterInitialization = initialized;
    expect(Object.keys(initialized.cacheEntries).filter(name => name.startsWith('vaayana-semantic-')).length).toBeGreaterThanOrEqual(2);
    await Promise.allSettled(bodyReads);
    report.firstInitializationCompletedBodyBytes = bodies.reduce((sum, entry) => sum + entry.bytes, 0);
    report.firstInitializationObservedResponseTransferBytes = bodies.reduce((sum, entry) => sum + (entry.responseBodyBytes ?? 0) + (entry.responseHeaderBytes ?? 0), 0);
    report.transferMethod = 'Playwright completed response Request.sizes(), response body plus response headers, including dedicated-worker response events; decoded bodies and service-worker flags recorded separately. Incomplete/failed requests excluded. Browser estimates are not a universal install size.';
    const semanticWorker = page.workers().find(worker => worker.url().includes('semantic.worker'));
    expect(semanticWorker, 'UI consent must have initialized the actual dedicated worker').toBeTruthy();
    const qualityStarted = Date.now();
    const vectors = await semanticWorker!.evaluate(async () => {
      const texts = [
        'I want to understand decision making, cognitive biases, and how people can reason more clearly.',
        'A psychology book explaining cognitive biases, judgment errors, and practical ways to improve decisions.',
        'A gardening guide to pruning roses, preparing soil, and growing vegetables through the seasons.',
        'A fantasy adventure about dragons, enchanted castles, and a young warrior seeking a magical sword.',
      ];
      // Observe the real initialized worker message path. No fake model outputs
      // or production test hook: initialization already happened through UI consent.
      const scope = self as unknown as { postMessage: (value: { id: number; type: string; vectors?: number[][]; error?: string }) => void; onmessage: ((event: MessageEvent) => void) | null };
      return new Promise<number[][]>((resolve, reject) => {
        const original = scope.postMessage.bind(scope);
        const timer = setTimeout(() => { scope.postMessage = original; reject(new Error('Real embedding probe timed out')); }, 20000);
        scope.postMessage = value => {
          if (value.id !== -9001) { original(value); return; }
          scope.postMessage = original;
          clearTimeout(timer);
          if (value.type === 'vectors' && value.vectors) resolve(value.vectors);
          else reject(new Error(value.error ?? 'Real embedding probe failed'));
        };
        scope.onmessage?.(new MessageEvent('message', { data: { id: -9001, type: 'embed', texts } }));
      });
    });
    expect(vectors).toHaveLength(4);
    for (const vector of vectors) {
      expect(vector).toHaveLength(384);
      expect(vector.every(Number.isFinite)).toBe(true);
    }
    const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0)
      / Math.sqrt(a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0));
    const sanityScores = { psychology: cosine(vectors[0], vectors[1]), gardening: cosine(vectors[0], vectors[2]), dragonFiction: cosine(vectors[0], vectors[3]) };
    report.independentSanity = { scores: sanityScores, wallMs: Date.now() - qualityStarted, expectedFirst: 'psychology', establishesGeneralQuality: false };
    expect(sanityScores.psychology).toBeGreaterThan(sanityScores.gardening);
    expect(sanityScores.psychology).toBeGreaterThan(sanityScores.dragonFiction);
    await navigate(page, 'Discover');
    await page.getByLabel('Interests', { exact: true }).fill('Decision making');
    await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Decisions in Practice', exact: true })).toBeVisible();
    const rerankStarted = Date.now();
    await page.getByRole('button', { name: 'Use semantic matching', exact: true }).click();
    await expect(page.getByText('LOCAL SEMANTIC MATCH', { exact: true })).toBeVisible({ timeout: 20000 });
    report.realRerankWallMs = Date.now() - rerankStarted;
    await page.screenshot({ path: 'docs/qa/live-semantic.png', fullPage: true });
    await page.reload();
    await navigate(page, 'Settings & backup');
    await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
    const cachedStarted = Date.now();
    await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
    await expect(page.getByText('Semantic ready', { exact: true })).toBeVisible({ timeout: 30000 });
    report.cachedReenableWallMs = Date.now() - cachedStarted;
    await context.setOffline(true);
    await page.reload();
    await navigate(page, 'Settings & backup');
    await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
    const offlineStarted = Date.now();
    await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
    await Promise.race([
      page.getByText('Semantic ready', { exact: true }).waitFor({ timeout: 30000 }),
      page.getByRole('alert').waitFor({ timeout: 30000 }),
      page.getByText('Basic fallback', { exact: true }).waitFor({ timeout: 30000 }),
    ]);
    report.cachedOfflineMode = await page.locator('.mode-badge').first().textContent();
    report.cachedOfflineInitializationWallMs = Date.now() - offlineStarted;
    report.cachedOfflineError = await page.getByRole('alert').isVisible() ? await page.getByRole('alert').textContent() : undefined;
    if (await page.getByText('Semantic ready', { exact: true }).isVisible()) {
      await navigate(page, 'Discover');
      await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Use semantic matching', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Use semantic matching', exact: true }).click();
      await expect(page.getByText('LOCAL SEMANTIC MATCH', { exact: true })).toBeVisible();
      report.cachedOfflineInferenceSucceeded = true;
      await navigate(page, 'Settings & backup');
    } else report.cachedOfflineInferenceSucceeded = false;
    await context.setOffline(false);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remove model', exact: true }).click();
    await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
    const removed = await storageFootprint(page);
    report.afterRemoval = removed;
    expect(Object.keys(removed.cacheEntries).some(name => name.startsWith('vaayana-semantic-'))).toBe(false);
    for (const name of Object.keys(before.cacheEntries)) expect(removed.cacheEntries[name]).toBe(before.cacheEntries[name]);
    await navigate(page, 'My library');
    await expect(page.getByRole('button', { name: 'Open Local Model Smoke Diary', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open Local Model Smoke Diary', exact: true }).click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('A public synthetic note retained after optional model removal.');
  } finally {
    await Promise.allSettled(bodyReads);
    report.completedResponseBodyBytes = bodies.reduce((sum, entry) => sum + entry.bytes, 0);
    report.completedResponseBodies = bodies;
    report.pageSessionObservedTransfer = transfers.snapshot();
    report.transferCoverageComplete = false;
    report.transferCaveat = 'Browser response observers did not expose the ONNX binary or WASM/module transfers, and reported negative sizes for some service-worker responses. The observed transfer/body sums are partial diagnostics (and can include an internal fetch plus its service-worker delivery), not total download bytes. Use exact CacheStorage payload sums to describe complete cached assets.';
    await transfers.stop().catch(() => {});
    await writeFile('docs/qa/live-model-measurements.json', JSON.stringify(report, null, 2));
    await testInfo.attach('actual-model-measurements', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  }
});
