#!/usr/bin/env node
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  copyTree,
  executableName,
  exists,
  hashManifest,
  normalizeSignableTree,
  readJson,
  repoRoot,
  runExecutable,
  targetTriple,
  writeJson,
} from './_lib.mjs';
import { generateThirdPartyNotices } from './generate-third-party-notices.mjs';
import { validateLegalNotices } from './validate-legal-notices.mjs';

const appRoot = path.join(repoRoot, 'apps', 'desktop');
const preserveVendorSignatures = process.argv.includes('--preserve-vendor-signatures');
const generatedRoot = path.join(appRoot, 'resources', 'generated');
const sourceResources = path.join(repoRoot, 'resources');
const appManifest = await readJson(path.join(appRoot, 'package.json'));
const agentManifestPath = path.join(repoRoot, 'packages', 'agents', 'package.json');
const agentManifest = (await exists(agentManifestPath)) ? await readJson(agentManifestPath) : null;
const packageRequires = [
  createRequire(path.join(appRoot, 'package.json')),
  ...(agentManifest ? [createRequire(agentManifestPath)] : []),
];

if (!(await exists(sourceResources))) {
  throw new Error(`Required immutable resources directory is missing: ${sourceResources}`);
}

await generateThirdPartyNotices();
await validateLegalNotices();
await fs.rm(generatedRoot, { recursive: true, force: true });
await fs.mkdir(generatedRoot, { recursive: true });
await copyTree(sourceResources, generatedRoot);
await prepareSqliteWasm();

const sidecars = [];
if (declaresDependency('@anthropic-ai/claude-agent-sdk')) {
  sidecars.push(await prepareClaude());
}
if (declaresDependency('@openai/codex-sdk')) {
  sidecars.push(await prepareCodex());
}
if (!sidecars.length) throw new Error('No declared agent sidecars were discovered');

const manifestPath = path.join(generatedRoot, 'sidecars', 'manifest.json');
await writeJson(manifestPath, {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  targetTriple: targetTriple(),
  sidecars,
});

const allResources = await hashManifest(generatedRoot, {
  exclude: ['resource-manifest.json'],
});
await writeJson(path.join(generatedRoot, 'resource-manifest.json'), {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  files: allResources,
});

console.log(
  `Prepared ${allResources.length} resource files for ${process.platform}-${process.arch}.`,
);

async function prepareClaude() {
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const sdkRoot = await resolvePackageRoot('@anthropic-ai/claude-agent-sdk');
  const packageRoot = await resolvePackageRoot(packageName, [
    createRequire(path.join(sdkRoot, 'package.json')),
  ]);
  const packageJson = await readJson(path.join(packageRoot, 'package.json'));
  const source = path.join(packageRoot, executableName('claude'));
  if (!(await exists(source)))
    throw new Error(`${packageName} does not contain ${path.basename(source)}`);
  const relativeExecutable = `sidecars/claude/${executableName('claude')}`;
  const destination = path.join(generatedRoot, ...relativeExecutable.split('/'));
  await copyTree(source, destination);
  if (process.platform !== 'win32') await fs.chmod(destination, 0o755);
  const smoke = await runExecutable(destination, ['--version'], {
    timeoutMs: 30_000,
    allowFailure: true,
  });
  if (smoke.code !== 0 || smoke.timedOut)
    throw new Error(`Claude sidecar failed --version: ${smoke.stderr}`);
  if (!preserveVendorSignatures) await normalizeSignableTree(path.dirname(destination));
  return {
    id: 'claude',
    package: packageName,
    packageVersion: packageJson.version,
    executable: relativeExecutable,
    versionOutput: `${smoke.stdout}${smoke.stderr}`.trim().slice(0, 500),
    files: await hashManifest(path.dirname(destination)),
  };
}

async function prepareSqliteWasm() {
  const packageRoot = await resolvePackageRoot('sql.js');
  const source = path.join(packageRoot, 'dist', 'sql-wasm.wasm');
  if (!(await exists(source))) throw new Error(`sql.js WASM runtime is missing at ${source}`);
  const bytes = await fs.readFile(source);
  if (!WebAssembly.validate(bytes)) throw new Error(`sql.js WASM runtime is invalid: ${source}`);
  await copyTree(source, path.join(generatedRoot, 'sql-wasm.wasm'));
}

async function prepareCodex() {
  const packageName = `@openai/codex-${process.platform}-${process.arch}`;
  const sdkRoot = await resolvePackageRoot('@openai/codex-sdk');
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
  const codexRoot = await resolvePackageRoot('@openai/codex', [sdkRequire]);
  const packageRoot = await resolvePackageRoot(packageName, [
    createRequire(path.join(codexRoot, 'package.json')),
  ]);
  const packageJson = await readJson(path.join(packageRoot, 'package.json'));
  const triple = targetTriple();
  const source = path.join(packageRoot, 'vendor', triple);
  if (!(await exists(source))) throw new Error(`${packageName} does not contain vendor/${triple}`);
  const relativeRoot = 'sidecars/codex';
  const destination = path.join(generatedRoot, ...relativeRoot.split('/'));
  await copyTree(source, destination);
  const relativeExecutable = `${relativeRoot}/bin/${executableName('codex')}`;
  const executable = path.join(generatedRoot, ...relativeExecutable.split('/'));
  if (!(await exists(executable)))
    throw new Error(`Codex sidecar executable is missing at ${executable}`);
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  const smoke = await runExecutable(executable, ['--version'], {
    timeoutMs: 30_000,
    allowFailure: true,
  });
  if (smoke.code !== 0 || smoke.timedOut)
    throw new Error(`Codex sidecar failed --version: ${smoke.stderr}`);
  if (!preserveVendorSignatures) await normalizeSignableTree(destination);
  return {
    id: 'codex',
    package: packageName,
    packageVersion: packageJson.version,
    executable: relativeExecutable,
    versionOutput: `${smoke.stdout}${smoke.stderr}`.trim().slice(0, 500),
    files: await hashManifest(destination),
  };
}

async function resolvePackageRoot(packageName, additionalRequires = []) {
  const resolvers = [...additionalRequires, ...packageRequires];
  let firstError;
  for (const resolver of resolvers) {
    // Resolve the package directory directly from Node's search paths before
    // asking for an exported entry. Packages such as @openai/codex-sdk expose
    // only an ESM "import" condition (and deliberately hide package.json), so
    // createRequire.resolve() cannot resolve either public specifier even
    // though the package is correctly installed.
    for (const searchPath of resolver.resolve.paths(packageName) ?? []) {
      const candidate = path.join(searchPath, ...packageName.split('/'));
      if (await exists(path.join(candidate, 'package.json'))) {
        return await fs.realpath(candidate);
      }
    }
    try {
      return path.dirname(resolver.resolve(`${packageName}/package.json`));
    } catch (error) {
      firstError ??= error;
    }
    try {
      let current = path.dirname(resolver.resolve(packageName));
      while (current !== path.dirname(current)) {
        if (await exists(path.join(current, 'package.json'))) return current;
        current = path.dirname(current);
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  throw new Error(
    `Dependency ${packageName} is not installed for ${process.platform}-${process.arch}. ` +
      `Ensure optional dependencies were not omitted. Original error: ${firstError?.message ?? 'not resolvable'}`,
  );
}

function declaresDependency(name) {
  return Boolean(appManifest.dependencies?.[name] || agentManifest?.dependencies?.[name]);
}
