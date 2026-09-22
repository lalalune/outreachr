import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const path of ['/help.html', '/legal/data-handling.html']) {
  test(`public guidance is readable without an account: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('link', { name: /Outreachr/ }).click();
    await expect(
      page.getByRole('link', { name: 'Continue with Eliza', exact: true }),
    ).toBeVisible();
  });
}
