# Type System Overview

Quick reference for the Sunrise type system organization and key files.

## Directory Structure

```
types/
├── index.ts          # Domain types (User, Auth, etc.)
├── api.ts            # API request/response types
├── admin.ts          # Admin dashboard types
├── prisma.ts         # Prisma model exports
└── storage.ts        # Storage/upload types

lib/validations/
├── auth.ts           # Auth validation schemas
├── user.ts           # User validation schemas
├── common.ts         # Reusable schema patterns
├── admin.ts          # Admin-specific validation
├── contact.ts        # Contact form validation
└── storage.ts        # Storage/upload validation

lib/api/
├── client.ts         # Type-safe API client
├── validation.ts     # Request validation utilities
├── responses.ts      # Response formatters
├── errors.ts         # Error handling
├── endpoints.ts      # API endpoint constants
├── parse-response.ts # Response parsing utilities
└── server-fetch.ts   # Server-side fetch wrapper

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
- `UserEmailPreferences` - Email notification preferences
- `UserPreferences` - Top-level user preferences
- `InvitationListItem` - Pending invitation for admin display
- `InvitationListResponse` - Paginated invitation list response
- Storage types (re-exported from `types/storage.ts`)

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
- `ContactSubmission` - Contact form submission model
- `FeatureFlag` - Feature flag model
- `Prisma` - Prisma namespace (utility types)

**When to use:**

- Importing database model types
- Using Prisma utility types (Select, Include, Where, etc.)
- Type-safe Prisma queries

### Admin Types (`types/admin.ts`)

**Purpose:** Types for admin dashboard functionality (Phase 4.4)

**Exports:**

- `SystemStats` - Dashboard overview statistics (user counts, system info)
- `LogEntry` - Log entry structure with level, message, context, error details
- `LogsQuery` - Query parameters for log filtering
- `FeatureFlagWithMeta` - Feature flag with parsed metadata
- `CreateFeatureFlagInput` - Input for creating feature flags
- `UpdateFeatureFlagInput` - Input for updating feature flags
- `AdminUserUpdateInput` - Fields an admin can update on a user
- `AdminUser` - User data as seen by admins (extended view)

**When to use:**

- Building admin dashboard components
- Typing admin API route requests/responses
- Working with feature flags
- Implementing user management features

### Validation Schemas (`lib/validations/`)

**Purpose:** Runtime validation using Zod

**Key Schemas:**

- **common.ts:**
  - `paginationQuerySchema` - Page/limit validation
  - `sortingQuerySchema` - sortBy/sortOrder validation
  - `searchQuerySchema` - Search query validation
  - `listQuerySchema` - Combined pagination+sorting+search
  - `paginationMetaSchema` - API response meta validation
  - `parsePaginationMeta()` - Safe meta parsing function
  - `cuidSchema` - CUID validation
  - `uuidSchema` - UUID validation
  - `urlSchema` - URL validation
  - `slugSchema` - Slug validation

- **auth.ts:**
  - `emailSchema` - Email validation with normalization
  - `passwordSchema` - Password strength validation
  - `signUpSchema` - User registration
  - `signInSchema` - User login
  - `changePasswordSchema` - Password change
  - `resetPasswordRequestSchema` - Forgot password
  - `resetPasswordSchema` - Password reset with token
  - `verifyEmailSchema` - Email verification
  - `sendVerificationEmailSchema` - Request verification email

- **user.ts:**
  - `updateUserSchema` - Profile updates
  - `listUsersQuerySchema` - User list queries
  - `inviteUserSchema` - Admin user invitation
  - `acceptInvitationSchema` - Accept invitation
  - `userIdSchema` - User ID parameter validation
  - `emailPreferencesSchema` - Email notification preferences
  - `userPreferencesSchema` - Full user preferences
  - `updatePreferencesSchema` - Preferences update
  - `deleteAccountSchema` - Account deletion confirmation

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
  - `ErrorCodes` - Standard error code constants
  - `APIError` - Base error class
  - `ValidationError` - 400 validation errors
  - `UnauthorizedError` - 401 auth errors
  - `ForbiddenError` - 403 permission errors
  - `NotFoundError` - 404 not found errors
  - `ConflictError` - 409 conflict errors
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

// Admin types
import type {
  SystemStats,
  LogEntry,
  FeatureFlagWithMeta,
  AdminUser,
  AdminUserUpdateInput,
} from '@/types/admin';

// Prisma types
import { User, Session, Prisma } from '@/types/prisma';

// Validation schemas
import { updateUserSchema } from '@/lib/validations/user';
import { paginationQuerySchema } from '@/lib/validations/common';

// API client (frontend)
import { apiClient, APIClientError } from '@/lib/api/client';

// API utilities (backend)
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { NotFoundError, ConflictError, handleAPIError } from '@/lib/api/errors';
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
const body = validateRequestBody(request, inviteUserSchema);
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

## Zod Patterns

### Top-Level vs String Methods

Zod 4 provides both top-level validators and string methods. Choose based on whether you need transforms:

**Simple validation (no transforms):**

```typescript
z.email(); // Top-level - validates only
z.cuid(); // Top-level - validates only
z.uuid(); // Top-level - validates only
z.url(); // Top-level - validates only
```

**With transforms (trim, lowercase, etc.):**

```typescript
// Apply transforms BEFORE validation
z.string()
  .trim() // Transform first
  .toLowerCase() // Transform second
  .email(); // Then validate

// ❌ Wrong order - validates raw input
z.string()
  .email() // Validates before transforms!
  .trim()
  .toLowerCase();
```

### Transform Order Rule

When combining transforms with validation, **transforms must come first**. Otherwise validation runs on untransformed input (e.g., email validation fails due to whitespace).

See `emailSchema` in `lib/validations/auth.ts` for the canonical pattern.
