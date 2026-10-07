/**
 * Unit Tests: Rate-Limit Middleware Dispatcher (applyRateLimit)
 *
 * Tests the middleware dispatcher that runs on every API request:
 * - Bypass flag handling (RATE_LIMIT_BYPASS env var)
 * - No-rule path (non-API routes, skip predicates)
 * - Limiter pass-through (happy path)
 * - Limiter exhaustion → 429 with correct headers and envelope
 * - Key-strategy resolution (ip, session-user, api-key, embed-token)
 *
 * IMPORTANT: tests/setup.ts sets RATE_LIMIT_BYPASS=true globally.
 * This file's beforeEach clears that flag so the dispatcher runs for real.
 * The real RATE_LIMIT_TIERS registry is used (NOT mocked) to verify that
 * the actual bucket is exhausted — asserting a spy call would prove nothing
 * about limit enforcement.
 *
 * @see lib/security/rate-limit-middleware.ts
 * @see lib/security/rate-limit-policy.ts
 * @see lib/security/rate-limit.ts
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { applyRateLimit } from '@/lib/security/rate-limit-middleware';
import { RATE_LIMIT_TIERS } from '@/lib/security/rate-limit';
import { parseJSON } from '@/tests/helpers/assertions';
import { createMockSession } from '@/tests/types/mocks';

// ─── Mock @/lib/auth/config ──────────────────────────────────────────────────
// Drive auth.api.getSession per-test: success, null, throw.
// The real rate-limit registry and policy table are NOT mocked (see plan #brittle).
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// ─── Mock @/lib/logging ──────────────────────────────────────────────────────
// The dispatcher logs in two places worth asserting:
// - logger.warn when a policy rule's tier isn't in RATE_LIMIT_TIERS (config drift)
// - logger.error when RATE_LIMIT_BYPASS is on in production (misconfiguration)
// Both are silent failure modes by default; the tests below assert the log
// actually fires.
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock @/lib/security/rate-limit-policy (partial) ────────────────────────
// Used ONLY in tests #4 (skip predicate) and #13 (api-key).
// importOriginal preserves the real policy table so all other tests work normally.
vi.mock('@/lib/security/rate-limit-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit-policy')>();
  return {
    ...actual,
    findRateLimitRule: vi.fn(actual.findRateLimitRule),
  };
});

// ─── Mock @/lib/db/client ────────────────────────────────────────────────────
// The api-key and embed-token strategies look the presented credential up
// before giving it its own bucket (#701). Each test decides which values exist.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiApiKey: { findFirst: vi.fn() },
    mcpApiKey: { findUnique: vi.fn() },
    aiAgentEmbedToken: { findUnique: vi.fn() },
  },
}));

import { auth } from '@/lib/auth/config';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { findRateLimitRule, type RateLimitRule } from '@/lib/security/rate-limit-policy';
import { resetRateLimitCredentialCache } from '@/lib/security/rate-limit-credentials';

// ─── Real findRateLimitRule reference ────────────────────────────────────────
// Captured via vi.importActual in beforeAll so we can restore the real
// implementation in beforeEach after vi.clearAllMocks() wipes it.
let realFindRateLimitRule: (
  pathname: string,
  policy?: readonly RateLimitRule[]
) => RateLimitRule | null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a unique user ID per test to avoid bucket contamination. */
function uniqueUserId(): string {
  return `user_mw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a NextRequest with optional header overrides. */
function makeRequest(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

/**
 * Exhaust a rate-limit bucket by making `count` requests.
 * Returns the response from the LAST request (useful for the exhaustion-point request).
 */
async function exhaust(
  path: string,
  count: number,
  headers: Record<string, string> = {}
): Promise<Response | null> {
  let last: Response | null = null;
  for (let i = 0; i < count; i++) {
    last = await applyRateLimit(makeRequest(path, headers));
  }
  return last;
}

// lru-cache reads its clock from `performance.now()` (captured at import) and
// memoises the reading for 1ms, so the cache TTL is driven by an offset on the
// real clock plus a short real wait for the memo to clear.
let clockOffset = 0;
const realPerformanceNow = performance.now.bind(performance);
async function advanceCacheClock(ms: number): Promise<void> {
  clockOffset += ms;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('applyRateLimit', () => {
  beforeAll(async () => {
    // Capture the real findRateLimitRule from the actual module so we can
    // restore it in beforeEach after vi.clearAllMocks() wipes the mock impl.
    const actual = await vi.importActual<typeof import('@/lib/security/rate-limit-policy')>(
      '@/lib/security/rate-limit-policy'
    );
    realFindRateLimitRule = actual.findRateLimitRule;
  });

  beforeEach(() => {
    // CRITICAL: tests/setup.ts sets RATE_LIMIT_BYPASS=true globally.
    // Clear it here so the dispatcher runs for real in every test.
    // Vitest auto-restores vi.stubEnv after each test.
    vi.stubEnv('RATE_LIMIT_BYPASS', '');

    // Reset the mock so every test starts with getSession returning null
    // (tests that need a session override it inline).
    vi.clearAllMocks();
    vi.spyOn(performance, 'now').mockImplementation(() => realPerformanceNow() + clockOffset);

    // Re-wire findRateLimitRule to the real implementation by default.
    // The real function was captured by the mock factory above.
    // Tests that need a synthetic rule override this inline.
    vi.mocked(findRateLimitRule).mockImplementation(realFindRateLimitRule);

    // Default: no session (tests override as needed)
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    // Default: no presented credential exists; verified ids start uncached.
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue(null);
    resetRateLimitCredentialCache();
  });

  // ─── Bypass behaviour (2 tests) ──────────────────────────────────────────

  describe('bypass behaviour', () => {
    it('returns null when RATE_LIMIT_BYPASS=true', async () => {
      // Arrange: override what beforeEach set — enable bypass
      vi.stubEnv('RATE_LIMIT_BYPASS', 'true');
      const request = makeRequest('/api/v1/admin/users');

      // Act
      const result = await applyRateLimit(request);

      // Assert: the dispatcher short-circuits before any limiter check
      expect(result).toBeNull();
    });

    it('returns null when RATE_LIMIT_BYPASS=1 (alternative truthy form)', async () => {
      // Arrange: alternative form documented in the source
      vi.stubEnv('RATE_LIMIT_BYPASS', '1');
      const request = makeRequest('/api/v1/admin/users');

      // Act
      const result = await applyRateLimit(request);

      // Assert: both truthy forms must work — the source explicitly checks both
      expect(result).toBeNull();
    });
  });

  // ─── No-rule path (2 tests) ──────────────────────────────────────────────

  describe('no-rule path', () => {
    it('returns null for a non-API path (no rule matches)', async () => {
      // Arrange: /admin/users is a page route — no /api prefix,
      // so no RATE_LIMIT_POLICY rule applies.
      const request = makeRequest('/admin/users');

      // Act
      const result = await applyRateLimit(request);

      // Assert: the dispatcher must not rate-limit non-API paths
      expect(result).toBeNull();
    });

    it('returns null when the skip predicate returns true', async () => {
      // Arrange: inject a synthetic rule with skip: () => true.
      // Using importActual would be circular here; instead we inject via the mock.
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test\//,
        tier: 'api',
        key: 'ip',
        skip: () => true,
      });
      const request = makeRequest('/api/v1/test/foo');

      // Act
      const result = await applyRateLimit(request);

      // Assert: skip predicate returning true → pass-through, no bucket consumed
      expect(result).toBeNull();
    });
  });

  // #685: the unknown-tier warning logs the path; a credential in a dynamic
  // segment must not reach the log through it.
  it('logs an unknown tier with the path collapsed', async () => {
    const token = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    vi.mocked(findRateLimitRule).mockReturnValue({
      match: /^\/api\/v1\/test\//,
      // A tier no one registered — the branch the type system normally prevents.
      tier: 'no-such-tier',
      key: 'ip',
    });

    const result = await applyRateLimit(makeRequest(`/api/v1/test/${token}`));

    expect(result).toBeNull();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Rate-limit policy references an unknown tier; skipping limiter',
      { tier: 'no-such-tier', pathname: '/api/v1/test/[param]' }
    );
  });

  // ─── Limiter pass-through (1 test) ───────────────────────────────────────

  describe('limiter pass-through', () => {
    it('returns null when the request is under the cap (happy path)', async () => {
      // Arrange: unique user so this request doesn't share a bucket with other tests
      const userId = uniqueUserId();
      const token = `mw:orchestration:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));
      const request = makeRequest('/api/v1/admin/orchestration/agents');

      // Act
      const result = await applyRateLimit(request);

      // Assert: under the 120/min cap → pass-through
      expect(result).toBeNull();
    });
  });

  // ─── Limiter exhaustion → 429 (3 tests) ──────────────────────────────────

  describe('limiter exhaustion → 429', () => {
    it('returns 429 with RATE_LIMIT_EXCEEDED envelope when orchestration bucket is exhausted', async () => {
      // Arrange: unique user to isolate this bucket
      const userId = uniqueUserId();
      const token = `mw:orchestration:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));
      const path = '/api/v1/admin/orchestration/agents';

      // Fill the 120-request cap
      await exhaust(path, 120);

      // Act: request #121 should be rejected
      const response = await applyRateLimit(makeRequest(path));

      // Assert status
      expect(response).not.toBeNull();
      // TypeScript narrowing
      if (!response) throw new Error('Expected a Response, got null');
      expect(response.status).toBe(429);

      // Assert the standard error envelope
      const body = await parseJSON<{ success: boolean; error: { code: string; message: string } }>(
        response
      );
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(typeof body.error.message).toBe('string');

      // Assert rate-limit headers are present and correctly shaped
      const retryAfter = Number(response.headers.get('Retry-After'));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('120');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      const reset = Number(response.headers.get('X-RateLimit-Reset'));
      expect(reset).toBeGreaterThan(0);

      // Cleanup
      RATE_LIMIT_TIERS.orchestration.reset(token);
    });

    it("exhausts 'admin' tier at 30 requests, not 120", async () => {
      // Arrange: unique user; admin tier cap is 30/min (tighter than orchestration's 120)
      const userId = uniqueUserId();
      const token = `mw:admin:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.admin.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));
      const path = '/api/v1/admin/users';

      // Fill the 30-request cap exactly
      await exhaust(path, 30);

      // Act: request #31 should be rejected
      const response = await applyRateLimit(makeRequest(path));

      // Assert: 429 means the admin tier (30/min) is enforced, not the
      // orchestration tier (120/min). A tier-resolution bug would let all
      // 30 through and only block at 120.
      expect(response).not.toBeNull();
      if (!response) throw new Error('Expected a Response, got null');
      expect(response.status).toBe(429);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('30');

      // Cleanup
      RATE_LIMIT_TIERS.admin.reset(token);
    });

    it('distinct user IDs do not share buckets', async () => {
      // Arrange: user A exhausts the admin bucket; user B should still pass
      const userIdA = uniqueUserId();
      const userIdB = uniqueUserId();
      const tokenA = `mw:admin:session-user:user:${userIdA}`;
      const tokenB = `mw:admin:session-user:user:${userIdB}`;
      RATE_LIMIT_TIERS.admin.reset(tokenA);
      RATE_LIMIT_TIERS.admin.reset(tokenB);
      const path = '/api/v1/admin/users';

      // Exhaust user A's bucket
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userIdA } })
      );
      await exhaust(path, 30);
      const responseA = await applyRateLimit(makeRequest(path));
      expect(responseA?.status).toBe(429); // A is exhausted

      // Act: switch to user B — should not be affected by A's bucket
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userIdB } })
      );
      const responseB = await applyRateLimit(makeRequest(path));

      // Assert: user B's bucket is independent
      expect(responseB).toBeNull();

      // Cleanup
      RATE_LIMIT_TIERS.admin.reset(tokenA);
      RATE_LIMIT_TIERS.admin.reset(tokenB);
    });
  });

  // ─── Key-strategy resolution (5 tests) ───────────────────────────────────

  describe('key-strategy resolution', () => {
    it("'ip' key uses the client IP from x-forwarded-for", async () => {
      // Arrange: auth tier is IP-keyed, 5/min cap
      const ip = '192.0.2.42';
      const token = `mw:auth:ip:${ip}`;
      RATE_LIMIT_TIERS.auth.reset(token);
      const path = '/api/v1/auth/login';
      const headers = { 'x-forwarded-for': ip };

      // 5 requests — all should pass (exactly at the cap boundary)
      for (let i = 0; i < 5; i++) {
        const r = await applyRateLimit(makeRequest(path, headers));
        expect(r).toBeNull();
      }

      // Act: 6th request from the same IP → 429
      const response = await applyRateLimit(makeRequest(path, headers));

      // Assert: the IP is the discriminator — same IP shares a bucket
      expect(response).not.toBeNull();
      if (!response) throw new Error('Expected a Response, got null');
      expect(response.status).toBe(429);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('5');

      // Cleanup
      RATE_LIMIT_TIERS.auth.reset(token);
    });

    it("'session-user' key uses session.user.id when session resolves", async () => {
      // Arrange: unique user ID to keep the peek assertion clean
      const userId = `user_mw_sess_${Date.now()}`;
      const token = `mw:orchestration:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));
      const request = makeRequest('/api/v1/admin/orchestration/agents');

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through
      expect(result).toBeNull();

      // The bucket at the session-keyed token should show exactly 1 consumed request.
      // This proves the dispatcher built the token using the user ID — not the IP.
      const stats = RATE_LIMIT_TIERS.orchestration.peek(token);
      expect(stats.remaining).toBe(119); // 120 cap − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.orchestration.reset(token);
    });

    it("'session-user' falls back to IP when no session resolves", async () => {
      // Arrange: getSession returns null → dispatcher falls back to IP keying
      const ip = '198.51.100.7';
      const token = `mw:orchestration:session-user:ip:${ip}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);
      const request = makeRequest('/api/v1/admin/orchestration/agents', {
        'x-forwarded-for': ip,
      });

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through (first request, under cap)
      expect(result).toBeNull();

      // The fallback token (ip-prefixed) should show 1 consumed request,
      // proving the dispatcher switched to IP keying on session miss.
      const stats = RATE_LIMIT_TIERS.orchestration.peek(token);
      expect(stats.remaining).toBe(119); // 120 cap − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.orchestration.reset(token);
    });

    it("'session-user' falls back to IP when session resolution throws", async () => {
      // Arrange: getSession throws (e.g. auth provider down)
      const ip = '203.0.113.1';
      const token = `mw:orchestration:session-user:ip:${ip}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('auth provider down'));
      const request = makeRequest('/api/v1/admin/orchestration/agents', {
        'x-forwarded-for': ip,
      });

      // Act: the dispatcher MUST catch the error and fall back to IP, not propagate it
      const result = await applyRateLimit(request);

      // Assert: the request proceeds (dispatcher did not throw or return the auth error)
      expect(result).toBeNull();

      // The fallback IP-keyed bucket should show 1 consumed request.
      // If the dispatcher DID propagate the error, this line would be unreachable.
      const stats = RATE_LIMIT_TIERS.orchestration.peek(token);
      expect(stats.remaining).toBe(119); // 120 cap − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.orchestration.reset(token);
    });

    it("'api-key' puts distinct unverified Bearer values from one IP into one bucket", async () => {
      // Arrange: none of these values names a stored key (the default mock).
      // Keying on the header as presented would give each its own bucket.
      const ip = '192.0.2.71';
      const ipToken = `mw:api:api-key:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(ipToken);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey/resource';
      // A user-key shape, an MCP-key shape, and a format Sunrise never issues.
      const values = ['sk_unverified_1', 'sk_unverified_2', 'smcp_unverified_3', 'opaque-value-4'];

      // Act
      for (const value of values) {
        expect(
          await applyRateLimit(
            makeRequest(path, { 'x-forwarded-for': ip, authorization: `Bearer ${value}` })
          )
        ).toBeNull();
      }

      // Assert: every request was counted against the one IP bucket, and no
      // per-value bucket was opened.
      expect(RATE_LIMIT_TIERS.api.peek(ipToken).remaining).toBe(100 - values.length);
      for (const value of values) {
        expect(RATE_LIMIT_TIERS.api.peek(`mw:api:api-key:key:${value}`).remaining).toBe(100);
      }

      RATE_LIMIT_TIERS.api.reset(ipToken);
    });

    it("'api-key' gives each verified key its own bucket, keyed on the stored row", async () => {
      // Arrange: two stored keys, one user key and one MCP key.
      const ip = '192.0.2.72';
      const keyA = 'sk_verified_alpha';
      const keyB = 'smcp_verified_beta';
      const tokenA = 'mw:api:api-key:key:sk:row_a';
      const tokenB = 'mw:api:api-key:key:mcp:row_b';
      RATE_LIMIT_TIERS.api.reset(tokenA);
      RATE_LIMIT_TIERS.api.reset(tokenB);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'row_a',
        expiresAt: null,
      } as never);
      vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue({
        id: 'row_b',
        isActive: true,
        expiresAt: null,
      } as never);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-verified\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-verified/resource';

      // Act: fill key A's bucket to the cap, then one more.
      await exhaust(path, 100, { 'x-forwarded-for': ip, authorization: `Bearer ${keyA}` });
      const responseA = await applyRateLimit(
        makeRequest(path, { 'x-forwarded-for': ip, authorization: `Bearer ${keyA}` })
      );
      const responseB = await applyRateLimit(
        makeRequest(path, { 'x-forwarded-for': ip, authorization: `Bearer ${keyB}` })
      );

      // Assert: A is capped, B (same IP) is not, and each sits in its own bucket.
      expect(responseA?.status).toBe(429);
      expect(responseB).toBeNull();
      expect(RATE_LIMIT_TIERS.api.peek(tokenA).remaining).toBe(0);
      expect(RATE_LIMIT_TIERS.api.peek(tokenB).remaining).toBe(99);
      // The verified id is cached: 101 requests on key A cost one lookup.
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ revokedAt: null }),
        })
      );

      RATE_LIMIT_TIERS.api.reset(tokenA);
      RATE_LIMIT_TIERS.api.reset(tokenB);
    });

    it("'api-key' skips the lookup once the caller's IP bucket is full", async () => {
      const ip = '192.0.2.73';
      const ipToken = `mw:api:api-key:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(ipToken);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-full\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-full/resource';
      await exhaust(path, 100, { 'x-forwarded-for': ip });
      vi.mocked(prisma.aiApiKey.findFirst).mockClear();

      // Act
      const response = await applyRateLimit(
        makeRequest(path, { 'x-forwarded-for': ip, authorization: 'Bearer sk_new_value' })
      );

      // Assert: refused from the IP bucket, without a lookup.
      expect(response?.status).toBe(429);
      expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled();

      RATE_LIMIT_TIERS.api.reset(ipToken);
    });

    it("'api-key' re-checks a stale verified key even when the IP bucket is full", async () => {
      // A key verified within the TTL is re-checked in the second half of it.
      // That re-check must not be gated on the IP bucket, or a key in steady
      // use would land in a full IP bucket each time its entry aged out.
      const ip = '192.0.2.75';
      const ipToken = `mw:api:api-key:ip:${ip}`;
      const keyToken = 'mw:api:api-key:key:sk:row_c';
      RATE_LIMIT_TIERS.api.reset(ipToken);
      RATE_LIMIT_TIERS.api.reset(keyToken);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: 'row_c',
        expiresAt: null,
      } as never);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-stale\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-stale/resource';
      const keyed = { 'x-forwarded-for': ip, authorization: 'Bearer sk_steady' };

      expect(await applyRateLimit(makeRequest(path, keyed))).toBeNull();
      await exhaust(path, 100, { 'x-forwarded-for': ip });
      await advanceCacheClock(30_001);

      // Act: the entry is stale and the IP bucket is full.
      const response = await applyRateLimit(makeRequest(path, keyed));

      // Assert: re-checked and kept in its own bucket.
      expect(response).toBeNull();
      expect(prisma.aiApiKey.findFirst).toHaveBeenCalledTimes(2);
      expect(RATE_LIMIT_TIERS.api.peek(keyToken).remaining).toBe(98);

      RATE_LIMIT_TIERS.api.reset(ipToken);
      RATE_LIMIT_TIERS.api.reset(keyToken);
    });

    it("'api-key' keeps a stale verified key's bucket when the re-check fails", async () => {
      const ip = '192.0.2.76';
      const keyToken = 'mw:api:api-key:key:sk:row_d';
      RATE_LIMIT_TIERS.api.reset(keyToken);
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValueOnce({
        id: 'row_d',
        expiresAt: null,
      } as never);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-recheck\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-recheck/resource';
      const keyed = { 'x-forwarded-for': ip, authorization: 'Bearer sk_flaky_db' };

      await applyRateLimit(makeRequest(path, keyed));
      await advanceCacheClock(30_001);
      vi.mocked(prisma.aiApiKey.findFirst).mockRejectedValueOnce(new Error('db down'));
      await applyRateLimit(makeRequest(path, keyed));

      expect(RATE_LIMIT_TIERS.api.peek(keyToken).remaining).toBe(98);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('credential lookup failed'),
        expect.objectContaining({ key: 'api-key', error: 'db down' })
      );

      RATE_LIMIT_TIERS.api.reset(keyToken);
    });

    it("'api-key' falls back to the IP bucket and warns when the lookup fails", async () => {
      const ip = '192.0.2.74';
      const ipToken = `mw:api:api-key:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(ipToken);
      vi.mocked(prisma.aiApiKey.findFirst).mockRejectedValue(new Error('db down'));
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-dbdown\//,
        tier: 'api',
        key: 'api-key',
      });

      const response = await applyRateLimit(
        makeRequest('/api/v1/test-apikey-dbdown/resource', {
          'x-forwarded-for': ip,
          authorization: 'Bearer sk_anything',
        })
      );

      expect(response).toBeNull();
      expect(RATE_LIMIT_TIERS.api.peek(ipToken).remaining).toBe(99);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('credential lookup failed'),
        expect.objectContaining({ key: 'api-key', error: 'db down' })
      );

      RATE_LIMIT_TIERS.api.reset(ipToken);
    });

    it("'api-key' key falls back to IP when Authorization header is present but not Bearer-format", async () => {
      // Arrange: synthetic api-key rule; send a non-Bearer authorization header
      // (e.g. Basic auth). The dispatcher must NOT extract a key — it should
      // fall back to IP keying, exactly as if no Authorization header were present.
      const ip = '192.0.2.77';
      const fallbackToken = `mw:api:api-key:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(fallbackToken);

      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-fallback\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-fallback/resource';
      const headers = {
        'x-forwarded-for': ip,
        // Basic auth — does not match /^Bearer\s+(.+)$/i → triggers IP fallback
        authorization: 'Basic dXNlcjpwYXNz',
      };
      const request = makeRequest(path, headers);

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through (first request, under cap)
      expect(result).toBeNull();

      // Verify the fallback IP token was consumed. If the dispatcher had (wrongly)
      // extracted a key from the Basic header, it would have built a key:-prefixed
      // token and the ip-prefixed bucket would show remaining === cap (untouched).
      const stats = RATE_LIMIT_TIERS.api.peek(fallbackToken);
      expect(stats.remaining).toBe(99); // 100-cap api tier − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.api.reset(fallbackToken);
    });

    it("'api-key' key falls back to IP when no Authorization header is present", async () => {
      // Arrange: synthetic api-key rule, NO Authorization header at all (distinct
      // from the "present but not Bearer" case above). Source branches at
      // `if (header)` — this exercises the falsy side.
      const ip = '192.0.2.78';
      const fallbackToken = `mw:api:api-key:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(fallbackToken);

      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey-noheader\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey-noheader/resource';
      // Only x-forwarded-for — no authorization header.
      const headers = { 'x-forwarded-for': ip };
      const request = makeRequest(path, headers);

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through and verify the IP fallback bucket was consumed.
      expect(result).toBeNull();
      const stats = RATE_LIMIT_TIERS.api.peek(fallbackToken);
      expect(stats.remaining).toBe(99);

      // Cleanup
      RATE_LIMIT_TIERS.api.reset(fallbackToken);
    });

    it("'embed-token' puts distinct unverified tokens from one IP into one bucket", async () => {
      // Arrange: no presented token exists (the default mock).
      const ip = '203.0.113.50';
      const ipToken = `mw:api:embed-token:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(ipToken);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/embed\/test\//,
        tier: 'api',
        key: 'embed-token',
      });
      const path = '/api/v1/embed/test/chat';
      const tokens = Array.from({ length: 5 }, (_, i) => `tok_unverified_${i}`);

      // Act
      for (const token of tokens) {
        expect(
          await applyRateLimit(makeRequest(path, { 'x-forwarded-for': ip, 'x-embed-token': token }))
        ).toBeNull();
      }

      // Assert: one IP bucket took all five; no per-token bucket was opened.
      expect(RATE_LIMIT_TIERS.api.peek(ipToken).remaining).toBe(100 - tokens.length);
      for (const token of tokens) {
        expect(RATE_LIMIT_TIERS.api.peek(`mw:api:embed-token:embed:${token}:${ip}`).remaining).toBe(
          100
        );
      }

      RATE_LIMIT_TIERS.api.reset(ipToken);
    });

    it("'embed-token' keys a verified token on its row id + IP", async () => {
      const ip = '203.0.113.51';
      const bucket = `mw:api:embed-token:embed:tokrow_1:${ip}`;
      RATE_LIMIT_TIERS.api.reset(bucket);
      vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue({
        id: 'tokrow_1',
        isActive: true,
        agent: { isActive: true },
      } as never);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/embed\/test-verified\//,
        tier: 'api',
        key: 'embed-token',
      });

      const result = await applyRateLimit(
        makeRequest('/api/v1/embed/test-verified/chat', {
          'x-forwarded-for': ip,
          'x-embed-token': 'tok_real',
        })
      );

      expect(result).toBeNull();
      expect(RATE_LIMIT_TIERS.api.peek(bucket).remaining).toBe(99);

      RATE_LIMIT_TIERS.api.reset(bucket);
    });

    it("'embed-token' treats an inactive token as unverified", async () => {
      const ip = '203.0.113.52';
      const ipToken = `mw:api:embed-token:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(ipToken);
      vi.mocked(prisma.aiAgentEmbedToken.findUnique).mockResolvedValue({
        id: 'tokrow_2',
        isActive: false,
        agent: { isActive: true },
      } as never);
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/embed\/test-inactive\//,
        tier: 'api',
        key: 'embed-token',
      });

      await applyRateLimit(
        makeRequest('/api/v1/embed/test-inactive/chat', {
          'x-forwarded-for': ip,
          'x-embed-token': 'tok_inactive',
        })
      );

      expect(RATE_LIMIT_TIERS.api.peek(ipToken).remaining).toBe(99);

      RATE_LIMIT_TIERS.api.reset(ipToken);
    });

    it("'embed-token' key falls back to IP when X-Embed-Token header is absent", async () => {
      // Arrange: same synthetic embed-token rule, but NO x-embed-token header.
      // The dispatcher must fall back to `ip:${ip}` rather than `embed:...:${ip}`.
      const ip = '198.51.100.99';
      const fallbackToken = `mw:api:embed-token:ip:${ip}`;
      RATE_LIMIT_TIERS.api.reset(fallbackToken);

      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/embed\/test-fallback\//,
        tier: 'api',
        key: 'embed-token',
      });
      const path = '/api/v1/embed/test-fallback/chat';
      // Deliberately omit x-embed-token header
      const request = makeRequest(path, { 'x-forwarded-for': ip });

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through
      expect(result).toBeNull();

      // The IP-fallback token should show 1 consumed request.
      // If the dispatcher (wrongly) fell back to some embed: prefix even
      // without a token header, the ip-prefixed bucket would be untouched.
      const stats = RATE_LIMIT_TIERS.api.peek(fallbackToken);
      expect(stats.remaining).toBe(99); // 100-cap api tier − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.api.reset(fallbackToken);
    });

    it('returns null (fail-open) AND logs a warning when the rule tier is not in the RATE_LIMIT_TIERS registry', async () => {
      // Arrange: inject a synthetic rule whose tier is NOT in RATE_LIMIT_TIERS.
      // TypeScript prevents this at compile time, but the source has a defensive
      // `if (!limiter) return null` branch to avoid breaking production traffic
      // if the type contract is somehow violated at runtime. The dispatcher MUST
      // log a warning so operators can detect the config drift; silently returning
      // null was the original bug.
      //
      // We force the type error intentionally with `as RateLimitTier` to reach
      // the branch the type system makes "unreachable" in normal usage.
      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-missing-tier\//,
        tier: 'nonexistent' as import('@/lib/security/rate-limit').RateLimitTier,
        key: 'ip',
      });
      const request = makeRequest('/api/v1/test-missing-tier/resource', {
        'x-forwarded-for': '10.0.0.1',
      });

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through: production traffic continues to flow even if a
      // tier is misconfigured, rather than causing a 500 error cascade.
      expect(result).toBeNull();

      // Assert observable signal: the unreachable branch MUST log a warning
      // with the tier name and pathname so operators can diagnose config drift.
      // Silent failure on this branch was the original code-review finding.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown tier'),
        expect.objectContaining({
          tier: 'nonexistent',
          pathname: '/api/v1/test-missing-tier/resource',
        })
      );
    });
  });

  // ─── Skip-predicate fall-through loop (Findings 1+2) ─────────────────────
  // These tests exercise the loop at lines 85-100 of the source: when the
  // FIRST matched rule's skip fires, the dispatcher iterates subsequent rules
  // looking for a non-skipping match. findRateLimitRule is NOT overridden here
  // (beforeEach re-wires it to the real implementation), so the real
  // RATE_LIMIT_POLICY is evaluated.

  describe('skip-predicate fall-through loop against real policy', () => {
    it('orchestration dual-rule: no Bearer sk_ header → falls through api-key rule to session-user rule', async () => {
      // Arrange: request to an orchestration path WITH a session but WITHOUT a
      // `Bearer sk_...` Authorization header. The first rule (api-key, skip
      // fires for non-sk_ headers) is skipped; the dispatcher must iterate and
      // land on the SECOND rule (session-user) — the real loop code path.
      const userId = uniqueUserId();
      const token = `mw:orchestration:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));

      // No Authorization header → api-key rule's skip fires → must fall through.
      const request = makeRequest('/api/v1/admin/orchestration/agents');

      // Act
      const result = await applyRateLimit(request);

      // Assert pass-through (first request, under the 120/min cap)
      expect(result).toBeNull();

      // The session-user bucket must show exactly 1 consumed request. This
      // proves the loop selected the SECOND (session-user) rule, not the
      // (skipped) api-key rule — the api-key bucket token would be different.
      const stats = RATE_LIMIT_TIERS.orchestration.peek(token);
      expect(stats.remaining).toBe(119); // 120 cap − 1 consumed

      // Cleanup
      RATE_LIMIT_TIERS.orchestration.reset(token);
    });

    it('non-credential better-auth path: /api/auth/get-session → skip fires → no subsequent match → null', async () => {
      // Arrange: `/api/auth/get-session` matches the /api/auth/ rule, but
      // skipNonCredentialAuthRoutes returns true (it's not a credential path).
      // The loop then iterates the remaining policy rules (mcp, webhooks, etc.)
      // — none of which match /api/auth/... — and falls through to return null.
      // This exercises the "candidate does not match → continue" path in the loop.
      const request = makeRequest('/api/auth/get-session');

      // Act
      const result = await applyRateLimit(request);

      // Assert: no rate limit applied at the middleware layer for non-credential
      // auth reads. The auth limiter bucket must NOT be consumed.
      expect(result).toBeNull();
    });
  });

  // ─── Production-bypass safeguard (3 tests) ───────────────────────────────

  describe('RATE_LIMIT_BYPASS production safeguard', () => {
    it('logs an error when bypass is active AND NODE_ENV=production', async () => {
      // Arrange: enable bypass and pin NODE_ENV to production. The dispatcher
      // is documented to emit a structured logger.error so the misconfiguration
      // surfaces in production log streams — the only way operators can detect
      // an accidental .env promotion that silently disables rate limiting.
      vi.stubEnv('RATE_LIMIT_BYPASS', 'true');
      vi.stubEnv('NODE_ENV', 'production');

      // Act
      const result = await applyRateLimit(makeRequest('/api/v1/admin/users'));

      // Assert pass-through (bypass still works — we don't refuse traffic, just log)
      expect(result).toBeNull();

      // Assert the structured error log fires with actionable context.
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('RATE_LIMIT_BYPASS'),
        expect.objectContaining({
          nodeEnv: 'production',
        })
      );
    });

    it('does NOT log an error when bypass is active in a non-production NODE_ENV', async () => {
      // Arrange: bypass on, NODE_ENV=test (the normal development/CI mode).
      // This is the intended use of the flag — no warning should fire and
      // tests using bypass shouldn't pollute log output.
      vi.stubEnv('RATE_LIMIT_BYPASS', 'true');
      vi.stubEnv('NODE_ENV', 'test');

      // Act
      const result = await applyRateLimit(makeRequest('/api/v1/admin/users'));

      // Assert: bypass works
      expect(result).toBeNull();
      // Assert no production warning fired
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does NOT log an error when bypass is off, regardless of NODE_ENV', async () => {
      // Arrange: production NODE_ENV but bypass explicitly off. The error log
      // is gated on bypass-being-active — turning bypass off must produce no
      // log noise even in production.
      vi.stubEnv('RATE_LIMIT_BYPASS', '');
      vi.stubEnv('NODE_ENV', 'production');

      // Set up a real session so the dispatcher gets through to the limiter
      // (otherwise it falls back to IP keying which is fine but irrelevant).
      const userId = uniqueUserId();
      RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { id: userId } }));

      // Act
      const result = await applyRateLimit(makeRequest('/api/v1/admin/users'));

      // Assert pass-through (under the cap)
      expect(result).toBeNull();
      // Assert: no production-bypass warning fired (bypass is off)
      expect(logger.error).not.toHaveBeenCalled();

      // Cleanup
      RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);
    });
  });
});
