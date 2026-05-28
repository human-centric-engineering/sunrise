/**
 * Rate-Limit Middleware Dispatcher
 *
 * Consumed by `proxy.ts` at the project root (Next.js 16 renamed the
 * `middleware.ts` file convention to `proxy.ts`). Runs on every API request,
 * looks up the matching tier from {@link RATE_LIMIT_POLICY}, identifies the
 * caller, applies the section limiter, and returns a 429 response if the cap
 * is exceeded — otherwise yields control back to the route handler.
 *
 * Route handlers must NOT call section limiters themselves. They MAY call
 * tighter *per-flow* limiters (chatLimiter, audioLimiter, etc.) as additive
 * checks on expensive sub-flows.
 *
 * **Test bypass.** Setting `RATE_LIMIT_BYPASS=true` makes `applyRateLimit`
 * a no-op. `tests/setup.ts` sets this so the vast majority of unit tests
 * never have to think about rate-limiting. Tests that explicitly exercise
 * the middleware (or a section tier) unset the env var in their own
 * `beforeEach` and reset the limiter state per test.
 *
 * @see lib/security/rate-limit-policy.ts — the policy table this consumes
 * @see lib/security/rate-limit.ts — limiter primitives + the tier registry
 * @see proxy.ts — project-root Next.js wiring
 */

import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { logger } from '@/lib/logging';
import { getClientIP } from '@/lib/security/ip';
import {
  createRateLimitResponse,
  resolveRateLimitTier,
  type RateLimiter,
} from '@/lib/security/rate-limit';
import {
  findRateLimitRule,
  getEffectiveRateLimitPolicy,
  pathMatchesRule,
  type RateLimitKey,
  type RateLimitRule,
} from '@/lib/security/rate-limit-policy';
import { registerAppRateLimits } from '@/lib/app/rate-limit';

// Auto-wire the app's rate-limit registrations (fork-readiness — the `lib/app/`
// bootstrap surface). Runs ONCE when this module loads, which is in the
// middleware runtime — the same realm `proxy.ts` evaluates the policy in, so an
// app-registered tier/rule is present before the first `applyRateLimit` call.
// (Module-level registries don't cross Next.js's middleware/server/client
// bundle boundaries, so each `lib/app/` file is imported by its realm's
// consumer rather than a single shared bootstrap.) Default is a no-op; if a
// fork's registration throws — e.g. a rule that would shadow a protected
// surface — it aborts boot, which is the intended fail-fast.
//
// The try/catch wraps the call to annotate the failure with a pointer to the
// offending file before re-throwing. Without it, the throw propagates out of
// this module's top level → `proxy.ts` fails to load → every API request
// returns a generic 500 with a stack that does NOT name `lib/app/rate-limit.ts`,
// making the debugging trail hard to follow. We MUST re-throw — fail-fast is
// the intended behaviour for a misconfigured rate-limit registration; logging
// and continuing would let the misconfiguration ship.
try {
  registerAppRateLimits();
  // Integrity check (fork-readiness finding #6): the rule shape widens `tier`
  // to `RateLimitTier | (string & {})` so forks can name custom tiers as
  // bare strings without TS module-augmentation gymnastics. The trade-off is
  // that a typo (`tier: 'billling'`) type-checks cleanly — and would silently
  // fail open at request time (no limiter resolves → no rate limit applied).
  // Convert that runtime fail-open into a boot-time throw: every rule's tier
  // MUST resolve once the auto-wire is done. If a fork's rule names a tier
  // it never registered, refuse to boot rather than ship the request-time
  // hole. Sunrise's built-in rules always resolve (covered by the type union),
  // so this check is load-bearing only for the app-extended slice.
  const unresolved = getEffectiveRateLimitPolicy().filter(
    (rule) => resolveRateLimitTier(rule.tier) === undefined
  );
  if (unresolved.length > 0) {
    const details = unresolved.map((r) => `${String(r.match)} → "${r.tier}"`).join(', ');
    throw new Error(
      `Rate-limit policy references ${unresolved.length} unknown tier(s): ${details}. ` +
        'Either register the tier(s) via registerRateLimitTier(...) in lib/app/rate-limit.ts, ' +
        'or fix the typo in the rule. Boot is aborted rather than shipping silent fail-open.'
    );
  }
} catch (error) {
  logger.error('Failed to register app rate limits from lib/app/rate-limit.ts', {
    error: error instanceof Error ? error.message : String(error),
    hint: 'A throw at module load aborts the middleware bundle. Check lib/app/rate-limit.ts for a registerRateLimitRule/registerRateLimitTier call that violates the registration contract (e.g. a matcher that shadows a Sunrise-protected path, or a tier name that collides with a built-in).',
  });
  throw error;
}

/**
 * Apply the rate-limit policy to an incoming request.
 *
 * Returns a `Response` (status 429) when the cap is exceeded; the caller
 * MUST return that response immediately and skip further middleware /
 * handler execution. Returns `null` when the request is allowed to proceed.
 *
 * Order of operations:
 *   1. Bypass check (`RATE_LIMIT_BYPASS=true` env var, used by the test suite).
 *   2. Find the first matching policy rule. No match → no rate limit.
 *   3. Run the rule's `skip` predicate (if any). True → no rate limit.
 *   4. Build the rate-limit token via the rule's key strategy. Session
 *      resolution happens only for `'session-user'` rules and falls back
 *      to IP if there's no session.
 *   5. Check the section limiter for that token. Allowed → return `null`.
 *      Exceeded → return the standard 429 response with `Retry-After` and
 *      `X-RateLimit-*` headers.
 *
 * Failure modes:
 *   - If session resolution throws (better-auth outage, DB down) we DO NOT
 *     fail-open: we fall back to IP keying so the request still gets a
 *     bucket. The route handler will surface the underlying error.
 *   - If the rule's tier isn't in `RATE_LIMIT_TIERS` (unreachable in
 *     practice — the type system enforces this) we treat it as "no limit"
 *     and log a warning. Open vs closed default here is open: a missing
 *     tier should not break production traffic, only telemetry.
 */
export async function applyRateLimit(request: NextRequest): Promise<Response | null> {
  if (isBypassEnabled()) return null;

  // Evaluate against the effective policy: Sunrise's base rules plus any
  // app-registered rules (spliced ahead of the catch-all). When no app rules
  // are registered this is the base policy by identity — no per-request cost.
  const policy = getEffectiveRateLimitPolicy();

  // First-match-wins, with fall-through on `skip`. A path with two
  // consecutive rules (e.g. the orchestration api-key + session-user pair
  // added in Phase 4) needs the second rule to apply when the first's
  // `skip` fires. `findRateLimitRule` returns the very first path match,
  // so we use it for the typical single-rule case and only iterate the
  // policy directly when that rule's `skip` is true.
  const pathname = request.nextUrl.pathname;
  let rule: RateLimitRule | null = findRateLimitRule(pathname, policy);
  if (rule?.skip?.(request)) {
    rule = null;
    // Re-use the shared matcher so a third matcher shape (or a tweak to the
    // existing string/RegExp semantics) can't silently diverge between
    // `findRateLimitRule` and this fallthrough loop.
    const startIndex = policy.findIndex((r) => pathMatchesRule(r.match, pathname));
    for (let i = startIndex + 1; i < policy.length; i++) {
      const candidate = policy[i];
      if (!pathMatchesRule(candidate.match, pathname)) continue;
      if (candidate.skip?.(request)) continue;
      rule = candidate;
      break;
    }
  }
  if (!rule) return null;

  const limiter: RateLimiter | undefined = resolveRateLimitTier(rule.tier);
  if (!limiter) {
    // Unreachable for built-in rules under normal type-checked code. If it
    // fires, a rule names a tier that `resolveRateLimitTier` can't resolve —
    // either core config drift, or an app rule referencing a tier it never
    // registered via `registerRateLimitTier`. Surface it loudly so operators
    // can fix the config instead of silently failing open.
    logger.warn('Rate-limit policy references an unknown tier; skipping limiter', {
      tier: rule.tier,
      pathname: request.nextUrl.pathname,
    });
    return null;
  }

  const token = await buildToken(rule, request);
  const result = limiter.check(token);
  if (!result.success) {
    return createRateLimitResponse(result);
  }
  return null;
}

/**
 * Whether the test/dev bypass is active. Set `RATE_LIMIT_BYPASS=true` (or `1`)
 * in the environment to short-circuit `applyRateLimit`. Used by
 * `tests/setup.ts` so the vast majority of unit tests never have to think
 * about rate-limiting.
 *
 * The check is intentionally strict — only the canonical `'true'` / `'1'`
 * enable the bypass. Plausible-but-non-canonical strings (`'yes'`, `'on'`,
 * `'TRUE'`) are treated as off, so a stray uppercase or shell-quoting
 * accident in a CI config can't accidentally disable rate limiting.
 *
 * The first call in production logs an error if the bypass is somehow
 * enabled (see {@link warnIfBypassActiveInProduction}).
 */
function isBypassEnabled(): boolean {
  const raw = process.env.RATE_LIMIT_BYPASS;
  const enabled = raw === 'true' || raw === '1';
  if (enabled) warnIfBypassActiveInProduction();
  return enabled;
}

/**
 * Production safeguard. If `RATE_LIMIT_BYPASS` is on while `NODE_ENV` is
 * `'production'`, log an error EVERY TIME the dispatcher would have run —
 * this is a misconfiguration that disables a critical security control, and
 * the only way an operator finds out is via the log stream. Logging once is
 * not enough because production deploys often have multiple workers; one
 * error per worker per request guarantees visibility without flooding (in
 * the correctly-configured case the warning never fires).
 *
 * We do NOT throw or refuse to serve traffic: a hard fail would turn a
 * config mistake into an outage, which is worse than running with bypass.
 * The structured log is the alerting hook.
 */
function warnIfBypassActiveInProduction(): void {
  if (process.env.NODE_ENV !== 'production') return;
  logger.error('RATE_LIMIT_BYPASS=true is set in production — rate limiting is disabled', {
    nodeEnv: process.env.NODE_ENV,
    fix: 'Unset RATE_LIMIT_BYPASS in the production environment.',
  });
}

/**
 * Build the rate-limit token (LRU cache key) for a given rule + request.
 *
 * Tokens are namespaced by tier and key strategy so different sections
 * don't share buckets, and so the middleware's section tokens don't
 * collide with per-flow sub-limiter tokens that route handlers may build
 * with their own conventions (e.g. `audio:user:...`).
 *
 * Format: `mw:${tier}:${key-strategy}:${identifier}`.
 */
async function buildToken(rule: RateLimitRule, request: NextRequest): Promise<string> {
  const id = await resolveIdentifier(rule.key, request);
  return `mw:${rule.tier}:${rule.key}:${id}`;
}

/**
 * Resolve the per-request identifier for the chosen key strategy.
 *
 * - `'ip'` returns the client IP.
 * - `'session-user'` resolves the better-auth session and returns the user
 *   ID. Falls back to `ip:${IP}` if no session (typical for routes the
 *   user hasn't authenticated to yet — they still get a per-IP bucket so
 *   anonymous traffic can't grief authenticated buckets).
 * - `'api-key'` extracts the API key hash from `Authorization: Bearer <key>`.
 *   Falls back to IP if missing.
 * - `'embed-token'` extracts the embed token from the `X-Embed-Token` header
 *   (and combines with IP, mirroring the existing `embed:user:${token}:${ip}`
 *   convention used by the embed chat limiter). Falls back to IP if missing.
 *
 * IP fallback exists because rate-limiting is best-effort defense in depth —
 * if we can't identify the caller more precisely, we still want *some* bucket
 * rather than letting the request through unlimited.
 */
async function resolveIdentifier(key: RateLimitKey, request: NextRequest): Promise<string> {
  const ip = getClientIP(request);

  switch (key) {
    case 'ip':
      return ip;

    case 'session-user': {
      try {
        const session = await auth.api.getSession({ headers: request.headers });
        if (session?.user?.id) return `user:${session.user.id}`;
      } catch {
        // Session resolution failed (auth provider hiccup, DB down). Fall
        // back to IP so we still apply some cap instead of failing open.
      }
      return `ip:${ip}`;
    }

    case 'api-key': {
      const header = request.headers.get('authorization');
      if (header) {
        // `Authorization: Bearer <key>` — use the key value as the bucket
        // identifier. Hashing happens inside the API-key resolution layer;
        // for rate-limiting we just need a stable per-key string.
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (match?.[1]) return `key:${match[1]}`;
      }
      return `ip:${ip}`;
    }

    case 'embed-token': {
      const token = request.headers.get('x-embed-token');
      if (token) return `embed:${token}:${ip}`;
      return `ip:${ip}`;
    }
  }
}
