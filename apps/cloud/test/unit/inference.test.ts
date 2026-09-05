import { randomUUID } from 'node:crypto';
/** Keeps plan inference on the operator credential and rejects unverified model/usage results. */
import { describe, expect, it } from 'vitest';
import { InferenceClient } from '../../src/inference';
import { PLANS } from '../../src/plans';

const appId = randomUUID();
const clientId = randomUUID();
const accountId = randomUUID();
const grant = `ead_${'a'.repeat(43)}`;
const config = {
  apiOrigin: 'https://cloud.fixture.test',
  appId,
  clientId,
  clientSecret: 'fixture-client-secret',
  developerApiKey: 'app-operator-fixture-key',
  billingEnvironment: 'test' as const,
};
const operatorKey = 'app-operator-fixture-key';
const input = (model: string) => ({
  model,
  funding: { billingAccountId: accountId, productFamilyKey: 'workspace', delegationToken: grant },
  system: 'Return a proposal for review.',
  prompt: 'Suggest a task.',
  schema: { type: 'object', properties: {} },
  requestId: 'persisted-request-id',
  signal: new AbortController().signal,
});
const result = (model: string) => ({
  model,
  choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

describe('app inference boundary', () => {
  it.each(Object.values(PLANS))(
    'uses the operator credential and exact $name model',
    async (plan) => {
      const client = new InferenceClient(config, async (url, init) => {
        expect(String(url)).toBe(
          `https://cloud.fixture.test/api/v1/apps/${appId}/inference/chat/completions`,
        );
        const headers = new Headers(init!.headers);
        expect(headers.get('Authorization')).toBe(
          `Basic ${Buffer.from(`${clientId}:fixture-client-secret`).toString('base64')}`,
        );
        expect(headers.get('X-Eliza-Developer-Authorization')).toBe(`Bearer ${operatorKey}`);
        expect(headers.get('X-App-Delegation')).toBe(grant);
        expect(headers.get('X-Eliza-Billing-Account-Id')).toBe(accountId);
        expect(headers.get('X-Eliza-Product-Family')).toBe('workspace');
        expect(headers.has('X-App-Id')).toBe(false);
        expect(headers.get('Idempotency-Key')).toBe('persisted-request-id');
        expect(init!.redirect).toBe('error');
        const body = JSON.parse(String(init!.body));
        expect(body.model).toBe(plan.model);
        expect(body).not.toHaveProperty('user');
        expect(body).not.toHaveProperty('organizationId');
        expect(body).not.toHaveProperty('tools');
        expect(String(init!.body)).not.toContain(operatorKey);
        return Response.json(result(plan.model));
      });
      expect((await client.complete(input(plan.model))).model).toBe(plan.model);
    },
  );

  it('requires an explicit same-app, same-environment account mapping before dispatch', async () => {
    let calls = 0;
    const client = new InferenceClient(config, async () => {
      calls++;
      return Response.json(result(PLANS.sol.model));
    });
    const mapping = {
      cloud_app_id: appId,
      cloud_billing_account_id: accountId,
      cloud_billing_environment: 'test' as const,
      cloud_product_family_key: 'workspace',
    };
    expect(client.funding(mapping, grant)).toEqual(input(PLANS.sol.model).funding);
    for (const changed of [
      { ...mapping, cloud_billing_account_id: null },
      { ...mapping, cloud_app_id: randomUUID() },
      { ...mapping, cloud_billing_environment: 'live' as const },
    ])
      expect(() => client.funding(changed, grant)).toThrow(
        expect.objectContaining({ code: 'app_billing_not_ready' }),
      );
    await expect(
      client.complete({
        ...input(PLANS.sol.model),
        funding: {
          ...input(PLANS.sol.model).funding,
          billingAccountId: 'workspace-id-is-not-a-cloud-account',
        },
      }),
    ).rejects.toMatchObject({ code: 'app_billing_not_ready' });
    expect(calls).toBe(0);
  });

  it('does not retry ambiguous outcomes or expose confidential upstream errors', async () => {
    let calls = 0;
    const client = new InferenceClient(config, async () => {
      calls++;
      return Response.json(
        { error: { code: 'APP_INFERENCE_OUTCOME_UNKNOWN', message: 'secret upstream detail' } },
        { status: 409 },
      );
    });
    await expect(client.complete(input(PLANS.sol.model))).rejects.toMatchObject({
      code: 'inference_failed',
    });
    expect(calls).toBe(1);
  });

  it('does not substitute an available model when the plan model is absent', async () => {
    const client = new InferenceClient(config, async () =>
      Response.json({
        data: [
          {
            id: PLANS.sol.model,
            context_length: 100_000,
            pricing: { prompt: '0.001', completion: '0.001' },
          },
        ],
      }),
    );
    await expect(client.price(PLANS.astra.model)).rejects.toMatchObject({
      code: 'model_unavailable',
    });
  });

  it('rejects a successful provider response for a different model', async () => {
    const client = new InferenceClient(config, async () => Response.json(result(PLANS.sol.model)));
    await expect(client.complete(input(PLANS.astra.model))).rejects.toMatchObject({
      code: 'model_mismatch',
    });
  });

  it('does not report a verified result without valid provider usage', async () => {
    for (const usage of [
      undefined,
      { prompt_tokens: -1, completion_tokens: 20 },
      { prompt_tokens: 100 },
    ]) {
      const client = new InferenceClient(config, async () =>
        Response.json({ ...result(PLANS.sol.model), usage }),
      );
      await expect(client.complete(input(PLANS.sol.model))).rejects.toThrow();
    }
  });
});
