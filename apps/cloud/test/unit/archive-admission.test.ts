/** Verifies that overlapping archive work cannot multiply process memory and failures release capacity. */
import { expect, it } from 'vitest';
import { withArchiveCapacity } from '../../src/archive-admission';

it('rejects overlapping work before its allocation starts and admits work after completion', async () => {
  let finish!: () => void;
  const first = withArchiveCapacity(() => new Promise<void>((resolve) => (finish = resolve)));
  let started = false;
  await expect(
    withArchiveCapacity(async () => {
      started = true;
    }),
  ).rejects.toMatchObject({ status: 503, code: 'archive_busy' });
  expect(started).toBe(false);
  finish();
  await first;
  await expect(withArchiveCapacity(async () => 'next')).resolves.toBe('next');
});

it('releases capacity when an archive rejects', async () => {
  await expect(
    withArchiveCapacity(async () => {
      throw new Error('invalid archive');
    }),
  ).rejects.toThrow('invalid archive');
  await expect(withArchiveCapacity(async () => 'recovered')).resolves.toBe('recovered');
});
