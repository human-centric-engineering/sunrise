# Code Organization & Patterns

## File Organization

### Directory Structure by Responsibility

```
sunrise/
├── app/                    # Next.js App Router (routes and API)
│   ├── (auth)/            # Authentication pages (route group)
│   │   ├── login/
│   │   ├── signup/
│   │   └── reset-password/
│   ├── (protected)/       # Protected routes (route group)
│   │   ├── layout.tsx     # Shared protected layout
│   │   ├── dashboard/     # Dashboard home
│   │   ├── settings/      # User settings
│   │   └── profile/       # User profile
│   ├── (public)/          # Public routes (route group)
│   │   ├── layout.tsx     # Shared public layout
│   │   ├── page.tsx       # Landing page
│   │   ├── about/
│   │   └── contact/
│   ├── api/               # API routes
│   ├── layout.tsx         # Root layout
│   └── error.tsx          # Error boundary
├── components/            # React components
│   ├── ui/               # Base UI components (shadcn/ui)
│   ├── forms/            # Form components
│   ├── layouts/          # Layout components
│   └── providers/        # Context providers
├── lib/                  # Business logic and utilities
│   ├── db/              # Database client
│   ├── auth/            # Authentication utilities
│   ├── api/             # API helpers
│   ├── email/           # Email services
│   ├── validations/     # Zod schemas
│   └── utils.ts         # General utilities
├── types/               # TypeScript type definitions
├── prisma/              # Database schema and migrations
└── emails/              # React Email templates
```

**Principle**: Colocate by feature when possible, separate by technical layer when shared across features.

### Component Organization

**Atomic Design Inspiration** (adapted for Next.js):

```typescript
// components/ui/button.tsx - Atomic component (shadcn/ui)
import { cn } from '@/lib/utils';

export function Button({ className, ...props }) {
  return <button className={cn('base-styles', className)} {...props} />;
}

// components/forms/login-form.tsx - Molecule (composed UI with logic)
'use client'

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginForm() {
  const form = useForm();
  return (
    <form>
      <Input {...form.register('email')} />
      <Button type="submit">Login</Button>
    </form>
  );
}

// app/(auth)/login/page.tsx - Organism (page composition)
import { LoginForm } from '@/components/forms/login-form';

export default function LoginPage() {
  return (
    <div className="container">
      <h1>Login</h1>
      <LoginForm />
    </div>
  );
}
```

### Route Organization Patterns

**Adding Protected Pages:**
```typescript
// app/(protected)/analytics/page.tsx
// New protected feature - uses (protected) layout automatically
import { getServerSession } from '@/lib/auth/utils';

export default async function AnalyticsPage() {
  const session = await getServerSession();
  // Protected by proxy, session guaranteed to exist
  const data = await fetchAnalytics(session.user.id);
  return <AnalyticsDashboard data={data} />;
}
```

**Adding Public Pages:**
```typescript
// app/(public)/pricing/page.tsx
// New public page - uses (public) layout automatically
export default function PricingPage() {
  return <PricingTable />;
}
```

**Creating New Route Group (Different Layout):**
```typescript
// app/(admin)/layout.tsx
// New route group for admin-specific UI
export default function AdminLayout({ children }) {
  return (
    <div className="admin-layout">
      <AdminSidebar />
      <main>{children}</main>
    </div>
  );
}

// app/(admin)/users/page.tsx
// Uses admin layout defined above
export default async function AdminUsersPage() {
  const users = await prisma.user.findMany();
  return <UserManagementTable users={users} />;
}
```

**Decision Guide:**
- Same navigation/UI as existing pages? → Use existing route group as subdirectory
- Different navigation/UI needed? → Create new route group with `layout.tsx`
- Just authentication difference? → Use `(protected)` vs `(public)`
- Completely different section? → New route group (e.g., `(admin)`, `(docs)`, `(portal)`)

### API Route Organization

```
app/api/
├── auth/
│   └── [...all]/route.ts         # better-auth catch-all
├── health/
│   └── route.ts                  # Health check
├── v1/                           # Versioned API
│   ├── users/
│   │   ├── route.ts             # GET /api/v1/users, POST /api/v1/users
│   │   └── [id]/
│   │       └── route.ts         # GET/PUT/DELETE /api/v1/users/:id
│   └── posts/
│       ├── route.ts
│       └── [id]/route.ts
└── webhooks/
    └── stripe/route.ts           # Webhook handlers
```

**Convention**: Resource-based URLs, version prefix for stability, separate file per resource.

## Error Handling Patterns

### Centralized Error Classes

```typescript
// lib/errors/index.ts
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public details?: any) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}
```

### API Route Error Handling

```typescript
// app/api/v1/users/[id]/route.ts
import { NextRequest } from 'next/server';
import { AppError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { errorResponse } from '@/lib/api/responses';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession();
    if (!session) {
      throw new UnauthorizedError();
    }

    // Fetch user
    const user = await prisma.user.findUnique({
      where: { id: params.id },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    return Response.json({
      success: true,
      data: user,
    });
  } catch (error) {
    // Handle known errors
    if (error instanceof AppError) {
      return Response.json(
        errorResponse(error.message, error.code),
        { status: error.statusCode }
      );
    }

    // Handle unexpected errors
    console.error('Unexpected error:', error);
    return Response.json(
      errorResponse('Internal server error', 'INTERNAL_ERROR'),
      { status: 500 }
    );
  }
}
```

### Server Component Error Handling

```typescript
// app/(dashboard)/users/[id]/page.tsx
import { notFound } from 'next/navigation';

export default async function UserPage({ params }: { params: { id: string } }) {
  const user = await prisma.user.findUnique({
    where: { id: params.id },
  });

  // Next.js built-in error handling
  if (!user) {
    notFound(); // Triggers not-found.tsx
  }

  return <UserProfile user={user} />;
}
```

```typescript
// app/(dashboard)/users/[id]/not-found.tsx
export default function NotFound() {
  return (
    <div>
      <h2>User Not Found</h2>
      <p>The user you're looking for doesn't exist.</p>
    </div>
  );
}
```

### Client-Side Error Boundaries

```typescript
// components/error-boundary.tsx
'use client'

import { useEffect } from 'react';

export function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error reporting service
    console.error('Error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h2 className="text-2xl font-bold mb-4">Something went wrong</h2>
      <button
        onClick={reset}
        className="px-4 py-2 bg-blue-500 text-white rounded"
      >
        Try again
      </button>
    </div>
  );
}
```

## Validation Patterns

### Zod Schema Organization

```typescript
// lib/validations/user.ts
import { z } from 'zod';

// Reusable field schemas
const emailSchema = z.string().email('Invalid email address');
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain uppercase letter')
  .regex(/[a-z]/, 'Password must contain lowercase letter')
  .regex(/[0-9]/, 'Password must contain number');

// Entity schemas
export const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: emailSchema.optional(),
});

// Infer TypeScript types from schemas
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
```

### API Validation Pattern

```typescript
// app/api/v1/users/route.ts
import { createUserSchema } from '@/lib/validations/user';
import { ValidationError } from '@/lib/errors';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate with Zod
    const validatedData = createUserSchema.parse(body);

    const user = await prisma.user.create({
      data: validatedData,
    });

    return Response.json({ success: true, data: user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          success: false,
          error: {
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: error.errors,
          },
        },
        { status: 400 }
      );
    }

    throw error;
  }
}
```

### Form Validation (Client + Server)

```typescript
// components/forms/signup-form.tsx
'use client'

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createUserSchema } from '@/lib/validations/user';

export function SignupForm() {
  const form = useForm({
    resolver: zodResolver(createUserSchema), // Client-side validation
  });

  const onSubmit = async (data) => {
    const response = await fetch('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify(data), // Server validates again
    });

    // Handle response
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      {/* Form fields */}
    </form>
  );
}
```

**Principle**: Validate on both client (UX) and server (security). Share schemas via Zod.

## Data Access Patterns

### Repository Pattern (Optional)

For complex queries, wrap Prisma in repository functions:

```typescript
// lib/repositories/user-repository.ts
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';

export class UserRepository {
  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        // Exclude password
      },
    });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
    });
  }

  async create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data });
  }

  async updateLastLogin(id: string) {
    return prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}

export const userRepository = new UserRepository();
```

**When to Use**: Complex queries, repeated patterns, business logic tied to data access

### Direct Prisma Access (Recommended for Simple Cases)

```typescript
// app/(dashboard)/users/page.tsx - Server component
import { prisma } from '@/lib/db/client';

export default async function UsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return <UserList users={users} />;
}
```

**When to Use**: Simple CRUD, server components, straightforward queries

## Async/Await Patterns

### Server Components (Top-Level Await)

```typescript
// app/(dashboard)/page.tsx
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';

export default async function DashboardPage() {
  // Sequential fetches (when dependent)
  const session = await getServerSession();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  // Parallel fetches (when independent)
  const [posts, stats] = await Promise.all([
    prisma.post.findMany({ where: { userId: user.id } }),
    prisma.stat.aggregate({ where: { userId: user.id } }),
  ]);

  return <Dashboard user={user} posts={posts} stats={stats} />;
}
```

### API Routes

```typescript
// app/api/v1/dashboard/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  const session = await getServerSession();

  if (!session) {
    return Response.json({ success: false }, { status: 401 });
  }

  // Parallel operations
  const [user, posts, notifications] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id } }),
    prisma.post.findMany({ where: { userId: session.user.id }, take: 10 }),
    prisma.notification.count({ where: { userId: session.user.id, read: false } }),
  ]);

  return Response.json({
    success: true,
    data: { user, posts, unreadCount: notifications },
  });
}
```

## Naming Conventions

### File Naming
- **Components**: `PascalCase.tsx` → `UserProfile.tsx`
- **Utilities**: `kebab-case.ts` → `format-date.ts`
- **Next.js Special**: `page.tsx`, `layout.tsx`, `route.ts`, `error.tsx`, `loading.tsx`

### Variable Naming
- **Constants**: `UPPER_SNAKE_CASE` → `MAX_LOGIN_ATTEMPTS`
- **Functions**: `camelCase` → `getUserById`
- **Components**: `PascalCase` → `LoginForm`
- **Types/Interfaces**: `PascalCase` → `UserProfile`, `CreateUserInput`

### Function Naming Conventions
- **Get**: Retrieve data → `getUserById()`, `getServerSession()`
- **Create**: Create new entity → `createUser()`, `createPost()`
- **Update**: Modify existing → `updateUserProfile()`, `updatePassword()`
- **Delete**: Remove entity → `deleteUser()`, `deletePost()`
- **Validate**: Check validity → `validateEmail()`, `validateToken()`
- **Handle**: Event handler → `handleSubmit()`, `handleClick()`

## Decision History & Trade-offs

### Error Handling Strategy
**Decision**: Custom error classes + standardized responses
**Rationale**:
- Type-safe error handling
- Consistent API responses
- Easy to add error tracking later (Sentry)
- Clear error codes for debugging

**Trade-offs**: More boilerplate than throwing strings

### Zod for Validation
**Decision**: Single Zod schema for client and server
**Rationale**:
- DRY principle (don't duplicate validation logic)
- Type inference (TypeScript types from schemas)
- Runtime safety (catch invalid data)

**Trade-offs**: Adds ~14KB to client bundle when used in client components

### Repository Pattern (Optional)
**Decision**: Allow both repository pattern and direct Prisma
**Rationale**:
- Flexibility for different complexity levels
- Repositories for complex queries with business logic
- Direct Prisma for simple CRUD
- Team can decide per use case

**Trade-offs**: Inconsistent patterns across codebase if not disciplined

## Code Style Guidelines

### Import Organization

```typescript
// 1. External dependencies
import { useState } from 'react';
import { z } from 'zod';

// 2. Internal absolute imports (@/)
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/db/client';

// 3. Relative imports
import { formatDate } from '../utils';

// 4. Type imports (separate)
import type { User } from '@prisma/client';
```

### TypeScript Best Practices

```typescript
// Use explicit return types for exported functions
export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

// Use type inference for internal functions
function formatUserName(user: User) {
  return `${user.firstName} ${user.lastName}`;
}

// Prefer interfaces for object shapes
interface UserProfile {
  id: string;
  name: string;
  email: string;
}

// Use types for unions/intersections
type UserRole = 'admin' | 'user' | 'guest';
```

### Comment Guidelines

```typescript
// Good: Explain WHY, not WHAT
// Hash password before storing (prevent plaintext exposure)
const hashedPassword = await hashPassword(password);

// Bad: Restating the code
// Hash the password
const hashedPassword = await hashPassword(password);

// Good: Document complex business logic
/**
 * Calculates user tier based on subscription and usage.
 * Premium users get tier boost regardless of usage.
 * Free users tier based on monthly active days.
 */
function calculateUserTier(user: User): UserTier {
  // Implementation
}
```

## Related Documentation

- [Architecture Overview](./overview.md) - System design and component boundaries
- [Dependencies](./dependencies.md) - Dependency management and injection patterns
- [API Endpoints](../api/endpoints.md) - API route patterns and examples
- [Database Models](../database/models.md) - Prisma model patterns
