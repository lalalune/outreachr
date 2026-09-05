import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('signs in, persists Shaw fixture contact and draft, runs a proposal, exports, and invites a viewer', async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Keep your fundraising moving.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('mobile-landing.jpg'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('link', { name: 'Continue with Eliza' }).click();
  await page.getByRole('link', { name: 'Sign in as Owner' }).click();
  await expect(page.getByRole('heading', { name: 'Who is running this round?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel('Your name').fill('Shaw Fixture');
  await page.getByLabel('Work email').fill('owner@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Company name').fill('Cloud E2E');
  await page.getByLabel('One-line description').fill('Controlled browser verification.');
  await page.getByLabel('Fundraising narrative').fill('Fixture only.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Target raise (USD)').fill('1000000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your fundraising history belongs to your workspace.' }),
  ).toBeVisible();
  await page
    .getByLabel('Sender postal address (optional during setup)')
    .fill('123 Fixture Street, Test City, NY 10001');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await navigation.getByRole('link', { name: 'Investors', exact: true }).click();
  await page.getByRole('button', { name: 'Add investor', exact: true }).click();
  const firm = page.getByRole('dialog', { name: 'Add an investor' });
  await firm.getByLabel('Firm or investor name').fill('Outreachr E2E Investor');
  await firm.getByRole('button', { name: 'Add investor', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search firms' }).fill('Outreachr E2E Investor');
  await page.getByRole('button', { name: /^Outreachr E2E Investor/ }).click();
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  const person = page.getByRole('dialog', { name: 'Add person to Outreachr E2E Investor' });
  await person.getByLabel('Full name').fill('Shaw Fixture');
  await person.getByLabel('Work email', { exact: true }).fill('shaw@example.test');
  await person.getByRole('button', { name: 'Save person' }).click();
  await expect(person).toBeHidden();
  await page
    .locator('.person-row')
    .filter({ hasText: 'Shaw Fixture' })
    .getByRole('button', { name: 'Draft', exact: true })
    .click();
  await navigation.getByRole('link', { name: 'Outreach', exact: true }).click();
  await expect(page.getByRole('button', { name: /Shaw Fixture/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Shaw Fixture/ })).toBeVisible();
  await navigation.getByRole('link', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: 'Run with GPT-5.6-sol', exact: true }).click();
  await expect(
    page.getByText('Review the prepared follow-up task.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Workspace settings', exact: true }).click();
  await page.context().route('https://accounts.google.com/o/oauth2/**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    expect(state).toBeTruthy();
    await route.fulfill({
      contentType: 'text/html',
      body: `<html lang="en"><title>Local Google consent fixture</title><h1>Local Google consent fixture</h1><a href="http://127.0.0.1:4175/google-complete?state=${encodeURIComponent(state!)}">Authorize fixture mailbox</a></html>`,
    });
  });
  const consentPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Google account', exact: true }).click();
  const consent = await consentPromise;
  await consent.getByRole('link', { name: 'Authorize fixture mailbox' }).click();
  await expect(
    consent.getByRole('heading', { name: 'Fixture Google account connected' }),
  ).toBeVisible();
  await consent.close();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Gmail mailbox', exact: true })
    .selectOption({ label: 'owner@example.test' });
  await page.getByRole('button', { name: 'Save mailbox', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Gmail mailbox', exact: true })).not.toHaveValue(
    '',
  );
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export people CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('people');
  await page.getByLabel('Invite email').fill('viewer@example.test');
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  const invitation = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(invitation);
  await viewer.getByRole('link', { name: 'Continue with Eliza' }).click();
  await viewer.getByRole('link', { name: 'Sign in as Viewer' }).click();
  await viewer.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await viewer
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption({ label: 'Test Owner workspace' });
  await expect(viewer.getByText(/Viewer access/)).toBeVisible();
  await viewer.getByRole('link', { name: 'Workspace settings', exact: true }).click();
  await expect(
    viewer.getByRole('button', { name: 'Connect Google account', exact: true }),
  ).toBeDisabled();
  await expect(
    viewer
      .getByRole('combobox', { name: 'Gmail mailbox', exact: true })
      .getByRole('option', { name: 'owner@example.test' }),
  ).toHaveCount(0);
  await expect(
    viewer.getByRole('button', { name: 'Review subscription', exact: true }),
  ).toBeDisabled();
  await viewerContext.close();
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(
    serious.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Workspace settings', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'Workspace settings', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('mobile-settings.jpg'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await navigation.getByRole('link', { name: 'Investors', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search firms' })).toBeVisible();
  expect(errors).toEqual([]);
});
