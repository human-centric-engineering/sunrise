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

// Revoke on any other identity change — used by the email-change flow
import { revokeUserSessions } from '@/lib/auth/sessions';

await revokeUserSessions({
  userId: user.id,
  exceptSessionToken: currentSession?.token, // omit to revoke everything
  reason: 'email_changed',
});
```

`revokeUserSessions` (`lib/auth/sessions.ts`) is the only application-code
session delete (test/smoke scripts do their own cleanup separately).
better-auth's own revocation is endpoint-scoped — it wants a request context
that a verification callback does not have — so this goes at the `session`
table directly. Omitting `exceptSessionToken` revokes everything, which is the
correct degradation when the current session cannot be identified: one extra
login beats leaving an attacker's session alive. An optional `activeOrgId`
narrows the delete to the sessions acting in one org — what removing a member
from an org uses (§106, `lib/tenancy/lifecycle.ts`), so their sessions in other
orgs survive. That path does not depend on the cache window below: the guard
re-reads the membership on every request into a non-install org, so a removed
member is refused at the next request regardless.

**Deleting the row is not instant everywhere.** `session.cookieCache` (above)
is enabled with a 5-minute `maxAge`, and `withAuth()` (`lib/auth/guards.ts`)
calls `auth.api.getSession()` without `disableCookieCache` — the same as every
other guard in the app, not something specific to this revocation path. A
session's signed cache cookie can therefore still authenticate for up to 5
minutes after its row is deleted, for revocation via `revokeUserSessions` here
exactly as much as for `changePassword`'s built-in `revokeOtherSessions`. This
is a pre-existing, app-wide trade-off — bypassing the cache on every guarded
request would mean a DB round-trip per request — not something the email-change
flow introduces or can fix locally.

## Email Change Security

Changing the address that owns an account is an identity mutation, not a profile
edit, and it is treated as one (#489). Three controls apply:

1. **Approval at the OLD address.** `user.changeEmail.sendChangeEmailConfirmation`
   mails an approval link to the address currently on the account. **Nothing is
   written to the database until it is clicked** — better-auth only mints a
   token — so a stolen session can _request_ a change but cannot complete one.
   This is the control that matters; the other two are depth.
2. **Re-authentication.** `PATCH /api/v1/users/me` requires `currentPassword`
   alongside `email`. OAuth-only accounts (no credential row) are exempt, since
   they have no password to confirm.
3. **Session revocation.** When the change finally lands,
   `afterEmailVerificationHook` revokes the user's other sessions — subject to
   the up-to-5-minute cookie-cache staleness window every revocation in this
   app has; see [Session Revocation](#session-revocation) above.

The flow is therefore **two clicks**: approve at the old address, then verify at
the new one. `PATCH /api/v1/users/me` delegates to `auth.api.changeEmail` rather
than writing the address, so a success response still carries the _old_ email
plus `emailChangeRequested: true`.

**Why it matters:** before this, one compromised session was enough for
permanent takeover — the address moved immediately, the verification link went
to the attacker, and `autoSignInAfterVerification` turned it into an independent
session. A session expires; control of the account's address does not.

**Two sharp edges when modifying this flow:**

- better-auth drives the change through the _same_ callbacks as signup
  verification (`sendVerificationEmail`, `afterEmailVerification`) with no
  discriminator in their arguments — and during a change, `user.email` is already
  the NEW address. Use `parseEmailChangeToken` (`lib/auth/change-email.ts`),
  which reads the `updateTo` claim off the token. Skipping it re-breaks two
  things: the invitation check strands changes to an invited address, and the
  welcome email greets established users all over again.
- `sendChangeEmailConfirmation` only fires when the current address is already
  verified. An unverified account has no inbox worth asking, so it goes straight
  to verifying the new address, with no approval gate.
- Revocation identifies "the current session" via `auth.api.getSession` on the
  hook's request, which only sees a cookie the browser actually sent. Clicking
  the new-address verification link from a device or browser with no app
  cookie — routine, since mail links often open elsewhere — is a case
  better-auth handles by minting a session server-side _before_ calling this
  hook and setting its cookie _after_. `getSession` can't see that session, and
  revoking "everything" when it returns null would delete the very session the
  response is about to hand back. `findMostRecentSessionToken` covers this: the
  newest session row is that just-minted one, since a stolen session (which
  predates the change) can never be newer.
- **Known limitation: no collision guard on the target address across the token
  lifetime.** `email` has `@@unique` (`prisma/schema/auth.prisma`), but nothing
  re-checks it between the approval click and the final verification — a window
  that's now the full 24-hour token life, not one request. If two users start a
  change to the same address and both complete verification inside that window,
  the second one hits `internalAdapter.updateUserByEmail` inside better-auth's
  own route with no surrounding `try/catch`
  (`node_modules/better-auth/dist/api/routes/email-verification.mjs`), so the
  unique-constraint violation surfaces as an unhandled error rather than a clean
  "email taken" message. Not patchable from `afterEmailVerificationHook` — it
  only runs after that write already succeeded (or not at all if it throws).
  Fixing this properly means better-auth re-validating uniqueness at the second
  step, which is out of this app's control.

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
