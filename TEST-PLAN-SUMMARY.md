# Test Plan Summary - Quick Reference

## Overview

This is a quick reference guide for implementing Phase 2.4 testing. See **TEST-PLAN.md** for the complete detailed plan.

---

## Quick Start

### 1. Install Dependencies (5 minutes)

```bash
npm install -D vitest @vitest/ui @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react
```

### 2. Create Configuration (10 minutes)

**File**: `vitest.config.ts`

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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

**File**: `tests/setup.ts`

```typescript
import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock Next.js modules
vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({ get: vi.fn() })),
  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));
```

### 3. Verify Setup (2 minutes)

```bash
npm test
# Should run (no tests yet, but should not error)
```

---

## Implementation Priority Order

### Week 1: Validation & Utils (12-14 hours)

1. **Validation Tests** (6-8 hours)
   - `tests/unit/validations/auth.test.ts` - Password, email, sign-up schemas
   - `tests/unit/validations/common.test.ts` - Pagination, CUID, sorting
   - `tests/unit/validations/user.test.ts` - User creation, updates

2. **Utility Tests** (2-3 hours)
   - `tests/unit/utils/password-strength.test.ts` - Password strength calculator
   - `tests/unit/utils/utils.test.ts` - Tailwind cn() utility

3. **Mock Helpers** (4-5 hours)
   - `tests/helpers/mocks/auth.ts` - Mock sessions/users
   - `tests/helpers/mocks/database.ts` - Mock Prisma
   - `tests/helpers/factories/user.ts` - User data factory

### Week 2: API & Core (10-13 hours)

4. **API Response Tests** (3-4 hours)
   - `tests/unit/api/responses.test.ts` - successResponse, errorResponse, paginatedResponse

5. **API Error Tests** (4-5 hours)
   - `tests/unit/api/errors.test.ts` - Error classes, handleAPIError, Prisma errors

6. **API Validation Tests** (3-4 hours)
   - `tests/unit/api/validation.test.ts` - validateRequestBody, validateQueryParams

### Week 3: Auth & Database (11-14 hours)

7. **Auth Tests** (5-6 hours)
   - `tests/unit/auth/utils.test.ts` - getServerSession, requireAuth, hasRole

8. **Database Tests** (2-3 hours)
   - `tests/unit/db/utils.test.ts` - Connection checks, health, transactions

9. **Logging Tests** (4-5 hours)
   - `tests/unit/logging/logger.test.ts` - Logger class, PII sanitization
   - `tests/unit/logging/context.test.ts` - Context extraction

### Week 4: Integration & Docs (4-6 hours)

10. **Integration Test** (2-3 hours)
    - `tests/integration/api/health.test.ts` - Example integration test

11. **Documentation** (2-3 hours)
    - `.context/testing/overview.md` - Testing patterns
    - Update CLAUDE.md with testing guidelines

**Total**: 37-47 hours

---

## Files to Test (Priority Order)

### High Priority (Core Functionality)

1. **Validation Schemas** - Pure functions, easy to test
   - `lib/validations/auth.ts` - 7 schemas (password, email, sign-up, etc.)
   - `lib/validations/common.ts` - 8 schemas (pagination, CUID, URL, etc.)
   - `lib/validations/user.ts` - 4 schemas (create, update, list, ID)

2. **Authentication** - Critical security logic
   - `lib/auth/utils.ts` - 6 functions (getServerSession, requireAuth, hasRole, etc.)

3. **API Utilities** - Core API patterns
   - `lib/api/responses.ts` - 3 functions (successResponse, errorResponse, paginatedResponse)
   - `lib/api/errors.ts` - 5 error classes + handleAPIError
   - `lib/api/validation.ts` - 3 functions (validateRequestBody, validateQueryParams, parsePaginationParams)

### Medium Priority (Complex Logic)

4. **Password Strength** - Complex algorithm
   - `lib/utils/password-strength.ts` - calculatePasswordStrength()

5. **Logging** - Environment-aware, sanitization
   - `lib/logging/index.ts` - Logger class
   - `lib/logging/context.ts` - Context extraction utilities

6. **Database** - Health checks, transactions
   - `lib/db/utils.ts` - 3 functions (checkDatabaseConnection, getDatabaseHealth, executeTransaction)

### Low Priority (Simple Utilities)

7. **General Utils**
   - `lib/utils.ts` - cn() function (Tailwind merge)

---

## Test Coverage Goals

### Must Have (Phase 2.4)

- **Validation Schemas**: ~80% coverage
  - All success cases
  - All validation errors
  - Edge cases (empty, too long, etc.)

- **Authentication**: ~70% coverage
  - Happy paths (authenticated user)
  - Error paths (no session, wrong role)
  - Edge cases (null values)

- **API Utilities**: ~75% coverage
  - All response types
  - All error types
  - Prisma error transformations

- **Password Strength**: ~90% coverage
  - All scoring paths
  - All penalties/bonuses
  - Edge cases (empty, very long)

### Nice to Have (Future)

- **Logging**: ~60% coverage
  - Basic logging methods
  - PII sanitization
  - Environment awareness

- **Database Utils**: ~60% coverage
  - Health checks
  - Basic operations

---

## Common Mock Patterns

### 1. Mock Next.js Headers

```typescript
import { vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({
    get: vi.fn((name: string) => {
      const mockHeaders = {
        'x-request-id': 'test-123',
        'user-agent': 'Mozilla/5.0',
      };
      return mockHeaders[name] || null;
    }),
  })),
}));
```

### 2. Mock better-auth

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(() =>
        Promise.resolve({
          session: { id: 'session-123', userId: 'user-123' },
          user: { id: 'user-123', email: 'test@example.com', role: 'USER' },
        })
      ),
    },
  },
}));
```

### 3. Mock Prisma Client

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(() => Promise.resolve()),
    $disconnect: vi.fn(),
  },
}));
```

### 4. Mock Logger

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
```

---

## Example Test Structure

### Validation Test

```typescript
import { describe, it, expect } from 'vitest';
import { passwordSchema } from '@/lib/validations/auth';

describe('passwordSchema', () => {
  it('should accept valid password', () => {
    const result = passwordSchema.parse('Test@123');
    expect(result).toBe('Test@123');
  });

  it('should reject password without uppercase', () => {
    expect(() => passwordSchema.parse('test@123')).toThrow(
      'must contain at least one uppercase letter'
    );
  });

  it('should reject password that is too short', () => {
    expect(() => passwordSchema.parse('Test@1')).toThrow('at least 8 characters');
  });
});
```

### Auth Utility Test

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getServerSession } from '@/lib/auth/utils';
import { auth } from '@/lib/auth/config';

vi.mock('@/lib/auth/config');
vi.mock('next/headers');

describe('getServerSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return session when authenticated', async () => {
    const mockSession = {
      session: { id: 'session-123' },
      user: { id: 'user-123', email: 'test@example.com' },
    };

    vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

    const result = await getServerSession();

    expect(result).toEqual(mockSession);
  });

  it('should return null when not authenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const result = await getServerSession();

    expect(result).toBeNull();
  });
});
```

### API Response Test

```typescript
import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from '@/lib/api/responses';

describe('successResponse', () => {
  it('should create success response with data', async () => {
    const response = successResponse({ id: '123', name: 'Test' });

    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json).toEqual({
      success: true,
      data: { id: '123', name: 'Test' },
    });
  });

  it('should accept custom status code', async () => {
    const response = successResponse({ id: '123' }, undefined, {
      status: 201,
    });

    expect(response.status).toBe(201);
  });
});
```

---

## Test File Template

```typescript
/**
 * Tests for [Module Name]
 *
 * Coverage:
 * - [Function 1]: [Brief description]
 * - [Function 2]: [Brief description]
 *
 * Mocks:
 * - [Dependency 1]: [Why mocked]
 * - [Dependency 2]: [Why mocked]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { functionToTest } from '@/lib/module';

// Mocks
vi.mock('@/lib/dependency', () => ({
  dependency: vi.fn(),
}));

describe('moduleName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('functionName', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange
      const input = 'test-input';

      // Act
      const result = functionToTest(input);

      // Assert
      expect(result).toBe('expected-output');
    });

    it('should throw error when [invalid condition]', () => {
      // Arrange
      const invalidInput = null;

      // Act & Assert
      expect(() => functionToTest(invalidInput)).toThrow('Expected error');
    });
  });
});
```

---

## Success Checklist

Phase 2.4 is complete when:

- [ ] Vitest installed and configured
- [ ] Test setup file created with global mocks
- [ ] At least 8 test files created (validation, utils, API, auth)
- [ ] All tests pass (`npm test`)
- [ ] Coverage report works (`npm run test:coverage`)
- [ ] Mock helpers created (auth, database, factories)
- [ ] At least 1 integration test example
- [ ] Testing documentation created in `.context/testing/`
- [ ] No skipped or failing tests

---

## Useful Commands

```bash
# Run all tests
npm test

# Run tests in watch mode (recommended during development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests with UI (browser-based)
npm run test:ui

# Run specific test file
npx vitest run tests/unit/validations/auth.test.ts

# Run tests matching pattern
npx vitest run --grep "passwordSchema"
```

---

## Common Issues & Solutions

### Issue: "Cannot find module '@/lib/...'"

**Solution**: Ensure `vitest.config.ts` has path alias resolution:

```typescript
resolve: {
  alias: {
    '@': path.resolve(__dirname, './'),
  },
}
```

### Issue: "headers is not a function"

**Solution**: Mock `next/headers` in test setup or individual test:

```typescript
vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({ get: vi.fn() })),
}));
```

### Issue: "Cannot access 'auth' before initialization"

**Solution**: Use `vi.mocked()` to properly type mocks:

```typescript
import { auth } from '@/lib/auth/config';
vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
```

### Issue: Tests pass individually but fail together

**Solution**: Ensure `vi.clearAllMocks()` in `beforeEach()`:

```typescript
beforeEach(() => {
  vi.clearAllMocks();
});
```

---

## Next Steps

After completing Phase 2.4:

1. Review test coverage report - identify gaps
2. Document testing patterns in `.context/testing/`
3. Create testing guidelines for new features
4. Consider adding integration tests (Phase 3+)
5. Consider adding component tests (Phase 3+)
6. Set up CI/CD to run tests on every PR

---

For complete details, test cases, and implementation guidance, see **TEST-PLAN.md**.
