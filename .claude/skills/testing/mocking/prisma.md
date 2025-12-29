# Mocking Prisma

**When to use**: Unit tests that need database operations WITHOUT real database

**What to mock**: Prisma client methods (findUnique, create, update, delete, etc.)

**Important**: For integration tests, use **real PostgreSQL via Testcontainers** instead of mocking.

**NEW (Week 3)**: Use shared mock types from `tests/types/mocks.ts` for consistent, type-safe mocking.

## Mock Prisma Client

### Basic Setup

```typescript
import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Mock the database client module
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(mockPrisma)),
    $disconnect: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));
```

## Common Query Mocks

### findUnique

```typescript
import { prisma } from '@/lib/db/client';

// Mock successful find
vi.mocked(prisma.user.findUnique).mockResolvedValue({
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  role: 'USER',
  emailVerified: new Date(),
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Mock not found (null)
vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

// Verify called with correct args
expect(prisma.user.findUnique).toHaveBeenCalledWith({
  where: { id: 'user-123' },
});
```

### findMany

```typescript
// Mock array of users
vi.mocked(prisma.user.findMany).mockResolvedValue([
  {
    id: 'user-1',
    email: 'user1@example.com',
    name: 'User 1',
    role: 'USER',
    // ... other fields
  },
  {
    id: 'user-2',
    email: 'user2@example.com',
    name: 'User 2',
    role: 'ADMIN',
    // ... other fields
  },
]);

// Mock empty array
vi.mocked(prisma.user.findMany).mockResolvedValue([]);

// Verify pagination args
expect(prisma.user.findMany).toHaveBeenCalledWith({
  skip: 0,
  take: 10,
  orderBy: { createdAt: 'desc' },
});
```

### create

```typescript
// Mock successful create
vi.mocked(prisma.user.create).mockResolvedValue({
  id: 'new-user-id',
  email: 'newuser@example.com',
  name: 'New User',
  role: 'USER',
  // ... other fields
});

// Verify create was called with data
expect(prisma.user.create).toHaveBeenCalledWith({
  data: {
    email: 'newuser@example.com',
    name: 'New User',
    role: 'USER',
  },
});
```

### update

```typescript
// Mock successful update
vi.mocked(prisma.user.update).mockResolvedValue({
  id: 'user-123',
  email: 'test@example.com',
  name: 'Updated Name', // Changed
  role: 'USER',
  // ... other fields
});

// Verify update args
expect(prisma.user.update).toHaveBeenCalledWith({
  where: { id: 'user-123' },
  data: { name: 'Updated Name' },
});
```

### delete

```typescript
// Mock successful delete
vi.mocked(prisma.user.delete).mockResolvedValue({
  id: 'user-123',
  email: 'deleted@example.com',
  // ... other fields
});

// Verify delete was called
expect(prisma.user.delete).toHaveBeenCalledWith({
  where: { id: 'user-123' },
});
```

### count

```typescript
// Mock count
vi.mocked(prisma.user.count).mockResolvedValue(42);

// Verify count was called
expect(prisma.user.count).toHaveBeenCalledWith({
  where: { role: 'USER' },
});
```

## Mocking Prisma Errors

### Unique Constraint Violation (P2002)

```typescript
vi.mocked(prisma.user.create).mockRejectedValue({
  code: 'P2002',
  meta: { target: ['email'] },
  message: 'Unique constraint failed on the fields: (`email`)',
});
```

### Record Not Found (P2025)

```typescript
vi.mocked(prisma.user.delete).mockRejectedValue({
  code: 'P2025',
  message: 'Record to delete does not exist.',
});
```

### Foreign Key Constraint (P2003)

```typescript
vi.mocked(prisma.user.delete).mockRejectedValue({
  code: 'P2003',
  meta: { field_name: 'userId' },
  message: 'Foreign key constraint failed on the field: `userId`',
});
```

## Transaction Mocking

```typescript
// Mock transaction callback execution
vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
  // Execute callback with mocked prisma
  return callback(prisma);
});

// Usage in test
await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: { ... } });
  await tx.account.create({ data: { ... } });
});
```

## Handling PrismaPromise Types (Week 3 Pattern)

**Problem**: Prisma 7 returns `PrismaPromise<T>` which is incompatible with standard `Promise<T>` in mocks.

**Solution**: Use the `delayed()` helper from `tests/types/mocks.ts` for async operations with delays.

```typescript
import { delayed } from '@/tests/types/mocks';

// ✅ CORRECT - Use delayed() for async mocks with timing
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 10) as any);

// ✅ CORRECT - For immediate responses, use mockResolvedValue
vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

// ❌ INCORRECT - Don't create Promise manually (type mismatch)
vi.mocked(prisma.$queryRaw).mockImplementation(
  () =>
    new Promise((resolve) => {
      setTimeout(() => resolve([{ result: 1 }]), 10);
    })
);
```

**Why `delayed()` Helper**:

1. Handles PrismaPromise vs Promise type differences
2. Provides consistent timing behavior for tests
3. Avoids `as any` casts scattered throughout tests
4. Type-safe alternative to manual Promise creation

**delayed() Implementation**:

```typescript
// From tests/types/mocks.ts
export async function delayed<T>(value: T, ms: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}
```

**Usage in Database Health Tests**:

```typescript
import { delayed } from '@/tests/types/mocks';

it('should measure latency accurately', async () => {
  // Mock query with known 50ms delay
  vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

  const result = await getDatabaseHealth();

  expect(result.latency).toBeGreaterThanOrEqual(50);
  expect(result.latency).toBeLessThan(100);
});
```

## Test Example: Database Utility

```typescript
import { vi, describe, it, expect } from 'vitest';
import { checkDatabaseConnection } from '@/lib/db/utils';
import { prisma } from '@/lib/db/client';

vi.mock('@/lib/db/client');

describe('checkDatabaseConnection', () => {
  it('should return true when database is connected', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

    const result = await checkDatabaseConnection();

    expect(result).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('should return false when database is disconnected', async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('Connection failed'));

    const result = await checkDatabaseConnection();

    expect(result).toBe(false);
  });
});
```

## When NOT to Mock Prisma

**❌ Don't mock for**:

- Integration tests (use real database with Testcontainers)
- Testing actual database constraints
- Testing complex queries with joins
- Testing transaction rollback behavior

**✅ Do mock for**:

- Unit tests of business logic
- Testing error handling
- Testing utility functions that use Prisma
- Fast, isolated tests

## Tips

1. **Integration over mocking**: Prefer real database for API/route tests
2. **Mock at module boundary**: Mock `@/lib/db/client`, not Prisma itself
3. **Verify calls**: Always verify Prisma was called with correct args
4. **Mock errors**: Test Prisma error codes (P2002, P2025, P2003)
5. **Clear mocks**: Use `beforeEach(() => vi.clearAllMocks())`
6. **Type safety**: Use TypeScript to ensure mock data matches schema
7. **Use shared helpers**: Import `delayed()` from `tests/types/mocks.ts` for async timing
8. **PrismaPromise types**: Use `delayed()` helper or `mockResolvedValue()`, not manual Promise creation

## Related Files

- **Source**: `lib/db/client.ts`, `lib/db/utils.ts`
- **Test utilities**: `lib/test-utils/database.ts` (for real database)
- **Templates**: See `../templates/complex.md` for integration tests (no mocking)
