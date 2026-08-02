import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const separator = token.indexOf('=');
    if (separator !== -1) {
      result[token.slice(2, separator)] = token.slice(separator + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

export async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function sha256File(target) {
  const hash = createHash('sha256');
  const handle = await fs.open(target, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function walkFiles(root) {
  if (!(await exists(root))) return [];
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  }
  await visit(root);
  return output;
}

export async function copyTree(source, destination) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode);
}

/**
 * Produce byte-identical public text assets on Windows, macOS, and Linux.
 * Git checkout line-ending policy is runner-dependent unless a repository
 * explicitly overrides it, while flattened GitHub release assets must match
 * every target bundle's checksum manifest.
 */
export async function copyCanonicalText(source, destination) {
  const contents = await fs.readFile(source, 'utf8');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents.replace(/\r\n?/gu, '\n'), 'utf8');
}

export async function normalizeCodeSignature(target, platform = process.platform) {
  const kind = await executableKind(target);
  if (platform === 'darwin' && kind === 'macho') {
    const signature = await run('codesign', ['--display', '--verbose=1', target], {
      allowFailure: true,
    });
    if (signature.code === 0) {
      await run('codesign', ['--remove-signature', target]);
    }
    await canonicalizeMachOLinkedit(target);
    return true;
  }
  if (platform === 'win32' && kind === 'pe') {
    await stripPeAuthenticode(target);
    return true;
  }
  return false;
}

/**
 * Read the PE security directory without invoking PowerShell. This keeps the
 * unsigned Windows release check deterministic on hosted x64 and arm64 runners,
 * where the legacy Microsoft.PowerShell.Security module is not always loadable.
 */
export async function peAuthenticodeCertificate(target) {
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length) {
      throw new Error(`Truncated PE executable: ${target}`);
    }
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) {
      throw new Error(`Missing DOS signature in ${target}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(24);
    if ((await handle.read(peHeader, 0, peHeader.length, peOffset)).bytesRead !== peHeader.length) {
      throw new Error(`Invalid PE header offset in ${target}`);
    }
    if (!peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
      throw new Error(`Missing PE signature in ${target}`);
    }
    const optionalSize = peHeader.readUInt16LE(20);
    const optionalOffset = peOffset + 24;
    const optional = Buffer.alloc(optionalSize);
    if (
      optionalSize < 128 ||
      (await handle.read(optional, 0, optional.length, optionalOffset)).bytesRead !==
        optional.length
    ) {
      throw new Error(`Truncated PE optional header in ${target}`);
    }
    const magic = optional.readUInt16LE(0);
    const dataDirectoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (dataDirectoriesOffset === null || dataDirectoriesOffset + 40 > optional.length) {
      throw new Error(`Unsupported PE optional header in ${target}`);
    }
    const offset = optional.readUInt32LE(dataDirectoriesOffset + 32);
    const size = optional.readUInt32LE(dataDirectoriesOffset + 36);
    if (offset === 0 && size === 0) return null;
    if (offset === 0 || size < 8 || offset + size > stat.size) {
      throw new Error(`Unsafe Authenticode certificate table in ${target}`);
    }
    const header = Buffer.alloc(8);
    if ((await handle.read(header, 0, header.length, offset)).bytesRead !== header.length) {
      throw new Error(`Truncated Authenticode certificate table in ${target}`);
    }
    const length = header.readUInt32LE(0);
    const revision = header.readUInt16LE(4);
    const certificateType = header.readUInt16LE(6);
    if (length < 8 || length > size || revision !== 0x0200 || certificateType !== 0x0002) {
      throw new Error(`Invalid Authenticode WIN_CERTIFICATE header in ${target}`);
    }
    return { offset, size, length, revision, certificateType };
  } finally {
    await handle.close();
  }
}

export async function runWindowsPowerShell(script, environment = {}) {
  const failures = [];
  for (const command of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = await run(
        command,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          allowFailure: true,
          env: { ...process.env, ...environment },
        },
      );
      if (result.code === 0) return;
      failures.push(`${command}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Windows PowerShell signature verification failed:\n${failures.join('\n')}`);
}

export async function normalizeSignableTree(root, platform = process.platform) {
  let normalized = 0;
  for (const file of await walkFiles(root)) {
    if (await normalizeCodeSignature(file, platform)) normalized += 1;
  }
  return normalized;
}

export async function collectCleanupErrors(cleanups) {
  const errors = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function throwWithCleanup(primaryError, cleanupErrors, context) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `${context} failed and cleanup also failed`,
      { cause: primaryError },
    );
  }
  throw primaryError;
}

export function throwCleanupErrors(cleanupErrors, context) {
  if (cleanupErrors.length === 0) return;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, `${context} cleanup failed`, {
    cause: cleanupErrors[0],
  });
}

export function nsisUninstallArgs(installRoot) {
  if (!installRoot) throw new Error('NSIS install root is required');
  return ['/S', `_?=${installRoot}`];
}

export async function run(command, args = [], options = {}) {
  return await runSpawned(command, args, options, (spawnOptions) =>
    spawnKnownCommand(command, args, spawnOptions),
  );
}

/** Execute an already-materialized absolute binary without consulting a shell or PATH. */
export async function runExecutable(executable, args = [], options = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error(`Executable path must be absolute: ${executable}`);
  }
  const command = await fs.realpath(executable);
  const stat = await fs.stat(command);
  if (!stat.isFile()) throw new Error(`Executable path is not a file: ${command}`);
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`Executable path is not marked executable: ${command}`);
  }
  return await runSpawned(command, args, options, (spawnOptions) =>
    spawn(command, args, spawnOptions),
  );
}

async function runSpawned(command, args, options, start) {
  const {
    cwd = repoRoot,
    env = process.env,
    timeoutMs = 0,
    allowFailure = false,
    capture = true,
    sensitive = false,
  } = options;
  return await new Promise((resolve, reject) => {
    const child = start({
      cwd,
      env,
      windowsHide: true,
      // Native packaging tools such as ditto must retain true inherited handles.
      // Piping and forwarding output is not equivalent on every hosted macOS runner.
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { code: code ?? 1, signal, stdout, stderr, timedOut };
      if (!allowFailure && (result.code !== 0 || timedOut)) {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        reject(
          new Error(
            `${command} ${sensitive ? '<redacted arguments>' : args.join(' ')} failed${timedOut ? ' (timed out)' : ''} with code ${result.code}${
              details ? `\n${details}` : ''
            }`,
          ),
        );
      } else {
        resolve(result);
      }
    });
  });
}

function spawnKnownCommand(command, args, options) {
  switch (command) {
    case 'codesign':
      return spawn('codesign', args, options);
    case 'ditto':
      return spawn('ditto', args, options);
    case 'dpkg':
      return spawn('dpkg', args, options);
    case 'dpkg-deb':
      return spawn('dpkg-deb', args, options);
    case 'dpkg-query':
      return spawn('dpkg-query', args, options);
    case 'gh':
      return spawn('gh', args, options);
    case 'git':
      return spawn('git', args, options);
    case 'gpg':
      return spawn('gpg', args, options);
    case 'hdiutil':
      return spawn('hdiutil', args, options);
    case 'node':
      return spawn('node', args, options);
    case 'pnpm':
      return spawn('pnpm', args, options);
    case 'powershell.exe':
      return spawn('powershell.exe', args, options);
    case 'pwsh.exe':
      return spawn('pwsh.exe', args, options);
    case 'security':
      return spawn('security', args, options);
    case 'spctl':
      return spawn('spctl', args, options);
    case 'sudo':
      return spawn('sudo', args, options);
    case 'xcrun':
      return spawn('xcrun', args, options);
    default:
      throw new Error(`Unsupported fixed command: ${command}`);
  }
}

async function executableKind(target) {
  const handle = await fs.open(target, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 4) return 'other';
    if (header[0] === 0x4d && header[1] === 0x5a) return 'pe';
    const magic = header.readUInt32BE(0);
    if (
      new Set([
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ]).has(magic)
    ) {
      return 'macho';
    }
    return 'other';
  } finally {
    await handle.close();
  }
}

async function stripPeAuthenticode(target) {
  const handle = await fs.open(target, 'r+');
  try {
    const stat = await handle.stat();
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length) {
      throw new Error(`Truncated PE executable: ${target}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(24);
    if ((await handle.read(peHeader, 0, peHeader.length, peOffset)).bytesRead !== peHeader.length) {
      throw new Error(`Invalid PE header offset in ${target}`);
    }
    if (!peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
      throw new Error(`Missing PE signature in ${target}`);
    }
    const optionalSize = peHeader.readUInt16LE(20);
    const optionalOffset = peOffset + 24;
    const optional = Buffer.alloc(optionalSize);
    if (
      optionalSize < 128 ||
      (await handle.read(optional, 0, optional.length, optionalOffset)).bytesRead !==
        optional.length
    ) {
      throw new Error(`Truncated PE optional header in ${target}`);
    }
    const magic = optional.readUInt16LE(0);
    const dataDirectoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (dataDirectoriesOffset === null || dataDirectoriesOffset + 40 > optional.length) {
      throw new Error(`Unsupported PE optional header in ${target}`);
    }
    const checksumOffset = optionalOffset + 64;
    const securityOffset = optionalOffset + dataDirectoriesOffset + 32;
    const certificateOffset = optional.readUInt32LE(dataDirectoriesOffset + 32);
    const certificateSize = optional.readUInt32LE(dataDirectoriesOffset + 36);
    const zeroChecksum = Buffer.alloc(4);
    const zeroSecurityDirectory = Buffer.alloc(8);
    await handle.write(zeroChecksum, 0, zeroChecksum.length, checksumOffset);
    await handle.write(zeroSecurityDirectory, 0, zeroSecurityDirectory.length, securityOffset);
    if (certificateOffset === 0 && certificateSize === 0) return;
    if (
      certificateOffset < optionalOffset + optionalSize ||
      certificateSize === 0 ||
      certificateOffset + certificateSize > stat.size
    ) {
      throw new Error(`Unsafe Authenticode certificate table in ${target}`);
    }
    const trailingSize = stat.size - certificateOffset - certificateSize;
    if (trailingSize > 7)
      throw new Error(`Unexpected data follows Authenticode table in ${target}`);
    if (trailingSize > 0) {
      const trailing = Buffer.alloc(trailingSize);
      await handle.read(trailing, 0, trailing.length, certificateOffset + certificateSize);
      if (trailing.some((byte) => byte !== 0)) {
        throw new Error(`Non-padding data follows Authenticode table in ${target}`);
      }
    }
    await handle.truncate(certificateOffset);
  } finally {
    await handle.close();
  }
}

async function canonicalizeMachOLinkedit(target) {
  const handle = await fs.open(target, 'r+');
  try {
    const magicBytes = Buffer.alloc(4);
    await handle.read(magicBytes, 0, magicBytes.length, 0);
    const magic = magicBytes.toString('hex');
    const littleEndian = magic === 'cefaedfe' || magic === 'cffaedfe';
    const is64 = magic === 'cffaedfe' || magic === 'feedfacf';
    if (!littleEndian && magic !== 'feedface' && magic !== 'feedfacf') {
      throw new Error(`Fat or unsupported Mach-O sidecar cannot be normalized: ${target}`);
    }
    const readU32 = (buffer, offset) =>
      littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const writeU32 = (buffer, value, offset) =>
      littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
    const readU64 = (buffer, offset) =>
      littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
    const writeU64 = (buffer, value, offset) =>
      littleEndian
        ? buffer.writeBigUInt64LE(value, offset)
        : buffer.writeBigUInt64BE(value, offset);
    const headerSize = is64 ? 32 : 28;
    const header = Buffer.alloc(headerSize);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) {
      throw new Error(`Truncated Mach-O header in ${target}`);
    }
    const commandCount = readU32(header, 16);
    const commandsSize = readU32(header, 20);
    const commands = Buffer.alloc(commandsSize);
    if (
      (await handle.read(commands, 0, commands.length, headerSize)).bytesRead !== commands.length
    ) {
      throw new Error(`Truncated Mach-O load commands in ${target}`);
    }
    let offset = 0;
    let normalized = false;
    for (let index = 0; index < commandCount; index += 1) {
      if (offset + 8 > commands.length) throw new Error(`Invalid Mach-O commands in ${target}`);
      const command = readU32(commands, offset);
      const commandSize = readU32(commands, offset + 4);
      if (commandSize < 8 || offset + commandSize > commands.length) {
        throw new Error(`Invalid Mach-O command size in ${target}`);
      }
      const segmentCommand = is64 ? 0x19 : 0x1;
      if (command === segmentCommand && commandSize >= (is64 ? 72 : 56)) {
        const name = commands
          .subarray(offset + 8, offset + 24)
          .toString('ascii')
          .replaceAll('\0', '');
        if (name === '__LINKEDIT') {
          if (is64) {
            const fileSize = readU64(commands, offset + 48);
            const canonicalVmSize = (fileSize + 0x3fffn) & ~0x3fffn;
            writeU64(commands, canonicalVmSize, offset + 32);
          } else {
            const fileSize = readU32(commands, offset + 36);
            const canonicalVmSize = Math.ceil(fileSize / 0x4000) * 0x4000;
            writeU32(commands, canonicalVmSize, offset + 28);
          }
          normalized = true;
        }
      }
      offset += commandSize;
    }
    if (!normalized) throw new Error(`Mach-O sidecar has no __LINKEDIT segment: ${target}`);
    await handle.write(commands, 0, commands.length, headerSize);
  } finally {
    await handle.close();
  }
}

export function pnpmInvocation(
  args = [],
  platform = process.platform,
  nodeExecutable = process.execPath,
) {
  if (platform !== 'win32') return { command: 'pnpm', args };
  if (!path.win32.isAbsolute(nodeExecutable)) {
    throw new Error(`Windows Node.js executable path must be absolute: ${nodeExecutable}`);
  }
  return {
    command: nodeExecutable,
    args: [
      path.win32.join(
        path.win32.dirname(nodeExecutable),
        'node_modules',
        'corepack',
        'dist',
        'pnpm.js',
      ),
      ...args,
    ],
  };
}

export async function runPnpm(args = [], options = {}) {
  if (process.platform !== 'win32') return await run('pnpm', args, options);
  const invocation = pnpmInvocation(args);
  if (!(await exists(invocation.args[0]))) {
    throw new Error(
      `Corepack's pnpm entry point is missing at ${invocation.args[0]}; install the Node.js Corepack distribution and activate pnpm first`,
    );
  }
  return await runExecutable(invocation.command, invocation.args, options);
}

export function executableName(baseName) {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

export function targetTriple(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const triples = {
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[key];
  if (!triple) throw new Error(`Unsupported release target ${key}`);
  return triple;
}

export function targetId(platform = process.platform, arch = process.arch) {
  const platformName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
  if (!platformName || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported release target ${platform}-${arch}`);
  }
  return `${platformName}-${arch}`;
}

export function explicitlyUnsignedEnvironment(
  environment = process.env,
  platform = process.platform,
) {
  const result = { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const name of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
  ]) {
    delete result[name];
  }
  if (platform === 'darwin') {
    // Electron Builder otherwise skips even the credential-free ad-hoc identity (`-`)
    // for pull requests, leaving Apple Silicon verification bundles unlaunchable.
    result.CSC_FOR_PULL_REQUEST = 'true';
  } else {
    delete result.CSC_FOR_PULL_REQUEST;
  }
  return result;
}

export async function hashManifest(root, options = {}) {
  const exclude = new Set(options.exclude ?? []);
  const rows = [];
  for (const file of await walkFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (exclude.has(relative)) continue;
    const stat = await fs.stat(file);
    rows.push({ path: relative, sha256: await sha256File(file), size: stat.size });
  }
  return rows;
}

export async function appendGitHubEnv(name, value) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) throw new Error('GITHUB_ENV is not set');
  const delimiter = `OUTREACHR_${createHash('sha256').update(`${name}:${value.length}`).digest('hex').slice(0, 16)}`;
  await fs.appendFile(githubEnv, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

export async function packageMetadataFromPnpmStore(root = repoRoot) {
  const store = path.join(root, 'node_modules', '.pnpm');
  if (!(await exists(store)))
    throw new Error(`pnpm virtual store not found at ${store}; run pnpm install first`);
  const listing = await runPnpm(['list', '--recursive', '--json', '--depth', 'Infinity'], {
    cwd: root,
  });
  let workspaces;
  try {
    workspaces = JSON.parse(listing.stdout);
  } catch (error) {
    throw new Error('Could not parse the active pnpm dependency graph', { cause: error });
  }
  const packageDirectories = activePnpmPackageDirectories(workspaces, store);

  const packages = new Map();
  for (const packageDirectory of packageDirectories) await addPackage(packageDirectory);
  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'),
  );

  async function addPackage(packageDirectory) {
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!(await exists(manifestPath))) return;
    let manifest;
    try {
      manifest = await readJson(manifestPath);
    } catch {
      return;
    }
    if (!manifest.name || !manifest.version) return;
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) return;
    const licenseFiles = [];
    for (const entry of await fs.readdir(packageDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(licen[cs]e|copying|notice)(\..*)?$/i.test(entry.name)) continue;
      const file = path.join(packageDirectory, entry.name);
      if ((await fs.stat(file)).size <= 1024 * 1024) licenseFiles.push(file);
    }
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license:
        typeof manifest.license === 'string'
          ? manifest.license
          : Array.isArray(manifest.licenses)
            ? manifest.licenses.map((item) => item.type ?? item).join(' OR ')
            : 'UNKNOWN',
      homepage: manifest.homepage ?? null,
      repository:
        typeof manifest.repository === 'string'
          ? manifest.repository
          : (manifest.repository?.url ?? null),
      packageDirectory,
      manifestPath,
      licenseFiles: licenseFiles.sort(),
    });
  }
}

export function activePnpmPackageDirectories(workspaces, store) {
  if (!Array.isArray(workspaces)) {
    throw new Error('The active pnpm dependency graph is not a workspace array');
  }
  const packageDirectories = new Set();
  for (const workspace of workspaces) {
    collectDependencyPaths(workspace.dependencies);
    collectDependencyPaths(workspace.devDependencies);
    collectDependencyPaths(workspace.optionalDependencies);
  }
  return [...packageDirectories].sort();

  function collectDependencyPaths(dependencies) {
    if (!dependencies || typeof dependencies !== 'object') return;
    for (const dependency of Object.values(dependencies)) {
      if (!dependency || typeof dependency !== 'object') continue;
      if (typeof dependency.path === 'string') {
        const candidate = path.resolve(dependency.path);
        const relative = path.relative(store, candidate);
        if (
          relative &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        ) {
          packageDirectories.add(candidate);
        }
      }
      collectDependencyPaths(dependency.dependencies);
      collectDependencyPaths(dependency.devDependencies);
      collectDependencyPaths(dependency.optionalDependencies);
    }
  }
}
