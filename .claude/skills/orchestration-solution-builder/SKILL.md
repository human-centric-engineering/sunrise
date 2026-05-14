---
name: orchestration-solution-builder
description: |
  End-to-end orchestration solution builder for Sunrise. Takes a business
  problem — "build me a customer support chatbot", "I need an AI assistant
  that can look up orders and process refunds", "create a content review
  pipeline" — and produces everything needed: providers, agents, capabilities,
  knowledge base, and workflows. Handles the full implementation pipeline
  from problem description to running system. Use when building complete
  agentic solutions, implementing an architecture from agent-architect, or
  setting up a new agent system from scratch.
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

### Step 1: Ensure at least one provider is configured

Sunrise is provider-agnostic. **Fresh installs ship with no providers** — system-seeded agents have empty `provider` and `model` strings and rely on the runtime resolver (`lib/orchestration/llm/agent-resolver.ts`) to pick a model from the matrix at call time. Developer onboarding runs through the rewritten setup wizard, which detects available env vars and surfaces what is wired.

Check what is already configured:

```
GET /api/v1/admin/orchestration/providers
```

Create a provider (any compatible flavour — Anthropic, OpenAI / OpenAI-compatible, Voyage, Ollama, etc.):

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

The env-var detection registry (`lib/orchestration/llm/env-detection`) tells the setup wizard which providers can be one-click activated based on the running process's environment. Anthropic-only deployments are fine for chat; **add a separate embedding-capable provider (Voyage / OpenAI / local) if RAG is needed** — Anthropic does not offer embeddings.

```json
{
  "name": "Voyage AI",
  "slug": "voyage",
  "providerType": "voyage",
  "apiKeyEnvVar": "VOYAGE_API_KEY"
}
```

Default models per TaskType (`routing` / `chat` / `reasoning` / `embeddings` / `audio`) are admin-tunable via the model matrix. Agents can leave `provider` and `model` empty to inherit the matrix-resolved defaults — useful for solutions that should portably follow whatever the operator has configured.

### Step 2: Create agents

One agent per distinct role. Pick the model **by TaskType**, not by hardcoded name — that way solutions stay portable across the providers the operator has configured.

| Role              | TaskType    | Temperature | Why                             |
| ----------------- | ----------- | ----------- | ------------------------------- |
| Router/Classifier | `routing`   | 0.0         | Fast, cheap, deterministic      |
| Worker/Specialist | `chat`      | 0.5         | Capable, good balance           |
| Creative/Writer   | `chat`      | 0.7-0.9     | More varied output              |
| Reviewer/Judge    | `reasoning` | 0.1-0.3     | Consistent, critical evaluation |

Leave `provider` and `model` empty (`""`) to inherit the matrix-resolved default for the implied TaskType. Or pin an explicit slug pair when the solution genuinely needs a specific model.

```
POST /api/v1/admin/orchestration/agents
{
  "name": "Support Agent",
  "slug": "support-agent",
  "description": "Handles customer support queries",
  "systemInstructions": "You are a helpful customer support agent...",
  "provider": "",
  "model": "",
  "temperature": 0.5,
  "maxTokens": 4096,
  "monthlyBudgetUsd": 50,
  "knowledgeCategories": ["product-docs", "faq"]
}
```

**Multi-modal and voice input toggles** (all default off; effective state also depends on the org-wide kill switches in `AiOrchestrationSettings` and the resolved chat model carrying the matching capability):

| Field                 | Effect                                                                                     | Required model capability      |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| `enableImageInput`    | Surfaces an attach-image control on admin + embed chat surfaces                            | `vision`                       |
| `enableDocumentInput` | Surfaces an attach-PDF control                                                             | `documents`                    |
| `enableVoiceInput`    | Surfaces a microphone control; transcribed via the `audio`-capable provider (e.g. Whisper) | provider-level `transcribe?()` |

Agent updates are **versioned** — `PATCH /agents/:id` creates an `AiAgentVersion` row capturing the field changes. A tab-prefixed change summary appears in the version history panel; rollback works like workflow rollback (append-only forward step).

### Step 3: Create custom capabilities

For each external action, API call, or data lookup, create one capability. The 4-step pipeline:

1. **TypeScript class** — create `lib/orchestration/capabilities/built-in/<slug>.ts` extending `BaseCapability<TArgs, TData>`. Define a Zod schema for input validation and an OpenAI-compatible `functionDefinition`. The `slug` must match `functionDefinition.name` exactly.
2. **Registry entry** — import and register in `registerBuiltInCapabilities()` in `lib/orchestration/capabilities/registry.ts`
3. **DB row** — `POST /api/v1/admin/orchestration/capabilities` with `executionType: "internal"`, `executionHandler` set to the class name, and matching `slug`
4. **Agent binding** — `POST /api/v1/admin/orchestration/agents/{agentId}/capabilities` with `capabilityId` and `isEnabled: true`

For `api`/`webhook` execution types, skip steps 1-2 — no TypeScript class needed, the dispatcher makes HTTP calls directly. Set `executionHandler` to the target URL.

Use `/orchestration-capability-builder` for detailed templates and gotchas when building complex capabilities.

### Step 4: Bind built-in capabilities

The 11 built-in capabilities exist as `isSystem: true` rows. Don't recreate — just bind:

| Slug                         | Purpose                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `search_knowledge_base`      | Hybrid semantic + BM25 search over the knowledge base                 |
| `get_pattern_detail`         | Lookup an agentic design pattern by number                            |
| `estimate_workflow_cost`     | Pre-flight USD cost estimate for a workflow                           |
| `read_user_memory`           | Per-user persistent memory read                                       |
| `write_user_memory`          | Per-user persistent memory write                                      |
| `escalate_to_human`          | Dispatch the helpdesk / approval-queue webhook                        |
| `call_external_api`          | Recipe-driven HTTP integration (Postmark, Stripe, Slack, etc.)        |
| `run_workflow`               | Chat agent triggers a workflow (with optional `human_approval` pause) |
| `upload_to_storage`          | Upload base64 payloads to S3 / Vercel Blob / local                    |
| `apply_audit_changes`        | Apply approved model-audit field changes                              |
| `add_provider_models`        | Register new models from audit proposals                              |
| `deactivate_provider_models` | Soft-delete deprecated provider models                                |

Bind with:

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
- `call_external_api` — agents that need to send email, post to chat, charge payments, render PDFs etc. **Prefer the recipe-driven approach over building a new capability** — recipes live in `.context/orchestration/recipes/`.
- `run_workflow` — chat agents that need to trigger a multi-step pipeline (and optionally pause for in-chat user approval). Per-agent `customConfig.allowedWorkflowSlugs` whitelist required.
- `upload_to_storage` — agents that produce binary outputs needing durable storage (e.g. rendered PDFs).

### Step 5: Set up knowledge base (if using RAG)

1. **Ensure an embedding-capable model is active** — embedding resolution is dynamic via `lib/orchestration/llm/embedding-models.ts` (DB-backed `AiProviderModel` rows tagged with `embedding` capability). Voyage AI, OpenAI `text-embedding-3-*`, or local Ollama all work. Anthropic does NOT offer embeddings.
2. **Upload documents** — `POST /api/v1/admin/orchestration/knowledge/documents` (multipart/form-data with `file` and optional `category`). Supported formats: Markdown, text, **CSV (row-atomic)**, EPUB, DOCX, and PDF. PDFs use a two-step flow: `previewDocument()` → admin review → `confirmPreview()`.
3. **Generate embeddings** — `POST /api/v1/admin/orchestration/knowledge/embed` (embeddings are NOT auto-generated on upload). Check status: `GET /api/v1/admin/orchestration/knowledge/embedding-status`.
4. **Scope to agents** — `PATCH /api/v1/admin/orchestration/agents/{id}` with `knowledgeCategories: ["category1", "category2"]`. Empty array = agent sees all categories.
5. **Bind capability** — bind the built-in `search_knowledge_base` capability to the agent (Step 4 process).
6. **Sanity-check the corpus** — admin Knowledge → **Visualize** tab renders structure, embedded-graph, and UMAP projection views. Useful for spotting mis-categorised uploads before they pollute retrieval.

Use `/orchestration-knowledge-builder` for detailed chunking configuration (structural / semantic / CSV), hybrid-search tuning (`bm25Weight`, not `keywordWeight`), and gotchas.

### Step 6: Compose the workflow (if needed)

Simple solutions (single agent chat) don't need a workflow. For multi-step processing:

1. **Select a template** — 12 built-in templates in `prisma/seeds/data/templates/` (`customer-support`, `content-pipeline`, `research-agent`, `cited-knowledge-advisor`, `scheduled-source-monitor`, `provider-model-audit`, etc.). Start from the closest one.
2. **Define the DAG** — `WorkflowDefinition` has `entryStepId`, `errorStrategy`, and `steps[]`. Each step has `id`, `name`, `type` (15 types available), `config`, and `nextSteps[]` (edges). Key step types: `llm_call`, `route`, `human_approval`, `tool_call`, `rag_retrieve`, `parallel`, `reflect`, `agent_call`, `orchestrator`.
3. **Configure error handling** — per-step `errorStrategy`: `retry` (transient failures), `fallback` (alternative path), `skip` (non-critical), `fail` (critical). Set `budgetLimitUsd` for cost caps (80% warning, 100% stop).
4. **Validate** — `validateWorkflow()` checks DAG structure (cycles, orphans, required config). `semanticValidateWorkflow()` checks DB references (model, capability, agent slugs exist).
5. **Create** v1 atomically via API (`POST` creates the workflow row and v1 in one transaction; `patternsUsed` is an `Int[]` of pattern numbers):

```
POST /api/v1/admin/orchestration/workflows
{
  "name": "Customer Support Pipeline",
  "slug": "customer-support",
  "workflowDefinition": { ... },
  "patternsUsed": [2, 5, 14],
  "budgetLimitUsd": 5.00,
  "isActive": true
}
```

6. **Iterate via draft / publish** — workflows are immutable-versioned. After v1, `PATCH /workflows/:id` writes to `draftDefinition`; nothing goes live until `POST /workflows/:id/publish` snapshots the draft as a new `AiWorkflowVersion` and repoints `publishedVersionId`. Use `POST /workflows/:id/rollback` to forward-step to a prior version (append-only, never destructive).

7. **Decide how the workflow is triggered**. Five entry points:
   - Manual / admin run (`POST /executions`)
   - Streaming UI run (`POST /workflows/:id/execute-stream`)
   - Scheduled cron via `AiWorkflowSchedule`
   - Inbound trigger at `POST /api/v1/inbound/:channel/:slug` (Slack / Postmark / generic HMAC)
   - Invoked by a chat agent through the `run_workflow` capability

Template variables in prompts: `{{input}}` (workflow input), `{{previous.output}}` (last step), `{{stepId.output}}` (specific step).

Use `/orchestration-workflow-builder` for the full versioning lifecycle, step config schemas, triggering surfaces, and crash-recovery semantics.

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

## Testing

Every solution should have tests covering its custom components. Follow patterns in `tests/unit/lib/orchestration/`.

### What to test per component

| Component    | Test location                                    | What to test                                                  |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| Capabilities | `tests/unit/lib/orchestration/capabilities/`     | Zod validation, execute success/error, slug consistency       |
| Workflows    | `tests/unit/lib/orchestration/workflows/`        | DAG validation, semantic validation, step config completeness |
| Knowledge    | `tests/unit/lib/orchestration/knowledge/`        | Chunking output, search filtering, document lifecycle         |
| Engine       | `tests/unit/lib/orchestration/engine/executors/` | Step executor logic, template interpolation, error strategies |

### Running tests

```bash
# All orchestration tests
npm run test -- tests/unit/lib/orchestration/

# Specific subsystem
npm run test -- tests/unit/lib/orchestration/capabilities/
npm run test -- tests/unit/lib/orchestration/workflows/

# Full validation
npm run validate
```

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
- [ ] Tests written and passing for all custom capabilities and workflows
- [ ] `npm run validate` passes (type-check + lint + format)
- [ ] Run `/pre-pr` before merging the feature branch
