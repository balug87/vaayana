import { expect, test } from '@playwright/test';
import { addManual, closeDetail, enableOnline, navigate, setPreference } from './helpers';
import { mockLookup } from './fixtures';
import { writeFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block' });

test('online and cover controls stop fresh provider and cover requests after reload', async ({ page }) => {
  const unexpected: string[] = [];
  await page.route('https://**/*', route => { unexpected.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  await addManual(page, 'Private Notes Never Leave');
  await closeDetail(page);
  await navigate(page, 'Settings & backup');
  await setPreference(page, /^Online lookup/, false);
  await setPreference(page, /^Load book covers/, false);
  await page.reload();
  await navigate(page, 'Discover');
  await page.getByLabel('Interests', { exact: true }).fill('Astronomy');
  await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
  await expect(page.getByText(/Online lookup is off/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find my next read', exact: true })).toBeEnabled();
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Open Private Notes Never Leave', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh metadata', exact: true })).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test('optional model requires consent and unsupported-worker failure preserves baseline', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { configurable: true, value: undefined }); });
  const remote: string[] = [];
  await page.route('https://**/*', route => { remote.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  await addManual(page, 'Baseline Survives Without AI');
  await closeDetail(page);
  await enableOnline(page);
  const download = page.getByRole('button', { name: 'Download optional model', exact: true });
  await expect(download).toBeDisabled();
  await expect(page.getByText('Rule-based', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
  await download.click();
  await expect(page.getByText('Basic fallback', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The local semantic model is ready.' })).toHaveCount(0);
  await navigate(page, 'My library');
  await expect(page.getByRole('button', { name: 'Open Baseline Survives Without AI', exact: true })).toBeVisible();
  expect(remote).toEqual([]);
});

test('mocked stalled model worker can be cancelled without changing the diary', async ({ page }) => {
  await page.addInitScript(() => {
    class StalledWorker {
      onmessage = null;
      onerror = null;
      postMessage() {}
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: StalledWorker });
  });
  await page.goto('/');
  await addManual(page, 'A Model Is Optional');
  await closeDetail(page);
  await enableOnline(page);
  await page.getByRole('checkbox', { name: /^I agree to download the optional model/ }).check();
  await page.getByRole('button', { name: 'Download optional model', exact: true }).click();
  await expect(page.getByText('Downloading', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel model download', exact: true }).click();
  await expect(page.getByText('Basic fallback', { exact: true })).toBeVisible();
  await navigate(page, 'My library');
  await expect(page.getByRole('button', { name: 'Open A Model Is Optional', exact: true })).toBeVisible();
});

test('stalled mock cover request is cancelled when cover loading is disabled', async ({ page }) => {
  await mockLookup(page);
  let coverStarted!: () => void;
  const started = new Promise<void>(resolve => { coverStarted = resolve; });
  let releaseCover!: () => void;
  const release = new Promise<void>(resolve => { releaseCover = resolve; });
  const cancelled: string[] = [];
  const finished: string[] = [];
  page.on('requestfailed', request => { if (request.url().includes('covers.openlibrary.org')) cancelled.push(request.url()); });
  page.on('requestfinished', request => { if (request.url().includes('covers.openlibrary.org')) finished.push(request.url()); });
  await page.route('https://covers.openlibrary.org/**', async route => {
    coverStarted();
    await release;
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }).catch(() => {});
  });
  try {
    await page.goto('/');
    await enableOnline(page);
    await setPreference(page, /^Load book covers/, true);
    await navigate(page, 'My library');
    await page.getByRole('button', { name: 'Add a book', exact: true }).first().click();
    const add = page.getByRole('dialog', { name: 'Add a book', exact: true });
    await add.getByLabel('Search title, author or ISBN', { exact: true }).fill('Thinking');
    await add.getByRole('button', { name: 'Search', exact: true }).click();
    await started;
    await closeDetail(page);
    await navigate(page, 'Settings & backup');
    await setPreference(page, /^Load book covers/, false);
    releaseCover();
    await expect.poll(() => cancelled.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(finished, 'Disabled cover loading should not consume the stalled image response').toEqual([]);
  } finally {
    releaseCover();
    await writeFile('docs/qa/cover-privacy-observation.json', JSON.stringify({
      fixture: 'synthetic stalled Open Library cover response',
      cancelledRequests: cancelled.length,
      finishedRequests: finished.length,
      liveProviderContacted: false,
    }, null, 2));
  }
});
