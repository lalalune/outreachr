import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreVault } from '@outreachr/core';
import { openNodeVault } from '@outreachr/core/node';
import { ElectronSecretStoreBackend, SecureStore } from '../../src/main/secure-store';
import { FakeSecretBackend } from '../helpers/secret-backend';

describe('SecureStore', () => {
  let vault: CoreVault;
  let backend: FakeSecretBackend;
  let store: SecureStore;

  beforeEach(async () => {
    vault = await openNodeVault();
    backend = new FakeSecretBackend();
    store = new SecureStore(vault, backend);
  });

  afterEach(() => vault.close());

  it('persists only ciphertext and round-trips structured secrets', async () => {
    const secret = {
      accessToken: 'google-access-token-never-plaintext',
      refreshToken: 'google-refresh-token-never-plaintext',
      expiresAt: '2026-08-01T00:00:00.000Z',
    };

    await store.set('oauth/google/tokens', secret);

    const row = vault.one<{ ciphertext: Uint8Array }>(
      'SELECT ciphertext FROM secure_secrets WHERE key=?',
      ['oauth/google/tokens'],
    );
    expect(row).toBeDefined();
    const stored = Buffer.from(row!.ciphertext);
    expect(stored.toString('utf8')).not.toContain(secret.accessToken);
    expect(stored.toString('utf8')).not.toContain(secret.refreshToken);
    expect(Buffer.from(vault.export()).includes(Buffer.from(secret.accessToken))).toBe(false);
    await expect(store.get<typeof secret>('oauth/google/tokens')).resolves.toEqual(secret);
    expect(backend.encryptions).toBe(1);
    expect(backend.decryptions).toBe(1);
  });

  it('fails closed when the operating-system credential backend is unavailable', async () => {
    backend.available = false;
    backend.backend = 'basic_text';
    backend.reason = 'Linux basic_text is insecure';

    await expect(store.status()).resolves.toEqual({
      available: false,
      backend: 'basic_text',
      reason: 'Linux basic_text is insecure',
    });
    await expect(store.set('oauth/google/tokens', { token: 'secret' })).rejects.toThrow(
      'Linux basic_text is insecure',
    );
    expect(Number(vault.scalar('SELECT COUNT(*) FROM secure_secrets'))).toBe(0);
  });

  it('stores non-secret local preferences in SQLite without depending on the secret backend', () => {
    backend.available = false;
    backend.backend = 'basic_text';
    backend.reason = 'Linux basic_text is insecure';

    store.setPreference('agent/claude/subscription-approval', {
      approved: true,
      confirmedAt: '2026-08-01T18:00:00.000Z',
    });
    expect(store.getPreference('agent/claude/subscription-approval')).toEqual({
      approved: true,
      confirmedAt: '2026-08-01T18:00:00.000Z',
    });
    expect(Number(vault.scalar('SELECT COUNT(*) FROM local_preferences'))).toBe(1);

    store.deletePreference('agent/claude/subscription-approval');
    expect(store.getPreference('agent/claude/subscription-approval')).toBeNull();
    expect(() => store.setPreference('../escape', true)).toThrow('Invalid local-preference key');
  });

  it('fails closed on decrypt after a previously available backend becomes locked', async () => {
    await store.set('oauth/google/tokens', { accessToken: 'encrypted' });
    backend.available = false;
    backend.reason = 'Keyring is locked';

    await expect(store.get('oauth/google/tokens')).rejects.toThrow('Keyring is locked');
  });

  it('transparently re-encrypts a value when the backend requests key rotation', async () => {
    await store.set('oauth/google/tokens', { accessToken: 'rotating-token' });
    const before = Buffer.from(
      vault.one<{ ciphertext: Uint8Array }>('SELECT ciphertext FROM secure_secrets WHERE key=?', [
        'oauth/google/tokens',
      ])!.ciphertext,
    );
    backend.reEncryptNext = true;

    await expect(store.get('oauth/google/tokens')).resolves.toEqual({
      accessToken: 'rotating-token',
    });

    const after = Buffer.from(
      vault.one<{ ciphertext: Uint8Array }>('SELECT ciphertext FROM secure_secrets WHERE key=?', [
        'oauth/google/tokens',
      ])!.ciphertext,
    );
    expect(after).toEqual(before);
    expect(backend.encryptions).toBe(2);
    expect(backend.decryptions).toBe(1);
  });

  it('rejects unsafe keys, supports deletion, and treats a missing secret as null', async () => {
    await expect(store.set('../escape', 'secret')).rejects.toThrow('Invalid secure-store key');
    await expect(store.get('oauth/microsoft/tokens')).resolves.toBeNull();

    await store.set('oauth/microsoft/tokens', { token: 'encrypted' });
    store.delete('oauth/microsoft/tokens');
    await expect(store.get('oauth/microsoft/tokens')).resolves.toBeNull();
  });
});

describe('ElectronSecretStoreBackend', () => {
  const encrypted = Buffer.from('ciphertext');
  const storage = {
    decryptString: () => 'plain',
    decryptStringAsync: async () => ({ result: 'plain', shouldReEncrypt: false }),
    encryptString: () => encrypted,
    encryptStringAsync: async () => encrypted,
    getSelectedStorageBackend: () => 'gnome_libsecret' as const,
    isEncryptionAvailable: () => {
      throw new Error('availability probes must not run during bootstrap');
    },
    setUsePlainTextEncryption: () => undefined,
  };

  it('reports built-in macOS and Windows facilities without probing or unlocking them', async () => {
    await expect(new ElectronSecretStoreBackend(storage, 'darwin').status()).resolves.toEqual({
      available: true,
      backend: 'keychain',
      reason: null,
    });
    await expect(new ElectronSecretStoreBackend(storage, 'win32').status()).resolves.toEqual({
      available: true,
      backend: 'dpapi',
      reason: null,
    });
  });

  it('fails closed when Electron selects an insecure Linux credential backend', async () => {
    const linuxStorage = { ...storage, getSelectedStorageBackend: () => 'basic_text' as const };
    await expect(new ElectronSecretStoreBackend(linuxStorage, 'linux').status()).resolves.toEqual({
      available: false,
      backend: 'basic_text',
      reason: 'Linux Secret Service, GNOME Keyring, or KWallet is unavailable or locked.',
    });
  });
});
