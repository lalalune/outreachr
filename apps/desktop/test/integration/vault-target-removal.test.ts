import { describe, expect, it } from 'vitest';
import {
  initializedVault,
  onboard,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

describe('round target deletion persistence', () => {
  it('cascades pipeline history across repeated saves and reopens the vault', async () => {
    const directory = await temporaryDirectory('target-removal');
    const service = await initializedVault(directory);
    try {
      await onboard(service);
      const investor = await service.createInvestor({
        name: 'Local Target Removal Capital',
        kind: 'micro_vc',
      });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await service.targetInvestor(investor.id, true);
        await service.moveInvestor(investor.id, 'diligence');
        const targetId = service.vault.scalar('SELECT id FROM targets WHERE firm_id=?', [
          investor.id,
        ]);
        expect(
          Number(
            service.vault.scalar('SELECT COUNT(*) FROM pipeline_events WHERE target_id=?', [
              targetId,
            ]),
          ),
        ).toBeGreaterThan(0);
        await service.targetInvestor(investor.id, false);
        expect(
          service.vault.scalar('SELECT COUNT(*) FROM pipeline_events WHERE target_id=?', [
            targetId,
          ]),
        ).toBe(0);
        expect(service.integrityCheck().ok).toBe(true);
      }
      const reopened = await initializedVault(directory);
      try {
        expect(reopened.integrityCheck().ok).toBe(true);
        expect(reopened.auditIntegrity().ok).toBe(true);
        expect(
          (await reopened.bootstrap()).investors.find((item) => item.id === investor.id)?.target,
        ).toBe(false);
      } finally {
        reopened.vault.close();
      }
    } finally {
      service.vault.close();
      await removeTemporaryDirectory(directory);
    }
  });
});
