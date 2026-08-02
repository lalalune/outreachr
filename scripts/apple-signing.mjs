import path from 'node:path';
import { run } from './_lib.mjs';

const PORTABLE_MAC_VARIABLES = [
  'OUTREACHR_MAC_CERTIFICATE_BASE64',
  'OUTREACHR_MAC_CERTIFICATE_PASSWORD',
  'OUTREACHR_APPLE_API_KEY_BASE64',
  'OUTREACHR_APPLE_API_KEY_ID',
  'OUTREACHR_APPLE_API_ISSUER',
  'OUTREACHR_APPLE_ID',
  'OUTREACHR_APPLE_APP_SPECIFIC_PASSWORD',
  'OUTREACHR_APPLE_TEAM_ID',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

const LOCAL_KEYCHAIN_VARIABLES = [
  'OUTREACHR_MAC_KEYCHAIN_IDENTITY',
  'OUTREACHR_APPLE_KEYCHAIN_PROFILE',
  'OUTREACHR_APPLE_KEYCHAIN',
  'CSC_NAME',
  'CSC_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
];

const API_NOTARY_ENVIRONMENT = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const APPLE_ID_NOTARY_ENVIRONMENT = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

export function assertMacSigningSourceIsExclusive(source, environment = process.env) {
  if (!['portable', 'local-keychain'].includes(source)) {
    throw new Error(`Unknown macOS signing source: ${source}`);
  }
  const conflictingNames =
    source === 'local-keychain' ? PORTABLE_MAC_VARIABLES : LOCAL_KEYCHAIN_VARIABLES;
  const configured = conflictingNames.filter((name) => hasValue(environment[name]));
  if (configured.length) {
    throw new Error(
      `${source === 'local-keychain' ? 'Local Keychain' : 'Portable certificate'} macOS signing mode is mutually exclusive; unset ${configured.join(', ')}`,
    );
  }
}

export function localKeychainSigningConfiguration(environment = process.env) {
  assertMacSigningSourceIsExclusive('local-keychain', environment);
  const identity = requiredText(environment, 'OUTREACHR_MAC_KEYCHAIN_IDENTITY');
  const expectedTeamId = requiredText(environment, 'OUTREACHR_MAC_EXPECTED_TEAM_ID');
  if (!/^[A-Z0-9]{10}$/u.test(expectedTeamId)) {
    throw new Error('OUTREACHR_MAC_EXPECTED_TEAM_ID must be an exact 10-character Apple Team ID');
  }
  const keychainProfile = requiredText(environment, 'OUTREACHR_APPLE_KEYCHAIN_PROFILE');
  const keychain = optionalText(environment, 'OUTREACHR_APPLE_KEYCHAIN');
  if (keychain && !path.isAbsolute(keychain)) {
    throw new Error('OUTREACHR_APPLE_KEYCHAIN must be an absolute Keychain path');
  }
  const identityFingerprint = /^[0-9a-f]{40}$/iu.test(identity);
  if (!identityFingerprint && !identity.startsWith('Developer ID Application: ')) {
    throw new Error(
      'OUTREACHR_MAC_KEYCHAIN_IDENTITY must be the exact Developer ID Application name or SHA-1 fingerprint',
    );
  }
  // electron-builder rejects Apple certificate type prefixes in CSC_NAME. Its
  // identity lookup accepts either the fingerprint or the remaining exact name.
  const builderIdentity = identityFingerprint
    ? identity.toUpperCase()
    : identity.slice('Developer ID Application: '.length);

  const signingEnvironment = {
    CSC_NAME: builderIdentity,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    APPLE_KEYCHAIN_PROFILE: keychainProfile,
  };
  if (keychain) {
    signingEnvironment.CSC_KEYCHAIN = keychain;
    signingEnvironment.APPLE_KEYCHAIN = keychain;
  }
  return { environment: signingEnvironment, identity, expectedTeamId, keychain };
}

export function selectDeveloperIdIdentity(output, configuredIdentity, expectedTeamId) {
  const identity = String(configuredIdentity ?? '').trim();
  if (!identity) throw new Error('A Developer ID Application identity is required');
  if (!/^[A-Z0-9]{10}$/u.test(expectedTeamId)) {
    throw new Error('The expected Apple Team ID must be exactly 10 uppercase letters or digits');
  }
  const requestedFingerprint = /^[0-9a-f]{40}$/iu.test(identity) ? identity.toUpperCase() : null;
  const matches = new Map();
  for (const line of String(output ?? '').split(/\r?\n/gu)) {
    const parsed = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/u.exec(line);
    if (!parsed) continue;
    const [, fingerprint, name] = parsed;
    if (requestedFingerprint ? fingerprint === requestedFingerprint : name === identity) {
      matches.set(fingerprint, { fingerprint, name });
    }
  }
  if (matches.size === 0) {
    throw new Error(`No valid code-signing identity exactly matched ${identity}`);
  }
  if (matches.size > 1) {
    throw new Error(
      `More than one valid code-signing identity matched ${identity}; configure its SHA-1 fingerprint instead`,
    );
  }
  const selected = [...matches.values()][0];
  if (!selected.name.startsWith('Developer ID Application: ')) {
    throw new Error(
      `Configured identity is not a Developer ID Application certificate: ${selected.name}`,
    );
  }
  const certificateTeamId = /\(([A-Z0-9]{10})\)$/u.exec(selected.name)?.[1];
  if (!certificateTeamId) {
    throw new Error(`Could not determine the Apple Team ID from identity ${selected.name}`);
  }
  if (certificateTeamId !== expectedTeamId) {
    throw new Error(
      `Developer ID identity team mismatch: expected ${expectedTeamId}, received ${certificateTeamId}`,
    );
  }
  return { ...selected, teamId: certificateTeamId };
}

export async function preflightLocalDeveloperId(configuration, options = {}) {
  const runner = options.runner ?? run;
  const args = ['find-identity', '-v', '-p', 'codesigning'];
  if (configuration.keychain) args.push(configuration.keychain);
  const result = await runner('security', args);
  const selected = selectDeveloperIdIdentity(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    configuration.identity,
    configuration.expectedTeamId,
  );
  console.log(
    `Validated local Developer ID Application identity ${selected.fingerprint} for team ${selected.teamId}.`,
  );
  return selected;
}

export function notarytoolCredentialArgs(environment) {
  const profile = optionalText(environment, 'APPLE_KEYCHAIN_PROFILE');
  const keychain = optionalText(environment, 'APPLE_KEYCHAIN');
  const apiState = groupState(environment, API_NOTARY_ENVIRONMENT);
  const appleIdState = groupState(environment, APPLE_ID_NOTARY_ENVIRONMENT);
  const configuredModes = [
    Boolean(profile || keychain),
    apiState !== 'absent',
    appleIdState !== 'absent',
  ].filter(Boolean).length;
  if (configuredModes !== 1) {
    throw new Error('Exactly one Apple notarization credential mode must be configured');
  }
  if (profile || keychain) {
    if (!profile) throw new Error('APPLE_KEYCHAIN_PROFILE is required for Keychain notarization');
    return [...(keychain ? ['--keychain', keychain] : []), '--keychain-profile', profile];
  }
  if (apiState !== 'complete') {
    if (apiState === 'partial')
      throw new Error('App Store Connect notarization credentials are partial');
    if (appleIdState !== 'complete')
      throw new Error('Apple ID notarization credentials are partial');
  }
  if (apiState === 'complete') {
    return [
      '--key',
      environment.APPLE_API_KEY,
      '--key-id',
      environment.APPLE_API_KEY_ID,
      '--issuer',
      environment.APPLE_API_ISSUER,
    ];
  }
  return [
    '--apple-id',
    environment.APPLE_ID,
    '--password',
    environment.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id',
    environment.APPLE_TEAM_ID,
  ];
}

function requiredText(environment, name) {
  const value = optionalText(environment, name);
  if (!value) throw new Error(`Required release setting ${name} is not configured`);
  return value;
}

function optionalText(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function groupState(environment, names) {
  const configured = names.filter((name) => hasValue(environment[name])).length;
  return configured === 0 ? 'absent' : configured === names.length ? 'complete' : 'partial';
}

function hasValue(value) {
  return typeof value === 'string' ? Boolean(value.trim()) : Boolean(value);
}
