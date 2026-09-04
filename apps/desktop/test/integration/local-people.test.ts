import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultService } from '../../src/main/vault-service';
import {
  initializedVault,
  onboard,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

describe('founder-created people', () => {
  const directories: string[] = [];
  const services: VaultService[] = [];
  async function fixture() {
    const directory = await temporaryDirectory('local-people');
    directories.push(directory);
    const service = await initializedVault(directory);
    services.push(service);
    await onboard(service);
    const firm = await service.createInvestor({ name: 'Private Founder Capital', kind: 'angel' });
    return { service, firm, directory };
  }
  afterEach(async () => {
    for (const service of services.splice(0)) service.vault.close();
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it('creates a contactable private person, drafts, reopens, and excludes them from contributions', async () => {
    const { service, firm, directory } = await fixture();
    const person = await service.createPerson({
      firmId: firm.id,
      name: 'Private Partner',
      title: 'Partner',
      workEmail: 'partner@private.test',
    });
    expect(person).toMatchObject({
      firmId: firm.id,
      name: 'Private Partner',
      workEmail: 'partner@private.test',
      canSendInitial: true,
    });
    const draft = await service.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'A possible fit',
      bodyText: 'Hello partner.',
    });
    expect(draft).toMatchObject({
      personId: person.id,
      recipientEmail: 'partner@private.test',
      approvalState: 'draft',
      sentAt: null,
    });
    expect(
      service.vault.one('SELECT is_public,contribution_eligible,origin FROM people WHERE id=?', [
        person.id,
      ]),
    ).toEqual({ is_public: 0, contribution_eligible: 0, origin: 'local' });
    const reopened = await initializedVault(directory);
    services.push(reopened);
    expect((await reopened.bootstrap()).people.find((item) => item.id === person.id)).toMatchObject(
      { email: 'partner@private.test' },
    );
    expect(reopened.integrityCheck().ok).toBe(true);
    const output = await reopened.exportContribution(directory);
    const exported = new service.vault.sqlite.Database(await readFile(output.databasePath));
    try {
      expect(exported.exec('SELECT COUNT(*) FROM people')[0]?.values[0]?.[0]).toBe(0);
      expect(exported.exec('SELECT COUNT(*) FROM public_work_emails')[0]?.values[0]?.[0]).toBe(0);
    } finally {
      exported.close();
    }
  });

  it('rejects duplicate identities and rolls back all partial contact writes', async () => {
    const { service, firm } = await fixture();
    const person = await service.createPerson({
      firmId: firm.id,
      name: 'Existing Partner',
      workEmail: 'existing@private.test',
    });
    const count = service.vault.scalar('SELECT COUNT(*) FROM people');
    await expect(
      service.createPerson({ firmId: firm.id, name: '  EXISTING   Partner ' }),
    ).rejects.toThrow('already exists');
    await expect(
      service.createPerson({
        firmId: firm.id,
        name: 'Duplicate Alias',
        workEmail: 'EXISTING@private.test',
      }),
    ).rejects.toThrow('already belongs');
    await expect(
      service.createPerson({
        firmId: firm.id,
        name: 'Partial Person',
        workEmail: 'fresh@private.test',
        personalEmail: 'invalid-email',
      }),
    ).rejects.toThrow();
    expect(service.vault.scalar('SELECT COUNT(*) FROM people')).toBe(count);
    expect(
      service.vault.scalar('SELECT COUNT(*) FROM contact_methods WHERE value=?', [
        'fresh@private.test',
      ]),
    ).toBe(0);
    expect(
      (await service.bootstrap()).people.find((item) => item.id === person.id)?.workEmail,
    ).toBe('existing@private.test');
    expect(service.integrityCheck().ok).toBe(true);
  });

  it('applies existing email suppressions to newly created people', async () => {
    const { service, firm } = await fixture();
    await service.addSuppression({
      scope: 'email',
      value: 'blocked@private.test',
      reason: 'Previously opted out',
    });
    const person = await service.createPerson({
      firmId: firm.id,
      name: 'Suppressed Partner',
      personalEmail: 'blocked@private.test',
    });
    expect(person).toMatchObject({
      canSendInitial: false,
      suppressionReason: 'Previously opted out',
    });
  });

  it('reconciles prior outbound history and retains the block after an email change', async () => {
    const { service, firm } = await fixture();
    await service.importMailboxMessages('google', 'ada@local.test', [
      {
        provider: 'google',
        id: 'historical-outbound',
        subject: 'Earlier introduction',
        from: { email: 'ada@local.test' },
        to: [{ email: 'history@private.test' }],
        occurredAt: '2026-07-20T12:00:00.000Z',
        direction: 'outbound',
      },
    ]);
    const person = await service.createPerson({
      firmId: firm.id,
      name: 'Known Partner',
      personalEmail: 'history@private.test',
    });
    expect(person).toMatchObject({ contacted: true, canSendInitial: false });
    const updated = await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'new-address@private.test',
      visibility: 'private',
      contributionEligible: false,
    });
    expect(updated).toMatchObject({
      email: 'new-address@private.test',
      contacted: true,
      canSendInitial: false,
    });
  });
});
