import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { completeOnboarding, expect, test } from './fixtures';

const execute = promisify(execFile);

test('refuses standalone MCP access while Electron owns the vault without changing its bytes', async ({
  page,
  dataDirectory,
  rendererErrors,
}) => {
  await completeOnboarding(page);
  const path = join(dataDirectory, 'outreachr.sqlite');
  const before = await readFile(path);
  await expect(
    execute(
      process.execPath,
      [
        resolve('out/main/mcp-stdio.js'),
        '--data-directory',
        dataDirectory,
        '--resource-directory',
        resolve('resources/generated'),
      ],
      { timeout: 15_000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('already open in the desktop app or standalone MCP server'),
  });
  expect(await readFile(path)).toEqual(before);
  expect((await page.evaluate(() => window.outreachr.bootstrap())).isFirstRun).toBe(false);
  expect(rendererErrors).toEqual([]);
});
