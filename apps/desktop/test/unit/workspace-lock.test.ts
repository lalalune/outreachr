import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorkspaceLock } from '../../src/main/workspace-lock';

describe('exclusive workspace ownership', () => {
  const directories: string[] = [];
  const releases: Array<() => void> = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (const release of releases.splice(0)) release();
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'outreachr-workspace-lock-'));
    directories.push(value);
    return value;
  }

  it('rejects a second owner, including symlink aliases, and releases cleanly', async () => {
    const root = await directory();
    const workspace = join(root, 'workspace');
    const alias = join(root, 'alias');
    const release = acquireWorkspaceLock(workspace);
    releases.push(release);
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => acquireWorkspaceLock(alias)).toThrow('already open');
    release();
    release();
    releases.push(acquireWorkspaceLock(alias));
  });

  it('prevents another process from opening the workspace and recovers a crashed owner', async () => {
    const workspace = await directory();
    const moduleUrl = pathToFileURL(resolve('src/main/workspace-lock.ts')).href;
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import { acquireWorkspaceLock } from ${JSON.stringify(moduleUrl)}; acquireWorkspaceLock(process.argv[1]); process.stdout.write('locked\\n'); setInterval(() => {}, 1000);`,
        workspace,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let errors = '';
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    const ready = await Promise.race([
      once(child.stdout!, 'data').then(([chunk]) => String(chunk)),
      once(child, 'exit').then(() => {
        throw new Error(`Lock owner exited early: ${errors}`);
      }),
    ]);
    expect(ready).toBe('locked\n');
    expect(() => acquireWorkspaceLock(workspace)).toThrow('already open');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(() => acquireWorkspaceLock(workspace)).toThrow('already open');
    // Advance the crashed owner's lease without a 30-second test delay.
    const expired = new Date(Date.now() - 60_000);
    await utimes(join(workspace, '.outreachr-vault.lock'), expired, expired);
    releases.push(acquireWorkspaceLock(workspace));
  });
});
