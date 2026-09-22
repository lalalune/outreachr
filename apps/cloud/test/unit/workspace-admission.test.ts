import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { admitWorkspace } from '../../src/workspace-admission';

it('bounds same-tenant waiters without consuming or blocking other tenant admissions', async () => {
  const pool = {} as Pool;
  const release = await admitWorkspace(pool, 'slow');
  const waiting = admitWorkspace(pool, 'slow', 20);
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'workspace_busy' });
  const releaseOther = await admitWorkspace(pool, 'other');
  releaseOther();
  await rejected;
  release();
  const next = await admitWorkspace(pool, 'slow');
  next();
});

it('preserves ordered admission and rejects excess queue growth', async () => {
  const pool = {} as Pool;
  const release = await admitWorkspace(pool, 'tenant');
  const a = admitWorkspace(pool, 'tenant');
  const b = admitWorkspace(pool, 'tenant');
  const c = admitWorkspace(pool, 'tenant');
  await expect(admitWorkspace(pool, 'tenant')).rejects.toMatchObject({ code: 'workspace_busy' });
  release();
  (await a)();
  (await b)();
  (await c)();
  release(); // Idempotent cleanup cannot release a later holder.
  (await admitWorkspace(pool, 'tenant'))();
});
