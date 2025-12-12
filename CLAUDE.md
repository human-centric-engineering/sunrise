# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Sunrise** is a production-ready Next.js 14+ starter template designed for rapid application development. It's optimized for AI-assisted development while maintaining best practices.

**Architecture:** Single monolith Next.js application with App Router, API routes, PostgreSQL database, and Docker-first deployment.

## Context Substrate Documentation

For comprehensive, domain-specific documentation, see the **`.context/` substrate**:

- **[`.context/substrate.md`](./.context/substrate.md)** - Entry point with navigation and AI usage patterns
- **[Architecture](./.context/architecture/overview.md)** - System design, component boundaries, deployment architecture
- **[Authentication](./.context/auth/overview.md)** - NextAuth.js v5 flows, session management, security model
- **[API](./.context/api/endpoints.md)** - REST endpoints, headers, CORS, client examples
- **[Database](./.context/database/schema.md)** - Prisma schema design, models, migrations, ERD diagrams
- **[Guidelines](./.context/guidelines.md)** - Development workflow, testing, deployment procedures

**When to Use**:
- **Deep Implementation Details**: For detailed patterns, use `.context/[domain]/`
- **Quick Reference**: For commands and common tasks, use this `CLAUDE.md`
- **AI Context Loading**: Load specific domains for targeted context (e.g., `.context/auth/` for auth features)

The substrate provides production-ready implementation patterns, decision rationale, security considerations, and performance guidelines for each domain.

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
docker-compose down                  # Stop all services
docker-compose logs -f web           # View app logs

# Production build
docker build -t sunrise .            # Build production image
docker-compose -f docker-compose.prod.yml up -d   # Run production stack
```

### Testing
```bash
npm run test             # Run tests with Vitest
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
```

## Project Architecture

### Core Stack
- **Framework:** Next.js 14+ with App Router
- **Language:** TypeScript (strict mode)
- **Database:** PostgreSQL 15 + Prisma ORM
- **Authentication:** NextAuth.js v5
- **Styling:** Tailwind CSS + shadcn/ui components
- **Email:** Resend + React Email templates
- **Validation:** Zod schemas

### Directory Structure Philosophy

```
app/
├── (auth)/              # Route group: authentication pages (login, signup, reset)
├── (dashboard)/         # Route group: protected user dashboard area
├── (marketing)/         # Route group: public marketing pages (landing, about)
└── api/                 # API routes
    ├── auth/            # NextAuth.js handlers
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

**1. Route Groups:** The `app/` directory uses route groups `(groupName)` to organize pages without affecting URLs. This allows clean separation of authenticated vs public pages with different layouts.

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

### Security Practices

- **Never commit `.env.local`** - only commit `.env.example`
- **Validate all user input** with Zod schemas
- **Use Prisma** for database queries (prevents SQL injection)
- **Hash passwords** with bcrypt (utilities in `lib/auth/passwords.ts`)
- **Protect API routes** using NextAuth session checks
- **Set security headers** in `next.config.js` and middleware
- **Rate limit** sensitive endpoints using utilities in `lib/security/rate-limit.ts`
- **Sanitize input** for XSS prevention using `lib/security/sanitize.ts`

### Common Tasks

**Adding a New Page:**
1. Create `app/(group)/page-name/page.tsx`
2. Use appropriate route group: `(auth)`, `(dashboard)`, or `(marketing)`
3. Import from `@/components` and `@/lib` using path aliases
4. Add to navigation if needed

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

**Adding a shadcn/ui Component:**
```bash
npx shadcn-ui@latest add [component-name]
# Example: npx shadcn-ui@latest add dialog
```
Components are installed to `components/ui/` and can be customized.

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
DATABASE_URL="postgresql://..."       # PostgreSQL connection string
NEXTAUTH_URL="http://localhost:3000"  # App URL (change for production)
NEXTAUTH_SECRET="..."                 # Generate with: openssl rand -base64 32
GOOGLE_CLIENT_ID="..."                # For Google OAuth (optional)
GOOGLE_CLIENT_SECRET="..."            # For Google OAuth (optional)
RESEND_API_KEY="..."                  # For email sending
EMAIL_FROM="noreply@yourdomain.com"   # From address for emails
NODE_ENV="development"                # or "production"
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

1. **Build Iteratively:** Complete one feature fully before moving to the next. Don't skip ahead.

2. **Test as You Go:** Test each feature locally before proceeding. Don't commit untested code.

3. **Document While Building:** Update documentation alongside code changes, not after.

4. **Follow the Build Order:** The phases in `SUNRISE-BUILD-PLAN.md` have dependencies. Follow the order.

5. **Keep It Simple:** Avoid over-engineering. Don't add features, refactoring, or "improvements" beyond what's requested. Simple code is maintainable code.

6. **Type Everything:** No `any` types. Use TypeScript strictly.

7. **Validate Everything:** All user input must go through Zod schemas.

8. **Reference the Plan:** When in doubt, consult `SUNRISE-BUILD-PLAN.md`. It's the source of truth.

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
- Verify `NEXTAUTH_SECRET` is set and valid
- Check `NEXTAUTH_URL` matches your app URL
- Ensure database is connected and migrations are applied
- Check browser console for session errors

**Docker build fails:**
- Ensure `output: 'standalone'` is in `next.config.js`
- Check Docker has enough memory (4GB+ recommended)
- Verify `.dockerignore` includes `node_modules` and `.next`

## Getting Help

1. Check this `CLAUDE.md` file for quick reference
2. Review **`.context/substrate.md`** for comprehensive domain-specific documentation
3. For specific domains, see `.context/[domain]/` (architecture, auth, api, database, guidelines)
4. Review `.instructions/SUNRISE-BUILD-PLAN.md` for implementation details
5. Check `.instructions/CLAUDE-CODE-GUIDE.md` for development approach
6. Review Next.js 14 App Router documentation
7. Check shadcn/ui documentation for component usage
8. Review Prisma documentation for database operations
