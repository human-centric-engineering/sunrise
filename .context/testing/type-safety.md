# Type Safety in Tests

Patterns for maintaining type safety in tests, including response type interfaces, shared mock types, and assertion helpers.

---

## Response Type Interfaces

### Define Response Types

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

// AVOID: Direct access (type error)
expect(parsed.meta.userId).toBe('user-123'); // Error: meta possibly undefined

// AVOID: Non-null assertion (runtime risk)
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

### parseJSON() / parseResponse()

**Purpose**: Type-safe response parsing.

**Two acceptable patterns exist**:

1. **Shared helper** (`parseJSON` from `tests/helpers/assertions.ts`) - for reuse across files
2. **Local helper** (`parseResponse` defined in test file) - for self-contained tests

Both patterns are valid. Use the shared helper when you need the assertion behavior, or define a local `parseResponse` when you want minimal dependencies.

```typescript
// Pattern 1: Shared helper
import { parseJSON } from '@/tests/helpers/assertions';

it('should return user data', async () => {
  const response = await GET();
  const body = await parseJSON<UserResponse>(response);
  expect(body.success).toBe(true);
});

// Pattern 2: Local helper (equally valid)
async function parseResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

it('should return user data', async () => {
  const response = await GET();
  const body = await parseResponse<UserResponse>(response);
  expect(body.success).toBe(true);
});
```

---

## Type Narrowing for Errors

### Using instanceof for Error Types

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

### Testing Zod Validation

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

## Summary

**Key Principles**:

1. **Define response interfaces** - For type-safe response parsing
2. **Use shared mock factories** - `createMockHeaders()`, `createMockSession()`, `delayed()`
3. **Use assertion helpers** - `assertDefined()`, `assertHasProperty()`, `parseJSON()`
4. **Use instanceof for errors** - Type narrowing instead of type assertions
5. **Avoid non-null assertions** - Use type guards instead of `!`

**Import Locations**:

```typescript
// Mock factories
import { createMockHeaders, createMockSession, delayed } from '@/tests/types/mocks';

// Assertion helpers
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy
- [Testing Patterns](./patterns.md) - General patterns
- [Mocking Strategies](./mocking.md) - Mock patterns
- [Testing History](./history.md) - Background on helpers
