import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.pages.ts',
  fullyParallel: false,
  workers: 1,
  outputDir: '../../../docs/qa/pages/test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PAGES_QA_URL,
    trace: 'retain-on-failure',
  },
});
