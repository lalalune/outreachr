/** Calls the registered Eliza Cloud boundary; provider secrets never enter Outreachr's browser. */
import { z } from 'zod';
import { CloudError } from './errors';

const principal = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  email: z.email(),
  name: z.string(),
  emailVerified: z.boolean(),
});
const exchangeResult = z.object({
  success: z.literal(true),
  token: z.string().startsWith('outreachr_'),
  expiresAt: z.string().datetime(),
  user: principal,
});
export const googleConnection = z.object({
  connectionId: z.string().uuid().nullable(),
  connected: z.boolean(),
  configured: z.boolean(),
  identity: z.record(z.string(), z.unknown()).nullable(),
  grantedScopes: z.array(z.string()),
  grantedCapabilities: z.array(z.string()),
  reason: z.string(),
});
export type GoogleConnection = z.infer<typeof googleConnection>;

export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new CloudError(
        502,
        'eliza_response_too_large',
        'Eliza returned an oversized response.',
      );
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class ElizaClient {
  constructor(
    readonly origin: string,
    readonly clientSecret: string,
    readonly request: typeof fetch = fetch,
  ) {}

  async response(path: string, grant: string | null, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('X-Outreachr-Client', this.clientSecret);
    headers.set('Content-Type', 'application/json');
    if (grant) headers.set('Authorization', `Bearer ${grant}`);
    try {
      return await this.request(new URL(`/api/v1/outreachr${path}`, this.origin), {
        ...init,
        headers,
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      });
    } catch {
      // A timed-out send may have completed. Callers must retain its durable ambiguous reservation.
      throw new CloudError(
        502,
        'eliza_transport_unavailable',
        'Eliza Cloud did not return a confirmed result.',
      );
    }
  }

  private async json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) {
      throw new CloudError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        'eliza_request_failed',
        response.status === 401 || response.status === 403
          ? 'Eliza authorization expired. Sign in again.'
          : `Eliza Cloud request failed (${response.status}).`,
      );
    }
    const text = await boundedResponseText(response, 2_000_000);
    if (text.length > 2_000_000)
      throw new CloudError(
        502,
        'eliza_response_too_large',
        'Eliza returned an oversized response.',
      );
    return schema.parse(JSON.parse(text));
  }

  async billing<T>(input: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.json(
      await this.response('/billing', null, { method: 'POST', body: JSON.stringify(input) }),
      schema,
    );
  }
  async exchange(code: string) {
    return this.json(
      await this.response('/token', null, { method: 'POST', body: JSON.stringify({ code }) }),
      exchangeResult,
    );
  }
  async identity(grant: string) {
    return (
      await this.json(
        await this.response('/identity', grant),
        z.object({ success: z.literal(true), user: principal }),
      )
    ).user;
  }
  async connections(grant: string) {
    return (
      await this.json(
        await this.response('/google/connections', grant),
        z.object({ success: z.literal(true), connections: z.array(googleConnection) }),
      )
    ).connections;
  }
  async revoke(grant: string) {
    await this.json(
      await this.response('/revoke', grant, { method: 'POST' }),
      z.object({ success: z.literal(true) }),
    );
  }
  googleFetch(grant: string, connectionId: string): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.body !== undefined && typeof init.body !== 'string')
        throw new CloudError(400, 'google_body_invalid', 'Google requests must use a JSON body.');
      return this.response('/google/request', grant, {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          url,
          method: init?.method ?? 'GET',
          ...(init?.body ? { body: init.body } : {}),
        }),
      });
    };
  }
}
