import { expect, test } from '@playwright/test';
import { addManual, closeDetail } from './helpers';

test.use({ serviceWorkers: 'block' });

test('new library is genuinely empty and explains local storage', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByText(/your (library|shelf).*empty|first book|make.*room.*first/i).first()).toBeVisible();
  await expect(page.getByText(/stored.*(device|browser)|stay.*(device|browser)|local.*(device|browser)/i).first()).toBeVisible();
  await expect(page.getByText(/backup|export/i).first()).toBeVisible();
  expect(external, 'An empty library should not automatically contact external providers').toEqual([]);
});

for (const formats of [['Physical'], ['Digital'], ['Physical', 'Digital']] as const) {
  test(`manual ${formats.join('+')} holding persists without ISBN or page count`, async ({ page }) => {
    await page.goto('/');
    const title = `Quiet Shelf ${formats.join(' and ')} മലയാളം`;
    await addManual(page, title, [...formats]);
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
    await page.getByRole('button', { name: new RegExp(title) }).first().click();
    const detail = page.getByRole('dialog', { name: title, exact: true });
    await expect(detail).toBeVisible();
    for (const format of formats) await expect(detail.getByText(new RegExp(format, 'i')).first()).toBeVisible();
  });
}

test('keyboard opens and dismisses Add a book without saving', async ({ page }) => {
  await page.goto('/');
  const addButton = page.getByRole('button', { name: 'Add a book', exact: true }).first();
  await addButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Add a book', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add a book', exact: true })).not.toBeVisible();
  await expect(addButton).toBeFocused();
});

test('all six Layers and unassigned remain available, local list search opens the same book', async ({ page }) => {
  await page.goto('/');
  const detail = await addManual(page, 'A Searchable Quiet Book');
  const primary = detail.getByRole('combobox', { name: 'Primary Layer', exact: true });
  await expect(primary).toHaveValue('');
  await expect(primary.locator('option')).toHaveText([
    'Unknown / unassigned', 'Operating System', 'Fuel', 'Hardware', 'Mind-Expanding', 'Software Applications', 'Screensaver or Sandbox',
  ]);
  await closeDetail(page);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByLabel('Search your library', { exact: true }).fill('quiet');
  await page.getByRole('button', { name: /A Searchable Quiet Book/ }).click();
  await expect(page.getByRole('dialog', { name: 'A Searchable Quiet Book', exact: true })).toBeVisible();
});

test('small reduced-motion viewport keeps navigation and manual entry usable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await addManual(page, 'Pocket Library', ['Physical']);
  await closeDetail(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'docs/qa/mobile-library.png', fullPage: true });
});
