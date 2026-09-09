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
    "emailVerified": true,
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
  "currentPassword": "required only alongside email",
  "bio": "Software developer",
  "phone": "+1 (555) 123-4567",
  "timezone": "America/New_York",
  "location": "New York, NY"
}
```

**Validation**: Uses `updateUserSchema` from `lib/validations/user.ts`

### Changing `email` is an identity mutation

Three rules apply when `email` is present. Rejecting the address change (missing
or wrong `currentPassword`, or the address is taken) rejects the **whole
request** — no profile fields are saved, matching normal REST behaviour for an
error response. If you don't want a `name`/`bio`/etc. edit held hostage to the
address-change rules, send it in a separate PATCH.

**The address does not change in this request.** Sending `email` _starts_ a
change; it does not perform one. The handler delegates to better-auth's
`changeEmail`, which mails an approval link to the address **currently** on the
account and writes nothing until it is clicked — then verifies the new address
before the swap. So the response still carries the old `email`, plus
`emailChangeRequested: true`. Before this (#489), the address moved immediately
and the verification link went to whoever asked, which made one compromised
session enough for permanent account takeover.

**Re-authentication.** `currentPassword` is required whenever `email` is
present, and is checked against the stored credential. Accounts with no password
(OAuth-only) are exempt — there is nothing to confirm — and rely on the approval
step instead. Omitting it on a password account is a **400**; getting it wrong is
a **403**.

**Session type.** `withAuth` accepts an API key of _any_ scope, and keys are
self-service — so without a check, a `chat`-scoped key handed to a third-party
integration could move the account to an attacker's address. The handler rejects
the email path for key-authenticated callers with **403 FORBIDDEN**, via
`isApiKeySession()` from `lib/auth/api-keys.ts`. Changing your address requires a
browser session.

When the change finally completes, the user's other sessions are revoked. Full
flow and its sharp edges: [`.context/auth/security.md`](../auth/security.md).

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "emailVerified": true,
    "emailChangeRequested": false,
    "image": "https://...",
    "role": "USER",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-15T14:30:00.000Z"
  }
}
```

`email` is always the address **currently** on the account — a requested change
is not reflected here until it is approved and verified.
`emailChangeRequested` is `true` when this request started a change flow. It is
`false` when no `email` was sent, or when the submitted address matched the
current one (compared case-insensitively, so a form that PATCHes every field
does not start a pointless flow) — in both cases every other profile field in
the body is still saved normally, since neither is a rejection. It is also
`false` when re-authentication and the uniqueness check passed but the
`changeEmail` call itself failed to start (e.g. the mail provider is down): this
is the one case where profile fields ARE saved (the write happens before that
call, and a mail failure must not undo it) despite the flow not starting — a
distinct case from the outright-rejected ones above, which save nothing.

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: Caller is authenticated by API key and the body contains `email`
- **403 Forbidden**: `currentPassword` is incorrect
- **400 Validation Error**: Invalid input data, or `email` sent without `currentPassword` on a password account
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

## Export Current User's Data (Subject Access)

✅ **Implemented in:** `app/api/v1/users/me/export/route.ts` (GET handler)

**Purpose**: Give the user a copy of everything held about them (GDPR Art. 15)

```
GET /api/v1/users/me/export
```

**Authentication**: Required — **browser session only**. An API key of any scope
is refused with 403, because an export is the whole account in one response and
keys are self-service (same reasoning as the email-change refusal above).

**Rate limit**: `exportLimiter` sub-cap, 10/min keyed on the calling user, on top
of the section tier.

**Response** (200 OK): the bundle from `exportUserData()` under the standard
envelope. Sent with `Cache-Control: no-store` and a `Content-Disposition`
attachment filename.

```json
{
  "success": true,
  "data": {
    "meta": {
      "formatVersion": 1,
      "generatedAt": "2026-07-31T12:00:00.000Z",
      "subjectUserId": "clxxxx",
      "exported": [{ "model": "Session", "section": "sessions", "description": "...", "rows": 3 }],
      "attribution": [{ "model": "AiAgent", "section": "agents", "description": "...", "rows": 1 }],
      "excluded": [{ "model": "AiMessageEmbedding", "reason": "..." }]
    },
    "account": { "id": "clxxxx" },
    "personalData": { "sessions": [], "conversations": [] },
    "attributions": { "agents": [] },
    "erasureReceipts": [],
    "app": {}
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: Authenticated with an API key rather than a browser session
- **429 Too Many Requests**: Export sub-cap exhausted

**Note**: Credential material — session tokens, password hashes, OAuth tokens,
API-key hashes, HMAC secrets — is omitted; `meta.excluded` states what else was
withheld and why. Volume is unbounded by design. What the bundle contains is
decided by the manifest, not this route — see
[Subject Access Export](../privacy/data-export.md).

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

**Authentication**: Required

**Authorization**: Decided by the authorization policy, not by this handler — it
is the one core route that declares a `resource` resolver, so the read goes
through `canRead`. Sunrise's default answers what it always did: you may read
your own profile, and platform staff may read anyone's. A fork that registers a
narrowing policy narrows this endpoint, and safe mode refuses the cross-user
read outright. See [`.context/auth/authorization.md`](../auth/authorization.md).

**API keys are judged by scope, not by their owner's role.** A key needs the
`admin` scope to read another user's profile; the fact that the key belongs to
an admin is not enough.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "USER",
    "emailVerified": true,
    "image": "https://...",
    "createdAt": "2025-01-01T08:00:00.000Z",
    "updatedAt": "2025-01-10T12:00:00.000Z"
  }
}
```

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden** (`Access denied`): the policy refused the read — by default,
  not ADMIN and not your own profile. A malformed id from a non-admin also lands
  here rather than on a 400, because the policy decides before the handler
  validates.
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

## Export a User's Data (Admin, Subject Access)

✅ **Implemented in:** `app/api/v1/users/[id]/export/route.ts` (GET handler)

**Purpose**: Answer a subject access request that arrives by email or post
rather than through the account itself (GDPR Art. 15)

```
GET /api/v1/users/:id/export
```

**Authentication**: Required (ADMIN role)

**Rate limit**: `exportLimiter` sub-cap, 10/min keyed on the **acting admin** —
so one operator working through a backlog is not blocked by another, and a
subject cannot exhaust their own export budget.

**Response** (200 OK): the same bundle shape as
[the self-service route](#export-current-users-data-subject-access), for the
named subject. Admins deliberately have no filter over what it contains — an
access response an operator can narrow is one they can narrow by mistake.

**Error Responses**:

- **401 Unauthorized**: No valid session
- **403 Forbidden**: User does not have ADMIN role
- **400 Validation Error**: Malformed user ID
- **404 Not Found**: No such user
- **429 Too Many Requests**: Export sub-cap exhausted

**Note**: A missing subject is a 404, distinct from a 500 — collapsing the two
would tell an operator the subject does not exist when the export merely broke.
The request is logged with both the subject and the acting admin, since reading
someone else's record is itself an event worth accounting for.

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [Auth Endpoints](./auth-endpoints.md) - Authentication API
- [Admin Endpoints](./admin-endpoints.md) - Admin-only API
- [Subject Access Export](../privacy/data-export.md) - the manifest that decides what an export contains
- [Account Deletion & Right to Erasure](../privacy/data-erasure.md) - the Art. 17 counterpart
