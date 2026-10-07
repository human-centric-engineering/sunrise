/**
 * Unit Tests: verified rate-limit credentials (#701)
 *
 * The lookups the `api-key` / `embed-token` strategies key on. The database is
 * mocked; the assertions are on the query each kind of credential sends and on
 * what the cache does with the answer.
 *
 * @see lib/security/rate-limit-credentials.ts
 */

import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiApiKey: { findFirst: vi.fn() },
    mcpApiKey: { findUnique: vi.fn() },
    aiAgentEmbedToken: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  getCachedRateLimitCredential,
  resetRateLimitCredentialCache,
  verifyRateLimitCredential,
} from '@/lib/security/rate-limit-credentials';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('verifyRateLimitCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetRateLimitCredentialCache();
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue(null);
  });

  it('looks a user key up by its SHA-256 hash, excluding revoked keys', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1' } as never);

    await expect(verifyRateLimitCredential('api-key', 'sk_abc')).resolves.toBe('sk:k1');
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: sha256('sk_abc'), revokedAt: null },
      select: { id: true },
    });
  });

  it('looks an MCP key up by its SHA-256 hash and refuses an inactive one', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
      id: 'm1',
      isActive: true,
    } as never);
    await expect(verifyRateLimitCredential('api-key', 'smcp_abc')).resolves.toBe('mcp:m1');
    expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: sha256('smcp_abc') },
      select: { id: true, isActive: true },
    });

    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
      id: 'm2',
      isActive: false,
    } as never);
    await expect(verifyRateLimitCredential('api-key', 'smcp_off')).resolves.toBeNull();
  });

  it('does not query for a value in a format Sunrise does not issue', async () => {
    await expect(verifyRateLimitCredential('api-key', 'opaque')).resolves.toBeNull();
    expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();
    expect(prisma.mcpApiKey.findUnique).not.toHaveBeenCalled();
  });

  it('returns the embed token row id for an active token', async () => {
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue({
      id: 't1',
      isActive: true,
    } as never);
    await expect(verifyRateLimitCredential('embed-token', 'tok')).resolves.toBe('t1');
    expect(prisma.aiAgentEmbedToken.findUnique).toHaveBeenCalledWith({
      where: { token: 'tok' },
      select: { id: true, isActive: true },
    });
  });

  it('caches a verified id for 60s, per kind, and never caches a miss', async () => {
    // lru-cache reads its clock from `performance.now()`, captured at import.
    let now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1' } as never);

    await verifyRateLimitCredential('api-key', 'sk_live');
    expect(getCachedRateLimitCredential('api-key', 'sk_live')).toBe('sk:k1');
    // The same string under the other strategy is a different credential.
    expect(getCachedRateLimitCredential('embed-token', 'sk_live')).toBeUndefined();

    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    await verifyRateLimitCredential('api-key', 'sk_unknown');
    expect(getCachedRateLimitCredential('api-key', 'sk_unknown')).toBeUndefined();

    now += 60_001;
    vi.advanceTimersByTime(60_001);
    expect(getCachedRateLimitCredential('api-key', 'sk_live')).toBeUndefined();
  });
});
