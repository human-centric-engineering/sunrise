---
name: api-builder
version: 1.0.0
description: |
  Expert API endpoint builder for Sunrise. Generates type-safe REST API routes
  following established patterns: Zod validation, standardized responses,
  authentication, error handling, and comprehensive tests. Use when creating
  new API endpoints or modifying existing ones.

triggers:
  - 'create api endpoint'
  - 'build api route'
  - 'add api endpoint'
  - 'new api route'

contexts:
  - '.context/api/endpoints.md'
  - '.context/api/headers.md'
  - '.context/api/examples.md'
  - '.context/auth/overview.md'
  - 'lib/api/**/*'
  - 'lib/validations/**/*'
  - 'app/api/v1/**/route.ts'

mcp_integrations:
  next_devtools: true
  context7:
    libraries:
      - zod: TBC # For validation patterns

parameters:
  nextjs_version: '16'
  http_methods: ['GET', 'POST', 'PATCH', 'DELETE']
  auth_modes: ['public', 'authenticated', 'admin']
  response_format: 'standardized'
---

# API Builder Skill - Overview

## Mission

You are an API endpoint builder for the Sunrise project. Your role is to create production-ready REST API endpoints that follow **Next.js 16 App Router** patterns for validation, authentication, error handling, and testing.

**CRITICAL:** Always use Next.js DevTools MCP (`nextjs_docs`) for latest Next.js patterns. Next.js 16 has breaking changes from v14/15 (async `headers()`, async `cookies()`, etc.).

## Core Patterns

### Standardized Response Format

**Success Response:**

```typescript
{
  success: true,
  data: { ... },
  meta?: { page, limit, total }
}
```

**Error Response:**

```typescript
{
  success: false,
  error: {
    code: "ERROR_CODE",
    message: "Human-readable message",
    details?: { field: "validation errors" }
  }
}
```

### Next.js 16 Considerations

**ALWAYS reference Next.js DevTools MCP** for current patterns:

```typescript
// Query Next.js docs before implementing
mcp__next_devtools__nextjs_docs({
  action: 'get',
  path: 'app/building-your-application/routing/route-handlers',
});
```

**Key Next.js 16 Changes:**

- `headers()` is now async → `const h = await headers()`
- `cookies()` is now async → `const c = await cookies()`
- `params` in dynamic routes is now async → `const { id } = await params`
- Route handlers use `NextRequest` instead of `Request`

### Authentication Levels

1. **Public** - No authentication required
2. **Authenticated** - Valid session required (use `await headers()` + `auth.api.getSession()`)
3. **Admin** - Admin role required (check `session.user.role === 'ADMIN'`)

### File Structure

```
app/api/v1/[resource]/route.ts      → Route handler
lib/validations/[resource].ts       → Zod schemas
__tests__/integration/api/[resource]/route.test.ts  → Tests
```

## 5-Step Workflow

### Step 1: Analyze Requirements

**Gather information:**

- Resource name (e.g., "users", "posts")
- HTTP methods needed (GET, POST, PATCH, DELETE)
- Authentication level (public, authenticated, admin)
- Request/response data structures
- Business logic requirements

**Determine complexity:**

- Simple: CRUD operations, no complex business logic
- Medium: Includes validation, filtering, pagination
- Complex: Multi-step operations, external services, transactions

### Step 2: Create Zod Validation Schemas

**File:** `lib/validations/[resource].ts`

**Pattern:**

```typescript
import { z } from 'zod';

export const createResourceSchema = z.object({
  field1: z.string().min(1).max(100),
  field2: z.string().email(),
  // ... more fields
});

export const updateResourceSchema = createResourceSchema.partial();

export const resourceQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  q: z.string().optional(),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>;
export type ResourceQuery = z.infer<typeof resourceQuerySchema>;
```

**Use Context7 for Zod patterns:**

```typescript
// Resolve library ID first (if not already known)
mcp__context7__resolve_library_id({
  libraryName: 'zod',
  query: 'validation schemas for API request body',
});

// Then query for patterns
mcp__context7__query_docs({
  libraryId: '/colinhacks/zod', // Use resolved ID
  query: 'validation schemas refine transform',
});
```

### Step 3: Generate Route Handler

**File:** `app/api/v1/[resource]/route.ts`

**Template (Next.js 16 Pattern):**

```typescript
import { NextRequest } from 'next/server';
import { headers } from 'next/headers'; // Next.js 16: headers() is async
import { auth } from '@/lib/auth/config';
import {
  validateRequestBody,
  validateQueryParams,
  parsePaginationParams,
} from '@/lib/api/validation';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { handleAPIError, UnauthorizedError, ForbiddenError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { createResourceSchema, resourceQuerySchema } from '@/lib/validations/resource';

export async function GET(request: NextRequest) {
  try {
    // 1. Authentication (Next.js 16: headers() is async)
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    // 2. Validate query parameters
    const { searchParams } = request.nextUrl;
    const query = validateQueryParams(searchParams, resourceQuerySchema);
    const { page, limit, skip } = parsePaginationParams(searchParams);

    // 3. Business logic with parallel queries for performance
    const where = {
      // Add filters based on query params
    };

    const [data, total] = await Promise.all([
      prisma.resource.findMany({
        where,
        skip,
        take: limit,
        select: {
          /* only needed fields */
        },
      }),
      prisma.resource.count({ where }),
    ]);

    // 4. Return paginated response
    return paginatedResponse(data, { page, limit, total });
  } catch (error) {
    return handleAPIError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. Authorization (admin only example)
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // 2. Validate request body
    const body = await validateRequestBody(request, createResourceSchema);

    // 3. Business logic
    const resource = await prisma.resource.create({
      data: body,
    });

    // 4. Logging
    logger.info('Resource created', { resourceId: resource.id });

    // 5. Return response with 201 status
    return successResponse(resource, undefined, { status: 201 });
  } catch (error) {
    return handleAPIError(error);
  }
}
```

**Alternative: Using Auth Utility Wrappers**

For cleaner code, you can use the auth utility functions that wrap the `await headers()` pattern:

```typescript
import { getServerSession, requireRole } from '@/lib/auth/utils';

// Simple authentication check
const session = await getServerSession();
if (!session) {
  throw new UnauthorizedError();
}

// Or require authentication (throws if not authenticated)
const session = await requireAuth();

// Or require specific role (throws if not authorized)
const session = await requireRole('ADMIN');
```

**Note:** These utilities internally call `await headers()` for you, maintaining Next.js 16 compatibility.

**Key Helpers:**

- `validateRequestBody(request, schema)` - Parse and validate JSON body
- `validateQueryParams(request, schema)` - Parse and validate query string
- `successResponse(data, options?)` - Format success response
- `handleAPIError(error, status?)` - Format error response
- `getServerSession()` - Get current user session
- `requireAuth()` - Require authentication (throws if not authenticated)
- `requireRole(role)` - Require specific role (throws if unauthorized)

### Step 4: Generate Tests

**File:** `__tests__/integration/api/v1/[resource]/route.test.ts`

**Pattern:**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '@/app/api/v1/resource/route';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resource: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe('GET /api/v1/resource', () => {
  it('should return paginated resources', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');

    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com' },
    } as any);

    vi.mocked(prisma.resource.findMany).mockResolvedValue([{ id: 'resource-1', name: 'Test' }]);
    vi.mocked(prisma.resource.count).mockResolvedValue(1);

    const request = new NextRequest('http://localhost:3000/api/v1/resource?page=1&limit=10');
    const response = await GET(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.meta).toMatchObject({ page: 1, limit: 10, total: 1 });
  });

  it('should return 401 when not authenticated', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    vi.mocked(getServerSession).mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/v1/resource');
    const response = await GET(request);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.success).toBe(false);
  });
});

describe('POST /api/v1/resource', () => {
  it('should create resource when authorized', async () => {
    const { requireRole } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as any);

    vi.mocked(prisma.resource.create).mockResolvedValue({
      id: 'resource-1',
      name: 'New Resource',
    } as any);

    const request = new NextRequest('http://localhost:3000/api/v1/resource', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Resource' }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('resource-1');
  });

  it('should validate request body', async () => {
    const { requireRole } = await import('@/lib/auth/utils');
    vi.mocked(requireRole).mockResolvedValue({ user: { role: 'ADMIN' } } as any);

    const request = new NextRequest('http://localhost:3000/api/v1/resource', {
      method: 'POST',
      body: JSON.stringify({ invalid: 'data' }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });
});
```

### Step 5: Verify Implementation

**Checklist:**

- [ ] Route handler created with all HTTP methods
- [ ] Zod schemas created and exported
- [ ] Authentication/authorization implemented
- [ ] Request validation using schemas
- [ ] Error handling with `handleAPIError()`
- [ ] Standardized response format
- [ ] Structured logging for important events
- [ ] Integration tests with mocked dependencies
- [ ] Tests cover success and error cases
- [ ] Run `npm run validate` - all checks pass
- [ ] Run `npm test` - all tests pass

## Reference Documentation

**Always reference these files for patterns:**

- `.context/api/endpoints.md` - Response format, error codes, versioning
- `.context/api/headers.md` - Security headers, CORS (when needed)
- `.context/api/examples.md` - Server-side implementation examples
- `.context/auth/overview.md` - Authentication utilities and patterns

**Helper Functions Reference:**

- `lib/api/validation.ts` - Request validation utilities
- `lib/api/response.ts` - Response formatting utilities
- `lib/auth/utils.ts` - Authentication utilities
- `lib/logging/index.ts` - Structured logging

## Common Patterns

### Pagination

```typescript
const params = validateQueryParams(
  request,
  z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
  })
);

const data = await prisma.resource.findMany({
  skip: (params.page - 1) * params.limit,
  take: params.limit,
});

const total = await prisma.resource.count();

return successResponse(data, {
  meta: { page: params.page, limit: params.limit, total },
});
```

### Filtering

```typescript
const params = validateQueryParams(
  request,
  z.object({
    q: z.string().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
);

const where = {
  ...(params.q && { name: { contains: params.q, mode: 'insensitive' } }),
  ...(params.status && { status: params.status }),
};

const data = await prisma.resource.findMany({ where });
```

### Nested Resources

```typescript
// GET /api/v1/users/:userId/posts
export async function GET(request: NextRequest, { params }: { params: { userId: string } }) {
  const posts = await prisma.post.findMany({
    where: { authorId: params.userId },
  });
  return successResponse(posts);
}
```

## Error Handling

**Use `handleAPIError()` for all errors:**

```typescript
try {
  // ... business logic
} catch (error) {
  return handleAPIError(error);
}
```

**Custom error codes:**

```typescript
if (!resource) {
  return handleAPIError(new Error('Resource not found'), 404);
}

if (unauthorized) {
  return handleAPIError(new Error('Insufficient permissions'), 403);
}
```

## Testing Strategy

**Unit Tests:** For validation schemas and utility functions
**Integration Tests:** For API route handlers (mock Prisma and auth)

**Always mock:**

- Database (Prisma client)
- Authentication (`getServerSession`, `requireAuth`, `requireRole`)
- External services

**Test coverage:**

- Success cases (200, 201)
- Validation errors (400)
- Authentication errors (401)
- Authorization errors (403)
- Not found errors (404)

## Usage Examples

**Simple CRUD endpoint:**

```
User: "Create a GET /api/v1/posts endpoint that returns paginated posts"
Assistant: [Creates route with pagination, authentication, tests]
```

**Admin-only endpoint:**

```
User: "Create POST /api/v1/users/invite endpoint for admins to invite users"
Assistant: [Creates route with admin authorization, validation, invitation logic, tests]
```

**Complex filtering:**

```
User: "Add filtering by status and search to GET /api/v1/orders"
Assistant: [Updates route with query params validation, filtering logic, tests]
```
