# Authentication Integration

## Next.js App Router Integration

Better-auth integrates deeply with Next.js 16+ App Router through server components, proxy, and route handlers in Sunrise. This document covers practical integration patterns for protecting routes, accessing sessions, and handling authentication state.

## Route Protection

### Proxy-Based Protection

The primary method for protecting routes uses Next.js proxy (formerly middleware) to check authentication before rendering:

```typescript
// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Define which routes require authentication
 */
const protectedRoutes = ['/dashboard', '/settings', '/profile'];

/**
 * Define which routes are auth pages (login, signup, etc.)
 * Authenticated users will be redirected away from these
 */
const authRoutes = ['/login', '/signup', '/reset-password'];

/**
 * Check if a user is authenticated by looking for the better-auth session cookie
 */
function isAuthenticated(request: NextRequest): boolean {
  // better-auth sets a session cookie named 'better-auth.session_token'
  const sessionToken = request.cookies.get('better-auth.session_token');
  return !!sessionToken;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = isAuthenticated(request);

  // Check if the current route is protected
  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

  // Check if the current route is an auth page
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));

  // Redirect unauthenticated users away from protected routes
  if (isProtectedRoute && !authenticated) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && authenticated) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

**Benefits**:

- Runs before page rendering (no flash of protected content)
- Works with both server and client components
- Centralized authentication logic
- Automatic redirects with callback URL preservation
- Fast cookie-based check (no database query)

### Page-Level Protection

For fine-grained control, check authentication in server components:

```typescript
// app/(protected)/settings/page.tsx
import { getServerSession } from '@/lib/auth/utils'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/client'

export default async function SettingsPage() {
  const session = await getServerSession()

  if (!session) {
    redirect('/login?callbackUrl=/settings')
  }

  // Fetch user-specific data
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  })

  return <SettingsForm user={session.user} settings={userSettings} />
}
```

**Alternative using requireAuth helper**:

```typescript
// app/(protected)/settings/page.tsx
import { requireAuth } from '@/lib/auth/utils'
import { prisma } from '@/lib/db/client'

export default async function SettingsPage() {
  // Throws error if not authenticated
  const session = await requireAuth()

  const userSettings = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  })

  return <SettingsForm user={session.user} settings={userSettings} />
}
```

### API Route Protection

Protect API endpoints with session checks:

```typescript
// app/api/v1/users/route.ts
import { getServerSession } from '@/lib/auth/utils';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  const session = await getServerSession();

  if (!session) {
    return Response.json({ success: false, error: { message: 'Unauthorized' } }, { status: 401 });
  }

  // Check role-based permissions
  if (session.user.role !== 'ADMIN') {
    return Response.json({ success: false, error: { message: 'Forbidden' } }, { status: 403 });
  }

  const users = await prisma.user.findMany();
  return Response.json({ success: true, data: users });
}
```

**Alternative using requireRole helper**:

```typescript
// app/api/v1/users/route.ts
import { requireRole } from '@/lib/auth/utils';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  try {
    // Throws if not authenticated or not admin
    await requireRole('ADMIN');

    const users = await prisma.user.findMany();
    return Response.json({ success: true, data: users });
  } catch (error) {
    const status = error.message === 'Authentication required' ? 401 : 403;
    return Response.json({ success: false, error: { message: error.message } }, { status });
  }
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
  id            String    @id @default(cuid())
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false)
  image         String?
  role          Role      @default(USER)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  sessions      Session[]
  accounts      Account[]
}
```

### Server-Side Role Checks

Using the built-in utility functions from `@/lib/auth/utils`:

```typescript
// app/(protected)/admin/page.tsx
import { requireRole } from '@/lib/auth/utils'

export default async function AdminPage() {
  // Throws if not authenticated or not admin
  const session = await requireRole('ADMIN')

  return (
    <div>
      <h1>Admin Dashboard</h1>
      <p>Welcome, {session.user.name}</p>
    </div>
  )
}
```

**Alternative with manual check**:

```typescript
// app/(protected)/admin/page.tsx
import { getServerSession } from '@/lib/auth/utils'
import { redirect } from 'next/navigation'

export default async function AdminPage() {
  const session = await getServerSession()

  if (!session) {
    redirect('/login?callbackUrl=/admin')
  }

  if (session.user.role !== 'ADMIN') {
    redirect('/unauthorized')
  }

  return <div>Admin Dashboard</div>
}
```

### Client-Side Role Checks

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

## Authentication Forms

### Sign Up Form

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

### Login Form

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

### Using Session in Client Components

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

## OAuth Provider Integration

### Google OAuth Setup

1. **Configure Google Cloud Console**:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a new project (or select existing)
   - Enable "Google+ API" or "Google Identity Services"
   - Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
   - Application type: "Web application"
   - Authorized JavaScript origins:
     - `http://localhost:3000` (development)
     - `https://yourdomain.com` (production)
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `https://yourdomain.com/api/auth/callback/google`
   - Copy the Client ID and Client Secret

2. **Add environment variables**:

```bash
GOOGLE_CLIENT_ID="your-client-id-here.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret-here"
```

3. **Provider is already configured** in `lib/auth/config.ts`:

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

4. **OAuth Components Already Implemented**:

Sunrise includes reusable OAuth components in `components/forms/`:

**Generic OAuth Button** (`oauth-button.tsx`):

```typescript
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

**OAuth Buttons Section** (`oauth-buttons.tsx`):

```typescript
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

**Usage in Forms**:
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

**OAuth Error Handling**:
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

### Adding Additional OAuth Providers

To add more providers (GitHub, Facebook, etc.), follow this pattern:

1. **Add environment variables**:

```bash
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-client-secret"
```

2. **Update auth configuration**:

```typescript
// lib/auth/config.ts
export const auth = betterAuth({
  socialProviders: {
    google: {
      /* ... */
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      enabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    },
  },
});
```

3. **Update OAuthButton type**:

```typescript
// components/forms/oauth-button.tsx
interface OAuthButtonProps {
  provider: 'google' | 'github'; // Add new provider here
  children: React.ReactNode;
  callbackUrl?: string;
}
```

4. **Add button to OAuthButtons component**:

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

**OAuth Flow**:

1. User clicks "Continue with Google"
2. `authClient.signIn.social()` initiates OAuth flow
3. User redirected to Google OAuth consent screen
4. Google redirects to `/api/auth/callback/google`
5. better-auth handles callback automatically:
   - Creates new user if first-time (signup flow)
   - Links account if existing user
   - Creates session
6. User redirected to callback URL (dashboard)

### Linking Social Accounts

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

## Session Management

### Server-Side Session Access

```typescript
// app/(protected)/dashboard/page.tsx
import { getServerSession, getServerUser } from '@/lib/auth/utils'

export default async function DashboardPage() {
  // Get full session (session + user)
  const session = await getServerSession()

  // Or get just the user
  const user = await getServerUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div>
      <h1>Welcome, {user.name}</h1>
      <p>Session expires: {new Date(session.session.expiresAt).toLocaleDateString()}</p>
    </div>
  )
}
```

### Session in Server Actions

```typescript
// app/actions/update-profile.ts
'use server';

import { requireAuth } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { revalidatePath } from 'next/cache';

export async function updateProfile(formData: FormData) {
  const session = await requireAuth();

  const name = formData.get('name') as string;

  await prisma.user.update({
    where: { id: session.user.id },
    data: { name },
  });

  revalidatePath('/profile');

  return { success: true };
}
```

### Client-Side Session Updates

When user data changes, the session automatically updates due to better-auth's reactive state management:

```typescript
// components/profile-form.tsx
'use client'

import { authClient, useSession } from '@/lib/auth/client'
import { useState } from 'react'

export function ProfileForm() {
  const { data: session, refetch } = useSession()
  const [name, setName] = useState(session?.user.name || '')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Update user via API
    const response = await fetch('/api/v1/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })

    if (response.ok) {
      // Manually refetch session if needed
      // (better-auth usually updates automatically)
      await refetch()
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit">Update Profile</button>
    </form>
  )
}
```

## Logout Implementation

### Simple Logout

```typescript
// components/logout-button.tsx
'use client'

import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

export function LogoutButton() {
  const router = useRouter()

  const handleLogout = async () => {
    await authClient.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <Button onClick={handleLogout} variant="ghost">
      Logout
    </Button>
  )
}
```

### Logout with Cleanup

```typescript
// components/logout-button.tsx
'use client'

import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

export function LogoutButton() {
  const router = useRouter()

  const handleLogout = async () => {
    try {
      // Optional: Clear client-side data
      localStorage.clear()
      sessionStorage.clear()

      // Optional: Call API to perform server-side cleanup
      await fetch('/api/auth/cleanup', { method: 'POST' })

      // Sign out
      await authClient.signOut()

      // Redirect and refresh
      router.push('/')
      router.refresh()
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  return (
    <Button onClick={handleLogout} variant="ghost">
      Logout
    </Button>
  )
}
```

## Server Actions with Authentication

### Protected Server Actions

```typescript
// app/actions/create-post.ts
'use server';

import { requireAuth } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

const createPostSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1),
});

export async function createPost(formData: FormData) {
  // Ensure user is authenticated
  const session = await requireAuth();

  // Validate input
  const data = createPostSchema.parse({
    title: formData.get('title'),
    content: formData.get('content'),
  });

  // Create post
  const post = await prisma.post.create({
    data: {
      ...data,
      authorId: session.user.id,
    },
  });

  return { success: true, post };
}
```

### Role-Based Server Actions

```typescript
// app/actions/delete-user.ts
'use server';

import { requireRole } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';

export async function deleteUser(userId: string) {
  // Ensure user is admin
  await requireRole('ADMIN');

  await prisma.user.delete({
    where: { id: userId },
  });

  return { success: true };
}
```

## API Patterns

### Protected API Route

```typescript
// app/api/v1/posts/route.ts
import { getServerSession } from '@/lib/auth/utils';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  const session = await getServerSession();

  if (!session) {
    return Response.json({ success: false, error: { message: 'Unauthorized' } }, { status: 401 });
  }

  // Fetch user's posts
  const posts = await prisma.post.findMany({
    where: { authorId: session.user.id },
  });

  return Response.json({ success: true, data: posts });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession();

  if (!session) {
    return Response.json({ success: false, error: { message: 'Unauthorized' } }, { status: 401 });
  }

  const body = await request.json();

  const post = await prisma.post.create({
    data: {
      ...body,
      authorId: session.user.id,
    },
  });

  return Response.json({ success: true, data: post });
}
```

### Role-Protected API Route

```typescript
// app/api/v1/admin/users/route.ts
import { requireRole } from '@/lib/auth/utils';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  try {
    await requireRole('ADMIN');

    const users = await prisma.user.findMany();

    return Response.json({ success: true, data: users });
  } catch (error) {
    const status = error.message === 'Authentication required' ? 401 : 403;
    return Response.json({ success: false, error: { message: error.message } }, { status });
  }
}
```

## Decision History & Trade-offs

### Proxy vs. Middleware

**Decision**: Use proxy file convention (Next.js 16+)
**Rationale**:

- Next.js 16 deprecated `middleware` in favor of `proxy` to clarify purpose
- Same functionality, better naming that reflects network boundary
- Aligns with Next.js direction moving forward

**Trade-offs**: Requires migration from older middleware convention

### better-auth vs. NextAuth.js

**Decision**: Use better-auth instead of NextAuth.js
**Rationale**:

- Simpler API with less boilerplate
- No provider wrapper needed for client hooks (uses nanostore)
- Built-in signup functionality (no custom API routes needed)
- Better TypeScript support
- More flexible session management
- Active development with modern patterns

**Trade-offs**: Smaller ecosystem than NextAuth.js, but rapidly growing

### Cookie-Based Session Check in Proxy

**Decision**: Check for session cookie existence in proxy, not full session validation
**Rationale**:

- Fast (no database query or API call in proxy)
- Sufficient for initial route protection
- Full validation happens in page/API route
- Better performance at scale

**Trade-offs**: Slight duplication of auth checks, but provides defense in depth

### Server-First Authentication

**Decision**: Perform authentication checks on server when possible
**Rationale**:

- More secure (client can't bypass)
- Better performance (no client-side redirect flash)
- SEO-friendly (correct status codes)
- Leverages React Server Components

**Trade-offs**: Requires understanding server vs. client components

### Callback URL Preservation

**Decision**: Pass `callbackUrl` in login redirects
**Rationale**:

- Better UX (return user to intended destination)
- Standard OAuth pattern
- Simple to implement

**Trade-offs**: Must validate callback URL to prevent open redirect (better-auth handles this)

### Auto-Login After Signup

**Decision**: Automatically sign in users after registration via better-auth
**Rationale**:

- Reduces friction (no need to login after signup)
- Common pattern in modern apps
- Built into better-auth by default

**Trade-offs**: Email verification handled separately (can be enabled in config)

## Performance Considerations

### Session Caching

better-auth caches session data using cookies and internal state management:

- Client-side: nanostore provides reactive state without re-fetching
- Server-side: Session validated once per request using headers
- No unnecessary database queries

### Proxy Efficiency

Proxy runs on every request to matched routes. Keep logic minimal:

- Use cookie existence check (fast, no I/O)
- Avoid database queries in proxy
- Full session validation in page/API route
- Cache static configuration

### Client Hook Optimization

The `useSession()` hook from better-auth is optimized:

- No provider wrapper needed (reduces React tree depth)
- Uses nanostore for efficient state management
- Only re-renders when session changes
- Automatic cleanup on unmount

### Database Query Optimization

When fetching user data, use Prisma's query optimization:

```typescript
// Select only needed fields
const user = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: {
    id: true,
    name: true,
    email: true,
    role: true,
  },
});
```

## Security Best Practices

### Environment Variables

- Never commit `.env` or `.env.local`
- Use strong `BETTER_AUTH_SECRET` (min 32 characters)
- Generate secret: `openssl rand -base64 32`
- Rotate secrets periodically

### Session Security

- HTTPS in production (enforced by better-auth)
- Secure cookie flags set automatically
- Session expiration configured (30 days default)
- Automatic session refresh

### Input Validation

- Validate all inputs with Zod schemas
- Sanitize user input before database operations
- Use Prisma (prevents SQL injection)
- Validate on server, not just client

### Rate Limiting

Consider adding rate limiting for:

- Login endpoints (prevent brute force)
- Signup endpoints (prevent spam)
- Password reset endpoints
- API endpoints

## Related Documentation

- [Auth Overview](./overview.md) - Authentication architecture and configuration
- [Auth Security](./security.md) - Security model and threat mitigation
- [Architecture Patterns](../architecture/patterns.md) - Error handling and code organization
- [API Endpoints](../api/endpoints.md) - API authentication patterns
- [Database Schema](../database/schema.md) - User and session models
