#!/usr/bin/env node
import os from 'node:os';
import { parseArgs, targetId } from './_lib.mjs';

const args = parseArgs();
const expectedPlatform = String(args.platform ?? process.platform);
const expectedArch = String(args.arch ?? process.arch);
const rawRunnerArch = process.env.RUNNER_ARCH?.toLowerCase();
const runnerArch =
  rawRunnerArch === 'amd64' || rawRunnerArch === 'x86_64'
    ? 'x64'
    : rawRunnerArch === 'aarch64'
      ? 'arm64'
      : rawRunnerArch;

const failures = [];
if (process.platform !== expectedPlatform)
  failures.push(`Node platform is ${process.platform}, expected ${expectedPlatform}`);
if (process.arch !== expectedArch)
  failures.push(`Node architecture is ${process.arch}, expected ${expectedArch}`);
if (runnerArch && runnerArch !== expectedArch)
  failures.push(`RUNNER_ARCH is ${runnerArch}, expected ${expectedArch}`);

const report = {
  target: targetId(expectedPlatform, expectedArch),
  expected: { platform: expectedPlatform, arch: expectedArch },
  actual: {
    platform: process.platform,
    arch: process.arch,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    osRelease: os.release(),
  },
};

if (failures.length) {
  console.error(JSON.stringify({ ...report, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}
