/** Calls the registered Eliza Cloud boundary; provider secrets never enter Outreachr's browser. */
import { CloudError } from './errors';

import { OutreachrDelegation, type DelegationConfig } from './delegation';
export { delegatedGoogleConnection as googleConnection } from './delegation';
export type { DelegatedGoogleConnection as GoogleConnection } from './delegation';

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

/** Product adapter uses generic registered Cloud capabilities only. */
export class ElizaClient extends OutreachrDelegation {
  constructor(config: DelegationConfig, request: typeof fetch = fetch) {
    super(config, request);
  }
}
