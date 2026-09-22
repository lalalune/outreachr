import { effectiveGoogleScopes } from './delegation';
/** Executes the existing CRM commands against a serialized, durable workspace vault. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool, PoolClient } from 'pg';
import { CommandService, type AgentPort } from '../../desktop/src/main/command-service';
import {
  ConnectorService,
  type ConnectorSecretStore,
} from '../../desktop/src/main/connector-service';
import { VaultService } from '../../desktop/src/main/vault-service';
import type { AgentEvent, CommandMap, CommandResultMap } from '../../desktop/src/shared/contracts';
import { withWorkspaceLock } from './database';
import { CloudError, requireCondition } from './errors';
import type { ElizaClient } from './eliza';
import { MailboxStore, mailboxConnectorId } from './mailboxes';
import { postgresVaultPersistence } from './vault-persistence';
import { entitlement, memberOrganization, type Identity, type Organization } from './workspaces';
import { isAdmin } from './plans';
import type { Session } from './sessions';
import { FileStore } from './files';
import { z } from 'zod';
import { recoverCloudAgentResults } from './agent-recovery';
import { exportCloudArchive, restoreCloudArchive } from './archive';

const READ_COMMANDS = new Set<keyof CommandMap>([
  'investor.get',
  'search',
  'data.exportCsv',
  'backup.export',
  'contribution.export',
  'agent.detect',
]);
const OPTIONAL_MAILBOX_ERRORS = new Set([
  'mailbox_changed',
  'google_account_setup_required',
  'eliza_permission_required',
  'eliza_request_unconfirmed',
]);
const PROVIDER_COMMANDS = new Set<keyof CommandMap>([
  'draft.send',
  'connector.test',
  'connector.syncCalendar',
  'connector.syncMail',
  'meeting.create',
]);
const ADMIN_COMMANDS = new Set<keyof CommandMap>([
  'onboarding.complete',
  'communications.policy.update',
  'backup.restore',
  'data.importSeed',
]);
const NATIVE_COMMANDS = new Set<keyof CommandMap>([
  'connector.configure',
  'connector.connect',
  'connector.disconnect',
  'agent.login',
  'agent.logout',
  'agent.credential.set',
  'agent.credential.remove',
  'agent.subscription.set',
  'data.reset',
]);
const FILE_COMMANDS = new Set<keyof CommandMap>([
  'data.previewInvestorCsv',
  'data.importInvestorCsv',
  'data.exportCsv',
  'data.importSeed',
  'backup.export',
  'backup.restore',
  'contribution.export',
]);

class DelegatedCredentialStore implements ConnectorSecretStore {
  constructor(
    readonly grant: string,
    readonly email: string,
  ) {}
  bindVault(): void {
    /* The delegated credential belongs to this request, never to a shared vault. */
  }
  async status() {
    return { available: true, backend: 'encrypted-cloud-session', reason: null };
  }
  async get<T>(key: string): Promise<T | null> {
    return key === 'oauth/google/tokens'
      ? ({ accessToken: this.grant, accountEmail: this.email, tokenType: 'Bearer' } as T)
      : null;
  }
  async set(): Promise<void> {
    throw new CloudError(403, 'managed_credentials', 'Manage your Gmail connection in Eliza.');
  }
  delete(): void {
    throw new CloudError(
      403,
      'managed_credentials',
      'Disconnect Gmail through workspace settings.',
    );
  }
}

export interface RuntimeContext {
  client: PoolClient;
  directory: string;
  vault: VaultService;
  organization: Organization;
  session: Session;
  identity: Identity;
}

export class CloudRuntime {
  readonly mailboxes: MailboxStore;
  constructor(
    readonly options: {
      pool: Pool;
      eliza: ElizaClient;
      revision: string;
      agentFactory: (context: RuntimeContext) => AgentPort;
      resourceDirectory?: string;
    },
  ) {
    this.mailboxes = new MailboxStore(options.pool, options.eliza);
  }

  async withVault<T>(
    session: Session,
    identity: Identity,
    orgId: string,
    work: (context: RuntimeContext, command: CommandService) => Promise<T>,
    emit: (event: AgentEvent) => void = () => {},
    mailboxAccess: 'required' | 'optional' = 'required',
  ) {
    return withWorkspaceLock(this.options.pool, orgId, async (client) => {
      const organization = await memberOrganization(client, session.userId, orgId);
      const directory = await mkdtemp(join(tmpdir(), 'outreachr-cloud-'));
      let vault: VaultService | undefined;
      try {
        const mailbox = await this.mailboxes
          .current(session.userId, orgId, session.grant, client)
          .catch((error: unknown) => {
            // Allow local workspace work when the selected Gmail connection is unavailable.
            // Never reuse unconfirmed mailbox credentials or suppress authentication/DB errors.
            if (
              mailboxAccess === 'optional' &&
              error instanceof CloudError &&
              OPTIONAL_MAILBOX_ERRORS.has(error.code)
            )
              return null;
            throw error;
          });
        const connectorId = mailbox
          ? mailboxConnectorId(mailbox.email)
          : `connector:cloud:unconnected:${session.userId}`;
        vault = new VaultService({
          appVersion: `cloud-${this.options.revision.slice(0, 12)}`,
          platform: 'linux',
          dataDirectory: directory,
          resourceDirectory:
            this.options.resourceDirectory ?? resolve(import.meta.dirname, '../../../resources'),
          persistence: postgresVaultPersistence(client, orgId),
          connectorIds: {
            google: connectorId,
            microsoft: `connector:cloud:unsupported:${session.userId}`,
          },
          senderEmail: identity.email,
          actorId: session.userId,
        });
        await vault.initialize();
        if (mailbox) {
          const existing = vault.vault.one<{ public_config_json: string }>(
            'SELECT public_config_json FROM connector_configs WHERE id=?',
            [connectorId],
          );
          const prior: unknown = existing ? JSON.parse(existing.public_config_json) : {};
          const configuration =
            typeof prior === 'object' && prior !== null && !Array.isArray(prior) ? prior : {};
          const now = new Date().toISOString();
          vault.repository.upsertConnectorConfig({
            id: connectorId,
            provider: 'google',
            accountLabel: mailbox.email,
            publicConfig: {
              ...configuration,
              clientId: 'eliza-cloud-managed',
              relationshipSync: true,
            },
            secretRef: 'memory://eliza-cloud-delegation',
            scopes: effectiveGoogleScopes(mailbox.grantedCapabilities),
            status: 'connected',
            createdAt: now,
            updatedAt: now,
          });
          await vault.persist();
        }
        const context = { client, directory, vault, organization, session, identity };
        await recoverCloudAgentResults(context);
        const connectors = new ConnectorService({
          vault,
          secureStore: new DelegatedCredentialStore(
            session.grant,
            mailbox?.email ?? identity.email,
          ),
          openExternal: async () => {
            throw new CloudError(
              403,
              'browser_action_required',
              'Open this connection from workspace settings.',
            );
          },
          fetch: mailbox
            ? this.options.eliza.googleFetch(session.grant, mailbox.connectionId)
            : async () => {
                throw new CloudError(
                  403,
                  'mailbox_required',
                  'Select your Gmail connection in workspace settings.',
                );
              },
        });
        const command = new CommandService({
          vault,
          connectors,
          agents: this.options.agentFactory(context),
          emitAgentEvent: emit,
        });
        return await work(context, command);
      } finally {
        vault?.vault?.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  bootstrap(session: Session, identity: Identity, orgId: string) {
    return this.withVault(
      session,
      identity,
      orgId,
      async (_context, command) => {
        const data = await command.bootstrap();
        return { ...data, hosting: 'cloud' as const, vaultPath: 'Cloud workspace' };
      },
      undefined,
      'optional',
    );
  }

  execute<K extends keyof CommandMap>(
    session: Session,
    identity: Identity,
    orgId: string,
    name: K,
    payload: unknown,
    emit?: (event: AgentEvent) => void,
  ): Promise<CommandResultMap[K]> {
    const manualMeeting =
      name === 'meeting.create' &&
      z.object({ provider: z.literal('manual') }).safeParse(payload).success;
    requireCondition(
      !NATIVE_COMMANDS.has(name),
      400,
      'cloud_settings_required',
      'Use workspace settings for cloud account, mailbox, and subscription controls.',
    );
    return this.withVault(
      session,
      identity,
      orgId,
      async (context, command) => {
        const { organization, client, directory } = context;
        if (
          !READ_COMMANDS.has(name) &&
          !(name === 'knowledge.remove' && organization.role !== 'viewer')
        )
          requireCondition(
            entitlement(organization, new Date()).canEdit,
            403,
            'editing_seat_required',
            'An editing seat and active trial or subscription are required.',
          );
        if (ADMIN_COMMANDS.has(name))
          requireCondition(
            isAdmin(organization.role),
            403,
            'admin_required',
            'Only workspace owners and admins can change this setting.',
          );
        if (name === 'backup.export' || name === 'backup.restore') {
          const backup = z
            .object({
              password: z.string().min(12).max(10000),
              path: z.string().optional(),
              directory: z.string().optional(),
            })
            .parse(payload);
          if (name === 'backup.export') {
            requireCondition(
              backup.directory === 'cloud-downloads',
              400,
              'download_target_invalid',
              'Use the browser download destination.',
            );
            return (await exportCloudArchive(context, backup.password)) as CommandResultMap[K];
          }
          const restored = await restoreCloudArchive(
            context,
            z.string().parse(backup.path),
            backup.password,
          );
          return {
            ...restored,
            hosting: 'cloud',
            vaultPath: 'Cloud workspace',
          } as CommandResultMap[K];
        }
        const files = new FileStore(client);
        let input = payload;
        if (FILE_COMMANDS.has(name)) {
          const value = z.record(z.string(), z.unknown()).parse(payload);
          if (
            [
              'data.previewInvestorCsv',
              'data.importInvestorCsv',
              'data.importSeed',
              'backup.restore',
            ].includes(name)
          ) {
            input = {
              ...value,
              path: await files.materialize(
                session.userId,
                orgId,
                z.string().parse(value.path),
                directory,
              ),
            };
          } else {
            requireCondition(
              value.directory === 'cloud-downloads',
              400,
              'download_target_invalid',
              'Use the browser download destination.',
            );
            input = { ...value, directory };
          }
        }
        // Validate a document reference before persisting it. New uploads expire unless linked.
        const document =
          name === 'knowledge.save'
            ? z
                .object({ content: z.string() })
                .parse(input)
                .content.match(/^file:(cloud-file:[0-9a-f-]{36})$/)?.[1]
            : undefined;
        if (document) {
          const file = await files.get(session.userId, orgId, document);
          requireCondition(
            file.purpose === 'upload' &&
              (file.user_id === session.userId || file.expires_at === null),
            403,
            'document_upload_required',
            'Choose your own upload or an existing workspace document.',
          );
        }
        let result = await command.execute(name, input);
        if (document) await files.retain(session.userId, orgId, document);
        if (name === 'data.exportCsv') {
          const output = result as { path: string };
          result = {
            path: await files.capture(session.userId, orgId, output.path),
          } as CommandResultMap[K];
        } else if (name === 'contribution.export') {
          const output = result as { databasePath: string; diffPath: string };
          result = {
            databasePath: await files.capture(session.userId, orgId, output.databasePath),
            diffPath: await files.capture(session.userId, orgId, output.diffPath),
          } as CommandResultMap[K];
        }
        if (result && typeof result === 'object' && 'vaultPath' in result) {
          Object.assign(result, { hosting: 'cloud', vaultPath: 'Cloud workspace' });
        }
        await client.query('INSERT INTO outreachr.audit(org_id,user_id,action) VALUES($1,$2,$3)', [
          orgId,
          session.userId,
          `command.${name}`,
        ]);
        return result;
      },
      emit,
      PROVIDER_COMMANDS.has(name) && !manualMeeting ? 'required' : 'optional',
    );
  }
}
