# Authentication Overview

## Authentication System

Sunrise uses **better-auth** for authentication, a modern TypeScript-first framework that provides flexible authentication strategies: email/password, OAuth providers (Google, GitHub, etc.), and magic links. better-auth is the official successor to NextAuth.js, recommended by the NextAuth team for all new projects.

The system implements session-based authentication with user data persisted in PostgreSQL via Prisma. This approach balances security, performance, and developer experience while eliminating common complexity like provider wrappers.

## Authentication Flow

### Credentials Flow (Email/Password)

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant BetterAuth
    participant API
    participant DB

    User->>Browser: Enter email/password
    Browser->>BetterAuth: POST /api/auth/sign-in/email
    BetterAuth->>DB: findUnique(email)
    DB-->>BetterAuth: User data with hashed password
    BetterAuth->>BetterAuth: Verify password (scrypt)
    BetterAuth-->>Browser: Set session cookie (HTTP-only)
    Browser-->>User: Redirect to dashboard
```

### OAuth Flow (Google)

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant BetterAuth
    participant Google
    participant DB

    User->>Browser: Click "Sign in with Google"
    Browser->>BetterAuth: GET /api/auth/sign-in/social
    BetterAuth-->>Browser: Redirect to Google
    Browser->>Google: Authorization request
    Google-->>User: Login prompt
    User->>Google: Approve access
    Google-->>Browser: Redirect with code
    Browser->>BetterAuth: Callback with code
    BetterAuth->>Google: Exchange code for token
    Google-->>BetterAuth: User profile data
    BetterAuth->>DB: findOrCreate(googleId)
    DB-->>BetterAuth: User record
    BetterAuth->>Browser: Set session cookie
    Browser-->>User: Redirect to dashboard
```

## Core Configuration

### better-auth Configuration

```typescript
// lib/auth/config.ts
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from '@/lib/db/client';

export const auth = betterAuth({
  // Database adapter
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Base URL for the application
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',

  // Secret for JWT signing
  secret: process.env.BETTER_AUTH_SECRET,

  // Enable email and password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Will be enabled in Phase 3 with email system
  },

  // Social authentication providers
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
  },

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days in seconds
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },

  // User model customization
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'USER',
        required: false,
      },
    },
  },

  // Database hooks for lifecycle events (see below)
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          /* validation logic */
        },
        after: async (user) => {
          /* post-creation logic */
        },
      },
    },
  },
});

// Export the auth handler type for use in API routes
export type Auth = typeof auth;
```

### Database Hooks

better-auth provides lifecycle hooks that run during database operations. Sunrise uses these hooks for invitation processing and welcome email automation.

#### User Creation Hooks

```typescript
// lib/auth/config.ts
databaseHooks: {
  user: {
    create: {
      /**
       * before hook - Validates OAuth invitation email match, applies role, deletes token
       *
       * For OAuth invitation flow:
       * 1. Validates the user's OAuth email matches the invitation email.
       * 2. Validates the invitation token and retrieves invitation metadata.
       * 3. Deletes the token immediately (before user creation) to close a race
       *    condition where two concurrent OAuth signups could both pass validation.
       * 4. Returns the user data with the invitation role merged in, so the user
       *    is created with the correct role and the session reflects it immediately.
       *
       * Throws APIError if email validation fails, preventing user creation.
       */
      before: async (user, ctx) => {
        const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

        if (isOAuthSignup) {
          const oauthState = await getOAuthState();
          const invitationEmail = oauthState?.invitationEmail;
          const invitationToken = oauthState?.invitationToken;

          // If invitation data is present, email MUST match
          if (invitationEmail && user.email !== invitationEmail) {
            throw new APIError('BAD_REQUEST', {
              message: `This invitation was sent to ${invitationEmail}. Please use an account with that email address, or set a password instead.`,
            });
          }

          // Validate token, consume it, and apply role before user creation
          if (invitationToken && invitationEmail && user.email === invitationEmail) {
            const isValidToken = await validateInvitationToken(invitationEmail, invitationToken);

            if (isValidToken) {
              const invitation = await getValidInvitation(invitationEmail);

              // Delete token NOW — prevents concurrent OAuth signups from reusing it
              await deleteInvitationToken(invitationEmail);
              logger.info('OAuth invitation token consumed', { email: invitationEmail });

              if (invitation?.metadata?.role && invitation.metadata.role !== 'USER') {
                return { data: { ...user, role: invitation.metadata.role } };
              }
            }
          }
        }

        return { data: user };
      },

      /**
       * after hook - Sets preferences, detects password invitations, sends welcome email
       *
       * Triggered after a new user is created via:
       * - Email/password signup
       * - OAuth/social login (only for NEW users, not existing logins)
       *
       * Responsibilities:
       * 1. Set default user preferences
       * 2. Detect password invitation acceptance (to send welcome email immediately)
       * 3. Send welcome email (timing depends on signup method and verification config)
       *
       * Note: OAuth invitation token deletion and role assignment both happen in the
       * before hook. The after hook does NOT process OAuth invitations.
       *
       * Non-blocking - logs errors but doesn't prevent signup completion.
       */
      after: async (user, ctx) => {
        const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

        // 1. Set default preferences
        await prisma.user.update({
          where: { id: user.id },
          data: { preferences: DEFAULT_USER_PREFERENCES }
        });

        // 2. Detect password invitation acceptance
        let isPasswordInvitation = false;
        if (!isOAuthSignup) {
          const invitation = await getValidInvitation(user.email);
          if (invitation) {
            isPasswordInvitation = true;
          }
        }

        // 3. Send welcome email
        // - OAuth users: email auto-verified by provider, send immediately
        // - Password users: send after email verification (via emailVerification.afterEmailVerification)
        // - Password invitation users: send immediately (email verified by accept-invite route)
        const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';
        const shouldSendWelcomeNow = isOAuthSignup || !requiresVerification || isPasswordInvitation;
        if (shouldSendWelcomeNow) {
          await sendEmail({
            to: user.email,
            subject: 'Welcome to Sunrise',
            react: WelcomeEmail({ userName: user.name, userEmail: user.email })
          });
        }
      }
    }
  }
}
```

**Key behaviors:**

- `before` hook: Validates data, applies invitation role, deletes invitation token — can reject user creation by throwing an error
- `after` hook: Non-blocking operations (errors logged, not thrown); does NOT handle OAuth invitation tokens
- OAuth state: Passed via `additionalData` parameter in OAuth flow
- Invitation token deletion: Happens in the `before` hook (before user creation) to prevent race conditions from concurrent OAuth signups

### API Route Handler

```typescript
// app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth/config';
import { toNextJsHandler } from 'better-auth/next-js';

export const { POST, GET } = toNextJsHandler(auth);
```

## Session Management

### Server-Side Session Access

```typescript
// In Server Components
import { auth } from '@/lib/auth/config'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    redirect('/login')
  }

  return <Dashboard user={session.user} />
}
```

```typescript
// In API Routes
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';

export async function GET(request: NextRequest) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Access session.user.id, session.user.email, etc.
  const data = await fetchUserData(session.user.id);
  return Response.json({ data });
}
```

### Server-Side Utilities

```typescript
// lib/auth/utils.ts
import { auth } from './config';
import { headers } from 'next/headers';
import { logger } from '@/lib/logging';

/**
 * Session type derived from better-auth configuration.
 *
 * Uses ReturnType inference so the type automatically includes custom fields
 * (e.g. `role`) defined in `auth.user.additionalFields` and stays in sync
 * with the better-auth config without manual maintenance.
 */
type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * Get the current user session on the server
 */
export async function getServerSession(): Promise<AuthSession | null> {
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({
      headers: requestHeaders,
    });
    return session;
  } catch (error) {
    logger.error('Failed to get server session', error);
    return null;
  }
}

/**
 * Get the current authenticated user on the server
 */
export async function getServerUser(): Promise<AuthSession['user'] | null> {
  const session = await getServerSession();
  return session?.user ?? null;
}

/**
 * Check if the current user has a specific role
 */
export async function hasRole(requiredRole: string): Promise<boolean> {
  const user = await getServerUser();
  if (!user) return false;
  return user.role === requiredRole;
}

/**
 * Require authentication for a server component or API route
 * @throws Error if not authenticated
 */
export async function requireAuth(): Promise<AuthSession> {
  const session = await getServerSession();
  if (!session) {
    throw new Error('Authentication required');
  }
  return session;
}

/**
 * Require a specific role for a server component or API route
 * @throws Error if not authenticated or doesn't have required role
 */
export async function requireRole(requiredRole: string): Promise<AuthSession> {
  const session = await requireAuth();
  if (session.user.role !== requiredRole) {
    throw new Error(`Role ${requiredRole} required`);
  }
  return session;
}

/**
 * Type guard for checking if a session exists
 */
export function isAuthenticated(session: AuthSession | null): session is AuthSession {
  return session !== null;
}
```

### Email Verification Status

```typescript
// lib/auth/verification-status.ts
import { prisma } from '@/lib/db/client';

export type VerificationStatus = 'verified' | 'pending' | 'not_sent';

/**
 * Get the verification status for a user's email
 *
 * @returns 'verified' - Email is verified
 * @returns 'pending' - Verification email sent, awaiting user action
 * @returns 'not_sent' - Email unverified and no verification email sent
 */
export async function getVerificationStatus(
  email: string,
  emailVerified: boolean
): Promise<VerificationStatus> {
  if (emailVerified) return 'verified';

  // Check if a verification token exists
  const verificationToken = await prisma.verification.findFirst({
    where: {
      identifier: email,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });

  return verificationToken ? 'pending' : 'not_sent';
}
```

### Clear Invalid Session

```typescript
// lib/auth/clear-session.ts
import { redirect } from 'next/navigation';

/**
 * Clear the better-auth session cookie and redirect to login
 *
 * Use when you detect an invalid session (user deleted, session expired)
 * to prevent infinite redirect loops.
 *
 * @param returnUrl - Optional URL to return to after login
 */
export function clearInvalidSession(returnUrl: string = '/'): never {
  const clearSessionUrl = `/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`;
  redirect(clearSessionUrl);
}
```

### Client-Side Session Access

**No Provider Wrapper Needed!** better-auth uses nanostore for state management, eliminating the need for React context providers.

```typescript
// lib/auth/client.ts
'use client';

import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
});

export const { useSession } = authClient;
```

```typescript
// In Client Components
'use client'

import { useSession } from '@/lib/auth/client'

export function UserProfile() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return <Skeleton />
  }

  if (!session) {
    return <LoginPrompt />
  }

  return <div>Welcome, {session.user.name}</div>
}
```

## Password Management

### Password Validation

```typescript
// lib/validations/auth.ts
import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must be less than 100 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const emailSchema = z
  .string()
  .min(1, 'Email is required')
  .email('Invalid email address')
  .max(255)
  .toLowerCase()
  .trim();

export const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().min(1).max(100).trim(),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
```

## Route Protection

### Middleware-Based Protection

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';

const protectedRoutes = ['/dashboard', '/settings', '/profile'];
const authRoutes = ['/login', '/signup', '/reset-password'];

function isAuthenticated(request: NextRequest): boolean {
  const sessionToken = request.cookies.get('better-auth.session_token');
  return !!sessionToken;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = isAuthenticated(request);

  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));

  // Redirect unauthenticated users to login
  if (isProtectedRoute && !authenticated) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && authenticated) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

## Decision History & Trade-offs

### better-auth vs. NextAuth.js v5

**Decision**: Use better-auth instead of NextAuth.js v5
**Rationale**:

- Official recommendation from NextAuth team
- Simpler architecture (no provider wrapper)
- Modern patterns (nanostore instead of React context)
- Native Prisma 7 support
- Active development and maintenance
- TypeScript-first design

**Trade-offs**:

- Smaller community than NextAuth.js
- Fewer examples and tutorials
- Newer framework (less battle-tested)

**Mitigation**: Comprehensive documentation, tested patterns in this codebase

### Session Management

**Decision**: Cookie-based sessions with better-auth defaults
**Rationale**:

- HTTP-only cookies prevent XSS attacks
- Automatic CSRF protection
- Works with Server Components
- No client-side session storage needed

**Trade-offs**: Sessions tied to domain (no cross-domain auth without additional setup)

### Password Hashing

**Decision**: Let better-auth handle password hashing (uses bcrypt internally)
**Rationale**:

- Framework handles security best practices
- Consistent hashing across auth flows
- Reduces custom code and potential errors

**Trade-offs**: Less control over hashing algorithm and rounds

## Performance Considerations

### Session Caching

better-auth caches sessions client-side for 5 minutes (configurable). Server-side calls to `getSession()` are fast cookie reads, no database hit per request.

### Database Connection Pooling

Prisma handles connection pooling (default: 10 connections). For high-traffic auth endpoints, adjust in `DATABASE_URL`:

```
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20"
```

## Related Documentation

- [Auth Integration](./integration.md) - Framework integration patterns for better-auth
- [Auth Security](./security.md) - Security model and threat mitigation
- [API Headers](../api/headers.md) - Authentication headers and middleware
- [Database Models](../database/models.md) - User and session schema
