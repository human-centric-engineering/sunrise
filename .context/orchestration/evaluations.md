# Dataset-driven evaluations

End-to-end architecture for Phase 1 batch evaluations: upload a
dataset, queue a run against an agent, drain in the background, surface
per-case results with heuristic + agent-judge scores.

## Architectural keystone: agents-as-judges

Every model-graded metric is an `AiAgent` row with `kind='judge'`,
driven by the evaluation worker via `streamChat`. The 6 built-in
metrics (correctness, relevance, coherence, faithfulness,
groundedness, brand-voice) ship as seeded `isSystem=true` agents;
admins can create custom judges in the agent form. This means:

- Judge prompts (the **rubric**) are edited in the existing agent
  form with version history, FieldHelp, and safety guardrails.
- Judges can have **knowledge attached** (e.g. a policy reviewer with
  the policy doc) and **capabilities bound** (e.g. an
  authoritative-answer lookup tool the LLM can call mid-judging).
- **Judge spend rolls up per-agent** on the existing costs page —
  every judge call writes a `CostOperation.CHAT` row attributed to
  the judge agent.
- The grader registry has ONE model-family entry, `judge_agent`, that
  takes `{ agentSlug }` in config. Adding a new metric = creating a
  new agent; no code change.

The brand-voice judge is the showcase use case: it reads the subject
agent's `brandVoiceInstructions` from the structured user-message
payload (pinned at queue time, like `datasetContentHash`) — impossible
with the previous function-grader design.

This is **separate from** the manual evaluation-session flow at
`.context/orchestration/evaluation-metrics.md`. That flow stays as-is —
a human chats with an agent, annotates each response, hits Complete,
and three named metrics (faithfulness/groundedness/relevance) are
scored as a bundled judge call. Phase 1 adds a second, complementary
loop:

- **Manual session** — interactive, single agent, human-in-the-loop, one
  bundled judge call per response. Persists to `AiEvaluationSession` and
  `AiEvaluationLog`.
- **Batch run** (new) — automated, dataset-fed, polymorphic subject
  (agent | workflow), per-grader judge calls. Persists to
  `AiEvaluationRun` and `AiEvaluationCaseResult`.

The two share the grader registry (heuristic + model + custom rubric)
and the judge-model resolution chain. They write to different tables on
purpose: manual sessions are conversational artifacts; batch runs are
benchmark results.

## Core entities

```
AiDataset
  ├─ contentHash (sha-256 of normalised cases)
  └─ cases: AiDatasetCase[]
       ├─ position (stable order)
       ├─ input        (string | object — workflow inputs)
       ├─ expectedOutput?
       ├─ metadata?    (tags, difficulty, expectedTrajectory)
       └─ referenceCitations?

AiEvaluationRun
  ├─ subjectKind: 'agent' | 'workflow'
  ├─ agentId    XOR  workflowId         (DB-level invariant)
  ├─ datasetId  +    datasetContentHash (pinned at submit time)
  ├─ metricConfigs Json   ([{ slug, config }])
  ├─ judgeProvider?, judgeModel?
  ├─ status: queued | running | completed | failed | cancelled
  ├─ progress: { casesTotal, casesDone, casesFailed }
  ├─ summary: per-metric mean / median / p95 / passRate / scoredCount
  ├─ lockedBy + lockedAt  (worker lease)
  └─ results: AiEvaluationCaseResult[]
       ├─ casePosition  (mirrors AiDatasetCase.position)
       ├─ subjectOutput
       ├─ subjectMetadata { citations, toolCalls, latency, … }
       ├─ metricScores  Record<graderSlug, { score, passed?, reasoning?, costUsd? }>
       └─ errorCode?, errorMessage?
```

`AiExperimentVariant.evaluationRunId` was added in the Phase 1
migration so Phase 2's experiment compare view can aggregate from
runs without schema rework.

## Worker

`processPendingEvaluationRuns()` in
`lib/orchestration/evaluations/run-worker.ts` is invoked once per
maintenance tick from the background `void Promise.allSettled` chain at
`app/api/v1/admin/orchestration/maintenance/tick/route.ts`. The HTTP
path returns 202 the moment schedules are claimed; the worker drains
on the background chain so a long batch can never stall the tick
endpoint.

Per-tick lifecycle:

1. **Claim** the oldest queued (or orphan-stale, `lockedAt < now − 5min`)
   run via a single conditional UPDATE. Mirrors `processOrphanedExecutions`
   — two workers cannot hold the same lease.
2. **Hash-pin check** — re-hash the dataset's current cases and compare
   to `datasetContentHash`. Mismatch ⇒ mark `failed` with
   `summary.note = 'dataset_changed_post_submit'`.
3. **Pre-flight** the run's grader configs against the dataset (every
   reference-required grader needs `expectedOutput` on every case).
4. **Resolve the judge binding** once: run-level override → env
   `EVALUATION_JUDGE_*` → env `EVALUATION_DEFAULT_*` → system chat
   default via `resolveAgentProviderAndModel`.
5. **Time-budgeted loop** (≤ 45s per tick): for each case without a
   result row, drain the subject (`streamChat` for agent subjects;
   `OrchestrationEngine.execute()` for workflow subjects, resolved
   via `subjectOutputSelector`), run every configured grader, write
   the `AiEvaluationCaseResult` row, throttle progress writes (every
   5 cases).
6. If the budget expires mid-run, **release the lease** so the next
   tick resumes from the case cursor. Crashed workers recover the same
   way — `lockedAt` ages past the 5-minute threshold and the next claim
   picks the run up.
7. When every case has a result row: aggregate per-metric stats into
   `summary`, log one `CostOperation.EVALUATION_JUDGE` row covering the
   total judge spend, mark `completed`.

Subject chat cost is **not** re-logged by the worker — `streamChat`
already writes `CostOperation.CHAT` rows for the underlying agent
turn. Double-logging would distort analytics. The judge cost is the
only new cost path the worker writes.

## Graders

Modelled on the workflow executor registry pattern at
`lib/orchestration/engine/executor-registry.ts`. Function-based, slug-
keyed, self-registers at module import.

```ts
// lib/orchestration/evaluations/graders/registry.ts
registerGrader({
  slug: 'exact_match',
  family: 'heuristic',           // 'heuristic' | 'model' | 'pairwise'
  referenceRequired: true,
  configSchema: zod,
  defaultConfig: { trim: true, caseInsensitive: false },
  grade: async (input) => ({ score, passed?, reasoning?, costUsd?, tokenUsage? }),
  description: '…plain-English UI label…',
});
```

A parity test asserts every slug in `KNOWN_GRADER_SLUGS` is registered
after the barrel import — a grader file that forgets `registerGrader`
fails CI rather than silently disappearing from the picker.

### Built-ins

**Heuristic** (deterministic, no LLM call, ~0ms):

- `exact_match`, `contains`, `regex`, `length_between`
- `json_schema`, `json_path_equals`
- `tool_was_called`, `citation_count_at_least`

**Judge agents** (one `judge_agent` registry entry; per-judge slug
picked via `config.agentSlug` at run time). Six answer-quality judges
seeded by `prisma/seeds/016-evaluation-judges.ts`:

- `eval-judge-correctness` — semantic match against `expectedOutput`.
  The biggest current gap before this refactor: reference-required,
  tolerant of wording / structure differences.
- `eval-judge-relevance` — addresses the question, regardless of
  correctness.
- `eval-judge-coherence` — internally consistent + well-organised.
- `eval-judge-faithfulness` — each `[N]` marker supported by its
  citation. Null when no markers.
- `eval-judge-groundedness` — substantive claims traceable to cited
  sources (common-knowledge loophole removed).
- `eval-judge-brand-voice` — response matches the subject agent's
  `brandVoiceInstructions`. Pinned at queue time.

Three Ragas-style retrieval-quality judges seeded by
`prisma/seeds/018-rag-evaluation-judges.ts` (Phase 3):

- `eval-judge-context-precision` — fraction of cited sources that are
  relevant to the question.
- `eval-judge-context-recall` — fraction of gold-reference claims that
  appear in the retrieved citations.
- `eval-judge-answer-similarity` — semantic similarity of ANSWER vs.
  EXPECTED ANSWER overall (Ragas-style, model-graded).

A second model-grader entry, `workflow_as_judge` (Phase 3), drives an
entire `AiWorkflow` as a judge — useful when scoring needs a
multi-step rubric, knowledge-grounded judging with capability calls,
or conditional rubric application. Config:
`{ workflowSlug, inputMapping: { var: '$.userInput' | '$.modelOutput' | … } }`.
The workflow's final step must output a `{score, reasoning}` envelope.

Each judge's `systemInstructions` IS the rubric, with explicit
**IGNORE** clauses telling it what the metric does NOT cover (so the
six don't bleed into each other). The structured user-message format
every judge receives:

    QUESTION: <case input>
    ANSWER: <subject output>
    [optional] EXPECTED ANSWER: <case.expectedOutput>
    [optional] CITED SOURCES: <JSON array {marker, documentName, excerpt}>
    [optional] TOOL CALLS: <JSON array {slug, args}>
    [optional] SUBJECT BRAND VOICE: <subject's brandVoiceInstructions>

Each judge returns `{score, reasoning}` JSON. The worker parses,
stores under a metric key derived from the judge's slug.

The manual-session path (`score-response.ts`) drives the three RAG
judges in parallel via `drainStreamChat` (refactored from a bundled
single-call to per-judge calls for consistency with the batch path).

**Pairwise** — `pairwise_judge_agent` (Phase 3) shows a judge agent
two candidate answers side-by-side and parses
`{ verdict: 'A' | 'B' | 'tie', reasoning }`. Used by the experiment
compare view to add a judge-verdict badge alongside the statistical
winner. Standalone runs refuse pairwise metrics at the route boundary
— they need two side-by-side outputs, which only the compare flow
supplies.

### Why no sandboxed code-based graders

The plan considered `vm2`/`quickjs-emscripten` for arbitrary user JS.
Rejected: `vm2` has known sandbox escapes; `quickjs` is a real
maintenance + bundle-size + security-review cost. The fixed set of
heuristic primitives covers >90% of real use cases. When users need
bespoke logic they should write a `custom_rubric` (model-graded) or
later a Sunrise capability that a `capability_grader` invokes — both
delegate trust to existing execution boundaries.

## Datasets

Stored as Prisma rows, NOT as knowledge chunks. The plan considered
reusing the knowledge ingestion pipeline; rejected because eval cases
are structured records (`input`, `expectedOutput`, `metadata`) needing
deterministic iteration, per-case joins, and tag filtering — all
Prisma-row strengths, all chunk-store weaknesses.

Two file formats supported by the upload handler at
`lib/orchestration/evaluations/datasets/upload-handler.ts`:

- **CSV** — header row required. `input` is the only required column;
  `expectedOutput`, `metadata` (JSON cell), `tags` (comma-separated, →
  `metadata.tags`), `referenceCitations` (JSON cell), `difficulty` (→
  `metadata.difficulty`) are optional. RFC 4180 quoting + BOM/CRLF
  normalisation + quote-aware delimiter sniffing.
- **JSONL** — one JSON object per line. `#` and `//` comment lines and
  blank lines are skipped. Strict: malformed lines throw with the line
  number rather than silently being dropped (silent data loss is the
  worst failure mode for evals).

`AiDataset.contentHash` is a SHA-256 over the canonicalised case array
(positions sorted, keys sorted, undefined fields stripped). Re-uploading
the identical file produces the same hash. Each `AiEvaluationRun`
captures the dataset's hash at submit time so dataset edits never
silently invalidate historical comparisons.

## API surface

All routes guarded by `withAdminAuth` (admin role required). Mutating
routes inherit the default 100/min rate-limit cap from
`lib/security/rate-limit-policy.ts`.

| Method | Path                  | Purpose                                                  |
| ------ | --------------------- | -------------------------------------------------------- |
| GET    | `/datasets`           | Paginated list (q, tag filters)                          |
| POST   | `/datasets`           | Multipart upload OR JSON body                            |
| GET    | `/datasets/:id`       | Detail + first 50 cases                                  |
| PATCH  | `/datasets/:id`       | Rename / re-tag (no hash change)                         |
| DELETE | `/datasets/:id`       | Refuses if a non-terminal run references it              |
| GET    | `/datasets/:id/cases` | Cursor-paginated cases                                   |
| GET    | `/runs`               | Paginated list (status, subject, dataset, agent filters) |
| POST   | `/runs`               | Queue a run after full pre-flight                        |
| GET    | `/runs/:id`           | Detail + summary (UI polls every 3s while active)        |
| GET    | `/runs/:id/cases`     | Per-case results, cursor-paginated                       |
| POST   | `/runs/:id/cancel`    | Queued/running → cancelled                               |
| GET    | `/graders`            | Registry contents — drives the metric picker             |

All under `/api/v1/admin/orchestration/evaluations/`.

## Admin UI

Pages under `/admin/orchestration/evaluations/`:

- `/datasets` — list + "Evaluation 101" empty-state card
- `/datasets/new` — upload form (CSV/JSONL drag-drop, FieldHelp on every field)
- `/datasets/[id]` — read-only detail + 50-case preview
- `/runs` — list + "Evaluation 101" empty-state card
- `/runs/new` — single-page form (basics → subject → dataset → metrics → judge)
- `/runs/[id]` — detail with 3-second polling, progress bar, summary table, per-case drill-in

A central UI-copy module at
`components/admin/orchestration/evaluations-foundations/help-text.ts`
holds every `<FieldHelp>` body and the Evaluation 101 card text. The
tone is locked: plain English, concrete actions, examples in inline
code, no "AI flourishes". One grep audits the whole surface.

## Phase 1 boundaries

- ~~Workflow-as-subject~~ — shipped in Phase 3. The worker dispatches
  to `OrchestrationEngine.execute()`; the run-create form has a
  Subject-kind toggle with a workflow picker and a
  `subjectOutputSelector` control.
- ~~Pairwise graders, RAG-specific Ragas metrics~~ — shipped in Phase 3
  (`pairwise_judge_agent` + three new Ragas judges).
- No CI gating endpoint yet — Phase 4.

## Phase 2 — cost estimator

Replaces the UI-copy-only heuristic with a real two-mode estimator that
mirrors the workflow cost estimator's contract.

- **Empirical mode** — when ≥3 prior `completed` runs match the
  fingerprint `(agentId, sorted judgeAgentSlugs, datasetContentHash)`,
  the estimator takes the median per-case cost from those runs
  (`totalCostUsd / casesDone`) and multiplies by the dataset's current
  case count. Range is tight (±15–50%, scaled by relative MAD).
- **Heuristic mode** — otherwise. Per-case shape is one subject call
  (~1.5k input + 500 output tokens at the subject agent's bound model)
  plus one call per judge agent (~600 input + 150 output at the judge's
  bound model). Heuristic graders cost nothing. Range is wide (×0.5 / ×2)
  to signal uncertainty.
- The fingerprint is **strict** on purpose: a judge swap, a model swap
  on the subject agent, or a dataset re-upload (which changes the
  content hash) resets the empirical floor until 3 fresh runs
  accumulate. Looser keys would silently misprice when the operator
  changes the setup.
- Models with no registry pricing surface with `pricingKnown: false` on
  the relevant `modelMix` entry. The form shows an explicit "no pricing
  data" callout rather than masking the gap as $0.
- Subject vs. judge `AiCostLog` rows are tagged with
  `metadata.role: 'subject' | 'judge'` (and `evaluationRunId`) so future
  per-role breakdowns work without re-instrumenting. The plumbing
  shipped in 2.0 and is forward-compat for Phase 3 workflow subjects.

The estimate is served by `POST /evaluations/runs/estimate` and called
from the run-create form on a 350 ms debounce keyed on
`(agentId, datasetId, sorted judgeAgentSlugs)`. Toggling a heuristic
grader does not re-fetch — heuristics are free.

## Phase 2 — trace-to-dataset capture

Admins can convert a real prod conversation turn or workflow execution
output into a new `AiDatasetCase` row on any existing dataset. Two
helpers + one endpoint:

- `captureConversationTurnAsCase({ datasetId, messageId, edits? })` —
  pairs an assistant `AiMessage` with its immediately preceding user
  turn. The user message becomes `input`; the assistant becomes
  `expectedOutput`; `provenance.citations` maps to `referenceCitations`.
- `captureWorkflowExecutionAsCase({ datasetId, executionId, selector, edits? })`
  — resolves the execution's output via the same `subjectOutputSelector`
  contract the eval worker uses (`final_report` / `last_step` /
  `step_id`). `inputData` becomes the case input; the resolved output
  becomes `expectedOutput`. Only `status='completed'` executions can be
  captured.

Both helpers delegate to `appendCasesToDataset()`, which validates each
new case via the same Zod schema upload uses, writes the row at the
next contiguous position, and **recomputes the dataset's `contentHash`**
over the full case array. Without the hash recompute, every queued eval
run pinned to the old hash would fail with `dataset_changed_post_submit`
on the next worker tick.

`POST /evaluations/datasets/:id/capture` is the wire route — Zod
discriminated union on `kind`, ownership enforced at three layers:
dataset (caller must own), source message's conversation (caller must
own), and source execution (caller must own). Without the source-side
check, a user could capture another user's prod traffic. UI entry
points land in 2.6.

## Phase 2 — synthetic case generation

A new `kind='generator'` `AiAgent` (`eval-case-generator`, seeded by
`017-case-generator-agent`) writes proposed cases from one of two
seed sources. The agent kind is deliberately distinct from `'judge'`
so the run-create form's judge picker (which filters
`WHERE kind = 'judge'`) never accidentally surfaces the generator.

Two modes:

- **`kb`** — `seed-loader.loadKbSeed()` pulls a representative breadth
  sample of chunks from the subject agent's accessible documents
  (via `resolveAgentDocumentAccess`). The generator turns those into
  grounded `{ input, expectedOutput, citations }` cases.
- **`failure_mining`** — `seed-loader.loadFailureSeed()` pulls
  low-scoring (`mean < 0.6`) prior `AiEvaluationCaseResult` rows for
  the subject agent, joined to their source case + worst-grader
  reasoning. The generator writes "similar but harder" variants
  targeting the same failure mode.

Two-step route flow:

- `POST /datasets/:id/generate-cases` — preview only. One LLM call,
  no writes. Sub-capped at **10/min/user** via `synthesisLimiter`
  (genuinely expensive — every request invokes the case-generator
  agent). Returns proposed cases for the admin to review and edit.
- `POST /datasets/:id/generate-cases/commit` — writes accepted cases
  via `appendCasesToDataset` with `source: 'synthetic'`. No LLM call,
  inherits the default 100/min.

Cost is tagged: the generator's chat call stamps
`costLogMetadata: { role: 'generator', mode, agentSlug }` so synthesis
spend appears as a third role alongside `'subject'` and `'judge'` in
the cost analytics. Existing role filters (`role: 'subject' | 'judge'`)
ignore the new value, so they don't double-count synthesis spend as
either of the other two.

## Phase 2 — variant runs + raw scores

A/B experiments now run against a shared dataset, with one
`AiEvaluationRun` per variant instead of the legacy `AiEvaluationSession`
manual chat. Schema additions on `AiExperiment` (migration
`20260525173530_add_experiment_dataset_fields`):

- `datasetId: String?` — every variant's eval run fires against this
  dataset. Nullable on legacy rows that pre-date the change.
- `metricConfigs: Json?` — pinned at create time, mirrors
  `AiEvaluationRun.metricConfigs`. Required when `datasetId` is set
  (`.refine()` on the create-experiment schema).

The run route at `POST /experiments/:id/run` branches:

- **Dataset-driven**: `datasetId` and `metricConfigs` are both set →
  create one `AiEvaluationRun` per variant against the experiment's
  dataset, hash-pinned via the dataset's current `contentHash` (same
  pinning the existing run-create route does). Variants compare via
  `AiEvaluationRun.summary.stats` per metric.
- **Legacy session**: otherwise → create one `AiEvaluationSession`
  per variant (the existing manual-chat path). Preserved for the
  back-compat window so experiments running at deploy time keep
  completing.

`AiEvaluationRun.summary` gains a `rawScores: Record<graderSlug, number[]>`
field, populated by the worker's aggregator at completion. Pure additive
JSON — no migration. The raw scores power the experiment compare view's
statistical tests (Welch's t-test + Cohen's d) — `mean`/`median`/`p95`
throw away the variance the test statistic needs, so the raw array is
the source of truth for "are these two variants distinguishable".

Phase 2.4 is back-end only. The compare view UI lands in 2.5.

## Phase 2 — variant compare view + winner badge

`/admin/orchestration/experiments/:id/compare` renders a side-by-side
per-metric grid for every variant of a dataset-driven experiment.
Server-rendered Next.js page that loads the experiment + each variant's
`AiEvaluationRun.summary.rawScores` and computes pairwise statistics
against the control variant (variant index 0).

Three pure libraries do the stats lifting:

- `stats/welch.ts` — Welch's two-sample t-test with the Lanczos log-Γ
  approximation + Lentz's continued-fraction expansion of the
  regularised incomplete beta function. Cross-validated against
  scipy's `ttest_ind(equal_var=False)`.
- `stats/cohens-d.ts` — pooled-SD Cohen's d with the conventional
  `negligible / small / medium / large` classification.
- `stats/winner.ts` — `decidePairwiseWinner(a, b, options)` composes
  the two. A variant "wins" only when ALL THREE conditions hold:
  higher mean ∧ `p < 0.05` ∧ `|d| ≥ 0.5`. Anything else returns
  `'no_clear_winner'` with a typed `reason` (`insufficient_samples` /
  `p_above_threshold` / `effect_size_too_small`) the UI can surface.

The compare table (`components/admin/orchestration/experiments/
variant-compare-table.tsx`) renders one row per metric with `mean ±
(n)` per variant cell, p-value and Cohen's d badges under each
challenger, and a Trophy + variant label in the winner column when the
threshold passes.

**Stats methodology caveat** (also shown in the UI's `FieldHelp`):
Welch's t-test assumes the per-sample mean is approximately normal.
Rubric scores on `[0, 1]` often aren't — they pile up at the ends.
The Central Limit Theorem rescues us when N is large enough (~30+ per
variant); below that, read p-values with extra caution. A permutation-
test fallback was considered and rejected — ~10× the implementation
cost for marginal accuracy at sample sizes a partner pilot would
realistically generate.

## Phase 3 — judges in workflows

Two complementary integrations let workflows use the judge agents
that already exist. No schema changes — pure code on the Phase 1.5
foundations (`drainStreamChat` + JSON parser, factored into a shared
`lib/orchestration/evaluations/judge-driver.ts`).

### `judge_call` workflow step type

New step executor at `lib/orchestration/engine/executors/judge-call.ts`,
modelled on `evaluate.ts`. Config:

```ts
{
  judgeAgentSlug: string;
  question: string;        // template-interpolated
  answer: string;          // template-interpolated
  expectedOutput?: string; // template-interpolated
  subjectBrandVoice?: string;
  threshold?: number;
}
```

The executor template-interpolates the string fields (so a workflow
can pass `{{previous.output}}` as the answer), drives the named judge
agent via `driveJudgeAgent`, parses the `{score, reasoning,
evaluationSteps?}` envelope, and returns a step output with a derived
`passed: boolean` flag (`score >= threshold`, or `true` when no
threshold). Routes downstream branches via the existing `route` step.
Unlocks:

| Pattern              | What it enables                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Inline QA gate       | Workflow → agent_call → judge_call → branch: publish if `passed`, escalate otherwise             |
| Self-review loop     | agent_call → judge_call → if `!passed`, agent_call again with feedback in prompt → max-N retries |
| Multi-judge approval | Parallel branches of 3 judge_calls → aggregate → require all 3 `passed`                          |
| Cost-aware routing   | Cheap heuristic check first (existing step); only run a judge_call if uncertain                  |

### `workflow_as_judge` grader

The inverse: an entire `AiWorkflow` used AS a judge in evaluation
runs. Registered alongside `judge_agent`:

```ts
{
  slug: 'workflow_as_judge',
  config: {
    workflowSlug: string,
    inputMapping: { var: '$.userInput' | '$.modelOutput' | '$.expectedOutput' | '$.citations' },
  },
}
```

The grader executes the workflow with the case fields mapped into its
variables, expects the final step to emit a `{score, reasoning,
evaluationSteps?}` envelope. Cost rows tagged
`{ evaluationRunId, role: 'judge', judgeWorkflowSlug }`. Run-creation
validates the workflow exists, is active, and has a published version
before queueing.

Unlocks:

- Composed multi-step rubrics that a single judge agent can't capture.
- Knowledge-grounded judging — the judge workflow can call
  `lookup_authoritative_answer` mid-judging via capabilities.
- Conditional rubric application (router → different scoring path per
  question type).
- A/B in production (workflow routes traffic to two variants and
  records the score delta as an evaluation result).

### `pairwise_judge_agent` grader

First built-in `family: 'pairwise'` grader. Shows a judge agent two
candidate answers side-by-side and parses
`{ verdict: 'A' | 'B' | 'tie', reasoning }`. Defaults to `'tie'` on
chat-layer or parse errors so downstream consumers always see a
usable shape. Standalone runs refuse pairwise metrics — they need
two side-by-side outputs, which only the experiment compare flow
supplies. The endpoint that surfaces verdicts in the admin UI ships
in Phase 3.5a (see below).

### What's NOT included

- Workflow-per-case (every dataset case its own workflow execution).
  Considered, rejected: 100s of WorkflowExecution rows per run pollutes
  the executions list and the workflow engine is tuned for tens of
  executions per workflow, not hundreds per dataset. Workflow-as-judge
  uses one workflow definition driving many cases — the right shape.
- A first-class "evaluation workflow" template type. Keep workflows
  generic; let the `judge_call` step + `workflow_as_judge` grader
  compose into eval-shaped workflows organically.

## Phase 3.5b — workflow-aware cost estimator

The cost estimator now handles workflow subjects so the `/runs/new`
form's cost banner is no longer suppressed when the operator picks a
workflow subject.

### Server

`estimateEvaluationRunCost` (`lib/orchestration/cost-estimation/evaluation-cost.ts`)
branches on `subjectKind`:

- `'agent'` — unchanged. Bound model lookup + heuristic per-case
  subject tokens.
- `'workflow'` — calls `loadWorkflowShape(workflowId, chatDefault)`
  from `workflow-cost.ts` (the same helper the workflow builder
  uses), walks the resulting `workSteps`, and applies the heuristic
  `WORKFLOW_STEP_INPUT_TOKENS_PER_CASE / OUTPUT_TOKENS_PER_CASE`
  (3,000 / 1,000 — same baseline as `workflow-cost.ts`) multiplied
  by each step's `multiplier` (`agent_call × 3`, `reflect × 2`,
  others × 1) and `caseCount`. Tokens are aggregated by resolved
  model — a workflow that calls two different agents binds two
  `modelMix` rows tagged `role: 'subject'`.

Empirical mode keys on `(subjectKind, agentId | workflowId, sorted
judgeAgentSlugs, datasetContentHash)` so workflow-subject and
agent-subject past runs never cross-pollute the estimate.

### UI

`run-create-form.tsx` no longer early-returns for workflow subjects
in `useEvaluationCostEstimate`. The hook now sends
`{ subjectKind, agentId|workflowId, datasetId, judgeAgentSlugs }`
and the response renders through the same banner (one `subject`
entry per resolved model, plus per-judge rows). Debounce stays at
350ms; suppression still kicks in until the chosen subject is
populated.

### What's NOT included

- A per-step cost breakdown in the eval banner. The estimator
  internally tracks tokens per step, but the UI sums them by model —
  the workflow builder's per-step tint is the right surface for
  that detail.
- Conditional-branch awareness (every LLM step is assumed to fire
  on every case). Matches the workflow-builder estimator's posture
  and is documented as a heuristic upper bound.

### Critical files

| Concern                | Path                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Estimator              | `lib/orchestration/cost-estimation/evaluation-cost.ts`                                       |
| Shape loader (re-used) | `lib/orchestration/cost-estimation/workflow-cost.ts` (`loadWorkflowShape`, `summariseShape`) |
| Zod schema             | `lib/validations/orchestration-evaluations.ts` (`estimateRunCostSchema`)                     |
| Estimate route         | `app/api/v1/admin/orchestration/evaluations/runs/estimate/route.ts`                          |
| Form hook              | `components/admin/orchestration/evaluations-foundations/run-create-form.tsx`                 |

## Phase 3.5a — pairwise verdicts endpoint + compare badge

The `pairwise_judge_agent` grader (Phase 3) is now driven through a
dedicated admin endpoint and surfaced on the compare view, completing
the half-shipped pairwise flow.

### Endpoint

`POST /api/v1/admin/orchestration/experiments/:id/verdicts`

- Body: `{ judgeAgentSlug, variantAId, variantBId }`. Variants must
  belong to the experiment and have a completed `AiEvaluationRun`.
- Loads both variants' per-case `AiEvaluationCaseResult` rows and joins
  them by `casePosition`. Drives `pairwiseJudgeAgentGrader` once per
  pair, tallies `{ A, B, tie }` verdicts, persists a
  `PairwiseVerdictSummary` blob on `AiExperiment.pairwiseVerdict`.
- Synchronous, hard-capped at 100 dataset cases — the 409 response
  recommends a smaller dataset. Above the cap the cost + latency of
  100 + judge LLM calls outweighs the inline UX value; promote to a
  queued worker if real datasets blow past the cap.
- Sub-cap: `pairwiseVerdictLimiter` at 5/min/session-user
  (`lib/security/rate-limit.ts`). Each call drives up to 100 LLM
  invocations, so the cap is tighter than the `orchestration` section
  tier's 120/min.
- Grader errors (LLM stream failure, malformed JSON) get folded into
  `casesFailed` rather than polluting the tally — the grader's
  prefixed reasoning string is the signal.
- Unpaired positions (one variant missing a result for that case)
  are recorded in `perCase` with an `error` string and counted in
  `casesFailed`; the grader is not invoked for them.

### Compare-view card

The compare page (`/admin/orchestration/experiments/:id/compare`)
now renders a **Pairwise verdict** card between the
"still queued" banner and the per-metric variant grid. The card
shows the stored tally (A wins / B wins / Ties / Failed) when one
exists, plus a **Run verdict / Re-run verdict** button that opens a
dialog with a judge picker + variant A/B selectors (defaults to
control + first challenger, judges pulled directly from
`AiAgent where kind='judge' AND isActive`).

The button is disabled below the threshold of two completed runs,
above the 100-case cap, or when the experiment has no dataset — the
empty-state copy explains which condition tripped.

### What's NOT included

- A queued/asynchronous path for >100-case experiments. The 100-cap
  is a deliberate constraint to keep the endpoint synchronous + the
  UX legible; we'd revisit if anyone actually wants pairwise tallies
  on bigger datasets.
- A history of past verdicts. Re-running overwrites the prior
  `pairwiseVerdict` blob with the new judge slug + timestamp. The
  cost rows (tagged `role: 'judge'` on `AiCostLog`) retain the audit
  trail.
- Pairwise stats (e.g. binomial test on the tally counts) on the
  compare page. The Welch + Cohen's d badges on the per-metric grid
  already serve the "is this difference real?" question; pairwise
  verdicts answer "which one would a judge prefer?".

### Critical files

| Concern                | Path                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| Schema                 | `prisma/schema.prisma` (`AiExperiment.pairwiseVerdict`)                     |
| Migration              | `prisma/migrations/20260527071146_add_experiment_pairwise_verdict/`         |
| Type                   | `types/orchestration.ts` (`PairwiseVerdictSummary`, `PairwiseVerdictCase`)  |
| Endpoint               | `app/api/v1/admin/orchestration/experiments/[id]/verdicts/route.ts`         |
| Compare GET (extended) | `app/api/v1/admin/orchestration/experiments/[id]/compare/route.ts`          |
| Zod schema             | `lib/validations/orchestration-evaluations.ts` (`runPairwiseVerdictSchema`) |
| Sub-limiter            | `lib/security/rate-limit.ts` (`pairwiseVerdictLimiter`)                     |
| Grader (reuse)         | `lib/orchestration/evaluations/graders/pairwise/judge-agent.ts`             |
| Compare page           | `app/admin/orchestration/experiments/[id]/compare/page.tsx`                 |
| Verdict card           | `components/admin/orchestration/experiments/pairwise-verdict-card.tsx`      |

## Phase 3.6 — dataset creation UX

A first-time admin on `/admin/orchestration/evaluations/datasets/new`
no longer faces a bare file picker. Two complementary surfaces remove
the cold-start gap:

### Inline guidance + downloadable starter

The page is a two-column layout. The left column carries the upload
form; the right column carries `DatasetAnatomyCard`, a worked example
showing one `datasetSamples` case field-by-field (input, expectedOutput,
tags, referenceCitations, metadata) so the shape of a good case is
visible without expanding anything.

Above the file picker, a **Need a starting point?** card offers
**Download CSV** / **Download JSONL** buttons. Both emit the same
three domain-neutral cases (`components/admin/orchestration/
evaluations-foundations/help-text.ts → datasetSamples`); the
client-side formatters in `lib/orchestration/evaluations/datasets/
sample-formatters.ts` round-trip cleanly through the existing CSV +
JSONL parsers (verified by `tests/unit/lib/orchestration/evaluations/
datasets/parsers.test.ts`). CSV uses RFC 4180 quoting; JSONL folds
the literal-string `tags` field into `metadata.tags` to match what
`csv-parser.ts` does at line 186.

All new help copy lives in `help-text.ts` (`datasetHelp.goodCase`,
`.starterDownload`, `.generateFromDescription`, `.domainPrompt`,
`.seedInputs`) — the tone-locked module.

### Generate from description

A second tab on `/datasets/new` (`DatasetNewTabs` + `GenerateFromDescriptionForm`)
is the cold-start path for admins who don't have a CSV to upload and
whose subject agent has no KB to sample from. The flow:

1. Pick a subject agent.
2. Type a 20–1000 char domain description ("Customer support agent
   for a fintech card issuer. Handles declines, fees, refunds.").
3. Optionally add up to 3 anchor inputs (real user questions).
4. Pick a target count (1–25).
5. **Generate** → preview shows proposed cases (shared
   `CaseReviewStep` with the per-dataset modal).
6. Untick anything wrong, give the dataset a name, **Save** →
   commit endpoint creates `AiDataset` + writes cases in one Prisma
   transaction; UI redirects to the new dataset's detail page.

No dataset row is created at preview time. The operator can cancel
out of review with no half-finished rows left behind.

Server side, this is a **third mode on the existing case generator**.
`SynthesisMode` widens to `'kb' | 'failure_mining' | 'description'`.
The description mode skips both seed loaders — no KB sampling, no
prior-failure query — and assembles the prompt from just the
domain text and anchor inputs. The eval-case-generator agent's
system prompt picks up a one-paragraph addition covering the new
seed shape on next `db:seed` run (no migration).

**New endpoints** (both `POST`, `withAdminAuth`):

- `/evaluations/datasets/generate-from-description` — preview. Body:
  `{ agentId, count: 1..25, domainPrompt: string(20..1000), seedInputs?: string[](0..3) }`.
  Sub-capped at 10/min via the existing `synthesisLimiter` (same
  per-flow cap as the per-dataset `/generate-cases` route).
- `/evaluations/datasets/generate-from-description/commit` — atomic
  create + write. Body: `{ name, description?, tags?, cases }`.
  Dataset source is stamped `'synthetic'`; per-case `metadata.mode =
'description'` distinguishes it from KB / failure-mining synthesis.

**Why this isn't Phase 3.5.** Phase 3.5 is two scoped follow-ups
deferred from Phase 3 (pairwise verdict endpoint + workflow-aware
cost estimator). Phase 3.6 is a separate, orthogonal piece of work
on the dataset cold-start gap; bundling it would muddle the changelog.

### Editable cases (pre-commit and post-commit)

The review step's `input` and `expectedOutput` fields are editable
textareas in both the per-dataset `GenerateCasesButton` modal and the
cold-start `GenerateFromDescriptionForm`. The parent owns the preview
state; `CaseReviewStep` accepts an `onEdit(i, patch)` callback and the
parent merges the patch into the proposals array, so the commit step
sends whatever the admin last typed. Object inputs (workflow subjects)
stay read-only — freeform JSON editing is fragile and the generator
emits string inputs in current flows.

Post-commit, the dataset detail page's case-preview table grows a
per-row **Edit** button that opens a Dialog. Saving PATCHes the new
per-case endpoint:

- `PATCH /evaluations/datasets/:id/cases/:position` — partial patch
  body `{ input?, expectedOutput?, metadata?, referenceCitations? }`
  (Zod-strict, at-least-one-field required). The handler updates the
  case + re-hashes the dataset + bumps `contentHash` and `updatedAt`
  in one Prisma transaction. `expectedOutput`/`metadata`/`referenceCitations`
  accept `null` to clear the field; `input` must stay populated.

**Why edits are safe for past runs.** `AiEvaluationRun.datasetContentHash`
is pinned at queue time, so completed runs are immune to later edits.
The worker's hash-pin check on claim still detects mismatches if an
in-flight run's dataset has drifted, marking it `failed` with
`summary.note = 'dataset_changed_post_submit'`. Position remains
stable across edits (it's the join key against
`AiEvaluationCaseResult.casePosition`), so drilling into a historical
result still resolves the correct row.

### Trajectory diagnostics on the case-detail dialog

The per-case drill-in dialog on `/runs/[id]` renders two diagnostic
sections sourced from the worker's persisted
`AiEvaluationCaseResult.subjectMetadata`:

- **Tool calls (N)** — per-tool row with slug, success/error badge,
  errorCode (when failed), latency, and the LLM-supplied arguments.
  Empty state explains the three common causes of a
  `tool_was_called` 0/N failure (no tool-use directive in the agent's
  prompt, input didn't demand retrieval, capability not actually
  bound + enabled).
- **Citations (N)** — each cited source the agent emitted (title +
  uri + marker). Hidden when empty.

The data was already on the row; this surface closes the
"`tool_was_called` failed, why?" debugging loop without a Prisma
query.

### `tool_was_called` slug picker

On `/runs/new`, the `tool_was_called` grader's slug field renders as
a dropdown listing the **enabled** capabilities bound to the
currently-selected subject agent — fetched live from
`GET /agents/:id/capabilities` when the agent picker changes.
Disabled capability rows are filtered out client-side so the operator
can't pick a tool the agent isn't wired to. Workflow subjects, agents
with no capabilities yet, and the brief moment before the fetch
resolves keep the original free-text input as a fallback — a workflow
step may bind a tool the agent itself doesn't, and we don't want to
block typing a slug we can't enumerate.

**Critical files**:

| Concern             | Path                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Help copy + samples | `components/admin/orchestration/evaluations-foundations/help-text.ts`                                                 |
| Download formatters | `lib/orchestration/evaluations/datasets/sample-formatters.ts`                                                         |
| Download buttons    | `components/admin/orchestration/evaluations-foundations/sample-download-buttons.tsx`                                  |
| Anatomy card        | `components/admin/orchestration/evaluations-foundations/dataset-anatomy-card.tsx`                                     |
| Tabs wrapper        | `components/admin/orchestration/evaluations-foundations/dataset-new-tabs.tsx`                                         |
| Generate form       | `components/admin/orchestration/evaluations-foundations/generate-from-description-form.tsx`                           |
| Shared review pane  | `components/admin/orchestration/evaluations-foundations/case-review-step.tsx`                                         |
| Description mode    | `lib/orchestration/evaluations/synthesis/case-generator.ts`                                                           |
| Preview endpoint    | `app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/route.ts`                              |
| Commit endpoint     | `app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit/route.ts`                       |
| Zod schemas         | `lib/validations/orchestration-evaluations.ts` (`generateFromDescription{Preview,Commit}Schema`)                      |
| Seed prompt         | `prisma/seeds/017-case-generator-agent.ts`                                                                            |
| Per-case PATCH      | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route.ts`                                  |
| PATCH Zod schema    | `lib/validations/orchestration-evaluations.ts` (`patchDatasetCaseSchema`)                                             |
| Edit dialog         | `components/admin/orchestration/evaluations-foundations/dataset-cases-table.tsx`                                      |
| Trace diagnostics   | `components/admin/orchestration/evaluations-foundations/run-detail-view.tsx` (`ToolCallsSection`, `CitationsSection`) |

## Critical files

| Concern                 | Path                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Schema                  | `prisma/schema.prisma` (AiDataset, AiDatasetCase, AiEvaluationRun, AiEvaluationCaseResult) |
| Worker                  | `lib/orchestration/evaluations/run-worker.ts`                                              |
| Lease helpers           | `lib/orchestration/evaluations/run-claim.ts`                                               |
| Agent case dispatch     | `lib/orchestration/evaluations/run-cases/agent-case.ts`                                    |
| Workflow case dispatch  | `lib/orchestration/evaluations/run-cases/workflow-case.ts`                                 |
| Shared judge driver     | `lib/orchestration/evaluations/judge-driver.ts`                                            |
| judge_call step         | `lib/orchestration/engine/executors/judge-call.ts`                                         |
| workflow_as_judge       | `lib/orchestration/evaluations/graders/model/workflow-as-judge.ts`                         |
| pairwise_judge_agent    | `lib/orchestration/evaluations/graders/pairwise/judge-agent.ts`                            |
| RAG judges seed         | `prisma/seeds/018-rag-evaluation-judges.ts`                                                |
| Dataset upload          | `lib/orchestration/evaluations/datasets/upload-handler.ts`                                 |
| CSV parser              | `lib/orchestration/evaluations/datasets/parsers/csv-parser.ts`                             |
| JSONL parser            | `lib/orchestration/evaluations/datasets/parsers/jsonl-parser.ts`                           |
| Hash function           | `lib/orchestration/evaluations/datasets/hash.ts`                                           |
| Grader registry         | `lib/orchestration/evaluations/graders/registry.ts`                                        |
| Grader types            | `lib/orchestration/evaluations/graders/types.ts`                                           |
| judge_agent grader      | `lib/orchestration/evaluations/graders/model/judge-agent.ts`                               |
| Judge agents seed       | `prisma/seeds/016-evaluation-judges.ts`                                                    |
| drainStreamChat         | `lib/orchestration/evaluations/drain-stream-chat.ts`                                       |
| Tick wiring             | `app/api/v1/admin/orchestration/maintenance/tick/route.ts`                                 |
| Cost estimator          | `lib/orchestration/cost-estimation/evaluation-cost.ts`                                     |
| Estimate route          | `app/api/v1/admin/orchestration/evaluations/runs/estimate/route.ts`                        |
| Append helper           | `lib/orchestration/evaluations/datasets/append-cases.ts`                                   |
| Capture helpers         | `lib/orchestration/evaluations/datasets/capture.ts`                                        |
| Capture route           | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/capture/route.ts`                |
| Synthesis seed-loader   | `lib/orchestration/evaluations/synthesis/seed-loader.ts`                                   |
| Case generator          | `lib/orchestration/evaluations/synthesis/case-generator.ts`                                |
| Generator agent seed    | `prisma/seeds/017-case-generator-agent.ts`                                                 |
| Synthesis preview route | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/route.ts`         |
| Synthesis commit route  | `app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/commit/route.ts`  |
| Experiment run route    | `app/api/v1/admin/orchestration/experiments/[id]/run/route.ts`                             |
| Phase 2.4 migration     | `prisma/migrations/20260525173530_add_experiment_dataset_fields/`                          |
| Welch t-test            | `lib/orchestration/evaluations/stats/welch.ts`                                             |
| Cohen's d               | `lib/orchestration/evaluations/stats/cohens-d.ts`                                          |
| Winner decision         | `lib/orchestration/evaluations/stats/winner.ts`                                            |
| Compare page            | `app/admin/orchestration/experiments/[id]/compare/page.tsx`                                |
| Compare table component | `components/admin/orchestration/experiments/variant-compare-table.tsx`                     |
| API routes              | `app/api/v1/admin/orchestration/evaluations/{datasets,runs,graders}/`                      |
| UI pages                | `app/admin/orchestration/evaluations/{datasets,runs}/`                                     |
| UI components           | `components/admin/orchestration/evaluations-foundations/`                                  |
| UI copy                 | `components/admin/orchestration/evaluations-foundations/help-text.ts`                      |
| Validation schemas      | `lib/validations/orchestration-evaluations.ts`                                             |
