# Type System Overview

Quick reference for the Sunrise type system organization and key files.

## Directory Structure

```
types/
├── index.ts          # Domain types (User, Auth, etc.)
├── api.ts            # API request/response types
└── prisma.ts         # Prisma model exports

lib/validations/
├── auth.ts           # Auth validation schemas
├── user.ts           # User validation schemas
└── common.ts         # Reusable schema patterns

lib/api/
├── client.ts         # Type-safe API client
├── validation.ts     # Request validation utilities
├── responses.ts      # Response formatters
└── errors.ts         # Error handling

.context/types/
├── overview.md       # This file - quick reference
└── conventions.md    # Detailed type conventions
```

## Key Files

### Domain Types (`types/index.ts`)

**Purpose:** Application-level types for business domain concepts

**Exports:**

- `UserRole` - User role enum ('USER' | 'ADMIN')
- `PublicUser` - User data safe for public exposure
- `UserListItem` - Subset for list displays
- `UserProfile` - User's own profile data
- `AuthSession` - Authenticated session type
- `UserResponse` - Single user API response
- `UserListResponse` - Paginated user list API response

**When to use:**

- Importing user-related types in components
- Typing API responses in frontend code
- Defining session types in auth utilities

### API Types (`types/api.ts`)

**Purpose:** Request/response type definitions for API layer

**Exports:**

- `APIResponse<T>` - Discriminated union for all API responses
- `APIError` - Error structure for API responses
- `PaginationMeta` - Pagination metadata
- `HTTPMethod` - HTTP method types
- `ValidationResult<T>` - Request validation result

**When to use:**

- Typing API route responses
- Creating new API response types
- Working with pagination

### Prisma Types (`types/prisma.ts`)

**Purpose:** Re-exports of Prisma-generated types

**Exports:**

- `User` - User model type
- `Session` - Session model type
- `Account` - Account model type
- `Verification` - Verification model type
- `Prisma` - Prisma namespace (utility types)

**When to use:**

- Importing database model types
- Using Prisma utility types (Select, Include, Where, etc.)
- Type-safe Prisma queries

### Validation Schemas (`lib/validations/`)

**Purpose:** Runtime validation using Zod

**Key Schemas:**

- **common.ts:**
  - `paginationQuerySchema` - Page/limit validation
  - `sortingQuerySchema` - sortBy/sortOrder validation
  - `searchQuerySchema` - Search query validation
  - `cuidSchema` - CUID validation
  - `uuidSchema` - UUID validation
  - `urlSchema` - URL validation
  - `slugSchema` - Slug validation

- **auth.ts:**
  - `signUpSchema` - User registration
  - `signInSchema` - User login
  - `resetPasswordSchema` - Password reset

- **user.ts:**
  - `updateUserSchema` - Profile updates
  - `listUsersQuerySchema` - User list queries
  - `createUserSchema` - Admin user creation
  - `userIdSchema` - User ID parameter validation

**When to use:**

- Validating API request bodies
- Validating query parameters
- Form validation with react-hook-form
- Inferring TypeScript types from schemas

### API Client (`lib/api/client.ts`)

**Purpose:** Type-safe frontend API client

**Exports:**

- `apiClient` - Main client object with methods:
  - `get<T>(path, options)` - GET requests
  - `post<T>(path, options)` - POST requests
  - `patch<T>(path, options)` - PATCH requests
  - `delete<T>(path, options)` - DELETE requests
- `APIClientError` - Client error class

**When to use:**

- Making API calls from client components
- Type-safe frontend data fetching
- Automatic error handling

### API Utilities (`lib/api/`)

**Purpose:** Server-side API helpers

**Key Functions:**

- **validation.ts:**
  - `validateRequestBody()` - Validate request body
  - `validateQueryParams()` - Validate query parameters

- **responses.ts:**
  - `successResponse()` - Format success responses
  - `errorResponse()` - Format error responses

- **errors.ts:**
  - `APIError` - Base error class
  - `ValidationError` - 400 validation errors
  - `UnauthorizedError` - 401 auth errors
  - `ForbiddenError` - 403 permission errors
  - `NotFoundError` - 404 not found errors
  - `handleAPIError()` - Centralized error handler

**When to use:**

- Building API routes
- Validating requests
- Throwing typed errors
- Formatting responses

## Quick Reference

### Import Patterns

```typescript
// Domain types
import { PublicUser, UserRole, AuthSession } from '@/types';

// API types
import type { APIResponse, PaginationMeta } from '@/types/api';

// Prisma types
import { User, Session, Prisma } from '@/types/prisma';

// Validation schemas
import { updateUserSchema } from '@/lib/validations/user';
import { paginationQuerySchema } from '@/lib/validations/common';

// API client (frontend)
import { apiClient, APIClientError } from '@/lib/api/client';

// API utilities (backend)
import { validateRequestBody, successResponse } from '@/lib/api';
import { NotFoundError, handleAPIError } from '@/lib/api/errors';
```

### Common Patterns

**Infer types from Zod schemas:**

```typescript
const schema = z.object({ name: z.string() });
type Input = z.infer<typeof schema>;
```

**Type-safe API call:**

```typescript
const user = await apiClient.get<PublicUser>('/api/v1/users/me');
```

**Validate request in API route:**

```typescript
const body = validateRequestBody(request, createUserSchema);
```

**Handle errors in API route:**

```typescript
try {
  // ... route logic
} catch (error) {
  return handleAPIError(error);
}
```

**Form with validation:**

```typescript
const form = useForm<UpdateUserInput>({
  resolver: zodResolver(updateUserSchema),
});
```

## Type Safety Flow

### Frontend → Backend

1. **Frontend:** Type-safe API call with `apiClient.get<T>()`
2. **Network:** Automatic JSON serialization
3. **Backend:** Validate with Zod schema
4. **Backend:** Type-safe business logic with inferred types
5. **Backend:** Format response with `successResponse()`
6. **Network:** Automatic JSON parsing
7. **Frontend:** Typed response data

### Form Submission

1. **Component:** Define Zod schema
2. **Component:** Infer TypeScript type with `z.infer<>`
3. **Component:** Create form with `react-hook-form` + `zodResolver`
4. **User:** Fill out form
5. **Component:** Client-side validation with Zod
6. **Component:** Submit via `apiClient.post<T>()`
7. **Backend:** Server-side validation with same Zod schema
8. **Backend:** Process validated data
9. **Backend:** Return typed response
10. **Component:** Handle typed response or error

## Related Documentation

- [Type Conventions](./conventions.md) - Detailed patterns and best practices
- [API Documentation](../api/endpoints.md) - API endpoint patterns
- [Authentication Guide](../auth/overview.md) - Auth type usage
- [Database Schema](../database/schema.md) - Prisma models

## Migration Notes

### Zod 4 Updates

This project uses Zod 4.x, which has different syntax from Zod 3.x:

**Zod 4 (Current):**

```typescript
z.cuid(); // Direct function
z.uuid(); // Direct function
z.url(); // Direct function
z.email(); // Direct function
```

**Zod 3 (Deprecated):**

```typescript
z.string().cuid(); // ❌ Deprecated
z.string().uuid(); // ❌ Deprecated
z.string().url(); // ❌ Deprecated
z.string().email(); // ❌ Deprecated
```

All validation schemas in this project follow Zod 4 conventions.
