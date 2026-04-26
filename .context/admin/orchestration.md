# Agent Orchestration — Overview

The orchestration layer lets admins design, configure, execute, and monitor AI agent systems using 21 agentic design patterns. Admin management lives under `/admin/orchestration` in the UI and `/api/v1/admin/orchestration` in the API. Consumer-facing chat endpoints live under `/api/v1/chat` (see `.context/api/consumer-chat.md`).

## Architecture

```
lib/orchestration/          ← Platform-agnostic core (NEVER imports Next.js)
├── knowledge/              ← Document ingestion, chunking, embeddings, vector search
├── llm/                    ← Provider abstraction, model registry, cost tracking
├── capabilities/           ← Tool dispatcher, built-in capabilities, rate limiting
├── chat/                   ← Streaming chat handler, context builder, input guard
├── workflows/              ← DAG validator, step types, templates
├── engine/                 ← Runtime executor, 12 step executors, event stream
├── evaluations/            ← Evaluation session completion handler
└── seed/                   ← Dev seed data for providers / agents

app/api/v1/admin/orchestration/  ← Thin Next.js wrappers (~30 lines each)
components/admin/orchestration/  ← React UI components
```

**Hard rule:** `lib/orchestration/` is pure TypeScript — no Next.js imports. The API layer handles auth, request parsing, SSE formatting, and delegates to the core. Chat returns `AsyncIterable<ChatEvent>`, not HTTP responses.

## Quick Start — First Agent in 5 Minutes

### 1. Create a provider

Navigate to **Orchestration → Providers → New** or call:

```
POST /api/v1/admin/orchestration/providers
{
  "name": "Anthropic",
  "slug": "anthropic",
  "providerType": "anthropic",
  "apiKeyEnvVar": "ANTHROPIC_API_KEY",
  "isActive": true
}
```

Ensure `ANTHROPIC_API_KEY` is set in your environment. Click **Test Connection** to verify.

### 2. Create an agent

Navigate to **Orchestration → Agents → New** or call:

```
POST /api/v1/admin/orchestration/agents
{
  "name": "My Assistant",
  "slug": "my-assistant",
  "description": "A helpful assistant",
  "systemInstructions": "You are a helpful assistant. Be concise and accurate.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.7,
  "maxTokens": 4096
}
```

### 3. Test it

Open the agent's edit page → **Test Chat** tab, or stream directly:

```
POST /api/v1/admin/orchestration/chat/stream
Content-Type: application/json

{ "agentSlug": "my-assistant", "message": "Hello!" }
```

The response is an SSE stream of `ChatEvent` objects (`start`, `content`, `status`, `done`, `error`).

## Key Concepts

### Agents

An agent is a configured AI persona: system instructions, model selection, temperature, budget, and attached capabilities. Agents are stored in `AiAgent` and scoped by `userId`. Seeded agents (`pattern-advisor`, `quiz-master`) are marked `isSystem: true` and cannot be deleted or deactivated via the admin API.

- [Agent list & pages](./orchestration-agents.md)
- [Agent form (5-tab editor)](./agent-form.md)

### Capabilities

Capabilities are tools an agent can call — function definitions with execution handlers, rate limits, and approval gates. Five built-in capabilities ship out of the box (`search_knowledge_base`, `estimate_workflow_cost`, `get_pattern_detail`, `read_user_memory`, `write_user_memory`) and are marked `isSystem: true` — they cannot be deleted or deactivated via the admin API.

- [Capabilities list page](./orchestration-capabilities.md)
- [How to create capabilities](./orchestration-capabilities-guide.md)
- [Capability form (4-tab editor)](./capability-form.md)

### Workflows

Workflows are DAGs of steps (LLM calls, tool calls, routing, parallel branches, human approvals, etc.) executed by the `OrchestrationEngine`. 12 step types are supported, and 5 built-in templates provide starting points.

- [How to design workflows](./orchestration-workflows-guide.md)
- [Workflow builder UI](./workflow-builder.md)

### Patterns

21 agentic design patterns (routing, chaining, reflection, planning, multi-agent, RAG, etc.) inform how you compose agents and workflows. The Learning UI provides an interactive explorer, advisor chatbot, and quizzes.

- [Learning UI](./orchestration-learn.md)
- [Solution builder guide](./orchestration-solution-builder.md)

### Knowledge Base

Upload documents (`.md`, `.txt`, max 10 MB) → auto-chunked → embedded with pgvector → semantic search available to agents via the `search_knowledge_base` capability. Agent scoping uses `AiAgent.knowledgeCategories` (a string array) to filter which categories an agent can search — when non-empty, the agent's `search_knowledge_base` calls are restricted to matching chunks only.

- [Knowledge Base UI](./orchestration-knowledge-ui.md)
- [Knowledge service docs](../orchestration/knowledge.md)

## API Reference

65 route files under `/api/v1/admin/orchestration/`. All require `ADMIN` role. Mutating routes are rate-limited at 30 req/min per IP.

| Area          | Endpoints           | Purpose                                                                               |
| ------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Agents        | 13 routes           | CRUD, capabilities, instructions history, export/import, clone, bulk, compare, budget |
| Capabilities  | 5 routes            | CRUD, agents-using count, execution stats                                             |
| Providers     | 7 routes            | CRUD, test connection, test model, health, models                                     |
| Workflows     | 8 routes            | CRUD, validate, dry-run, execute, definition history/revert                           |
| Executions    | 5 routes            | List, read, approve, cancel, retry-step                                               |
| Chat          | 1 route             | Streaming chat turn (SSE)                                                             |
| Knowledge     | 10 routes           | Documents, search, seed, embed, graph, retry, patterns                                |
| Conversations | 4 routes            | List, read, delete, bulk clear                                                        |
| Costs         | 3 routes            | Breakdown, summary, alerts                                                            |
| Settings      | 1 route             | Global orchestration settings                                                         |
| Webhooks      | 2 routes            | CRUD for webhook subscriptions                                                        |
| Evaluations   | 4 routes            | CRUD, logs, AI completion                                                             |
| Experiments   | 3 files, 6 handlers | A/B testing — list, create, get, update, delete, run                                  |
| Observability | 1 route             | Dashboard stats                                                                       |
| Quiz          | 1 route             | Quiz scores                                                                           |

Full reference: [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md)

## Configuration

### Global Settings

`PATCH /api/v1/admin/orchestration/settings` — singleton row in `AiOrchestrationSettings`.

| Setting                    | Purpose                                                                   | Default                           |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| `defaultModels`            | Task → model mapping (`routing`, `chat`, `reasoning`, `embeddings`)       | Auto-computed from model registry |
| `globalMonthlyBudgetUsd`   | Hard cap across all agents                                                | `null` (unlimited)                |
| `searchConfig`             | Knowledge base search tuning (vector weight, keyword weight, etc.)        | `null` (built-in defaults)        |
| `inputGuardMode`           | Prompt injection detection mode: `log_only`, `warn_and_continue`, `block` | `log_only`                        |
| `defaultApprovalTimeoutMs` | Default timeout for human-approval steps (ms)                             | `null` (no timeout)               |
| `approvalDefaultAction`    | Action when approval times out: `deny` or `allow`                         | `deny`                            |

Settings are cached for 30s. The PATCH route invalidates the cache immediately.

### Per-Agent Settings

| Setting             | Purpose                                                 | Default            |
| ------------------- | ------------------------------------------------------- | ------------------ |
| `monthlyBudgetUsd`  | Per-agent monthly spend limit (80% warning, 100% block) | `null` (unlimited) |
| `fallbackProviders` | Ordered list of fallback provider slugs (max 5)         | `[]`               |
| `temperature`       | LLM temperature                                         | `0.7`              |
| `maxTokens`         | Max output tokens per turn                              | `4096`             |

### Resilience

- **Circuit breaker**: Auto-disables failing providers (5 failures / 60s → 30s cooldown)
- **Provider fallback**: Tries `[primary, ...fallbackProviders]` in order
- **Input guard**: Log-only prompt injection detection (never blocks)
- **Chat rate limit**: 20/min per user ID (on top of 30/min per IP admin limiter)

See [`.context/orchestration/resilience.md`](../orchestration/resilience.md) for details.

### Choosing an Embedding Provider

The knowledge base requires an **embedding provider** — a model that converts text into numerical vectors for similarity search. This is separate from the chat model.

**Anthropic (Claude) does not offer an embeddings API.** You need a dedicated embedding provider alongside your Anthropic chat provider.

| Provider                    | Model                  | Dims      | Schema-Compatible         | Cost/1M | Free Tier         |
| --------------------------- | ---------------------- | --------- | ------------------------- | ------- | ----------------- |
| **Voyage AI** (recommended) | voyage-3               | 1024→1536 | Yes                       | $0.06   | 200M tokens/month |
| OpenAI                      | text-embedding-3-small | 1536      | Yes                       | $0.02   | No                |
| OpenAI                      | text-embedding-3-large | 3072→1536 | Yes                       | $0.13   | No                |
| Ollama                      | nomic-embed-text       | 768       | No (schema change needed) | Free    | Yes (local)       |

"Schema-Compatible" means the model can produce 1536-dimension vectors matching the `AiKnowledgeChunk.embedding vector(1536)` column.

The static registry is at `lib/orchestration/llm/embedding-models.ts` and served via `GET /api/v1/admin/orchestration/embedding-models`.

## Related Documentation

| Topic                      | Path                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Service-level architecture | [`.context/orchestration/overview.md`](../orchestration/overview.md)                      |
| LLM providers              | [`.context/orchestration/llm-providers.md`](../orchestration/llm-providers.md)            |
| Streaming chat             | [`.context/orchestration/chat.md`](../orchestration/chat.md)                              |
| Engine & execution         | [`.context/orchestration/engine.md`](../orchestration/engine.md)                          |
| SSE helper                 | [`.context/api/sse.md`](../api/sse.md)                                                    |
| Solution builder           | [`.context/admin/orchestration-solution-builder.md`](./orchestration-solution-builder.md) |
| Setup wizard               | [`.context/admin/setup-wizard.md`](./setup-wizard.md)                                     |
| Observability              | [`.context/admin/orchestration-observability.md`](./orchestration-observability.md)       |
