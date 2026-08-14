# Security Overview

## Security Model

Sunrise implements **defense in depth** with multiple layers of protection from network to application code. This document covers general application security measures that apply across all features, not just authentication.

For authentication-specific security (password hashing, sessions, OAuth), see [Auth Security](../auth/security.md). For domain-specific privacy posture, see:

- [Conversation access — consent-gated cross-user access](./conversation-access.md) — admins see only what users explicitly share.
- [PII redaction at the capability layer](./pii-redaction.md) — write-time redaction so PII never enters the audit substrate raw.

## Security Utilities

All security utilities are located in `lib/security/`:

| File                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `constants.ts`             | Security constants (rate limits, CORS config)             |
| `rate-limit.ts`            | Sliding window rate limiter primitives + tier registry    |
| `rate-limit-policy.ts`     | Path-to-tier policy table (single source of truth)        |
| `rate-limit-middleware.ts` | Dispatcher (`applyRateLimit`) consumed by `proxy.ts`      |
| `rate-limit-stores/`       | Pluggable backing stores: memory (LRU, default) and Redis |
| `headers.ts`               | CSP and security headers utilities                        |
| `sanitize.ts`              | XSS prevention and input sanitization                     |
| `cors.ts`                  | CORS configuration and utilities                          |
| `ip.ts`                    | Client IP extraction with validation                      |
| `redact.ts`                | PII redaction primitives ([details](./pii-redaction.md))  |
| `safe-url.ts`              | SSRF guard for admin-settable outbound URLs               |
| `index.ts`                 | Module exports                                            |

The project-root `proxy.ts` (Next.js 16's renamed middleware) wires `applyRateLimit` into the request lifecycle. See [Rate Limiting](./rate-limiting.md) for the layered model.

## Security Headers

**Implementation**: `lib/security/headers.ts`

All security headers are managed through the `setSecurityHeaders()` function, called in `proxy.ts` for every response.

```typescript
import { setSecurityHeaders } from '@/lib/security/headers';

// In proxy.ts
const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
const requestHeaders = new Headers(request.headers);
requestHeaders.set('x-nonce', nonce);
const response = NextResponse.next({ request: { headers: requestHeaders } });
setSecurityHeaders(response, nonce);
```

**Headers Applied**:

| Header                      | Value                                                   | Purpose                       |
| --------------------------- | ------------------------------------------------------- | ----------------------------- |
| `Content-Security-Policy`   | Environment-specific                                    | XSS prevention                |
| `X-Frame-Options`           | `DENY`                                                  | Clickjacking prevention       |
| `X-Content-Type-Options`    | `nosniff`                                               | MIME type sniffing prevention |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                       | Referrer leakage control      |
| `Permissions-Policy`        | `geolocation=(), microphone=(self), camera=()`          | Feature restriction           |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) | HTTPS enforcement             |

**Deprecated Headers**:

- ❌ `X-XSS-Protection` - Removed. Deprecated by browsers, replaced by CSP.

**Permissions-Policy notes**:

- `microphone=(self)` lets the admin app call `getUserMedia({ audio: true })` for voice input on first-party origins; `geolocation=()` and `camera=()` remain fully denied.
- The embed widget mounts on partner sites via `<script>` injection and inherits the **parent site's** `Permissions-Policy`. Sunrise cannot override it from the script payload — partner sites must allow microphone access in their own policy (and iframe embedders need `allow="microphone"` on the iframe element).

## Content Security Policy (CSP)

**Location**: `lib/security/headers.ts`

CSP is implemented with environment-specific policies to balance security with development experience.

### Development CSP

Permissive policy for HMR/Fast Refresh:

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https: blob:;
media-src 'self' blob:;
font-src 'self' data:;
connect-src 'self' webpack://* ws://localhost:* wss://localhost:*;
worker-src 'self' blob:;
frame-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
object-src 'none';
```

### Production CSP

Strict policy with violation reporting. `script-src` is extended per-request with a nonce:

```
default-src 'self';
script-src 'self' 'nonce-{per-request-nonce}';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https: blob:;
media-src 'self' blob:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self' blob:;
frame-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
object-src 'none';
upgrade-insecure-requests;
report-uri /api/csp-report;
```

The nonce is generated in `proxy.ts` per request and forwarded via the `x-nonce` request header. The base `PRODUCTION_CSP` config defines `script-src 'self'`; `getCSPConfig(nonce)` appends `'nonce-{nonce}'` at runtime.

### CSP Usage

```typescript
import { getCSP, getCSPConfig, extendCSP, buildCSP } from '@/lib/security/headers';

// Get CSP string with nonce (used by proxy middleware)
const csp = getCSP(nonce);

// Get raw CSP config with nonce
const config = getCSPConfig(nonce);

// Extend base CSP with additional directives
const extendedCSP = extendCSP({
  'img-src': ['https://cdn.example.com'],
  'connect-src': ['https://api.analytics.com'],
});

// Build CSP string from config object
const csp = buildCSP(customConfig);
```

> **Note**: `extendCSP()` is available for routes needing additional CSP permissions (e.g., embedding YouTube videos). Base CSP is applied automatically via `setSecurityHeaders()`.

### Third-party iframes — the `frame-src` seam

`frame-src` is `'self'` in both policies. A fork that legitimately embeds a
third-party iframe (a marketing or onboarding video is the common case) declares
the hosts in **`lib/app/csp.ts`** instead of editing this security-sensitive
platform file:

```typescript
// lib/app/csp.ts — fork-owned scaffold, empty in vanilla Sunrise
export const appFrameSrc: string[] = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
];
```

`getCSPConfig()` folds these into `frame-src` for both the dev and prod policy,
so the global CSP `setSecurityHeaders()` sets already carries them — no
per-route `extendCSP()` needed.

**Only exact `https://` origins are accepted** — optionally a left-most wildcard
(`https://*.example.com`) and a port. A bare `*`, a `data:` scheme, a path, a
CSP keyword, or anything containing whitespace or `;` is **dropped and logged at
warn** at module load, because these values are spliced into a response header.

Keep the list exactly as broad as the feature. The safety argument that makes an
allowlist acceptable is that the fork's resolver only ever builds iframe `src`s
on these hosts, from a **validated id** — never from an admin's raw input — so a
hostile stored value resolves to `null` (no iframe) upstream of the CSP ever
mattering. Prefer the privacy-preserving host where one exists
(`youtube-nocookie.com` over `youtube.com`).

### Analytics CSP Auto-Configuration

When analytics providers are configured via environment variables, their domains are automatically added to CSP:

| Provider  | Env Variable                     | Domains Added                               |
| --------- | -------------------------------- | ------------------------------------------- |
| PostHog   | `NEXT_PUBLIC_POSTHOG_KEY`        | Host + assets CDN (script-src, connect-src) |
| GA4       | `NEXT_PUBLIC_GA4_MEASUREMENT_ID` | googletagmanager.com, google-analytics.com  |
| Plausible | `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`   | Configured host (script-src, connect-src)   |

This is handled by `getAnalyticsCSPDomains()` in `lib/security/headers.ts`.

### CSP Violation Reporting

Production CSP includes `report-uri /api/csp-report` which logs violations:

```typescript
// app/api/csp-report/route.ts
export async function POST(request: Request) {
  const report = await request.json();
  logger.warn('CSP Violation', { report });
  return new Response(null, { status: 204 });
}
```

## Rate Limiting

**Implementation**: `lib/security/rate-limit-policy.ts`, `lib/security/rate-limit-middleware.ts`, `lib/security/rate-limit.ts`, `lib/security/rate-limit-stores/`

Section caps (admin / orchestration / api / auth) are enforced centrally in `proxy.ts` via a declarative policy table — every `/api/**` request consults it. Per-flow tighter caps (chat, audio, image, contact, upload, etc.) layer additively inside route handlers.

**Don't call section limiters from route handlers.** The middleware already did. The redundant call would double-count against the same bucket. Per-flow sub-caps are the only rate-limit work handlers should do.

See [Rate Limiting](./rate-limiting.md) for the full reference: the 9-rule policy table, four key strategies (`ip`, `session-user`, `api-key`, `embed-token`), the per-flow sub-cap catalogue, env-var overrides, the `RATE_LIMIT_BYPASS` test escape hatch, and the async/Redis variants for distributed deployments.

## Client IP Extraction

**Implementation**: `lib/security/ip.ts`

Extracts client IP addresses from requests for rate limiting and security logging.

### Functions

```typescript
import { getClientIP, isValidIP } from '@/lib/security/ip';

// Extract client IP from request (checks X-Forwarded-For, X-Real-IP)
const clientIP = getClientIP(request);

// Validate IP format (prevents arbitrary strings as rate limit keys)
if (isValidIP(headerValue)) {
  // Safe to use as rate limit key
}
```

### IP Header Priority

1. `X-Forwarded-For` (first IP in comma-separated list)
2. `X-Real-IP`
3. Fallback: `127.0.0.1`

**Fallback Behavior**: When no valid IP is found in headers, returns `127.0.0.1`. This ensures rate limiting works in development and prevents errors when running without a reverse proxy.

### Security Considerations

- **IP Validation**: Prevents arbitrary strings from being used as rate limit keys
- **Proxy Trust**: In production, ensure your reverse proxy (nginx, Cloudflare) strips and re-sets `X-Forwarded-For` to prevent client spoofing

## CORS Configuration

**Implementation**: `lib/security/cors.ts`

Secure by default, configurable for external access.

### Default Behavior

- **Production**: Same-origin only unless `ALLOWED_ORIGINS` is set
- **Development**: Automatically allows `http://localhost:3000`, `http://localhost:3001`, and `http://127.0.0.1:3000`

### Configuration

```bash
# .env - Leave unset for same-origin only (most secure)
# Set to enable CORS for specific domains:
ALLOWED_ORIGINS=https://app.example.com,https://mobile.example.com
```

### Usage in API Routes

```typescript
// Option 1: HOC wrapper
import { withCORS, handlePreflight } from '@/lib/security/cors';

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request);
}

export const POST = withCORS(async (request: NextRequest) => {
  return Response.json({ data: 'example' });
});

// Option 2: Create all handlers at once
import { createCORSHandlers } from '@/lib/security/cors';

const handlers = createCORSHandlers({
  GET: async (request) => Response.json({ data: 'example' }),
  POST: async (request) => Response.json({ created: true }),
});

export const { GET, POST, OPTIONS } = handlers;
```

> **Note**: These utilities are available for routes requiring cross-origin access. Currently, most API routes use same-origin requests and don't require explicit CORS handling.

### Custom Options

```typescript
const customOptions: CORSOptions = {
  origin: ['https://specific.com'],
  methods: ['GET', 'POST'],
  credentials: true,
  maxAge: 86400,
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-ID'],
};

export const POST = withCORS(handler, customOptions);

// Check origin manually
import { isOriginAllowed, setCORSHeaders } from '@/lib/security/cors';

if (isOriginAllowed(origin, ['https://trusted.com'])) {
  setCORSHeaders(response, request);
}
```

## Input Sanitization

**Implementation**: `lib/security/sanitize.ts`

Defense-in-depth against XSS attacks, complementing CSP headers.

### Available Functions

```typescript
import {
  escapeHtml,
  stripHtml,
  sanitizeUrl,
  sanitizeRedirectUrl,
  sanitizeObject,
  sanitizeFilename,
} from '@/lib/security/sanitize';
```

### Function Reference

| Function                | Purpose                       | Example                        |
| ----------------------- | ----------------------------- | ------------------------------ |
| `escapeHtml()`          | HTML entity encoding          | `<script>` → `&lt;script&gt;`  |
| `stripHtml()`           | Remove all HTML tags          | `<p>Hello</p>` → `Hello`       |
| `sanitizeUrl()`         | Block dangerous protocols     | `javascript:...` → `''`        |
| `sanitizeRedirectUrl()` | Prevent open redirects        | External URLs → `/`            |
| `sanitizeObject()`      | Recursive object sanitization | Escapes all string values      |
| `sanitizeFilename()`    | Prevent path traversal        | `../etc/passwd` → `etc_passwd` |
| `safeCallbackUrl()`     | Safe relative URL extraction  | External URLs → fallback       |

### Examples

```typescript
// HTML escaping (for displaying user content)
const safe = escapeHtml('<script>alert("xss")</script>');
// Result: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'

// URL sanitization
sanitizeUrl('javascript:alert(1)'); // Returns ''
sanitizeUrl('https://example.com'); // Returns 'https://example.com'

// Redirect sanitization
const baseUrl = 'https://app.example.com';
sanitizeRedirectUrl('https://evil.com', baseUrl); // Returns '/'
sanitizeRedirectUrl('/dashboard', baseUrl); // Returns '/dashboard'

// Filename sanitization
sanitizeFilename('../../../etc/passwd'); // Returns 'etc_passwd'
```

## SSRF Guard for Outbound URLs

**Implementation**: `lib/security/safe-url.ts`

Used at every point where the application accepts an outbound HTTP target from persisted data or user input — most importantly `AiProviderConfig.baseUrl`, which an admin can set and which the LLM provider factory then fetches from server-side.

```typescript
import { checkSafeProviderUrl, isSafeProviderUrl } from '@/lib/security/safe-url';

const result = checkSafeProviderUrl(baseUrl, { allowLoopback: isLocal });
if (!result.ok) {
  // result.reason: 'invalid_url' | 'disallowed_scheme' | 'blocked_host' | 'private_ip' | 'loopback_not_allowed'
}
```

**Blocks by default:**

- Non-`http(s)` schemes (`file:`, `gopher:`, `javascript:`, `data:`, etc.)
- Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `metadata.goog`, `100.100.100.200`, `fd00:ec2::254`)
- Unspecified address (`0.0.0.0`, `::`)
- RFC1918 (`10/8`, `172.16/12`, `192.168/16`) and CGNAT (`100.64/10`)
- Link-local (`169.254/16`, IPv6 `fe80::/10`)
- IPv6 unique local (`fc00::/7`)
- Loopback (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`) **unless** `allowLoopback: true`

Private / metadata ranges stay blocked even with `allowLoopback: true` — local model servers run on loopback, not on the LAN.

**Wire it at two layers** whenever a persisted URL becomes an outbound fetch:

1. **Schema validation** — `.superRefine()` at the Zod layer so writes are rejected up front. See `providerConfigSchema` in `lib/validations/orchestration.ts` for the pattern.
2. **Build-time re-check** — re-validate at the point of use (before the fetch SDK is constructed) to catch PATCH merges, seed scripts, and direct DB writes that bypassed the schema. See `buildProviderFromConfig` in `lib/orchestration/llm/provider-manager.ts`.

**Error-oracle suppression.** Any route that performs an outbound fetch against an admin-settable URL and surfaces the result must strip raw SDK / fetch error messages from the response. Forwarding the verbatim error turns the endpoint into a blind-SSRF port scanner (ECONNREFUSED vs. TLS error vs. 404 vs. timeout all leak information about the target). Log the real error server-side, return a generic code to the client. See `app/api/v1/admin/orchestration/providers/[id]/test/route.ts` and `.../models/route.ts` for the canonical pattern.

**Limitation — by design:** no DNS resolution. Defending against DNS rebinding would require pinning the resolved IP through the subsequent fetch, which the OpenAI / Anthropic SDKs don't expose. The build-time re-check narrows the rebinding window but does not close it.

## Input Validation

**Implementation**: Zod schemas in `lib/validations/`

All user input is validated using Zod schemas before processing.

```typescript
import { z } from 'zod';

// Always validate in API routes
export async function POST(request: Request) {
  const body = await request.json();

  try {
    const validatedData = schema.parse(body);
    // Continue with validated data
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { success: false, error: { message: 'Validation failed', details: error.errors } },
        { status: 400 }
      );
    }
  }
}
```

**Protection Against**:

- SQL Injection: Prisma uses parameterized queries, Zod validates types
- XSS: React auto-escapes + CSP headers + sanitization utilities
- NoSQL Injection: Type validation prevents malicious operators
- Buffer Overflow: Max length limits prevent memory exhaustion

## Supply-Chain Security

CI scans dependencies, code, and git history on every push and PR to `main` (plus a weekly cron). All four layers are zero-config for forks — no secrets, and they work on org-owned repos.

| Layer              | Workflow / file                           | What it does                                                                                 |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dependency updates | `.github/dependabot.yml`                  | Weekly npm + GitHub Actions version-update PRs; minor/patch grouped, majors individual       |
| Dependency gate    | `.github/workflows/dependency-review.yml` | Fails a PR that adds a dependency with a known **high+** vulnerability; license advisory     |
| SAST               | `.github/workflows/codeql.yml`            | CodeQL static analysis (JS/TS, `build-mode: none`); findings in **Security → Code scanning** |
| Secret scanning    | `.github/workflows/secret-scan.yml`       | TruffleHog scans the diff (PR) and full history (cron); fails on a committed credential      |
| Standing audit     | `.github/workflows/dependency-audit.yml`  | Weekly: `npm audit` on the tree as it stands, plus an absolute `libc` completeness check     |

#### Responding to a finding you cannot simply fix

The audit job fails only on advisories with a fix published, so a red job means
_something is installable today_. When that fix cannot be taken — it breaks a
feature, or the parent declared its range for a reason — work down this ladder
rather than reaching for the off switch:

1. **Check the incompatibility is real.** npm reports a "fix available" for
   patch bumps too; confirm before designing around it.
2. **Add a `package.json` `overrides` entry.** This is the primary remedy for
   the grandparent-pin shape the job exists to catch, and it is a _fix_, not a
   suppression: it forces the patched transitive past the parent's declared
   range, so the tree genuinely changes and the finding clears honestly. It
   would have resolved the `ws@8.20.1` case, where `engine.io` and
   `socket.io-adapter` both declared `ws: ~8.20.1`. Sunrise carries two
   overrides today (`hono`, `valibot`).

   Adding one is deliberately not quiet: `hasRisk()` in
   `scripts/ci/lockfile-diff.ts` fails `check:lockfile` on any `overrides`
   change, so it arrives as a reviewed decision on a PR. That gate exists
   because an override forces a package past a range its dependents declared,
   which can break the dependent — test the affected path before merging one.

   **Removing one gates too**, and should: dropping an override that was
   fixing a CVE walks the patched transitive straight back to the vulnerable
   version, and is exactly as much of a decision as adding it was. There is no
   acknowledgement facility — an `overrides` change is cleared by review, not by
   a file.

3. **If overriding genuinely breaks things**, there is no good option today.
   `--report` drops gating entirely and `--floor` drops a whole severity; both
   throw away the whole signal to silence one finding. The intended answer is a
   suppression keyed on advisory id, package, version, reason and an **expiry
   date**, and it is deliberately unbuilt until the first time a fixable
   finding is consciously declined — see the "case this does NOT cover" section
   in `scripts/ci/audit-advisories.ts`.

What not to do is leave it red indefinitely. The job's whole design rests on a
red meaning something, and a standing red trains people to stop looking.

**Why a standing audit as well as the dependency gate:** `dependency-review` diffs a PR, so it gates what a PR _adds_ and goes green forever once a vulnerable version is on `main`. Dependabot does watch the tree, but has no package to bump when the fix lives in a **grandparent** — `ws@8.20.1` sat behind two packages declaring `ws: ~8.20.1`, neither vulnerable, so no PR was ever raised and the alert stayed open for seven weeks (#538, #549). The audit job fails only on findings that are actionable today (high+ with a non-major fix) and reports the rest, so an advisory nobody can clear does not red-line the board permanently. Unlike CodeQL and dependency-review it needs no Advanced Security, so it runs on private forks too.

**TruffleHog over gitleaks-action:** gitleaks-action requires a paid licence for org-owned repos; TruffleHog is free for everyone, so forks inherit it unchanged.

**Two settings live outside these files — enable them per repo:**

1. **Settings → Code security → Dependabot security updates** — the vulnerability-driven PRs. The version-update config in `dependabot.yml` does not enable them.
2. After the first green run, add **Analyze (javascript-typescript)**, **Dependency Review**, and **TruffleHog** as required status checks in branch protection. They run on every PR and always report, so requiring them directly is safe — unlike `ci.yml`'s skippable `Validate` / `Docker Build` jobs, which is why `CI Status` is the aggregate gate there.

## Security Checklist

### Headers & Policies

- [x] Content-Security-Policy with environment-specific policies
- [x] Security headers set in proxy (`lib/security/headers.ts`)
- [x] HTTPS enforced in production (HSTS header)
- [x] X-Frame-Options set to DENY
- [x] Permissions-Policy restricts browser features

### API Protection

- [x] Rate limiting on API endpoints — section caps via `lib/security/rate-limit-policy.ts` (applied by `proxy.ts`); per-flow caps via dedicated limiters in `lib/security/rate-limit.ts`
- [x] CORS configuration (`lib/security/cors.ts`)
- [x] Input validation on all user inputs (Zod schemas)
- [x] Input sanitization utilities (`lib/security/sanitize.ts`)

### Data Protection

- [x] Prisma prevents SQL injection (parameterized queries)
- [x] Sensitive errors don't leak information
- [x] Database uses connection pooling with limits

### Maintenance

- [x] Automated dependency updates + vulnerability scanning in CI (see [Supply-Chain Security](#supply-chain-security))
- [ ] CSP violation monitoring (check `/api/csp-report` logs)

## Decision History

### Rate Limiting: Centralised Policy Table + Middleware Dispatch

**Decision**: Every rate-limit decision flows from a single declarative policy table at `lib/security/rate-limit-policy.ts`; the dispatcher (`applyRateLimit`) is called once from `proxy.ts` for every API request. Route handlers do not call section limiters.

**Rationale**: a starter template that asks every developer to remember `{ rateLimit: '…' }` on every new route will eventually ship a route without it. The policy table makes the right thing the default — every new `/api/v1/**` route inherits 100/min keyed on session-user with zero handler work. Reviewing rate-limit policy = reading one file.

**Rejected alternative**: a `{ rateLimit: 'tier' }` option on `withAdminAuth`. Wrapper-as-discipline is the foot-gun this design avoids — annotations get forgotten and policy scatters across 100+ handler files. Reverted before landing (commit `b4008770`).

**Trade-off**: one extra proxy hop per request to consult the policy table and resolve the key. Negligible — the lookup is a regex test against ≤ 10 rules; session resolution piggybacks on the auth call the handler would make anyway.

Per-flow sub-caps (chat, audio, image, contact, upload, etc.) still live in handlers because they're tighter per-operation protection layered on top of the section cap, not the section cap itself.

See [Rate Limiting](./rate-limiting.md) for the full reference.

### Rate Limiting: Pluggable Store Architecture

**Decision**: Pluggable `RateLimitStore` interface with memory (default) and Redis adapters
**Implementation**: `lib/security/rate-limit-stores/`

```
lib/security/rate-limit-stores/
├── types.ts    # RateLimitStore interface
├── memory.ts   # MemoryRateLimitStore — LRU cache (default)
├── redis.ts    # RedisRateLimitStore — Redis sorted sets (optional)
└── index.ts    # Factory: getStore(), reads RATE_LIMIT_STORE env var
```

**Configuration:**

| Env var            | Values            | Default  | Description                            |
| ------------------ | ----------------- | -------- | -------------------------------------- |
| `RATE_LIMIT_STORE` | `memory`, `redis` | `memory` | Which backing store to use             |
| `REDIS_URL`        | Redis connection  | —        | Required when `RATE_LIMIT_STORE=redis` |

**`RateLimitStore` interface:**

```typescript
interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  reset(key: string): Promise<void>;
  peek(key: string, windowMs: number): Promise<{ count: number; resetAt: number } | null>;
}
```

**Memory store** — `MemoryRateLimitStore`: uses `lru-cache` with per-key timestamp arrays. Suitable for single-server deployments. Limits reset on server restart.

**Redis store** — `RedisRateLimitStore`: uses Redis sorted sets with Lua scripts for atomic increment-and-expire. Each request gets a unique member (`timestamp:pid-counter`) to prevent dedup under concurrency. Requires `ioredis` (optional peer dependency). Connection is initialized asynchronously with an awaitable promise to avoid startup races.

If `RATE_LIMIT_STORE=redis` but `REDIS_URL` is unset, falls back to memory with a warning log.

**Async vs sync limiters.** Only the async store-backed limiter factories (`createAsyncRateLimiter`, `createAsyncDynamicLimiter`) read from the configured store. The default sync limiters used by the policy table and per-flow caps run on their own in-process LRU caches — switch to the async variants when moving to multi-region deployments. See [Rate Limiting → Distributed Deployments](./rate-limiting.md#distributed-deployments).

### CSP: unsafe-inline for Styles

**Decision**: Allow `'unsafe-inline'` for `style-src`
**Rationale**:

- Required for Tailwind CSS utility classes
- Next.js injects inline styles for certain features

**Trade-offs**: Slightly reduced XSS protection for styles

### CSP: Per-Request Nonce for script-src

**Decision**: Generate a per-request nonce in `proxy.ts` and add `'nonce-{nonce}'` to `script-src` in production
**Rationale**:

- Eliminates the need for `'unsafe-inline'` in `script-src`
- Next.js injects inline hydration scripts that must be allowed; a nonce permits them without opening the door to all inline scripts
- Nonce approach is more secure than `'unsafe-inline'` or hash-based allowlisting (hashes must be recomputed on every build)

**Trade-offs**:

- Root layout must be an `async` server component to read the `x-nonce` request header via `headers()`
- `suppressHydrationWarning` is required on nonced `<script>` tags — browsers remove the `nonce` attribute from the DOM after reading it, causing a React hydration mismatch if not suppressed

### X-Frame-Options: DENY

**Decision**: Use `DENY` for maximum clickjacking protection
**Rationale**:

- Prevents all framing, including same-origin
- Matches CSP `frame-ancestors: 'none'` for consistent policy
- No legitimate use case for embedding the app in iframes

**Trade-offs**: Cannot embed app pages in same-origin iframes (not needed for this application)

## TypeScript Types

Available type exports from `@/lib/security`:

| Type                      | Description                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `RateLimitOptions`        | Configuration for `createRateLimiter()`                                                 |
| `RateLimitResult`         | Return value from `limiter.check()`                                                     |
| `RateLimiter`             | Sync rate limiter instance interface                                                    |
| `AsyncRateLimiter`        | Async store-backed rate limiter instance interface                                      |
| `DynamicRateLimiter`      | Dynamic (per-token RPM) sync rate limiter                                               |
| `AsyncDynamicRateLimiter` | Dynamic (per-token RPM) async rate limiter                                              |
| `RateLimitTier`           | Section-tier union (`'admin' \| 'orchestration' \| 'api' \| 'auth'`)                    |
| `RateLimitKey`            | Caller-identification strategy (`'ip' \| 'session-user' \| 'api-key' \| 'embed-token'`) |
| `RateLimitRule`           | One rule in `RATE_LIMIT_POLICY`                                                         |
| `CSPConfig`               | CSP directive configuration object                                                      |
| `CORSOptions`             | CORS configuration options                                                              |
| `SafeUrlCheckOptions`     | Options for `checkSafeProviderUrl()`                                                    |
| `SafeUrlCheckResult`      | Discriminated-union return shape from `checkSafeProviderUrl()`                          |

## Related Documentation

- [Rate Limiting](./rate-limiting.md) - Policy table, dispatcher, key strategies, per-flow caps
- [Security Gotchas](./gotchas.md) - Anti-patterns and the right way to use each primitive
- [Auth Security](../auth/security.md) - Authentication-specific security
- [API Headers](../api/headers.md) - HTTP headers and middleware
- [Environment Configuration](../environment/overview.md) - Security-related env vars
- [Error Handling](../errors/overview.md) - Secure error responses

## Resources

- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [MDN Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
