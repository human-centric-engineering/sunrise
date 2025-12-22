# Database Models & Usage

## Prisma Client Usage

This document covers practical patterns for working with Prisma models in Sunrise, including CRUD operations, relations, validation, and performance optimization.

## Prisma Client Setup

### Client Singleton

```typescript
// lib/db/client.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

**Why Global**: Prevents creating multiple Prisma clients during Next.js hot-reloading in development.

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
  role: z.enum(['USER', 'ADMIN', 'MODERATOR']).optional(),
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

### User Repository Pattern

```typescript
// lib/repositories/user-repository.ts
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';

export class UserRepository {
  // Safe user selection (excludes password)
  private readonly safeSelect = {
    id: true,
    name: true,
    email: true,
    role: true,
    emailVerified: true,
    image: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: this.safeSelect,
    });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      // Include password for authentication
    });
  }

  async findByEmailSafe(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: this.safeSelect,
    });
  }

  async create(data: Prisma.UserCreateInput) {
    return prisma.user.create({
      data,
      select: this.safeSelect,
    });
  }

  async updateLastLogin(id: string) {
    return prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  async search(query: string, limit = 20) {
    return prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: this.safeSelect,
      take: limit,
    });
  }
}

export const userRepository = new UserRepository();
```

### Pagination Helper

```typescript
// lib/db/pagination.ts
export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export async function paginate<T>(
  model: any,
  params: PaginationParams,
  where?: any
): Promise<PaginatedResult<T>> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    model.findMany({
      where,
      skip,
      take: limit,
    }),
    model.count({ where }),
  ]);

  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// Usage
const result = await paginate(
  prisma.user,
  { page: 1, limit: 20 },
  {
    role: 'USER',
  }
);
```

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
