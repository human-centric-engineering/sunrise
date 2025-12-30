# Testing Patterns for Sunrise

Best practices and proven patterns for writing tests in the Sunrise project.

---

## Test File Structure

### Standard Template

Every test file should follow this structure:

```typescript
/**
 * [Module Name] Tests
 *
 * Brief description of what's being tested
 *
 * Test Coverage:
 * - Feature 1
 * - Feature 2
 * - Edge cases and error handling
 *
 * @see [path to source file]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { functionToTest } from '@/lib/module';

/**
 * Mock dependencies (if needed)
 */
vi.mock('@/lib/dependency', () => ({
  dependency: vi.fn(),
}));

/**
 * Test Suite: [High-Level Feature]
 *
 * Description of what this suite covers
 */
describe('[Module/Function Name]', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore mocks after each test
    vi.restoreAllMocks();
  });

  describe('[specific feature]', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange: Set up test data
      const input = createTestData();

      // Act: Execute the function
      const result = functionToTest(input);

      // Assert: Verify outcome
      expect(result).toEqual(expectedOutput);
    });
  });
});
```

---

## Arrange-Act-Assert Pattern

### Always Use AAA Comments

```typescript
// EXCELLENT - Clear sections
it('should parse pagination parameters correctly', () => {
  // Arrange: Create URLSearchParams with custom values
  const searchParams = new URLSearchParams('page=3&limit=50');

  // Act: Parse the parameters
  const result = parsePaginationParams(searchParams);

  // Assert: Verify correct calculation
  expect(result).toEqual({
    page: 3,
    limit: 50,
    skip: 100, // (3-1) * 50
  });
});

// GOOD - Inline comments for simple tests
it('should default to page 1', () => {
  const searchParams = new URLSearchParams(''); // Arrange
  const result = parsePaginationParams(searchParams); // Act
  expect(result.page).toBe(1); // Assert
});

// AVOID - No structure (hard to understand)
it('should work', () => {
  const searchParams = new URLSearchParams('page=0');
  const result = parsePaginationParams(searchParams);
  expect(result.page).toBe(1);
});
```

---

## Type Safety for Response Objects

### Define Response Type Interfaces

```typescript
/**
 * Type definitions for response bodies
 */
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

/**
 * Helper: Parse JSON response body with type safety
 */
async function parseSuccessResponse<T>(response: Response): Promise<SuccessResponse<T>> {
  return (await response.json()) as SuccessResponse<T>;
}

async function parseErrorResponse(response: Response): Promise<ErrorResponse> {
  return (await response.json()) as ErrorResponse;
}
```

### Usage in Tests

```typescript
describe('successResponse', () => {
  it('should return success response with data', async () => {
    // Arrange
    const data = { id: '123', name: 'John' };

    // Act
    const response = successResponse(data);
    const json = await parseSuccessResponse(response);

    // Assert - Type-safe access to properties
    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual(data);
  });
});
```

---

## Shared Mock Types

### Use Centralized Mock Factories

Always import mock factories from `tests/types/mocks.ts` instead of creating inline mocks.

**Why**: Complete type implementations prevent incomplete mock errors that trigger lint/type error cycles.

```typescript
import {
  createMockHeaders,
  createMockSession,
  delayed,
  type MockHeaders,
  type MockSession,
} from '@/tests/types/mocks';
```

### createMockHeaders()

**Purpose**: Complete Headers mock with all required methods.

```typescript
import { createMockHeaders } from '@/tests/types/mocks';

// Mock Next.js headers() function
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

import { headers } from 'next/headers';

it('should read request headers', async () => {
  // Arrange: Create mock with custom headers
  vi.mocked(headers).mockResolvedValue(
    createMockHeaders({
      'x-request-id': 'test-123',
      'user-agent': 'test-agent',
    }) as any
  );

  // Act
  const requestId = await getRequestId();

  // Assert
  expect(requestId).toBe('test-123');
});
```

### createMockSession()

**Purpose**: Complete better-auth session structure.

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

it('should require authentication', async () => {
  // Arrange: Mock authenticated user
  vi.mocked(auth.api.getSession).mockResolvedValue(
    createMockSession({
      user: { id: 'user-123', email: 'test@example.com' },
    }) as any
  );

  // Act
  const result = await protectedFunction();

  // Assert
  expect(result).toBeDefined();
});
```

### delayed()

**Purpose**: PrismaPromise-compatible async helper for timing tests.

```typescript
import { delayed } from '@/tests/types/mocks';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';

it('should measure database latency', async () => {
  // Arrange: Mock query with known 50ms delay
  vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

  // Act
  const result = await getDatabaseHealth();

  // Assert
  expect(result.latency).toBeGreaterThanOrEqual(50);
  expect(result.latency).toBeLessThan(100);
});
```

**Reference**: See `.context/testing/mocking.md` for complete mock strategies by dependency.

---

## Type-Safe Assertion Helpers

### Use Type Guards Instead of Non-Null Assertions

Always import assertion helpers from `tests/helpers/assertions.ts` for type narrowing.

**Why**: Better error messages and type safety than `!` non-null assertions.

```typescript
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

### assertDefined()

**Purpose**: Type guard for optional properties.

```typescript
import { assertDefined } from '@/tests/helpers/assertions';

it('should include metadata in response', () => {
  // Arrange
  const output = logger.format('test message', { userId: 'user-123' });
  const parsed = JSON.parse(output);

  // Assert: Use assertDefined for type narrowing
  assertDefined(parsed.meta);
  expect(parsed.meta.userId).toBe('user-123'); // Type-safe!
});

// ❌ AVOID: Direct access (type error)
expect(parsed.meta.userId).toBe('user-123'); // Error: meta possibly undefined

// ❌ AVOID: Non-null assertion (runtime risk)
expect(parsed.meta!.userId).toBe('user-123'); // Could fail if meta is undefined
```

### assertHasProperty()

**Purpose**: Type guard for property existence.

```typescript
import { assertHasProperty } from '@/tests/helpers/assertions';

it('should include error details', () => {
  // Arrange
  const error = new ValidationError('Test error');
  const response = handleAPIError(error);

  // Assert: Use assertHasProperty for property checks
  assertHasProperty(response, 'error');
  expect(response.error.code).toBe('VALIDATION_ERROR');
});
```

### parseJSON()

**Purpose**: Type-safe response parsing.

```typescript
import { parseJSON } from '@/tests/helpers/assertions';

interface UserResponse {
  success: boolean;
  data: { id: string; email: string };
}

it('should return user data', async () => {
  // Arrange
  const response = await GET();

  // Act: Parse with type safety
  const body = await parseJSON<UserResponse>(response);

  // Assert: Type-safe access
  expect(body.success).toBe(true);
  expect(body.data.id).toBeDefined();
});
```

**Reference**: See `.context/testing/history.md` for background on why these helpers were created.

---

## Error Testing Patterns

### Type-Safe Error Handling

```typescript
// GOOD - Type narrowing with instanceof
it('should throw ValidationError for invalid data', async () => {
  // Arrange
  const invalidData = { email: 'not-an-email' };
  const mockRequest = createMockRequest(invalidData);

  // Act & Assert
  try {
    await validateRequestBody(mockRequest, schema);
    expect.fail('Should have thrown ValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    if (error instanceof ValidationError) {
      // Type-safe access to ValidationError properties
      expect(error.message).toBe('Invalid request body');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.status).toBe(400);
      expect(error.details).toBeDefined();
    }
  }
});

// AVOID - Type assertion (no runtime safety)
try {
  await validateRequestBody(mockRequest, schema);
} catch (error) {
  expect((error as ValidationError).message).toBe('...'); // Could fail
}
```

### Testing Zod Validation Errors

```typescript
describe('passwordSchema', () => {
  it('should reject password without uppercase letter', () => {
    // Arrange
    const invalidPassword = 'password123!';

    // Act
    const result = passwordSchema.safeParse(invalidPassword);

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('uppercase letter');
    }
  });
});
```

---

## Async Testing Patterns

### Testing Async Functions

```typescript
describe('validateRequestBody()', () => {
  it('should parse and validate correct data', async () => {
    // Arrange: Mock async request.json()
    const validData = { name: 'John', email: 'john@example.com' };
    const mockJsonFn = vi.fn().mockResolvedValue(validData);
    const mockRequest = {
      json: mockJsonFn,
    } as unknown as NextRequest;

    // Act: Await async validation
    const result = await validateRequestBody(mockRequest, schema);

    // Assert: Verify result and mock call
    expect(result).toEqual(validData);
    expect(mockJsonFn).toHaveBeenCalledTimes(1);
  });
});
```

### Testing Promise Rejections

```typescript
it('should throw error for malformed JSON', async () => {
  // Arrange: Mock json() to reject
  const mockRequest = {
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  } as unknown as NextRequest;

  // Act & Assert: Use expect().rejects
  await expect(validateRequestBody(mockRequest, schema)).rejects.toThrow(
    'Invalid JSON in request body'
  );
});
```

---

## Mock Patterns

### Mocking Logger

```typescript
// Mock at top of file
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

import { logger } from '@/lib/logging';

// In test
it('should log error with correct context', () => {
  const error = new Error('Test error');

  // Type-cast for type safety
  const mockError = logger.error as unknown as ReturnType<typeof vi.fn>;

  handleAPIError(error);

  expect(mockError).toHaveBeenCalledWith('API Error', error, {
    errorType: 'api',
    isDevelopment: true,
  });
});
```

### Mocking Environment Variables

```typescript
// Mock environment module
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'development', // Default value
  },
}));

import { env } from '@/lib/env';

// In test - change environment
it('should behave differently in production', () => {
  // Arrange: Set production environment
  (env as { NODE_ENV: string }).NODE_ENV = 'production';

  // Act
  const result = someFunction();

  // Assert: Production behavior
  expect(result).not.toHaveProperty('debugInfo');
});
```

### Mocking Next.js Request

```typescript
it('should handle POST request', async () => {
  // Arrange: Create mock NextRequest
  const mockRequest = new NextRequest('http://localhost:3000/api/v1/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'John', email: 'john@example.com' }),
  });

  // Act
  const response = await POST(mockRequest);
  const data = await response.json();

  // Assert
  expect(response.status).toBe(201);
  expect(data.success).toBe(true);
});
```

---

## Parameterized Testing

### Using Test Case Arrays

```typescript
describe('skip calculation', () => {
  it('should correctly calculate skip = (page - 1) * limit', () => {
    // Arrange: Define test cases
    const testCases = [
      { page: 1, limit: 20, expectedSkip: 0 },
      { page: 2, limit: 20, expectedSkip: 20 },
      { page: 3, limit: 20, expectedSkip: 40 },
      { page: 5, limit: 10, expectedSkip: 40 },
      { page: 10, limit: 100, expectedSkip: 900 },
    ];

    testCases.forEach(({ page, limit, expectedSkip }) => {
      // Arrange
      const searchParams = new URLSearchParams(`page=${page}&limit=${limit}`);

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.skip).toBe(expectedSkip);
    });
  });
});
```

### Using describe.each

```typescript
describe.each([
  { password: 'Password123!', valid: true, reason: 'all criteria met' },
  { password: 'password123!', valid: false, reason: 'no uppercase' },
  { password: 'PASSWORD123!', valid: false, reason: 'no lowercase' },
  { password: 'Password!', valid: false, reason: 'no number' },
  { password: 'Password123', valid: false, reason: 'no special char' },
])('passwordSchema with $password', ({ password, valid, reason }) => {
  it(`should ${valid ? 'accept' : 'reject'} - ${reason}`, () => {
    const result = passwordSchema.safeParse(password);
    expect(result.success).toBe(valid);
  });
});
```

---

## Testing Edge Cases

### Boundary Values

```typescript
describe('pagination limits', () => {
  it('should enforce minimum page of 1', () => {
    const testCases = [0, -1, -5, -999];

    testCases.forEach((invalidPage) => {
      const searchParams = new URLSearchParams(`page=${invalidPage}`);
      const result = parsePaginationParams(searchParams);
      expect(result.page).toBe(1);
    });
  });

  it('should enforce maximum limit of 100', () => {
    const testCases = [101, 500, 9999];

    testCases.forEach((invalidLimit) => {
      const searchParams = new URLSearchParams(`limit=${invalidLimit}`);
      const result = parsePaginationParams(searchParams);
      expect(result.limit).toBe(100);
    });
  });
});
```

### Null/Undefined/Empty Values

```typescript
describe('edge cases', () => {
  it('should handle null data', async () => {
    const response = successResponse(null);
    const json = await parseSuccessResponse(response);
    expect(json.data).toBe(null);
  });

  it('should handle empty object', async () => {
    const response = successResponse({});
    const json = await parseSuccessResponse(response);
    expect(json.data).toEqual({});
  });

  it('should handle empty array', async () => {
    const response = successResponse([]);
    const json = await parseSuccessResponse(response);
    expect(json.data).toEqual([]);
  });
});
```

---

## Test Organization

### Grouping by Feature

```typescript
describe('handleAPIError', () => {
  describe('APIError handling', () => {
    it('should handle APIError with all properties', async () => { ... });
    it('should handle ValidationError', async () => { ... });
    it('should handle UnauthorizedError', async () => { ... });
  });

  describe('Zod validation error handling', () => {
    it('should transform Zod error with single field error', async () => { ... });
    it('should transform Zod error with multiple field errors', async () => { ... });
  });

  describe('Prisma error handling', () => {
    describe('P2002 - Unique constraint violation', () => {
      it('should handle unique constraint on email field', async () => { ... });
      it('should handle unique constraint on username field', async () => { ... });
    });

    describe('P2025 - Record not found', () => {
      it('should handle record not found error', async () => { ... });
    });
  });
});
```

### Descriptive Test Names

```typescript
// EXCELLENT - Explains scenario and outcome
it('should return 400 status code for validation errors', async () => { ... });
it('should include field-specific errors in response details', async () => { ... });
it('should log error with correct context in production mode', () => { ... });

// GOOD - Clear and specific
it('should validate email format', () => { ... });
it('should reject password without uppercase', () => { ... });

// AVOID - Vague or unclear
it('works', () => { ... });
it('handles errors', () => { ... });
it('test validation', () => { ... });
```

---

## Setup and Teardown

### beforeEach and afterEach

```typescript
describe('API Error Handling', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Set default environment
    (env as { NODE_ENV: string }).NODE_ENV = 'development';
  });

  afterEach(() => {
    // Restore all mocks after each test
    vi.restoreAllMocks();
  });

  it('should log error', () => {
    // Test runs with fresh mocks
  });
});
```

### Test-Specific Setup

```typescript
describe('environment-aware behavior', () => {
  it('should include details in development', async () => {
    // Arrange: Override default environment for this test
    (env as { NODE_ENV: string }).NODE_ENV = 'development';

    // Act
    const response = handleAPIError(error);
    const body = await parseErrorResponse(response);

    // Assert
    expect(body.error.details).toBeDefined();
  });

  it('should exclude details in production', async () => {
    // Arrange: Set production for this test
    (env as { NODE_ENV: string }).NODE_ENV = 'production';

    // Act
    const response = handleAPIError(error);
    const body = await parseErrorResponse(response);

    // Assert
    expect(body.error.details).toBeUndefined();
  });
});
```

---

## Summary

**Key Testing Patterns**:

1. **Structure**: Use consistent file structure with documentation headers
2. **AAA**: Always include Arrange-Act-Assert comments
3. **Shared Mocks**: Use `createMockHeaders()`, `createMockSession()`, `delayed()` from `tests/types/mocks.ts`
4. **Type Guards**: Use `assertDefined()`, `assertHasProperty()`, `parseJSON()` from `tests/helpers/assertions.ts`
5. **Type Safety**: Define response interfaces for type-safe assertions
6. **Error Testing**: Use `instanceof` for type narrowing
7. **Async**: Properly handle promises with `async/await` and `.rejects`
8. **Mocking**: Mock at boundaries (database, auth, external APIs)
9. **Parameterized**: Use test case arrays or `describe.each` to reduce duplication
10. **Edge Cases**: Test boundaries, null/undefined, empty values
11. **Organization**: Group related tests with nested `describe` blocks
12. **Descriptive Names**: Test names should explain scenario and expected outcome

**Test Quality Metrics**:

- Every test should be independent (no shared state)
- Every test should be deterministic (same input = same output)
- Every test should be fast (< 100ms for unit tests)
- Every test should have a clear purpose (test one behavior)

**Before Writing Tests**:

1. Read `.context/testing/` documentation for comprehensive guidance
2. Import shared mock factories from `tests/types/mocks.ts`
3. Import assertion helpers from `tests/helpers/assertions.ts`
4. Review `.claude/skills/testing/gotchas.md` for critical issues to avoid
5. Define response type interfaces
6. Set up proper mocks in `beforeEach`
7. Use AAA pattern with comments

**Related Documentation**:

- `.context/testing/overview.md` - Testing philosophy and tech stack
- `.context/testing/mocking.md` - Dependency mocking strategies
- `.context/testing/decisions.md` - Architectural rationale
- `.context/testing/history.md` - Key learnings and solutions
- `.claude/skills/testing/gotchas.md` - Common pitfalls and solutions
