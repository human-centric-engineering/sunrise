# Authentication Security

## Security Model

Sunrise implements **defense in depth** for authentication security, with multiple layers of protection from network to application code. This document covers threat models, security measures, and best practices specific to authentication.

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

**Implementation**: bcrypt with 12 rounds (salt + hash)

```typescript
// lib/auth/passwords.ts
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12; // 2^12 iterations

export async function hashPassword(password: string): Promise<string> {
  // Automatically generates unique salt per password
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  // Constant-time comparison (prevents timing attacks)
  return bcrypt.compare(password, hashedPassword);
}
```

**Protection Against**:
- **Rainbow Tables**: Unique salt per password prevents precomputed hash tables
- **Brute Force**: 12 rounds makes each guess computationally expensive (~150-300ms)
- **Timing Attacks**: bcrypt.compare runs in constant time
- **Database Breach**: Stolen hashes are useless without massive computational resources

**Benchmark**: ~250ms per hash on modern CPU (intentionally slow to prevent brute force)

### 2. Session Security

**Implementation**: HTTP-only, Secure, SameSite cookies with JWT

```typescript
// lib/auth/config.ts
export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  cookies: {
    sessionToken: {
      name: '__Secure-next-auth.session-token',
      options: {
        httpOnly: true,      // Prevents JavaScript access
        sameSite: 'lax',     // CSRF protection
        path: '/',
        secure: true,        // HTTPS only in production
      },
    },
  },
  jwt: {
    secret: process.env.NEXTAUTH_SECRET, // Strong random secret
    maxAge: 30 * 24 * 60 * 60,
  },
};
```

**Protection Against**:
- **XSS**: `httpOnly: true` prevents JavaScript from accessing cookie
- **CSRF**: `sameSite: 'lax'` blocks cross-site cookie sending
- **Man-in-the-Middle**: `secure: true` requires HTTPS
- **Session Fixation**: NextAuth rotates session tokens on login

**Environment Validation**:
```typescript
// Enforce strong secret in production
if (process.env.NODE_ENV === 'production' &&
    process.env.NEXTAUTH_SECRET.length < 32) {
  throw new Error('NEXTAUTH_SECRET must be at least 32 characters');
}
```

### 3. Rate Limiting

**Implementation**: Sliding window rate limiter

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
  const ip = request.ip ?? '127.0.0.1';
  const { success, remaining } = limiter.check(5, ip); // 5 requests per minute per IP

  if (!success) {
    return Response.json(
      { success: false, error: { message: 'Too many requests' } },
      {
        status: 429,
        headers: { 'X-RateLimit-Remaining': '0' }
      }
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

export const loginSchema = z.object({
  email: z
    .string()
    .min(1, 'Email is required')
    .email('Invalid email address')
    .max(255)
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(1, 'Password is required')
    .max(100), // Prevent excessive input
});

// Always validate in API routes
export async function POST(request: Request) {
  const body = await request.json();

  try {
    const validatedData = loginSchema.parse(body);
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

**NextAuth.js Built-in**:
```typescript
// Automatic CSRF token generation and validation
// app/api/auth/[...nextauth]/route.ts
const handler = NextAuth(authOptions);
// NextAuth adds CSRF token to session and validates on state-changing requests
```

**Additional Protection for Custom Endpoints**:
```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Set CSRF token in response
  const csrfToken = generateCSRFToken();
  response.cookies.set('csrf-token', csrfToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
  });

  return response;
}
```

**Protection Against**: Cross-site request forgery attacks

### 6. Security Headers

**Implementation via middleware**:
```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Restrict resource loading
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';"
  );

  // Force HTTPS
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy
  response.headers.set(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );

  return response;
}
```

### 7. Password Reset Security

**Token Generation**:
```typescript
import { randomBytes } from 'crypto';

// Cryptographically secure random token
const token = randomBytes(32).toString('hex'); // 64 character hex string

// Store hashed version in database
const hashedToken = await hashPassword(token);

await prisma.verificationToken.create({
  data: {
    identifier: email,
    token: hashedToken,
    expires: new Date(Date.now() + 1000 * 60 * 60), // 1 hour expiry
  },
});
```

**Timing Attack Prevention**:
```typescript
// app/api/auth/reset-request/route.ts
export async function POST(request: Request) {
  const { email } = await request.json();

  const user = await prisma.user.findUnique({ where: { email } });

  // ALWAYS return success (prevent email enumeration)
  if (!user) {
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));
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
- Token replay (single use, expires after 1 hour)
- Brute force (rate limited to 3 attempts per 15 minutes)

### 8. OAuth Security

**State Parameter Validation**:
```typescript
// NextAuth.js automatically generates and validates state parameter
// Prevents CSRF in OAuth flow
```

**Callback URL Validation**:
```typescript
// lib/auth/config.ts
export const authOptions: NextAuthOptions = {
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Only allow redirects to same origin or whitelisted domains
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith('/')) return `${baseUrl}${url}`;

      // Whitelist specific external domains if needed
      const allowedDomains = ['https://trusted-domain.com'];
      const redirectUrl = new URL(url);
      if (allowedDomains.includes(redirectUrl.origin)) {
        return url;
      }

      // Default to base URL
      return baseUrl;
    },
  },
};
```

**Protection Against**:
- Open redirect vulnerabilities
- OAuth authorization code interception
- State parameter CSRF

## Security Best Practices

### 1. Environment Variable Security

```bash
# .env.local (NEVER commit this file)

# Strong secret (32+ characters, random)
NEXTAUTH_SECRET="your-super-secret-random-string-32-chars-minimum"

# Generate with:
# openssl rand -base64 32

# Database URL (avoid exposing in logs)
DATABASE_URL="postgresql://user:password@localhost:5432/db"

# OAuth credentials (never expose client secrets)
GOOGLE_CLIENT_SECRET="secret-value-not-in-repo"
```

### 2. Password Policy

Enforced via Zod schema:
```typescript
export const passwordSchema = z
  .string()
  .min(8, 'Minimum 8 characters')
  .max(100, 'Maximum 100 characters')
  .regex(/[A-Z]/, 'Must contain uppercase letter')
  .regex(/[a-z]/, 'Must contain lowercase letter')
  .regex(/[0-9]/, 'Must contain number')
  .regex(/[^A-Za-z0-9]/, 'Must contain special character');
```

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
  event: 'login' | 'logout' | 'signup' | 'password_reset',
  userId: string,
  metadata?: Record<string, any>
) {
  await prisma.auditLog.create({
    data: {
      userId,
      event,
      metadata,
      ipAddress: metadata?.ip,
      userAgent: metadata?.userAgent,
      timestamp: new Date(),
    },
  });
}

// Usage
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

- [ ] All passwords hashed with bcrypt (12+ rounds)
- [ ] NEXTAUTH_SECRET is 32+ characters
- [ ] Session cookies are httpOnly, secure, sameSite
- [ ] Rate limiting on auth endpoints
- [ ] Input validation on all user inputs
- [ ] CSRF protection enabled
- [ ] Security headers set in middleware
- [ ] HTTPS enforced in production
- [ ] OAuth redirect URLs validated
- [ ] Sensitive errors don't leak information
- [ ] Database uses connection pooling with limits
- [ ] Regular dependency updates

## Incident Response

### Suspected Session Compromise

1. Rotate `NEXTAUTH_SECRET` (invalidates all sessions)
2. Force all users to re-login
3. Review audit logs for suspicious activity
4. Check for XSS vulnerabilities in recent changes

### Password Database Breach

1. Assess scope (which passwords exposed)
2. Force password reset for affected users
3. Send breach notification emails
4. Review password hashing implementation
5. Consider increasing bcrypt rounds

## Decision History & Trade-offs

### JWT vs. Database Sessions
**Decision**: JWT sessions (stateless)
**Security Implications**:
- **Pro**: No session store to compromise
- **Con**: Can't invalidate sessions server-side
- **Mitigation**: Short expiry (30 days), `NEXTAUTH_SECRET` rotation invalidates all

### bcrypt Rounds (12)
**Decision**: 12 rounds instead of 10 or 14
**Rationale**:
- 10 rounds: Too fast (~100ms, easier to brute force)
- 12 rounds: ~250ms (acceptable UX, strong security)
- 14 rounds: ~1s (poor UX for login)

**Benchmark**: 2^12 = 4,096 iterations per hash

### Rate Limiting Strategy
**Decision**: In-memory LRU cache vs. Redis
**Rationale**:
- Simpler deployment (no Redis dependency)
- Sufficient for single-server deployment
- Upgrade to Redis when horizontal scaling needed

**Trade-offs**: Limits reset on server restart, not shared across instances

## Related Documentation

- [Auth Overview](./overview.md) - Authentication flows and configuration
- [Auth Integration](./integration.md) - Framework integration patterns
- [API Headers](../api/headers.md) - Security headers and CORS configuration
- [Architecture Overview](../architecture/overview.md) - Overall security architecture
