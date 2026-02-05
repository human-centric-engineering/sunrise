# API Headers & Middleware

HTTP header management for security, performance, and API functionality.

## Security Headers

**Implemented in:** `lib/security/headers.ts`, `proxy.ts`

All security headers are set via `setSecurityHeaders()` in the proxy middleware:

```typescript
// proxy.ts
import { setSecurityHeaders } from '@/lib/security/headers';

const response = NextResponse.next();
setSecurityHeaders(response);
```

### Headers Applied

| Header                      | Value                                      | Purpose                         |
| --------------------------- | ------------------------------------------ | ------------------------------- |
| `Content-Security-Policy`   | Environment-specific (see below)           | XSS and injection protection    |
| `X-Frame-Options`           | `DENY`                                     | Prevent clickjacking            |
| `X-Content-Type-Options`    | `nosniff`                                  | Prevent MIME sniffing           |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`          | Control referrer leakage        |
| `Permissions-Policy`        | `geolocation=(), microphone=(), camera=()` | Disable unused browser features |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`      | Force HTTPS (production only)   |

**Note:** `X-XSS-Protection` is intentionally NOT set. It's deprecated and can introduce XSS vulnerabilities in older browsers. CSP provides better protection.

## Content Security Policy (CSP)

**Implemented in:** `lib/security/headers.ts`

Environment-aware CSP with automatic analytics provider allowlisting:

### Development CSP

Permissive for HMR and Fast Refresh:

- `'unsafe-eval'` for Next.js HMR
- `'unsafe-inline'` for scripts/styles
- WebSocket connections for HMR

### Production CSP

Strict for maximum security:

- No `'unsafe-eval'`
- `'unsafe-inline'` only for styles (required for Tailwind)
- `frame-ancestors: 'none'` prevents clickjacking
- CSP violation reporting to `/api/csp-report`

### Analytics Provider Allowlisting

CSP automatically allows configured analytics providers:

```typescript
// Environment variables → CSP directives
NEXT_PUBLIC_POSTHOG_KEY → PostHog domains in script-src, connect-src
NEXT_PUBLIC_GA4_MEASUREMENT_ID → Google Analytics domains
NEXT_PUBLIC_PLAUSIBLE_DOMAIN → Plausible domains
```

### Extending CSP for Specific Routes

```typescript
import { extendCSP } from '@/lib/security/headers';

// Allow YouTube embeds on a specific page
const extendedCSP = extendCSP({
  'frame-src': ["'self'", 'https://www.youtube.com'],
});
```

## CORS (Cross-Origin Resource Sharing)

**Implemented in:** `lib/security/cors.ts`

Opt-in CORS for API routes that need cross-origin access.

### Usage

```typescript
import { withCORS, handlePreflight } from '@/lib/security/cors';

// Handle preflight requests
export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request);
}

// Wrap handler with CORS
export const GET = withCORS(async (request: NextRequest) => {
  return Response.json({ data: 'example' });
});
```

### Configuration

```bash
# Environment variable for allowed origins
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

In development, localhost variants are automatically allowed.

### Default Behavior

- **No CORS by default** - API routes are same-origin only
- **Opt-in per route** - Use `withCORS()` wrapper
- **Credentials supported** - Cookies work cross-origin when enabled

## Rate Limiting

**Implemented in:** `lib/security/rate-limit.ts`, `proxy.ts`

### Proxy-Level Rate Limiting

Applied automatically in middleware:

| Route Pattern               | Limiter        | Limit      |
| --------------------------- | -------------- | ---------- |
| `/api/v1/*`                 | `apiLimiter`   | 100/minute |
| `/api/v1/admin/*`           | `adminLimiter` | 30/minute  |
| `/api/auth/sign-in`         | `authLimiter`  | 5/minute   |
| `/api/auth/sign-up`         | `authLimiter`  | 5/minute   |
| `/api/auth/forgot-password` | `authLimiter`  | 5/minute   |
| `/api/auth/reset-password`  | `authLimiter`  | 5/minute   |

### Route-Level Rate Limiting

Additional limiters for specific endpoints:

```typescript
import { contactLimiter, getClientIP, createRateLimitResponse } from '@/lib/security';

export async function POST(request: NextRequest) {
  const clientIP = getClientIP(request);
  const result = contactLimiter.check(clientIP);

  if (!result.success) {
    return createRateLimitResponse(result);
  }

  // Handle request...
}
```

### Available Limiters

| Limiter                    | Limit         | Use Case                    |
| -------------------------- | ------------- | --------------------------- |
| `authLimiter`              | 5/minute      | Login, signup               |
| `apiLimiter`               | 100/minute    | General API                 |
| `adminLimiter`             | 30/minute     | Admin endpoints             |
| `contactLimiter`           | 5/hour        | Contact form                |
| `verificationEmailLimiter` | 3/15 minutes  | Email verification requests |
| `passwordResetLimiter`     | 3/15 minutes  | Password reset requests     |
| `uploadLimiter`            | 10/15 minutes | File uploads                |
| `inviteLimiter`            | 10/15 minutes | User invitations            |
| `acceptInviteLimiter`      | 5/15 minutes  | Accept invite attempts      |
| `cspReportLimiter`         | 20/minute     | CSP violation reports       |

### Rate Limit Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1640995200
Retry-After: 60  (on 429 response)
```

## Request ID Tracing

**Implemented in:** `proxy.ts`, `lib/logging/context.ts`

Every request gets a unique ID for distributed tracing:

```typescript
// Automatically generated/propagated in proxy
const requestId = request.headers.get('x-request-id') || generateRequestId();
response.headers.set('x-request-id', requestId);
```

Use in error logging:

```typescript
import { logger } from '@/lib/logging';

const requestLogger = logger.withContext({ requestId: request.headers.get('x-request-id') });
requestLogger.error('Request failed', error);
```

## Origin Validation (CSRF Protection)

**Implemented in:** `proxy.ts`

Additional CSRF protection for state-changing requests:

- Validates `Origin` header matches `Host` for POST/PUT/PATCH/DELETE
- Complements better-auth's CSRF token protection
- Returns 403 for cross-origin state-changing requests

## Content Type Guidelines

### JSON Response (Default)

```typescript
return Response.json({ success: true, data: {} });
// Content-Type: application/json; charset=utf-8
```

### File Download

```typescript
return new Response(buffer, {
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="report.pdf"',
  },
});
```

## Caching Guidelines

### No Cache (Default for API Routes)

```typescript
headers: { 'Cache-Control': 'no-store, max-age=0' }
```

### Private Cache (User-Specific Data)

```typescript
headers: { 'Cache-Control': 'private, max-age=300' }
```

### Public Cache (Static Data)

```typescript
headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' }
```

## Related Documentation

- [API Endpoints](./endpoints.md) - API route implementation
- [API Examples](./examples.md) - Client implementation patterns
- [Security Overview](../security/overview.md) - Security architecture
