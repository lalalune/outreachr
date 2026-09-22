/** Bounds memory-heavy archive transformations across all workspaces in one server process. */
import { CloudError } from './errors';

let active = false;

export async function withArchiveCapacity<T>(work: () => Promise<T>): Promise<T> {
  if (active)
    throw new CloudError(
      503,
      'archive_busy',
      'Another workspace archive is being processed. Wait for it to finish, then try again.',
    );
  active = true;
  try {
    return await work();
  } finally {
    active = false;
  }
}
