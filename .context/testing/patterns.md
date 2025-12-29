# Testing Patterns for Sunrise

**Best practices and patterns from Week 1 & 2 implementation**

This document provides proven patterns for writing tests in the Sunrise project, extracted from 404 successfully implemented tests across validation, utility, and API layers.

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

**Key Patterns from 404 Tests**:

1. **Structure**: Use consistent file structure with documentation headers
2. **AAA**: Always include Arrange-Act-Assert comments
3. **Type Safety**: Define response interfaces for type-safe assertions
4. **Error Testing**: Use `instanceof` for type narrowing
5. **Async**: Properly handle promises with `async/await` and `.rejects`
6. **Mocking**: Mock at boundaries (database, auth, external APIs)
7. **Parameterized**: Use test case arrays or `describe.each` to reduce duplication
8. **Edge Cases**: Test boundaries, null/undefined, empty values
9. **Organization**: Group related tests with nested `describe` blocks
10. **Descriptive Names**: Test names should explain scenario and expected outcome

**Test Quality Metrics**:

- Every test should be independent (no shared state)
- Every test should be deterministic (same input = same output)
- Every test should be fast (< 100ms for unit tests)
- Every test should have a clear purpose (test one behavior)

**Before Writing Tests**:

1. Read `gotchas.md` for critical issues to avoid
2. Review existing test files for similar patterns
3. Define response type interfaces
4. Set up proper mocks in `beforeEach`
5. Use AAA pattern with comments
