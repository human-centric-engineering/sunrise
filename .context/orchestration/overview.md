# Agent Orchestration

The orchestration layer lives in `lib/orchestration/` and powers the Sunrise admin dashboard's AI agent system.

**Hard rule:** Everything under `lib/orchestration/` is **platform-agnostic**. Never import from `next/server`, `next/headers`, `next/cache`, or any Next.js module. HTTP/SSE wrapping happens in `app/api/v1/admin/orchestration/*`.

## Module Layout

| Module                         | Purpose                                                 | Status     |
| ------------------------------ | ------------------------------------------------------- | ---------- |
| `lib/orchestration/knowledge/` | Document ingestion, chunking, embeddings, vector search | Phase 1 ✓  |
| `lib/orchestration/llm/`       | Provider abstraction, model registry, cost tracking     | Phase 2a ✓ |
| `lib/orchestration/seed/`      | Dev seed data for providers / agents                    | Phase 1 ✓  |

## Documentation

| Topic         | File                                     | Covers                                                     |
| ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| LLM Providers | [`llm-providers.md`](./llm-providers.md) | Chat, streaming, embeddings, cost tracking, model registry |

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
