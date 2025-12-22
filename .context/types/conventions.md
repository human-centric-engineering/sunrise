# Type Safety & Validation Conventions

## Overview

This document describes the type safety patterns and validation conventions used throughout the Sunrise project. Following these patterns ensures consistency, maintainability, and type safety across the codebase.

## Type Organization

### 1. Shared Types (`types/`)

**Purpose:** Domain-specific types and shared interfaces

```
types/
├── index.ts          # Domain types (User, Auth, etc.)
├── api.ts            # API request/response types
└── prisma.ts         # Prisma model re-exports
```

**When to use:**

- Define domain concepts (User, Session, etc.)
- Create API response type aliases
- Re-export Prisma types for better discoverability

**Example:**

```typescript
// types/index.ts
export type PublicUser = User;
export type UserListItem = Pick<User, 'id' | 'name' | 'email'>;
export type UserResponse = APIResponse<PublicUser>;
```

### 2. Validation Schemas (`lib/validations/`)

**Purpose:** Runtime validation using Zod

```
lib/validations/
├── auth.ts           # Authentication schemas
├── user.ts           # User management schemas
└── common.ts         # Reusable patterns
```

**When to use:**

- Validate API request bodies
- Validate query parameters
- Validate form inputs
- Define runtime type constraints

**Example:**

```typescript
// lib/validations/user.ts
export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: emailSchema,
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
```

### 3. API Utilities (`lib/api/`)

**Purpose:** API client, validation, responses, and errors

```
lib/api/
├── client.ts         # Type-safe frontend client
├── validation.ts     # Request validation
├── responses.ts      # Response formatting
└── errors.ts         # Error handling
```

**When to use:**

- Make API calls from client components (use `client.ts`)
- Validate requests in API routes (use `validation.ts`)
- Format API responses (use `responses.ts`)
- Handle errors consistently (use `errors.ts`)

## Core Patterns

### Schema Inference

**Always infer types from Zod schemas** instead of defining types separately. This ensures runtime and compile-time types stay in sync.

```typescript
// ✅ Good - single source of truth
const signUpSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
});

type SignUpInput = z.infer<typeof signUpSchema>;

// ❌ Bad - types can drift
type SignUpInput = {
  name: string;
  email: string;
  password: string;
};
```

### API Response Types

Use discriminated unions for type-safe response handling:

```typescript
export type APIResponse<T> =
  | { success: true; data: T; meta?: Record<string, unknown> }
  | { success: false; error: APIError };

// Usage
async function getUser(): Promise<PublicUser> {
  const response = await apiClient.get<PublicUser>('/api/v1/users/me');
  // response is automatically typed as PublicUser (data extracted)
  return response;
}
```

### Form Validation

Use `react-hook-form` with `zodResolver` for type-safe forms:

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

const form = useForm<UpdateUserInput>({
  resolver: zodResolver(updateUserSchema),
  defaultValues: {
    name: '',
    email: '',
  },
});

async function onSubmit(data: UpdateUserInput) {
  // data is fully typed based on schema
  await apiClient.patch('/api/v1/users/me', { body: data });
}
```

### API Endpoint Validation

Always validate inputs with Zod utilities in API routes:

```typescript
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { createUserSchema, listUsersQuerySchema } from '@/lib/validations/user';

export async function POST(request: NextRequest) {
  try {
    // Validate body - throws ValidationError if invalid
    const body = validateRequestBody(request, createUserSchema);

    // Use validated data (fully typed)
    const user = await prisma.user.create({ data: body });

    return successResponse(user);
  } catch (error) {
    return handleAPIError(error);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Validate query params
  const query = validateQueryParams(searchParams, listUsersQuerySchema);

  const users = await prisma.user.findMany({
    skip: (query.page - 1) * query.limit,
    take: query.limit,
  });

  return successResponse(users);
}
```

### Error Handling

Use custom error classes with centralized handler:

```typescript
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  handleAPIError,
} from '@/lib/api/errors';

// Throw specific errors
if (!session) {
  throw new UnauthorizedError();
}

if (!user) {
  throw new NotFoundError('User not found');
}

if (invalidData) {
  throw new ValidationError('Invalid input', {
    email: ['Email is required'],
  });
}

// Catch-all error handler in API routes
export async function GET(request: NextRequest) {
  try {
    // ... route logic
  } catch (error) {
    return handleAPIError(error); // Automatically formats errors
  }
}
```

### Type-Safe API Client

Use `apiClient` for all frontend API calls to ensure type safety:

```typescript
import { apiClient, APIClientError } from '@/lib/api/client';
import type { PublicUser, UserListResponse } from '@/types';

// GET request
const user = await apiClient.get<PublicUser>('/api/v1/users/me');

// GET with query parameters
const response = await apiClient.get<UserListResponse>('/api/v1/users', {
  params: { page: 1, limit: 10, q: 'search' },
});

// POST request
const newUser = await apiClient.post<PublicUser>('/api/v1/users', {
  body: { name: 'John', email: 'john@example.com' },
});

// Error handling
try {
  const user = await apiClient.get<PublicUser>('/api/v1/users/me');
} catch (error) {
  if (error instanceof APIClientError) {
    console.error(error.message, error.code, error.details);
  }
}
```

### Prisma Type Safety

Import types from `types/prisma.ts` for better discoverability:

```typescript
// ✅ Good - explicit re-exports
import { User, Session, Prisma } from '@/types/prisma';

const userSelect: Prisma.UserSelect = {
  id: true,
  name: true,
  email: true,
};

// ❌ Avoid - direct imports scatter dependencies
import { User, Session } from '@prisma/client';
```

## Best Practices

### 1. Type Inference Over Explicit Types

Prefer `z.infer<>` over manually defining types:

```typescript
// ✅ Good
const schema = z.object({ name: z.string() });
type Input = z.infer<typeof schema>;

// ❌ Bad
const schema = z.object({ name: z.string() });
type Input = { name: string };
```

### 2. Schema Reuse

Use common schemas from `lib/validations/common.ts`:

```typescript
import { paginationQuerySchema, sortingQuerySchema } from '@/lib/validations/common';

export const listPostsQuerySchema = z.object({
  page: paginationQuerySchema.shape.page,
  limit: paginationQuerySchema.shape.limit,
  sortBy: z.enum(['title', 'createdAt']).default('createdAt'),
  sortOrder: sortingQuerySchema.shape.sortOrder,
});
```

### 3. Domain-Specific Types

Keep domain logic in validation schemas, not in common schemas:

```typescript
// ✅ Good - domain-specific sortBy
export const listUsersQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  sortBy: z.enum(['name', 'email', 'createdAt']).default('createdAt'),
});

// ❌ Bad - trying to make common schemas too specific
export const userSortingSchema = z.object({
  sortBy: z.enum(['name', 'email', 'createdAt']),
});
```

### 4. API Client for Frontend

Always use `apiClient` for frontend API calls, never raw `fetch`:

```typescript
// ✅ Good - type-safe, error handling included
const user = await apiClient.get<User>('/api/v1/users/me');

// ❌ Bad - no type safety, manual error handling
const response = await fetch('/api/v1/users/me');
const data = await response.json();
```

### 5. Error Types

Throw specific error classes, not generic errors:

```typescript
// ✅ Good
throw new NotFoundError('User not found');
throw new ValidationError('Invalid email', { email: ['Invalid format'] });

// ❌ Bad
throw new Error('User not found');
throw new Error('Invalid email');
```

## Common Validation Patterns

### Pagination

```typescript
import { paginationQuerySchema } from '@/lib/validations/common';

const query = validateQueryParams(searchParams, paginationQuerySchema);
const skip = (query.page - 1) * query.limit;
const users = await prisma.user.findMany({ skip, take: query.limit });
```

### Sorting

```typescript
import { sortingQuerySchema } from '@/lib/validations/common';

const schema = z.object({
  ...sortingQuerySchema.shape,
  sortBy: z.enum(['name', 'createdAt']).default('createdAt'),
});

const query = validateQueryParams(searchParams, schema);
const users = await prisma.user.findMany({
  orderBy: { [query.sortBy]: query.sortOrder },
});
```

### Search

```typescript
import { searchQuerySchema } from '@/lib/validations/common';

const query = validateQueryParams(searchParams, searchQuerySchema);
const users = await prisma.user.findMany({
  where: query.q
    ? {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ],
      }
    : undefined,
});
```

### ID Validation

```typescript
import { cuidSchema } from '@/lib/validations/common';

const schema = z.object({ id: cuidSchema });
const params = schema.parse({ id: paramsId });

const user = await prisma.user.findUnique({
  where: { id: params.id },
});
```

## Examples

### Complete API Route Example

```typescript
import { NextRequest } from 'next/server';
import {
  validateRequestBody,
  validateQueryParams,
  successResponse,
  handleAPIError,
} from '@/lib/api';
import { createUserSchema, listUsersQuerySchema } from '@/lib/validations/user';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = validateQueryParams(searchParams, listUsersQuerySchema);

    const users = await prisma.user.findMany({
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
      where: query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : undefined,
    });

    const total = await prisma.user.count();

    return successResponse(users, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    });
  } catch (error) {
    return handleAPIError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = validateRequestBody(request, createUserSchema);

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        role: body.role,
      },
    });

    return successResponse(user, { status: 201 });
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Complete Form Component Example

```typescript
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { updateUserSchema } from '@/lib/validations/user';
import { apiClient, APIClientError } from '@/lib/api/client';
import type { UpdateUserInput } from '@/lib/validations/user';
import type { PublicUser } from '@/types';

export function UserProfileForm({ user }: { user: PublicUser }) {
  const form = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      name: user.name,
      email: user.email,
    },
  });

  async function onSubmit(data: UpdateUserInput) {
    try {
      const updated = await apiClient.patch<PublicUser>('/api/v1/users/me', {
        body: data,
      });
      console.log('Updated:', updated);
    } catch (error) {
      if (error instanceof APIClientError) {
        if (error.code === 'VALIDATION_ERROR' && error.details) {
          // Set form errors from API
          Object.entries(error.details).forEach(([field, messages]) => {
            form.setError(field as keyof UpdateUserInput, {
              message: Array.isArray(messages) ? messages[0] : String(messages),
            });
          });
        } else {
          console.error(error.message);
        }
      }
    }
  }

  return <form onSubmit={form.handleSubmit(onSubmit)}>{/* form fields */}</form>;
}
```

## Quick Reference

| Task                     | Pattern                                     | File                   |
| ------------------------ | ------------------------------------------- | ---------------------- |
| Define domain type       | `export type UserRole = 'USER' \| 'ADMIN'`  | `types/index.ts`       |
| Create validation schema | `export const schema = z.object({ ... })`   | `lib/validations/*.ts` |
| Infer type from schema   | `type Input = z.infer<typeof schema>`       | Same as schema         |
| Make API call (frontend) | `await apiClient.get<T>('/api/v1/...')`     | Client component       |
| Validate request body    | `validateRequestBody(request, schema)`      | API route              |
| Validate query params    | `validateQueryParams(searchParams, schema)` | API route              |
| Handle errors            | `return handleAPIError(error)`              | API route              |
| Import Prisma types      | `import { User } from '@/types/prisma'`     | Anywhere               |

## Related Documentation

- [Type System Overview](./overview.md) - High-level type organization
- [API Documentation](..//api/endpoints.md) - API endpoint patterns
- [Validation Schemas](../../lib/validations/) - All validation schemas
