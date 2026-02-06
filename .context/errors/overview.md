# Error Handling - Architecture Overview

**Last Updated**: 2026-02-06
**Status**: Complete

This document provides a high-level overview of the error handling architecture in Sunrise. For detailed implementation guidance, see the linked documentation.

## Table of Contents

- [Architecture Diagram](#architecture-diagram)
- [Four-Layer Summary](#four-layer-summary)
- [Error Flow Diagrams](#error-flow-diagrams)
- [Quick Start](#quick-start)
- [Related Documentation](#related-documentation)

## Architecture Diagram

The error handling system consists of four integrated layers:

```
+-------------------------------------------------------------+
|                    Error Tracking                            |
|              (Sentry or No-Op Mode)                         |
|  lib/errors/sentry.ts - trackError(), trackMessage()        |
+-------------------------------------------------------------+
                            ^
                            |
+-------------------------------------------------------------+
|                  Structured Logging                          |
|         (Environment-Aware JSON/Colored Output)             |
|    lib/logging/index.ts - logger.error/warn/info()          |
+-------------------------------------------------------------+
                            ^
                            |
+-------------------------------------------------------------+
|                   Error Handlers                             |
|  Global (client) + API routes (server) + Boundaries         |
|  lib/errors/handler.ts - handleClientError()                |
|  lib/api/errors.ts - handleAPIError()                       |
|  components/error-boundary.tsx - ErrorBoundary              |
+-------------------------------------------------------------+
                            ^
                            |
+-------------------------------------------------------------+
|              User-Friendly Messages                          |
|    Error Code -> Human-Readable Translation                 |
|  lib/errors/messages.ts - getUserFriendlyMessage()          |
+-------------------------------------------------------------+
```

## Four-Layer Summary

### Layer 1: User-Friendly Messages

Translates technical error codes to actionable user messages.

**Location**: `lib/errors/messages.ts`

**Key Functions**:

- `getUserFriendlyMessage(code)` - Map error code to friendly text
- `getContextualErrorMessage(code, context)` - Generate context-aware messages
- `getFormErrorMessage(error, field)` - Extract form-specific errors

See [User-Friendly Messages](./user-messages.md) for full documentation.

### Layer 2: Error Handlers

Centralizes error catching and processing across client and server.

**Components**:

| Handler          | Location                        | Purpose                                          |
| ---------------- | ------------------------------- | ------------------------------------------------ |
| Global Client    | `lib/errors/handler.ts`         | Catches unhandled promises and runtime errors    |
| API Handler      | `lib/api/errors.ts`             | Handles API route errors, Prisma/Zod translation |
| Error Boundaries | `components/error-boundary.tsx` | React component error catching                   |

See [Error Classes](./error-classes.md) and [Error Boundaries](./error-boundaries.md) for details.

### Layer 3: Structured Logging

Environment-aware logging with request context for distributed tracing.

**Location**: `lib/logging/index.ts`, `lib/logging/context.ts`

**Log Levels**:

- `DEBUG` - Verbose debugging (dev only)
- `INFO` - General application flow
- `WARN` - Degraded states, non-breaking issues
- `ERROR` - Breaking errors that need attention

See [Logging Overview](../logging/overview.md) for detailed guidelines.

### Layer 4: Error Tracking

Production error monitoring with optional Sentry integration.

**Location**: `lib/errors/sentry.ts`

**Features**:

- No-op mode (works without Sentry installed)
- Drop-in Sentry integration (just set DSN)
- Error severity levels
- User context association
- Automatic PII scrubbing

## Error Flow Diagrams

### Client-Side Error Flow

```
User Action -> Component Error
                |
                +-- Caught by Error Boundary?
                |   YES -> Show fallback UI
                |       -> Log with logger.error()
                |       -> Track with trackError()
                |       -> Show "Try again" button
                |
                +-- Unhandled Promise Rejection?
                |   YES -> Global error handler (lib/errors/handler.ts)
                |       -> Normalize error
                |       -> Log with logger.error()
                |       -> Track with trackError()
                |       -> (No UI shown - silent recovery)
                |
                +-- Uncaught Runtime Error?
                    YES -> Global error handler (lib/errors/handler.ts)
                        -> Normalize error
                        -> Log with logger.error()
                        -> Track with trackError()
                        -> (No UI shown - silent recovery)
```

### Server-Side Error Flow

```
API Request -> Route Handler Error
                |
                +-- APIError (custom)?
                |   YES -> Use error.code and error.message
                |       -> Log with logger.error()
                |       -> Return errorResponse()
                |
                +-- Zod Validation Error?
                |   YES -> Transform to field errors
                |       -> Return VALIDATION_ERROR response
                |
                +-- Prisma Error?
                |   YES -> Translate Prisma code (P2002 -> EMAIL_TAKEN)
                |       -> Return appropriate error response
                |
                +-- Unknown Error?
                    YES -> Return INTERNAL_ERROR
                        -> Log with logger.error()
                        -> Return generic error response
```

### Distributed Tracing Flow

```
1. Request enters proxy.ts
   +-- Generate request ID: abc123def456...
   +-- Set x-request-id header in response

2. Client receives request ID
   +-- Store for subsequent requests

3. Client makes API call
   +-- Include x-request-id in request headers

4. Server receives request
   +-- Extract request ID from headers
   +-- Create logger with context: logger.withContext({ requestId })

5. All logs include request ID
   +-- Client: { requestId: "abc123...", action: "click-delete" }
   +-- Server: { requestId: "abc123...", endpoint: "/api/v1/users/:id" }
   +-- Database: { requestId: "abc123...", query: "DELETE FROM users" }

6. Error occurs
   +-- All logs/errors share same requestId
   +-- Search logs by requestId -> See complete flow
```

## Quick Start

### Log an Error with Context

```typescript
import { logger } from '@/lib/logging';
import { getRequestId } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const requestId = await getRequestId();
  const requestLogger = logger.withContext({ requestId });

  try {
    // ... route logic
  } catch (error) {
    requestLogger.error('Failed to create user', error, {
      endpoint: '/api/v1/users',
      method: 'POST',
    });
    throw error;
  }
}
```

### Throw API Errors

```typescript
import { UnauthorizedError, NotFoundError } from '@/lib/api/errors';

// In an API route
if (!session) {
  throw new UnauthorizedError();
}

if (!user) {
  throw new NotFoundError('User not found');
}
```

See [Error Classes](./error-classes.md) for all available error types.

### Show User-Friendly Errors

```typescript
import { FormError } from '@/components/forms/form-error';

// In a form component
{apiError && <FormError code={apiError.code} />}
```

See [User-Friendly Messages](./user-messages.md) for all error codes and patterns.

### Use Error Boundaries

```typescript
import { ErrorBoundary } from '@/components/error-boundary';

<ErrorBoundary
  fallback={(error, reset) => (
    <div>
      <p>{error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  )}
>
  <MyComponent />
</ErrorBoundary>
```

See [Error Boundaries](./error-boundaries.md) for hierarchy and custom boundaries.

## Utilities

### normalizeError()

**Location**: `lib/errors/handler.ts`

Converts unknown error values to a consistent format for logging and handling.

```typescript
import { normalizeError } from '@/lib/errors/handler';

try {
  await riskyOperation();
} catch (err) {
  const { message, error, metadata } = normalizeError(err);
  logger.error(message, error, metadata);
}
```

**Return values**:

- `message` - Human-readable error message
- `error` - An Error object (original or wrapped)
- `metadata` - Additional context (e.g., `code`, `cause`)

## Related Documentation

### Error Handling

- **[Error Classes](./error-classes.md)** - API error classes and Prisma/Zod integration
- **[Error Boundaries](./error-boundaries.md)** - React error boundaries and ErrorCard
- **[User-Friendly Messages](./user-messages.md)** - Error code mappings and form errors
- **[Logging Overview](../logging/overview.md)** - Detailed logging guidelines

### Related Domains

- **[API Endpoints](../api/endpoints.md#error-responses)** - API error format
- **[Authentication](../auth/overview.md)** - Auth error handling
- **[Database](../database/schema.md)** - Prisma error handling

## See Also

- `lib/logging/index.ts` - Logger implementation
- `lib/logging/context.ts` - Request context utilities
- `lib/errors/handler.ts` - Global error handler
- `lib/errors/messages.ts` - User-friendly messages
- `lib/errors/sentry.ts` - Error tracking abstraction
- `lib/api/errors.ts` - API error classes
- `components/error-boundary.tsx` - Reusable error boundary
- `components/ui/error-card.tsx` - Shared error UI component
