# Mocking Strategies

Mocking patterns for external dependencies in the Sunrise project. This guide covers when to mock, what to mock, and how to mock common dependencies.

## Mock Philosophy

**Mock at boundaries, not internals**:

- Mock external systems (database, APIs, file I/O)
- Mock framework modules (Next.js headers, cookies, navigation)
- Don't mock your own business logic

**When to mock**:

- Unit tests: Mock all external dependencies
- Integration tests: Mock external boundaries (APIs), use real implementations internally
- Component tests: Mock data fetching, use real UI components

**When NOT to mock**:

- Pure functions (validation schemas, utilities)
- Your own business logic
- Framework features you're specifically testing

**Shared Mock Types**: Use factories from `tests/types/mocks.ts`:

```typescript
import { createMockHeaders, createMockSession, delayed } from '@/tests/types/mocks';
```

---

## Prisma (Database)

**When to use**: Unit tests requiring database operations WITHOUT real database.

**For integration tests**: Use real PostgreSQL via Testcontainers instead of mocking.

### Basic Setup

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(prisma)),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
```

### Common Patterns

```typescript
import { prisma } from '@/lib/db/client';
import { delayed } from '@/tests/types/mocks';

// Mock successful query
vi.mocked(prisma.user.findUnique).mockResolvedValue({
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  role: 'USER',
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Mock not found
vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

// Mock with timing (PrismaPromise compatibility)
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

// Verify calls
expect(prisma.user.findUnique).toHaveBeenCalledWith({
  where: { id: 'user-123' },
});
```

### Error Mocking

```typescript
// Unique constraint violation (P2002)
vi.mocked(prisma.user.create).mockRejectedValue({
  code: 'P2002',
  meta: { target: ['email'] },
});

// Record not found (P2025)
vi.mocked(prisma.user.delete).mockRejectedValue({
  code: 'P2025',
  message: 'Record to delete does not exist.',
});
```

**See** `tests/types/mocks.ts` for `delayed()` helper and PrismaPromise compatibility.

---

## better-auth (Authentication)

**When to use**: Unit tests for auth utilities, protected routes, session management.

### Server-Side Session

```typescript
import { vi } from 'vitest';
import { createMockSession } from '@/tests/types/mocks';

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

import { auth } from '@/lib/auth/config';

// Mock authenticated user
vi.mocked(auth.api.getSession).mockResolvedValue(
  createMockSession({ userId: 'user-123', role: 'ADMIN' }) as any
);

// Mock unauthenticated
vi.mocked(auth.api.getSession).mockResolvedValue(null);
```

### Client-Side Auth

```typescript
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  },
}));

import { authClient } from '@/lib/auth/client';

// Mock successful sign-in
vi.mocked(authClient.signIn.email).mockResolvedValue({
  data: {
    user: { id: '1', email: 'test@example.com' },
    session: { id: 'session-1', token: 'token-123' },
  },
  error: null,
});

// Mock sign-in failure
vi.mocked(authClient.signIn.email).mockResolvedValue({
  data: null,
  error: { message: 'Invalid credentials' },
});
```

**See** `tests/types/mocks.ts` for `createMockSession()` factory with complete session structure.

---

## Next.js (Framework)

**When to use**: Tests using Next.js server/client APIs.

### Server Components

```typescript
import { vi } from 'vitest';
import { createMockHeaders } from '@/tests/types/mocks';

// Mock headers()
vi.mock('next/headers', () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

import { headers } from 'next/headers';

// Use shared mock factory
vi.mocked(headers).mockResolvedValue(createMockHeaders({ 'x-request-id': 'test-123' }) as any);

// Mock cookies
vi.mocked(cookies).mockReturnValue({
  get: vi.fn((name) => ({ name, value: 'test-value' })),
  set: vi.fn(),
  delete: vi.fn(),
});
```

### Redirects

```typescript
// redirect() throws a special error
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
}));

// Test redirect
expect(() => redirect('/dashboard')).toThrow('NEXT_REDIRECT: /dashboard');
```

### Client Components

```typescript
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/current-path',
  useSearchParams: () => new URLSearchParams('?page=1'),
}));

// Verify navigation
expect(mockPush).toHaveBeenCalledWith('/dashboard');
```

**See** `tests/types/mocks.ts` for `createMockHeaders()` factory with complete Headers interface.

---

## Logger (Structured Logging)

**When to use**: Unit tests that use structured logger.

### Basic Setup

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));
```

### Verification

```typescript
import { logger } from '@/lib/logging';

// Verify logging
expect(logger.info).toHaveBeenCalledWith('Operation completed', {
  userId: 'user-123',
  duration: 150,
});

// Verify error logging
expect(logger.error).toHaveBeenCalledWith(
  'Operation failed',
  error,
  expect.objectContaining({ userId: 'user-123' })
);

// Verify call count
expect(logger.debug).toHaveBeenCalledTimes(3);
```

### Context Logger

```typescript
const mockContextLogger = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
};

vi.mocked(logger.withContext).mockReturnValue(mockContextLogger);

// Verify context usage
expect(logger.withContext).toHaveBeenCalledWith({ requestId: 'req-123' });
expect(mockContextLogger.info).toHaveBeenCalledWith('Request processed');
```

---

## Best Practices

1. **Use shared mock factories**: Import from `tests/types/mocks.ts` instead of inline mocks
2. **Mock at module level**: Use `vi.mock()` at top of test file before imports
3. **Reset mocks**: Use `beforeEach(() => vi.clearAllMocks())` for test isolation
4. **Verify calls**: Always verify mocks were called with correct arguments
5. **Type safety**: Use `vi.mocked()` helper for type-safe mock access
6. **Complete types**: Use factory functions to avoid incomplete type errors

## Quick Reference

**Shared mock factories**:

```typescript
import {
  createMockHeaders, // Complete Headers interface
  createMockSession, // Complete better-auth session
  delayed, // PrismaPromise timing helper
} from '@/tests/types/mocks';
```

**Type-safe assertions**:

```typescript
import {
  assertDefined, // Type guard for optional properties
  assertHasProperty, // Type guard for property existence
  parseJSON, // Type-safe response parsing
} from '@/tests/helpers/assertions';
```

---

## Environment Variables

**When to use**: Tests that behave differently based on environment.

### Basic Setup

```typescript
import { vi } from 'vitest';

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

### Environment-Aware Tests

```typescript
describe('environment-aware behavior', () => {
  beforeEach(() => {
    // Reset to default environment
    (env as { NODE_ENV: string }).NODE_ENV = 'development';
  });

  it('should include details in development', async () => {
    // Arrange: Development is default
    const error = new ValidationError('Test error');

    // Act
    const response = handleAPIError(error);
    const body = await response.json();

    // Assert
    expect(body.error.details).toBeDefined();
  });

  it('should exclude details in production', async () => {
    // Arrange: Set production for this test
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    const error = new ValidationError('Test error');

    // Act
    const response = handleAPIError(error);
    const body = await response.json();

    // Assert
    expect(body.error.details).toBeUndefined();
  });
});
```

---

## Next.js Request Mocking

**When to use**: API route tests that need to simulate HTTP requests.

### Basic NextRequest

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

### Request with Headers

```typescript
it('should read authorization header', async () => {
  // Arrange: Create request with headers
  const mockRequest = new NextRequest('http://localhost:3000/api/v1/protected', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer token-123',
      'X-Request-ID': 'req-456',
    },
  });

  // Act
  const response = await GET(mockRequest);

  // Assert
  expect(response.status).toBe(200);
});
```

### Request with Query Parameters

```typescript
it('should parse query parameters', async () => {
  // Arrange: URL includes query params
  const mockRequest = new NextRequest('http://localhost:3000/api/v1/users?page=2&limit=10&q=john');

  // Act
  const response = await GET(mockRequest);
  const data = await response.json();

  // Assert
  expect(data.meta.page).toBe(2);
  expect(data.meta.limit).toBe(10);
});
```

### Request with Route Parameters

For dynamic routes like `[id]`, use context parameter:

```typescript
it('should handle route params', async () => {
  // Arrange
  const mockRequest = new NextRequest('http://localhost:3000/api/v1/users/user-123');
  const context = { params: Promise.resolve({ id: 'user-123' }) };

  // Act
  const response = await GET(mockRequest, context);
  const data = await response.json();

  // Assert
  expect(data.data.id).toBe('user-123');
});
```

---

## API Client Mocking

**When to use**: Component tests that make API calls.

### Basic Setup

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from '@/lib/api/client';
```

### Common Patterns

```typescript
// Mock successful GET
vi.mocked(apiClient.get).mockResolvedValue({
  success: true,
  data: { id: '123', name: 'John' },
});

// Mock successful POST
vi.mocked(apiClient.post).mockResolvedValue({
  success: true,
  data: { id: '456', name: 'New User' },
});

// Mock API error
vi.mocked(apiClient.patch).mockRejectedValue(
  new APIClientError('Validation failed', 400, 'VALIDATION_ERROR')
);

// Verify calls
expect(apiClient.get).toHaveBeenCalledWith('/api/v1/users/123');
expect(apiClient.post).toHaveBeenCalledWith('/api/v1/users', {
  body: { name: 'John', email: 'john@example.com' },
});
```

---

## Best Practices

1. **Use shared mock factories**: Import from `tests/types/mocks.ts` instead of inline mocks
2. **Mock at module level**: Use `vi.mock()` at top of test file before imports
3. **Reset mocks**: Use `beforeEach(() => vi.clearAllMocks())` for test isolation
4. **Verify calls**: Always verify mocks were called with correct arguments
5. **Type safety**: Use `vi.mocked()` helper for type-safe mock access
6. **Complete types**: Use factory functions to avoid incomplete type errors

## Quick Reference

**Shared mock factories**:

```typescript
import {
  createMockHeaders, // Complete Headers interface
  createMockSession, // Complete better-auth session
  delayed, // PrismaPromise timing helper
} from '@/tests/types/mocks';
```

**Type-safe assertions**:

```typescript
import {
  assertDefined, // Type guard for optional properties
  assertHasProperty, // Type guard for property existence
  parseJSON, // Type-safe response parsing
} from '@/tests/helpers/assertions';
```

---

## Test Helpers Reference

The project provides several helper files for common testing scenarios. These complement the mock factories in `tests/types/mocks.ts`.

### API Helpers (`tests/helpers/api.ts`)

Utilities for testing API routes and making mock requests.

| Export                                           | Description                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `createMockRequest(options)`                     | Create a mock NextRequest object with method, URL, body, headers, searchParams |
| `createAuthenticatedRequest(options)`            | Create mock request with session cookie for authenticated routes               |
| `parseJsonResponse(response)`                    | Extract JSON from Response object                                              |
| `assertSuccessResponse(response, expectedData?)` | Assert response matches standardized success format                            |
| `assertErrorResponse(response, code?, message?)` | Assert response matches standardized error format                              |
| `createMockSearchParams(params)`                 | Create URLSearchParams for query parameter testing                             |

```typescript
import { createMockRequest, assertSuccessResponse } from '@/tests/helpers/api';

it('should handle POST request', async () => {
  const request = createMockRequest({
    method: 'POST',
    url: 'http://localhost:3000/api/v1/users',
    body: { name: 'John Doe' },
  });

  const response = await POST(request);
  const json = await response.json();
  assertSuccessResponse(json, { name: 'John Doe' });
});
```

### Auth Helpers (`tests/helpers/auth.ts`)

Utilities for mocking authentication in tests.

| Export                              | Description                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `createMockAuthSession(overrides?)` | Create complete mock session object with user and session data                      |
| `mockGetSession(session)`           | Create mock function for `getSession()` that returns specified session              |
| `mockAuthenticatedUser(role?)`      | Create mock session for authenticated user with specified role                      |
| `mockUnauthenticatedUser()`         | Returns null to simulate no active session                                          |
| `mockAdminUser()`                   | Create mock session for admin user (shorthand for `mockAuthenticatedUser('ADMIN')`) |

```typescript
import { createMockAuthSession, mockGetSession } from '@/tests/helpers/auth';

vi.mock('@/lib/auth/server', () => ({
  getSession: mockGetSession(createMockAuthSession()),
}));
```

### Database Helpers (`tests/helpers/db.ts`)

Utilities for testing database operations with Prisma.

| Export                                   | Description                                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| `mockPrismaClient`                       | Pre-configured mock Prisma client with all common model methods |
| `resetDbMocks()`                         | Reset all database mocks (call in `afterEach`)                  |
| `createMockUser(overrides?)`             | Generate realistic user data with all required fields           |
| `createMockSession(userId?, overrides?)` | Generate realistic session data                                 |

```typescript
import { mockPrismaClient, createMockUser } from '@/tests/helpers/db';

vi.mock('@/lib/db', () => ({ db: mockPrismaClient }));

it('should find user', async () => {
  vi.mocked(mockPrismaClient.user.findUnique).mockResolvedValue(createMockUser());
  // ... test
});
```

### Email Helpers (`tests/helpers/email.ts`)

Utilities for mocking email functionality in tests.

| Export                                  | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `mockEmailSuccess(mock, id?)`           | Configure sendEmail mock to return success  |
| `mockEmailFailure(mock, errorMessage?)` | Configure sendEmail mock to return failure  |
| `mockEmailError(mock, error)`           | Configure sendEmail mock to throw exception |
| `resetEmailMock(mock)`                  | Clear email mock history and configuration  |
| `createMockEmailResult(id?)`            | Create successful SendEmailResult object    |
| `createMockEmailFailure(errorMessage?)` | Create failed SendEmailResult object        |

```typescript
vi.mock('@/lib/email/send');
import { sendEmail } from '@/lib/email/send';
import { mockEmailSuccess } from '@/tests/helpers/email';

beforeEach(() => {
  mockEmailSuccess(vi.mocked(sendEmail));
});
```

### General Mock Utilities (`tests/helpers/mocks.ts`)

Common mocks and factories for general testing scenarios.

| Export                                   | Description                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `mockLogger`                             | Pre-configured mock logger with all methods (debug, info, warn, error, withContext) |
| `mockConsole()`                          | Silence console output during tests (call in describe block)                        |
| `createMockDate(dateString?)`            | Create consistent Date for time-sensitive tests                                     |
| `mockEnv(env)`                           | Temporarily set environment variables for testing                                   |
| `waitFor(ms?)`                           | Helper for async code that needs to settle                                          |
| `createMockFormData(data)`               | Create FormData for form submission testing                                         |
| `createMockFetchResponse(data, status?)` | Create mock Response object for fetch testing                                       |
| `mockFetch(response, status?)`           | Create mock fetch function                                                          |

```typescript
import { mockLogger, createMockDate } from '@/tests/helpers/mocks';

vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

it('should log with timestamp', () => {
  const date = createMockDate('2024-01-01T00:00:00Z');
  // ... test with consistent date
});
```

---

## Mock Factories Reference (`tests/types/mocks.ts`)

Complete list of available mock factories with their types.

| Export                          | Type     | Description                                            |
| ------------------------------- | -------- | ------------------------------------------------------ |
| `MockHeaders`                   | Type     | Complete Headers interface for testing                 |
| `createMockHeaders(headers?)`   | Function | Create mock Headers with specified values              |
| `MockSession`                   | Type     | Complete better-auth session structure                 |
| `createMockSession(overrides?)` | Function | Create mock session with user and session data         |
| `MockUser`                      | Type     | Database user type for testing                         |
| `createMockUser(overrides?)`    | Function | Create mock user with all required fields              |
| `MockPrismaClient`              | Type     | Type-safe Prisma mock client                           |
| `createMockPrisma()`            | Function | Create properly typed Prisma mock with all methods     |
| `delayed(value, ms)`            | Function | PrismaPromise-compatible async helper for timing tests |
| `MockLogger`                    | Type     | Logger interface for testing                           |
| `createMockLogger()`            | Function | Create mock logger instance                            |

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy
- [Testing Patterns](./patterns.md) - General patterns
- [Type Safety](./type-safety.md) - Type-safe testing
- [Async Testing](./async-testing.md) - Async patterns
- [Edge Cases](./edge-cases.md) - Error testing
