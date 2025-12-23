# Test Implementation Priority Guide

When implementing Phase 2.4 or adding tests to new features, follow this priority order to maximize value and build confidence incrementally.

## Priority Matrix

| Priority | Complexity | Files | Est. Time | Why This Order                          |
| -------- | ---------- | ----- | --------- | --------------------------------------- |
| 1        | Simple     | 3     | 2-3h      | Mission-critical validation, no mocking |
| 2        | Simple     | 2     | 1-2h      | Pure functions, quick wins              |
| 3        | Medium     | 4     | 4-5h      | Core infrastructure, moderate mocking   |
| 4        | Medium     | 1     | 2-3h      | Security-critical PII scrubbing         |
| 5        | Complex    | 1     | 4-5h      | Security-sensitive, builds on API utils |
| 6        | Complex    | 3     | 8-10h     | Full integration, most realistic tests  |
| 7        | Medium     | 2     | 4-5h      | UI behavior, less critical than logic   |

**Total Estimated Time**: 25-33 hours (3-4 days)

## Priority 1: Validation Schemas (Simple - 2-3 hours)

**Files to Test:**

- `lib/validations/auth.ts` → `__tests__/lib/validations/auth.test.ts`
- `lib/validations/user.ts` → `__tests__/lib/validations/user.test.ts`
- `lib/validations/common.ts` → `__tests__/lib/validations/common.test.ts`

**Why First:**

- Mission-critical input validation (security)
- Pure functions (no mocking needed)
- Easy wins that build confidence
- Foundation for all API tests

**Test Coverage:**

- Password schema: 10+ test cases (uppercase, lowercase, special char, length)
- Email schema: Normalization, trimming, validation
- Signup schema: Custom refinements (password matching)
- Pagination schema: Defaults, clamping, coercion
- All Zod schemas: Valid and invalid inputs

**Template**: See `templates/simple.md`

**Success**: 95%+ coverage, all tests passing

---

## Priority 2: Utilities (Simple - 1-2 hours)

**Files to Test:**

- `lib/utils/password-strength.ts` → `__tests__/lib/utils/password-strength.test.ts`
- `lib/db/utils.ts` → `__tests__/lib/db/utils.test.ts`

**Why Second:**

- Pure functions with clear input/output
- No external dependencies
- Builds test-writing momentum

**Test Coverage:**

- Password strength: All scoring criteria (length, variety, penalties)
- Database health check: Connected and disconnected states
- Transaction wrapper: Successful and failed transactions

**Template**: See `templates/simple.md`

**Success**: 85%+ coverage, all edge cases tested

---

## Priority 3: API Utilities (Medium - 4-5 hours)

**Files to Test:**

- `lib/api/validation.ts` → `__tests__/lib/api/validation.test.ts`
- `lib/api/errors.ts` → `__tests__/lib/api/errors.test.ts`
- `lib/api/responses.ts` → `__tests__/lib/api/responses.test.ts`
- `lib/api/client.ts` → `__tests__/lib/api/client.test.ts`

**Why Third:**

- Core infrastructure used by all API routes
- Moderate mocking (NextRequest, Zod)
- Critical for API route tests (Priority 6)

**Test Coverage:**

- Request validation: Valid JSON, malformed JSON, Zod errors
- Error handling: Prisma errors (P2002, P2025, P2003), Zod transforms
- Response formatters: Success, error, pagination metadata
- API client: GET/POST/PATCH/DELETE with error handling

**Template**: See `templates/medium.md`

**Mocking**: `NextRequest`, `URLSearchParams`, structured logger

**Success**: 85%+ coverage, all error paths tested

---

## Priority 4: Error Handler (Medium - 2-3 hours)

**Files to Test:**

- `lib/errors/handler.ts` → `__tests__/lib/errors/handler.test.ts`

**Why Fourth:**

- Security-critical (PII scrubbing)
- Complex edge cases (various error types)
- Used throughout application

**Test Coverage:**

- Error normalization: Error objects, strings, objects, primitives
- PII scrubbing: Sensitive field names (password, token, secret)
- Recursive scrubbing: Nested objects and arrays
- Error fingerprinting: Deduplication logic
- Sentry integration: Error tracking

**Template**: See `templates/medium.md`

**Mocking**: Structured logger, Sentry client

**Success**: 90%+ coverage (security-critical)

---

## Priority 5: Auth Utilities (Complex - 4-5 hours)

**Files to Test:**

- `lib/auth/utils.ts` → `__tests__/lib/auth/utils.test.ts`

**Why Fifth:**

- Security-sensitive (session management, authorization)
- 6 functions to test (`getServerSession`, `getServerUser`, `hasRole`, `requireAuth`, `requireRole`, `isAuthenticated`)
- Requires better-auth mocking
- Builds on API utilities (error handling)

**Test Coverage:**

- `getServerSession`: Authenticated, unauthenticated, error handling
- `getServerUser`: Extract user from session, null handling
- `hasRole`: Role matching, unauthenticated, null roles
- `requireAuth`: Throws when unauthenticated
- `requireRole`: Throws when wrong role
- `isAuthenticated`: Type guard behavior

**Template**: See `templates/medium.md`

**Mocking**: See `mocking/better-auth.md`

**Success**: 90%+ coverage (auth-critical)

---

## Priority 6: API Endpoints (Complex - 8-10 hours)

**Files to Test:**

- `app/api/v1/users/route.ts` → `__tests__/app/api/v1/users/route.test.ts`
- `app/api/v1/users/[id]/route.ts` → `__tests__/app/api/v1/users/[id]/route.test.ts`
- `app/api/v1/users/me/route.ts` → `__tests__/app/api/v1/users/me/route.test.ts`

**Why Sixth:**

- Full-stack integration testing
- Requires database + auth setup (Testcontainers)
- Most realistic tests (HTTP lifecycle)
- Builds on all previous tests

**Test Coverage:**

**GET /api/v1/users:**

- Authenticated admin: Paginated results
- Unauthenticated: 401 error
- Non-admin: 403 error
- Pagination: Multiple pages work
- Sorting: Order by different fields
- Searching: Filter by name/email

**POST /api/v1/users:**

- Admin creates user: 201 success
- Duplicate email: 400 error
- Invalid data: 400 validation error
- Non-admin: 403 error

**GET /api/v1/users/:id:**

- Admin views any user: 200 success
- User views own profile: 200 success
- User views other profile: 403 error
- Invalid CUID: 400 error
- User not found: 404 error

**DELETE /api/v1/users/:id:**

- Admin deletes user: 200 success
- Admin deletes self: 400 error
- User deletes self: 403 error
- Cascades to sessions/accounts

**GET /api/v1/users/me:**

- Authenticated user: 200 with profile
- Unauthenticated: 401 error

**PATCH /api/v1/users/me:**

- Update name: 200 success
- Update email: 200 success
- Duplicate email: 400 error

**Template**: See `templates/complex.md`

**Setup**: Testcontainers + real PostgreSQL

**Success**: 80%+ coverage, all CRUD operations tested

---

## Priority 7: Components (Medium - 4-5 hours)

**Files to Test:**

- `components/forms/login-form.tsx` → `__tests__/components/forms/login-form.test.tsx`
- `components/forms/signup-form.tsx` → `__tests__/components/forms/signup-form.test.tsx`

**Why Last:**

- UI behavior (less critical than business logic)
- Requires React Testing Library setup
- Builds on auth mocking

**Test Coverage:**

**LoginForm:**

- Renders fields: Email, password, submit button
- User can type: Input values update
- Validation: Email format, required fields
- Submission: Calls `authClient.signIn.email()`
- Loading state: Button disabled during submit
- Error state: Shows error message

**SignupForm:**

- Renders fields: Name, email, password, confirm password
- Password strength: Updates in real-time
- Validation: Password matching, email format
- Submission: Calls `authClient.signUp.email()`
- Loading state: Form disabled during submit
- Error state: Shows validation/API errors

**Template**: See `templates/component.md`

**Mocking**: See `mocking/nextjs.md`, `mocking/better-auth.md`

**Success**: 70%+ coverage (focus on critical user paths)

---

## Quick Reference: Test by Complexity

### Simple (No Mocking)

1. Validation schemas (Priority 1)
2. Utilities (Priority 2)

### Medium (Mock Dependencies)

3. API utilities (Priority 3)
4. Error handler (Priority 4)
5. Components (Priority 7)

### Complex (Real Database)

5. Auth utilities (Priority 5) - Mock better-auth
6. API endpoints (Priority 6) - Testcontainers

---

## Verification After Each Priority

```bash
# Run tests for current priority
npm test -- __tests__/lib/validations

# Check coverage
npm run test:coverage

# Verify threshold met
# Priority 1: 95%+
# Priority 2: 85%+
# Priority 3: 85%+
# Priority 4: 90%+
# Priority 5: 90%+
# Priority 6: 80%+
# Priority 7: 70%+
```

---

## Related Files

- **Templates**: See `templates/` for test structure examples
- **Mocking**: See `mocking/` for dependency mocking strategies
- **Success Criteria**: See `success-criteria.md` for coverage thresholds
