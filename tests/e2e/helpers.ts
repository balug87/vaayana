import { expect, type Page } from '@playwright/test';
import type { BackupDocument } from '../../src/domain/types';

export async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Main navigation', includeHidden: true }).waitFor({ state: 'attached' });
  const button = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: name === 'My library' ? /^My library/ : name, exact: name !== 'My library' });
  if (!await button.isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await button.click();
}

export async function closeDetail(page: Page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
}

export async function addManual(page: Page, title: string, formats: ('Physical' | 'Digital')[] = ['Physical'], pages?: number, author = 'A. Reader') {
  await page.getByRole('button', { name: 'Add a book', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a book', exact: true });
  await dialog.getByRole('tab', { name: 'Enter manually', exact: true }).click();
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Author', { exact: true }).fill(author);
  if (pages) await dialog.getByLabel('Page count', { exact: true }).fill(String(pages));
  for (const format of ['Physical', 'Digital'] as const) await dialog.getByLabel(format, { exact: true }).setChecked(formats.includes(format));
  await dialog.getByRole('button', { name: 'Save book', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  return page.getByRole('dialog', { name: title, exact: true });
}

export async function enableOnline(page: Page) {
  await navigate(page, 'Settings & backup');
  await setPreference(page, /^Online lookup/, true);
}

export async function setPreference(page: Page, name: RegExp, enabled: boolean) {
  const checkbox = page.getByRole('checkbox', { name });
  if (await checkbox.isChecked() !== enabled) await checkbox.click();
  if (enabled) await expect(checkbox).toBeChecked();
  else await expect(checkbox).not.toBeChecked();
}

export async function exportBackup(page: Page): Promise<{ text: string; document: BackupDocument }> {
  await navigate(page, 'Settings & backup');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Backup download stream missing');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, document: JSON.parse(text) as BackupDocument };
}

export async function addGoal(page: Page, metric: 'books' | 'pages' | 'minutes', target: number) {
  await navigate(page, 'Reading');
  await page.getByRole('button', { name: 'Set a goal', exact: true }).click();
  await page.getByRole('combobox', { name: 'Goal unit', exact: true }).selectOption(metric);
  await page.getByLabel('Goal target', { exact: true }).fill(String(target));
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save goal', exact: true })).not.toBeVisible();
}

export function goalCard(page: Page, metric: string) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: metric, exact: true }) });
}
