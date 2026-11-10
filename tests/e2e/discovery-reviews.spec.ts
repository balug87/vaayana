import { expect, test } from '@playwright/test';
import { addManual, closeDetail, enableOnline, navigate } from './helpers';
import { deepenFixture, expandFixture } from './fixtures';

test.use({ serviceWorkers: 'block' });

test('mocked retrieval supplies two explained lanes; wishlist and dismissed books stay excluded', async ({ page }) => {
  const queries: string[] = [];
  await page.route('https://openlibrary.org/**', route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(q);
    return route.fulfill({ json: q.includes('cognitive anthropology') ? expandFixture : deepenFixture });
  });
  await page.route('https://covers.openlibrary.org/**', route => route.abort());
  await page.goto('/');
  await enableOnline(page);
  await navigate(page, 'Discover');
  await expect(page.getByRole('button', { name: 'Find my next read', exact: true })).toBeDisabled();
  await page.getByLabel('Interests', { exact: true }).fill('Decision making');
  await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decisions in Practice', exact: true })).toBeVisible();
  await expect(page.getByText('Matches your decision making interest.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decisions in Practice', exact: true })).not.toBeVisible();
  await page.getByRole('tab', { name: /^Expand your interests/ }).click();
  await expect(page.getByRole('heading', { name: 'Culture and Human Choices', exact: true })).toBeVisible();
  await expect(page.getByText(/From decision making to cognitive anthropology:/)).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss Culture and Human Choices', exact: true }).click();
  await page.getByRole('button', { name: 'Find my next read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find my next read', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Culture and Human Choices', exact: true })).not.toBeVisible();
  await page.getByRole('tab', { name: /^Deepen your interests/ }).click();
  await expect(page.getByRole('heading', { name: 'Decisions in Practice', exact: true })).not.toBeVisible();
  expect(queries.some(query => query.includes('decision making'))).toBe(true);
  expect(queries.some(query => query.includes('cognitive anthropology'))).toBe(true);
  await navigate(page, 'My library');
  await expect(page.getByRole('button', { name: 'Open Decisions in Practice', exact: true })).toBeVisible();
});

test('reviews distinguish verified source cards, searches and unavailable ratings; unsafe URLs rejected', async ({ page }) => {
  await page.goto('/');
  const detail = await addManual(page, 'Links, Not Invented Reviews');
  await detail.getByRole('tab', { name: 'Sources', exact: true }).click();
  await expect(detail.getByText('No Open Library reader rating available. Missing is not zero.', { exact: true })).toBeVisible();
  await expect(detail.getByText('No verified professional review links saved.', { exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Search Goodreads', exact: true })).toBeVisible();
  await detail.getByLabel('Review title', { exact: true }).fill('An explicitly verified source');
  await detail.getByLabel('Publication / source', { exact: true }).fill('Public QA source');
  await detail.getByLabel('Review URL', { exact: true }).fill('javascript:alert("unsafe")');
  await detail.getByRole('checkbox', { name: 'I checked that this link points to a real review of this book.', exact: true }).check();
  await detail.getByRole('button', { name: 'Save review link', exact: true }).click();
  await expect(detail.getByRole('alert')).toBeVisible();
  await expect(detail.getByRole('link', { name: 'An explicitly verified source', exact: true })).not.toBeVisible();
  await detail.getByLabel('Review URL', { exact: true }).fill('https://www.kirkusreviews.com/book-reviews/test/qa-review/');
  await detail.getByRole('button', { name: 'Save review link', exact: true }).click();
  const link = detail.getByRole('link', { name: 'An explicitly verified source', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://www.kirkusreviews.com/book-reviews/test/qa-review/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  await closeDetail(page);
});
