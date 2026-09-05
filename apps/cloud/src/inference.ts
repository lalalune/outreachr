/** Calls exact Eliza Cloud models and meters provider-reported tokens against the current catalog. */
import { z } from 'zod';
import { CloudError, requireCondition } from './errors';
import { boundedResponseText } from './eliza';

const rate = z.coerce.number().finite().positive();
const modelSchema = z.object({
  id: z.string(),
  context_length: z.number().int().positive(),
  pricing: z.object({
    prompt: rate,
    completion: rate,
    overrides: z
      .array(z.object({ min_prompt_tokens: z.number(), prompt: rate, completion: rate }))
      .optional(),
  }),
});
export type ModelPrice = z.infer<typeof modelSchema>;
export const MAX_OUTPUT_TOKENS = 4096;
// The product allowance uses uncached catalog tokens plus Cloud's 20% markup.
// It is an application allowance, not a claim about the final Cloud invoice.
export function allowanceCost(price: ModelPrice, inputTokens: number, outputTokens: number) {
  const tier =
    [...(price.pricing.overrides ?? [])]
      .sort((a, b) => b.min_prompt_tokens - a.min_prompt_tokens)
      .find((item) => inputTokens >= item.min_prompt_tokens) ?? price.pricing;
  return Math.ceil((inputTokens * tier.prompt + outputTokens * tier.completion) * 120);
}

export class InferenceClient {
  constructor(
    readonly origin: string,
    readonly apiKey: string,
    readonly request: typeof fetch = fetch,
  ) {}

  async price(model: string): Promise<ModelPrice> {
    requireCondition(
      Boolean(this.apiKey),
      503,
      'inference_not_configured',
      'Cloud inference is not configured.',
    );
    const response = await this.request(new URL('/api/v1/models', this.origin), {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    requireCondition(
      response.ok,
      503,
      'model_catalog_unavailable',
      'The model catalog is unavailable. Try again later.',
    );
    const catalog = z
      .object({ data: z.array(z.unknown()) })
      .parse(JSON.parse(await boundedResponseText(response, 8_000_000)));
    const found = catalog.data.find(
      (item) => typeof item === 'object' && item !== null && 'id' in item && item.id === model,
    );
    requireCondition(found, 503, 'model_unavailable', 'Your plan model is currently unavailable.');
    return modelSchema.parse(found);
  }

  async complete(input: {
    model: string;
    system: string;
    prompt: string;
    schema: object;
    requestId: string;
    signal: AbortSignal;
  }) {
    const response = await this.request(new URL('/api/v1/chat/completions', this.origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.requestId,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ],
        stream: false,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'outreachr_proposals', strict: true, schema: input.schema },
        },
      }),
    });
    if (!response.ok)
      throw new CloudError(
        502,
        'inference_failed',
        `Cloud inference did not return a confirmed result (${response.status}).`,
      );
    const result = z
      .object({
        model: z.string(),
        choices: z
          .array(
            z.object({
              finish_reason: z.string(),
              message: z.object({ content: z.string().nullable() }),
            }),
          )
          .min(1),
        usage: z.object({
          prompt_tokens: z.number().int().nonnegative(),
          completion_tokens: z.number().int().nonnegative(),
        }),
      })
      .parse(JSON.parse(await boundedResponseText(response, 2_000_000)));
    requireCondition(
      result.model === input.model,
      502,
      'model_mismatch',
      'Cloud returned a different model than requested.',
    );
    return result;
  }
}
