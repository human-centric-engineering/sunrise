# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Sunrise** is a production-ready Next.js 16 starter template designed for rapid application development. It's optimized for AI-assisted development while maintaining best practices.

**Architecture:** Single monolith Next.js application with App Router, API routes, PostgreSQL database, and Docker-first deployment.

## Context Substrate Documentation

For comprehensive, domain-specific documentation, see the **`.context/` substrate**:

- **[`.context/substrate.md`](./.context/substrate.md)** - Entry point with navigation and AI usage patterns
- **[Architecture](./.context/architecture/overview.md)** - System design, component boundaries, deployment architecture
- **[Authentication](./.context/auth/overview.md)** - better-auth flows, session management, security model
- **[API](./.context/api/endpoints.md)** - REST endpoints, headers, CORS, client examples
- **[Database](./.context/database/schema.md)** - Prisma schema design, models, migrations, ERD diagrams
- **[Guidelines](./.context/guidelines.md)** - Development workflow, testing, deployment procedures

**When to Use**:

- **Deep Implementation Details**: For detailed patterns, use `.context/[domain]/`
- **Quick Reference**: For commands and common tasks, use this `CLAUDE.md`
- **AI Context Loading**: Load specific domains for targeted context (e.g., `.context/auth/` for auth features)

The substrate provides production-ready implementation patterns, decision rationale, security considerations, and performance guidelines for each domain.

## MCP Server Integration

**CRITICAL: Always initialize Next.js DevTools MCP first. Do this without asking**

This project has the **next-devtools** MCP server configured. When starting any work session:

1. **Check for MCP availability:** Look for the `next-devtools` MCP server in your available tools
2. **Initialize FIRST:** If the server is available, ALWAYS call `mcp__next-devtools__init` as your first action - do this without asking
3. **Why this matters:** The init tool:
   - Fetches the latest Next.js documentation and establishes context
   - Sets up MANDATORY documentation requirements for all Next.js queries
   - Ensures you use the `nextjs_docs` tool for ALL Next.js concepts instead of relying on prior knowledge
   - Documents all available MCP tools and their use cases
   - Provides access to Cache Components knowledge, migration guides, and runtime diagnostics

**When to use Next.js DevTools MCP tools:**

- Before implementing ANY changes to the Next.js app (check current state with `nextjs_index` and `nextjs_call`)
- For diagnostic questions ("What's happening?", "Why isn't this working?", "What routes exist?")
- To search the running app (use MCP first, fallback to static codebase search if needed)
- When working with Next.js 16 features, Cache Components, or performing upgrades
- For browser automation testing with `browser_eval`

**Remember:** Always query the Next.js documentation via MCP tools rather than relying on pre-existing knowledge to ensure accuracy with the latest Next.js patterns and best practices.

## Context7 MCP Integration

**IMPORTANT: Use Context7 automatically for library documentation and code generation**

This project has the **context7** MCP server configured for accessing up-to-date library documentation.

### When to Use Context7

**Use Context7 automatically (without asking) when:**

- Writing code that uses external libraries (React, Prisma, better-auth, etc.)
- Implementing features with library-specific APIs
- Troubleshooting library-related issues
- Learning library patterns and best practices
- Migrating between library versions

**How to Use:**

1. **For known libraries:** Use the library ID directly from the list below
2. **For new libraries:** Call `mcp__context7__resolve-library-id` first to find the correct ID
3. **Get documentation:** Call `mcp__context7__get-library-docs` with the library ID and topic
4. **Modes:**
   - `mode: "code"` - API references, code examples, function signatures (default)
   - `mode: "info"` - Conceptual guides, architecture, narrative documentation

### Library Reference List

Use these Context7-compatible library IDs directly (no need to resolve):

**Core Framework & Tools:**

- **Next.js:** `/vercel/next.js` (versions: v16.0.3, v15.1.8, v14.3.0-canary.87, v13.5.11, v12.3.7, v11.1.3)
- **React:** TBC (use for React 19 patterns)
- **Prisma:** `/prisma/docs` (check if version-specific is available)
- **TypeScript:** `/microsoft/typescript`

**Authentication & Security:**

- **better-auth:** `/better-auth/better-auth`

**UI & Styling:**

- **Tailwind CSS:** `/websites/tailwindcss`
- **Radix UI:** TBC
- **shadcn/ui:** `/websites/ui_shadcn` (component library patterns)

**Data & Validation:**

- **Zod:** TBC
- **React Hook Form:** TBC

**Update and add to this list as you use libraries in Sunrise development.**

### Example Usage

```typescript
// When implementing better-auth patterns:
// 1. Get documentation
mcp__context7__get -
  library -
  docs({
    context7CompatibleLibraryID: '/better-auth/better-auth/1.4.7',
    topic: 'session management server components',
    mode: 'code',
  });

// 2. Use the patterns from documentation in your code
// 3. Add the library to the list above if not already present
```

**Best Practices:**

- Always use version-specific IDs when available (e.g., `/better-auth/better-auth/1.4.7` instead of `/better-auth/better-auth`)
- Use `mode: "code"` for implementation tasks
- Use `mode: "info"` for understanding architecture or concepts
- Keep the library list updated as the project grows
- Reference the list to avoid redundant library ID lookups

## Essential Commands

### Development

```bash
npm run dev              # Start development server
npm run build            # Build for production
npm run start            # Start production server
npm run lint             # Run ESLint
npm run lint:fix         # Fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check formatting
npm run type-check       # Run TypeScript compiler
npm run validate         # Run type-check + lint + format check
```

### Database (Prisma)

```bash
npm run db:migrate       # Create and apply new migration
npm run db:push          # Push schema changes without migration
npm run db:studio        # Open Prisma Studio GUI
npm run db:seed          # Run seed script
npx prisma generate      # Regenerate Prisma client after schema changes
```

### Docker

```bash
# Development environment (includes database)
docker-compose up                    # Start all services
docker-compose up --build            # Rebuild and start
docker-compose up -d                 # Start in background (detached)
docker-compose down                  # Stop all services
docker-compose down -v               # Stop and remove volumes
docker-compose logs -f web           # View app logs
docker-compose logs -f db            # View database logs
docker-compose exec web npx prisma migrate dev  # Run migrations in container
docker-compose exec web npx prisma studio       # Open Prisma Studio
docker-compose exec db psql -U postgres -d sunrise  # Access database CLI

# Production build and deployment
docker build -t sunrise:latest .     # Build production image
docker images sunrise:latest         # Check image size (should be ~150-200MB)
docker-compose -f docker-compose.prod.yml up -d --build  # Build and start production stack
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy  # Run production migrations
docker-compose -f docker-compose.prod.yml logs -f web     # View production logs
docker-compose -f docker-compose.prod.yml ps              # Check service health
docker-compose -f docker-compose.prod.yml down            # Stop production stack

# Maintenance and troubleshooting
docker system prune -f               # Clean up unused Docker resources
docker-compose restart web           # Restart app without rebuilding
curl http://localhost:3000/api/health  # Test health endpoint
```

### Testing

```bash
npm run test             # Run tests with Vitest
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
```

## Project Architecture

### Core Stack

- **Framework:** Next.js 16 with App Router
- **Language:** TypeScript (strict mode)
- **Database:** PostgreSQL 15 + Prisma ORM
- **Authentication:** better-auth
- **Styling:** Tailwind CSS + shadcn/ui components
- **Email:** Resend + React Email templates
- **Validation:** Zod schemas
- **Logging:** Structured logging with environment-aware output
- **Error Handling:** Global error handler, error boundaries, Sentry integration

### Directory Structure Philosophy

```
app/
├── (auth)/              # Route group: authentication pages (login, signup, reset)
├── (protected)/         # Route group: all protected routes
│   ├── dashboard/       # Dashboard home
│   ├── settings/        # User settings
│   └── profile/         # User profile
├── (public)/            # Route group: all public routes
│   ├── page.tsx         # Landing page
│   ├── about/           # About page
│   └── contact/         # Contact page
└── api/                 # API routes
    ├── auth/            # better-auth handlers
    ├── health/          # Health check endpoint
    └── v1/              # Versioned API endpoints

components/
├── ui/                  # shadcn/ui base components
├── forms/               # Form components with validation
├── layouts/             # Layout components
└── providers/           # React context providers

lib/
├── db/                  # Database client & utilities
├── auth/                # Authentication utilities & config
├── email/               # Email client & sending utilities
├── api/                 # API helpers & response formatters
├── security/            # CORS, rate limiting, sanitization
├── validations/         # Zod validation schemas
└── utils.ts             # General utilities

prisma/
├── schema.prisma        # Database schema (source of truth)
├── migrations/          # Database migrations (auto-generated)
└── seed.ts              # Seed data for development

emails/                  # React Email templates
types/                   # Shared TypeScript types
```

### Important Patterns

**1. Route Groups:** The `app/` directory uses route groups `(groupName)` to organize pages without affecting URLs. This allows clean separation with different layouts:

- `(auth)` - Authentication pages with minimal layout
- `(protected)` - All authenticated routes (dashboard, settings, profile, etc.)
- `(public)` - All public routes (landing, about, pricing, etc.)

**Adding new pages:**

- Same layout as existing? Add as subdirectory: `(protected)/analytics/page.tsx`
- Different layout needed? Create new route group: `(admin)/layout.tsx`

**2. API Response Format:** All API endpoints use standardized responses:

```typescript
// Success
{ success: true, data: { ... }, meta?: { ... } }

// Error
{ success: false, error: { code: "ERROR_CODE", message: "...", details?: { ... } } }
```

**3. Server Components by Default:** Use server components unless client interactivity is needed. Add `'use client'` directive sparingly.

**4. Environment Validation:** Environment variables are validated at runtime using Zod schemas in `lib/env.ts`.

**5. Type Safety:** All forms use Zod schemas with `react-hook-form` and `zodResolver`. Database types are auto-generated from Prisma schema.

## Development Guidelines

### Build Order

This project follows a phased build plan documented in `.instructions/SUNRISE-BUILD-PLAN.md`. The phases are:

1. **Phase 1:** Core Foundation (Next.js setup, database, auth, API structure, Docker)
2. **Phase 2:** Developer Experience (linting, testing, types, documentation)
3. **Phase 3:** Production Features (email, user management, security, landing page)
4. **Phase 4:** Optional Features (documented as guides, not implemented)

**When implementing features:** Reference the build plan as the source of truth. Complete features fully before moving to the next. Test each feature as you build it.

### Planning with Skills

When formulating implementation plans, always review available skills and recommend their usage for relevant parts of the plan:

| Skill                | Use For                                      |
| -------------------- | -------------------------------------------- |
| `/api-builder`       | Creating/modifying REST API endpoints        |
| `/component-builder` | Creating reusable React components           |
| `/deployment-guide`  | Deployment documentation                     |
| `/email-designer`    | Email templates with React Email             |
| `/form-builder`      | Forms with Zod + react-hook-form + shadcn/ui |
| `/page-builder`      | New pages with proper layouts/metadata       |
| `/security-hardener` | Rate limiting, CORS, CSP, sanitization       |
| `/testing`           | Unit/integration tests                       |

**Example plan for "Add user invitation management page":**

1. Design API endpoints → **use `/api-builder`**
2. Create invitation list component → **use `/component-builder`**
3. Build invite form with validation → **use `/form-builder`**
4. Create the management page → **use `/page-builder`**
5. Add comprehensive tests → **use `/testing`**

### Code Style

**TypeScript:**

- Use strict mode (already configured)
- Prefer interfaces over types for objects
- Explicit return types for exported functions
- No `any` types—use proper typing

**React:**

- Functional components only
- Server components by default
- Use `'use client'` only when needed (forms, hooks, interactivity)
- TypeScript for all component props

**File Naming:**

- Components: `PascalCase.tsx`
- Utilities: `kebab-case.ts`
- Next.js pages: `page.tsx`
- Next.js API routes: `route.ts`
- Next.js layouts: `layout.tsx`

**Component Structure:**

```typescript
// 1. Imports
import { ... } from '...'

// 2. Types/Interfaces
interface ComponentProps { ... }

// 3. Component
export function ComponentName({ prop }: ComponentProps) {
  // Hooks
  // Event handlers
  // Render
  return (...)
}
```

**API Route Structure:**

```typescript
// app/api/v1/resource/route.ts
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    // 1. Validate input (Zod schema)
    // 2. Check authentication if needed
    // 3. Business logic
    // 4. Return standardized response
    return Response.json({ success: true, data: { ... } })
  } catch (error) {
    return Response.json({
      success: false,
      error: { message: 'Error message' }
    }, { status: 500 })
  }
}
```

**Logging:**

**CRITICAL: Use the structured logger instead of `console` for all production code.**

- ✅ **Use `logger`** from `@/lib/logging` for:
  - API routes and server actions
  - Business logic and data operations
  - Error tracking and monitoring
  - User actions and important events
  - Any code that runs in production

- ⚠️ **Only use `console`** for:
  - Quick local debugging (temporary, remove before commit)
  - Build scripts and tooling (not application code)

**Why:**

- Structured logs work in production (JSON format for log aggregation)
- Environment-aware output (colored in dev, JSON in prod)
- Request tracing (automatic request ID propagation)
- PII sanitization (sensitive data scrubbed automatically)
- AI-friendly observability (machine-parseable for debugging)

**Examples:**

```typescript
import { logger } from '@/lib/logging';

// ✅ GOOD - Use structured logger
export async function GET(request: NextRequest) {
  const requestLogger = logger.withContext({ requestId: 'abc123' });
  requestLogger.info('User list requested', { limit: 10 });

  try {
    const users = await db.user.findMany();
    requestLogger.info('Users fetched', { count: users.length });
    return Response.json({ success: true, data: users });
  } catch (error) {
    requestLogger.error('Failed to fetch users', error, { endpoint: '/api/v1/users' });
    return handleAPIError(error);
  }
}

// ❌ BAD - Don't use console in production code
export async function GET(request: NextRequest) {
  console.log('Getting users...'); // No structure, no context, disappears in production
  try {
    const users = await db.user.findMany();
    console.log('Found users:', users); // May leak PII, not sanitized
    return Response.json({ success: true, data: users });
  } catch (error) {
    console.error('Error:', error); // No request context, hard to debug
    return handleAPIError(error);
  }
}
```

**Log Levels:**

- `logger.debug()` - Verbose debugging (only in development)
- `logger.info()` - Important application events (user actions, data changes)
- `logger.warn()` - Warnings (deprecated APIs, fallback paths)
- `logger.error()` - Errors requiring attention (exceptions, failures)

**Documentation:** See [`.context/errors/logging.md`](./.context/errors/logging.md) for:

- When to log and what not to log
- Request context best practices
- Performance considerations
- PII sanitization guidelines

### Git Hooks

**Pre-commit:**

- Runs `lint-staged` automatically on staged files
- Formats with Prettier
- Fixes ESLint issues
- Fast (<5 seconds for typical changes)

**Pre-push:**

- Runs TypeScript type-check
- Catches type errors before pushing
- ~10 seconds

**Bypassing Hooks (Emergency Only):**

```bash
git commit --no-verify -m "emergency fix"
git push --no-verify
```

**Why bypass?** Only for urgent production hotfixes or when hooks are genuinely blocking valid commits.

### Security Practices

- **Never commit `.env.local`** - only commit `.env.example`
- **Validate all user input** with Zod schemas
- **Use Prisma** for database queries (prevents SQL injection)
- **Hash passwords** with bcrypt (better-auth handles this)
- **Protect API routes** using better-auth session checks
- **Set security headers** in `next.config.js` and middleware
- **Rate limit** sensitive endpoints using utilities in `lib/security/rate-limit.ts`
- **Sanitize input** for XSS prevention using `lib/security/sanitize.ts`

### Common Tasks

**Adding a New Page:**

1. Determine if it's public or protected
2. Choose appropriate route group:
   - Authentication flow → `(auth)/page-name/page.tsx`
   - Protected feature → `(protected)/page-name/page.tsx`
   - Public page → `(public)/page-name/page.tsx`
   - Different layout needed → Create new group `(admin)/page-name/page.tsx`
3. Import from `@/components` and `@/lib` using path aliases
4. Add to navigation if needed

**Examples:**

- Analytics dashboard: `app/(protected)/analytics/page.tsx` (uses protected layout)
- Pricing page: `app/(public)/pricing/page.tsx` (uses public layout)
- Admin panel: `app/(admin)/layout.tsx` + `app/(admin)/users/page.tsx` (custom layout)

**Adding a New API Endpoint:**

1. Create `app/api/v1/[resource]/route.ts`
2. Implement HTTP methods (GET, POST, PUT, DELETE)
3. Create Zod validation schema in `lib/validations/`
4. Use standardized response format
5. Add tests in `tests/integration/`
6. Document in `docs/api.md`

**Adding a Database Model:**

1. Update `prisma/schema.prisma`
2. Run `npm run db:migrate` to create migration
3. Run `npx prisma generate` to update Prisma client
4. Update seed data in `prisma/seed.ts` if needed
5. Create TypeScript types if needed in `types/`

**Adding a Form:**

1. Create Zod schema in `lib/validations/`
2. Build form component in `components/forms/` using `react-hook-form`
3. Use shadcn/ui form components (`Form`, `FormField`, etc.)
4. Connect to API endpoint
5. Handle loading and error states

**Making API Calls from Frontend:**

Use the type-safe `apiClient` for all API calls from client components:

```typescript
import { apiClient, APIClientError } from '@/lib/api/client';
import type { PublicUser } from '@/types';

// GET request
const user = await apiClient.get<PublicUser>('/api/v1/users/me');

// GET with query parameters
const users = await apiClient.get<PublicUser[]>('/api/v1/users', {
  params: { page: 1, limit: 10, q: 'search' },
});

// POST request with body
const newUser = await apiClient.post<PublicUser>('/api/v1/users', {
  body: { name: 'John', email: 'john@example.com' },
});

// PATCH request
const updated = await apiClient.patch<PublicUser>('/api/v1/users/me', {
  body: { name: 'Jane' },
});

// DELETE request
await apiClient.delete('/api/v1/users/123');

// Error handling
try {
  const user = await apiClient.get<PublicUser>('/api/v1/users/me');
} catch (error) {
  if (error instanceof APIClientError) {
    console.error(error.message, error.code, error.details);

    // Handle validation errors
    if (error.code === 'VALIDATION_ERROR' && error.details) {
      // error.details contains field-specific validation errors
    }
  }
}
```

**Benefits:**

- Type safety with generics
- Automatic JSON parsing
- Consistent error handling
- Query parameter serialization
- Integration with API response types

**Adding a shadcn/ui Component:**

```bash
npx shadcn-ui@latest add [component-name]
# Example: npx shadcn-ui@latest add dialog
```

Components are installed to `components/ui/` and can be customized.

### Email System

**Quick Start:**

```typescript
import { sendEmail } from '@/lib/email/send';
import WelcomeEmail from '@/emails/welcome';

await sendEmail({
  to: 'user@example.com',
  subject: 'Welcome to Sunrise',
  react: WelcomeEmail({ userName: 'John', userEmail: 'user@example.com' }),
});
```

**User Creation Methods:**

1. **Self-Signup (Primary - User-Initiated)**:
   - User: `POST /api/auth/sign-up/email`
   - Email verification: Environment-based (dev=disabled, prod=enabled)
   - Best for: Public user registration
   - Mobile apps: Use better-auth API directly

2. **Invitation-based (Admin-Initiated - Recommended)**:
   - Admin: `POST /api/v1/users/invite`
   - User: Accept via email link (`POST /api/auth/accept-invite`)
   - Security: Token-based, user sets own password
   - Email auto-verified on acceptance
   - Best for: Team invites, admin-created accounts

**Configuration:**

```bash
# Production (required)
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com

# Development (optional, emails logged only)
# Leave blank to disable

# Email verification override (optional)
REQUIRE_EMAIL_VERIFICATION=true  # Force enable in dev
REQUIRE_EMAIL_VERIFICATION=false # Force disable in prod
```

**Email Templates:**

- `emails/welcome.tsx` - After invitation acceptance
- `emails/invitation.tsx` - User invitations from admin
- `emails/verify-email.tsx` - Self-signup verification (production)
- `emails/reset-password.tsx` - Password reset

**Preview Templates:**

```bash
npm run email:dev  # Opens preview at http://localhost:3001
```

**Testing:**

```typescript
import { mockEmailSuccess } from '@/tests/helpers/email';

beforeEach(() => {
  mockEmailSuccess(vi.mocked(sendEmail), 'email-id');
});
```

**Documentation:**

- System overview: `.context/email/overview.md`
- User creation patterns: `.context/auth/user-creation.md`
- Mobile integration: `.context/api/mobile-integration.md`

## Docker Configuration

**Production Build:** The project uses multi-stage Docker builds with Next.js standalone output for minimal image size.

**Key Configuration:**

- `next.config.js` has `output: 'standalone'` enabled
- Production Dockerfile creates ~100MB images
- Non-root user (`nextjs:nodejs`) for security
- Health check endpoint at `/api/health`

**Environment in Docker:**

- Set environment variables in `docker-compose.yml` or pass with `-e` flag
- Database service name is `db` (not `localhost`) in Docker Compose
- Use `DATABASE_URL=postgresql://user:password@db:5432/dbname` format

## Environment Variables

Required variables are documented in `.env.example`. Key variables:

```bash
DATABASE_URL="postgresql://..."         # PostgreSQL connection string
BETTER_AUTH_URL="http://localhost:3000" # App URL (change for production)
BETTER_AUTH_SECRET="..."                # Generate with: openssl rand -base64 32
GOOGLE_CLIENT_ID="..."                  # For Google OAuth (optional)
GOOGLE_CLIENT_SECRET="..."              # For Google OAuth (optional)
RESEND_API_KEY="..."                    # For email sending
EMAIL_FROM="noreply@yourdomain.com"     # From address for emails
NODE_ENV="development"                  # or "production"
```

**After adding/changing environment variables:**

1. Update `.env.example`
2. Update `.instructions/SUNRISE-BUILD-PLAN.md` if it's a new variable
3. Rebuild if variable starts with `NEXT_PUBLIC_` (embedded at build time)
4. Validate in `lib/env.ts` using Zod

## Documentation

### Core Documentation Files

- `.instructions/SUNRISE-BUILD-PLAN.md` - Complete build plan (SOURCE OF TRUTH)
- `.instructions/CLAUDE-CODE-GUIDE.md` - How to use the build plan effectively
- `.instructions/BUILD-PROGRESS-TRACKER.md` - Checklist of features
- `.instructions/DEPLOYMENT.md` - Comprehensive deployment guide for all platforms
- `.instructions/DEPLOYMENT-QUICKSTART.md` - Quick deployment reference

### When to Reference Documentation

- **Before starting any feature:** Read the relevant section in `SUNRISE-BUILD-PLAN.md`
- **When making architectural decisions:** Consult the build plan's implementation guidelines
- **When deploying:** Use `DEPLOYMENT.md` for platform-specific instructions
- **When unsure about project structure:** Reference this file and the build plan

## Key Principles

1. **API-First Architecture:** Every capability in the UI must be accessible via API. This ensures maximum interoperability with AI agents, external systems, and future integrations. When building features, implement the API endpoint first, then the UI layer.

2. **Build Iteratively:** Complete one feature fully before moving to the next. Don't skip ahead.

3. **Test as You Go:** Test each feature locally before proceeding. Don't commit untested code.

4. **Document While Building:** Update documentation alongside code changes, not after.

5. **Follow the Build Order:** The phases in `SUNRISE-BUILD-PLAN.md` have dependencies. Follow the order.

6. **Keep It Simple:** Avoid over-engineering. Don't add features, refactoring, or "improvements" beyond what's requested. Simple code is maintainable code.

7. **Type Everything:** No `any` types. Use TypeScript strictly.

8. **Validate Everything:** All user input must go through Zod schemas.

9. **Reference the Plan:** When in doubt, consult `SUNRISE-BUILD-PLAN.md`. It's the source of truth.

## Troubleshooting

**Database connection fails:**

- Check `DATABASE_URL` format in `.env.local`
- Ensure PostgreSQL is running
- In Docker: use service name `db`, not `localhost`

**Build fails:**

- Run `npm run type-check` to find TypeScript errors
- Check that all environment variables are set
- Verify Prisma schema is valid: `npx prisma validate`
- Regenerate Prisma client: `npx prisma generate`

**Authentication not working:**

- Verify `BETTER_AUTH_SECRET` is set and valid
- Check `BETTER_AUTH_URL` matches your app URL
- Ensure database is connected and migrations are applied
- Check browser console for session errors

**Docker build fails:**

- Ensure `output: 'standalone'` is in `next.config.js`
- Check Docker has enough memory (4GB+ recommended)
- Verify `.dockerignore` includes `node_modules` and `.next`

**NPM peer dependency warnings:**

- **Known Issue**: better-auth@1.4.7 expects @prisma/client@^5.22.0, but we use Prisma 7.1.0
- **Status**: Works correctly in practice; better-auth is compatible with Prisma 7
- **Solution**: `.npmrc` is configured with `legacy-peer-deps=true` to handle this
- **No Action Required**: This is expected and documented
- **Future**: Will be resolved when better-auth officially supports Prisma 7

## Getting Help

1. Check this `CLAUDE.md` file for quick reference
2. Review **`.context/substrate.md`** for comprehensive domain-specific documentation
3. For specific domains, see `.context/[domain]/` (architecture, auth, api, database, guidelines)
4. Review `.instructions/SUNRISE-BUILD-PLAN.md` for implementation details
5. Check `.instructions/CLAUDE-CODE-GUIDE.md` for development approach
6. Review Next.js 14 App Router documentation
7. Check shadcn/ui documentation for component usage
8. Review Prisma documentation for database operations

- Remember to use Tailwind v4, which is quite different from v3. Check the Tailwind v4 documentation on context7 when working with styling
