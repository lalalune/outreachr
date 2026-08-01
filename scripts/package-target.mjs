#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { explicitlyUnsignedEnvironment, parseArgs, repoRoot, runPnpm, targetId } from './_lib.mjs';

const args = parseArgs();
const expectedPlatform = String(args.platform ?? process.platform);
const expectedArch = String(args.arch ?? process.arch);
const release = args.release === true || args.release === 'true';
const unsigned = args.unsigned === true || args.unsigned === 'true';

if (release && unsigned) throw new Error('A package cannot be both --release and --unsigned');

if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  throw new Error(
    `Refusing a non-native package: running ${process.platform}-${process.arch}, requested ${expectedPlatform}-${expectedArch}`,
  );
}

const platformFlag = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform];
if (!platformFlag) throw new Error(`Unsupported packaging platform ${process.platform}`);
const platformTargets = {
  darwin: ['dmg', 'zip'],
  win32: ['nsis'],
  linux: ['AppImage', 'deb'],
}[process.platform];
await fs.rm(path.join(repoRoot, 'apps', 'desktop', 'release'), {
  recursive: true,
  force: true,
});
await runPnpm(['prepare:resources'], { cwd: repoRoot, capture: false });
await runPnpm(['--filter', '@outreachr/desktop...', 'build'], {
  cwd: repoRoot,
  capture: false,
});

const builderArgs = [
  '--filter',
  '@outreachr/desktop',
  'exec',
  'electron-builder',
  platformFlag,
  ...platformTargets,
  `--${process.arch}`,
  '--publish',
  'never',
];
if (release && process.platform === 'darwin') builderArgs.push('--config.mac.notarize=true');
if (unsigned && process.platform === 'darwin') {
  builderArgs.push(
    '--config.mac.identity=-',
    '--config.mac.notarize=false',
    '--config.dmg.sign=false',
  );
}
const builderEnvironment = unsigned ? explicitlyUnsignedEnvironment(process.env) : process.env;
await runPnpm(builderArgs, {
  cwd: repoRoot,
  capture: false,
  env: builderEnvironment,
});

console.log(
  `Built native ${release ? 'release' : unsigned ? 'explicitly unsigned' : 'verification'} packages for ${targetId()}.`,
);
