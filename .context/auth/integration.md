# Authentication Integration

## Next.js App Router Integration

NextAuth.js v5 integrates deeply with Next.js 14+ App Router through server components, middleware, and route handlers in Sunrise. This document covers practical integration patterns for protecting routes, accessing sessions, and handling authentication state.

## Route Protection

### Middleware-Based Protection

The primary method for protecting routes uses Next.js middleware to check authentication before rendering:

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

export async function middleware(request: NextRequest) {
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  const isAuthPage = request.nextUrl.pathname.startsWith('/login') ||
                     request.nextUrl.pathname.startsWith('/signup');
  const isProtectedPage = request.nextUrl.pathname.startsWith('/dashboard');

  // Redirect authenticated users away from auth pages
  if (isAuthPage && token) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  // Redirect unauthenticated users to login
  if (isProtectedPage && !token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/login',
    '/signup',
    '/settings/:path*',
  ],
};
```

**Benefits**:
- Runs before page rendering (no flash of protected content)
- Works with both server and client components
- Centralized authentication logic
- Automatic redirects with callback URL preservation

### Page-Level Protection

For fine-grained control, check authentication in server components:

```typescript
// app/(dashboard)/settings/page.tsx
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { redirect } from 'next/navigation';

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/login?callbackUrl=/settings');
  }

  // Fetch user-specific data
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  });

  return <SettingsForm settings={userSettings} />;
}
```

### API Route Protection

Protect API endpoints with session checks:

```typescript
// app/api/v1/users/route.ts
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return Response.json(
      { success: false, error: { message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  // Check role-based permissions
  if (session.user.role !== 'admin') {
    return Response.json(
      { success: false, error: { message: 'Forbidden' } },
      { status: 403 }
    );
  }

  const users = await prisma.user.findMany();
  return Response.json({ success: true, data: users });
}
```

## Role-Based Access Control

### User Roles in Database

```prisma
// prisma/schema.prisma
enum Role {
  USER
  ADMIN
  MODERATOR
}

model User {
  id       String   @id @default(cuid())
  email    String   @unique
  role     Role     @default(USER)
  // ... other fields
}
```

### Role Checking Helper

```typescript
// lib/auth/roles.ts
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';

export async function requireRole(allowedRoles: string[]) {
  const session = await getServerSession(authOptions);

  if (!session) {
    throw new Error('Unauthorized');
  }

  if (!allowedRoles.includes(session.user.role)) {
    throw new Error('Forbidden');
  }

  return session;
}

// Usage in API route
export async function DELETE(request: NextRequest) {
  try {
    const session = await requireRole(['admin']);

    // Admin-only logic
    await prisma.user.delete({ where: { id: params.id } });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { success: false, error: { message: error.message } },
      { status: error.message === 'Unauthorized' ? 401 : 403 }
    );
  }
}
```

### Client-Side Role Checks

```typescript
// components/admin-panel.tsx
'use client'

import { useSession } from 'next-auth/react';

export function AdminPanel() {
  const { data: session } = useSession();

  if (session?.user?.role !== 'admin') {
    return null; // Don't render for non-admins
  }

  return (
    <div>
      <h2>Admin Panel</h2>
      {/* Admin controls */}
    </div>
  );
}
```

**Note**: Client-side checks are for UX only. Always validate on server.

## Authentication Forms

### Login Form with NextAuth

```typescript
// components/forms/login-form.tsx
'use client'

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginSchema } from '@/lib/validations/auth';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';

  const form = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const onSubmit = async (data: LoginFormValues) => {
    try {
      const result = await signIn('credentials', {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (result?.error) {
        form.setError('root', {
          message: 'Invalid email or password',
        });
        return;
      }

      router.push(callbackUrl);
      router.refresh();
    } catch (error) {
      form.setError('root', {
        message: 'An error occurred. Please try again.',
      });
    }
  };

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
  );
}
```

### Signup Form with User Creation

```typescript
// components/forms/signup-form.tsx
'use client'

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { signupSchema } from '@/lib/validations/auth';
import { useRouter } from 'next/navigation';

export function SignupForm() {
  const router = useRouter();

  const form = useForm({
    resolver: zodResolver(signupSchema),
  });

  const onSubmit = async (data: SignupFormValues) => {
    try {
      // Create user via API
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        form.setError('root', { message: error.error.message });
        return;
      }

      // Auto-login after signup
      await signIn('credentials', {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      router.push('/dashboard');
      router.refresh();
    } catch (error) {
      form.setError('root', {
        message: 'An error occurred. Please try again.',
      });
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <Input {...form.register('name')} placeholder="Full Name" />
      <Input {...form.register('email')} type="email" placeholder="Email" />
      <Input {...form.register('password')} type="password" placeholder="Password" />
      <Button type="submit" loading={form.formState.isSubmitting}>
        Sign Up
      </Button>
    </form>
  );
}
```

### Signup API Route

```typescript
// app/api/auth/signup/route.ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/passwords';
import { signupSchema } from '@/lib/validations/auth';
import { sendVerificationEmail } from '@/lib/email/templates';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = signupSchema.parse(body);

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email: validatedData.email },
    });

    if (existingUser) {
      return Response.json(
        { success: false, error: { message: 'Email already registered' } },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await hashPassword(validatedData.password);

    // Create user
    const user = await prisma.user.create({
      data: {
        name: validatedData.name,
        email: validatedData.email,
        password: hashedPassword,
      },
    });

    // Send verification email
    await sendVerificationEmail(user.email, user.name);

    return Response.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { success: false, error: { message: 'Validation failed', details: error.errors } },
        { status: 400 }
      );
    }

    return Response.json(
      { success: false, error: { message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

## OAuth Provider Integration

### Adding Google OAuth

1. **Configure Google Cloud Console**:
   - Create OAuth 2.0 credentials
   - Set authorized redirect URI: `https://yourdomain.com/api/auth/callback/google`

2. **Add environment variables**:
```bash
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
```

3. **Provider already configured** in `authOptions` (see [overview.md](./overview.md))

4. **Add login button**:
```typescript
// components/oauth-buttons.tsx
'use client'

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export function GoogleLoginButton() {
  return (
    <Button
      onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
      variant="outline"
    >
      <GoogleIcon className="mr-2" />
      Continue with Google
    </Button>
  );
}
```

### Adding Additional OAuth Providers

Follow the same pattern for GitHub, Facebook, etc.:

```typescript
// lib/auth/config.ts
import GitHubProvider from 'next-auth/providers/github';

export const authOptions: NextAuthOptions = {
  providers: [
    // ... existing providers
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
};
```

## Session Refresh Patterns

### Automatic Session Updates

When user data changes (profile update, role change), update the session:

```typescript
// app/api/v1/users/[id]/route.ts
import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';

export async function PATCH(request: NextRequest) {
  const session = await getServerSession(authOptions);

  // Update user
  const updatedUser = await prisma.user.update({
    where: { id: session.user.id },
    data: { name: 'New Name' },
  });

  // Client must refetch session
  return Response.json({
    success: true,
    data: updatedUser,
    meta: { sessionRefreshRequired: true },
  });
}
```

### Client-Side Session Refetch

```typescript
'use client'

import { useSession } from 'next-auth/react';

export function ProfileForm() {
  const { data: session, update } = useSession();

  const handleSubmit = async (data) => {
    const response = await fetch('/api/v1/users/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });

    // Trigger session refresh
    await update();
  };
}
```

## Logout Implementation

### Simple Logout

```typescript
// components/logout-button.tsx
'use client'

import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  return (
    <Button onClick={() => signOut({ callbackUrl: '/' })}>
      Logout
    </Button>
  );
}
```

### Logout with Cleanup

```typescript
export function LogoutButton() {
  const handleLogout = async () => {
    // Optional: Clear client-side data
    localStorage.clear();

    // Optional: Call API to invalidate server-side resources
    await fetch('/api/auth/logout', { method: 'POST' });

    // Sign out
    await signOut({ callbackUrl: '/' });
  };

  return <Button onClick={handleLogout}>Logout</Button>;
}
```

## Decision History & Trade-offs

### Client vs. Server Session Checks
**Decision**: Use middleware for route-level, server components for data-level
**Rationale**:
- Middleware prevents unauthorized page renders (better UX)
- Server components enable data-specific checks (e.g., resource ownership)
- Combination provides defense in depth

**Trade-offs**: Slight duplication of auth checks

### Callback URL Preservation
**Decision**: Pass `callbackUrl` in login redirects
**Rationale**:
- Better UX (return user to intended destination)
- Standard OAuth pattern
- Simple to implement

**Trade-offs**: Open redirect vulnerability if not validated (NextAuth handles this)

### Auto-login After Signup
**Decision**: Automatically sign in users after registration
**Rationale**:
- Reduces friction (no need to login after signup)
- Common pattern in modern apps
- Simple implementation

**Trade-offs**: Skips email verification requirement (implemented separately)

## Performance Considerations

### Session Caching
NextAuth.js caches `getServerSession()` calls within the same request. Multiple calls don't hit the database repeatedly.

### Middleware Efficiency
Middleware runs on every request to matched routes. Keep logic minimal:
- Use JWT token decoding (fast, no database)
- Avoid database queries in middleware
- Cache static configuration

## Related Documentation

- [Auth Overview](./overview.md) - Authentication flows and configuration
- [Auth Security](./security.md) - Security model and threat mitigation
- [Architecture Patterns](../architecture/patterns.md) - Error handling and code organization
- [API Endpoints](../api/endpoints.md) - API authentication patterns
