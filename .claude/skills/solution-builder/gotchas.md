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

The 6 built-in capabilities (`search_knowledge_base`, `get_pattern_detail`, `estimate_workflow_cost`, `read_user_memory`, `write_user_memory`, `escalate_to_human`) already exist in the database. **Do not create new capability rows with the same slugs.** Just bind the existing ones to your agents.

## Knowledge Base Embedding Is a Separate Step

Uploading documents creates chunks but does **not** generate embeddings. You must explicitly call `POST /knowledge/embed` after uploading. Without this step, vector search returns nothing and RAG-enabled agents can't find documents.

## patternsUsed Is Metadata Only

The `patternsUsed` field on workflows is **not enforced** — it doesn't affect execution. It's documentation metadata for the admin UI. But it's useful for discoverability, so populate it accurately.

## Testing Agents Before Workflows

Always test agents individually via the Test Chat tab before wiring them into workflows. Debugging a failing agent inside a workflow is much harder — you can't see the intermediate prompts and responses as easily.

## Agent Model + Provider Must Match

The `model` field on an agent must be a model slug available on the specified `provider`. If the provider doesn't have that model registered, the agent will fail at runtime. Check available models via:

```
GET /api/v1/admin/orchestration/providers/{id}/models
```

## Workflow Budget vs Agent Budget

These are separate controls:

- **`budgetLimitUsd` on workflow** — per-execution cap; resets each run
- **`monthlyBudgetUsd` on agent** — monthly rolling cap across all conversations

Both should be set in production. A workflow without a budget can run up unlimited costs in a single execution.

## Simple Solutions Don't Need Workflows

A single agent with capabilities works fine for chat-based interactions. Workflows add complexity — only use them when you need multi-step processing, routing, approval gates, or parallel execution. Don't over-engineer.
