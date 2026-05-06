# Capability Dispatcher

Platform-agnostic runtime that lets an agent call tools — search the knowledge base, look up a pattern, estimate a workflow's cost, and any future registered capability. Implemented in `lib/orchestration/capabilities/`.

The dispatcher is the layer between the LLM's `tool_use` message and the concrete service call. Without it, agents can only produce text. With it, admins can toggle activation, rate limits, and approval gates on `AiCapability` rows without a redeploy.

## Quick Start

```typescript
import {
  capabilityDispatcher,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities';

// Wire the built-in handlers into the dispatcher. Idempotent.
registerBuiltInCapabilities();

// Dispatch a tool call.
const result = await capabilityDispatcher.dispatch(
  'estimate_workflow_cost',
  { description: 'Summarise 10 docs', estimated_steps: 10, model_tier: 'mid' },
  { userId: 'user-1', agentId: 'agent-1' }
);

if (result.success) {
  logger.info('capability result', { data: result.data });
} else {
  logger.error('capability error', {
    code: result.error?.code,
    message: result.error?.message,
  });
}
```

Every outcome is a `CapabilityResult` — the dispatcher never throws at its boundary.

## Public Surface

Everything is exported from `@/lib/orchestration/capabilities`:

| Export                         | Kind      | Purpose                                                                                  |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------------- |
| `capabilityDispatcher`         | singleton | `register`, `dispatch`, `loadFromDatabase`, `getRegistryEntry`, `has`, `clearCache`      |
| `registerBuiltInCapabilities`  | function  | Idempotent wiring of the twelve built-in handlers                                        |
| `getCapabilityDefinitions`     | function  | Returns the function definitions an LLM should see for a given agent (strict allow-list) |
| `BaseCapability`               | class     | Abstract parent with `validate`, `success`, `error` helpers                              |
| `CapabilityValidationError`    | class     | Thrown by `validate` on bad args; dispatcher maps to `invalid_args`                      |
| `CapabilityResult`             | type      | `{ success, data?, error?, skipFollowup? }`                                              |
| `CapabilityContext`            | type      | `{ userId, agentId, conversationId?, entityContext? }`                                   |
| `CapabilityFunctionDefinition` | type      | OpenAI-compatible function schema stored in `AiCapability.functionDefinition`            |
| `CapabilityRegistryEntry`      | type      | Merged view of the `AiCapability` row loaded by the dispatcher                           |
| `AgentCapabilityBinding`       | type      | Per-agent override, merged `AiAgentCapability` + `AiCapability`                          |

Built-in capability classes (`SearchKnowledgeCapability`, `GetPatternDetailCapability`, `EstimateCostCapability`, `ReadUserMemoryCapability`, `WriteUserMemoryCapability`, `EscalateToHumanCapability`, `ApplyAuditChangesCapability`, `AddProviderModelsCapability`, `DeactivateProviderModelsCapability`, `CallExternalApiCapability`, `RunWorkflowCapability`, `UploadToStorageCapability`) are **not** re-exported — callers go through the dispatcher.

## Outbound HTTP: `call_external_api`

The `call_external_api` capability gives an agent the ability to make outbound HTTP requests to allowlisted hosts. It is the foundation Sunrise uses for vendor integrations (transactional email, payments, chat notifications, calendar events, document rendering) — see [`recipes/`](./recipes/index.md) for worked examples per pattern.

**Why one generic capability rather than per-vendor classes.** Bundling vendor SDKs (Stripe, Postmark, Slack, etc.) costs a lot in dependency footprint and version-pin burden, and ships a product opinion. Sunrise instead curates a single sharpened HTTP primitive plus pattern-named recipes that show developers how to wire any specific vendor.

**Security posture:**

- Hosts are gated by `ORCHESTRATION_ALLOWED_HOSTS` (the `lib/orchestration/http/allowlist.ts` module).
- Auth credentials are env-var names referenced from the per-agent `AiAgentCapability.customConfig` row — never in args, never visible to the LLM, never logged.
- Optional `allowedUrlPrefixes` in `customConfig` constrains the LLM to specific paths within an allowed host (recommended for payment-shaped APIs).
- Optional `autoIdempotency: true` in `customConfig` attaches an `Idempotency-Key` header on every call (essential for safe retries on payment APIs).

**Args (LLM-supplied):**

| Field             | Type                                              | Required       | Description                                                                                                                |
| ----------------- | ------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `string` (URL)                                    | Yes (see note) | Fully qualified HTTPS URL. Optional when the binding pins a `forcedUrl` — in that case the LLM-supplied value is discarded |
| `method`          | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | Yes            | HTTP method                                                                                                                |
| `headers`         | `Record<string, string>`                          | No             | Optional request headers; per-binding `forcedHeaders` override matching keys (case-insensitively)                          |
| `body`            | `string \| object`                                | No             | Object → JSON-stringified; string → verbatim. Ignored for GET/DELETE                                                       |
| `responseExtract` | `string` (JMESPath)                               | No             | Optional inline transform; falls back to binding `defaultResponseTransform`                                                |

**Per-agent `customConfig` (admin-supplied via `AiAgentCapability.customConfig`):**

| Field                      | Type                                                                                                    | Description                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedUrlPrefixes`       | `string[]`                                                                                              | URL allowlist within the host. LLM URL must `startsWith` one. Ignored when `forcedUrl` is set                                                                                                                               |
| `forcedUrl`                | `string` (URL)                                                                                          | Replaces the LLM-supplied `url` entirely. Use for endpoints where the URL itself is a credential (chat-platform incoming webhooks). When set, the LLM does not need to supply `url` at all and `allowedUrlPrefixes` is moot |
| `auth`                     | `{ type, secret?, queryParam?, apiKeyHeaderName?, hmacHeaderName?, hmacAlgorithm?, hmacBodyTemplate? }` | Auth config; `secret` is an env var name. `apiKeyHeaderName` overrides the default `X-API-Key` header for vendors that use a custom name (e.g. Postmark's `X-Postmark-Server-Token`)                                        |
| `forcedHeaders`            | `Record<string, string>`                                                                                | Headers always applied; override LLM-supplied keys (case-insensitively — `Authorization` from forced wins over `authorization` from args)                                                                                   |
| `autoIdempotency`          | `boolean`                                                                                               | When true, attach a fresh UUID `Idempotency-Key` per call                                                                                                                                                                   |
| `idempotencyHeader`        | `string`                                                                                                | Override the default `Idempotency-Key` header name                                                                                                                                                                          |
| `defaultResponseTransform` | `{ type: 'jmespath' \| 'template', expression: string }`                                                | Applied unless `responseExtract` is supplied                                                                                                                                                                                |
| `timeoutMs`                | `number`                                                                                                | Per-binding timeout override                                                                                                                                                                                                |
| `maxResponseBytes`         | `number`                                                                                                | Per-binding response cap override                                                                                                                                                                                           |

**Error codes returned in `CapabilityResult.error.code`:** `invalid_args`, `invalid_binding` (returned fail-closed when the per-agent `customConfig` JSON fails its Zod schema; admin must repair the row before the agent can call this capability again), `url_not_allowed`, `host_not_allowed`, `auth_failed`, `rate_limited`, `http_error`, `timeout`, `response_too_large`, `request_aborted`, `request_failed`.

**Implementation:** `lib/orchestration/capabilities/built-in/call-external-api.ts`. Delegates to `lib/orchestration/http/` for the actual HTTP call.

**Don't bypass the recipes.** If you find yourself binding `call_external_api` for a pattern that isn't covered by a recipe and isn't a one-off, add a recipe — it's a markdown file, takes an hour, and saves the next person the same investigation.

## The `BaseCapability` Contract

```typescript
export abstract class BaseCapability<TArgs = unknown, TData = unknown> {
  abstract readonly slug: string;
  abstract readonly functionDefinition: CapabilityFunctionDefinition;
  protected abstract readonly schema?: CapabilitySchema<TArgs>;

  abstract execute(args: TArgs, context: CapabilityContext): Promise<CapabilityResult<TData>>;

  validate(rawArgs: unknown): TArgs; // throws CapabilityValidationError
  protected success<T extends TData>(
    data: T,
    opts?: { skipFollowup?: boolean }
  ): CapabilityResult<T>;
  protected error(message: string, code?: string): CapabilityResult<never>;
}
```

`validate()` _throws_ rather than returning a discriminated result — that way `execute()` can treat its args as already typed. The dispatcher catches `CapabilityValidationError` and emits `{ code: 'invalid_args' }`.

Subclasses return results via `this.success(...)` / `this.error(...)` — never by hand-building a `CapabilityResult`.

## Dispatch Pipeline

`capabilityDispatcher.dispatch(slug, rawArgs, context)` runs this pipeline, returning as soon as any step fails:

1. **Load registry** — `loadFromDatabase()` fetches active `AiCapability` rows into the in-memory map. Deduped via an inflight promise; cached for 5 minutes.
2. **Handler lookup** — `handlers.get(slug)`. Missing → `{ code: 'unknown_capability' }`.
3. **Registry lookup** — the in-memory `CapabilityRegistryEntry`. Missing → `{ code: 'capability_inactive' }`.
4. **Per-agent binding** — `prisma.aiAgentCapability.findMany({ agentId })`, cached per agent for 5 minutes. An explicit row with `isEnabled: false` → `{ code: 'capability_disabled_for_agent' }`. Missing row = default-allow with base-capability defaults.
5. **Rate limit** — effective limit = `binding.effectiveRateLimit ?? entry.rateLimit`. If non-null, a sliding-window `RateLimiter` keyed by slug (token = `agentId`) checks the request. Exceeded → `{ code: 'rate_limited' }`.
6. **Approval gate** — `entry.requiresApproval: true` → `{ code: 'requires_approval', skipFollowup: true }`. The handler never runs. (The admin queue that resolves approvals is a later slice.)
7. **Validate args** — `handler.validate(rawArgs)`. `CapabilityValidationError` → `{ code: 'invalid_args', message }`.
8. **Execute** — `await handler.execute(validated, context)`. Any thrown error → `{ code: 'execution_error' }` and `logger.error`.
9. **Log cost** — fire-and-forget `logCost({ operation: 'tool_call', model: 'n/a', provider: 'capability', inputTokens: 0, outputTokens: 0, metadata: { slug, success } })`. Not awaited: the LLM call that triggered the tool already logged its own tokens, and `logCost` returns `null` on DB failure.
10. **Return** the handler's result verbatim. One `logger.info('Capability dispatched', ...)` line with `latencyMs` rounds out each call.

### Cache semantics

- `loadFromDatabase()` — 5 min TTL for the `AiCapability` registry; concurrent callers share one in-flight fetch.
- `getAgentBinding()` — 5 min TTL per `agentId`; concurrent callers share one per-agent in-flight fetch.
- `clearCache()` — drops the registry, rate limiters, and all agent bindings. **Does not** drop the in-memory handler map — re-registration is controlled by `registerBuiltInCapabilities`'s module flag.

Call `clearCache()` from admin mutation endpoints that update `AiCapability` / `AiAgentCapability` rows.

### Default-allow vs default-deny

The dispatcher and `getCapabilityDefinitions` use deliberately asymmetric defaults for missing pivot rows:

- **`dispatch()` is default-allow.** No `AiAgentCapability` row = use the base capability's settings. Backend, CLI, and test callers can dispatch without any admin wiring.
- **`getCapabilityDefinitions()` is default-deny.** Only capabilities with an explicit `AiAgentCapability` row where `isEnabled: true` AND the underlying capability is both `isActive` and present in the in-memory handler map are returned. The LLM only _sees_ tools an admin has explicitly enabled.

## Built-in Capabilities

### `search_knowledge_base`

Semantic search over the knowledge base. Delegates to `searchKnowledge` in `lib/orchestration/knowledge/search.ts` (vector-only or hybrid mode, controlled by `searchConfig.hybridEnabled`).

```json
{
  "name": "search_knowledge_base",
  "description": "Semantic search over the knowledge base. Each result carries a `marker` field — cite via [N] in your response.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 500 },
      "pattern_number": { "type": "integer", "minimum": 1, "maximum": 999 },
      "document_id": { "type": "string", "format": "uuid" }
    },
    "required": ["query"]
  }
}
```

Returns `{ results: [{ chunkId, documentId, documentName, content, patternNumber, patternName, section, similarity, vectorScore?, keywordScore?, finalScore? }] }`. Zero matches is a valid success — not an error.

**Citation contract.** This capability is registered as a citation producer in `lib/orchestration/chat/citations.ts`. The chat handler post-processes every result it returns: each item gets a monotonic `marker` injected before the result is yielded, persisted, and fed back to the LLM. The tool description instructs the model to cite via `[N]` so the marker appears inline in the assistant's text. The accumulated `Citation[]` envelope is surfaced to the client as a `citations` SSE event and persisted on the assistant message metadata. See [Streaming Chat — Citations](./chat.md#citations) for the full lifecycle.

The hybrid score fields (`vectorScore`, `keywordScore`, `finalScore`) are present only when the search ran in hybrid mode — they let admin trace viewers explain _why_ a particular chunk ranked high.

### `get_pattern_detail`

Returns every chunk for a single pattern, ordered by section. Delegates to `getPatternDetail`.

```json
{
  "name": "get_pattern_detail",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern_number": { "type": "integer", "minimum": 1, "maximum": 999 }
    },
    "required": ["pattern_number"]
  }
}
```

Empty chunks array → `{ code: 'not_found' }`.

### `estimate_workflow_cost`

Planning-grade USD cost estimate for a multi-step workflow. Picks the first model in the requested tier via `modelRegistry.getModelsByTier()` and multiplies by per-step heuristics (**1500 input / 500 output tokens per step**, documented in the source file header as rough estimates, not measured traces).

```json
{
  "name": "estimate_workflow_cost",
  "parameters": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "minLength": 1, "maxLength": 2000 },
      "estimated_steps": { "type": "integer", "minimum": 1, "maximum": 1000 },
      "model_tier": { "type": "string", "enum": ["budget", "mid", "frontier"] }
    },
    "required": ["description", "estimated_steps", "model_tier"]
  }
}
```

Returns `{ model, tier, totalSteps, assumptions, cost }` with `skipFollowup: true` — the cost _is_ the final answer, so the chat handler should not feed it back for another LLM turn.

### `read_user_memory`

Retrieves stored memories for the current user+agent pair. Delegates to `prisma.aiUserMemory.findMany`. Scoped to `(userId, agentId)` from the capability context.

```json
{
  "name": "read_user_memory",
  "parameters": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "minLength": 1, "maxLength": 255 }
    },
    "required": []
  }
}
```

Returns `{ memories: [{ key, value, updatedAt }] }`. When `key` is omitted, returns all memories (up to 50) for the user+agent pair. Empty array is a valid success.

### `write_user_memory`

Stores or updates a memory for the current user+agent pair. Uses `prisma.aiUserMemory.upsert` with compound unique `(userId, agentId, key)`.

```json
{
  "name": "write_user_memory",
  "parameters": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "minLength": 1, "maxLength": 255 },
      "value": { "type": "string", "minLength": 1, "maxLength": 5000 }
    },
    "required": ["key", "value"]
  }
}
```

Returns `{ key, action }` where `action` is `'created'` or `'updated'`.

### `escalate_to_human`

Signals that the current conversation needs human attention. Dispatches a `conversation_escalated` webhook event so external systems (helpdesks, ticketing, Slack) can pick up the escalation, and calls `notifyEscalation` (`lib/orchestration/capabilities/built-in/escalation-notifier.ts`) which reads `OrchestrationSettings.escalationConfig` and sends email notifications (plus an optional secondary webhook POST to a config-driven URL). Both side effects are fire-and-forget. The agent remains in the conversation — it should inform the user that a human will follow up.

```json
{
  "name": "escalate_to_human",
  "parameters": {
    "type": "object",
    "properties": {
      "reason": { "type": "string", "minLength": 1, "maxLength": 1000 },
      "priority": { "type": "string", "enum": ["low", "medium", "high"] },
      "metadata": { "type": "object" }
    },
    "required": ["reason"]
  }
}
```

Returns `{ escalated: true, reason, priority, metadata? }`. The `metadata` parameter is optional and passed through to the webhook payload, which also includes `agentId`, `userId`, `conversationId`, `reason`, and `priority`.

### `run_workflow`

Lets an agent trigger a named workflow on the user's behalf during a chat turn. Returns when the workflow either completes synchronously (the LLM gets the output as a normal tool result) or pauses on a `human_approval` step (the chat handler emits an `approval_required` SSE event, the user sees an Approve / Reject card inline, and `skipFollowup: true` prevents an LLM narration turn racing the click).

```json
{
  "name": "run_workflow",
  "parameters": {
    "type": "object",
    "properties": {
      "workflowSlug": { "type": "string", "maxLength": 120 },
      "input": { "type": "object", "additionalProperties": true }
    },
    "required": ["workflowSlug"]
  }
}
```

Per-agent binding `customConfig`:

- `allowedWorkflowSlugs: string[]` — required, min 1. The LLM may only invoke workflows on this list. Fail-closed if the binding is missing or malformed.
- `defaultBudgetUsd?: number` — optional. Forwarded to the engine as `budgetLimitUsd` so chat-triggered workflows can't exceed a per-binding spend cap regardless of the system prompt.

Result `data` is a discriminated union on `status`:

- `'completed'` — `{ executionId, output, totalCostUsd, totalTokensUsed }`. LLM gets the output as a normal tool result.
- `'pending_approval'` — `{ executionId, stepId, prompt, expiresAt, approveToken, rejectToken }`. Tokens are raw HMAC strings; the chat surface (admin or embed) constructs the channel-specific URL at POST time.

Workflow failure surfaces as a capability error (`code: 'workflow_failed'`) so the LLM treats it as a tool failure rather than a sad-path success. See [Streaming Chat — In-chat approvals](./chat.md#in-chat-approvals) for the full event sequence.

### `upload_to_storage`

Persists a binary artefact (PDF from a renderer, image from a generator, CSV from a report builder) to the configured Sunrise storage backend (S3, Vercel Blob, or local) and returns a URL the user can open. Closes the loop with `call_external_api` for endpoints that return bytes inline as `{ encoding: 'base64', contentType, data }` — the agent can chain render → upload without the LLM having to interpret base64.

```json
{
  "name": "upload_to_storage",
  "parameters": {
    "type": "object",
    "properties": {
      "data": { "type": "string", "description": "Base64-encoded file bytes" },
      "contentType": { "type": "string", "maxLength": 127 },
      "filename": { "type": "string", "maxLength": 200 },
      "description": { "type": "string", "maxLength": 500 }
    },
    "required": ["data", "contentType"]
  }
}
```

Per-agent binding `customConfig`:

- `keyPrefix?: string` — optional path prefix, must end with `/`. Defaults to `agent-uploads/<agentId>/`. Forced through `validateStorageKey` at upload time so a malformed prefix can't escape the bucket.
- `allowedContentTypes?: string[]` — optional MIME allowlist (e.g. `['application/pdf']`). When set, an upload with a non-matching `contentType` fails closed with `content_type_not_allowed`. Recommended for narrow bindings.
- `maxFileSizeBytes?: number` — optional per-binding cap. Defaults to the deployment's `MAX_FILE_SIZE_MB` (5 MB if unset).
- `signedUrlTtlSeconds?: number` — when set, the result returns a time-limited signed URL instead of a public one. **Only S3 supports signed URLs**; on Vercel Blob / local the call fails with `signed_url_not_supported`. Implies `public: false` at upload time.
- `public?: boolean` — defaults `true`. Ignored when `signedUrlTtlSeconds` is set (signed implies private).

Result `data`:

- `key` — canonical storage key (use this for any future delete capability; never derive from `url`)
- `url` — public URL (or signed URL when `signedUrlTtlSeconds` is set)
- `size` — uploaded bytes
- `contentType` — echoed for the LLM's narration
- `signed` — boolean
- `expiresAt?` — RFC3339 timestamp when `signed: true`

**Security posture.** The LLM cannot influence the storage path. The prefix is admin-set, `filename` is parsed for an extension only (and rejected if it doesn't match `^\.[a-z0-9]{1,10}$`), and the path segment is a random UUID. Path traversal (`..`), absolute paths, and backslashes in the resolved key are rejected by `validateStorageKey` before the storage provider is called.

See `recipes/document-render.md` (Pattern B) for the canonical chain: `call_external_api` → `upload_to_storage`.

## Consumer Contract (Chat Handler)

The chat handler will eventually:

1. Call `getCapabilityDefinitions(agentId)` to build the LLM's `tools` array.
2. For each `tool_use` block in the LLM's response:
   - Extract `name` and `input`.
   - Call `capabilityDispatcher.dispatch(name, input, { userId, agentId, conversationId })`.
   - Map the `CapabilityResult` to a `ChatEvent` of type `capability_result` (see `types/orchestration.ts`).
   - If `result.skipFollowup === true`, render the result directly and stop. Otherwise, feed the result back to the LLM as a tool-result message and continue the turn.
3. If `dispatch` returns `{ code: 'requires_approval' }`, enqueue an approval request (later slice) and surface the gated state to the UI.

## Rate Limiting & Approval

- **Rate limit key:** `(slug, agentId)`. One `RateLimiter` instance per slug, `agentId` used as the token. Base values come from `AiCapability.rateLimit` (calls/min, `null` = unlimited); per-agent overrides come from `AiAgentCapability.customRateLimit`.
- **Window:** 60 s sliding (from `createRateLimiter({ interval: 60_000 })`).
- **Approval:** Phase 2b ships only the contract — the dispatcher short-circuits with `requires_approval` and never calls the handler. Phase 2c will add the admin queue that resolves gated calls.

## Anti-Patterns

**Don't** construct built-in capabilities directly — go through the dispatcher:

```typescript
// Bad — bypasses rate limit, approval, registry, and cost log
const cap = new SearchKnowledgeCapability();
const result = await cap.execute({ query: 'react' }, ctx);
```

**Don't** call the underlying service from code that should be going through the dispatcher:

```typescript
// Bad inside an agent-facing code path
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
const results = await searchKnowledge('react');
```

Services like `searchKnowledge` and `calculateCost` are fine to call directly from non-agent code (admin endpoints, seed scripts, tests) — the anti-pattern is skipping the dispatcher for _agent_ tool calls.

**Don't** await the dispatcher's `logCost` — it's fire-and-forget by design, so accounting latency never blocks the user-facing response.

**Don't** import `next/*` anywhere under `lib/orchestration/capabilities/`:

```typescript
// Will break the platform-agnostic contract
import { cache } from 'react';
import { headers } from 'next/headers';
```

**Don't** add new methods to `CapabilityDispatcher` without a matching consumer — keep the surface small.

## Testing

Unit tests live in `tests/unit/lib/orchestration/capabilities/`. Mocking style matches the rest of the orchestration domain:

```typescript
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));

const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
```

Notes:

- `@/lib/security/rate-limit` is **not** mocked in dispatcher tests — the real `createRateLimiter` exercises actual sliding-window behaviour.
- Because `capabilityDispatcher` is a singleton, call `capabilityDispatcher.clearCache()` in `beforeEach` AND re-`register()` any handlers the test needs (clearCache does not drop the handler map).
- For the dispatcher's fire-and-forget `logCost`, flush microtasks (`await Promise.resolve(); await Promise.resolve();`) before asserting on the mock.

Run the suite:

```bash
npx vitest run tests/unit/lib/orchestration/capabilities
```

## Related Documentation

- [Orchestration Overview](./overview.md) — domain entry point
- [LLM Providers](./llm-providers.md) — the Phase 2a provider abstraction that cost logging piggy-backs on
- `.claude/docs/agent-orchestration.md` — architectural brief
- `types/orchestration.ts` — `CostOperation`, `ChatEvent`, `AgentWithCapabilities`
- `prisma/schema.prisma` — `AiCapability`, `AiAgentCapability`
