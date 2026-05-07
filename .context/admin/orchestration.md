# Agent Orchestration — Admin Landing

Admin-facing entry point for the orchestration layer. The admin dashboard at `/admin/orchestration` lets you design, configure, run, and monitor AI agents without touching code. This page orients you to the admin surface — for deeper detail jump into the linked sub-pages.

> **For full system inventory and capability matrix** (every step type, capability, route group, schema model), see [`.context/orchestration/meta/functional-specification.md`](../orchestration/meta/functional-specification.md). For the architectural rules that the engineering team follows, see [`.claude/docs/agent-orchestration.md`](../../.claude/docs/agent-orchestration.md).

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

If you'd prefer guided onboarding, run the [Setup Wizard](./setup-wizard.md) — five steps from empty install to working chat.

## Admin Surface — Where to Look

The dashboard groups concerns into sidebar sections. Each row below points to the sub-page doc that explains the screen.

### Build

| Page                             | Doc                                                                                                                                                                              | What you do here                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Agents (list / form)             | [`orchestration-agents.md`](./orchestration-agents.md), [`agent-form.md`](./agent-form.md)                                                                                       | CRUD for agents, capability binding, instructions, embed tab |
| Capabilities (list / form)       | [`orchestration-capabilities.md`](./orchestration-capabilities.md), [`capability-form.md`](./capability-form.md)                                                                 | Tool definitions, JSON Schema editor, rate limits, approval  |
| Workflows (list / builder)       | [`workflow-builder.md`](./workflow-builder.md)                                                                                                                                   | Visual DAG editor, palette, dry-run, publish/draft/rollback  |
| Knowledge base                   | [`orchestration-knowledge-ui.md`](./orchestration-knowledge-ui.md)                                                                                                               | Document upload, chunking, search test                       |
| Providers (list / form / models) | [`orchestration-providers.md`](./orchestration-providers.md), [`provider-form.md`](./provider-form.md), [`orchestration-provider-models.md`](./orchestration-provider-models.md) | LLM credentials, model registry, connection test             |
| Setup Wizard                     | [`setup-wizard.md`](./setup-wizard.md)                                                                                                                                           | Five-step guided initial configuration                       |

### Operate

| Page                       | Doc                                                                  | What you do here                                        |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Conversations              | [`orchestration-conversations.md`](./orchestration-conversations.md) | Browse chat history, view traces, tag, export           |
| Executions (list / detail) | [`orchestration-observability.md`](./orchestration-observability.md) | Workflow run history, trace viewer, latency attribution |
| Approvals                  | [`orchestration-approvals.md`](./orchestration-approvals.md)         | Pending human-approval queue                            |
| Costs & budget             | [`orchestration-costs.md`](./orchestration-costs.md)                 | Summary, trend, savings, settings singleton             |
| Observability              | [`orchestration-observability.md`](./orchestration-observability.md) | Dashboard metrics, latency, error rates                 |
| Audit log                  | [`orchestration-audit-log.md`](./orchestration-audit-log.md)         | Immutable config change log                             |

### Improve

| Page                   | Doc                                                                        | What you do here                                           |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Evaluations            | [`orchestration-evaluations.md`](./orchestration-evaluations.md)           | Quality assessment runner, scoring, annotations            |
| Experiments            | (admin form)                                                               | A/B variants for agents (model, temperature, instructions) |
| Analytics              | [`orchestration-analytics.md`](./orchestration-analytics.md)               | Usage, popular topics, unanswered questions, gaps          |
| Learning UI            | [`orchestration-learn.md`](./orchestration-learn.md)                       | Pattern explorer, advisor chatbot, quizzes                 |
| Solution builder guide | [`orchestration-solution-builder.md`](./orchestration-solution-builder.md) | Problem-to-solution worked examples                        |

### Connect

| Page             | Doc                                                                                                                          | What you do here                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| MCP server       | [`../orchestration/mcp.md`](../orchestration/mcp.md)                                                                         | Tools, resources, sessions, audit, API keys         |
| Embed widget     | [`../orchestration/embed.md`](../orchestration/embed.md)                                                                     | Token auth, CORS, widget.js loader, Shadow DOM chat |
| Hooks & webhooks | [`../orchestration/hooks.md`](../orchestration/hooks.md), [`../orchestration/scheduling.md`](../orchestration/scheduling.md) | Event hooks, outbound webhooks, cron schedules      |
| Backup & restore | [`../orchestration/backup.md`](../orchestration/backup.md)                                                                   | Export/import config bundle                         |

For the admin HTTP API used by these pages, see [`../api/orchestration-endpoints.md`](../api/orchestration-endpoints.md). All admin routes require `ADMIN` role; mutating routes are rate-limited per IP.

## Configuration

### Global Settings

`PATCH /api/v1/admin/orchestration/settings` — singleton row in `AiOrchestrationSettings`.

| Setting                    | Purpose                                                                   | Default                           |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| `defaultModels`            | Task → model mapping (`routing`, `chat`, `reasoning`, `embeddings`)       | Auto-computed from model registry |
| `globalMonthlyBudgetUsd`   | Hard cap across all agents                                                | `null` (unlimited)                |
| `searchConfig`             | Knowledge base search tuning (vector weight, BM25 weight, hybrid on/off)  | `null` (built-in defaults)        |
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

For the full per-agent configuration surface, see [`agent-form.md`](./agent-form.md).

### Resilience defaults

- **Circuit breaker**: Auto-disables failing providers (5 failures / 60s → 30s cooldown)
- **Provider fallback**: Tries `[primary, ...fallbackProviders]` in order
- **Input guard**: Log-only prompt injection detection by default
- **Chat rate limit**: 20/min per user ID (on top of 30/min per IP admin limiter)

Detail in [`../orchestration/resilience.md`](../orchestration/resilience.md).

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

## Related

- **What the system does, end to end** → [`../orchestration/meta/functional-specification.md`](../orchestration/meta/functional-specification.md)
- **Why architectural choices were made** → [`../orchestration/meta/architectural-decisions.md`](../orchestration/meta/architectural-decisions.md)
- **Engineering directory map** → [`../orchestration/overview.md`](../orchestration/overview.md)
- **Architectural rules for code authors** → [`../../.claude/docs/agent-orchestration.md`](../../.claude/docs/agent-orchestration.md)
- **Hosting in production** → [`../orchestration/meta/hosting-requirements.md`](../orchestration/meta/hosting-requirements.md)
