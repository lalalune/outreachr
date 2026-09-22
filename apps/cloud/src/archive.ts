/** Portable encrypted workspace data, excluding service identity and billing authority. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createEncryptedBackup, restoreEncryptedBackup } from '@outreachr/core';
import { openNodeVault } from '@outreachr/core/node';
import type { CoreVault } from '@outreachr/core';
import type { RuntimeContext } from './runtime';
import { FileStore, MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_WORKSPACE_FILE_BYTES } from './files';
import { transaction } from './database';
import { requireCondition } from './errors';
import { withArchiveCapacity } from './archive-admission';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const content = z.object({ bytes: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const archiveSchema = z.object({
  format: z.literal('outreachr-cloud-archive'),
  version: z.literal(1),
  snapshot: content,
  files: z
    .array(content.extend({ id: z.string().uuid(), name: z.string().min(1).max(150) }))
    .max(10000),
});
function decode(record: z.infer<typeof content>, max: number) {
  requireCondition(
    record.bytes.length <= Math.ceil(max / 3) * 4,
    413,
    'archive_too_large',
    'Archive exceeds the workspace storage limit.',
  );
  const bytes = Buffer.from(record.bytes, 'base64');
  requireCondition(
    bytes.length > 0 &&
      bytes.length <= max &&
      bytes.toString('base64') === record.bytes &&
      digest(bytes) === record.sha256,
    400,
    'archive_checksum_invalid',
    'Archive contents failed verification.',
  );
  return bytes;
}
function stripAuthority(vault: CoreVault) {
  vault.run('DELETE FROM secure_secrets');
  vault.run("UPDATE approvals SET status='revoked',revoked_at=? WHERE status='active'", [
    new Date().toISOString(),
  ]);
  vault.run("UPDATE messages SET state='draft' WHERE state='approved'");
  vault.run(
    "UPDATE connector_configs SET secret_ref='memory://reconnect-required',status='disabled',scopes_json='[]',public_config_json='{}'",
  );
  vault.run('UPDATE agent_context_grants SET revoked_at=? WHERE revoked_at IS NULL', [
    new Date().toISOString(),
  ]);
  // Erase deleted credential pages from the portable SQLite file as well.
  vault.run('VACUUM');
}

export function exportCloudArchive(context: RuntimeContext, password: string) {
  return withArchiveCapacity(() => exportArchive(context, password));
}

async function exportArchive(context: RuntimeContext, password: string) {
  const { vault, client, organization, session } = context;
  const clone = await openNodeVault({ bytes: vault.vault.export() });
  let snapshot: Buffer;
  try {
    stripAuthority(clone);
    snapshot = Buffer.from(clone.export());
  } finally {
    clone.close();
  }
  const rows = await client.query<{ id: string; name: string; content: Buffer }>(
    "SELECT id,name,content FROM outreachr.files WHERE org_id=$1 AND purpose='upload' AND expires_at IS NULL ORDER BY id",
    [organization.id],
  );
  const files = rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    bytes: row.content.toString('base64'),
    sha256: digest(row.content),
  }));
  const references = vault.vault.all<{ content: string }>(
    "SELECT content FROM knowledge_items WHERE content LIKE 'file:cloud-file:%'",
  );
  requireCondition(
    references.every((row) => files.some((file) => row.content === `file:cloud-file:${file.id}`)),
    409,
    'archive_document_missing',
    'A linked document is missing. Remove its stale reference or upload it again before exporting.',
  );
  const plaintext = Buffer.from(
    JSON.stringify({
      format: 'outreachr-cloud-archive',
      version: 1,
      snapshot: { bytes: snapshot.toString('base64'), sha256: digest(snapshot) },
      files,
    }),
  );
  requireCondition(
    plaintext.length <= Math.floor(MAX_ARCHIVE_BYTES * 0.74),
    413,
    'archive_too_large',
    'Workspace archive exceeds the 256 MB transfer limit.',
  );
  return {
    path: await new FileStore(client).save(
      session.userId,
      organization.id,
      'Outreachr.outreachr-cloud-backup',
      Buffer.from(await createEncryptedBackup(plaintext, password)),
      'archive_download',
    ),
  };
}

export function restoreCloudArchive(context: RuntimeContext, handle: string, password: string) {
  return withArchiveCapacity(() => restoreArchive(context, handle, password));
}

async function restoreArchive(context: RuntimeContext, handle: string, password: string) {
  const { vault, client, organization, session } = context;
  // Historical provider actions must never be rolled back by a portable import.
  requireCondition(
    Number(vault.vault.scalar('SELECT count(*) FROM send_ledger')) === 0 &&
      Number(vault.vault.scalar('SELECT count(*) FROM mail_events')) === 0 &&
      Number(vault.vault.scalar('SELECT count(*) FROM calendar_operations')) === 0,
    409,
    'restore_requires_unused_workspace',
    'Restore into a workspace with no email or calendar history. Existing provider history cannot be replaced.',
  );
  const upload = await new FileStore(client).get(session.userId, organization.id, handle, true);
  requireCondition(
    upload.purpose === 'archive_upload',
    400,
    'cloud_archive_required',
    'Select a complete Outreachr cloud archive. Desktop database backups do not include hosted documents.',
  );
  const archive = archiveSchema.parse(
    JSON.parse(
      Buffer.from(await restoreEncryptedBackup(upload.content, password)).toString('utf8'),
    ),
  );
  const snapshot = decode(archive.snapshot, MAX_ARCHIVE_BYTES);
  const files = archive.files.map((file) => ({
    ...file,
    content: decode(file, MAX_FILE_BYTES),
    newId: randomUUID(),
  }));
  requireCondition(
    new Set(files.map((file) => file.id)).size === files.length,
    400,
    'archive_duplicate_file',
    'Archive contains duplicate document identifiers.',
  );
  requireCondition(
    files.reduce((sum, file) => sum + file.content.length, 0) <= MAX_WORKSPACE_FILE_BYTES,
    413,
    'archive_too_large',
    'Documents exceed the workspace storage limit.',
  );
  await transaction(client, async () => {
    await vault.restoreSnapshot(snapshot); // Integrity, schema and audit-chain verification precede persistence.
    stripAuthority(vault.vault);
    for (const row of vault.vault.all<{ id: string; content: string }>(
      "SELECT id,content FROM knowledge_items WHERE content LIKE 'file:cloud-file:%'",
    )) {
      const file = files.find((file) => row.content === `file:cloud-file:${file.id}`);
      requireCondition(
        file,
        400,
        'archive_document_missing',
        'Archive is missing a linked document.',
      );
      const reference = `file:cloud-file:${file.newId}`;
      vault.vault.run('UPDATE knowledge_items SET content=?,content_sha256=? WHERE id=?', [
        reference,
        digest(reference),
        row.id,
      ]);
    }
    await client.query('DELETE FROM outreachr.files WHERE org_id=$1', [organization.id]);
    for (const file of files)
      await client.query(
        "INSERT INTO outreachr.files(id,org_id,user_id,name,content,purpose) VALUES($1,$2,$3,$4,$5,'upload')",
        [
          file.newId,
          organization.id,
          session.userId,
          file.name.replace(/[^a-zA-Z0-9 ._()-]/g, '_'),
          file.content,
        ],
      );
    await vault.persist();
    await client.query(
      "INSERT INTO outreachr.audit(org_id,user_id,action,detail) VALUES($1,$2,'workspace.archive_restored',$3)",
      [organization.id, session.userId, JSON.stringify({ documents: files.length })],
    );
  });
  return vault.bootstrap();
}
