# Sunrise Test Suite

Quick reference for running and writing tests in the Sunrise project.

**For comprehensive testing documentation**, see [`.context/testing/`](../.context/testing/):

- **overview.md** - Testing philosophy, tech stack, test types
- **patterns.md** - Best practices, AAA structure, shared mocks
- **mocking.md** - Dependency mocking strategies
- **decisions.md** - Architectural rationale
- **history.md** - Key learnings and solutions

---

## Quick Start

```bash
# Run all tests
npm test

# Run tests in watch mode (recommended during development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests with UI
npm run test:ui

# Type-check + lint + tests (before committing)
npm run validate
```

---

## Directory Structure

```
tests/
├── README.md                       # This file
├── setup.ts                        # Global test setup and environment configuration
├── helpers/                        # Shared test utilities
│   └── assertions.ts               # Type-safe assertion helpers
├── types/                          # Shared mock type definitions
│   └── mocks.ts                    # Mock factories (createMockHeaders, createMockSession, delayed)
├── unit/                           # Unit tests (545+ tests)
│   ├── auth/                       # Authentication utilities
│   ├── validations/                # Zod schema validation
│   ├── utils/                      # General utilities
│   ├── api/                        # API response formatting, error handling
│   ├── db/                         # Database utilities
│   └── logging/                    # Structured logging
└── integration/                    # Integration tests (14+ tests)
    └── api/                        # API endpoint integration tests
```

---

## Testing Philosophy

- **Example-Driven**: Tests demonstrate best practices
- **Quality over Quantity**: Well-crafted tests that verify behavior
- **Test Behavior, Not Implementation**: Focus on outcomes, not internals
- **Mock at Boundaries**: Mock external systems (database, APIs), not business logic

**See** [`.context/testing/overview.md`](../.context/testing/overview.md) for comprehensive philosophy and rationale.

---

## Running Tests

### All Tests

```bash
npm test
```

### Specific Test File

```bash
npm test -- tests/unit/validations/auth.test.ts
```

### By Pattern

```bash
# Run all validation tests
npm test -- validations

# Run all API tests
npm test -- api
```

### Watch Mode

```bash
npm run test:watch
```

Changes to test files or source files trigger automatic re-runs.

### Coverage

```bash
npm run test:coverage
```

Generates coverage report in `coverage/` directory. Open `coverage/index.html` in browser for detailed view.

**Coverage Targets**:

- 80%+ overall coverage
- 90%+ for critical paths (authentication, validation, security)

---

## Writing Tests

### Import Shared Utilities

**CRITICAL**: Always use shared mock factories and type guards to prevent lint/type errors.

```typescript
// Import mock factories
import { createMockHeaders, createMockSession, delayed } from '@/tests/types/mocks';

// Import type-safe assertions
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

### Test Structure (AAA Pattern)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Feature Name', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Reset mocks before each test
  });

  it('should [expected behavior] when [condition]', () => {
    // Arrange: Set up test data and mocks
    const input = { name: 'Test' };

    // Act: Execute the function under test
    const result = functionUnderTest(input);

    // Assert: Verify the outcome
    expect(result).toEqual({ success: true });
  });
});
```

**See** [`.context/testing/patterns.md`](../.context/testing/patterns.md) for comprehensive patterns and examples.

---

## Mocking Dependencies

### Prisma (Database)

```typescript
import { createMockSession } from '@/tests/types/mocks';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';

vi.mocked(prisma.user.findUnique).mockResolvedValue({
  id: 'user-123',
  email: 'test@example.com',
  // ... other fields
});
```

### better-auth (Authentication)

```typescript
import { createMockSession } from '@/tests/types/mocks';

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

import { auth } from '@/lib/auth/config';

vi.mocked(auth.api.getSession).mockResolvedValue(
  createMockSession({ user: { id: 'user-123' } }) as any
);
```

### Next.js (Headers, Cookies, Navigation)

```typescript
import { createMockHeaders } from '@/tests/types/mocks';

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

import { headers } from 'next/headers';

vi.mocked(headers).mockResolvedValue(createMockHeaders({ 'x-request-id': 'test-123' }) as any);
```

**See** [`.context/testing/mocking.md`](../.context/testing/mocking.md) for complete mocking strategies.

---

## Critical Gotchas

### 1. Use Shared Mock Factories

**Always** import from `tests/types/mocks.ts` instead of creating inline mocks. This prevents recurring lint/type error cycles.

### 2. Use Type-Safe Assertions

Use `assertDefined()`, `assertHasProperty()`, and `parseJSON()` from `tests/helpers/assertions.ts` instead of non-null assertions (`!`).

### 3. ESLint Auto-Fix Won't Remove `async`

ESLint rule `@typescript-eslint/require-await` is disabled for test files. Your `async` keywords are safe.

### 4. Response.json() Type Safety

Always use `parseJSON<T>()` helper instead of direct `.json()` calls to maintain type safety.

### 5. Mock Setup Timing

Set environment variables BEFORE module imports in `setup.ts`, otherwise modules that validate env vars at import time will fail.

**See** [`.claude/skills/testing/gotchas.md`](../.claude/skills/testing/gotchas.md) for complete list with solutions.

---

## Debugging Tests

### Console Output

```bash
# Run with console output
npm test

# Verbose mode
npm test -- --reporter=verbose
```

### Breakpoints (VS Code)

1. Add breakpoint in test file
2. Click "Debug" in test sidebar
3. Or use "JavaScript Debug Terminal"

### Isolate Failing Test

```typescript
// Run only this test
it.only('should test specific behavior', () => {
  // ...
});

// Skip this test
it.skip('should be fixed later', () => {
  // ...
});
```

---

## Pre-Commit Checklist

Before committing test code:

1. **Run tests**: `npm test` - All tests must pass
2. **Run linter**: `npm run lint` - Zero errors, zero warnings
3. **Run type-check**: `npm run type-check` - Zero type errors
4. **Check coverage**: `npm run test:coverage` - Meet coverage targets
5. **Run validate**: `npm run validate` - All checks in one command

---

## Tech Stack

- **Test Framework**: Vitest (fast, modern, Vite-integrated)
- **Component Testing**: React Testing Library (user-centric testing)
- **Mocking**: Vitest `vi.mock()` with shared factories
- **Assertions**: Vitest `expect()` with type-safe helpers
- **Coverage**: Vitest coverage with c8

**Why these choices?** See [`.context/testing/decisions.md`](../.context/testing/decisions.md)

---

## Getting Help

1. **Quick patterns**: [`.context/testing/patterns.md`](../.context/testing/patterns.md)
2. **Mocking strategies**: [`.context/testing/mocking.md`](../.context/testing/mocking.md)
3. **Common problems**: [`.claude/skills/testing/gotchas.md`](../.claude/skills/testing/gotchas.md)
