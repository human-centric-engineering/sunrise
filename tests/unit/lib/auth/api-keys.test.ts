/**
 * Tests for `lib/auth/api-keys.ts`.
 *
 * Covers:
 *   - generateApiKey: format and uniqueness
 *   - hashApiKey: deterministic SHA-256
 *   - keyPrefix: first 8 chars
 *   - validateScopes: valid and invalid scopes
 *   - hasScope: scope checking with admin fallthrough
 */

import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  keyPrefix,
  validateScopes,
  hasScope,
} from '@/lib/auth/api-keys';

describe('generateApiKey', () => {
  it('returns a key starting with sk_', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^sk_[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1).not.toBe(key2);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-char hex hash', () => {
    const hash = hashApiKey('sk_test123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const hash1 = hashApiKey('sk_test');
    const hash2 = hashApiKey('sk_test');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different keys', () => {
    const hash1 = hashApiKey('sk_abc');
    const hash2 = hashApiKey('sk_def');
    expect(hash1).not.toBe(hash2);
  });
});

describe('keyPrefix', () => {
  it('returns first 8 characters', () => {
    expect(keyPrefix('sk_abcdef1234567890')).toBe('sk_abcde');
  });
});

describe('validateScopes', () => {
  it('accepts valid scopes', () => {
    expect(validateScopes(['chat'])).toBe(true);
    expect(validateScopes(['chat', 'analytics'])).toBe(true);
    expect(validateScopes(['admin'])).toBe(true);
    expect(validateScopes(['chat', 'analytics', 'knowledge', 'admin'])).toBe(true);
    expect(validateScopes(['webhook'])).toBe(true);
  });

  it('rejects invalid scopes', () => {
    expect(validateScopes(['invalid'])).toBe(false);
    expect(validateScopes(['chat', 'invalid'])).toBe(false);
  });
});

describe('hasScope', () => {
  it('returns true when scope is present', () => {
    expect(hasScope(['chat', 'analytics'], 'chat')).toBe(true);
  });

  it('returns false when scope is missing', () => {
    expect(hasScope(['chat'], 'analytics')).toBe(false);
  });

  it('admin scope grants access to everything', () => {
    expect(hasScope(['admin'], 'chat')).toBe(true);
    expect(hasScope(['admin'], 'analytics')).toBe(true);
    expect(hasScope(['admin'], 'knowledge')).toBe(true);
  });
});
