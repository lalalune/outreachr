#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activePnpmPackageDirectories,
  collectCleanupErrors,
  copyCanonicalText,
  copyTree,
  explicitlyUnsignedEnvironment,
  nsisUninstallArgs,
  normalizeCodeSignature,
  parseArgs,
  peAuthenticodeCertificate,
  pnpmInvocation,
  repoRoot,
  run,
  runExecutable,
  sha256File,
  targetId,
  throwCleanupErrors,
  throwWithCleanup,
} from './_lib.mjs';
import {
  assertMacSigningSourceIsExclusive,
  localKeychainSigningConfiguration,
  notarytoolCredentialArgs,
  preflightLocalDeveloperId,
  selectDeveloperIdIdentity,
} from './apple-signing.mjs';
import { assessReleaseSecrets } from './validate-release-secrets.mjs';
import { verifyFuseBinary } from './verify-electron-fuses.mjs';
import { signingStatus } from './write-signing-status.mjs';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outreachr-release-script-test-'));
try {
  const virtualStore = path.join(temporaryRoot, 'node_modules', '.pnpm');
  const activePackage = path.join(virtualStore, 'active@1.0.0', 'node_modules', 'active');
  const nestedPackage = path.join(virtualStore, 'nested@1.0.0', 'node_modules', 'nested');
  assert.deepEqual(
    activePnpmPackageDirectories(
      [
        {
          dependencies: {
            active: {
              path: activePackage,
              dependencies: { nested: { path: nestedPackage } },
            },
            outside: { path: path.join(temporaryRoot, 'outside-package') },
          },
        },
      ],
      virtualStore,
    ),
    [activePackage, nestedPackage].sort(),
    'license and SBOM metadata must follow only active in-store dependencies',
  );
  assert.throws(() => activePnpmPackageDirectories({}, virtualStore), /not a workspace array/);
  const primaryFailure = new Error('primary failure');
  const cleanupFailure = new Error('cleanup failure');
  const secondCleanupFailure = new Error('second cleanup failure');
  const cleanupErrors = await collectCleanupErrors([
    async () => {},
    async () => {
      throw cleanupFailure;
    },
    async () => {
      throw secondCleanupFailure;
    },
  ]);
  assert.deepEqual(cleanupErrors, [cleanupFailure, secondCleanupFailure]);
  assert.throws(
    () => throwWithCleanup(primaryFailure, cleanupErrors, 'Test operation'),
    (error) =>
      error instanceof AggregateError &&
      error.cause === primaryFailure &&
      error.errors[0] === primaryFailure &&
      error.errors[1] === cleanupFailure,
    'cleanup failures must not mask the primary failure',
  );
  assert.throws(
    () => throwWithCleanup(primaryFailure, [], 'Test operation'),
    (error) => error === primaryFailure,
  );
  assert.doesNotThrow(() => throwCleanupErrors([], 'Test operation'));
  assert.throws(
    () => throwCleanupErrors([cleanupFailure], 'Test operation'),
    (error) => error === cleanupFailure,
  );
  assert.throws(
    () => throwCleanupErrors(cleanupErrors, 'Test operation'),
    (error) =>
      error instanceof AggregateError &&
      error.cause === cleanupFailure &&
      error.errors[1] === secondCleanupFailure,
  );
  assert.deepEqual(nsisUninstallArgs('C:\\Temp\\Outreachr install'), [
    '/S',
    '_?=C:\\Temp\\Outreachr install',
  ]);
  const payload = path.join(temporaryRoot, 'payload');
  await fs.mkdir(path.join(payload, 'nested'), { recursive: true });
  await fs.writeFile(path.join(payload, 'alpha.txt'), 'alpha\n', 'utf8');
  await fs.writeFile(path.join(payload, 'nested', 'beta.txt'), 'beta\n', 'utf8');
  assert.equal(
    await sha256File(path.join(payload, 'alpha.txt')),
    'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060',
  );
  assert.deepEqual(parseArgs(['--platform', 'linux', '--arch=arm64', 'positional']), {
    _: ['positional'],
    platform: 'linux',
    arch: 'arm64',
  });
  assert.equal(targetId('darwin', 'x64'), 'macos-x64');
  assert.equal(targetId('win32', 'arm64'), 'windows-arm64');
  assert.equal(targetId('linux', 'arm64'), 'linux-arm64');
  const localSigningInput = {
    OUTREACHR_MAC_KEYCHAIN_IDENTITY: 'Developer ID Application: Example Maintainer (ABCDE12345)',
    OUTREACHR_MAC_EXPECTED_TEAM_ID: 'ABCDE12345',
    OUTREACHR_APPLE_KEYCHAIN_PROFILE: 'outreachr-notary',
  };
  assert.deepEqual(localKeychainSigningConfiguration(localSigningInput), {
    environment: {
      CSC_NAME: 'Example Maintainer (ABCDE12345)',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      APPLE_KEYCHAIN_PROFILE: 'outreachr-notary',
    },
    identity: 'Developer ID Application: Example Maintainer (ABCDE12345)',
    expectedTeamId: 'ABCDE12345',
    keychain: undefined,
  });
  assert.equal(
    localKeychainSigningConfiguration({
      ...localSigningInput,
      OUTREACHR_MAC_KEYCHAIN_IDENTITY: '0123456789abcdef0123456789abcdef01234567',
    }).environment.CSC_NAME,
    '0123456789ABCDEF0123456789ABCDEF01234567',
  );
  const customKeychain = path.join(temporaryRoot, 'release-signing.keychain-db');
  const localSigningWithKeychain = localKeychainSigningConfiguration({
    ...localSigningInput,
    OUTREACHR_APPLE_KEYCHAIN: customKeychain,
  });
  assert.equal(localSigningWithKeychain.environment.CSC_KEYCHAIN, customKeychain);
  assert.equal(localSigningWithKeychain.environment.APPLE_KEYCHAIN, customKeychain);
  assert.throws(
    () =>
      localKeychainSigningConfiguration({
        ...localSigningInput,
        OUTREACHR_APPLE_KEYCHAIN: 'relative.keychain-db',
      }),
    /absolute Keychain path/,
  );
  assert.throws(
    () =>
      localKeychainSigningConfiguration({
        ...localSigningInput,
        OUTREACHR_MAC_CERTIFICATE_BASE64: 'portable-certificate',
      }),
    /mutually exclusive.*OUTREACHR_MAC_CERTIFICATE_BASE64/,
  );
  assert.throws(
    () =>
      assertMacSigningSourceIsExclusive('portable', {
        OUTREACHR_APPLE_KEYCHAIN_PROFILE: 'local-profile',
      }),
    /mutually exclusive.*OUTREACHR_APPLE_KEYCHAIN_PROFILE/,
  );
  const developerIdOutput =
    '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Example Maintainer (ABCDE12345)"\n' +
    '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Development: Example Maintainer (ABCDE12345)"\n' +
    '     2 valid identities found\n';
  assert.deepEqual(
    selectDeveloperIdIdentity(
      developerIdOutput,
      'Developer ID Application: Example Maintainer (ABCDE12345)',
      'ABCDE12345',
    ),
    {
      fingerprint: '0123456789ABCDEF0123456789ABCDEF01234567',
      name: 'Developer ID Application: Example Maintainer (ABCDE12345)',
      teamId: 'ABCDE12345',
    },
  );
  assert.equal(
    selectDeveloperIdIdentity(
      developerIdOutput,
      '0123456789abcdef0123456789abcdef01234567',
      'ABCDE12345',
    ).name,
    'Developer ID Application: Example Maintainer (ABCDE12345)',
  );
  assert.throws(
    () =>
      selectDeveloperIdIdentity(
        developerIdOutput,
        'Developer ID Application: Example Maintainer (ABCDE12345)',
        'ZYXWV98765',
      ),
    /team mismatch/,
  );
  assert.throws(
    () =>
      selectDeveloperIdIdentity(
        developerIdOutput,
        'Apple Development: Example Maintainer (ABCDE12345)',
        'ABCDE12345',
      ),
    /not a Developer ID Application certificate/,
  );
  let securityInvocation;
  assert.equal(
    (
      await preflightLocalDeveloperId(localSigningWithKeychain, {
        runner: async (command, commandArgs) => {
          securityInvocation = { command, commandArgs };
          return { stdout: developerIdOutput, stderr: '' };
        },
      })
    ).teamId,
    'ABCDE12345',
  );
  assert.deepEqual(securityInvocation, {
    command: 'security',
    commandArgs: ['find-identity', '-v', '-p', 'codesigning', customKeychain],
  });
  assert.deepEqual(notarytoolCredentialArgs({ APPLE_KEYCHAIN_PROFILE: 'outreachr-notary' }), [
    '--keychain-profile',
    'outreachr-notary',
  ]);
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_KEYCHAIN: customKeychain,
      APPLE_KEYCHAIN_PROFILE: 'outreachr-notary',
    }),
    ['--keychain', customKeychain, '--keychain-profile', 'outreachr-notary'],
  );
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_API_KEY: '/tmp/notary-key.p8',
      APPLE_API_KEY_ID: 'KEYID',
      APPLE_API_ISSUER: 'ISSUER',
    }),
    ['--key', '/tmp/notary-key.p8', '--key-id', 'KEYID', '--issuer', 'ISSUER'],
  );
  assert.deepEqual(
    notarytoolCredentialArgs({
      APPLE_ID: 'maintainer@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'ABCDE12345',
    }),
    ['--apple-id', 'maintainer@example.com', '--password', 'secret', '--team-id', 'ABCDE12345'],
  );
  assert.throws(
    () =>
      notarytoolCredentialArgs({
        APPLE_KEYCHAIN_PROFILE: 'outreachr-notary',
        APPLE_ID: 'maintainer@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret',
        APPLE_TEAM_ID: 'ABCDE12345',
      }),
    /Exactly one Apple notarization credential mode/,
  );
  assert.throws(
    () => notarytoolCredentialArgs({ APPLE_API_KEY: '/tmp/notary-key.p8' }),
    /credentials are partial/,
  );
  const fuseSentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
  const hardenedFuseWire = Buffer.concat([
    fuseSentinel,
    Buffer.from([1, 8, 48, 49, 48, 48, 49, 49, 0x90, 0x90]),
  ]);
  assert.equal(verifyFuseBinary(hardenedFuseWire), 1);
  const unsafeFuseWire = Buffer.from(hardenedFuseWire);
  unsafeFuseWire[fuseSentinel.length + 2] = 49;
  assert.throws(() => verifyFuseBinary(unsafeFuseWire), /RunAsNode fuse is enabled/);
  assert.deepEqual(assessReleaseSecrets({}, 'optional'), {
    policy: 'optional',
    mac: 'unsigned',
    windows: 'unsigned',
    overall: 'mixed-or-unsigned',
  });
  assert.throws(
    () => assessReleaseSecrets({ OUTREACHR_MAC_CERTIFICATE_BASE64: 'partial' }, 'optional'),
    /partially configured|partial/,
  );
  const completeReleaseSecrets = {
    OUTREACHR_MAC_CERTIFICATE_BASE64: 'certificate',
    OUTREACHR_MAC_CERTIFICATE_PASSWORD: 'password',
    OUTREACHR_MAC_EXPECTED_TEAM_ID: 'TEAM',
    OUTREACHR_APPLE_API_KEY_BASE64: 'key',
    OUTREACHR_APPLE_API_KEY_ID: 'key-id',
    OUTREACHR_APPLE_API_ISSUER: 'issuer',
    OUTREACHR_WINDOWS_CERTIFICATE_BASE64: 'certificate',
    OUTREACHR_WINDOWS_CERTIFICATE_PASSWORD: 'password',
    OUTREACHR_WINDOWS_EXPECTED_PUBLISHER: 'publisher',
  };
  assert.deepEqual(assessReleaseSecrets(completeReleaseSecrets, 'optional'), {
    policy: 'optional',
    mac: 'signed',
    windows: 'signed',
    overall: 'fully-signed',
  });
  assert.equal(
    signingStatus({
      target: 'macos-arm64',
      mode: 'unsigned',
      tagVerification: 'unsigned',
    }).platformTrust.notarization,
    'none',
  );
  assert.deepEqual(pnpmInvocation(['--filter', '@outreachr/desktop', 'build'], 'linux'), {
    command: 'pnpm',
    args: ['--filter', '@outreachr/desktop', 'build'],
  });
  assert.deepEqual(
    pnpmInvocation(
      ['--filter', '@outreachr/desktop', 'build & echo remains one argument'],
      'win32',
      'C:\\node\\node.exe',
    ),
    {
      command: 'C:\\node\\node.exe',
      args: [
        'C:\\node\\node_modules\\corepack\\dist\\pnpm.js',
        '--filter',
        '@outreachr/desktop',
        'build & echo remains one argument',
      ],
    },
  );
  assert.throws(
    () => pnpmInvocation(['build'], 'win32', 'node.exe'),
    /Windows Node\.js executable path must be absolute/,
  );
  const unsignedMacEnvironment = explicitlyUnsignedEnvironment(
    {
      CSC_FOR_PULL_REQUEST: 'false',
      CSC_LINK: 'must-not-survive',
      CSC_KEY_PASSWORD: 'must-not-survive',
      KEEP_ME: 'yes',
    },
    'darwin',
  );
  assert.equal(unsignedMacEnvironment.CSC_FOR_PULL_REQUEST, 'true');
  assert.equal(unsignedMacEnvironment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(unsignedMacEnvironment.KEEP_ME, 'yes');
  assert.equal('CSC_LINK' in unsignedMacEnvironment, false);
  assert.equal('CSC_KEY_PASSWORD' in unsignedMacEnvironment, false);
  const unsignedWindowsEnvironment = explicitlyUnsignedEnvironment(
    { CSC_FOR_PULL_REQUEST: 'true', WIN_CSC_LINK: 'must-not-survive' },
    'win32',
  );
  assert.equal('CSC_FOR_PULL_REQUEST' in unsignedWindowsEnvironment, false);
  assert.equal('WIN_CSC_LINK' in unsignedWindowsEnvironment, false);
  await assert.rejects(() => run('sh', ['-c', 'true']), /Unsupported fixed command/);
  const nodeProbe = await runExecutable(process.execPath, ['--version']);
  assert.equal(nodeProbe.code, 0);
  assert.match(nodeProbe.stdout, /^v\d+/u);
  const unsignedPe = Buffer.alloc(528);
  unsignedPe.write('MZ', 0, 'ascii');
  unsignedPe.writeUInt32LE(0x80, 0x3c);
  unsignedPe.write('PE\0\0', 0x80, 'binary');
  unsignedPe.writeUInt16LE(240, 0x80 + 20);
  unsignedPe.writeUInt16LE(0x20b, 0x80 + 24);
  const unsignedPePath = path.join(temporaryRoot, 'unsigned.exe');
  await fs.writeFile(unsignedPePath, unsignedPe);
  assert.equal(await peAuthenticodeCertificate(unsignedPePath), null);
  const signedPe = Buffer.from(unsignedPe);
  signedPe.writeUInt32LE(512, 0x80 + 24 + 112 + 32);
  signedPe.writeUInt32LE(16, 0x80 + 24 + 112 + 36);
  signedPe.writeUInt32LE(16, 512);
  signedPe.writeUInt16LE(0x0200, 516);
  signedPe.writeUInt16LE(0x0002, 518);
  const signedPePath = path.join(temporaryRoot, 'signed.exe');
  await fs.writeFile(signedPePath, signedPe);
  assert.deepEqual(await peAuthenticodeCertificate(signedPePath), {
    offset: 512,
    size: 16,
    length: 16,
    revision: 0x0200,
    certificateType: 0x0002,
  });
  const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const desktopManifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  assert.equal(
    desktopManifest.desktopName,
    'outreachr.desktop',
    'Linux packages must declare the installed desktop-entry filename',
  );
  const electronBuilderVersion = String(desktopManifest.devDependencies?.['electron-builder']);
  assert.match(
    electronBuilderVersion,
    /^\d+\.\d+\.\d+$/,
    'electron-builder must be pinned to an exact stable version',
  );
  const [builderMajor, builderMinor, builderPatch] = electronBuilderVersion.split('.').map(Number);
  assert.ok(
    builderMajor > 26 ||
      (builderMajor === 26 && (builderMinor > 15 || (builderMinor === 15 && builderPatch >= 6))),
    'electron-builder 26.15.6+ is required to prevent NSIS from dropping executable files',
  );
  const electronBuilderConfig = await fs.readFile(
    path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'),
    'utf8',
  );
  assert.match(
    electronBuilderConfig,
    /^linux:\r?\n\s+executableName: outreachr\r?\n\s+syncDesktopName: true$/m,
    'Linux packages must use the stable outreachr executable and matching desktop identity',
  );
  const packageBuildScript = String(rootManifest.scripts?.['build:packages'] ?? '');
  assert.doesNotMatch(
    packageBuildScript,
    /packages[\\/]\*\*/,
    'cold package builds must not use a path-separator-sensitive workspace filter',
  );
  for (const packageName of [
    '@outreachr/agents',
    '@outreachr/connectors',
    '@outreachr/core',
    '@outreachr/mcp',
  ]) {
    assert.ok(
      packageBuildScript.includes(`--filter ${packageName}`),
      `cold package builds must explicitly include ${packageName}`,
    );
  }
  for (const lifecycle of ['prelint', 'pretypecheck', 'pretest', 'pretest:coverage']) {
    assert.equal(
      rootManifest.scripts?.[lifecycle],
      'pnpm build:packages',
      `${lifecycle} must prepare workspace exports on a cold checkout`,
    );
  }
  const windowsLegalText = path.join(temporaryRoot, 'windows-legal.txt');
  const canonicalLegalText = path.join(temporaryRoot, 'canonical-legal.txt');
  await fs.writeFile(windowsLegalText, 'first line\r\nsecond line\r\n', 'utf8');
  await copyCanonicalText(windowsLegalText, canonicalLegalText);
  assert.equal(
    await fs.readFile(canonicalLegalText, 'utf8'),
    'first line\nsecond line\n',
    'public legal assets must be byte-identical across checkout line-ending policies',
  );
  const nativeReleaseMatrix = [
    ['macos-x64', 'macos-15-intel'],
    ['macos-arm64', 'macos-15'],
    ['windows-x64', 'windows-2025'],
    ['windows-arm64', 'windows-11-arm'],
    ['linux-x64', 'ubuntu-24.04'],
    ['linux-arm64', 'ubuntu-24.04-arm'],
  ];
  for (const workflowName of ['verify.yml', 'release.yml', 'codeql.yml']) {
    const workflow = await fs.readFile(
      path.join(repoRoot, '.github', 'workflows', workflowName),
      'utf8',
    );
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map(
      ([, reference]) => reference,
    );
    assert.ok(actionReferences.length > 0, `${workflowName} must declare external actions`);
    for (const reference of actionReferences) {
      assert.match(
        reference,
        /^[a-f0-9]{40}$/,
        `${workflowName} action references must be pinned to full commit SHAs`,
      );
    }
  }
  for (const workflowName of ['verify.yml', 'release.yml']) {
    const workflow = await fs.readFile(
      path.join(repoRoot, '.github', 'workflows', workflowName),
      'utf8',
    );
    const configuredMatrix = [
      ...workflow.matchAll(/^\s+- target: ([\w-]+)\r?\n\s+runner: ([\w.-]+)/gm),
    ].map(([, target, runner]) => [target, runner]);
    assert.deepEqual(
      configuredMatrix,
      nativeReleaseMatrix,
      `${workflowName} must use the supported six-target native runner matrix`,
    );
    assert.doesNotMatch(
      workflow,
      /windows-11-vs2026-arm/,
      `${workflowName} must not depend on the VS2026 preview runner`,
    );
  }
  const releaseChecklist = await fs.readFile(
    path.join(repoRoot, '.github', 'RELEASE_CHECKLIST.md'),
    'utf8',
  );
  const releaseWorkflow = await fs.readFile(
    path.join(repoRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const verifyWorkflow = await fs.readFile(
    path.join(repoRoot, '.github', 'workflows', 'verify.yml'),
    'utf8',
  );
  assert.match(
    verifyWorkflow,
    /verify-complete:[\s\S]*?needs: \[native-verify, quality-security, attest-verified-builds\]/,
    'the stable branch-protection check must wait for every push attestation',
  );
  assert.match(
    releaseWorkflow,
    /verify-attestations\.mjs[^\r\n]*--source-digest "\$GITHUB_SHA"/,
    'release attestation verification must bind the protected tag to its exact source commit',
  );
  assert.match(
    releaseWorkflow,
    /for \(const requiredCheck of \['All native targets', 'JavaScript and TypeScript'\]\)/,
    'release preflight must require both exact hosted check-run contexts on protected main',
  );
  assert.match(
    releaseWorkflow,
    /release\.data\.immutable !== true/,
    'release publication must fail closed unless GitHub reports an immutable public release',
  );
  assert.match(
    releaseWorkflow,
    /verify-published-assets\.mjs --expected publish-assets --actual downloaded-public-assets/,
    'release publication must compare the immutable public assets byte-for-byte',
  );
  assert.match(
    releaseChecklist,
    /Windows arm64 on `windows-11-arm`/,
    'the maintainer release checklist must name the supported Windows arm64 runner',
  );
  assert.doesNotMatch(
    releaseChecklist,
    /windows-11-vs2026-arm/,
    'the maintainer release checklist must not recommend the VS2026 preview runner',
  );
  assert.match(
    releaseChecklist,
    /CodeQL check context \*\*JavaScript and TypeScript\*\*/,
    'the maintainer release checklist must name the exact CodeQL check-run context',
  );
  const seedManifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'resources', 'seed-manifest.json'), 'utf8'),
  );
  const sqliteResources = (await fs.readdir(path.join(repoRoot, 'resources')))
    .filter((name) => name.endsWith('.sqlite'))
    .sort();
  assert.deepEqual(
    sqliteResources,
    [seedManifest.artifact],
    'resources must contain exactly the seed database named by its manifest',
  );
  assert.equal(
    await sha256File(path.join(repoRoot, 'resources', seedManifest.artifact)),
    seedManifest.fileSha256,
    'the repository seed bytes must match the pinned manifest digest',
  );
  const syntheticPePath = path.join(temporaryRoot, 'signed.exe');
  const syntheticPe = Buffer.alloc(0x280, 0);
  syntheticPe.write('MZ', 0, 'ascii');
  syntheticPe.writeUInt32LE(0x80, 0x3c);
  syntheticPe.write('PE\0\0', 0x80, 'binary');
  syntheticPe.writeUInt16LE(0xf0, 0x80 + 20);
  syntheticPe.writeUInt16LE(0x20b, 0x98);
  syntheticPe.writeUInt32LE(0x12345678, 0x98 + 64);
  syntheticPe.writeUInt32LE(0x200, 0x98 + 112 + 32);
  syntheticPe.writeUInt32LE(0x80, 0x98 + 112 + 36);
  syntheticPe.fill(0xa5, 0x200);
  await fs.writeFile(syntheticPePath, syntheticPe);
  assert.equal(await normalizeCodeSignature(syntheticPePath, 'win32'), true);
  const normalizedPe = await fs.readFile(syntheticPePath);
  assert.equal(normalizedPe.length, 0x200);
  assert.equal(normalizedPe.readUInt32LE(0x98 + 64), 0);
  assert.equal(normalizedPe.readUInt32LE(0x98 + 112 + 32), 0);
  assert.equal(normalizedPe.readUInt32LE(0x98 + 112 + 36), 0);

  const generate = path.join(repoRoot, 'scripts', 'generate-checksums.mjs');
  const verify = path.join(repoRoot, 'scripts', 'verify-checksums.mjs');
  await run('node', [generate, '--directory', payload]);
  await run('node', [verify, '--manifest', path.join(payload, 'SHA256SUMS')]);

  await fs.writeFile(path.join(payload, 'alpha.txt'), 'tampered\n', 'utf8');
  const tamperResult = await run('node', [verify, '--manifest', path.join(payload, 'SHA256SUMS')], {
    allowFailure: true,
  });
  assert.notEqual(tamperResult.code, 0, 'tampered artifact must fail checksum verification');

  const unsafeManifest = path.join(temporaryRoot, 'unsafe-sums');
  await fs.writeFile(unsafeManifest, `${'0'.repeat(64)}  ../outside\n`, 'utf8');
  const traversalResult = await run('node', [verify, '--manifest', unsafeManifest], {
    allowFailure: true,
  });
  assert.notEqual(
    traversalResult.code,
    0,
    'path traversal in a checksum manifest must be rejected',
  );

  const targets = nativeReleaseMatrix.map(([target]) => target);
  const releaseAssets = path.join(temporaryRoot, 'release-assets');
  const attestationSource = path.join(temporaryRoot, 'attestation.jsonl');
  await fs.writeFile(attestationSource, '{"test":"attestation"}\n', 'utf8');
  for (const target of targets) {
    const bundle = path.join(releaseAssets, `outreachr-${target}`);
    await fs.mkdir(bundle, { recursive: true });
    const required = {
      LICENSE: 'test license\n',
      NOTICE: 'test notice\n',
      [`THIRD_PARTY_NOTICES-${target}.md`]: '# Test notices\n',
      [`licenses-${target}.json`]: '{}\n',
      [`build-target-${target}.json`]: '{}\n',
      [`outreachr-${target}.cdx.json`]: '{}\n',
      [`outreachr-${target}.provenance.json`]: '{}\n',
      ...distributionFixtures(target),
    };
    for (const [name, contents] of Object.entries(required)) {
      await fs.writeFile(path.join(bundle, name), contents, 'utf8');
    }
    const releaseMode = target.startsWith('linux') ? 'checksum-attested' : 'unsigned';
    await fs.writeFile(
      path.join(bundle, `SIGNING-STATUS-${target}.json`),
      `${JSON.stringify(
        signingStatus({
          target,
          mode: releaseMode,
          tagVerification: 'unsigned',
          tagVerificationReason: 'unsigned',
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );
    await run('node', [
      generate,
      '--directory',
      bundle,
      '--output',
      path.join(bundle, `SHA256SUMS-${target}`),
    ]);
    await run(
      'node',
      [
        path.join(repoRoot, 'scripts', 'copy-attestation.mjs'),
        '--output',
        path.join(bundle, `outreachr-${target}.attestation.intoto.jsonl`),
      ],
      { env: { ...process.env, ATTESTATION_BUNDLE: attestationSource } },
    );
  }

  const verifyBundles = path.join(repoRoot, 'scripts', 'verify-release-bundle.mjs');
  const stageBundles = path.join(repoRoot, 'scripts', 'stage-publish-assets.mjs');
  const stagedAssets = path.join(temporaryRoot, 'publish-assets');
  await run('node', [verifyBundles, '--directory', releaseAssets]);
  await run('node', [stageBundles, '--input', releaseAssets, '--output', stagedAssets]);
  assert.equal(await fs.readFile(path.join(stagedAssets, 'NOTICE'), 'utf8'), 'test notice\n');
  assert.match(await fs.readFile(path.join(stagedAssets, 'RELEASE-TRUST.md'), 'utf8'), /UNSIGNED/);
  const downloadedAssets = path.join(temporaryRoot, 'downloaded-publish-assets');
  await copyTree(stagedAssets, downloadedAssets);
  const verifyPublishedAssets = path.join(repoRoot, 'scripts', 'verify-published-assets.mjs');
  await run('node', [
    verifyPublishedAssets,
    '--expected',
    stagedAssets,
    '--actual',
    downloadedAssets,
  ]);
  await fs.writeFile(path.join(downloadedAssets, 'NOTICE'), 'tampered draft asset\n', 'utf8');
  const draftTamperResult = await run(
    'node',
    [verifyPublishedAssets, '--expected', stagedAssets, '--actual', downloadedAssets],
    { allowFailure: true },
  );
  assert.notEqual(draftTamperResult.code, 0, 'tampered draft-release asset must be rejected');

  const firstBundle = path.join(releaseAssets, 'outreachr-macos-x64');
  const unattested = path.join(firstBundle, 'unattested-extra.txt');
  await fs.writeFile(unattested, 'must fail closed\n', 'utf8');
  const unattestedResult = await run('node', [verifyBundles, '--directory', releaseAssets], {
    allowFailure: true,
  });
  assert.notEqual(unattestedResult.code, 0, 'an unchecksummed release asset must be rejected');
  await fs.rm(unattested, { force: true });

  const firstChecksum = path.join(firstBundle, 'SHA256SUMS-macos-x64');
  const originalChecksums = await fs.readFile(firstChecksum, 'utf8');
  await fs.appendFile(firstChecksum, originalChecksums.split(/\r?\n/)[0] + '\n', 'utf8');
  const duplicateResult = await run('node', [verifyBundles, '--directory', releaseAssets], {
    allowFailure: true,
  });
  assert.notEqual(duplicateResult.code, 0, 'duplicate checksum subjects must be rejected');
  await fs.writeFile(firstChecksum, originalChecksums, 'utf8');

  const collisionRoot = path.join(temporaryRoot, 'collision-release');
  const collisionExtension =
    process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '.exe' : '.AppImage';
  for (const directory of ['one', 'two']) {
    await fs.mkdir(path.join(collisionRoot, directory), { recursive: true });
    await fs.writeFile(
      path.join(collisionRoot, directory, `Outreachr-collision${collisionExtension}`),
      directory,
      'utf8',
    );
  }
  const collisionResult = await run(
    'node',
    [
      path.join(repoRoot, 'scripts', 'collect-release-artifacts.mjs'),
      '--release-dir',
      collisionRoot,
      '--target',
      targetId(),
      '--output',
      path.join(temporaryRoot, 'collision-output'),
    ],
    { allowFailure: true },
  );
  assert.notEqual(collisionResult.code, 0, 'artifact basename collisions must be rejected');

  console.log(
    'Release-script self-test passed: command portability, cleanup-error preservation, deterministic NSIS uninstall, active dependency metadata, Electron fuse enforcement, optional/partial signing policy, trust disclosures, pinned seed integrity, checksums, tamper/path safety, all six release bundles, complete attestation coverage, draft-asset comparison, and collision rejection.',
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

function distributionFixtures(target) {
  if (target.startsWith('macos')) {
    return {
      [`Outreachr-test-${target}-UNSIGNED-UNNOTARIZED.dmg`]: 'dmg\n',
      [`Outreachr-test-${target}-UNSIGNED-UNNOTARIZED.zip`]: 'zip\n',
    };
  }
  if (target.startsWith('windows')) {
    return { [`Outreachr-test-${target}-UNSIGNED.exe`]: 'exe\n' };
  }
  return {
    [`Outreachr-test-${target}.AppImage`]: 'appimage\n',
    [`Outreachr-test-${target}.deb`]: 'deb\n',
  };
}
