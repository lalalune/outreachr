import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InvestorDetail, MeetingItem, SourceReviewItem } from '../../src/shared/contracts';
import { App } from '../../src/renderer/src/App';
import { HashRouter } from '../../src/renderer/src/lib/router';
import { WorkspaceProvider } from '../../src/renderer/src/state/WorkspaceContext';
import { bootstrapFixture, installBridge } from './fixtures';

function renderRoute(route: string): void {
  window.location.hash = route;
  render(
    <HashRouter>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </HashRouter>,
  );
}

function investorDetail(expectedCheckUsd: number | null): InvestorDetail {
  const fixture = bootstrapFixture();
  return {
    ...fixture.investors[0]!,
    expectedCheckUsd,
    target: true,
    pipelineStage: 'diligence',
    website: 'https://calm.example',
    description: 'A fixture investor.',
    thesis: 'Seed AI.',
    applicationUrl: null,
    contactEmail: null,
    leadBehavior: null,
    currentFund: null,
    people: fixture.people,
    portfolio: [],
    sources: [],
    activity: [],
  };
}

describe('renderer command flows', () => {
  it('keeps investor section deep links on the detail route and scrolls to the requested section', async () => {
    const fixture = bootstrapFixture();
    const detail = investorDetail(null);
    const command = vi.fn(async (name: string) => {
      if (name === 'investor.get') return detail;
      throw new Error(`Unexpected renderer test command: ${name}`);
    });
    const scrolledIds: string[] = [];
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: function scrollIntoView(this: HTMLElement): void {
        scrolledIds.push(this.id);
      },
    });

    try {
      installBridge(fixture, command as never);
      renderRoute('#/investors/firm:test#portfolio');

      expect(await screen.findByRole('heading', { name: 'Calm Capital' })).toBeVisible();
      await waitFor(() => expect(scrolledIds).toContain('portfolio'));
      const sources = screen.getByRole('link', { name: /^Sources 0$/u });
      expect(sources).toHaveAttribute('href', '#/investors/firm:test#sources');
      fireEvent.click(sources);

      await waitFor(() => expect(window.location.hash).toBe('#/investors/firm:test#sources'));
      await waitFor(() => expect(scrolledIds).toContain('sources'));
      expect(screen.getByRole('heading', { name: 'Calm Capital' })).toBeVisible();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('records the exact expected-check amount selected by the founder', async () => {
    const fixture = bootstrapFixture();
    const detail = investorDetail(null);
    const command = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      if (name === 'investor.get') return detail;
      if (name === 'pipeline.amount') {
        return { ...detail, expectedCheckUsd: payload.expectedCheckUsd };
      }
      throw new Error(`Unexpected renderer test command: ${name}`);
    });
    installBridge(fixture, command as never);
    renderRoute('#/investors/firm:test');

    expect(await screen.findByRole('heading', { name: 'Calm Capital' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Record expected check' }));
    const dialog = screen.getByRole('dialog', { name: 'Expected check from Calm Capital' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /^Expected check \(USD\)/u }), {
      target: { value: '750000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save amount' }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('pipeline.amount', {
        investorId: 'firm:test',
        expectedCheckUsd: 750_000,
      }),
    );
    expect(await screen.findByText('Expected check updated')).toBeVisible();
  });

  it('sets a dated next action from the pipeline and shows the latest message date', async () => {
    const fixture = bootstrapFixture();
    fixture.investors[0] = {
      ...fixture.investors[0]!,
      target: true,
      pipelineStage: 'diligence',
      lastMessageAt: '2026-08-01T17:00:00.000Z',
    };
    fixture.counts.targeted = 1;
    fixture.pipeline.find((column) => column.stage === 'diligence')!.targetIds = ['firm:test'];
    const command = vi.fn(async (name: string) => {
      if (name === 'pipeline.nextAction') return fixture.investors[0]!;
      throw new Error(`Unexpected renderer test command: ${name}`);
    });
    const bridge = installBridge(fixture, command as never);
    renderRoute('#/pipeline');

    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeVisible();
    expect(screen.getByText(/Last message/u)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Set next action' }));
    const dialog = screen.getByRole('dialog', { name: 'Plan the next action' });
    fireEvent.change(within(dialog).getByLabelText('Next action'), {
      target: { value: 'Send requested metrics' },
    });
    fireEvent.change(within(dialog).getByLabelText('Due'), {
      target: { value: '2026-08-05T10:00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save next action' }));

    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith('pipeline.nextAction', {
        investorId: 'firm:test',
        nextAction: 'Send requested metrics',
        nextActionAt: new Date('2026-08-05T10:00').toISOString(),
      }),
    );
  });

  it('trims and saves private agenda and outcome context for one meeting', async () => {
    const fixture = bootstrapFixture();
    const meeting: MeetingItem = {
      id: 'meeting:renderer-update',
      title: 'Partner diligence call',
      startsAt: '2026-08-03T17:00:00.000Z',
      endsAt: '2026-08-03T17:30:00.000Z',
      provider: 'manual',
      investorId: 'firm:test',
      personIds: ['person:test'],
      location: 'Video',
      agenda: null,
      notes: null,
      status: 'upcoming',
    };
    fixture.meetings = [meeting];
    const command = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      if (name === 'meeting.update') return { ...meeting, ...payload };
      throw new Error(`Unexpected renderer test command: ${name}`);
    });
    installBridge(fixture, command as never);
    renderRoute('#/meetings');

    expect(await screen.findByRole('heading', { name: 'Meetings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open meeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Partner diligence call' });
    fireEvent.change(within(dialog).getByLabelText('Agenda'), {
      target: { value: '  Review enterprise adoption evidence  ' },
    });
    fireEvent.change(within(dialog).getByLabelText('Private notes and outcome'), {
      target: { value: '  Partner requested a security follow-up.  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save context' }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('meeting.update', {
        id: 'meeting:renderer-update',
        agenda: 'Review enterprise adoption evidence',
        notes: 'Partner requested a security follow-up.',
      }),
    );
    expect(await screen.findByText('Meeting context saved')).toBeVisible();
  });

  it('routes accept and reject to the exact source assertions selected by the founder', async () => {
    const fixture = bootstrapFixture();
    const source = {
      id: 'source:renderer',
      title: 'Investor site',
      url: 'https://calm.example/thesis',
      publisher: 'Calm Capital',
      observedAt: '2026-07-31T19:00:00.000Z',
      confidence: 'verified' as const,
      rights: 'link_only' as const,
    };
    fixture.sourceReview = [
      {
        id: 'claim:accept',
        entityName: 'Accept Capital',
        field: 'stage',
        currentValue: 'Pre-seed',
        proposedValue: 'Seed',
        source,
        status: 'pending',
      },
      {
        id: 'claim:reject',
        entityName: 'Reject Capital',
        field: 'sector',
        currentValue: 'AI',
        proposedValue: 'Consumer',
        source,
        status: 'pending',
      },
    ] satisfies SourceReviewItem[];
    const command = vi.fn(async (_name: string, payload: Record<string, unknown>) => ({
      ...fixture.sourceReview.find((item) => item.id === payload.id)!,
      status: payload.decision === 'accept' ? 'accepted' : 'rejected',
    }));
    installBridge(fixture, command as never);
    renderRoute('#/review');

    expect(await screen.findByRole('heading', { name: 'Sources & review' })).toBeVisible();
    const acceptRow = screen.getByText('Accept Capital').closest('article');
    const rejectRow = screen.getByText('Reject Capital').closest('article');
    expect(acceptRow).not.toBeNull();
    expect(rejectRow).not.toBeNull();
    fireEvent.click(within(acceptRow!).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('source.review', {
        id: 'claim:accept',
        decision: 'accept',
      }),
    );
    fireEvent.click(within(rejectRow!).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('source.review', {
        id: 'claim:reject',
        decision: 'reject',
      }),
    );
  });

  it('treats cancelled backup, restore, seed import, and CSV selections as no-ops', async () => {
    const fixture = bootstrapFixture();
    const bridge = installBridge(fixture);
    renderRoute('#/settings/data');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    const backupDialog = screen.getByRole('dialog', { name: 'Create encrypted backup' });
    fireEvent.change(within(backupDialog).getByLabelText(/^Backup password/u), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(
      within(backupDialog).getByRole('button', { name: 'Choose folder and encrypt' }),
    );
    await waitFor(() => expect(bridge.selectDirectory).toHaveBeenCalledTimes(1));
    fireEvent.click(within(backupDialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(bridge.selectFile).toHaveBeenCalledWith([
        { name: 'Outreachr encrypted backup', extensions: ['outreachr-backup'] },
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /Import Outreachr seed/u }));
    await waitFor(() =>
      expect(bridge.selectFile).toHaveBeenCalledWith([
        { name: 'Outreachr SQLite seed', extensions: ['sqlite', 'db'] },
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /Export private investor records/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Export audit CSV' }));
    await waitFor(() => expect(bridge.selectDirectory).toHaveBeenCalledTimes(3));

    expect(bridge.command).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Restore encrypted backup' }),
    ).not.toBeInTheDocument();
  });

  it('clears backup, restore, and vault-delete secrets when their dialogs are cancelled', async () => {
    const fixture = bootstrapFixture();
    const bridge = installBridge(fixture);
    vi.mocked(bridge.selectFile).mockResolvedValue('/tmp/founder.outreachr-backup');
    renderRoute('#/settings/data');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    let dialog = screen.getByRole('dialog', { name: 'Create encrypted backup' });
    fireEvent.change(within(dialog).getByLabelText(/^Backup password/u), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    dialog = screen.getByRole('dialog', { name: 'Create encrypted backup' });
    expect(within(dialog).getByLabelText(/^Backup password/u)).toHaveValue('');
    expect(
      within(dialog).getByRole('button', { name: 'Choose folder and encrypt' }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    dialog = await screen.findByRole('dialog', { name: 'Restore encrypted backup' });
    fireEvent.change(within(dialog).getByLabelText(/^Backup password/u), {
      target: { value: 'another secret password' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    dialog = await screen.findByRole('dialog', { name: 'Restore encrypted backup' });
    expect(within(dialog).getByLabelText(/^Backup password/u)).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Verify and restore' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Privacy & security' }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete local vault/u }));
    dialog = screen.getByRole('dialog', { name: 'Delete the local vault?' });
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' },
    });
    expect(within(dialog).getByRole('button', { name: 'Delete and restart' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Delete local vault/u }));
    dialog = screen.getByRole('dialog', { name: 'Delete the local vault?' });
    expect(within(dialog).getByLabelText('Type DELETE to confirm')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Delete and restart' })).toBeDisabled();
    expect(bridge.command).not.toHaveBeenCalled();
  });
});
