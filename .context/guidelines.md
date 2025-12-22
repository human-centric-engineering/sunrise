# Development Guidelines

## Development Workflow

This document defines the development workflow, testing strategies, deployment procedures, and operational guidelines for Sunrise.

## Environment Setup

### Prerequisites

- Node.js 20+ (LTS recommended)
- PostgreSQL 15+ (local or Docker)
- Docker Desktop (for containerized development)
- Git
- npm (comes with Node.js)

### Initial Setup

```bash
# 1. Clone repository
git clone https://github.com/your-org/sunrise.git
cd sunrise

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env.local

# Edit .env.local with your database credentials
# Required: DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL

# 4. Initialize database
npx prisma migrate dev

# 5. Seed database (optional)
npx prisma db seed

# 6. Start development server
npm run dev

# Application runs at http://localhost:3000
```

### Environment Variables

```bash
# .env.local (required for development)

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/sunrise"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"

# OAuth (optional)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Email (optional)
RESEND_API_KEY="your-resend-api-key"
EMAIL_FROM="noreply@localhost"

# Node Environment
NODE_ENV="development"
```

**Generate NEXTAUTH_SECRET**:

```bash
openssl rand -base64 32
```

## Development Commands

### Core Commands

```bash
# Development
npm run dev              # Start dev server with hot reload
npm run build            # Build for production
npm run start            # Start production server
npm run lint             # Run ESLint
npm run lint:fix         # Fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check formatting
npm run type-check       # Run TypeScript compiler
npm run validate         # Run all checks (type + lint + format)
```

### Database Commands

```bash
# Migrations
npx prisma migrate dev           # Create and apply migration
npx prisma migrate dev --name add_feature  # Named migration
npx prisma migrate deploy        # Apply migrations (production)
npx prisma migrate status        # Check migration status
npx prisma migrate reset         # Reset database (WARNING: deletes data)

# Database Operations
npx prisma db push               # Push schema without migration (prototyping)
npx prisma db pull               # Pull schema from database
npx prisma db seed               # Run seed script

# Client Generation
npx prisma generate              # Generate Prisma Client
npx prisma studio                # Open Prisma Studio GUI
```

### Testing Commands

```bash
npm run test                     # Run all tests
npm run test:watch              # Run tests in watch mode
npm run test:coverage           # Run tests with coverage report
npm run test:unit               # Run unit tests only
npm run test:integration        # Run integration tests only
```

### Docker Commands

```bash
# Development Environment
docker-compose up                # Start all services
docker-compose up --build        # Rebuild and start
docker-compose down              # Stop all services
docker-compose logs -f web       # View app logs

# Production Build
docker build -t sunrise .                     # Build production image
docker run -p 3000:3000 sunrise               # Run container
docker-compose -f docker-compose.prod.yml up  # Production stack
```

## Code Quality

### Pre-Commit Workflow

```bash
# Before committing
npm run validate     # Type check + lint + format check

# Or use git hooks (Husky + lint-staged)
# Automatically runs on git commit
```

### Husky Configuration

```json
// package.json
{
  "husky": {
    "hooks": {
      "pre-commit": "lint-staged",
      "pre-push": "npm run type-check && npm test"
    }
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

### ESLint Configuration

```javascript
// .eslintrc.json
{
  "extends": [
    "next/core-web-vitals",
    "prettier"
  ],
  "rules": {
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  }
}
```

### Prettier Configuration

```json
// .prettierrc
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 90,
  "tabWidth": 2,
  "useTabs": false
}
```

## Testing Strategy

### Test Structure

```
tests/
├── setup.ts                 # Test configuration
├── unit/                    # Unit tests
│   ├── auth.test.ts
│   ├── validation.test.ts
│   └── utils.test.ts
├── integration/             # Integration tests
│   ├── api/
│   │   ├── users.test.ts
│   │   └── auth.test.ts
│   └── db/
│       └── user-repository.test.ts
└── e2e/                     # End-to-end tests (optional)
    └── auth-flow.test.ts
```

### Unit Test Example

```typescript
// tests/unit/validation.test.ts
import { describe, it, expect } from 'vitest';
import { createUserSchema } from '@/lib/validations/user';

describe('User Validation', () => {
  it('validates correct user data', () => {
    const validData = {
      name: 'John Doe',
      email: 'john@example.com',
      password: 'SecurePass123!',
    };

    const result = createUserSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const invalidData = {
      name: 'John Doe',
      email: 'not-an-email',
      password: 'SecurePass123!',
    };

    const result = createUserSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    expect(result.error?.errors[0].path).toEqual(['email']);
  });

  it('rejects weak password', () => {
    const weakPassword = {
      name: 'John Doe',
      email: 'john@example.com',
      password: 'weak',
    };

    const result = createUserSchema.safeParse(weakPassword);
    expect(result.success).toBe(false);
  });
});
```

### Integration Test Example

```typescript
// tests/integration/api/users.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db/client';
import { createMockSession } from '../helpers';

describe('GET /api/v1/users/me', () => {
  beforeEach(async () => {
    // Clean up test database
    await prisma.user.deleteMany();
  });

  it('returns current user for authenticated request', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'test@example.com',
        name: 'Test User',
      },
    });

    const session = createMockSession(user);

    const response = await fetch('http://localhost:3000/api/v1/users/me', {
      headers: {
        Cookie: `session-token=${session.token}`,
      },
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data.email).toBe('test@example.com');
  });

  it('returns 401 for unauthenticated request', async () => {
    const response = await fetch('http://localhost:3000/api/v1/users/me');

    expect(response.status).toBe(401);
  });
});
```

### Test Coverage Goals

- **Critical Paths**: 80%+ coverage (authentication, authorization, validation)
- **Business Logic**: 70%+ coverage (utilities, services, repositories)
- **UI Components**: Manual testing acceptable (or add E2E tests)

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/unit/validation.test.ts

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Coverage report at coverage/index.html
```

## Git Workflow

### Branching Strategy

```bash
# Main branches
main        # Production-ready code
develop     # Development branch (optional)

# Feature branches
feature/add-user-profile
feature/oauth-integration

# Fix branches
fix/login-redirect-bug
fix/email-validation

# Hotfix branches (critical production fixes)
hotfix/security-patch
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
feat: add user profile page
fix: resolve login redirect issue
docs: update deployment guide
refactor: simplify auth utilities
test: add validation tests
chore: update dependencies
```

**Examples**:

```bash
git commit -m "feat: add password reset flow"
git commit -m "fix: correct email validation regex"
git commit -m "docs: add API endpoint documentation"
git commit -m "test: add unit tests for auth utilities"
```

### Pull Request Process

1. **Create Feature Branch**:

```bash
git checkout -b feature/new-feature
```

2. **Make Changes and Commit**:

```bash
git add .
git commit -m "feat: add new feature"
```

3. **Push to Remote**:

```bash
git push -u origin feature/new-feature
```

4. **Create Pull Request** via GitHub/GitLab

5. **Code Review Checklist**:
   - [ ] Tests pass
   - [ ] Linting passes
   - [ ] Type checking passes
   - [ ] Code reviewed by peer
   - [ ] Documentation updated
   - [ ] No merge conflicts

6. **Merge to Main**:

```bash
# Squash and merge (recommended)
# Or rebase and merge
```

## Deployment

### Deployment Checklist

**Pre-Deployment**:

- [ ] All tests pass
- [ ] Code reviewed and approved
- [ ] Environment variables configured
- [ ] Database migrations ready
- [ ] Database backup completed
- [ ] Changelog updated

**Deployment Steps**:

- [ ] Build Docker image
- [ ] Push to container registry
- [ ] Apply database migrations
- [ ] Deploy new version
- [ ] Verify health check
- [ ] Monitor error logs

**Post-Deployment**:

- [ ] Smoke tests passed
- [ ] Monitor performance metrics
- [ ] Check error rates
- [ ] Verify critical user flows

### Docker Deployment

**Build Production Image**:

```bash
# Build image
docker build -t sunrise:latest .

# Tag for registry
docker tag sunrise:latest registry.example.com/sunrise:1.0.0

# Push to registry
docker push registry.example.com/sunrise:1.0.0
```

**Deploy with Docker Compose**:

```bash
# Pull latest image
docker-compose pull

# Apply database migrations
docker-compose run --rm web npx prisma migrate deploy

# Start services
docker-compose up -d

# Check health
curl http://localhost:3000/api/health
```

### Platform-Specific Deployment

**Vercel** (Easiest):

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Set environment variables in Vercel dashboard
```

**Railway**:

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Deploy
railway up
```

**Self-Hosted** (see [DEPLOYMENT.md](../.instructions/DEPLOYMENT.md))

### Environment-Specific Configuration

**Development**:

```bash
NODE_ENV=development
NEXTAUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://localhost:5432/sunrise_dev
```

**Staging**:

```bash
NODE_ENV=production
NEXTAUTH_URL=https://staging.sunrise.com
DATABASE_URL=postgresql://staging-db:5432/sunrise
```

**Production**:

```bash
NODE_ENV=production
NEXTAUTH_URL=https://sunrise.com
DATABASE_URL=postgresql://prod-db:5432/sunrise
```

## Monitoring & Logging

### Health Checks

```bash
# Check application health
curl https://api.sunrise.com/api/health

# Expected response
{
  "status": "ok",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "database": "connected"
}
```

### Logging Best Practices

```typescript
// Good: Structured logging with context
console.log('[API] User login:', {
  userId: user.id,
  timestamp: new Date().toISOString(),
  ip: request.ip,
});

// Bad: Unstructured logging
console.log('User logged in');
```

### Error Tracking

**Integrate Sentry** (optional):

```typescript
// lib/monitoring/sentry.ts
import * as Sentry from '@sentry/nextjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,
  });
}

// Use in error boundaries
Sentry.captureException(error);
```

## Security Guidelines

### Secrets Management

```bash
# NEVER commit secrets to git
.env.local           # In .gitignore
.env.production      # In .gitignore

# Use environment variables
DATABASE_URL=postgresql://...
NEXTAUTH_SECRET=...

# For production, use secret managers
# - Vercel: Environment Variables
# - AWS: Secrets Manager
# - Docker: Secrets
```

### Security Checklist

- [ ] HTTPS enforced in production
- [ ] Security headers configured (CSP, HSTS, X-Frame-Options)
- [ ] Rate limiting enabled on auth endpoints
- [ ] All inputs validated with Zod
- [ ] Passwords hashed with bcrypt (12 rounds)
- [ ] SQL injection prevented (Prisma parameterized queries)
- [ ] XSS prevented (React auto-escaping + CSP)
- [ ] CSRF protection enabled (NextAuth)
- [ ] Dependencies updated regularly (`npm audit`)
- [ ] Environment variables validated at startup

## Performance Guidelines

### Optimization Checklist

- [ ] Use server components by default
- [ ] Select only needed database fields
- [ ] Implement pagination for list endpoints
- [ ] Use database indexes on frequently queried fields
- [ ] Enable caching for static/public data
- [ ] Optimize images with Next.js Image component
- [ ] Minimize client-side JavaScript
- [ ] Use dynamic imports for heavy components
- [ ] Monitor Core Web Vitals

### Performance Monitoring

```bash
# Check bundle size
npm run build

# Analyze bundle
npm install -g @next/bundle-analyzer
```

## Troubleshooting

### Common Issues

**Database Connection Fails**:

```bash
# Check DATABASE_URL format
postgresql://user:password@host:5432/database

# Test connection
psql $DATABASE_URL

# Check Prisma connection
npx prisma db pull
```

**Build Fails**:

```bash
# Clear Next.js cache
rm -rf .next

# Clear node_modules
rm -rf node_modules && npm install

# Check TypeScript errors
npm run type-check
```

**Migrations Fail**:

```bash
# Check migration status
npx prisma migrate status

# Reset database (development only!)
npx prisma migrate reset

# Resolve failed migration
npx prisma migrate resolve --rolled-back migration_name
```

## Related Documentation

- [Architecture Overview](./architecture/overview.md) - System architecture
- [Database Migrations](./database/migrations.md) - Migration workflow
- [API Endpoints](./api/endpoints.md) - API reference
- [Deployment Guide](../.instructions/DEPLOYMENT.md) - Detailed deployment instructions
