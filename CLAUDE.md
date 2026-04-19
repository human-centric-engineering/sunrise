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
| ETag / 304    | `computeETag()`, `checkConditional()`  | `lib/api/etag.ts`                |

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
| `/test-review`       | Confidence-scored test quality report (≥80 filter)  |
| `/test-fix`          | Apply findings from a `/test-review` report         |
| `/test-coverage`     | Find coverage gaps and untested files               |
| `/test-triage`       | Ledger-driven triage for codebase-wide remediation  |
| `/security-hardener` | Rate limiting, CORS, CSP                            |
| `/email-designer`    | React Email templates                               |
| `/docs-writer`       | Create/update .context/ docs                        |
| `/docs-audit`        | Check documentation accuracy                        |
| `/agent-architect`   | Agentic design patterns, orchestration architecture |

## Test Engineering

Testing has a dedicated command workflow. The commands break down into three jobs — pick the one that matches the situation, don't loop them together reflexively.

### Three Jobs

| Job         | When                                         | Commands                                                                                     |
| ----------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Floor**   | Ongoing — raise quality on legacy test files | `/test-triage scan` → `worklist` → `rescan` · optionally `/test-fix from-rescan`             |
| **Ceiling** | One-shot — build out a critical module       | `/test-coverage` → `/test-plan coverage` → `/test-write plan` → `/test-review` → `/test-fix` |
| **Gate**    | Every PR — catch regressions before merge    | `/test-review` (branch diff) or `/test-review pr [number]` (PR comment)                      |

### Testing Commands

| Command          | Purpose                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/test-plan`     | Analyze code and produce a phased, prioritized test plan                                                                               |
| `/test-write`    | Execute a plan by spawning test-engineer subagents                                                                                     |
| `/test-review`   | Confidence-scored quality report (filter ≥80). Writes `.reviews/tests-{slug}.md`. `pr` mode posts a GitHub PR comment.                 |
| `/test-fix`      | Apply findings from a `.reviews/tests-{slug}.md` report (`--all` or `--findings=N,N,N`). Second mode: `from-rescan <file>` for ledger. |
| `/test-coverage` | Find coverage gaps and untested files                                                                                                  |
| `/test-triage`   | Grade test files (Clean/Minor/Bad/Rotten) for codebase remediation                                                                     |

### Common Flows

**PR gate** (most common — every branch before merge):

```
/test-review pr            → review + post PR comment (silent if no findings ≥80)
/test-fix --all            → applies every finding ≥80 from the latest report
# OR: /test-fix --findings=1,3,5   → pick specific findings
# OR: /test-review                 → local-only branch diff → .reviews/tests-branch-{name}.md
```

`/test-review` is diagnostic, not a gate — it produces a confidence-scored report; the human (or PR reviewer) judges what to action. `/test-fix` does not re-audit after applying.

**Ceiling pass** (one-shot on a critical module):

```
/test-coverage lib/auth        → finds coverage gaps
/test-plan coverage lib/auth   → produces phased plan
/test-write plan               → executes (spawns test-engineer agents)
/test-review lib/auth          → audits quality
/test-fix --all                → applies findings
```

**Add tests for branch changes** (no existing tests yet):

```
/test-plan           → produces phased plan from branch diff
/test-write plan     → executes Sprint 1
/test-review         → audits what was written (writes .reviews/tests-branch-{name}.md)
/test-fix --all      → fixes findings
```

The chain stops at `/test-fix`. Re-run `/test-review` only if the source changed after fixes, or on the next PR — do not loop reflexively.

**Codebase-wide test remediation (Floor)** — legacy green-bar cleanup:

```
/test-triage scan <folder>       → grade files, write to ledger
/test-triage worklist            → see prioritised queue (Rotten first)
/test-triage fix <file>          → print both fix paths (A: rescan-driven fast path · B: full review)
/test-fix from-rescan <file>     → path A: apply ledger NOTES directly (Minor/Bad with specific findings)
/test-review <file> → /test-fix  → path B: full audit then apply (Rotten, or vague findings)
/test-triage rescan <file>       → re-grade after fix, update ledger
```

Use `/test-triage` for quality remediation across 360+ files — it grades cheaply via regex + narrow Sonnet pass and tracks progress across sessions. Use `/test-review` for branch-scoped audit (1–20 file pairs).

**Quick test for 1-2 files** (skips planning):

```
/test-write lib/auth/guards.ts    → inline plan + execute
```

### How It Works

`/test-review` writes a **confidence-scored report** to `.reviews/tests-{slug}.md`: 5 parallel Sonnet agents (assertion quality, coverage, mock realism, brittleness, alignment) score findings 0–100, and the report shows findings ≥80. There is no auto-loop — the user (or PR reviewer) reads the report and picks what to action. `/test-fix` consumes a report by slug or by most-recent mtime.

`/test-coverage` and `/test-plan` chain via structured output: `/test-plan` consumes coverage findings to build sprint-based plans; `/test-write` executes plans by spawning **test-engineer** subagents (defined in `.claude/agents/test-engineer.md`).

All commands default to branch diff mode but accept file/folder paths. The test-engineer agent reads `.context/testing/` for patterns and validates tests pass lint and type-check before completing.

### Agent vs Skill vs Commands

| Use                     | When                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| **`/test-*` commands**  | Standard workflow — planning, writing, reviewing, coverage analysis |
| **test-engineer agent** | Spawned automatically by `/test-write` — don't invoke directly      |
| **`/testing` skill**    | Quick patterns reference, single test file guidance                 |

## Documentation

**Entry point:** `.context/substrate.md` — full navigation and AI usage patterns

| Domain                  | Path                                                 | Key Content                                              |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Architecture            | `.context/architecture/`                             | System design, deployment                                |
| Authentication          | `.context/auth/`                                     | better-auth, sessions, guards                            |
| API                     | `.context/api/`                                      | Endpoints, responses, client                             |
| Database                | `.context/database/`                                 | Prisma schema, migrations, seeding                       |
| Security                | `.context/security/`                                 | Rate limiting, headers, CORS                             |
| Logging                 | `.context/logging/`                                  | Structured logging, request ctx                          |
| Testing                 | `.context/testing/`                                  | Patterns, mocking, async                                 |
| Email                   | `.context/email/`                                    | Templates, sending                                       |
| Workflow                | `.context/workflow.md`                               | Git, commits, PR process                                 |
| AI Orchestration        | `.claude/docs/agent-orchestration.md`                | Agent system design, patterns                            |
| Orchestration Overview  | `.context/admin/orchestration.md`                    | Architecture, quick start, key concepts, config          |
| Solution Builder        | `.context/admin/orchestration-solution-builder.md`   | Problem-to-solution guide, 5 worked examples             |
| Capabilities Guide      | `.context/admin/orchestration-capabilities-guide.md` | How to create capabilities, BaseCapability ref           |
| Workflows Guide         | `.context/admin/orchestration-workflows-guide.md`    | Step types, error strategies, templates, extending       |
| LLM Providers           | `.context/orchestration/llm-providers.md`            | Provider abstraction, cost tracking                      |
| Capabilities            | `.context/orchestration/capabilities.md`             | Tool dispatcher, built-ins, rate limits                  |
| Streaming Chat          | `.context/orchestration/chat.md`                     | Chat handler, tool loop, context builder                 |
| Knowledge Base          | `.context/orchestration/knowledge.md`                | Document ingestion, chunking, vector search              |
| Workflows               | `.context/orchestration/workflows.md`                | DAG validator, step types, error codes                   |
| Orchestration Engine    | `.context/orchestration/engine.md`                   | Runtime executor, registry, events, strategies           |
| External Calls          | `.context/orchestration/external-calls.md`           | HTTP executor, outbound rate limits, auth, response caps |
| Resilience & Errors     | `.context/orchestration/resilience.md`               | Circuit breaker, fallback, budget UX, input guard        |
| Output Guard            | `.context/orchestration/output-guard.md`             | Topic boundaries, PII detection, brand voice             |
| Agent Visibility        | `.context/orchestration/agent-visibility.md`         | Visibility modes, invite tokens, access control          |
| API Keys                | `.context/orchestration/api-keys.md`                 | Self-service API keys, scopes, key resolution            |
| MCP Server              | `.context/orchestration/mcp.md`                      | MCP protocol, tools, resources, keys, audit              |
| Orchestration Admin API | `.context/orchestration/admin-api.md`                | Agents, capabilities, chat, knowledge, executions        |
| Orchestration Endpoints | `.context/api/orchestration-endpoints.md`            | Admin HTTP reference for all 65 routes                   |
| Consumer Chat API       | `.context/api/consumer-chat.md`                      | End-user chat endpoints, agent visibility, rate limits   |
| Document Ingestion      | `.context/orchestration/document-ingestion.md`       | Multi-format parsing, PDF preview flow, parser arch      |
| Scheduling & Webhooks   | `.context/orchestration/scheduling.md`               | Cron schedules, webhook triggers, scheduler tick         |
| Client Analytics        | `.context/orchestration/analytics.md`                | Popular topics, unanswered questions, engagement, gaps   |
| SSE Bridge              | `.context/api/sse.md`                                | `sseResponse` helper, framing, sanitization              |
| Orchestration Dashboard | `.context/admin/orchestration-dashboard.md`          | Admin landing page, data sources, layout                 |
| Agents List / Pages     | `.context/admin/orchestration-agents.md`             | List, create, edit shells; table, bulk export            |
| Agent Form              | `.context/admin/agent-form.md`                       | 5-tab create/edit form, FieldHelp reference              |
| Capabilities List       | `.context/admin/orchestration-capabilities.md`       | Table, category filter, agents-using count               |
| Capability Form         | `.context/admin/capability-form.md`                  | 4 tabs, visual builder ↔ JSON editor, safety             |
| Providers List          | `.context/admin/orchestration-providers.md`          | Card grid, status dots, env-var-only security            |
| Provider Form           | `.context/admin/provider-form.md`                    | 4-flavor selector, reverse-mapping on edit               |
| Costs & Budget          | `.context/admin/orchestration-costs.md`              | Summary, trend, savings, settings singleton              |
| Workflow Builder        | `.context/admin/workflow-builder.md`                 | React Flow canvas, palette, step registry                |
| Learning UI             | `.context/admin/orchestration-learn.md`              | Pattern explorer, advisor chatbot, quiz, tabbed hub      |
| Knowledge Base UI       | `.context/admin/orchestration-knowledge-ui.md`       | Document management, upload, search test                 |
| Chat Interface          | `.context/admin/orchestration-chat-interface.md`     | Reusable SSE chat component, embedded mode               |
| Evaluations UI          | `.context/admin/orchestration-evaluations.md`        | Evaluation runner, annotations, completion flow          |
| Observability Dashboard | `.context/admin/orchestration-observability.md`      | Dashboard metrics, trace viewers, logging audit          |
| Setup Wizard            | `.context/admin/setup-wizard.md`                     | 5-step guided setup flow, resume behavior                |
| Contextual Help         | `.context/ui/contextual-help.md`                     | `<FieldHelp>` directive for form fields                  |
| UI Hooks                | `.context/ui/hooks.md`                               | `useLocalStorage`, `useWizard`                           |

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
