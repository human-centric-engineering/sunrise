/**
 * Tests for `lib/auth/api-keys.ts`.
 *
 * Covers:
 *   - generateApiKey: format and uniqueness
 *   - hashApiKey: deterministic SHA-256
 *   - keyPrefix: first 8 chars
 *   - validateScopes: valid and invalid scopes
 *   - hasScope: scope checking with admin fallthrough
 *   - resolveApiKey: missing/malformed header returns null
 *   - resolveApiKey: key not found in DB returns null
 *   - resolveApiKey: expired key returns null
 *   - resolveApiKey: valid key returns session + scopes + rateLimitRpm
 *   - resolveApiKey: key with no expiresAt does not expire
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiApiKey: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  generateApiKey,
  hashApiKey,
  keyPrefix,
  validateScopes,
  hasScope,
  resolveApiKey,
} from '@/lib/auth/api-keys';
import { NextRequest } from 'next/server';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeApiKey(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'key-1',
    userId: 'user-1',
    keyHash: 'some-hash',
    scopes: ['chat'],
    rateLimitRpm: 60,
    revokedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    user: {
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role: 'USER',
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}

function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers.authorization = authHeader;
  }
  return new NextRequest('http://localhost:3000/api/v1/test', { headers });
}

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

// ─── resolveApiKey ────────────────────────────────────────────────────────────

describe('resolveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiApiKey.update).mockResolvedValue({} as never);
  });

  it('returns null when Authorization header is absent', async () => {
    // Arrange
    const req = makeRequest();
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result).toBeNull();
    expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when Authorization header does not start with "Bearer sk_"', async () => {
    // Arrange — plain Basic auth, not a sk_ token
    const req = makeRequest('Basic dXNlcjpwYXNz');
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result).toBeNull();
    expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when Authorization starts with "Bearer " but not "Bearer sk_"', async () => {
    const req = makeRequest('Bearer someOtherToken');
    const result = await resolveApiKey(req);
    expect(result).toBeNull();
  });

  it('returns null when key is not found in the database', async () => {
    // Arrange
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    const req = makeRequest('Bearer sk_abc123');
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result).toBeNull();
  });

  it('returns null when key has expired', async () => {
    // Arrange — key with past expiry
    const expired = makeApiKey({ expiresAt: new Date(Date.now() - 1000) });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(expired as never);
    const req = makeRequest('Bearer sk_validkey');
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result).toBeNull();
  });

  it('returns session, scopes, and rateLimitRpm for a valid non-expired key', async () => {
    // Arrange
    const future = new Date(Date.now() + 86400000);
    const apiKey = makeApiKey({
      expiresAt: future,
      scopes: ['chat', 'analytics'],
      rateLimitRpm: 120,
    });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(apiKey as never);
    const rawKey = 'sk_' + 'a'.repeat(64);
    const req = makeRequest(`Bearer ${rawKey}`);
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result).not.toBeNull();
    expect(result!.scopes).toEqual(['chat', 'analytics']);
    expect(result!.rateLimitRpm).toBe(120);
    expect(result!.session.user.id).toBe('user-1');
    expect(result!.session.user.email).toBe('test@example.com');
    expect(result!.session.session.userId).toBe('user-1');
    expect(result!.session.session.id).toBe('apikey_key-1');
  });

  it('accepts a key with no expiresAt (never expires)', async () => {
    // Arrange — expiresAt is null
    const apiKey = makeApiKey({ expiresAt: null });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(apiKey as never);
    const req = makeRequest('Bearer sk_' + 'b'.repeat(64));
    // Act
    const result = await resolveApiKey(req);
    // Assert: null expiresAt means the key is valid
    expect(result).not.toBeNull();
  });

  it('fires a fire-and-forget lastUsedAt update after resolving a valid key', async () => {
    // Arrange
    const apiKey = makeApiKey();
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(apiKey as never);
    const req = makeRequest('Bearer sk_' + 'c'.repeat(64));
    // Act
    await resolveApiKey(req);
    // Wait for microtask queue to flush the fire-and-forget
    await Promise.resolve();
    // Assert
    expect(prisma.aiApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'key-1' },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    );
  });

  it('looks up key by SHA-256 hash of the raw key', async () => {
    // Arrange
    const rawKey = 'sk_abc123def456';
    const expectedHash = hashApiKey(rawKey);
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    const req = makeRequest(`Bearer ${rawKey}`);
    // Act
    await resolveApiKey(req);
    // Assert — DB is queried with the hash, never the raw key
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ keyHash: expectedHash }),
      })
    );
  });

  it('uses expiresAt as the session expiry when present', async () => {
    // Arrange
    const future = new Date(Date.now() + 3600000);
    const apiKey = makeApiKey({ expiresAt: future });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(apiKey as never);
    const req = makeRequest('Bearer sk_' + 'd'.repeat(64));
    // Act
    const result = await resolveApiKey(req);
    // Assert
    expect(result!.session.session.expiresAt).toEqual(future);
  });
});
