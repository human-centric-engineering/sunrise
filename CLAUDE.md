# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Project Overview

**Sunrise** is a production-ready Next.js 16 starter template with App Router, PostgreSQL/Prisma, better-auth, and Docker deployment. Optimized for AI-assisted development.

**Stack versions (breaking changes from prior versions — use MCP/Context7 for current docs):**

- **Next.js 16** — not 14/15 (new APIs, Cache Components)
- **React 19** — not 18 (new hooks, Server Components patterns)
- **Prisma 7** — not 5/6 (new client API)
- **Tailwind 4** — not 3 (completely different config, new syntax)

## Critical Rules

**These override defaults. Follow exactly.**

### Type Safety

- **Never use `as` on external data** (API responses, user input, env vars) — validate with Zod first
- **No `any` types** — use proper typing or `unknown` with type guards
- **Validate at boundaries** — all user input through Zod schemas

### Code Quality

- **Use `logger` not `console`** — structured logging from `@/lib/logging` for all production code
- **Search before creating** — check `lib/` for existing utilities before writing new ones
- **Keep it simple** — no features, refactoring, or "improvements" beyond what's requested

### Security

- **Rate limit all mutating endpoints** — use limiters from `lib/security/rate-limit.ts`
- **Use auth guards** — `withAuth()`, `withAdminAuth()` from `lib/auth/guards.ts`
- **Run `/security-review`** before merging feature branches

### Architecture

- **API-first** — implement API endpoints before UI; every capability must be API-accessible
- **Server components by default** — add `'use client'` only when needed

## MCP Integration

### Next.js DevTools (Required)

**Always call `mcp__next-devtools__init` first** — do this without asking when starting work.

Use for: diagnostics, route inspection, runtime errors, browser automation, Next.js docs.

### Context7 (Library Docs)

Use for external library docs: `resolve-library-id` → `query-docs`. Essential for current Next.js/Prisma/Tailwind patterns.

## Essential Commands

```bash
# Development
npm run dev                    # Start dev server
npm run validate               # Type-check + lint + format

# Database
npm run db:migrate             # Create and apply migration
npm run db:studio              # Open Prisma Studio

# Testing
npm run test                   # Run tests
npm run test:watch             # Watch mode

# Docker
docker-compose up              # Start dev environment
docker-compose down            # Stop services
```

Full command reference: `.context/commands.md`

## Project-Specific Patterns

### Route Groups

```
app/
├── (auth)/        # Auth pages (login, signup) — minimal layout
├── (protected)/   # Authenticated routes — requires session
├── (public)/      # Public routes — marketing, landing
├── admin/         # Admin dashboard — creates /admin/* URLs (not a route group)
└── api/v1/        # Versioned API endpoints
```

**Route groups** `(name)` organize code without affecting URLs. **Regular folders** like `admin/` create URL segments.

**Adding pages:** Same layout → add to existing group. Different layout → create new group or folder.

### Imports

Always use the `@/` path alias — never relative paths:

```typescript
import { logger } from '@/lib/logging'; // ✅
import { Button } from '@/components/ui/button';
import { logger } from '../../lib/logging'; // ❌
```

### API Response Format

```typescript
// Success
{ success: true, data: { ... }, meta?: { ... } }

// Error
{ success: false, error: { code: "ERROR_CODE", message: "...", details?: { ... } } }
```

### Key Utilities

| Need          | Utility                                | Location                     |
| ------------- | -------------------------------------- | ---------------------------- |
| API responses | `successResponse()`, `errorResponse()` | `lib/api/responses.ts`       |
| Auth guards   | `withAuth()`, `withAdminAuth()`        | `lib/auth/guards.ts`         |
| Rate limiting | `authLimiter`, `apiLimiter`, etc.      | `lib/security/rate-limit.ts` |
| Client IP     | `getClientIP()`                        | `lib/security/ip.ts`         |
| Sanitization  | `escapeHtml()`, `sanitizeUrl()`        | `lib/security/sanitize.ts`   |
| Server fetch  | `serverFetch()`                        | `lib/api/server-fetch.ts`    |
| Logging       | `logger.info()`, `logger.error()`      | `lib/logging/index.ts`       |

## Skills

Use these for implementation tasks:

| Skill                | Use For                          |
| -------------------- | -------------------------------- |
| `/api-builder`       | REST API endpoints               |
| `/form-builder`      | Forms with Zod + react-hook-form |
| `/component-builder` | Reusable React components        |
| `/page-builder`      | New pages with layouts/metadata  |
| `/testing`           | Unit and integration tests       |
| `/security-hardener` | Rate limiting, CORS, CSP         |
| `/email-designer`    | React Email templates            |
| `/docs-writer`       | Create/update .context/ docs     |
| `/docs-audit`        | Check documentation accuracy     |

## Test Engineering

Use the **test-engineer agent** for comprehensive test coverage. Defined in `.claude/agents/test-engineer.md`.

### When to Use

**Proactively launch after:**

- Implementing a new feature, API endpoint, or component
- Refactoring code (ensure behavior preserved)
- Fixing bugs (prevent regression)

**On request:**

- "Add tests for X"
- "Review test coverage"
- "Set up testing framework"

### How to Use

Launch via Task tool as a **foreground subagent** (never background):

```
Task tool with subagent_type: "test-engineer"
prompt: "Write tests for [specific code]. Cover happy path, validation errors, and edge cases."
```

**Critical constraint:** Never use `run_in_background: true` — test engineers need Write/Edit access.

### Agent vs Skill

| Use                     | When                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| **test-engineer agent** | Writing new tests, comprehensive coverage, multi-file test suites |
| **`/testing` skill**    | Quick test patterns reference, single test file guidance          |

The agent reads `.context/testing/` automatically and validates tests pass lint and type-check before completing.

## Documentation

**Entry point:** `.context/substrate.md` — full navigation and AI usage patterns

| Domain         | Path                     | Key Content                     |
| -------------- | ------------------------ | ------------------------------- |
| Architecture   | `.context/architecture/` | System design, deployment       |
| Authentication | `.context/auth/`         | better-auth, sessions, guards   |
| API            | `.context/api/`          | Endpoints, responses, client    |
| Database       | `.context/database/`     | Prisma schema, migrations       |
| Security       | `.context/security/`     | Rate limiting, headers, CORS    |
| Logging        | `.context/logging/`      | Structured logging, request ctx |
| Testing        | `.context/testing/`      | Patterns, mocking, async        |
| Email          | `.context/email/`        | Templates, sending              |
| Workflow       | `.context/workflow.md`   | Git, commits, PR process        |

## Troubleshooting

**Database connection fails:**

- Check `DATABASE_URL` in `.env.local`
- In Docker: use `db` not `localhost`

**Build fails:**

- Run `npm run type-check` for errors
- Run `npx prisma generate` after schema changes

**Auth not working:**

- Verify `BETTER_AUTH_SECRET` is set
- Check `BETTER_AUTH_URL` matches app URL

**Peer dependency warnings (better-auth/Prisma):**

- Expected — `.npmrc` has `legacy-peer-deps=true`
- No action required
