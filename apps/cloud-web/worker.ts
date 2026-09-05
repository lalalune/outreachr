/** Serves the CRM and proxies API requests to one configured private BFF origin. */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PUBLIC_ORIGIN: string;
  BFF_ORIGIN: string;
  EDGE_SECRET: string;
}
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.origin !== env.PUBLIC_ORIGIN)
      return new Response('Use the Outreachr website.', { status: 421 });
    let response: Response;
    if (incoming.pathname.startsWith('/api/')) {
      if (!env.BFF_ORIGIN || !env.EDGE_SECRET)
        return Response.json({ error: 'The service is not configured.' }, { status: 503 });
      const target = new URL(env.BFF_ORIGIN);
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.pathname !== '/'
      )
        return Response.json({ error: 'The service is not configured.' }, { status: 503 });
      target.pathname = incoming.pathname;
      target.search = incoming.search;
      const headers = new Headers();
      for (const name of [
        'accept',
        'content-type',
        'cookie',
        'origin',
        'x-outreachr-request',
        'x-file-name',
        'x-eliza-event',
        'x-eliza-delivery',
        'x-eliza-key-id',
        'x-eliza-timestamp',
        'x-eliza-signature',
      ]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set('X-Outreachr-Edge', env.EDGE_SECRET);
      try {
        response = await fetch(target, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(200_000)]),
        });
      } catch {
        response = Response.json(
          {
            error:
              'The service did not return a confirmed result. Refresh before retrying an external action.',
          },
          { status: 502 },
        );
      }
    } else response = await env.ASSETS.fetch(request);
    const result = new Response(response.body, response);
    for (const [name, value] of Object.entries(securityHeaders)) result.headers.set(name, value);
    if (incoming.pathname.startsWith('/api/')) result.headers.set('Cache-Control', 'no-store');
    return result;
  },
};
