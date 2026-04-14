# Building Solutions with the Sunrise Orchestration Layer

This reference bridges from architectural pattern selection to implementation.
Use it when a developer describes a business problem and wants you to build
an agentic solution using the Sunrise orchestration layer.

---

## End-to-End Solution Flow

When a developer describes a problem:

1. **Select patterns** — use the pattern selection guide in SKILL.md
2. **Design the architecture** — use composition recipes as starting points
3. **Create agents** — one per distinct role (see below)
4. **Create capabilities** — one per tool/action the agents need
5. **Compose the workflow** — wire agents and steps into a DAG
6. **Test** — use the embedded chat and workflow executor
7. **Monitor** — check costs, traces, and evaluations

---

## Creating an Agent

Agents are configured in the database via the admin API or UI.
For Claude Code, create them via a database seed or API call.

**API:** `POST /api/v1/admin/orchestration/agents`

```typescript
{
  name: "Customer Support Agent",
  slug: "customer-support",
  description: "Handles customer enquiries, looks up orders, processes refunds",
  systemInstructions: `You are a customer support agent for [Company].
    You help customers with order enquiries, refunds, and general questions.
    Always verify the customer's order before making changes.
    Escalate to a human if the refund exceeds $100 or the customer is upset.`,
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  temperature: 0.3,
  maxTokens: 4096,
  monthlyBudgetUsd: 50.00
}
```

Key decisions per agent:

- **Model choice:** Budget model for routing/classification, mid-tier for
  conversation, frontier for complex reasoning
- **Temperature:** 0.0-0.3 for factual tasks, 0.5-0.7 for conversational,
  0.8+ for creative
- **System instructions:** Be specific about role, boundaries, escalation
  rules, and output format

---

## Creating a Capability

Each capability is a tool the agent can call. Capabilities are defined in
two parts: the function schema (what the LLM sees) and the handler (what
executes).

### Step 1: Write the handler

Create a file at `lib/orchestration/capabilities/built-in/your-capability.ts`:

```typescript
import { BaseCapability } from '../base-capability';
import { CapabilityResult, CapabilityContext } from '../types';
import { z } from 'zod';

const argsSchema = z.object({
  orderId: z.string().describe('The order ID to look up'),
});

export class LookupOrder extends BaseCapability {
  name = 'lookup_order';

  async execute(
    args: Record<string, unknown>,
    context: CapabilityContext
  ): Promise<CapabilityResult> {
    const { orderId } = this.validate(args, argsSchema);

    // Your business logic here
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return this.error('Order not found');
    }

    return this.success(order);
  }
}
```

### Step 2: Register in the capability registry

In `lib/orchestration/capabilities/registry.ts`, add:

```typescript
import { LookupOrder } from './built-in/lookup-order';
dispatcher.register('lookup_order', new LookupOrder());
```

### Step 3: Create the database record

**API:** `POST /api/v1/admin/orchestration/capabilities`

```typescript
{
  name: "Look Up Order",
  slug: "lookup_order",
  description: "Retrieves order details by order ID",
  category: "orders",
  functionDefinition: {
    name: "lookup_order",
    description: "Look up a customer order by its ID. Returns order status, items, and shipping info.",
    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The order ID to look up"
        }
      },
      required: ["orderId"]
    }
  },
  executionType: "internal",
  executionHandler: "lookup_order",
  requiresApproval: false,
  rateLimit: 30
}
```

### Step 4: Attach to the agent

**API:** `POST /api/v1/admin/orchestration/agents/{agentId}/capabilities`

```typescript
{ capabilityId: "the-capability-id", isEnabled: true }
```

---

## Composing a Workflow

Workflows are DAGs of pattern steps. Create them via the API or the
visual Workflow Builder UI.

**API:** `POST /api/v1/admin/orchestration/workflows`

```typescript
{
  name: "Customer Support Pipeline",
  slug: "customer-support-pipeline",
  description: "Routes customer queries, retrieves context, handles or escalates",
  workflowDefinition: {
    entryStepId: "classify",
    errorStrategy: "fallback",
    steps: [
      {
        id: "classify",
        name: "Classify Intent",
        type: "route",
        config: {
          prompt: "Classify the customer's intent: ORDER_QUERY, REFUND, COMPLAINT, GENERAL",
          routes: {
            "ORDER_QUERY": "lookup",
            "REFUND": "refund_check",
            "COMPLAINT": "escalate",
            "GENERAL": "respond"
          }
        },
        nextSteps: [
          { targetStepId: "lookup", condition: "ORDER_QUERY" },
          { targetStepId: "refund_check", condition: "REFUND" },
          { targetStepId: "escalate", condition: "COMPLAINT" },
          { targetStepId: "respond", condition: "GENERAL" }
        ]
      },
      {
        id: "lookup",
        name: "Look Up Order",
        type: "tool_call",
        config: { capability: "lookup_order" },
        nextSteps: [{ targetStepId: "respond" }]
      },
      {
        id: "refund_check",
        name: "Check Refund Eligibility",
        type: "tool_call",
        config: { capability: "check_refund" },
        nextSteps: [
          { targetStepId: "process_refund", condition: "eligible" },
          { targetStepId: "escalate", condition: "needs_approval" }
        ]
      },
      {
        id: "process_refund",
        name: "Process Refund",
        type: "tool_call",
        config: { capability: "process_refund" },
        nextSteps: [{ targetStepId: "respond" }]
      },
      {
        id: "escalate",
        name: "Escalate to Human",
        type: "human_approval",
        config: {
          message: "Customer issue requires human attention",
          timeout: 300
        },
        nextSteps: [{ targetStepId: "respond" }]
      },
      {
        id: "respond",
        name: "Generate Response",
        type: "llm_call",
        config: {
          prompt: "Generate a helpful response based on the context gathered"
        },
        nextSteps: []
      }
    ]
  },
  patternsUsed: [2, 5, 13]
}
```

---

## Adding a New Step Type

To add a step type for an emerging pattern (e.g., Orchestrator-Worker):

### Step 1: Create the executor

```typescript
// lib/orchestration/engine/executors/orchestrator-worker.ts
import { StepExecutor, StepContext, ExecutionEvent } from '../types';

export const executeOrchestratorWorker: StepExecutor = async function* (
  step,
  context
): AsyncIterable<ExecutionEvent> {
  // 1. Orchestrator analyses the task
  // 2. Dynamically spawns worker agents based on task needs
  // 3. Distributes sub-tasks to workers
  // 4. Collects and synthesises results
  // 5. Returns combined output
};
```

### Step 2: Register in the step registry

```typescript
// lib/orchestration/engine/step-registry.ts
import { executeOrchestratorWorker } from './executors/orchestrator-worker';

registry.registerStepType('orchestrator_worker', executeOrchestratorWorker, {
  name: 'Orchestrator-Worker',
  description: 'Dynamically spawns and manages worker agents based on task needs',
  icon: 'network',
  configSchema: z.object({
    orchestratorPrompt: z.string(),
    maxWorkers: z.number().default(5),
    workerModel: z.string().optional(),
  }),
  inputHandles: 1,
  outputHandles: 1,
});
```

It automatically appears in the workflow builder palette and can be
used in workflow definitions.

---

## File Reference

| What                       | Where                                               |
| -------------------------- | --------------------------------------------------- |
| All orchestration services | `lib/orchestration/`                                |
| LLM providers              | `lib/orchestration/llm/`                            |
| Capability handlers        | `lib/orchestration/capabilities/built-in/`          |
| Capability base class      | `lib/orchestration/capabilities/base-capability.ts` |
| Capability dispatcher      | `lib/orchestration/capabilities/dispatcher.ts`      |
| Step type registry         | `lib/orchestration/engine/step-registry.ts`         |
| Workflow engine            | `lib/orchestration/engine/orchestration-engine.ts`  |
| Chat handler               | `lib/orchestration/chat/streaming-handler.ts`       |
| Knowledge base search      | `lib/orchestration/knowledge/search.ts`             |
| Document manager           | `lib/orchestration/knowledge/document-manager.ts`   |
| API routes                 | `app/api/v1/admin/orchestration/`                   |
| Admin pages                | `app/admin/orchestration/`                          |
| UI components              | `components/admin/orchestration/`                   |
| Types                      | `types/orchestration.ts`                            |
| Validation schemas         | `lib/validations/orchestration.ts`                  |
| Seed data                  | `lib/orchestration/seed/chunks.json`                |

---

## Common Solution Patterns

### "I need a chatbot that answers questions from our docs"

Patterns: RAG (14) + Tool Use (5) + Guardrails (18)
Create: 1 agent, 1 capability (search_knowledge_base), upload docs via Knowledge Base API

### "I need to process incoming requests and route to specialists"

Patterns: Routing (2) + Multi-Agent (7) + Tool Use (5)
Create: 1 router agent + N specialist agents, each with domain-specific capabilities

### "I need to generate reports with quality checks"

Patterns: Chaining (1) + Reflection (4) + Tool Use (5)
Create: 1 agent, data-retrieval capabilities, a workflow with research → draft → critique → revise steps

### "I need to automate a multi-step process with human approval"

Patterns: Planning (6) + Tool Use (5) + HITL (13) + Guardrails (18)
Create: 1 agent with write capabilities marked requiresApproval: true, workflow with human_approval steps before irreversible actions

### "I need to monitor and improve agent quality over time"

Patterns: Evaluation (19) + Learning (9) + Reflection (4)
Create: evaluation sessions to test agents, review improvement suggestions, update system instructions based on findings
