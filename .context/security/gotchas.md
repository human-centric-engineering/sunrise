# Security Gotchas & Common Pitfalls

Time-tested anti-patterns and the right way to use the primitives in `lib/security/`. Most of these came from real near-misses or from `/security-review` findings; the rules are written to fail safely when applied without thought.

For the primitives themselves, see [overview.md](./overview.md). For pre-PR auditing, run `/security-review` on the branch.

## Critical Security Issues

### 1. Breaking Next.js Development with Strict CSP

**Problem:** CSP blocks Next.js Hot Module Replacement (HMR) in development.

`lib/security/headers.ts` already handles this — `getCSPConfig()` returns a permissive dev policy (`'unsafe-inline'`, `'unsafe-eval'`, `ws://localhost`) and a strict prod policy. The split is applied automatically inside `proxy.ts` via `setSecurityHeaders(response)`.

**Wrong:** rolling your own CSP string at the call site.

```typescript
// Don't hand-roll — this duplicates the dev/prod logic and drifts
response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self';");
```

**Correct:** use the shared helpers; extend only when you need a per-route exception.

```typescript
import { extendCSP } from '@/lib/security/headers';

// Per-route addition (e.g. allowing an embed script from a CDN)
response.headers.set(
  'Content-Security-Policy',
  extendCSP({ 'script-src': ["'self'", 'https://cdn.example.com'] })
);
```

**Why:** Next.js HMR requires WebSocket connections and inline scripts that strict CSP blocks. The dev exception lives in one place so the rule "dev is permissive, prod is strict" is enforceable.

---

### 2. Rate Limiting Without Proper Key Strategy

**Problem:** Rate limiting by user ID alone allows unauthenticated brute force — the attacker never authenticates, so the key is `undefined` and the limit never applies.

**Wrong:**

```typescript
const key = session?.user?.id;
if (!key) return { allowed: true }; // No rate limit for anonymous!
const result = authLimiter.check(key);
```

**Correct:** key by IP when there's no session (auth endpoints, signup, contact forms). For authenticated endpoints where per-user abuse matters, key by user ID. Use both when an endpoint serves both states.

```typescript
import { authLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

const key = session?.user?.id ? `user:${session.user.id}` : `ip:${getClientIP(request)}`;
const result = authLimiter.check(key);
if (!result.success) return createRateLimitResponse(result);
```

**Why:** auth-endpoint abuse is, by definition, unauthenticated. Rate-limiting only authenticated requests on login is the same as not rate-limiting login at all.

---

### 3. Trusting X-Forwarded-For Header Without Validation

**Problem:** Attackers can spoof their IP address by setting `X-Forwarded-For` themselves. If you take the leftmost value blindly, rate limits and audit logs become meaningless.

**Wrong:** reading the header directly.

```typescript
// Don't do this — `getClientIP` already handles spoofing
const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
```

**Correct:** always go through `getClientIP` from `lib/security/ip.ts`. It picks the rightmost trusted hop, falls back to the connection IP, and validates that the result is a real IP.

```typescript
import { getClientIP } from '@/lib/security/ip';
const ip = getClientIP(request);
```

**Why:** the leftmost value in `X-Forwarded-For` is whatever the client sent — the rightmost is what the closest trusted proxy actually saw. `getClientIP` encodes that rule plus IP validation in one place so it cannot drift across the codebase.

---

### 4. CORS Allowing All Origins in Development Leaking to Production

**Problem:** Development CORS config accidentally used in production

**Wrong:**

```typescript
const ALLOWED_ORIGINS = ['*']; // Dangerous!
```

**Correct:**

```typescript
function getAllowedOrigins(): string[] {
  const origins = [process.env.NEXT_PUBLIC_APP_URL].filter(Boolean) as string[];

  // Only add localhost in development
  if (process.env.NODE_ENV === 'development') {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }

  return origins;
}
```

---

### 5. Exposing Stack Traces in Production Error Responses

**Problem:** Error details leak implementation information

**Wrong:**

```typescript
return Response.json(
  {
    error: {
      message: error.message,
      stack: error.stack, // Never expose in production!
    },
  },
  { status: 500 }
);
```

**Correct:**

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

return Response.json(
  {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isDevelopment ? error.message : 'An unexpected error occurred',
      ...(isDevelopment && { stack: error.stack }),
    },
  },
  { status: 500 }
);
```

---

### 6. Rate Limit Headers Missing Reset Time

**Problem:** clients can't implement proper backoff without reset info, and a bare `429` looks like a transient failure rather than a quota event.

**Wrong:** hand-rolling the response.

```typescript
return new Response('Too Many Requests', { status: 429 });
```

**Correct:** use `createRateLimitResponse(result)` — it builds a JSON envelope with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers from the `RateLimitResult` returned by the limiter.

```typescript
import { contactLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

const result = contactLimiter.check(clientIP);
if (!result.success) return createRateLimitResponse(result);
```

---

### 7. Input Sanitisation Breaking Legitimate Input

**Problem:** over-aggressive character stripping removes valid input — names like "O'Brien", emails with `+` tags, addresses with commas, URLs with query strings.

**Wrong:** hand-rolling a regex that strips "anything weird".

```typescript
// Breaks "O'Brien", "user+tag@x.com", "C++"
const cleaned = input.replace(/[^a-zA-Z0-9 ]/g, '');
```

**Correct:** sanitise **for the context** using the helpers in `lib/security/sanitize.ts`. Store the original value; only transform at the boundary where it's dangerous.

```typescript
import { escapeHtml, sanitizeUrl, safeCallbackUrl } from '@/lib/security/sanitize';

const safeHtml = escapeHtml(userBio); // when rendering inside HTML
const safeUrl = sanitizeUrl(userLink); // rejects javascript:, data:, etc.
const next = safeCallbackUrl(searchParams.get('next'), '/dashboard'); // redirect param
```

**Why:** sanitisation is context-specific. HTML-escaping a value bound for SQL doesn't prevent injection; URL-validating a value bound for the DOM doesn't prevent XSS. Match the helper to the sink.

---

### 8. Timing Attacks in Authentication

**Problem:** Different response times reveal valid vs invalid users

**Wrong:**

```typescript
const user = await db.user.findUnique({ where: { email } });
if (!user) {
  return Response.json({ error: 'User not found' }, { status: 404 }); // Fast response
}
// Slow password verification follows...
```

**Correct:**

```typescript
const user = await db.user.findUnique({ where: { email } });

// Always perform password verification (even with dummy hash)
const passwordValid = user
  ? await verifyPassword(password, user.passwordHash)
  : await verifyPassword(password, DUMMY_HASH); // Constant time

if (!user || !passwordValid) {
  return Response.json({ error: 'Invalid credentials' }, { status: 401 });
}
```

---

### 9. Missing Security Headers on Error Responses

**Problem:** Error pages don't have security headers

**Wrong:**

```typescript
// Error handler that doesn't set headers
export default function Error() {
  return <div>Error occurred</div>;
}
```

**Correct:**

```typescript
// Security headers should be set in middleware/proxy for ALL responses
// including error pages - this is already handled in proxy.ts

// Make sure error responses from API routes also have headers
return handleAPIError(error); // This should set headers
```

---

### 10. Account Lockout Without Unlock Mechanism

**Problem:** Legitimate users get locked out permanently

**Wrong:**

```typescript
if (failedAttempts >= 5) {
  await db.user.update({
    where: { id: user.id },
    data: { locked: true }, // No way to unlock!
  });
}
```

**Correct:**

```typescript
if (failedAttempts >= 5) {
  await db.user.update({
    where: { id: user.id },
    data: {
      lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // 15 minute lockout
      failedAttempts: 0, // Reset counter
    },
  });
}

// In login check:
if (user.lockedUntil && user.lockedUntil > new Date()) {
  const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
  return Response.json(
    { error: `Account locked. Try again in ${minutesLeft} minutes.` },
    { status: 429 }
  );
}
```

---

### 11. Fetching User-Controlled URLs Without an SSRF Guard

**Problem:** any `fetch(url)` where `url` came (even partially) from user input is an SSRF vector. The attacker points it at `http://169.254.169.254/` (cloud metadata), `http://10.0.0.5/admin`, `file:///etc/passwd`, or similar — and your server happily fetches it.

**Wrong:** trusting validation at config time.

```typescript
// Validating once at form submit is not enough — DNS can change before fetch
const provider = await prisma.provider.create({ data: { baseUrl } });
const response = await fetch(provider.baseUrl); // SSRF window
```

**Correct:** re-check at the point of use with `checkSafeProviderUrl` (or its boolean shorthand `isSafeProviderUrl`).

```typescript
import { checkSafeProviderUrl } from '@/lib/security/safe-url';

const urlCheck = checkSafeProviderUrl(url, { allowLoopback: false });
if (!urlCheck.ok) {
  log.error('URL rejected by SSRF guard', { reason: urlCheck.reason });
  throw new ValidationError(`URL not allowed: ${urlCheck.reason ?? 'blocked'}`);
}
const response = await fetch(url);
```

**Why:** validation at submit time can be bypassed by DNS rebinding — the hostname resolves to a public IP at validation, then to a private IP at fetch. The check has to happen at the moment of the network call. The guard blocks private/loopback/link-local ranges, IP literals, embedded credentials, and dangerous schemes (`file://`, etc.).

---

## Best Practices Summary

1. **Environment-aware**: dev and prod configurations live in one place (`lib/security/headers.ts` for CSP, `lib/security/cors.ts` for origins) — don't duplicate the split at call sites
2. **Fail secure**: default to deny, explicitly allow
3. **Constant time**: auth operations should take the same time regardless of result
4. **Use the shared primitives**: `getClientIP`, `createRateLimitResponse`, `escapeHtml`, `safeCallbackUrl`, `checkSafeProviderUrl` — never hand-roll
5. **Sanitise for context**: HTML-escape for display, URL-validate for redirects, filename-sanitise for storage — pick the helper that matches the sink
6. **Time-limited lockouts**: account lockouts must have a clear path to recovery
7. **Log security events**: track failed attempts, rate-limit blocks, SSRF rejections, sanitiser hits
8. **Test both modes**: validate security features under dev AND prod environment configs
9. **Security headers everywhere**: `proxy.ts` already covers app responses; check that API error envelopes from `handleAPIError` also flow through it
10. **SSRF at fetch time**: re-check user-controlled URLs at the point of `fetch`, not just at submit time
