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

## API Route Implementation

### Standard Pattern

From `app/api/v1/users/me/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError, handleAPIError } from '@/lib/api/errors';

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session) throw new UnauthorizedError();

    // 2. Business logic
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) throw new UnauthorizedError('User not found');

    // 3. Return response
    return successResponse(user);
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### With Validation

```typescript
import { validateRequestBody, parsePaginationParams } from '@/lib/api/validation';
import { updateUserSchema } from '@/lib/validations/user';

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();

    // Validate request body with Zod schema
    const body = await validateRequestBody(request, updateUserSchema);

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: body,
    });

    return successResponse(user);
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Pagination

```typescript
import { paginatedResponse } from '@/lib/api/responses';
import { parsePaginationParams } from '@/lib/api/validation';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePaginationParams(searchParams);

    const [users, total] = await Promise.all([
      prisma.user.findMany({ skip, take: limit }),
      prisma.user.count(),
    ]);

    return paginatedResponse(users, { page, limit, total });
  } catch (error) {
    return handleAPIError(error);
  }
}
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
