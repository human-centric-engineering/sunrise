# Admin API Endpoints

Admin-only endpoints for system management, monitoring, and configuration.

All admin endpoints require authentication with the ADMIN role. Unauthorized or non-admin users receive appropriate error responses.

## Get System Statistics

✅ **Implemented in:** `app/api/v1/admin/stats/route.ts`

**Purpose**: Get system statistics for the admin dashboard including user counts and system health

```
GET /api/v1/admin/stats
```

**Authentication**: Required (ADMIN role)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "users": {
      "total": 150,
      "verified": 142,
      "recentSignups": 5,
      "byRole": {
        "USER": 145,
        "ADMIN": 5
      }
    },
    "system": {
      "nodeVersion": "v20.10.0",
      "appVersion": "1.0.0",
      "environment": "production",
      "uptime": 86400,
      "databaseStatus": "connected"
    }
  }
}
```

**Response Fields**:

- `users.total`: Total number of users in the system
- `users.verified`: Users with verified email addresses
- `users.recentSignups`: Users created in the last 24 hours
- `users.byRole`: Breakdown of users by role (USER, ADMIN)
- `system.nodeVersion`: Node.js version running the server
- `system.appVersion`: Application version from package.json
- `system.environment`: Current environment (development/production)
- `system.uptime`: Server uptime in seconds
- `system.databaseStatus`: Database connection status (`connected`, `disconnected`, `error`)

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role

## Get Application Logs

✅ **Implemented in:** `app/api/v1/admin/logs/route.ts`

**Purpose**: Get application logs with filtering and pagination for debugging and monitoring

```
GET /api/v1/admin/logs?level=error&search=database&page=1&limit=50
```

**Authentication**: Required (ADMIN role)

**Query Parameters** (all optional):

| Parameter | Type   | Default | Description                                           |
| --------- | ------ | ------- | ----------------------------------------------------- |
| `level`   | string | -       | Filter by log level: `debug`, `info`, `warn`, `error` |
| `search`  | string | -       | Search in message content (max 200 chars)             |
| `page`    | number | 1       | Page number (1-indexed)                               |
| `limit`   | number | 50      | Items per page (max: 100)                             |

**Validation**: Uses `logsQuerySchema` from `lib/validations/admin.ts`

**Response** (200 OK):

```json
{
  "success": true,
  "data": [
    {
      "id": "log_abc123",
      "timestamp": "2026-01-15T10:30:00.000Z",
      "level": "error",
      "message": "Database connection timeout",
      "context": {
        "requestId": "req_xyz789",
        "userId": "clxxxx"
      },
      "error": {
        "name": "TimeoutError",
        "message": "Connection timed out after 5000ms",
        "code": "ETIMEDOUT"
      }
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 1250,
    "totalPages": 25
  }
}
```

**Log Entry Fields**:

- `id`: Unique identifier for the log entry
- `timestamp`: ISO timestamp when the log was created
- `level`: Log level (`debug`, `info`, `warn`, `error`)
- `message`: Log message text
- `context`: Additional context (requestId, userId, etc.)
- `meta`: Additional metadata
- `error`: Error details if level is `error` (name, message, stack, code)

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Invalid query parameters

## Feature Flags

### List Feature Flags

✅ **Implemented in:** `app/api/v1/admin/feature-flags/route.ts` (GET handler)

**Purpose**: List all feature flags in the system

```
GET /api/v1/admin/feature-flags
```

**Authentication**: Required (ADMIN role)

**Response** (200 OK):

```json
{
  "success": true,
  "data": [
    {
      "id": "clxxxx",
      "name": "ENABLE_BETA_FEATURES",
      "description": "Enable beta features for all users",
      "enabled": true,
      "metadata": {
        "rolloutPercentage": 50
      },
      "createdBy": "clyyyy",
      "createdAt": "2026-01-01T08:00:00.000Z",
      "updatedAt": "2026-01-10T12:00:00.000Z"
    }
  ]
}
```

### Create Feature Flag

✅ **Implemented in:** `app/api/v1/admin/feature-flags/route.ts` (POST handler)

**Purpose**: Create a new feature flag

```
POST /api/v1/admin/feature-flags
```

**Authentication**: Required (ADMIN role)

**Request Body**:

```json
{
  "name": "NEW_DASHBOARD",
  "description": "Enable the new dashboard design",
  "enabled": false,
  "metadata": {
    "releaseDate": "2026-02-01"
  }
}
```

**Validation**: Uses `createFeatureFlagSchema` from `lib/validations/admin.ts`

- `name`: Required, must be SCREAMING_SNAKE_CASE (e.g., `ENABLE_FEATURE`, `NEW_DASHBOARD`)
- `description`: Optional, max 500 characters
- `enabled`: Optional, defaults to `false`
- `metadata`: Optional, JSON object for additional configuration

**Response** (201 Created):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "NEW_DASHBOARD",
    "description": "Enable the new dashboard design",
    "enabled": false,
    "metadata": {
      "releaseDate": "2026-02-01"
    },
    "createdBy": "clyyyy",
    "createdAt": "2026-01-15T14:30:00.000Z",
    "updatedAt": "2026-01-15T14:30:00.000Z"
  }
}
```

**Error Responses**:

- **400 Validation Error**: Name must be SCREAMING_SNAKE_CASE
- **409 Conflict**: Feature flag with same name already exists

### Get Feature Flag by ID

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (GET handler)

```
GET /api/v1/admin/feature-flags/:id
```

**Authentication**: Required (ADMIN role)

**Error Responses**:

- **404 Not Found**: Feature flag not found

### Update Feature Flag

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (PATCH handler)

```
PATCH /api/v1/admin/feature-flags/:id
```

**Authentication**: Required (ADMIN role)

**Request Body** (all fields optional):

```json
{
  "description": "Updated description",
  "enabled": true,
  "metadata": {
    "rolloutPercentage": 100
  }
}
```

**Note**: The `name` field cannot be updated after creation.

### Delete Feature Flag

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (DELETE handler)

```
DELETE /api/v1/admin/feature-flags/:id
```

**Authentication**: Required (ADMIN role)

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

## Invitations Management

### List Pending Invitations

✅ **Implemented in:** `app/api/v1/admin/invitations/route.ts`

**Purpose**: List all pending user invitations with pagination, search, and sorting

```
GET /api/v1/admin/invitations?page=1&limit=20&search=john&sortBy=invitedAt&sortOrder=desc
```

**Authentication**: Required (ADMIN role)

**Query Parameters** (all optional):

| Parameter   | Type   | Default     | Description                                           |
| ----------- | ------ | ----------- | ----------------------------------------------------- |
| `page`      | number | 1           | Page number (1-indexed)                               |
| `limit`     | number | 20          | Items per page (max: 100)                             |
| `search`    | string | -           | Search in name or email (max 200 chars)               |
| `sortBy`    | string | `invitedAt` | Sort field: `name`, `email`, `invitedAt`, `expiresAt` |
| `sortOrder` | string | `desc`      | Sort order: `asc`, `desc`                             |

**Validation**: Uses `listInvitationsQuerySchema` from `lib/validations/admin.ts`

**Response** (200 OK):

```json
{
  "success": true,
  "data": [
    {
      "email": "jane@example.com",
      "name": "Jane Doe",
      "role": "USER",
      "invitedAt": "2026-01-10T14:30:00.000Z",
      "expiresAt": "2026-01-17T14:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

**Invitation Fields**:

- `email`: Invitee's email address
- `name`: Invitee's name
- `role`: Role assigned to the invitation (`USER`, `ADMIN`)
- `invitedAt`: When the invitation was created
- `expiresAt`: When the invitation expires (7 days from creation)

### Cancel Invitation

✅ **Implemented in:** `app/api/v1/admin/invitations/[email]/route.ts`

**Purpose**: Cancel a pending user invitation by email address

```
DELETE /api/v1/admin/invitations/:email
```

**Authentication**: Required (ADMIN role)

**URL Parameter**: `email` - URL-encoded email address of the invitation to cancel

**Example**:

```
DELETE /api/v1/admin/invitations/jane%40example.com
```

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "message": "Invitation for jane@example.com has been deleted"
  }
}
```

**Error Responses**:

- **404 Not Found**: Invitation not found or already expired

**Note**: The email parameter must be URL-encoded when it contains special characters like `@`.

## Common Error Responses

All admin endpoints return these errors for authentication/authorization failures:

**401 Unauthorized** (No valid session):

```json
{
  "success": false,
  "error": {
    "message": "Authentication required",
    "code": "UNAUTHORIZED"
  }
}
```

**403 Forbidden** (Not admin):

```json
{
  "success": false,
  "error": {
    "message": "Admin access required",
    "code": "FORBIDDEN"
  }
}
```

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [User Endpoints](./user-endpoints.md) - User management API
- [Auth Integration](../auth/integration.md) - Admin auth guards (`withAdminAuth`)
