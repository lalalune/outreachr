import { randomUUID, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createEncryptedBackup, restoreEncryptedBackup } from '@outreachr/core';
import { openNodeVault } from '@outreachr/core/node';
import { closeTestDatabase } from '../disposable-database';
import { migrate } from '../../src/schema';
import { WorkspaceStore } from '../../src/workspaces';
import { CloudRuntime } from '../../src/runtime';
import { ElizaClient } from '../../src/eliza';
import { CloudAgent, AgentRuns } from '../../src/agent';
import { InferenceClient } from '../../src/inference';
import { RateLimiter } from '../../src/rate-limits';
import { MailboxWorker } from '../../src/mailbox-worker';
import { SessionStore, CredentialCipher } from '../../src/sessions';
import { FileStore } from '../../src/files';

const database = `outreachr_archives_${randomUUID().replaceAll('-', '')}`;
const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Disposable local database required.');
const admin = new Pool({ connectionString: url.href });
url.pathname = `/${database}`;
const pool = new Pool({ connectionString: url.href });
const store = new WorkspaceStore(pool);
const config = {
  appId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: 'fixture',
  apiOrigin: 'https://unused.example.test',
  publicOrigin: 'http://localhost:4444',
  loginOrigin: 'https://unused.example.test',
  billingEnvironment: 'test' as const,
};
const eliza = new ElizaClient(config);
const runtime = () =>
  new CloudRuntime({
    pool,
    eliza,
    revision: 'archive-test',
    agentFactory: (context) =>
      new CloudAgent(
        context,
        new InferenceClient({ ...config, developerApiKey: '' }),
        new AgentRuns(),
      ),
  });
const files = new FileStore(pool);
const password = 'test-only-archive-passphrase';
async function workspace() {
  const identity = {
    id: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: 'Archive tester',
    emailVerified: true,
  };
  const org = (await store.signIn(identity)).organizations[0]!;
  const session = {
    userId: identity.id,
    grant: `ead_${'a'.repeat(43)}`,
    expiresAt: new Date(Date.now() + 600000),
  };
  return {
    identity,
    org,
    session,
    run: <K extends Parameters<CloudRuntime['execute']>[3]>(name: K, payload: unknown) =>
      runtime().execute(session, identity, org.id, name, payload),
  };
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(pool);
});
afterAll(() => closeTestDatabase(pool, admin, database));

describe('complete cloud archives', () => {
  it('does not retain an upload when its document command fails validation', async () => {
    const owner = await workspace();
    const path = await files.save(
      owner.identity.id,
      owner.org.id,
      'temporary.txt',
      Buffer.from('fixture'),
      'upload',
    );
    await expect(
      owner.run('knowledge.save', {
        title: 'Bad reference',
        category: 'invalid-category',
        content: `file:${path}`,
        sharePolicy: 'internal',
      }),
    ).rejects.toThrow();
    expect((await files.get(owner.identity.id, owner.org.id, path)).expires_at).not.toBeNull();
    const state = await runtime().bootstrap(owner.session, owner.identity, owner.org.id);
    expect(JSON.stringify(state)).not.toContain(`file:${path}`);
  });

  it('restores documents with new tenant references, strips credentials and preserves authority outside the archive', async () => {
    const source = await workspace();
    const target = await workspace();
    const handle = await files.save(
      source.identity.id,
      source.org.id,
      'Company deck.pdf',
      Buffer.from('fixture document bytes'),
      'upload',
    );
    await source.run('knowledge.save', {
      title: 'Deck',
      category: 'company',
      content: `file:${handle}`,
      sharePolicy: 'internal',
    });
    await runtime().withVault(source.session, source.identity, source.org.id, async ({ vault }) => {
      vault.vault.run('INSERT INTO secure_secrets VALUES(?,?,?)', [
        'fixture-secret',
        Buffer.from('never-export-this-secret'),
        new Date().toISOString(),
      ]);
      await vault.persist();
    });
    const result = (await source.run('backup.export', {
      directory: 'cloud-downloads',
      password,
    })) as { path: string };
    const download = await files.get(source.identity.id, source.org.id, result.path);
    const plaintext = JSON.parse(
      Buffer.from(await restoreEncryptedBackup(download.content, password)).toString(),
    );
    expect(plaintext.files).toHaveLength(1);
    const snapshot = Buffer.from(plaintext.snapshot.bytes, 'base64');
    expect(snapshot.includes(Buffer.from('never-export-this-secret'))).toBe(false);
    const restoredVault = await openNodeVault({ bytes: snapshot });
    expect(restoredVault.scalar('SELECT count(*) FROM secure_secrets')).toBe(0);
    restoredVault.close();
    await expect(files.get(target.identity.id, source.org.id, result.path)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    const upload = await files.save(
      target.identity.id,
      target.org.id,
      'restore',
      download.content,
      'archive_upload',
    );
    await target.run('backup.restore', { path: upload, password });
    const reopened = await runtime().bootstrap(target.session, target.identity, target.org.id);
    const restored = reopened.knowledge.find((item) => item.title === 'Deck')!;
    expect(restored.content).not.toBe(`file:${handle}`);
    expect(
      (
        await files.get(target.identity.id, target.org.id, restored.content.slice(5))
      ).content.toString(),
    ).toBe('fixture document bytes');
    expect(
      (await store.members(target.identity.id, target.org.id)).some(
        (member) => member.id === source.identity.id,
      ),
    ).toBe(false);
    expect((await files.get(source.identity.id, source.org.id, handle)).content.toString()).toBe(
      'fixture document bytes',
    );
  });

  it('rejects wrong passwords, altered document checksums and missing linked documents without committing a replacement', async () => {
    const owner = await workspace();
    const handle = await files.save(
      owner.identity.id,
      owner.org.id,
      'deck.txt',
      Buffer.from('original'),
      'upload',
    );
    await owner.run('knowledge.save', {
      title: 'Keep this',
      category: 'company',
      content: `file:${handle}`,
      sharePolicy: 'internal',
    });
    const output = (await owner.run('backup.export', {
      directory: 'cloud-downloads',
      password,
    })) as { path: string };
    const download = await files.get(owner.identity.id, owner.org.id, output.path);
    const upload = await files.save(
      owner.identity.id,
      owner.org.id,
      'restore',
      download.content,
      'archive_upload',
    );
    await expect(
      owner.run('backup.restore', { path: upload, password: 'incorrect-password' }),
    ).rejects.toThrow(/authentication/);
    for (const mode of ['checksum', 'missing']) {
      const archive = JSON.parse(
        Buffer.from(await restoreEncryptedBackup(download.content, password)).toString(),
      );
      if (mode === 'checksum') archive.files[0].sha256 = '0'.repeat(64);
      else archive.files = [];
      const bad = await files.save(
        owner.identity.id,
        owner.org.id,
        'bad',
        Buffer.from(await createEncryptedBackup(Buffer.from(JSON.stringify(archive)), password)),
        'archive_upload',
      );
      await expect(owner.run('backup.restore', { path: bad, password })).rejects.toMatchObject({
        code: mode === 'checksum' ? 'archive_checksum_invalid' : 'archive_document_missing',
      });
      expect((await files.get(owner.identity.id, owner.org.id, handle)).content.toString()).toBe(
        'original',
      );
      expect(
        (await runtime().bootstrap(owner.session, owner.identity, owner.org.id)).knowledge.some(
          (item) => item.title === 'Keep this',
        ),
      ).toBe(true);
    }
  });

  it('refuses to roll back a workspace with an uncertain calendar operation', async () => {
    const owner = await workspace();
    await runtime().withVault(owner.session, owner.identity, owner.org.id, async ({ vault }) => {
      vault.vault.run(
        "INSERT INTO calendar_operations(operation_key,provider,account_email,request_json,state,created_at,updated_at) VALUES('fixture','google','sender@example.test','{}','ambiguous',?,?)",
        [new Date().toISOString(), new Date().toISOString()],
      );
      await vault.persist();
    });
    await expect(
      owner.run('backup.restore', { path: `cloud-file:${randomUUID()}`, password }),
    ).rejects.toMatchObject({ code: 'restore_requires_unused_workspace' });
  });
});

describe('offboarding and recorded-result recovery', () => {
  it('archives reversibly, requires canceled billing, purges content, and cannot recreate deleted access or a trial on login', async () => {
    const owner = await workspace();
    const other = await workspace();
    const handle = await files.save(
      owner.identity.id,
      owner.org.id,
      'private.txt',
      Buffer.from('delete me'),
      'upload',
    );
    await owner.run('knowledge.save', {
      title: 'Private',
      category: 'company',
      content: `file:${handle}`,
      sharePolicy: 'internal',
    });
    await expect(
      store.deleteWorkspace(other.identity.id, owner.org.id, owner.org.name),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    await expect(
      store.deleteWorkspace(owner.identity.id, owner.org.id, 'wrong name'),
    ).rejects.toMatchObject({ code: 'workspace_name_required' });
    await store.archive(owner.identity.id, owner.org.id, true);
    await expect(
      owner.run('investor.create', { name: 'Blocked', kind: 'angel' }),
    ).rejects.toMatchObject({ code: 'editing_seat_required' });
    await expect(
      owner.run('backup.export', { directory: 'cloud-downloads', password }),
    ).resolves.toHaveProperty('path');
    await store.archive(owner.identity.id, owner.org.id, false);
    await owner.run('investor.create', { name: 'Allowed', kind: 'angel' });
    await pool.query(
      "UPDATE outreachr.organizations SET subscription_id='sub_fixture',subscription_status='active' WHERE id=$1",
      [owner.org.id],
    );
    await expect(
      store.deleteWorkspace(owner.identity.id, owner.org.id, owner.org.name),
    ).rejects.toMatchObject({ code: 'cancel_subscription_first' });
    await pool.query(
      "UPDATE outreachr.organizations SET subscription_status='canceled' WHERE id=$1",
      [owner.org.id],
    );
    await store.deleteWorkspace(owner.identity.id, owner.org.id, owner.org.name);
    expect(
      (await pool.query('SELECT 1 FROM outreachr.vaults WHERE org_id=$1', [owner.org.id])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM outreachr.files WHERE org_id=$1', [owner.org.id])).rowCount,
    ).toBe(0);
    await expect(
      runtime().bootstrap(owner.session, owner.identity, owner.org.id),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    expect((await store.signIn(owner.identity)).organizations).toEqual([]);
    expect(
      (
        await pool.query('SELECT 1 FROM outreachr.organizations WHERE created_by=$1', [
          owner.identity.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('removes a departing member and mailbox while protecting the last owner', async () => {
    const owner = await workspace();
    const guest = await workspace();
    const invitation = await store.invite(
      owner.identity.id,
      owner.org.id,
      guest.identity.email,
      'viewer',
    );
    await store.acceptInvite(guest.identity.id, invitation.token);
    await pool.query(
      'INSERT INTO outreachr.mailboxes(org_id,user_id,connection_id,email) VALUES($1,$2,$3,$4)',
      [owner.org.id, guest.identity.id, randomUUID(), guest.identity.email],
    );
    await store.changeMember(guest.identity.id, owner.org.id, guest.identity.id, null);
    expect(
      (
        await pool.query('SELECT 1 FROM outreachr.mailboxes WHERE org_id=$1 AND user_id=$2', [
          owner.org.id,
          guest.identity.id,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(store.members(guest.identity.id, owner.org.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(
      store.changeMember(owner.identity.id, owner.org.id, owner.identity.id, null),
    ).rejects.toMatchObject({ code: 'last_owner' });
  });

  it('recovers a charged response once after restart without applying proposals or making another provider request', async () => {
    const owner = await workspace();
    const requestKey = `agent-run:${randomUUID()}`;
    await runtime().withVault(owner.session, owner.identity, owner.org.id, async ({ vault }) => {
      vault.repository.createAgentRun({
        id: requestKey,
        provider: 'codex',
        purpose: 'Recover this paid result',
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      await vault.persist();
    });
    const response = {
      model: 'openai/gpt-5.6-sol',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              summary: 'Review task',
              proposals: [
                {
                  id: 'one',
                  kind: 'task',
                  title: 'Recovered task',
                  rationale: 'Human review required.',
                  investorId: null,
                  payload: {
                    title: 'Recovered task',
                    notes: null,
                    dueAt: null,
                    investorId: null,
                    personId: null,
                  },
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    await pool.query(
      "INSERT INTO outreachr.usage(id,org_id,user_id,request_key,model,period_key,reserved_cents,settled_cents,status,response_json) VALUES($1,$2,$3,$4,$5,'fixture',1,1,'completed',$6)",
      [
        randomUUID(),
        owner.org.id,
        owner.identity.id,
        requestKey,
        response.model,
        JSON.stringify(response),
      ],
    );
    await runtime().bootstrap(owner.session, owner.identity, owner.org.id);
    await runtime().bootstrap(owner.session, owner.identity, owner.org.id);
    await runtime().withVault(owner.session, owner.identity, owner.org.id, async ({ vault }) => {
      expect(
        vault.vault.scalar('SELECT count(*) FROM agent_proposals WHERE agent_run_id=?', [
          requestKey,
        ]),
      ).toBe(1);
      expect(vault.vault.scalar('SELECT status FROM agent_runs WHERE id=?', [requestKey])).toBe(
        'completed',
      );
      expect(vault.vault.scalar("SELECT count(*) FROM tasks WHERE title='Recovered task'")).toBe(0);
    });
    expect(
      (
        await pool.query('SELECT count(*)::int AS count FROM outreachr.usage WHERE org_id=$1', [
          owner.org.id,
        ])
      ).rows[0].count,
    ).toBe(1);
  });
});

describe('scheduled mailbox access and archive transfer', () => {
  it('assembles ordered private archive chunks and removes transient parts', async () => {
    const owner = await workspace();
    const other = await workspace();
    const a = await files.save(
      owner.identity.id,
      owner.org.id,
      'part',
      Buffer.from('first-'),
      'archive_part',
    );
    const b = await files.save(
      owner.identity.id,
      owner.org.id,
      'part',
      Buffer.from('second'),
      'archive_part',
    );
    await expect(
      files.assembleArchive(other.identity.id, other.org.id, [a, b]),
    ).rejects.toMatchObject({ code: 'file_not_found' });
    const assembled = await files.assembleArchive(owner.identity.id, owner.org.id, [a, b]);
    expect((await files.get(owner.identity.id, owner.org.id, assembled)).content.toString()).toBe(
      'first-second',
    );
    await expect(files.get(owner.identity.id, owner.org.id, a)).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });

  it('claims opted-in work once, records expired-session failures, and stops after opt-out', async () => {
    const owner = await workspace();
    const sessions = new SessionStore(
      pool,
      new CredentialCipher(randomBytes(32).toString('base64')),
    );
    const scheduled = runtime();
    const execute = vi.spyOn(scheduled, 'execute').mockResolvedValue({} as never);
    const identity = vi
      .spyOn(eliza, 'identity')
      .mockResolvedValue({ ...owner.identity, organizationId: null });
    try {
      await pool.query(
        'INSERT INTO outreachr.mailboxes(org_id,user_id,connection_id,email) VALUES($1,$2,$3,$4)',
        [owner.org.id, owner.identity.id, randomUUID(), owner.identity.email],
      );
      const worker = new MailboxWorker(pool, sessions, scheduled, 'workspace');
      expect(await worker.runPending()).toBe(0);
      await scheduled.mailboxes.setBackgroundSync(owner.identity.id, owner.org.id, true);
      await worker.runPending();
      expect(execute).not.toHaveBeenCalled();
      expect((await scheduled.mailboxes.syncStatus(owner.identity.id, owner.org.id))?.error).toBe(
        'session_expired',
      );
      await sessions.create(owner.identity.id, owner.session.grant, owner.session.expiresAt);
      await scheduled.mailboxes.setBackgroundSync(owner.identity.id, owner.org.id, true);
      await Promise.all([worker.runPending(), worker.runPending()]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[3]).toBe('connector.syncMail');
      expect(
        (await scheduled.mailboxes.syncStatus(owner.identity.id, owner.org.id))?.lastSyncAt,
      ).toBeInstanceOf(Date);
      await scheduled.mailboxes.setBackgroundSync(owner.identity.id, owner.org.id, false);
      expect(await worker.runPending()).toBe(0);
      await sessions.revokeAll(owner.identity.id);
      await expect(sessions.forBackground(owner.identity.id)).rejects.toMatchObject({
        code: 'session_expired',
      });
    } finally {
      execute.mockRestore();
      identity.mockRestore();
    }
  });
});

it('enforces shared request limits atomically across competing workers and resets by time window', async () => {
  let now = Date.now();
  const limiter = new RateLimiter(pool, () => now);
  const subject = randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => limiter.consume('test', subject, 3)),
  );
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(3);
  for (const item of results)
    if (item.status === 'rejected') expect(item.reason).toMatchObject({ code: 'rate_limit' });
  now += 60000;
  await expect(limiter.consume('test', subject, 3)).resolves.toBeUndefined();
});
