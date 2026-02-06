# Authentication Security

## Overview

This document covers **authentication-specific security** for Sunrise using better-auth. For general application security (CSP, CORS, rate limiting, sanitization), see [Security Overview](../security/overview.md).

## Threat Model

### Authentication Threats

1. **Credential Stuffing**: Automated login attempts using leaked credentials
2. **Brute Force**: Systematic password guessing attacks
3. **Session Hijacking**: Stealing session tokens to impersonate users
4. **Session Fixation**: Forcing a user to use a known session ID
5. **CSRF**: Forcing authenticated users to execute unwanted actions
6. **Timing Attacks**: Inferring information from response timing
7. **Password Database Breach**: Exposure of stored password hashes
8. **OAuth Token Theft**: Intercepting OAuth authorization codes

## Password Security

### Secure Storage (scrypt)

**Implementation**: scrypt (better-auth default)

better-auth uses **scrypt** by default, which is more secure than bcrypt for password hashing. Scrypt is memory-hard, making it resistant to hardware brute-force attacks.

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

| Algorithm | Characteristics        | Vulnerability                      |
| --------- | ---------------------- | ---------------------------------- |
| scrypt    | Memory-hard + CPU-hard | Resistant to ASIC/GPU              |
| bcrypt    | CPU-hard only          | Vulnerable to specialized hardware |

**Performance**: Both intentionally slow (~150-300ms per hash)

**Protection Against**:

- **Rainbow Tables**: Unique salt per password
- **Brute Force**: Memory-hard algorithm makes each guess expensive
- **Timing Attacks**: Constant-time comparison built-in
- **Database Breach**: Stolen hashes computationally infeasible to crack

### Password Policy

Enforced via Zod schema in `lib/validations/auth.ts`:

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

## Session Security

### Session Configuration

```typescript
// lib/auth/config.ts
export const auth = betterAuth({
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // Update every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes cache
    },
  },
});
```

### Session Strategy

- **Primary**: Database-backed sessions (revocable server-side)
- **Cache**: Short-lived cookie cache (5 minutes) for performance
- **Cookies**: HTTP-only, Secure, SameSite=Lax by default

### Cookie Security

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

### Cookie Cache Strategies

```typescript
cookieCache: {
  enabled: true,
  maxAge: 5 * 60,
  strategy: 'compact', // or 'jwt' or 'jwe'
}
```

- **compact**: Smallest size, basic encoding (default)
- **jwt**: JSON Web Token format
- **jwe**: JSON Web Encryption (encrypted payload)

### Session Revocation

```typescript
// Revoke all sessions on password change
await authClient.changePassword({
  newPassword: newPassword,
  currentPassword: currentPassword,
  revokeOtherSessions: true,
});

// Database revocation
// DELETE FROM session WHERE userId = 'user-id';
```

**Protection Against**:

- **XSS**: `httpOnly: true` prevents JavaScript access
- **CSRF**: `sameSite: 'lax'` + built-in CSRF tokens
- **Man-in-the-Middle**: `secure: true` requires HTTPS
- **Session Fixation**: Token rotation on login
- **Session Hijacking**: Database sessions can be revoked immediately

## CSRF Protection

### better-auth Built-in

better-auth includes automatic CSRF protection:

- CSRF tokens in state-changing requests
- SameSite cookie attribute
- Origin header validation

```typescript
// Automatic CSRF protection (no configuration needed)
// app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth/config';

export const { GET, POST } = auth.handler;
```

### Additional Origin Validation

```typescript
// proxy.ts - validates Origin for state-changing requests
function validateOrigin(request: NextRequest): boolean {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
    return true;
  }

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');

  if (!origin) return true;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
```

## Auth Rate Limiting

Authentication endpoints use the `authLimiter` from `lib/security/rate-limit.ts`:

```typescript
import { authLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

// In auth API routes
const ip = request.ip ?? request.headers.get('x-forwarded-for') ?? '127.0.0.1';
const result = authLimiter.check(ip);

if (!result.success) {
  return createRateLimitResponse(result);
}
```

**Auth-specific limits**:

| Endpoint       | Limit      | Window     | Rationale             |
| -------------- | ---------- | ---------- | --------------------- |
| Login          | 5 requests | 1 minute   | Prevent brute force   |
| Signup         | 5 requests | 1 minute   | Prevent spam accounts |
| Password Reset | 3 requests | 15 minutes | Prevent enumeration   |

## Password Reset Security

### Token Generation

```typescript
import { randomBytes } from 'crypto';

// Cryptographically secure random token
const token = randomBytes(32).toString('hex'); // 64 character hex string
```

### Timing Attack Prevention

```typescript
export async function POST(request: Request) {
  const { email } = await request.json();
  const user = await prisma.user.findUnique({ where: { email } });

  // ALWAYS return success (prevent email enumeration)
  if (!user) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return Response.json({ success: true });
  }

  await generateTokenAndSendEmail(user);
  return Response.json({ success: true });
}
```

**Protection Against**:

- Email enumeration (can't determine if email exists)
- Token prediction (cryptographically random)
- Token replay (single use via verification table)
- Brute force (rate limited)

## OAuth Security

### State Parameter Validation

better-auth automatically generates and validates state parameters to prevent CSRF in OAuth flows.

### OAuth Configuration

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

### Callback URL Validation

better-auth validates redirect URLs to prevent open redirect vulnerabilities.

**Protection Against**:

- Open redirect vulnerabilities
- OAuth authorization code interception
- State parameter CSRF attacks
- Token theft via XSS (tokens in HTTP-only cookies)

## Environment Security

```bash
# .env.local (NEVER commit this file)

# Strong secret (32+ characters, random)
BETTER_AUTH_SECRET="your-super-secret-random-string-32-chars-minimum"

# Generate with: openssl rand -base64 32

# Base URL (production URL in production)
BETTER_AUTH_URL="https://yourdomain.com"

# OAuth credentials (never expose client secrets)
GOOGLE_CLIENT_SECRET="secret-value-not-in-repo"
```

**Validation**:

```typescript
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32)
) {
  throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
}
```

## Account Lockout (Optional)

> **Note:** This is an example implementation pattern, not included in Sunrise by default. Implement if your application requires account lockout/audit logging.

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
```

## Audit Logging

> **Note:** This is an example implementation pattern, not included in Sunrise by default. Implement if your application requires account lockout/audit logging.

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
```

## Security Checklist

### Authentication

- [x] Passwords hashed with scrypt (better-auth default)
- [ ] BETTER_AUTH_SECRET is 32+ characters (verify in production)
- [x] Session cookies are httpOnly, secure, sameSite
- [x] Rate limiting on auth endpoints
- [x] CSRF protection enabled (better-auth built-in)
- [x] OAuth redirect URLs validated

### Best Practices

- [x] Timing attack prevention on password reset
- [x] Email enumeration prevention
- [x] Session revocation on password change
- [x] Sensitive errors don't leak information

## Incident Response

### Suspected Session Compromise

1. Rotate `BETTER_AUTH_SECRET` (invalidates all sessions)
2. Force all users to re-login (clear sessions from database)
3. Review audit logs for suspicious activity
4. Check for XSS vulnerabilities in recent changes

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
4. Consider adding 2FA

## Decision History

### scrypt vs bcrypt

**Decision**: Use scrypt (better-auth default)

- **Pro**: Memory-hard, resistant to ASIC/GPU
- **Pro**: More secure than bcrypt
- **Con**: Slightly higher server memory usage

### Database Sessions vs Pure JWT

**Decision**: Database sessions with cookie cache

- **Pro**: Can revoke sessions server-side
- **Pro**: Session data not exposed in JWT
- **Con**: Requires database query (mitigated by cache)

### Session Expiry (30 days)

**Decision**: 30-day expiry with 24-hour update

- Balance between security and UX
- Sessions update when active
- Adjustable per deployment

## Related Documentation

- [Auth Overview](./overview.md) - Authentication flows
- [Auth Integration](./integration.md) - Framework integration
- [Security Overview](../security/overview.md) - General security (CSP, CORS, etc.)

## Resources

- [better-auth Documentation](https://www.better-auth.com/docs)
- [better-auth Security Guide](https://www.better-auth.com/docs/concepts/security)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
