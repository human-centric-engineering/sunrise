# API Client Examples

Patterns for consuming the Sunrise API from client components, server components, and external services.

## Client Components

Use `apiClient` for all API calls from client components. It handles JSON parsing, error handling, and type safety.

### Basic Usage

```typescript
// components/example.tsx
'use client';

import { useState } from 'react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { PublicUser } from '@/types';

export function UserProfile() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchUser() {
    setLoading(true);
    setError(null);

    try {
      const data = await apiClient.get<PublicUser>(API.USERS.ME);
      setUser(data);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  // ...
}
```

### GET with Query Parameters

```typescript
const users = await apiClient.get<PublicUser[]>(API.USERS.LIST, {
  params: { page: 1, limit: 20, q: 'search term' },
});
```

### POST/PATCH Requests

```typescript
// Update profile
const updated = await apiClient.patch<PublicUser>(API.USERS.ME, {
  body: { name: 'New Name', bio: 'Updated bio' },
});

// Create invitation
await apiClient.post(API.USERS.INVITE, {
  body: { email: 'user@example.com', role: 'USER' },
});
```

### DELETE Requests

```typescript
await apiClient.delete(API.USERS.byId(userId));
```

### Error Handling

```typescript
try {
  await apiClient.patch(API.USERS.ME, { body: formData });
} catch (err) {
  if (err instanceof APIClientError) {
    // err.message - Human-readable error message
    // err.code - Error code (e.g., 'VALIDATION_ERROR', 'UNAUTHORIZED')
    // err.status - HTTP status code
    // err.details - Additional error details (e.g., field validation errors)

    if (err.code === 'VALIDATION_ERROR' && err.details) {
      // Handle field-specific errors
      setFieldErrors(err.details);
    } else if (err.status === 401) {
      // Redirect to login
      router.push('/login');
    } else {
      setError(err.message);
    }
  }
}
```

### Real Example: Profile Form

From `components/forms/profile-form.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export function ProfileForm({ user }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit } = useForm({
    defaultValues: { name: user.name, bio: user.bio }
  });

  async function onSubmit(data) {
    setIsLoading(true);
    setError(null);

    try {
      await apiClient.patch(API.USERS.ME, { body: data });
      router.refresh();
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }

  return <form onSubmit={handleSubmit(onSubmit)}>...</form>;
}
```

## Server Components

Use `serverFetch` for API calls from server components. It forwards cookies for authentication.

### Basic Usage

```typescript
// app/(protected)/dashboard/page.tsx
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import type { SystemStats } from '@/types/admin';

export default async function DashboardPage() {
  const res = await serverFetch('/api/v1/admin/stats');
  const { data: stats } = await parseApiResponse<SystemStats>(res);

  return <StatsDisplay stats={stats} />;
}
```

### With Query Parameters

```typescript
const res = await serverFetch('/api/v1/users?limit=20&sortBy=createdAt');
const { data: users } = await parseApiResponse<User[]>(res);
```

### POST from Server

```typescript
const res = await serverFetch('/api/v1/users/invite', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', role: 'USER' }),
});
```

### Server Fetch Helpers

The `serverFetch` module provides helpers for internal API calls:

```typescript
import { serverFetch, parseApiResponse, getCookieHeader, getBaseUrl } from '@/lib/api/server-fetch';
```

**`getCookieHeader()`** - Serializes all cookies from the current request for forwarding:

```typescript
const cookieHeader = await getCookieHeader();
// Returns: "session_token=abc; other=xyz"
```

**`getBaseUrl()`** - Gets the app base URL for constructing absolute URLs:

```typescript
const baseUrl = getBaseUrl();
// Returns: "http://localhost:3000" or production URL
```

### Response Parsing

Use `parseApiResponse()` to validate API responses follow the expected discriminated union format:

```typescript
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';

const res = await serverFetch('/api/v1/users/me');
const { data: user } = await parseApiResponse<User>(res);
```

**What it validates:**

- Response body is an object with boolean `success` field
- When `success: true`, `data` field is present
- When `success: false`, `error` object is present

**Error behavior:**

- Throws `Error` if body is not an object
- Throws `Error` if `success` field is missing or not boolean
- Throws `Error` if `success: true` but `data` is missing
- Throws `Error` if `success: false` but `error` is missing

**When to use:** Always pair with `serverFetch` in server components instead of unsafe `as` casts on JSON responses.

## API Route Implementation

Use auth guards (`withAuth`, `withAdminAuth`) for authenticated routes. They handle session retrieval, authorization, and error handling automatically.

### Basic Authenticated Route

```typescript
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';

export const GET = withAuth(async (_request, session) => {
  // session is guaranteed valid - no need for null checks or try/catch
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, role: true },
  });

  return successResponse(user);
});
```

### Admin-Only Route

```typescript
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';

export const GET = withAdminAuth(async (_request, session) => {
  // session.user.role is guaranteed to be 'ADMIN'
  // Returns 401 if not authenticated, 403 if not admin
  const stats = await getSystemStats();
  return successResponse(stats);
});
```

### Route with Dynamic Params

```typescript
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';

export const GET = withAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = await params;

  const resource = await prisma.resource.findUnique({
    where: { id, userId: session.user.id },
  });

  if (!resource) throw new NotFoundError('Resource not found');

  return successResponse(resource);
});
```

### With Validation

```typescript
import { withAuth } from '@/lib/auth/guards';
import {
  validateRequestBody,
  validateQueryParams,
  parsePaginationParams,
} from '@/lib/api/validation';
import { updateUserSchema } from '@/lib/validations/user';

export const PATCH = withAuth(async (request, session) => {
  // Validate request body with Zod schema
  const body = await validateRequestBody(request, updateUserSchema);

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: body,
  });

  return successResponse(user);
});
```

**Note:** Prefer `parsePaginationParams()` over manual `parseInt` for pagination. It handles defaults, bounds checking, and skip calculation.

### Public Endpoints

Public endpoints don't use guards - use manual try/catch with rate limiting.

```typescript
import { NextRequest } from 'next/server';
import { successResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { contactSchema } from '@/lib/validations/contact';
import {
  contactLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export async function POST(request: NextRequest) {
  try {
    // 1. Check rate limit first
    const clientIP = getClientIP(request);
    const rateLimitResult = contactLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      return createRateLimitResponse(rateLimitResult);
    }

    // 2. Validate request body
    const body = await validateRequestBody(request, contactSchema);

    // 3. Business logic
    await processContactForm(body);

    // 4. Return success with rate limit headers
    return successResponse({ message: 'Message sent successfully' }, undefined, {
      headers: getRateLimitHeaders(rateLimitResult),
    });
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Pagination

```typescript
import { withAuth } from '@/lib/auth/guards';
import { paginatedResponse } from '@/lib/api/responses';
import { parsePaginationParams } from '@/lib/api/validation';

export const GET = withAuth(async (request, _session) => {
  const { searchParams } = request.nextUrl;
  const { page, limit, skip } = parsePaginationParams(searchParams);

  const [users, total] = await Promise.all([
    prisma.user.findMany({ skip, take: limit }),
    prisma.user.count(),
  ]);

  return paginatedResponse(users, { page, limit, total });
});
```

### Error Classes

```typescript
import {
  UnauthorizedError, // 401 - Not authenticated
  ForbiddenError, // 403 - Not authorized
  NotFoundError, // 404 - Resource not found
  ValidationError, // 400 - Invalid input
  ConflictError, // 409 - Resource conflict
} from '@/lib/api/errors';

// Usage
if (!session) throw new UnauthorizedError();
if (session.user.role !== 'ADMIN') throw new ForbiddenError('Admin access required');
if (!user) throw new NotFoundError('User not found');
```

### Response Helpers

**`successResponse(data, meta?, options?)`** - Standard success response:

```typescript
// Simple success
return successResponse({ id: '123', name: 'John' });

// With pagination metadata
return successResponse(users, { page: 1, limit: 20, total: 150, totalPages: 8 });

// With custom status and headers (e.g., rate limit headers)
return successResponse({ message: 'Created' }, undefined, {
  status: 201,
  headers: {
    'X-RateLimit-Remaining': '99',
    Location: '/api/v1/users/123',
  },
});
```

### Query Parameter Validation

Use `validateQueryParams()` for type-safe query parameter validation:

```typescript
import { withAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { z } from 'zod';

const listUsersQuerySchema = z.object({
  role: z.enum(['USER', 'ADMIN']).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['name', 'createdAt']).default('createdAt'),
});

export const GET = withAuth(async (request, _session) => {
  const { searchParams } = request.nextUrl;
  const { role, search, sortBy } = validateQueryParams(searchParams, listUsersQuerySchema);

  const users = await prisma.user.findMany({
    where: {
      ...(role && { role }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    },
    orderBy: { [sortBy]: 'desc' },
  });

  return successResponse(users);
});
```

## API Endpoint Constants

Use `API` constants instead of hardcoding paths:

```typescript
import { API } from '@/lib/api/endpoints';

// Available endpoints
API.AUTH.BASE; // /api/auth
API.AUTH.SIGN_OUT; // /api/auth/sign-out

API.USERS.ME; // /api/v1/users/me
API.USERS.ME_PREFERENCES; // /api/v1/users/me/preferences
API.USERS.ME_AVATAR; // /api/v1/users/me/avatar
API.USERS.LIST; // /api/v1/users
API.USERS.INVITE; // /api/v1/users/invite
API.USERS.byId(id); // /api/v1/users/{id}

API.ADMIN.STATS; // /api/v1/admin/stats
API.ADMIN.LOGS; // /api/v1/admin/logs
API.ADMIN.INVITATIONS; // /api/v1/admin/invitations
API.ADMIN.FEATURE_FLAGS; // /api/v1/admin/feature-flags

API.PUBLIC.HEALTH; // /api/health
API.PUBLIC.CONTACT; // /api/v1/contact
```

## External Consumers (cURL)

```bash
# Health check
curl https://your-domain.com/api/health

# Get current user (with session cookie)
curl -X GET https://your-domain.com/api/v1/users/me \
  -H "Content-Type: application/json" \
  --cookie "better-auth.session_token=YOUR_TOKEN"

# Update profile
curl -X PATCH https://your-domain.com/api/v1/users/me \
  -H "Content-Type: application/json" \
  --cookie "better-auth.session_token=YOUR_TOKEN" \
  -d '{"name": "New Name"}'

# List users (admin)
curl -X GET "https://your-domain.com/api/v1/users?page=1&limit=20" \
  -H "Content-Type: application/json" \
  --cookie "better-auth.session_token=YOUR_TOKEN"
```

## Related Documentation

- [API Endpoints](./endpoints.md) - Complete endpoint reference
- [API Headers](./headers.md) - CORS, security headers
- [Auth Integration](../auth/integration.md) - Authentication patterns
