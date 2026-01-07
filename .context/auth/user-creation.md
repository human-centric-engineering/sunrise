# User Creation Patterns

**Version**: 2.1.0
**Last Updated**: 2026-01-07
**Status**: Production-ready

## Overview

Sunrise supports three user creation patterns: **self-signup** (email/password or OAuth), **OAuth signup** (social login), and **invitation-based** (admin-initiated). All patterns prioritize security and user experience.

## Pattern Comparison

| Aspect             | Self-Signup (Email/Password)   | OAuth Signup (Social Login)      | Invitation-Based                     |
| ------------------ | ------------------------------ | -------------------------------- | ------------------------------------ |
| Initiated by       | User                           | User                             | Admin                                |
| Endpoint           | `POST /api/auth/sign-up/email` | `GET /api/auth/oauth/{provider}` | `POST /api/v1/users/invite`          |
| User provides      | Name, email, password          | OAuth consent                    | -                                    |
| Admin provides     | -                              | -                                | Name, email, role                    |
| Password required  | Yes                            | No                               | Yes (set by user on acceptance)      |
| Email verification | Environment-based              | Auto-verified by OAuth provider  | Auto-verified on acceptance          |
| Security           | High (user-controlled)         | High (OAuth provider)            | Highest (token-based)                |
| UX                 | Excellent (self-service)       | Excellent (one-click)            | Good (invitation flow)               |
| Recommended for    | Public user registration       | Quick signups, social accounts   | Team invites, admin-created accounts |

## Self-Signup Pattern (Primary - User-Initiated)

**Use Case**: Public user registration, SaaS signups, open community access

### Flow

1. User visits signup page
2. User provides name, email, and password
3. better-auth creates account with hashed password
4. Email verification email sent (if enabled in environment)
5. User verifies email (production) or logs in directly (development)

### Implementation

**Client-side (Web UI):**

```typescript
// components/forms/signup-form.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function SignupForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        email: formData.get('email'),
        password: formData.get('password'),
      }),
    })

    if (response.ok) {
      // Redirect based on email verification setting
      router.push('/login?message=Check your email to verify your account')
    } else {
      const data = await response.json()
      setError(data.message || 'Signup failed')
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* Form fields */}
    </form>
  )
}
```

**Mobile Apps:**

```typescript
// Mobile app (React Native, Flutter, etc.)
async function signUp(name: string, email: string, password: string) {
  const response = await fetch('https://your-app.com/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });

  if (!response.ok) {
    throw new Error('Signup failed');
  }

  const data = await response.json();
  // Handle response (redirect to verify email or login)
}
```

### Email Verification

**Environment-based behavior:**

- **Development**: Email verification disabled by default (immediate login)
- **Production**: Email verification enabled by default (must verify before login)
- **Override**: Set `REQUIRE_EMAIL_VERIFICATION=true/false` to override default

**Configuration:**

```typescript
// lib/auth/config.ts
emailAndPassword: {
  requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production',
  sendVerificationOnSignUp: true,
}
```

## OAuth Signup Pattern (Social Login)

**Use Case**: Quick signups, users with existing social accounts, reduced friction

### Flow

1. User clicks "Sign in with Google" (or other provider)
2. Redirected to OAuth provider for consent
3. Provider redirects back with authorization code
4. better-auth exchanges code for user profile
5. User account created automatically (or linked if exists)
6. Email auto-verified by OAuth provider
7. User logged in immediately

### Implementation

**Client-side (Web UI):**

```typescript
// components/forms/oauth-button.tsx
'use client';

import { signIn } from '@/lib/auth/client';

export function GoogleSignInButton() {
  async function handleSignIn() {
    await signIn.social({
      provider: 'google',
      callbackURL: '/dashboard',
    });
  }

  return (
    <button onClick={handleSignIn}>
      Sign in with Google
    </button>
  );
}
```

**Mobile Apps:**

```typescript
// Mobile app OAuth flow
async function signInWithGoogle() {
  // Step 1: Get authorization URL
  const authUrl = 'https://your-app.com/api/auth/oauth/google';

  // Step 2: Open browser for OAuth consent
  const result = await openAuthBrowser(authUrl);

  // Step 3: Extract session from callback
  const sessionToken = extractTokenFromCallback(result.url);

  // Step 4: Store session token
  await secureStorage.set('session_token', sessionToken);
}
```

### Supported Providers

- **Google** - Configured via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- **GitHub** - Add via better-auth configuration
- **Other providers** - See better-auth documentation

### Security Features

**OAuth Security:**

- State parameter prevents CSRF attacks
- PKCE (Proof Key for Code Exchange) for mobile apps
- Token validation and refresh handling
- Email verification delegated to OAuth provider

**Session Management:**

- Secure session cookies (httpOnly, sameSite)
- Session tokens stored securely
- Automatic session refresh

## Invitation-Based Pattern (Recommended for Admin)

**Use Case**: Team invitations, admin-created accounts, controlled access

### Flow

1. **Admin invites user** via `POST /api/v1/users/invite`
   - Provides: name, email, role
   - System generates secure token
   - Invitation stored in `Verification` table with metadata
   - Invitation email sent with accept link

2. **User receives email** with invitation link
   - Link format: `/accept-invite?token={token}&email={email}`
   - Token expires in 7 days

3. **User accepts invitation** via `POST /api/auth/accept-invite`
   - User clicks link, arrives at password setup page
   - User sets own password
   - System creates user account via better-auth (stable User ID)
   - Email auto-verified on acceptance
   - Welcome email sent
   - Invitation token deleted

4. **User logs in** with new credentials

### Implementation

**Admin invites user:**

```typescript
// Admin UI or API client
async function inviteUser(name: string, email: string, role: string) {
  const response = await fetch('/api/v1/users/invite', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'better-auth.session_token=...',
    },
    body: JSON.stringify({ name, email, role }),
  });

  if (!response.ok) {
    throw new Error('Invitation failed');
  }

  const data = await response.json();
  return data.invitation; // { email, name, role, invitedAt, expiresAt, link }
}
```

**User accepts invitation:**

```typescript
// Accept invitation page
async function acceptInvitation(
  token: string,
  email: string,
  password: string,
  confirmPassword: string
) {
  const response = await fetch('/api/auth/accept-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, email, password, confirmPassword }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to accept invitation');
  }

  return response.json(); // { success: true, data: { message: "..." } }
}
```

### Security Features

**Token Security:**

- Storage: SHA-256 hashed tokens (32 bytes = 64 hex chars)
- Validation: Token must match email and not be expired
- Single-use: Token deleted after acceptance
- Expiration: 7 days from generation

**User ID Stability:**

- User created **once** on invitation acceptance
- No delete/recreate pattern (stable User ID)
- All related data (sessions, permissions) linked to stable ID

**Email Verification:**

- Email marked as verified on acceptance
- No separate verification step needed
- User can log in immediately after acceptance

## Removed Patterns

### Password-Based Admin Creation (Removed 2026-01-07)

**Previous endpoint**: `POST /api/v1/users` (removed)

**Why removed**: Security anti-pattern (password sharing), poor UX

**Migration**: Use invitation-based pattern for admin-created accounts

## Technical Details

### Database Models

**User table:**

```prisma
model User {
  id            String    @id @default(cuid())
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false)
  password      String?   // Hashed by better-auth (scrypt)
  role          String    @default("USER")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}
```

**Verification table (invitation tokens):**

```prisma
model Verification {
  id         String   @id @default(cuid())
  identifier String   // Format: "invitation:{email}"
  value      String   // SHA-256 hashed token
  expiresAt  DateTime
  metadata   Json?    // { name, role, invitedBy, invitedAt }
  createdAt  DateTime @default(now())
}
```

### API Endpoints

**Self-Signup (Email/Password):**

- `POST /api/auth/sign-up/email` - better-auth endpoint
- Request: `{ name, email, password }`
- Response: `{ user: { id, name, email }, session: { token } }`

**OAuth Signup:**

- `GET /api/auth/oauth/google` - Initiate Google OAuth flow
- `GET /api/auth/oauth/github` - Initiate GitHub OAuth flow
- `GET /api/auth/callback/google` - OAuth callback handler
- Response: Redirects to app with session token

**Invitation:**

- `POST /api/v1/users/invite` - Create invitation (admin only)
- Request: `{ name, email, role }`
- Response: `{ invitation: { email, name, role, invitedAt, expiresAt, link } }`

**Accept Invitation:**

- `POST /api/auth/accept-invite` - Accept invitation (public with token)
- Request: `{ token, email, password, confirmPassword }`
- Response: `{ message: "Invitation accepted successfully" }`

**Get Invitation Metadata:**

- `GET /api/v1/invitations/metadata?token={token}&email={email}` - Get invitation details (public)
- Response: `{ name, role }`

### Email Templates

**Verification Email** (`emails/verify-email.tsx`):

- Sent: After self-signup (production only)
- Contains: Verification link with token
- Expiration: 24 hours

**Invitation Email** (`emails/invitation.tsx`):

- Sent: When admin invites user
- Contains: Accept link with token
- Expiration: 7 days

**Welcome Email** (`emails/welcome.tsx`):

- Sent: After invitation acceptance
- Contains: Dashboard link, getting started tips
- Non-blocking: Email failure doesn't fail acceptance

## Testing

### Self-Signup (Email/Password)

```bash
# Test signup
curl -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"SecurePassword123!"}'

# Check if email verification required
# Development: Can log in immediately
# Production: Must verify email first
```

### OAuth Signup

```bash
# Test OAuth (browser required)
open http://localhost:3000/api/auth/oauth/google

# Or from UI
# Click "Sign in with Google" button
# Complete OAuth consent flow
# Redirected back to app with session
```

### Invitation-Based

```bash
# 1. Admin invites user
curl -X POST http://localhost:3000/api/v1/users/invite \
  -H "Cookie: better-auth.session_token=..." \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com","role":"USER"}'

# 2. Check email for invitation link
# Link format: /accept-invite?token={token}&email={email}

# 3. User accepts invitation
curl -X POST http://localhost:3000/api/auth/accept-invite \
  -H "Content-Type: application/json" \
  -d '{
    "token":"...",
    "email":"john@example.com",
    "password":"SecurePassword123!",
    "confirmPassword":"SecurePassword123!"
  }'

# 4. User logs in
curl -X POST http://localhost:3000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"SecurePassword123!"}'
```

## Decision History

### Why Environment-Based Email Verification?

**Decision**: Email verification enabled in production, disabled in development
**Rationale**:

- Development: Fast iteration without email setup
- Production: Security best practice (verify email ownership)
- Override: Allow explicit control via environment variable

**Trade-offs**:

- Inconsistency between environments (testing needed)
- Documentation burden (explain environment differences)
- Benefit: Developer experience vs. production security

## Related Documentation

- [Authentication Overview](./overview.md) - Complete auth system architecture
- [Email System](../email/overview.md) - Email sending and templates
- [API Endpoints](../api/endpoints.md) - API reference for all endpoints
- [Mobile Integration](../api/mobile-integration.md) - Mobile app authentication guide
