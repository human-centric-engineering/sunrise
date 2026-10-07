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

// lru-cache reads its clock from `performance.now()` (captured at import) and
// memoises the reading for 1ms, so the cache TTL is driven by an offset on the
// real clock plus a short real wait for the memo to clear.
let clockOffset = 0;
const realPerformanceNow = performance.now.bind(performance);
async function advanceCacheClock(ms: number): Promise<void> {
  clockOffset += ms;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('verifyRateLimitCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, 'now').mockImplementation(() => realPerformanceNow() + clockOffset);
    resetRateLimitCredentialCache();
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue(null);
  });

  it('looks a user key up by its SHA-256 hash, excluding revoked keys', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1', expiresAt: null } as never);

    await expect(verifyRateLimitCredential('api-key', 'sk_abc')).resolves.toBe('sk:k1');
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: sha256('sk_abc'), revokedAt: null },
      select: { id: true, expiresAt: true },
    });
  });

  it('refuses an expired user key and an expired MCP key', async () => {
    const past = new Date(Date.now() - 1000);
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1', expiresAt: past } as never);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue({
      id: 'm1',
      isActive: true,
      expiresAt: past,
    } as never);

    await expect(verifyRateLimitCredential('api-key', 'sk_old')).resolves.toBeNull();
    await expect(verifyRateLimitCredential('api-key', 'smcp_old')).resolves.toBeNull();
  });

  it('looks an MCP key up by its SHA-256 hash and refuses an inactive one', async () => {
    const future = new Date(Date.now() + 60_000);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
      id: 'm1',
      isActive: true,
      expiresAt: future,
    } as never);
    await expect(verifyRateLimitCredential('api-key', 'smcp_abc')).resolves.toBe('mcp:m1');
    expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: sha256('smcp_abc') },
      select: { id: true, isActive: true, expiresAt: true },
    });

    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
      id: 'm2',
      isActive: false,
      expiresAt: null,
    } as never);
    await expect(verifyRateLimitCredential('api-key', 'smcp_off')).resolves.toBeNull();
  });

  it('does not query for a value in a format Sunrise does not issue', async () => {
    await expect(verifyRateLimitCredential('api-key', 'opaque')).resolves.toBeNull();
    expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();
    expect(prisma.mcpApiKey.findUnique).not.toHaveBeenCalled();
  });

  it('returns the embed token row id only when the token and its agent are active', async () => {
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValueOnce({
      id: 't1',
      isActive: true,
      agent: { isActive: true },
    } as never);
    await expect(verifyRateLimitCredential('embed-token', 'tok')).resolves.toBe('t1');
    expect(prisma.aiAgentEmbedToken.findUnique).toHaveBeenCalledWith({
      where: { token: 'tok' },
      select: { id: true, isActive: true, agent: { select: { isActive: true } } },
    });

    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValueOnce({
      id: 't2',
      isActive: true,
      agent: { isActive: false },
    } as never);
    await expect(verifyRateLimitCredential('embed-token', 'tok2')).resolves.toBeNull();
  });

  it('caches a verified id for 60s, marks it stale after 30s, and never caches a miss', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1', expiresAt: null } as never);

    await verifyRateLimitCredential('api-key', 'sk_live');
    expect(getCachedRateLimitCredential('api-key', 'sk_live')).toEqual({
      id: 'sk:k1',
      stale: false,
    });
    // The same string under the other strategy is a different credential.
    expect(getCachedRateLimitCredential('embed-token', 'sk_live')).toBeUndefined();

    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    await verifyRateLimitCredential('api-key', 'sk_unknown');
    expect(getCachedRateLimitCredential('api-key', 'sk_unknown')).toBeUndefined();

    await advanceCacheClock(30_001);
    expect(getCachedRateLimitCredential('api-key', 'sk_live')).toEqual({
      id: 'sk:k1',
      stale: true,
    });

    await advanceCacheClock(30_000);
    expect(getCachedRateLimitCredential('api-key', 'sk_live')).toBeUndefined();
  });

  it('drops the cached entry when a re-check finds the credential gone', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
      id: 'k1',
      expiresAt: null,
    } as never);
    await verifyRateLimitCredential('api-key', 'sk_revoked_later');
    expect(getCachedRateLimitCredential('api-key', 'sk_revoked_later')?.id).toBe('sk:k1');

    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce(null);
    await expect(verifyRateLimitCredential('api-key', 'sk_revoked_later')).resolves.toBeNull();
    expect(getCachedRateLimitCredential('api-key', 'sk_revoked_later')).toBeUndefined();
  });

  it('caches a key that expires within the TTL only until it expires', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
      id: 'k1',
      expiresAt: new Date(Date.now() + 10_000),
    } as never);

    await verifyRateLimitCredential('api-key', 'sk_expiring');
    expect(getCachedRateLimitCredential('api-key', 'sk_expiring')?.id).toBe('sk:k1');

    await advanceCacheClock(10_001);
    expect(getCachedRateLimitCredential('api-key', 'sk_expiring')).toBeUndefined();
  });

  it('shares one lookup between concurrent calls for the same credential', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({ id: 'k1', expiresAt: null } as never);

    const results = await Promise.all([
      verifyRateLimitCredential('api-key', 'sk_busy'),
      verifyRateLimitCredential('api-key', 'sk_busy'),
      verifyRateLimitCredential('api-key', 'sk_busy'),
    ]);

    expect(results).toEqual(['sk:k1', 'sk:k1', 'sk:k1']);
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(1);
    // Settled lookups are not reused: a later call queries again.
    await verifyRateLimitCredential('api-key', 'sk_busy');
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);
  });

  it('re-arms a cached entry when its re-check fails, and rethrows', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
      id: 'k1',
      expiresAt: null,
    } as never);
    await verifyRateLimitCredential('api-key', 'sk_db_flaky');
    await advanceCacheClock(30_001);
    expect(getCachedRateLimitCredential('api-key', 'sk_db_flaky')?.stale).toBe(true);

    vi.mocked(prisma.aiApiKey.findFirst).mockRejectedValueOnce(new Error('db down'));
    await expect(verifyRateLimitCredential('api-key', 'sk_db_flaky')).rejects.toThrow('db down');

    expect(getCachedRateLimitCredential('api-key', 'sk_db_flaky')).toEqual({
      id: 'sk:k1',
      stale: false,
    });
  });
});
