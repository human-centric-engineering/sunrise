/**
 * Rate-Limit Policy Table
 *
 * Single source of truth for which rate-limit tier applies to which API path.
 * Consumed by `lib/security/rate-limit-middleware.ts`, which runs from
 * `proxy.ts` at the project root on every API request (Next.js 16 renamed the
 * `middleware.ts` file convention to `proxy.ts`).
 *
 * **This is the canonical rate-limit configuration for Sunrise.** Reviewing
 * rate-limit policy = reviewing this one file. Adding a new section to the
 * admin surface, splitting a tier, raising a cap — all happen here, never in
 * route handlers.
 *
 * Route handlers do NOT call section limiters directly. The only acceptable
 * in-handler rate-limit call is an additive *per-flow* cap (e.g.
 * `chatLimiter`, `audioLimiter`, `imageLimiter` for the expensive chat-stream
 * flows). Those layer on top of the section tier applied by the middleware.
 *
 * @see lib/security/rate-limit-middleware.ts — the dispatcher that consumes this table
 * @see lib/security/rate-limit.ts — tier definitions and limiter instances
 * @see proxy.ts — project-root wiring
 */

import type { RateLimitTier } from '@/lib/security/rate-limit';

/**
 * How the caller is identified when building the rate-limit token.
 *
 * - `'ip'` — keyed on the client IP only. Use when the session can't (or
 *   shouldn't) be resolved at middleware time, e.g. authentication flows
 *   where the caller has no session yet, or webhook ingress where the source
 *   is identified by signature rather than session.
 * - `'session-user'` — keyed on the better-auth `session.user.id`. Falls back
 *   to IP if no session is present (the route handler will surface 401 if it
 *   requires auth — the rate-limit middleware doesn't enforce auth, it
 *   protects against abuse on top of whatever the route itself enforces).
 * - `'api-key'` — keyed on the API key hash from the `Authorization` header.
 *   Falls back to IP if no key. Used for routes that accept programmatic
 *   access via API keys instead of cookie sessions.
 * - `'embed-token'` — keyed on the embed token + client IP. Used for embedded
 *   widget surfaces where the caller is anonymous but the token identifies
 *   the embedding site.
 */
export type RateLimitKey = 'ip' | 'session-user' | 'api-key' | 'embed-token';

/**
 * One rule in the rate-limit policy table.
 *
 * Rules are evaluated in declaration order. **First match wins** — list the
 * most specific path patterns first.
 */
export interface RateLimitRule {
  /**
   * Path matcher. `RegExp` is preferred for precision; a literal string
   * matches as a prefix (e.g. `'/api/v1/admin/'` matches anything under that
   * prefix). The matched value is `request.nextUrl.pathname`.
   */
  match: RegExp | string;

  /**
   * Which tier (limiter + cap) to apply. Resolved at request time via
   * `resolveRateLimitTier` (built-in tiers + app-registered tiers).
   *
   * Built-in Sunrise rules use a {@link RateLimitTier} literal. App-registered
   * rules (see {@link registerRateLimitRule}) may name a tier created via
   * `registerRateLimitTier`, hence the widening to `string` — the literal union
   * is kept in the type for editor autocomplete on the built-in names.
   */
  tier: RateLimitTier | (string & {});

  /** How to identify the caller. See {@link RateLimitKey}. */
  key: RateLimitKey;

  /**
   * Optional predicate. When it returns `true`, skip rate-limiting for this
   * specific request even when the path matches. Useful for trusted internal
   * callers (e.g. a request bearing a service-account header) or feature
   * flags that selectively disable the cap.
   *
   * Receives the raw `Request` so it can inspect headers, URL, etc. — but
   * NOT the session (session resolution happens after the rule fires).
   */
  skip?: (request: Request) => boolean;
}

/**
 * Credential-surface paths under `/api/auth/**` that warrant the OWASP-grade
 * 5/min brute-force cap. Anything else under `/api/auth/**` (`get-session`,
 * `sign-out`, OAuth `callback/*`, `list-sessions`, `revoke-session`) is high-
 * frequency / bursty-but-legitimate traffic and is skipped by
 * {@link skipNonCredentialAuthRoutes} so legitimate users on shared NATs don't
 * collectively hit the cap on session refreshes.
 */
const CREDENTIAL_AUTH_PATTERN =
  /^\/api\/auth\/(sign-in|sign-up|forget-password|reset-password|send-verification-email|verify-email|change-password|accept-invite)(\/|$|\?)/;

/**
 * Skip predicate for the `/api/auth/**` rule. Returns `true` (skip rate
 * limiting) for non-credential auth endpoints; returns `false` (apply the
 * 5/min auth cap) for credential endpoints.
 */
function skipNonCredentialAuthRoutes(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return !CREDENTIAL_AUTH_PATTERN.test(pathname);
}

/**
 * The `/api/v1/**` catch-all rule — the final fallback before requests escape
 * the policy. Exported as a named const so:
 *   1. `getEffectiveRateLimitPolicy` can identity-compare on the last element
 *      and throw at startup if some future PR ever shifts it off the tail.
 *   2. Tests can reference the same object instead of structural matching.
 *
 * Declared above {@link RATE_LIMIT_POLICY} because the policy literal embeds
 * this reference (declaration order; `const` is not hoisted).
 */
export const CATCH_ALL_RULE: RateLimitRule = {
  match: /^\/api\/v1\//,
  tier: 'api',
  key: 'session-user',
};

/**
 * The rate-limit policy.
 *
 * **Ordering matters.** Each request is matched against rules top-to-bottom;
 * the first match wins. List sub-sections before parent sections, and tighter
 * (more specific) paths before broader ones.
 *
 * The default `'api'` tier at the bottom catches any `/api/v1/**` route that
 * doesn't match a more specific rule — including future routes added by
 * downstream forks. New forks inherit reasonable protection on day one
 * without having to remember anything.
 */
export const RATE_LIMIT_POLICY: readonly RateLimitRule[] = [
  // ── Admin surface ────────────────────────────────────────────────────────
  // Orchestration UI is the chatty admin surface — agents, workflows,
  // knowledge, executions. Looser cap (120/min) to absorb editor traffic
  // where one user action fans out into several list/validate/preview calls.
  //
  // Phase 4 (CI eval gate): admin-scoped API keys can hit these endpoints
  // headlessly. When an `Authorization: Bearer sk_...` header is present we
  // key on the API key so CI runs from a shared IP don't share a bucket
  // with cookie sessions on the same host. Without the header we skip this
  // rule and fall through to the cookie-keyed rule below.
  {
    match: /^\/api\/v1\/admin\/orchestration\//,
    tier: 'orchestration',
    key: 'api-key',
    skip: (req) => !/^Bearer\s+sk_/i.test(req.headers.get('authorization') ?? ''),
  },
  {
    match: /^\/api\/v1\/admin\/orchestration\//,
    tier: 'orchestration',
    key: 'session-user',
  },

  // Core admin endpoints — users, logs, feature flags, invitations, stats.
  // Tighter cap (30/min) — these endpoints aren't part of any chatty UI
  // workflow and benefit from defense-in-depth against compromised
  // admin accounts.
  {
    match: /^\/api\/v1\/admin\//,
    tier: 'admin',
    key: 'session-user',
  },

  // ── Authentication surface ───────────────────────────────────────────────
  // Login, signup, password reset, verification. Keyed on IP (no session
  // yet) and capped tight (5/min) per OWASP brute-force guidance.
  // better-auth's own endpoints live under /api/auth/** — Sunrise's
  // application-layer auth lives under /api/v1/auth/**.
  //
  // The /api/auth/** rule matches every better-auth endpoint but ALSO
  // matches frequent non-credential reads — `get-session` fires on every
  // page focus, `sign-out` is one-shot but legitimate, and OAuth provider
  // callbacks are bursty by design. The skip predicate keeps the 5/min
  // brute-force cap targeted at the credential surface (sign-in, sign-up,
  // forget-password, reset-password, send-verification-email, verify-email,
  // change-password, accept-invite) and lets the rest through unrated at
  // the middleware layer — matching the pre-refactor behaviour and
  // preventing spurious 429s on shared-NAT session refreshes.
  {
    match: /^\/api\/v1\/auth\//,
    tier: 'auth',
    key: 'ip',
  },
  {
    match: /^\/api\/auth\//,
    tier: 'auth',
    key: 'ip',
    skip: skipNonCredentialAuthRoutes,
  },

  // ── MCP transport (LLM-agent interface) ──────────────────────────────────
  // MCP is a distinct interface from the human-facing REST API: server-to-
  // server, always API-key-authenticated, much chattier per session (agents
  // iterate through tool calls inside a conversation). It gets its own tier
  // (300/min by default — override with `RATE_LIMIT_MCP`) keyed by api-key
  // so two customers sharing a NAT'd egress get independent buckets. The
  // per-customer budget knob is `McpRateLimiter` inside the handler, sized
  // from the `apiKey.rateLimit` field; this section tier is the coarse
  // ceiling above it.
  {
    match: /^\/api\/v1\/mcp(\/|$)/,
    tier: 'mcp',
    key: 'api-key',
  },

  // ── Consumer surfaces with non-session keying ────────────────────────────
  // These all use the `'api'` tier (100/min) for the section cap, but the
  // *keying* differs from the default `session-user` because the caller's
  // identity is established by something other than a session cookie.
  // Per-flow tighter caps (apiKeyChatLimiter, embedChatLimiter, inboundLimiter,
  // contactLimiter) layer on top inside their respective handlers.

  // Webhook triggers authenticate via API key (Authorization: Bearer <key>);
  // there is no user session, and keying on IP would incorrectly group all
  // calls from a single sender even if they hold distinct keys.
  {
    match: /^\/api\/v1\/webhooks\//,
    tier: 'api',
    key: 'api-key',
  },
  // Embed widgets are anonymous; the embed token identifies the embedding
  // site. Token + IP composite (built by the middleware) mirrors the
  // long-shipping `embed:user:${token}:${ip}` convention used by the
  // per-flow `embedChatLimiter`.
  {
    match: /^\/api\/v1\/embed\//,
    tier: 'api',
    key: 'embed-token',
  },
  // Inbound triggers (Slack app-mention webhooks, Postmark email parses,
  // generic HMAC-signed senders) are server-to-server. No session, no
  // API key in the conventional sense — keyed on the remote IP.
  {
    match: /^\/api\/v1\/inbound\//,
    tier: 'api',
    key: 'ip',
  },
  // Contact form is unauthenticated public submission. Per-flow
  // contactLimiter inside the handler enforces the tight 5/hour cap;
  // the section tier here is a defense-in-depth upper bound.
  {
    match: /^\/api\/v1\/contact/,
    tier: 'api',
    key: 'ip',
  },

  // ── General authenticated API ────────────────────────────────────────────
  // Catch-all for every other route under /api/v1/. Default 100/min,
  // keyed on session. Anonymous traffic falls back to IP keying inside
  // the middleware. Routes that need a TIGHTER per-flow cap on top of
  // this (chat-stream, audio, image, upload, invite, password-reset, etc.)
  // keep their sub-limiter call in the handler — it's additive to this
  // section tier.
  //
  // The catch-all is exported as a named const so `getEffectiveRateLimitPolicy`
  // can runtime-assert it stays last: app rules are spliced in just ahead of
  // it, and a future PR appending another rule after `CATCH_ALL_RULE` would
  // silently put app rules in the wrong slot (they'd never match). Identity
  // check turns that subtle ordering bug into a loud fail-fast at startup.
  CATCH_ALL_RULE,
];

/**
 * Find the first policy rule whose `match` accepts the given pathname.
 *
 * Returns `null` if no rule matches — the middleware treats that as
 * "don't rate-limit this request" (typical for non-API routes like
 * `/admin/users` page or static assets, which the middleware matcher
 * should already have excluded, but we double-check anyway).
 *
 * The `policy` parameter defaults to {@link getEffectiveRateLimitPolicy} —
 * the base policy spliced with any app-registered rules — so a caller that
 * doesn't pass `policy` still sees app rules. Defaulting to the bare
 * `RATE_LIMIT_POLICY` would silently bypass the fork-readiness extension and
 * leave any future caller routing on Sunrise rules only. The optional
 * argument exists so unit tests can exercise the matcher against a synthetic
 * policy without needing module-level mocks.
 */
export function findRateLimitRule(
  pathname: string,
  policy: readonly RateLimitRule[] = getEffectiveRateLimitPolicy()
): RateLimitRule | null {
  for (const rule of policy) {
    if (pathMatchesRule(rule.match, pathname)) return rule;
  }
  return null;
}

/**
 * Whether a rule's `match` accepts `pathname`. String matchers are prefix
 * (`startsWith`) matches; `RegExp` matchers use `.test()`. Shared by
 * {@link findRateLimitRule}, the app-rule security guard, AND the middleware's
 * skip-fallthrough loop so all three agree on exactly what "this rule could
 * fire for this path" means — a previous inline copy in the middleware
 * drifted from this version once, hence the export.
 */
export function pathMatchesRule(match: RegExp | string, pathname: string): boolean {
  return typeof match === 'string' ? pathname.startsWith(match) : match.test(pathname);
}

// =============================================================================
// App-Extensible Policy Rules (fork-readiness seam 13)
// =============================================================================

/**
 * Canonical namespace prefixes representing every Sunrise-owned protected
 * surface. An app-registered rule is REJECTED if its matcher fires for any
 * path under these prefixes — see {@link registerRateLimitRule}.
 *
 * Namespace prefixes (rather than specific endpoint paths) so this list stays
 * stable as Sunrise adds new admin / auth / MCP endpoints under these roots —
 * a new endpoint like `/api/v1/admin/billing/` is automatically covered
 * because the prefix probe `/api/v1/admin/anything-goes-here` matches it
 * against any app matcher broad enough to fire on the namespace. Previously
 * each endpoint had its own probe entry which drifted from the policy each
 * time a new admin surface landed.
 *
 * Each probe is a representative sub-path under the namespace — `*-probe-*`
 * sentinels are deliberate gibberish that no real route uses, so a
 * regex-style matcher that's overly precise (e.g. `/^\/api\/v1\/admin\/users$/`)
 * still gets caught by the broader-namespace coverage we care about.
 *
 * Covers: `/api/v1/admin/**` · `/api/auth/**` · `/api/v1/auth/**` ·
 * `/api/v1/mcp(\/|$)`.
 */
const PROTECTED_PATH_PROBES: readonly string[] = [
  '/api/v1/admin/-probe-', // any path under /api/v1/admin/
  '/api/auth/-probe-', // any path under /api/auth/
  '/api/v1/auth/-probe-', // any path under /api/v1/auth/ (Sunrise app-layer auth)
  '/api/v1/mcp', // MCP transport (bare)
  '/api/v1/mcp/-probe-', // any path under /api/v1/mcp/
];

/** App-registered rules, in registration order. See {@link registerRateLimitRule}. */
const appRules: RateLimitRule[] = [];

/**
 * Memoised effective policy — recomputed only when `appRules` changes. The
 * middleware now defaults to `getEffectiveRateLimitPolicy()` (see
 * {@link findRateLimitRule}), so this fires on every request; recomputing
 * `[...head, ...appRules, CATCH_ALL_RULE]` every time would be a wasted
 * allocation once any app rule is registered. `null` means "needs recompute"
 * (initial state, after register, after reset).
 */
let effectivePolicyCache: readonly RateLimitRule[] | null = null;

/**
 * Register an app/fork rate-limit rule.
 *
 * The rule is inserted into the effective policy AFTER every built-in Sunrise
 * rule (the admin/auth/mcp protected rules and the consumer-surface rules) and
 * BEFORE the `/^\/api\/v1\//` catch-all — so an app can give its own namespace
 * a distinct tier/keying without having to restate, or accidentally shadow, any
 * Sunrise rule.
 *
 * **Security constraint.** App rules may only govern the app's own paths. A
 * rule whose matcher could fire for a Sunrise-protected surface
 * (`/api/v1/admin/**`, `/api/auth/**`, `/api/v1/auth/**`, `/api/v1/mcp/**`) is
 * REJECTED at registration — otherwise a fork could loosen the 30/min admin cap
 * or re-key the brute-force auth cap to IP, a privilege-escalation / DoS vector.
 * The check probes the matcher against {@link PROTECTED_PATH_PROBES}; a broad
 * regex like `/^\/api\/v1\//` is rejected because it matches the admin probe.
 *
 * Intended to run once at startup (before the first request).
 *
 * @throws if the rule's matcher could fire for a Sunrise-protected path.
 */
export function registerRateLimitRule(rule: RateLimitRule): void {
  for (const probe of PROTECTED_PATH_PROBES) {
    if (pathMatchesRule(rule.match, probe)) {
      throw new Error(
        `registerRateLimitRule: matcher ${String(rule.match)} would shadow the Sunrise-protected ` +
          `path "${probe}". App rules must be scoped to the app's own /api/v1 namespace and may ` +
          'not match admin, auth, or MCP surfaces.'
      );
    }
  }
  // Dedupe by reference — Next.js HMR re-evaluates the middleware module on
  // file changes and re-runs `registerAppRateLimits()`. Without this, every
  // hot-reload would append another copy of the same rule, growing the policy
  // iteration on every request (functionally idempotent thanks to first-match-
  // wins, but unbounded growth). A reference check is enough for HMR-of-
  // middleware-only; if the fork edits `lib/app/rate-limit.ts` itself, the
  // rule literal is a fresh reference and a duplicate would slip through —
  // accepted, since changing your registrations should restart the dev server.
  if (appRules.includes(rule)) return;
  appRules.push(rule);
  effectivePolicyCache = null; // invalidate — registration is a structural change
}

/**
 * The effective policy the middleware evaluates: the base {@link RATE_LIMIT_POLICY}
 * with any app-registered rules spliced in just ahead of the catch-all.
 *
 * Returns the base policy unchanged when no app rules are registered (the
 * common case — Sunrise itself registers none), avoiding a per-request array
 * allocation. When app rules ARE registered, the composed array is memoised
 * in `effectivePolicyCache` so repeated calls (the middleware default now
 * invokes this on every request) don't reallocate; the cache invalidates on
 * `registerRateLimitRule` and `__resetAppRateLimitRules`.
 *
 * Runtime-asserts that {@link CATCH_ALL_RULE} is still the last element of
 * `RATE_LIMIT_POLICY` — a future PR appending another rule after the catch-all
 * would silently put app rules in the wrong slot (they'd never match), so we
 * fail fast at first call instead of letting it ship as silent dead-rule debt.
 */
export function getEffectiveRateLimitPolicy(): readonly RateLimitRule[] {
  // Identity check — structural match would let a copy slip past, so compare
  // against the exported reference the policy literal embedded.
  if (RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1] !== CATCH_ALL_RULE) {
    throw new Error(
      'rate-limit policy invariant violated: CATCH_ALL_RULE is no longer the last element of ' +
        'RATE_LIMIT_POLICY. App rules splice in just ahead of the catch-all; if something else ' +
        'is at the tail, app rules would be inserted in the wrong slot and never match. ' +
        'Move CATCH_ALL_RULE back to the end of the policy array.'
    );
  }
  if (appRules.length === 0) return RATE_LIMIT_POLICY;
  if (effectivePolicyCache !== null) return effectivePolicyCache;
  // App rules go immediately before the catch-all: after all specific Sunrise
  // rules, ahead of the fallback.
  const head = RATE_LIMIT_POLICY.slice(0, -1);
  effectivePolicyCache = [...head, ...appRules, CATCH_ALL_RULE];
  return effectivePolicyCache;
}

/**
 * Test-only: drop all app-registered rules. Production code never calls this —
 * registration is a one-time startup action. Exposed so tests that register
 * rules can isolate themselves.
 */
export function __resetAppRateLimitRules(): void {
  appRules.length = 0;
  effectivePolicyCache = null;
}
