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

# Message-Level Provenance

Workflow-step provenance (above) captures `output.sources` per step. The conversation-level twin — added alongside the supervisor audit substrate — captures the same idea per message, in a typed bundle on every assistant `AiMessage`. An auditor can hand a partner the full record of "how was this answer grounded" without joins across tables.

The schema mirrors the supervisor-on-execution pattern: 5 indexed scalars + 1 JSON bundle. Scalars are queryable; JSON holds the rich evidence tree.

## What lands on each AiMessage

| Column                | Source of truth                                                                                    | Use                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agentVersionId`      | Pinned `AiAgentVersion.id` when the message was fired by a versioned agent                         | Filter "every message produced by agent vN". Null on direct chat with the live agent.  |
| `workflowExecutionId` | `AiWorkflowExecution.id` of the last `run_workflow` capability call that completed during the turn | Self-describing join key back to the execution row. Non-FK (executions can be pruned). |
| `workflowVersionId`   | `AiWorkflowExecution.versionId` snapshotted at message time                                        | Pin which workflow version produced the synthesised answer.                            |
| `modelId`             | The model string resolved by `resolveAgentProviderAndModel` for this turn                          | "Show every message routed to model X."                                                |
| `providerSlug`        | The provider slug resolved for this turn                                                           | Cost-attribution + audit.                                                              |
| `provenance` (JSONB)  | Typed `MessageProvenance` shape (below)                                                            | Rich evidence tree for the audit bundle.                                               |

Indexes on `agentVersionId`, `workflowExecutionId`, `modelId` keep the queryable surface fast.

## The MessageProvenance bundle

```typescript
interface MessageProvenance {
  /** KB chunks cited via `[N]` markers in the assistant content. */
  citations?: Citation[];
  /** Snapshot of the terminal workflow step's output.sources when `run_workflow` fired. */
  workflowSources?: ProvenanceItem[];
  /** Every capability dispatch on the turn that produced this message (always-on). */
  capabilityCalls?: ToolCallTrace[];
}
```

Authoritative source: [`types/orchestration.ts`](../../types/orchestration.ts) (`MessageProvenance`). The schema lives in [`lib/validations/orchestration.ts`](../../lib/validations/orchestration.ts) (`messageProvenanceSchema`) — read sites validate before consuming.

### Citations gain `contentHash` and `documentVersion`

The chat handler's `Citation` type now pins `contentHash` and `documentVersion` per cited chunk. The hash comes from `AiKnowledgeDocument.fileHash` at search time — a later re-ingestion of the same `documentId` will hash differently, so an auditor can detect that the chunk the LLM saw is no longer available verbatim. `documentVersion` stays null until the KB freshness scanner (improvement-priorities item 31) lands; the hash alone carries the audit signal until then.

## How it flows

```
chat handler turn       →   resolved agent + model + provider
KB chunk lookups        →   contentHash forwarded onto each Citation
capability dispatches   →   buildToolCallTrace (always-on, no includeTrace gate)
run_workflow result     →   workflowExecutionId captured per turn
assistant build site    →   snapshotWorkflowProvenance() reads the
                            execution's terminal step output.sources
persistMessage()        →   one helper writes all 5 scalars + provenance bundle
```

The capture is best-effort everywhere it can be:

- A pruned `AiWorkflowExecution` between dispatch and the assistant build → snapshot returns null, message persists without workflow pins, warn logged.
- A malformed persisted provenance JSON → `messageProvenanceSchema.safeParse` returns failure; consumers degrade to null; the message still renders.
- A pre-feature row (or a write site that doesn't carry the new fields, e.g. error markers) → columns stay null, treated as "pre-snapshot".

Provenance is audit substrate, not a load-bearing primitive.

### Persisted args + result previews are post-redaction

`capabilityCalls[].arguments` and `capabilityCalls[].resultPreview` reflect the **redacted** form, not what the LLM actually saw. Each capability declares its PII stance (`processesPii: boolean`) and a `redactProvenance(args, result)` method on its class — the chat handler's `buildToolCallTrace` looks the capability up in the registry and calls the redactor before constructing the trace row. PII-handling capabilities (`call_external_api`, `escalate_to_human`, `run_workflow`, `read_user_memory`, `write_user_memory`, `upload_to_storage`) mask domain-specific fields and replace free-text bodies with sentinels; non-PII capabilities pass through verbatim.

The LLM still sees the un-redacted result on its turn (the redactor's output is only used for the durable audit row). Provenance bundles are safe to hand to auditors without leaking the actual emails / phone numbers / file contents that flowed through the capability. See [`.context/security/pii-redaction.md`](../security/pii-redaction.md) for the contract.

### Every provenance download is logged

`GET /api/v1/admin/orchestration/conversations/[id]/provenance` and `/provenance.md` write an `AiAdminAuditLog` entry with `action: 'conversation.provenance_export'` on every successful response — admin id, conversation id, format, message count, IP, timestamp. Pulling a provenance bundle leaves a trace by design.

## The bundle endpoint

`GET /api/v1/admin/orchestration/conversations/[id]/provenance` returns the typed bundle as JSON. The sibling `provenance.md` route returns the deterministic Markdown rendering. Both are admin-only, rate-limited (`adminLimiter`), and gated by `adminCanViewConversation` — the caller's own conversation, one actively shared with them, or a system-owned inbound thread where the authorization policy permits an unattributed read. Anything else returns 404, not 403, so an attacker can't enumerate other users.

The Markdown renderer ([`lib/orchestration/trace/render-conversation-markdown.ts`](../../lib/orchestration/trace/render-conversation-markdown.ts)) emits HTML-ready GitHub-flavoured Markdown so a future Gotenberg PDF adapter can convert without surprises. PDF is not yet built — it's a thin downstream wrapper once Gotenberg infrastructure is provisioned.

## Adopting it in your code

Most users don't need to. The chat handler is the single write site; every assistant message gets pinned automatically. You only need to think about provenance when:

- **You write a non-chat AiMessage row.** Carry the model/provider/agent context through `PersistMessageParams` and snapshot any workflow result. The chat handler's `persistMessage` helper is the reference implementation.
- **You consume `AiMessage.metadata`.** It no longer carries `citations`, `toolCalls`, or `modelUsed`. Read those from `AiMessage.provenance.citations`, `AiMessage.provenance.capabilityCalls`, and the new top-level `AiMessage.modelId` column.
- **You add a third provenance trail** (e.g. memory retrieval, tool federation). Extend `MessageProvenance` with the new field and update the renderer + Zod schema. The shape is open for extension; the contract is "every claim must be attributable."

## What this is not

- **Not a back-fill.** Pre-feature rows stay as they are. Convention: null = pre-snapshot.
- **Not a single source of truth for execution provenance.** Workflow step `output.sources` still live in the execution trace; the message bundle holds a _snapshot_ of the terminal step's sources for self-describing audit. The execution remains canonical.
- **Not coupled to a supervisor verdict per message.** Conversation-level supervisor review is reserved (`POST /conversations/[id]/review` is unallocated) for a future, separate item. The provenance bundle is the substrate that future supervisor would review.

## See also

- [improvement-priorities item 47](./meta/improvement-priorities.md) — the originating ticket
- [admin conversations UI](../admin/orchestration-conversations.md) — trace viewer surface
- [orchestration endpoints](../api/orchestration-endpoints.md) — route reference
- [chat citations](./chat.md#citations) — the chunk-marker contract the bundle persists
