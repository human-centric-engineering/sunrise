# OAuth Provider Integration

This document covers setting up OAuth providers (Google, GitHub, etc.) for social login in Sunrise.

## Google OAuth Setup

### 1. Configure Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Enable "Google+ API" or "Google Identity Services"
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
5. Application type: "Web application"
6. Authorized JavaScript origins:
   - `http://localhost:3000` (development)
   - `https://yourdomain.com` (production)
7. Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://yourdomain.com/api/auth/callback/google`
8. Copy the Client ID and Client Secret

### 2. Add Environment Variables

```bash
GOOGLE_CLIENT_ID="your-client-id-here.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret-here"
```

### 3. Provider Configuration

Provider is already configured in `lib/auth/config.ts`:

```typescript
export const auth = betterAuth({
  // ... other config
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
  },
});
```

## OAuth Components

Sunrise includes reusable OAuth components in `components/forms/`.

### Generic OAuth Button

```typescript
// components/forms/oauth-button.tsx
'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'

interface OAuthButtonProps {
  provider: 'google' // Add more: 'github' | 'facebook' etc.
  children: React.ReactNode
  callbackUrl?: string
}

export function OAuthButton({ provider, children, callbackUrl }: OAuthButtonProps) {
  const [isLoading, setIsLoading] = useState(false)
  const searchParams = useSearchParams()
  const redirect = callbackUrl || searchParams.get('callbackUrl') || '/dashboard'

  const handleOAuthSignIn = async () => {
    try {
      setIsLoading(true)
      await authClient.signIn.social({
        provider,
        callbackURL: redirect,
      })
      // User is redirected to OAuth provider
    } catch (error) {
      setIsLoading(false)
      console.error('OAuth sign-in error:', error)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={isLoading}
      onClick={() => void handleOAuthSignIn()}
    >
      {isLoading ? 'Redirecting...' : children}
    </Button>
  )
}
```

### OAuth Buttons Section

```typescript
// components/forms/oauth-buttons.tsx
'use client'

import { OAuthButton } from './oauth-button'

export function OAuthButtons({ callbackUrl }: { callbackUrl?: string }) {
  return (
    <div className="space-y-4">
      {/* OAuth Provider Buttons */}
      <div className="space-y-2">
        <OAuthButton provider="google" callbackUrl={callbackUrl}>
          <GoogleIcon />
          <span className="ml-2">Continue with Google</span>
        </OAuthButton>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">
            Or continue with email
          </span>
        </div>
      </div>
    </div>
  )
}
```

### Usage in Forms

OAuth buttons are already integrated into login and signup forms:

```typescript
// components/forms/login-form.tsx or signup-form.tsx
import { OAuthButtons } from './oauth-buttons'

export function LoginForm() {
  return (
    <div className="space-y-4">
      {/* OAuth Buttons at top */}
      <OAuthButtons callbackUrl="/dashboard" />

      {/* Email/Password form below */}
      <form>{/* ... */}</form>
    </div>
  )
}
```

### OAuth Error Handling

OAuth errors from URL params are automatically handled:

```typescript
// In login/signup forms
useEffect(() => {
  const oauthError = searchParams.get('error');
  const oauthErrorDescription = searchParams.get('error_description');

  if (oauthError) {
    setError(oauthErrorDescription || 'OAuth authentication failed. Please try again.');
  }
}, [searchParams]);
```

## Adding Additional OAuth Providers

To add more providers (GitHub, Facebook, etc.), follow this pattern:

### 1. Add Environment Variables

```bash
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-client-secret"
```

### 2. Update Auth Configuration

```typescript
// lib/auth/config.ts
export const auth = betterAuth({
  socialProviders: {
    google: {/* ... */},
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      enabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    },
  },
});
```

### 3. Update OAuthButton Type

```typescript
// components/forms/oauth-button.tsx
interface OAuthButtonProps {
  provider: 'google' | 'github'; // Add new provider here
  children: React.ReactNode;
  callbackUrl?: string;
}
```

### 4. Add Button to OAuthButtons Component

```typescript
// components/forms/oauth-buttons.tsx
export function OAuthButtons({ callbackUrl }: { callbackUrl?: string }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <OAuthButton provider="google" callbackUrl={callbackUrl}>
          <GoogleIcon />
          <span className="ml-2">Continue with Google</span>
        </OAuthButton>

        {/* Add new provider */}
        <OAuthButton provider="github" callbackUrl={callbackUrl}>
          <GitHubIcon />
          <span className="ml-2">Continue with GitHub</span>
        </OAuthButton>
      </div>
      {/* Divider ... */}
    </div>
  )
}
```

### 5. No schema change

A new provider needs nothing in `prisma/schema/auth.prisma`. An `Account` row
is identified by `(providerId, accountId)` and better-auth writes both. See
[Account Identity](#account-identity-providerid-accountid) for what a row
written outside better-auth must carry.

## OAuth Flow

1. User clicks "Continue with Google"
2. `authClient.signIn.social()` initiates OAuth flow
3. User redirected to Google OAuth consent screen
4. Google redirects to `/api/auth/callback/google`
5. better-auth handles callback automatically:
   - Creates new user if first-time (signup flow)
   - Links account if existing user
   - Creates session
6. User redirected to callback URL (dashboard)

## Account Identity: `(providerId, accountId)`

An `Account` row is identified by the pair **`(providerId, accountId)`**, as in
better-auth 1.6. `accountId` is the provider's subject — the verified `sub`
claim for Google — and for a credential (email/password) row it is the owning
`User.id`. Sign-in asserts that last one: a credential row whose `accountId` is
not its user's id simply cannot be signed in to.

**Anything that writes an `Account` outside better-auth — a smoke fixture, a
seed, a fork's importer — sets `providerId`, `accountId` and `userId`, and for
a credential row sets `accountId = userId`.** Nothing else is an identity key.

### The `issuer` detour (better-auth 1.7.0–1.7.2)

Those three releases keyed identity on an `issuer` column instead — the OIDC
issuer for social accounts, `local:credential` for email/password — and 0.11.0
shipped 1.7.1 without the column, which took out every sign-in in production.
`20260825120000_add_account_issuer` (#672) added and backfilled it.

**1.7.3 reverted the re-keying** and committed to keeping the core account
schema stable for the rest of v1. From then on better-auth never writes
`issuer`, and a `NOT NULL` column nothing writes fails every insert into
`account` — sign-up, first social sign-in and account linking — while existing
users keep signing in and nothing in the toolchain says why.
`20260915180000_drop_account_issuer` drops the column and its index. Both
statements are `IF EXISTS`, so a database on which an operator already ran the
upstream cleanup by hand takes the migration as a no-op. Note the index name:
Prisma called it `account_issuer_accountId_key`; the upstream recipe's
`account_issuer_accountId_uidx` never existed on a Sunrise database.

**Do not revive the column.** `tests/unit/prisma/auth-schema-parity.test.ts`
derives both directions from better-auth's own tables — every column it reads
must exist, and nothing this schema requires may be a column it never writes —
so a future release that needs `issuer` back fails that test on the version
bump, with a backfill to write, rather than in production. The reverse check
lives in that test rather than in better-auth's own init-time validation
because, under Prisma 7's compact runtime data model, the adapter cannot see
whether a column is required and so — by its own docblock — "reports missing
tables and columns but never a required column".

## Linking Social Accounts

Allow users to link additional OAuth providers to their existing account:

```typescript
// components/settings/linked-accounts.tsx
'use client'

import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'

export function LinkedAccounts() {
  const linkGoogle = async () => {
    await authClient.linkSocial({
      provider: 'google',
    })
  }

  return (
    <div>
      <h2>Linked Accounts</h2>
      <Button onClick={linkGoogle}>
        Link Google Account
      </Button>
    </div>
  )
}
```

## Provider-Specific Configuration

### Google

- Scopes: `email`, `profile` (default)
- Account linking: Automatic by email
- Profile data: name, email, image

### GitHub (if added)

- Scopes: `read:user`, `user:email`
- Account linking: Automatic by email
- Profile data: name, email, avatar_url

## Troubleshooting

### "Invalid redirect URI"

Ensure your redirect URIs exactly match:

- Development: `http://localhost:3000/api/auth/callback/[provider]`
- Production: `https://yourdomain.com/api/auth/callback/[provider]`

### "Access blocked: App not verified"

For development, click "Advanced" → "Go to [app name] (unsafe)". For production, complete Google's verification process.

### OAuth state mismatch

Clear cookies and try again. This usually happens when switching between environments.

## Related Documentation

- [Auth Forms](./forms.md) - Login and signup form implementation
- [Session Management](./sessions.md) - Post-OAuth session handling
- [Auth Integration](./integration.md) - Route protection patterns
