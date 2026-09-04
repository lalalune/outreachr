import type { Page } from '@playwright/test';
import { completeOnboarding, expect, navigate, test } from './fixtures';

interface Candidate {
  id: string;
  name: string;
  firmId: string;
}

async function twoPeopleWithoutEmail(page: Page): Promise<[Candidate, Candidate]> {
  const people = await page.evaluate(async () => {
    const data = await window.outreachr.bootstrap();
    return data.people
      .filter((person) => person.firmId && !person.email)
      .slice(0, 2)
      .map((person) => ({ id: person.id, name: person.name, firmId: person.firmId! }));
  });
  expect(people, 'The production seed needs two people without a work email').toHaveLength(2);
  return [people[0]!, people[1]!];
}

test.describe('Google connectors through the built Electron IPC boundary', () => {
  test('connects with PKCE, exhausts Gmail and Calendar pages, creates an invite, sends once, and blocks replay', async ({
    googleProviderMock,
    page,
    rendererErrors,
  }) => {
    await completeOnboarding(page);
    const [historicalPerson, sendRecipient] = await twoPeopleWithoutEmail(page);

    await navigate(page, 'Settings');
    await page.getByRole('button', { name: 'Mail & calendar', exact: true }).click();
    const googleSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Google Workspace', exact: true }),
    });
    await expect(googleSection).toBeVisible();
    await googleSection
      .getByRole('textbox', { name: 'Application (client) ID' })
      .fill('e2e-founder-owned-desktop-client');
    await googleSection.getByLabel('Desktop client secret').fill('e2e-google-desktop-secret');
    await googleSection.getByRole('checkbox', { name: /Enable relationship sync/u }).check();
    await googleSection.getByRole('button', { name: 'Save and connect in browser' }).click();

    await expect(page.getByText('Google connected', { exact: true })).toBeVisible();
    await expect(googleSection.getByText('ada@local.test', { exact: true })).toBeVisible();
    const tokenRequest = new URLSearchParams(googleProviderMock.tokenRequestBodies[0]);
    expect(tokenRequest.get('client_id')).toBe('e2e-founder-owned-desktop-client');
    expect(tokenRequest.get('grant_type')).toBe('authorization_code');
    expect(tokenRequest.get('code')).toBe('outreachr-e2e-google-code');
    expect(tokenRequest.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(tokenRequest.get('client_secret')).toBe('e2e-google-desktop-secret');
    expect(JSON.stringify(await page.evaluate(() => window.outreachr.bootstrap()))).not.toContain(
      'e2e-google-desktop-secret',
    );

    await googleSection.getByRole('button', { name: 'Sync mail history' }).click();
    await expect(
      page.getByText('Google relationship history synced', { exact: true }),
    ).toBeVisible();
    expect(googleProviderMock.gmailListQueries.slice(0, 2)).toEqual(['', '']);
    expect(googleProviderMock.gmailMetadataIds.sort()).toEqual([
      'ignored-inbound',
      'outbound-page-one',
      'outbound-page-two',
    ]);

    // Unmatched outbound headers are retained for lifetime duplicate safety and
    // become canonical when the founder later adds that exact address. The
    // unrelated inbound record is never surfaced or attributed.
    const reconciledHistory = await page.evaluate(async (personId) => {
      await window.outreachr.command('person.contact.add', {
        personId,
        kind: 'work_email',
        value: 'history.one@example.test',
        visibility: 'private',
        contributionEligible: false,
      });
      const data = await window.outreachr.bootstrap();
      return {
        events: data.mailEvents.map((event) => ({
          subject: event.subject,
          direction: event.direction,
          personId: event.personId,
        })),
        person: data.people.find((item) => item.id === personId),
      };
    }, historicalPerson.id);
    expect(reconciledHistory.events).toEqual([
      {
        subject: 'Historical page one',
        direction: 'outbound',
        personId: historicalPerson.id,
      },
    ]);
    expect(reconciledHistory.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'Unrelated inbound must be discarded' }),
      ]),
    );
    expect(reconciledHistory.person).toMatchObject({ contacted: true, canSendInitial: false });

    await googleSection.getByRole('button', { name: 'Sync calendar' }).click();
    await expect(page.getByText('Google calendar synced', { exact: true })).toBeVisible();
    expect(googleProviderMock.calendarPageTokens).toEqual([null, 'calendar-page-two']);
    const meetingTitles = await page.evaluate(async () =>
      (await window.outreachr.bootstrap()).meetings.map((meeting) => meeting.title),
    );
    expect(meetingTitles).toEqual(
      expect.arrayContaining(['Mock investor introduction', 'Mock investor follow-up']),
    );

    await navigate(page, 'Meetings');
    await page.getByRole('button', { name: 'Add meeting' }).first().click();
    const meetingDialog = page.getByRole('dialog', { name: 'Add a meeting' });
    const meetingStart = new Date(Date.now() + 7 * 86_400_000);
    meetingStart.setMinutes(0, 0, 0);
    const meetingEnd = new Date(meetingStart.getTime() + 30 * 60_000);
    const localInput = (value: Date): string => {
      const offset = value.getTimezoneOffset() * 60_000;
      return new Date(value.getTime() - offset).toISOString().slice(0, 16);
    };
    await meetingDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('E2E Google invite');
    await meetingDialog
      .getByRole('textbox', { name: 'Starts', exact: true })
      .fill(localInput(meetingStart));
    await meetingDialog
      .getByRole('textbox', { name: 'Ends', exact: true })
      .fill(localInput(meetingEnd));
    await meetingDialog
      .getByRole('combobox', { name: 'Calendar', exact: true })
      .selectOption('google');
    await meetingDialog
      .getByRole('combobox', { name: 'Investor', exact: true })
      .selectOption(historicalPerson.firmId);
    await meetingDialog
      .getByRole('checkbox', { name: new RegExp(historicalPerson.name, 'u') })
      .check();
    await meetingDialog
      .getByRole('button', { name: 'Create and send invitation', exact: true })
      .click();
    await expect(
      page.locator('#main-content').getByText('E2E Google invite', { exact: true }),
    ).toBeVisible();
    expect(googleProviderMock.calendarCreateCalls).toBe(1);
    expect(googleProviderMock.calendarCreateBodies[0]).toMatchObject({
      summary: 'E2E Google invite',
      attendees: [{ email: 'history.one@example.test', displayName: historicalPerson.name }],
    });
    const createdMeeting = await page.evaluate(async () =>
      (await window.outreachr.bootstrap()).meetings.find(
        (meeting) => meeting.title === 'E2E Google invite',
      ),
    );
    expect(createdMeeting).toMatchObject({
      provider: 'google',
      investorId: historicalPerson.firmId,
      personIds: [historicalPerson.id],
    });

    const sent = await page.evaluate(
      async ({ personId, recipientName }) => {
        await window.outreachr.command('person.contact.add', {
          personId,
          kind: 'work_email',
          value: 'fresh.target@example.test',
          visibility: 'private',
          contributionEligible: false,
        });
        const draft = await window.outreachr.command('draft.create', {
          personId,
          provider: 'google',
          kind: 'initial',
          subject: 'A founder-reviewed connector E2E message',
          bodyText: `Hi ${recipientName.split(' ')[0]},\n\nI believe our local-first AI infrastructure may fit your seed thesis.\n\nAda\n\n—\nAda Founder\nLocal Labs\n123 Founder Way\nSan Francisco, CA 94107\nUnited States\nIf you prefer no further email from me, reply "opt out" and I will not contact you again.`,
        });
        const approved = await window.outreachr.command('draft.approve', {
          id: draft.id,
          expectedContentHash: draft.contentHash,
        });
        return window.outreachr.command('draft.send', {
          id: approved.id,
          expectedContentHash: approved.contentHash,
        });
      },
      { personId: sendRecipient.id, recipientName: sendRecipient.name },
    );
    expect(sent).toMatchObject({
      approvalState: 'sent',
      providerMessageId: 'e2e-provider-message-1',
      recipientEmail: 'fresh.target@example.test',
    });
    expect(googleProviderMock.gmailSendCalls).toBe(1);
    // Adding a canonical email changes the identity digest. The send guard must
    // therefore invalidate the old completion cursor and exhaust both pages
    // again instead of relying on an incremental overlap query.
    expect(googleProviderMock.gmailListQueries).toEqual(['', '', '', '']);
    expect(googleProviderMock.gmailMetadataIds).toHaveLength(6);
    const rawMessage = Buffer.from(googleProviderMock.sentRawMessages[0]!, 'base64url').toString(
      'utf8',
    );
    expect(rawMessage).toMatch(/^To: .*<fresh\.target@example\.test>$/mu);
    expect(rawMessage).toContain('Subject: A founder-reviewed connector E2E message');
    expect(rawMessage).toMatch(/X-Outreachr-Operation-Key: send:[^\r\n]+/u);

    const replayError = await page.evaluate(async ({ id, contentHash }) => {
      try {
        await window.outreachr.command('draft.send', { id, expectedContentHash: contentHash });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, sent);
    expect(replayError).toMatch(/Exact founder approval is required/u);
    expect(googleProviderMock.gmailSendCalls).toBe(1);
    expect(googleProviderMock.authorizationHeaders.length).toBeGreaterThan(0);
    expect(new Set(googleProviderMock.authorizationHeaders)).toEqual(
      new Set(['Bearer e2e-google-access']),
    );
    expect(rendererErrors).toEqual([]);
  });
});
