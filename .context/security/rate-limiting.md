# Rate Limiting

Rate-limit enforcement for every `/api/**` request in Sunrise. Section caps are applied centrally in `proxy.ts` via a policy table; per-flow tighter caps live in handlers as additive checks on expensive sub-flows.

## Quick Reference

**Adding a new section cap** — edit one file: [`lib/security/rate-limit-policy.ts`](../../lib/security/rate-limit-policy.ts).

**Adding a per-flow sub-cap inside a handler** — import the relevant limiter (e.g. `chatLimiter`, `audioLimiter`) from `@/lib/security/rate-limit` and call it after auth.

| Need                                | Where                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Change which paths get which tier   | `lib/security/rate-limit-policy.ts` (the policy table)                                                   |
| Change a tier's cap                 | `lib/security/constants.ts` (`LIMITS.*`) or an env var                                                   |
| Add a new built-in tier             | `RateLimitTier` union + `RATE_LIMIT_TIERS` registry in `lib/security/rate-limit.ts`                      |
| Add an **app/fork** tier or rule    | `registerRateLimitTier()` / `registerRateLimitRule()` — see [App / Fork Extension](#app--fork-extension) |
| Add a per-flow sub-cap to a handler | Import the limiter from `@/lib/security/rate-limit`, call it inline                                      |
| Disable rate-limiting in tests      | `RATE_LIMIT_BYPASS=true` (set in `tests/setup.ts` for all unit tests)                                    |

## Architecture

Two layers, each owning a distinct responsibility:

```
┌─ Request hits proxy.ts ──────────────────────────────────┐
│                                                          │
│  1. Origin validation (CSRF defense)                     │
│  2. applyRateLimit(request)  ← SECTION CAP applied here  │
│       └─ getEffectiveRateLimitPolicy() → base + app rules│
│       └─ findRateLimitRule(pathname, policy) → rule      │
│       └─ resolveIdentifier(key, request) → token         │
│       └─ resolveRateLimitTier(tier).check(token)         │
│  3. Auth / redirects / security headers                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌─ Route handler ──────────────────────────────────────────┐
│                                                          │
│  - Per-flow SUB-CAP applied here (optional, additive):   │
│    chatLimiter, audioLimiter, imageLimiter,              │
│    contactLimiter, inboundLimiter, embedChatLimiter,     │
│    passwordResetLimiter, agentChatLimiter,               │
│    apiKeyChatLimiter, uploadLimiter, inviteLimiter, etc. │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Section caps** are the broad "this entire surface gets N/min" protection. They live in the [policy table](../../lib/security/rate-limit-policy.ts), are applied by [`applyRateLimit`](../../lib/security/rate-limit-middleware.ts), and route handlers do NOT call them directly.

**Per-flow sub-caps** are tighter limits on specific expensive operations (chat streaming, audio transcription, image attachments, contact form submissions). They stay in route handlers as additive checks against dedicated limiters.

A request to `/api/v1/admin/orchestration/chat/stream` gets BOTH: the orchestration section tier (120/min per admin user) AND the chat sub-cap (20/min per admin user) inside the handler. The two caps share no buckets — they're applied to different limiter instances with different keying.

## The Policy Table

Single source of truth. First match wins; rules are evaluated top to bottom.

| #   | Path matcher                   | Tier            | Key strategy   | Notes                                                  |
| --- | ------------------------------ | --------------- | -------------- | ------------------------------------------------------ |
| 1   | `/api/v1/admin/orchestration/` | `orchestration` | `session-user` | 120/min — chatty editor UI                             |
| 2   | `/api/v1/admin/`               | `admin`         | `session-user` | 30/min — core admin (users, logs, invitations, flags)  |
| 3   | `/api/v1/auth/`                | `auth`          | `ip`           | 5/min — app-layer auth endpoints                       |
| 4   | `/api/auth/`                   | `auth`          | `ip`           | 5/min — better-auth's own routes                       |
| 5   | `/api/v1/mcp/`                 | `mcp`           | `api-key`      | 300/min — LLM-agent transport keyed per api-key        |
| 6   | `/api/v1/webhooks/`            | `api`           | `api-key`      | 100/min keyed on `Authorization: Bearer <key>`         |
| 7   | `/api/v1/embed/`               | `api`           | `embed-token`  | 100/min keyed on `X-Embed-Token` header + IP composite |
| 8   | `/api/v1/inbound/`             | `api`           | `ip`           | 100/min — server-to-server (Slack, Postmark, etc.)     |
| 9   | `/api/v1/contact`              | `api`           | `ip`           | 100/min — unauthenticated public submission            |
| 10  | `/api/v1/` (catch-all)         | `api`           | `session-user` | 100/min — everything else                              |

**Order matters.** The orchestration rule (1) must come before the broader admin rule (2) — otherwise `/api/v1/admin/orchestration/agents` would match `/api/v1/admin/` first and land on the tighter 30/min admin tier. The MCP rule (5) and the consumer-specific rules (6–9) must come before the catch-all (10) — otherwise MCP would key on session-user (and fall back to IP, defeating the api-key keying), webhooks would key on session-user, and so on.

Tests in `tests/unit/lib/security/rate-limit-policy.test.ts` lock the order in place.

## Section Tiers

Five section tiers, each backed by a single limiter instance in [`RATE_LIMIT_TIERS`](../../lib/security/rate-limit.ts):

| Tier            | Cap     | Env override            | Limiter                     |
| --------------- | ------- | ----------------------- | --------------------------- |
| `admin`         | 30/min  | `RATE_LIMIT_ADMIN`      | `adminLimiter`              |
| `orchestration` | 120/min | `RATE_LIMIT_ORCH_ADMIN` | `orchestrationAdminLimiter` |
| `api`           | 100/min | `RATE_LIMIT_API`        | `apiLimiter`                |
| `mcp`           | 300/min | `RATE_LIMIT_MCP`        | `mcpLimiter`                |
| `auth`          | 5/min   | `RATE_LIMIT_AUTH`       | `authLimiter`               |

Caps are per-window (1 minute) using the sliding-window algorithm from `lib/security/rate-limit.ts`. Bumps via env vars are intended for development; production should run on the defaults. The `auth` cap is the OWASP brute-force floor — `RATE_LIMIT_AUTH` exists for parity (and the occasional shared-NAT dev loosen), but raise it in production only with a clear reason.

**Why `mcp` is separate from `api`.** MCP is a distinct interface — server-to-server, always API-key-authenticated, much chattier per session than human-driven REST traffic (LLM agents iterate through tool calls inside a conversation). The 100/min `api` cap is too tight for legitimate agent workloads; the 300/min default leaves room for normal activity while still rate-limiting a runaway agent loop within ~5 seconds. Per-customer budgets are tunable separately via `McpRateLimiter` against the `apiKey.rateLimit` field; the section tier here is the coarse ceiling above that.

## Key Strategies

How the dispatcher identifies the caller when building the bucket token. Token format: `mw:${tier}:${key}:${identifier}`.

| Strategy       | Identifier source                                                      | Fallback                 |
| -------------- | ---------------------------------------------------------------------- | ------------------------ |
| `ip`           | `getClientIP(request)` — `X-Forwarded-For` (leftmost) then `X-Real-IP` | `127.0.0.1`              |
| `session-user` | better-auth `session.user.id`                                          | IP (`ip:${getClientIP}`) |
| `api-key`      | `Authorization: Bearer <key>` header value                             | IP (`ip:${getClientIP}`) |
| `embed-token`  | `X-Embed-Token` header + IP composite                                  | IP (`ip:${getClientIP}`) |

**Why fallbacks exist.** Rate-limiting is best-effort defense in depth — if we can't identify the caller more precisely (auth provider down, session not yet established, missing header), we still want _some_ bucket rather than letting the request through unlimited. The fallback to IP gives unauthenticated/can't-resolve traffic a per-IP cap without changing the rule's intent for authenticated callers.

**Session resolution failure is a behaviour, not a panic.** When `auth.api.getSession` throws (DB outage, etc.), the dispatcher catches the error and falls back to IP keying — it does NOT propagate the auth error as the request's response. Route handlers that require authentication surface their own 401 downstream.

## Per-Flow Sub-Caps (handler-applied)

These are NOT tiers. They're tighter caps on specific expensive operations, applied additively inside route handlers. The middleware's section tier still applies on top.

| Limiter                    | Cap                     | Used in                                       |
| -------------------------- | ----------------------- | --------------------------------------------- |
| `chatLimiter`              | 20/min per user         | Admin chat streaming                          |
| `consumerChatLimiter`      | 10/min per user         | Consumer chat streaming                       |
| `embedChatLimiter`         | 10/min per token+IP     | Embed widget chat                             |
| `audioLimiter`             | 10/min per user         | Voice transcription (Whisper calls)           |
| `imageLimiter`             | 20/min per user         | Chat turns carrying image / PDF attachments   |
| `contactLimiter`           | 5/hour per IP           | Contact form submissions                      |
| `inboundLimiter`           | 60/min per channel+IP   | Slack / Postmark / generic HMAC inbound       |
| `passwordResetLimiter`     | 3/15min per IP          | Password reset requests                       |
| `verificationEmailLimiter` | 3/15min per IP          | Email verification resends                    |
| `acceptInviteLimiter`      | 5/15min per IP          | Invitation acceptance                         |
| `inviteLimiter`            | 10/15min per IP         | Sending invitations                           |
| `uploadLimiter`            | 10/15min per IP         | File uploads                                  |
| `cspReportLimiter`         | 20/min per IP           | CSP violation reports                         |
| `exportLimiter`            | 10/min per admin user   | Bulk-export endpoints (conversations export)  |
| `agentChatLimiter`         | per-agent RPM (dynamic) | Consumer chat with `rateLimitRpm` override    |
| `apiKeyChatLimiter`        | per-key RPM (dynamic)   | Webhook triggers with `rateLimitRpm` override |

Per-flow caps are token-prefixed (`audio:user:${userId}`, `embed:user:${token}:${ip}`, etc.) so they don't collide with the middleware's section tier buckets.

Each per-flow cap is env-tunable through the same `envInt()` mechanism as the tiers, via `RATE_LIMIT_<NAME>` (e.g. `RATE_LIMIT_UPLOAD`, `RATE_LIMIT_CHAT`, `RATE_LIMIT_EXPORT`). A positive integer overrides the default; anything else (unset, non-numeric, ≤ 0) falls back. The time-window constants (`*_INTERVAL`) are intentionally NOT env-tunable — they encode OWASP-aligned abuse windows that shouldn't drift per deployment. See [Configuration](#configuration) for the full list.

## Anti-Patterns

### Don't call section limiters from route handlers

**Wrong:**

```typescript
import { adminLimiter } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth(async (request) => {
  const ip = getClientIP(request);
  const rl = adminLimiter.check(ip);
  if (!rl.success) return createRateLimitResponse(rl);
  // ... handler body
});
```

This pattern double-applies the section cap — the middleware already enforced it on this exact path. The redundant call burns a token from the same bucket the middleware just consumed from, halving the user's actual budget.

**Right:**

```typescript
export const GET = withAdminAuth(async (request) => {
  // No section limiter call — middleware applied it via the policy table.
  // ... handler body
});
```

### Don't add policy rules at the bottom

**Wrong:** appending a new rule after the `/api/v1/` catch-all. The catch-all matches everything, so the new rule never fires.

**Right:** insert the new rule above any broader rule it overlaps with. The policy is ordered most-specific-first; a new rule for `/api/v1/foo/bar` goes above the `/api/v1/foo/` rule (if one exists) and above the catch-all.

### Don't hand-roll 429 responses

**Wrong:**

```typescript
return new Response('Too Many Requests', { status: 429 });
```

Clients can't back off without `Retry-After` and `X-RateLimit-*` headers.

**Right:** the dispatcher already uses `createRateLimitResponse(result)` — which builds the standard error envelope plus all the rate-limit headers — for every 429. Per-flow sub-caps inside handlers use the same helper:

```typescript
import { contactLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

const result = contactLimiter.check(`ip:${getClientIP(request)}`);
if (!result.success) return createRateLimitResponse(result);
```

### Don't mock `@/lib/security/rate-limit` to make tests pass

**Wrong:** in a unit test for a route handler, `vi.mock('@/lib/security/rate-limit')` so the limiter "always succeeds". This proves the test calls a mocked function — it proves nothing about real rate-limit behaviour.

**Right:** `tests/setup.ts` sets `RATE_LIMIT_BYPASS=true` for the entire unit suite, which makes `applyRateLimit` a no-op at the proxy layer. Route-handler tests don't need to think about section rate limits.

Tests that specifically exercise rate-limit behaviour (the dispatcher, a per-flow sub-cap) clear the bypass in their own scope:

```typescript
beforeEach(() => {
  vi.stubEnv('RATE_LIMIT_BYPASS', '');
  // Reset any limiter buckets the test will use:
  RATE_LIMIT_TIERS.orchestration.reset('mw:orchestration:session-user:user:user_test123');
});
```

See [`tests/unit/lib/security/rate-limit-middleware.test.ts`](../../tests/unit/lib/security/rate-limit-middleware.test.ts) for the canonical pattern.

## Configuration

| Variable                                                                                                                                                                                                                                                               | Purpose                                                                             | Default                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `RATE_LIMIT_ADMIN`                                                                                                                                                                                                                                                     | Override the `admin` tier cap (per-minute)                                          | `30`                                                        |
| `RATE_LIMIT_ORCH_ADMIN`                                                                                                                                                                                                                                                | Override the `orchestration` tier cap (per-minute)                                  | `120`                                                       |
| `RATE_LIMIT_API`                                                                                                                                                                                                                                                       | Override the `api` tier cap (per-minute)                                            | `100`                                                       |
| `RATE_LIMIT_MCP`                                                                                                                                                                                                                                                       | Override the `mcp` tier cap (per-minute)                                            | `300`                                                       |
| `RATE_LIMIT_AUTH`                                                                                                                                                                                                                                                      | Override the `auth` tier cap (per-minute) — OWASP floor, raise with care            | `5`                                                         |
| `RATE_LIMIT_PASSWORD_RESET` · `RATE_LIMIT_CONTACT` · `RATE_LIMIT_ACCEPT_INVITE` · `RATE_LIMIT_UPLOAD` · `RATE_LIMIT_INVITE` · `RATE_LIMIT_CSP_REPORT` · `RATE_LIMIT_CHAT` · `RATE_LIMIT_CONSUMER_CHAT` · `RATE_LIMIT_AUDIO` · `RATE_LIMIT_EXPORT` · `RATE_LIMIT_IMAGE` | Override the matching per-flow sub-cap (count only; `*_INTERVAL` windows are fixed) | see [Per-Flow Sub-Caps](#per-flow-sub-caps-handler-applied) |
| `RATE_LIMIT_STORE`                                                                                                                                                                                                                                                     | Backing store for the **async** limiter variants only                               | `memory`                                                    |
| `REDIS_URL`                                                                                                                                                                                                                                                            | Redis connection string (required if `RATE_LIMIT_STORE=redis`)                      | —                                                           |
| `RATE_LIMIT_BYPASS`                                                                                                                                                                                                                                                    | Test/dev escape hatch — `true` short-circuits the dispatcher                        | unset                                                       |

`RATE_LIMIT_BYPASS` is intended for the test suite and local development convenience. It MUST NOT be set in production.

## Distributed Deployments

The default section limiters and per-flow sub-caps are **in-process LRU caches** — each Node.js instance maintains its own buckets. That's sufficient for single-server deployments and for the starter template's out-of-the-box behaviour.

For multi-server or multi-region deployments, swap the sync `createRateLimiter` instances for the async store-backed variants:

| Sync (default)            | Async (Redis-backed)           |
| ------------------------- | ------------------------------ |
| `createRateLimiter`       | `createAsyncRateLimiter`       |
| `createDynamicLimiter`    | `createAsyncDynamicLimiter`    |
| `RateLimiter` (interface) | `AsyncRateLimiter` (interface) |

The async variants read from `getStore()`, which honours `RATE_LIMIT_STORE=redis` + `REDIS_URL`. See [`lib/security/rate-limit-stores/`](../../lib/security/rate-limit-stores/) for the store interface (`MemoryRateLimitStore`, `RedisRateLimitStore`).

**Subtle correctness note.** The async variants compare with `<=` (count-after-add) while the sync variants compare with `<` (count-before-add). Both allow exactly `maxRequests` per window; the operators differ to compensate for `store.increment()` returning count-after-add. Tests in `tests/unit/lib/security/rate-limit.test.ts` lock this in.

## Adding a New Tier

Three edits, in order:

1. **Declare the limiter** in [`lib/security/rate-limit.ts`](../../lib/security/rate-limit.ts):

   ```typescript
   export const billingAdminLimiter = createRateLimiter({
     interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
     maxRequests: SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.BILLING_ADMIN,
     uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
   });
   ```

2. **Extend the registry**:

   ```typescript
   export type RateLimitTier = 'admin' | 'orchestration' | 'api' | 'mcp' | 'auth' | 'billing';

   export const RATE_LIMIT_TIERS: Record<RateLimitTier, RateLimiter> = {
     admin: adminLimiter,
     orchestration: orchestrationAdminLimiter,
     api: apiLimiter,
     mcp: mcpLimiter,
     auth: authLimiter,
     billing: billingAdminLimiter,
   };
   ```

3. **Add the rule** to [`lib/security/rate-limit-policy.ts`](../../lib/security/rate-limit-policy.ts), placed in order:

   ```typescript
   { match: /^\/api\/v1\/admin\/billing\//, tier: 'billing', key: 'session-user' },
   ```

   Update the length and order assertions in `tests/unit/lib/security/rate-limit-policy.test.ts`.

## App / Fork Extension

The three edits above ("Adding a New Tier") are how **Sunrise itself** adds a built-in tier — they edit core files. Apps and forks should NOT edit `RATE_LIMIT_POLICY`, the `RateLimitTier` union, or the `RATE_LIMIT_TIERS` registry. Instead, register an app tier/rule at startup so an upstream merge stays clean:

```typescript
import { createRateLimiter, registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';
import { SECURITY_CONSTANTS } from '@/lib/security/constants';

// 1. (optional) register an app-specific section tier
registerRateLimitTier(
  'billing',
  createRateLimiter({
    interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
    maxRequests: 40,
    uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
  })
);

// 2. point an app path at it (or at a built-in tier)
registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'session-user' });
```

Run registration once at startup, before the first request — e.g. from the same module that bootstraps your app's other extensions. `registerRateLimitTier` / `registerRateLimitRule` and `appEnvSchema` are the platform's three "configure without editing core" seams.

**How app rules are merged.** `getEffectiveRateLimitPolicy()` (called by the dispatcher on every request) returns the base policy with app rules spliced in **after every built-in Sunrise rule and before the `/api/v1/` catch-all**. So an app rule governs the app's own namespace without restating — or being able to shadow — any Sunrise rule. `resolveRateLimitTier(name)` resolves built-in and app tiers from one registry.

**Security constraints (enforced at registration — these throw):**

- **`registerRateLimitTier` cannot override a built-in tier.** Registering `'admin'`, `'auth'`, `'mcp'`, etc. (or a duplicate app name) throws. A fork cannot silently swap the 30/min `admin` limiter for a looser one.
- **`registerRateLimitRule` cannot match a Sunrise-protected surface.** A rule whose matcher could fire for `/api/v1/admin/**`, `/api/auth/**`, `/api/v1/auth/**`, or `/api/v1/mcp/**` is rejected — so an overly-broad matcher like `/^\/api\/v1\//` (which would match the admin probe) throws at registration. This is defense-in-depth on top of the ordering guarantee: because app rules are evaluated _after_ the built-in admin/auth/mcp rules, those rules win first-match regardless; the registration guard makes a foot-gun loud instead of silent.

App tiers/rules are developer config applied at startup — not attacker-reachable input. The guard exists so a fork author can't _accidentally_ weaken an auth/admin cap, not as a defense against a malicious operator (who owns the process anyway).

## Decision History

### Rate Limiting: Centralised Policy Table + Middleware Dispatch

**Decision:** every rate-limit decision flows from a single declarative policy table at `lib/security/rate-limit-policy.ts`; the dispatcher (`applyRateLimit`) is called once from `proxy.ts` for every API request. Route handlers don't call section limiters.

**Rationale:**

- A starter template that asks every developer to remember `{ rateLimit: '…' }` on every new route will eventually ship a route without it. The policy table makes the right thing the default — every new `/api/v1/**` route inherits 100/min keyed on session-user with zero handler work.
- Single audit surface. Reviewing rate-limit policy = reading one file. Adding a new section, splitting a tier, tightening a cap — all happen in one place, not scattered across handlers.
- Per-flow sub-caps still live in handlers because they're tighter per-operation protection layered on top of the section cap, not the section cap itself.

**Rejected alternative:** a `{ rateLimit: 'tier' }` option on `withAdminAuth`. Wrapper-as-discipline is the foot-gun this design avoids — every new route author has to remember the annotation, and the policy is scattered across 100+ handler files instead of one table. Reverted in commit `b4008770` before landing.

**Trade-off:** one extra middleware hop per request to consult the policy table and resolve the key. Negligible — the lookup is a regex test against ≤ 10 rules; session resolution piggybacks on the existing better-auth call that auth-gated handlers would make anyway.

## Related Documentation

- [Security Overview](./overview.md) — security primitives and the broader request lifecycle
- [Security Gotchas](./gotchas.md) — anti-patterns and the right way to use each primitive
- [Environment Configuration](../environment/overview.md) — security-related env vars
- [Auth Security](../auth/security.md) — authentication-specific security
