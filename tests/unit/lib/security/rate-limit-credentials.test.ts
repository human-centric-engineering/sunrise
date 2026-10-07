/**
 * Unit Tests: verified rate-limit credentials (#701)
 *
 * The lookups the `api-key` / `embed-token` strategies key on. The database is
 * mocked; the assertions are on the query each kind of credential sends, on
 * how many queries reach it, and on what the cache serves afterwards.
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
import { logger } from '@/lib/logging';
import {
  resetRateLimitCredentialBudget,
  resetRateLimitCredentialCache,
  resolveRateLimitCredential,
} from '@/lib/security/rate-limit-credentials';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const IP = '198.51.100.10';

// lru-cache reads its clock from `performance.now()` (captured at import) and
// memoises the reading for 1ms, so the cache TTL is driven by an offset on the
// real clock plus a short real wait for the memo to clear. Date moves with it
// so expiry arithmetic agrees.
let clockOffset = 0;
const realPerformanceNow = performance.now.bind(performance);
async function advanceClocks(ms: number): Promise<void> {
  clockOffset += ms;
  vi.setSystemTime(Date.now() + ms);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Let background re-checks settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const resolveKey = (value: string, ip = IP) => resolveRateLimitCredential('api-key', value, ip);

describe('resolveRateLimitCredential', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    vi.clearAllMocks();
    vi.spyOn(performance, 'now').mockImplementation(() => realPerformanceNow() + clockOffset);
    resetRateLimitCredentialCache();
    resetRateLimitCredentialBudget(IP);
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue(null);
  });

  describe('lookups', () => {
    it('looks a user key up by its SHA-256 hash, excluding revoked keys', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'k1',
        expiresAt: null,
      } as never);

      await expect(resolveKey('sk_abc')).resolves.toBe('sk:k1');
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledWith({
        where: { keyHash: sha256('sk_abc'), revokedAt: null },
        select: { id: true, expiresAt: true },
      });
    });

    it('refuses an expired user key and an expired MCP key', async () => {
      const past = new Date(Date.now() - 1000);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'k1',
        expiresAt: past,
      } as never);
      vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue({
        id: 'm1',
        isActive: true,
        expiresAt: past,
        orgId: null,
        org: null,
      } as never);

      await expect(resolveKey('sk_old')).resolves.toBeNull();
      await expect(resolveKey('smcp_old')).resolves.toBeNull();
    });

    it('looks an MCP key up by its SHA-256 hash and refuses an inactive one', async () => {
      vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
        id: 'm1',
        isActive: true,
        expiresAt: null,
        orgId: null,
        org: null,
      } as never);
      await expect(resolveKey('smcp_abc')).resolves.toBe('mcp:m1');
      expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledWith({
        where: { keyHash: sha256('smcp_abc') },
        select: {
          id: true,
          isActive: true,
          expiresAt: true,
          orgId: true,
          org: { select: { status: true } },
        },
      });

      vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValueOnce({
        id: 'm2',
        isActive: false,
        expiresAt: null,
        orgId: null,
        org: null,
      } as never);
      await expect(resolveKey('smcp_off')).resolves.toBeNull();
    });

    it('refuses an MCP key or embed token whose org is suspended', async () => {
      vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue({
        id: 'm1',
        isActive: true,
        expiresAt: null,
        orgId: 'cmorg_suspended',
        org: { status: 'SUSPENDED' },
      } as never);
      vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue({
        id: 't1',
        isActive: true,
        orgId: 'cmorg_suspended',
        agent: { isActive: true },
        org: { status: 'SUSPENDED' },
      } as never);

      await expect(resolveKey('smcp_suspended')).resolves.toBeNull();
      await expect(resolveRateLimitCredential('embed-token', 'tok', IP)).resolves.toBeNull();
    });

    it('does not query for a value in a format Sunrise does not issue', async () => {
      await expect(resolveKey('opaque')).resolves.toBeNull();
      expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();
      expect(prisma.mcpApiKey.findUnique).not.toHaveBeenCalled();
    });

    it('returns the embed token row id only when the token and its agent are active', async () => {
      vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValueOnce({
        id: 't1',
        isActive: true,
        orgId: null,
        agent: { isActive: true },
        org: null,
      } as never);
      await expect(resolveRateLimitCredential('embed-token', 'tok', IP)).resolves.toBe('t1');

      vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValueOnce({
        id: 't2',
        isActive: true,
        orgId: null,
        agent: { isActive: false },
        org: null,
      } as never);
      await expect(resolveRateLimitCredential('embed-token', 'tok2', IP)).resolves.toBeNull();
    });
  });

  describe('cache', () => {
    it('serves a verified key without a query, refreshes it in the background after 30s, and lets it lapse after 60s', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'k1',
        expiresAt: null,
      } as never);

      await resolveKey('sk_live');
      await expect(resolveKey('sk_live')).resolves.toBe('sk:k1');
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(1);

      // Second half of the TTL: still served, with one background re-check.
      await advanceClocks(30_001);
      await expect(resolveKey('sk_live')).resolves.toBe('sk:k1');
      await settle();
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);

      // The re-check renewed it; with no further use it lapses after 60s.
      await advanceClocks(60_001);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
      await expect(resolveKey('sk_live')).resolves.toBeNull();
    });

    it('never caches a miss', async () => {
      await resolveKey('sk_unknown');
      await resolveKey('sk_unknown');
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);
    });

    it('caches a key that expires within the TTL only until it expires, without refreshing it', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'k1',
        expiresAt: new Date(Date.now() + 20_000),
      } as never);

      await resolveKey('sk_short_lived');
      // 20s left is under the refresh mark, but a re-check could not extend it.
      await resolveKey('sk_short_lived');
      await settle();
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(1);

      await advanceClocks(20_001);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
      await expect(resolveKey('sk_short_lived')).resolves.toBeNull();
    });

    it('drops the cached entry when a background re-check finds the key gone', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
        id: 'k1',
        expiresAt: null,
      } as never);
      await resolveKey('sk_revoked_later');

      await advanceClocks(30_001);
      await resolveKey('sk_revoked_later'); // served; re-check finds nothing
      await settle();

      await expect(resolveKey('sk_revoked_later')).resolves.toBeNull();
    });

    it('re-arms an entry when its re-check fails, but not past 2x the TTL since the last good check', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
        id: 'k1',
        expiresAt: null,
      } as never);
      await resolveKey('sk_db_flaky');
      vi.mocked(prisma.aiApiKey.findFirst).mockRejectedValue(new Error('db down'));

      // t=30s: re-check fails and re-arms (to t=90s).
      await advanceClocks(30_001);
      await resolveKey('sk_db_flaky');
      await settle();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('lookup failed'),
        expect.objectContaining({ key: 'api-key', error: 'db down' })
      );

      // t=61s: past the original TTL, still served thanks to the re-arm.
      await advanceClocks(31_000);
      await expect(resolveKey('sk_db_flaky')).resolves.toBe('sk:k1');
      await settle();

      // t=121s: the last good check is over 2x TTL old, so the entry lapsed.
      await advanceClocks(60_000);
      await expect(resolveKey('sk_db_flaky')).resolves.toBeNull();
    });
  });

  describe('lookup budget and sharing', () => {
    it('spends one budget slot and one query on concurrent checks of the same cold value', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'k1',
        expiresAt: null,
      } as never);

      const results = await Promise.all([
        resolveKey('sk_busy'),
        resolveKey('sk_busy'),
        resolveKey('sk_busy'),
      ]);

      expect(results).toEqual(['sk:k1', 'sk:k1', 'sk:k1']);
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(1);
    });

    it('stops looking up cold values from one IP after 30 a minute, and keeps other IPs apart', async () => {
      for (let i = 0; i < 30; i++) await resolveKey(`sk_cold_${i}`);
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(30);

      await expect(resolveKey('sk_cold_over_budget')).resolves.toBeNull();
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(30);

      const otherIp = '198.51.100.11';
      resetRateLimitCredentialBudget(otherIp);
      await resolveKey('sk_cold_other_ip', otherIp);
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(31);
      resetRateLimitCredentialBudget(otherIp);
    });

    it('a lookup that settles after a reset does not drop the newer in-flight lookup', async () => {
      let resolveFirst: (row: unknown) => void = () => {};
      let resolveSecond: (row: unknown) => void = () => {};
      vi.mocked(prisma.aiApiKey.findFirst)
        .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)) as never)
        .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)) as never);

      const first = resolveKey('sk_reset_race');
      await settle();
      resetRateLimitCredentialCache();
      const second = resolveKey('sk_reset_race');
      await settle();
      resolveFirst({ id: 'k1', expiresAt: null });
      await first;

      // The second lookup is still pending and must still be shared.
      const third = resolveKey('sk_reset_race');
      resolveSecond({ id: 'k1', expiresAt: null });
      await expect(Promise.all([second, third])).resolves.toEqual(['sk:k1', 'sk:k1']);
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);
    });
  });
});
