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
   stub for workflow subjects until Phase 3), run every configured
   grader, write the `AiEvaluationCaseResult` row, throttle progress
   writes (every 5 cases).
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
picked via `config.agentSlug` at run time). Six seeded by
`prisma/seeds/016-evaluation-judges.ts`:

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

**Pairwise** — declared family on the registry, no built-ins yet.
Pairwise judges land in Phase 3 (experiment compare view).

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

- Workflow-as-subject — schema is wired, worker has a stub branch
  returning a typed `workflow_subject_not_supported_in_phase_1` error,
  the run-creation API rejects `subjectKind: 'workflow'` at the route
  boundary. Phase 3 ships the UI.
- Pairwise graders, RAG-specific Ragas metrics, trace-to-dataset
  capture, synthetic case generation — all land in Phase 2/3.
- Cost estimate on the run-create form is a coarse heuristic; the
  proper estimator is a Phase 2 follow-up.
- No CI gating endpoint yet — Phase 4.

## Roadmap: judges in workflows

Confirmed as future work. Two complementary integrations let workflows
use the judge agents that already exist; no schema changes needed for
either, just new code in `lib/orchestration/engine/executors/` and the
grader registry.

### Direction 1 — `judge_call` workflow step type

A new step executor in `lib/orchestration/engine/executors/judge-call.ts`,
modelled on the existing `evaluate.ts` step. Config shape:

```ts
{
  judgeAgentSlug: string;
  question: string | TemplateRef;
  answer: string | TemplateRef;
  expectedOutput?: string | TemplateRef;
  citations?: CitationsRef;
}
```

The executor constructs the same structured user-message payload the
batch worker uses, drives the named judge agent via `streamChat`,
parses the `{score, reasoning, evaluationSteps}` envelope, and returns
a typed step output workflows can route on. Unlocks:

| Pattern              | What it enables                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Inline QA gate       | Workflow → agent_call → judge_call → branch: publish if score ≥ threshold, escalate otherwise            |
| Self-review loop     | agent_call → judge_call → if score < threshold, agent_call again with feedback in prompt → max-N retries |
| Multi-judge approval | Parallel branches of 3 judge_calls → aggregate → require all 3 above threshold                           |
| Cost-aware routing   | Cheap heuristic check first (existing step); only run a judge_call if uncertain                          |

Estimated lift: ~150 LOC + tests. The reusable surface (judge agents,
`drainStreamChat`, JSON parser) is already in place from Phase 1.5.

### Direction 2 — `workflow_as_judge` grader family

The inverse: an entire workflow used AS a judge in evaluation runs. A
new grader-family entry alongside `judge_agent`:

```ts
{ slug: 'workflow_as_judge', config: { workflowSlug, inputMapping } }
```

The grader executes the workflow with the case input + subject output
as workflow variables, expects the workflow to output a
`{score, reasoning}` envelope from its final step. Unlocks:

- Pairwise grading (workflow runs two candidates, judge picks the winner)
- Knowledge-grounded judging with capability use (judge agent can call
  `lookup_authoritative_answer` mid-judging before scoring)
- Conditional rubric application (different scoring path per question type)
- A/B in production (workflow routes traffic to two variants and
  records the score delta as an evaluation result)

Estimated lift: ~200 LOC + tests + a `workflow_as_judge.test.ts` round-
trip integration test. Schema is already forward-compatible
(`AiEvaluationRun.subjectKind` already supports `workflow` as a subject
type; `workflow_as_judge` reuses the same workflow execution path).

### What's NOT being added

- Workflow-per-case (every dataset case its own workflow execution).
  Considered, rejected: 100s of WorkflowExecution rows per run pollutes
  the executions list and the workflow engine is tuned for tens of
  executions per workflow, not hundreds per dataset. Workflow-as-judge
  uses one workflow definition driving many cases — the right shape.
- A first-class "evaluation workflow" template type. Keep workflows
  generic; let the `judge_call` step + `workflow_as_judge` grader
  compose into eval-shaped workflows organically.

## Critical files

| Concern             | Path                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Schema              | `prisma/schema.prisma` (AiDataset, AiDatasetCase, AiEvaluationRun, AiEvaluationCaseResult) |
| Worker              | `lib/orchestration/evaluations/run-worker.ts`                                              |
| Lease helpers       | `lib/orchestration/evaluations/run-claim.ts`                                               |
| Agent case dispatch | `lib/orchestration/evaluations/run-cases/agent-case.ts`                                    |
| Workflow case stub  | `lib/orchestration/evaluations/run-cases/workflow-case.ts`                                 |
| Dataset upload      | `lib/orchestration/evaluations/datasets/upload-handler.ts`                                 |
| CSV parser          | `lib/orchestration/evaluations/datasets/parsers/csv-parser.ts`                             |
| JSONL parser        | `lib/orchestration/evaluations/datasets/parsers/jsonl-parser.ts`                           |
| Hash function       | `lib/orchestration/evaluations/datasets/hash.ts`                                           |
| Grader registry     | `lib/orchestration/evaluations/graders/registry.ts`                                        |
| Grader types        | `lib/orchestration/evaluations/graders/types.ts`                                           |
| judge_agent grader  | `lib/orchestration/evaluations/graders/model/judge-agent.ts`                               |
| Judge agents seed   | `prisma/seeds/016-evaluation-judges.ts`                                                    |
| drainStreamChat     | `lib/orchestration/evaluations/drain-stream-chat.ts`                                       |
| Tick wiring         | `app/api/v1/admin/orchestration/maintenance/tick/route.ts`                                 |
| API routes          | `app/api/v1/admin/orchestration/evaluations/{datasets,runs,graders}/`                      |
| UI pages            | `app/admin/orchestration/evaluations/{datasets,runs}/`                                     |
| UI components       | `components/admin/orchestration/evaluations-foundations/`                                  |
| UI copy             | `components/admin/orchestration/evaluations-foundations/help-text.ts`                      |
| Validation schemas  | `lib/validations/orchestration-evaluations.ts`                                             |
