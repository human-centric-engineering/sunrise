# Agent Orchestration — Context for Claude Code

Architectural rules and entry points for working in the orchestration layer. This doc is deliberately small — it tells you the rules and where to look. For inventory facts (counts, step types, capabilities, schema), read the spec.

## Canonical references

| Need                          | File                                                      |
| ----------------------------- | --------------------------------------------------------- |
| **What does the system do?**  | `.context/orchestration/meta/functional-specification.md` |
| **Why was X chosen?**         | `.context/orchestration/meta/architectural-decisions.md`  |
| **Index of all meta docs**    | `.context/orchestration/meta/README.md`                   |
| **Engineering directory map** | `.context/orchestration/overview.md`                      |
| **Admin operator landing**    | `.context/admin/orchestration.md`                         |

## Architectural rules

These change how you write code. Treat as non-negotiable.

- **Platform-agnostic core.** Everything under `lib/orchestration/` is pure TypeScript. Never import from `next/server`, `next/headers`, `next/cache`, or any Next.js module. The chat handler returns `AsyncIterable<ChatEvent>` (typed plain objects), not HTTP responses.
- **API-first.** Every capability must be API-accessible before any UI is built. UI calls the API; it does not duplicate logic.
- **Multi-tenant via `userId`.** Scope all agent data by `userId`. Cross-user lookups return 404, not 403. Organisation scoping is a future addition — don't anticipate it.
- **`@/` imports only.** Never use relative paths, even for siblings. Enforced by ESLint.
- **Validate at boundaries.** Zod schemas in `lib/validations/orchestration.ts` validate every external input. Never `as` external data.

## Where things live

| Need                                             | File / Directory                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Core services (engine, capabilities, chat, etc.) | `lib/orchestration/`                                                                                    |
| API routes                                       | `app/api/v1/admin/orchestration/`, `app/api/v1/orchestration/`, `app/api/v1/embed/`, `app/api/v1/chat/` |
| Admin pages                                      | `app/admin/orchestration/`                                                                              |
| Components                                       | `components/admin/orchestration/`                                                                       |
| Types                                            | `types/orchestration.ts`                                                                                |
| Validation schemas                               | `lib/validations/orchestration.ts`                                                                      |
| Prisma models                                    | `prisma/schema.prisma` (29 `Ai*` models)                                                                |
| Seeds                                            | `prisma/seeds/data/`                                                                                    |
| SSE bridge                                       | `lib/api/sse.ts` (`sseResponse()`)                                                                      |
| Tests                                            | `tests/unit/lib/orchestration/`, `tests/integration/api/v1/admin/orchestration/`                        |

For per-module engineering detail (chat handler, knowledge base, workflows, MCP, scheduling, etc.), the directory map at `.context/orchestration/overview.md` lists every doc.

## Implementation skills

When the task fits one of these, the skill loads the right context for you:

- `/orchestration-agent-architect` — pattern selection, multi-pattern composition
- `/orchestration-solution-builder` — end-to-end build from problem to running solution
- `/orchestration-capability-builder` — custom capabilities (Zod, registry, DB, agent binding)
- `/orchestration-workflow-builder` — workflow DAGs with all step types
- `/orchestration-knowledge-builder` — document ingestion, embeddings, scoping
