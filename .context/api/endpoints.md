# API Endpoints

> **Implementation Status:** December 2025
>
> - ✅ **Implemented** - Endpoints currently available (with file references)
> - 📋 **Planned** - Endpoints defined for future development

## API Design Principles

Sunrise implements RESTful APIs through Next.js route handlers with the following principles:

- **Versioning**: All public APIs use `/api/v1/` prefix
- **Resource-Based**: URLs represent resources (nouns), not actions
- **HTTP Methods**: Standard methods (GET, POST, PUT, PATCH, DELETE)
- **Standard Responses**: Consistent `{ success, data, error }` format
- **Authentication**: Session-based using better-auth
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

✅ **Implemented in:** `app/api/health/route.ts`

**Purpose**: System health monitoring for load balancers and monitoring tools

```
GET /api/health
```

**Authentication**: None required

**Response** (200 OK):

```json
{
  "status": "ok",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "version": "1.0.0",
  "uptime": 3600,
  "database": "connected"
}
```

**Response** (503 Service Unavailable - database disconnected):

```json
{
  "status": "error",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "database": "disconnected"
}
```

## User Endpoints

### Get Current User

✅ **Implemented in:** `app/api/v1/users/me/route.ts` (GET handler)

**Purpose**: Retrieve authenticated user's profile

```
GET /api/v1/users/me
```

**Authentication**: Required (session)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "USER",
    "emailVerified": "2025-01-15T10:00:00.000Z",
    "image": "https://...",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-10T12:00:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
  ```json
  {
    "success": false,
    "error": {
      "message": "No active session found",
      "code": "UNAUTHORIZED"
    }
  }
  ```

### Update Current User

✅ **Implemented in:** `app/api/v1/users/me/route.ts` (PATCH handler)

**Purpose**: Update authenticated user's profile

```
PATCH /api/v1/users/me
```

**Authentication**: Required (session)

**Request Body** (all fields optional):

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com"
}
```

**Validation**: Uses `updateUserSchema` from `lib/validations/user.ts`

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "emailVerified": "2025-01-15T10:00:00.000Z",
    "image": "https://...",
    "role": "USER",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-15T14:30:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **400 Validation Error**: Invalid input data
  ```json
  {
    "success": false,
    "error": {
      "message": "Invalid request body",
      "code": "VALIDATION_ERROR",
      "details": {
        "errors": [{ "path": "email", "message": "Invalid email format" }]
      }
    }
  }
  ```
- **400 Email Taken**: Email already in use by another user
  ```json
  {
    "success": false,
    "error": {
      "message": "Email already in use",
      "code": "EMAIL_TAKEN"
    }
  }
  ```

### List Users (Admin)

✅ **Implemented in:** `app/api/v1/users/route.ts` (GET handler)

**Purpose**: List all users with pagination and search (admin only)

```
GET /api/v1/users?page=1&limit=20&search=john&sortBy=createdAt&sortOrder=desc
```

**Authentication**: Required (ADMIN role)

**Query Parameters** (all optional):

- `page`: Page number (default: 1, min: 1)
- `limit`: Items per page (default: 20, max: 100)
- `search`: Search by name or email (case-insensitive)
- `sortBy`: Sort field - `name`, `email`, `createdAt` (default: `createdAt`)
- `sortOrder`: Sort order - `asc`, `desc` (default: `desc`)

**Validation**: Uses `listUsersQuerySchema` from `lib/validations/user.ts`

**Response** (200 OK):

```json
{
  "success": true,
  "data": [
    {
      "id": "clxxxx",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "USER",
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

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
  ```json
  {
    "success": false,
    "error": {
      "message": "Admin access required",
      "code": "FORBIDDEN"
    }
  }
  ```
- **400 Validation Error**: Invalid query parameters

### Create User (Admin)

✅ **Implemented in:** `app/api/v1/users/route.ts` (POST handler)

**Purpose**: Create a new user account (admin only, delegates to better-auth signup API)

```
POST /api/v1/users
```

**Authentication**: Required (ADMIN role)

**Request Body**:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "SecurePassword123!",
  "role": "USER"
}
```

**Validation**: Uses `createUserSchema` from `lib/validations/user.ts`

- `name`: Required, 1-100 characters
- `email`: Required, valid email format
- `password`: Required, minimum 8 characters
- `role`: Optional, one of `USER`, `ADMIN`, `MODERATOR` (default: `USER`)

**Response** (201 Created):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "USER",
    "emailVerified": null,
    "image": null,
    "createdAt": "2025-01-15T14:30:00.000Z",
    "updatedAt": "2025-01-15T14:30:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Invalid request body
- **400 Email Taken**: Email already in use

**Note**: This endpoint delegates to better-auth's signup API (`auth.api.signUpEmail()`) for secure user creation with password hashing.

### Get User by ID

✅ **Implemented in:** `app/api/v1/users/[id]/route.ts` (GET handler)

**Purpose**: Retrieve specific user details

```
GET /api/v1/users/:id
```

**Authentication**: Required (ADMIN role or requesting own profile)

**Authorization**: Users can view their own profile. Admins can view any user profile.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "USER",
    "emailVerified": "2025-01-15T10:00:00.000Z",
    "image": "https://...",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-10T12:00:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User is not ADMIN and not requesting own profile
  ```json
  {
    "success": false,
    "error": {
      "message": "Forbidden",
      "code": "FORBIDDEN"
    }
  }
  ```
- **404 Not Found**: User ID does not exist
  ```json
  {
    "success": false,
    "error": {
      "message": "User not found",
      "code": "NOT_FOUND"
    }
  }
  ```

### Delete User

✅ **Implemented in:** `app/api/v1/users/[id]/route.ts` (DELETE handler)

**Purpose**: Delete a user account (admin only)

```
DELETE /api/v1/users/:id
```

**Authentication**: Required (ADMIN role)

**Authorization**: Admins only. Cannot delete own account.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "deleted": true
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
  ```json
  {
    "success": false,
    "error": {
      "message": "Forbidden",
      "code": "FORBIDDEN"
    }
  }
  ```
- **400 Bad Request**: Attempting to delete own account
  ```json
  {
    "success": false,
    "error": {
      "message": "Cannot delete your own account",
      "code": "SELF_DELETE_FORBIDDEN"
    }
  }
  ```
- **404 Not Found**: User ID does not exist

**Note**: Deletion cascades to related records (sessions, accounts) as configured in Prisma schema.

## Authentication Endpoints

✅ **Implemented in:** `app/api/auth/[...all]/route.ts` (better-auth handler)

**Purpose**: All authentication flows are handled by better-auth

Better-auth provides the following endpoints automatically:

### Sign Up with Email

```
POST /api/auth/sign-up/email
```

**Request Body**:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePassword123!"
}
```

### Sign In with Email

```
POST /api/auth/sign-in/email
```

**Request Body**:

```json
{
  "email": "john@example.com",
  "password": "SecurePassword123!"
}
```

### Sign In with OAuth (Google)

```
GET /api/auth/sign-in/social
```

**Query Parameters**:

- `provider`: `google`
- `callbackURL`: URL to redirect after successful authentication

### Sign Out

```
POST /api/auth/sign-out
```

### Get Session

```
GET /api/auth/session
```

**Response**:

```json
{
  "user": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "USER"
  },
  "session": {
    "token": "...",
    "expiresAt": "..."
  }
}
```

### OAuth Callback

```
GET /api/auth/callback/google
```

Handles OAuth callback from Google after successful authentication.

### Clear Session (Utility)

✅ **Implemented in:** `app/api/auth/clear-session/route.ts`

**Purpose**: Utility endpoint for clearing session cookies

```
GET /api/auth/clear-session
```

**Response**: Redirects to home page with session cookie cleared.

**Note**: Refer to better-auth documentation for complete API reference and configuration options.

## Planned Endpoints

The following endpoints are defined for future implementation:

### Invite User (Admin)

📋 **Planned** - Phase 3.1 (Email System)

**Purpose**: Create user account without password, send invitation email

```
POST /api/v1/users/invite
```

**Authentication**: Required (ADMIN role)

**Request Body**:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "USER"
}
```

**Response** (201 Created):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "USER",
    "invitationToken": "...",
    "invitationSentAt": "2025-01-15T14:30:00.000Z"
  }
}
```

**Flow**:

1. Admin creates user without password
2. Invitation token generated and stored
3. Email sent with invitation link: `/auth/accept-invite?token=...`
4. User clicks link, sets password, account activated

### Accept Invitation

📋 **Planned** - Phase 3.1 (Email System)

**Purpose**: Allow invited user to set password and activate account

```
GET /auth/accept-invite?token=...
```

**Query Parameters**:

- `token`: Invitation token from email

**Flow**:

1. Validate invitation token
2. Display password form
3. Update user record with password
4. Clear invitation token
5. Redirect to login

**Implementation**: Page route in `app/(auth)/accept-invite/page.tsx`

## Common Patterns

📋 **Guidance** - Common implementation patterns for API routes

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
const orderBy = validSortFields.includes(sortBy) ? { [sortBy]: sortOrder } : { createdAt: 'desc' };

const results = await prisma.user.findMany({ orderBy });
```

## Error Codes

| Code                  | HTTP Status | Meaning                             |
| --------------------- | ----------- | ----------------------------------- |
| `UNAUTHORIZED`        | 401         | No valid session                    |
| `FORBIDDEN`           | 403         | Authenticated but lacks permissions |
| `NOT_FOUND`           | 404         | Resource doesn't exist              |
| `VALIDATION_ERROR`    | 400         | Input validation failed             |
| `EMAIL_TAKEN`         | 400         | Email already registered            |
| `RATE_LIMIT_EXCEEDED` | 429         | Too many requests                   |
| `INTERNAL_ERROR`      | 500         | Server error                        |

## Decision History & Trade-offs

📋 **Guidance** - Documentation of API design decisions and architectural trade-offs

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

📋 **Guidance** - Performance optimization patterns for API routes

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
const [users, total] = await Promise.all([prisma.user.findMany(), prisma.user.count()]);

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
