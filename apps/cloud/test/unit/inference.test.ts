/** Keeps plan inference on the operator credential and rejects unverified model/usage results. */
import { describe, expect, it } from 'vitest';
import { InferenceClient } from '../../src/inference';
import { PLANS } from '../../src/plans';

const operatorKey = 'app-operator-fixture-key';
const input = (model: string) => ({
  model,
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
      const client = new InferenceClient(
        'https://cloud.fixture.test',
        operatorKey,
        async (url, init) => {
          expect(String(url)).toBe('https://cloud.fixture.test/api/v1/chat/completions');
          const headers = new Headers(init!.headers);
          expect(headers.get('Authorization')).toBe(`Bearer ${operatorKey}`);
          expect(headers.get('Idempotency-Key')).toBe('persisted-request-id');
          expect(init!.redirect).toBe('error');
          const body = JSON.parse(String(init!.body));
          expect(body.model).toBe(plan.model);
          expect(body).not.toHaveProperty('user');
          expect(body).not.toHaveProperty('organizationId');
          expect(body).not.toHaveProperty('tools');
          expect(String(init!.body)).not.toContain(operatorKey);
          return Response.json(result(plan.model));
        },
      );
      expect((await client.complete(input(plan.model))).model).toBe(plan.model);
    },
  );

  it('does not substitute an available model when the plan model is absent', async () => {
    const client = new InferenceClient('https://cloud.fixture.test', operatorKey, async () =>
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
    const client = new InferenceClient('https://cloud.fixture.test', operatorKey, async () =>
      Response.json(result(PLANS.sol.model)),
    );
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
      const client = new InferenceClient('https://cloud.fixture.test', operatorKey, async () =>
        Response.json({ ...result(PLANS.sol.model), usage }),
      );
      await expect(client.complete(input(PLANS.sol.model))).rejects.toThrow();
    }
  });
});
