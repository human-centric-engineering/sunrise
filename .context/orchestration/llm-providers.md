# LLM Provider Abstraction

Platform-agnostic interface for calling any LLM — cloud (Anthropic, OpenAI), OSS hosts (Together, Fireworks, Groq), or local servers (Ollama, LM Studio, vLLM) — through one API. Implemented in `lib/orchestration/llm/`.

## Quick Start

```typescript
import { providerManager, costTracker } from '@/lib/orchestration/llm';

// Resolve a provider by slug (loaded from AiProviderConfig).
const provider = await providerManager.getProvider('anthropic');

// Non-streaming chat.
const response = await provider.chat(
  [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hi in 3 words.' },
  ],
  { model: 'claude-sonnet-4-6' }
);

// Log the cost — safe even if the DB write fails (returns null).
await costTracker.logCost({
  agentId: 'agent-1',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  inputTokens: response.usage.inputTokens,
  outputTokens: response.usage.outputTokens,
  operation: 'chat',
});
```

## Public Surface

Everything is exported from `@/lib/orchestration/llm`:

| Export                                                                                  | Kind      | Purpose                                                                                             |
| --------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `LlmProvider`                                                                           | interface | Contract every provider implements                                                                  |
| `ProviderError`                                                                         | class     | Structured error with `code`, `status?`, `retriable`                                                |
| `AnthropicProvider`                                                                     | class     | Claude family via `@anthropic-ai/sdk`                                                               |
| `OpenAiCompatibleProvider`                                                              | class     | Any OpenAI-compatible host via `openai` SDK                                                         |
| `providerManager`                                                                       | namespace | `getProvider`, `registerProvider`, `listProviders`, `testProvider`, `clearCache`                    |
| `modelRegistry`                                                                         | namespace | `refreshFromOpenRouter`, `getModel`, `getModelsByTier`, `getModelsByProvider`, `getAvailableModels` |
| `costTracker`                                                                           | namespace | `calculateCost`, `logCost`, `getAgentCosts`, `checkBudget`                                          |
| `LlmMessage`, `LlmOptions`, `LlmResponse`, `StreamChunk`, `ModelInfo`, `ProviderConfig` | types     | Message/option/response dialect                                                                     |

Internal helpers (`fetchWithTimeout`, `withRetry`, the static fallback map) are **not** exported — they are implementation details.

## The `LlmProvider` Interface

```typescript
interface LlmProvider {
  readonly name: string;
  readonly isLocal: boolean;

  chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse>;
  chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk>;
  embed(text: string): Promise<number[]>;
  listModels(): Promise<ModelInfo[]>;
  testConnection(): Promise<{ ok: boolean; models: string[]; error?: string }>;
}
```

`LlmMessage` supports roles `system | user | assistant | tool` with content as `string | ContentPart[]` for multimodal input. Assistant messages can carry `toolCalls`. `StreamChunk` is a discriminated union: `{ type: 'text' }`, `{ type: 'tool_call' }`, or `{ type: 'done', usage, finishReason }`.

### `LlmOptions`

Key options passed to `chat()` and `chatStream()`:

| Field            | Type                | Description                                  |
| ---------------- | ------------------- | -------------------------------------------- |
| `model`          | `string`            | Model identifier (e.g., `claude-sonnet-4-6`) |
| `temperature`    | `number`            | Sampling temperature                         |
| `maxTokens`      | `number`            | Max output tokens                            |
| `tools`          | `LlmToolDef[]`      | Tool definitions for function calling        |
| `responseFormat` | `LlmResponseFormat` | Request structured output (see below)        |
| `signal`         | `AbortSignal`       | Cancellation signal                          |

### Structured Output / JSON Mode

The `responseFormat` option requests structured JSON responses from LLMs:

```typescript
type LlmResponseFormat =
  | { type: 'json_object' } // any valid JSON
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean }; // constrained
```

**Provider implementations:**

- **OpenAI-compatible**: passes `response_format` directly to the API (native support)
- **Anthropic**: uses a tool-based extraction pattern — defines a single tool with the schema, forces tool use, and extracts the result from the tool call arguments

**Usage in agents:** Set `responseFormat` on `AiAgent` config for agents that always return structured data. In workflows, the `llm_call` step config supports `responseFormat` for structured extraction steps.

**Validation:** When `json_schema` is used, the response is parsed and validated against the schema before returning. Invalid responses emit an `error` event.

## Concrete Providers

### AnthropicProvider

Backed by `@anthropic-ai/sdk`. Splits leading system messages into Anthropic's `system` field, converts `tool` role into `user` messages with `tool_result` blocks, and aggregates streamed `input_json_delta` fragments into a single `tool_call` chunk.

**`embed()` throws** — Anthropic has no first-party embeddings API. Use an OpenAI-compatible provider for embeddings.

### OpenAiCompatibleProvider

A single class covering every OpenAI-compatible chat completions host:

- OpenAI (`https://api.openai.com/v1`)
- Ollama (`http://localhost:11434/v1`)
- LM Studio (`http://localhost:1234/v1`)
- vLLM (`http://localhost:8000/v1`)
- Together (`https://api.together.xyz/v1`)
- Fireworks (`https://api.fireworks.ai/inference/v1`)
- Groq (`https://api.groq.com/openai/v1`)

Local servers get a `'not-needed'` sentinel API key (the OpenAI SDK rejects empty strings, local hosts ignore the `Authorization` header) and a shorter 10s default timeout.

**Default embedding models** are picked automatically: `text-embedding-3-small` for cloud, `nomic-embed-text` for local. Override via `embeddingModel` option.

## Provider Manager (DB-Backed Factory)

`providerManager.getProvider(slug)` is the single entry point. It:

1. Checks the in-memory cache. Each entry stores `{ provider, cachedAt }` and is evicted after **5 minutes** (`CACHE_TTL_MS`). This ensures config changes in the database (e.g. switching API keys, toggling `isActive`) take effect without a restart.
2. Loads the matching `AiProviderConfig` row (`findFirst` against slug or name).
3. Throws `ProviderError` with `code: 'provider_not_found'` / `'provider_disabled'` if missing or inactive.
4. Resolves the API key from `process.env[config.apiKeyEnvVar]` (or skips for local providers).
5. Instantiates `AnthropicProvider` or `OpenAiCompatibleProvider` based on `providerType`.
6. Caches with timestamp and returns.

**Do:**

```typescript
const provider = await providerManager.getProvider('ollama');
```

**Don't:**

```typescript
// Never construct SDK clients directly.
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

For tests or scripts that bypass the database, use `providerManager.registerProvider(config)` which accepts a plain `ProviderConfig` object.

`clearCache()` evicts one or all cached instances — call it for immediate invalidation (e.g. after an admin updates a provider config). Without manual invalidation, stale entries expire naturally after 5 minutes.

## Model Registry

Dynamic catalogue of models with pricing, context windows, and capabilities. Three layers:

1. **Static fallback map** — always available. Covers Claude Opus/Sonnet/Haiku 4.x, GPT-4o family, Llama 3.3 70B on Together/Fireworks/Groq, and a `local:generic` placeholder.
2. **OpenRouter refresh** — `modelRegistry.refreshFromOpenRouter()` pulls 300+ live entries from `https://openrouter.ai/api/v1/models`, cached 24h. No API key required. Concurrent callers share one in-flight fetch.
3. **Per-provider discovery** — `modelRegistry.refreshFromProvider(provider)` marks entries as `available: true` when a configured provider lists them (e.g. Ollama returns only locally-pulled models).

```typescript
await modelRegistry.refreshFromOpenRouter();

modelRegistry.getModel('claude-opus-4-6');
modelRegistry.getModelsByTier('frontier');
modelRegistry.getModelsByProvider('anthropic');
modelRegistry.getAvailableModels('ollama');
```

Tiers are classified by input cost: `local` (≤0), `budget` (≤\$0.50/M), `mid` (≤\$5/M), `frontier` (>\$5/M).

If OpenRouter is unreachable, accessors continue serving the fallback map silently — a warning is logged.

## Cost Tracking

Every provider call should be followed by `costTracker.logCost(...)`. Local models cost \$0 but their token counts are still recorded for benchmarking (`isLocal: true`).

| Function                                | Purpose                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculateCost(modelId, inTok, outTok)` | Pure math; returns `{ inputCostUsd, outputCostUsd, totalCostUsd, isLocal }`. Unknown models log a warning and resolve to \$0.                                     |
| `logCost(params)`                       | Writes an `AiCostLog` row. **Forgiving**: returns `null` on DB failure so chat responses are never lost to accounting errors.                                     |
| `getAgentCosts(agentId, dateRange?)`    | Returns a `CostSummary` (matches `types/orchestration.ts`) with totals and breakdowns by provider / model / operation.                                            |
| `checkBudget(agentId)`                  | Sums the current UTC calendar month and compares to `AiAgent.monthlyBudgetUsd`. Returns `{ withinBudget, spent, limit, remaining }`. Null budget means unlimited. |

```typescript
// Before a chat turn, make sure the agent can still spend.
const budget = await costTracker.checkBudget('agent-1');
if (!budget.withinBudget) {
  throw new Error(`Agent over monthly budget ($${budget.spent} / $${budget.limit})`);
}
```

## Error Handling & Resilience

Uniform across every provider via `withRetry` + `fetchWithTimeout` (internal helpers):

| Concern         | Cloud provider                               | Local provider              |
| --------------- | -------------------------------------------- | --------------------------- |
| Default timeout | 30s (overridable via `timeoutMs`)            | 10s (overridable)           |
| Retry 429       | Yes (exp backoff)                            | Yes                         |
| Retry 5xx       | Yes (exp backoff)                            | **No** — restart won't help |
| Max retries     | 3 (overridable via `maxRetries`)             | 3 (overridable)             |
| Backoff         | 500ms → 1s → 2s + ±25% jitter, capped at 10s | same                        |

`ProviderError` carries `code` (stable short string), `status?` (HTTP code when known), `retriable` (consulted by `withRetry`), and `cause?`. SDK errors are narrowed via `toProviderError()` which extracts the `status` field that both `@anthropic-ai/sdk` and `openai` expose.

Every long-running call accepts an `AbortSignal` via `LlmOptions.signal`. Aborts surface as non-retriable `ProviderError('aborted')`.

## Configuration

`AiProviderConfig` rows (see `prisma/schema.prisma`) drive the provider manager. Fields used here:

| Field          | Purpose                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `slug`         | Primary lookup key for `getProvider`                                                                                             |
| `name`         | Fallback lookup key; human label                                                                                                 |
| `providerType` | `'anthropic' \| 'openai-compatible'` — dispatch key                                                                              |
| `baseUrl`      | Required for `openai-compatible`                                                                                                 |
| `apiKeyEnvVar` | Name of the `process.env` var holding the key                                                                                    |
| `isLocal`      | Shorter timeouts, no 5xx retries, allows empty API key                                                                           |
| `isActive`     | `false` → `getProvider` throws `provider_disabled`                                                                               |
| `timeoutMs`    | Per-provider timeout override (1,000–300,000 ms). Resolution: `timeoutMs` → `LOCAL_TIMEOUT_MS` (if local) → `DEFAULT_TIMEOUT_MS` |
| `maxRetries`   | Per-provider retry override (0–10). Passed to the SDK constructor                                                                |

## Anti-Patterns

**Don't** construct providers directly in application code — always go through `providerManager`:

```typescript
// Bad — bypasses cache, config, and env-var resolution
const p = new AnthropicProvider({ name: 'x', type: 'anthropic', apiKey: 'sk-...', isLocal: false });
```

**Don't** import Next.js modules from anywhere under `lib/orchestration/llm/`:

```typescript
// Will break the platform-agnostic contract
import { cache } from 'react';
import { headers } from 'next/headers';
```

**Don't** swallow `ProviderError.retriable` — use the built-in retry via `withRetry` (already wired into `chat`/`chatStream`/`embed`) instead of rolling your own loop.

**Don't** skip cost logging for local models — token counts are still valuable for benchmarking and showing up in `getAgentCosts` breakdowns.

## Task-type defaults (Phase 4 Session 4.4)

`getDefaultModelForTask(task: TaskType)` in `lib/orchestration/llm/model-registry.ts` resolves the default model for a `TaskType` (`routing | chat | reasoning | embeddings`) by reading the `AiOrchestrationSettings` singleton (`slug: 'global'`). A 30-second in-memory TTL cache sits in front of the Prisma read. The settings PATCH route calls `invalidateSettingsCache()` so admin edits take effect on the next turn without waiting for the cache to expire.

Missing keys fall back to `computeDefaultModelMap()`, which picks sensible defaults from whatever the registry currently knows about (cheapest budget tier for routing/chat, frontier for reasoning). On a fresh deployment the first `GET /settings` lazily upserts the row with these defaults. See [`admin-api.md` § Orchestration settings](./admin-api.md#orchestration-settings-singleton) and [`../admin/orchestration-costs.md`](../admin/orchestration-costs.md) for the HTTP surface.

## Admin surface (Phase 3.2)

Admins manage `AiProviderConfig` rows through `/api/v1/admin/orchestration/providers` — full CRUD plus a live `POST /:id/test` (wraps `providerManager.testProvider`) and a per-provider `GET /:id/models` (wraps `provider.listModels()`). Every response hydrates rows with `apiKeyPresent: boolean`, derived via `isApiKeyEnvVarSet()` — the raw `process.env[apiKeyEnvVar]` value is **never** returned from a route, logged, or written to the response envelope. The aggregated `GET /models` endpoint returns the merged model registry and accepts `?refresh=true` to force an OpenRouter refresh. Full route reference lives in [`admin-api.md`](./admin-api.md#providers).

**SSRF guard on `baseUrl`.** `providerConfigSchema` / `updateProviderConfigSchema` both run `checkSafeProviderUrl()` (`lib/security/safe-url.ts`) via `.superRefine()`. As a defense-in-depth layer, `buildProviderFromConfig()` re-runs the same validator before constructing `OpenAiCompatibleProvider`, throwing `ProviderError({ code: 'unsafe_base_url' })` on reject — this catches PATCH merges that flip `isLocal` without re-sending `baseUrl`, plus any direct DB writes that bypass Zod. Blocked: non-`http(s)` schemes, cloud metadata hosts, RFC1918 / CGNAT / link-local / IPv6 unique-local, and loopback unless the row is marked `isLocal: true`. The `/test` and `/models` routes also strip raw SDK error messages before responding so the fetch error can't be used as a blind-SSRF oracle — the real error is logged server-side only. See [`admin-api.md` § SSRF safety](./admin-api.md#ssrf-safety-hard-guarantee) for the full contract.

## Testing

Unit tests live in `tests/unit/lib/orchestration/llm/` and mock `@anthropic-ai/sdk`, `openai`, and `@/lib/db/client`. Notable patterns:

- SDK mocks must be declared before the dynamic `await import(...)` of the module under test.
- `modelRegistry.__resetForTests()` clears cached state between cases.
- Browser-like vitest environment: both SDKs refuse to instantiate without `dangerouslyAllowBrowser: true`, so mock them in any test that imports `AnthropicProvider` / `OpenAiCompatibleProvider` (even indirectly via `provider-manager`).

Run just this module:

```bash
npx vitest run tests/unit/lib/orchestration/llm
```

## Related Documentation

- [Orchestration Overview](./overview.md) — domain entry point
- `.claude/docs/agent-orchestration.md` — architectural brief
- `types/orchestration.ts` — shared types (`CostSummary`, `CostOperation`, `ChatEvent`, ...)
- `prisma/schema.prisma` — `AiProviderConfig`, `AiAgent`, `AiCostLog`
