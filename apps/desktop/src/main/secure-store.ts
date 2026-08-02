import { safeStorage } from 'electron';
import type { CoreVault } from '@outreachr/core';

interface AsyncSafeStorage {
  encryptStringAsync?: (value: string) => Promise<Buffer>;
  decryptStringAsync?: (
    value: Buffer,
  ) => Promise<string | { result: string; shouldReEncrypt?: boolean }>;
}

interface ElectronSafeStorage extends AsyncSafeStorage {
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
  getSelectedStorageBackend(): ReturnType<typeof safeStorage.getSelectedStorageBackend>;
}

export interface SecretStoreStatus {
  available: boolean;
  backend: string;
  reason: string | null;
}

export interface SecretStoreBackend {
  status(): Promise<SecretStoreStatus>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }>;
}

export class ElectronSecretStoreBackend implements SecretStoreBackend {
  readonly #storage: ElectronSafeStorage;
  readonly #platform: NodeJS.Platform;

  constructor(
    storage: ElectronSafeStorage = safeStorage,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#storage = storage;
    this.#platform = platform;
  }

  async status(): Promise<SecretStoreStatus> {
    const backend =
      this.#platform === 'linux'
        ? this.#storage.getSelectedStorageBackend()
        : this.#platform === 'darwin'
          ? 'keychain'
          : 'dpapi';
    if (this.#platform === 'linux' && (backend === 'basic_text' || backend === 'unknown')) {
      return {
        available: false,
        backend,
        reason: 'Linux Secret Service, GNOME Keyring, or KWallet is unavailable or locked.',
      };
    }
    return {
      // Keychain and DPAPI are built-in OS facilities. Calling either Electron
      // availability probe here can initialize the macOS encryptor and block a
      // fresh packaged app before first paint. Linux is the only platform where
      // Electron can deliberately select an insecure plaintext backend, which is
      // rejected above. Actual encryption/decryption still fails closed below.
      available: true,
      backend,
      reason: null,
    };
  }

  async encrypt(value: string): Promise<Buffer> {
    const status = await this.status();
    if (!status.available) throw new Error(status.reason ?? 'Credential encryption is unavailable');
    if (this.#storage.encryptStringAsync) return this.#storage.encryptStringAsync(value);
    return this.#storage.encryptString(value);
  }

  async decrypt(value: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }> {
    const status = await this.status();
    if (!status.available) throw new Error(status.reason ?? 'Credential decryption is unavailable');
    if (this.#storage.decryptStringAsync) {
      const result = await this.#storage.decryptStringAsync(value);
      return typeof result === 'string'
        ? { plaintext: result, shouldReEncrypt: false }
        : { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt ?? false };
    }
    return { plaintext: this.#storage.decryptString(value), shouldReEncrypt: false };
  }
}

export class SecureStore {
  #vault: () => CoreVault;
  readonly #backend: SecretStoreBackend;

  constructor(vault: CoreVault, backend: SecretStoreBackend = new ElectronSecretStoreBackend()) {
    this.#vault = () => vault;
    this.#backend = backend;
    this.#ensureTable();
  }

  /**
   * Follow a replaceable vault owner instead of retaining a database object that
   * may be closed during an authenticated backup restore.
   */
  bindVault(vault: () => CoreVault): void {
    this.#vault = vault;
    this.#ensureTable();
  }

  #ensureTable(): void {
    this.#vault().run(`CREATE TABLE IF NOT EXISTS secure_secrets (
      key TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.#vault().run(`CREATE TABLE IF NOT EXISTS local_preferences (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  status(): Promise<SecretStoreStatus> {
    return this.#backend.status();
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._:/-]{1,199}$/iu.test(key)) throw new Error('Invalid secure-store key');
    const ciphertext = await this.#backend.encrypt(JSON.stringify(value));
    this.#vault().run(
      `INSERT INTO secure_secrets(key,ciphertext,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,
      [key, ciphertext, new Date().toISOString()],
    );
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.#vault().one<{ ciphertext: Uint8Array }>(
      'SELECT ciphertext FROM secure_secrets WHERE key=?',
      [key],
    );
    if (!row) return null;
    const result = await this.#backend.decrypt(Buffer.from(row.ciphertext));
    if (result.shouldReEncrypt) await this.set(key, JSON.parse(result.plaintext) as unknown);
    return JSON.parse(result.plaintext) as T;
  }

  delete(key: string): void {
    this.#vault().run('DELETE FROM secure_secrets WHERE key=?', [key]);
  }

  /**
   * Store a non-secret, device-local preference in the same SQLite vault.
   * Preferences deliberately do not depend on Keychain/DPAPI/Secret Service,
   * so policy choices remain available even when a secret backend is locked.
   */
  setPreference(key: string, value: unknown): void {
    if (!/^[a-z0-9][a-z0-9._:/-]{1,199}$/iu.test(key))
      throw new Error('Invalid local-preference key');
    this.#vault().run(
      `INSERT INTO local_preferences(key,value_json,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      [key, JSON.stringify(value), new Date().toISOString()],
    );
  }

  getPreference<T>(key: string): T | null {
    const row = this.#vault().one<{ value_json: string }>(
      'SELECT value_json FROM local_preferences WHERE key=?',
      [key],
    );
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  deletePreference(key: string): void {
    this.#vault().run('DELETE FROM local_preferences WHERE key=?', [key]);
  }
}
