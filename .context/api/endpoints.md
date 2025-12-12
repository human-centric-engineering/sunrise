# API Endpoints

## API Design Principles

Sunrise implements RESTful APIs through Next.js route handlers with the following principles:

- **Versioning**: All public APIs use `/api/v1/` prefix
- **Resource-Based**: URLs represent resources (nouns), not actions
- **HTTP Methods**: Standard methods (GET, POST, PUT, PATCH, DELETE)
- **Standard Responses**: Consistent `{ success, data, error }` format
- **Authentication**: Session-based using NextAuth.js
- **Validation**: Zod schemas for all inputs

## Response Format

### Success Response

```typescript
{
  "success": true,
  "data": { /* response payload */ },
  "meta": { /* optional metadata (pagination, etc.) */ }
}
```

### Error Response

```typescript
{
  "success": false,
  "error": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "details": { /* optional additional context */ }
  }
}
```

## Core Endpoints

### Health Check

**Purpose**: System health monitoring for load balancers and monitoring tools

```
GET /api/health
```

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "version": "1.0.0",
  "uptime": 3600,
  "database": "connected"
}
```

**Implementation**:
```typescript
// app/api/health/route.ts
import { prisma } from '@/lib/db/client';

export async function GET() {
  try {
    // Check database connectivity
    await prisma.$queryRaw`SELECT 1`;

    return Response.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      database: 'connected',
    });
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
      },
      { status: 503 }
    );
  }
}
```

## User Endpoints

### Get Current User

**Purpose**: Retrieve authenticated user's profile

```
GET /api/v1/users/me
```

**Authentication**: Required

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "user",
    "emailVerified": "2025-01-15T10:00:00.000Z",
    "createdAt": "2025-01-01T08:00:00.000Z"
  }
}
```

**Implementation**:
```typescript
// app/api/v1/users/me/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return Response.json(
      { success: false, error: { message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      image: true,
      createdAt: true,
      // Exclude password
    },
  });

  return Response.json({ success: true, data: user });
}
```

### Update Current User

**Purpose**: Update authenticated user's profile

```
PATCH /api/v1/users/me
```

**Authentication**: Required

**Request Body**:
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "user"
  }
}
```

**Implementation**:
```typescript
// app/api/v1/users/me/route.ts
import { updateUserSchema } from '@/lib/validations/user';

export async function PATCH(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return Response.json(
      { success: false, error: { message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const validatedData = updateUserSchema.parse(body);

    // Check if email is already taken
    if (validatedData.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: validatedData.email },
      });

      if (existingUser && existingUser.id !== session.user.id) {
        return Response.json(
          {
            success: false,
            error: {
              message: 'Email already in use',
              code: 'EMAIL_TAKEN',
            },
          },
          { status: 400 }
        );
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: validatedData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    return Response.json({ success: true, data: updatedUser });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          success: false,
          error: {
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: error.errors,
          },
        },
        { status: 400 }
      );
    }

    return Response.json(
      { success: false, error: { message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### List Users (Admin)

**Purpose**: List all users (admin only)

```
GET /api/v1/users?page=1&limit=20&search=john
```

**Authentication**: Required (Admin role)

**Query Parameters**:
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)
- `search` (optional): Search by name or email

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "clxxxx",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "user",
      "createdAt": "2025-01-01T08:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**Implementation**:
```typescript
// app/api/v1/users/route.ts
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return Response.json(
      { success: false, error: { message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  if (session.user.role !== 'admin') {
    return Response.json(
      { success: false, error: { message: 'Forbidden' } },
      { status: 403 }
    );
  }

  const { searchParams } = request.nextUrl;
  const page = parseInt(searchParams.get('page') || '1');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
  const search = searchParams.get('search') || '';

  const skip = (page - 1) * limit;

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return Response.json({
    success: true,
    data: users,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}
```

### Get User by ID (Admin)

**Purpose**: Retrieve specific user details

```
GET /api/v1/users/:id
```

**Authentication**: Required (Admin role or own profile)

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "user",
    "emailVerified": "2025-01-15T10:00:00.000Z",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-10T12:00:00.000Z"
  }
}
```

**Implementation**:
```typescript
// app/api/v1/users/[id]/route.ts
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return Response.json(
      { success: false, error: { message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  // Allow users to view their own profile, admins can view any
  if (session.user.id !== params.id && session.user.role !== 'admin') {
    return Response.json(
      { success: false, error: { message: 'Forbidden' } },
      { status: 403 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      image: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    return Response.json(
      {
        success: false,
        error: { message: 'User not found', code: 'NOT_FOUND' },
      },
      { status: 404 }
    );
  }

  return Response.json({ success: true, data: user });
}
```

### Delete User (Admin)

**Purpose**: Delete a user account

```
DELETE /api/v1/users/:id
```

**Authentication**: Required (Admin role)

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "deleted": true
  }
}
```

**Implementation**:
```typescript
// app/api/v1/users/[id]/route.ts
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  if (!session || session.user.role !== 'admin') {
    return Response.json(
      { success: false, error: { message: 'Forbidden' } },
      { status: 403 }
    );
  }

  // Prevent self-deletion
  if (session.user.id === params.id) {
    return Response.json(
      {
        success: false,
        error: { message: 'Cannot delete your own account' },
      },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: params.id },
  });

  if (!user) {
    return Response.json(
      { success: false, error: { message: 'User not found' } },
      { status: 404 }
    );
  }

  await prisma.user.delete({
    where: { id: params.id },
  });

  return Response.json({
    success: true,
    data: { id: params.id, deleted: true },
  });
}
```

## Common Patterns

### Pagination

```typescript
// Standard pagination pattern
const page = parseInt(searchParams.get('page') || '1');
const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
const skip = (page - 1) * limit;

const [items, total] = await Promise.all([
  prisma.model.findMany({ skip, take: limit }),
  prisma.model.count(),
]);

return Response.json({
  success: true,
  data: items,
  meta: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  },
});
```

### Search/Filtering

```typescript
// Case-insensitive search across multiple fields
const search = searchParams.get('search') || '';

const where = search
  ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }
  : {};

const results = await prisma.user.findMany({ where });
```

### Sorting

```typescript
// Dynamic sorting
const sortBy = searchParams.get('sortBy') || 'createdAt';
const sortOrder = searchParams.get('sortOrder') || 'desc';

const validSortFields = ['name', 'email', 'createdAt'];
const orderBy = validSortFields.includes(sortBy)
  ? { [sortBy]: sortOrder }
  : { createdAt: 'desc' };

const results = await prisma.user.findMany({ orderBy });
```

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `UNAUTHORIZED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Authenticated but lacks permissions |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `VALIDATION_ERROR` | 400 | Input validation failed |
| `EMAIL_TAKEN` | 400 | Email already registered |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

## Decision History & Trade-offs

### Versioned API Path
**Decision**: `/api/v1/` prefix for all public APIs
**Rationale**:
- Allows breaking changes in v2 without affecting v1 clients
- Clear separation from internal APIs (`/api/auth/`, `/api/health/`)
- Industry standard practice

**Trade-offs**: Slightly longer URLs

### Standard Response Format
**Decision**: `{ success, data, error }` over varying formats
**Rationale**:
- Client code can always check `success` field
- TypeScript type safety for responses
- Easy to add metadata without breaking changes

**Trade-offs**: Slightly verbose for simple responses

### Pagination Defaults
**Decision**: Default 20 items, max 100 per page
**Rationale**:
- 20 items: Good balance of data transfer and UX
- Max 100: Prevents excessive database load
- Standard across industry

**Trade-offs**: Some use cases may need larger limits (use cursor pagination instead)

## Performance Considerations

### Database Query Optimization

```typescript
// Good: Select only needed fields
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },
});

// Bad: Fetch entire user object including password hash
const user = await prisma.user.findUnique({ where: { id } });
```

### Parallel Queries

```typescript
// Good: Parallel execution
const [users, total] = await Promise.all([
  prisma.user.findMany(),
  prisma.user.count(),
]);

// Bad: Sequential execution
const users = await prisma.user.findMany();
const total = await prisma.user.count(); // Waits for first query
```

### Response Caching

```typescript
// Add cache headers for static data
export async function GET(request: NextRequest) {
  const data = await fetchStaticData();

  return Response.json(
    { success: true, data },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate',
      },
    }
  );
}
```

## Related Documentation

- [API Headers](./headers.md) - HTTP headers, CORS, and middleware
- [API Examples](./examples.md) - Client implementation examples
- [Auth Integration](../auth/integration.md) - Authentication patterns
- [Database Models](../database/models.md) - Prisma schema and queries
