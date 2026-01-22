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
    "bio": "Software developer with passion for building great products",
    "phone": "+1 (555) 123-4567",
    "timezone": "America/New_York",
    "location": "New York, NY",
    "preferences": {
      "email": {
        "marketing": false,
        "productUpdates": true,
        "securityAlerts": true
      }
    },
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
  "email": "jane@example.com",
  "bio": "Software developer",
  "phone": "+1 (555) 123-4567",
  "timezone": "America/New_York",
  "location": "New York, NY"
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

### Delete Current User (Self-Deletion)

✅ **Implemented in:** `app/api/v1/users/me/route.ts` (DELETE handler)

**Purpose**: Allow user to delete their own account (Phase 3.2)

```
DELETE /api/v1/users/me
```

**Authentication**: Required (session)

**Request Body**:

```json
{
  "confirmation": "DELETE"
}
```

**Validation**: Uses `deleteAccountSchema` from `lib/validations/user.ts`

- User must type exactly "DELETE" to confirm

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "deleted": true,
    "message": "Account deleted successfully"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **400 Validation Error**: Missing or incorrect confirmation
  ```json
  {
    "success": false,
    "error": {
      "message": "Invalid request body",
      "code": "VALIDATION_ERROR",
      "details": {
        "errors": [
          { "path": "confirmation", "message": "Please type DELETE to confirm account deletion" }
        ]
      }
    }
  }
  ```

**Note**: Deletion cascades to sessions and accounts. Session cookie is cleared automatically.

### Get User Preferences

✅ **Implemented in:** `app/api/v1/users/me/preferences/route.ts` (GET handler)

**Purpose**: Get current user's email notification preferences (Phase 3.2)

```
GET /api/v1/users/me/preferences
```

**Authentication**: Required (session)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "email": {
      "marketing": false,
      "productUpdates": true,
      "securityAlerts": true
    }
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session

### Update User Preferences

✅ **Implemented in:** `app/api/v1/users/me/preferences/route.ts` (PATCH handler)

**Purpose**: Update current user's email notification preferences (Phase 3.2)

```
PATCH /api/v1/users/me/preferences
```

**Authentication**: Required (session)

**Request Body** (all fields optional):

```json
{
  "email": {
    "marketing": true,
    "productUpdates": false
  }
}
```

**Validation**: Uses `updatePreferencesSchema` from `lib/validations/user.ts`

- `marketing`: Boolean (opt-in for marketing emails)
- `productUpdates`: Boolean (receive product update emails)
- `securityAlerts`: Always `true` (cannot be disabled)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "email": {
      "marketing": true,
      "productUpdates": false,
      "securityAlerts": true
    }
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **400 Validation Error**: Invalid preference values

**Note**: `securityAlerts` is always `true` and cannot be disabled for security reasons.

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

### Create User (Self-Signup)

✅ **Implemented by:** better-auth (`/api/auth/sign-up/email`)

**Purpose**: User self-registration (public endpoint)

```
POST /api/auth/sign-up/email
```

**Authentication**: None (public endpoint)

**Request Body**:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):

```json
{
  "user": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "USER"
  },
  "session": {
    "token": "...",
    "expiresAt": "..."
  }
}
```

**Email Verification**:

- **Development**: Disabled by default (immediate login)
- **Production**: Enabled by default (must verify email first)
- **Override**: Set `REQUIRE_EMAIL_VERIFICATION=true/false`

**Error Responses**:

- **400 Validation Error**: Invalid request body
- **400 Email Taken**: Email already registered

**Note**: For admin-created accounts, use the invitation-based flow instead. See [User Creation Patterns](../auth/user-creation.md) for details.

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

## Invitation Endpoints

### Invite User (Admin)

✅ **Implemented in:** `app/api/v1/users/invite/route.ts`

**Purpose**: Invite new user via email (admin only)

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

**Validation**: Uses `inviteUserSchema` from `lib/validations/user.ts`

- `name`: Required, 1-100 characters
- `email`: Required, valid email format
- `role`: Optional, one of `USER`, `ADMIN` (default: `USER`)

**Response** (201 Created):

```json
{
  "success": true,
  "data": {
    "message": "Invitation sent successfully",
    "invitation": {
      "email": "jane@example.com",
      "name": "Jane Doe",
      "role": "USER",
      "invitedAt": "2026-01-07T14:30:00.000Z",
      "expiresAt": "2026-01-14T14:30:00.000Z",
      "link": "http://localhost:3000/accept-invite?token=...&email=jane@example.com"
    }
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Invalid request body
- **409 Conflict**: User already exists with this email

**Flow**:

1. Check if user already exists (409 if exists)
2. Check if invitation already sent (return existing if valid)
3. Generate secure token (SHA-256 hashed)
4. Store invitation in `Verification` table with metadata
5. Send invitation email
6. Return invitation details

**Note**: User is NOT created until invitation is accepted. See [User Creation Patterns](../auth/user-creation.md) for complete flow.

### Get Invitation Metadata

✅ **Implemented in:** `app/api/v1/invitations/metadata/route.ts`

**Purpose**: Get invitation metadata for acceptance form (public with token validation)

```
GET /api/v1/invitations/metadata?token={token}&email={email}
```

**Authentication**: None (validated via token)

**Query Parameters**:

- `token`: Invitation token (required)
- `email`: Email address (required)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "name": "Jane Doe",
    "role": "USER"
  }
}
```

**Error Responses**:

- **400 Validation Error**: Invalid or expired token
- **404 Not Found**: Invitation not found

**Usage**: Pre-fill user details in acceptance form before user sets password

### Accept Invitation

✅ **Implemented in:** `app/api/auth/accept-invite/route.ts`

**Purpose**: Accept invitation and set password (public with token validation)

```
POST /api/auth/accept-invite
```

**Authentication**: None (validated via token)

**Request Body**:

```json
{
  "token": "abc123...",
  "email": "jane@example.com",
  "password": "SecurePassword123!",
  "confirmPassword": "SecurePassword123!"
}
```

**Validation**: Uses `acceptInvitationSchema` from `lib/validations/user.ts`

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "message": "Invitation accepted successfully. You can now log in."
  }
}
```

**Error Responses**:

- **400 Validation Error**: Invalid token, passwords don't match, etc.
- **404 Not Found**: Invitation not found
- **500 Internal Error**: User creation failed

**Flow**:

1. Validate token and email
2. Get invitation metadata (name, role)
3. Create user via better-auth signup (stable User ID)
4. Update role if non-default
5. Mark email as verified
6. Delete invitation token
7. Send welcome email (non-blocking)
8. Return success (user must log in)

**Security**: Token hashed (SHA-256), single-use, expires in 7 days

**Implementation**: Page route at `app/(auth)/accept-invite/page.tsx`

## Contact Form Endpoints

### Submit Contact Form

✅ **Implemented in:** `app/api/v1/contact/route.ts`

**Purpose**: Submit a contact form message (public endpoint)

```
POST /api/v1/contact
```

**Authentication**: None (public endpoint)

**Rate Limit**: 5 requests per hour per IP

**Request Body**:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "subject": "Question about Sunrise",
  "message": "I'd like to learn more about your product...",
  "website": ""
}
```

**Validation**: Uses `contactWithHoneypotSchema` from `lib/validations/contact.ts`

- `name`: Required, max 100 characters
- `email`: Required, valid email format
- `subject`: Required, max 200 characters
- `message`: Required, min 10 characters, max 5000 characters
- `website`: Honeypot field - must be empty (hidden from real users)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "message": "Thank you for your message. We will get back to you soon."
  }
}
```

**Response Headers**:

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1704067200
```

**Error Responses**:

- **400 Validation Error**: Invalid request body
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
- **429 Rate Limit Exceeded**: Too many requests
  ```json
  {
    "success": false,
    "error": {
      "message": "Rate limit exceeded. Please try again later.",
      "code": "RATE_LIMIT_EXCEEDED"
    }
  }
  ```

**Flow**:

1. Check rate limit (5/hour per IP)
2. Validate request body (including honeypot check)
3. Store submission in `ContactSubmission` database table
4. Send email notification to `CONTACT_EMAIL` or `EMAIL_FROM` (non-blocking)
5. Return success response

**Spam Prevention**:

- **Honeypot field**: The `website` field is hidden via CSS. Bots that auto-fill all fields will trigger this. When triggered, the API returns a success response (to not tip off the bot) but doesn't process the submission.
- **Rate limiting**: 5 submissions per hour per IP address prevents abuse.

**Email Notification**:

- Sent to `CONTACT_EMAIL` environment variable (falls back to `EMAIL_FROM`)
- If neither is configured, no email is sent (submission is still stored)
- Uses `ContactNotificationEmail` template from `emails/contact-notification.tsx`
- Includes sender's email in `Reply-To` header for easy response

**Note**: Submissions are always stored in the database regardless of email configuration.

## Admin Endpoints

All admin endpoints require authentication with the ADMIN role. Unauthorized or non-admin users receive appropriate error responses.

### Get System Statistics

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
  ```json
  {
    "success": false,
    "error": {
      "message": "Authentication required",
      "code": "UNAUTHORIZED"
    }
  }
  ```
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

### Get Application Logs

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
    },
    {
      "id": "log_def456",
      "timestamp": "2026-01-15T10:29:00.000Z",
      "level": "info",
      "message": "User logged in",
      "context": {
        "requestId": "req_abc123",
        "userId": "clxxxx"
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
    },
    {
      "id": "clzzzz",
      "name": "MAINTENANCE_MODE",
      "description": "Put the application in maintenance mode",
      "enabled": false,
      "metadata": null,
      "createdBy": "clyyyy",
      "createdAt": "2026-01-02T10:00:00.000Z",
      "updatedAt": "2026-01-02T10:00:00.000Z"
    }
  ]
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role

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

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Invalid request body
  ```json
  {
    "success": false,
    "error": {
      "message": "Invalid request body",
      "code": "VALIDATION_ERROR",
      "details": {
        "errors": [
          {
            "path": "name",
            "message": "Name must be in SCREAMING_SNAKE_CASE (e.g., ENABLE_FEATURE, NEW_DASHBOARD)"
          }
        ]
      }
    }
  }
  ```
- **409 Conflict**: Feature flag with same name already exists
  ```json
  {
    "success": false,
    "error": {
      "message": "Feature flag 'NEW_DASHBOARD' already exists",
      "code": "CONFLICT"
    }
  }
  ```

### Get Feature Flag by ID

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (GET handler)

**Purpose**: Get a specific feature flag by its ID

```
GET /api/v1/admin/feature-flags/:id
```

**Authentication**: Required (ADMIN role)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
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
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **404 Not Found**: Feature flag not found
  ```json
  {
    "success": false,
    "error": {
      "message": "Feature flag not found",
      "code": "NOT_FOUND"
    }
  }
  ```

### Update Feature Flag

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (PATCH handler)

**Purpose**: Update an existing feature flag

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

**Validation**: Uses `updateFeatureFlagSchema` from `lib/validations/admin.ts`

- `description`: Optional, max 500 characters
- `enabled`: Optional, boolean
- `metadata`: Optional, JSON object (replaces existing metadata)

**Note**: The `name` field cannot be updated after creation.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "ENABLE_BETA_FEATURES",
    "description": "Updated description",
    "enabled": true,
    "metadata": {
      "rolloutPercentage": 100
    },
    "createdBy": "clyyyy",
    "createdAt": "2026-01-01T08:00:00.000Z",
    "updatedAt": "2026-01-15T14:30:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **404 Not Found**: Feature flag not found
- **400 Validation Error**: Invalid request body

### Delete Feature Flag

✅ **Implemented in:** `app/api/v1/admin/feature-flags/[id]/route.ts` (DELETE handler)

**Purpose**: Delete a feature flag

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

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **404 Not Found**: Feature flag not found
  ```json
  {
    "success": false,
    "error": {
      "message": "Feature flag not found",
      "code": "NOT_FOUND"
    }
  }
  ```

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
    },
    {
      "email": "bob@example.com",
      "name": "Bob Smith",
      "role": "ADMIN",
      "invitedAt": "2026-01-08T10:00:00.000Z",
      "expiresAt": "2026-01-15T10:00:00.000Z"
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

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Invalid query parameters

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

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **404 Not Found**: Invitation not found or already expired
  ```json
  {
    "success": false,
    "error": {
      "message": "Invitation not found or already expired",
      "code": "NOT_FOUND"
    }
  }
  ```

**Note**: The email parameter must be URL-encoded when it contains special characters like `@`.

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
| `CONFLICT`            | 409         | Resource already exists             |
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
