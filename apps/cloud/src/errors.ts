/** Carries safe, actionable cloud API failures without leaking provider internals. */
export class CloudError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function requireCondition(
  condition: unknown,
  status: CloudError['status'],
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new CloudError(status, code, message);
}
