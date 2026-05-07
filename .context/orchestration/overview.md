# Agent Orchestration — Engineering Directory

The orchestration layer lives in `lib/orchestration/` and powers the Sunrise admin dashboard's AI agent system. This page is the engineering-side directory map for `.context/orchestration/` — one row per topic doc.

For the full module list, every step type, every capability, route counts, and the schema, see [`meta/functional-specification.md`](./meta/functional-specification.md). For the architectural rules code authors must follow, see [`.claude/docs/agent-orchestration.md`](../../.claude/docs/agent-orchestration.md). For the admin UI, see [`.context/admin/orchestration.md`](../admin/orchestration.md).

**Hard rule (load-bearing):** Everything under `lib/orchestration/` is platform-agnostic. Never import from `next/server`, `next/headers`, `next/cache`, or any Next.js module. HTTP/SSE wrapping happens in `app/api/v1/admin/orchestration/*`.

## Engineering Topics

| Doc                                                              | Covers                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`llm-providers.md`](./llm-providers.md)                         | Provider abstraction, chat, streaming, embeddings, cost tracking, model registry |
| [`provider-selection-matrix.md`](./provider-selection-matrix.md) | Tier classification, model audit workflow, decision heuristic                    |
| [`capabilities.md`](./capabilities.md)                           | Tool dispatcher, built-in capabilities, rate limits, approval gating             |
| [`chat.md`](./chat.md)                                           | Streaming chat handler, tool loop, context builder, error codes                  |
| [`knowledge.md`](./knowledge.md)                                 | Document ingestion, chunking, vector search, hybrid retrieval                    |
| [`document-ingestion.md`](./document-ingestion.md)               | Multi-format parsing, PDF preview flow, parser architecture                      |
| [`workflows.md`](./workflows.md)                                 | DAG validator, step types, error codes                                           |
| [`workflow-versioning.md`](./workflow-versioning.md)             | Publish / draft / rollback model, execution pinning, audit events                |
| [`patterns-and-steps.md`](./patterns-and-steps.md)               | The 21 canonical patterns, step→pattern relationships, author guidance           |
| [`engine.md`](./engine.md)                                       | Runtime executor, executor registry, events, checkpoints, error strategies       |
| [`tracing.md`](./tracing.md)                                     | Tracer interface, no-op default, OTEL adapter, span tree                         |
| [`external-calls.md`](./external-calls.md)                       | HTTP executor, outbound rate limits, auth, response caps                         |
| [`autonomous-orchestration.md`](./autonomous-orchestration.md)   | Orchestrator step, workflows vs autonomous, when to use each                     |
| [`resilience.md`](./resilience.md)                               | Circuit breaker, fallback, budget UX, input guard, error registry                |
| [`output-guard.md`](./output-guard.md)                           | Topic boundaries, PII detection, brand voice, citation guard                     |
| [`agent-visibility.md`](./agent-visibility.md)                   | Visibility modes, invite tokens, access control                                  |
| [`api-keys.md`](./api-keys.md)                                   | Self-service API keys, scopes, key resolution                                    |
| [`mcp.md`](./mcp.md)                                             | MCP protocol, tools, resources, keys, audit                                      |
| [`scheduling.md`](./scheduling.md)                               | Cron schedules, webhook triggers, scheduler tick                                 |
| [`inbound-triggers.md`](./inbound-triggers.md)                   | Slack / Postmark / generic-HMAC inbound adapters, replay protection              |
| [`hooks.md`](./hooks.md)                                         | In-process event dispatch, outbound webhooks vs internal handlers                |
| [`analytics.md`](./analytics.md)                                 | Popular topics, unanswered questions, engagement, gaps                           |
| [`evaluation-metrics.md`](./evaluation-metrics.md)               | Named-metric scoring (faithfulness, groundedness, relevance), rescore            |
| [`experiments.md`](./experiments.md)                             | A/B variants, lifecycle, run API                                                 |
| [`backup.md`](./backup.md)                                       | Export/import config, schema versioning, ImportResult                            |
| [`embed.md`](./embed.md)                                         | Token auth, CORS, widget.js loader, Shadow DOM chat                              |
| [`admin-api.md`](./admin-api.md)                                 | Admin HTTP API summary (paths, auth, rate limits)                                |
| [`recipes/`](./recipes/)                                         | Vendor integration cookbook (HTTP-based, no SDK bundling)                        |
| [`meta/`](./meta/README.md)                                      | Spec, decisions, maturity, roadmap, hosting, commercial, QA test plan            |

## Architecture Decisions (summary)

The full record with alternatives and rationale lives in [`meta/architectural-decisions.md`](./meta/architectural-decisions.md). The decisions you'll feel day-to-day:

- **Platform-agnostic core.** Orchestration services return plain values and `AsyncIterable`s, not HTTP responses. The API layer adapts.
- **API-first.** Every capability must be API-accessible before any UI is built.
- **Multi-tenant by `userId`.** All agent data is scoped by `userId`. Organisation scoping is a later addition.
- **Provider-agnostic LLMs.** A single `LlmProvider` interface covers Anthropic, OpenAI, Ollama, LM Studio, vLLM, Together, Fireworks, Groq, Voyage AI, Google, Mistral, Cohere. Callers never touch vendor SDKs directly.
- **pgvector** for embeddings; **SSE** for streaming chat.

## Related Files

- [`.claude/docs/agent-orchestration.md`](../../.claude/docs/agent-orchestration.md) — architectural rules for code authors
- [`.context/admin/orchestration.md`](../admin/orchestration.md) — admin operator landing
- `.claude/skills/orchestration-*` — implementation skills (architect, solution builder, capability builder, workflow builder, knowledge builder)
- `types/orchestration.ts` — shared TypeScript types (`TokenUsage`, `ChatEvent`, `CostSummary`, ...)
- `lib/validations/orchestration.ts` — Zod schemas for every external boundary
- `prisma/schema.prisma` — 29 `Ai*` models (agents, workflows, conversations, knowledge, costs, …)
