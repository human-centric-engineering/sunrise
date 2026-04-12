# Agent Orchestration

The orchestration layer lives in `lib/orchestration/` and powers the Sunrise admin dashboard's AI agent system.

**Hard rule:** Everything under `lib/orchestration/` is **platform-agnostic**. Never import from `next/server`, `next/headers`, `next/cache`, or any Next.js module. HTTP/SSE wrapping happens in `app/api/v1/admin/orchestration/*`.

## Module Layout

| Module                            | Purpose                                                                                                        | Status      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| `lib/orchestration/knowledge/`    | Document ingestion, chunking, embeddings, vector search                                                        | Phase 1 ✓   |
| `lib/orchestration/llm/`          | Provider abstraction, model registry, cost tracking                                                            | Phase 2a ✓  |
| `lib/orchestration/capabilities/` | Tool dispatcher, built-in capabilities, rate limiting, approval gating                                         | Phase 2b ✓  |
| `lib/orchestration/chat/`         | Streaming chat handler, context builder, message composition                                                   | Phase 2c ✓  |
| `lib/orchestration/workflows/`    | DAG validator (authoring-time structural checks)                                                               | Phase 3.2 ✓ |
| `lib/orchestration/engine/`       | Runtime executor — `OrchestrationEngine`, executor registry, 9 step executors, event stream                    | Phase 5.2 ✓ |
| `lib/orchestration/seed/`         | Dev seed data for providers / agents                                                                           | Phase 1 ✓   |
| `lib/orchestration/evaluations/`  | Evaluation session completion handler (bounded prompt, sanitized errors)                                       | Phase 3.4 ✓ |
| `app/api/v1/admin/orchestration/` | Admin CRUD + runtime routes (chat stream, knowledge, conversations, costs, evaluations, live workflow execute) | Phase 5.2 ✓ |

## Documentation

| Topic         | File                                     | Covers                                                                         |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| LLM Providers | [`llm-providers.md`](./llm-providers.md) | Chat, streaming, embeddings, cost tracking, model registry                     |
| Capabilities  | [`capabilities.md`](./capabilities.md)   | Dispatcher, built-in capabilities, rate limits, approval gating                |
| Chat          | [`chat.md`](./chat.md)                   | Streaming chat handler, tool loop, context builder, error codes                |
| Knowledge     | [`knowledge.md`](./knowledge.md)         | Document ingestion, chunking, vector search, seeder                            |
| Workflows     | [`workflows.md`](./workflows.md)         | DAG validator, step types, error codes                                         |
| Engine        | [`engine.md`](./engine.md)               | Runtime executor, executor registry, events, checkpoints, error strategies     |
| Resilience    | [`resilience.md`](./resilience.md)       | Circuit breaker, provider fallback, budget UX, input guard, error registry     |
| Admin API     | [`admin-api.md`](./admin-api.md)         | Agents, capabilities, providers, workflows, chat, knowledge, costs, executions |

### Admin UI (`.context/admin/`)

| Topic             | File                                                                          | Covers                                                               |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Agents list       | [`orchestration-agents.md`](../admin/orchestration-agents.md)                 | List page, table, duplicate/import dialogs                           |
| Agent form        | [`agent-form.md`](../admin/agent-form.md)                                     | 5-tab create/edit form, instructions history, test chat              |
| Capabilities list | [`orchestration-capabilities.md`](../admin/orchestration-capabilities.md)     | Table, category filter, lazy agents-using count, soft-delete dialog  |
| Capability form   | [`capability-form.md`](../admin/capability-form.md)                           | 4 tabs, visual builder ↔ JSON editor, execution, safety              |
| Providers list    | [`orchestration-providers.md`](../admin/orchestration-providers.md)           | Card grid, status dots, models dialog, env-var-only security model   |
| Provider form     | [`provider-form.md`](../admin/provider-form.md)                               | 4-flavor selector, reverse-mapping on edit, test-connection flow     |
| Costs & budget    | [`orchestration-costs.md`](../admin/orchestration-costs.md)                   | Summary cards, trend chart, savings panel, settings singleton        |
| Workflow builder  | [`workflow-builder.md`](../admin/workflow-builder.md)                         | React Flow canvas, pattern palette, step registry, layout round-trip |
| Learning UI       | [`orchestration-learn.md`](../admin/orchestration-learn.md)                   | Pattern explorer, advisor chatbot, quiz system, tabbed hub           |
| Knowledge Base UI | [`orchestration-knowledge-ui.md`](../admin/orchestration-knowledge-ui.md)     | Document management, drag-drop upload, search test                   |
| Chat Interface    | [`orchestration-chat-interface.md`](../admin/orchestration-chat-interface.md) | Reusable SSE chat component, embedded mode, event callbacks          |

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
