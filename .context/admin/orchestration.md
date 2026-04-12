# Agent Orchestration — Overview

The orchestration layer lets admins design, configure, execute, and monitor AI agent systems using 21 agentic design patterns. Everything lives under `/admin/orchestration` in the UI and `/api/v1/admin/orchestration` in the API.

## Architecture

```
lib/orchestration/          ← Platform-agnostic core (NEVER imports Next.js)
├── knowledge/              ← Document ingestion, chunking, embeddings, vector search
├── llm/                    ← Provider abstraction, model registry, cost tracking
├── capabilities/           ← Tool dispatcher, built-in capabilities, rate limiting
├── chat/                   ← Streaming chat handler, context builder, input guard
├── workflows/              ← DAG validator, step types, templates
├── engine/                 ← Runtime executor, 9 step executors, event stream
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

An agent is a configured AI persona: system instructions, model selection, temperature, budget, and attached capabilities. Agents are stored in `AiAgent` and scoped by `userId`.

- [Agent list & pages](./.context/admin/orchestration-agents.md)
- [Agent form (5-tab editor)](./.context/admin/agent-form.md)

### Capabilities

Capabilities are tools an agent can call — function definitions with execution handlers, rate limits, and approval gates. Three built-in capabilities ship out of the box (`search_knowledge_base`, `estimate_workflow_cost`, `get_pattern_detail`).

- [Capabilities list page](./.context/admin/orchestration-capabilities.md)
- [How to create capabilities](./.context/admin/orchestration-capabilities-guide.md)
- [Capability form (4-tab editor)](./.context/admin/capability-form.md)

### Workflows

Workflows are DAGs of steps (LLM calls, tool calls, routing, parallel branches, human approvals, etc.) executed by the `OrchestrationEngine`. 9 step types are supported, and 5 built-in templates provide starting points.

- [How to design workflows](./.context/admin/orchestration-workflows-guide.md)
- [Workflow builder UI](./.context/admin/workflow-builder.md)

### Patterns

21 agentic design patterns (routing, chaining, reflection, planning, multi-agent, RAG, etc.) inform how you compose agents and workflows. The Learning UI provides an interactive explorer, advisor chatbot, and quizzes.

- [Learning UI](./.context/admin/orchestration-learn.md)
- [Solution builder guide](./.context/admin/orchestration-solution-builder.md)

### Knowledge Base

Upload documents (`.md`, `.txt`, max 10 MB) → auto-chunked → embedded with pgvector → semantic search available to agents via the `search_knowledge_base` capability.

- [Knowledge Base UI](./.context/admin/orchestration-knowledge-ui.md)
- [Knowledge service docs](./.context/orchestration/knowledge.md)

## API Reference

41 endpoints under `/api/v1/admin/orchestration/`. All require `ADMIN` role. Mutating routes are rate-limited at 30 req/min per IP.

| Area          | Endpoints | Purpose                                                         |
| ------------- | --------- | --------------------------------------------------------------- |
| Agents        | 10 routes | CRUD, capabilities, instructions history, export/import, budget |
| Capabilities  | 4 routes  | CRUD, agents-using count                                        |
| Providers     | 5 routes  | CRUD, test connection, models                                   |
| Workflows     | 5 routes  | CRUD, validate, execute                                         |
| Executions    | 2 routes  | Read status, approve paused                                     |
| Chat          | 1 route   | Streaming chat turn (SSE)                                       |
| Knowledge     | 6 routes  | Documents, search, seed                                         |
| Conversations | 4 routes  | List, read, delete, bulk clear                                  |
| Costs         | 4 routes  | Breakdown, summary, alerts, settings                            |

Full reference: [`.context/api/orchestration-endpoints.md`](./.context/api/orchestration-endpoints.md)

## Configuration

### Global Settings

`PATCH /api/v1/admin/orchestration/settings` — singleton row in `AiOrchestrationSettings`.

| Setting                  | Purpose                                                             | Default                           |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| `defaultModels`          | Task → model mapping (`routing`, `chat`, `reasoning`, `embeddings`) | Auto-computed from model registry |
| `globalMonthlyBudgetUsd` | Hard cap across all agents                                          | `null` (unlimited)                |

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

See [`.context/orchestration/resilience.md`](./.context/orchestration/resilience.md) for details.

## Related Documentation

| Topic                      | Path                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Service-level architecture | [`.context/orchestration/overview.md`](./.context/orchestration/overview.md)                             |
| LLM providers              | [`.context/orchestration/llm-providers.md`](./.context/orchestration/llm-providers.md)                   |
| Streaming chat             | [`.context/orchestration/chat.md`](./.context/orchestration/chat.md)                                     |
| Engine & execution         | [`.context/orchestration/engine.md`](./.context/orchestration/engine.md)                                 |
| SSE helper                 | [`.context/api/sse.md`](./.context/api/sse.md)                                                           |
| Solution builder           | [`.context/admin/orchestration-solution-builder.md`](./.context/admin/orchestration-solution-builder.md) |
| Setup wizard               | [`.context/admin/setup-wizard.md`](./.context/admin/setup-wizard.md)                                     |
| Observability              | [`.context/admin/orchestration-observability.md`](./.context/admin/orchestration-observability.md)       |
