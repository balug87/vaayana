import { expect, test } from '@playwright/test';
import { addManual, closeDetail, navigate } from './helpers';

test('complete baseline shell excludes model assets and permits offline relaunch and editing', async ({ page, context }) => {
  const optional: string[] = [];
  page.on('request', request => {
    if (/semantic\.worker|onnx|transformers|huggingface|\.wasm(?:\?|$)/i.test(request.url())) optional.push(request.url());
  });
  await page.goto('/');
  await navigate(page, 'Settings & backup');
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  expect(optional, 'First baseline load must not fetch optional worker/model/runtime assets').toEqual([]);
  await navigate(page, 'My library');
  await addManual(page, 'Available Without Internet');
  await closeDetail(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Available Without Internet', exact: true })).toBeVisible();
  await page.getByLabel('Search your library', { exact: true }).fill('Available');
  await page.getByRole('button', { name: 'Open Available Without Internet', exact: true }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Written while offline.');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('notes are saved');
  await closeDetail(page);
  await addManual(page, 'Added Offline Too', ['Digital']);
  await closeDetail(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Added Offline Too', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Available Without Internet', exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('missing required cached asset never remains reported offline-ready', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Settings & backup');
  await expect(page.getByText('Offline ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const removed = await page.evaluate(async () => {
    const name = (await caches.keys()).find(key => key.includes('precache'));
    if (!name) return false;
    const cache = await caches.open(name);
    const key = (await cache.keys()).find(request => request.url.includes('.css'));
    return key ? cache.delete(key) : false;
  });
  expect(removed, 'Fault injection must remove a real required shell CSS cache entry').toBe(true);
  await page.getByRole('button', { name: 'Recheck offline setup', exact: true }).click();
  await expect(page.getByText('Offline setup error', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline ready', { exact: true })).not.toBeVisible();
});
