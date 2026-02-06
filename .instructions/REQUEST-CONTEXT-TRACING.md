# Request Context Tracing Implementation

**Status:** Planned
**Priority:** Medium
**Effort:** ~2 hours

## Overview

The codebase has a half-implemented distributed tracing system. The proxy generates request IDs, but API routes don't attach them to logs. This work completes the implementation to enable production debugging via request ID correlation.

## Current State

| Component                      | Status       | Location                 |
| ------------------------------ | ------------ | ------------------------ |
| Request ID generation          | Done         | `proxy.ts:100`           |
| Request ID in response headers | Done         | `proxy.ts:224`           |
| Context extraction utilities   | Done         | `lib/logging/context.ts` |
| API routes using context       | **Not done** | All routes in `app/api/` |

## What Needs to Be Done

### 1. Update API Routes to Use Request Context

For each API route, change from:

```typescript
// Current pattern
import { logger } from '@/lib/logging';

export async function POST(request: NextRequest) {
  try {
    logger.info('Creating user', { email });
    // ... logic
  } catch (error) {
    logger.error('Failed to create user', error);
    return handleAPIError(error);
  }
}
```

To:

```typescript
// New pattern with request context
import { logger } from '@/lib/logging';
import { getFullContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const context = await getFullContext(request);
  const log = logger.withContext(context);

  try {
    log.info('Creating user', { email });
    // ... logic
  } catch (error) {
    log.error('Failed to create user', error);
    return handleAPIError(error);
  }
}
```

### 2. Routes to Update

Run this to find all API routes:

```bash
find app/api -name "route.ts" | head -20
```

Key routes (prioritize these):

- `app/api/v1/users/route.ts`
- `app/api/v1/contact/route.ts`
- `app/api/v1/admin/**/*.ts`
- `app/api/auth/**/*.ts` (custom auth routes only)

### 3. Optional: Create a Helper

Consider adding a helper to reduce boilerplate:

```typescript
// lib/api/context.ts
import { logger } from '@/lib/logging';
import { getFullContext } from '@/lib/logging/context';

export async function getRouteLogger(request: Request) {
  const context = await getFullContext(request);
  return logger.withContext(context);
}
```

Usage:

```typescript
import { getRouteLogger } from '@/lib/api/context';

export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);
  log.info('Processing request');
}
```

## Benefits

1. **Production debugging** - Search logs by request ID to trace entire request flow
2. **User context** - Logs automatically include userId/sessionId when authenticated
3. **Error correlation** - Connect client errors to server errors via shared request ID
4. **Audit trail** - See which user performed which action

## Example Log Output

Before (no context):

```json
{"level":"info","message":"Creating user","meta":{"email":"user@example.com"}}
{"level":"error","message":"Database error","error":{"name":"PrismaError"}}
```

After (with context):

```json
{"level":"info","message":"Creating user","context":{"requestId":"abc123","userId":"user_456"},"meta":{"email":"user@example.com"}}
{"level":"error","message":"Database error","context":{"requestId":"abc123","userId":"user_456"},"error":{"name":"PrismaError"}}
```

Now you can search `requestId:abc123` and see the entire request flow.

## Testing

1. Make an API request
2. Check response headers for `x-request-id`
3. Check server logs for matching `requestId` in context
4. Verify authenticated requests include `userId` and `sessionId`

## Documentation Updates

After implementing, update `.context/errors/logging.md`:

- Change request context patterns from "recommended" to "standard practice"
- Add examples showing the new pattern
