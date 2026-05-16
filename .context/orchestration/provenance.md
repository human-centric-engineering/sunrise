# Workflow-Step Provenance

Workflow LLM and agent steps that produce claims (a misclassification proposal, an extracted quote, a regulatory advisory) can carry a typed `sources` array on their structured JSON output describing where each claim came from. The engine lifts that array onto `ExecutionTraceEntry.provenance`; the structured approval UI and the trace viewer render it as colour-coded pills with hover-out detail.

Use this when a workflow's LLM step has access to two or more knowledge channels (training, web search, knowledge base, prior step outputs, external API responses) and the admin reviewing the result needs to know which channel grounded each claim. Citations live in the chat handler (item 2 — done); this is the analogous primitive for workflow step output.

## Why this exists

Concrete failure mode that motivated the contract: the [provider model audit workflow](../admin/orchestration-provider-audit-guide.md) was proposing that **Qwen2.5-72B is an embedding engine**. The producer LLM steps injected web search results as raw context, but never had to cite which result supported a claim. Training-knowledge confabulations and search-grounded facts showed up with the same `confidence: 'high'` label, and the approval UI rendered both as identical free-text `reason` cells. The admin had no signal to tell them apart.

Forcing attribution per claim turns "looks like an embedding model" into a checkable signal: a `training_knowledge · low` pill rendered next to the change cell tells the admin to verify before approving, and a `web · provider.com` pill links straight to the source the LLM cited.

## The contract

```typescript
interface ProvenanceItem {
  source:
    | 'training_knowledge'
    | 'web_search'
    | 'knowledge_base'
    | 'prior_step'
    | 'external_call'
    | 'user_input';
  confidence: 'high' | 'medium' | 'low';
  reference?: string; // URL / chunk id / step path
  snippet?: string; // ≤400-char quoted excerpt
  stepId?: string; // upstream step id (when source !== 'training_knowledge')
  note?: string; // free-text rationale
}
```

Authoritative source: [`lib/orchestration/provenance/types.ts`](../../lib/orchestration/provenance/types.ts).

### Rules of the road

- `training_knowledge` claims are **never** `confidence: 'high'`. If you cannot tie a claim to an external source, the model's own assertion is at best `medium` and a name-pattern inference is `low`.
- `web_search`, `knowledge_base`, `external_call`, and `prior_step` sources **must** carry a non-empty `reference`. Use the URL for web search, the chunk id for the KB, the step path (`load_models.output.models[3].slug`) for prior steps.
- `snippet` is the LLM's quote of the relevant text. Cap at 200 chars in producer prompts; the schema allows 400 so the LLM has slack.
- `note` is the LLM's one-line "what this source told me" rationale. Optional but strongly preferred.

## How it flows

```
external_call             →   numbered web search results in prompt
LLM step (analyse / agent) →   output.sources: ProvenanceItem[]
engine extractProvenance() →   lifts to ExecutionTraceEntry.provenance
trace viewer + approval UI →   colour-coded pills with hover detail
guard rule (opt-in)        →   rejects items missing sources, uses retry budget
```

The capture is permissive. Workflows that don't emit `output.sources` get `trace.provenance === undefined`; the renderer hides the panel. Workflows that emit a malformed array silently lose provenance but the workflow does not fail. Provenance is observability, not a load-bearing primitive.

## Adopting it in your workflow

### 1. Emit sources from your producer step

Update the producer's prompt to require `sources` per item in the output JSON. The [audit workflow's prompts](../../prisma/seeds/data/templates/provider-model-audit.ts) show one working pattern:

- Render any external context (search results, KB chunks) as a numbered block: `[1] title — url\nsnippet …`
- Tell the LLM exactly how to attribute each kind of claim:
  - Supported by `[N]` → `{ source: 'web_search', reference: '<url>', snippet: '<≤200 chars>' }`
  - Training only → `{ source: 'training_knowledge', confidence: 'medium' | 'low', note: '<why>' }`
  - Inferred from a model name pattern → `{ source: 'training_knowledge', confidence: 'low', note: 'inferred from model name ...' }`

### 2. Surface sources in your approval UI

Add a `'sources'` field to your `reviewSchema`:

```typescript
{ key: 'sources', label: 'Sources', display: 'sources', readonly: true }
```

The `SourcesField` renderer (`components/admin/orchestration/approvals/sources-field.tsx`) handles pills, hover content, and the JSON fallback for malformed arrays. No further wiring required.

### 3. (Optional) Enforce attribution with a guard rule

If you want missing-sources to fail the step (the audit workflow does), inline the result of `provenanceRequiredRule()` into your `guard` step's `rules` prompt:

```typescript
import { provenanceRequiredRule } from '@/lib/orchestration/provenance/guard-rules';

// In your guard step's config:
rules: `${existingRules}\n\n${provenanceRequiredRule({ fields: ['claims', 'recommendations'] })}`;
```

Options:

- `fields` — the top-level arrays of the producer output that must carry sources. Defaults to the audit shape `['changes', 'newModels', 'deactivateModels']`.
- `perItem` (default `true`) — entries inside each array carry sources, not the array itself.
- `ruleNumber` (default `8`) — slot the rule into your numbered list cleanly.

The guard's existing retry budget gives the LLM two attempts to attribute before the workflow halts.

## Trace viewer

`ExecutionTraceEntryRow` (the post-hoc admin view at `/admin/orchestration/executions/[id]`) renders a Sources panel below the Input/Output grid when an entry's `provenance` is non-empty. Same pill design as the approval UI — admins learn one inspection pattern. The live SSE execution panel doesn't surface provenance today (it would require carrying the typed field through the streaming event payload).

## What this is _not_

- **Not a citation envelope.** The chat handler's [Citation](../../types/orchestration.ts) type and the `[N]` marker system in `lib/orchestration/chat/citations.ts` are a per-turn rendering contract for `search_knowledge_base` tool results. Provenance is a per-claim record on structured step output. They can coexist on the same execution.
- **Not engine-enforced.** Adoption is opt-in via the producer prompt and the guard helper. The engine captures whatever the step emits; if you don't emit sources, the field stays undefined.
- **Not cross-step.** Each step's `provenance` is local to its own trace entry. Aggregate "where did this whole answer come from" views are out of scope here — they're item 47-style (per-message conversation provenance) work.
- **Not retrofitted onto existing rows.** New executions get the new field; pre-feature rows stay as they are.

## See also

- [provider-model-audit.ts seed](../../prisma/seeds/data/templates/provider-model-audit.ts) — first workflow to adopt the contract
- [provider audit guide](../admin/orchestration-provider-audit-guide.md) — admin walkthrough
- [chat citations](./chat.md#citations) — the chat-handler-level analogue
- [improvement-priorities item 47](./meta/improvement-priorities.md) — conversation provenance bundle (separate, complementary)
