/** Rehydrates paid, recorded responses after process loss; never invokes inference or applies proposals. */
import type { RuntimeContext } from './runtime';
import { parseCloudResult } from './agent';
import { completionSchema } from './inference';
import { stableJson } from '@outreachr/core';

export async function recoverCloudAgentResults({
  client,
  vault,
  session,
  organization,
}: RuntimeContext) {
  const results = await client.query<{ id: string; request_key: string; response_json: unknown }>(
    "SELECT id,request_key,response_json FROM outreachr.usage WHERE org_id=$1 AND user_id=$2 AND status='completed' AND response_json IS NOT NULL AND recovered_at IS NULL ORDER BY created_at LIMIT 50",
    [organization.id, session.userId],
  );
  for (const row of results.rows) {
    const run = vault.vault.one<{ status: string }>('SELECT status FROM agent_runs WHERE id=?', [
      row.request_key,
    ]);
    if (!run) continue; // An intentional archive restore may not contain this local run.
    if (run.status !== 'completed') {
      try {
        const response = completionSchema.parse(row.response_json);
        if (response.choices[0]?.finish_reason !== 'stop') throw new Error('Incomplete response');
        const result = parseCloudResult(response.choices[0].message.content);
        // Preserve already reviewed proposals, including partial responses from pre-recovery versions.
        const existing = vault.vault
          .all<{ payload_json: string }>(
            'SELECT payload_json FROM agent_proposals WHERE agent_run_id=?',
            [row.request_key],
          )
          .map((item) => stableJson(JSON.parse(item.payload_json)));
        vault.vault.transaction(() => {
          for (const [index, proposal] of result.proposals.entries()) {
            const payload = {
              kind: proposal.kind,
              title: proposal.title,
              rationale: proposal.rationale,
              investorId: proposal.investorId ?? null,
              payload: proposal.payload,
            };
            const match = existing.indexOf(stableJson(payload));
            if (match >= 0) {
              existing.splice(match, 1);
              continue;
            }
            vault.repository.createAgentProposal({
              id: `proposal:${row.request_key}:${index}`,
              agentRunId: row.request_key,
              proposalType: proposal.kind,
              payload,
              status: 'pending',
              reviewedAt: null,
              createdAt: new Date().toISOString(),
            });
          }
          vault.vault.run(
            "UPDATE agent_runs SET status='completed',completed_at=?,error_detail=NULL WHERE id=?",
            [new Date().toISOString(), row.request_key],
          );
        });
      } catch {
        vault.vault.run(
          "UPDATE agent_runs SET status='failed',completed_at=?,error_detail=? WHERE id=?",
          [
            new Date().toISOString(),
            'The recorded model response could not be recovered as verified proposals. No actions were applied.',
            row.request_key,
          ],
        );
      }
      await vault.persist();
    }
    await client.query('UPDATE outreachr.usage SET recovered_at=now() WHERE id=$1 AND org_id=$2', [
      row.id,
      organization.id,
    ]);
  }
}
