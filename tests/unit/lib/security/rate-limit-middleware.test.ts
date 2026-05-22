/**
 * Unit Tests: Rate-Limit Middleware Dispatcher (applyRateLimit)
 *
 * Tests the middleware dispatcher that runs on every API request:
 * - Bypass flag handling (RATE_LIMIT_BYPASS env var)
 * - No-rule path (non-API routes, skip predicates)
 * - Limiter pass-through (happy path)
 * - Limiter exhaustion → 429 with correct headers and envelope
 * - Key-strategy resolution (ip, session-user, api-key)
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

import { auth } from '@/lib/auth/config';
import { findRateLimitRule, type RateLimitRule } from '@/lib/security/rate-limit-policy';

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

    // Re-wire findRateLimitRule to the real implementation by default.
    // The real function was captured by the mock factory above.
    // Tests that need a synthetic rule override this inline.
    vi.mocked(findRateLimitRule).mockImplementation(realFindRateLimitRule);

    // Default: no session (tests override as needed)
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
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

  // ─── Limiter pass-through (1 test) ───────────────────────────────────────

  describe('limiter pass-through', () => {
    it('returns null when the request is under the cap (happy path)', async () => {
      // Arrange: unique user so this request doesn't share a bucket with other tests
      const userId = uniqueUserId();
      const token = `mw:orchestration:session-user:user:${userId}`;
      RATE_LIMIT_TIERS.orchestration.reset(token);
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userId } }) as never
      );
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
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userId } }) as never
      );
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
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userId } }) as never
      );
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
        createMockSession({ user: { id: userIdA } }) as never
      );
      await exhaust(path, 30);
      const responseA = await applyRateLimit(makeRequest(path));
      expect(responseA?.status).toBe(429); // A is exhausted

      // Act: switch to user B — should not be affected by A's bucket
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userIdB } }) as never
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
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { id: userId } }) as never
      );
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

    it("'api-key' key extracts from Authorization: Bearer header", async () => {
      // Arrange: inject a synthetic rule using the 'api-key' strategy.
      // No real RATE_LIMIT_POLICY rule currently uses 'api-key', so we inject one.
      const apiTierCap = 100; // api tier cap
      const keyA = 'my-test-key-alpha';
      const keyB = 'my-test-key-beta';
      const tokenA = `mw:api:api-key:key:${keyA}`;
      const tokenB = `mw:api:api-key:key:${keyB}`;
      RATE_LIMIT_TIERS.api.reset(tokenA);
      RATE_LIMIT_TIERS.api.reset(tokenB);

      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/test-apikey\//,
        tier: 'api',
        key: 'api-key',
      });
      const path = '/api/v1/test-apikey/resource';

      // Fill key A's bucket to the cap
      await exhaust(path, apiTierCap, { authorization: `Bearer ${keyA}` });

      // Act: one more request with key A → 429
      const responseA = await applyRateLimit(
        makeRequest(path, { authorization: `Bearer ${keyA}` })
      );
      expect(responseA).not.toBeNull();
      if (!responseA) throw new Error('Expected a Response, got null');
      expect(responseA.status).toBe(429);

      // Assert: a different key gets its own independent bucket
      const responseB = await applyRateLimit(
        makeRequest(path, { authorization: `Bearer ${keyB}` })
      );
      // Key B has not been used — should still pass
      expect(responseB).toBeNull();

      // Cleanup
      RATE_LIMIT_TIERS.api.reset(tokenA);
      RATE_LIMIT_TIERS.api.reset(tokenB);
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

    it("'embed-token' key uses X-Embed-Token header + IP composite when header is present", async () => {
      // Arrange: synthetic embed-token rule; token and IP are composed as
      // `embed:${token}:${ip}` inside resolveIdentifier.
      const ip = '203.0.113.50';
      const tokenA = 'tok_abc123';
      const tokenB = 'tok_different456';
      const bucketA = `mw:api:embed-token:embed:${tokenA}:${ip}`;
      const bucketB = `mw:api:embed-token:embed:${tokenB}:${ip}`;
      RATE_LIMIT_TIERS.api.reset(bucketA);
      RATE_LIMIT_TIERS.api.reset(bucketB);

      vi.mocked(findRateLimitRule).mockReturnValue({
        match: /^\/api\/v1\/embed\/test\//,
        tier: 'api',
        key: 'embed-token',
      });
      const path = '/api/v1/embed/test/chat';

      // Act: one request with token A
      const result = await applyRateLimit(
        makeRequest(path, { 'x-forwarded-for': ip, 'x-embed-token': tokenA })
      );

      // Assert pass-through
      expect(result).toBeNull();

      // The composite bucket for token A should show exactly 1 consumed request.
      // This proves the dispatcher used the header value, not the IP alone.
      const statsA = RATE_LIMIT_TIERS.api.peek(bucketA);
      expect(statsA.remaining).toBe(99); // 100-cap api tier − 1 consumed

      // Token B with the same IP must be an independent bucket (untouched).
      const statsB = RATE_LIMIT_TIERS.api.peek(bucketB);
      expect(statsB.remaining).toBe(100); // not consumed

      // Cleanup
      RATE_LIMIT_TIERS.api.reset(bucketA);
      RATE_LIMIT_TIERS.api.reset(bucketB);
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

    it('returns null (fail-open) when the rule tier is not in the RATE_LIMIT_TIERS registry', async () => {
      // Arrange: inject a synthetic rule whose tier is NOT in RATE_LIMIT_TIERS.
      // TypeScript prevents this at compile time, but the source has a defensive
      // `if (!limiter) return null` branch to avoid breaking production traffic
      // if the type contract is somehow violated at runtime. This test proves
      // that the fail-open behaviour fires rather than throwing.
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

      // Assert: the dispatcher did not throw — it returned null (fail-open),
      // which means production traffic continues to flow even if a tier is
      // misconfigured, rather than causing a 500 error cascade.
      expect(result).toBeNull();
    });
  });
});
