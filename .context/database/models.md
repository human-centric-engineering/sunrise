# Database Models & Usage

## Prisma Client Usage

This document covers practical patterns for working with Prisma models in Sunrise, including CRUD operations, relations, validation, and performance optimization.

## Prisma Client Setup

### Client Singleton

```typescript
// lib/db/client.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from '@/lib/env';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

// Create connection pool (reuse across hot reloads in development)
const pool = globalForPrisma.pool ?? new Pool({ connectionString: env.DATABASE_URL });

if (env.NODE_ENV !== 'production') globalForPrisma.pool = pool;

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Create Prisma client
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

**Why Global**: Prevents creating multiple Prisma clients during Next.js hot-reloading in development.

**Prisma 7 Adapter**: Prisma 7 requires a database adapter. We use `@prisma/adapter-pg` with a `pg` connection pool for PostgreSQL.

## Database Utilities

Utility functions in `lib/db/utils.ts` for common database operations:

| Function                    | Purpose                      | Returns                            |
| --------------------------- | ---------------------------- | ---------------------------------- |
| `checkDatabaseConnection()` | Verify database is reachable | `Promise<boolean>`                 |
| `disconnectDatabase()`      | Safe shutdown                | `Promise<void>`                    |
| `getDatabaseHealth()`       | Health check with latency    | `Promise<{ connected, latency? }>` |
| `executeTransaction(cb)`    | Typed transaction wrapper    | `Promise<T>`                       |

### Usage Examples

```typescript
import {
  checkDatabaseConnection,
  disconnectDatabase,
  getDatabaseHealth,
  executeTransaction,
} from '@/lib/db/utils';

// Health check endpoint
const health = await getDatabaseHealth();
// { connected: true, latency: 5 }

// Transaction with typed callback
const result = await executeTransaction(async (tx) => {
  const user = await tx.user.create({ data: { ... } });
  await tx.account.create({ data: { userId: user.id, ... } });
  return user;
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await disconnectDatabase();
  process.exit(0);
});
```

## Type Imports

Import Prisma types from `@/types/prisma` instead of directly from `@prisma/client`:

```typescript
// ✅ Good - use centralized re-exports
import { User, Session, Account, Prisma } from '@/types/prisma';

// ❌ Avoid - direct imports scatter dependencies
import { User, Session } from '@prisma/client';
```

**Available Types:**

- **Models**: `User`, `Session`, `Account`, `Verification`, `ContactSubmission`, `FeatureFlag`
- **Namespace**: `Prisma` for utility types (`Prisma.UserSelect`, `Prisma.UserWhereInput`, `Prisma.UserCreateInput`, etc.)

**Benefits:**

- Improved IDE autocomplete and type hints
- Decouples application code from Prisma internals
- Easier to mock types in tests

### Import Pattern

```typescript
// Anywhere in the application
import { prisma } from '@/lib/db/client';

// Use directly
const users = await prisma.user.findMany();
```

## CRUD Operations

### Create

```typescript
// Simple create
const user = await prisma.user.create({
  data: {
    name: 'John Doe',
    email: 'john@example.com',
    password: hashedPassword,
    role: 'USER',
  },
});

// Create with relations
const user = await prisma.user.create({
  data: {
    name: 'John Doe',
    email: 'john@example.com',
    accounts: {
      create: {
        type: 'oauth',
        provider: 'google',
        providerAccountId: 'google-id-123',
      },
    },
  },
  include: {
    accounts: true, // Return created user with accounts
  },
});

// Create many (bulk insert)
const users = await prisma.user.createMany({
  data: [
    { name: 'User 1', email: 'user1@example.com' },
    { name: 'User 2', email: 'user2@example.com' },
  ],
  skipDuplicates: true, // Skip on unique constraint violations
});
```

### Read

```typescript
// Find unique
const user = await prisma.user.findUnique({
  where: { id: 'user-id' },
});

// Find unique or throw
const user = await prisma.user.findUniqueOrThrow({
  where: { email: 'john@example.com' },
});

// Find first matching
const user = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
  orderBy: { createdAt: 'desc' },
});

// Find many with filtering
const users = await prisma.user.findMany({
  where: {
    role: 'USER',
    emailVerified: { not: null },
    createdAt: { gte: new Date('2025-01-01') },
  },
  orderBy: { createdAt: 'desc' },
  take: 20,
  skip: 0,
});

// Complex filtering with AND/OR
const users = await prisma.user.findMany({
  where: {
    OR: [{ email: { contains: 'gmail.com' } }, { email: { contains: 'yahoo.com' } }],
    AND: [{ role: 'USER' }, { emailVerified: { not: null } }],
  },
});
```

### Update

```typescript
// Update one
const user = await prisma.user.update({
  where: { id: 'user-id' },
  data: {
    name: 'Jane Doe',
    updatedAt: new Date(), // Automatic with @updatedAt
  },
});

// Update many
const result = await prisma.user.updateMany({
  where: { emailVerified: null },
  data: { role: 'USER' }, // Batch update
});

console.log(`Updated ${result.count} users`);

// Upsert (update or create)
const user = await prisma.user.upsert({
  where: { email: 'john@example.com' },
  update: { name: 'John Updated' },
  create: {
    email: 'john@example.com',
    name: 'John Doe',
  },
});

// Atomic increment
const user = await prisma.user.update({
  where: { id: 'user-id' },
  data: {
    loginCount: { increment: 1 },
  },
});
```

### Delete

```typescript
// Delete one
const user = await prisma.user.delete({
  where: { id: 'user-id' },
});

// Delete many
const result = await prisma.user.deleteMany({
  where: {
    emailVerified: null,
    createdAt: { lt: new Date('2025-01-01') },
  },
});

console.log(`Deleted ${result.count} unverified users`);
```

## Select & Include

### Select Specific Fields

```typescript
// Only select needed fields (better performance)
const user = await prisma.user.findUnique({
  where: { id: 'user-id' },
  select: {
    id: true,
    name: true,
    email: true,
    // password explicitly excluded
  },
});

// Type: { id: string; name: string | null; email: string }
```

### Include Relations

```typescript
// Include related data
const user = await prisma.user.findUnique({
  where: { id: 'user-id' },
  include: {
    accounts: true,
    sessions: true,
  },
});

// Nested includes
const user = await prisma.user.findUnique({
  where: { id: 'user-id' },
  include: {
    accounts: {
      select: {
        provider: true,
        providerAccountId: true,
      },
    },
  },
});

// Filtering included relations
const users = await prisma.user.findMany({
  include: {
    sessions: {
      where: {
        expires: { gt: new Date() }, // Only active sessions
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    },
  },
});
```

## Aggregation & Counting

```typescript
// Count records
const count = await prisma.user.count();

// Count with filter
const adminCount = await prisma.user.count({
  where: { role: 'ADMIN' },
});

// Aggregate functions
const stats = await prisma.user.aggregate({
  _count: true,
  _min: { createdAt: true },
  _max: { createdAt: true },
});

// Group by
const usersByRole = await prisma.user.groupBy({
  by: ['role'],
  _count: true,
  _sum: { loginCount: true },
});

// Result: [
//   { role: 'USER', _count: 150, _sum: { loginCount: 1500 } },
//   { role: 'ADMIN', _count: 5, _sum: { loginCount: 200 } },
// ]
```

## Transactions

### Sequential Transactions

```typescript
// All operations succeed or all fail
const [user, account] = await prisma.$transaction([
  prisma.user.create({
    data: { name: 'John', email: 'john@example.com' },
  }),
  prisma.account.create({
    data: {
      userId: 'user-id',
      provider: 'google',
      providerAccountId: 'google-123',
      type: 'oauth',
    },
  }),
]);
```

### Interactive Transactions

```typescript
// Complex transaction logic
const result = await prisma.$transaction(async (tx) => {
  // Check if email exists
  const existing = await tx.user.findUnique({
    where: { email: 'john@example.com' },
  });

  if (existing) {
    throw new Error('Email already exists');
  }

  // Create user
  const user = await tx.user.create({
    data: {
      name: 'John',
      email: 'john@example.com',
      password: hashedPassword,
    },
  });

  // Create account
  const account = await tx.account.create({
    data: {
      userId: user.id,
      provider: 'credentials',
      providerAccountId: user.id,
      type: 'credentials',
    },
  });

  return { user, account };
});
```

### Transaction Isolation

```typescript
// Set isolation level
await prisma.$transaction(
  async (tx) => {
    // Transaction logic
  },
  {
    isolationLevel: 'Serializable', // Highest isolation
    maxWait: 5000, // Max time to wait for transaction start
    timeout: 10000, // Max transaction duration
  }
);
```

## Raw Queries

### Raw SQL Queries

```typescript
// Raw query (use sparingly)
const users = await prisma.$queryRaw`
  SELECT id, name, email
  FROM users
  WHERE email LIKE ${`%${searchTerm}%`}
  ORDER BY created_at DESC
  LIMIT 10
`;

// Type-safe raw query
import { Prisma } from '@prisma/client';

const users = await prisma.$queryRaw<User[]>`
  SELECT * FROM users WHERE role = ${Prisma.sql`'ADMIN'`}
`;

// Execute raw SQL (DDL, no return value)
await prisma.$executeRaw`
  UPDATE users SET last_login_at = NOW() WHERE id = ${userId}
`;
```

**When to Use Raw SQL**:

- Complex queries Prisma doesn't support well
- Performance-critical queries needing specific SQL
- Database-specific features (CTEs, window functions)

**Caution**: Validate inputs carefully to prevent SQL injection

## Validation Patterns

### Input Validation with Zod

```typescript
// lib/validations/user.ts
import { z } from 'zod';

export const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(100),
  role: z.enum(['USER', 'ADMIN']).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

// API route
export async function POST(request: Request) {
  const body = await request.json();

  // Validate input
  const validatedData = createUserSchema.parse(body);

  // Create user
  const user = await prisma.user.create({
    data: {
      ...validatedData,
      password: await hashPassword(validatedData.password),
    },
  });

  return Response.json({ success: true, data: user });
}
```

### Prisma Schema Constraints

```prisma
// Database-level constraints
model User {
  email String @unique  // Enforced by database

  @@index([email])
}
```

**Two-Layer Validation**:

1. **Zod (Application)**: Validate input format and business rules
2. **Prisma/PostgreSQL (Database)**: Enforce data integrity constraints

## Common Patterns

### Direct Prisma Access

API routes use direct Prisma client access rather than a repository abstraction layer. This keeps the codebase simple while Prisma provides full type safety.

```typescript
// app/api/v1/users/[id]/route.ts
import { prisma } from '@/lib/db/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';

export const GET = withAdminAuth(async (request, _session, { params }) => {
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  return successResponse(user);
});
```

### Safe Field Selection

Use explicit `select` to avoid exposing sensitive fields. Define reusable selection objects for consistency:

```typescript
// Define once, use across routes
const USER_PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  image: true,
  createdAt: true,
} as const;

// In API routes
const user = await prisma.user.findUnique({
  where: { id },
  select: USER_PUBLIC_FIELDS,
});

// For lists
const users = await prisma.user.findMany({
  select: USER_PUBLIC_FIELDS,
  take: limit,
  skip,
});
```

**Why not repositories?** For a starter template, repositories add abstraction without clear benefit. Prisma already provides a clean query API with full type safety. Direct access is simpler to understand and maintain.

### Pagination Utilities

Pagination is implemented through multiple utilities working together:

| Location                    | Utility                   | Purpose                                   |
| --------------------------- | ------------------------- | ----------------------------------------- |
| `lib/validations/common.ts` | `paginationQuerySchema`   | Zod schema for page/limit validation      |
| `lib/validations/common.ts` | `listQuerySchema`         | Combined pagination + sorting + search    |
| `lib/api/validation.ts`     | `parsePaginationParams()` | Extract page/limit/skip from query params |
| `lib/api/responses.ts`      | `paginatedResponse()`     | Create standardized paginated response    |

#### Validation Schemas

```typescript
// lib/validations/common.ts
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

// Combined schema for list endpoints
export const listQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  ...sortingQuerySchema.shape,
  ...searchQuerySchema.shape,
});
```

#### Pagination Parsing

```typescript
// lib/api/validation.ts
export function parsePaginationParams(searchParams: URLSearchParams): {
  page: number;
  limit: number;
  skip: number; // Calculated: (page - 1) * limit
};
```

#### Paginated Response

```typescript
// lib/api/responses.ts
export function paginatedResponse<T>(
  data: T[],
  pagination: { page: number; limit: number; total: number },
  options?: { status?: number; headers?: HeadersInit }
): Response;
```

#### Usage in API Routes

```typescript
// app/api/v1/users/route.ts
export const GET = withAdminAuth(async (request, _session) => {
  const { searchParams } = request.nextUrl;
  const query = validateQueryParams(searchParams, listUsersQuerySchema);
  const { page, limit, skip } = parsePaginationParams(searchParams);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    }),
    prisma.user.count({ where }),
  ]);

  return paginatedResponse(users, { page, limit, total });
});
```

Used in: admin users (`/api/v1/users`), admin logs (`/api/v1/admin/logs`), invitations (`/api/v1/admin/invitations`).

## Performance Optimization

### N+1 Query Prevention

```typescript
// Bad: N+1 queries
const users = await prisma.user.findMany();
for (const user of users) {
  // Separate query for each user!
  const accounts = await prisma.account.findMany({
    where: { userId: user.id },
  });
}

// Good: Single query with include
const users = await prisma.user.findMany({
  include: { accounts: true },
});
```

### Field Selection

```typescript
// Bad: Fetch entire row (including large fields)
const users = await prisma.user.findMany();

// Good: Select only needed fields
const users = await prisma.user.findMany({
  select: { id: true, name: true, email: true },
});
```

### Query Optimization

```typescript
// Use indexes for filtering
const users = await prisma.user.findMany({
  where: {
    email: 'john@example.com', // Uses index on email
  },
});

// Avoid computed filtering (can't use index)
const users = await prisma.user.findMany();
const filtered = users.filter((u) => u.email.includes('@gmail.com'));
// Better: Use database filtering
const users = await prisma.user.findMany({
  where: { email: { contains: '@gmail.com' } },
});
```

## Error Handling

```typescript
import { Prisma } from '@prisma/client';

try {
  const user = await prisma.user.create({
    data: { email: 'duplicate@example.com', name: 'John' },
  });
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint violation
    if (error.code === 'P2002') {
      console.error('Email already exists');
    }

    // Record not found
    if (error.code === 'P2025') {
      console.error('Record not found');
    }
  }

  throw error;
}
```

**Common Error Codes**:

- `P2002`: Unique constraint violation
- `P2025`: Record not found
- `P2003`: Foreign key constraint violation
- `P2034`: Transaction conflict

## Decision History & Trade-offs

### Repository Pattern vs. Direct Prisma

**Decision**: Provide both patterns, repositories optional
**Rationale**:

- Repositories: Encapsulate complex queries, provide abstraction
- Direct Prisma: Simpler for straightforward CRUD
- Team flexibility

**Trade-offs**: Inconsistent patterns if not disciplined

### Select vs. Include Default

**Decision**: Explicit select for user-facing queries
**Rationale**:

- Security (never accidentally return passwords)
- Performance (only fetch needed fields)
- Clear intent in code

**Trade-offs**: More verbose queries

## Related Documentation

- [Database Schema](./schema.md) - Prisma schema design
- [Database Migrations](./migrations.md) - Migration workflow
- [API Endpoints](../api/endpoints.md) - Using models in API routes
- [Architecture Patterns](../architecture/patterns.md) - Error handling
