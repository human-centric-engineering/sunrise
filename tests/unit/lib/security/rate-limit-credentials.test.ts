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
    vi.useRealTimers();
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

  it('never marks an entry capped at the key expiry as stale', async () => {
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
      id: 'k1',
      expiresAt: new Date(Date.now() + 20_000),
    } as never);

    await verifyRateLimitCredential('api-key', 'sk_short_lived');

    // 20s left is under the 30s refresh mark, but a re-check could not extend it.
    expect(getCachedRateLimitCredential('api-key', 'sk_short_lived')).toEqual({
      id: 'sk:k1',
      stale: false,
    });
  });

  it('re-arms a failed re-check only up to the key expiry', async () => {
    // Both clocks move together here: the cache TTL (performance.now) and the
    // expiry arithmetic (Date).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const advanceBoth = async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      await advanceCacheClock(ms);
    };
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
      id: 'k1',
      expiresAt: new Date(Date.now() + 80_000),
    } as never);
    await verifyRateLimitCredential('api-key', 'sk_expiring_outage');
    await advanceBoth(30_001);
    expect(getCachedRateLimitCredential('api-key', 'sk_expiring_outage')?.stale).toBe(true);

    vi.mocked(prisma.aiApiKey.findFirst).mockRejectedValueOnce(new Error('db down'));
    await expect(verifyRateLimitCredential('api-key', 'sk_expiring_outage')).rejects.toThrow();

    // Re-armed, but only for the ~50s left before the key expires, not 60s.
    await advanceBoth(49_000);
    expect(getCachedRateLimitCredential('api-key', 'sk_expiring_outage')?.id).toBe('sk:k1');
    await advanceBoth(1_000);
    expect(getCachedRateLimitCredential('api-key', 'sk_expiring_outage')).toBeUndefined();
    vi.useRealTimers();
  });

  it('a lookup that settles after a reset does not drop the newer in-flight lookup', async () => {
    let resolveFirst: (row: unknown) => void = () => {};
    vi.mocked(prisma.aiApiKey.findFirst)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)) as never)
      .mockImplementationOnce(() => new Promise(() => {}) as never);

    const first = verifyRateLimitCredential('api-key', 'sk_reset_race');
    resetRateLimitCredentialCache();
    const second = verifyRateLimitCredential('api-key', 'sk_reset_race');
    resolveFirst({ id: 'k1', expiresAt: null });
    await first;

    // The second lookup is still pending and must still be shared.
    expect(verifyRateLimitCredential('api-key', 'sk_reset_race')).toBe(second);
    expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);
  });
});
