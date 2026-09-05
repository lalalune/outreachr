/** Verifies credential encryption binds ciphertext to its original session. */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialCipher, constantTimeEqual } from '../../src/sessions';

describe('session credentials', () => {
  it('rejects ciphertext copied into another session and authenticated tampering', () => {
    const cipher = new CredentialCipher(randomBytes(32).toString('base64'));
    const encrypted = cipher.encrypt('delegated-mail-credential', 'session-a');
    expect(encrypted).not.toContain('delegated-mail-credential');
    expect(cipher.decrypt(encrypted, 'session-a')).toBe('delegated-mail-credential');
    expect(() => cipher.decrypt(encrypted, 'session-b')).toThrow();
    const bytes = Buffer.from(encrypted, 'base64url');
    bytes[30] = bytes[30]! ^ 1;
    expect(() => cipher.decrypt(bytes.toString('base64url'), 'session-a')).toThrow();
  });
  it('requires a complete encryption key and compares exact state bytes', () => {
    expect(() => new CredentialCipher('invalid')).toThrow();
    expect(constantTimeEqual('expected', 'expected')).toBe(true);
    expect(constantTimeEqual('expected', 'expected-extra')).toBe(false);
    expect(constantTimeEqual('expected', 'Expected')).toBe(false);
  });
});
