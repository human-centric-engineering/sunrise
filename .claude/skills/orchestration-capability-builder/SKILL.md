---
name: orchestration-capability-builder
version: 1.0.0
description: |
  Expert capability builder for Sunrise orchestration. Creates custom agent
  capabilities with Zod validation, OpenAI-compatible function definitions,
  execution handlers, registry wiring, and database setup. Handles the full
  4-step pipeline: TypeScript class, registry, DB row, agent binding.
  Use when creating new capabilities or tools for agents.

triggers:
  - 'create capability'
  - 'build capability'
  - 'add tool for agent'
  - 'custom capability'
  - 'new capability'

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
  "isActive": true
}
```

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

## Dispatch Pipeline (9 steps)

When `capabilityDispatcher.dispatch(slug, rawArgs, context)` is called:

1. **Load registry** — fetch active `AiCapability` rows (5 min cache)
2. **Handler lookup** — check in-memory map; missing = `unknown_capability`
3. **Registry lookup** — check DB registry; missing = `capability_inactive`
4. **Agent binding** — load `AiAgentCapability` rows (5 min cache); disabled = `capability_disabled_for_agent`
5. **Rate limit** — sliding window by `(slug, agentId)`; exceeded = `rate_limited`
6. **Approval gate** — `requiresApproval: true` = `requires_approval` (handler never runs)
7. **Validate args** — run Zod schema; failure = `invalid_args`
8. **Execute** — call handler; thrown errors = `execution_error`
9. **Log cost** — fire-and-forget cost entry

## Safety Configuration

| Level     | Field              | Purpose                                      |
| --------- | ------------------ | -------------------------------------------- |
| Base      | `requiresApproval` | Short-circuits dispatch — handler never runs |
| Base      | `rateLimit`        | Calls/minute/agent; `null` = unlimited       |
| Base      | `isActive`         | Global kill switch                           |
| Per-agent | `isEnabled`        | Disable for specific agent                   |
| Per-agent | `customRateLimit`  | Override base rate limit; `null` = use base  |

Effective rate limit: `customRateLimit ?? rateLimit`.

## Built-in Capabilities (do not recreate)

These 6 capabilities ship as `isSystem: true` — bind them to agents, never recreate:

| Slug                     | Purpose                          |
| ------------------------ | -------------------------------- |
| `search_knowledge_base`  | Semantic search over documents   |
| `get_pattern_detail`     | Full pattern content by number   |
| `estimate_workflow_cost` | Planning-grade USD cost estimate |
| `read_user_memory`       | Session memory access            |
| `write_user_memory`      | Session memory updates           |
| `escalate_to_human`      | Human-in-the-loop escalation     |

## Verification Checklist

- [ ] `slug` matches across class, `functionDefinition.name`, and DB row
- [ ] Zod schema and `functionDefinition.parameters` are semantically equivalent
- [ ] Class is imported and registered in `registry.ts`
- [ ] DB row has correct `executionType` and `executionHandler`
- [ ] Agent binding created with `isEnabled: true`
- [ ] No `next/*` imports in the capability file
- [ ] `this.success()` / `this.error()` used (never hand-built result objects)
- [ ] Tests written under `tests/unit/lib/orchestration/capabilities/`
