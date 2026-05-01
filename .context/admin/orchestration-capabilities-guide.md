# How to Create Capabilities

Capabilities are tools an agent can call during conversation — function definitions with execution handlers, Zod validation, rate limits, and approval gates. This guide walks through creating a custom capability from scratch.

## Quick Reference

| Concept           | Detail                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base class        | `BaseCapability<TArgs, TData>` in `lib/orchestration/capabilities/base-capability.ts`                                                                                                                                 |
| Registration      | `capabilityDispatcher.register(instance)` in `lib/orchestration/capabilities/registry.ts`                                                                                                                             |
| Built-in count    | 9 (`search_knowledge_base`, `get_pattern_detail`, `estimate_workflow_cost`, `read_user_memory`, `write_user_memory`, `escalate_to_human`, `apply_audit_changes`, `add_provider_models`, `deactivate_provider_models`) |
| Dispatch pipeline | 9 steps: load registry, handler lookup, registry lookup, agent binding, rate limit, approval gate, validate args, execute, log cost                                                                                   |
| Result shape      | `CapabilityResult<T>` — `{ success, data?, error?, skipFollowup? }`                                                                                                                                                   |

## Step-by-Step: Create a Custom Capability

### Step 1: Define the Zod schema and types

Create a new file at `lib/orchestration/capabilities/built-in/your-capability.ts`:

```typescript
import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const schema = z.object({
  order_id: z.string().min(1).max(100),
});

type Args = z.infer<typeof schema>;

interface Data {
  orderId: string;
  status: string;
  total: number;
}
```

The Zod schema validates raw LLM-supplied args before they reach `execute()`. Never accept `z.any()` — always define the shape explicitly.

### Step 2: Implement the capability class

```typescript
export class LookupOrderCapability extends BaseCapability<Args, Data> {
  readonly slug = 'lookup_order';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'lookup_order',
    description: 'Look up an order by ID and return its status and total.',
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID to look up.',
          minLength: 1,
          maxLength: 100,
        },
      },
      required: ['order_id'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, _context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Call your service — the dispatcher handles validation, rate limiting,
    // and error wrapping, so focus on the business logic here.
    const order = await lookupOrder(args.order_id);

    if (!order) {
      return this.error(`Order ${args.order_id} not found`, 'not_found');
    }

    return this.success({
      orderId: order.id,
      status: order.status,
      total: order.total,
    });
  }
}
```

Key points:

- `slug` must match `functionDefinition.name` and the `AiCapability.slug` in the database
- `functionDefinition` uses OpenAI-compatible JSON Schema — it's passed directly to the LLM's `tools` array
- Use `this.success(data)` and `this.error(message, code)` — never hand-build `CapabilityResult` objects
- If the result IS the final answer (no follow-up LLM turn needed), pass `{ skipFollowup: true }` to `this.success()`

### Step 3: Register with the dispatcher

In `lib/orchestration/capabilities/registry.ts`, import your class and add it to `registerBuiltInCapabilities`:

```typescript
import { LookupOrderCapability } from './built-in/lookup-order';

export function registerBuiltInCapabilities(): void {
  if (registered) return;
  capabilityDispatcher.register(new SearchKnowledgeCapability());
  capabilityDispatcher.register(new GetPatternDetailCapability());
  capabilityDispatcher.register(new EstimateCostCapability());
  capabilityDispatcher.register(new LookupOrderCapability()); // Add here
  registered = true;
}
```

Registration is idempotent — repeated calls (HMR, multiple entrypoints) are safe.

### Step 4: Create the database row

Create an `AiCapability` row via the admin UI or API. The `executionType` must be `internal` and the `executionHandler` must match the class name so the dispatcher can route to it:

```
POST /api/v1/admin/orchestration/capabilities
{
  "name": "Order Lookup",
  "slug": "lookup_order",
  "description": "Look up an order by ID",
  "category": "internal",
  "executionType": "internal",
  "executionHandler": "LookupOrderCapability",
  "functionDefinition": { ... },   // Same object as Step 2
  "requiresApproval": false,
  "rateLimit": 30,
  "isActive": true
}
```

For `api` and `webhook` execution types, `executionHandler` must be a valid URL (validated on both client and server).

Then attach it to an agent:

```
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{
  "capabilityId": "<capability-id>",
  "isEnabled": true,
  "customRateLimit": null
}
```

The `customRateLimit` on the pivot row overrides the base capability's `rateLimit` for this specific agent.

## BaseCapability Reference

```typescript
abstract class BaseCapability<TArgs = unknown, TData = unknown> {
  // ── Required overrides ──────────────────────────────────────
  abstract readonly slug: string;
  abstract readonly functionDefinition: CapabilityFunctionDefinition;
  protected abstract readonly schema: CapabilitySchema<TArgs>;
  abstract execute(args: TArgs, ctx: CapabilityContext): Promise<CapabilityResult<TData>>;

  // ── Provided by base class ──────────────────────────────────
  validate(rawArgs: unknown): TArgs; // throws CapabilityValidationError
  protected success<T>(data: T, opts?): CapabilityResult<T>;
  protected error(message: string, code?: string): CapabilityResult<never>;
}
```

| Member                  | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `slug`                  | Unique identifier, matches `AiCapability.slug` and `functionDefinition.name`          |
| `functionDefinition`    | OpenAI-compatible function schema passed to the LLM's `tools` array                   |
| `schema`                | Zod schema for arg validation — `validate()` runs this before `execute()`             |
| `execute(args, ctx)`    | Business logic — args are already validated and typed                                 |
| `validate(rawArgs)`     | Parses raw args through the Zod schema; throws `CapabilityValidationError` on failure |
| `success(data, opts?)`  | Build a success result; set `skipFollowup: true` to prevent a follow-up LLM turn      |
| `error(message, code?)` | Build an error result; default code is `'capability_error'`                           |

### CapabilityContext

```typescript
interface CapabilityContext {
  userId: string; // Authenticated user
  agentId: string; // Agent making the call
  conversationId?: string; // Current conversation (if chat)
  entityContext?: Record<string, unknown>; // Free-form context from chat handler
}
```

### CapabilityResult

```typescript
interface CapabilityResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  skipFollowup?: boolean; // true = don't feed result back to LLM
}
```

## Built-in Capabilities

Nine capabilities ship out of the box. All are in `lib/orchestration/capabilities/built-in/`. The first six are general-purpose; the last three support the Provider Model Audit workflow.

### `search_knowledge_base`

Semantic search over the agentic patterns knowledge base. Delegates to `searchKnowledge()` in `lib/orchestration/knowledge/search.ts`.

| Parameter        | Type                 | Required | Description                   |
| ---------------- | -------------------- | -------- | ----------------------------- |
| `query`          | string (1–500 chars) | Yes      | Natural-language search query |
| `pattern_number` | integer (1–999)      | No       | Filter to a single pattern    |

Returns `{ results: [{ chunkId, content, patternNumber, patternName, section, similarity }] }`. Zero matches is a valid success, not an error. Uses defaults of 10 results and 0.7 similarity threshold.

### `get_pattern_detail`

Returns every chunk for a single pattern, ordered by section. Delegates to `getPatternDetail()`.

| Parameter        | Type            | Required | Description        |
| ---------------- | --------------- | -------- | ------------------ |
| `pattern_number` | integer (1–999) | Yes      | The pattern number |

Returns `{ patternNumber, patternName, totalTokens, chunks: [{ chunkId, chunkKey, section, content, estimatedTokens }] }`. Empty chunks array returns an error with code `not_found`.

### `estimate_workflow_cost`

Planning-grade USD cost estimate for a multi-step workflow. Uses hard-coded per-step token assumptions (1500 input / 500 output per step) — rough order-of-magnitude, not measured from production traces.

| Parameter         | Type                                  | Required | Description                                         |
| ----------------- | ------------------------------------- | -------- | --------------------------------------------------- |
| `description`     | string (1–2000 chars)                 | Yes      | Natural-language description (logged, not executed) |
| `estimated_steps` | integer (1–1000)                      | Yes      | Approximate step count                              |
| `model_tier`      | `"budget"` \| `"mid"` \| `"frontier"` | Yes      | Price tier for model selection                      |

Returns `{ model, tier, totalSteps, assumptions, cost: { inputCostUsd, outputCostUsd, totalCostUsd } }` with `skipFollowup: true` — the cost estimate IS the final answer.

### `read_user_memory`

Reads a user's stored memory entries for the current agent context. Delegates to the memory service.

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `key`     | string | No       | Optional key to filter by |

### `write_user_memory`

Writes or updates a memory entry for the current user and agent context.

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `key`     | string | Yes      | Memory key            |
| `value`   | string | Yes      | Memory value to store |

### `escalate_to_human`

Flags a conversation for human review when the agent cannot resolve a query. Logs the escalation reason and pauses automated responses.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `reason`  | string | Yes      | Why escalation is needed |

### `apply_audit_changes`

Applies approved field changes to provider model entries. Validates each change against the update schema and invalidates the model cache. Used by the Provider Model Audit workflow.

| Parameter  | Type   | Required | Description                                                           |
| ---------- | ------ | -------- | --------------------------------------------------------------------- |
| `model_id` | string | No       | Model ID (single-model mode)                                          |
| `changes`  | array  | No       | Array of `{ field, currentValue, proposedValue, reason, confidence }` |
| `models`   | array  | No       | Array of `{ model_id, changes }` (multi-model mode)                   |

### `add_provider_models`

Adds new provider model entries to the registry. Validates against the create schema, skips duplicates, and invalidates the model cache.

| Parameter   | Type  | Required | Description                                                                                     |
| ----------- | ----- | -------- | ----------------------------------------------------------------------------------------------- |
| `newModels` | array | Yes      | Array of model entries with name, slug, providerSlug, modelId, capabilities, tierRole, bestRole |

### `deactivate_provider_models`

Soft-deletes provider model entries (sets `isActive=false`). Already-inactive models are skipped.

| Parameter          | Type  | Required | Description                            |
| ------------------ | ----- | -------- | -------------------------------------- |
| `deactivateModels` | array | Yes      | Array of `{ modelId, reason }` entries |

## Dispatch Pipeline

When the chat handler calls `capabilityDispatcher.dispatch(slug, rawArgs, context)`, these steps run in order (returning on first failure):

1. **Load registry** — fetches active `AiCapability` rows from DB (5 min cache, deduped inflight)
2. **Handler lookup** — checks in-memory handler map; missing = `unknown_capability`
3. **Registry lookup** — checks DB-loaded registry; missing = `capability_inactive`
4. **Agent binding** — loads `AiAgentCapability` rows for the agent (5 min cache); `isEnabled: false` = `capability_disabled_for_agent`
5. **Rate limit** — sliding-window check keyed by `(slug, agentId)`; exceeded = `rate_limited`
6. **Approval gate** — `requiresApproval: true` = `requires_approval` (handler never runs)
7. **Validate args** — runs `handler.validate(rawArgs)` through the Zod schema; failure = `invalid_args`
8. **Execute** — calls `handler.execute(validated, context)`; thrown errors become `execution_error`
9. **Log cost** — fire-and-forget cost log entry (never blocks the response)

### Default-Allow vs Default-Deny

The dispatcher uses deliberately asymmetric defaults:

- **`dispatch()` is default-allow** — no `AiAgentCapability` row = use base capability defaults. Backend, CLI, and test callers can dispatch without admin wiring.
- **`getCapabilityDefinitions()` is default-deny** — only capabilities with an explicit `AiAgentCapability` row (`isEnabled: true`) AND an active `AiCapability` AND a registered handler are returned. The LLM only sees tools an admin has explicitly enabled.

## Safety Configuration

Each capability has two levels of safety controls:

### Base capability (`AiCapability` row)

| Field              | Purpose                                                                        | Default |
| ------------------ | ------------------------------------------------------------------------------ | ------- |
| `requiresApproval` | If true, dispatch short-circuits with `requires_approval` — handler never runs | `false` |
| `rateLimit`        | Calls per minute per agent; `null` = unlimited                                 | `null`  |
| `isActive`         | Global kill switch — inactive capabilities are invisible                       | `true`  |

### Per-agent override (`AiAgentCapability` pivot row)

| Field             | Purpose                                                        | Default |
| ----------------- | -------------------------------------------------------------- | ------- |
| `isEnabled`       | Disable for a specific agent without touching other agents     | `true`  |
| `customRateLimit` | Override the base rate limit for this agent; `null` = use base | `null`  |

The effective rate limit is `customRateLimit ?? rateLimit` from the base capability.

## Anti-Patterns

**Don't construct capabilities directly** — go through the dispatcher:

```typescript
// Bad — bypasses rate limit, approval, registry, and cost log
const cap = new SearchKnowledgeCapability();
const result = await cap.execute({ query: 'react' }, ctx);
```

**Don't call underlying services from agent-facing code**:

```typescript
// Bad inside an agent code path — skips dispatcher controls
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
const results = await searchKnowledge('react');
```

Direct service calls are fine from non-agent code (admin endpoints, seed scripts, tests).

**Don't import `next/*` in capability files** — `lib/orchestration/` is platform-agnostic.

## Related Documentation

- [Capability dispatcher (service)](../orchestration/capabilities.md) — full dispatch pipeline, caching, testing
- [Capabilities list page (UI)](./orchestration-capabilities.md) — admin table, category filter
- [Capability form (UI)](./capability-form.md) — 4-tab create/edit form
- [Orchestration overview](./orchestration.md) — system entry point
