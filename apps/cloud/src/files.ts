/** Stores workspace files behind opaque references instead of accepting server filesystem paths. */
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockOrganization, transaction } from './database';
import { requireCondition } from './errors';
import { entitlement, memberOrganization } from './workspaces';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024;
const reference = z.string().regex(/^cloud-file:[0-9a-f-]{36}$/);

export class FileStore {
  constructor(readonly database: Pool | PoolClient) {}

  async save(
    userId: string,
    orgId: string,
    name: string,
    content: Buffer,
    purpose: 'upload' | 'download',
  ) {
    requireCondition(
      content.length > 0 && content.length <= MAX_FILE_BYTES,
      413,
      'file_size_invalid',
      'Files must be between 1 byte and 25 MB.',
    );
    const safeName =
      basename(name.replaceAll('\\', '/'))
        .replace(/[^a-zA-Z0-9 ._()-]/g, '_')
        .slice(0, 150) || 'download';
    return transaction(this.database, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      if (purpose === 'upload')
        requireCondition(
          entitlement(org, new Date()).canEdit,
          403,
          'editing_seat_required',
          'An active editing seat is required to upload files.',
        );
      await client.query('DELETE FROM outreachr.files WHERE org_id=$1 AND expires_at < now()', [
        orgId,
      ]);
      const used = (
        await client.query<{ bytes: number }>(
          'SELECT COALESCE(sum(octet_length(content)),0)::int AS bytes FROM outreachr.files WHERE org_id=$1',
          [orgId],
        )
      ).rows[0]!.bytes;
      requireCondition(
        used + content.length <= MAX_WORKSPACE_FILE_BYTES,
        413,
        'file_storage_full',
        'Workspace file storage is full. Remove unused files before uploading.',
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO outreachr.files(id,org_id,user_id,name,content,purpose,expires_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='download' THEN now()+interval '1 hour' ELSE NULL END)`,
        [id, orgId, userId, safeName, content, purpose],
      );
      return `cloud-file:${id}`;
    });
  }

  async get(userId: string, orgId: string, handle: string, ownUpload = false) {
    await memberOrganization(this.database, userId, orgId);
    const id = z.string().uuid().parse(reference.parse(handle).slice('cloud-file:'.length));
    const row = (
      await this.database.query<{
        id: string;
        name: string;
        content: Buffer;
        user_id: string;
        purpose: string;
      }>(
        'SELECT id,name,content,user_id,purpose FROM outreachr.files WHERE id=$1 AND org_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [id, orgId],
      )
    ).rows[0];
    requireCondition(
      row &&
        (!ownUpload || (row.user_id === userId && row.purpose === 'upload')) &&
        (row.purpose !== 'download' || row.user_id === userId),
      404,
      'file_not_found',
      'File not found in this workspace.',
    );
    return row;
  }

  async remove(userId: string, orgId: string, handle: string) {
    return transaction(this.database, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        entitlement(org, new Date()).canEdit,
        403,
        'editing_seat_required',
        'An active editing seat is required.',
      );
      const file = await new FileStore(client).get(userId, orgId, handle);
      requireCondition(
        file.user_id === userId || org.role === 'owner' || org.role === 'admin',
        403,
        'file_owner_required',
        'Only the uploader or a workspace admin can remove this file.',
      );
      await client.query('DELETE FROM outreachr.files WHERE id=$1 AND org_id=$2', [file.id, orgId]);
    });
  }

  async materialize(userId: string, orgId: string, handle: string, directory: string) {
    const file = await this.get(userId, orgId, handle, true);
    const path = join(directory, `${file.id}-${file.name}`);
    await writeFile(path, file.content, { mode: 0o600, flag: 'wx' });
    return path;
  }

  async capture(userId: string, orgId: string, path: string) {
    return this.save(userId, orgId, basename(path), await readFile(path), 'download');
  }
}
