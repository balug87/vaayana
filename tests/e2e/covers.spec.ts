import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { BackupDocument } from '../../src/domain/types';
import { addManual, closeDetail, exportBackup, navigate, setPreference } from './helpers';
import { fileUpload, mockLookup } from './fixtures';

// Synthetic books only. No persistent profiles, recordings or real collections.
test.use({ serviceWorkers: 'block', trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(60_000);

const inventedCatalog = {
  books: [
    { title: 'Synthetic Cover Atlas', author: 'Synthetic QA Author' },
    { title: 'Synthetic Cover Without Author', author: null },
  ],
};

async function blockExternalRequests(page: Page, baseURL: string) {
  const unexpected: { origin: string; method: string }[] = [];
  const allowedOrigin = new URL(baseURL).origin;
  await page.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin === allowedOrigin) await route.continue();
    else {
      unexpected.push({ origin: new URL(request.url()).origin, method: request.method() });
      await route.abort();
    }
  });
  return unexpected;
}

async function previewInventedCatalog(page: Page, document: unknown = inventedCatalog) {
  await navigate(page, 'Settings & backup');
  await page.getByLabel('Import backup or catalog', { exact: true }).setInputFiles(
    fileUpload('synthetic-cover-catalog.json', JSON.stringify(document)),
  );
  await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).toBeVisible();
}

test('automatic cover fetching starts off and manual or imported books never contact providers without consent', async ({ page, baseURL }) => {
  const unexpected = await blockExternalRequests(page, baseURL!);
  await page.goto('./');
  await addManual(page, 'Synthetic Manual Cover', ['Physical']);
  await closeDetail(page);
  await previewInventedCatalog(page);
  await page.getByRole('checkbox', { name: /^I reviewed the catalog/ }).check();
  await page.getByRole('button', { name: 'Import reviewed catalog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
  await navigate(page, 'My library');
  for (const title of ['Synthetic Manual Cover', ...inventedCatalog.books.map(book => book.title)]) {
    await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
  }
  await page.reload();
  const exported = (await exportBackup(page)).document;
  expect(exported.entities.works).toHaveLength(3);
  expect(exported.entities.settings.find(row => row.id === 'preferences')?.value).toMatchObject({
    onlineAccess: false, loadCovers: false, autoFetchCovers: false,
  });
  expect(unexpected).toEqual([]);
});

type MockResult = 'found' | 'missing' | 'ambiguous' | 'invalid' | 'hold' | 'symbol-collision';
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function mockCoverNetwork(context: BrowserContext, baseURL: string, results: Record<string, MockResult>, holdAfter = Infinity) {
  const queries: string[] = [];
  const requests: { url: string; method: string; body: string | null; referer?: string }[] = [];
  const unexpected: string[] = [];
  let released = false;
  const held = new Map<number, () => void>();
  const release = () => {
    released = true;
    for (const finish of held.values()) finish();
    held.clear();
  };
  const releaseQuery = (number: number) => {
    const finish = held.get(number);
    if (!finish) throw new Error(`Synthetic held request ${number} was not pending`);
    finish(); held.delete(number);
  };
  context.on('request', request => {
    if (new URL(request.url()).origin !== new URL(baseURL).origin) {
      requests.push({ url: request.url(), method: request.method(), body: request.postData(), referer: request.headers().referer });
    }
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(baseURL).origin) return route.continue();
    if (url.origin === 'https://covers.openlibrary.org') {
      return route.fulfill({ contentType: 'image/png', body: tinyPng, headers: { 'access-control-allow-origin': '*' } }).catch(() => {});
    }
    if (url.origin !== 'https://openlibrary.org' || url.pathname !== '/search.json') {
      unexpected.push(url.origin + url.pathname);
      return route.abort();
    }
    const query = url.searchParams.get('q') ?? '';
    const title = query.match(/^title:"(.*?)" AND author:"/)?.[1] ?? '';
    const author = query.match(/ AND author:"(.*)"$/)?.[1] ?? '';
    queries.push(title);
    const queryNumber = queries.length;
    if (!Object.hasOwn(results, title)) {
      unexpected.push('unexpected synthetic title lookup');
      return route.abort();
    }
    const mode = queries.length > holdAfter ? 'hold' : results[title];
    if (mode === 'hold' && !released) await new Promise<void>(resolve => { held.set(queryNumber, resolve); });
    const doc = {
      key: '/works/OL7001W',
      title: mode === 'symbol-collision' ? title.replace('C++:', 'C:') : title,
      author_name: [author], cover_i: mode === 'hold' ? 7000 + queryNumber : 7001,
    };
    const docs = mode === 'ambiguous' ? [doc, { ...doc, key: '/works/OL7002W', cover_i: 7002 }]
      : mode === 'missing' ? [] : [doc];
    const json = mode === 'invalid' ? { invalid: 'Synthetic malformed provider response' }
      : { numFound: docs.length, start: 0, numFoundExact: true, docs };
    await route.fulfill({ json, headers: { 'access-control-allow-origin': '*' } }).catch(() => {});
  });
  return { queries, requests, unexpected, release, releaseQuery };
}

function expectPrivateNetwork(network: Awaited<ReturnType<typeof mockCoverNetwork>>, forbidden: string[] = []) {
  expect(network.unexpected).toEqual([]);
  for (const request of network.requests) {
    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
    expect(request.referer).toBeUndefined();
    for (const text of forbidden) expect(request.url).not.toContain(encodeURIComponent(text));
  }
}

async function commitCatalog(page: Page) {
  await page.getByRole('checkbox', { name: /^I reviewed the catalog/ }).check();
  await page.getByRole('button', { name: 'Import reviewed catalog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
}

async function enableAutomaticCovers(page: Page) {
  await navigate(page, 'Settings & backup');
  await setPreference(page, /^Automatically fetch book covers/, true);
  await expect(page.getByRole('checkbox', { name: /^Online lookup/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Load book covers/ })).toBeChecked();
}

async function waitForProviderCovers(page: Page, count: number) {
  await expect.poll(async () => {
    const document = (await exportBackup(page)).document;
    return document.entities.coverStates.filter(state => state.provider).length;
  }, { timeout: 20_000, intervals: [200, 500, 1000] }).toBe(count);
}

function expectProtectedLibrary(before: BackupDocument, after: BackupDocument) {
  for (const table of [
    'works', 'editions', 'identifiers', 'holdings', 'metadataSnapshots', 'fieldOverrides',
    'notes', 'readingCycles', 'sessions', 'statusEvents', 'goals', 'tags', 'tagAssignments',
    'layerAssignments', 'personalRatings', 'importReceipts',
  ] as const) expect(after.entities[table], `Cover operations must not change ${table}`).toEqual(before.entities[table]);
  expect(Object.keys(after.entities)).not.toContain('coverJobs');
}

async function syntheticPhoto(page: Page, mimeType = 'image/png', color = '#996633') {
  const base64 = await page.evaluate(({ mimeType, color }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 768; canvas.height = 1024;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff'; context.fillRect(20, 20, 40, 70);
    return canvas.toDataURL(mimeType).split(',')[1];
  }, { mimeType, color });
  return { name: 'synthetic-local-photo-marker.' + mimeType.split('/')[1], mimeType, buffer: Buffer.from(base64, 'base64') };
}

async function openBook(page: Page, title: string) {
  await navigate(page, 'My library');
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  return page.getByRole('dialog', { name: title, exact: true });
}

async function expectDecodedCover(page: Page) {
  await expect.poll(() => page.getByRole('dialog').locator('.book-cover img').first().evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  ), { timeout: 10_000 }).toBe(true);
}

test('opt-in covers existing and newly imported books, skips uncertainty and never mutates bibliography or history', async ({ page, context, browser, baseURL }) => {
  const title = 'Synthetic Existing Cover Match';
  const later = 'Synthetic Later Cover Match';
  const ambiguous = 'Synthetic Ambiguous Cover Match';
  const broken = 'Synthetic Broken Cover Response';
  const missing = 'Synthetic Missing Cover Match';
  const distinct = 'C++: The Invented Field Guide';
  const network = await mockCoverNetwork(context, baseURL!, {
    [title]: 'found', [later]: 'found', [ambiguous]: 'ambiguous', [broken]: 'invalid', [missing]: 'missing',
    [distinct]: 'symbol-collision',
  });
  await page.goto('./');
  const detail = await addManual(page, title);
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  const diaryMarker = 'Synthetic diary text never belongs in a provider query.';
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill(diaryMarker);
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  const before = (await exportBackup(page)).document;
  await enableAutomaticCovers(page);
  await waitForProviderCovers(page, 1);
  expectProtectedLibrary(before, (await exportBackup(page)).document);
  await previewInventedCatalog(page, { books: [
    { title: later, author: 'Synthetic QA Author' }, { title: ambiguous, author: 'Synthetic QA Author' },
    { title: broken, author: 'Synthetic QA Author' }, { title: missing, author: 'Synthetic QA Author' },
    { title: distinct, author: 'Synthetic QA Author' },
    { title: 'Synthetic Unknown Cover Author', author: null },
  ] });
  await commitCatalog(page);
  await waitForProviderCovers(page, 2);
  await expect(page.getByText(/^Covers needing attention \(/)).toBeVisible();
  await expect.poll(() => network.queries.length, { timeout: 20_000 }).toBe(6);
  await page.reload();
  await expect(page.getByLabel('Cover fetching status', { exact: true })).toBeVisible();
  const exported = (await exportBackup(page)).document;
  expect(exported.entities.works).toHaveLength(7);
  expect(exported.entities.coverStates.filter(state => state.provider)).toHaveLength(2);
  expect(exported.entities.sessions).toEqual(before.entities.sessions);
  expect(exported.entities.notes).toEqual(before.entities.notes);
  expect(exported.schemaVersion).toBe(3);
  expect(exported.formatVersion).toBe(1);
  expect(network.queries).not.toContain('Synthetic Unknown Cover Author');
  expect(new Set(network.queries).size).toBe(network.queries.length);
  expectPrivateNetwork(network, [diaryMarker, 'synthetic-local-photo-marker']);
  const destination = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  try {
    const nextNetwork = await mockCoverNetwork(destination, baseURL!, {});
    const next = await destination.newPage();
    await next.goto('./');
    await navigate(next, 'Settings & backup');
    await next.getByLabel('Import backup or catalog', { exact: true }).setInputFiles(fileUpload('synthetic-provider-covers.json', JSON.stringify(exported)));
    await expect(next.getByRole('heading', { name: 'Review import before writing', exact: true })).toBeVisible();
    await next.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
    await next.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
    await expect(next.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
    await expect(next.getByRole('checkbox', { name: /^Automatically fetch book covers/ })).not.toBeChecked();
    const roundtrip = (await exportBackup(next)).document;
    expect(roundtrip.entities.coverStates).toEqual(exported.entities.coverStates);
    expect(roundtrip.entities.settings.find(row => row.id === 'preferences')?.value.autoFetchCovers).toBe(false);
    expect(nextNetwork.queries).toEqual([]);
    expectPrivateNetwork(nextNetwork, [diaryMarker]);
  } finally { await destination.close(); }
});

test('cancelling persists through reload and a new catalog until explicitly resumed', async ({ page, context, baseURL }) => {
  const title = 'Synthetic Paused Cover Match';
  const later = 'Synthetic Paused Imported Cover';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold', [later]: 'found' });
  try {
    await page.goto('./');
    await addManual(page, title); await closeDetail(page);
    await enableAutomaticCovers(page);
    await expect.poll(() => network.queries.length).toBe(1);
    await page.getByRole('button', { name: 'Cancel cover fetching', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    await previewInventedCatalog(page, { books: [{ title: later, author: 'Synthetic QA Author' }] });
    await commitCatalog(page);
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    expect(network.queries).toEqual([title]);
    network.release();
    expect((await exportBackup(page)).document.entities.coverStates).toHaveLength(0);
    await page.getByRole('button', { name: 'Resume cover fetching', exact: true }).click();
    await waitForProviderCovers(page, 2);
    expect(network.queries).toContain(later);
    expect(network.queries.filter(query => query === title)).toHaveLength(2);
    expectPrivateNetwork(network);
  } finally { network.release(); }
});

test('a persistent cover-claim storage failure halts until an explicit retry after storage recovers', async ({ page, context, baseURL }) => {
  const title = 'Synthetic Cover Storage Recovery';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'found' });
  await page.addInitScript(() => {
    const state = { enabled: true, attempts: 0 };
    Object.defineProperty(window, '__qaCoverQuota', { value: state });
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'coverJobs' && state.enabled) {
        state.attempts++;
        throw new DOMException('Synthetic cover claim quota failure', 'QuotaExceededError');
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.goto('./');
  await addManual(page, title); await closeDetail(page);
  const before = (await exportBackup(page)).document;
  await enableAutomaticCovers(page);
  await expect(page.getByRole('alert').filter({ hasText: /storage|cover/i }).first()).toBeVisible();
  const attempts = () => page.evaluate(() =>
    (window as unknown as { __qaCoverQuota: { attempts: number } }).__qaCoverQuota.attempts);
  // The explicit opt-in may retry its own first claim once before the halt latches;
  // an automatic loop would keep counting beyond that bounded pair.
  const settled = await attempts();
  expect(settled).toBeGreaterThanOrEqual(1);
  expect(settled).toBeLessThanOrEqual(2);
  for (let change = 0; change < 3; change++) {
    await navigate(page, 'My library');
    await navigate(page, 'Settings & backup');
    await expect(page.getByRole('alert').filter({ hasText: /storage|cover/i }).first()).toBeVisible();
  }
  // Mounts, renders and navigations must never trigger another attempt.
  expect(await attempts()).toBe(settled);
  expect(network.queries).toEqual([]);
  await page.evaluate(() => {
    (window as unknown as { __qaCoverQuota: { enabled: boolean } }).__qaCoverQuota.enabled = false;
  });
  await page.getByRole('button', { name: 'Fetch missing covers', exact: true }).click();
  await waitForProviderCovers(page, 1);
  expect(await attempts()).toBe(settled);
  expectProtectedLibrary(before, (await exportBackup(page)).document);
  expect(network.queries).toEqual([title]);
  expectPrivateNetwork(network);
});

test('going offline mid-lookup pauses safely and reconnecting resumes without a manual retry or failed job', async ({ page, context, baseURL }) => {
  const title = 'Synthetic Reconnected Cover Match';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold' });
  try {
    await page.goto('./');
    await addManual(page, title); await closeDetail(page);
    await enableAutomaticCovers(page);
    await expect.poll(() => network.queries.length).toBe(1);
    await context.setOffline(true);
    const status = page.getByLabel('Cover fetching status', { exact: true });
    await expect(status).toContainText('Offline');
    await expect(status).toContainText('0 cancelled');
    await expect(status).toContainText('0 failed');
    network.release();
    expect((await exportBackup(page)).document.entities.coverStates).toHaveLength(0);
    await context.setOffline(false);
    await waitForProviderCovers(page, 1);
    await expect(status).toContainText('1 found');
    await expect(status).toContainText('0 cancelled');
    await expect(status).toContainText('0 failed');
    expect(network.queries.every(query => query === title)).toBe(true);
    // An in-flight HTTP request may need one replay after network loss, but the
    // one logical cover job must not fail, cancel or start an automatic loop.
    expect(network.queries.length).toBeLessThanOrEqual(2);
    expectPrivateNetwork(network);
  } finally { network.release(); await context.setOffline(false); }
});

test('a 325-book fictional catalog preserves bounded progress through cancel, reload, a new entry and resume', async ({ page, context, baseURL }) => {
  const books = Array.from({ length: 325 }, (_, index) => ({
    title: `Synthetic Scale Cover ${String(index + 1).padStart(3, '0')}`, author: 'Synthetic Scale Author',
  }));
  const added = { title: 'Synthetic Scale Later Entry', author: 'Synthetic Scale Author' };
  const results = Object.fromEntries([...books, added].map(book => [book.title, 'found' as const]));
  // Finish one request, hold the next. Real scheduling is exercised only for a
  // few books; the service's fake-clock tests own full-queue throughput coverage.
  const network = await mockCoverNetwork(context, baseURL!, results, 1);
  try {
    await page.goto('./');
    await previewInventedCatalog(page, { books, total_unique_titles: 325 });
    await commitCatalog(page);
    await enableAutomaticCovers(page);
    await expect.poll(() => network.queries.length, { timeout: 20_000 }).toBe(2);
    await page.getByRole('button', { name: 'Cancel cover fetching', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    network.release();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    const checkpoint = (await exportBackup(page)).document;
    expect(checkpoint.entities.works).toHaveLength(325);
    expect(checkpoint.entities.coverStates.filter(state => state.provider)).toHaveLength(1);
    await previewInventedCatalog(page, { books: [added] });
    await commitCatalog(page);
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    expect(network.queries).toHaveLength(2);
    await page.getByRole('button', { name: 'Resume cover fetching', exact: true }).click();
    await expect.poll(() => network.queries.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: 'Cancel cover fetching', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume cover fetching', exact: true })).toBeVisible();
    const final = (await exportBackup(page)).document;
    expect(final.entities.works).toHaveLength(326);
    expect(network.queries.filter(title => title === network.queries[0])).toHaveLength(1);
    // Resume explicitly retries the cancelled item; completed successes never
    // repeat, and no item is retried twice by this one resume action.
    for (const title of new Set(network.queries)) expect(network.queries.filter(query => query === title).length).toBeLessThanOrEqual(2);
    expect(final.entities.sessions).toHaveLength(0);
    expect(final.entities.readingCycles).toHaveLength(0);
    expect(final.entities.notes).toHaveLength(0);
    expectPrivateNetwork(network);
  } finally { network.release(); }
});

for (const toggle of ['Automatically fetch book covers', 'Online lookup', 'Load book covers']) {
  test(`turning off ${toggle} cancels a pending lookup and discards its late result`, async ({ page, context, baseURL }) => {
    const title = 'Synthetic Revoked Cover Match';
    const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold' });
    try {
      await page.goto('./');
      await addManual(page, title); await closeDetail(page);
      await enableAutomaticCovers(page);
      await expect.poll(() => network.queries.length).toBe(1);
      await setPreference(page, new RegExp(`^${toggle}`), false);
      await page.reload();
      const exported = (await exportBackup(page)).document;
      expect(exported.entities.coverStates).toHaveLength(0);
      expect(network.queries).toEqual([title]);
      if (toggle === 'Automatically fetch book covers') {
        await expect(page.getByRole('checkbox', { name: /^Load book covers/ })).not.toBeChecked();
      }
      await setPreference(page, new RegExp(`^${toggle}`), true);
      await page.getByRole('button', { name: 'Fetch missing covers', exact: true }).click();
      // Explicit retry must acquire a fresh claim now, not wait five minutes for
      // the cancelled request's lease. Hold the NEW response separately.
      await expect.poll(() => network.queries.length, { timeout: 10_000 }).toBe(2);
      network.releaseQuery(1);
      expect((await exportBackup(page)).document.entities.coverStates).toHaveLength(0);
      network.release();
      await waitForProviderCovers(page, 1);
      const resumed = (await exportBackup(page)).document;
      expect(resumed.entities.coverStates[0].provider?.coverId).toBe(7002);
      expect(network.queries).toEqual([title, title]);
      expectPrivateNetwork(network);
    } finally { network.release(); }
  });
}

for (const withoutLocks of [false, true]) {
  test(`two tabs share one cover claim${withoutLocks ? ' without Web Locks' : ''}`, async ({ page, context, baseURL }) => {
    const title = 'Synthetic Shared Cover Claim';
    const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold' });
    if (withoutLocks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    let second: Page | undefined;
    try {
      await page.goto('./');
      await addManual(page, title); await closeDetail(page);
      await enableAutomaticCovers(page);
      await expect.poll(() => network.queries.length).toBe(1);
      second = await context.newPage();
      await second.goto('./');
      await navigate(second, 'Settings & backup');
      await expect(second.getByRole('checkbox', { name: /^Automatically fetch book covers/ })).toBeChecked();
      await expect(second.getByLabel('Cover fetching status', { exact: true })).toBeVisible();
      expect(network.queries).toEqual([title]);
      network.release();
      await waitForProviderCovers(second, 1);
      const result = (await exportBackup(second)).document;
      expect(result.entities.works).toHaveLength(1);
      expect(result.entities.coverStates).toHaveLength(1);
      expect(network.queries).toEqual([title]);
      expectPrivateNetwork(network);
    } finally { network.release(); await second?.close(); }
  });
}

test('a photo uploaded during provider lookup wins over the late response', async ({ page, context, baseURL }) => {
  const title = 'Synthetic Photo Wins Race';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold' });
  try {
    await page.goto('./');
    await addManual(page, title); await closeDetail(page);
    await enableAutomaticCovers(page);
    await expect.poll(() => network.queries.length).toBe(1);
    const detail = await openBook(page, title);
    await detail.getByLabel('Upload cover photo', { exact: true }).setInputFiles(await syntheticPhoto(page));
    await expect(detail.getByRole('button', { name: 'Remove custom cover', exact: true })).toBeVisible();
    await expectDecodedCover(page);
    await closeDetail(page);
    const uploaded = (await exportBackup(page)).document.entities.coverStates[0];
    expect(uploaded.uploaded).toBeTruthy();
    network.release();
    await page.reload();
    expect((await exportBackup(page)).document.entities.coverStates[0]).toEqual(uploaded);
    await mockLookup(page, true);
    const refreshed = await openBook(page, title);
    await refreshed.getByRole('tab', { name: 'Sources', exact: true }).click();
    await refreshed.getByRole('button', { name: 'Refresh metadata', exact: true }).click();
    await refreshed.getByRole('button', { name: /Updated Provider Title/ }).click();
    await expect(refreshed.getByRole('heading', { name: 'Review provider changes', exact: true })).toBeVisible();
    await refreshed.getByRole('button', { name: 'Apply provider refresh', exact: true }).click();
    await closeDetail(page);
    expect((await exportBackup(page)).document.entities.coverStates[0]).toEqual(uploaded);
    expectPrivateNetwork(network, ['synthetic-local-photo-marker']);
  } finally { network.release(); }
});

test('editing bibliography during lookup never applies the old identity result', async ({ page, context, baseURL }) => {
  const title = 'Synthetic Old Cover Identity';
  const renamed = 'Synthetic New Cover Identity';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold', [renamed]: 'missing' });
  try {
    await page.goto('./');
    await addManual(page, title); await closeDetail(page);
    await enableAutomaticCovers(page);
    await expect.poll(() => network.queries.length).toBe(1);
    const detail = await openBook(page, title);
    await detail.getByLabel('Title', { exact: true }).fill(renamed);
    await detail.getByRole('button', { name: 'Save details', exact: true }).click();
    await closeDetail(page);
    network.release();
    await expect.poll(() => network.queries.includes(renamed), { timeout: 20_000 }).toBe(true);
    const result = (await exportBackup(page)).document;
    expect(result.entities.works).toHaveLength(1);
    expect(result.entities.coverStates.filter(state => state.provider)).toHaveLength(0);
    expect(result.entities.fieldOverrides.some(row => row.field === 'title' && row.value === renamed)).toBe(true);
    expectPrivateNetwork(network);
  } finally { network.release(); }
});

test('an imported book deletion prevents the pending provider answer from recreating it', async ({ page, context, baseURL }) => {
  const title = 'The Invented Observatory';
  const network = await mockCoverNetwork(context, baseURL!, { [title]: 'hold' });
  try {
    await page.goto('./');
    await navigate(page, 'Settings & backup');
    for (const snapshot of ['before', 'after']) {
      await page.getByLabel('Import backup or catalog', { exact: true }).setInputFiles(
        fileURLToPath(new URL(`./fixtures/catalog-deletion-${snapshot}.backup.json`, import.meta.url)),
      );
      await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).toBeVisible();
      if (snapshot === 'after') {
        for (const choice of await page.getByRole('combobox', { name: /^Resolve / }).all()) await choice.selectOption('use-import');
      }
      await page.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
      await page.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
      if (snapshot === 'before') {
        expect((await exportBackup(page)).document.schemaVersion).toBe(3);
        await enableAutomaticCovers(page);
        await expect.poll(() => network.queries.length).toBe(1);
      }
    }
    network.release();
    await page.reload();
    const result = (await exportBackup(page)).document;
    expect(result.entities.works).toHaveLength(0);
    expect(result.entities.coverStates).toHaveLength(0);
    expect(network.queries).toEqual([title]);
    expectPrivateNetwork(network);
  } finally { network.release(); }
});

test.describe('portable local cover photos', () => {
  test.use({ serviceWorkers: 'allow' });
  test('JPEG, PNG and WebP normalize locally, failed replacements retain the photo, and backups restore it offline without consent', async ({ page, context, browser, baseURL }) => {
    const network = await mockCoverNetwork(context, baseURL!, {});
    const title = 'Synthetic Portable Cover Photo';
    await page.goto('./');
    await addManual(page, title); await closeDetail(page);
    const before = (await exportBackup(page)).document;
    await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const detail = await openBook(page, title);
      await detail.getByLabel('Upload cover photo', { exact: true }).setInputFiles(await syntheticPhoto(page, mime));
      await expect(detail.getByRole('button', { name: 'Remove custom cover', exact: true })).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Remove custom cover', exact: true })).toBeEnabled();
      await expectDecodedCover(page);
      await closeDetail(page);
      const state = (await exportBackup(page)).document.entities.coverStates[0];
      expect(state.uploaded).toMatchObject({ mime: 'image/jpeg', width: 384, height: 512 });
      expect(state.uploaded!.byteLength).toBeGreaterThan(0);
      expect(state.uploaded!.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.from(state.uploaded!.jpegBase64, 'base64').byteLength).toBe(state.uploaded!.byteLength);
    }
    const saved = (await exportBackup(page)).document;
    expectProtectedLibrary(before, saved);
    const detail = await openBook(page, title);
    for (const file of [
      { name: 'synthetic-unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      { name: 'synthetic-corrupt.png', mimeType: 'image/png', buffer: Buffer.from('Synthetic invalid image') },
      { name: 'synthetic-too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
    ]) {
      await detail.getByLabel('Upload cover photo', { exact: true }).setInputFiles(file);
      await expect(detail.getByRole('alert')).toBeVisible();
      await expectDecodedCover(page);
    }
    await closeDetail(page);
    const exported = await exportBackup(page);
    expect(exported.document.schemaVersion).toBe(3);
    expect(exported.document.formatVersion).toBe(1);
    expect(exported.document.entities.coverStates).toEqual(saved.entities.coverStates);
    expect(exported.text).not.toContain('synthetic-local-photo-marker');
    await context.setOffline(true);
    await page.reload();
    await openBook(page, title);
    await expectDecodedCover(page);
    await closeDetail(page);
    await context.setOffline(false);
    const destination = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    try {
      const nextNetwork = await mockCoverNetwork(destination, baseURL!, {});
      const next = await destination.newPage();
      await next.goto('./');
      await navigate(next, 'Settings & backup');
      await next.getByLabel('Import backup or catalog', { exact: true }).setInputFiles(fileUpload('synthetic-cover-backup.json', exported.text));
      await expect(next.getByRole('heading', { name: 'Review import before writing', exact: true })).toBeVisible();
      await next.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
      await next.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
      await expect(next.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
      const restored = (await exportBackup(next)).document;
      expect(restored.entities.coverStates).toEqual(exported.document.entities.coverStates);
      expect(restored.entities.settings.find(row => row.id === 'preferences')?.value.autoFetchCovers).toBe(false);
      const restoredDetail = await openBook(next, title);
      await destination.setOffline(true);
      await expectDecodedCover(next);
      await restoredDetail.getByRole('button', { name: 'Remove custom cover', exact: true }).click();
      await expect(restoredDetail.getByRole('button', { name: 'Remove custom cover', exact: true })).not.toBeVisible();
      // Removal retains an empty revisioned cover state. A second upload must
      // carry that revision, not treat "none" as a never-saved cover.
      await restoredDetail.getByLabel('Upload cover photo', { exact: true }).setInputFiles(
        await syntheticPhoto(next, 'image/png', '#336699'),
      );
      await expect(restoredDetail.getByRole('button', { name: 'Remove custom cover', exact: true })).toBeEnabled();
      await expectDecodedCover(next);
      await closeDetail(next);
      expect((await exportBackup(next)).document.entities.coverStates[0].uploaded).toBeTruthy();
      expectPrivateNetwork(nextNetwork, ['synthetic-local-photo-marker']);
    } finally { await destination.close(); }
    expectPrivateNetwork(network, ['synthetic-local-photo-marker']);
    expect(network.requests).toEqual([]);
  });
});

test('cancelled catalog cover candidates never write books or trigger provider lookups', async ({ page, baseURL }) => {
  const unexpected = await blockExternalRequests(page, baseURL!);
  await page.goto('./');
  await addManual(page, 'Synthetic Cover Diary Retained');
  await closeDetail(page);
  const before = (await exportBackup(page)).document;
  await previewInventedCatalog(page);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await page.reload();
  const after = (await exportBackup(page)).document;
  for (const table of ['works', 'editions', 'holdings', 'notes', 'readingCycles', 'sessions', 'importReceipts'] as const) {
    expect(after.entities[table]).toEqual(before.entities[table]);
  }
  expect(unexpected).toEqual([]);
});

test('previously enabled online lookup and remote image display do not consent to automatic catalog searches', async ({ page, baseURL }) => {
  const unexpected = await blockExternalRequests(page, baseURL!);
  await page.goto('./');
  await addManual(page, 'Synthetic Previous Cover Preference');
  await closeDetail(page);
  await navigate(page, 'Settings & backup');
  await setPreference(page, /^Online lookup/, true);
  await setPreference(page, /^Load book covers/, true);
  await page.reload();
  await previewInventedCatalog(page);
  await page.getByRole('checkbox', { name: /^I reviewed the catalog/ }).check();
  await page.getByRole('button', { name: 'Import reviewed catalog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review import before writing', exact: true })).not.toBeVisible();
  await navigate(page, 'My library');
  await page.reload();
  const exported = (await exportBackup(page)).document;
  expect(exported.entities.works).toHaveLength(3);
  expect(exported.entities.settings.find(row => row.id === 'preferences')?.value).toMatchObject({
    onlineAccess: true, loadCovers: true, autoFetchCovers: false,
  });
  // Existing image-display consent is allowed to load known provider IDs. These
  // synthetic manual/catalog books have none, so even an image request is wrong.
  expect(unexpected).toEqual([]);
});
