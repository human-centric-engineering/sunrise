# Phase 2.4 Testing Framework - Implementation Plan

**Last Updated**: 2025-12-26
**Status**: Planning
**Dependencies**: Phase 2.3 Complete (Error Handling & Logging)

## Overview

This document outlines the complete implementation plan for Phase 2.4: Testing Framework. The goal is to establish a comprehensive, maintainable testing infrastructure using Vitest with Next.js 16, React 19, and Prisma 7 compatibility.

## Objectives

1. **Establish Testing Infrastructure**: Set up Vitest with proper Next.js 16 and React 19 support
2. **Create Test Utilities**: Build reusable helpers for database, auth, API mocking
3. **Document Testing Patterns**: Comprehensive guide for writing different test types
4. **Implement Example Tests**: Cover critical paths with real-world examples
5. **Configure Coverage Reporting**: Set up meaningful coverage metrics and thresholds
6. **Integrate with CI/CD**: Ensure tests run in pre-push hooks and CI pipelines

## Documentation Structure

Following the `.context/` substrate pattern, testing documentation will be organized as:

```
.context/testing/
├── overview.md           # Testing philosophy, patterns, quick start (500-700 lines)
├── setup.md              # Configuration, installation, troubleshooting (400-500 lines)
├── patterns.md           # Writing tests: unit, integration, e2e patterns (600-800 lines)
└── mocking.md            # Mock strategies: database, auth, Next.js modules (500-600 lines)
```

**Total**: ~2000-2700 lines of comprehensive testing documentation

### 1. Testing Documentation Plan

#### `.context/testing/overview.md`

**Purpose**: High-level testing strategy, philosophy, and quick start guide

**Contents** (~500-700 lines):

1. **Testing Philosophy** (50-75 lines)
   - Test pyramid approach (unit > integration > e2e)
   - What to test vs. what not to test
   - Focus on behavior, not implementation details
   - Balance between speed and confidence
   - Test-driven development (TDD) guidelines

2. **Test Types and When to Use Them** (100-150 lines)
   - **Unit Tests**: Pure functions, utilities, validation schemas
     - Examples: Zod schema validation, formatters, helpers
     - When: Testing isolated logic without dependencies
   - **Integration Tests**: API endpoints, database operations, auth flows
     - Examples: POST /api/v1/users, user creation flow, session management
     - When: Testing components working together
   - **Component Tests**: React components with Testing Library
     - Examples: Forms, error boundaries, layouts
     - When: Testing UI behavior and user interactions
   - **E2E Tests** (Optional/Future): Full user flows with Playwright
     - Examples: Sign up → email verification → dashboard
     - When: Critical user journeys (defer to later phase)

3. **Quick Start Guide** (150-200 lines)
   - Running tests: `npm test`, `npm run test:watch`, `npm run test:coverage`
   - File organization and naming conventions
   - Writing your first test (step-by-step example)
   - Debugging tests (VSCode integration, console output)
   - Common commands reference

4. **Project-Specific Patterns** (150-200 lines)
   - Testing Next.js 16 Server Components
   - Testing Server Actions
   - Testing API routes with standardized responses
   - Testing with better-auth sessions
   - Testing Prisma 7 database operations
   - Testing error boundaries and error handlers

5. **Coverage Guidelines** (50-75 lines)
   - Critical paths requiring 100% coverage (auth, validation, security)
   - Standard paths aiming for 80%+ (API endpoints, business logic)
   - Lower priority areas (60%+ acceptable for UI components)
   - Coverage reporting and thresholds
   - What coverage doesn't measure (quality, edge cases)

6. **Testing Checklist** (25-50 lines)
   - Pre-PR checklist: tests pass, coverage maintained, new tests added
   - What to test for new features
   - Regression test guidelines

**Cross-references**:

- `.context/testing/patterns.md` for detailed test examples
- `.context/testing/mocking.md` for mock strategies
- `.context/errors/overview.md` for error handling integration
- `.context/api/endpoints.md` for API testing patterns

---

#### `.context/testing/setup.md`

**Purpose**: Installation, configuration, and troubleshooting

**Contents** (~400-500 lines):

1. **Installation** (50-75 lines)
   - Dependencies to install (Vitest, Testing Library, jsdom)
   - Version compatibility (Next.js 16, React 19, Prisma 7)
   - Installation commands with explanations

2. **Vitest Configuration** (150-200 lines)
   - `vitest.config.ts` complete breakdown
   - Next.js path alias resolution (`@/`)
   - React 19 and jsdom setup
   - Global setup/teardown hooks
   - Mock resolution for Next.js modules
   - Environment variables for tests
   - Coverage configuration (exclude patterns, reporters)

3. **Test Setup Files** (100-150 lines)
   - `tests/setup.ts` - global test configuration
   - Testing Library matchers (`@testing-library/jest-dom`)
   - Mock implementations for Next.js modules (next/navigation, next/headers)
   - Environment variable setup for tests
   - Database connection configuration

4. **Test Utilities Setup** (50-75 lines)
   - Custom render function with providers
   - Database test helpers (seed, cleanup, factories)
   - Auth helpers (createMockSession, createMockUser)
   - API test helpers (createTestRequest, parseTestResponse)

5. **VSCode Integration** (25-50 lines)
   - Recommended extensions (Vitest extension)
   - Debug configuration for tests
   - Running individual tests from UI

6. **Troubleshooting** (75-100 lines)
   - Common errors and solutions
   - Path alias resolution issues
   - Mock resolution failures
   - Database connection problems
   - React 19 compatibility issues
   - Performance: slow test suites

**Code Examples**:

- Complete `vitest.config.ts` with inline comments
- `tests/setup.ts` with all matchers and mocks
- VSCode `launch.json` for test debugging

---

#### `.context/testing/patterns.md`

**Purpose**: Detailed examples of writing different test types

**Contents** (~600-800 lines):

1. **General Testing Principles** (50-75 lines)
   - Arrange-Act-Assert (AAA) pattern
   - Test naming: `should [expected behavior] when [condition]`
   - One assertion per test (when practical)
   - Test independence (no shared state)
   - Meaningful variable names
   - Comments for complex logic

2. **Unit Test Patterns** (100-150 lines)
   - **Validation Schemas** (Zod)
     - Testing valid input
     - Testing validation errors
     - Testing edge cases (empty, null, malformed)
     - Example: `tests/unit/validations/user.test.ts`
   - **Utility Functions**
     - Pure functions (formatters, parsers, calculators)
     - Example: `tests/unit/utils/format.test.ts`
   - **Type Guards and Assertions**

3. **API Route Testing** (150-200 lines)
   - **GET Endpoints**
     - Happy path: successful retrieval
     - Error cases: not found, unauthorized
     - Query parameters and filtering
     - Example: `tests/integration/api/users/list.test.ts`
   - **POST Endpoints**
     - Valid data creation
     - Validation errors (missing fields, invalid format)
     - Duplicate detection (unique constraints)
     - Example: `tests/integration/api/users/create.test.ts`
   - **PATCH/PUT Endpoints**
     - Partial updates
     - Authorization (only own resources)
     - Example: `tests/integration/api/users/update.test.ts`
   - **DELETE Endpoints**
     - Successful deletion
     - Authorization checks
     - Cascade behavior
   - **Standardized Response Testing**
     - Verify `{ success, data, error }` format
     - Check error codes and messages

4. **Database Testing** (100-150 lines)
   - **Setup and Teardown**
     - `beforeEach` and `afterEach` patterns
     - Database cleanup strategies
     - Test data seeding
   - **CRUD Operations**
     - Create with valid data
     - Read operations (findUnique, findMany)
     - Update operations
     - Delete and cascade
   - **Constraint Testing**
     - Unique constraints
     - Foreign key constraints
     - Required fields
   - **Transaction Testing**
     - Rollback on failure
   - **Example**: `tests/integration/db/user-repository.test.ts`

5. **Component Testing** (100-150 lines)
   - **Server Components**
     - Testing async components
     - Mocking server-only modules
     - Example: `tests/unit/components/user-list.test.tsx`
   - **Client Components**
     - Rendering tests
     - User interaction (clicks, form inputs)
     - State changes
     - Example: `tests/unit/components/login-form.test.tsx`
   - **Form Testing**
     - Initial render
     - Validation errors
     - Successful submission
     - Loading states
   - **Error Boundaries**
     - Triggering errors
     - Fallback UI rendering

6. **Authentication Testing** (75-100 lines)
   - Creating mock sessions
   - Testing protected routes
   - Testing auth middleware
   - Login/logout flows
   - Example: `tests/integration/auth/session.test.ts`

7. **Async/Promise Testing** (25-50 lines)
   - Using `async/await` in tests
   - Testing promise rejections
   - Timeout handling with `waitFor`

8. **Snapshot Testing** (25-50 lines)
   - When to use snapshots (rarely)
   - Avoiding brittle tests
   - Reviewing snapshot changes

**Each section includes**:

- Complete code example
- Explanation of what's being tested
- Common pitfalls to avoid
- Variations for different scenarios

---

#### `.context/testing/mocking.md`

**Purpose**: Comprehensive mock strategies for all dependencies

**Contents** (~500-600 lines):

1. **Mocking Philosophy** (50-75 lines)
   - What to mock vs. what to use real implementations
   - Mock levels: module mocks, function spies, test doubles
   - Avoiding over-mocking (integration > unit for most cases)
   - When to use real database vs. mocks

2. **Next.js Module Mocking** (100-150 lines)
   - **next/navigation**
     - useRouter, usePathname, useSearchParams
     - redirect, notFound
     - Example setup in `tests/setup.ts`
   - **next/headers**
     - cookies(), headers()
     - Mocking for Server Components
   - **next/cache**
     - revalidatePath, revalidateTag
   - **Server Actions**
     - Direct import and testing
     - Form submission simulation

3. **Database Mocking** (150-200 lines)
   - **Prisma Client Mocking** (for unit tests)
     - Using `vi.mock` with Prisma
     - Mocking individual operations (findUnique, create, etc.)
     - Type-safe mocks with Vitest
     - Example: `tests/mocks/prisma.ts`
   - **Test Database** (for integration tests)
     - Using a real database for integration tests
     - Database seeding strategies
     - Cleanup between tests
     - Transaction rollback pattern
     - Example: `tests/helpers/db.ts`
   - **Mock Data Factories**
     - Creating realistic test data
     - Faker.js integration (optional)
     - Factory functions for models
     - Example: `tests/factories/user.ts`

4. **Authentication Mocking** (75-100 lines)
   - **Session Mocking**
     - Creating mock better-auth sessions
     - Mocking `getServerSession()`
     - Setting up authenticated test requests
     - Example: `tests/helpers/auth.ts`
   - **User Mocking**
     - Mock user objects
     - Different roles and permissions

5. **External API Mocking** (50-75 lines)
   - Mocking fetch calls
   - Using Mock Service Worker (MSW) - optional
   - Testing error scenarios (timeouts, network failures)

6. **Environment Variable Mocking** (25-50 lines)
   - Overriding `process.env` in tests
   - Testing with different configurations

7. **Date/Time Mocking** (25-50 lines)
   - Using `vi.useFakeTimers()`
   - Testing time-dependent logic
   - Restoring real timers

8. **Email Mocking** (25-50 lines)
   - Mocking Resend API
   - Capturing sent emails
   - Verifying email content

9. **File System Mocking** (25-50 lines)
   - Mocking file uploads
   - Testing file-based operations

**Each section includes**:

- Setup code
- Usage examples
- Reset/cleanup patterns
- Type safety considerations

---

### 2. Coverage Reporting Plan

#### Coverage Tools and Configuration

**Tool**: Vitest built-in coverage with `@vitest/coverage-v8`

**Configuration in `vitest.config.ts`**:

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html', 'lcov'],
  reportsDirectory: './coverage',
  exclude: [
    'node_modules/**',
    '.next/**',
    'dist/**',
    'coverage/**',
    'tests/**',
    '**/*.config.{ts,js}',
    '**/*.d.ts',
    'types/**',
    'prisma/seed.ts',
    'emails/**', // Email templates (tested manually/visually)
  ],
  include: [
    'app/**/*.{ts,tsx}',
    'lib/**/*.{ts,tsx}',
    'components/**/*.{ts,tsx}',
  ],
  thresholds: {
    // Global thresholds (enforced)
    lines: 70,
    functions: 70,
    branches: 70,
    statements: 70,
  },
}
```

#### Coverage Thresholds by Domain

**Critical Paths (100% coverage required)**:

- `lib/auth/` - Authentication utilities
- `lib/validations/` - All Zod schemas
- `lib/security/` - Rate limiting, sanitization, CORS
- `lib/api/errors.ts` - Error handling
- `lib/api/responses.ts` - Response formatters

**Standard Paths (80%+ coverage target)**:

- `app/api/v1/` - All API endpoints
- `lib/db/` - Database utilities
- `lib/logging/` - Logging system
- `lib/errors/` - Error handlers

**Lower Priority (60%+ acceptable)**:

- `components/ui/` - shadcn/ui components (mostly third-party)
- `components/layouts/` - Layout components (visual, tested manually)
- `app/(auth)/`, `app/(protected)/`, `app/(public)/` - Page components

**Excluded from Coverage**:

- Configuration files (`*.config.ts`)
- Type definitions (`*.d.ts`, `types/**`)
- Seed scripts (`prisma/seed.ts`)
- Email templates (`emails/**`) - visual testing
- Build artifacts (`.next/`, `dist/`)

#### Coverage Reporting Formats

1. **Text** (terminal output during test runs)
   - Quick overview of coverage percentages
   - Color-coded: red (<70%), yellow (70-80%), green (>80%)

2. **HTML** (detailed interactive report)
   - Open `coverage/index.html` in browser
   - Line-by-line coverage visualization
   - Drill down into files and functions

3. **JSON** (machine-readable for CI/CD)
   - `coverage/coverage-final.json`
   - Used by code coverage badges and reporting tools

4. **LCOV** (standard format for integration)
   - `coverage/lcov.info`
   - Compatible with SonarQube, Codecov, Coveralls

#### Coverage Scripts in `package.json`

```json
{
  "scripts": {
    "test:coverage": "vitest run --coverage",
    "test:coverage:watch": "vitest watch --coverage",
    "test:coverage:ui": "vitest --ui --coverage",
    "test:coverage:open": "open coverage/index.html"
  }
}
```

#### What Coverage Doesn't Measure

**Important to document**:

- Coverage percentage ≠ test quality
- 100% coverage can still miss edge cases
- Coverage doesn't test error paths well
- Visual/UX issues not caught
- Performance regressions not detected
- Security vulnerabilities not guaranteed to be caught

**Recommended in documentation**:

- Focus on meaningful tests, not just coverage numbers
- Use mutation testing (optional, future enhancement)
- Combine with manual testing for UI/UX
- Security testing requires dedicated tools (penetration testing, SAST)

---

### 3. Testing Best Practices Documentation

#### Test Naming Conventions

**Pattern**: `should [expected behavior] when [condition]`

**Examples**:

```typescript
// Good ✅
it('should return user when valid ID provided', async () => { ... })
it('should throw 404 error when user not found', async () => { ... })
it('should validate email format when creating user', async () => { ... })

// Bad ❌
it('test user creation', async () => { ... })
it('works', async () => { ... })
it('returns data', async () => { ... })
```

#### File Organization

**Structure**:

```
tests/
├── setup.ts                    # Global test configuration
├── helpers/                    # Test utilities
│   ├── db.ts                   # Database helpers
│   ├── auth.ts                 # Auth helpers
│   ├── api.ts                  # API test helpers
│   └── render.tsx              # Custom render with providers
├── mocks/                      # Mock implementations
│   ├── prisma.ts               # Prisma client mock
│   ├── next-navigation.ts      # Next.js navigation mocks
│   └── resend.ts               # Email service mock
├── factories/                  # Test data factories
│   ├── user.ts                 # User factory
│   └── session.ts              # Session factory
├── unit/                       # Unit tests
│   ├── validations/
│   │   ├── auth.test.ts
│   │   └── user.test.ts
│   ├── utils/
│   │   └── format.test.ts
│   └── components/
│       ├── error-boundary.test.tsx
│       └── login-form.test.tsx
└── integration/                # Integration tests
    ├── api/
    │   ├── health.test.ts
    │   └── v1/
    │       └── users/
    │           ├── list.test.ts
    │           ├── create.test.ts
    │           ├── update.test.ts
    │           └── delete.test.ts
    ├── auth/
    │   └── session.test.ts
    └── db/
        └── user-repository.test.ts
```

**Naming Conventions**:

- Test files: `*.test.ts` or `*.test.tsx`
- Place next to source OR in `tests/` directory
- Mirror source structure in `tests/` for clarity

#### What to Test vs. What Not to Test

**DO Test**:

- Business logic and algorithms
- Validation rules (Zod schemas)
- API endpoints (all methods and edge cases)
- Error handling (catch blocks, error boundaries)
- Authentication/authorization logic
- Database operations (CRUD, constraints)
- Form behavior (validation, submission)
- Conditional rendering based on state
- User interactions (clicks, inputs, navigation)

**DON'T Test**:

- External library internals (React, Next.js, Prisma)
- Type definitions alone (TypeScript catches this)
- CSS styling (visual regression tools better suited)
- Static content (unchanged text, images)
- Third-party components (shadcn/ui already tested)
- Build configuration (unless custom logic added)

#### Testing Async/Server Components

**Next.js 16 Server Components**:

```typescript
// Server Component returns a Promise
import { render, screen } from '@testing-library/react';
import UserList from './UserList';

// Mock server-only modules
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
  headers: vi.fn(() => new Map()),
}));

describe('UserList Server Component', () => {
  it('should render user list', async () => {
    // Server Components are async
    const Component = await UserList({ limit: 10 });
    render(Component);

    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
```

**Server Actions**:

```typescript
import { createUser } from './actions';

describe('createUser Server Action', () => {
  it('should create user with valid data', async () => {
    const formData = new FormData();
    formData.append('name', 'John Doe');
    formData.append('email', 'john@example.com');

    const result = await createUser(formData);

    expect(result.success).toBe(true);
    expect(result.data.name).toBe('John Doe');
  });
});
```

---

### 4. CI/CD Integration

#### Pre-Push Git Hook

**Already configured in Husky** (`.husky/pre-push`):

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

npm run type-check && npm test
```

**Expected behavior**:

- Runs TypeScript type-check (~10s)
- Runs all tests (~5-20s depending on suite size)
- Blocks push if either fails
- Developer can bypass with `git push --no-verify` (emergency only)

#### GitHub Actions Workflow (Future)

**Placeholder for `.github/workflows/test.yml`**:

```yaml
name: Tests

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: sunrise_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run type check
        run: npm run type-check

      - name: Run tests
        run: npm run test:coverage
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/sunrise_test
          BETTER_AUTH_SECRET: test-secret-key
          BETTER_AUTH_URL: http://localhost:3000
          NODE_ENV: test

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          fail_ci_if_error: false
```

---

## Implementation Order

### Step 1: Install Dependencies

- Install Vitest, Testing Library, jsdom
- Install coverage provider (@vitest/coverage-v8)
- Update package.json scripts (already done)

### Step 2: Create Configuration

- Create `vitest.config.ts` with Next.js support
- Create `tests/setup.ts` with global mocks and matchers
- Configure path aliases and environment

### Step 3: Build Test Utilities

- `tests/helpers/db.ts` - Database helpers (seed, cleanup)
- `tests/helpers/auth.ts` - Auth helpers (createMockSession, createMockUser)
- `tests/helpers/api.ts` - API test helpers (request/response wrappers)
- `tests/helpers/render.tsx` - Custom render with providers
- `tests/mocks/prisma.ts` - Prisma client mock factory
- `tests/factories/user.ts` - User data factory

### Step 4: Write Example Tests

**Priority order**:

1. **Validation Tests** (easiest, establishes pattern)
   - `tests/unit/validations/auth.test.ts`
   - `tests/unit/validations/user.test.ts`
2. **API Endpoint Tests** (critical path)
   - `tests/integration/api/health.test.ts` (simplest)
   - `tests/integration/api/v1/users/list.test.ts`
   - `tests/integration/api/v1/users/create.test.ts`
3. **Component Tests** (UI coverage)
   - `tests/unit/components/error-boundary.test.tsx`
   - `tests/unit/components/login-form.test.tsx`
4. **Database Tests** (integration)
   - `tests/integration/db/user-repository.test.ts`

### Step 5: Write Documentation

**Order**:

1. `.context/testing/overview.md` (start here, sets philosophy)
2. `.context/testing/setup.md` (configuration reference)
3. `.context/testing/patterns.md` (detailed examples)
4. `.context/testing/mocking.md` (mock strategies)

### Step 6: Update Project Documentation

- Update `README.md` with testing section
- Update `.context/substrate.md` with testing domain entry
- Update `.context/guidelines.md` with testing workflow
- Update `BUILD-PROGRESS-TRACKER.md` with completion status

### Step 7: Run Coverage and Validate

- Run `npm run test:coverage`
- Review coverage report (HTML)
- Adjust thresholds if needed
- Document coverage gaps and future tests

---

## Success Criteria

**Phase 2.4 is complete when**:

- [ ] Vitest installed and configured with Next.js 16 + React 19 support
- [ ] All test utilities created and documented
- [ ] Minimum 15 example tests written covering:
  - [ ] 3+ validation tests (auth, user schemas)
  - [ ] 5+ API endpoint tests (health, users CRUD)
  - [ ] 3+ component tests (error boundary, forms)
  - [ ] 2+ database tests (user repository)
  - [ ] 2+ authentication tests (session management)
- [ ] All tests pass (`npm test` returns 0 exit code)
- [ ] Coverage reporting configured and working
- [ ] Coverage thresholds met (70%+ global coverage)
- [ ] Complete documentation in `.context/testing/` (4 files)
- [ ] Testing section added to `README.md`
- [ ] Pre-push hook includes test execution
- [ ] No known flaky tests
- [ ] Documentation reviewed and accurate

---

## Future Enhancements (Post-Phase 2.4)

**Not included in Phase 2.4, but documented for future**:

1. **End-to-End Testing with Playwright**
   - Full user flow testing (sign up → dashboard → settings)
   - Visual regression testing
   - Cross-browser testing

2. **Performance Testing**
   - API endpoint response time benchmarks
   - Database query performance tests
   - Frontend bundle size monitoring

3. **Mutation Testing**
   - Stryker or similar tool
   - Validate test effectiveness (tests that catch bugs)

4. **Visual Regression Testing**
   - Percy or Chromatic integration
   - Component screenshot comparison

5. **Advanced Mock Scenarios**
   - Mock Service Worker (MSW) for API mocking
   - Test database with realistic data volumes
   - Chaos engineering (simulated failures)

6. **CI/CD Enhancements**
   - Parallel test execution
   - Test result caching
   - Coverage badges in README
   - Automatic PR comments with coverage diff

---

## Notes for AI Implementation

When implementing this phase with Claude or another AI assistant:

1. **Start with documentation review**: Read existing `.context/` files to match style and depth
2. **Install dependencies first**: Ensure all tools work before writing tests
3. **One test type at a time**: Start with validation tests (simplest), then API, then components
4. **Test the tests**: Intentionally break code to verify tests catch the failure
5. **Documentation-first for complex topics**: Write mock strategy docs before implementing complex mocks
6. **Use real examples from codebase**: Reference actual schemas, API routes, components
7. **Cross-reference existing patterns**: Link to error handling, logging, API docs
8. **Validate coverage thresholds**: Adjust percentages based on actual achievable coverage
9. **Keep it practical**: Avoid over-engineering, focus on patterns developers will actually use

---

## Related Documentation

- [`.context/guidelines.md`](../.context/guidelines.md) - Current testing section (to be enhanced)
- [`.context/errors/overview.md`](../.context/errors/overview.md) - Error handling (testing integration)
- [`.context/api/endpoints.md`](../.context/api/endpoints.md) - API patterns (testing targets)
- [`.instructions/SUNRISE-BUILD-PLAN.md`](./SUNRISE-BUILD-PLAN.md) - Phase 2.4 requirements
- [`.instructions/BUILD-PROGRESS-TRACKER.md`](./BUILD-PROGRESS-TRACKER.md) - Progress tracking
