---
name: orchestration-capability-builder
version: 1.0.0
description: |
  Expert capability builder for Sunrise orchestration. Creates custom agent
  capabilities (tools) that let agents call APIs, look up data, process refunds,
  send notifications, or perform any external action. Handles Zod validation,
  OpenAI-compatible function definitions, execution handlers, registry wiring,
  and database setup via the 4-step pipeline: TypeScript class, registry, DB row,
  agent binding. Use when an agent needs a new tool, needs to call an external
  service, or needs to perform actions beyond conversation.

triggers:
  - 'create capability'
  - 'build capability'
  - 'add tool for agent'
  - 'custom capability'
  - 'new capability'
  - 'my agent needs to look up'
  - 'agent should be able to call'
  - 'give my agent access to'
  - 'agent tool that calls'
  - 'connect agent to API'
  - 'agent needs to fetch data'
  - 'add a tool to my agent'

contexts:
  - 'lib/orchestration/capabilities/base-capability.ts'
  - 'lib/orchestration/capabilities/types.ts'
  - 'lib/orchestration/capabilities/registry.ts'
  - 'lib/orchestration/capabilities/dispatcher.ts'
  - 'lib/orchestration/capabilities/built-in/*.ts'
  - 'lib/validations/orchestration.ts'
  - '.context/admin/orchestration-capabilities-guide.md'
  - '.context/orchestration/capabilities.md'
  - 'types/orchestration.ts'

mcp_integrations:
  context7:
    libraries:
      - zod: '/colinhacks/zod'

parameters:
  execution_types: ['internal', 'api', 'webhook']
  requires_approval_default: false
  rate_limit_default: 30
---

# Capability Builder Skill

## Mission

You build production-ready capabilities for the Sunrise orchestration system. Capabilities are tools that agents call during conversation — each one combines a Zod schema, an OpenAI-compatible function definition, and an execution handler. Your job is to produce all four artifacts (class, registry entry, DB row, agent binding) correctly and in the right order.

## Before you start: check the recipes

For HTTP-shaped integrations (send an email, post to chat, charge a payment, create a calendar event, render a PDF), **don't build a new capability — use the existing `call_external_api` capability with the appropriate recipe**. The recipes live in `.context/orchestration/recipes/` and provide:

- The full per-agent `customConfig` JSON to bind
- Vendor variants (Postmark / SendGrid / Resend / SES; Stripe / Adyen / Mollie; etc.)
- Agent prompt guidance
- Worked end-to-end examples
- Anti-patterns specific to the integration shape

If you're about to write a new capability and the request matches one of the recipe patterns, recommend the recipe instead. Building a `StripeCapability` when a `payment-charge` recipe binding gets the same outcome with no new code is a regression in maintainability.

**Build a fresh capability when:** the integration is genuinely stateful (multi-step OAuth flows, paginated retrieval with cursor management), needs in-process state across calls, or requires logic that doesn't fit a single HTTP request/response.

## The 4-Step Pipeline

Every capability requires coordinated changes across 4 locations. Missing any one causes silent failures.

### Step 1: Create the capability class

Create a new file at `lib/orchestration/capabilities/built-in/<slug>.ts`:

```typescript
import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

// 1. Define Zod schema — validates raw LLM-supplied args
const schema = z.object({
  order_id: z.string().min(1).max(100),
});

type Args = z.infer<typeof schema>;

// 2. Define the return data shape
interface Data {
  orderId: string;
  status: string;
  total: number;
}

// 3. Implement the class
export class LookupOrderCapability extends BaseCapability<Args, Data> {
  readonly slug = 'lookup_order';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'lookup_order', // MUST match slug exactly
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

### Step 2: Register with the dispatcher

In `lib/orchestration/capabilities/registry.ts`, import the class and add it to `registerBuiltInCapabilities()`:

```typescript
import { LookupOrderCapability } from './built-in/lookup-order';

export function registerBuiltInCapabilities(): void {
  if (registered) return;
  // ... existing registrations ...
  capabilityDispatcher.register(new LookupOrderCapability());
  registered = true;
}
```

### Step 3: Create the database row

```
POST /api/v1/admin/orchestration/capabilities
{
  "name": "Order Lookup",
  "slug": "lookup_order",
  "description": "Look up an order by ID",
  "category": "internal",
  "executionType": "internal",
  "executionHandler": "LookupOrderCapability",
  "functionDefinition": { /* same object as Step 1 */ },
  "requiresApproval": false,
  "rateLimit": 30,
  "isIdempotent": false,
  "isActive": true
}
```

`isIdempotent` defaults to `false`. The orchestration engine's dispatch cache (`AiWorkflowStepDispatch`, keyed on `(executionId, stepId)`) deduplicates side effects on re-drive after a crash. Leave the default unless the capability is **provably safe to rerun** — a write that's already idempotent at the destination (PUT with the same key, an upstream API that handles `Idempotency-Key` headers itself). Misconfiguring `isIdempotent: true` on a destructive capability is documented as the "you marked it idempotent" admin trade-off.

### Step 4: Bind to an agent

```
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{
  "capabilityId": "<capability-id-from-step-3>",
  "isEnabled": true,
  "customRateLimit": null
}
```

## Execution Type Decision Tree

| Type       | When to use                                     | `executionHandler` value                         |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| `internal` | Business logic in TypeScript within the app     | Class name (e.g. `LookupOrderCapability`)        |
| `api`      | Call an external REST API                       | Full URL (e.g. `https://api.example.com/orders`) |
| `webhook`  | Fire-and-forget notification to external system | Full URL (validated by `checkSafeProviderUrl`)   |

For `api` and `webhook` types, no TypeScript class is needed — the dispatcher makes the HTTP call directly. Only `internal` type requires Steps 1-2.

## BaseCapability Contract

```typescript
abstract class BaseCapability<TArgs = unknown, TData = unknown> {
  abstract readonly slug: string;
  abstract readonly functionDefinition: CapabilityFunctionDefinition;
  protected abstract readonly schema: CapabilitySchema<TArgs>;
  abstract execute(args: TArgs, ctx: CapabilityContext): Promise<CapabilityResult<TData>>;

  validate(rawArgs: unknown): TArgs; // throws CapabilityValidationError
  protected success<T>(data: T, opts?): CapabilityResult<T>;
  protected error(message: string, code?: string): CapabilityResult<never>;
}
```

- `slug` — unique identifier, must match `functionDefinition.name` and `AiCapability.slug` in DB
- `functionDefinition` — OpenAI-compatible JSON Schema, passed to the LLM's `tools` array
- `schema` — Zod schema for arg validation (runs before `execute`)
- `execute(args, ctx)` — business logic; args are pre-validated and typed
- `success(data, opts?)` — build success result; set `{ skipFollowup: true }` if the result IS the final answer
- `error(message, code?)` — build error result; default code is `'capability_error'`

## CapabilityContext

```typescript
interface CapabilityContext {
  userId: string;
  agentId: string;
  conversationId?: string;
  entityContext?: Record<string, unknown>;
}
```

## Dispatch Pipeline

When `capabilityDispatcher.dispatch(slug, rawArgs, context)` is called:

1. **Load registry** — fetch active `AiCapability` rows (5 min cache)
2. **Handler lookup** — check in-memory map; missing = `unknown_capability`
3. **Registry lookup** — check DB registry; missing = `capability_inactive`
4. **Agent binding** — load `AiAgentCapability` rows (5 min cache); disabled = `capability_disabled_for_agent`
5. **Rate limit** — sliding window by `(slug, agentId)`; exceeded = `rate_limited`
6. **Approval gate** — `requiresApproval: true` = `requires_approval` (handler never runs; the chat surface renders an Approve / Reject card via `run_workflow` when wired)
7. **Validate args** — run Zod schema; failure = `invalid_args`
8. **Execute** — call handler; thrown errors = `execution_error`
9. **Log cost** — fire-and-forget cost entry to `AiCostLog`

**When dispatched inside a workflow `tool_call` step**, the engine also wraps this pipeline in the `AiWorkflowStepDispatch` cache: the first successful call is recorded; on re-drive after a crash, the cached result is returned without re-firing the handler. Capabilities with `isIdempotent: true` opt out of the cache. The cache is keyed on `(executionId, stepId)`.

For `agent_call`, `orchestrator`, and `reflect` step types, the engine additionally records per-turn state to `currentStepTurns` so multi-turn loops resume cleanly after a crash without losing prior turns' work. Capability authors don't configure this directly but should know capabilities they author may be re-invoked under the cache umbrella.

## Safety Configuration

| Level     | Field              | Purpose                                                                      |
| --------- | ------------------ | ---------------------------------------------------------------------------- |
| Base      | `requiresApproval` | Short-circuits dispatch — handler never runs                                 |
| Base      | `rateLimit`        | Calls/minute/agent; `null` = unlimited                                       |
| Base      | `isIdempotent`     | When `true`, opts out of the dispatch cache (destination handles dedup)      |
| Base      | `isActive`         | Global kill switch                                                           |
| Per-agent | `isEnabled`        | Disable for specific agent                                                   |
| Per-agent | `customRateLimit`  | Override base rate limit; `null` = use base                                  |
| Per-agent | `customConfig`     | Per-agent JSON config blob (recipe variants, allowlists, ${env:VAR} secrets) |

Effective rate limit: `customRateLimit ?? rateLimit`.

### Env-var resolution in `customConfig`

Four named fields support the `${env:VAR}` template, resolved at call time so secrets never sit in the DB:

- `call_external_api.forcedUrl`
- `call_external_api.forcedHeaders`
- workflow `external_call.url`
- workflow `external_call.headers`

Missing env var → `invalid_binding` for the capability path, `ExecutorError('missing_env_var')` for the workflow step. Rotation = change one env var, no binding edit. The admin Configure dialog displays `meta.warnings.missingEnvVars` so unset references are surfaced at save time (mirrors `apiKeyPresent` for providers).

## Built-in Capabilities (do not recreate)

These 12 capabilities ship as `isSystem: true` — bind them to agents, never recreate:

| Slug                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `search_knowledge_base`      | Hybrid semantic + BM25 search over the knowledge base           |
| `get_pattern_detail`         | Full pattern content by number                                  |
| `estimate_workflow_cost`     | Planning-grade USD cost estimate                                |
| `read_user_memory`           | Per-user persistent memory read                                 |
| `write_user_memory`          | Per-user persistent memory write                                |
| `escalate_to_human`          | Human-in-the-loop escalation (helpdesk webhook)                 |
| `call_external_api`          | Recipe-driven HTTP integration (Postmark, Stripe, Slack, etc.)  |
| `run_workflow`               | Chat agent triggers a workflow (with optional in-chat approval) |
| `upload_to_storage`          | Upload base64 payloads to S3 / Vercel Blob / local              |
| `apply_audit_changes`        | Apply approved model audit field changes                        |
| `add_provider_models`        | Register new models from audit proposals                        |
| `deactivate_provider_models` | Soft-delete deprecated provider models                          |

**`call_external_api` is the canonical HTTP capability.** Before writing a new capability that wraps an HTTP endpoint, check `.context/orchestration/recipes/` — for email (Postmark / SendGrid / Resend / SES), chat (Slack / Discord), payments (Stripe / Adyen / Mollie), document rendering (Gotenberg), and calendar (Google / Outlook), a recipe-driven `call_external_api` binding gets the same outcome with zero new TypeScript. `call_external_api` also supports `multipart/form-data` bodies (mutually exclusive with `body`; incompatible with HMAC auth) for vendors like Gotenberg.

## Testing

Write tests under `tests/unit/lib/orchestration/capabilities/`. Follow existing patterns in that directory.

### What to test

1. **Validation** — verify the Zod schema rejects bad input and accepts good input
2. **Execute** — verify success and error paths with mocked dependencies
3. **Slug consistency** — assert `capability.slug === capability.functionDefinition.name`

### Test template

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MyCapability } from '@/lib/orchestration/capabilities/built-in/my-capability';

describe('MyCapability', () => {
  const capability = new MyCapability();
  const context = { userId: 'test-user', agentId: 'test-agent' };

  it('slug matches functionDefinition.name', () => {
    expect(capability.slug).toBe(capability.functionDefinition.name);
  });

  it('validates valid input', () => {
    expect(() => capability.validate({ field: 'value' })).not.toThrow();
  });

  it('rejects invalid input', () => {
    expect(() => capability.validate({})).toThrow();
  });

  it('executes successfully', async () => {
    const result = await capability.execute({ field: 'value' }, context);
    expect(result.success).toBe(true);
  });
});
```

### What to mock

- Database calls (Prisma) — mock the specific query, not the entire client
- External API calls — mock `fetch` or the HTTP client
- Never mock `BaseCapability` methods (`validate`, `success`, `error`) — test through them

### Running tests

```bash
npm run test -- tests/unit/lib/orchestration/capabilities/my-capability.test.ts
```

## Verification Checklist

- [ ] `slug` matches across class, `functionDefinition.name`, and DB row
- [ ] Zod schema and `functionDefinition.parameters` are semantically equivalent
- [ ] Class is imported and registered in `registry.ts`
- [ ] DB row has correct `executionType` and `executionHandler`
- [ ] Agent binding created with `isEnabled: true`
- [ ] No `next/*` imports in the capability file
- [ ] `this.success()` / `this.error()` used (never hand-built result objects)
- [ ] Tests written and passing under `tests/unit/lib/orchestration/capabilities/`
- [ ] `npm run validate` passes (type-check + lint + format)
- [ ] Run `/pre-pr` before merging the feature branch
