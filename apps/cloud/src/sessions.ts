/** Stores opaque browser sessions and encrypts delegated Cloud credentials at rest. */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { requireCondition } from './errors';
import { SESSION_DAYS } from './plans';
import { hashToken, newToken } from './workspaces';

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class CredentialCipher {
  readonly #key: Buffer;
  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, 'base64');
    if (this.#key.length !== 32)
      throw new Error('SESSION_ENCRYPTION_KEY must encode exactly 32 bytes');
  }

  encrypt(value: string, sessionHash: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(sessionHash));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decrypt(value: string, sessionHash: string): string {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(sessionHash));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export interface Session {
  userId: string;
  grant: string;
  expiresAt: Date;
}

export class SessionStore {
  constructor(
    readonly pool: Pool,
    readonly cipher: CredentialCipher,
    readonly now: () => Date = () => new Date(),
  ) {}

  async beginLogin(returnPath = '/') {
    requireCondition(
      returnPath.startsWith('/') && !returnPath.startsWith('//') && !/[\\\r\n]/u.test(returnPath),
      400,
      'invalid_return_path',
      'Return path must stay within Outreachr.',
    );
    const token = newToken();
    await this.pool.query(
      'INSERT INTO outreachr.login_states(token_hash,expires_at,return_path) VALUES($1,$2,$3)',
      [hashToken(token), new Date(this.now().getTime() + 10 * 60_000), returnPath],
    );
    return token;
  }

  async consumeLogin(state: string, cookieState: string) {
    requireCondition(
      state.length >= 32 && state.length <= 128 && constantTimeEqual(state, cookieState),
      401,
      'login_state_invalid',
      'Login state is missing or does not match this browser. Start again.',
    );
    const result = await this.pool.query<{ return_path: string }>(
      'DELETE FROM outreachr.login_states WHERE token_hash=$1 AND expires_at>$2 RETURNING return_path',
      [hashToken(state), this.now()],
    );
    requireCondition(
      result.rows[0],
      401,
      'login_state_expired',
      'Login expired or was already completed. Start again.',
    );
    return result.rows[0].return_path;
  }

  async create(userId: string, grant: string, grantExpiresAt: Date) {
    const token = newToken();
    const digest = hashToken(token);
    const expiresAt = new Date(
      Math.min(this.now().getTime() + SESSION_DAYS * 86_400_000, grantExpiresAt.getTime()),
    );
    requireCondition(
      Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > this.now().getTime(),
      401,
      'grant_expired',
      'Eliza login has expired.',
    );
    await this.pool.query(
      'INSERT INTO outreachr.sessions(token_hash,user_id,eliza_grant_ciphertext,expires_at) VALUES($1,$2,$3,$4)',
      [digest, userId, this.cipher.encrypt(grant, digest), expiresAt],
    );
    return { token, expiresAt };
  }

  async get(token: string | undefined): Promise<Session> {
    requireCondition(
      token && token.length >= 32 && token.length <= 128,
      401,
      'login_required',
      'Sign in with Eliza to continue.',
    );
    const digest = hashToken(token);
    const result = await this.pool.query<{
      user_id: string;
      eliza_grant_ciphertext: string;
      expires_at: Date;
    }>(
      `SELECT s.user_id,s.eliza_grant_ciphertext,s.expires_at FROM outreachr.sessions s
       JOIN outreachr.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.email_verified=true`,
      [digest, this.now()],
    );
    const row = result.rows[0];
    requireCondition(row, 401, 'session_expired', 'Your session has expired. Sign in again.');
    return {
      userId: row.user_id,
      grant: this.cipher.decrypt(row.eliza_grant_ciphertext, digest),
      expiresAt: row.expires_at,
    };
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('DELETE FROM outreachr.sessions WHERE token_hash=$1', [hashToken(token)]);
  }
}
