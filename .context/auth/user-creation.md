# User Creation Patterns

**Version**: 2.2.0
**Last Updated**: 2026-01-07
**Status**: Production-ready

## Overview

Sunrise supports three user creation patterns: **self-signup** (email/password or OAuth), **OAuth signup** (social login), and **invitation-based** (admin-initiated with password OR OAuth acceptance). All patterns prioritize security and user experience, and all patterns send welcome emails automatically.

## Pattern Comparison

| Aspect             | Self-Signup (Email/Password)   | OAuth Signup (Social Login)      | Invitation-Based                                      |
| ------------------ | ------------------------------ | -------------------------------- | ----------------------------------------------------- |
| Initiated by       | User                           | User                             | Admin                                                 |
| Endpoint           | `POST /api/auth/sign-up/email` | `GET /api/auth/oauth/{provider}` | `POST /api/v1/users/invite`                           |
| User provides      | Name, email, password          | OAuth consent                    | -                                                     |
| Admin provides     | -                              | -                                | Name, email, role                                     |
| Acceptance method  | N/A (direct signup)            | N/A (direct signup)              | Password setup OR OAuth (user choice)                 |
| Password required  | Yes                            | No                               | Optional (password OR OAuth)                          |
| Email verification | Environment-based              | Auto-verified by OAuth provider  | Auto-verified on acceptance                           |
| Welcome email      | ✅ Sent on signup              | ✅ Sent on signup                | ✅ Sent on acceptance                                 |
| Security           | High (user-controlled)         | High (OAuth provider)            | Highest (token-based + user choice)                   |
| UX                 | Excellent (self-service)       | Excellent (one-click)            | Excellent (choice of password OR OAuth)               |
| Recommended for    | Public user registration       | Quick signups, social accounts   | Team invites, admin-created accounts with flexibility |

## Self-Signup Pattern (Primary - User-Initiated)

**Use Case**: Public user registration, SaaS signups, open community access

### Flow

1. User visits signup page
2. User provides name, email, and password
3. better-auth creates account with hashed password
4. **Welcome email sent** (all environments)
5. **Verification email sent** (if enabled in production)
6. User verifies email (production) or logs in directly (development)

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
7. **Welcome email sent** (for new signups only, not existing user logins)
8. User logged in immediately

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

3. **User accepts invitation** - Two options available:

   **Option A: Accept with OAuth (Recommended)**
   - User clicks "Accept with Google" button on invitation page
   - OAuth flow initiated with invitation token/email in state
   - Google verifies user identity
   - System creates user account via better-auth (stable User ID)
   - Role from invitation metadata applied automatically
   - Email auto-verified by OAuth provider
   - Welcome email sent
   - Invitation token deleted
   - User logged in immediately

   **Option B: Accept with Password**
   - User sets password on invitation page
   - Submits via `POST /api/auth/accept-invite`
   - System creates user account via better-auth (stable User ID)
   - Email auto-verified on acceptance
   - Welcome email sent
   - Invitation token deleted
   - User must log in with new credentials

4. **User accesses dashboard** with assigned role

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

**User accepts invitation (Option A: OAuth):**

```typescript
// Accept invitation page - OAuth button
import { OAuthButtons } from '@/components/forms/oauth-buttons';

export default function AcceptInvitePage({ searchParams }) {
  const token = searchParams.get('token');
  const email = searchParams.get('email');

  return (
    <div>
      <h1>Accept Invitation</h1>

      {/* OAuth acceptance (recommended) */}
      <OAuthButtons
        mode="invitation"
        invitationToken={token}
        invitationEmail={email}
        callbackUrl="/dashboard"
      />

      {/* OR */}

      {/* Password form (alternative) */}
      <form onSubmit={handlePasswordAcceptance}>
        {/* ... password fields ... */}
      </form>
    </div>
  );
}
```

**OAuth invitation flow is handled automatically in the `before` hook:**

```typescript
// lib/auth/config.ts - Database hooks (automatic)
databaseHooks: {
  user: {
    create: {
      // before hook: validates email match, applies role, deletes token — all BEFORE user creation
      before: async (user, ctx) => {
        const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

        if (isOAuthSignup) {
          const oauthState = await getOAuthState();
          const invitationEmail = oauthState?.invitationEmail;
          const invitationToken = oauthState?.invitationToken;

          // Reject if OAuth email doesn't match invitation email
          if (invitationEmail && user.email !== invitationEmail) {
            throw new APIError('BAD_REQUEST', {
              message: `This invitation was sent to ${invitationEmail}. Please use an account with that email address, or set a password instead.`,
            });
          }

          // Validate token, delete it immediately, apply role to user before creation
          if (invitationToken && invitationEmail && user.email === invitationEmail) {
            const isValid = await validateInvitationToken(invitationEmail, invitationToken);

            if (isValid) {
              const invitation = await getValidInvitation(invitationEmail);

              // Token deleted BEFORE user creation to close concurrent-signup race condition
              await deleteInvitationToken(invitationEmail);
              logger.info('OAuth invitation token consumed', { email: invitationEmail });

              if (invitation?.metadata?.role && invitation.metadata.role !== 'USER') {
                // Return merged user data — user is created with the correct role immediately
                return { data: { ...user, role: invitation.metadata.role } };
              }
            }
          }
        }

        return { data: user };
      },

      // after hook: sets preferences, detects password invitations, sends welcome email
      // Does NOT handle OAuth invitation tokens — those are fully processed in the before hook.
      after: async (user, ctx) => {
        const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

        // Set default preferences for all new users
        await prisma.user.update({
          where: { id: user.id },
          data: { preferences: DEFAULT_USER_PREFERENCES },
        });

        // Detect password invitation acceptance
        let isPasswordInvitation = false;
        if (!isOAuthSignup) {
          const invitation = await getValidInvitation(user.email);
          if (invitation) isPasswordInvitation = true;
        }

        // Send welcome email (OAuth and password-invitation users: immediately;
        // password signup with verification enabled: after email verification)
        const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';
        const shouldSendWelcomeNow = isOAuthSignup || !requiresVerification || isPasswordInvitation;
        if (shouldSendWelcomeNow) {
          await sendEmail({
            to: user.email,
            subject: 'Welcome to Sunrise',
            react: WelcomeEmail({ userName: user.name, userEmail: user.email }),
          });
        }
      },
    }
  }
}
```

**User accepts invitation (Option B: Password):**

```typescript
// Accept invitation page - Password form
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

- Sent: After **all user signups** (email/password, OAuth, and invitation acceptance)
- Trigger: Database hook after user creation (`lib/auth/config.ts`)
- Contains: Personalized greeting, dashboard link, getting started tips
- Non-blocking: Email failure doesn't prevent signup/acceptance
- Sent only once: Only for new user creation, not existing OAuth user logins

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

# 3a. User accepts invitation with OAuth (recommended)
# - Visit invitation link in browser
# - Click "Accept with Google" button
# - Complete OAuth flow
# - Automatically logged in with assigned role

# 3b. User accepts invitation with password
curl -X POST http://localhost:3000/api/auth/accept-invite \
  -H "Content-Type: application/json" \
  -d '{
    "token":"...",
    "email":"john@example.com",
    "password":"SecurePassword123!",
    "confirmPassword":"SecurePassword123!"
  }'

# 4. User logs in (if password method used)
curl -X POST http://localhost:3000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"SecurePassword123!"}'
```

## Decision History

### Why OAuth Invitation Acceptance? (Added 2026-01-07)

**Decision**: Allow invited users to accept invitations via OAuth instead of password-only

**Rationale**:

- **Better UX**: Users can accept invitations with their existing Google account (one-click)
- **Reduced friction**: No need to create and remember another password
- **Higher security**: OAuth providers (Google) have stronger authentication than most users' passwords
- **Consistency**: OAuth is already available for standard signup, should be available for invitations
- **Flexibility**: Users choose their preferred method (OAuth OR password)

**Implementation**:

- OAuth button added to accept-invite page with `mode="invitation"`
- Invitation token/email passed through OAuth state
- `before` database hook validates email match, deletes the token (before user creation to prevent race conditions), and returns the user data with the invitation role merged in — so the user is created with the correct role and the session reflects it immediately
- `after` hook does NOT process OAuth invitations; it only detects password invitations
- Non-blocking: Invitation processing failures (other than email mismatch) don't prevent OAuth signup

**Trade-offs**:

- ✅ **Pro**: Better UX, higher security, more flexibility
- ⚠️ **Con**: Slightly more complex implementation (database hook logic)
- ⚠️ **Con**: Requires OAuth provider configuration (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)

### Why Welcome Emails for All Signups? (Added 2026-01-07)

**Decision**: Send welcome email for all user signups (email/password, OAuth, and invitation acceptance)

**Rationale**:

- **Consistent onboarding**: All users receive the same welcome experience
- **User confirmation**: Confirms account creation and provides next steps
- **Dashboard link**: Direct link to get started immediately
- **Brand impression**: First interaction with the app via email

**Implementation**:

- Database hook `databaseHooks.user.create.after` sends welcome email
- Triggers automatically after any user creation (OAuth, email/password, invitation)
- Non-blocking: Email failures logged but don't prevent signup
- Sent only once: Only for new user creation, not existing OAuth user logins

**Trade-offs**:

- ✅ **Pro**: Better UX, consistent onboarding, user confirmation
- ⚠️ **Con**: Users may receive multiple emails (welcome + verification) in production
- ⚠️ **Con**: Requires email configuration (RESEND_API_KEY, EMAIL_FROM)

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
