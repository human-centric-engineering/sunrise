# Testing Gotchas & Best Practices

**Lessons learned from Week 1 & 2 implementation (404 tests)**

This document captures critical issues, gotchas, and best practices discovered during the initial testing framework implementation for Sunrise.

---

## Critical Gotchas

### 1. ESLint Auto-Fix Removes `async` Keywords

**SEVERITY**: Critical - Breaks tests silently

**The Problem**:
ESLint auto-fix may incorrectly remove the `async` keyword from test functions that use `await`.

```typescript
// BEFORE ESLint auto-fix
it('should validate request body', async () => {
  const result = await validateRequestBody(request, schema);
  expect(result).toBeDefined();
});

// AFTER ESLint auto-fix (BROKEN!)
it('should validate request body', () => {
  // ❌ async removed!
  const result = await validateRequestBody(request, schema); // Error: await in non-async
  expect(result).toBeDefined();
});
```

**Why It Happens**:

- ESLint rule `@typescript-eslint/require-await` checks if `async` is necessary
- If the test uses helper functions that internally `await`, or uses `expect(...).rejects.toThrow()`, ESLint thinks `async` is unused
- Auto-fix removes it, breaking the test

**Solutions**:

**Option 1**: Disable auto-fix for test files in VSCode settings:

```json
{
  "eslint.codeActionsOnSave.rules": {
    "@typescript-eslint/require-await": "off"
  }
}
```

**Option 2**: Add ESLint exception for test files in `.eslintrc.json`:

```json
{
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.test.tsx"],
      "rules": {
        "@typescript-eslint/require-await": "off"
      }
    }
  ]
}
```

**Option 3**: Always review auto-fix changes before committing

**Best Practice**: Add the ESLint override to your project configuration to prevent this issue for all developers.

**Status**: ✅ **IMPLEMENTED** - This project now has ESLint overrides configured in `eslint.config.mjs` to disable `@typescript-eslint/require-await` for all test files. ESLint auto-fix will not remove `async` keywords from test functions.

---

### 2. NODE_ENV Is Read-Only in Tests

**SEVERITY**: Critical - Environment-dependent behavior can't be tested

**The Problem**:
Cannot set `process.env.NODE_ENV` directly in tests because Node.js sets it as read-only.

```typescript
// ❌ BROKEN - Silently fails or throws error
beforeEach(() => {
  process.env.NODE_ENV = 'production'; // Error: Cannot assign to read-only property
});
```

**Why It Happens**:
Node.js marks `NODE_ENV` as a read-only property in some runtime environments.

**Solution**: Use `Object.defineProperty()` to override the property descriptor:

```typescript
// ✅ CORRECT - Works in all environments
beforeEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'production',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

// Reset after test
afterEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'test',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});
```

**Example from Week 2**:

```typescript
// Test error details in development vs production
it('should include error details in development mode', async () => {
  // Arrange: Set development environment
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'development',
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // Act
  const error = new Error('Test error');
  const response = handleAPIError(error);
  const body = await parseResponse(response);

  // Assert: Development mode includes stack trace
  expect(body.error.details).toBeDefined();
  expect(body.error.details.stack).toBeDefined();
});
```

**Best Practice**: Set `NODE_ENV` in `tests/setup.ts` BEFORE any imports:

```typescript
// tests/setup.ts (MUST be at the very top, before imports!)
Object.defineProperty(process.env, 'NODE_ENV', {
  value: 'test',
  writable: true,
  enumerable: true,
  configurable: true,
});
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
// ... other env vars

// NOW it's safe to import modules
import '@testing-library/jest-dom';
import { expect, vi } from 'vitest';
```

**Why This Matters**: Modules like `lib/env.ts` validate environment variables at import time, so env vars MUST be set before any imports.

---

### 3. Response.json() Returns `Promise<any>`

**SEVERITY**: High - Loss of type safety in tests

**The Problem**:
TypeScript cannot infer the type of `Response.json()` return value, leading to `any` types and loss of type safety.

```typescript
// ❌ UNSAFE - No type checking
const response = handleAPIError(error);
const body = await response.json(); // Type: any
expect(body.error.message).toBe('...'); // No autocomplete, typos not caught
```

**Solution**: Define response type interfaces and use helper functions.

```typescript
// ✅ SAFE - Full type safety
interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

// Helper function for type-safe parsing
async function parseResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// Usage in tests
it('should return error response', async () => {
  const response = handleAPIError(error);
  const body = await parseResponse<ErrorResponse>(response);

  expect(body.success).toBe(false); // ✅ Type-safe!
  expect(body.error.message).toBe('...'); // ✅ Autocomplete works!
  expect(body.error.code).toBe('INTERNAL_ERROR'); // ✅ Catches typos!
});
```

**Example from Week 2 (API Response Tests)**:

```typescript
describe('successResponse', () => {
  // Define types at top of test file
  interface SuccessResponse<T = unknown> {
    success: true;
    data: T;
    meta?: Record<string, unknown>;
  }

  it('should return success response with data', async () => {
    // Arrange
    const data = { id: '123', name: 'John' };

    // Act
    const response = successResponse(data);
    const json = (await response.json()) as SuccessResponse;

    // Assert
    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { id: '123', name: 'John' },
    });
  });
});
```

**Best Practice**: Create a shared test utilities file with response type definitions:

```typescript
// tests/helpers/api.ts
export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

export async function parseSuccessResponse<T>(response: Response): Promise<SuccessResponse<T>> {
  return (await response.json()) as SuccessResponse<T>;
}

export async function parseErrorResponse(response: Response): Promise<ErrorResponse> {
  return (await response.json()) as ErrorResponse;
}
```

---

### 4. Mock Setup Timing

**SEVERITY**: Critical - Tests fail with cryptic import errors

**The Problem**:
Environment variables must be set BEFORE any module imports in `setup.ts`, otherwise modules that validate env vars at import time will fail.

```typescript
// ❌ BROKEN - Imports happen before env vars are set
import { env } from '@/lib/env'; // Validates env at import time!
import { db } from '@/lib/db'; // Uses DATABASE_URL from env!

process.env.DATABASE_URL = 'test-url'; // Too late!
process.env.BETTER_AUTH_SECRET = 'test-secret'; // Too late!
```

**Why It Happens**:

- Modules like `lib/env.ts` use Zod validation that runs at module import time
- By the time `process.env` is set, the validation has already failed

**Solution**: Always set environment variables FIRST in `setup.ts`:

```typescript
// ✅ CORRECT - tests/setup.ts
/**
 * Set up test environment variables BEFORE any imports
 * This is critical because lib/env.ts validates environment variables at module load time
 */
Object.defineProperty(process.env, 'NODE_ENV', {
  value: 'test',
  writable: true,
  enumerable: true,
  configurable: true,
});
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.BETTER_AUTH_SECRET = 'test-secret-key-for-testing-only';
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// NOW it's safe to import
import '@testing-library/jest-dom';
import { expect, vi, afterEach } from 'vitest';

// Mock Next.js modules
vi.mock('next/navigation', () => ({
  // ...
}));
```

**Best Practice**: Document this in `setup.ts` with comments explaining WHY the order matters.

---

## Best Practices from Week 1 & 2

### TypeScript Type Narrowing in Error Tests

**Pattern**: Use `instanceof` for type-safe error property access.

```typescript
// ✅ GOOD - Type narrowing with instanceof
try {
  await validateRequestBody(request, schema);
  expect.fail('Should have thrown ValidationError');
} catch (error) {
  expect(error).toBeInstanceOf(ValidationError);
  if (error instanceof ValidationError) {
    expect(error.message).toBe('Invalid request body');  // ✅ Type-safe
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toBeDefined();
  }
}

// ❌ AVOID - Type assertion (less safe)
catch (error) {
  expect((error as ValidationError).message).toBe('...');  // Could fail at runtime
}
```

**Why**: TypeScript doesn't know the type of `error` in catch blocks. `instanceof` provides runtime type checking AND type narrowing.

---

### Response Parsing Helper Functions

**Pattern**: Create helper functions for consistent, type-safe response parsing.

```typescript
// Define at top of test file
interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

async function parseResponse(response: Response): Promise<ErrorResponse> {
  return (await response.json()) as ErrorResponse;
}

// Use consistently throughout tests
it('should handle API error', async () => {
  const response = handleAPIError(error);
  const body = await parseResponse(response);

  expect(response.status).toBe(500);
  expect(body.success).toBe(false);
  expect(body.error.message).toBe('Internal server error');
});

it('should handle validation error', async () => {
  const response = handleAPIError(validationError);
  const body = await parseResponse(response);

  expect(response.status).toBe(400);
  expect(body.error.code).toBe('VALIDATION_ERROR');
});
```

**Benefits**:

- Type safety across all tests
- Consistent error handling
- Easy to update if response format changes
- No duplication of type assertions

---

### Arrange-Act-Assert with Comments

**Pattern**: Always use AAA comments for clarity, especially in complex tests.

```typescript
// ✅ EXCELLENT - Clear structure
it('should parse pagination params with skip calculation', () => {
  // Arrange: Create URLSearchParams with page and limit
  const searchParams = new URLSearchParams('page=3&limit=50');

  // Act: Parse the pagination parameters
  const result = parsePaginationParams(searchParams);

  // Assert: Verify correct calculation (skip = (page - 1) * limit)
  expect(result).toEqual({
    page: 3,
    limit: 50,
    skip: 100, // (3-1) * 50 = 100
  });
});

// ✅ GOOD - Inline comments for simple tests
it('should enforce minimum page of 1', () => {
  const searchParams = new URLSearchParams('page=0'); // Arrange
  const result = parsePaginationParams(searchParams); // Act
  expect(result.page).toBe(1); // Assert: page corrected to 1
});

// ❌ AVOID - No structure, hard to understand
it('should work', () => {
  const searchParams = new URLSearchParams('page=0');
  const result = parsePaginationParams(searchParams);
  expect(result.page).toBe(1);
});
```

**Benefits**:

- Tests are self-documenting
- Easy to understand intent
- Helpful for future developers
- Makes complex logic clear

---

### Descriptive Test Names

**Pattern**: Test names should explain the scenario and expected outcome.

```typescript
// ✅ EXCELLENT - Explains what, when, and why
describe('parsePaginationParams()', () => {
  describe('skip calculation', () => {
    it('should correctly calculate skip = (page - 1) * limit', () => {
      // ...
    });

    it('should calculate skip correctly for first page', () => {
      // ...
    });

    it('should calculate skip correctly for large offsets', () => {
      // ...
    });
  });

  describe('min page enforcement', () => {
    it('should enforce minimum page of 1', () => {
      // ...
    });

    it('should enforce minimum for negative page values', () => {
      // ...
    });
  });
});

// ❌ AVOID - Vague or unclear
describe('parsePaginationParams', () => {
  it('works correctly', () => { ... });
  it('handles edge cases', () => { ... });
  it('test page', () => { ... });
});
```

**Benefits**:

- Test failures are immediately understandable
- Documentation for API behavior
- Easy to identify gaps in coverage
- Serves as executable specification

---

### Mock Logger with Proper Types

**Pattern**: Type-cast mocked logger functions for type-safe assertions.

```typescript
// Mock the logger
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@/lib/logging';

it('should log API error with correct context', () => {
  const error = new APIError('Test error', 'TEST', 500);

  // Type-cast for type safety
  const mockError = logger.error as unknown as ReturnType<typeof vi.fn>;

  handleAPIError(error);

  expect(mockError).toHaveBeenCalledWith('API Error', error, {
    errorType: 'api',
    isDevelopment: true,
  });
});
```

**Alternative**: Use `vi.mocked()` helper:

```typescript
import { logger } from '@/lib/logging';
import { vi } from 'vitest';

it('should log error', () => {
  handleAPIError(error);

  expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
    'API Error',
    error,
    expect.objectContaining({ errorType: 'api' })
  );
});
```

---

### Test Each Behavior Independently

**Pattern**: One assertion per test (or closely related assertions).

```typescript
// ✅ GOOD - Each test verifies one behavior
describe('errorResponse()', () => {
  it('should set status 500 by default', () => {
    const response = errorResponse('Error');
    expect(response.status).toBe(500);
  });

  it('should set correct Content-Type header', () => {
    const response = errorResponse('Error');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('should include error message in response', async () => {
    const response = errorResponse('Custom error');
    const body = await parseResponse(response);
    expect(body.error.message).toBe('Custom error');
  });
});

// ❌ AVOID - Testing multiple behaviors (hard to debug failures)
it('should return error response correctly', async () => {
  const response = errorResponse('Error');
  expect(response.status).toBe(500);
  expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  const body = await parseResponse(response);
  expect(body.error.message).toBe('Error');
  expect(body.success).toBe(false);
});
```

**Benefits**:

- Precise failure messages (you know exactly what broke)
- Easy to add new test cases
- Better test organization
- Clear documentation of expected behavior

---

### Use `describe.each` for Parameterized Tests

**Pattern**: Test multiple inputs with the same logic using parameterized tests.

```typescript
// ✅ EXCELLENT - Parameterized test
describe('skip calculation', () => {
  it('should correctly calculate skip = (page - 1) * limit', () => {
    const testCases = [
      { page: 1, limit: 20, expectedSkip: 0 },
      { page: 2, limit: 20, expectedSkip: 20 },
      { page: 3, limit: 20, expectedSkip: 40 },
      { page: 5, limit: 10, expectedSkip: 40 },
      { page: 10, limit: 100, expectedSkip: 900 },
    ];

    testCases.forEach(({ page, limit, expectedSkip }) => {
      const searchParams = new URLSearchParams(`page=${page}&limit=${limit}`);
      const result = parsePaginationParams(searchParams);
      expect(result.skip).toBe(expectedSkip);
    });
  });
});

// ❌ AVOID - Repetitive tests
it('should calculate skip for page 1', () => {
  const searchParams = new URLSearchParams('page=1&limit=20');
  expect(parsePaginationParams(searchParams).skip).toBe(0);
});

it('should calculate skip for page 2', () => {
  const searchParams = new URLSearchParams('page=2&limit=20');
  expect(parsePaginationParams(searchParams).skip).toBe(20);
});
// ... 10 more repetitive tests
```

**Benefits**:

- Less code duplication
- Easy to add new test cases
- Clear relationship between inputs and outputs
- Comprehensive coverage with minimal code

---

## Summary

**Key Takeaways from Week 1 & 2**:

1. **ESLint auto-fix is dangerous** for async tests - disable `@typescript-eslint/require-await` for test files
2. **NODE_ENV requires `Object.defineProperty()`** - cannot be set directly
3. **Response.json() needs type interfaces** - define `SuccessResponse` and `ErrorResponse` types
4. **Environment setup order matters** - set env vars BEFORE imports in `setup.ts`
5. **Use AAA comments** - makes tests self-documenting
6. **Type-safe error handling** - use `instanceof` for type narrowing
7. **Descriptive test names** - explain scenario and expected outcome
8. **One behavior per test** - precise failure messages
9. **Helper functions for parsing** - consistent type-safe response handling
10. **Parameterized tests** - reduce duplication with `describe.each` or test case arrays

**Stats from Week 1 & 2**:

- 404 tests passing
- 8 test files
- 100% success rate after addressing these gotchas
- Zero flaky tests
