import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachScreenshot, completeOnboarding, expect, navigate, test } from './fixtures';

test('previews, cancels, imports and drafts for an investor CSV through the Electron UI', async ({
  desktopApp,
  page,
  dataDirectory,
  rendererErrors,
}, testInfo) => {
  await completeOnboarding(page);
  const path = join(dataDirectory, 'founder-investors.csv');
  await writeFile(
    path,
    'name,type,person_name,work_email\nImported Founder Capital,angel,Imported Partner,imported@example.test',
  );
  await desktopApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
  await navigate(page, 'Investors');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Review investor CSV' });
  await expect(preview.getByText('Imported Founder Capital', { exact: true })).toBeVisible();
  await expect(preview.getByText('imported@example.test', { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, '06-review-private-csv');
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    (await page.evaluate(() => window.outreachr.bootstrap())).investors.some(
      (firm) => firm.name === 'Imported Founder Capital',
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await preview.getByRole('button', { name: 'Import reviewed rows' }).click();
  await expect(preview).toBeHidden();
  await expect(page.getByText('CSV imported', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search firms' }).fill('Imported Founder Capital');
  await page.getByRole('button', { name: /^Imported Founder Capital/u }).click();
  const person = page.locator('.person-row').filter({ hasText: 'Imported Partner' });
  await expect(person.getByRole('button', { name: 'Draft', exact: true })).toBeEnabled();
  await person.getByRole('button', { name: 'Draft', exact: true }).click();
  const data = await page.evaluate(() => window.outreachr.bootstrap());
  expect(
    data.drafts.find((draft) => draft.recipientEmail === 'imported@example.test'),
  ).toMatchObject({ approvalState: 'draft', sentAt: null });
  expect(rendererErrors).toEqual([]);
});
