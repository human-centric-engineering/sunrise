/**
 * Tests: App-extensible rate-limit registry (fork-readiness seam 13)
 *
 * Covers the three things the seam adds:
 *   1. Tier registry — `registerRateLimitTier` / `resolveRateLimitTier`, and
 *      its refusal to shadow built-in tiers.
 *   2. Rule registry — `registerRateLimitRule`'s SECURITY guard (app rules may
 *      not match Sunrise-protected surfaces) and its insertion position
 *      (after every Sunrise rule, before the catch-all).
 *   3. End-to-end — `applyRateLimit` actually resolves an app tier and applies
 *      an app rule's cap (verified by exhausting a real bucket, not a mock).
 *
 * The registries are module-level singletons; `__reset*` helpers restore the
 * built-in baseline after each test so cases stay independent.
 *
 * @see lib/security/rate-limit.ts
 * @see lib/security/rate-limit-policy.ts
 * @see lib/security/rate-limit-middleware.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth + logging so importing the middleware doesn't pull in real
// better-auth / DB wiring. The 'ip'-keyed app rule below never calls
// getSession, but the dispatcher imports the module regardless.
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createRateLimiter,
  registerRateLimitTier,
  resolveRateLimitTier,
  __resetAppRateLimitTiers,
  RATE_LIMIT_TIERS,
} from '@/lib/security/rate-limit';
import {
  registerRateLimitRule,
  getEffectiveRateLimitPolicy,
  findRateLimitRule,
  pathMatchesRule,
  RATE_LIMIT_POLICY,
  CATCH_ALL_RULE,
  __resetAppRateLimitRules,
  type RateLimitRule,
} from '@/lib/security/rate-limit-policy';
import { applyRateLimit } from '@/lib/security/rate-limit-middleware';

function makeLimiter(maxRequests: number) {
  return createRateLimiter({ interval: 60_000, maxRequests });
}

afterEach(() => {
  __resetAppRateLimitRules();
  __resetAppRateLimitTiers();
});

// ─── Tier registry ─────────────────────────────────────────────────────────

describe('registerRateLimitTier / resolveRateLimitTier', () => {
  it('resolves built-in tiers without any registration', () => {
    // The registry is seeded from RATE_LIMIT_TIERS, holding the SAME instances.
    expect(resolveRateLimitTier('admin')).toBe(RATE_LIMIT_TIERS.admin);
    expect(resolveRateLimitTier('api')).toBe(RATE_LIMIT_TIERS.api);
    expect(resolveRateLimitTier('mcp')).toBe(RATE_LIMIT_TIERS.mcp);
  });

  it('registers an app tier and resolves it to the same limiter instance', () => {
    const limiter = makeLimiter(7);
    registerRateLimitTier('billing', limiter);
    expect(resolveRateLimitTier('billing')).toBe(limiter);
  });

  it('returns undefined for an unknown tier name', () => {
    expect(resolveRateLimitTier('does-not-exist')).toBeUndefined();
  });

  it('refuses to override a built-in tier (security: cannot loosen admin/auth/etc.)', () => {
    // Registering 'admin' with a looser limiter would silently weaken the
    // 30/min core-admin cap — the registry must reject it.
    expect(() => registerRateLimitTier('admin', makeLimiter(10_000))).toThrow(/built-in/i);
    // The built-in instance is untouched.
    expect(resolveRateLimitTier('admin')).toBe(RATE_LIMIT_TIERS.admin);
  });

  it('rejects a duplicate app-tier registration', () => {
    registerRateLimitTier('billing', makeLimiter(7));
    expect(() => registerRateLimitTier('billing', makeLimiter(9))).toThrow(/already registered/i);
  });

  it('rejects an empty tier name', () => {
    expect(() => registerRateLimitTier('', makeLimiter(1))).toThrow();
  });

  it('rejects a confusable case-variant of a built-in tier (case-insensitive guard)', () => {
    // `'Admin' in RATE_LIMIT_TIERS` is false case-sensitively, so without
    // the case-normalize fix a fork could register 'Admin' as a separate
    // tier that operators reading logs would mistake for the real `admin`
    // cap. The guard normalizes to lowercase and rejects.
    expect(() => registerRateLimitTier('Admin', makeLimiter(10_000))).toThrow(/built-in|collides/i);
    expect(() => registerRateLimitTier('MCP', makeLimiter(10_000))).toThrow(/built-in|collides/i);
    expect(() => registerRateLimitTier('Auth', makeLimiter(10_000))).toThrow(/built-in|collides/i);
    // ...and none of those leaked into the registry.
    expect(resolveRateLimitTier('Admin')).toBeUndefined();
    expect(resolveRateLimitTier('MCP')).toBeUndefined();
  });

  it("treats prototype-chain keys as non-collisions (Object.hasOwn, not 'in')", () => {
    // `'toString' in RATE_LIMIT_TIERS` is `true` via Object.prototype, which
    // would trip the built-in guard with a misleading "is a built-in Sunrise
    // tier" message — confusing the author and blocking a legitimate tier
    // name. Object.hasOwn ignores the prototype chain, so registration goes
    // through (no built-in actually owns 'toString' as a tier).
    const limiter = makeLimiter(3);
    expect(() => registerRateLimitTier('toString', limiter)).not.toThrow();
    expect(resolveRateLimitTier('toString')).toBe(limiter);
  });

  it("treats 'constructor' as non-collision (prototype key, not a real tier)", () => {
    const limiter = makeLimiter(3);
    expect(() => registerRateLimitTier('constructor', limiter)).not.toThrow();
    expect(resolveRateLimitTier('constructor')).toBe(limiter);
  });

  it('is idempotent when the SAME limiter instance is re-registered (HMR-safe)', () => {
    // Next.js HMR re-evaluates the middleware module → re-runs
    // `registerAppRateLimits()` → re-registers tiers. With the same limiter
    // reference (which is what an unchanged `lib/app/rate-limit.ts` produces),
    // the call must be a no-op rather than throwing "already registered".
    const limiter = makeLimiter(7);
    registerRateLimitTier('billing', limiter);
    expect(() => registerRateLimitTier('billing', limiter)).not.toThrow();
    // ...and the same limiter is still what resolves.
    expect(resolveRateLimitTier('billing')).toBe(limiter);
  });

  it('still throws when re-registering with a DIFFERENT limiter instance', () => {
    // Idempotence is by reference identity, not by name. A second distinct
    // limiter under the same name is a genuine duplicate that would silently
    // discard one bucket — keep the throw to surface it.
    const first = makeLimiter(7);
    const second = makeLimiter(7); // same config, different instance
    registerRateLimitTier('billing', first);
    expect(() => registerRateLimitTier('billing', second)).toThrow(/different limiter/i);
    // The first registration wins; the second never replaces it.
    expect(resolveRateLimitTier('billing')).toBe(first);
  });
});

// ─── Rule registry — security guard ──────────────────────────────────────────

describe('registerRateLimitRule — protected-namespace guard', () => {
  // The guard uses namespace-prefix probes ('/api/v1/admin/...', '/api/auth/...',
  // '/api/v1/auth/...', '/api/v1/mcp...'), so any matcher that fires for an
  // arbitrary path under one of these namespaces is rejected. Specific
  // endpoints inside a namespace need not be probed individually — the prefix
  // covers them (and stays stable as Sunrise adds new sub-routes).
  const protectedMatchers: Array<[string, RegExp | string]> = [
    ['core admin namespace (regex)', /^\/api\/v1\/admin\//],
    ['better-auth credential surface', /^\/api\/auth\//],
    ['Sunrise app-layer auth', /^\/api\/v1\/auth\//],
    ['MCP transport', /^\/api\/v1\/mcp(\/|$)/],
    ['overly-broad /api/v1 (shadows admin)', /^\/api\/v1\//],
    ['overly-broad /api (shadows auth)', /^\/api\//],
    ['admin string prefix', '/api/v1/admin/'],
    ['catch-all regex', /.*/],
  ];

  it.each(protectedMatchers)(
    'rejects a rule whose matcher could fire for the %s',
    (_label, match) => {
      // Act & Assert — registration throws...
      expect(() => registerRateLimitRule({ match, tier: 'api', key: 'ip' })).toThrow(
        /shadow|protected/i
      );
      // ...and the rejected rule was NOT added (effective policy === base by identity).
      expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
    }
  );

  it('accepts a rule scoped to the app’s own /api/v1 namespace', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    // It was added — effective policy is no longer the base array by identity.
    expect(getEffectiveRateLimitPolicy()).not.toBe(RATE_LIMIT_POLICY);
  });

  it('accepts a rule nested INSIDE a Sunrise sub-namespace — ordering, not the guard, protects', () => {
    // Namespace-prefix probes intentionally do NOT catch matchers more
    // specific than the probe (a regex like /^\/api\/v1\/admin\/orchestration\//
    // doesn't fire for /api/v1/admin/-probe- because the probe lacks
    // "orchestration"). The defence here is first-match-wins ordering: app
    // rules splice in AFTER every Sunrise rule, so Sunrise's orchestration
    // rule still wins for any orchestration path before the fork's rule is
    // ever evaluated. This test pins the behaviour so a future tightening
    // of the guard is a deliberate change, not an accident.
    registerRateLimitRule({
      match: /^\/api\/v1\/admin\/orchestration\//,
      tier: 'api',
      key: 'ip',
    });
    const eff = getEffectiveRateLimitPolicy();
    // Rule is in the policy...
    expect(eff).not.toBe(RATE_LIMIT_POLICY);
    // ...but a request to /api/v1/admin/orchestration/agents still resolves
    // to Sunrise's 'orchestration' tier (which comes first), not the fork's 'api'.
    expect(findRateLimitRule('/api/v1/admin/orchestration/agents', eff)?.tier).toBe(
      'orchestration'
    );
  });
});

// ─── Rule registry — insertion position ──────────────────────────────────────

describe('getEffectiveRateLimitPolicy — insertion position', () => {
  it('returns the base policy by identity when no app rules are registered', () => {
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('splices an app rule immediately before the catch-all, after all Sunrise rules', () => {
    const appRule: RateLimitRule = {
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'session-user',
    };
    registerRateLimitRule(appRule);
    const eff = getEffectiveRateLimitPolicy();

    // Exactly one rule added.
    expect(eff).toHaveLength(RATE_LIMIT_POLICY.length + 1);
    // Catch-all (session-user /^\/api\/v1\//) remains the LAST rule.
    const baseCatchAll = RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1];
    expect(eff[eff.length - 1]).toBe(baseCatchAll);
    // App rule sits immediately ahead of the catch-all.
    expect(eff[eff.length - 2]).toBe(appRule);
    // Every Sunrise specific rule still precedes the app rule, unchanged & in order.
    expect(eff.slice(0, RATE_LIMIT_POLICY.length - 1)).toEqual(RATE_LIMIT_POLICY.slice(0, -1));
  });

  it('app rule wins over the catch-all for the app namespace (first-match-wins)', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'api-key' });
    const rule = findRateLimitRule('/api/v1/billing/charge', getEffectiveRateLimitPolicy());
    // Resolves to the app rule's keying, NOT the session-user catch-all.
    expect(rule?.key).toBe('api-key');
  });

  it('does not change resolution for Sunrise-owned paths', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'api-key' });
    const eff = getEffectiveRateLimitPolicy();
    expect(findRateLimitRule('/api/v1/admin/users', eff)?.tier).toBe('admin');
    expect(findRateLimitRule('/api/v1/mcp', eff)?.tier).toBe('mcp');
    // A generic api path still lands on the session-user catch-all.
    expect(findRateLimitRule('/api/v1/unrelated/thing', eff)?.key).toBe('session-user');
  });

  it('CATCH_ALL_RULE is the last element of the base policy (the splice-position invariant)', () => {
    // Identity equality — `getEffectiveRateLimitPolicy` runtime-asserts this
    // exact reference is the tail before splicing app rules in. A future PR
    // that appended another rule (or rebuilt the catch-all as a structural
    // copy) would silently shift app rules into the wrong slot.
    expect(RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1]).toBe(CATCH_ALL_RULE);
  });

  it('CATCH_ALL_RULE is the same reference spliced into the effective policy', () => {
    // The effective-policy assembler must rebuild around the SAME catch-all
    // reference; otherwise the assert / app-rule consumers can't identity-
    // compare and we lose the invariant.
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    const eff = getEffectiveRateLimitPolicy();
    expect(eff[eff.length - 1]).toBe(CATCH_ALL_RULE);
  });

  it('dedupes by reference — re-registering the SAME rule does not double the policy', () => {
    // Next.js HMR re-evaluates the middleware module on file changes and
    // re-runs `registerAppRateLimits()`. Without the dedup, every hot-reload
    // would append another copy of the rule and grow the per-request
    // iteration unboundedly. Reference equality covers the common case
    // (middleware re-evaluation, unchanged app file → same rule literal).
    const rule: RateLimitRule = {
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'session-user',
    };
    registerRateLimitRule(rule);
    const lengthAfterFirst = getEffectiveRateLimitPolicy().length;
    registerRateLimitRule(rule);
    registerRateLimitRule(rule);
    expect(getEffectiveRateLimitPolicy().length).toBe(lengthAfterFirst);
  });

  it('memoises the effective policy across repeated calls once app rules are registered', () => {
    // The middleware now defaults findRateLimitRule's policy arg to
    // getEffectiveRateLimitPolicy(), so this fires on every request once any
    // app rule is registered. The cache MUST return the same array instance
    // until a register/reset invalidates it — otherwise every request pays
    // the allocation cost the comment claims is avoided.
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    const a = getEffectiveRateLimitPolicy();
    const b = getEffectiveRateLimitPolicy();
    const c = getEffectiveRateLimitPolicy();
    expect(a).toBe(b); // identity, not just structural equality
    expect(b).toBe(c);
    // Sanity: the cached array still contains the registered rule.
    expect(a).not.toBe(RATE_LIMIT_POLICY);
  });

  it('invalidates the cache when a new app rule is registered', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    const before = getEffectiveRateLimitPolicy();
    registerRateLimitRule({ match: /^\/api\/v1\/widgets\//, tier: 'api', key: 'session-user' });
    const after = getEffectiveRateLimitPolicy();
    // A second registration must produce a new array (the old cache is stale).
    expect(after).not.toBe(before);
    expect(after.length).toBe(before.length + 1);
  });

  it('invalidates the cache on __resetAppRateLimitRules', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    const beforeReset = getEffectiveRateLimitPolicy();
    expect(beforeReset).not.toBe(RATE_LIMIT_POLICY);
    __resetAppRateLimitRules();
    // After reset there are no app rules → identity return of the base policy.
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('does NOT dedupe structurally — distinct rule objects with same shape both register', () => {
    // The dedup is intentionally by reference, not by content. A fork editing
    // `lib/app/rate-limit.ts` itself produces a fresh rule literal on
    // re-evaluation; that case still grows the list (accepted — changing
    // your registrations is a "restart the dev server" situation). The
    // test documents this so the behaviour isn't silently tightened later.
    const ruleA: RateLimitRule = {
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'session-user',
    };
    const ruleB: RateLimitRule = {
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'session-user',
    };
    registerRateLimitRule(ruleA);
    const baselineLength = getEffectiveRateLimitPolicy().length;
    registerRateLimitRule(ruleB);
    expect(getEffectiveRateLimitPolicy().length).toBe(baselineLength + 1);
  });
});

// ─── pathMatchesRule + findRateLimitRule default arg ────────────────────────

describe('pathMatchesRule (exported helper)', () => {
  it('returns true for a string matcher that is a prefix of the pathname', () => {
    // The middleware skip-fallthrough loop now uses this helper instead of an
    // inline copy. Lock the contract: string matchers are `startsWith`.
    expect(pathMatchesRule('/api/v1/billing/', '/api/v1/billing/charge')).toBe(true);
    expect(pathMatchesRule('/api/v1/billing/', '/api/v1/billing/')).toBe(true);
    expect(pathMatchesRule('/api/v1/billing/', '/api/v1/widgets/list')).toBe(false);
  });

  it('returns true for a RegExp matcher whose .test() accepts the pathname', () => {
    expect(pathMatchesRule(/^\/api\/v1\/admin\//, '/api/v1/admin/users')).toBe(true);
    expect(pathMatchesRule(/^\/api\/v1\/admin\//, '/api/v1/billing/charge')).toBe(false);
  });
});

describe('findRateLimitRule default arg (finding #14 — defaults to effective policy)', () => {
  it('with no policy arg, picks up app-registered rules (not just the base policy)', () => {
    // The previous default was `RATE_LIMIT_POLICY` (the bare base) — any
    // future caller using the default would silently bypass app rules. The
    // new default is `getEffectiveRateLimitPolicy()`, so callers that don't
    // pass policy still see the app slice.
    registerRateLimitRule({
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'api-key',
    });
    // No explicit policy argument — the default kicks in.
    const rule = findRateLimitRule('/api/v1/billing/charge');
    // App rule wins (its `api-key` keying, not the catch-all's `session-user`).
    expect(rule?.key).toBe('api-key');
  });
});

// ─── End-to-end: middleware applies an app tier + rule ───────────────────────

describe('applyRateLimit — enforces an app-registered tier + rule', () => {
  beforeEach(() => {
    // tests/setup.ts sets RATE_LIMIT_BYPASS=true globally; clear it so the
    // dispatcher runs for real. Vitest auto-restores after the test.
    vi.stubEnv('RATE_LIMIT_BYPASS', '');
    vi.clearAllMocks();
  });

  it('resolves the app tier and enforces its cap (not the api default)', async () => {
    // Arrange — an app tier capped at 2/min, wired to an app path.
    registerRateLimitTier('billing', makeLimiter(2));
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'ip' });

    const headers = { 'x-forwarded-for': '192.0.2.200' };
    const make = (): NextRequest =>
      new NextRequest('http://localhost:3000/api/v1/billing/charge', { headers });

    // Act + Assert — first two requests pass...
    expect(await applyRateLimit(make())).toBeNull();
    expect(await applyRateLimit(make())).toBeNull();

    // ...the third is rejected AT THE APP CAP OF 2 (proving the app tier was
    // resolved — the api default of 100 would have let it through).
    const blocked = await applyRateLimit(make());
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('X-RateLimit-Limit')).toBe('2');
  });

  it('keeps Sunrise paths on their built-in tier even with an app rule registered', async () => {
    // Arrange — register an unrelated app rule, then hit a core admin path.
    registerRateLimitTier('billing', makeLimiter(2));
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'ip' });
    const userId = `user_ext_${Date.now()}`;
    vi.mocked((await import('@/lib/auth/config')).auth.api.getSession).mockResolvedValue({
      user: { id: userId },
    } as never);
    RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);

    // Act — a core admin request still resolves to the 30/min admin tier.
    const res = await applyRateLimit(
      new NextRequest('http://localhost:3000/api/v1/admin/users', {
        headers: { 'x-forwarded-for': '192.0.2.201' },
      })
    );

    // Assert — under cap, passes; the app rule didn't perturb Sunrise routing.
    expect(res).toBeNull();
    RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);
  });
});
