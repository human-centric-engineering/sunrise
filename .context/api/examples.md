# API Client Examples

> **Implementation Status:** December 2025
>
> - ✅ **Implemented** - Patterns from actual codebase (with file references)
> - 📋 **Guidance** - Best practice examples for future development

## Client Implementation Patterns

This document provides practical examples of consuming the Sunrise API from various clients: browser JavaScript, React components, external services, and command-line tools.

**Purpose:** This serves as both a reference for implemented patterns and a guide for future API development.

## Browser Fetch API

📋 **Guidance** - Client-side patterns for consuming the API

### Basic GET Request

```typescript
// Fetch current user profile
async function getCurrentUser() {
  try {
    const response = await fetch('/api/v1/users/me', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Include cookies for session auth
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error.message);
    }

    return result.data;
  } catch (error) {
    console.error('Failed to fetch user:', error);
    throw error;
  }
}

// Usage
const user = await getCurrentUser();
console.log(user.name, user.email);
```

### POST Request with Body

```typescript
// Update user profile
async function updateUserProfile(updates: { name?: string; email?: string }) {
  try {
    const response = await fetch('/api/v1/users/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(updates),
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error.message);
    }

    return result.data;
  } catch (error) {
    console.error('Failed to update profile:', error);
    throw error;
  }
}

// Usage
await updateUserProfile({ name: 'Jane Doe' });
```

### Handling Rate Limits

```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitSeconds = retryAfter ? parseInt(retryAfter) : 60;

      console.log(`Rate limited. Retrying in ${waitSeconds}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    return response;
  }

  throw new Error('Max retries exceeded');
}

// Usage
const response = await fetchWithRetry('/api/v1/users', {
  method: 'GET',
  credentials: 'include',
});
```

## React Components

📋 **Guidance** - React patterns for API consumption

### Custom Hook for API Calls

```typescript
// hooks/useAPI.ts
import { useState, useEffect } from 'react';

interface APIState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAPI<T>(url: string) {
  const [state, setState] = useState<APIState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const response = await fetch(url, {
          credentials: 'include',
        });

        if (cancelled) return;

        const result = await response.json();

        if (!result.success) {
          setState({ data: null, loading: false, error: result.error.message });
          return;
        }

        setState({ data: result.data, loading: false, error: null });
      } catch (error) {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : 'An error occurred',
        });
      }
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

// Usage in component
function UserProfile() {
  const { data: user, loading, error } = useAPI<User>('/api/v1/users/me');

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!user) return <div>No user found</div>;

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  );
}
```

### Mutation Hook with Optimistic Updates

```typescript
// hooks/useMutation.ts
import { useState } from 'react';

export function useMutation<TData, TVariables>(
  url: string,
  options?: {
    method?: string;
    onSuccess?: (data: TData) => void;
    onError?: (error: string) => void;
  }
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = async (variables: TVariables) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(url, {
        method: options?.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(variables),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error.message);
      }

      options?.onSuccess?.(result.data);
      return result.data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      options?.onError?.(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { mutate, loading, error };
}

// Usage in component
function EditProfileForm() {
  const { mutate, loading, error } = useMutation('/api/v1/users/me', {
    method: 'PATCH',
    onSuccess: () => {
      alert('Profile updated!');
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);

    await mutate({
      name: formData.get('name'),
      email: formData.get('email'),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" placeholder="Name" />
      <input name="email" type="email" placeholder="Email" />
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save'}
      </button>
    </form>
  );
}
```

### Paginated List Component

```typescript
// components/UsersList.tsx
import { useState, useEffect } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
}

export function UsersList() {
  const [users, setUsers] = useState<User[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsers() {
      setLoading(true);

      const response = await fetch(`/api/v1/users?page=${page}&limit=20`, {
        credentials: 'include',
      });

      const result = await response.json();

      if (result.success) {
        setUsers(result.data);
        setTotalPages(result.meta.totalPages);
      }

      setLoading(false);
    }

    fetchUsers();
  }, [page]);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <ul>
        {users.map(user => (
          <li key={user.id}>
            {user.name} ({user.email})
          </li>
        ))}
      </ul>

      <div className="pagination">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
        >
          Previous
        </button>

        <span>
          Page {page} of {totalPages}
        </span>

        <button
          onClick={() => setPage(p => p + 1)}
          disabled={page === totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

## Server-Side API Implementation Patterns

✅ **Implemented** - Patterns from actual route handlers

These patterns are used in the implemented API routes and should be followed for consistency.

### Error Handling Pattern

✅ **From:** `app/api/v1/users/me/route.ts`

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

    // 2. Business logic with Prisma
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) throw new UnauthorizedError('User not found');

    // 3. Return standardized response
    return successResponse(user);
  } catch (error) {
    // 4. Centralized error handling
    return handleAPIError(error);
  }
}
```

### Authentication & Authorization Pattern

✅ **From:** `app/api/v1/users/route.ts`

```typescript
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { UnauthorizedError, ForbiddenError } from '@/lib/api/errors';

export async function GET(request: NextRequest) {
  try {
    // Authentication check
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    // Authorization check (role-based)
    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // ... route logic
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Request Validation Pattern

✅ **From:** `app/api/v1/users/route.ts` and `app/api/v1/users/me/route.ts`

```typescript
import {
  validateRequestBody,
  validateQueryParams,
  parsePaginationParams,
} from '@/lib/api/validation';
import { createUserSchema, listUsersQuerySchema } from '@/lib/validations/user';

// Validate request body (POST/PATCH)
export async function POST(request: NextRequest) {
  try {
    const body = await validateRequestBody(request, createUserSchema);
    // body is now typed and validated

    // ... use validated data
  } catch (error) {
    return handleAPIError(error); // Automatically returns 400 with field errors
  }
}

// Validate query parameters (GET)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = validateQueryParams(searchParams, listUsersQuerySchema);
    const { page, limit, skip } = parsePaginationParams(searchParams);

    // query, page, limit, skip are now validated
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Pagination Pattern

✅ **From:** `app/api/v1/users/route.ts` (lines 78-97)

```typescript
import { paginatedResponse } from '@/lib/api/responses';
import { parsePaginationParams } from '@/lib/api/validation';

export async function GET(request: NextRequest) {
  try {
    // 1. Parse and validate pagination params
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePaginationParams(searchParams);

    // 2. Build where clause (example with search)
    const query = validateQueryParams(searchParams, listUsersQuerySchema);
    const where = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    // 3. Execute queries in parallel for performance
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { [query.sortBy]: query.sortOrder },
      }),
      prisma.user.count({ where }),
    ]);

    // 4. Return paginated response
    return paginatedResponse(users, { page, limit, total });
  } catch (error) {
    return handleAPIError(error);
  }
}
```

### Custom Error Classes Pattern

✅ **From:** `lib/api/errors.ts`

```typescript
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/api/errors';

// Use custom error classes for better error handling
if (!session) throw new UnauthorizedError();
if (session.user.role !== 'ADMIN') throw new ForbiddenError('Admin access required');
if (!user) throw new NotFoundError('User not found');

// handleAPIError() will automatically:
// - Convert to proper HTTP status codes (401, 403, 404)
// - Return standardized error response format
// - Include error codes for client-side handling
```

### Response Utilities Pattern

✅ **From:** `lib/api/responses.ts`

```typescript
import { successResponse, errorResponse, paginatedResponse } from '@/lib/api/responses';

// Success response
return successResponse(userData);
// { success: true, data: userData }

// Success with custom status
return successResponse(newUser, undefined, { status: 201 });

// Paginated response
return paginatedResponse(users, { page, limit, total });
// { success: true, data: users, meta: { page, limit, total, totalPages } }

// Error response (rarely used - prefer custom error classes)
return errorResponse('Something went wrong', { code: 'CUSTOM_ERROR', status: 500 });
```

## Server-Side API Consumption

✅ **Implemented in:** `lib/api/server-fetch.ts`

When server components need to call internal API routes (e.g., fetching data for SSR), use the `serverFetch` utility which handles cookie forwarding automatically.

### serverFetch Utility

```typescript
// lib/api/server-fetch.ts
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Fetch an internal API route from a server component with cookie forwarding.
 * - Automatically forwards the current request's cookies (for auth)
 * - Constructs absolute URL from relative path
 * - Disables caching by default
 */
export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookieHeader = await getCookieHeader();
  const baseUrl = getBaseUrl();

  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookieHeader,
      ...init?.headers,
    },
    cache: init?.cache ?? 'no-store',
  });
}
```

### Usage in Server Components

```typescript
// app/(protected)/admin/page.tsx
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import type { SystemStats } from '@/types/admin';

export default async function AdminDashboard() {
  const res = await serverFetch('/api/v1/admin/stats');
  const { data: stats } = await parseApiResponse<SystemStats>(res);

  return <StatsDisplay stats={stats} />;
}
```

### With Query Parameters

```typescript
// Fetch paginated list
const res = await serverFetch('/api/v1/users?limit=20&sortBy=createdAt');

// With search
const res = await serverFetch(`/api/v1/users?q=${encodeURIComponent(searchTerm)}`);
```

### POST Request from Server

```typescript
// Server action calling internal API
const res = await serverFetch('/api/v1/users/invite', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', role: 'USER' }),
});
```

### parseApiResponse Helper

```typescript
// lib/api/parse-response.ts
export async function parseApiResponse<T>(response: Response): Promise<APIResponse<T>> {
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error?.message || 'API request failed');
  }
  return json;
}
```

**Key Benefits:**

- Cookie forwarding for authentication (session cookies are passed to API routes)
- Absolute URL construction (works in any server context)
- Consistent error handling with parseApiResponse
- No caching by default (fresh data for SSR)

## Type-Safe API Client

📋 **Guidance** - Client-side TypeScript patterns for consuming the API

### API Client Class

```typescript
// lib/api-client.ts
type APIResponse<T> =
  | {
      success: true;
      data: T;
      meta?: Record<string, any>;
    }
  | {
      success: false;
      error: {
        message: string;
        code?: string;
        details?: any;
      };
    };

export class APIClient {
  private baseURL: string;

  constructor(baseURL = '') {
    this.baseURL = baseURL;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      credentials: 'include',
    });

    const result: APIResponse<T> = await response.json();

    if (!result.success) {
      throw new Error(result.error.message);
    }

    return result.data;
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, data: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async patch<T>(endpoint: string, data: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

// Create singleton instance
export const api = new APIClient('/api/v1');

// Usage
const user = await api.get<User>('/users/me');
await api.patch('/users/me', { name: 'New Name' });
```

### Type-Safe Endpoints

```typescript
// lib/api/endpoints.ts
import { api } from './api-client';

export const userAPI = {
  getCurrentUser: () => api.get<User>('/users/me'),

  updateCurrentUser: (data: UpdateUserInput) => api.patch<User>('/users/me', data),

  listUsers: (params: { page?: number; limit?: number; search?: string }) => {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );

    return api.get<{ data: User[]; meta: PaginationMeta }>(`/users?${query}`);
  },

  getUserById: (id: string) => api.get<User>(`/users/${id}`),

  deleteUser: (id: string) => api.delete<{ deleted: boolean }>(`/users/${id}`),
};

// Usage with full type safety
const user = await userAPI.getCurrentUser(); // Type: User
await userAPI.updateCurrentUser({ name: 'Jane' });
```

## External API Consumption

📋 **Guidance** - Patterns for external services consuming Sunrise API

### Node.js / Server-Side

```typescript
// External service calling Sunrise API
import fetch from 'node-fetch';

class SunriseClient {
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async request(endpoint: string, options?: RequestInit) {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`, // If API keys implemented
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getUsers(params?: { page?: number; limit?: number }) {
    const query = params ? `?${new URLSearchParams(params as Record<string, string>)}` : '';

    return this.request(`/api/v1/users${query}`);
  }
}

// Usage
const client = new SunriseClient(process.env.API_KEY!, 'https://api.sunrise.com');

const users = await client.getUsers({ page: 1, limit: 50 });
```

### cURL Examples

```bash
# Get current user
curl -X GET https://api.sunrise.com/api/v1/users/me \
  -H "Content-Type: application/json" \
  --cookie "session-token=your-session-token"

# Update user profile
curl -X PATCH https://api.sunrise.com/api/v1/users/me \
  -H "Content-Type: application/json" \
  --cookie "session-token=your-session-token" \
  -d '{"name": "Jane Doe", "email": "jane@example.com"}'

# List users with pagination
curl -X GET "https://api.sunrise.com/api/v1/users?page=1&limit=20" \
  -H "Content-Type: application/json" \
  --cookie "session-token=your-session-token"

# Delete user (admin only)
curl -X DELETE https://api.sunrise.com/api/v1/users/clxxxx \
  -H "Content-Type: application/json" \
  --cookie "session-token=your-session-token"
```

## Error Handling Patterns

📋 **Guidance** - Client-side error handling patterns

### Centralized Error Handler

```typescript
// lib/api/error-handler.ts
export class APIError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export async function handleAPIResponse<T>(response: Response): Promise<T> {
  const result = await response.json();

  if (!result.success) {
    throw new APIError(result.error.message, result.error.code, response.status);
  }

  return result.data;
}

// Usage
try {
  const user = await handleAPIResponse<User>(
    await fetch('/api/v1/users/me', { credentials: 'include' })
  );
} catch (error) {
  if (error instanceof APIError) {
    if (error.status === 401) {
      // Redirect to login
      window.location.href = '/login';
    } else {
      console.error(`API Error [${error.code}]:`, error.message);
    }
  }
}
```

### React Error Boundary

```typescript
// components/APIErrorBoundary.tsx
import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class APIErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('API Error:', error, errorInfo);
    // Log to error tracking service
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-container">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Usage
<APIErrorBoundary>
  <UserProfile />
</APIErrorBoundary>
```

## Decision History & Trade-offs

📋 **Guidance** - Documentation of design choices and architectural trade-offs

### Client-Side vs. Server Components

**Decision**: Provide both fetch examples and React hooks
**Rationale**:

- Server components: Direct API calls in component (simpler)
- Client components: Need hooks for state management
- Both patterns valid depending on use case

### Custom Hooks vs. Libraries (React Query, SWR)

**Decision**: Show custom hooks as foundation
**Rationale**:

- No additional dependencies
- Educational value
- Easy to upgrade to library later
- Team can choose preferred library

**Trade-offs**: Custom hooks lack advanced features (caching, deduplication, optimistic updates)

### API Client Class vs. Plain Fetch

**Decision**: Provide both patterns
**Rationale**:

- Plain fetch: Simple, no abstraction
- Client class: DRY, type safety, error handling
- Different complexity needs

## Performance Considerations

📋 **Guidance** - Optimization patterns for client-side API consumption

### Request Deduplication

```typescript
// Prevent duplicate simultaneous requests
const requestCache = new Map<string, Promise<any>>();

export async function fetchWithDedup<T>(url: string): Promise<T> {
  if (requestCache.has(url)) {
    return requestCache.get(url)!;
  }

  const promise = fetch(url, { credentials: 'include' })
    .then((r) => r.json())
    .finally(() => requestCache.delete(url));

  requestCache.set(url, promise);
  return promise;
}
```

### Response Caching

```typescript
// Simple in-memory cache
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchWithCache<T>(url: string): Promise<T> {
  const cached = cache.get(url);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const response = await fetch(url, { credentials: 'include' });
  const result = await response.json();
  const data = result.data;

  cache.set(url, { data, timestamp: Date.now() });
  return data;
}
```

## Related Documentation

- [API Endpoints](./endpoints.md) - API route reference
- [API Headers](./headers.md) - HTTP headers and CORS
- [Auth Integration](../auth/integration.md) - Authentication with API
- [Architecture Patterns](../architecture/patterns.md) - Error handling patterns
