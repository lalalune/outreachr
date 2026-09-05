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
  await expect(
    page.getByText('Cloud workspace setup is being confirmed.', { exact: false }),
  ).toBeVisible();
  const pendingSetup = await (await page.request.get('/api/me')).json();
  const pendingOrg = pendingSetup.organizations[0];
  expect(pendingOrg.trial_ends_at).toBeNull();
  expect(pendingOrg.entitlement.canEdit).toBe(false);
  expect((await page.request.post('http://127.0.0.1:4175/test/billing/trial-unblock')).ok()).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Retry workspace setup', exact: true }).click();
  await expect(page.getByText('Free trial through', { exact: false })).toBeVisible();
  const confirmedSetup = await (await page.request.get('/api/me')).json();
  const confirmedOrg = confirmedSetup.organizations[0];
  const trialProof = await (
    await page.request.get('http://127.0.0.1:4175/test/billing/trial')
  ).json();
  expect(trialProof).toMatchObject({ effects: 1, exactRetry: true });
  expect(confirmedOrg.trial_ends_at).toBe(trialProof.trial.endsAt);
  expect(confirmedOrg.cloud_provisioning_state).toBe('ready');
  expect(confirmedOrg.cloud_membership_ready).toBe(true);
  expect(confirmedOrg.entitlement.canEdit).toBe(true);

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
  // Returning from billing must update the app banner and selected model's access,
  // rather than displaying the pre-checkout account object until a page reload.
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const org of body.organizations) {
      org.entitlement.canEdit = false;
      org.entitlement.active = false;
      org.entitlement.trial = false;
      org.subscription_status = 'canceled';
    }
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/Subscription required to edit, use AI, or send mail/)).toBeVisible();
  await page.unroute('**/api/me');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/Subscription required to edit, use AI, or send mail/)).toHaveCount(
    0,
  );
  await page.route('**/api/google/connections', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Finish free account setup in Eliza Cloud before connecting Google.',
        code: 'google_account_setup_required',
      }),
    }),
  );
  await page.getByRole('link', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Finish free account setup');
  await expect(page.getByRole('row').filter({ hasText: 'owner@example.test' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review subscription', exact: true }),
  ).toBeEnabled();
  await page.unroute('**/api/google/connections');
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/AI allowance used: \$0\.01 of \$2\.00/)).toBeVisible();

  await page.getByRole('button', { name: 'Review subscription', exact: true }).click();
  const billingReview = page.getByLabel('Subscription review', { exact: true });
  await expect(billingReview).toContainText('$49.00 per month before tax');
  await expect(billingReview).toContainText('Quoted amount due now: $0.00');
  await page.getByRole('button', { name: 'Dismiss review', exact: true }).click();
  await expect(billingReview).toHaveCount(0);
  await page.getByRole('button', { name: 'Review subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Agree and continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cloud has not confirmed this request');
  await page.getByRole('button', { name: 'Check billing request', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Cloud confirmed the billing request' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  expect(
    (await page.request.post('http://127.0.0.1:4175/test/billing/external-checkout')).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Check billing request', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Continue to checkout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel open checkout', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Checkout cancellation is being confirmed' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue to checkout', exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Check billing request', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Checkout canceled.');
  expect(
    await (await page.request.get('http://127.0.0.1:4175/test/billing/expiry-count')).json(),
  ).toEqual({ count: 1 });
  await page.getByRole('button', { name: 'Check billing request', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

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
  await expect(
    page
      .getByRole('main')
      .getByRole('status')
      .filter({ hasText: /^Saved\.$/ }),
  ).toHaveText('Saved.');
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
  const acceptedAccount = await (
    await viewer.request.get(new URL('/api/me', viewer.url()).href)
  ).json();
  const acceptedWorkspace = acceptedAccount.organizations.find(
    (org: { name: string }) => org.name === 'Test Owner workspace',
  );
  expect(acceptedWorkspace.cloud_membership_ready).toBe(true);
  expect(acceptedWorkspace.entitlement.canEdit).toBe(false);
  expect(acceptedWorkspace.seat_capacity).toBe(1);
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
  // An ownership transfer keeps editing seats and the original trial period intact,
  // including a provider commit whose first response cannot be observed.
  expect(
    (await page.request.post('http://127.0.0.1:4175/test/billing/ownership-prepare')).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`/api/organizations/${acceptedWorkspace.id}/billing/refresh`, {
        data: {},
        headers: { Origin: 'http://127.0.0.1:4173', 'X-Outreachr-Request': '1' },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByLabel('Role for viewer@example.test', { exact: true }).selectOption('member');
  const transfer = page.getByRole('button', {
    name: 'Transfer ownership to viewer@example.test',
    exact: true,
  });
  await expect(transfer).toBeEnabled();
  await transfer.click();
  await expect(page.getByText('An ownership change is pending.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Role for owner@example.test', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Review subscription', exact: true }),
  ).toBeDisabled();
  expect(
    (await page.request.post('http://127.0.0.1:4175/test/billing/ownership-unblock')).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Check ownership status', exact: true }).click();
  await expect(page.getByLabel('Role for owner@example.test', { exact: true })).toHaveValue(
    'member',
  );
  await expect(page.getByLabel('Role for viewer@example.test', { exact: true })).toHaveValue(
    'owner',
  );
  await expect(
    page.getByRole('button', { name: 'Review subscription', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await viewer.reload();
  await expect(viewer.getByLabel('Role for viewer@example.test', { exact: true })).toHaveValue(
    'owner',
  );
  await expect(
    viewer.getByRole('button', { name: 'Review subscription', exact: true }),
  ).toBeEnabled();
  const transferredAccount = await (await viewer.request.get('/api/me')).json();
  const transferredWorkspace = transferredAccount.organizations.find(
    (org: { id: string }) => org.id === acceptedWorkspace.id,
  );
  expect(transferredWorkspace.trial_ends_at).toBe(acceptedWorkspace.trial_ends_at);
  expect(transferredWorkspace.seat_capacity).toBe(2);
  expect(
    await (await page.request.get('http://127.0.0.1:4175/test/billing/ownership')).json(),
  ).toMatchObject({ effects: 1, seats: 2 });
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
