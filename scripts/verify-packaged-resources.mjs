#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  copyTree,
  exists,
  normalizeCodeSignature,
  parseArgs,
  readJson,
  repoRoot,
  run,
  runExecutable,
  runWindowsPowerShell,
  sha256File,
  walkFiles,
} from './_lib.mjs';

const args = parseArgs();
const releaseDir = path.resolve(
  args['release-dir'] ?? path.join(repoRoot, 'apps', 'desktop', 'release'),
);
const appArchives = (await walkFiles(releaseDir)).filter(
  (file) => path.basename(file) === 'app.asar',
);
if (!appArchives.length) throw new Error(`No packaged app.asar was found under ${releaseDir}`);

let verified = 0;
for (const appArchive of appArchives) {
  const resourcesRoot = path.dirname(appArchive);
  const payloadRoot = path.join(resourcesRoot, 'resources');
  const manifestPath = path.join(payloadRoot, 'resource-manifest.json');
  if (!(await exists(manifestPath))) continue;
  const manifest = await readJson(manifestPath);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(
      `Packaged resource target ${manifest.platform}-${manifest.arch} does not match runner ${process.platform}-${process.arch}`,
    );
  }
  for (const relative of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    const target = path.join(resourcesRoot, relative);
    if (!(await exists(target)) || (await fs.stat(target)).size === 0) {
      throw new Error(`Packaged legal notice is missing or empty: ${target}`);
    }
  }
  const sqliteResources = (await walkFiles(payloadRoot)).filter((file) =>
    file.toLowerCase().endsWith('.sqlite'),
  );
  if (!sqliteResources.length)
    throw new Error(`No SQLite investor seed was packaged under ${payloadRoot}`);
  const wasmPath = path.join(payloadRoot, 'sql-wasm.wasm');
  if (!(await exists(wasmPath)) || !WebAssembly.validate(await fs.readFile(wasmPath))) {
    throw new Error(`A valid sql.js WASM runtime was not packaged at ${wasmPath}`);
  }
  if (!(manifest.files ?? []).some((entry) => entry.path === 'sql-wasm.wasm')) {
    throw new Error('The resource manifest does not cover sql-wasm.wasm');
  }

  for (const entry of manifest.files ?? []) {
    const target = safeResourcePath(payloadRoot, entry.path);
    if (!(await exists(target))) throw new Error(`Packaged resource is missing: ${entry.path}`);
    await verifyManifestEntry(target, entry);
  }

  const sidecarManifest = await readJson(path.join(payloadRoot, 'sidecars', 'manifest.json'));
  const expectedIds = new Set(['claude', 'codex']);
  for (const sidecar of sidecarManifest.sidecars ?? []) {
    expectedIds.delete(sidecar.id);
    const executable = safeResourcePath(payloadRoot, sidecar.executable);
    if (!(await exists(executable)))
      throw new Error(`Missing ${sidecar.id} executable at ${executable}`);
    const smoke = await runExecutable(executable, ['--version'], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (smoke.code !== 0 || smoke.timedOut) {
      throw new Error(`${sidecar.id} packaged executable failed --version: ${smoke.stderr}`);
    }
  }
  if (expectedIds.size)
    throw new Error(`Packaged sidecar manifest is missing: ${[...expectedIds].join(', ')}`);
  verified += 1;
  console.log(`Verified packaged resources at ${resourcesRoot}`);
}

async function verifyManifestEntry(target, entry) {
  const stat = await fs.stat(target);
  const digest = await sha256File(target);
  if (stat.size === entry.size && digest === entry.sha256) return;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outreachr-normalized-binary-'));
  const normalized = path.join(temporaryRoot, path.basename(target));
  try {
    await verifyEmbeddedSignature(target);
    await copyTree(target, normalized);
    if (!(await normalizeCodeSignature(normalized))) {
      throw new Error(`Packaged resource checksum mismatch: ${entry.path}`);
    }
    const normalizedStat = await fs.stat(normalized);
    const normalizedDigest = await sha256File(normalized);
    if (normalizedStat.size !== entry.size || normalizedDigest !== entry.sha256) {
      throw new Error(`Packaged signed-resource checksum mismatch: ${entry.path}`);
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyEmbeddedSignature(target) {
  if (process.platform === 'darwin') {
    await run('codesign', ['--verify', '--strict', target]);
    return;
  }
  if (process.platform === 'win32') {
    const script =
      'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ' +
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:OUTREACHR_VERIFY_EXECUTABLE; ' +
      'if ($signature.Status -ne \'Valid\') { throw "Invalid embedded Authenticode signature: $($signature.Status)" }';
    await runWindowsPowerShell(script, {
      OUTREACHR_VERIFY_EXECUTABLE: target,
    });
  }
}

if (verified !== 1) {
  throw new Error(
    `Expected exactly one native package resource root, verified ${verified} under ${releaseDir}`,
  );
}

function safeResourcePath(root, relative) {
  const target = path.resolve(root, ...String(relative).split('/'));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Unsafe packaged resource path: ${relative}`);
  }
  return target;
}
