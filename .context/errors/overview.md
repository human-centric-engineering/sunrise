# Error Handling & Logging - Architecture Overview

**Last Updated**: 2025-12-22
**Phase**: 2.3 - Error Handling & Logging
**Status**: ✅ Complete

This document describes the comprehensive error handling and logging system implemented in Sunrise.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Four-Layer Error Handling](#four-layer-error-handling)
- [Error Flow Diagrams](#error-flow-diagrams)
- [Error Boundaries](#error-boundaries)
- [User-Friendly Messaging](#user-friendly-messaging)
- [Integration with Existing Systems](#integration-with-existing-systems)
- [Quick Start Examples](#quick-start-examples)

## Architecture Overview

The error handling system consists of four integrated layers:

```
┌─────────────────────────────────────────────────────────┐
│                    Error Tracking                        │
│              (Sentry or No-Op Mode)                     │
│  lib/errors/sentry.ts - trackError(), trackMessage()    │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────┐
│                  Structured Logging                      │
│         (Environment-Aware JSON/Colored Output)         │
│    lib/logging/index.ts - logger.error/warn/info()      │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────┐
│                   Error Handlers                         │
│  Global (client) + API routes (server) + Boundaries     │
│  lib/errors/handler.ts - handleClientError()            │
│  lib/api/errors.ts - handleAPIError()                   │
│  components/error-boundary.tsx - ErrorBoundary          │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────┐
│              User-Friendly Messages                      │
│    Error Code → Human-Readable Translation              │
│  lib/errors/messages.ts - getUserFriendlyMessage()      │
└─────────────────────────────────────────────────────────┘
```

## Four-Layer Error Handling

### Layer 1: User-Friendly Messages

**Purpose**: Translate technical error codes to actionable user messages

**Location**: `lib/errors/messages.ts`

**Key Functions**:

- `getUserFriendlyMessage(code)` - Map error code to friendly text
- `getContextualErrorMessage(code, context)` - Generate context-aware messages
- `getFormErrorMessage(error, field)` - Extract form-specific errors

**Example**:

```typescript
import { getUserFriendlyMessage } from '@/lib/errors/messages';

// Technical error code
const error = { code: 'UNAUTHORIZED' };

// User-friendly message
const message = getUserFriendlyMessage(error.code);
// → "Please sign in to continue."
```

**Error Code Mappings**:

- `UNAUTHORIZED` → "Please sign in to continue."
- `FORBIDDEN` → "You don't have permission to access this resource."
- `NOT_FOUND` → "The requested resource could not be found."
- `VALIDATION_ERROR` → "Please check your input and try again."
- `EMAIL_TAKEN` → "This email address is already registered."
- `RATE_LIMIT_EXCEEDED` → "Too many requests. Please try again later."
- `INTERNAL_ERROR` → "Something went wrong. Please try again."

### Layer 2: Error Handlers

**Purpose**: Centralize error catching and processing

**Components**:

1. **Global Client Error Handler** (`lib/errors/handler.ts`)
   - Catches all unhandled promise rejections
   - Catches all uncaught runtime errors
   - Normalizes errors to consistent format
   - Automatic PII scrubbing

2. **API Error Handler** (`lib/api/errors.ts`)
   - Handles all API route errors
   - Consistent error response format
   - Prisma error translation
   - Zod validation error formatting

3. **Error Boundaries** (`components/error-boundary.tsx`)
   - React component error catching
   - Route-specific boundaries
   - Customizable fallback UI
   - Automatic error recovery

**Example - Global Handler**:

```typescript
// Automatically catches unhandled errors
throw new Error('Something failed');
// → Caught, logged, tracked, shown to user
```

**Example - API Handler**:

```typescript
// app/api/v1/users/route.ts
export async function POST(request: NextRequest) {
  try {
    // ... route logic
  } catch (error) {
    return handleAPIError(error); // Centralized handling
  }
}
```

**Example - Error Boundary**:

```typescript
<ErrorBoundary fallback={<MyErrorUI />}>
  <MyComponent />
</ErrorBoundary>
```

### Layer 3: Structured Logging

**Purpose**: Consistent, environment-aware logging with request context

**Location**: `lib/logging/index.ts`, `lib/logging/context.ts`

**Features**:

- Environment-aware output (JSON in prod, colored in dev)
- Request ID propagation for distributed tracing
- User context association
- Automatic PII sanitization
- Child loggers with inherited context

**Log Levels**:

- `DEBUG` - Verbose debugging info (dev only)
- `INFO` - General application flow
- `WARN` - Degraded states, non-breaking issues
- `ERROR` - Breaking errors that need attention

**Example**:

```typescript
import { logger } from '@/lib/logging';

// Basic logging
logger.info('User logged in', { userId: '123' });
logger.error('Database query failed', error, { query: 'SELECT ...' });

// With request context
import { getRequestId } from '@/lib/logging/context';

const requestId = await getRequestId();
const requestLogger = logger.withContext({ requestId });
requestLogger.info('Processing request'); // Includes requestId automatically
```

**Distributed Tracing**:

```
Client Request
    │
    ├─ Request ID: abc123def456...
    │
    ├─ Client log: "User clicked delete button"
    │   { requestId: "abc123...", component: "UserTable" }
    │
    ├─ Server log: "DELETE /api/v1/users/:id received"
    │   { requestId: "abc123...", userId: "user_789" }
    │
    ├─ Database log: "User deleted from database"
    │   { requestId: "abc123...", userId: "user_789", duration_ms: 45 }
    │
    └─ All logs share same requestId → Easy debugging
```

### Layer 4: Error Tracking

**Purpose**: Production error monitoring and alerting

**Location**: `lib/errors/sentry.ts`

**Features**:

- No-op mode (works without Sentry installed)
- Drop-in Sentry integration (just set DSN)
- Error severity levels
- User context association
- Tags for filtering and grouping
- Automatic PII scrubbing

**Example**:

```typescript
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

try {
  riskyOperation();
} catch (error) {
  trackError(error, {
    tags: { feature: 'checkout', step: 'payment' },
    extra: { orderId: '123', amount: 99.99 },
    level: ErrorSeverity.Error,
  });
}
```

**Sentry Setup** (optional):

1. `npm install @sentry/nextjs`
2. Set `NEXT_PUBLIC_SENTRY_DSN` environment variable
3. Create `sentry.client.config.ts` and `sentry.server.config.ts`
4. Update `next.config.js` with `withSentryConfig()`
5. Restart server → Sentry automatically enabled

## Error Flow Diagrams

### Client-Side Error Flow

```
User Action → Component Error
                │
                ├─ Caught by Error Boundary?
                │   YES → Show fallback UI
                │        → Log with logger.error()
                │        → Track with trackError()
                │        → Show "Try again" button
                │
                ├─ Unhandled Promise Rejection?
                │   YES → Global error handler (lib/errors/handler.ts)
                │        → Normalize error
                │        → Log with logger.error()
                │        → Track with trackError()
                │        → (No UI shown - silent recovery)
                │
                └─ Uncaught Runtime Error?
                    YES → Global error handler (lib/errors/handler.ts)
                         → Normalize error
                         → Log with logger.error()
                         → Track with trackError()
                         → (No UI shown - silent recovery)
```

### Server-Side Error Flow

```
API Request → Route Handler Error
                │
                ├─ APIError (custom)?
                │   YES → Use error.code and error.message
                │        → Log with logger.error()
                │        → Return errorResponse()
                │
                ├─ Zod Validation Error?
                │   YES → Transform to field errors
                │        → Return VALIDATION_ERROR response
                │
                ├─ Prisma Error?
                │   YES → Translate Prisma code (P2002 → EMAIL_TAKEN)
                │        → Return appropriate error response
                │
                └─ Unknown Error?
                    YES → Return INTERNAL_ERROR
                         → Log with logger.error()
                         → Return generic error response
```

### Distributed Tracing Flow

```
1. Request enters proxy.ts
   └─ Generate request ID: abc123def456...
   └─ Set x-request-id header in response

2. Client receives request ID
   └─ Store for subsequent requests

3. Client makes API call
   └─ Include x-request-id in request headers

4. Server receives request
   └─ Extract request ID from headers
   └─ Create logger with context: logger.withContext({ requestId })

5. All logs include request ID
   └─ Client: { requestId: "abc123...", action: "click-delete" }
   └─ Server: { requestId: "abc123...", endpoint: "/api/v1/users/:id" }
   └─ Database: { requestId: "abc123...", query: "DELETE FROM users" }

6. Error occurs
   └─ All logs/errors share same requestId
   └─ Search logs by requestId → See complete flow
```

## Error Boundaries

### When to Use Error Boundaries

**Use error boundaries to**:

- Isolate component tree failures
- Provide graceful degradation
- Show user-friendly error UI
- Enable error recovery without page reload

**Where to place boundaries**:

- ✅ Around route-level components (app/(protected)/error.tsx)
- ✅ Around complex feature components
- ✅ Around third-party integrations
- ❌ NOT around event handlers (use try/catch)
- ❌ NOT around async code (use global handler)

### Error Boundary Hierarchy

```
app/error.tsx (Root)
    │
    ├─ app/(protected)/error.tsx
    │   └─ Catches: Dashboard, Settings, Profile errors
    │   └─ Special handling: Session expiration → Redirect to login
    │
    ├─ app/(public)/error.tsx
    │   └─ Catches: Landing, About, Contact errors
    │   └─ Special handling: Show "Go home" button
    │
    └─ app/(auth)/error.tsx (optional)
        └─ Catches: Login, Signup, Reset Password errors
        └─ Special handling: Show "Try again" or "Contact support"
```

**Nested boundaries catch first**:

```typescript
// Error in dashboard component:
<RootErrorBoundary>          // ← Won't catch (nested boundary catches first)
  <ProtectedErrorBoundary>   // ← Catches here!
    <DashboardPage />         // ← Error occurs here
  </ProtectedErrorBoundary>
</RootErrorBoundary>
```

### Custom Error Boundaries

```typescript
import { ErrorBoundary } from '@/components/error-boundary';

// Basic usage
<ErrorBoundary>
  <ComplexFeature />
</ErrorBoundary>

// Custom fallback
<ErrorBoundary
  fallback={(error, reset) => (
    <div>
      <h2>Feature unavailable</h2>
      <p>{error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  )}
>
  <ComplexFeature />
</ErrorBoundary>

// Auto-reset when data changes
<ErrorBoundary resetKeys={[userId]}>
  <UserProfile userId={userId} />
</ErrorBoundary>

// With error callback
<ErrorBoundary
  onError={(error, errorInfo) => {
    analytics.track('component-error', {
      component: errorInfo.componentStack
    });
  }}
>
  <ComplexFeature />
</ErrorBoundary>
```

## User-Friendly Messaging

### Error Code → User Message Translation

**Problem**: Technical error codes are not user-friendly

```typescript
// Bad (technical)
'VALIDATION_ERROR: Email field failed regex validation';

// Good (user-friendly)
'Please check your input and try again.';
```

**Solution**: `lib/errors/messages.ts` provides translation layer

**Simple mapping**:

```typescript
import { getUserFriendlyMessage } from '@/lib/errors/messages';

getUserFriendlyMessage('UNAUTHORIZED');
// → "Please sign in to continue."
```

**Contextual messages**:

```typescript
import { getContextualErrorMessage } from '@/lib/errors/messages';

getContextualErrorMessage('NOT_FOUND', { resource: 'user' });
// → "User not found."

getContextualErrorMessage('FORBIDDEN', { action: 'delete', resource: 'post' });
// → "You don't have permission to delete this post."
```

**Form-specific errors**:

```typescript
import { getFormErrorMessage } from '@/lib/errors/messages';

const apiError = {
  code: 'VALIDATION_ERROR',
  details: { email: ['Invalid email format'] },
};

getFormErrorMessage(apiError, 'email');
// → "Invalid email format"
```

### Using Friendly Messages in Components

**FormError component** (automatic translation):

```typescript
import { FormError } from '@/components/forms/form-error';

// Direct message
<FormError message="Email is required" />

// Error code (automatically translated)
<FormError code="UNAUTHORIZED" />
// → Displays: "Please sign in to continue."

// From API error
<FormError code={apiError.code} />
```

**Custom error displays**:

```typescript
import { getUserFriendlyMessage } from '@/lib/errors/messages';

function MyComponent() {
  const [error, setError] = useState(null);

  const handleAction = async () => {
    try {
      await apiCall();
    } catch (err) {
      const message = getUserFriendlyMessage(err.code);
      setError(message);
    }
  };

  return (
    <div>
      {error && <p className="text-red-500">{error}</p>}
      <button onClick={handleAction}>Submit</button>
    </div>
  );
}
```

## Integration with Existing Systems

### API Error System Integration

The error handling system **extends** (not replaces) the existing API error classes:

**Existing API errors** (`lib/api/errors.ts`):

- ✅ Still works exactly the same
- ✅ Enhanced with structured logging
- ✅ Integrated with error tracking
- ✅ User-friendly message translation available

**Example - No changes needed**:

```typescript
// This still works exactly as before
throw new UnauthorizedError();
throw new ValidationError('Invalid input', details);
throw new NotFoundError('User not found');

// Now also:
// - Logged with structured logger
// - Tracked in Sentry (if configured)
// - Can be translated to user-friendly messages
```

### better-auth Integration

**Server-side session checking**:

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

**Database utilities**:

```typescript
// lib/db/utils.ts uses structured logger
import { checkDatabaseConnection, getDatabaseHealth } from '@/lib/db/utils';

const connected = await checkDatabaseConnection();
// Errors logged with: logger.error('Database connection failed', error)
```

**Seed script**:

```typescript
// prisma/seed.ts uses structured logger
logger.info('🌱 Seeding database...');
logger.info('✅ Created test user', { email: testUser.email });
logger.error('❌ Seeding failed', error);
```

## Quick Start Examples

### Example 1: Log an Info Message

```typescript
import { logger } from '@/lib/logging';

logger.info('User completed checkout', {
  userId: '123',
  orderId: 'order_456',
  total: 99.99,
});
```

**Output (development)**:

```
10:30:45 INFO  User completed checkout
  Meta: {"userId":"123","orderId":"order_456","total":99.99}
```

**Output (production)**:

```json
{
  "timestamp": "2025-12-22T10:30:45.123Z",
  "level": "info",
  "message": "User completed checkout",
  "meta": {
    "userId": "123",
    "orderId": "order_456",
    "total": 99.99
  }
}
```

### Example 2: Log an Error with Context

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

### Example 3: Track an Error in Sentry

```typescript
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

try {
  await processPayment(orderId);
} catch (error) {
  trackError(error, {
    tags: {
      feature: 'checkout',
      step: 'payment',
      paymentMethod: 'stripe',
    },
    extra: {
      orderId,
      amount: 99.99,
      currency: 'USD',
    },
    level: ErrorSeverity.Error,
  });

  throw error; // Re-throw to show UI error
}
```

### Example 4: Custom Error Boundary

```typescript
import { ErrorBoundary } from '@/components/error-boundary';

function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>

      <ErrorBoundary
        fallback={(error, reset) => (
          <Card>
            <CardHeader>
              <CardTitle>Stats Unavailable</CardTitle>
              <CardDescription>
                Unable to load statistics. {error.message}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={reset}>Retry</Button>
            </CardContent>
          </Card>
        )}
      >
        <StatisticsWidget />
      </ErrorBoundary>

      <UserActivity />
    </div>
  );
}
```

### Example 5: Show User-Friendly Error in Form

```typescript
import { FormError } from '@/components/forms/form-error';
import { getUserFriendlyMessage } from '@/lib/errors/messages';

function SignupForm() {
  const [apiError, setApiError] = useState(null);

  const onSubmit = async (data) => {
    try {
      await apiClient.post('/api/v1/users', data);
    } catch (error) {
      setApiError(error);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input name="email" />

      {/* Show API error with user-friendly message */}
      {apiError && <FormError code={apiError.code} />}

      <Button type="submit">Sign Up</Button>
    </form>
  );
}
```

## Related Documentation

- **[Logging Best Practices](./logging.md)** - Detailed logging guidelines
- **[API Error Handling](./../api/endpoints.md#error-responses)** - API error format
- **[Authentication](./../auth/overview.md)** - Auth error handling
- **[Database](./../database/schema.md)** - Prisma error handling

## See Also

- `lib/logging/index.ts` - Logger implementation
- `lib/logging/context.ts` - Request context utilities
- `lib/errors/handler.ts` - Global error handler
- `lib/errors/messages.ts` - User-friendly messages
- `lib/errors/sentry.ts` - Error tracking abstraction
- `lib/api/errors.ts` - API error classes
- `components/error-boundary.tsx` - Reusable error boundary
