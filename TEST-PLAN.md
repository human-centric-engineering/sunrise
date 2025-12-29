# Sunrise - Unit Testing Plan (Phase 2.4)

## Overview

This document outlines a comprehensive plan for implementing unit tests for the Sunrise starter template. The focus is on creating **example tests** that demonstrate best practices, not achieving 100% coverage. These tests serve as patterns for developers to follow when adding new features.

## Testing Philosophy

1. **Example-Driven**: Write representative tests that show patterns, not exhaustive coverage
2. **Production Quality**: Tests should be production-grade, not throwaway code
3. **Documentation Through Tests**: Tests serve as living documentation of how code should work
4. **Pragmatic Coverage**: Focus on critical paths and complex logic
5. **Mock Strategically**: Mock external dependencies (auth, database) but test real logic

## Current State Analysis

### Existing Infrastructure

- **Vitest**: Already installed in `package.json` (devDependencies not present, needs installation)
- **Test Scripts**: Already configured (`test`, `test:watch`, `test:coverage`)
- **Tests Directory**: Empty `/tests` directory exists
- **No Configuration**: No `vitest.config.ts` file exists yet

### Code to Test

Based on the codebase exploration, the following code requires testing:

#### Authentication Utilities (`lib/auth/utils.ts`)

- `getServerSession()` - Get current user session
- `getServerUser()` - Extract user from session
- `hasRole()` - Check user role
- `requireAuth()` - Enforce authentication
- `requireRole()` - Enforce role-based access
- `isAuthenticated()` - Type guard

#### Validation Schemas (`lib/validations/`)

- **`auth.ts`**: Password, email, sign-up, sign-in, password change, reset schemas
- **`user.ts`**: Update user, list users query, create user, user ID validation
- **`common.ts`**: Pagination, sorting, search, CUID, UUID, URL, slug validation

#### Utility Functions

- **`lib/utils.ts`**: `cn()` - Tailwind class merge utility
- **`lib/utils/password-strength.ts`**: `calculatePasswordStrength()` - Password strength calculator

#### API Response Utilities (`lib/api/`)

- **`responses.ts`**: `successResponse()`, `errorResponse()`, `paginatedResponse()`
- **`errors.ts`**: Custom error classes, `handleAPIError()`
- **`validation.ts`**: `validateRequestBody()`, `validateQueryParams()`, `parsePaginationParams()`

#### Database Utilities (`lib/db/utils.ts`)

- `checkDatabaseConnection()` - Health check
- `getDatabaseHealth()` - Health with latency
- `executeTransaction()` - Transaction wrapper

#### Logging Utilities (`lib/logging/`)

- **`index.ts`**: Logger class methods, PII sanitization, log formatting
- **`context.ts`**: Request context extraction, user context, IP detection

---

## Test Plan Structure

### Directory Organization

```
tests/
├── setup.ts                        # Global test setup (mocks, matchers)
├── helpers/
│   ├── mocks/
│   │   ├── auth.ts                 # Mock auth session/user
│   │   ├── database.ts             # Mock Prisma client
│   │   ├── next.ts                 # Mock Next.js headers, cookies
│   │   └── logger.ts               # Mock logger
│   ├── factories/
│   │   ├── user.ts                 # User data factory
│   │   ├── session.ts              # Session data factory
│   │   └── api.ts                  # API request/response factory
│   └── assertions/
│       └── api.ts                  # Custom API response assertions
├── unit/
│   ├── auth/
│   │   └── utils.test.ts           # Auth utility tests
│   ├── validations/
│   │   ├── auth.test.ts            # Auth validation tests
│   │   ├── user.test.ts            # User validation tests
│   │   └── common.test.ts          # Common validation tests
│   ├── utils/
│   │   ├── utils.test.ts           # General utilities tests
│   │   └── password-strength.test.ts
│   ├── api/
│   │   ├── responses.test.ts       # Response utilities tests
│   │   ├── errors.test.ts          # Error handling tests
│   │   └── validation.test.ts      # Request validation tests
│   ├── db/
│   │   └── utils.test.ts           # Database utilities tests
│   └── logging/
│       ├── logger.test.ts          # Logger tests
│       └── context.test.ts         # Context utilities tests
└── integration/
    ├── api/
    │   └── health.test.ts          # Health endpoint integration test (example)
    └── README.md                   # Note: Integration tests are examples only
```

---

## Detailed Test Plans by Module

### 1. Authentication Utilities (`lib/auth/utils.ts`)

**File**: `tests/unit/auth/utils.test.ts`

**Dependencies to Mock**:

- `lib/auth/config` - Mock `auth.api.getSession()`
- `next/headers` - Mock `headers()` function
- `lib/logging` - Mock `logger.error()`

**Test Cases**:

#### `getServerSession()`

1. **Success**: Returns session when auth succeeds
   - Mock `auth.api.getSession()` to return valid session
   - Assert returned session matches expected structure
   - Assert has `session` and `user` objects

2. **No session**: Returns null when not authenticated
   - Mock `auth.api.getSession()` to return null
   - Assert returns null

3. **Error handling**: Returns null and logs error when auth throws
   - Mock `auth.api.getSession()` to throw error
   - Assert returns null
   - Assert `logger.error` was called

#### `getServerUser()`

1. **Authenticated user**: Extracts user from session
   - Mock `getServerSession()` to return session with user
   - Assert returns user object only
   - Assert user properties are correct

2. **No session**: Returns null when not authenticated
   - Mock `getServerSession()` to return null
   - Assert returns null

#### `hasRole()`

1. **Has role**: Returns true when user has required role
   - Mock `getServerUser()` with role='ADMIN'
   - Call `hasRole('ADMIN')`
   - Assert returns true

2. **Different role**: Returns false when user has different role
   - Mock `getServerUser()` with role='USER'
   - Call `hasRole('ADMIN')`
   - Assert returns false

3. **No session**: Returns false when not authenticated
   - Mock `getServerUser()` to return null
   - Assert returns false

4. **No role field**: Returns false when user.role is null
   - Mock `getServerUser()` with role=null
   - Assert returns false

#### `requireAuth()`

1. **Authenticated**: Returns session when authenticated
   - Mock `getServerSession()` to return valid session
   - Assert returns session
   - Assert doesn't throw

2. **Not authenticated**: Throws error when no session
   - Mock `getServerSession()` to return null
   - Assert throws Error with 'Authentication required'

#### `requireRole()`

1. **Has required role**: Returns session when role matches
   - Mock `requireAuth()` to return session with role='ADMIN'
   - Call `requireRole('ADMIN')`
   - Assert returns session

2. **Missing role**: Throws error when role doesn't match
   - Mock `requireAuth()` to return session with role='USER'
   - Call `requireRole('ADMIN')`
   - Assert throws Error with 'Role ADMIN required'

3. **Not authenticated**: Throws auth error when no session
   - Mock `requireAuth()` to throw 'Authentication required'
   - Assert error is propagated

#### `isAuthenticated()`

1. **Type guard - authenticated**: Narrows type when session exists
   - Call with valid session object
   - Assert returns true
   - TypeScript should narrow type (compile-time check)

2. **Type guard - not authenticated**: Returns false for null
   - Call with null
   - Assert returns false

**Mock Strategy**:

```typescript
// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock auth config
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
  },
}));
```

**Key Patterns to Demonstrate**:

- Mocking Next.js server-only modules (`next/headers`)
- Mocking better-auth API
- Testing async functions with promises
- Error handling and logging verification
- Type guard testing

---

### 2. Validation Schemas (`lib/validations/`)

#### 2.1 Auth Validation (`lib/validations/auth.ts`)

**File**: `tests/unit/validations/auth.test.ts`

**Dependencies to Mock**: None (pure Zod schemas)

**Test Cases**:

##### `passwordSchema`

1. **Valid password**: Accepts password meeting all requirements
   - Input: `Test@123` (8 chars, upper, lower, number, special)
   - Assert: `schema.parse()` succeeds

2. **Too short**: Rejects password < 8 characters
   - Input: `Test@1`
   - Assert: Throws with error message 'at least 8 characters'

3. **Too long**: Rejects password > 100 characters
   - Input: 101-character string
   - Assert: Throws with error message 'less than 100 characters'

4. **Missing uppercase**: Rejects without uppercase letter
   - Input: `test@123`
   - Assert: Throws with error about uppercase

5. **Missing lowercase**: Rejects without lowercase letter
   - Input: `TEST@123`
   - Assert: Throws with error about lowercase

6. **Missing number**: Rejects without number
   - Input: `Test@test`
   - Assert: Throws with error about number

7. **Missing special char**: Rejects without special character
   - Input: `Test1234`
   - Assert: Throws with error about special character

##### `emailSchema`

1. **Valid email**: Accepts valid email
   - Input: `user@example.com`
   - Assert: Parses successfully

2. **Normalizes to lowercase**: Converts to lowercase
   - Input: `USER@EXAMPLE.COM`
   - Assert: Output is `user@example.com`

3. **Trims whitespace**: Removes leading/trailing spaces
   - Input: `  user@example.com  `
   - Assert: Output is `user@example.com`

4. **Empty email**: Rejects empty string
   - Input: ``
   - Assert: Throws 'Email is required'

5. **Invalid format**: Rejects invalid email format
   - Input: `not-an-email`
   - Assert: Throws 'Invalid email address'

6. **Too long**: Rejects email > 255 characters
   - Input: `${'a'.repeat(250)}@example.com`
   - Assert: Throws 'less than 255 characters'

##### `signUpSchema`

1. **Valid sign-up**: Accepts valid registration data
   - Input: `{ name: 'John', email: 'john@example.com', password: 'Test@123', confirmPassword: 'Test@123' }`
   - Assert: Parses successfully

2. **Password mismatch**: Rejects when passwords don't match
   - Input: `{ password: 'Test@123', confirmPassword: 'Test@456', ... }`
   - Assert: Throws 'Passwords don't match' on confirmPassword field

3. **Empty name**: Rejects empty name
   - Input: `{ name: '', ... }`
   - Assert: Throws 'Name is required'

4. **Name too long**: Rejects name > 100 characters
   - Input: `{ name: 'a'.repeat(101), ... }`
   - Assert: Throws 'less than 100 characters'

5. **Invalid email**: Rejects invalid email (delegates to emailSchema)
   - Input: `{ email: 'invalid', ... }`
   - Assert: Throws email validation error

6. **Invalid password**: Rejects weak password (delegates to passwordSchema)
   - Input: `{ password: 'weak', confirmPassword: 'weak', ... }`
   - Assert: Throws password validation error

##### `signInSchema`

1. **Valid sign-in**: Accepts valid login data
   - Input: `{ email: 'user@example.com', password: 'anypassword' }`
   - Assert: Parses successfully

2. **Empty password**: Rejects empty password
   - Input: `{ email: 'user@example.com', password: '' }`
   - Assert: Throws 'Password is required'

3. **Note**: Sign-in doesn't validate password strength (only presence)
   - Input: `{ email: 'user@example.com', password: 'weak' }`
   - Assert: Parses successfully (no strength validation on login)

##### `changePasswordSchema`

1. **Valid password change**: Accepts valid change request
   - Input: `{ currentPassword: 'Old@123', newPassword: 'New@123', confirmPassword: 'New@123' }`
   - Assert: Parses successfully

2. **Password mismatch**: Rejects when new passwords don't match
   - Input: `{ newPassword: 'New@123', confirmPassword: 'New@456', ... }`
   - Assert: Throws 'Passwords don't match'

3. **Same password**: Rejects when new equals current
   - Input: `{ currentPassword: 'Same@123', newPassword: 'Same@123', confirmPassword: 'Same@123' }`
   - Assert: Throws 'must be different from current password'

4. **Empty current password**: Rejects empty current password
   - Input: `{ currentPassword: '', ... }`
   - Assert: Throws 'Current password is required'

5. **Weak new password**: Rejects weak new password
   - Input: `{ newPassword: 'weak', confirmPassword: 'weak', ... }`
   - Assert: Throws password validation error

##### Other Schemas (Brief Coverage)

- `resetPasswordRequestSchema`: Test valid email, invalid email
- `resetPasswordSchema`: Test valid reset, mismatched passwords, missing token
- `verifyEmailSchema`: Test valid token, empty token

**Key Patterns to Demonstrate**:

- Testing Zod schemas with `parse()` and error handling
- Testing `.refine()` custom validation
- Testing schema transformations (toLowerCase, trim)
- Extracting error messages from ZodError
- Testing nested schemas (composition)

---

#### 2.2 User Validation (`lib/validations/user.ts`)

**File**: `tests/unit/validations/user.test.ts`

**Test Cases**:

##### `updateUserSchema`

1. **Valid update**: Accepts partial user data
   - Input: `{ name: 'Jane Doe' }`
   - Assert: Parses successfully

2. **Email update**: Accepts email change
   - Input: `{ email: 'new@example.com' }`
   - Assert: Parses successfully and normalized

3. **Both fields**: Accepts both name and email
   - Input: `{ name: 'Jane', email: 'jane@example.com' }`
   - Assert: Parses successfully

4. **Empty object**: Accepts empty object (all fields optional)
   - Input: `{}`
   - Assert: Parses successfully

5. **Empty name**: Rejects empty name string
   - Input: `{ name: '' }`
   - Assert: Throws 'Name cannot be empty'

6. **Name too long**: Rejects name > 100 characters
   - Input: `{ name: 'a'.repeat(101) }`
   - Assert: Throws validation error

##### `listUsersQuerySchema`

1. **Default values**: Applies defaults when not provided
   - Input: `{}`
   - Assert: Returns `{ page: 1, limit: 20, sortBy: 'createdAt', sortOrder: 'desc' }`

2. **Custom pagination**: Accepts custom page/limit
   - Input: `{ page: '2', limit: '50' }` (query params are strings)
   - Assert: Returns `{ page: 2, limit: 50, ... }` (coerced to numbers)

3. **Search query**: Accepts search parameter
   - Input: `{ search: 'john' }`
   - Assert: Returns object with search field

4. **Custom sorting**: Accepts sortBy and sortOrder
   - Input: `{ sortBy: 'email', sortOrder: 'asc' }`
   - Assert: Returns correct sorting config

5. **Max limit enforcement**: Caps limit at 100
   - Input: `{ limit: '200' }`
   - Assert: Returns `{ limit: 100, ... }`

6. **Invalid sortBy**: Rejects invalid sort field
   - Input: `{ sortBy: 'invalid' }`
   - Assert: Throws validation error

##### `userIdSchema`

1. **Valid CUID**: Accepts valid CUID format
   - Input: `{ id: 'cmjbv4i3x00003wsloputgwul' }`
   - Assert: Parses successfully

2. **Invalid CUID**: Rejects invalid CUID format
   - Input: `{ id: 'invalid-id' }`
   - Assert: Throws 'Invalid ID format'

3. **Empty ID**: Rejects empty string
   - Input: `{ id: '' }`
   - Assert: Throws validation error

##### `createUserSchema`

1. **Valid user creation**: Accepts full user data
   - Input: `{ name: 'John', email: 'john@example.com', password: 'Test@123', role: 'USER' }`
   - Assert: Parses successfully

2. **Default role**: Applies USER role when not provided
   - Input: `{ name: 'John', email: 'john@example.com' }`
   - Assert: Returns `{ role: 'USER', ... }`

3. **Optional password**: Accepts user without password
   - Input: `{ name: 'John', email: 'john@example.com', role: 'ADMIN' }`
   - Assert: Parses successfully (password is optional)

4. **Admin role**: Accepts ADMIN role
   - Input: `{ ..., role: 'ADMIN' }`
   - Assert: Parses successfully

5. **Invalid role**: Rejects invalid role
   - Input: `{ ..., role: 'SUPERUSER' }`
   - Assert: Throws validation error

**Key Patterns to Demonstrate**:

- Testing schemas with optional fields
- Testing default values
- Testing query parameter coercion (string to number)
- Testing CUID validation (Zod 4 syntax)
- Testing enum validation

---

#### 2.3 Common Validation (`lib/validations/common.ts`)

**File**: `tests/unit/validations/common.test.ts`

**Test Cases**:

##### `paginationQuerySchema`

1. **Defaults**: Returns default page=1, limit=10
   - Input: `{}`
   - Assert: `{ page: 1, limit: 10 }`

2. **Custom values**: Accepts custom page/limit
   - Input: `{ page: '3', limit: '25' }`
   - Assert: `{ page: 3, limit: 25 }`

3. **Max limit**: Enforces max limit of 100
   - Input: `{ limit: '500' }`
   - Assert: `{ limit: 100 }`

4. **Invalid values**: Rejects negative/zero values
   - Input: `{ page: '0' }`
   - Assert: Throws validation error

##### `sortingQuerySchema`

1. **Defaults**: Returns default sortOrder='desc'
   - Input: `{}`
   - Assert: `{ sortOrder: 'desc' }`

2. **Custom values**: Accepts asc/desc
   - Input: `{ sortBy: 'name', sortOrder: 'asc' }`
   - Assert: Parses successfully

3. **Invalid order**: Rejects invalid sort order
   - Input: `{ sortOrder: 'invalid' }`
   - Assert: Throws validation error

##### `searchQuerySchema`

1. **Search query**: Accepts search string
   - Input: `{ q: 'search term' }`
   - Assert: Parses successfully

2. **Trims whitespace**: Removes extra spaces
   - Input: `{ q: '  search  ' }`
   - Assert: Returns `{ q: 'search' }`

3. **Optional**: Accepts empty object
   - Input: `{}`
   - Assert: `{ q: undefined }`

##### `cuidSchema`

1. **Valid CUID**: Accepts valid CUID
   - Input: `'cmjbv4i3x00003wsloputgwul'`
   - Assert: Parses successfully

2. **Invalid CUID**: Rejects invalid format
   - Input: `'not-a-cuid'`
   - Assert: Throws 'Invalid ID format'

##### `uuidSchema`

1. **Valid UUID**: Accepts valid UUID v4
   - Input: `'550e8400-e29b-41d4-a716-446655440000'`
   - Assert: Parses successfully

2. **Invalid UUID**: Rejects invalid format
   - Input: `'not-a-uuid'`
   - Assert: Throws 'Invalid UUID format'

##### `urlSchema`

1. **Valid URL**: Accepts http/https URLs
   - Input: `'https://example.com'`
   - Assert: Parses successfully

2. **Invalid URL**: Rejects non-URL strings
   - Input: `'not a url'`
   - Assert: Throws 'Invalid URL format'

##### `slugSchema`

1. **Valid slug**: Accepts lowercase alphanumeric with hyphens
   - Input: `'my-blog-post-123'`
   - Assert: Parses successfully

2. **Invalid slug - uppercase**: Rejects uppercase
   - Input: `'My-Blog-Post'`
   - Assert: Throws validation error

3. **Invalid slug - spaces**: Rejects spaces
   - Input: `'my blog post'`
   - Assert: Throws validation error

4. **Invalid slug - special chars**: Rejects special characters
   - Input: `'my_blog_post'`
   - Assert: Throws validation error

**Key Patterns to Demonstrate**:

- Testing Zod 4 built-in validators (`.cuid()`, `.uuid()`, `.url()`)
- Testing regex patterns
- Testing coercion (`.coerce.number()`)
- Testing min/max constraints
- Testing default values

---

### 3. Utility Functions

#### 3.1 General Utils (`lib/utils.ts`)

**File**: `tests/unit/utils/utils.test.ts`

**Dependencies to Mock**: None (uses clsx and tailwind-merge)

**Test Cases**:

##### `cn()` (Tailwind class merge)

1. **Single class**: Returns single class string
   - Input: `cn('text-red-500')`
   - Assert: Returns `'text-red-500'`

2. **Multiple classes**: Merges multiple classes
   - Input: `cn('text-red-500', 'bg-blue-200')`
   - Assert: Returns merged string

3. **Conditional classes**: Handles conditional classes (clsx)
   - Input: `cn('base', { 'active': true, 'disabled': false })`
   - Assert: Returns `'base active'`

4. **Tailwind conflicts**: Resolves Tailwind conflicts
   - Input: `cn('text-red-500', 'text-blue-500')`
   - Assert: Returns `'text-blue-500'` (last wins)

5. **Undefined/null**: Filters out falsy values
   - Input: `cn('base', undefined, null, false, 'active')`
   - Assert: Returns `'base active'`

**Key Patterns to Demonstrate**:

- Testing utility functions with dependencies
- Testing variadic arguments
- Testing Tailwind CSS merge behavior

---

#### 3.2 Password Strength (`lib/utils/password-strength.ts`)

**File**: `tests/unit/utils/password-strength.test.ts`

**Dependencies to Mock**: None (pure function)

**Test Cases**:

##### `calculatePasswordStrength()`

1. **Empty password**: Returns weak score for empty string
   - Input: `''`
   - Assert: `{ score: 0, label: 'Weak', color: 'bg-gray-300', percentage: 0 }`

2. **Very weak password**: Returns low score for simple password
   - Input: `'password'` (all lowercase, common word)
   - Assert: `score <= 1`, `label: 'Weak'`

3. **Weak password**: Returns low score for short/simple
   - Input: `'pass123'` (< 8 chars)
   - Assert: `score <= 2`, `label: 'Weak' | 'Fair'`

4. **Fair password**: Returns medium score
   - Input: `'Password1'` (8+ chars, upper, lower, number)
   - Assert: `score: 2`, `label: 'Fair'`

5. **Good password**: Returns good score
   - Input: `'Password123'` (12+ chars, variety)
   - Assert: `score: 3`, `label: 'Good'`

6. **Strong password**: Returns high score
   - Input: `'MyP@ssw0rd2024!'` (16+ chars, all varieties, no patterns)
   - Assert: `score: 4`, `label: 'Strong'`, `percentage: 100`

7. **Length bonus**: Awards points for length
   - Input: `'abcdefgh'` (8 chars)
   - Assert: Higher score than 6 chars

8. **Character variety bonus**: Awards points for variety
   - Input: `'Abc123!@#'`
   - Assert: Contains uppercase, lowercase, number, special

9. **Common pattern penalty**: Penalizes repeated chars
   - Input: `'Passsword123'` (repeated 's')
   - Assert: Lower score than without repeats

10. **Common sequence penalty**: Penalizes common sequences
    - Input: `'123456789'` (starts with 123)
    - Assert: Heavily penalized

11. **All lowercase penalty**: Penalizes only lowercase
    - Input: `'password'`
    - Assert: Penalty applied

12. **All uppercase penalty**: Penalizes only uppercase
    - Input: `'PASSWORD'`
    - Assert: Penalty applied

13. **All numbers penalty**: Penalizes only numbers
    - Input: `'12345678'`
    - Assert: Penalty applied

14. **Percentage calculation**: Correctly calculates percentage
    - Input: Various passwords
    - Assert: `percentage = (score / 4) * 100`

**Key Patterns to Demonstrate**:

- Testing pure functions with complex logic
- Testing scoring/rating algorithms
- Testing penalty/bonus systems
- Testing multiple conditions and edge cases

---

### 4. API Utilities

#### 4.1 Response Utilities (`lib/api/responses.ts`)

**File**: `tests/unit/api/responses.test.ts`

**Dependencies to Mock**: None (pure functions returning Response objects)

**Test Cases**:

##### `successResponse()`

1. **Simple success**: Returns success response with data
   - Input: `successResponse({ id: '123', name: 'John' })`
   - Assert: `{ success: true, data: { id: '123', name: 'John' } }`
   - Assert: Status 200
   - Assert: Content-Type header

2. **With metadata**: Includes meta object
   - Input: `successResponse(data, { page: 1, total: 100 })`
   - Assert: Response includes `meta` field

3. **Custom status**: Accepts custom status code
   - Input: `successResponse(data, undefined, { status: 201 })`
   - Assert: Status 201

4. **Custom headers**: Includes custom headers
   - Input: `successResponse(data, undefined, { headers: { 'X-Custom': 'value' } })`
   - Assert: Response includes custom header

##### `errorResponse()`

1. **Simple error**: Returns error response with message
   - Input: `errorResponse('Not found')`
   - Assert: `{ success: false, error: { message: 'Not found' } }`
   - Assert: Status 500 (default)

2. **With error code**: Includes error code
   - Input: `errorResponse('Not found', { code: 'NOT_FOUND' })`
   - Assert: `error.code === 'NOT_FOUND'`

3. **With status**: Custom status code
   - Input: `errorResponse('Bad request', { status: 400 })`
   - Assert: Status 400

4. **With details**: Includes error details
   - Input: `errorResponse('Validation failed', { details: { email: ['Invalid'] } })`
   - Assert: `error.details` present

##### `paginatedResponse()`

1. **Paginated data**: Returns data with pagination meta
   - Input: `paginatedResponse([...items], { page: 1, limit: 20, total: 150 })`
   - Assert: `meta.page === 1`
   - Assert: `meta.limit === 20`
   - Assert: `meta.total === 150`
   - Assert: `meta.totalPages === 8` (calculated)

2. **Total pages calculation**: Correctly calculates total pages
   - Input: Various total/limit combinations
   - Assert: `Math.ceil(total / limit)`

3. **Empty results**: Handles empty array
   - Input: `paginatedResponse([], { page: 1, limit: 20, total: 0 })`
   - Assert: Returns empty data array
   - Assert: `totalPages === 0`

**Key Patterns to Demonstrate**:

- Testing Response object creation
- Testing JSON serialization
- Testing HTTP headers
- Testing calculated fields

---

#### 4.2 Error Handling (`lib/api/errors.ts`)

**File**: `tests/unit/api/errors.test.ts`

**Dependencies to Mock**:

- `@/lib/env` - Mock environment variables
- `@/lib/logging` - Mock logger

**Test Cases**:

##### Custom Error Classes

1. **APIError**: Creates error with code and status
   - Create: `new APIError('Message', 'CODE', 400)`
   - Assert: Properties set correctly
   - Assert: Error.captureStackTrace called

2. **ValidationError**: Creates 400 error
   - Create: `new ValidationError('Invalid', { field: ['error'] })`
   - Assert: `status === 400`
   - Assert: `code === 'VALIDATION_ERROR'`
   - Assert: Details preserved

3. **UnauthorizedError**: Creates 401 error
   - Create: `new UnauthorizedError()`
   - Assert: `status === 401`
   - Assert: Default message

4. **ForbiddenError**: Creates 403 error
   - Create: `new ForbiddenError('Admin only')`
   - Assert: `status === 403`
   - Assert: Custom message

5. **NotFoundError**: Creates 404 error
   - Create: `new NotFoundError('User not found')`
   - Assert: `status === 404`

##### `handleAPIError()`

1. **APIError handling**: Returns formatted response for APIError
   - Input: `new ValidationError('Invalid', { details })`
   - Assert: Response contains error message, code, status, details
   - Assert: Logger called

2. **Zod error handling**: Transforms ZodError to validation response
   - Input: Zod validation error
   - Assert: Status 400
   - Assert: Code 'VALIDATION_ERROR'
   - Assert: Details formatted correctly

3. **Prisma unique constraint**: Handles P2002 error
   - Input: Prisma error with code 'P2002'
   - Assert: Status 400
   - Assert: Code 'EMAIL_TAKEN'
   - Assert: Message mentions field

4. **Prisma not found**: Handles P2025 error
   - Input: Prisma error with code 'P2025'
   - Assert: Status 404
   - Assert: Code 'NOT_FOUND'

5. **Prisma foreign key**: Handles P2003 error
   - Input: Prisma error with code 'P2003'
   - Assert: Status 400
   - Assert: Code 'VALIDATION_ERROR'

6. **Unknown Prisma error**: Handles other Prisma errors
   - Input: Prisma error with unknown code
   - Assert: Status 500
   - Assert: Includes details in dev mode only

7. **Generic Error**: Handles standard Error objects
   - Input: `new Error('Something went wrong')`
   - Assert: Status 500
   - Assert: Message preserved
   - Assert: Stack in dev mode only

8. **Unknown error**: Handles non-Error values
   - Input: `'string error'`
   - Assert: Status 500
   - Assert: Generic error message

9. **Environment-aware details**: Includes details in dev, hides in prod
   - Mock `env.NODE_ENV = 'production'`
   - Assert: No stack traces or internal details in response

**Mock Strategy**:

```typescript
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'development', // or 'production'
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
  },
}));
```

**Key Patterns to Demonstrate**:

- Testing custom error classes
- Testing error transformation
- Testing environment-aware behavior
- Testing error logging
- Testing Prisma-specific error codes

---

#### 4.3 Request Validation (`lib/api/validation.ts`)

**File**: `tests/unit/api/validation.test.ts`

**Dependencies to Mock**:

- `next/server` - Mock NextRequest

**Test Cases**:

##### `validateRequestBody()`

1. **Valid JSON body**: Parses and validates correct data
   - Input: Valid JSON matching schema
   - Assert: Returns parsed data
   - Assert: Type-safe based on schema

2. **Invalid data**: Throws ValidationError for invalid data
   - Input: Data failing schema validation
   - Assert: Throws ValidationError
   - Assert: Error details formatted correctly

3. **Malformed JSON**: Throws ValidationError for invalid JSON
   - Input: Malformed JSON string
   - Assert: Throws ValidationError with JSON error message

4. **Empty body**: Throws ValidationError
   - Input: Empty request body
   - Assert: Throws appropriate error

##### `validateQueryParams()`

1. **Valid query params**: Parses URLSearchParams
   - Input: `?page=1&limit=20`
   - Assert: Returns `{ page: 1, limit: 20 }`

2. **Invalid params**: Throws ValidationError
   - Input: Invalid query params
   - Assert: Throws ValidationError with details

3. **Missing params**: Uses defaults from schema
   - Input: Empty URLSearchParams
   - Assert: Returns default values

##### `parsePaginationParams()`

1. **Default values**: Returns defaults when not provided
   - Input: Empty URLSearchParams
   - Assert: `{ page: 1, limit: 20, skip: 0 }`

2. **Custom values**: Parses custom page/limit
   - Input: `?page=3&limit=50`
   - Assert: `{ page: 3, limit: 50, skip: 100 }`

3. **Skip calculation**: Correctly calculates skip
   - Various page/limit combinations
   - Assert: `skip = (page - 1) * limit`

4. **Min page enforcement**: Enforces minimum page of 1
   - Input: `?page=0` or `?page=-5`
   - Assert: `page = 1`

5. **Max limit enforcement**: Caps limit at 100
   - Input: `?limit=500`
   - Assert: `limit = 100`

6. **Min limit enforcement**: Enforces minimum limit of 1
   - Input: `?limit=0` or `?limit=-10`
   - Assert: `limit = 1`

7. **Invalid number**: Throws ValidationError for NaN
   - Input: `?page=abc`
   - Assert: Throws ValidationError

**Mock Strategy**:

```typescript
// Mock NextRequest with json() method
const mockRequest = {
  json: vi.fn(),
  nextUrl: {
    searchParams: new URLSearchParams('?page=1'),
  },
} as unknown as NextRequest;
```

**Key Patterns to Demonstrate**:

- Testing request body parsing
- Testing query parameter parsing
- Testing validation error transformation
- Testing URLSearchParams conversion
- Testing numeric constraints

---

### 5. Database Utilities (`lib/db/utils.ts`)

**File**: `tests/unit/db/utils.test.ts`

**Dependencies to Mock**:

- `@/lib/db/client` - Mock Prisma client
- `@/lib/logging` - Mock logger

**Test Cases**:

##### `checkDatabaseConnection()`

1. **Successful connection**: Returns true when query succeeds
   - Mock `prisma.$queryRaw` to resolve
   - Assert: Returns true

2. **Failed connection**: Returns false and logs error
   - Mock `prisma.$queryRaw` to reject
   - Assert: Returns false
   - Assert: Logger.error called

##### `disconnectDatabase()`

1. **Disconnect**: Calls prisma.$disconnect()
   - Assert: `prisma.$disconnect` called

##### `getDatabaseHealth()`

1. **Healthy database**: Returns connected=true with latency
   - Mock `prisma.$queryRaw` to resolve after delay
   - Assert: `{ connected: true, latency: <number> }`
   - Assert: Latency is reasonable (< 1000ms in test)

2. **Unhealthy database**: Returns connected=false
   - Mock `prisma.$queryRaw` to reject
   - Assert: `{ connected: false }`
   - Assert: No latency field
   - Assert: Logger.error called

##### `executeTransaction()`

1. **Successful transaction**: Executes callback in transaction
   - Mock `prisma.$transaction`
   - Assert: Callback executed
   - Assert: Returns callback result

2. **Failed transaction**: Propagates errors
   - Mock callback to throw error
   - Assert: Error propagated
   - Assert: Transaction rolled back

**Mock Strategy**:

```typescript
vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: vi.fn((callback) => callback(mockTx)),
  },
}));
```

**Key Patterns to Demonstrate**:

- Mocking Prisma client methods
- Testing database health checks
- Testing transaction execution
- Testing error handling with database operations

---

### 6. Logging Utilities (`lib/logging/`)

#### 6.1 Logger (`lib/logging/index.ts`)

**File**: `tests/unit/logging/logger.test.ts`

**Dependencies to Mock**:

- `process.env` - Mock environment variables
- `console` methods - Spy on console output

**Test Cases**:

##### Logger Class - Basic Functionality

1. **Log levels**: Respects log level filtering
   - Set level to INFO
   - Call `logger.debug()`
   - Assert: Nothing logged
   - Call `logger.info()`
   - Assert: Logged

2. **Debug logging**: Only logs in development or DEBUG level
   - Set NODE_ENV=production, LOG_LEVEL=INFO
   - Call `logger.debug()`
   - Assert: Not logged

3. **Info logging**: Logs informational messages
   - Call `logger.info('message', { meta })`
   - Assert: Console output includes message and meta

4. **Warn logging**: Logs warnings
   - Call `logger.warn('warning')`
   - Assert: Console output includes warning

5. **Error logging**: Logs errors with stack traces
   - Call `logger.error('error', new Error('test'))`
   - Assert: Console.error called
   - Assert: Output includes error message and stack

##### PII Sanitization

1. **Sanitizes password field**: Redacts password
   - Input: `{ user: { password: 'secret' } }`
   - Assert: Output contains `[REDACTED]`

2. **Sanitizes token field**: Redacts tokens
   - Input: `{ token: 'abc123' }`
   - Assert: Output contains `[REDACTED]`

3. **Sanitizes nested sensitive fields**: Recursive sanitization
   - Input: Nested object with password
   - Assert: All password fields redacted

4. **Case-insensitive matching**: Matches PASSWORD, Token, etc.
   - Input: `{ PASSWORD: 'test', Token: 'test' }`
   - Assert: Both redacted

5. **Preserves non-sensitive data**: Doesn't redact safe fields
   - Input: `{ name: 'John', email: 'john@example.com' }`
   - Assert: Fields preserved

##### Output Formatting

1. **Development format**: Human-readable colored output
   - Set NODE_ENV=development
   - Call logger methods
   - Assert: Output includes colors, timestamps, formatted text

2. **Production format**: JSON output
   - Set NODE_ENV=production
   - Call logger methods
   - Assert: Output is valid JSON
   - Assert: Includes timestamp, level, message fields

3. **Error formatting - dev**: Shows stack traces
   - Set NODE_ENV=development
   - Log error with stack
   - Assert: Stack trace in output

4. **Error formatting - prod**: Sanitized error info
   - Set NODE_ENV=production
   - Log error with stack
   - Assert: Sanitized in JSON output

##### Context and Child Loggers

1. **Child logger**: Inherits parent context
   - Create logger with context `{ requestId: '123' }`
   - Create child with `{ userId: '456' }`
   - Log message
   - Assert: Output includes both requestId and userId

2. **withContext**: Creates logger with context
   - Call `logger.withContext({ key: 'value' })`
   - Assert: New logger has context
   - Assert: Original logger unchanged

3. **Empty context**: Doesn't include context field
   - Log without context
   - Assert: No context field in output

##### Log Level Management

1. **Get level**: Returns current level
   - Assert: `logger.getLevel()` returns expected level

2. **Set level**: Changes log level dynamically
   - Set level to ERROR
   - Assert: Only ERROR logs output

**Mock Strategy**:

```typescript
// Mock console methods
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

// Mock environment
vi.stubEnv('NODE_ENV', 'development');
vi.stubEnv('LOG_LEVEL', 'debug');
```

**Key Patterns to Demonstrate**:

- Testing console output
- Testing environment-aware behavior
- Testing data sanitization (security)
- Testing class methods and state
- Testing child/parent relationships

---

#### 6.2 Context Utilities (`lib/logging/context.ts`)

**File**: `tests/unit/logging/context.test.ts`

**Dependencies to Mock**:

- `next/headers` - Mock headers()
- `@/lib/auth/config` - Mock auth.api.getSession()
- `nanoid` - Mock ID generation (optional)

**Test Cases**:

##### `generateRequestId()`

1. **Generates ID**: Returns 16-character string
   - Call function
   - Assert: Returns string of length 16

2. **Unique IDs**: Generates different IDs
   - Call multiple times
   - Assert: IDs are different

##### `getRequestId()`

1. **Existing ID**: Returns ID from headers
   - Mock headers with 'x-request-id'
   - Assert: Returns existing ID

2. **No ID**: Generates new ID
   - Mock headers without 'x-request-id'
   - Assert: Returns generated ID

##### `getRequestContext()`

1. **Full context**: Extracts request information
   - Mock Request with method, url, headers
   - Assert: Returns `{ requestId, method, url, userAgent }`

2. **Minimal context**: Works without request object
   - Call without request parameter
   - Assert: Returns `{ requestId }`

##### `getUserContext()`

1. **Authenticated user**: Returns user info
   - Mock auth.api.getSession() with session
   - Assert: Returns `{ userId, sessionId, email }`

2. **Not authenticated**: Returns empty object
   - Mock auth.api.getSession() to return null
   - Assert: Returns `{}`

3. **Auth error**: Handles errors gracefully
   - Mock auth.api.getSession() to throw
   - Assert: Returns `{}` (doesn't throw)

##### `getFullContext()`

1. **Combined context**: Merges request and user context
   - Mock both request and auth
   - Assert: Returns combined object

2. **Partial auth**: Works when not authenticated
   - Mock auth to return null
   - Assert: Returns request context only

##### `getEndpointPath()`

1. **Extracts path**: Returns pathname without query
   - Input: Request with URL '/api/users?page=1'
   - Assert: Returns '/api/users'

2. **Handles errors**: Fallback to full URL
   - Input: Invalid URL
   - Assert: Returns request.url

##### `getClientIp()`

1. **Forwarded IP**: Extracts from x-forwarded-for
   - Mock headers with 'x-forwarded-for: 1.2.3.4, 5.6.7.8'
   - Assert: Returns '1.2.3.4' (first IP)

2. **Real IP**: Checks x-real-ip
   - Mock headers with 'x-real-ip: 1.2.3.4'
   - Assert: Returns '1.2.3.4'

3. **Cloudflare**: Checks cf-connecting-ip
   - Mock headers with 'cf-connecting-ip: 1.2.3.4'
   - Assert: Returns '1.2.3.4'

4. **No IP**: Returns undefined
   - Mock headers without IP headers
   - Assert: Returns undefined

5. **Header priority**: Uses first available header
   - Mock multiple IP headers
   - Assert: Uses x-forwarded-for first

**Mock Strategy**:

```typescript
vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({
    get: vi.fn((header) => {
      const headers = { 'x-request-id': '123' };
      return headers[header];
    }),
  })),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));
```

**Key Patterns to Demonstrate**:

- Mocking Next.js server-only modules
- Testing async context extraction
- Testing error handling (try/catch)
- Testing header parsing logic
- Testing fallback behaviors

---

## Setup and Configuration

### 1. Vitest Configuration (`vitest.config.ts`)

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/', '*.config.{js,ts}', '.next/', 'dist/'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

**Key Features**:

- React plugin for JSX/TSX support
- jsdom environment for DOM testing
- Path alias resolution matching tsconfig.json
- Coverage configuration
- Global test APIs (describe, it, expect)

---

### 2. Test Setup File (`tests/setup.ts`)

```typescript
import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Clean up after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock Next.js modules globally
vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({
    get: vi.fn(),
  })),
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Suppress console errors in tests (optional)
// global.console = {
//   ...console,
//   error: vi.fn(),
//   warn: vi.fn(),
// };
```

**Purpose**:

- Import Testing Library matchers
- Set up global cleanup
- Mock Next.js server-only modules
- Configure test environment

---

### 3. Mock Helpers

#### Auth Mocks (`tests/helpers/mocks/auth.ts`)

```typescript
import { vi } from 'vitest';

export const mockSession = {
  session: {
    id: 'session-123',
    userId: 'user-123',
    token: 'token-abc',
    expiresAt: new Date('2025-12-31'),
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
  user: {
    id: 'user-123',
    name: 'John Doe',
    email: 'john@example.com',
    emailVerified: true,
    image: null,
    role: 'USER',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
};

export const mockAdminSession = {
  ...mockSession,
  user: {
    ...mockSession.user,
    role: 'ADMIN',
  },
};

export function mockAuth(returnValue: any = mockSession) {
  vi.mock('@/lib/auth/config', () => ({
    auth: {
      api: {
        getSession: vi.fn(() => Promise.resolve(returnValue)),
      },
    },
  }));
}
```

#### Database Mocks (`tests/helpers/mocks/database.ts`)

```typescript
import { vi } from 'vitest';

export const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  session: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $disconnect: vi.fn(),
  $transaction: vi.fn((callback) => callback(mockPrisma)),
};

export function mockDatabase() {
  vi.mock('@/lib/db/client', () => ({
    prisma: mockPrisma,
  }));
}
```

#### Next.js Mocks (`tests/helpers/mocks/next.ts`)

```typescript
import { vi } from 'vitest';

export function mockHeaders(headers: Record<string, string> = {}) {
  return vi.fn(() => ({
    get: (name: string) => headers[name] || null,
  }));
}

export function mockCookies(cookies: Record<string, string> = {}) {
  return vi.fn(() => ({
    get: (name: string) => cookies[name] || null,
    set: vi.fn(),
  }));
}
```

---

### 4. Data Factories

#### User Factory (`tests/helpers/factories/user.ts`)

```typescript
export function createMockUser(overrides = {}) {
  return {
    id: 'user-123',
    name: 'John Doe',
    email: 'john@example.com',
    emailVerified: true,
    image: null,
    role: 'USER',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

export function createMockUsers(count: number) {
  return Array.from({ length: count }, (_, i) =>
    createMockUser({
      id: `user-${i}`,
      email: `user${i}@example.com`,
      name: `User ${i}`,
    })
  );
}
```

---

## Dependencies to Install

Run this command to install missing test dependencies:

```bash
npm install -D vitest @vitest/ui @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react
```

**Packages**:

- `vitest` - Test runner (already in package.json scripts)
- `@vitest/ui` - Web UI for test results
- `@testing-library/react` - React testing utilities
- `@testing-library/jest-dom` - DOM matchers (toBeInTheDocument, etc.)
- `@testing-library/user-event` - User interaction simulation
- `jsdom` - DOM implementation for Node
- `@vitejs/plugin-react` - React support for Vitest

---

## Priority Test Implementation Order

Based on the Phase 2.4 requirements ("example unit tests"), implement in this order:

### Week 1: Foundation & Setup

1. **Setup** (1-2 hours)
   - Install dependencies
   - Create `vitest.config.ts`
   - Create `tests/setup.ts`
   - Create mock helpers

2. **Validation Tests** (4-6 hours)
   - `tests/unit/validations/auth.test.ts` - Password, email, sign-up validation
   - `tests/unit/validations/common.test.ts` - CUID, pagination, sorting
   - **Rationale**: Pure functions, no mocks needed, easy to start

3. **Utility Tests** (2-3 hours)
   - `tests/unit/utils/password-strength.test.ts` - Password strength algorithm
   - `tests/unit/utils/utils.test.ts` - Tailwind cn() utility
   - **Rationale**: Pure functions, demonstrates testing patterns

### Week 2: API & Core Logic

4. **API Response Tests** (3-4 hours)
   - `tests/unit/api/responses.test.ts` - Success, error, pagination responses
   - **Rationale**: Core API patterns, no complex mocks

5. **API Error Tests** (4-5 hours)
   - `tests/unit/api/errors.test.ts` - Error classes, handleAPIError, Prisma errors
   - **Rationale**: Critical error handling logic, demonstrates mocking

6. **API Validation Tests** (3-4 hours)
   - `tests/unit/api/validation.test.ts` - Request body, query params, pagination
   - **Rationale**: Request validation patterns

### Week 3: Auth & Database

7. **Auth Utility Tests** (5-6 hours)
   - `tests/unit/auth/utils.test.ts` - Session, user, role checking, requireAuth
   - **Rationale**: Critical authentication logic, demonstrates Next.js mocking

8. **Database Utility Tests** (2-3 hours)
   - `tests/unit/db/utils.test.ts` - Connection checks, health, transactions
   - **Rationale**: Database patterns, Prisma mocking

9. **Logging Tests** (4-5 hours)
   - `tests/unit/logging/logger.test.ts` - Logger class, sanitization, formatting
   - `tests/unit/logging/context.test.ts` - Context extraction, IP detection
   - **Rationale**: Complex logic, environment-aware behavior

### Week 4: Polish & Documentation

10. **Integration Test Example** (2-3 hours)
    - `tests/integration/api/health.test.ts` - Example integration test
    - **Rationale**: Demonstrates integration testing pattern

11. **Documentation** (2-3 hours)
    - Create `.context/testing/overview.md`
    - Document patterns and best practices
    - Update CLAUDE.md with testing guidance

**Total Estimated Time**: 32-45 hours

---

## Success Criteria

The Phase 2.4 implementation is complete when:

1. **Infrastructure**:
   - [ ] Vitest configured and running
   - [ ] Test scripts work (`npm test`, `npm run test:watch`, `npm run test:coverage`)
   - [ ] Coverage reporting functional

2. **Example Tests**:
   - [ ] At least 3 validation schema test files (auth, user, common)
   - [ ] At least 2 utility test files (password-strength, utils)
   - [ ] At least 3 API test files (responses, errors, validation)
   - [ ] At least 1 auth test file (utils)
   - [ ] At least 1 database test file (utils)
   - [ ] At least 1 logging test file (logger)
   - [ ] At least 1 integration test (health endpoint)

3. **Quality**:
   - [ ] All tests pass
   - [ ] Tests demonstrate proper mocking patterns
   - [ ] Tests are well-documented with comments
   - [ ] Edge cases covered (error handling, validation, etc.)
   - [ ] No failing or skipped tests

4. **Documentation**:
   - [ ] Testing patterns documented in `.context/testing/`
   - [ ] Mock strategies explained
   - [ ] Examples for common scenarios

---

## Key Testing Patterns to Demonstrate

1. **Mocking Next.js Modules**:
   - `next/headers` (headers, cookies)
   - `next/navigation` (useRouter, usePathname)
   - Server Components patterns

2. **Mocking External Dependencies**:
   - Prisma client (database operations)
   - better-auth (authentication)
   - Logger (structured logging)

3. **Testing Async Code**:
   - Promises and async/await
   - Error handling in async functions
   - Concurrent async operations

4. **Testing Validation**:
   - Zod schemas (success and failure)
   - Error message extraction
   - Custom refinements

5. **Testing Error Handling**:
   - Custom error classes
   - Error transformation
   - Environment-aware error details

6. **Testing Pure Functions**:
   - Password strength calculation
   - Utility functions
   - Data transformations

7. **Testing API Utilities**:
   - Response formatting
   - Request validation
   - Pagination logic

---

## Notes for AI Implementation

When implementing these tests:

1. **Start Simple**: Begin with validation tests (pure functions, no mocks)
2. **Build Incrementally**: Add one test file at a time, ensure it passes
3. **Use Factories**: Create data factories to reduce duplication
4. **Document Patterns**: Add comments explaining mock strategies
5. **Test Edge Cases**: Don't just test happy paths
6. **Keep Tests Isolated**: Each test should be independent
7. **Use Descriptive Names**: Test names should explain the scenario
8. **Follow AAA Pattern**: Arrange, Act, Assert in every test
9. **Mock Sparingly**: Only mock what you need to
10. **Verify Mocks**: Assert that mocks are called correctly

---

## Future Enhancements (Phase 4+)

These are NOT part of Phase 2.4 but should be documented for future work:

- Component tests (React components with Testing Library)
- Integration tests for API routes (with test database)
- E2E tests with Playwright
- Visual regression tests
- Performance tests
- Load tests for API endpoints
- Mutation testing (Stryker)
- Contract testing for external APIs

---

## Conclusion

This test plan provides a comprehensive roadmap for implementing unit tests in the Sunrise project. The focus is on **quality over quantity** - creating well-crafted example tests that serve as patterns for future development.

The tests prioritize:

- **Critical paths**: Authentication, validation, error handling
- **Complex logic**: Password strength, logging, error transformation
- **Common patterns**: API responses, request validation, database utilities

By following this plan, the Sunrise template will have a solid testing foundation that demonstrates best practices and makes it easy for developers to add tests for new features.
