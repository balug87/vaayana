import { expect, test, type Download, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { addManual, closeDetail, exportBackup, navigate } from './helpers';
import { fileUpload } from './fixtures';

test.use({ serviceWorkers: 'allow' });

/** Entirely invented input. Never replace this with a personal catalog. */
const catalog = {
  total_unique_titles: 99,
  notes: 'Synthetic catalog source, explicitly unverified.',
  books: [
    { title: 'Synthetic Catalog Volume One', author: 'Synthetic QA Author', source_images: [1], notes: 'Synthetic first-volume source note.' },
    { title: 'Synthetic Catalog Volume Two', author: 'Synthetic QA Author', source_images: [2, 3] },
    { title: 'Synthetic Uncertain Catalog', author: null, source_images: [5], notes: 'Synthetic source uncertainty.' },
  ],
};
const review = (page: Page) => page.getByRole('heading', { name: 'Review import before writing', exact: true });
const catalogReview = (page: Page) => page.getByRole('checkbox', { name: /^I reviewed the catalog/ });
const catalogCommit = (page: Page) => page.getByRole('button', { name: 'Import reviewed catalog', exact: true });

async function upload(page: Page, document: unknown) {
  await page.getByLabel('Import backup or catalog', { exact: true })
    .setInputFiles(fileUpload('synthetic-catalog.json', JSON.stringify(document)));
  await expect(review(page)).toBeVisible();
}

async function commitCatalog(page: Page) {
  await catalogReview(page).check();
  await catalogCommit(page).click();
  await expect(review(page)).not.toBeVisible();
}

async function commitBackup(page: Page) {
  await page.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
  await page.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
  await expect(review(page)).not.toBeVisible();
}

async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Synthetic example download stream missing');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function observeRequests(page: Page) {
  const external: string[] = [];
  const optional: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(page.url()).origin) {
      external.push(url.origin);
      await route.abort();
    } else await route.continue();
  });
  page.on('request', request => {
    if (/semantic\.worker|\.wasm(?:$|\?)/.test(request.url())) optional.push('optional-model-asset');
  });
  return { external, optional };
}

test('format guide, downloadable examples and schemas are scoped; copied example and both formats preview safely', async ({ page }, info) => {
  await page.goto('./');
  await navigate(page, 'Settings & backup');
  await expect(page.getByRole('heading', { name: 'Two accepted JSON formats', exact: true })).toBeVisible();
  const links = [
    'Read the full import format guide', 'Download catalog example', 'Download catalog JSON Schema',
    'Download generated backup example', 'Download backup JSON Schema',
  ];
  const documents: Record<string, Record<string, unknown>> = {};
  const urls: string[] = [];
  const scope = new URL('./', page.url());
  for (const name of links) {
    const link = page.getByRole('link', { name, exact: true });
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!, page.url());
    urls.push(url.href);
    expect(url.origin).toBe(scope.origin);
    expect(url.pathname).toMatch(new RegExp(`^${scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}import-formats/`));
    const response = await page.request.get(url.href);
    expect(response.status(), name).toBe(200);
    if (name === links[0]) {
      expect(response.headers()['content-type']).toContain('text/html');
      expect(await response.text()).toContain('source_images');
    } else {
      expect(response.headers()['content-type']).toContain('json');
      const pending = page.waitForEvent('download');
      await link.click();
      documents[name] = JSON.parse(await downloadText(await pending));
    }
  }
  for (const name of [links[2], links[4]]) {
    expect(documents[name].$schema).toMatch(/^https?:/);
    expect(documents[name].type).toBe('object');
  }
  // Capture the clipboard API argument, not the user's operating-system clipboard.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { (window as unknown as Record<string, unknown>).qaCopiedCatalog = value; } },
  }));
  await page.getByText('Copy a small catalog example', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy example JSON', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Example JSON copied.' })).toBeVisible();
  const copied = await page.evaluate(() => JSON.parse(String((window as unknown as Record<string, unknown>).qaCopiedCatalog)));
  expect(copied.books).toHaveLength(2);
  for (const [document, detected] of [
    [copied, 'Book catalog'],
    [documents[links[1]], 'Book catalog'],
    [documents[links[3]], 'Vaayana backup'],
  ] as const) {
    await upload(page, document);
    await expect(page.getByText(`Detected format: ${detected}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  }
  expect((await exportBackup(page)).document.entities.works).toHaveLength(0);
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible();
  await page.context().setOffline(true);
  const cached = await page.evaluate(async paths => {
    return Promise.all(paths.map(async path => {
      const response = await fetch(path);
      const text = await response.text();
      return {
        status: response.status,
        valid: path.endsWith('.json') ? typeof JSON.parse(text) === 'object' : text.includes('source_images'),
      };
    }));
  }, urls);
  expect(cached).toEqual(urls.map(() => ({ status: 200, valid: true })));
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  if (process.env.IMPORT_QA_SCREENSHOTS) {
    await expect(page.getByText('Backup download prepared. Check that the file was saved.', { exact: true })).not.toBeVisible({ timeout: 10_000 });
    await page.locator('.import-format-help').screenshot({ path: info.outputPath('synthetic-import-formats.png') });
  }
});

test('catalog preview cancellation and additive repeated import preserve diary and unverified provenance through a canonical roundtrip', async ({ page, browser, baseURL }) => {
  await page.goto('./');
  const requests = await observeRequests(page);
  const detail = await addManual(page, 'Synthetic Existing Diary', ['Physical']);
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill('Synthetic existing diary note.');
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  const before = (await exportBackup(page)).document;
  await upload(page, catalog);
  await expect(page.getByText('Detected format: Book catalog', { exact: true })).toBeVisible();
  await expect(page.getByText('3 actual entries', { exact: true })).toBeVisible();
  await expect(page.getByText(/Declared count 99 differs from 3 actual entries/)).toBeVisible();
  await expect(page.getByText(catalog.notes, { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Starting shelf for new catalog books', exact: true })).toHaveValue('to-read');
  await expect(page.getByRole('combobox', { name: 'Owned formats for new catalog books', exact: true })).toHaveValue('unknown');
  await expect(catalogCommit(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  const cancelled = (await exportBackup(page)).document;
  for (const table of ['works', 'editions', 'holdings', 'notes', 'sessions', 'readingCycles', 'importReceipts'] as const) {
    expect(cancelled.entities[table]).toEqual(before.entities[table]);
  }
  await upload(page, catalog);
  await commitCatalog(page);
  await page.reload();
  const first = await exportBackup(page);
  const imported = first.document.entities.works.filter(work => work.id !== before.entities.works[0].id);
  expect(imported).toHaveLength(3);
  expect(imported.every(work => work.initialStatus === 'to-read')).toBe(true);
  expect(first.document.entities.works.find(work => work.id === before.entities.works[0].id)).toEqual(before.entities.works[0]);
  for (const table of ['holdings', 'notes', 'sessions', 'readingCycles', 'statusEvents', 'metadataSnapshots', 'tagAssignments', 'layerAssignments'] as const) {
    expect(first.document.entities[table]).toEqual(before.entities[table]);
  }
  const provenance = first.document.entities.editions.flatMap(edition => edition.catalogProvenance ?? []);
  expect(provenance).toHaveLength(3);
  for (const row of catalog.books) {
    expect(first.document.entities.editions.find(edition => edition.metadata.title === row.title)?.metadata).toEqual({
      title: row.title, authors: row.author === null ? [] : [row.author],
    });
    expect(provenance.find(source => source.originalTitle === row.title)).toMatchObject({
      originalAuthor: row.author, sourceImages: row.source_images, unverified: true,
      ...('notes' in row ? { notes: row.notes } : {}),
    });
  }
  expect(first.document.entities.importReceipts.find(receipt => receipt.catalog)?.catalog).toEqual({
    actualCount: 3, declaredCount: 99, unknownAuthorCount: 1, notes: catalog.notes, unverified: true,
  });
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Open Synthetic Uncertain Catalog', exact: true }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unverified catalog sources', exact: true })).toBeVisible();
  await page.getByText('Catalog source 1 · unverified', { exact: true }).click();
  await expect(page.getByText('Original author: Unknown author', { exact: true })).toBeVisible();
  await expect(page.getByText(catalog.books[2].notes!, { exact: true })).toBeVisible();
  await closeDetail(page);
  await navigate(page, 'Settings & backup');
  await upload(page, catalog);
  await expect(page.getByText(/This file has already been imported/)).toBeVisible();
  await commitCatalog(page);
  const repeated = await exportBackup(page);
  for (const table of ['works', 'editions', 'holdings', 'notes', 'sessions', 'readingCycles'] as const) {
    expect(repeated.document.entities[table]).toEqual(first.document.entities[table]);
  }
  expect(requests.external).toEqual([]);
  expect(requests.optional).toEqual([]);
  const destination = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  try {
    const next = await destination.newPage();
    await next.goto('./');
    await navigate(next, 'Settings & backup');
    await upload(next, first.document);
    await expect(next.getByText('Detected format: Vaayana backup', { exact: true })).toBeVisible();
    await commitBackup(next);
    const roundtrip = await exportBackup(next);
    for (const table of ['works', 'editions', 'holdings', 'notes', 'sessions', 'readingCycles'] as const) {
      expect(roundtrip.document.entities[table]).toEqual(first.document.entities[table]);
    }
  } finally { await destination.close(); }
});

test('explicit catalog defaults restage, reset review and survive a pre-import backup without inventing history', async ({ page }) => {
  await page.goto('./');
  await navigate(page, 'Settings & backup');
  await upload(page, catalog);
  await catalogReview(page).check();
  const shelf = page.getByRole('combobox', { name: 'Starting shelf for new catalog books', exact: true });
  const formats = page.getByRole('combobox', { name: 'Owned formats for new catalog books', exact: true });
  await shelf.selectOption('wishlist');
  await expect(shelf).toHaveValue('wishlist');
  await expect(catalogReview(page)).not.toBeChecked();
  for (const value of ['physical', 'digital', 'unknown', 'both']) {
    await catalogReview(page).check();
    await formats.selectOption(value);
    await expect(formats).toHaveValue(value);
    await expect(catalogReview(page)).not.toBeChecked();
    await expect(catalogCommit(page)).toBeDisabled();
  }
  await catalogReview(page).check();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download a pre-import backup (then review again)', exact: true }).click();
  expect(JSON.parse(await downloadText(await pending)).entities.works).toHaveLength(0);
  await expect(shelf).toHaveValue('wishlist');
  await expect(formats).toHaveValue('both');
  await expect(catalogReview(page)).not.toBeChecked();
  await commitCatalog(page);
  const result = (await exportBackup(page)).document.entities;
  expect(result.works).toHaveLength(3);
  expect(result.works.every(work => work.initialStatus === 'wishlist')).toBe(true);
  expect(result.holdings).toHaveLength(6);
  for (const work of result.works) {
    expect(result.holdings.filter(holding => holding.workId === work.id).map(holding => holding.format).sort()).toEqual(['digital', 'physical']);
  }
  for (const table of ['readingCycles', 'sessions', 'statusEvents', 'notes', 'metadataSnapshots', 'tagAssignments', 'layerAssignments'] as const) {
    expect(result[table]).toHaveLength(0);
  }
});

for (const decision of ['keep-local', 'use-import'] as const) {
  test(`similar catalog title requires explicit ${decision} without replacing the existing book`, async ({ page }) => {
    await page.goto('./');
    await addManual(page, catalog.books[0].title, ['Physical'], undefined, catalog.books[0].author!);
    await closeDetail(page);
    const before = (await exportBackup(page)).document;
    await upload(page, { books: [catalog.books[0]] });
    const resolution = page.getByRole('combobox', { name: 'Resolve catalog entry 1', exact: true });
    await expect(resolution).toHaveValue('keep-local');
    if (decision === 'use-import') {
      await catalogReview(page).check();
      await resolution.selectOption(decision);
      await expect(catalogReview(page)).not.toBeChecked();
    }
    await commitCatalog(page);
    const after = (await exportBackup(page)).document;
    expect(after.entities.works).toHaveLength(decision === 'keep-local' ? 1 : 2);
    expect(after.entities.works.find(work => work.id === before.entities.works[0].id)).toEqual(before.entities.works[0]);
    expect(after.entities.holdings).toEqual(before.entities.holdings);
    expect(after.entities.readingCycles).toEqual(before.entities.readingCycles);
  });
}

test('an older changed-source catalog keeps an imported deletion unless explicitly restored', async ({ browser, baseURL }) => {
  const older = {
    total_unique_titles: 1, notes: 'Fictional deletion regression.',
    books: [{ title: 'The Invented Observatory', author: 'M. Example', source_images: [1], notes: 'Version one source annotation' }],
  };
  for (const decision of ['keep-local', 'use-import'] as const) {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto('./');
      await navigate(page, 'Settings & backup');
      for (const snapshot of ['before', 'after']) {
        await page.getByLabel('Import backup or catalog', { exact: true }).setInputFiles(
          fileURLToPath(new URL(`./fixtures/catalog-deletion-${snapshot}.backup.json`, import.meta.url)),
        );
        await expect(review(page)).toBeVisible();
        await expect(page.getByText('Detected format: Vaayana backup', { exact: true })).toBeVisible();
        if (snapshot === 'after') {
          const resolutions = page.getByRole('combobox', { name: /^Resolve / });
          expect(await resolutions.count()).toBeGreaterThan(0);
          for (const resolution of await resolutions.all()) await resolution.selectOption('use-import');
        }
        await commitBackup(page);
        expect((await exportBackup(page)).document.entities.works).toHaveLength(snapshot === 'before' ? 1 : 0);
      }
      await upload(page, older);
      const resolution = page.getByRole('combobox', { name: 'Resolve catalog entry 1', exact: true });
      await expect(resolution).toHaveValue('keep-local');
      await expect(page.getByText('Catalog entry 1: keep deleted or restore?', { exact: true })).toBeVisible();
      if (decision === 'use-import') await resolution.selectOption('use-import');
      await commitCatalog(page);
      const result = (await exportBackup(page)).document.entities;
      expect(result.works).toHaveLength(decision === 'keep-local' ? 0 : 1);
      for (const table of ['readingCycles', 'sessions', 'statusEvents', 'notes', 'holdings'] as const) expect(result[table]).toHaveLength(0);
      if (decision === 'use-import') {
        expect(result.works[0].initialStatus).toBe('to-read');
        expect(result.editions[0].catalogProvenance?.[0]).toMatchObject({
          originalTitle: older.books[0].title, originalAuthor: older.books[0].author,
          sourceImages: [1], notes: older.books[0].notes, unverified: true,
        });
      }
      await upload(page, older);
      await expect(page.getByText(/This file has already been imported/)).toBeVisible();
      await commitCatalog(page);
      expect((await exportBackup(page)).document.entities.works).toHaveLength(decision === 'keep-local' ? 0 : 1);
    } finally { await context.close(); }
  }
});

test('wrong catalog shapes give actionable field paths without echoing values or changing the library', async ({ page }) => {
  await page.goto('./');
  await addManual(page, 'Synthetic Retained Book');
  await closeDetail(page);
  const before = (await exportBackup(page)).document;
  const canary = 'Synthetic value must not appear in validation errors';
  const cases = [
    { input: [{ title: canary, author: null }], message: /Supported formats/ },
    { input: { books: [{ title: canary }] }, message: /Catalog entry 1 requires author/ },
    { input: { books: [{ title: canary, author: 42 }] }, message: /Catalog entry 1 author/ },
    { input: { books: [{ title: canary, author: null, unsupported: canary }] }, message: /Catalog entry 1 contains unsupported fields/ },
    { input: { format: 'vaayana', formatVersion: 999, books: [{ title: canary, author: null }] }, message: /field|version|format/i },
  ];
  for (const item of cases) {
    await page.getByLabel('Import backup or catalog', { exact: true })
      .setInputFiles(fileUpload('synthetic-invalid.json', JSON.stringify(item.input)));
    await expect(page.getByRole('alert')).toContainText(item.message);
    await expect(page.getByRole('alert')).not.toContainText(canary);
    await expect(review(page)).not.toBeVisible();
  }
  const after = (await exportBackup(page)).document;
  for (const table of ['works', 'editions', 'holdings', 'notes', 'sessions', 'readingCycles'] as const) {
    expect(after.entities[table]).toEqual(before.entities[table]);
  }
});
