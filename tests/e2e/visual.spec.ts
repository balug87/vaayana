import { expect, test } from '@playwright/test';
import { addManual, closeDetail } from './helpers';

test.use({ serviceWorkers: 'block' });

test('public-title manual example library is legible at desktop and mobile widths', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A life in books.', exact: true })).toBeVisible();
  await expect(page.locator('.page-content')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'docs/qa/desktop-empty.png', fullPage: true });
  for (const [title, author] of [['Pride and Prejudice', 'Jane Austen'], ['The Art of War', 'Sun Tzu'], ['A Room of One’s Own', 'Virginia Woolf'], ['The Time Machine', 'H. G. Wells'], ['Walden', 'Henry David Thoreau']]) {
    await addManual(page, title, ['Physical'], undefined, author);
    await closeDetail(page);
  }
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10000 });
  await page.locator('main').focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'docs/qa/desktop-library.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'docs/qa/mobile-library.png', fullPage: true });
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.getByRole('button', { name: /Pride and Prejudice/ })).toBeVisible();
  await page.screenshot({ path: 'docs/qa/mobile-list.png', fullPage: true });
});
