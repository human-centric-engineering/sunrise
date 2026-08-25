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

### 5. Decide the provider's `issuer`

New providers need no schema change, but if you are migrating a database that
already holds rows for the new provider, extend
`20260825120000_add_account_issuer` first — it raises on a `providerId` whose
issuer it does not know, rather than guessing one.
See [Account Identity](#account-identity-issuer-accountid).

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

## Account Identity: `(issuer, accountId)`

Since better-auth 1.7, an `Account` row is identified by the pair
**`(issuer, accountId)`** — enforced by `@@unique([issuer, accountId])`.
`providerId` is local configuration only and is **never** an identity key.

| Account kind                   | `issuer`                           | `accountId`              |
| ------------------------------ | ---------------------------------- | ------------------------ |
| Email/password                 | `local:credential`                 | the owning `User.id`     |
| Google (and any OIDC provider) | `https://accounts.google.com`      | the verified `sub` claim |
| OAuth2 provider with no issuer | `local:oauth:<encoded providerId>` | the provider's subject   |

`issuer` names the authority that vouched for the subject, so two providers can
never collide on a subject string. better-auth derives it from the provider's
`accountIssuer`; `lib/auth/constants.ts` exports `CREDENTIAL_ACCOUNT_ISSUER`
for the credential case.

**Anything that writes an `Account` outside better-auth — a smoke fixture, a
seed, a fork's importer — must set `issuer`,** and a credential row must also
set `accountId` to the owning user's id. Sign-in checks all three; a row that
disagrees simply cannot be signed in to.

### Adding a provider that is not in the table above

The migration `20260825120000_add_account_issuer` deliberately **refuses to
guess**: it raises if it meets a `providerId` whose issuer it does not know.
A fork adding an OIDC provider must extend it with that provider's verified
issuer (Microsoft, for example, is
`https://login.microsoftonline.com/<tenant>/v2.0`), because an issuer cannot be
derived from a provider's name. A plain OAuth2 provider with no issuer of its
own uses `local:oauth:` + the percent-encoded `providerId`.

Getting this wrong does not fail loudly at runtime — it strands the affected
users at the login screen — which is why the migration stops instead.

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
