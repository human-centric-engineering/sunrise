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

- **Rate limiting is automatic** — section caps are enforced by `proxy.ts` via the policy table at `lib/security/rate-limit-policy.ts`. New `/api/v1/**` routes inherit 100/min keyed on session-user with no handler work. Add per-flow sub-caps inside handlers only for expensive sub-flows (chat-stream, audio, image, upload, contact, etc.). Do not call section limiters (`adminLimiter`, `apiLimiter`, `authLimiter`) directly from route handlers — the middleware already did. See [`.context/security/rate-limiting.md`](./.context/security/rate-limiting.md).
- **Use auth guards** — `withAuth()`, `withAdminAuth()` from `lib/auth/guards.ts`
- **Run `/security-review`** before merging feature branches

### Architecture

- **API-first** — implement API endpoints before UI; every capability must be API-accessible
- **Server components by default** — add `'use client'` only when needed
- **No N+1 client-side fetches** — list/table pages get all data from a single enriched list endpoint; never fire per-row API calls in `useEffect`
- **Contextual help on form fields** — every non-trivial form field gets a `<FieldHelp>` ⓘ popover; see `.context/ui/contextual-help.md`
- **New `User` relations need an `onDelete` policy _and_ an export disposition** — any new model with a `userId`/`createdBy` FK must (1) declare `onDelete: Cascade` (personal data) or `onDelete: SetNull` (retained config/audit, FK nullable) — omitting it defaults to `Restrict` and silently breaks GDPR erasure; and (2) be added to `SUBJECT_DATA_SOURCES` in `lib/privacy/export-sources.ts`, which decides what a data subject receives from it. The second is enforced — `tests/unit/lib/privacy/export-sources.test.ts` parses the schema and fails until the model is listed. **Never delete a row from that manifest to make the test pass**; that ships a silently short answer to a data subject. Never call `prisma.user.delete()` directly — route account deletion through `eraseUser()`, and subject access through `exportUserData()`. See `.context/privacy/data-erasure.md` and `.context/privacy/data-export.md`.
- **`CHANGELOG.md` follows the public surface** — when a PR adds, removes, or changes a named seam, a documented public API, or a published Prisma model interface (see [`VERSIONING.md`](./VERSIONING.md#public-surface-contract-tight-definition)), append a bullet to `CHANGELOG.md`'s `## [Unreleased]` section as part of the same PR using [Keep-a-Changelog](https://keepachangelog.com/en/1.1.0/) categories (Added / Changed / Deprecated / Removed / Fixed / Security). PRs that don't touch the public surface (internal refactors, tests, docs, chores) deliberately do **not** belong in the CHANGELOG — adding noise dilutes the signal forks rely on. `/pre-pr` step 5d flags public-surface diffs that omit a CHANGELOG entry.

## MCP Integration

### Next.js DevTools (Required)

**Always call `mcp__next-devtools__init` first** — do this without asking when starting work.

Use for: diagnostics, route inspection, runtime errors, browser automation, Next.js docs.

### Context7 (Library Docs)

Use for external library docs: `resolve-library-id` → `query-docs`. Essential for current Next.js/Prisma/Tailwind patterns.

> **The next section applies only when the `hce-hub` MCP server is configured
> for this checkout.** Sunrise is open source: if you have forked it, or are
> contributing without access to the HCE Hub, skip the whole section that
> follows — including its "fix your MCP config" instruction. Nothing else in
> this file depends on it; the development workflow without the Hub is
> [`.context/workflow.md`](./.context/workflow.md).

<!-- hce-hub:bootstrap — regenerate with the Hub's `get_project_bootstrap` tool and replace everything between these markers -->

## This project is coordinated through the HCE Hub

**Sunrise** · slug `sunrise` · project id `cmtd5heg2001804ky8pgo6odx` · host platform: Sunrise (the platform)

The Hub is this project's **system of record** for planning and delivery.
Claiming, planning, starting, completing and shipping are Hub tool calls over
MCP — not files in this repo. If you do not already know what you are picking
up, start with `next_task`. Your client's tool list is the current set;
`model.verbs` in the core process groups them by what they are for.

If those tools are not in your tool list at all, this repo's MCP config is
missing or its key is wrong. Fix that before planning anything, rather than
working around it.

### Read the process from the Hub before you start work of any kind

**This block is a pointer. It is not the process, and it is not a summary of
one.** It carries this project's identity, where the process lives, and the
little that has to survive the Hub being unreachable — nothing else. Working
from this block alone means working without the rules it does not contain.

So read the tiers below before you plan, size, **or start building** — most
sessions do the last of those without doing the first two. What the Hub serves
is the current version; this repo deliberately does not restate it, because a
copy is the thing that goes stale.

- `hub://process/core` · HCE process — core. **Read its `read.judgement` section first.**
- `hub://process/sunrise-platform` · HCE process — working in Sunrise.

Every rule is addressable by the id printed beside its heading (`fp1`,
`flow.gates`, `read.judgement`). Cite them by id rather than re-explaining
them.

### The shape, if the Hub is unreachable

Five lines, duplicated here on purpose because they almost never change:

1. **Claim** the feature before working it — ownership is a feature-level thing.
2. **Reconcile** the plan against the actual tree before sizing anything.
3. **Plan** it into tasks, each with a done-when provable _at merge_.
4. **Build**, look at it yourself, then run the gates, and open the PR last.
5. **Close out** the feature, recording decisions as you make them.

### Gates

In this order. Read **exit codes**, not piped output — a pipeline that swallows
a failure reports success.

1. `/pre-pr` — the platform's own checklist (`npm run validate` plus a scoped
   test run and the anti-pattern scans), including the public-surface checks.
2. `/security-review`
3. `/code-review`
4. `npm run format`

**The commands are here; the rules about running them are not.** What to do
with a finding, when to stop reviewing, and what must never be amended are in
`flow.gates` and `flow.review-rounds`.

<!-- /hce-hub:bootstrap -->

## Essential Commands

```bash
# Development
npm run dev                    # Start dev server
npm run validate               # CHANGELOG + Node version + type-check + lint + format (Prettier + Prisma)

# Database
npm run db:migrate:dev         # Create and apply migration (dev only)
npm run db:migrate:deploy      # Apply pending migrations (prod / CI)
npm run db:migrate:status      # Show migration status
npm run db:seed                # Apply new/changed seed units
npm run db:reset               # Drop, re-migrate, re-seed from scratch
npm run db:studio              # Open Prisma Studio

# Testing
npm run test:changed           # Tests this branch affects + whole-tree guards (fast; what /pre-pr runs)
npm run test:changed:coverage  # ...and gate coverage per changed file (≥80% each)
npm run test                   # Full suite — for a merge from main, a release cut, or the whole picture
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

Always use the `@/` path alias — never relative paths. Enforced by ESLint (`no-restricted-imports`).

```typescript
import { logger } from '@/lib/logging'; // ✅
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/forms/form-error'; // ✅ even for sibling files
import { logger } from '../../lib/logging'; // ❌
import { FormError } from './form-error'; // ❌ no exception for siblings
```

**Why no sibling-import exception:** Sunrise is a starter template. Downstream forks copy folders, rename modules, and split capsules — `@/` survives those moves; `./` breaks silently. A single mechanical rule is also grep-checkable by `/pre-pr` and `/code-review`, removes "is this local or cross-module?" judgment, and avoids the slow drift toward inconsistency that exception-laden rules invite. We accept the cost: cohesive capsules (`components/forms/`, `components/admin/orchestration/workflow-builder/`) read slightly more verbosely than they would with `./` siblings. That trade is intentional, not an oversight.

### API Response Format

```typescript
// Success
{ success: true, data: { ... }, meta?: { ... } }

// Error
{ success: false, error: { code: "ERROR_CODE", message: "...", details?: { ... } } }
```

### Key Utilities

| Need                  | Utility                                                              | Location                                |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| API responses         | `successResponse()`, `errorResponse()`                               | `lib/api/responses.ts`                  |
| Auth guards           | `withAuth()`, `withAdminAuth()`                                      | `lib/auth/guards.ts`                    |
| Rate-limit policy     | `RATE_LIMIT_POLICY`, `findRateLimitRule()`                           | `lib/security/rate-limit-policy.ts`     |
| Rate-limit dispatcher | `applyRateLimit()` (called from `proxy.ts`)                          | `lib/security/rate-limit-middleware.ts` |
| Rate-limit primitives | `authLimiter`, `apiLimiter`, `chatLimiter`, etc. (per-flow sub-caps) | `lib/security/rate-limit.ts`            |
| Client IP             | `getClientIP()`                                                      | `lib/security/ip.ts`                    |
| Sanitization          | `escapeHtml()`, `sanitizeUrl()`                                      | `lib/security/sanitize.ts`              |
| User erasure (GDPR)   | `eraseUser()`                                                        | `lib/privacy/erase-user.ts`             |
| Subject access (GDPR) | `exportUserData()`                                                   | `lib/privacy/export-user.ts`            |
| Server fetch          | `serverFetch()`                                                      | `lib/api/server-fetch.ts`               |
| Logging               | `logger.info()`, `logger.error()`                                    | `lib/logging/index.ts`                  |
| Local storage         | `useLocalStorage()`                                                  | `lib/hooks/use-local-storage.ts`        |
| Wizard state          | `useWizard()`                                                        | `lib/hooks/use-wizard.ts`               |
| Unmount-safe timer    | `useTimeout()`                                                       | `lib/hooks/use-timeout.ts`              |
| ETag / 304            | `computeETag()`, `checkConditional()`                                | `lib/api/etag.ts`                       |

## Skills

Use these for implementation tasks:

| Skill                               | Use For                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `/api-builder`                      | REST API endpoints                                     |
| `/form-builder`                     | Forms with Zod + react-hook-form                       |
| `/component-builder`                | Reusable React components                              |
| `/page-builder`                     | New pages with layouts/metadata                        |
| `/testing`                          | Quick test patterns reference                          |
| `/test-plan`                        | Analyze code and produce a test plan                   |
| `/test-write`                       | Execute test plan with test-engineer agents            |
| `/test-review`                      | Confidence-scored test quality report (≥80 filter)     |
| `/test-fix`                         | Apply findings from a `/test-review` report            |
| `/test-coverage`                    | Find coverage gaps and untested files                  |
| `/test-triage`                      | Ledger-driven triage for codebase-wide remediation     |
| `/email-designer`                   | React Email templates                                  |
| `/docs-writer`                      | Create/update .context/ docs                           |
| `/docs-audit`                       | Check documentation accuracy                           |
| `/orchestration-agent-architect`    | Agentic design patterns, orchestration architecture    |
| `/orchestration-capability-builder` | Custom agent capabilities (Zod, registry, DB, binding) |
| `/orchestration-workflow-builder`   | Workflow DAGs with 15 step types                       |
| `/orchestration-knowledge-builder`  | Knowledge base setup (upload, embed, scope)            |
| `/orchestration-solution-builder`   | End-to-end orchestration solutions                     |

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

> **Two namespace tiers are reserved for downstream forks — Sunrise core must
> never create files or tables under either.** `/app` is the **leaf-fork** tier
> (`.context/app/`, `lib/app/**` fork-owned scaffold, `components/app/**`, and
> `prisma/schema/app.prisma` — which ships empty; the platform's own app-domain
> models live in `prisma/schema/platform.prisma`). `/framework` is the
> **framework-layer** tier for forks that sit _between_ Sunrise and their own
> leaf forks (e.g. Daybreak): `lib/framework/`, `components/framework/`,
> `.context/framework/`, `prisma/schema/framework-*.prisma`, and the
> `framework_` table prefix. Keeping
> both empty upstream is what lets a fork's files there merge cleanly. Sunrise
> platform docs go under a named domain folder (below); the app boot seam is
> `lib/app/bootstrap.ts` (empty `initApp()`). See
> [`CUSTOMIZATION.md`](./CUSTOMIZATION.md#the-appplatform-model).

| Domain                   | Path                                                      | Key Content                                                                                                                              |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture             | `.context/architecture/`                                  | System design, deployment                                                                                                                |
| CI Pipeline              | `.context/architecture/ci.md`                             | GitHub Actions pipeline; public/private-fork adaptation, `CI_TEST_SCOPE` knob, GHAS-skip, sharding, the two forker gotchas               |
| Checks & Gates           | `.context/architecture/checks.md`                         | "I found nothing" vs "I could not look" — the six channels, with the defect each one caused                                              |
| Fork Init Seams          | `.context/architecture/fork-init-seams.md`                | The eleven `lib/app/*` seams; the rollback guarantee, the roster (derived, not written), and what per-registration isolation still needs |
| Multi-Tenancy            | `.context/architecture/multi-tenancy.md`                  | Opt-in RLS retrofit playbook; single-tenant by default, `TENANCY_MODE` seam, fork-tier map, upstream-sync checklist                      |
| Multi-Tenancy Design     | `.context/architecture/multi-tenancy-design.md`           | Binding design for the opt-in tenancy capability: the 2026-08-27 decisions, design principles, target architecture, assurance, spikes    |
| Multi-Tenancy Research   | `.context/architecture/multi-tenancy-research.md`         | Gap analysis: five isolation planes, control/commercial planes, ownership matrix, fork merge surface, provisions for forks               |
| Authentication           | `.context/auth/`                                          | better-auth, sessions, guards                                                                                                            |
| API                      | `.context/api/`                                           | Endpoints, responses, client                                                                                                             |
| Database                 | `.context/database/`                                      | Prisma schema, migrations, seeding                                                                                                       |
| Security                 | `.context/security/`                                      | Rate limiting, headers, CORS                                                                                                             |
| Privacy                  | `.context/privacy/`                                       | Consent, erasure (Art. 17), subject access (Art. 15) and its source manifest                                                             |
| Logging                  | `.context/logging/`                                       | Structured logging, request ctx                                                                                                          |
| Testing                  | `.context/testing/`                                       | Patterns, mocking, async                                                                                                                 |
| Email                    | `.context/email/`                                         | Templates, sending                                                                                                                       |
| Workflow                 | `.context/workflow.md`                                    | Git, commits, PR process                                                                                                                 |
| AI Orchestration         | `.claude/docs/agent-orchestration.md`                     | Architectural rules for Claude Code sessions (platform-agnostic core, file paths)                                                        |
| Orchestration Spec       | `.context/orchestration/meta/functional-specification.md` | **Canonical** — what the system does (every step type, capability, route, schema model)                                                  |
| Orchestration Decisions  | `.context/orchestration/meta/architectural-decisions.md`  | Why each choice was made; alternatives rejected and the reasons                                                                          |
| Orchestration Roadmap    | `.context/orchestration/meta/improvement-priorities.md`   | Prioritised improvements against actual deployment profile                                                                               |
| Orchestration Hosting    | `.context/orchestration/meta/hosting-requirements.md`     | What it takes to run in production; platform comparison                                                                                  |
| Orchestration Meta Index | `.context/orchestration/meta/README.md`                   | Index for the 8 meta docs (spec, decisions, roadmap, commercial, QA)                                                                     |
| Orchestration Overview   | `.context/admin/orchestration.md`                         | Admin operator landing — quick start and pointers to admin sub-pages                                                                     |
| Solution Builder         | `.context/admin/orchestration-solution-builder.md`        | Problem-to-solution guide, 5 worked examples                                                                                             |
| Capabilities Guide       | `.context/admin/orchestration-capabilities-guide.md`      | How to create capabilities, BaseCapability ref                                                                                           |
| Workflows Guide          | `.context/admin/orchestration-workflows-guide.md`         | Step types, error strategies, templates, extending                                                                                       |
| LLM Providers            | `.context/orchestration/llm-providers.md`                 | Provider abstraction, cost tracking                                                                                                      |
| Capabilities             | `.context/orchestration/capabilities.md`                  | Tool dispatcher, built-ins, rate limits                                                                                                  |
| Streaming Chat           | `.context/orchestration/chat.md`                          | Chat handler, tool loop, context builder                                                                                                 |
| Knowledge Base           | `.context/orchestration/knowledge.md`                     | Document ingestion, chunking, vector search                                                                                              |
| Workflows                | `.context/orchestration/workflows.md`                     | DAG validator, step types, error codes                                                                                                   |
| Workflow Versioning      | `.context/orchestration/workflow-versioning.md`           | Publish/draft/rollback model, execution pinning, audit events                                                                            |
| Cost Estimation          | `.context/orchestration/cost-estimation.md`               | Generic pre-run USD estimate service; empirical/heuristic modes; trigger-UI recipe                                                       |
| Step Provenance          | `.context/orchestration/provenance.md`                    | `output.sources` contract, engine capture, approval/trace UI pills, opt-in guard rule                                                    |
| Agent Field Registry     | `.context/orchestration/agent-fields.md`                  | Single source of truth for `AiAgent` config fields; how to add a field, derived vs parity-tested surfaces, fork seam                     |
| Patterns & Steps         | `.context/orchestration/patterns-and-steps.md`            | The 21 canonical patterns, step→pattern relationships, author guidance                                                                   |
| Orchestration Engine     | `.context/orchestration/engine.md`                        | Runtime executor, registry, events, strategies                                                                                           |
| Tracing (OTEL plug-in)   | `.context/orchestration/tracing.md`                       | Tracer interface, no-op default, OTEL adapter, span tree, attributes                                                                     |
| External Calls           | `.context/orchestration/external-calls.md`                | HTTP executor, outbound rate limits, auth, response caps                                                                                 |
| Resilience & Errors      | `.context/orchestration/resilience.md`                    | Circuit breaker, fallback, budget UX, input guard                                                                                        |
| Output Guard             | `.context/orchestration/output-guard.md`                  | Topic boundaries, PII detection, brand voice                                                                                             |
| Agent Visibility         | `.context/orchestration/agent-visibility.md`              | Visibility modes, invite tokens, access control                                                                                          |
| API Keys                 | `.context/orchestration/api-keys.md`                      | Self-service API keys, scopes, key resolution                                                                                            |
| MCP Server               | `.context/orchestration/mcp.md`                           | MCP protocol, tools, resources, keys, audit                                                                                              |
| Orchestration Admin API  | `.context/orchestration/admin-api.md`                     | Agents, capabilities, chat, knowledge, executions                                                                                        |
| Orchestration Endpoints  | `.context/api/orchestration-endpoints.md`                 | Admin HTTP reference — full table of every admin route                                                                                   |
| Provider Selection       | `.context/orchestration/provider-selection-matrix.md`     | Tier classification, decision heuristic, model audit workflow                                                                            |
| Consumer Chat API        | `.context/api/consumer-chat.md`                           | End-user chat endpoints, agent visibility, rate limits                                                                                   |
| Document Ingestion       | `.context/orchestration/document-ingestion.md`            | Multi-format parsing, PDF preview flow, parser arch                                                                                      |
| Scheduling & Webhooks    | `.context/orchestration/scheduling.md`                    | Cron schedules, webhook triggers, scheduler tick                                                                                         |
| Data Retention & Pruning | `.context/orchestration/retention.md`                     | Scheduled purge of aged conversations/executions/evals/logs; terminal-only, coherent windows                                             |
| Inbound Triggers         | `.context/orchestration/inbound-triggers.md`              | Slack / Postmark / generic-HMAC adapters, replay protection, per-channel payload tables                                                  |
| Event Hooks              | `.context/orchestration/hooks.md`                         | In-process dispatch, outbound webhooks vs internal handlers                                                                              |
| Client Analytics         | `.context/orchestration/analytics.md`                     | Popular topics, unanswered questions, engagement, gaps                                                                                   |
| Autonomous Orchestration | `.context/orchestration/autonomous-orchestration.md`      | Orchestrator step, workflows vs autonomous, when to use each                                                                             |
| Backup & Restore         | `.context/orchestration/backup.md`                        | Export/import config, schema versioning, ImportResult                                                                                    |
| Experiments (A/B)        | `.context/orchestration/experiments.md`                   | Variants, lifecycle (draft→running→completed), run API                                                                                   |
| Embed Widget             | `.context/orchestration/embed.md`                         | Token auth, CORS, widget.js loader, Shadow DOM chat                                                                                      |
| SSE Bridge               | `.context/api/sse.md`                                     | `sseResponse` helper, framing, sanitization                                                                                              |
| Orchestration Dashboard  | `.context/admin/orchestration-dashboard.md`               | Admin landing page, data sources, layout                                                                                                 |
| Agents List / Pages      | `.context/admin/orchestration-agents.md`                  | List, create, edit shells; table, bulk export                                                                                            |
| Agent Form               | `.context/admin/agent-form.md`                            | 6-tab create/edit form, FieldHelp reference                                                                                              |
| Agent Profiles (admin)   | `.context/admin/orchestration-agent-profiles.md`          | Shared persona / voice / guardrails library, attached-agent counts                                                                       |
| Agent Profiles (runtime) | `.context/orchestration/agent-profiles.md`                | Inheritance resolver, override/append modes, composition order                                                                           |
| Capabilities List        | `.context/admin/orchestration-capabilities.md`            | Table, category filter, agents-using count                                                                                               |
| Capability Form          | `.context/admin/capability-form.md`                       | 4 tabs, visual builder ↔ JSON editor, safety                                                                                             |
| Providers List           | `.context/admin/orchestration-providers.md`               | Card grid, status dots, env-var-only security                                                                                            |
| Provider Form            | `.context/admin/provider-form.md`                         | 4-flavor selector, reverse-mapping on edit                                                                                               |
| Provider Models (admin)  | `.context/admin/orchestration-provider-models.md`         | Matrix view, decision heuristic, model form                                                                                              |
| Provider Audit Guide     | `.context/admin/orchestration-provider-audit-guide.md`    | Walkthrough: run the built-in audit workflow, tamper test                                                                                |
| Costs & Budget           | `.context/admin/orchestration-costs.md`                   | Summary, trend, savings, settings singleton                                                                                              |
| Workflow Builder         | `.context/admin/workflow-builder.md`                      | React Flow canvas, palette, step registry                                                                                                |
| Learning UI              | `.context/admin/orchestration-learn.md`                   | Pattern explorer, advisor chatbot, quiz, tabbed hub                                                                                      |
| Knowledge Base UI        | `.context/admin/orchestration-knowledge-ui.md`            | Document management, upload, search test                                                                                                 |
| Chat Interface           | `.context/admin/orchestration-chat-interface.md`          | Reusable SSE chat component, embedded mode                                                                                               |
| Conversations (admin)    | `.context/admin/orchestration-conversations.md`           | Conversation list, trace viewer, tagging, export                                                                                         |
| Evaluations UI           | `.context/admin/orchestration-evaluations.md`             | Evaluation runner, annotations, completion flow                                                                                          |
| Evaluation Metrics       | `.context/orchestration/evaluation-metrics.md`            | Named-metric scoring (faithfulness, groundedness, relevance), rescore                                                                    |
| Dataset-driven Evals     | `.context/orchestration/evaluations.md`                   | Phase 1 batch runs: datasets, grader registry, worker, polymorphic subject                                                               |
| Observability Dashboard  | `.context/admin/orchestration-observability.md`           | Dashboard metrics, trace viewers, logging audit                                                                                          |
| Live Engine (admin)      | `.context/admin/orchestration-executions-live-engine.md`  | Stuck-execution dashboard (embedded above the executions list), force-fail action, lease inspector, stuck-threshold setting              |
| Analytics (admin)        | `.context/admin/orchestration-analytics.md`               | Usage, popular topics, unanswered, feedback, gaps                                                                                        |
| Audit Log (admin)        | `.context/admin/orchestration-audit-log.md`               | Immutable config change log, entity filters                                                                                              |
| Approval Queue (admin)   | `.context/admin/orchestration-approvals.md`               | Pending approvals list, approve/reject, sidebar badge                                                                                    |
| Setup Wizard             | `.context/admin/setup-wizard.md`                          | 5-step guided setup flow, resume behavior                                                                                                |
| Contextual Help          | `.context/ui/contextual-help.md`                          | `<FieldHelp>` directive for form fields                                                                                                  |
| UI Hooks                 | `.context/ui/hooks.md`                                    | `useLocalStorage`, `useWizard`, `useTimeout`                                                                                             |
| Per-Surface Theming      | `.context/ui/surface-theming.md`                          | `data-surface` seam: proxy classification, `<SurfaceSync>`, fork-owned `brand-theme.css`, the six design constraints                     |

## Troubleshooting

**Database connection fails:**

- Check `DATABASE_URL` in `.env.local`
- In Docker: use `db` not `localhost`

**Build fails:**

- Run `npm run type-check` for errors
- Run `npx prisma generate` after schema changes

**Lint dies with ENOENT before reading any source file:**

- Stale paths in the ESLint cache (see the `coverage/**` note in `eslint.config.mjs`)
- Run `npm run clean:cache` — the toolchain caches are `.eslintcache` and
  `.prettiercache` at the repo root, so `rm -rf .next` no longer clears them (#677)

**Auth not working:**

- Verify `BETTER_AUTH_SECRET` is set
- Check `BETTER_AUTH_URL` matches app URL

**Peer dependency warnings (better-auth/Prisma):**

- Expected — `.npmrc` has `legacy-peer-deps=true`
- No action required
