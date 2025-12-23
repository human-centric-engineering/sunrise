# Complex Test Template - Integration Tests

**Use Case**: API routes with database and authentication, full-stack integration testing

**Complexity**: Complex (Interactive)
**Dependencies**: Prisma, better-auth, Next.js, PostgreSQL
**Mocking**: Minimal (use real database via Testcontainers)

## Template Structure

```typescript
// __tests__/app/api/v1/users/route.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDatabase, clearTestDatabase } from '@/lib/test-utils/database';
import { createMockSession } from '@/lib/test-utils/factories';
import type { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

beforeAll(async () => {
  // Start PostgreSQL container and run migrations
  prisma = await startTestDatabase();
}, 30000); // 30s timeout for container startup

beforeEach(async () => {
  // Clear all data before each test
  await clearTestDatabase(prisma);
});

afterAll(async () => {
  // Cleanup: disconnect and stop container
  await prisma.$disconnect();
});

describe('GET /api/v1/users', () => {
  it('should return paginated users for admin', async () => {
    // Arrange: Create test users
    await prisma.user.createMany({
      data: [
        { email: 'user1@example.com', name: 'User 1', role: 'USER' },
        { email: 'user2@example.com', name: 'User 2', role: 'USER' },
        { email: 'admin@example.com', name: 'Admin', role: 'ADMIN' },
      ],
    });

    const admin = await prisma.user.findUnique({
      where: { email: 'admin@example.com' },
    });
    const adminSession = createMockSession(admin!);

    // Act: Make request as admin
    const response = await fetch('http://localhost:3000/api/v1/users?page=1&limit=10', {
      headers: { Cookie: `session-token=${adminSession.token}` },
    });

    // Assert: Verify response
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data).toHaveLength(3);
    expect(data.meta).toMatchObject({
      page: 1,
      limit: 10,
      total: 3,
      totalPages: 1,
    });
  });

  it('should return 401 for unauthenticated request', async () => {
    const response = await fetch('http://localhost:3000/api/v1/users');

    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error.message).toContain('Authentication required');
  });

  it('should return 403 for non-admin user', async () => {
    // Arrange: Create regular user
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: 'User', role: 'USER' },
    });
    const userSession = createMockSession(user);

    // Act: Make request as regular user
    const response = await fetch('http://localhost:3000/api/v1/users', {
      headers: { Cookie: `session-token=${userSession.token}` },
    });

    // Assert: Verify forbidden
    expect(response.status).toBe(403);
  });

  it('should support pagination', async () => {
    // Create 25 users
    const users = Array.from({ length: 25 }, (_, i) => ({
      email: `user${i}@example.com`,
      name: `User ${i}`,
      role: 'USER' as const,
    }));

    await prisma.user.createMany({ data: users });

    const admin = await prisma.user.create({
      data: { email: 'admin@example.com', name: 'Admin', role: 'ADMIN' },
    });
    const adminSession = createMockSession(admin);

    // Test page 1
    const page1 = await fetch('http://localhost:3000/api/v1/users?page=1&limit=10', {
      headers: { Cookie: `session-token=${adminSession.token}` },
    });
    const data1 = await page1.json();

    expect(data1.data).toHaveLength(10);
    expect(data1.meta.totalPages).toBe(3); // 26 users / 10 per page

    // Test page 2
    const page2 = await fetch('http://localhost:3000/api/v1/users?page=2&limit=10', {
      headers: { Cookie: `session-token=${adminSession.token}` },
    });
    const data2 = await page2.json();

    expect(data2.data).toHaveLength(10);
    expect(data2.meta.page).toBe(2);
  });
});

describe('POST /api/v1/users', () => {
  it('should create user with admin authorization', async () => {
    const admin = await prisma.user.create({
      data: { email: 'admin@example.com', name: 'Admin', role: 'ADMIN' },
    });
    const adminSession = createMockSession(admin);

    const response = await fetch('http://localhost:3000/api/v1/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session-token=${adminSession.token}`,
      },
      body: JSON.stringify({
        name: 'New User',
        email: 'newuser@example.com',
        password: 'SecurePass123!',
        role: 'USER',
      }),
    });

    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data.email).toBe('newuser@example.com');

    // Verify user created in database
    const user = await prisma.user.findUnique({
      where: { email: 'newuser@example.com' },
    });
    expect(user).toBeTruthy();
  });

  it('should return 400 for duplicate email', async () => {
    // Create existing user
    await prisma.user.create({
      data: { email: 'existing@example.com', name: 'Existing', role: 'USER' },
    });

    const admin = await prisma.user.create({
      data: { email: 'admin@example.com', name: 'Admin', role: 'ADMIN' },
    });
    const adminSession = createMockSession(admin);

    const response = await fetch('http://localhost:3000/api/v1/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session-token=${adminSession.token}`,
      },
      body: JSON.stringify({
        name: 'Duplicate',
        email: 'existing@example.com',
        password: 'SecurePass123!',
      }),
    });

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.message).toContain('email');
  });
});
```

## Testing Checklist

For integration tests, ensure you cover:

- [ ] **Authentication**: Test authenticated and unauthenticated requests
- [ ] **Authorization**: Test different user roles (USER, ADMIN, etc.)
- [ ] **Database operations**: Verify CRUD operations work end-to-end
- [ ] **Pagination**: Test pagination, sorting, searching
- [ ] **Error cases**: 400, 401, 403, 404, 500 responses
- [ ] **Data validation**: Invalid input handled correctly
- [ ] **Side effects**: Database state changes verified

## Testcontainers Setup

### Start Test Database

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

export async function startTestDatabase(): Promise<PrismaClient> {
  const container = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  // Run migrations
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });

  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
}
```

### Clear Test Database

```typescript
export async function clearTestDatabase(prisma: PrismaClient): Promise<void> {
  const tables = ['User', 'Session', 'Account', 'VerificationToken'];

  for (const table of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
  }
}
```

## Tips

1. **Use real database**: Testcontainers provides production parity
2. **Clear data between tests**: Ensures test isolation
3. **Create minimal data**: Only create what's needed for each test
4. **Test full HTTP lifecycle**: Request → Response, not just functions
5. **Verify database state**: Check database after operations
6. **Mock authentication**: Use `createMockSession()` for auth
7. **Test authorization**: Verify role-based access control
8. **Timeout handling**: Integration tests may take longer (30s timeout)

## Verification

```bash
# Run integration tests
npm test -- __tests__/app/api

# Expected: All tests pass, 80%+ coverage
# Note: Integration tests are slower (10-30s)
```

## Related Files

- **Source**: `app/api/v1/users/route.ts`, `app/api/v1/users/[id]/route.ts`
- **Test utilities**: `lib/test-utils/database.ts`, `lib/test-utils/factories.ts`
- **Mocking**: See `../mocking/better-auth.md` for auth patterns
- **Other templates**: See `medium.md` for unit tests with mocks
