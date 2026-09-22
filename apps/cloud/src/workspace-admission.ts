/** Waits outside the connection pool so one busy workspace cannot exhaust shared connections. */
import type { Pool } from 'pg';
import { CloudError } from './errors';

type Waiter = { grant: () => void };
type Queue = { waiting: Waiter[] };
const queues = new WeakMap<Pool, Map<string, Queue>>();
const busy = () =>
  new CloudError(
    409,
    'workspace_busy',
    'This workspace is busy. Wait for the current operation to finish, then try again.',
  );

export async function admitWorkspace(
  pool: Pool,
  orgId: string,
  waitMs = 2_000,
): Promise<() => void> {
  let entries = queues.get(pool);
  if (!entries) {
    entries = new Map();
    queues.set(pool, entries);
  }
  let queue = entries.get(orgId);
  if (queue) {
    if (queue.waiting.length >= 3) throw busy();
    const current = queue;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = current.waiting.indexOf(waiter);
        if (index >= 0) current.waiting.splice(index, 1);
        reject(busy());
      }, waitMs);
      current.waiting.push(waiter);
    });
  } else {
    queue = { waiting: [] };
    entries.set(orgId, queue);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = queue.waiting.shift();
    if (next) next.grant();
    else entries.delete(orgId);
  };
}
