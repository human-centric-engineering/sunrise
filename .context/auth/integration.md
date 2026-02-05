# Authentication Integration

Better-auth integrates deeply with Next.js 16+ App Router through server components, proxy, and route handlers in Sunrise. This document covers route protection patterns.

**Related Documents:**

- [Forms](./forms.md) - Login, signup, and client components
- [OAuth](./oauth.md) - Social login setup and configuration
- [Sessions](./sessions.md) - Session management and logout
- [Decisions](./decisions.md) - Architecture decisions and best practices

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
 *
 * Note: better-auth uses different cookie names based on protocol:
 * - HTTP: 'better-auth.session_token'
 * - HTTPS: '__Secure-better-auth.session_token' (with Secure flag)
 */
function isAuthenticated(request: NextRequest): boolean {
  const sessionToken =
    request.cookies.get('better-auth.session_token') ||
    request.cookies.get('__Secure-better-auth.session_token');
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

**Note:** The actual proxy also includes rate limiting for auth endpoints (5 requests/minute for sign-in, sign-up, password reset) and API endpoints (60/minute for API, 30/minute for admin). See [Security Overview](../security/overview.md) for rate limiting details.

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

### API Route Guards (Recommended Pattern)

For cleaner API route code, use the higher-order function guards from `lib/auth/guards.ts`:

```typescript
// lib/auth/guards.ts
import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from './config';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';

/**
 * Wrap an API route handler with authentication.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Passes the session to the handler
 * - Catches all errors via handleAPIError
 */
export function withAuth(
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>
): (request: NextRequest) => Promise<Response>;

/**
 * Wrap an API route handler with admin authentication.
 *
 * - Throws UnauthorizedError (401) if no session
 * - Throws ForbiddenError (403) if user role is not ADMIN
 */
export function withAdminAuth(
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>
): (request: NextRequest) => Promise<Response>;
```

**Usage - Simple authenticated route:**

```typescript
// app/api/v1/users/me/route.ts
import { withAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/response';
import { prisma } from '@/lib/db/client';

export const GET = withAuth(async (request, session) => {
  // session is guaranteed to be authenticated
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });
  return successResponse(user);
});
```

**Usage - Admin-only route:**

```typescript
// app/api/v1/admin/users/route.ts
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/response';
import { prisma } from '@/lib/db/client';

export const GET = withAdminAuth(async (request, session) => {
  // session is guaranteed to be an authenticated admin
  const users = await prisma.user.findMany();
  return successResponse(users);
});
```

**Usage - Route with dynamic params:**

```typescript
// app/api/v1/admin/users/[id]/route.ts
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/response';
import { prisma } from '@/lib/db/client';

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  await prisma.user.delete({ where: { id } });
  return successResponse({ id, deleted: true });
});
```

**Benefits of guards:**

- No try/catch boilerplate - errors routed through `handleAPIError`
- Consistent 401/403 responses
- Session is always typed and available
- Supports route params with generics

## Role-Based Access Control

### User Roles in Database

```prisma
// prisma/schema.prisma
enum Role {
  USER
  ADMIN
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

## Related Documentation

- [Auth Overview](./overview.md) - Authentication architecture and configuration
- [Auth Security](./security.md) - Security model and threat mitigation
- [Auth Forms](./forms.md) - Login and signup form patterns
- [OAuth](./oauth.md) - Social login setup
- [Sessions](./sessions.md) - Session management
- [Decisions](./decisions.md) - Trade-offs and best practices
- [API Endpoints](../api/endpoints.md) - API authentication patterns
- [Database Schema](../database/schema.md) - User and session models
