# Authentication Forms

This document covers form implementation patterns for authentication flows in Sunrise, including signup, login, and client-side session usage.

## Sign Up Form

```typescript
// components/forms/signup-form.tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/lib/auth/client'
import { useRouter } from 'next/navigation'
import { signupSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SignupForm() {
  const router = useRouter()

  const form = useForm({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
    },
  })

  const onSubmit = async (data: SignupFormValues) => {
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
            form.clearErrors()
          },
          onSuccess: () => {
            // Redirect to dashboard after successful signup
            router.push('/dashboard')
            router.refresh()
          },
          onError: (ctx) => {
            form.setError('root', {
              message: ctx.error.message || 'Failed to create account',
            })
          },
        }
      )
    } catch (error) {
      form.setError('root', {
        message: 'An unexpected error occurred. Please try again.',
      })
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
      {form.formState.errors.root && (
        <p className="text-red-500">{form.formState.errors.root.message}</p>
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

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/lib/auth/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { loginSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard'

  const form = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  const onSubmit = async (data: LoginFormValues) => {
    try {
      await authClient.signIn.email(
        {
          email: data.email,
          password: data.password,
        },
        {
          onRequest: () => {
            form.clearErrors()
          },
          onSuccess: () => {
            router.push(callbackUrl)
            router.refresh()
          },
          onError: (ctx) => {
            form.setError('root', {
              message: 'Invalid email or password',
            })
          },
        }
      )
    } catch (error) {
      form.setError('root', {
        message: 'An unexpected error occurred. Please try again.',
      })
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
      {form.formState.errors.root && (
        <p className="text-red-500">{form.formState.errors.root.message}</p>
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

## Form Validation Schemas

Forms use Zod schemas for validation:

```typescript
// lib/validations/auth.ts
import { z } from 'zod';

export const signupSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export type SignupFormValues = z.infer<typeof signupSchema>;
export type LoginFormValues = z.infer<typeof loginSchema>;
```

## Related Documentation

- [OAuth Integration](./oauth.md) - OAuth buttons and social login
- [Session Management](./sessions.md) - Server and client session handling
- [Auth Integration](./integration.md) - Route protection patterns
