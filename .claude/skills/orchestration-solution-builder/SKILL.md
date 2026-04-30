---
name: orchestration-solution-builder
version: 1.0.0
description: |
  End-to-end orchestration solution builder for Sunrise. Takes a business
  problem (or architecture from agent-architect) and produces everything
  needed: providers, agents, capabilities, knowledge base, and workflows.
  The meta-skill that orchestrates the full implementation pipeline.
  Use when building complete agentic solutions from scratch.

triggers:
  - 'build orchestration solution'
  - 'build agentic solution'
  - 'create agent system'
  - 'build agent pipeline'
  - 'implement orchestration'
  - 'implement this design'
  - 'end to end agent'

contexts:
  - '.context/admin/orchestration.md'
  - '.context/admin/orchestration-solution-builder.md'
  - '.context/admin/orchestration-capabilities-guide.md'
  - '.context/admin/orchestration-workflows-guide.md'
  - '.context/orchestration/knowledge.md'
  - '.context/orchestration/engine.md'
  - '.context/orchestration/capabilities.md'
  - 'lib/orchestration/capabilities/built-in/*.ts'
  - 'lib/orchestration/capabilities/registry.ts'
  - 'lib/orchestration/engine/step-registry.ts'
  - 'prisma/seeds/data/templates/*.ts'
  - 'types/orchestration.ts'
  - 'lib/validations/orchestration.ts'

mcp_integrations:
  context7:
    libraries:
      - zod: '/colinhacks/zod'

parameters:
  complexity_tiers: ['simple', 'moderate', 'complex']
  default_provider: 'anthropic'
  default_model_routing: 'claude-haiku-4-5'
  default_model_chat: 'claude-sonnet-4-6'
---

# Solution Builder Skill

## Mission

You build complete agentic solutions from problem description to running system. You handle the full pipeline: providers, agents, capabilities, knowledge base, and workflows — in the correct order, with proper wiring. You pick up where `agent-architect` leaves off (or do both design and implementation if no architecture exists yet).

## Complexity Tiers

### Simple (single agent, no workflow)

**Example:** FAQ chatbot, single-purpose assistant

- 1 agent with built-in capabilities
- No custom capabilities needed
- No workflow — agent handles everything via chat
- Setup: provider → agent → bind capabilities → test

### Moderate (1-2 agents, custom capabilities, workflow)

**Example:** Customer support with order lookup, content pipeline

- 1-2 agents with distinct roles
- 1-3 custom capabilities
- Workflow with 3-8 steps
- Setup: provider → agents → capabilities + registry → workflow → test

### Complex (multi-agent, workflows, approval gates, knowledge base)

**Example:** Autonomous research, multi-agent review pipeline

- 3+ agents with specialised roles
- Multiple custom capabilities + built-in bindings
- Multi-branch workflow with approval gates
- Knowledge base with scoped categories
- Setup: provider → agents → capabilities + registry → knowledge base → workflow → test

## The 8-Step Implementation Process

**Order matters.** Each step depends on the previous ones.

### Step 1: Ensure provider exists

Check if the provider is already configured:

```
GET /api/v1/admin/orchestration/providers
```

If not, create one:

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

For RAG, also create an embedding provider (Voyage AI recommended):

```json
{
  "name": "Voyage AI",
  "slug": "voyage",
  "providerType": "voyage",
  "apiKeyEnvVar": "VOYAGE_API_KEY"
}
```

### Step 2: Create agents

One agent per distinct role. Model selection by role:

| Role              | Model             | Temperature | Why                             |
| ----------------- | ----------------- | ----------- | ------------------------------- |
| Router/Classifier | claude-haiku-4-5  | 0.0         | Fast, cheap, deterministic      |
| Worker/Specialist | claude-sonnet-4-6 | 0.5         | Capable, good balance           |
| Creative/Writer   | claude-sonnet-4-6 | 0.7-0.9     | More varied output              |
| Reviewer/Judge    | claude-sonnet-4-6 | 0.1-0.3     | Consistent, critical evaluation |

```
POST /api/v1/admin/orchestration/agents
{
  "name": "Support Agent",
  "slug": "support-agent",
  "description": "Handles customer support queries",
  "systemInstructions": "You are a helpful customer support agent...",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.5,
  "maxTokens": 4096,
  "monthlyBudgetUsd": 50,
  "knowledgeCategories": ["product-docs", "faq"]
}
```

### Step 3: Create custom capabilities

For each external action, API call, or data lookup, create one capability. Follow the 4-step pipeline from the capability-builder skill:

1. **TypeScript class** — `lib/orchestration/capabilities/built-in/<slug>.ts`
2. **Registry entry** — add to `registerBuiltInCapabilities()` in `registry.ts`
3. **DB row** — `POST /capabilities` with matching slug
4. **Agent binding** — `POST /agents/{id}/capabilities`

For API/webhook capabilities, skip steps 1-2 (no code needed).

### Step 4: Bind built-in capabilities

The 6 built-in capabilities exist as `isSystem: true` rows. Don't recreate — just bind:

```
# Find the capability ID
GET /api/v1/admin/orchestration/capabilities?slug=search_knowledge_base

# Bind to agent
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{
  "capabilityId": "<id>",
  "isEnabled": true
}
```

Common bindings:

- `search_knowledge_base` — any RAG-enabled agent
- `escalate_to_human` — agents handling sensitive topics
- `read_user_memory` / `write_user_memory` — conversational agents needing memory

### Step 5: Set up knowledge base (if using RAG)

1. Upload documents with categories
2. Generate embeddings: `POST /knowledge/embed`
3. Set agent `knowledgeCategories` to scope access
4. Bind `search_knowledge_base` to the agent (Step 4)

See the knowledge-builder skill for full details.

### Step 6: Compose the workflow (if needed)

Simple solutions (single agent chat) don't need a workflow. For multi-step processing:

1. Start from the closest built-in template (9 available)
2. Customise steps, prompts, and error strategies
3. Validate with `validateWorkflow()` and `semanticValidateWorkflow()`

```
POST /api/v1/admin/orchestration/workflows
{
  "name": "Customer Support Pipeline",
  "slug": "customer-support",
  "workflowDefinition": { ... },
  "patternsUsed": ["routing", "rag", "tool_use"],
  "budgetLimitUsd": 5.00,
  "isActive": true
}
```

See the workflow-builder skill for full details.

### Step 7: Test

**Agent test** — use the Test Chat tab on the agent edit page:

- Test with representative inputs
- Verify capability calls work
- Check knowledge base search returns relevant results

**Workflow test** — execute with test input:

```
POST /api/v1/admin/orchestration/executions
{
  "workflowId": "<id>",
  "inputData": { "user_query": "test input" }
}
```

Check execution traces for:

- All steps complete successfully
- Token usage is reasonable
- Cost is within budget
- Error strategies trigger correctly

### Step 8: Production hardening

| Control             | Where                      | Purpose                               |
| ------------------- | -------------------------- | ------------------------------------- |
| Agent budget        | `monthlyBudgetUsd`         | Cap monthly spend per agent           |
| Workflow budget     | `budgetLimitUsd`           | Cap spend per workflow execution      |
| Rate limits         | `rateLimit` per capability | Prevent runaway tool calls            |
| Approval gates      | `requiresApproval`         | Human review for sensitive operations |
| Fallback providers  | Provider config            | Resilience if primary provider fails  |
| Error strategies    | Per-step `errorStrategy`   | Graceful degradation on step failures |
| Input/output guards | Guard steps in workflow    | Safety checks on content              |

## Agent Configuration Patterns

### Naming conventions

| Convention       | Example                           |
| ---------------- | --------------------------------- |
| Agent slugs      | `support-agent`, `content-writer` |
| Capability slugs | `lookup_order`, `process_refund`  |
| Workflow slugs   | `customer-support-pipeline`       |

### System instructions template

```
You are [role description]. Your responsibilities:
1. [Primary task]
2. [Secondary task]
3. [Constraints/guardrails]

When using tools:
- [Tool usage guidance]
- [Error handling guidance]

Always:
- [Quality standards]
- [Tone/voice guidelines]
```

## Capability Identification Checklist

For each of these, consider whether a capability is needed:

- [ ] Does the agent need to look up data from a database or API?
- [ ] Does the agent need to create, update, or delete records?
- [ ] Does the agent need to send notifications (email, Slack, etc.)?
- [ ] Does the agent need to search documents or knowledge?
- [ ] Does the agent need to escalate to a human?
- [ ] Does the agent need to call external services?

Each "yes" = one capability. Use built-in capabilities where they fit before creating custom ones.

## Verification Checklist

- [ ] Provider configured and API key set
- [ ] All agents created with appropriate models and temperatures
- [ ] Custom capabilities: class + registry + DB row + agent binding (all 4 steps)
- [ ] Built-in capabilities bound (not recreated)
- [ ] Knowledge base: documents uploaded, embeddings generated, categories scoped
- [ ] Workflow: validates, all steps have required config, error strategies set
- [ ] Budget limits configured (agent-level and workflow-level)
- [ ] Tested via agent chat and workflow execution
- [ ] Rate limits set on all capabilities
- [ ] Approval gates on sensitive operations
