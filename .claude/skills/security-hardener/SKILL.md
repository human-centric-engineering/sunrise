---
name: security-hardener
version: 1.0.0
description: |
  Security hardening skill for Sunrise. Implements OWASP-aligned security features:
  rate limiting, CORS, CSP, input sanitization, and security headers.
  Use when implementing security features or hardening existing endpoints.

triggers:
  - 'add rate limiting'
  - 'configure CORS'
  - 'implement CSP'
  - 'security hardening'
  - 'add input sanitization'
  - 'secure this endpoint'

contexts:
  - 'lib/security/**/*'
  - 'proxy.ts'
  - '.context/auth/security.md'
  - '.context/api/headers.md'
  - 'next.config.js'

mcp_integrations:
  next_devtools: true
  context7:
    libraries:
      - { nextjs: '/vercel/next.js' }

parameters:
  owasp_top_10: true
  environment_aware: true # Different configs for dev vs prod
---

# Security Hardener Skill - Overview

## Mission

You are a security specialist for the Sunrise project. Your role is to implement production-grade security features following **OWASP guidelines** and security best practices, with environment-aware configurations.

**CRITICAL:** Security changes must never break development experience. Always implement separate dev/prod configurations.

## Current Security State

### Already Implemented

| Feature                   | Location            | Status   |
| ------------------------- | ------------------- | -------- |
| Password hashing (scrypt) | better-auth         | Complete |
| Session security          | better-auth + proxy | Complete |
| Security headers (basic)  | proxy.ts            | Complete |
| Input validation (Zod)    | lib/validations/    | Complete |
| Error handling            | lib/api/errors.ts   | Complete |
| Structured logging        | lib/logging/        | Complete |
| Environment validation    | lib/env.ts          | Complete |
| CSRF protection           | better-auth         | Complete |

### Needs Implementation

| Feature            | Location                   | Priority |
| ------------------ | -------------------------- | -------- |
| Rate limiting      | lib/security/rate-limit.ts | High     |
| CSP headers        | proxy.ts                   | High     |
| CORS configuration | lib/security/cors.ts       | Medium   |
| Input sanitization | lib/security/sanitize.ts   | Medium   |
| Account lockout    | lib/auth/ + database       | Medium   |

## 5-Step Workflow

### Step 1: Analyze Security Requirements

**Questions to answer:**

1. What security feature is needed?
2. What endpoints/routes does it affect?
3. What's the threat model? (What attacks does this prevent?)
4. Does it need different dev/prod behavior?
5. What are the performance implications?

**Common threat models:**

- **Rate limiting** → Brute force, DoS
- **CSP** → XSS, injection attacks
- **CORS** → Cross-origin attacks
- **Sanitization** → XSS, injection
- **Account lockout** → Credential stuffing

### Step 2: Design Solution

**Environment-aware configuration:**

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

const config = isDevelopment
  ? {
      /* permissive for development */
    }
  : {
      /* strict for production */
    };
```

**Fail-secure principle:**

```typescript
// Default to secure, opt-out for specific cases
const isAllowed = allowlist.includes(origin) || false;
```

### Step 3: Implement Security Feature

See templates for specific implementations:

- `templates/rate-limit.md` - Rate limiting with LRU cache
- `templates/csp.md` - Content Security Policy
- `templates/cors.md` - CORS configuration
- `templates/sanitize.md` - Input sanitization

### Step 4: Integrate with Application

**For middleware (proxy.ts):**

```typescript
import { rateLimiter } from '@/lib/security/rate-limit';
import { getCSPHeader } from '@/lib/security/csp';

// In proxy function, before route handling:
const rateLimitResult = await rateLimiter.check(request, '/api/auth');
if (!rateLimitResult.allowed) {
  return new Response('Too Many Requests', {
    status: 429,
    headers: rateLimitResult.headers,
  });
}
```

**For API routes:**

```typescript
import { sanitizeInput } from '@/lib/security/sanitize';

const cleanInput = sanitizeInput(userInput);
```

### Step 5: Verify Implementation

**Security checklist:**

- [ ] Feature works in both dev and prod modes
- [ ] Dev experience not degraded
- [ ] Proper error responses (not exposing internals)
- [ ] Logging captures security events
- [ ] Tests cover security scenarios
- [ ] Documentation updated

## Key Security Patterns

### 1. Environment-Aware Security

```typescript
// ✅ Different behavior for dev/prod
const cspPolicy =
  process.env.NODE_ENV === 'development'
    ? "default-src 'self' 'unsafe-inline' 'unsafe-eval';" // Dev: allow HMR
    : "default-src 'self'; script-src 'self';"; // Prod: strict

// ❌ Never do this - breaks development
const cspPolicy = "default-src 'self';"; // Would break HMR
```

### 2. Fail-Secure Defaults

```typescript
// ✅ Default to secure
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false; // No origin = deny
  return ALLOWED_ORIGINS.includes(origin);
}

// ❌ Don't do this - default insecure
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // Dangerous default
  return !BLOCKED_ORIGINS.includes(origin);
}
```

### 3. Rate Limit Response Headers

```typescript
// Always include rate limit info in headers
return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
  status: 429,
  headers: {
    'Content-Type': 'application/json',
    'Retry-After': String(Math.ceil(resetInSeconds)),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(resetTimestamp),
  },
});
```

### 4. Security Event Logging

```typescript
import { logger } from '@/lib/logging';

// Log security events
logger.warn('Rate limit exceeded', {
  ip: request.ip,
  endpoint: request.url,
  userId: session?.user?.id,
});

logger.info('Successful login', {
  userId: user.id,
  ip: request.ip,
  userAgent: request.headers.get('user-agent'),
});
```

## Existing Security Files Reference

### proxy.ts - Current Headers

```typescript
// Currently implemented headers
response.headers.set('X-Frame-Options', 'DENY');
response.headers.set('X-Content-Type-Options', 'nosniff');
response.headers.set('X-XSS-Protection', '1; mode=block');
response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

// Production only
if (process.env.NODE_ENV === 'production') {
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
```

### lib/validations/auth.ts - Validation Patterns

```typescript
// Password validation example
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100)
  .regex(/[A-Z]/, 'Must contain uppercase')
  .regex(/[a-z]/, 'Must contain lowercase')
  .regex(/[0-9]/, 'Must contain number')
  .regex(/[^A-Za-z0-9]/, 'Must contain special character');
```

### lib/api/errors.ts - Error Handling

```typescript
// Use existing error classes
import { UnauthorizedError, ForbiddenError, ValidationError } from '@/lib/api/errors';

if (rateLimitExceeded) {
  throw new APIError('RATE_LIMIT_EXCEEDED', 'Too many requests', 429);
}
```

## Common Security Implementations

### Rate Limiting Key Strategies

```typescript
// By IP (anonymous users)
const key = `rate:${ip}`;

// By user ID (authenticated)
const key = `rate:${userId}`;

// By endpoint
const key = `rate:${ip}:${endpoint}`;

// Combined (best for auth endpoints)
const key = `rate:auth:${ip}`;
```

### CORS Origin Validation

```typescript
const ALLOWED_ORIGINS = [process.env.NEXT_PUBLIC_APP_URL, 'https://app.example.com'];

// Development: allow localhost variants
if (process.env.NODE_ENV === 'development') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://127.0.0.1:3000');
}
```

### CSP Directives

```typescript
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"], // Needed for Tailwind
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};
```

## Testing Security Features

### Rate Limiting Test

```typescript
import { describe, it, expect } from 'vitest';

describe('Rate Limiter', () => {
  it('should allow requests under limit', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await rateLimiter.check('test-ip', '/api/auth');
      expect(result.allowed).toBe(true);
    }
  });

  it('should block requests over limit', async () => {
    // Fill up the limit
    for (let i = 0; i < 5; i++) {
      await rateLimiter.check('block-ip', '/api/auth');
    }

    // Next request should be blocked
    const result = await rateLimiter.check('block-ip', '/api/auth');
    expect(result.allowed).toBe(false);
    expect(result.headers['Retry-After']).toBeDefined();
  });
});
```

### CORS Test

```typescript
describe('CORS', () => {
  it('should allow configured origins', () => {
    expect(isOriginAllowed('https://app.example.com')).toBe(true);
  });

  it('should reject unknown origins', () => {
    expect(isOriginAllowed('https://evil.com')).toBe(false);
  });

  it('should reject null origin', () => {
    expect(isOriginAllowed(null)).toBe(false);
  });
});
```

## Usage Examples

**Add rate limiting to auth endpoints:**

```
User: "Add rate limiting to the login endpoint"
Assistant: [Creates lib/security/rate-limit.ts, integrates in proxy.ts for /api/auth/*]
```

**Implement CSP headers:**

```
User: "Add Content Security Policy headers"
Assistant: [Creates CSP config with dev/prod variants, integrates in proxy.ts]
```

**Configure CORS for API:**

```
User: "Set up CORS for the API routes"
Assistant: [Creates lib/security/cors.ts with origin validation, adds to API routes]
```
