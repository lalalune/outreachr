import { readFile, readdir, stat } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { attachScreenshot, completeOnboarding, expect, navigate, test } from './fixtures';

interface InvestorCandidate {
  investorId: string;
  investorName: string;
  personId: string;
  personName: string;
}

async function candidateWithoutEmail(page: Page): Promise<InvestorCandidate> {
  const candidate = await page.evaluate(async () => {
    const data = await window.outreachr.bootstrap();
    const person = data.people.find((item) => item.firmId && !item.email);
    if (!person?.firmId) return null;
    const investor = data.investors.find((item) => item.id === person.firmId);
    if (!investor) return null;
    return {
      investorId: investor.id,
      investorName: investor.name,
      personId: person.id,
      personName: person.name,
    };
  });
  expect(
    candidate,
    'The production seed needs at least one firm person without email',
  ).not.toBeNull();
  return candidate!;
}

async function seriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const serious = await seriousAxeViolations(page);
  expect(
    serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test.describe('Outreachr built Electron application', () => {
  test('onboards, researches a seeded investor, adds a private contact, approves but never sends, and moves the pipeline', async ({
    page,
    rendererErrors,
  }, testInfo) => {
    await expect(page.getByRole('heading', { name: 'Who is running this round?' })).toBeVisible();
    await attachScreenshot(page, testInfo, '01-onboarding-founder');
    await completeOnboarding(page);
    const candidate = await candidateWithoutEmail(page);

    const activeRoundDot = page.locator('.round-switcher__dot');
    await expect(activeRoundDot).toHaveCSS('width', '8px');
    await expect(activeRoundDot).toHaveCSS('height', '8px');
    await expect(activeRoundDot).toHaveCSS('flex-grow', '0');

    await navigate(page, 'Investors');
    await page.getByRole('searchbox', { name: 'Search firms' }).fill(candidate.investorName);
    await expect(page.getByText('1 results')).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`^${candidate.investorName}`) }).click();
    await expect(page.getByRole('heading', { name: candidate.investorName })).toBeVisible();

    const mainContent = page.locator('#main-content');
    await expect
      .poll(() => mainContent.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await mainContent.hover();
    await page.mouse.wheel(0, 800);
    await expect
      .poll(() => mainContent.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await mainContent.evaluate((element) => {
      element.scrollTop = 0;
    });

    await page.getByRole('button', { name: 'Add to round' }).click();
    await expect(page.getByRole('button', { name: 'In this round' })).toBeVisible();

    const personRow = page.locator('.person-row').filter({ hasText: candidate.personName });
    await personRow.getByRole('button', { name: 'Edit contacts' }).click();
    const privateEmail =
      `e2e.${candidate.personId.replaceAll(/[^a-z0-9]/giu, '-')}@example.test`.toLowerCase();
    const contactDialog = page.getByRole('dialog', {
      name: `Edit contact details for ${candidate.personName}`,
    });
    await contactDialog
      .getByRole('textbox', { name: 'Work email', exact: true })
      .fill(privateEmail);
    await contactDialog.getByRole('button', { name: 'Save contact details' }).click();
    await expect(personRow.getByRole('button', { name: 'Draft' })).toBeEnabled();
    await personRow.getByRole('button', { name: 'Draft' }).click();

    await navigate(page, 'Outreach');
    await expect(page.getByRole('heading', { name: 'Outreach' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(candidate.personName) }).click();
    await page.getByLabel('Subject').fill('A founder-reviewed possible fit');
    await page
      .getByLabel('Body')
      .fill(
        `Hi ${candidate.personName.split(' ')[0]},\n\nI believe our local-first AI infrastructure may fit your seed thesis.\n\nAda\n\n—\nAda Founder\nLocal Labs\n123 Founder Way\nSan Francisco, CA 94107\nUnited States\nIf you prefer no further email from me, reply "opt out" and I will not contact you again.`,
      );
    await page.getByRole('button', { name: 'Approve exact message' }).click();
    await expect(page.getByRole('button', { name: 'Send now' })).toBeVisible();
    await expect(
      page.getByText('This exact content is approved. Editing will require reapproval.'),
    ).toBeVisible();
    const approved = await page.evaluate(async () => {
      const data = await window.outreachr.bootstrap();
      return data.drafts[0];
    });
    expect(approved).toMatchObject({
      approvalState: 'approved',
      recipientEmail: privateEmail,
      subject: 'A founder-reviewed possible fit',
      sentAt: null,
      providerMessageId: null,
    });
    expect(await page.getByRole('button', { name: 'Send now' }).count()).toBe(1);
    await page.locator('.dialog__footer').getByRole('button', { name: 'Close' }).click();

    await navigate(page, 'Pipeline');
    const stage = page.getByLabel(`Move ${candidate.investorName}`);
    await expect(stage).toBeVisible();
    await stage.selectOption('diligence');
    await expect(stage).toHaveValue('diligence');
    const pipelineState = await page.evaluate(async (id) => {
      const data = await window.outreachr.bootstrap();
      return data.investors.find((item) => item.id === id)?.pipelineStage;
    }, candidate.investorId);
    expect(pipelineState).toBe('diligence');
    await attachScreenshot(page, testInfo, '02-approved-outreach-pipeline');
    await expectNoSeriousAxeViolations(page);
    expect(rendererErrors).toEqual([]);
  });

  test('creates founder-owned records, updates round settings, and exports a privacy-safe contribution', async ({
    page,
    exportDirectory,
    rendererErrors,
  }, testInfo) => {
    await completeOnboarding(page);

    await navigate(page, 'Investors');
    await page.getByRole('button', { name: 'Add investor' }).click();
    const investorDialog = page.getByRole('dialog', { name: 'Add an investor' });
    await investorDialog.getByLabel('Firm or investor name').fill('Never Export E2E Capital');
    await investorDialog.getByLabel('Investor type').selectOption('angel');
    await investorDialog.getByLabel('Website (optional)').fill('https://never-export-e2e.example');
    await investorDialog.getByLabel('Headquarters (optional)').fill('Los Angeles, CA');
    await investorDialog.getByRole('button', { name: 'Add investor', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add an investor' })).toBeHidden();
    await expect(page.getByText('Investor added')).toBeVisible();
    await expect(page.getByText('193 firms · 192 people')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search firms' }).fill('Never Export E2E Capital');
    await expect(page.getByText('1 results')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Never Export E2E Capital/u })).toBeVisible();

    await navigate(page, 'Tasks');
    await page.getByRole('button', { name: 'New task' }).click();
    const taskDialog = page.getByRole('dialog', { name: 'New task' });
    await taskDialog
      .getByRole('textbox', { name: 'Task', exact: true })
      .fill('Close E2E loose ends');
    await taskDialog.getByRole('textbox', { name: 'Due', exact: true }).fill('2030-08-01T10:00');
    await taskDialog.getByRole('button', { name: 'Create task' }).click();
    await expect(page.getByText('Close E2E loose ends')).toBeVisible();

    await navigate(page, 'Meetings');
    await page.getByRole('button', { name: 'Add meeting' }).first().click();
    const meetingDialog = page.getByRole('dialog', { name: 'Add a meeting' });
    await meetingDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('E2E investor meeting');
    await meetingDialog
      .getByRole('textbox', { name: 'Starts', exact: true })
      .fill('2030-08-02T10:00');
    await meetingDialog
      .getByRole('textbox', { name: 'Ends', exact: true })
      .fill('2030-08-02T10:30');
    await meetingDialog.getByRole('button', { name: 'Add meeting', exact: true }).click();
    await expect(page.locator('#main-content').getByText('E2E investor meeting')).toBeVisible();

    await navigate(page, 'Knowledge');
    await page.getByRole('button', { name: 'Add knowledge' }).click();
    const knowledgeDialog = page.getByRole('dialog', { name: 'Add knowledge' });
    await knowledgeDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('E2E metrics snapshot');
    await knowledgeDialog
      .getByRole('combobox', { name: 'Category', exact: true })
      .selectOption('metrics');
    await knowledgeDialog
      .getByRole('textbox', { name: 'Content', exact: true })
      .fill('Private estimate used only for deterministic E2E validation.');
    await knowledgeDialog
      .getByRole('combobox', { name: 'Disclosure policy', exact: true })
      .selectOption('internal');
    await knowledgeDialog.getByRole('button', { name: 'Save item' }).click();
    await expect(page.locator('#main-content').getByText('E2E metrics snapshot')).toBeVisible();

    await navigate(page, 'Documents');
    await page.getByRole('button', { name: 'Add link' }).click();
    const documentDialog = page.getByRole('dialog', { name: 'Track a document link' });
    await documentDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('E2E deck reference');
    await documentDialog
      .getByRole('textbox', { name: 'URL', exact: true })
      .fill('https://documents.example.test/deck');
    await documentDialog
      .getByRole('combobox', { name: 'Disclosure policy', exact: true })
      .selectOption('meeting_only');
    await documentDialog.getByRole('button', { name: 'Save link' }).click();
    await expect(page.getByText('E2E deck reference', { exact: true })).toBeVisible();

    await navigate(page, 'Lists');
    await page.getByRole('button', { name: 'New list' }).click();
    const listDialog = page.getByRole('dialog', { name: 'Create a list' });
    await listDialog.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E priority list');
    await listDialog
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Local founder-owned selection');
    await listDialog.getByRole('button', { name: 'Create list' }).click();
    await expect(page.locator('#main-content').getByText('E2E priority list')).toBeVisible();

    await navigate(page, 'Settings');
    await page.getByRole('button', { name: 'Round', exact: true }).click();
    await page.getByRole('button', { name: 'Edit round strategy' }).click();
    const roundDialog = page.getByRole('dialog', { name: 'Edit round strategy' });
    await roundDialog
      .getByRole('combobox', { name: 'Stage', exact: true })
      .selectOption('series_a');
    await roundDialog
      .getByRole('combobox', { name: 'Status', exact: true })
      .selectOption('planning');
    await roundDialog
      .getByRole('spinbutton', { name: 'Target raise (USD)', exact: true })
      .fill('8000000');
    await roundDialog
      .getByRole('spinbutton', { name: 'Minimum useful check', exact: true })
      .fill('500000');
    await roundDialog
      .getByRole('spinbutton', { name: 'Maximum expected check', exact: true })
      .fill('2000000');
    await roundDialog
      .getByRole('textbox', { name: 'Sector tags', exact: true })
      .fill('AI, Agentic, Enterprise');
    await roundDialog
      .getByRole('textbox', { name: 'Geographies', exact: true })
      .fill('United States');
    await roundDialog
      .getByRole('textbox', { name: 'Narrative', exact: true })
      .fill('Series A planning narrative for E2E.');
    await roundDialog.getByRole('button', { name: 'Save round' }).click();
    const round = await page.evaluate(async () => (await window.outreachr.bootstrap()).round);
    expect(round).toMatchObject({
      stage: 'series_a',
      status: 'planning',
      targetAmount: 8_000_000,
    });

    await page.getByRole('button', { name: 'Mail & calendar', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Daily hard limit', exact: true }).fill('3');
    await page.getByRole('button', { name: 'Save communication policy', exact: true }).click();
    await expect(page.getByText(/0 of 3 founder-approved sends reserved today/u)).toBeVisible();
    await page.getByRole('combobox', { name: 'Block by', exact: true }).selectOption('domain');
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('e2e-blocked.example');
    await page
      .getByRole('textbox', { name: 'Reason', exact: true })
      .fill('E2E founder-private suppression reason');
    await page.getByRole('button', { name: 'Add suppression', exact: true }).click();
    const suppressionList = page.getByLabel('Active communication suppressions');
    await expect(suppressionList.getByText('Domain · e2e-blocked.example')).toBeVisible();
    await page.getByRole('button', { name: 'Pause all sending', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Resume founder-approved sends', exact: true }),
    ).toBeVisible();

    await navigate(page, 'Outreach');
    await expect(page.getByText('All sending is paused')).toBeVisible();
    await navigate(page, 'Settings');
    await page.getByRole('button', { name: 'Mail & calendar', exact: true }).click();
    await page.getByRole('button', { name: 'Resume founder-approved sends', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pause all sending', exact: true }),
    ).toBeVisible();
    await suppressionList.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await expect(
      page.getByText('No active founder, bounce, complaint, or policy suppressions.'),
    ).toBeVisible();

    const contribution = await page.evaluate(
      async (directory) => window.outreachr.command('contribution.export', { directory }),
      exportDirectory,
    );
    expect((await stat(contribution.databasePath)).size).toBeGreaterThan(1_000);
    expect((await stat(contribution.diffPath)).size).toBeGreaterThan(100);
    const files = await readdir(exportDirectory);
    expect(files.filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    const databaseBytes = await readFile(contribution.databasePath);
    const diff = await readFile(contribution.diffPath, 'utf8');
    expect(databaseBytes.includes(Buffer.from('Never Export E2E Capital'))).toBe(false);
    expect(databaseBytes.includes(Buffer.from('Close E2E loose ends'))).toBe(false);
    expect(databaseBytes.includes(Buffer.from('Private estimate used only'))).toBe(false);
    expect(databaseBytes.includes(Buffer.from('E2E founder-private suppression reason'))).toBe(
      false,
    );
    expect(diff).toContain('Public allowlist only');
    expect(diff).not.toContain('Never Export E2E Capital');

    await attachScreenshot(page, testInfo, '03-production-ready-founder-records');
    await expectNoSeriousAxeViolations(page);
    expect(rendererErrors).toEqual([]);
  });

  test('loads every major page without renderer errors and passes serious/critical axe checks', async ({
    page,
    rendererErrors,
  }, testInfo) => {
    await completeOnboarding(page);
    const routes: Array<[string, string]> = [
      ['Up next', 'Up next'],
      ['Round overview', 'Local Labs Seed round'],
      ['Investors', 'Investor universe'],
      ['Pipeline', 'Pipeline'],
      ['Introductions', 'Introductions'],
      ['Outreach', 'Outreach'],
      ['Meetings', 'Meetings'],
      ['Knowledge', 'Knowledge'],
      ['Agent', 'Agent'],
      ['Sources & review', 'Sources & review'],
      ['Lists', 'Lists'],
      ['Tasks', 'Tasks'],
      ['Documents', 'Documents & data room'],
      ['Settings', 'Settings'],
    ];
    const routeViolations: Array<{
      theme: 'light' | 'dark';
      route: string;
      id: string;
      impact: string | null | undefined;
      help: string;
      targets: unknown[];
    }> = [];
    for (const [link, heading] of routes) {
      await navigate(page, link);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const serious = await seriousAxeViolations(page);
      routeViolations.push(
        ...serious.map((violation) => ({
          theme: 'light' as const,
          route: link,
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          targets: violation.nodes.map((node) => node.target),
        })),
      );
    }

    await navigate(page, 'Settings');
    await page.getByRole('combobox', { name: /^Theme/u }).selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => window.localStorage.getItem('outreachr.theme'))).toBe('dark');

    for (const [link, heading] of routes) {
      await navigate(page, link);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const serious = await seriousAxeViolations(page);
      routeViolations.push(
        ...serious.map((violation) => ({
          theme: 'dark' as const,
          route: link,
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          targets: violation.nodes.map((node) => node.target),
        })),
      );
    }

    await navigate(page, 'Round overview');
    await attachScreenshot(page, testInfo, '04-dark-theme-round-overview');
    expect(routeViolations).toEqual([]);
    expect(rendererErrors).toEqual([]);
  });

  test('keeps core navigation keyboard-operable at 200% zoom with reduced motion', async ({
    desktopApp,
    page,
    rendererErrors,
  }) => {
    await completeOnboarding(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await desktopApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Outreachr window is unavailable');
      window.webContents.setZoomFactor(2);
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Up next', exact: true })).toBeVisible();
    const routeBeforeSkip = await page.evaluate(() => window.location.hash);

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    expect(await page.evaluate(() => window.location.hash)).toBe(routeBeforeSkip);

    await navigate(page, 'Investors');
    await expect(
      page.getByRole('heading', { name: 'Investor universe', exact: true }),
    ).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    expect(rendererErrors).toEqual([]);
  });

  test('scrolls a long page from the main content panel', async ({ desktopApp, page }) => {
    await desktopApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Outreachr window is unavailable');
      window.setContentSize(1280, 768);
    });
    await completeOnboarding(page);

    const main = page.locator('#main-content');
    const dimensions = await main.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

    const bounds = await main.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.wheel(0, 1200);

    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
});
