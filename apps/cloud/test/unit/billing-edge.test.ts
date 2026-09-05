/** Exercises the deployed edge boundary's exact signed bytes and header allowlist. */
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../../cloud-web/worker';

afterEach(() => vi.unstubAllGlobals());
it('forwards Cloud notification signatures and exact bytes with only the configured edge credential', async () => {
  const body = '{ "signed": "exact bytes" }\n';
  const fetch = vi.fn(async (target: URL, input: RequestInit) => {
    expect(target.href).toBe('https://bff.fixture.test/api/billing/notifications');
    const headers = new Headers(input.headers);
    expect(headers.get('X-Outreachr-Edge')).toBe('configured-edge-secret');
    expect(headers.get('X-Eliza-Key-Id')).toBe('key-id');
    expect(headers.get('X-Eliza-Timestamp')).toBe('timestamp');
    expect(headers.get('X-Eliza-Signature')).toBe('sha256=signature');
    expect(headers.get('X-Eliza-Delivery')).toBe('delivery');
    expect(headers.get('X-Eliza-Event')).toBe('app.subscription.updated');
    expect(headers.has('Stripe-Signature')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
    expect(await new Response(input.body).text()).toBe(body);
    expect(input.redirect).toBe('manual');
    return Response.json({ received: true });
  });
  vi.stubGlobal('fetch', fetch);
  const response = await worker.fetch(
    new Request('https://app.fixture.test/api/billing/notifications', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Outreachr-Edge': 'attacker-supplied',
        'X-Eliza-Key-Id': 'key-id',
        'X-Eliza-Timestamp': 'timestamp',
        'X-Eliza-Signature': 'sha256=signature',
        'X-Eliza-Delivery': 'delivery',
        'X-Eliza-Event': 'app.subscription.updated',
        'Stripe-Signature': 'legacy',
        Authorization: 'unexpected',
      },
    }),
    {
      PUBLIC_ORIGIN: 'https://app.fixture.test',
      BFF_ORIGIN: 'https://bff.fixture.test',
      EDGE_SECRET: 'configured-edge-secret',
      ASSETS: { fetch: async () => new Response('unused') },
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(fetch).toHaveBeenCalledOnce();
});
