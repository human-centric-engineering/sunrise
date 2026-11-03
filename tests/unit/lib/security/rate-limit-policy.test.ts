/**
 * Rate-Limit Policy Unit Tests
 *
 * Tests for the policy table (`RATE_LIMIT_POLICY`) and the matcher function
 * (`findRateLimitRule`) in `lib/security/rate-limit-policy.ts`.
 *
 * No mocks needed — the module is a pure data structure + a deterministic
 * string/RegExp matcher with no external dependencies.
 *
 * @see lib/security/rate-limit-policy.ts
 */

import { describe, it, expect } from 'vitest';
import { findRateLimitRule, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';

describe('rate-limit-policy', () => {
  describe('findRateLimitRule — tier resolution', () => {
    it("returns the 'orchestration' tier for orchestration admin paths", () => {
      // Arrange — orchestration path is the most specific; must match before the broader admin rule.
      // Phase 4: orchestration has two rules — an api-key variant (skipped when no Authorization
      // header) and the session-user fallback. Without a Request object, `findRateLimitRule`
      // can't evaluate skip predicates, so it returns the first match (the api-key rule).
      const pathname = '/api/v1/admin/orchestration/agents';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert — the function selected an orchestration rule, not the generic admin rule
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('orchestration');
      expect(rule?.key).toBe('api-key');
    });

    it("returns the 'admin' tier for core admin paths", () => {
      // Arrange — core admin path; orchestration prefix is absent, so it falls through
      // to the second rule (admin) and should NOT match the catch-all api rule
      const pathname = '/api/v1/admin/users';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert — the admin rule was selected with the correct cap and key strategy
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('admin');
      expect(rule?.key).toBe('session-user');
    });

    it("returns the 'auth' tier and 'ip' key for both auth path families", () => {
      // Arrange — Sunrise app-layer auth lives under /api/v1/auth/;
      // better-auth's own endpoints live under /api/auth/ — both must resolve to 'auth'
      const appAuthPath = '/api/v1/auth/login';
      const betterAuthPath = '/api/auth/sign-in';

      // Act
      const appAuthRule = findRateLimitRule(appAuthPath);
      const betterAuthRule = findRateLimitRule(betterAuthPath);

      // Assert — both families keyed on IP (callers have no session yet)
      expect(appAuthRule).not.toBeNull();
      expect(appAuthRule?.tier).toBe('auth');
      expect(appAuthRule?.key).toBe('ip');

      expect(betterAuthRule).not.toBeNull();
      expect(betterAuthRule?.tier).toBe('auth');
      expect(betterAuthRule?.key).toBe('ip');
    });

    it("returns the 'api' catch-all tier for general /api/v1/ paths", () => {
      // Arrange — chat and user-profile paths must not match orchestration, admin, or auth;
      // they land on the section-level catch-all. This locks in that per-flow caps (chatLimiter,
      // audioLimiter) stack ON TOP of this section tier, not below it.
      const chatPath = '/api/v1/chat/stream';
      const userPath = '/api/v1/users/me';

      // Act
      const chatRule = findRateLimitRule(chatPath);
      const userRule = findRateLimitRule(userPath);

      // Assert — both get the default section cap keyed on session-user
      expect(chatRule).not.toBeNull();
      expect(chatRule?.tier).toBe('api');
      expect(chatRule?.key).toBe('session-user');

      expect(userRule).not.toBeNull();
      expect(userRule?.tier).toBe('api');
      expect(userRule?.key).toBe('session-user');
    });

    it("MCP transport paths use the dedicated 'mcp' tier with 'api-key' keying", () => {
      // Arrange — MCP is a distinct interface from the human-facing REST API:
      // server-to-server, always API-key-authenticated, much chattier per
      // session. It gets its own tier (300/min) keyed by API key so two
      // customers sharing a NAT'd egress get independent buckets. This locks
      // in that an MCP request does NOT fall through to the api catch-all,
      // which would key on session-user and (since MCP has no session) fall
      // back to IP — collapsing two customers behind the same egress.
      const pathname = '/api/v1/mcp/anything';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert — tier MUST be 'mcp', not 'api'; key MUST be 'api-key', not 'session-user'
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('mcp');
      expect(rule?.key).toBe('api-key');
    });

    it("the bare /api/v1/mcp path (no trailing slash) also resolves to the 'mcp' tier", () => {
      // Arrange — the MCP rule uses `(\/|$)` boundary so the bare path matches.
      // The Streamable HTTP transport accepts POST/GET/DELETE at /api/v1/mcp
      // directly (no sub-path), and Next.js routes such requests to the same
      // route handler. The rule MUST resolve regardless of trailing slash.
      const pathname = '/api/v1/mcp';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('mcp');
      expect(rule?.key).toBe('api-key');
    });

    it("webhook paths use the 'api' tier with 'api-key' keying", () => {
      // Arrange — webhook callers authenticate via Authorization: Bearer <key>,
      // not session cookies. Keying on the API key (instead of session-user or IP)
      // means each key gets its own bucket — a customer can't grief another
      // customer's webhook budget just by sharing infrastructure.
      const pathname = '/api/v1/webhooks/trigger';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert — same section cap as other api routes (100/min), but keyed differently
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('api');
      expect(rule?.key).toBe('api-key');
    });

    it("embed paths use the 'api' tier with 'embed-token' keying", () => {
      // Arrange — embed widgets are anonymous from a session perspective; the embed
      // token identifies the embedding site. The middleware composes
      // `embed:${token}:${ip}` so two sites with the same token but different IPs
      // (or two anonymous users on the same embedded page) get independent buckets.
      const pathname = '/api/v1/embed/chat';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('api');
      expect(rule?.key).toBe('embed-token');
    });

    it("inbound trigger paths use the 'api' tier with 'ip' keying", () => {
      // Arrange — Slack app-mention webhooks, Postmark inbound email, and generic
      // HMAC-signed senders are server-to-server. No session, no API key in the
      // conventional sense — keyed on the remote IP so a noisy sender can be
      // rate-limited without affecting other channels.
      const pathname = '/api/v1/inbound/slack/agent-slug';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('api');
      expect(rule?.key).toBe('ip');
    });

    it("the contact form path uses the 'api' tier with 'ip' keying", () => {
      // Arrange — contact form is unauthenticated public submission. The
      // per-flow contactLimiter (5/hour) provides the real protection inside
      // the handler; this section tier is defense-in-depth above that.
      const pathname = '/api/v1/contact';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('api');
      expect(rule?.key).toBe('ip');
    });

    it("the waitlist paths use the 'api' tier with 'ip' keying, and only they do", () => {
      // Arrange — join, confirm and leave are anonymous public routes (§125);
      // a session-user key would put every visitor in the IP fallback bucket
      // anyway, but saying so keeps the keying explicit. The matcher must not
      // catch a sibling that merely shares the prefix.
      const waitlist = ['/api/v1/waitlist', '/api/v1/waitlist/confirm', '/api/v1/waitlist?x=1'];

      for (const pathname of waitlist) {
        // Act
        const rule = findRateLimitRule(pathname);

        // Assert
        expect(rule?.tier, pathname).toBe('api');
        expect(rule?.key, pathname).toBe('ip');
      }
      expect(findRateLimitRule('/api/v1/waitlisted-things')?.key).toBe('session-user');
    });

    it('returns null for non-API paths (page routes, static assets, root)', () => {
      // Arrange — middleware should never rate-limit page routes; these paths must
      // fall through all rules and return null so the dispatcher is a no-op.
      const nonApiPaths = ['/admin/users', '/', '/_next/static/foo', '/dashboard'];

      for (const pathname of nonApiPaths) {
        // Act
        const rule = findRateLimitRule(pathname);

        // Assert
        expect(rule, `expected null for path: ${pathname}`).toBeNull();
      }
    });
  });

  describe('findRateLimitRule — first-match-wins ordering', () => {
    it("orchestration path resolves to 'orchestration', not 'admin'", () => {
      // Arrange — /api/v1/admin/orchestration/ starts with /api/v1/admin/ which
      // would match the admin rule if order were wrong. This test is the guard
      // against accidental rule reordering — if orchestration moves below admin,
      // this test fails immediately.
      const pathname = '/api/v1/admin/orchestration/workflows/abc';

      // Act
      const rule = findRateLimitRule(pathname);

      // Assert — the orchestration rule (index 0) won; admin rule (index 1) did not
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('orchestration');
      expect(rule?.tier).not.toBe('admin');
    });

    it('MCP + consumer-specific rules resolve before the api catch-all', () => {
      // Arrange — each non-session-keyed rule (mcp, webhooks, embed, inbound,
      // contact) needs to resolve to its own keying strategy, NOT fall through
      // to the catch-all's 'session-user' key. If any of these is accidentally
      // moved below the catch-all, this test fails: the catch-all matches
      // `/api/v1/anything` so it would silently swallow MCP / webhooks / embed /
      // inbound / contact traffic with the wrong keying. That's a real security
      // regression worth a dedicated guard.
      const cases: Array<[string, 'api-key' | 'embed-token' | 'ip']> = [
        ['/api/v1/mcp', 'api-key'],
        ['/api/v1/mcp/whatever', 'api-key'],
        ['/api/v1/webhooks/trigger', 'api-key'],
        ['/api/v1/embed/chat', 'embed-token'],
        ['/api/v1/inbound/slack/agent-slug', 'ip'],
        ['/api/v1/contact', 'ip'],
        ['/api/v1/waitlist', 'ip'],
        ['/api/v1/waitlist/confirm', 'ip'],
      ];

      for (const [pathname, expectedKey] of cases) {
        // Act
        const rule = findRateLimitRule(pathname);

        // Assert — the consumer-specific rule won; catch-all (which would yield
        // 'session-user') did not. Failure message names the path so the cause
        // is obvious if a rule is moved.
        expect(rule, `expected a rule for ${pathname}`).not.toBeNull();
        expect(rule?.key, `expected ${expectedKey} keying for ${pathname}`).toBe(expectedKey);
        expect(rule?.key, `${pathname} should not fall through to session-user`).not.toBe(
          'session-user'
        );
      }
    });
  });

  describe('RATE_LIMIT_POLICY — declared order', () => {
    it('policy array is ordered from most-specific to least-specific', () => {
      // Assert — ordering IS the API. If someone reorders the array, this test
      // surfaces the breakage immediately. The order here encodes the
      // first-match-wins contract explicitly so it can be verified without
      // running path matching. Tiers alone aren't enough to disambiguate (most
      // consumer rules share the 'api' tier) so we also assert the key strategy.
      // Phase 4: orchestration has two consecutive rules — api-key variant
      // (skipped when no Authorization Bearer header) and the session-user
      // fallback. Both target the same `tier: 'orchestration'` cap.
      expect(RATE_LIMIT_POLICY[0]).toMatchObject({ tier: 'orchestration', key: 'api-key' });
      expect(RATE_LIMIT_POLICY[1]).toMatchObject({ tier: 'orchestration', key: 'session-user' });
      expect(RATE_LIMIT_POLICY[2].tier).toBe('admin');
      expect(RATE_LIMIT_POLICY[3].tier).toBe('auth'); // /api/v1/auth/
      expect(RATE_LIMIT_POLICY[4].tier).toBe('auth'); // /api/auth/ (better-auth routes)
      // MCP transport — distinct interface, distinct tier, before the api consumer block.
      expect(RATE_LIMIT_POLICY[5]).toMatchObject({ tier: 'mcp', key: 'api-key' }); // mcp
      // Consumer-specific rules — same tier ('api') but distinct keying.
      expect(RATE_LIMIT_POLICY[6]).toMatchObject({ tier: 'api', key: 'api-key' }); // webhooks
      expect(RATE_LIMIT_POLICY[7]).toMatchObject({ tier: 'api', key: 'embed-token' }); // embed
      expect(RATE_LIMIT_POLICY[8]).toMatchObject({ tier: 'api', key: 'ip' }); // inbound
      expect(RATE_LIMIT_POLICY[9]).toMatchObject({ tier: 'api', key: 'ip' }); // contact
      expect(RATE_LIMIT_POLICY[10]).toMatchObject({ tier: 'api', key: 'ip' }); // waitlist
      // Catch-all — must remain LAST so the consumer rules above it have a chance to match.
      expect(RATE_LIMIT_POLICY[11]).toMatchObject({ tier: 'api', key: 'session-user' });
    });

    it('has exactly 12 rules (catches unintended additions or deletions)', () => {
      // A length change is a signal that the policy changed. This test surfaces
      // that signal without being prescriptive about what was added/removed.
      expect(RATE_LIMIT_POLICY).toHaveLength(12);
    });
  });

  describe('/api/auth/** skip predicate — credential vs non-credential routes', () => {
    // The /api/auth/ rule applies the 5/min auth cap, but its skip predicate
    // restricts that cap to credential endpoints only. Non-credential routes
    // (get-session, sign-out, OAuth callbacks) are matched but skipped, so
    // legitimate users on shared NATs don't collectively hit 5/min on
    // session refreshes. This describe block locks in which paths get capped
    // and which get skipped — drift in either direction is a regression.

    const betterAuthRule = RATE_LIMIT_POLICY.find(
      (r) => r.match instanceof RegExp && r.match.source === '^\\/api\\/auth\\/'
    );

    function makeRequest(pathname: string): Request {
      return new Request(`http://localhost:3000${pathname}`);
    }

    it('the better-auth rule has a skip predicate attached', () => {
      // Arrange + Assert: the rule exists and the skip predicate is wired.
      // Without this, the test below would silently pass (skip would be
      // undefined and never called).
      expect(betterAuthRule).toBeDefined();
      expect(betterAuthRule?.skip).toBeTypeOf('function');
    });

    it.each([
      '/api/auth/sign-in',
      '/api/auth/sign-in/email',
      '/api/auth/sign-up',
      '/api/auth/sign-up/email',
      '/api/auth/forget-password',
      '/api/auth/reset-password',
      '/api/auth/send-verification-email',
      '/api/auth/verify-email',
      '/api/auth/change-password',
      '/api/auth/accept-invite',
    ])('does NOT skip credential endpoint %s (returns false → 5/min cap applies)', (pathname) => {
      // Act
      const skipped = betterAuthRule?.skip?.(makeRequest(pathname));

      // Assert: skip returned false → the dispatcher will apply the auth tier
      // cap. These are the endpoints OWASP brute-force guidance targets.
      expect(skipped).toBe(false);
    });

    it.each([
      '/api/auth/get-session',
      '/api/auth/sign-out',
      '/api/auth/callback/google',
      '/api/auth/callback/github',
      '/api/auth/list-sessions',
      '/api/auth/revoke-session',
      '/api/auth/revoke-sessions',
    ])(
      'skips non-credential endpoint %s (returns true → no rate limit at middleware layer)',
      (pathname) => {
        // Act
        const skipped = betterAuthRule?.skip?.(makeRequest(pathname));

        // Assert: skip returned true → the dispatcher bypasses rate limiting.
        // Non-credential routes are not brute-force surfaces; capping them at
        // 5/min would produce spurious 429s on shared-NAT session refreshes.
        expect(skipped).toBe(true);
      }
    );

    it('does not match credential-prefix-but-not-credential paths (e.g. /api/auth/sign-in-helper)', () => {
      // Arrange: a hypothetical future route whose name starts with a credential
      // prefix but isn't itself a credential endpoint. The pattern uses
      // `(\/|$|\?)` after the credential name to prevent prefix-match drift.
      // E.g. `/api/auth/sign-in-helper` should be skipped (not capped) because
      // it isn't `/api/auth/sign-in` itself.

      // Act
      const skipped = betterAuthRule?.skip?.(makeRequest('/api/auth/sign-in-helper'));

      // Assert: skip returned true — the credential pattern only matches
      // exact-prefix-followed-by-boundary, so unrelated paths fall through.
      expect(skipped).toBe(true);
    });

    it('matches credential paths with query strings (e.g. /api/auth/sign-in?callback=...)', () => {
      // Arrange: better-auth often appends query strings to credential flows
      // (callback URLs, error params). The `(\/|$|\?)` boundary in the pattern
      // explicitly handles the `?` separator so these are still capped.

      // Act
      const skipped = betterAuthRule?.skip?.(
        makeRequest('/api/auth/sign-in?callbackUrl=/dashboard')
      );

      // Assert: skip returned false — query strings on credential paths
      // must NOT bypass the brute-force cap.
      expect(skipped).toBe(false);
    });
  });

  describe('findRateLimitRule — string-prefix match support', () => {
    // `RateLimitRule.match` accepts `RegExp | string`. When `match` is a string,
    // `findRateLimitRule` falls back to `pathname.startsWith(match)`. The current
    // production policy uses only RegExp rules, so the string-prefix branch isn't
    // exercised by the tier-resolution suite above. We pass a synthetic policy
    // directly to the real `findRateLimitRule` (its second arg, defaulted to
    // RATE_LIMIT_POLICY in production) so these tests exercise the actual source
    // code path — not a copy.

    const stringPrefixPolicy: import('@/lib/security/rate-limit-policy').RateLimitRule[] = [
      { match: '/test-prefix/', tier: 'api', key: 'ip' },
    ];

    it('matches a pathname that starts with the string prefix', () => {
      // Act: pathname starts with the string prefix
      const rule = findRateLimitRule('/test-prefix/sub/path', stringPrefixPolicy);

      // Assert: the `typeof rule.match === 'string'` branch in the source ran
      // `pathname.startsWith(rule.match)` and returned the matching rule.
      expect(rule).not.toBeNull();
      expect(rule?.tier).toBe('api');
      expect(rule?.key).toBe('ip');
    });

    it('returns null for a pathname that does not start with the string prefix', () => {
      // Act: completely unrelated path
      const rule = findRateLimitRule('/other-path/foo', stringPrefixPolicy);

      // Assert: no match → null
      expect(rule).toBeNull();
    });

    it('does not match when the pathname equals the prefix without a trailing slash', () => {
      // Arrange: prefix is '/test-prefix/' (WITH trailing slash).
      // '/test-prefix' (NO trailing slash) does NOT start with '/test-prefix/'
      // so it must NOT match — this locks in the exact startsWith() semantics.

      // Act
      const rule = findRateLimitRule('/test-prefix', stringPrefixPolicy);

      // Assert: no match — this is the key boundary condition for string-prefix rules
      expect(rule).toBeNull();
    });

    it('preserves first-match-wins ordering for mixed string+RegExp policies', () => {
      // Arrange: a string rule shadows a more permissive RegExp catch-all that
      // would otherwise match. This proves the loop runs the per-rule check
      // (string OR RegExp) and bails on the first match — the branch interleaving
      // is the source-level contract worth locking in.
      const mixedPolicy: import('@/lib/security/rate-limit-policy').RateLimitRule[] = [
        { match: '/test-prefix/', tier: 'admin', key: 'ip' },
        { match: /.*/, tier: 'api', key: 'session-user' },
      ];

      const matchingPath = findRateLimitRule('/test-prefix/foo', mixedPolicy);
      const nonMatchingPath = findRateLimitRule('/other/path', mixedPolicy);

      // Assert
      expect(matchingPath?.tier).toBe('admin'); // string rule won
      expect(nonMatchingPath?.tier).toBe('api'); // fell through to RegExp catch-all
    });

    it('uses the production policy when called with one argument (defaulted policy)', () => {
      // Arrange: the no-arg form (default `policy = RATE_LIMIT_POLICY`) must
      // behave identically to the production callers. This guards against
      // someone accidentally inverting the default in a future refactor.
      const adminPath = findRateLimitRule('/api/v1/admin/users');
      const orchPath = findRateLimitRule('/api/v1/admin/orchestration/agents');

      // Assert: matches what the production policy table declares
      expect(adminPath?.tier).toBe('admin');
      expect(orchPath?.tier).toBe('orchestration');
    });
  });
});
