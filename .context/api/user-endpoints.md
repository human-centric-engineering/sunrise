# User API Endpoints

User management endpoints for profile, preferences, and avatar operations.

## Get Current User

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

## Update Current User

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
- **400 Email Taken**: Email already in use by another user

## Delete Current User (Self-Deletion)

✅ **Implemented in:** `app/api/v1/users/me/route.ts` (DELETE handler)

**Purpose**: Allow user to delete their own account

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

**Note**: Deletion cascades to sessions and accounts. Session cookie is cleared automatically.

## Get User Preferences

✅ **Implemented in:** `app/api/v1/users/me/preferences/route.ts` (GET handler)

**Purpose**: Get current user's email notification preferences

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

## Update User Preferences

✅ **Implemented in:** `app/api/v1/users/me/preferences/route.ts` (PATCH handler)

**Purpose**: Update current user's email notification preferences

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

**Note**: `securityAlerts` is always `true` and cannot be disabled for security reasons.

## Upload Avatar

✅ **Implemented in:** `app/api/v1/users/me/avatar/route.ts` (POST handler)

**Purpose**: Upload or replace the current user's avatar

```
POST /api/v1/users/me/avatar
```

**Authentication**: Required (session)

**Content-Type**: `multipart/form-data`

**Request Body**: `file` field (binary image)

**Validation**:

- Magic bytes verification (not just MIME type)
- Supported formats: JPEG, PNG, WebP, GIF
- Max size: Configurable via `MAX_FILE_SIZE_MB` (default 5MB)

**Validation Schemas**: See `lib/validations/storage.ts` for `imageFileSchema` and `avatarUploadSchema`

**Processing**:

- Resized to 500x500 max dimensions
- Centre-cropped to square aspect ratio
- Converted to JPEG format

**Storage Key**: `avatars/{userId}/avatar.jpg` (overwrites previous avatar)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "url": "https://...?v=1706012345678",
    "key": "avatars/clx.../avatar.jpg",
    "size": 12345,
    "width": 500,
    "height": 500
  }
}
```

**Error Responses**:

- **400 Validation Error**: Missing or invalid file
- **400 File Too Large**: File exceeds max size
- **400 Invalid File Type**: Unsupported format or magic bytes mismatch
- **401 Unauthorized**: No valid session
- **503 Storage Not Configured**: S3-compatible storage not available

## Delete Avatar

✅ **Implemented in:** `app/api/v1/users/me/avatar/route.ts` (DELETE handler)

**Purpose**: Remove the current user's avatar

```
DELETE /api/v1/users/me/avatar
```

**Authentication**: Required (session)

**Behavior**: Deletes all files under `avatars/{userId}/` prefix and sets `user.image` to `null`.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "Avatar removed"
  }
}
```

## List Users (Admin)

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
- **400 Validation Error**: Invalid query parameters

## Get User by ID

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
- **404 Not Found**: User ID does not exist

## Update User (Admin)

✅ **Implemented in:** `app/api/v1/users/[id]/route.ts` (PATCH handler)

**Purpose**: Update a user's information (admin only)

```
PATCH /api/v1/users/:id
```

**Authentication**: Required (ADMIN role)

**Request Body** (all fields optional, but at least one required):

```json
{
  "name": "Jane Doe",
  "role": "ADMIN",
  "emailVerified": true
}
```

**Validation**: Uses `adminUserUpdateSchema` from `lib/validations/admin.ts`

- `name`: String (optional)
- `role`: Enum `USER` | `ADMIN` (optional)
- `emailVerified`: Boolean (optional)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "ADMIN",
    "emailVerified": true,
    "image": "https://...",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-15T14:30:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **404 Not Found**: User ID does not exist
- **400 Validation Error**: Invalid input data or no fields provided
- **400 SELF_ROLE_CHANGE**: Admin attempting to change their own role

**Security Notes**:

- Admins cannot change their own role (prevents accidental self-lockout)
- All role changes are logged with admin ID and changes made

## Delete User

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
- **400 Bad Request**: Attempting to delete own account
- **400 Bad Request**: Attempting to delete another admin account
- **404 Not Found**: User ID does not exist

**Note**: Deletion cascades to related records (sessions, accounts) as configured in Prisma schema.

**Admin Protection**: Admins cannot delete other admin accounts. To delete an admin, first demote them to USER role using the PATCH endpoint, then delete.

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [Auth Endpoints](./auth-endpoints.md) - Authentication API
- [Admin Endpoints](./admin-endpoints.md) - Admin-only API
