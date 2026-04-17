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
- **No N+1 client-side fetches** — list/table pages get all data from a single enriched list endpoint; never fire per-row API calls in `useEffect`
- **Contextual help on form fields** — every non-trivial form field gets a `<FieldHelp>` ⓘ popover; see `.context/ui/contextual-help.md`

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
npm run db:migrate:dev         # Create and apply migration (dev only)
npm run db:migrate:deploy      # Apply pending migrations (prod / CI)
npm run db:migrate:status      # Show migration status
npm run db:seed                # Apply new/changed seed units
npm run db:reset               # Drop, re-migrate, re-seed from scratch
npm run db:studio              # Open Prisma Studio

# Testing
npm run test                   # Run tests
npm run test:watch             # Watch mode
npm run smoke:chat             # Smoke: streaming chat handler vs real dev DB

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

| Need          | Utility                                | Location                         |
| ------------- | -------------------------------------- | -------------------------------- |
| API responses | `successResponse()`, `errorResponse()` | `lib/api/responses.ts`           |
| Auth guards   | `withAuth()`, `withAdminAuth()`        | `lib/auth/guards.ts`             |
| Rate limiting | `authLimiter`, `apiLimiter`, etc.      | `lib/security/rate-limit.ts`     |
| Client IP     | `getClientIP()`                        | `lib/security/ip.ts`             |
| Sanitization  | `escapeHtml()`, `sanitizeUrl()`        | `lib/security/sanitize.ts`       |
| Server fetch  | `serverFetch()`                        | `lib/api/server-fetch.ts`        |
| Logging       | `logger.info()`, `logger.error()`      | `lib/logging/index.ts`           |
| Local storage | `useLocalStorage()`                    | `lib/hooks/use-local-storage.ts` |
| Wizard state  | `useWizard()`                          | `lib/hooks/use-wizard.ts`        |

## Skills

Use these for implementation tasks:

| Skill                | Use For                                             |
| -------------------- | --------------------------------------------------- |
| `/api-builder`       | REST API endpoints                                  |
| `/form-builder`      | Forms with Zod + react-hook-form                    |
| `/component-builder` | Reusable React components                           |
| `/page-builder`      | New pages with layouts/metadata                     |
| `/testing`           | Quick test patterns reference                       |
| `/test-plan`         | Analyze code and produce a test plan                |
| `/test-write`        | Execute test plan with test-engineer agents         |
| `/test-review`       | Audit test quality                                  |
| `/test-coverage`     | Find coverage gaps and untested files               |
| `/security-hardener` | Rate limiting, CORS, CSP                            |
| `/email-designer`    | React Email templates                               |
| `/docs-writer`       | Create/update .context/ docs                        |
| `/docs-audit`        | Check documentation accuracy                        |
| `/agent-architect`   | Agentic design patterns, orchestration architecture |

## Test Engineering

Testing has a dedicated command workflow. Use these commands instead of manually crafting prompts.

### Testing Commands

| Command          | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `/test-plan`     | Analyze code and produce a phased, prioritized test plan |
| `/test-write`    | Execute a plan by spawning test-engineer subagents       |
| `/test-review`   | Audit test quality (weak assertions, missing edge cases) |
| `/test-coverage` | Find coverage gaps and untested files                    |

### Common Flows

**Add tests for branch changes** (most common):

```
/test-plan              → produces phased plan from branch diff
/test-write plan        → executes Sprint 1
/test-review            → audits quality
/test-plan review       → plans fixes from review findings
/test-write plan        → executes fixes
/test-coverage branch   → verifies coverage meets thresholds
```

**Improve tests in a folder**:

```
/test-review lib/auth       → finds quality issues
/test-plan review lib/auth  → plans fixes
/test-write plan            → executes
```

**Fill repo-wide coverage gaps**:

```
/test-coverage              → finds all gaps
/test-plan coverage         → produces multi-sprint plan
/test-write plan            → executes sprint by sprint
```

**Quick test for 1-2 files** (skips planning):

```
/test-write lib/auth/guards.ts    → inline plan + execute
```

### How It Works

Commands chain via structured output: `/test-coverage` and `/test-review` produce findings that `/test-plan` consumes to build sprint-based execution plans. `/test-write` executes plans by spawning **test-engineer** subagents (defined in `.claude/agents/test-engineer.md`).

All commands default to branch diff mode but accept file/folder paths. The test-engineer agent reads `.context/testing/` for patterns and validates tests pass lint and type-check before completing.

### Agent vs Skill vs Commands

| Use                     | When                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| **`/test-*` commands**  | Standard workflow — planning, writing, reviewing, coverage analysis |
| **test-engineer agent** | Spawned automatically by `/test-write` — don't invoke directly      |
| **`/testing` skill**    | Quick patterns reference, single test file guidance                 |

## Documentation

**Entry point:** `.context/substrate.md` — full navigation and AI usage patterns

| Domain                  | Path                                                 | Key Content                                         |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Architecture            | `.context/architecture/`                             | System design, deployment                           |
| Authentication          | `.context/auth/`                                     | better-auth, sessions, guards                       |
| API                     | `.context/api/`                                      | Endpoints, responses, client                        |
| Database                | `.context/database/`                                 | Prisma schema, migrations, seeding                  |
| Security                | `.context/security/`                                 | Rate limiting, headers, CORS                        |
| Logging                 | `.context/logging/`                                  | Structured logging, request ctx                     |
| Testing                 | `.context/testing/`                                  | Patterns, mocking, async                            |
| Email                   | `.context/email/`                                    | Templates, sending                                  |
| Workflow                | `.context/workflow.md`                               | Git, commits, PR process                            |
| AI Orchestration        | `.claude/docs/agent-orchestration.md`                | Agent system design, patterns                       |
| Orchestration Overview  | `.context/admin/orchestration.md`                    | Architecture, quick start, key concepts, config     |
| Solution Builder        | `.context/admin/orchestration-solution-builder.md`   | Problem-to-solution guide, 5 worked examples        |
| Capabilities Guide      | `.context/admin/orchestration-capabilities-guide.md` | How to create capabilities, BaseCapability ref      |
| Workflows Guide         | `.context/admin/orchestration-workflows-guide.md`    | Step types, error strategies, templates, extending  |
| LLM Providers           | `.context/orchestration/llm-providers.md`            | Provider abstraction, cost tracking                 |
| Capabilities            | `.context/orchestration/capabilities.md`             | Tool dispatcher, built-ins, rate limits             |
| Streaming Chat          | `.context/orchestration/chat.md`                     | Chat handler, tool loop, context builder            |
| Knowledge Base          | `.context/orchestration/knowledge.md`                | Document ingestion, chunking, vector search         |
| Workflows               | `.context/orchestration/workflows.md`                | DAG validator, step types, error codes              |
| Orchestration Engine    | `.context/orchestration/engine.md`                   | Runtime executor, registry, events, strategies      |
| Resilience & Errors     | `.context/orchestration/resilience.md`               | Circuit breaker, fallback, budget UX, input guard   |
| Orchestration Admin API | `.context/orchestration/admin-api.md`                | Agents, capabilities, chat, knowledge, executions   |
| Orchestration Endpoints | `.context/api/orchestration-endpoints.md`            | Consumer HTTP reference for all 41 routes           |
| SSE Bridge              | `.context/api/sse.md`                                | `sseResponse` helper, framing, sanitization         |
| Orchestration Dashboard | `.context/admin/orchestration-dashboard.md`          | Admin landing page, data sources, layout            |
| Agents List / Pages     | `.context/admin/orchestration-agents.md`             | List, create, edit shells; table, bulk export       |
| Agent Form              | `.context/admin/agent-form.md`                       | 5-tab create/edit form, FieldHelp reference         |
| Capabilities List       | `.context/admin/orchestration-capabilities.md`       | Table, category filter, agents-using count          |
| Capability Form         | `.context/admin/capability-form.md`                  | 4 tabs, visual builder ↔ JSON editor, safety        |
| Providers List          | `.context/admin/orchestration-providers.md`          | Card grid, status dots, env-var-only security       |
| Provider Form           | `.context/admin/provider-form.md`                    | 4-flavor selector, reverse-mapping on edit          |
| Costs & Budget          | `.context/admin/orchestration-costs.md`              | Summary, trend, savings, settings singleton         |
| Workflow Builder        | `.context/admin/workflow-builder.md`                 | React Flow canvas, palette, step registry           |
| Learning UI             | `.context/admin/orchestration-learn.md`              | Pattern explorer, advisor chatbot, quiz, tabbed hub |
| Knowledge Base UI       | `.context/admin/orchestration-knowledge-ui.md`       | Document management, upload, search test            |
| Chat Interface          | `.context/admin/orchestration-chat-interface.md`     | Reusable SSE chat component, embedded mode          |
| Evaluations UI          | `.context/admin/orchestration-evaluations.md`        | Evaluation runner, annotations, completion flow     |
| Observability Dashboard | `.context/admin/orchestration-observability.md`      | Dashboard metrics, trace viewers, logging audit     |
| Setup Wizard            | `.context/admin/setup-wizard.md`                     | 5-step guided setup flow, resume behavior           |
| Contextual Help         | `.context/ui/contextual-help.md`                     | `<FieldHelp>` directive for form fields             |
| UI Hooks                | `.context/ui/hooks.md`                               | `useLocalStorage`, `useWizard`                      |

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
