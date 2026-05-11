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

  // Optional — providers that don't expose a transcription API simply omit this.
  // Routing (`getAudioProvider`) filters by `AiProviderModel.capabilities` so the
  // method is only ever called on providers that implement it.
  transcribe?(
    audio: Blob | Buffer | ArrayBuffer | Uint8Array,
    options: TranscribeOptions
  ): Promise<TranscribeResponse>;
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

### Audio transcription (`transcribe`)

`OpenAiCompatibleProvider` implements `transcribe()` via the OpenAI SDK's `audio.transcriptions.create({ file, model, response_format: 'verbose_json' })`. The verbose response carries duration (seconds, converted to `durationMs`) and the auto-detected language. Works for OpenAI proper and any compatible host that exposes `/v1/audio/transcriptions` (Groq Whisper). Hosts that don't expose this endpoint (Ollama, vLLM, LM Studio in their default configs) won't be picked by `getAudioProvider()` because no `'audio'`-capability `AiProviderModel` row will exist for them — but if one is configured anyway the SDK call returns 404 and the route surfaces `TRANSCRIPTION_FAILED`.

`AnthropicProvider` does not implement `transcribe()` — Anthropic has no first-party audio API.

**`getAudioProvider()` (in `provider-manager.ts`)** is the entry point used by both the admin and embed transcribe routes. Selection runs in two stages:

1. **Operator-pinned default.** Reads `AiOrchestrationSettings.defaultModels.audio` first. When set, the matching `(providerSlug, modelId)` matrix row is attempted ahead of the registry-ordered loop — voice input uses the model the operator chose in settings, not whichever matrix row happened to seed first. Each resolution logs `source: 'operator_default'` so the path is visible in logs.
2. **Matrix fallback.** Walks every other active `AiProviderModel` row whose `capabilities` array contains `'audio'`, ordered by `isDefault desc, createdAt asc`. Logs `source: 'matrix_fallback'`. The pinned-then-fallback design keeps voice working even when the operator's pin is temporarily unreachable: if the pinned row's breaker is open, its provider lacks `transcribe()`, or `getProvider()` throws, the resolver falls through to the next-best matrix row rather than returning `null`. Same fallback applies when the pinned `modelId` no longer exists in the active audio rows (e.g. the row was deactivated after the setting was saved).

Returns `null` only when both stages exhaust without finding a usable provider. Callers translate that to a `NO_AUDIO_PROVIDER` user-facing error (rather than a thrown exception, because "voice not configured" is an expected deployment state).

The `'audio'` capability value is inferred for `whisper-*` / `tts-*` (OpenAI, Azure) and `*whisper*` / `*distil-whisper*` (Groq, Together, Fireworks, openai-compatible) model ids by `lib/orchestration/llm/capability-inference.ts`. Inference is limited to providers whose backing class (`OpenAiCompatibleProvider`) implements `transcribe()` — bespoke audio providers like Deepgram or AssemblyAI need a dedicated `transcribe()` implementation before being added to the inference list, otherwise the runtime would silently skip those rows.

The settings PATCH route validates `defaultModels.audio` against the matrix (the chosen `modelId` must exist in an active `AiProviderModel` row whose `capabilities` contains `'audio'`) — distinct from the chat/reasoning slots which validate against the hardcoded chat-model registry. Audio support is matrix-driven, so the matrix is the authoritative source.

Operators can now add audio rows directly from the admin UI (`/admin/orchestration/provider-models/new` and the Discover Models dialog both surface an `Audio` capability checkbox). Pre-Phase-1 the matrix's Zod enum (`MODEL_CAPABILITIES` in `types/orchestration.ts`) rejected anything outside `['chat', 'embedding']`, so adding a Whisper row required hand-editing the DB. The 009-provider-models seed ships a default Whisper row, so a fresh checkout has voice input working as soon as an OpenAI key is set.

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

## Tokenisation

LLMs split text into tokens, not characters. The mapping is dense for English prose (~4 chars/token), much denser for code, and much sparser for non-English / CJK text (~1–2 chars/token). Each provider family ships its own tokeniser; the same string yields different counts on OpenAI vs. Anthropic vs. Google.

Sunrise resolves the right tokeniser per model **before** an LLM call, so context-window truncation drops the right amount of history (no silent provider-side rejections, no over-aggressive trimming). Cost accounting is unaffected — providers report exact `usage.inputTokens` after the call.

### Public surface

```typescript
import { tokeniserForModel, type Tokeniser } from '@/lib/orchestration/llm';

const t = tokeniserForModel('claude-haiku-4-5');
t.id; // 'anthropic-approx'
t.exact; // false  — calibrated approximator
t.count('Hello world'); // synchronous, no network
```

### Strategy per family

| Family                                           | Strategy                                  | Source             |
| ------------------------------------------------ | ----------------------------------------- | ------------------ |
| OpenAI gpt-4o, o1, o3, o4, gpt-4.1               | Exact via `o200k_base`                    | `gpt-tokenizer`    |
| OpenAI gpt-4 / gpt-3.5 / davinci (legacy)        | Exact via `cl100k_base`                   | `gpt-tokenizer`    |
| Anthropic (Claude)                               | `o200k_base` × **1.10** calibration       | local approximator |
| Google Gemini                                    | `o200k_base` × **1.10** calibration       | local approximator |
| Llama-family (Together, Fireworks, Groq, Ollama) | `o200k_base` × **1.05** calibration       | local approximator |
| Unknown model id                                 | Llama-family approximator (defensive)     | local approximator |
| Missing / null modelId                           | `chars / 3.5` heuristic (legacy fallback) | none               |

The multipliers are **conservative on purpose** — over-counting drops history slightly early; under-counting overflows the context window. Anthropic publishes that Claude tokenisers run roughly 10% denser than OpenAI's modern tokeniser for English; the multiplier captures that without a network call.

### Routing layers

`tokeniserForModel(modelId)` resolves the right tokeniser through three layers, in priority order:

1. **Registry by `provider`** — if `getModel(modelId)` returns a model whose `provider` field matches a known family (`openai`, `anthropic`, `google` / `gemini`, `together` / `fireworks` / `groq` / `ollama` / `lmstudio` / `vllm` / `meta-llama`), route by that. This is the default path in production.
2. **Model-id pattern** — if the registry is missing the entry (brand-new id, refresh in flight) or the provider field is a custom human-readable label (e.g. a provider config named "OpenAI Production"), infer the family from the id itself: `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI, `gemini-*` → Gemini, `llama` / `mistral` / `qwen` substring → Llama-family. Defensive net.
3. **Llama-family approximator** — final default for any modern BPE model not caught by the first two layers; under-counts by at most a few percent versus the truth, which is far better than the chars-only heuristic.

The heuristic tokeniser is only returned when the caller passes a missing / empty model id — production callers should always supply one.

### Why local-only

Anthropic exposes a network `count_tokens` endpoint and Google's SDK has `countTokens()`. Both add 200–500 ms per chat turn — unacceptable on a streaming hot path. Sunrise's tokeniser layer is **synchronous and local** by contract; if a future feature wants exact pre-flight counts (e.g. budget enforcement before a long generation), it can opt in to the network path independently.

### Where it's used

| Caller                                        | What it does                                           |
| --------------------------------------------- | ------------------------------------------------------ |
| `lib/orchestration/chat/token-estimator.ts`   | Estimates token counts for individual strings / arrays |
| `lib/orchestration/chat/message-builder.ts`   | Drops oldest history rows that don't fit before send   |
| `lib/orchestration/chat/streaming-handler.ts` | Threads the agent's `model` in as `modelId`            |

The chunker (`lib/orchestration/knowledge/chunker.ts`) keeps a separate, simpler `chars / 4` heuristic — embedding-time chunk sizing tolerates more slack and the embedding tokenisers differ from chat tokenisers.

### Re-calibrating the multipliers

Multipliers ship as constants in `lib/orchestration/llm/tokeniser.ts`. To re-measure:

1. Pick a corpus of representative strings (English prose, code, non-English, CJK).
2. For each provider, send each string with `max_tokens: 1` and read back `usage.inputTokens`.
3. Compute the ratio against `encodeO200k(text).length` from `gpt-tokenizer`.
4. Round up and bump the constant. Treat the change as a forward-only adjustment — old conversations have already been accounted for via the `usage.inputTokens` provider report.

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

`getDefaultModelForTask(task: TaskType)` in `lib/orchestration/llm/model-registry.ts` resolves the default model for a `TaskType` (`routing | chat | reasoning | embeddings | audio`) by reading the `AiOrchestrationSettings` singleton (`slug: 'global'`). A 30-second in-memory TTL cache sits in front of the Prisma read. The settings PATCH route calls `invalidateSettingsCache()` so admin edits take effect on the next turn without waiting for the cache to expire.

Missing keys fall back to `computeDefaultModelMap()`, which picks sensible defaults from whatever the chat-model registry currently knows about (cheapest budget tier for routing/chat, frontier for reasoning). The `embeddings` and `audio` slots are deliberately left empty — they're matrix-driven (rows declare `capabilities: ['embedding']` or `['audio']`) rather than registry-driven, so any guess here would mislead operators. The admin defaults form fetches options for both slots directly from the matrix: embeddings via the embedding-model registry, audio via `GET /provider-models?capability=audio&isActive=true`. Both render a "no options" hint that nudges the operator to seed the right matrix row instead of suggesting a value. On a fresh deployment the first `GET /settings` lazily upserts the row with these defaults. See [`admin-api.md` § Orchestration settings](./admin-api.md#orchestration-settings-singleton) and [`../admin/orchestration-costs.md`](../admin/orchestration-costs.md) for the HTTP surface.

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

## Provider Models & Decision Heuristic

Beyond runtime provider config, the platform maintains a **Provider Selection Matrix** — a DB-managed registry of individual model entries (`AiProviderModel`) with tier classification, capability ratings, and chat/embedding distinction.

The decision heuristic in `lib/orchestration/llm/provider-selector.ts` scores models against a task intent and returns ranked recommendations:

```typescript
import { recommendModels } from '@/lib/orchestration/llm';

const recs = await recommendModels('thinking', { limit: 3 });
// → [{ slug: 'anthropic-claude-opus-4', providerSlug: 'anthropic', score: 90, reason: '...' }, ...]

// Embedding-specific recommendations
const embedRecs = await recommendModels('embedding', { limit: 3 });
```

Models are cached with a 60-second TTL (same pattern as `settings-resolver.ts`). Cache is invalidated by the CRUD API routes.

See [Provider Selection Matrix](./provider-selection-matrix.md) for the full 6-tier classification, scoring algorithm, and API reference.

## Related Documentation

- [Orchestration Overview](./overview.md) — domain entry point
- [Provider Selection Matrix](./provider-selection-matrix.md) — tier classification, decision heuristic, model CRUD
- `.claude/docs/agent-orchestration.md` — architectural brief
- `types/orchestration.ts` — shared types (`CostSummary`, `CostOperation`, `ChatEvent`, ...)
- `prisma/schema.prisma` — `AiProviderConfig`, `AiAgent`, `AiCostLog`, `AiProviderModel`
