# Dependency Management

## Dependency Philosophy

Sunrise follows a **lean dependency strategy**: use battle-tested libraries for complex problems (authentication, ORM, validation) while keeping the overall dependency count minimal to reduce maintenance burden and security surface area.

### Core Dependencies

**Framework & Runtime:**
```json
{
  "next": "^14.0.0",
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "typescript": "^5.3.0"
}
```

**Database & Validation:**
```json
{
  "@prisma/client": "^5.7.0",
  "prisma": "^5.7.0",
  "zod": "^3.22.4"
}
```

**Authentication:**
```json
{
  "next-auth": "^5.0.0-beta",
  "@auth/prisma-adapter": "^1.0.0",
  "bcrypt": "^5.1.1",
  "@types/bcrypt": "^5.0.2"
}
```

**UI & Styling:**
```json
{
  "tailwindcss": "^3.4.0",
  "@radix-ui/react-*": "^1.0.0",
  "class-variance-authority": "^0.7.0",
  "clsx": "^2.0.0",
  "tailwind-merge": "^2.2.0",
  "lucide-react": "^0.294.0"
}
```

**Email:**
```json
{
  "resend": "^3.0.0",
  "@react-email/components": "^0.0.12"
}
```

## Dependency Injection Patterns

### Database Client Singleton

Prisma client must be instantiated once and reused across the application to prevent connection pool exhaustion:

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

**Why Global Variable**: Next.js hot-reloading in development creates new module instances. Without global storage, each reload creates a new Prisma client, exhausting database connections.

**Import Pattern**:
```typescript
// Anywhere in the app
import { prisma } from '@/lib/db/client';

// Use directly
const users = await prisma.user.findMany();
```

### Service Layer Pattern

For complex business logic, create service modules that encapsulate dependencies:

```typescript
// lib/services/user-service.ts
import { prisma } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/passwords';
import { sendWelcomeEmail } from '@/lib/email/templates';

export class UserService {
  async createUser(data: CreateUserInput) {
    // Validate
    const validatedData = createUserSchema.parse(data);

    // Hash password
    const hashedPassword = await hashPassword(validatedData.password);

    // Create user
    const user = await prisma.user.create({
      data: {
        ...validatedData,
        password: hashedPassword,
      },
    });

    // Send welcome email
    await sendWelcomeEmail(user.email, user.name);

    return user;
  }
}

// Export singleton instance
export const userService = new UserService();
```

**Usage in API Routes**:
```typescript
// app/api/v1/users/route.ts
import { userService } from '@/lib/services/user-service';

export async function POST(request: Request) {
  const data = await request.json();

  try {
    const user = await userService.createUser(data);
    return Response.json({ success: true, data: user });
  } catch (error) {
    return Response.json(
      { success: false, error: { message: error.message } },
      { status: 400 }
    );
  }
}
```

### Configuration Objects

Centralize configuration to avoid scattered magic strings:

```typescript
// lib/config.ts
export const config = {
  app: {
    name: 'Sunrise',
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  },
  auth: {
    sessionMaxAge: 30 * 24 * 60 * 60, // 30 days in seconds
    verificationTokenExpiry: 24 * 60 * 60 * 1000, // 24 hours in ms
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  email: {
    from: process.env.EMAIL_FROM || 'noreply@sunrise.com',
    apiKey: process.env.RESEND_API_KEY,
  },
  features: {
    enableGoogleOAuth: !!process.env.GOOGLE_CLIENT_ID,
    enableEmailVerification: true,
  },
} as const;

// Type-safe access
import { config } from '@/lib/config';
console.log(config.auth.sessionMaxAge); // TypeScript knows this is a number
```

### Environment Variable Validation

Validate environment variables at startup to fail fast:

```typescript
// lib/env.ts
import { z } from 'zod';

const envSchema = z.object({
  // Required
  DATABASE_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(32),
  NEXTAUTH_URL: z.string().url(),

  // Optional
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),

  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export const env = envSchema.parse(process.env);

// Usage
import { env } from '@/lib/env';
const dbUrl = env.DATABASE_URL; // Type-safe and validated
```

**Benefits**:
- Application won't start with invalid configuration
- TypeScript autocomplete for environment variables
- Single source of truth for required vs. optional variables
- Clear error messages when variables are missing

## Utility Function Organization

### Path Aliases

Configure TypeScript path aliases for clean imports:

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"],
      "@/components/*": ["./components/*"],
      "@/lib/*": ["./lib/*"],
      "@/app/*": ["./app/*"],
      "@/types/*": ["./types/*"]
    }
  }
}
```

**Import Examples**:
```typescript
// Before
import { Button } from '../../../../components/ui/button';

// After
import { Button } from '@/components/ui/button';
```

### Shared Utilities

Common utility functions organized by domain:

```typescript
// lib/utils.ts - General utilities
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}
```

```typescript
// lib/api/responses.ts - API utilities
export function successResponse<T>(data: T, meta?: Record<string, any>) {
  return {
    success: true as const,
    data,
    ...(meta && { meta }),
  };
}

export function errorResponse(message: string, code?: string, details?: any) {
  return {
    success: false as const,
    error: {
      message,
      ...(code && { code }),
      ...(details && { details }),
    },
  };
}
```

## Decision History & Trade-offs

### Prisma vs. Other ORMs
**Decision**: Prisma over TypeORM, Sequelize, or Drizzle
**Rationale**:
- Best TypeScript integration (generated types match schema exactly)
- Excellent migration workflow
- Prisma Studio for database inspection
- Active development and community support

**Trade-offs**:
- Abstraction layer can limit complex query capabilities
- Vendor-specific schema language (not standard SQL)
- Larger package size than lightweight alternatives

### Next-Auth v5 Beta
**Decision**: Use Next-Auth v5 (beta) despite stable v4 availability
**Rationale**:
- Built for Next.js App Router (v4 designed for Pages Router)
- Better edge runtime support
- Improved TypeScript types
- Future-proof (v5 will be stable soon)

**Trade-offs**:
- Beta software may have undiscovered bugs
- Community resources mostly for v4
- Breaking changes possible before stable release

**Mitigation**: Pin exact version in package.json, comprehensive testing, monitor release notes

### Zod for Validation
**Decision**: Zod over Yup, Joi, or class-validator
**Rationale**:
- TypeScript-first design (infer types from schemas)
- No dependencies (small bundle size)
- Excellent DX (autocomplete, error messages)
- Same schema for client and server validation

**Trade-offs**: Slight learning curve for complex transformations

### shadcn/ui vs. Component Libraries
**Decision**: shadcn/ui over Material-UI, Chakra UI, or Ant Design
**Rationale**:
- Copy-paste components (full control, no npm bloat)
- Built on Radix UI (accessible primitives)
- Tailwind integration (consistent styling)
- Easy customization (components in your codebase)

**Trade-offs**:
- Manual updates (not npm-managed)
- More initial setup for each component
- Smaller ecosystem than established libraries

## Package Management

### Lock File Strategy
**Use**: `package-lock.json` (npm's lock file)
**Commit**: Always commit lock file to repository
**Updates**: Run `npm audit fix` monthly, `npm update` quarterly

### Dependency Update Workflow
```bash
# Check for updates
npm outdated

# Update specific package
npm update package-name

# Update all within semver range
npm update

# Test after updates
npm run type-check && npm run lint && npm test

# Commit lock file changes
git add package-lock.json && git commit -m "chore: update dependencies"
```

### Security Scanning
```bash
# Audit dependencies
npm audit

# Fix vulnerabilities automatically
npm audit fix

# Manual review for breaking changes
npm audit fix --force
```

## Performance Considerations

### Bundle Size Management
- **Avoid large dependencies**: Check bundle impact with `npm view package-name`
- **Use dynamic imports**: Load heavy components only when needed
```typescript
// Heavy component loaded on demand
const HeavyChart = dynamic(() => import('@/components/charts/heavy-chart'), {
  loading: () => <Skeleton />,
});
```
- **Tree-shaking**: Import specific functions, not entire libraries
```typescript
// Good - tree-shakeable
import { format } from 'date-fns';

// Bad - imports entire library
import * as dateFns from 'date-fns';
```

### Database Connection Pooling
```typescript
// Prisma automatically pools connections (default: 10)
// Adjust in schema.prisma if needed:
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  // Add connection limit: ?connection_limit=20
}
```

## Related Documentation

- [Architecture Overview](./overview.md) - System design and component boundaries
- [Patterns](./patterns.md) - Code organization conventions
- [Database Models](../database/models.md) - Prisma schema details
