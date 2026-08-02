/* eslint-disable no-empty-pattern -- Playwright requires fixture dependencies to use object destructuring. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { startGoogleProviderMock, type GoogleProviderMockState } from './google-provider-mock';

interface DesktopFixtures {
  desktopApp: ElectronApplication;
  page: Page;
  dataDirectory: string;
  exportDirectory: string;
  rendererErrors: string[];
  startupLogs: string[];
  googleProviderMock: GoogleProviderMockState;
}

const desktopRoot = resolve(import.meta.dirname, '..');

export const test = base.extend<DesktopFixtures>({
  dataDirectory: async ({}, provide) => {
    const directory = await mkdtemp(join(tmpdir(), 'outreachr-e2e-data-'));
    await provide(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  },

  exportDirectory: async ({}, provide) => {
    const directory = await mkdtemp(join(tmpdir(), 'outreachr-e2e-export-'));
    await mkdir(directory, { recursive: true });
    await provide(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  },

  startupLogs: async ({}, provide) => {
    await provide([]);
  },

  googleProviderMock: async ({}, provide) => {
    const mock = await startGoogleProviderMock();
    try {
      await provide(mock.state);
    } finally {
      await mock.close();
    }
  },

  desktopApp: async ({ dataDirectory, googleProviderMock, startupLogs }, provide) => {
    const application = await electron.launch({
      // The main process requests its single-instance lock before it can apply
      // OUTREACHR_E2E_DATA_DIR. Give Electron the isolated user-data path at
      // process launch so sequential fixtures never contend for the same lock.
      args: [desktopRoot, `--user-data-dir=${dataDirectory}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OUTREACHR_E2E_DATA_DIR: dataDirectory,
        OUTREACHR_E2E_GOOGLE_PROVIDER_URL: googleProviderMock.baseUrl,
        OUTREACHR_E2E_SECRET_KEY: randomBytes(32).toString('hex'),
        CLAUDE_CODE_OAUTH_TOKEN: 'e2e-setup-token-must-never-persist',
        OUTREACHR_STARTUP_DIAGNOSTICS: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 60_000,
    });
    application.process().stdout?.on('data', (chunk: Buffer) => startupLogs.push(chunk.toString()));
    application.process().stderr?.on('data', (chunk: Buffer) => startupLogs.push(chunk.toString()));
    try {
      await provide(application);
    } finally {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        application.close().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolveTimeout) => {
          closeTimer = setTimeout(() => resolveTimeout(false), 5_000);
        }),
      ]);
      if (closeTimer) clearTimeout(closeTimer);
      if (!closed && !application.process().killed) application.process().kill('SIGKILL');
    }
  },

  page: async ({ desktopApp, startupLogs }, provide) => {
    let page: Page;
    try {
      page = await desktopApp.firstWindow({ timeout: 60_000 });
    } catch (error) {
      const detail = startupLogs.join('').trim() || 'No Electron process output was captured.';
      throw new Error(`Electron did not create its first window.\n${detail}`, { cause: error });
    }
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.waitForLoadState('domcontentloaded');
    await provide(page);
  },

  rendererErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await provide(errors);
  },
});

export { expect };

export async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
}

export async function completeOnboarding(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Who is running this round?' })).toBeVisible();
  await page.getByLabel('Your name').fill('Ada Founder');
  await page.getByLabel('Work email').fill('ada@local.test');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Company name').fill('Local Labs');
  await page
    .getByLabel('One-line description')
    .fill('Local-first infrastructure for trustworthy AI teams.');
  await page
    .getByLabel('Fundraising narrative')
    .fill('Founder-reviewed traction and narrative. All estimates are labeled.');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Round stage').selectOption('seed');
  await page.getByLabel('Target raise (USD)').fill('3000000');
  await page.getByLabel('Minimum useful check').fill('250000');
  await page.getByLabel('Maximum expected check').fill('1000000');
  await page.getByLabel('Sector tags').fill('AI, Agentic, Developer Tools');
  await page.getByLabel('Geographies').fill('United States');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(
    page.getByRole('heading', { name: 'Your fundraising history stays on this device.' }),
  ).toBeVisible();
  await page
    .getByLabel('Sender postal address (optional during setup)')
    .fill('123 Founder Way\nSan Francisco, CA 94107\nUnited States');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your local workspace is ready to build.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create local workspace' }).click();

  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
}

export async function navigate(page: Page, label: string): Promise<void> {
  const navigation =
    label === 'Settings'
      ? page.getByRole('complementary', { name: 'Workspace sidebar' })
      : page.getByRole('navigation', { name: 'Primary navigation' });

  await navigation
    .getByRole('link', {
      name: label,
      exact: true,
    })
    .click();
}
