/** Stores workspace files behind opaque references instead of accepting server filesystem paths. */
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockOrganization, transaction } from './database';
import { requireCondition } from './errors';
import { entitlement, memberOrganization } from './workspaces';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024;
const reference = z.string().regex(/^cloud-file:[0-9a-f-]{36}$/);

export class FileStore {
  constructor(readonly database: Pool | PoolClient) {}

  async save(
    userId: string,
    orgId: string,
    name: string,
    content: Buffer,
    purpose: 'upload' | 'download' | 'archive_upload' | 'archive_download' | 'archive_part',
  ) {
    const archive = purpose.startsWith('archive_');
    requireCondition(
      content.length > 0 &&
        content.length <=
          (archive && purpose !== 'archive_part' ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES),
      413,
      'file_size_invalid',
      archive
        ? 'Archives must be between 1 byte and 256 MB.'
        : 'Files must be between 1 byte and 25 MB.',
    );
    const safeName =
      basename(name.replaceAll('\\', '/'))
        .replace(/[^a-zA-Z0-9 ._()-]/g, '_')
        .slice(0, 150) || 'download';
    return transaction(this.database, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      if (purpose === 'upload' || purpose === 'archive_upload' || purpose === 'archive_part')
        requireCondition(
          entitlement(org, new Date()).canEdit,
          403,
          'editing_seat_required',
          'An active editing seat is required to upload files.',
        );
      await client.query('DELETE FROM outreachr.files WHERE org_id=$1 AND expires_at < now()', [
        orgId,
      ]);
      if (archive && purpose !== 'archive_part')
        await client.query(
          'DELETE FROM outreachr.files WHERE org_id=$1 AND user_id=$2 AND purpose=$3',
          [orgId, userId, purpose],
        );
      const used = (
        await client.query<{ bytes: number }>(
          "SELECT COALESCE(sum(octet_length(content)),0)::int AS bytes FROM outreachr.files WHERE org_id=$1 AND (purpose LIKE 'archive_%')=$2",
          [orgId, archive],
        )
      ).rows[0]!.bytes;
      requireCondition(
        used + content.length <= (archive ? 2 * MAX_ARCHIVE_BYTES : MAX_WORKSPACE_FILE_BYTES),
        413,
        'file_storage_full',
        'Workspace file storage is full. Remove unused files before uploading.',
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO outreachr.files(id,org_id,user_id,name,content,purpose,expires_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6<>'upload' THEN now()+interval '1 hour' ELSE now()+interval '24 hours' END)`,
        [id, orgId, userId, safeName, content, purpose],
      );
      return `cloud-file:${id}`;
    });
  }

  async assembleArchive(userId: string, orgId: string, handles: string[]) {
    requireCondition(
      handles.length > 0 && handles.length <= 11 && new Set(handles).size === handles.length,
      400,
      'archive_parts_invalid',
      'Select a valid archive upload.',
    );
    return transaction(this.database, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        entitlement(org, new Date()).canEdit,
        403,
        'editing_seat_required',
        'An active editing seat is required to upload files.',
      );
      const parts = [];
      let bytes = 0;
      for (const handle of handles) {
        const part = await new FileStore(client).get(userId, orgId, handle, true);
        requireCondition(
          part.purpose === 'archive_part',
          400,
          'archive_parts_invalid',
          'Archive upload contains an invalid part.',
        );
        bytes += part.content.length;
        requireCondition(
          bytes <= MAX_ARCHIVE_BYTES,
          413,
          'archive_too_large',
          'Archives must be 256 MB or smaller.',
        );
        parts.push(part);
      }
      // Replace the chunks atomically: assembly must not double their storage charge.
      await client.query(
        "DELETE FROM outreachr.files WHERE org_id=$1 AND user_id=$2 AND (id=ANY($3::uuid[]) OR purpose='archive_upload')",
        [orgId, userId, parts.map((part) => part.id)],
      );
      const id = randomUUID();
      await client.query(
        "INSERT INTO outreachr.files(id,org_id,user_id,name,content,purpose,expires_at) VALUES($1,$2,$3,'Restore.outreachr-cloud-backup',$4,'archive_upload',now()+interval '1 hour')",
        [id, orgId, userId, Buffer.concat(parts.map((part) => part.content))],
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
        expires_at: Date | null;
      }>(
        'SELECT id,name,content,user_id,purpose,expires_at FROM outreachr.files WHERE id=$1 AND org_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [id, orgId],
      )
    ).rows[0];
    requireCondition(
      row &&
        (!ownUpload ||
          (row.user_id === userId &&
            ['upload', 'archive_upload', 'archive_part'].includes(row.purpose))) &&
        (row.purpose === 'upload' || row.user_id === userId),
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
        org.role !== 'viewer',
        403,
        'editing_role_required',
        'Only workspace editors and admins can remove files.',
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

  async list(userId: string, orgId: string) {
    const org = await memberOrganization(this.database, userId, orgId);
    const rows = await this.database.query<{
      id: string;
      name: string;
      bytes: number;
      expiresAt: Date | null;
      canRemove: boolean;
    }>(
      `SELECT id,name,octet_length(content) AS bytes,expires_at AS "expiresAt",
        ($2::boolean AND (user_id=$3 OR $4::boolean)) AS "canRemove"
       FROM outreachr.files WHERE org_id=$1 AND purpose='upload'
       AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC`,
      [orgId, org.role !== 'viewer', userId, org.role === 'owner' || org.role === 'admin'],
    );
    const used = await this.database.query<{ bytes: number }>(
      `SELECT COALESCE(sum(octet_length(content)),0)::int AS bytes FROM outreachr.files
       WHERE org_id=$1 AND purpose NOT LIKE 'archive_%' AND (expires_at IS NULL OR expires_at>now())`,
      [orgId],
    );
    return {
      files: rows.rows,
      usedBytes: used.rows[0]!.bytes,
      limitBytes: MAX_WORKSPACE_FILE_BYTES,
    };
  }

  /** Only an uploader can turn their temporary upload into a shared document. */
  async retain(userId: string, orgId: string, handle: string) {
    const file = await this.get(userId, orgId, handle);
    requireCondition(
      file.purpose === 'upload' && (file.user_id === userId || file.expires_at === null),
      403,
      'document_upload_required',
      'Choose your own upload or an existing workspace document.',
    );
    if (file.expires_at === null) return;
    const retained = await this.database.query(
      `UPDATE outreachr.files SET expires_at=NULL WHERE id=$1 AND org_id=$2 AND user_id=$3`,
      [file.id, orgId, userId],
    );
    requireCondition(
      retained.rowCount,
      409,
      'upload_expired',
      'This upload expired before it was saved. Upload the document again.',
    );
  }

  async cleanup() {
    await this.database.query('DELETE FROM outreachr.files WHERE expires_at < now()');
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
