# Provider Model Audit — Walkthrough Guide

The Provider Model Audit workflow is a built-in, genuine use case that doubles as a stress test for the entire agentic orchestration system. It exercises 11 of 15 step types end-to-end: LLM calls, routing, parallelisation, agent delegation, external HTTP calls, guardrails, reflection, evaluation, human-in-the-loop approval, capability dispatch, and notifications.

By running this workflow yourself, you will see how agents, capabilities, workflows, the approval queue, and the execution engine all work together — and you will end up with a real audit of your provider model data.

## What the workflow does

The workflow audits your provider model registry (the matrix of AI models you have configured) to check whether the attributes — tier role, reasoning depth, latency, cost efficiency, etc. — are still accurate. It also discovers new models from your providers and flags deprecated ones.

### Step-by-step flow

```
1. load_models          (llm_call)        Parse input into structured model data
       ↓
2. search_provider_info (external_call)   Search the web for current model info
       ↓                                  ⚠ Optional — skipped if no API key
3. classify_models      (route)           Route by model type: chat / embedding / mixed
       ↓
4. audit_models         (parallel)        Fan out to 3 concurrent branches:
   ├─ 5a. analyse_chat         (llm_call)        Evaluate chat model attributes
   ├─ 5b. analyse_embedding    (llm_call)        Evaluate embedding model attributes
   └─ 5c. discover_new_models  (agent_call)      🤖 Delegate to provider-model-auditor agent
       ↓
6. validate_proposals   (guard)           Validate proposed values against enum schemas
       ↓
7. refine_findings      (reflect)         Draft → critique → revise loop
       ↓
8. score_audit          (evaluate)        Score quality on 1-10 scale (5 dimensions)
       ↓
9. review_changes       (human_approval)  ⏸ Pause for admin: Accept / Reject / Modify per change
       ↓
10. apply_changes       (tool_call)       🔧 apply_audit_changes capability
       ↓
11. add_new_models      (tool_call)       🔧 add_provider_models capability
       ↓
12. deactivate_models   (tool_call)       🔧 deactivate_provider_models capability
       ↓
13. compile_report      (agent_call)      🤖 Delegate to audit-report-writer agent
       ↓
14. notify_complete     (send_notification)  Email the consolidated report
```

### What makes each step type interesting

| Step type               | What you will see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`llm_call`**          | Raw LLM completion with structured JSON output. The engine interpolates `{{input}}` and prior step outputs into prompts.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **`external_call`**     | HTTP request to Brave Search API. Demonstrates auth, response transformation (jmespath), and graceful degradation via `errorStrategy: skip`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`route`**             | LLM classifies the input and the engine branches to different paths based on the classification.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`parallel`**          | Three branches run concurrently. The engine waits for all to complete (`wait-all` strategy).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`agent_call`**        | The `discover_new_models` step delegates to the `provider-model-auditor` agent, which has its own system instructions, model config, and 5 bound capabilities. The `compile_report` step delegates to a different agent (`audit-report-writer`) with zero capabilities — pure synthesis.                                                                                                                                                                                                                                                                |
| **`guard`**             | The engine validates all proposed enum values. If validation fails, it retries up to 2 times before blocking.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`reflect`**           | A draft-critique-revise loop. The engine generates a critique of the proposals, then revises them. You can see the iteration count in the execution trace.                                                                                                                                                                                                                                                                                                                                                                                              |
| **`evaluate`**          | Scores the audit on 5 dimensions (accuracy, completeness, specificity, confidence calibration, consistency). The threshold is 6/10.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`human_approval`**    | The workflow pauses. You will see it appear in the **Approval Queue** with an orange badge in the sidebar. The audit workflow renders the **structured viewer** — three sections (existing-model changes, new model proposals, deactivations) with per-change Accept / Reject / Modify controls (enum-aware Selects for fields like `tierRole`, text inputs for free-text). Your filtered selection flows downstream to the apply capabilities. See [`orchestration-approvals.md`](./orchestration-approvals.md#structured-approval-views) for details. |
| **`tool_call`**         | Three capabilities fire in sequence: apply changes, add models, deactivate models. Each goes through the capability dispatcher (Zod validation, rate limiting, execution, cost logging).                                                                                                                                                                                                                                                                                                                                                                |
| **`send_notification`** | Sends an email with the consolidated report (from the `compile_report` agent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Prerequisites

### Required

1. **An LLM provider configured and active**
   - Navigate to **Orchestration > Providers** in the sidebar
   - You need at least one provider (e.g. Anthropic) with a valid API key
   - The `ANTHROPIC_API_KEY` environment variable must be set in `.env.local`
   - Click **Test Connection** on the provider card to verify

2. **Provider models seeded**
   - Run `npm run db:seed` if you haven't already — this populates the model registry
   - Navigate to **Orchestration > Providers** and click the **Model Matrix** tab to see the seeded models

3. **The workflow and agents exist in the database**
   - These are created by `npm run db:seed` (seed unit `010-model-auditor`)
   - Navigate to **Orchestration > Workflows** — you should see "Provider Model Audit" in the list
   - Navigate to **Orchestration > Agents** — you should see "Provider Model Auditor" and "Audit Report Writer"

### Optional (for web search enrichment)

4. **Brave Search API key** — for the `search_provider_info` step
   - Sign up at [brave.com/search/api](https://brave.com/search/api/) (free tier: 1,000 queries/month)
   - Add to `.env.local`: `BRAVE_SEARCH_API_KEY=your_key_here`
   - Add `api.search.brave.com` to `ORCHESTRATION_ALLOWED_HOSTS` in `.env.local`
   - **If you skip this**, the step is silently skipped and the workflow continues without web context — no errors, no impact on the core audit

## Running the audit — step by step

### 1. Prepare test data (the tamper test)

The best way to see the workflow in action is to deliberately tamper with a model's data and see if the audit catches it.

1. Navigate to **Orchestration > Providers**
2. Click the **Model Matrix** tab
3. Pick a well-known model (e.g. `claude-sonnet-4-6` from Anthropic)
4. Click **Edit** on that model
5. Change a field to something obviously wrong — for example:
   - Change `reasoningDepth` from `high` to `none`
   - Or change `tierRole` from `worker` to `embedding`
6. Save the change
7. Note down what you changed — you will check whether the audit catches it

### 2. Get the model data for input

The workflow needs model data as input. The easiest way is to copy it from the API:

1. Open a terminal and run:

   ```bash
   curl -s http://localhost:3000/api/v1/admin/orchestration/providers/models \
     -H "Cookie: $(cat .cookie)" | jq '.data' > /tmp/models.json
   ```

   Or simply navigate to the **Model Matrix** tab and use the browser's network inspector to copy the JSON response.

2. Alternatively, just describe what you want audited in plain text — the `load_models` step will parse it:
   ```json
   {
     "query": "Audit all Anthropic models for accuracy"
   }
   ```

### 3. Open the workflow

1. Navigate to **Orchestration > Workflows** in the sidebar
2. Find **"Provider Model Audit"** in the table and click on it
3. You are now in the **Workflow Builder** — you can see the visual DAG with all 14 steps connected
4. Scroll through the canvas to see how steps connect — drag to pan, scroll to zoom
5. Click on any step block to see its configuration in the right panel

### 4. Execute the workflow

1. Click the **Execute** button in the top toolbar
2. The **Execution Input Dialog** opens — paste your model data JSON or a simple query
3. Optionally set a **Budget Limit** (e.g. `$1.00` for testing)
4. Click **Execute Workflow**
5. The **Execution Panel** opens on the right side, showing a live SSE stream:
   - Each step appears as it starts and completes
   - You can see tokens used, cost, and duration per step
   - Watch the `search_provider_info` step — if you configured Brave Search, you will see web results. If not, it shows "skipped"
   - The `discover_new_models` step shows `agent_call` — the engine loaded the agent's system instructions, resolved its provider, and ran a complete chat turn

### 5. Approve the changes

1. When the workflow reaches `review_changes`, it **pauses**
2. The execution panel shows "Awaiting approval"
3. Look at the sidebar — the **Approval Queue** item now has an **orange badge** showing "1"
4. Click **Approval Queue** in the sidebar
5. Expand the row. Instead of a wall of JSON, the **structured viewer** renders three sections:
   - **Proposed changes to existing models** — one parent per model, expandable into a per-field changes table (field, current, proposed, confidence, reason)
   - **Proposed new models** — one card per new model with its full classification
   - **Proposed deactivations** — one row per deprecated model with the reason
   - Quality score from the evaluation step appears at the top
6. Review the proposals — check if the tampered field was detected:
   - Look for your model in the changes list
   - The `proposedValue` should correct your deliberate tamper
   - The `confidence` should be "high" for obvious corrections
7. Decide per change:
   - **Accept** is the default for every change — leave it alone to apply
   - **Reject** any individual change you disagree with (use the per-row Reject button); the rest still apply
   - **Modify** to edit the proposed value before accepting — for enum fields (`tierRole`, `latency`, etc.) you get a dropdown of valid values; for free-text fields (`bestRole`, `description`) you get an input. A "Modified" badge marks the edited row.
8. Click **Approve selected** (add optional notes) — only the accepted (and possibly modified) changes flow downstream
   - Or click **Reject** with a reason to cancel the whole workflow

### 6. See the results

After approval, the workflow continues:

1. The three `tool_call` steps apply changes, add models, and deactivate models
2. The `compile_report` agent synthesises everything into a structured report
3. The `notify_complete` step sends the report via email (to the configured address)

**To see the full execution trace:**

1. Navigate to **Orchestration > Executions** in the sidebar
2. Find the completed execution and click on it
3. The **Execution Detail** page shows:
   - Overall status, total tokens, total cost, duration
   - **Input Data** — the JSON you provided
   - **Output Data** — all step outputs indexed by step ID
   - **Step Timeline** — click any step to expand its trace:
     - The prompt that was sent
     - The LLM response
     - Tokens and cost for that step
     - Duration
4. Verify your tamper was caught: check the `apply_changes` step output to confirm the correction was applied

**To verify the fix:**

1. Navigate back to **Orchestration > Providers > Model Matrix**
2. Find the model you tampered with
3. Confirm the field was corrected back to its proper value

## How attribution works

Each producer step (`analyse_chat`, `analyse_embedding`, `discover_new_models`) is required to attribute every claim it makes. The output JSON carries a `sources` array per change, per new model, and per deactivation:

```json
{
  "field": "tierRole",
  "currentValue": "embedding",
  "proposedValue": "thinking",
  "reason": "Qwen2.5-72B is a general-purpose LLM, not an embedding model",
  "confidence": "high",
  "sources": [
    {
      "source": "web_search",
      "confidence": "high",
      "reference": "https://qwenlm.github.io/blog/qwen2.5/",
      "snippet": "Qwen2.5 series flagship: 72B-parameter general-purpose language model with strong reasoning and coding…",
      "note": "Official Qwen release notes describe it as a chat/reasoning model, not embedding"
    }
  ]
}
```

The web search step (`search_provider_info`) renders Brave results as a numbered block in each producer's prompt: `[1] title — url\nsnippet`. The LLM is told to cite by `[N]` when a claim is search-backed and to fall back to `training_knowledge` (capped at `medium`/`low` confidence) when it isn't.

The `validate_proposals` guard rejects any proposal whose `sources` array is missing or malformed, using the existing 2-retry budget. The retry context surfaces the offending object so the producer can re-attempt with attribution.

The approval UI renders each source as a colour-coded pill: `web · qwenlm.github.io ●●●` (blue, high confidence), `training · ●○○` (amber, low confidence), `kb · doc.pdf ●●●` (emerald). Hover or focus pops a tooltip with the reference, snippet, and note. Admins reviewing a row of proposed changes can scan the pills and spot a stream of `training · low` claims that warrant rejection vs `web · high` claims that warrant acceptance.

The same pills appear in the trace viewer (post-execution) under the Output panel of each step that emitted sources. See [`.context/orchestration/provenance.md`](../orchestration/provenance.md) for the full contract.

## What to explore next

Now that you have seen the full workflow in action, explore these areas:

| What                       | Where                                             | Why                                                                                                                      |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Agent configuration**    | Orchestration > Agents > "Provider Model Auditor" | See the system instructions, model config, and 5 bound capabilities that the `discover_new_models` step used             |
| **Capability definitions** | Orchestration > Capabilities                      | See how `apply_audit_changes`, `add_provider_models`, and `deactivate_provider_models` are defined with function schemas |
| **Cost tracking**          | Orchestration > Costs & Budget                    | See the cost breakdown for your execution — per-step and per-agent                                                       |
| **Workflow builder**       | Click on the workflow again                       | Try modifying a step's prompt, or add a new step to the DAG                                                              |
| **Execution comparison**   | Run the audit again with different input          | Compare two executions side by side in the Executions list                                                               |
| **Learning patterns**      | Orchestration > Learning                          | Read about the 10 design patterns this workflow uses                                                                     |

## Under the hood

For developers who want to understand the engine:

| Component                | File                                                   | What it does                                              |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------- |
| Workflow definition      | `prisma/seeds/data/templates/provider-model-audit.ts`  | The complete step DAG with prompts, configs, and edges    |
| Agent + capability seeds | `prisma/seeds/010-model-auditor.ts`                    | Creates both agents, 3 capabilities, and the workflow     |
| Orchestration engine     | `lib/orchestration/engine/orchestration-engine.ts`     | DAG walker — runs steps, handles errors, emits SSE events |
| Agent call executor      | `lib/orchestration/engine/executors/agent-call.ts`     | Loads agent config, resolves provider, runs tool loop     |
| External call executor   | `lib/orchestration/engine/executors/external-call.ts`  | HTTP client with auth, rate limiting, response transform  |
| Capability dispatcher    | `lib/orchestration/capabilities/dispatcher.ts`         | Routes tool calls to capability handlers                  |
| Approval flow            | `lib/orchestration/engine/executors/human-approval.ts` | Throws `PausedForApproval`, engine persists state         |
| Execution context        | `lib/orchestration/engine/context.ts`                  | Tracks step outputs, tokens, cost, variables              |
