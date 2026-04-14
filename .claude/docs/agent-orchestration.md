# Agent Orchestration Layer — Context for Claude Code

## What This Is

The Agent Orchestration Layer in the Sunrise admin dashboard lets admins design, configure, execute, and monitor AI agent systems using 21 agentic design patterns. It is fully built across 7 phases with 41 API routes, 9 service modules, and 6800+ tests.

**Main documentation:** [`.context/admin/orchestration.md`](../../.context/admin/orchestration.md)

## Architecture Decisions

- All orchestration services go in `lib/orchestration/` (platform-agnostic)
- All new Prisma models go in `prisma/schema.prisma` following existing conventions
- All new API routes go under `app/api/v1/admin/orchestration/*`
- All new admin pages go under `app/admin/orchestration/*`
- All new components go under `components/admin/orchestration/*`
- All new validation schemas go in `lib/validations/orchestration.ts`
- All new types go in `types/orchestration.ts`
- The vector DB uses pgvector extension on PostgreSQL
- SSE (Server-Sent Events) for streaming agent responses to clients
- LLM provider abstraction supporting Anthropic, OpenAI, Ollama, and any OpenAI-compatible provider

## Critical: Platform-Agnostic Core

`lib/orchestration/` MUST be pure TypeScript. It must NEVER import from `next/server`, `next/headers`, `next/cache`, or any Next.js-specific module.

The separation is:

- `lib/orchestration/*` — pure TypeScript core. Chat handler returns `AsyncIterable<ChatEvent>` (typed plain objects), NOT HTTP responses.
- `app/api/v1/admin/orchestration/*` — thin Next.js wrappers (~30 lines each) that handle auth, request parsing, SSE formatting, and delegate to the core.

## Module Layout

| Module        | Path                              | Phase | Purpose                                                 |
| ------------- | --------------------------------- | ----- | ------------------------------------------------------- |
| Knowledge     | `lib/orchestration/knowledge/`    | 1     | Document ingestion, chunking, embeddings, vector search |
| LLM Providers | `lib/orchestration/llm/`          | 2a    | Provider abstraction, model registry, cost tracking     |
| Capabilities  | `lib/orchestration/capabilities/` | 2b    | Tool dispatcher, built-in capabilities, rate limiting   |
| Chat          | `lib/orchestration/chat/`         | 3     | Streaming chat handler, context builder, input guard    |
| Workflows     | `lib/orchestration/workflows/`    | 4     | DAG validator, step types, templates                    |
| Engine        | `lib/orchestration/engine/`       | 5     | Runtime executor, 9 step executors, event stream        |
| Evaluations   | `lib/orchestration/evaluations/`  | 6     | Evaluation session completion handler                   |
| Seed          | `lib/orchestration/seed/`         | 1     | Dev seed data for providers / agents                    |

## Key File Paths

| Area        | Key Files                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Types       | `types/orchestration.ts` — all orchestration types, events, step types                           |
| Validation  | `lib/validations/orchestration.ts` — all Zod schemas                                             |
| SSE helper  | `lib/api/sse.ts` — `sseResponse()` used by chat + execute routes                                 |
| API routes  | `app/api/v1/admin/orchestration/` — 41 route files                                               |
| Admin pages | `app/admin/orchestration/` — dashboard, agents, capabilities, providers, workflows, costs, learn |
| Tests       | `tests/unit/lib/orchestration/`, `tests/integration/api/v1/admin/orchestration/`                 |

## API-First Rule

Every capability must be API-accessible before any UI is built. All API endpoints were built in Phase 3. All UI was built in Phase 4+.

## Multi-Tenant Note

Scope all agent data by `userId`. Organisation scoping can be added later.

## Future Work

- **Variable embedding dimensions** — allow the `AiKnowledgeChunk.embedding` column to support non-1536 dimensions, enabling local models (768-dim) without schema changes
- **Quarterly registry review** — update `lib/orchestration/llm/embedding-models.ts` pricing and add new models
- **Auto-detect embedding capability** — probe provider `/models` endpoint to discover embedding support automatically
- **Cohere native adapter** — Cohere's embeddings API uses `input_type` and `embedding_types` params that differ from OpenAI; a dedicated adapter would unlock full Cohere support

## Key Reference Documents

- [Orchestration overview](../../.context/admin/orchestration.md) — main entry point
- [Solution builder](../../.context/admin/orchestration-solution-builder.md) — problem-to-solution guide
- [Capabilities guide](../../.context/admin/orchestration-capabilities-guide.md) — how to create capabilities
- [Workflows guide](../../.context/admin/orchestration-workflows-guide.md) — how to design workflows
- [Agent architect skill](../skills/agent-architect/SKILL.md) — pattern selection and composition
