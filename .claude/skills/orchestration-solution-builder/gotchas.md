# Solution Builder — Gotchas

## Order of Creation Matters

Dependencies enforce this sequence:

1. **Providers** — agents reference provider slugs
2. **Agents** — capabilities bind to agents, workflows reference agent slugs
3. **Capabilities** — must exist in registry before workflows that reference them
4. **Knowledge base** — agents need `knowledgeCategories` set, embedding provider must exist
5. **Workflows** — semantic validator checks agent slugs and capability slugs exist

Creating things out of order causes validation failures or silent misconfigurations.

## Built-in Capabilities Are isSystem: true

The built-in capabilities (`search_knowledge_base`, `get_pattern_detail`, `estimate_workflow_cost`, `read_user_memory`, `write_user_memory`, `escalate_to_human`, `call_external_api`, `run_workflow`, `upload_to_storage`, `apply_audit_changes`, `add_provider_models`, `deactivate_provider_models`) already exist in the database. **Do not create new capability rows with the same slugs.** Just bind the existing ones to your agents.

## Knowledge Base Embedding Is a Separate Step

Uploading documents creates chunks but does **not** generate embeddings. You must explicitly call `POST /knowledge/embed` after uploading. Without this step, vector search returns nothing and RAG-enabled agents can't find documents.

## patternsUsed Is Metadata Only

The `patternsUsed` field on workflows is **not enforced** — it doesn't affect execution. It's documentation metadata for the admin UI. But it's useful for discoverability, so populate it accurately.

## Testing Agents Before Workflows

Always test agents individually via the Test Chat tab before wiring them into workflows. Debugging a failing agent inside a workflow is much harder — you can't see the intermediate prompts and responses as easily.

## Agent Model + Provider Must Match (Or Both Be Empty)

If you pin `provider` and `model` on an agent, the model slug must be registered on that provider. If the provider doesn't have that model registered, the agent will fail at runtime. Check available models via:

```
GET /api/v1/admin/orchestration/providers/{id}/models
```

**Alternative:** set both `provider` and `model` to empty strings (`""`) — the runtime resolver (`lib/orchestration/llm/agent-resolver.ts`) then picks the matrix-resolved default for the implied TaskType. This is how system-seeded agents work on fresh installs, and it keeps solutions portable across the providers each operator has wired.

## Prefer Recipes Over New Capabilities For HTTP-Shaped Integrations

For sending email, posting to Slack, charging payments, rendering PDFs, etc., bind `call_external_api` with the appropriate recipe from `.context/orchestration/recipes/` instead of writing a new capability class. Recipes provide the per-agent `customConfig` JSON, vendor variants, and worked examples. Building a `StripeCapability` when `payment-charge` recipe binding gets the same outcome with no new code is a maintainability regression.

## Workflow Edits Don't Go Live Until Publish

`PATCH /workflows/:id` writes to `draftDefinition`. Running schedules, inbound triggers, and `run_workflow` calls continue to fire the previously-published version until `POST /workflows/:id/publish` snapshots the draft. A common confusion: "I saved the workflow but the change isn't running." Publish to roll it forward.

## Agent Edits Are Versioned

`PATCH /agents/:id` creates an `AiAgentVersion` row capturing the field changes — agents are immutable-versioned alongside workflows. Useful for auditing prompt regressions; the version-history panel renders a tab-prefixed change summary and Before/After diff per field.

## Workflow Budget vs Agent Budget

These are separate controls:

- **`budgetLimitUsd` on workflow** — per-execution cap; resets each run
- **`monthlyBudgetUsd` on agent** — monthly rolling cap across all conversations

Both should be set in production. A workflow without a budget can run up unlimited costs in a single execution.

## Simple Solutions Don't Need Workflows

A single agent with capabilities works fine for chat-based interactions. Workflows add complexity — only use them when you need multi-step processing, routing, approval gates, or parallel execution. Don't over-engineer.
