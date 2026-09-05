import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  workers: 1,
  // This complete flow includes two browsers and real PostgreSQL-backed CRM operations.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --dir ../cloud exec tsx test/browser-server.ts',
      url: 'http://127.0.0.1:4174/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
