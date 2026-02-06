# Authentication API Endpoints

Authentication endpoints powered by better-auth.

✅ **Implemented in:** `app/api/auth/[...all]/route.ts` (better-auth handler)

All authentication flows are handled by better-auth automatically.

## Sign Up with Email

```
POST /api/auth/sign-up/email
```

**Authentication**: None (public endpoint)

**Request Body**:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):

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

**Email Verification**:

- **Development**: Disabled by default (immediate login)
- **Production**: Enabled by default (must verify email first)
- **Override**: Set `REQUIRE_EMAIL_VERIFICATION=true/false`

**Error Responses**:

- **400 Validation Error**: Invalid request body
- **400 Email Taken**: Email already registered

**Note**: For admin-created accounts, use the invitation-based flow instead. See [User Creation Patterns](../auth/user-creation.md) for details.

## Sign In with Email

```
POST /api/auth/sign-in/email
```

**Authentication**: None (public endpoint)

**Request Body**:

```json
{
  "email": "john@example.com",
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):

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

## Sign In with OAuth (Google)

```
GET /api/auth/sign-in/social
```

**Query Parameters**:

- `provider`: `google`
- `callbackURL`: URL to redirect after successful authentication

**Flow**:

1. User clicks "Continue with Google"
2. Redirected to Google OAuth consent screen
3. Google redirects to `/api/auth/callback/google`
4. better-auth handles callback, creates/links user, creates session
5. User redirected to callback URL

## Sign Out

```
POST /api/auth/sign-out
```

**Authentication**: Required (session)

**Response**: Session cleared, cookies removed.

## Get Session

```
GET /api/auth/session
```

**Authentication**: Optional (returns null if not authenticated)

**Response** (200 OK - authenticated):

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

**Response** (200 OK - not authenticated):

```json
null
```

## OAuth Callback

```
GET /api/auth/callback/google
```

Handles OAuth callback from Google after successful authentication. This endpoint is called automatically by Google.

## Clear Session (Utility)

✅ **Implemented in:** `app/api/auth/clear-session/route.ts`

**Purpose**: Utility endpoint for clearing session cookies

```
GET /api/auth/clear-session
```

**Response**: Redirects to home page with session cookie cleared.

## Send Verification Email

✅ **Implemented in:** `app/api/auth/send-verification-email/route.ts`

**Purpose**: Request a verification email for the current user's account

```
POST /api/auth/send-verification-email
```

**Authentication**: None required (uses email lookup)

**Rate Limit**: 3 requests per 15 minutes per IP

**Request Body**:

```json
{
  "email": "user@example.com"
}
```

**Response** (200 OK - always returns success to prevent email enumeration):

```json
{
  "success": true,
  "data": {
    "message": "If an account exists with this email, a verification email has been sent."
  }
}
```

**Use Cases**:

- Email verification was disabled during signup (dev mode)
- User wants to verify their email for added security
- Previous verification email expired or was lost

**Security Note**: Always returns success response to prevent email enumeration attacks.

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

**Note**: User is NOT created until invitation is accepted.

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

**Usage**: Pre-fill user details in acceptance form before user sets password.

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

**Security**: Token hashed (SHA-256), single-use, expires in 7 days.

**Implementation**: Page route at `app/(auth)/accept-invite/page.tsx`

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [User Endpoints](./user-endpoints.md) - User management API
- [OAuth Integration](../auth/oauth.md) - OAuth setup and configuration
- [User Creation Patterns](../auth/user-creation.md) - Signup vs invitation flows
