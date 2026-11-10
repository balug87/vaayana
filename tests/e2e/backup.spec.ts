import { expect, test } from '@playwright/test';
import { addManual, closeDetail, exportBackup, navigate } from './helpers';
import { fileUpload, malformedBackups } from './fixtures';

test.use({ serviceWorkers: 'block' });

test('backup preview is cancellable and repeated self-import does not duplicate diary', async ({ page }) => {
  await page.goto('/');
  const detail = await addManual(page, 'Portable Reading Diary', ['Physical', 'Digital']);
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill('A note that must survive a repeated backup.');
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  const first = await exportBackup(page);
  expect(first.document.formatVersion).toBe(1);
  expect(first.document.entities.works).toHaveLength(1);
  await page.getByLabel('Import backup', { exact: true }).setInputFiles(fileUpload('library.json', first.text));
  await expect(page.getByRole('heading', { name: 'Review import before writing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit safe merge', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review import before writing' })).not.toBeVisible();
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByLabel('Import backup', { exact: true }).setInputFiles(fileUpload('library.json', first.text));
    await page.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
    await page.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review import before writing' })).not.toBeVisible();
  }
  const after = await exportBackup(page);
  expect(after.document.entities.works).toEqual(first.document.entities.works);
  expect(after.document.entities.notes).toEqual(first.document.entities.notes);
  expect(after.document.entities.holdings).toEqual(first.document.entities.holdings);
  expect(after.document.entities.readingCycles).toEqual(first.document.entities.readingCycles);
});

test('export transfers a diary to a different empty browser profile only after commit', async ({ page, browser }) => {
  await page.goto('/');
  const detail = await addManual(page, 'Manual Library Transfer', ['Digital']);
  await detail.getByRole('tab', { name: 'Notes', exact: true }).click();
  await detail.getByRole('textbox', { name: 'Notes', exact: true }).fill('Transfer this note without cloud sync.');
  await detail.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  const original = await exportBackup(page);
  const destination = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block' });
  try {
    const next = await destination.newPage();
    await next.goto('/');
    await navigate(next, 'Settings & backup');
    await next.getByLabel('Import backup', { exact: true }).setInputFiles(fileUpload('transfer.json', original.text));
    await expect(next.getByRole('heading', { name: 'Review import before writing' })).toBeVisible();
    await expect(next.getByRole('navigation').getByRole('button', { name: /^My library/ })).toContainText('0');
    await next.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
    await next.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
    await expect(next.getByRole('heading', { name: 'Review import before writing' })).not.toBeVisible();
    await navigate(next, 'My library');
    await next.getByRole('button', { name: 'Open Manual Library Transfer', exact: true }).click();
    await next.getByRole('tab', { name: 'Notes', exact: true }).click();
    await expect(next.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Transfer this note without cloud sync.');
  } finally { await destination.close().catch(() => {}); }
});

test('malformed, hostile and unsupported backups leave existing books and notes unchanged', async ({ page }) => {
  await page.goto('/');
  await addManual(page, 'Keep This Library', ['Physical']);
  await closeDetail(page);
  const first = await exportBackup(page);
  for (const malformed of malformedBackups(first.document)) {
    await test.step(malformed.label, async () => {
      await page.getByLabel('Import backup', { exact: true }).setInputFiles(fileUpload('invalid.json', malformed.text));
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Review import before writing' })).not.toBeVisible();
    });
  }
  expect(await page.evaluate(() => (Object.prototype as Record<string, unknown>).polluted)).toBeUndefined();
  const after = await exportBackup(page);
  for (const table of ['works', 'editions', 'holdings', 'notes', 'sessions', 'readingCycles'] as const) {
    expect(after.document.entities[table], `Rejected backups must preserve ${table}`).toEqual(first.document.entities[table]);
  }
});

test('older backup cannot silently resurrect a deleted reading session', async ({ page }) => {
  await page.goto('/');
  const detail = await addManual(page, 'Deletion Has a Memory');
  await detail.getByRole('tab', { name: 'Reading', exact: true }).click();
  await detail.getByLabel('Pages read this session', { exact: true }).fill('7');
  await detail.getByRole('button', { name: 'Log reading', exact: true }).click();
  await expect(detail.getByText('7 pages · 0 minutes', { exact: true })).toBeVisible();
  await closeDetail(page);
  const old = await exportBackup(page);
  await navigate(page, 'My library');
  await page.getByRole('button', { name: 'Open Deletion Has a Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Reading', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete reading session', exact: true }).click();
  await expect(page.getByText('7 pages · 0 minutes', { exact: true })).not.toBeVisible();
  await closeDetail(page);
  await navigate(page, 'Settings & backup');
  await page.getByLabel('Import backup', { exact: true }).setInputFiles(fileUpload('older.json', old.text));
  await expect(page.getByText('Restore or keep deleted?', { exact: true })).toBeVisible();
  for (const resolution of await page.getByRole('combobox', { name: /^Resolve / }).all()) await expect(resolution).toHaveValue('keep-local');
  await page.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.', exact: true }).check();
  await page.getByRole('button', { name: 'Commit safe merge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review import before writing' })).not.toBeVisible();
  const after = await exportBackup(page);
  expect(after.document.entities.sessions).toHaveLength(0);
  expect(after.document.entities.tombstones.some(tombstone => tombstone.table === 'sessions')).toBe(true);
});
