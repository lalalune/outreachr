import { AppInferenceClient } from '@elizaos/cloud-sdk';
import type { Organization } from './workspaces';
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

export const completionSchema = z.object({
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
});
export type Completion = z.infer<typeof completionSchema>;

export interface InferenceConfig {
  apiOrigin: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  developerApiKey: string;
  billingEnvironment: 'test' | 'live';
}
export interface InferenceFunding {
  billingAccountId: string;
  productFamilyKey: string;
  delegationToken: string;
}

export class InferenceClient {
  private readonly sdk: AppInferenceClient;
  get apiKey() {
    return this.config.developerApiKey;
  }
  get origin() {
    return this.config.apiOrigin;
  }
  constructor(
    readonly config: InferenceConfig,
    readonly request: typeof fetch = fetch,
  ) {
    this.sdk = new AppInferenceClient(config.appId, {
      apiBaseUrl: `${config.apiOrigin}/api/v1`,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      developerApiKey: config.developerApiKey,
      fetchImpl: (input, init) => request(input, { ...init, redirect: 'error' }),
    });
  }
  funding(
    organization: Pick<
      Organization,
      | 'cloud_app_id'
      | 'cloud_billing_account_id'
      | 'cloud_billing_environment'
      | 'cloud_product_family_key'
    >,
    delegationToken: string,
  ): InferenceFunding {
    requireCondition(
      organization.cloud_app_id === this.config.appId &&
        organization.cloud_billing_environment === this.config.billingEnvironment &&
        organization.cloud_billing_account_id &&
        organization.cloud_product_family_key,
      503,
      'app_billing_not_ready',
      'This workspace is not yet connected to Cloud app billing.',
    );
    return {
      billingAccountId: organization.cloud_billing_account_id,
      productFamilyKey: organization.cloud_product_family_key,
      delegationToken,
    };
  }

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
    funding: InferenceFunding;
  }) {
    const operation = z
      .object({
        billingAccountId: z.uuid(),
        productFamilyKey: z.string().min(1).max(128),
        delegationToken: z.string().regex(/^ead_[A-Za-z0-9_-]{43}$/),
      })
      .safeParse(input.funding);
    requireCondition(
      operation.success,
      503,
      'app_billing_not_ready',
      'Cloud app funding is not configured for this request.',
    );
    let response: unknown;
    try {
      response = await this.sdk.createChatCompletion(
        { ...operation.data, operationId: input.requestId },
        {
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
        },
        { signal: input.signal, timeoutMs: 180_000 },
      );
    } catch {
      throw new CloudError(
        502,
        'inference_failed',
        'Cloud inference did not return a confirmed result. Review the recorded run before retrying.',
      );
    }
    const result = completionSchema.parse(response);
    requireCondition(
      result.model === input.model,
      502,
      'model_mismatch',
      'Cloud returned a different model than requested.',
    );
    return result;
  }
}
