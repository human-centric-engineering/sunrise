# Evaluation pages

Admin surface for two complementary evaluation flows: **manual sessions** (a human chats with one agent and annotates each turn) and **dataset-driven batch runs** (the worker fires every case in a dataset at an agent or workflow, then a judge agent scores each response). Sessions landed in Phase 7; batch runs in Phase 1 of the eval-foundations work.

> **Scope note.** Evaluation **sessions** are for auditing an _agent's chat turns_ (faithfulness, groundedness, relevance — see `.context/orchestration/evaluation-metrics.md`). For auditing a _workflow execution_, use the `supervisor` step type or the retroactive review endpoint. Batch **runs** are the larger story — see `.context/orchestration/evaluations.md` for the worker, the agent-as-judges architecture, the grader registry, and the dataset/result schema. Both flows now drive the same six seeded judge agents.

**Pages**

| Route                                            | File                                                         | Role                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `/admin/orchestration/evaluations`               | `app/admin/orchestration/evaluations/page.tsx`               | Sessions + Experiments tabs. Top strip links to Datasets and Batch runs sub-pages.      |
| `/admin/orchestration/evaluations/new`           | `app/admin/orchestration/evaluations/new/page.tsx`           | Manual session create form                                                              |
| `/admin/orchestration/evaluations/[id]`          | `app/admin/orchestration/evaluations/[id]/page.tsx`          | Manual session runner/viewer                                                            |
| `/admin/orchestration/evaluations/datasets`      | `app/admin/orchestration/evaluations/datasets/page.tsx`      | Datasets list with the "Evaluation 101" empty-state card                                |
| `/admin/orchestration/evaluations/datasets/new`  | `app/admin/orchestration/evaluations/datasets/new/page.tsx`  | Upload form — CSV / JSONL with auto-seeded name and FieldHelp on every field            |
| `/admin/orchestration/evaluations/datasets/[id]` | `app/admin/orchestration/evaluations/datasets/[id]/page.tsx` | Read-only detail + first 50 cases preview + "Run against this dataset" CTA              |
| `/admin/orchestration/evaluations/runs`          | `app/admin/orchestration/evaluations/runs/page.tsx`          | Batch runs list (status badges, progress %, cost)                                       |
| `/admin/orchestration/evaluations/runs/new`      | `app/admin/orchestration/evaluations/runs/new/page.tsx`      | Single-page create form — basics / subject / dataset / heuristic graders / judge agents |
| `/admin/orchestration/evaluations/runs/[id]`     | `app/admin/orchestration/evaluations/runs/[id]/page.tsx`     | Run detail with 3 s polling, summary table, per-case drill-in dialog                    |

All pages are async server components using `serverFetch()` + `parseApiResponse()`. Fetch failures fall back to empty state or `notFound()`. The run-detail and form pages hand off to client components for interactive parts.

## What landed in Phase 2

All four items shipped end-to-end. See
[`.context/orchestration/evaluations.md`](../orchestration/evaluations.md)
for the route/component-level spec; this section is the operator's
quick map.

1. **Empirical cost estimator on the run-create form.** Replaces the
   old "cases × ~600 tokens" UI-copy heuristic with a live
   `POST /evaluations/runs/estimate` call (debounced 350ms). Shows
   mid + range + an `empirical` / `heuristic` badge. Empirical mode
   kicks in once ≥3 prior runs match `(agentId, judgeAgentSlugs,
datasetContentHash)`.
2. **Trace-to-dataset capture.** `POST /datasets/:id/capture` lets an
   admin convert a real prod conversation turn or workflow execution
   output into a new dataset case. The case picks up the source
   message's citations as `referenceCitations`. Three-layer ownership
   check (dataset + source conversation + source execution) so a user
   can't capture another user's traffic.
3. **Synthetic case generation.** Two modes — `kb` (sample the agent's
   accessible knowledge chunks) and `failure_mining` (sample
   low-scoring prior cases). Preview via
   `POST /datasets/:id/generate-cases` (sub-capped at 10/min/user),
   commit accepted cases via `.../generate-cases/commit`. The
   generator agent is `kind='generator'` (new kind, seeded by
   `017-case-generator-agent`) — kept distinct from `kind='judge'` so
   it doesn't pollute the judge picker.
4. **Experiment compare view.** Dataset-driven experiments
   (`AiExperiment.datasetId` + `metricConfigs`, Phase 2.4 migration)
   create one `AiEvaluationRun` per variant against a shared dataset.
   `/experiments/:id/compare` renders a per-metric × variant grid
   with Welch's t-test + Cohen's d badges and a winner badge when all
   three thresholds pass (higher mean ∧ p < 0.05 ∧ |d| ≥ 0.5).

**UI wiring that still needs hooking up.** The capture and synthesis
APIs are live but the admin entry points (a "Save to dataset" button
on the conversations + workflow execution detail pages, a "Generate
cases" button on the dataset detail page) are tracked as follow-up UI
polish. Operators can drive both flows via the API today; the buttons
are mechanical to add and will land in the next UI sweep.

## Batch run flow (Phase 1)

The headline new surface. End-to-end journey:

1. **Upload a dataset** (`/datasets/new`). Drag-drop CSV or JSONL; required column is `input`, everything else optional (`expectedOutput`, `tags`, `metadata`, `referenceCitations`). The form auto-seeds the dataset name from the filename stem, validates extension + size client-side, posts multipart to `POST /api/v1/admin/orchestration/evaluations/datasets`.
2. **Queue a run** (`/runs/new`). Pick subject (agent only in Phase 1), pick dataset, tick metrics from two sections — heuristic graders (cheap deterministic) and judge agents (built-in + custom). Submit → `POST /api/v1/admin/orchestration/evaluations/runs` validates ownership, pre-flights graders, pins `subjectBrandVoice` into the brand-voice judge config, queues the run.
3. **Watch it process** (`/runs/[id]`). Polls every 3 s while queued/running. Shows progress bar, then summary table after completion (mean / median / p95 / passRate per metric). Per-case results table; click a row → drill-in dialog with the judge's full reasoning + chain-of-thought `evaluation_steps`.
4. **Cancel anytime**. The Cancel button on the detail page flips the run to 'cancelled'; the worker picks it up between cases.

The Evaluation 101 card on the empty-state for both datasets and runs explains the model — what datasets are, what graders do, what runs produce. Tone is plain English with concrete actions; copy lives in `components/admin/orchestration/evaluations-foundations/help-text.ts` so the FieldHelp wording stays auditable in one place.

## Judge agent picker

The run-create form loads judge agents live from `/api/v1/admin/orchestration/evaluations/graders` and groups them into **Built-in** and **Custom** subsections. Each row shows the agent's name, slug, model, description, and an `[edit]` link that opens the agent form in a new tab so admins can tune the rubric without leaving the picker. A "Create custom judge" CTA navigates to `/admin/orchestration/agents/new?kind=judge` — the agent form pre-selects `kind=judge` and shows a judge-creation explainer.

Ticking a judge adds `{ slug: 'judge_agent', config: { agentSlug } }` to the run's metric configs. The API resolves the agent at queue time, verifies it's `kind='judge'` + active, and pins `subjectBrandVoice` for the brand-voice judge.

## List page

**Table:** `components/admin/orchestration/evaluations-table.tsx` (client component).

Columns:

| Column  | Source              | Notes                                             |
| ------- | ------------------- | ------------------------------------------------- |
| Title   | `evaluation.title`  | Links to detail/runner page                       |
| Agent   | `evaluation.agent`  | Agent name or `—` if deleted                      |
| Status  | `evaluation.status` | Badge: draft / in_progress / completed / archived |
| Logs    | `_count.logs`       | Right-aligned count                               |
| Created | `createdAt`         | Locale date string                                |
| Actions | —                   | Dropdown menu (Archive). Hidden for archived rows |

### Filters

- **Search**: 300ms debounced, sends `q` query param (title search)
- **Agent filter**: dropdown populated from prefetched agents list
- **Status filter**: dropdown with draft / in_progress / completed / archived

### Pagination

Previous/Next buttons, server-side pagination via `page` + `limit` params.

### Row actions

Each non-archived row has a `...` dropdown menu with:

- **Archive** — opens a confirmation dialog, PATCHes `status: 'archived'`, removes row from list on success

## Create page

**Form:** `components/admin/orchestration/evaluation-form.tsx` (react-hook-form + zodResolver).

| Field       | Type     | Validation      | FieldHelp |
| ----------- | -------- | --------------- | --------- |
| Agent       | Select   | Required        | ✓         |
| Title       | Input    | Required, ≤200  | ✓         |
| Description | Textarea | Optional, ≤5000 | ✓         |

On submit: POSTs to `/evaluations`, redirects to `/evaluations/{id}` on success.

## Runner page (detail)

**Component:** `components/admin/orchestration/evaluation-runner.tsx` — the core of the evaluation experience.

### Action bar

Above the split panel:

- **Archive button** — opens confirmation dialog, PATCHes status to `archived`. Available for draft/in_progress evaluations.

### Layout

Split-panel grid (`grid-cols-1 lg:grid-cols-2`):

- **Left panel**: Inline SSE chat connected to the evaluation's agent
- **Right panel**: Per-message annotation tools

### Chat panel

Built inline (not using `ChatInterface` component) for full message-tracking control. Uses the same SSE streaming pattern via `parseSseBlock()` from `lib/api/sse-parser.ts`. Sends `contextType: 'evaluation'` and `contextId: evaluation.id`.

**Log restoration on mount:** When returning to an in-progress evaluation, the runner fetches existing logs via `GET /evaluations/{id}/logs?limit=500` and reconstructs the message history. Only `user_input` and `ai_response` event types are rendered as chat messages.

### Annotation panel

Header includes a manual **Save button** (floppy disk icon) for immediate annotation persistence.

Each message entry is expandable with:

- **Category buttons**: Expected / Unexpected / Issue / Observation (radio-style toggle)
- **Rating slider**: 1–5 (default 3)
- **Notes textarea**: free-text

Annotations are stored in React state as `Map<number, Annotation>`.

### Annotation limit

The metadata format supports a maximum of **24 non-default annotations** (4 keys each + `ann_count` = 97 keys max, within the 100-key metadata limit).

- **Warning banner**: shown when 4 or fewer slots remain
- **Limit reached banner**: shown at 0 remaining slots

### Annotation persistence

> **Important:** Annotations are persisted to session metadata for record-keeping, but are **not** fed to the AI analysis. The `/complete` endpoint analyses the conversation logs (transcript) only. Annotations serve as the evaluator's own notes.

Annotations are persisted to the session's `metadata` field via PATCH as flat keys:

```
ann_count: 3
ann_0_idx: 0, ann_0_cat: "expected", ann_0_rat: 4, ann_0_notes: "Good response"
ann_1_idx: 2, ann_1_cat: "issue", ann_1_rat: 2, ann_1_notes: "Hallucinated"
```

The `metadataSchema` only allows `Record<string, string|number|boolean|null>` with max 100 keys.

**Save mechanisms:**

1. **Auto-save**: 30-second debounce after any annotation change (uses `annotationsRef.current` to avoid stale closures)
2. **Manual save**: Save button in annotation panel header for immediate persistence
3. **Pre-completion save**: annotations are saved before triggering AI analysis

### Status transitions

| From                   | To          | Trigger                                                              |
| ---------------------- | ----------- | -------------------------------------------------------------------- |
| draft                  | in_progress | Auto-PATCH on runner mount (useEffect with ref guard)                |
| in_progress            | completed   | User clicks "Complete Evaluation" → confirms dialog → POST /complete |
| any (except completed) | archived    | Archive button (with confirmation) or manual PATCH via API           |

> **Note:** Archived sessions cannot be completed. The `/complete` endpoint returns `409 Conflict` for both `completed` and `archived` sessions.

### Completion flow

1. User clicks "Complete Evaluation" button
2. **Confirmation dialog** appears warning the action is irreversible
3. On confirm: final PATCH to save annotations to metadata
4. POST to `/evaluations/{id}/complete` (triggers AI analysis)
5. Loading state during analysis ("Analysing…")
6. On success: transitions to completed view

### Completed view

Read-only view showing:

- Evaluation metadata (title, description, agent, dates)
- AI-generated summary (prose block)
- Improvement suggestions (bulleted list)
- Token usage and cost info
- **Quality scores card** — average faithfulness/groundedness/relevance plus the judge model and `scoredLogCount`. Shows a noisy-scores caveat below 20 messages. See "Named metric scoring" below.
- **Re-score button** — re-runs the metric scorer (faithfulness, groundedness, relevance) over the existing transcript. Useful after a knowledge-base update or prompt change. Confirmation dialog; cumulative cost tracked on `metricSummary.totalScoringCostUsd`.
- **Conversation transcript** — loads from `/evaluations/{id}/logs` and renders as chat bubbles. Each assistant message carries three score chips (F/G/R) with a popover showing the judge's reasoning per metric. Shows "No transcript available." if logs are empty or fetch fails.

## Named metric scoring

Beyond the AI-written summary, completing a session runs an LLM-as-judge over each
`ai_response` log and produces three named scores. Spec: `.context/orchestration/evaluation-metrics.md`.

- **Faithfulness** — for every `[N]`-marked claim in the answer, does citation `[N]`'s
  excerpt actually support it? Penalises unsupported claims and hallucinated markers.
  Returns `null` when the answer carries no inline markers.
- **Groundedness** — beyond inline markers, are the substantive claims traceable to
  evidence at all? Penalises free-floating assertions.
- **Relevance** — does the answer address the user's question? 0 = entirely off-topic,
  1 = direct.

Scores live in `AiEvaluationLog.faithfulnessScore` / `groundednessScore` /
`relevanceScore` (`Float?`, 0..1). Per-metric judge reasoning is stored in
`AiEvaluationLog.judgeReasoning` (display-only). Aggregate averages and judge
metadata land on `AiEvaluationSession.metricSummary` for cheap list/aggregate
queries.

### Judge model

The judge model resolves through three layers:

```
EVALUATION_JUDGE_PROVIDER / EVALUATION_JUDGE_MODEL   # explicit judge (if set)
       ↓ (fall through when unset)
EVALUATION_DEFAULT_PROVIDER / EVALUATION_DEFAULT_MODEL   # shared eval default
       ↓ (fall through when unset)
System chat default (resolveAgentProviderAndModel('chat'))   # first active provider + configured default chat model
```

Standard practice — judge ≥ subject — so a Haiku-powered agent gets judged by a
stronger model. Set `EVALUATION_JUDGE_MODEL` explicitly in multi-provider
deployments where you want true independence. In single-provider deployments
(OpenAI-only, OpenRouter-only, Ollama-only) the bottom layer ensures evaluation
scoring works without any env-var configuration — the judge just uses whatever
the system has configured for chat.

Prior versions hard-coded `anthropic` / `claude-sonnet-4-6` as the bottom
fallback, which broke deployments without an Anthropic provider configured.

### Failure posture

- **Per-log judge errors** are swallowed (logged at warn level). One bad turn
  doesn't void the whole pass — `metricSummary.scoredLogCount` reflects the
  successful subset.
- **Wholesale scoring failure** (e.g. judge provider unavailable) leaves the
  session `completed` with the summary intact and `metricSummary: null`. Admins
  can hit "Re-score" later to retry once the provider is back.

### Re-score

`POST /api/v1/admin/orchestration/evaluations/:id/rescore` re-runs scoring over an
already-completed session. Overwrites scores in place; `totalScoringCostUsd`
accumulates across runs. 409 if the session isn't `completed`.

### Archived view

Simple centered message: "This evaluation has been archived." No chat panel or annotations rendered.

### Deleted agent handling

If the evaluation's agent has been deleted, the runner shows an error state explaining the agent is unavailable. The evaluation cannot be run but can still be viewed if already completed.

## Endpoint helpers

`lib/api/endpoints.ts` provides:

| Helper                     | Route                                     |
| -------------------------- | ----------------------------------------- |
| `EVALUATIONS`              | `/api/v1/admin/orchestration/evaluations` |
| `evaluationById(id)`       | `.../evaluations/${id}`                   |
| `evaluationComplete(id)`   | `.../evaluations/${id}/complete`          |
| `evaluationRescore(id)`    | `.../evaluations/${id}/rescore`           |
| `evaluationLogs(id)`       | `.../evaluations/${id}/logs`              |
| `agentEvaluationTrend(id)` | `.../agents/${id}/evaluation-trend`       |

## Key implementation details

### Stale closure prevention

The `updateAnnotation` callback uses `[]` deps for stable identity. The debounced auto-save reads from `annotationsRef.current` (a ref kept in sync with state) rather than relying on the closure-captured annotations value. This prevents saving stale/empty annotations.

### Log-to-message conversion

The `logsToMessages()` helper filters log entries to only `user_input` and `ai_response` event types, mapping them to `{ role, content }` chat messages. Capability calls and errors are excluded from the chat display.

### Annotation counting

`countActiveAnnotations()` counts entries with any non-default value (category set, rating != 3, or notes non-empty). This matches the serialization logic that skips fully-default entries.

## Related documentation

- [Admin API — Evaluations section](./../orchestration/admin-api.md) — HTTP contract
- [Chat interface](./../admin/orchestration-chat-interface.md) — Reusable chat component (not used directly here but same SSE contract)
- [SSE bridge](./../api/sse.md) — `sseResponse` helper, framing contract
