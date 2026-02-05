# Security Overview

## Security Model

Sunrise implements **defense in depth** with multiple layers of protection from network to application code. This document covers general application security measures that apply across all features, not just authentication.

For authentication-specific security (password hashing, sessions, OAuth), see [Auth Security](../auth/security.md).

## Security Utilities

All security utilities are located in `lib/security/`:

| File            | Purpose                                       |
| --------------- | --------------------------------------------- |
| `constants.ts`  | Security constants (rate limits, CORS config) |
| `rate-limit.ts` | LRU cache-based sliding window rate limiter   |
| `headers.ts`    | CSP and security headers utilities            |
| `sanitize.ts`   | XSS prevention and input sanitization         |
| `cors.ts`       | CORS configuration and utilities              |
| `ip.ts`         | Client IP extraction with validation          |
| `index.ts`      | Module exports                                |

## Security Headers

**Implementation**: `lib/security/headers.ts`

All security headers are managed through the `setSecurityHeaders()` function, called in `proxy.ts` for every response.

```typescript
import { setSecurityHeaders } from '@/lib/security/headers';

// In proxy.ts
const response = NextResponse.next();
setSecurityHeaders(response);
```

**Headers Applied**:

| Header                      | Value                                                   | Purpose                       |
| --------------------------- | ------------------------------------------------------- | ----------------------------- |
| `Content-Security-Policy`   | Environment-specific                                    | XSS prevention                |
| `X-Frame-Options`           | `SAMEORIGIN`                                            | Clickjacking prevention       |
| `X-Content-Type-Options`    | `nosniff`                                               | MIME type sniffing prevention |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                       | Referrer leakage control      |
| `Permissions-Policy`        | `geolocation=(), microphone=(), camera=()`              | Feature restriction           |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) | HTTPS enforcement             |

**Deprecated Headers**:

- ❌ `X-XSS-Protection` - Removed. Deprecated by browsers, replaced by CSP.

## Content Security Policy (CSP)

**Location**: `lib/security/headers.ts`

CSP is implemented with environment-specific policies to balance security with development experience.

### Development CSP

Permissive policy for HMR/Fast Refresh:

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' ws://localhost:*;
frame-ancestors 'self';
form-action 'self';
base-uri 'self';
object-src 'none';
```

### Production CSP

Strict policy with violation reporting:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self';
frame-ancestors 'self';
form-action 'self';
base-uri 'self';
object-src 'none';
report-uri /api/csp-report;
```

### CSP Usage

```typescript
import { getCSP, getCSPConfig, extendCSP } from '@/lib/security/headers';

// Get CSP string for current environment
const csp = getCSP();

// Get raw CSP config object
const config = getCSPConfig();

// Extend base CSP with additional directives
const extendedCSP = extendCSP({
  'img-src': ['https://cdn.example.com'],
  'connect-src': ['https://api.analytics.com'],
});
```

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

**Implementation**: `lib/security/rate-limit.ts`

LRU cache-based sliding window rate limiter. No Redis required for single-server deployment.

### Pre-configured Limiters

| Limiter                    | Limit        | Window     | Use Case                    |
| -------------------------- | ------------ | ---------- | --------------------------- |
| `authLimiter`              | 5 requests   | 1 minute   | Login, signup               |
| `apiLimiter`               | 100 requests | 1 minute   | General API routes          |
| `adminLimiter`             | 30 requests  | 1 minute   | Admin endpoints             |
| `passwordResetLimiter`     | 3 requests   | 15 minutes | Password reset              |
| `contactLimiter`           | 5 requests   | 1 hour     | Contact form submissions    |
| `verificationEmailLimiter` | 3 requests   | 15 minutes | Email verification requests |
| `acceptInviteLimiter`      | 5 requests   | 15 minutes | Invitation acceptance       |
| `uploadLimiter`            | 10 requests  | 15 minutes | File uploads                |
| `inviteLimiter`            | 10 requests  | 15 minutes | Sending invitations         |
| `cspReportLimiter`         | 20 requests  | 1 minute   | CSP violation reports       |

### Usage

```typescript
import {
  createRateLimiter,
  authLimiter,
  apiLimiter,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';

// Use pre-configured limiter
const result = apiLimiter.check('user-ip');

if (!result.success) {
  return createRateLimitResponse(result); // Returns 429 with headers
}

// Create custom limiter
const customLimiter = createRateLimiter({
  interval: 60000, // 1 minute window
  maxRequests: 10,
});
```

### Rate Limit Headers

All rate-limited responses include:

- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Requests remaining in window
- `X-RateLimit-Reset` - Unix timestamp when limit resets
- `Retry-After` - Seconds until retry (on 429 responses)

### Features

- **Sliding window**: Accurate tracking across time boundaries
- **LRU eviction**: Automatic cleanup (max 500 unique tokens)
- **Peek without consume**: Check limits without incrementing
- **Manual reset**: Clear limits for specific tokens

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

### Security Considerations

- **IP Validation**: Prevents arbitrary strings from being used as rate limit keys
- **Proxy Trust**: In production, ensure your reverse proxy (nginx, Cloudflare) strips and re-sets `X-Forwarded-For` to prevent client spoofing

## CORS Configuration

**Implementation**: `lib/security/cors.ts`

Secure by default, configurable for external access.

### Default Behavior

- **Production**: Same-origin only unless `ALLOWED_ORIGINS` is set
- **Development**: Automatically allows localhost variants (3000, 3001, 127.0.0.1)

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

## Security Checklist

### Headers & Policies

- [x] Content-Security-Policy with environment-specific policies
- [x] Security headers set in proxy (`lib/security/headers.ts`)
- [x] HTTPS enforced in production (HSTS header)
- [x] X-Frame-Options set to SAMEORIGIN
- [x] Permissions-Policy restricts browser features

### API Protection

- [x] Rate limiting on API endpoints (`lib/security/rate-limit.ts`)
- [x] CORS configuration (`lib/security/cors.ts`)
- [x] Input validation on all user inputs (Zod schemas)
- [x] Input sanitization utilities (`lib/security/sanitize.ts`)

### Data Protection

- [x] Prisma prevents SQL injection (parameterized queries)
- [x] Sensitive errors don't leak information
- [x] Database uses connection pooling with limits

### Maintenance

- [ ] Regular dependency updates (schedule `npm audit`)
- [ ] CSP violation monitoring (check `/api/csp-report` logs)

## Decision History

### Rate Limiting: In-Memory LRU vs Redis

**Decision**: In-memory LRU cache
**Rationale**:

- Simpler deployment (no Redis dependency)
- Sufficient for single-server deployment
- Upgrade to Redis when horizontal scaling needed

**Trade-offs**: Limits reset on server restart, not shared across instances

### CSP: unsafe-inline for Styles

**Decision**: Allow `'unsafe-inline'` for `style-src`
**Rationale**:

- Required for Tailwind CSS utility classes
- Next.js injects inline styles for certain features

**Trade-offs**: Slightly reduced XSS protection for styles

### X-Frame-Options: SAMEORIGIN vs DENY

**Decision**: Use `SAMEORIGIN` instead of `DENY`
**Rationale**:

- Allows embedding within same-origin iframes
- Useful for embedded content, modals, previews

**Trade-offs**: Slightly increased clickjacking surface (same-origin only)

## Related Documentation

- [Auth Security](../auth/security.md) - Authentication-specific security
- [API Headers](../api/headers.md) - HTTP headers and middleware
- [Environment Configuration](../environment/overview.md) - Security-related env vars
- [Error Handling](../errors/overview.md) - Secure error responses

## Resources

- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [MDN Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
