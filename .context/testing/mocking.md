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

**For detailed examples, see**:

- `.claude/skills/testing/templates/` - Test templates by complexity
- `tests/unit/` - 545 unit tests with mocking examples
- `tests/integration/` - 14 integration tests with boundary mocking
