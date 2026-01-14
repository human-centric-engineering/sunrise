# Security Hardener - Gotchas & Common Pitfalls

## Critical Security Issues

### 1. Breaking Next.js Development with Strict CSP

**Problem:** CSP blocks Next.js Hot Module Replacement (HMR) in development

**Wrong:**

```typescript
// This breaks development
const csp = "default-src 'self'; script-src 'self';";
response.headers.set('Content-Security-Policy', csp);
```

**Correct:**

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

const csp = isDevelopment
  ? "default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws://localhost:3000;"
  : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';";

response.headers.set('Content-Security-Policy', csp);
```

**Why:** Next.js HMR requires WebSocket connections and inline scripts that strict CSP blocks.

---

### 2. Rate Limiting Without Proper Key Strategy

**Problem:** Rate limiting by user ID allows unauthenticated brute force

**Wrong:**

```typescript
// Only rate limit authenticated users
const key = session?.user?.id;
if (!key) return { allowed: true }; // No rate limit for anonymous!
```

**Correct:**

```typescript
// Rate limit by IP for anonymous, by user ID for authenticated
const key = session?.user?.id ? `user:${session.user.id}` : `ip:${getClientIP(request)}`;
```

---

### 3. Trusting X-Forwarded-For Header Without Validation

**Problem:** Attackers can spoof IP address via headers

**Wrong:**

```typescript
function getClientIP(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
}
```

**Correct:**

```typescript
function getClientIP(request: Request): string {
  // Only trust X-Forwarded-For if behind trusted proxy
  if (process.env.TRUSTED_PROXY === 'true') {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      // Take the rightmost IP (closest to your server)
      const ips = forwarded.split(',').map((ip) => ip.trim());
      return ips[ips.length - 1] || request.ip || 'unknown';
    }
  }

  // Otherwise use direct connection IP
  return request.ip || 'unknown';
}
```

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

**Problem:** Clients can't implement proper backoff without reset time

**Wrong:**

```typescript
return new Response('Too Many Requests', { status: 429 });
```

**Correct:**

```typescript
return new Response(
  JSON.stringify({
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
  }),
  {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(resetInSeconds)),
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(resetTimestamp),
    },
  }
);
```

---

### 7. Input Sanitization Breaking Legitimate Input

**Problem:** Over-aggressive sanitization removes valid characters

**Wrong:**

```typescript
// Removes all special characters - breaks names like "O'Brien"
function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9 ]/g, '');
}
```

**Correct:**

```typescript
// Only escape HTML-dangerous characters
function sanitizeForHTML(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Keep the original in database, only sanitize for display
```

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

## Best Practices Summary

1. **Environment-aware**: Always have dev vs prod configurations
2. **Fail secure**: Default to deny, explicitly allow
3. **Constant time**: Auth operations should take same time regardless of result
4. **Rate limit headers**: Always include Retry-After and limit info
5. **IP handling**: Don't trust headers without proxy validation
6. **Sanitize for context**: HTML sanitize for display, not storage
7. **Time-limited lockouts**: Allow recovery from account lockout
8. **Log security events**: Track failed attempts, rate limits, blocks
9. **Test both modes**: Test security features in dev AND prod modes
10. **Headers everywhere**: Security headers on all responses including errors
