import { defineConfig } from '@playwright/test';
const browserName = process.env.OUTREACHR_TEST_BROWSER ?? 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit')
  throw new Error('Choose chromium, firefox or webkit for browser verification.');
export default defineConfig({
  testDir: './test',
  workers: 1,
  // This complete flow includes two browsers and real PostgreSQL-backed CRM operations.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        'node --import ../cloud/node_modules/tsx/dist/loader.mjs ../cloud/test/browser-server.ts',
      url: 'http://127.0.0.1:4174/health',
      timeout: 120_000,
      reuseExistingServer: false,
      // Let the fixture close its connections and drop its disposable database.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
