# Agent Orchestration

The orchestration layer lives in `lib/orchestration/` and powers the Sunrise admin dashboard's AI agent system.

**Hard rule:** Everything under `lib/orchestration/` is **platform-agnostic**. Never import from `next/server`, `next/headers`, `next/cache`, or any Next.js module. HTTP/SSE wrapping happens in `app/api/v1/admin/orchestration/*`.

## Module Layout

| Module                            | Purpose                                                                                                                      | Status                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `lib/orchestration/knowledge/`    | Document ingestion, chunking, embeddings, vector search                                                                      | Phase 1 ✓                    |
| `lib/orchestration/llm/`          | Provider abstraction, model registry, cost tracking                                                                          | Phase 2a ✓                   |
| `lib/orchestration/capabilities/` | Tool dispatcher, built-in capabilities, rate limiting, approval gating                                                       | Phase 2b ✓                   |
| `lib/orchestration/chat/`         | Streaming chat handler, context builder, message composition                                                                 | Phase 2c ✓                   |
| `lib/orchestration/workflows/`    | DAG validator (executor + step runners arrive in Session 5.2)                                                                | Phase 3.2 ✓ (validator only) |
| `lib/orchestration/seed/`         | Dev seed data for providers / agents                                                                                         | Phase 1 ✓                    |
| `app/api/v1/admin/orchestration/` | Admin CRUD + runtime routes (chat stream, knowledge base, conversations); execution routes are 501 stubs pending Session 5.2 | Phase 3.3 ✓                  |

## Documentation

| Topic         | File                                     | Covers                                                                     |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| LLM Providers | [`llm-providers.md`](./llm-providers.md) | Chat, streaming, embeddings, cost tracking, model registry                 |
| Capabilities  | [`capabilities.md`](./capabilities.md)   | Dispatcher, built-in capabilities, rate limits, approval gating            |
| Chat          | [`chat.md`](./chat.md)                   | Streaming chat handler, tool loop, context builder, error codes            |
| Knowledge     | [`knowledge.md`](./knowledge.md)         | Document ingestion, chunking, vector search, seeder                        |
| Workflows     | [`workflows.md`](./workflows.md)         | DAG validator, error codes, Phase 5.2 engine roadmap                       |
| Admin API     | [`admin-api.md`](./admin-api.md)         | Agents, capabilities, providers, workflows, chat, knowledge, conversations |

## Architecture Decisions

- **Platform-agnostic core**: Orchestration services return plain values and `AsyncIterable`s, not HTTP responses. The API layer adapts.
- **API-first**: Every capability must be API-accessible before any UI is built.
- **Multi-tenant**: All agent data is scoped by `userId`. Organisation scoping is a later addition.
- **Provider-agnostic LLMs**: A single `LlmProvider` interface covers Anthropic, OpenAI, Ollama, LM Studio, vLLM, Together, Fireworks, and Groq. Callers never touch vendor SDKs directly.
- **pgvector** for embeddings; **SSE** for streaming responses from the future chat handler.

## Related Files

- `.claude/docs/agent-orchestration.md` — architectural brief for Claude Code sessions
- `.claude/skills/agent-architect/` — design-decision skill for orchestration work
- `types/orchestration.ts` — shared TypeScript types (`TokenUsage`, `ChatEvent`, `CostSummary`, ...)
- `prisma/schema.prisma` — `AiAgent`, `AiProviderConfig`, `AiCostLog`, `AiConversation`, `AiWorkflowExecution`, and knowledge-base models
