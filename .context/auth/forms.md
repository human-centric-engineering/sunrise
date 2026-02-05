# Authentication Forms

This document covers form implementation patterns for authentication flows in Sunrise, including signup, login, and client-side session usage.

## Session Types and Hooks

### SessionUser Interface

The `SessionUser` interface defines the typed user object with all custom fields included. better-auth's client types don't automatically include `additionalFields` defined in the server config (like `role`), so we provide this interface for type safety.

```typescript
// lib/auth/client.ts
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role: UserRole; // 'USER' | 'ADMIN'
  createdAt: Date;
  updatedAt: Date;
}

export interface TypedSessionData {
  user: SessionUser;
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}
```

### useSession Hook

The `useSession` hook is a thin wrapper around better-auth's `authClient.useSession` that adds runtime validation for custom user fields (`role`). This ensures the type assertion is backed by an actual runtime check.

**Why a wrapper instead of a type cast:**

- better-auth's client types don't include `additionalFields` automatically
- A bare `as` cast would silently produce wrong types if the server config changes
- This wrapper validates `role` at runtime, defaulting to 'USER' if unexpected

```typescript
'use client'
import { useSession, type SessionUser } from '@/lib/auth/client'

export function UserProfile() {
  const { data: session, isPending, error } = useSession()

  if (isPending) return <div>Loading...</div>
  if (error) return <div>Error loading session</div>
  if (!session) return <div>Not authenticated</div>

  // session.user is typed as SessionUser with role included
  return (
    <div>
      <h1>Welcome, {session.user.name}!</h1>
      <p>Role: {session.user.role}</p> {/* TypeScript knows about role */}
    </div>
  )
}
```

## Sign Up Form

```typescript
// components/forms/signup-form.tsx
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/lib/auth/client'
import { useRouter } from 'next/navigation'
import { signUpSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SignupForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
    },
  })

  const onSubmit = async (data: SignUpInput) => {
    try {
      await authClient.signUp.email(
        {
          email: data.email,
          password: data.password,
          name: data.name,
        },
        {
          onRequest: () => {
            // Show loading state
            setError(null)
          },
          onSuccess: () => {
            // Redirect to dashboard after successful signup
            router.push('/dashboard')
            router.refresh()
          },
          onError: (ctx) => {
            setError(ctx.error.message || 'Failed to create account')
          },
        }
      )
    } catch (error) {
      setError('An unexpected error occurred. Please try again.')
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <Input
        {...form.register('name')}
        placeholder="Full Name"
        error={form.formState.errors.name?.message}
      />
      <Input
        {...form.register('email')}
        type="email"
        placeholder="Email"
        error={form.formState.errors.email?.message}
      />
      <Input
        {...form.register('password')}
        type="password"
        placeholder="Password"
        error={form.formState.errors.password?.message}
      />
      {error && (
        <p className="text-red-500">{error}</p>
      )}
      <Button type="submit" loading={form.formState.isSubmitting}>
        Sign Up
      </Button>
    </form>
  )
}
```

## Login Form

```typescript
// components/forms/login-form.tsx
'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/lib/auth/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard'
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  const onSubmit = async (data: SignInInput) => {
    try {
      await authClient.signIn.email(
        {
          email: data.email,
          password: data.password,
        },
        {
          onRequest: () => {
            setError(null)
          },
          onSuccess: () => {
            router.push(callbackUrl)
            router.refresh()
          },
          onError: (ctx) => {
            setError('Invalid email or password')
          },
        }
      )
    } catch (error) {
      setError('An unexpected error occurred. Please try again.')
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <Input
        {...form.register('email')}
        type="email"
        placeholder="Email"
        error={form.formState.errors.email?.message}
      />
      <Input
        {...form.register('password')}
        type="password"
        placeholder="Password"
        error={form.formState.errors.password?.message}
      />
      {error && (
        <p className="text-red-500">{error}</p>
      )}
      <Button type="submit" loading={form.formState.isSubmitting}>
        Login
      </Button>
    </form>
  )
}
```

## Using Session in Client Components

```typescript
// components/user-profile.tsx
'use client'

import { useSession } from '@/lib/auth/client'

export function UserProfile() {
  const { data: session, isPending, error } = useSession()

  if (isPending) {
    return <div>Loading...</div>
  }

  if (error) {
    return <div>Error loading session: {error.message}</div>
  }

  if (!session) {
    return <div>Not authenticated</div>
  }

  return (
    <div>
      <h1>Welcome, {session.user.name}!</h1>
      <p>Email: {session.user.email}</p>
      <p>Email verified: {session.user.emailVerified ? 'Yes' : 'No'}</p>
      {session.user.image && (
        <img src={session.user.image} alt="Profile" />
      )}
    </div>
  )
}
```

## Client-Side Role Checks

```typescript
// components/admin-panel.tsx
'use client'

import { useSession } from '@/lib/auth/client'

export function AdminPanel() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return <div>Loading...</div>
  }

  if (session?.user?.role !== 'ADMIN') {
    return null // Don't render for non-admins
  }

  return (
    <div>
      <h2>Admin Panel</h2>
      {/* Admin controls */}
    </div>
  )
}
```

**Note**: Client-side checks are for UX only. Always validate on server.

## Validation Schemas Reference

All authentication forms use Zod schemas from `lib/validations/auth.ts` for consistent validation. Each schema is exported with its corresponding TypeScript type.

| Schema                        | Purpose                  | Key Validations                                      |
| ----------------------------- | ------------------------ | ---------------------------------------------------- |
| `passwordSchema`              | Base password rules      | 8+ chars, uppercase, lowercase, number, special char |
| `emailSchema`                 | Email with normalization | Valid email, trimmed, lowercase, max 255             |
| `signUpSchema`                | Registration             | email, password, name, confirmPassword match         |
| `signInSchema`                | Login                    | email, password                                      |
| `changePasswordSchema`        | Password change          | currentPassword, newPassword, confirmPassword        |
| `resetPasswordRequestSchema`  | Forgot password          | email only                                           |
| `resetPasswordSchema`         | Reset completion         | token, password, confirmPassword                     |
| `verifyEmailSchema`           | Email verification       | token only                                           |
| `sendVerificationEmailSchema` | Resend verification      | email only                                           |

### Usage Example

```typescript
import { signUpSchema, type SignUpInput } from '@/lib/validations/auth';

const form = useForm<SignUpInput>({
  resolver: zodResolver(signUpSchema),
});
```

### Password Schema Details

```typescript
// lib/validations/auth.ts
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
  .max(255, 'Email must be less than 255 characters')
  .toLowerCase()
  .trim();
```

## Auth Components

Sunrise provides ready-to-use authentication components for common UI patterns:

| Component           | Location                                   | Purpose                                           |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| `UserButton`        | `components/auth/user-button.tsx`          | User avatar dropdown with profile/settings/logout |
| `LogoutButton`      | `components/auth/logout-button.tsx`        | Standalone logout button with loading state       |
| `PasswordForm`      | `components/forms/password-form.tsx`       | Change password form with strength meter          |
| `ResetPasswordForm` | `components/forms/reset-password-form.tsx` | Request + complete password reset flow            |
| `PasswordInput`     | `components/ui/password-input.tsx`         | Input with show/hide toggle                       |

### UserButton

Dropdown menu button that shows authentication state and options. When not logged in, shows login/signup options. When logged in, shows avatar with profile, settings, and sign out. Includes conditional admin dashboard link for users with `ADMIN` role.

```typescript
import { UserButton } from '@/components/auth/user-button'

// In header/navigation
<UserButton />
```

### LogoutButton

Standalone logout button with customizable variant, size, and redirect path. Handles session cleanup and analytics tracking automatically.

```typescript
import { LogoutButton } from '@/components/auth/logout-button'

<LogoutButton variant="ghost" />
<LogoutButton variant="outline" redirectTo="/login" />
```

### PasswordForm

Change password form with strength meter, validation, and success states. Revokes other sessions on password change for security.

```typescript
import { PasswordForm } from '@/components/forms/password-form'

// In settings page
<PasswordForm />
```

### ResetPasswordForm

Dual-mode component that handles both password reset request (email input) and completion (new password with token). Automatically detects which mode to show based on URL token parameter.

```typescript
import { ResetPasswordForm } from '@/components/forms/reset-password-form'

// Shows email input if no ?token param
// Shows password reset if ?token=... present
<ResetPasswordForm />
```

### PasswordInput

Password input field with show/hide toggle button. Forwards ref to underlying input element and supports all standard input props.

```typescript
import { PasswordInput } from '@/components/ui/password-input'

<PasswordInput
  id="password"
  placeholder="Enter password"
  {...register('password')}
/>
```

## Related Documentation

- [OAuth Integration](./oauth.md) - OAuth buttons and social login
- [Session Management](./sessions.md) - Server and client session handling
- [Auth Integration](./integration.md) - Route protection patterns
