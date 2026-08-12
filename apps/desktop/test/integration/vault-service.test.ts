import { createHash } from 'node:crypto';
import { readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEncryptedBackup, restoreEncryptedBackup } from '@outreachr/core';
import type { VaultService } from '../../src/main/vault-service';
import {
  RESOURCE_ROOT,
  firstPersonWithoutEmail,
  initializedVault,
  onboard,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

const PINNED_FILE_DIGEST = 'b120aeb6a71f201e6a4a3198e0b9a7eef45ff24b2c0b224b8e763fbea2caee23';
const PINNED_LOGICAL_DIGEST = 'e91f834c59b9d7fc0a679174513c9b44b228cc6925c3654443f1b534d1643899';

function normalizedSeedInvestorKind(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (/token|crypto|blockchain|web3/u.test(normalized)) return 'crypto_fund';
  if (normalized.includes('corporate')) return 'corporate_vc';
  if (normalized.includes('family office')) return 'family_office';
  if (normalized.includes('accelerator')) return 'accelerator';
  if (normalized.includes('studio')) return 'venture_studio';
  if (normalized.includes('syndicate')) return 'syndicate';
  if (normalized.includes('scout')) return 'scout';
  if (normalized.includes('angel network') || normalized.includes('founder community'))
    return 'angel_network';
  if (normalized.includes('angel')) return 'angel';
  if (normalized.includes('solo')) return 'solo_gp';
  if (normalized.includes('micro')) return 'micro_vc';
  if (normalized.includes('institutional vc') || normalized.includes('venture capital'))
    return 'venture_capital';
  throw new Error(`Unknown seed investor type in test fixture: ${label}`);
}

describe('VaultService with the production investor seed', () => {
  const directories: string[] = [];
  const services: VaultService[] = [];

  const create = async (): Promise<{ service: VaultService; directory: string }> => {
    const directory = await temporaryDirectory('vault');
    directories.push(directory);
    const service = await initializedVault(directory);
    services.push(service);
    return { service, directory };
  };

  afterEach(async () => {
    for (const service of services.splice(0)) {
      try {
        service.vault.close();
      } catch {
        // A restore test may already have replaced or closed the original database.
      }
    }
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it('pins, imports, and persists the complete production seed in an isolated vault', async () => {
    const seedBytes = await readFile(`${RESOURCE_ROOT}/Outreachr_Investor_Seed.sqlite`);
    expect(createHash('sha256').update(seedBytes).digest('hex')).toBe(PINNED_FILE_DIGEST);

    const { service } = await create();
    const bootstrap = await service.bootstrap();

    expect(service.integrityCheck()).toEqual({ ok: true, messages: ['ok'] });
    expect(bootstrap).toMatchObject({
      appVersion: '0.1.0-test',
      isFirstRun: true,
      seedVersion: '0.1.1',
      seedSignatureStatus: 'pinned unsigned research',
      counts: { firms: 192, people: 192 },
    });
    expect(bootstrap.investors).toHaveLength(192);
    expect(bootstrap.people).toHaveLength(192);
    expect(Number(service.vault.scalar('SELECT COUNT(*) FROM sources'))).toBe(1_010);
    expect(Number(service.vault.scalar('SELECT COUNT(*) FROM claims'))).toBe(2_790);
    expect(
      service.vault.all(
        `SELECT investor_type,COUNT(*) count FROM firms f
         WHERE f.origin='seed' AND NOT EXISTS (
           SELECT 1 FROM people p WHERE p.id=f.id AND p.firm_id=f.id
         ) GROUP BY investor_type ORDER BY investor_type`,
      ),
    ).toEqual([
      { investor_type: 'micro_vc', count: 88 },
      { investor_type: 'venture_capital', count: 79 },
    ]);
    expect(bootstrap.investors.find((firm) => firm.name === 'Boost VC')).toMatchObject({
      kind: 'micro_vc',
      additionalKinds: expect.arrayContaining(['accelerator', 'crypto_fund']),
    });
    expect(bootstrap.investors.find((firm) => firm.name === 'South Park Commons')).toMatchObject({
      kind: 'venture_capital',
      additionalKinds: expect.arrayContaining(['accelerator', 'angel_network']),
    });
    const rawTypeClaims = service.vault.all<{ entity_id: string; value_json: string }>(
      `SELECT entity_id,value_json FROM claims
       WHERE entity_type='firm' AND field='investor_types' ORDER BY entity_id`,
    );
    expect(rawTypeClaims).toHaveLength(192);
    const investorById = new Map(bootstrap.investors.map((investor) => [investor.id, investor]));
    for (const claim of rawTypeClaims) {
      const raw = JSON.parse(claim.value_json) as unknown;
      expect(typeof raw).toBe('string');
      const expected = [
        ...new Set(String(raw).split(';').filter(Boolean).map(normalizedSeedInvestorKind)),
      ].sort();
      const investor = investorById.get(claim.entity_id);
      expect(investor, `missing runtime investor ${claim.entity_id}`).toBeDefined();
      expect([...new Set([investor!.kind, ...investor!.additionalKinds])].sort()).toEqual(expected);
    }
    expect(bootstrap.people.find((person) => person.name === 'Andrew Yeung')).toMatchObject({
      investorKinds: expect.arrayContaining(['angel', 'angel_network']),
    });
    const aarthi = bootstrap.people.find((person) => person.name === 'Aarthi Ramamurthy');
    expect(aarthi?.sectors).toEqual(
      expect.arrayContaining(['AI and ML tooling', 'robotics', 'manufacturing automation']),
    );
    expect(aarthi?.sectors).not.toEqual(
      expect.arrayContaining(['San Francisco, CA', 'Micro VC', 'Solo GP', 'Schema Ventures']),
    );
    expect(
      service.vault.all(
        `SELECT f.investor_type,COUNT(*) count
         FROM firms f JOIN people p ON p.id=f.id AND p.firm_id=f.id
         WHERE f.origin='seed' AND f.investor_type<>'vc_firm'
         GROUP BY f.investor_type ORDER BY f.investor_type`,
      ),
    ).toEqual([
      { investor_type: 'angel', count: 9 },
      { investor_type: 'family_office', count: 1 },
      { investor_type: 'scout', count: 2 },
      { investor_type: 'solo_gp', count: 13 },
    ]);
    expect(
      Number(
        service.vault.scalar(
          `SELECT COUNT(*) FROM people p
           JOIN firms f ON f.id=p.id
           WHERE p.origin='seed' AND p.firm_id=p.id AND f.origin='seed'`,
        ),
      ),
    ).toBe(25);
    expect(
      service.vault.all(
        `SELECT entity_type,COUNT(*) count FROM claims
         WHERE field='primary_investor_type' GROUP BY entity_type ORDER BY entity_type`,
      ),
    ).toEqual([
      { entity_type: 'firm', count: 25 },
      { entity_type: 'person', count: 25 },
    ]);
    expect(
      service.vault.all(
        `SELECT entity_type,COUNT(*) count FROM claims
         WHERE field='investor_types' GROUP BY entity_type ORDER BY entity_type`,
      ),
    ).toEqual([
      { entity_type: 'firm', count: 192 },
      { entity_type: 'person', count: 25 },
    ]);
    expect(
      Number(
        service.vault.scalar(
          `SELECT COUNT(*) FROM entity_sources person_source
           WHERE person_source.entity_type='person'
             AND person_source.entity_id IN (
               SELECT id FROM people WHERE origin='seed' AND firm_id=id
             )
             AND EXISTS (
               SELECT 1 FROM entity_sources firm_source
               WHERE firm_source.entity_type='firm'
                 AND firm_source.entity_id=person_source.entity_id
                 AND firm_source.source_id=person_source.source_id
                 AND firm_source.source_role=person_source.source_role
             )`,
        ),
      ),
    ).toBe(162);
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM claims WHERE source_id IS NOT NULL AND field NOT IN ('linkedin_url','x_url','contact_url')",
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM claims WHERE field IN ('portfolio_example','named_partner') AND source_id IS NOT NULL",
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        service.vault.scalar(
          `SELECT COUNT(*) FROM contact_methods c LEFT JOIN sources s ON s.id=c.source_id
           WHERE c.source_id IS NULL
              OR rtrim(lower(c.normalized_value),'/')<>rtrim(lower(s.canonical_url),'/')`,
        ),
      ),
    ).toBe(0);
    expect(
      service.vault.scalar(
        'SELECT logical_digest_sha256 FROM seed_imports ORDER BY imported_at DESC LIMIT 1',
      ),
    ).toBe(PINNED_LOGICAL_DIGEST);
    expect(Number(service.vault.scalar('SELECT COUNT(*) FROM seed_imports'))).toBe(1);

    const independent = bootstrap.investors.find((investor) => investor.id === 'I001');
    expect(independent).toMatchObject({
      name: 'Joanne Wilson',
      kind: 'angel',
      peopleCount: 1,
      target: false,
    });
    await onboard(service);
    await service.targetInvestor('I001', true);
    expect(
      (await service.bootstrap()).investors.find((investor) => investor.id === 'I001'),
    ).toMatchObject({ target: true, pipelineStage: 'researching' });
    expect(await service.investorDetail('I001')).toMatchObject({
      id: 'I001',
      kind: 'angel',
      people: [{ id: 'I001', firmId: 'I001', name: 'Joanne Wilson' }],
    });
    expect(bootstrap.investors.find((investor) => investor.id === 'I002')).toMatchObject({
      kind: 'solo_gp',
      additionalKinds: expect.arrayContaining(['angel', 'syndicate']),
    });
    expect(
      bootstrap.investors.find((investor) => investor.id === 'I002')?.additionalKinds,
    ).not.toContain('crypto_fund');

    const unattributedPortfolio = service.vault.one<{ entity_id: string; id: string }>(
      "SELECT entity_id,id FROM claims WHERE entity_type='firm' AND field='portfolio_example' AND source_id IS NULL ORDER BY id LIMIT 1",
    );
    expect(unattributedPortfolio).toBeDefined();
    const unattributedDetail = await service.investorDetail(unattributedPortfolio!.entity_id);
    expect(
      unattributedDetail.portfolio.find((portfolio) => portfolio.id === unattributedPortfolio!.id)
        ?.source,
    ).toEqual({
      id: 'unattributed',
      title: 'Unattributed seed record',
      url: '',
      publisher: 'Unknown',
      observedAt: expect.any(String),
      confidence: 'unknown',
      rights: 'unknown',
    });

    if (process.platform !== 'win32') {
      expect((await stat(service.vaultPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the bundled research seed entirely out of public contribution exports', async () => {
    const { service } = await create();
    const output = await temporaryDirectory('seed-only-contribution');
    directories.push(output);
    const contribution = await service.exportContribution(output);
    const exported = new service.vault.sqlite.Database(await readFile(contribution.databasePath));
    try {
      for (const table of [
        'sources',
        'firms',
        'people',
        'funds',
        'claims',
        'entity_sources',
        'tags',
        'entity_tags',
        'public_work_emails',
      ]) {
        expect(
          Number(exported.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? -1),
        ).toBe(0);
      }
      expect(exported.exec('SELECT license_spdx FROM package_manifest')[0]?.values[0]?.[0]).toBe(
        'NOASSERTION',
      );
    } finally {
      exported.close();
    }
  });

  it('reopens without duplicating seed data and preserves complete founder workflows', async () => {
    const { service, directory } = await create();
    await onboard(service);
    const investor = await service.createInvestor({
      name: 'Private E2E Capital',
      kind: 'micro_vc',
      website: 'https://private-e2e.example',
      headquarters: 'New York, NY',
      description: 'Founder-private fixture.',
    });
    await service.targetInvestor(investor.id, true);
    await service.moveInvestor(investor.id, 'diligence');
    await service.updateNextAction(
      investor.id,
      'Send requested metrics',
      '2026-08-05T17:00:00.000Z',
    );
    await service.createTask({
      title: 'Confirm partner fit',
      notes: 'Private task notes',
      dueAt: '2026-08-03T17:00:00.000Z',
      status: 'open',
      investorId: investor.id,
      personId: null,
    });
    await service.createMeeting({
      title: 'Private partner call',
      startsAt: '2026-08-04T18:00:00.000Z',
      endsAt: '2026-08-04T18:30:00.000Z',
      provider: 'manual',
      investorId: investor.id,
      personIds: [],
      location: 'Video',
      agenda: 'Fit',
      notes: null,
      status: 'upcoming',
    });
    await service.saveKnowledge({
      title: 'Current ARR',
      category: 'metrics',
      content: 'Private estimate: $1.2m ARR.',
      sharePolicy: 'internal',
    });
    await service.createList({ name: 'Priority partners', description: 'Founder-owned list' });
    service.vault.close();
    services.splice(services.indexOf(service), 1);

    const reopened = await initializedVault(directory, () => new Date('2026-08-01T00:00:00.000Z'));
    services.push(reopened);
    const bootstrap = await reopened.bootstrap();
    expect(bootstrap.isFirstRun).toBe(false);
    expect(bootstrap.round).toMatchObject({ companyName: 'Local Labs', stage: 'seed' });
    expect(bootstrap.investors.find((item) => item.id === investor.id)).toMatchObject({
      target: true,
      pipelineStage: 'diligence',
      nextAction: 'Send requested metrics',
      nextActionAt: '2026-08-05T17:00:00.000Z',
    });
    expect(bootstrap.tasks.some((item) => item.title === 'Confirm partner fit')).toBe(true);
    expect(bootstrap.meetings.some((item) => item.title === 'Private partner call')).toBe(true);
    expect(bootstrap.knowledge.some((item) => item.title === 'Current ARR')).toBe(true);
    expect(bootstrap.lists.some((item) => item.name === 'Priority partners')).toBe(true);
    expect(Number(reopened.vault.scalar('SELECT COUNT(*) FROM seed_imports'))).toBe(1);
    expect(reopened.integrityCheck().ok).toBe(true);
  });

  it('serializes concurrent vault snapshots without stale writes or shared temp files', async () => {
    const { service, directory } = await create();
    await onboard(service);
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 20; index += 1) {
      service.vault.run('UPDATE founder_profiles SET company_name=? WHERE id=?', [
        `Concurrent Company ${index}`,
        'founder',
      ]);
      pending.push(service.persist());
    }
    await Promise.all(pending);

    const persisted = new service.vault.sqlite.Database(
      new Uint8Array(await readFile(service.vaultPath)),
    );
    try {
      expect(
        persisted.exec("SELECT company_name FROM founder_profiles WHERE id='founder'")[0]
          ?.values[0]?.[0],
      ).toBe('Concurrent Company 19');
    } finally {
      persisted.close();
    }
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps individual email private, prefers work email, and redacts both from agent context', async () => {
    const { service } = await create();
    await onboard(service);
    const person = firstPersonWithoutEmail(service);

    await expect(
      service.addPersonContact({
        personId: person.id,
        kind: 'personal_email',
        value: 'private.person@example.test',
        visibility: 'public',
        contributionEligible: true,
      }),
    ).rejects.toThrow(/local-private/u);

    const withPersonal = await service.addPersonContact({
      personId: person.id,
      kind: 'personal_email',
      value: 'private.person@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    expect(withPersonal).toMatchObject({
      workEmail: null,
      personalEmail: 'private.person@example.test',
      email: 'private.person@example.test',
      canSendInitial: true,
    });
    expect(
      service.vault.one<{
        visibility: string;
        contribution_eligible: number;
        source_id: string | null;
      }>(
        "SELECT visibility,contribution_eligible,source_id FROM contact_methods WHERE person_id=? AND kind='personal_email'",
        [person.id],
      ),
    ).toEqual({ visibility: 'private', contribution_eligible: 0, source_id: null });

    const withWork = await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'work.person@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    expect(withWork).toMatchObject({
      workEmail: 'work.person@example.test',
      personalEmail: 'private.person@example.test',
      email: 'work.person@example.test',
    });

    const context = await service.agentContext(['investors']);
    expect(context.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: person.id,
          email: null,
          workEmail: null,
          personalEmail: null,
        }),
      ]),
    );
  });

  it('recovers canonical people from attendee email in legacy meeting JSON', async () => {
    const { service } = await create();
    await onboard(service);
    const person = firstPersonWithoutEmail(service);
    await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'legacy.calendar.partner@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const meeting = await service.createMeeting({
      title: 'Legacy attendee relationship',
      startsAt: '2026-08-04T18:00:00.000Z',
      endsAt: '2026-08-04T18:30:00.000Z',
      provider: 'manual',
      investorId: person.firmId,
      personIds: [person.id],
      location: null,
      agenda: null,
      notes: null,
      status: 'upcoming',
    });
    service.vault.run('UPDATE meetings SET attendee_json=? WHERE id=?', [
      JSON.stringify([
        {
          name: person.name,
          email: 'legacy.calendar.partner@example.test',
        },
      ]),
      meeting.id,
    ]);

    expect(
      (await service.bootstrap()).meetings.find((item) => item.id === meeting.id),
    ).toMatchObject({
      investorId: person.firmId,
      personIds: [person.id],
    });
  });

  it('persists not-now distinctly and reuses a person-scoped task target across reloads', async () => {
    const { service, directory } = await create();
    await onboard(service);
    const person = firstPersonWithoutEmail(service);
    await service.targetInvestor(person.firmId, true);
    await service.moveInvestor(person.firmId, 'not_now');

    const firstTask = await service.createTask({
      title: 'Research the partner',
      notes: 'Person-scoped founder follow-up.',
      dueAt: '2026-08-05T17:00:00.000Z',
      status: 'open',
      investorId: person.firmId,
      personId: person.id,
    });
    const secondTask = await service.createTask({
      title: 'Prepare partner questions',
      notes: null,
      dueAt: null,
      status: 'open',
      investorId: person.firmId,
      personId: person.id,
    });
    expect(firstTask).toMatchObject({ investorId: person.firmId, personId: person.id });
    expect(secondTask).toMatchObject({ investorId: person.firmId, personId: person.id });
    expect(
      Number(
        service.vault.scalar('SELECT COUNT(*) FROM targets WHERE round_id=? AND person_id=?', [
          (await service.bootstrap()).round!.id,
          person.id,
        ]),
      ),
    ).toBe(1);
    expect(
      (await service.bootstrap()).investors.find((item) => item.id === person.firmId),
    ).toMatchObject({ pipelineStage: 'not_now', nextAction: 'Not now' });

    service.vault.close();
    services.splice(services.indexOf(service), 1);
    const reopened = await initializedVault(directory, () => new Date('2026-08-01T00:00:00.000Z'));
    services.push(reopened);
    await reopened.createTask({
      title: 'Send the partner brief',
      notes: null,
      dueAt: null,
      status: 'open',
      investorId: person.firmId,
      personId: person.id,
    });
    const afterReload = await reopened.bootstrap();
    expect(afterReload.tasks.filter((item) => item.personId === person.id)).toHaveLength(3);
    expect(
      Number(
        reopened.vault.scalar('SELECT COUNT(*) FROM targets WHERE round_id=? AND person_id=?', [
          afterReload.round!.id,
          person.id,
        ]),
      ),
    ).toBe(1);
    expect(afterReload.investors.find((item) => item.id === person.firmId)).toMatchObject({
      pipelineStage: 'not_now',
      nextAction: 'Not now',
    });

    await reopened.moveInvestor(person.firmId, 'ready');
    expect(
      (await reopened.bootstrap()).investors.find((item) => item.id === person.firmId),
    ).toMatchObject({ pipelineStage: 'ready', nextAction: null });
    expect(
      reopened.vault.one<{ disposition: string | null; owner_note: string | null }>(
        'SELECT disposition,owner_note FROM targets WHERE firm_id=? AND person_id IS NULL',
        [person.firmId],
      ),
    ).toEqual({ disposition: null, owner_note: null });
  });

  it('keeps accepted and rejected source reviews terminal with attributable source data', async () => {
    const { service, directory } = await create();
    const claims = service.vault.all<{ id: string; canonical_url: string }>(
      `SELECT c.id,s.canonical_url
       FROM claims c JOIN sources s ON s.id=c.source_id
       WHERE trim(s.canonical_url)!='' ORDER BY c.id LIMIT 2`,
    );
    expect(claims).toHaveLength(2);
    service.vault.run(
      "UPDATE claims SET status='stale',review_disposition=NULL,reviewed_at=NULL WHERE id IN (?,?)",
      [claims[0]!.id, claims[1]!.id],
    );
    await service.persist();

    await expect(service.reviewSource(claims[0]!.id, 'accept')).resolves.toMatchObject({
      id: claims[0]!.id,
      status: 'accepted',
      source: { url: claims[0]!.canonical_url },
    });
    await expect(service.reviewSource(claims[1]!.id, 'reject')).resolves.toMatchObject({
      id: claims[1]!.id,
      status: 'rejected',
      source: { url: claims[1]!.canonical_url },
    });
    await expect(service.reviewSource(claims[1]!.id, 'reject')).rejects.toThrow(
      'no longer pending',
    );
    expect((await service.bootstrap()).sourceReview.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(claims.map((claim) => claim.id)),
    );

    service.vault.close();
    services.splice(services.indexOf(service), 1);
    const reopened = await initializedVault(directory);
    services.push(reopened);
    expect((await reopened.bootstrap()).sourceReview.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(claims.map((claim) => claim.id)),
    );
    expect(
      reopened.vault.all<{ id: string; review_disposition: string }>(
        'SELECT id,review_disposition FROM claims WHERE id IN (?,?) ORDER BY id',
        [claims[0]!.id, claims[1]!.id],
      ),
    ).toEqual(
      expect.arrayContaining([
        { id: claims[0]!.id, review_disposition: 'accepted' },
        { id: claims[1]!.id, review_disposition: 'rejected' },
      ]),
    );
  });

  it('returns every pending source review instead of silently truncating at one hundred', async () => {
    const { service } = await create();
    const claims = service.vault.all<{ id: string }>(
      `SELECT c.id FROM claims c JOIN sources s ON s.id=c.source_id
       WHERE trim(s.canonical_url)!='' ORDER BY c.id LIMIT 101`,
    );
    expect(claims).toHaveLength(101);
    const placeholders = claims.map(() => '?').join(',');
    service.vault.run(
      `UPDATE claims SET status='stale',review_disposition=NULL,reviewed_at=NULL
       WHERE id IN (${placeholders})`,
      claims.map((claim) => claim.id),
    );

    const claimIds = new Set(claims.map((claim) => claim.id));
    const returnedIds = (await service.bootstrap()).sourceReview
      .filter((item) => claimIds.has(item.id))
      .map((item) => item.id);
    expect(returnedIds).toHaveLength(101);
    expect(new Set(returnedIds)).toEqual(claimIds);
  });

  it('returns more than one hundred audit and mailbox events in investor activity', async () => {
    const { service } = await create();
    await onboard(service);
    const person = firstPersonWithoutEmail(service);
    await service.targetInvestor(person.firmId, true);
    const targetId = String(
      service.vault.scalar(
        'SELECT id FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
        [person.firmId],
      ),
    );

    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const occurredAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      service.vault.run(
        `INSERT INTO audit_log(
          occurred_at,actor_type,action,entity_type,entity_id,detail_json
        ) VALUES (?,?,?,?,?,?)`,
        [occurredAt, 'founder', `completeness.audit.${suffix}`, 'target', targetId, '{}'],
      );
      service.vault.run(
        `INSERT INTO mail_events(
          id,provider,provider_message_id,person_id,direction,kind,sender_address,
          recipient_addresses_json,subject,occurred_at,metadata_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `mail:completeness:${suffix}`,
          'google',
          `provider-completeness-${suffix}`,
          person.id,
          'inbound',
          'reply',
          `history.${suffix}@example.test`,
          JSON.stringify([{ email: 'ada@local.test' }]),
          `Completeness mail ${suffix}`,
          occurredAt,
          '{}',
          occurredAt,
        ],
      );
    }
    await service.persist();

    const activity = (await service.investorDetail(person.firmId)).activity;
    expect(activity.filter((item) => item.title.startsWith('completeness audit '))).toHaveLength(
      101,
    );
    expect(activity.filter((item) => item.detail?.startsWith('Completeness mail '))).toHaveLength(
      101,
    );
  });

  it('shares only outreach-safe knowledge with an agent company context grant', async () => {
    const { service } = await create();
    await onboard(service);
    for (const [title, sharePolicy] of [
      ['Internal metrics', 'internal'],
      ['Outreach narrative', 'safe_for_outreach'],
      ['Meeting notes', 'meeting_only'],
      ['Diligence room', 'diligence_only'],
    ] as const) {
      await service.saveKnowledge({
        title,
        category: 'company',
        content: `${title} private body`,
        sharePolicy,
      });
    }
    await service.saveKnowledge({
      title: 'Safe but unrelated',
      category: 'other',
      content: 'This is not company context.',
      sharePolicy: 'safe_for_outreach',
    });

    const context = await service.agentContext(['company']);
    expect(context.company).toEqual([
      expect.objectContaining({ title: 'Outreach narrative', sharePolicy: 'safe_for_outreach' }),
    ]);
    expect(JSON.stringify(context)).not.toContain('Internal metrics');
    expect(JSON.stringify(context)).not.toContain('Meeting notes');
    expect(JSON.stringify(context)).not.toContain('Diligence room');
    expect(JSON.stringify(context)).not.toContain('Safe but unrelated');
    expect((await service.agentContext([])).company).toBeUndefined();
    expect((await service.agentContext(['activity'])).activity).toMatchObject({
      tasks: expect.any(Array),
      meetings: expect.any(Array),
      drafts: expect.any(Array),
      mailEvents: expect.any(Array),
      agentProposals: expect.any(Array),
    });
  });

  it('creates and atomically replaces founder-owned static list membership', async () => {
    const { service } = await create();
    const [first, second, third] = (await service.bootstrap()).investors;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();

    const created = await service.createList({
      name: 'Focused investors',
      description: 'Exact founder-selected membership.',
      memberFirmIds: [first!.id, second!.id],
    });
    expect(created).toMatchObject({
      name: 'Focused investors',
      count: 2,
      memberFirmIds: [first!.id, second!.id],
    });

    const updated = await service.updateList({
      id: created.id,
      name: 'Focused investors — reviewed',
      description: null,
      memberFirmIds: [third!.id, first!.id, third!.id],
    });
    expect(updated).toMatchObject({
      name: 'Focused investors — reviewed',
      count: 2,
      memberFirmIds: [third!.id, first!.id],
    });

    await expect(
      service.updateList({
        id: created.id,
        name: 'Must roll back',
        description: null,
        memberFirmIds: ['firm:does-not-exist'],
      }),
    ).rejects.toThrow('list member entity does not exist');
    expect((await service.bootstrap()).lists.find((list) => list.id === created.id)).toMatchObject({
      name: 'Focused investors — reviewed',
      count: 2,
      memberFirmIds: [third!.id, first!.id],
    });
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE entity_type='list' AND entity_id=?",
          [created.id],
        ),
      ),
    ).toBe(2);
  });

  it('persists founder expected checks and calculates committed and soft-circled capital exactly', async () => {
    const { service, directory } = await create();
    await onboard(service);
    const [committedInvestor, softCircleInvestor] = (await service.bootstrap()).investors;
    expect(committedInvestor).toBeDefined();
    expect(softCircleInvestor).toBeDefined();

    await service.targetInvestor(committedInvestor!.id, true);
    await service.targetInvestor(softCircleInvestor!.id, true);
    await expect(
      service.updateExpectedCheck(committedInvestor!.id, 750_000),
    ).resolves.toMatchObject({ id: committedInvestor!.id, expectedCheckUsd: 750_000 });
    await expect(
      service.updateExpectedCheck(softCircleInvestor!.id, 425_000),
    ).resolves.toMatchObject({ id: softCircleInvestor!.id, expectedCheckUsd: 425_000 });
    await service.moveInvestor(committedInvestor!.id, 'committed');
    await service.moveInvestor(softCircleInvestor!.id, 'soft_circle');

    const beforeRestart = await service.bootstrap();
    expect(beforeRestart.round).toMatchObject({
      committedAmount: 750_000,
      softCircleAmount: 425_000,
    });
    expect(
      beforeRestart.investors.find((investor) => investor.id === committedInvestor!.id),
    ).toMatchObject({ expectedCheckUsd: 750_000, pipelineStage: 'committed' });
    expect(
      beforeRestart.investors.find((investor) => investor.id === softCircleInvestor!.id),
    ).toMatchObject({ expectedCheckUsd: 425_000, pipelineStage: 'soft_circle' });

    service.vault.close();
    services.splice(services.indexOf(service), 1);
    const reopened = await initializedVault(directory, () => new Date('2026-08-01T00:00:00.000Z'));
    services.push(reopened);
    expect((await reopened.bootstrap()).round).toMatchObject({
      committedAmount: 750_000,
      softCircleAmount: 425_000,
    });

    await reopened.updateExpectedCheck(softCircleInvestor!.id, null);
    expect((await reopened.bootstrap()).round).toMatchObject({
      committedAmount: 750_000,
      softCircleAmount: 0,
    });
    expect(
      reopened.vault.one<{ expected_check_usd: number | null }>(
        'SELECT expected_check_usd FROM targets WHERE firm_id=?',
        [softCircleInvestor!.id],
      ),
    ).toEqual({ expected_check_usd: null });
  });

  it('binds approval to exact draft content and invalidates it after an edit', async () => {
    const { service } = await create();
    await onboard(service);
    const person = firstPersonWithoutEmail(service);
    await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'partner.private@example.test',
      visibility: 'private',
      contributionEligible: false,
    });

    const draft = await service.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'A deliberate introduction',
      bodyText: 'Hi — this is the exact founder-reviewed body.',
    });
    expect(draft.bodyText).toContain('123 Founder Way\nSan Francisco, CA 94107');
    expect(draft.bodyText).toContain('reply "opt out"');
    expect(draft).toMatchObject({
      canApprove: true,
      approvalBlockReasons: [],
      canSend: false,
    });
    await expect(service.approveDraft(draft.id, '0'.repeat(64))).rejects.toThrow(
      'Draft changed before approval',
    );

    const approved = await service.approveDraft(draft.id, draft.contentHash);
    expect(approved.approvalState).toBe('approved');
    const edited = await service.updateDraft(draft.id, {
      bodyText: `${draft.bodyText}\nOne post-approval edit.`,
    });
    expect(edited.contentHash).not.toBe(draft.contentHash);
    expect(edited.approvalState).toBe('draft');
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM approvals WHERE message_id=? AND status='active'",
          [draft.id],
        ),
      ),
    ).toBe(0);
  });

  it('keeps drafts editable but blocks approval until the configured footer is visibly present', async () => {
    const { service } = await create();
    await onboard(service);
    await service.updateCommunicationPolicy({
      sendingPaused: false,
      dailySendLimit: 10,
      postalAddress: null,
    });
    const person = firstPersonWithoutEmail(service);
    await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'footer.readiness@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const blocked = await service.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Editable while blocked',
      bodyText: 'The founder can keep editing this local draft.',
    });
    expect(blocked).toMatchObject({
      approvalState: 'draft',
      canApprove: false,
      canSend: false,
    });
    expect(blocked.approvalBlockReasons[0]).toMatch(/postal address/i);
    await expect(service.approveDraft(blocked.id, blocked.contentHash)).rejects.toThrow(
      /postal address/i,
    );

    await service.updateCommunicationPolicy({
      sendingPaused: false,
      dailySendLimit: 10,
      postalAddress: '500 New Address Lane\nNew York, NY 10001\nUnited States',
    });
    const stillBlocked = (await service.bootstrap()).drafts.find((item) => item.id === blocked.id)!;
    expect(stillBlocked.canApprove).toBe(false);
    expect(stillBlocked.approvalBlockReasons).toContain(
      'The message body must include the exact configured sender postal address.',
    );
    const replacement = await service.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Footer appended',
      bodyText: 'A newly created draft.',
    });
    expect(replacement.canApprove).toBe(true);
    expect(replacement.bodyText).toContain('500 New Address Lane\nNew York, NY 10001');
  });

  it('enforces founder suppressions, a global pause, and the daily send cap in SQLite', async () => {
    const { service } = await create();
    await onboard(service);
    const people = service.vault.all<{ id: string; firm_id: string }>(
      `SELECT p.id,p.firm_id FROM people p
       WHERE p.firm_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM contact_methods c
         WHERE c.person_id=p.id AND c.kind IN ('work_email','personal_email')
       ) ORDER BY p.id LIMIT 3`,
    );
    expect(people).toHaveLength(3);
    const addresses = [
      'first.policy@example.test',
      'second.policy@example.test',
      'third.policy@blocked.example',
    ];
    for (const [index, person] of people.entries()) {
      await service.addPersonContact({
        personId: person.id,
        kind: 'work_email',
        value: addresses[index]!,
        visibility: 'private',
        contributionEligible: false,
      });
    }

    const domainSuppression = await service.addSuppression({
      scope: 'domain',
      value: '@BLOCKED.EXAMPLE',
      reason: 'Founder requested no contact for this domain.',
    });
    expect(domainSuppression).toMatchObject({
      scope: 'domain',
      value: '@BLOCKED.EXAMPLE',
      active: true,
      source: 'founder',
    });
    expect(
      (await service.bootstrap()).people.find((item) => item.id === people[2]!.id),
    ).toMatchObject({
      canSendInitial: false,
      suppressionReason: 'Founder requested no contact for this domain.',
    });
    await expect(
      service.createDraft({
        personId: people[2]!.id,
        provider: 'google',
        kind: 'initial',
        subject: 'Must be blocked',
        bodyText: 'This draft cannot be created while the recipient is suppressed.',
      }),
    ).rejects.toThrow('Founder requested no contact');
    await expect(service.removeSuppression(domainSuppression.id)).resolves.toMatchObject({
      id: domainSuppression.id,
      active: false,
    });
    expect(
      (await service.bootstrap()).people.find((item) => item.id === people[2]!.id),
    ).toMatchObject({ canSendInitial: true });

    const drafts = [];
    service.repository.upsertConnectorConfig({
      id: 'connector:google',
      provider: 'google',
      accountLabel: 'ada@local.test',
      publicConfig: { relationshipSync: false },
      secretRef: 'memory://google',
      scopes: [],
      status: 'connected',
      createdAt: '2026-07-31T19:00:00.000Z',
      updatedAt: '2026-07-31T19:00:00.000Z',
    });
    for (const [index, person] of people.entries()) {
      const draft = await service.createDraft({
        personId: person.id,
        provider: 'google',
        kind: 'initial',
        subject: `Policy test ${index + 1}`,
        bodyText: `Founder-approved policy body ${index + 1}.`,
      });
      drafts.push(await service.approveDraft(draft.id, draft.contentHash));
    }
    await expect(
      service.updateCommunicationPolicy({ sendingPaused: true, dailySendLimit: 1 }),
    ).resolves.toMatchObject({
      sendingPaused: true,
      dailySendLimit: 1,
      hourlySendLimit: 3,
      recipientDomainDailyLimit: 2,
      recipientDomainCooldownMinutes: 30,
      reservedToday: 0,
      reservedThisHour: 0,
    });
    expect(
      Number(service.vault.scalar("SELECT COUNT(*) FROM approvals WHERE status='active'")),
    ).toBe(0);
    const pausedDraft = (await service.bootstrap()).drafts.find(
      (item) => item.id === drafts[0]!.id,
    )!;
    const pausedApproved = await service.approveDraft(pausedDraft.id, pausedDraft.contentHash);
    expect(() =>
      service.repository.reserveApprovedSend(
        pausedApproved.id,
        'google',
        'ada@local.test',
        '2026-07-31T19:01:00.000Z',
        'send:paused',
      ),
    ).toThrow('all sending is paused');
    expect(Number(service.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);

    await service.updateCommunicationPolicy({
      sendingPaused: false,
      dailySendLimit: 1,
      recipientDomainCooldownMinutes: 1,
    });
    for (const [index, draft] of drafts.entries()) {
      const current = (await service.bootstrap()).drafts.find((item) => item.id === draft.id)!;
      drafts[index] = await service.approveDraft(current.id, current.contentHash);
    }
    expect(
      service.repository.reserveApprovedSend(
        drafts[0]!.id,
        'google',
        'ada@local.test',
        '2026-07-31T19:02:00.000Z',
        'send:first',
      ),
    ).toMatchObject({ id: 'send:first', status: 'reserved' });
    expect(() =>
      service.repository.reserveApprovedSend(
        drafts[1]!.id,
        'google',
        'ada@local.test',
        '2026-07-31T19:04:00.000Z',
        'send:over-limit',
      ),
    ).toThrow('daily founder send limit reached');
    expect((await service.bootstrap()).communicationPolicy).toMatchObject({
      sendingPaused: false,
      dailySendLimit: 1,
      reservedToday: 1,
      hourlySendLimit: 3,
      reservedThisHour: 0,
    });
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM approvals WHERE id=(SELECT approval_id FROM send_ledger WHERE id='send:first') AND status='used'",
        ),
      ),
    ).toBe(1);
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM approvals WHERE message_id=? AND status='active'",
          [drafts[1]!.id],
        ),
      ),
    ).toBe(1);
  });

  it('keeps audit records append-only and detects an externally tampered audit chain', async () => {
    const { service } = await create();
    await onboard(service);
    await service.updateCommunicationPolicy({ sendingPaused: false, dailySendLimit: 7 });
    const before = service.auditIntegrity();
    expect(before).toMatchObject({ ok: true, errorAt: null });
    expect(before.entries).toBeGreaterThan(0);

    expect(() =>
      service.vault.run(
        "UPDATE audit_log SET detail_json='{}' WHERE id=(SELECT id FROM audit_log ORDER BY id LIMIT 1)",
      ),
    ).toThrow('audit log is append-only');
    expect(service.auditIntegrity()).toEqual(before);

    // Model an attacker or external SQLite editor that first removes the guard.
    service.vault.run('DROP TRIGGER audit_log_is_append_only_update');
    service.vault.run(
      `UPDATE audit_log SET detail_json='{"externally_tampered":true}'
       WHERE id=(SELECT id FROM audit_log ORDER BY id LIMIT 1)`,
    );
    const detected = service.auditIntegrity();
    expect(detected.ok).toBe(false);
    expect(detected.errorAt).not.toBeNull();
    expect(detected.entries).toBe(before.entries);
    expect((await service.bootstrap()).auditIntegrity).toEqual(detected);
    expect(service.integrityCheck().ok).toBe(true);
  });

  it('applies only strict founder-reviewed agent proposals and keeps unsupported work local', async () => {
    const { service } = await create();
    await onboard(service);
    const at = '2026-07-31T19:00:00.000Z';
    service.repository.createAgentRun({
      id: 'agent-run:proposal-review',
      provider: 'codex',
      model: null,
      purpose: 'Prepare bounded local work.',
      contextPolicy: { disclosedContextIds: ['round', 'investors'] },
      status: 'completed',
      startedAt: at,
      completedAt: at,
      errorDetail: null,
      createdAt: at,
    });
    const createProposal = (
      id: string,
      kind: 'draft' | 'task' | 'pipeline_move' | 'note' | 'research',
      payload: Record<string, unknown>,
      investorId: string | null = null,
    ): void => {
      service.repository.createAgentProposal({
        id,
        agentRunId: 'agent-run:proposal-review',
        proposalType: kind,
        payload: {
          kind,
          title: `${kind} founder review`,
          rationale: 'Founder must inspect and approve this exact local mutation.',
          investorId,
          payload,
        },
        status: 'pending',
        reviewedAt: null,
        createdAt: at,
      });
    };

    createProposal('proposal:invalid-task', 'task', {
      title: 'Must not apply',
      unrecognizedField: 'host rejects additional fields',
    });
    await expect(
      service.reviewAgentProposal({ id: 'proposal:invalid-task', decision: 'apply' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(
      service.vault.scalar("SELECT status FROM agent_proposals WHERE id='proposal:invalid-task'"),
    ).toBe('pending');
    await expect(
      service.reviewAgentProposal({ id: 'proposal:invalid-task', decision: 'reject' }),
    ).resolves.toMatchObject({ status: 'rejected', operation: 'rejected' });

    const investor = (await service.bootstrap()).investors[0]!;
    await service.targetInvestor(investor.id, true);
    createProposal(
      'proposal:pipeline',
      'pipeline_move',
      { investorId: investor.id, stage: 'meeting' },
      investor.id,
    );
    await expect(
      service.reviewAgentProposal({ id: 'proposal:pipeline', decision: 'apply' }),
    ).resolves.toMatchObject({ appliedEntityType: 'target', operation: 'applied' });
    expect(
      (await service.bootstrap()).investors.find((item) => item.id === investor.id),
    ).toMatchObject({ pipelineStage: 'meeting' });

    const person = firstPersonWithoutEmail(service);
    await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'proposal-draft@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    createProposal('proposal:draft', 'draft', {
      personId: person.id,
      provider: 'google',
      subject: 'Founder review only',
      bodyText: 'This must remain an unapproved initial draft.',
    });
    await expect(
      service.reviewAgentProposal({ id: 'proposal:draft', decision: 'apply' }),
    ).resolves.toMatchObject({ appliedEntityType: 'message', operation: 'applied' });
    expect((await service.bootstrap()).drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personId: person.id,
          kind: 'initial',
          approvalState: 'draft',
          subject: 'Founder review only',
        }),
      ]),
    );

    createProposal('proposal:research', 'research', { query: 'Review a new market signal' });
    await expect(
      service.reviewAgentProposal({
        id: 'proposal:research',
        decision: 'convert_to_task',
      }),
    ).resolves.toMatchObject({ appliedEntityType: 'task', operation: 'converted_to_task' });
    expect((await service.bootstrap()).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'research founder review', status: 'open' }),
      ]),
    );

    expect((await service.bootstrap()).agentProposals).toEqual([]);
    expect(
      Number(
        service.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='agent.proposal_applied'",
        ),
      ),
    ).toBe(3);
    await service.targetInvestor(investor.id, false);
    expect(
      Number(service.vault.scalar("SELECT COUNT(*) FROM audit_log WHERE action='target.removed'")),
    ).toBe(1);
    expect(service.auditIntegrity().ok).toBe(true);
  });

  it('restores encrypted backups and exports a contribution with no private activity', async () => {
    const { service } = await create();
    const output = await temporaryDirectory('exports');
    directories.push(output);
    await onboard(service);
    const privateFirmName = 'Never Export Private Capital';
    const privateEmail = 'never-export-private@example.test';
    const privatePersonalEmail = 'never-export-individual@example.test';
    await service.createInvestor({ name: privateFirmName, kind: 'angel' });
    const person = firstPersonWithoutEmail(service);
    await service.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: privateEmail,
      visibility: 'private',
      contributionEligible: false,
    });
    await service.addPersonContact({
      personId: person.id,
      kind: 'personal_email',
      value: privatePersonalEmail,
      visibility: 'private',
      contributionEligible: false,
    });
    await service.createTask({
      title: 'Never export this private task',
      notes: 'Private founder activity',
      dueAt: null,
      status: 'open',
      investorId: null,
      personId: null,
    });

    const backupPath = await service.exportBackup(output, 'correct horse battery staple');
    expect(basename(backupPath)).toBe('Outreachr-2026-07-31T19-00-00-000Z.outreachr-backup');
    const originalBackup = await readFile(backupPath);
    const secondBackupPath = await service.exportBackup(output, 'a different secure passphrase');
    expect(basename(secondBackupPath)).toBe(
      'Outreachr-2026-07-31T19-00-00-000Z-2.outreachr-backup',
    );
    expect(await readFile(backupPath)).toEqual(originalBackup);
    if (process.platform !== 'win32') expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backupAudit = service.vault.one<{ detail_json: string }>(
      "SELECT detail_json FROM audit_log WHERE action='backup.exported' ORDER BY id DESC LIMIT 1",
    );
    expect(backupAudit?.detail_json).toContain('outreachr-encrypted-backup');
    expect(backupAudit?.detail_json).not.toContain(output);
    expect(backupAudit?.detail_json).not.toContain('correct horse battery staple');
    await service.createTask({
      title: 'Created after backup',
      notes: null,
      dueAt: null,
      status: 'open',
      investorId: null,
      personId: null,
    });
    const restoredPlaintext = await restoreEncryptedBackup(
      originalBackup,
      'correct horse battery staple',
    );
    const tamperedAudit = new service.vault.sqlite.Database(restoredPlaintext);
    const tamperedAuditPath = join(output, 'tampered-audit.outreachr-backup');
    try {
      const appendOnlyTrigger = String(
        tamperedAudit.exec(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='audit_log_is_append_only_update'",
        )[0]?.values[0]?.[0],
      );
      tamperedAudit.run('DROP TRIGGER audit_log_is_append_only_update');
      tamperedAudit.run(
        "UPDATE audit_log SET action='tampered.restore' WHERE id=(SELECT MIN(id) FROM audit_log)",
      );
      tamperedAudit.run(appendOnlyTrigger);
      await writeFile(
        tamperedAuditPath,
        await createEncryptedBackup(
          new Uint8Array(tamperedAudit.export()),
          'correct horse battery staple',
        ),
      );
    } finally {
      tamperedAudit.close();
    }
    await expect(
      service.restoreBackup(tamperedAuditPath, 'correct horse battery staple'),
    ).rejects.toThrow('audit chain verification failed');

    const unexpectedSchema = new service.vault.sqlite.Database(restoredPlaintext);
    const unexpectedSchemaPath = join(output, 'unexpected-schema.outreachr-backup');
    try {
      unexpectedSchema.run(`CREATE TRIGGER attacker_restore AFTER INSERT ON tasks
        BEGIN DELETE FROM tasks; END`);
      await writeFile(
        unexpectedSchemaPath,
        await createEncryptedBackup(
          new Uint8Array(unexpectedSchema.export()),
          'correct horse battery staple',
        ),
      );
    } finally {
      unexpectedSchema.close();
    }
    await expect(
      service.restoreBackup(unexpectedSchemaPath, 'correct horse battery staple'),
    ).rejects.toThrow('unexpected or modified schema object: attacker_restore');
    expect(
      (await service.bootstrap()).tasks.some((item) => item.title === 'Created after backup'),
    ).toBe(true);
    await service.restoreBackup(backupPath, 'correct horse battery staple');
    expect(
      Number(service.vault.scalar("SELECT COUNT(*) FROM audit_log WHERE action='backup.restored'")),
    ).toBe(1);
    expect(
      (await service.bootstrap()).tasks.some((item) => item.title === 'Created after backup'),
    ).toBe(false);

    const contribution = await service.exportContribution(output);
    await expect(service.exportContribution(output)).rejects.toMatchObject({ code: 'EEXIST' });
    const partialOutput = await temporaryDirectory('partial-contribution');
    directories.push(partialOutput);
    const preexistingDiff = join(partialOutput, basename(contribution.diffPath));
    const partialDatabase = join(partialOutput, basename(contribution.databasePath));
    await writeFile(preexistingDiff, 'do not replace this diff\n', 'utf8');
    await expect(service.exportContribution(partialOutput)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(preexistingDiff, 'utf8')).toBe('do not replace this diff\n');
    await expect(stat(partialDatabase)).rejects.toMatchObject({ code: 'ENOENT' });
    const contributionAudit = service.vault.one<{ detail_json: string }>(
      "SELECT detail_json FROM audit_log WHERE action='contribution.exported' ORDER BY id DESC LIMIT 1",
    );
    expect(contributionAudit?.detail_json).not.toContain(output);
    expect(contributionAudit?.detail_json).not.toContain(privateEmail);
    const peopleCsv = await service.exportCsv(output, 'people');
    expect(basename(peopleCsv)).toBe('Outreachr-people-2026-07-31T19-00-00-000Z.csv');
    const originalPeopleCsv = await readFile(peopleCsv);
    expect(originalPeopleCsv.toString('utf8')).toContain('work_email,individual_email');
    expect(originalPeopleCsv.toString('utf8')).toContain(privateEmail);
    expect(originalPeopleCsv.toString('utf8')).toContain(privatePersonalEmail);
    const secondPeopleCsv = await service.exportCsv(output, 'people');
    expect(basename(secondPeopleCsv)).toBe('Outreachr-people-2026-07-31T19-00-00-000Z-2.csv');
    expect(await readFile(peopleCsv)).toEqual(originalPeopleCsv);
    if (process.platform !== 'win32') expect((await stat(peopleCsv)).mode & 0o777).toBe(0o600);
    const csvAudit = service.vault.one<{ detail_json: string }>(
      "SELECT detail_json FROM audit_log WHERE action='data.private_csv_exported' AND entity_id='people' LIMIT 1",
    );
    expect(csvAudit?.detail_json).toContain('people');
    expect(csvAudit?.detail_json).not.toContain(output);
    expect(csvAudit?.detail_json).not.toContain(privateEmail);
    await service.createInvestor({ name: '=1+1', kind: 'angel' });
    const investorCsv = await service.exportCsv(output, 'investors');
    expect(await readFile(investorCsv, 'utf8')).toContain("'=1+1");
    await service.importSeedFile(`${RESOURCE_ROOT}/Outreachr_Investor_Seed.sqlite`);
    expect(
      Number(
        service.vault.scalar("SELECT COUNT(*) FROM audit_log WHERE action='seed.import_skipped'"),
      ),
    ).toBe(1);
    const contributionBytes = new Uint8Array(await readFile(contribution.databasePath));
    const contributionDb = new service.vault.sqlite.Database(contributionBytes);
    try {
      const tables = contributionDb
        .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]
        ?.values.map((row) => String(row[0]));
      expect(tables).toEqual([
        'claims',
        'entity_sources',
        'entity_tags',
        'firms',
        'funds',
        'package_manifest',
        'people',
        'public_work_emails',
        'sources',
        'tags',
      ]);
      expect(tables).not.toEqual(
        expect.arrayContaining([
          'founder_profiles',
          'rounds',
          'targets',
          'messages',
          'approvals',
          'send_ledger',
          'mail_events',
          'suppressions',
          'communication_settings',
          'meetings',
          'tasks',
          'audit_log',
          'audit_chain',
          'connector_configs',
          'agent_runs',
        ]),
      );
      expect(
        contributionDb.exec('SELECT license_spdx FROM package_manifest')[0]?.values[0]?.[0],
      ).toBe('NOASSERTION');
      expect(
        contributionDb.exec('SELECT COUNT(*) FROM firms WHERE name=?', [privateFirmName])[0]
          ?.values[0]?.[0] ?? 0,
      ).toBe(0);
      expect(
        contributionDb.exec('SELECT COUNT(*) FROM public_work_emails WHERE work_email=?', [
          privateEmail,
        ])[0]?.values[0]?.[0] ?? 0,
      ).toBe(0);
    } finally {
      contributionDb.close();
    }

    const diff = await readFile(contribution.diffPath, 'utf8');
    expect(diff).toContain('Public allowlist only');
    expect(diff).not.toContain(privateFirmName);
    expect(diff).not.toContain(privateEmail);
    expect(diff).not.toContain(privatePersonalEmail);
    expect(diff).not.toContain('Never export this private task');
  }, 120_000);

  it('rejects oversized selected backups and seeds before reading or mutating the vault', async () => {
    const { service, directory } = await create();
    await onboard(service);
    const auditCount = Number(service.vault.scalar('SELECT COUNT(*) FROM audit_log'));
    const oversizedBackup = join(directory, 'oversized.outreachr-backup');
    await writeFile(oversizedBackup, new Uint8Array([1]));
    await truncate(oversizedBackup, 512 * 1024 * 1024 + 1);
    await expect(service.restoreBackup(oversizedBackup, 'a-safe-test-password')).rejects.toThrow(
      'Backup file is larger than the 512 MiB safety limit.',
    );

    const oversizedSeed = join(directory, 'oversized-seed.sqlite');
    await writeFile(oversizedSeed, new Uint8Array([1]));
    await truncate(oversizedSeed, 256 * 1024 * 1024 + 1);
    await expect(service.importSeedFile(oversizedSeed)).rejects.toThrow(
      'Seed file is larger than the 256 MiB safety limit.',
    );
    expect(Number(service.vault.scalar('SELECT COUNT(*) FROM audit_log'))).toBe(auditCount);
    expect(service.integrityCheck().ok).toBe(true);
  });
});
