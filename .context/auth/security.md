# Authentication Security

## Security Model

Sunrise implements **defense in depth** for authentication security using **better-auth**, with multiple layers of protection from network to application code. This document covers threat models, security measures, and best practices specific to better-auth.

## Threat Model

### Identified Threats

1. **Credential Stuffing**: Automated login attempts using leaked credentials from other services
2. **Brute Force**: Systematic password guessing attacks
3. **Session Hijacking**: Stealing session tokens to impersonate users
4. **CSRF (Cross-Site Request Forgery)**: Forcing authenticated users to execute unwanted actions
5. **XSS (Cross-Site Scripting)**: Injecting malicious scripts to steal session data
6. **SQL Injection**: Manipulating database queries through input
7. **Timing Attacks**: Inferring information from response timing differences
8. **Password Database Breach**: Exposure of stored password hashes
9. **OAuth Token Theft**: Intercepting OAuth authorization codes or tokens
10. **Session Fixation**: Forcing a user to use a known session ID

## Security Measures

### 1. Secure Password Storage

**Implementation**: scrypt (better-auth default)

better-auth uses **scrypt** by default, which is more secure than bcrypt for password hashing. Scrypt is designed to be memory-hard, making it extremely resistant to hardware brute-force attacks.

```typescript
// lib/auth/config.ts
import { betterAuth } from 'better-auth';

export const auth = betterAuth({
  emailAndPassword: {
    enabled: true,
    // Uses scrypt by default - no configuration needed
    // Default parameters: N=32768, r=8, p=1, keylen=64
  },
});
```

**scrypt vs bcrypt**:

- **scrypt**: Memory-hard (requires significant RAM), more resistant to ASIC/GPU attacks
- **bcrypt**: CPU-hard only, vulnerable to specialized hardware
- **Performance**: Both intentionally slow (~150-300ms per hash)

**Protection Against**:

- **Rainbow Tables**: Unique salt per password prevents precomputed hash tables
- **Brute Force**: Memory-hard algorithm makes each guess expensive
- **Timing Attacks**: Constant-time comparison built into scrypt/bcrypt
- **Database Breach**: Stolen hashes are computationally infeasible to crack

### 2. Session Security

**Implementation**: Database sessions with cookie cache

```typescript
// lib/auth/config.ts
export const auth = betterAuth({
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days in seconds
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes cookie cache
    },
  },
});
```

**Session Strategy**:

- **Primary**: Database-backed sessions (can be revoked server-side)
- **Cache**: Short-lived cookie cache (5 minutes) for performance
- **Cookies**: HTTP-only, Secure, SameSite=Lax by default

**Cookie Configuration**:
better-auth automatically sets secure cookie defaults:

```typescript
// Automatic configuration (no code needed)
{
  httpOnly: true,      // Prevents JavaScript access
  secure: true,        // HTTPS only in production
  sameSite: 'lax',     // CSRF protection
  path: '/',
}
```

**Cookie Cache Strategies**:
better-auth supports three encoding strategies:

```typescript
export const auth = betterAuth({
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
      strategy: 'compact', // or 'jwt' or 'jwe'
    },
  },
});
```

- **compact**: Smallest size, basic encoding
- **jwt**: JSON Web Token format, widely compatible
- **jwe**: JSON Web Encryption, most secure (encrypted payload)

**Protection Against**:

- **XSS**: `httpOnly: true` prevents JavaScript from accessing cookies
- **CSRF**: `sameSite: 'lax'` blocks cross-site cookie sending + built-in CSRF tokens
- **Man-in-the-Middle**: `secure: true` requires HTTPS in production
- **Session Fixation**: better-auth rotates session tokens on login
- **Session Hijacking**: Database sessions can be revoked immediately

**Session Revocation**:

```typescript
// Revoke all sessions on password change
await authClient.changePassword({
  newPassword: newPassword,
  currentPassword: currentPassword,
  revokeOtherSessions: true, // Force re-auth on all devices
});

// Manual session revocation
await authClient.signOut({
  fetchOptions: {
    onSuccess: () => {
      // All sessions for this user are revoked
    },
  },
});
```

**Environment Validation**:

```typescript
// Enforce strong secret in production
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32)
) {
  throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
}
```

### 3. Rate Limiting

**Implementation**: LRU cache-based sliding window rate limiter

**Location**: `lib/security/rate-limit.ts`

The rate limiter uses an LRU cache with sliding window algorithm, providing efficient memory usage and accurate request tracking without external dependencies (no Redis required for single-server deployment).

```typescript
// lib/security/rate-limit.ts
import {
  createRateLimiter,
  authLimiter,
  apiLimiter,
  passwordResetLimiter,
} from '@/lib/security/rate-limit';

// Pre-configured limiters (ready to use)
const result = authLimiter.check('user-ip'); // 5 requests/minute
const result = apiLimiter.check('user-ip'); // 100 requests/minute
const result = passwordResetLimiter.check('user-ip'); // 3 requests/15 minutes

// Custom limiter
const customLimiter = createRateLimiter({
  interval: 60000, // 1 minute window
  maxRequests: 10, // Max requests per window
});

// Result includes rate limit info for headers
const { success, limit, remaining, reset } = customLimiter.check('token');

// Usage in API routes
export async function POST(request: NextRequest) {
  const ip = request.ip ?? request.headers.get('x-forwarded-for') ?? '127.0.0.1';
  const result = authLimiter.check(ip);

  if (!result.success) {
    return createRateLimitResponse(result); // Returns 429 with proper headers
  }

  // Process request
}
```

**Pre-configured Limiters**:

| Limiter                | Limit        | Window     | Use Case                |
| ---------------------- | ------------ | ---------- | ----------------------- |
| `authLimiter`          | 5 requests   | 1 minute   | Login, signup           |
| `apiLimiter`           | 100 requests | 1 minute   | General API routes      |
| `passwordResetLimiter` | 3 requests   | 15 minutes | Password reset requests |

**Rate Limit Headers**:

All rate-limited responses include standard headers:

- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Requests remaining in window
- `X-RateLimit-Reset` - Unix timestamp when limit resets
- `Retry-After` - Seconds until retry (on 429 responses)

**Features**:

- **Sliding window**: Accurate tracking across time boundaries
- **LRU eviction**: Automatic cleanup of old entries (max 500 unique tokens)
- **Peek without consume**: Check limits without incrementing counter
- **Manual reset**: Clear limits for specific tokens
- **Thread-safe**: Concurrent request handling

**Protection Against**:

- Brute force attacks
- Credential stuffing
- API abuse
- DDoS attempts

### 4. Input Validation & Sanitization

**Zod Validation** (all inputs):

```typescript
// lib/validations/auth.ts
import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(8, 'Minimum 8 characters')
  .max(100, 'Maximum 100 characters')
  .regex(/[A-Z]/, 'Must contain uppercase letter')
  .regex(/[a-z]/, 'Must contain lowercase letter')
  .regex(/[0-9]/, 'Must contain number')
  .regex(/[^A-Za-z0-9]/, 'Must contain special character');

export const signInSchema = z.object({
  email: z
    .string()
    .min(1, 'Email is required')
    .email('Invalid email address')
    .max(255)
    .toLowerCase()
    .trim(),
  password: z.string().min(1, 'Password is required').max(100), // Prevent excessive input
});

// Always validate in API routes
export async function POST(request: Request) {
  const body = await request.json();

  try {
    const validatedData = signInSchema.parse(body);
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
- XSS: React auto-escapes, Content-Security-Policy headers
- NoSQL Injection: Type validation prevents malicious operators
- Buffer Overflow: Max length limits prevent memory exhaustion

### 5. CSRF Protection

**better-auth Built-in**:
better-auth includes automatic CSRF protection via:

- CSRF tokens in state-changing requests
- SameSite cookie attribute
- Origin header validation

```typescript
// Automatic CSRF protection (no configuration needed)
// app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth/config';

export const { GET, POST } = auth.handler;
// better-auth automatically:
// 1. Generates CSRF tokens
// 2. Validates tokens on POST/PUT/DELETE requests
// 3. Checks Origin/Referer headers
```

**Additional Protection via Proxy** (Next.js 16):

```typescript
// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // Validate Origin for state-changing requests
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');

    if (origin && !origin.includes(host || '')) {
      return new NextResponse('Forbidden', { status: 403 });
    }
  }

  return NextResponse.next();
}
```

**Protection Against**: Cross-site request forgery attacks

### 6. Security Headers

**Implementation**: Centralized security headers via `lib/security/headers.ts`

All security headers are managed through the `setSecurityHeaders()` function, which is called in `proxy.ts` for every response.

```typescript
// lib/security/headers.ts
import { setSecurityHeaders } from '@/lib/security/headers';

// In proxy.ts
const response = NextResponse.next();
setSecurityHeaders(response);
```

**Headers Applied**:

| Header                      | Value                                                   | Purpose                       |
| --------------------------- | ------------------------------------------------------- | ----------------------------- |
| `Content-Security-Policy`   | Environment-specific (see CSP section)                  | XSS prevention                |
| `X-Frame-Options`           | `SAMEORIGIN`                                            | Clickjacking prevention       |
| `X-Content-Type-Options`    | `nosniff`                                               | MIME type sniffing prevention |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                       | Referrer leakage control      |
| `Permissions-Policy`        | `geolocation=(), microphone=(), camera=()`              | Feature restriction           |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) | HTTPS enforcement             |

**Deprecated Headers Removed**:

- ❌ `X-XSS-Protection` - Deprecated, replaced by CSP. Can cause XSS vulnerabilities in older browsers.

**Header Changes from Previous Versions**:

- `X-Frame-Options`: Changed from `DENY` to `SAMEORIGIN` to allow same-origin framing (useful for embedded content)
- `Content-Security-Policy`: Now implemented with environment-specific policies

### 7. Content Security Policy (CSP)

**Status**: ✅ Implemented

**Location**: `lib/security/headers.ts`

Content-Security-Policy is implemented with environment-specific policies to balance security with development experience.

**Implementation**:

```typescript
// lib/security/headers.ts
import { getCSP, getCSPConfig, extendCSP, buildCSP } from '@/lib/security/headers';

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

**Development CSP** (permissive for HMR/Fast Refresh):

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

**Production CSP** (strict):

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

**CSP Directives Explained:**

| Directive         | Value                    | Purpose                              |
| ----------------- | ------------------------ | ------------------------------------ |
| `default-src`     | `'self'`                 | Fallback for unspecified directives  |
| `script-src`      | `'self'`                 | Only same-origin scripts             |
| `style-src`       | `'self' 'unsafe-inline'` | Same-origin + Tailwind inline styles |
| `img-src`         | `'self' data: https:`    | Same-origin, data URIs, HTTPS images |
| `font-src`        | `'self' data:`           | Same-origin and data URI fonts       |
| `connect-src`     | `'self'`                 | XHR/fetch/WebSocket connections      |
| `frame-ancestors` | `'self'`                 | Embedding control (clickjacking)     |
| `object-src`      | `'none'`                 | Block plugins (Flash, Java)          |

**CSP Violation Reporting**:

Production CSP includes `report-uri /api/csp-report` which logs violations:

```typescript
// app/api/csp-report/route.ts
export async function POST(request: Request) {
  const report = await request.json();
  logger.warn('CSP Violation', { report });
  return new Response(null, { status: 204 });
}
```

**Extending CSP for External Services**:

```typescript
// For routes needing additional CSP sources
const analyticsCSP = extendCSP({
  'connect-src': ['https://api.analytics.com'],
  'script-src': ['https://cdn.analytics.com'],
});
```

**Attack Prevention:**

```html
<!-- Without CSP: This injected script runs -->
<script src="https://evil.com/steal-data.js"></script>

<!-- With CSP: Browser blocks it -->
<!-- Console error: "Refused to load script from 'https://evil.com/...' because it violates CSP" -->
```

### 8. CORS Configuration

**Implementation**: Configurable CORS via `lib/security/cors.ts`

CORS (Cross-Origin Resource Sharing) is configured to be secure by default while allowing external access when explicitly configured.

**Default Behavior**:

- **Production**: Same-origin only (no CORS headers) unless `ALLOWED_ORIGINS` is set
- **Development**: Automatically allows localhost variants (3000, 3001, 127.0.0.1)

**Configuration**:

```bash
# .env - Leave unset for same-origin only (most secure)
# Set to enable CORS for specific domains:
ALLOWED_ORIGINS=https://app.example.com,https://mobile.example.com
```

**Usage in API Routes**:

```typescript
// Option 1: HOC wrapper for handlers
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

**Custom CORS Options**:

```typescript
const customOptions: CORSOptions = {
  origin: ['https://specific.com'],
  methods: ['GET', 'POST'],
  credentials: true,
  maxAge: 86400, // 24 hours preflight cache
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-ID'],
};

export const POST = withCORS(handler, customOptions);
```

**Security Features**:

- **Origin Validation**: Strict comparison, case-sensitive
- **Fail-Secure**: No origin = deny (null origins rejected)
- **Credentials Support**: Proper handling for cookies/auth headers
- **Vary Header**: Prevents caching issues with different origins

### 9. Input Sanitization

**Implementation**: XSS prevention utilities in `lib/security/sanitize.ts`

Input sanitization provides defense-in-depth against XSS attacks, complementing CSP headers.

**Available Functions**:

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

**HTML Escaping** (for displaying user content):

```typescript
const userInput = '<script>alert("xss")</script>';
const safe = escapeHtml(userInput);
// Result: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
```

**HTML Stripping** (for plain text extraction):

```typescript
const html = '<p>Hello <strong>World</strong></p>';
const text = stripHtml(html);
// Result: 'Hello World'
```

**URL Sanitization** (blocks dangerous protocols):

```typescript
sanitizeUrl('javascript:alert(1)'); // Returns ''
sanitizeUrl('data:text/html,...'); // Returns ''
sanitizeUrl('https://example.com'); // Returns 'https://example.com'
sanitizeUrl('/relative/path'); // Returns '/relative/path'
```

**Redirect URL Sanitization** (prevents open redirects):

```typescript
const baseUrl = 'https://app.example.com';

sanitizeRedirectUrl('/dashboard', baseUrl); // '/dashboard'
sanitizeRedirectUrl('https://evil.com', baseUrl); // '/'
sanitizeRedirectUrl('//evil.com', baseUrl); // '/'

// With allowed hosts
const allowedHosts = ['docs.example.com'];
sanitizeRedirectUrl('https://docs.example.com/guide', baseUrl, allowedHosts);
// Returns 'https://docs.example.com/guide'
```

**Object Sanitization** (recursive):

```typescript
const input = {
  name: '<script>xss</script>',
  profile: {
    bio: '<img onerror=alert(1)>',
  },
};

const clean = sanitizeObject(input);
// All string values HTML-escaped recursively
```

**Filename Sanitization** (prevents path traversal):

```typescript
sanitizeFilename('../../../etc/passwd'); // 'etc_passwd'
sanitizeFilename('file\0.txt'); // 'file.txt'
sanitizeFilename('folder/file.txt'); // 'folder_file.txt'
```

**When to Use**:

| Scenario                     | Function                |
| ---------------------------- | ----------------------- |
| Displaying user text in HTML | `escapeHtml()`          |
| Plain text from HTML input   | `stripHtml()`           |
| User-provided URLs           | `sanitizeUrl()`         |
| Post-login redirects         | `sanitizeRedirectUrl()` |
| File upload names            | `sanitizeFilename()`    |
| API input (defensive)        | `sanitizeObject()`      |

### 10. Password Reset Security

**Token Generation**:

```typescript
import { randomBytes } from 'crypto';

// Cryptographically secure random token
const token = randomBytes(32).toString('hex'); // 64 character hex string

// Store in verification table (better-auth handles this)
// Tokens are automatically hashed and expire after configured time
```

**Timing Attack Prevention**:

```typescript
// app/api/auth/reset-request/route.ts
export async function POST(request: Request) {
  const { email } = await request.json();

  const user = await prisma.user.findUnique({ where: { email } });

  // ALWAYS return success (prevent email enumeration)
  if (!user) {
    // Simulate processing time to prevent timing attacks
    await new Promise((resolve) => setTimeout(resolve, 100));
    return Response.json({ success: true });
  }

  // Generate token and send email
  await generateTokenAndSendEmail(user);

  return Response.json({ success: true });
}
```

**Protection Against**:

- Email enumeration (can't determine if email exists)
- Token prediction (cryptographically random)
- Token replay (single use via verification table)
- Brute force (rate limited to 3 attempts per 15 minutes)

### 11. OAuth Security

**State Parameter Validation**:
better-auth automatically generates and validates state parameters to prevent CSRF in OAuth flows.

**OAuth Configuration**:

```typescript
// lib/auth/config.ts
export const auth = betterAuth({
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
  },
});
```

**Callback URL Validation**:
better-auth validates redirect URLs to prevent open redirect vulnerabilities.

**Protection Against**:

- Open redirect vulnerabilities
- OAuth authorization code interception
- State parameter CSRF attacks
- Token theft via XSS (tokens stored in HTTP-only cookies)

## Security Best Practices

### 1. Environment Variable Security

```bash
# .env.local (NEVER commit this file)

# Strong secret (32+ characters, random)
BETTER_AUTH_SECRET="your-super-secret-random-string-32-chars-minimum"

# Generate with:
# openssl rand -base64 32

# Base URL (production URL in production)
BETTER_AUTH_URL="https://yourdomain.com"

# Database URL (avoid exposing in logs)
DATABASE_URL="postgresql://user:password@localhost:5432/db"

# OAuth credentials (never expose client secrets)
GOOGLE_CLIENT_SECRET="secret-value-not-in-repo"
```

### 2. Password Policy

Enforced via Zod schema (see Input Validation section above):

- Minimum 8 characters
- Maximum 100 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

**Rationale**: NIST guidelines recommend length over complexity, but we balance usability with security.

### 3. Account Lockout (Optional Enhancement)

```typescript
// lib/auth/account-lockout.ts
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

export async function checkAccountLockout(email: string): Promise<boolean> {
  const attempts = await prisma.loginAttempt.count({
    where: {
      email,
      createdAt: { gte: new Date(Date.now() - LOCKOUT_DURATION) },
      success: false,
    },
  });

  return attempts >= MAX_FAILED_ATTEMPTS;
}

export async function recordLoginAttempt(email: string, success: boolean) {
  await prisma.loginAttempt.create({
    data: { email, success, createdAt: new Date() },
  });

  // Clean up old attempts
  await prisma.loginAttempt.deleteMany({
    where: {
      createdAt: { lt: new Date(Date.now() - LOCKOUT_DURATION) },
    },
  });
}
```

### 4. Audit Logging

```typescript
// lib/auth/audit-log.ts
export async function logAuthEvent(
  event: 'login' | 'logout' | 'signup' | 'password_reset' | 'password_change',
  userId: string,
  metadata?: Record<string, unknown>
) {
  await prisma.auditLog.create({
    data: {
      userId,
      event,
      metadata,
      ipAddress: metadata?.ip as string,
      userAgent: metadata?.userAgent as string,
      timestamp: new Date(),
    },
  });
}

// Usage in auth callbacks
await logAuthEvent('login', user.id, {
  ip: request.ip,
  userAgent: request.headers.get('user-agent'),
  provider: 'credentials',
});
```

## Vulnerability Scanning

### Dependency Auditing

```bash
# Run monthly
npm audit

# Auto-fix vulnerabilities
npm audit fix

# Review breaking changes
npm audit fix --force
```

### Security Checklist

- [x] All passwords hashed with scrypt (better-auth default)
- [ ] BETTER_AUTH_SECRET is 32+ characters (verify in production)
- [x] Session cookies are httpOnly, secure, sameSite
- [x] Rate limiting on auth endpoints (`authLimiter` in lib/security/rate-limit.ts)
- [x] Input validation on all user inputs (Zod schemas)
- [x] Input sanitization utilities (lib/security/sanitize.ts)
- [x] CSRF protection enabled (better-auth built-in + origin validation in proxy.ts)
- [x] Security headers set in proxy (lib/security/headers.ts)
- [x] Content-Security-Policy with environment-specific policies
- [x] CORS configuration (lib/security/cors.ts)
- [x] HTTPS enforced in production (HSTS header)
- [x] OAuth redirect URLs validated (better-auth built-in)
- [x] Sensitive errors don't leak information
- [x] Database uses connection pooling with limits
- [ ] Regular dependency updates (schedule npm audit)

## Incident Response

### Suspected Session Compromise

1. Rotate `BETTER_AUTH_SECRET` (invalidates all sessions)
2. Force all users to re-login (sessions stored in database can be cleared)
3. Review audit logs for suspicious activity
4. Check for XSS vulnerabilities in recent changes
5. Enable session revocation on password change

**Database Session Revocation**:

```sql
-- Revoke all sessions for a user
DELETE FROM session WHERE userId = 'user-id';

-- Revoke all sessions globally
DELETE FROM session;
```

### Password Database Breach

1. Assess scope (which passwords exposed)
2. Force password reset for affected users
3. Send breach notification emails
4. Review password hashing implementation
5. Consider adding additional security layer (2FA)

## Decision History & Trade-offs

### scrypt vs bcrypt for Password Hashing

**Decision**: Use scrypt (better-auth default)
**Security Implications**:

- **Pro**: Memory-hard algorithm, resistant to ASIC/GPU attacks
- **Pro**: More secure than bcrypt against specialized hardware
- **Pro**: Configurable memory cost for future-proofing
- **Con**: Slightly higher server memory usage
- **Mitigation**: Monitor memory usage, adjust parameters if needed

**Why scrypt?**: Modern best practice, recommended by security experts over bcrypt for new applications.

### Database Sessions vs Pure JWT

**Decision**: Database sessions with cookie cache (hybrid)
**Security Implications**:

- **Pro**: Can revoke sessions server-side immediately
- **Pro**: Session data not exposed in JWT
- **Pro**: More control over session lifecycle
- **Con**: Requires database query for validation (mitigated by 5-min cache)
- **Con**: Slightly more complex infrastructure

**Why hybrid?**: Best of both worlds - security of database sessions with performance of short-lived cache.

### Session Expiry (30 days)

**Decision**: 30-day session expiry with 24-hour update age
**Rationale**:

- Balance between security and user experience
- Sessions update every 24 hours when active
- Inactive sessions expire after 30 days
- Can be adjusted per deployment needs

### Rate Limiting Strategy

**Decision**: In-memory LRU cache vs Redis
**Rationale**:

- Simpler deployment (no Redis dependency)
- Sufficient for single-server deployment
- Upgrade to Redis when horizontal scaling needed

**Trade-offs**: Limits reset on server restart, not shared across instances

### Cookie Cache Strategy

**Decision**: "compact" encoding (default)
**Alternatives**: "jwt" or "jwe"
**Rationale**:

- Smallest cookie size
- Sufficient security with HTTPS
- Can upgrade to "jwe" (encrypted) if needed

## Advanced Security Features

### Hybrid Stateless Sessions with Secondary Storage

For advanced use cases, better-auth supports Redis-backed sessions:

```typescript
import { betterAuth } from 'better-auth';
import { redis } from './redis';

export const auth = betterAuth({
  secondaryStorage: {
    get: async (key) => await redis.get(key),
    set: async (key, value, ttl) => await redis.set(key, value, 'EX', ttl),
    delete: async (key) => await redis.del(key),
  },
  session: {
    cookieCache: {
      maxAge: 5 * 60, // 5 minutes
      refreshCache: false, // Disable stateless refresh
    },
  },
});
```

### API Key Security (if using API key plugin)

```typescript
import { betterAuth } from 'better-auth';
import { apiKey } from 'better-auth/plugins';

export const auth = betterAuth({
  plugins: [
    apiKey({
      // NEVER disable hashing in production
      disableKeyHashing: false, // Recommended: keep keys hashed
    }),
  ],
});
```

## Related Documentation

- [Auth Overview](./overview.md) - Authentication flows and configuration
- [Auth Integration](./integration.md) - Framework integration patterns
- [API Headers](../api/headers.md) - Security headers and CORS configuration
- [Architecture Overview](../architecture/overview.md) - Overall security architecture

## Resources

- [better-auth Documentation](https://www.better-auth.com/docs)
- [better-auth Security Guide](https://www.better-auth.com/docs/concepts/security)
- [scrypt Password Hashing](https://en.wikipedia.org/wiki/Scrypt)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
