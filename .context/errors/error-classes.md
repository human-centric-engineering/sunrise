# API Error Classes

**Last Updated**: 2026-02-06
**Related**: [Error Handling Overview](./overview.md)

This document covers the API error classes used for consistent error handling across all API routes.

## Table of Contents

- [APIError Base Class](#apierror-base-class)
- [Error Classes](#error-classes)
- [When to Use Each](#when-to-use-each)
- [handleAPIError Function](#handleapierror-function)
- [Prisma Error Translation](#prisma-error-translation)
- [Zod Validation Errors](#zod-validation-errors)
- [Integration with Existing Systems](#integration-with-existing-systems)

## APIError Base Class

**Location**: `lib/api/errors.ts`

The base class for all API errors. Extend this for custom error types or use directly.

```typescript
import { APIError } from '@/lib/api/errors';

// Direct usage
throw new APIError('Something went wrong', 'CUSTOM_ERROR', 500);

// With details
throw new APIError('Invalid request', 'BAD_REQUEST', 400, {
  reason: 'Missing required field',
});
```

**Constructor Parameters**:

| Parameter | Type                      | Default     | Description                    |
| --------- | ------------------------- | ----------- | ------------------------------ |
| `message` | `string`                  | (required)  | Error message                  |
| `code`    | `string`                  | `undefined` | Error code for client handling |
| `status`  | `number`                  | `500`       | HTTP status code               |
| `details` | `Record<string, unknown>` | `undefined` | Additional error details       |

## Error Classes

### ValidationError (400)

Used when request data fails validation.

```typescript
import { ValidationError } from '@/lib/api/errors';

// Basic validation error
throw new ValidationError('Invalid input');

// With field-specific details
throw new ValidationError('Validation failed', {
  email: ['Invalid email format'],
  password: ['Too short', 'Must contain a number'],
});
```

### UnauthorizedError (401)

Used when authentication is required but not provided or invalid.

```typescript
import { UnauthorizedError } from '@/lib/api/errors';

if (!session) {
  throw new UnauthorizedError();
}

// With custom message
throw new UnauthorizedError('Session expired');
```

### ForbiddenError (403)

Used when user is authenticated but lacks permission.

```typescript
import { ForbiddenError } from '@/lib/api/errors';

if (session.user.role !== 'ADMIN') {
  throw new ForbiddenError('Admin access required');
}
```

### NotFoundError (404)

Used when a requested resource does not exist.

```typescript
import { NotFoundError } from '@/lib/api/errors';

const user = await prisma.user.findUnique({ where: { id } });
if (!user) {
  throw new NotFoundError('User not found');
}
```

### ConflictError (409)

Used for resource conflicts like duplicates or concurrent modifications.

```typescript
import { ConflictError } from '@/lib/api/errors';

// Duplicate resource
const existingFlag = await prisma.featureFlag.findUnique({ where: { key } });
if (existingFlag) {
  throw new ConflictError('Feature flag already exists');
}

// Concurrent modification
throw new ConflictError('Resource was modified by another request');
```

## When to Use Each

| Error               | HTTP Status   | Use Case                                       |
| ------------------- | ------------- | ---------------------------------------------- |
| `ValidationError`   | 400           | Invalid input data, schema validation failures |
| `UnauthorizedError` | 401           | Missing or invalid authentication              |
| `ForbiddenError`    | 403           | Authenticated but lacks permission             |
| `NotFoundError`     | 404           | Resource does not exist                        |
| `ConflictError`     | 409           | Duplicate resources, concurrent modification   |
| `APIError`          | 500 (default) | Custom errors, internal server errors          |

### Anti-Patterns

**Don't use ConflictError for**:

- Validation errors (use `ValidationError`)
- Missing resources (use `NotFoundError`)
- Permission issues (use `ForbiddenError`)

**Don't use generic messages in production**:

```typescript
// Bad - leaks implementation details
throw new APIError(error.message, 'INTERNAL_ERROR', 500);

// Good - generic message for unknown errors
throw new APIError('An unexpected error occurred', 'INTERNAL_ERROR', 500);
```

## handleAPIError Function

**Location**: `lib/api/errors.ts`

Centralized error handler for all API routes. Automatically handles APIError, Zod, and Prisma errors.

```typescript
import { handleAPIError } from '@/lib/api/errors';

export async function POST(request: NextRequest) {
  try {
    // ... route logic
  } catch (error) {
    return handleAPIError(error);
  }
}
```

**What it handles**:

1. `APIError` instances - Uses error's code, status, and details
2. `z.ZodError` - Transforms to VALIDATION_ERROR with field details
3. `Prisma.PrismaClientKnownRequestError` - Translates Prisma codes
4. `Prisma.PrismaClientValidationError` - Returns VALIDATION_ERROR
5. Unknown errors - Returns INTERNAL_ERROR (generic message in production)

## Prisma Error Translation

The `handleAPIError` function automatically translates Prisma error codes:

| Prisma Code | API Error        | HTTP Status | Example                          |
| ----------- | ---------------- | ----------- | -------------------------------- |
| `P2002`     | EMAIL_TAKEN      | 400         | Unique constraint violation      |
| `P2025`     | NOT_FOUND        | 404         | Record not found                 |
| `P2003`     | VALIDATION_ERROR | 400         | Foreign key constraint violation |
| Other       | INTERNAL_ERROR   | 500         | Generic database error           |

**P2002 - Unique Constraint Violation**:

```typescript
// When Prisma throws P2002 (e.g., duplicate email)
// handleAPIError returns:
{
  success: false,
  error: {
    code: "EMAIL_TAKEN",
    message: "Email already exists",
    details: { field: "email", constraint: "unique" }
  }
}
```

**P2025 - Record Not Found**:

```typescript
// When Prisma throws P2025 (e.g., delete non-existent record)
// handleAPIError returns:
{
  success: false,
  error: {
    code: "NOT_FOUND",
    message: "Record not found"
  }
}
```

## Zod Validation Errors

Zod validation errors are automatically transformed to a readable format:

```typescript
// When Zod throws validation error
const schema = z.object({
  email: z.string().email(),
  age: z.number().min(18),
});

// handleAPIError transforms to:
{
  success: false,
  error: {
    code: "VALIDATION_ERROR",
    message: "Validation failed",
    details: {
      email: ["Invalid email"],
      age: ["Number must be greater than or equal to 18"]
    }
  }
}
```

**Manual Zod error handling** (if needed):

```typescript
const result = schema.safeParse(data);
if (!result.success) {
  // Transform Zod errors to field details format
  const details: Record<string, string[]> = {};
  result.error.issues.forEach((issue) => {
    const path = issue.path.join('.');
    if (!details[path]) details[path] = [];
    details[path].push(issue.message);
  });
  throw new ValidationError('Invalid input', details);
}
```

## Integration with Existing Systems

### better-auth Integration

Auth utilities use structured logging and API errors:

```typescript
// lib/auth/utils.ts already uses logger
import { getServerSession } from '@/lib/auth/utils';

const session = await getServerSession();
// Errors logged with: logger.error('Failed to get server session', error)
```

**Client-side auth errors**:

```typescript
// components/forms/oauth-button.tsx
// components/auth/logout-button.tsx
// Both now use: logger.error('OAuth sign-in error', error)
```

### Prisma Integration

Database utilities use structured logging:

```typescript
import { checkDatabaseConnection, getDatabaseHealth } from '@/lib/db/utils';

const connected = await checkDatabaseConnection();
// Errors logged with: logger.error('Database connection failed', error)
```

**Seed script logging**:

```typescript
// prisma/seed.ts uses structured logger
logger.info('Seeding database...');
logger.info('Created test user', { email: testUser.email });
logger.error('Seeding failed', error);
```

### Using with Auth Guards

Auth guards automatically handle errors:

```typescript
import { withAuth, withAdminAuth } from '@/lib/auth/guards';

// Returns 401 if not authenticated
export const GET = withAuth(async (request, session) => {
  // session is guaranteed to exist
  return successResponse({ user: session.user });
});

// Returns 403 if not admin
export const DELETE = withAdminAuth(async (request, session) => {
  // session.user.role is guaranteed to be 'ADMIN'
  await prisma.user.delete({ where: { id } });
  return successResponse({ deleted: true });
});
```

## Related Documentation

- **[Error Handling Overview](./overview.md)** - Architecture and flow diagrams
- **[User-Friendly Messages](./user-messages.md)** - Error code to message mapping
- **[API Endpoints](../api/endpoints.md)** - API response format

## See Also

- `lib/api/errors.ts` - Error classes implementation
- `lib/api/responses.ts` - Response utilities
- `lib/auth/guards.ts` - Auth guard wrappers
