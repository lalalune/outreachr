import { readFile } from 'node:fs/promises';
import { completeOnboarding, expect, navigate, test } from './fixtures';

test.describe('Founder credential setup through the built Electron boundary', () => {
  test('documents exact OAuth setup and keeps a Claude key write-only and encrypted', async ({
    page,
    rendererErrors,
  }) => {
    await completeOnboarding(page);
    await navigate(page, 'Settings');

    await page.getByRole('button', { name: 'Mail & calendar', exact: true }).click();
    const google = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Google Workspace', exact: true }),
    });
    await expect(google.getByText('Create a Desktop app OAuth client')).toBeVisible();
    await expect(google.getByText('gmail.send', { exact: true })).toBeVisible();
    await expect(google.getByText('gmail.readonly', { exact: true })).toBeVisible();
    await expect(google.getByText(/Testing grants expire after seven days/u)).toBeVisible();
    await expect(google.getByRole('textbox', { name: 'Application (client) ID' })).toHaveAttribute(
      'autocomplete',
      'off',
    );
    await expect(google.locator('input[type="password"]')).toHaveCount(0);

    const microsoft = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Microsoft 365', exact: true }),
    });
    await expect(
      microsoft.getByText('http://localhost/oauth/callback', { exact: true }),
    ).toBeVisible();
    await expect(microsoft.getByText(/Mail\.ReadBasic/u)).toBeVisible();

    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(page.getByText(/official ChatGPT sign-in page/u)).toBeVisible();
    await expect(page.getByText(/API-key authentication is the default/u)).toBeVisible();
    const enableSubscription = page.getByRole('button', {
      name: 'Enable subscription access',
      exact: true,
    });
    await expect(enableSubscription).toBeDisabled();
    await page
      .getByRole('checkbox', {
        name: /I confirm Anthropic approved this Outreachr deployment/u,
      })
      .check();
    await expect(enableSubscription).toBeEnabled();
    await enableSubscription.click();
    await expect(
      page.getByText('Claude subscription access enabled', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Subscription enabled by founder', { exact: true })).toBeVisible();

    const subscriptionBootstrap = await page.evaluate(async () => window.outreachr.bootstrap());
    expect(
      subscriptionBootstrap.agents.find((agent) => agent.provider === 'claude')
        ?.subscriptionAuthApproved,
    ).toBe(true);
    const subscriptionVaultBytes = await readFile(subscriptionBootstrap.vaultPath);
    expect(subscriptionVaultBytes.includes(Buffer.from('e2e-setup-token-must-never-persist'))).toBe(
      false,
    );

    await page.getByRole('button', { name: 'Disable subscription access', exact: true }).click();
    await expect(
      page.getByText('Claude subscription access disabled', { exact: true }),
    ).toBeVisible();
    const disabledBootstrap = await page.evaluate(async () => window.outreachr.bootstrap());
    expect(
      disabledBootstrap.agents.find((agent) => agent.provider === 'claude')
        ?.subscriptionAuthApproved,
    ).toBe(false);

    const apiKey = 'sk-ant-built-electron-write-only-key-000001';
    const keyInput = page.getByLabel('Anthropic API key', { exact: true });
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await keyInput.fill(apiKey);
    await page.getByRole('button', { name: 'Save encrypted API key', exact: true }).click();
    await expect(keyInput).toHaveValue('');

    const bootstrap = await page.evaluate(async () => window.outreachr.bootstrap());
    expect(JSON.stringify(bootstrap)).not.toContain(apiKey);
    const vaultBytes = await readFile(bootstrap.vaultPath);
    expect(vaultBytes.includes(Buffer.from(apiKey))).toBe(false);
    await expect(page.getByText(apiKey, { exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Remove stored API key', exact: true }).click();
    await expect(page.getByText('Stored Claude API key removed', { exact: true })).toBeVisible();
    expect(rendererErrors).toEqual([]);
  });
});
