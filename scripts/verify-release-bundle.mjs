#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, parseArgs, readJson, repoRoot, run, walkFiles } from './_lib.mjs';

const args = parseArgs();
const root = path.resolve(args.directory ?? path.join(repoRoot, 'release-assets'));
const targets = [
  'macos-x64',
  'macos-arm64',
  'windows-x64',
  'windows-arm64',
  'linux-x64',
  'linux-arm64',
];

for (const target of targets) {
  const candidates = [path.join(root, `outreachr-${target}`), path.join(root, target)];
  let resolved;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      resolved = candidate;
      break;
    }
  }
  if (!resolved) throw new Error(`Downloaded release bundle is missing ${target}`);
  for (const required of [
    `SHA256SUMS-${target}`,
    'LICENSE',
    'NOTICE',
    `THIRD_PARTY_NOTICES-${target}.md`,
    `licenses-${target}.json`,
    `build-target-${target}.json`,
    `outreachr-${target}.cdx.json`,
    `outreachr-${target}.provenance.json`,
    `outreachr-${target}.attestation.intoto.jsonl`,
    `outreachr-${target}.attestation.intoto.jsonl.sha256`,
    `SIGNING-STATUS-${target}.json`,
  ]) {
    if (!(await exists(path.join(resolved, required))))
      throw new Error(`${target} is missing ${required}`);
  }
  await run(
    'node',
    [
      path.join(repoRoot, 'scripts', 'verify-checksums.mjs'),
      '--manifest',
      path.join(resolved, `SHA256SUMS-${target}`),
    ],
    {
      capture: false,
    },
  );
  await run(
    'node',
    [
      path.join(repoRoot, 'scripts', 'verify-checksums.mjs'),
      '--manifest',
      path.join(resolved, `outreachr-${target}.attestation.intoto.jsonl.sha256`),
    ],
    { capture: false },
  );
  const files = await walkFiles(resolved);
  const checksumName = `SHA256SUMS-${target}`;
  const attestationName = `outreachr-${target}.attestation.intoto.jsonl`;
  const attestationChecksumName = `${attestationName}.sha256`;
  const checksumLines = (await fs.readFile(path.join(resolved, checksumName), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  const covered = new Set();
  for (const line of checksumLines) {
    const match = /^[a-f0-9]{64} {2}([^/]+)$/i.exec(line);
    if (!match) throw new Error(`${target} contains an unsafe checksum subject: ${line}`);
    if (covered.has(match[1])) {
      throw new Error(`${target} checksum manifest contains duplicate subject ${match[1]}`);
    }
    covered.add(match[1]);
  }
  const expectedCovered = files
    .map((file) => path.basename(file))
    .filter(
      (name) =>
        name !== checksumName && name !== attestationName && name !== attestationChecksumName,
    );
  if (new Set(expectedCovered).size !== expectedCovered.length) {
    throw new Error(`${target} contains duplicate asset basenames`);
  }
  for (const name of expectedCovered) {
    if (!covered.has(name)) throw new Error(`${target} asset is not checksummed: ${name}`);
  }
  for (const name of covered) {
    if (!expectedCovered.includes(name)) {
      throw new Error(`${target} checksum manifest references an unexpected asset: ${name}`);
    }
  }
  const extensions = files.map((file) => path.extname(file).toLowerCase());
  const status = await readJson(path.join(resolved, `SIGNING-STATUS-${target}.json`));
  verifySigningStatus(target, status, files);
  if (
    target.startsWith('macos') &&
    (!extensions.includes('.dmg') || !extensions.includes('.zip'))
  ) {
    throw new Error(`${target} is missing DMG or ZIP distribution artifacts`);
  }
  if (target.startsWith('windows') && !extensions.includes('.exe')) {
    throw new Error(`${target} is missing its installer`);
  }
  if (
    target.startsWith('linux') &&
    (!extensions.includes('.appimage') || !extensions.includes('.deb'))
  ) {
    throw new Error(`${target} is missing AppImage or deb distribution artifacts`);
  }
}

console.log(`Verified all ${targets.length} native release bundles in ${root}`);

function verifySigningStatus(target, status, files) {
  if (status.schemaVersion !== 1 || status.target !== target) {
    throw new Error(`${target} has an invalid signing-status identity`);
  }
  if (
    !Array.isArray(status.mandatoryIntegrity) ||
    !status.mandatoryIntegrity.includes('sha256-manifest') ||
    !status.mandatoryIntegrity.includes('github-oidc-build-attestation')
  ) {
    throw new Error(`${target} signing status does not require checksums and GitHub attestations`);
  }
  const names = files.map((file) => path.basename(file));
  if (target.startsWith('macos')) {
    if (!['signed', 'unsigned'].includes(status.releaseMode)) {
      throw new Error(`${target} has invalid release mode ${status.releaseMode}`);
    }
    if (status.releaseMode === 'unsigned') {
      if (
        status.platformTrust?.codeSigning !== 'ad-hoc-only' ||
        status.platformTrust?.notarization !== 'none' ||
        !names.some((name) => name.includes('UNSIGNED-UNNOTARIZED'))
      ) {
        throw new Error(`${target} unsigned/unnotarized disclosure is incomplete`);
      }
    } else if (
      status.platformTrust?.codeSigning !== 'developer-id' ||
      status.platformTrust?.notarization !== 'apple-notarized-and-stapled' ||
      names.some((name) => name.includes('UNSIGNED'))
    ) {
      throw new Error(`${target} signed release status is inconsistent with its assets`);
    }
  } else if (target.startsWith('windows')) {
    if (!['signed', 'unsigned'].includes(status.releaseMode)) {
      throw new Error(`${target} has invalid release mode ${status.releaseMode}`);
    }
    if (status.releaseMode === 'unsigned') {
      if (
        status.platformTrust?.codeSigning !== 'none' ||
        !names.some((name) => name.includes('UNSIGNED'))
      ) {
        throw new Error(`${target} unsigned disclosure is incomplete`);
      }
    } else if (
      status.platformTrust?.codeSigning !== 'authenticode-timestamped' ||
      names.some((name) => name.includes('UNSIGNED'))
    ) {
      throw new Error(`${target} signed release status is inconsistent with its assets`);
    }
  } else if (
    status.releaseMode !== 'checksum-attested' ||
    status.platformTrust?.codeSigning !== 'none-required'
  ) {
    throw new Error(`${target} must disclose checksum-attested Linux authenticity`);
  }
  if (!status.userNotice || !status.tag?.githubVerification) {
    throw new Error(
      `${target} signing status is missing its user notice or tag verification state`,
    );
  }
}
