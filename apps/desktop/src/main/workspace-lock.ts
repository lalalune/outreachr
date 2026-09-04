import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { lockSync } from 'proper-lockfile';

/** SQL.js writes whole-vault snapshots, so only one process may own a workspace. */
export function acquireWorkspaceLock(dataDirectory: string): () => void {
  mkdirSync(dataDirectory, { recursive: true });
  const directory = realpathSync(dataDirectory);
  let release: () => void;
  try {
    release = lockSync(directory, {
      lockfilePath: join(directory, '.outreachr-vault.lock'),
      realpath: true,
      stale: 30_000,
      update: 10_000,
      retries: 0,
      onCompromised: () => {
        // Do not run shutdown persistence after losing ownership: that would
        // overwrite the new owner's vault with this process's older snapshot.
        process.stderr.write('Outreachr lost its workspace lock and must restart.\n');
        process.exit(1);
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error(
        'This Outreachr workspace is already open in the desktop app or standalone MCP server. Close the other process and try again. After a crash, wait 30 seconds before retrying.',
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    release();
    released = true;
  };
}
