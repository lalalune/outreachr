import { attachScreenshot, completeOnboarding, expect, navigate, test } from './fixtures';

test('creates an investor, adds a private person in the UI, and opens an outreach draft', async ({
  page,
  rendererErrors,
}, testInfo) => {
  await completeOnboarding(page);
  await navigate(page, 'Investors');
  await page.getByRole('button', { name: 'Add investor' }).click();
  const investorDialog = page.getByRole('dialog', { name: 'Add an investor' });
  await investorDialog.getByLabel('Firm or investor name').fill('Founder Contact Capital');
  await investorDialog.getByRole('button', { name: 'Add investor', exact: true }).click();
  await expect(investorDialog).toBeHidden();
  await page.getByRole('searchbox', { name: 'Search firms' }).fill('Founder Contact Capital');
  await page.getByRole('button', { name: /^Founder Contact Capital/u }).click();
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  const personDialog = page.getByRole('dialog', { name: 'Add person to Founder Contact Capital' });
  await personDialog.getByLabel('Full name').fill('Local Founder Partner');
  await personDialog.getByLabel('Title', { exact: true }).fill('Partner');
  await personDialog.getByLabel('Work email', { exact: true }).fill('founder-partner@example.test');
  await attachScreenshot(page, testInfo, '05-add-private-person');
  await personDialog.getByRole('button', { name: 'Save person' }).click();
  await expect(personDialog).toBeHidden();
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  await personDialog.getByLabel('Full name').fill('Local Founder Partner');
  await personDialog.getByRole('button', { name: 'Save person' }).click();
  await expect(
    page.getByText(
      'A person with this name already exists at this investor. Edit that person instead.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(personDialog).toBeVisible();
  await personDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const person = page.locator('.person-row').filter({ hasText: 'Local Founder Partner' });
  await expect(person.getByRole('button', { name: 'Draft', exact: true })).toBeEnabled();
  await person.getByRole('button', { name: 'Draft', exact: true }).click();
  await navigate(page, 'Outreach');
  await expect(page.getByRole('button', { name: /Local Founder Partner/u })).toBeVisible();
  const data = await page.evaluate(() => window.outreachr.bootstrap());
  expect(
    data.drafts.find((draft) => draft.recipientEmail === 'founder-partner@example.test'),
  ).toMatchObject({ sentAt: null, approvalState: 'draft' });
  expect(rendererErrors).toEqual([]);
});
