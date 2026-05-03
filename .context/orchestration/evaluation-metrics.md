# Named evaluation metrics

LLM-as-judge scoring of AI responses against three named rubrics —
**faithfulness**, **groundedness**, **relevance** — produced when an
evaluation session is completed (or re-scored). Lives alongside the
existing AI-written summary; doesn't replace it.

This doc is the canonical spec. Cross-references:

- Admin UI: `.context/admin/orchestration-evaluations.md` (Named metric scoring section)
- Citations dependency: `.context/orchestration/chat.md` (Citations section)
- Streaming-handler eval-log mirroring: `lib/orchestration/chat/streaming-handler.ts`

## Why these three

Recognisable to anyone who's built RAG before — the Haystack standard
rubric — which matters when a partner's domain expert wants to validate
the agent before launch.

| Metric           | What it measures                                                                                                                                                         | Depends on                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Faithfulness** | For each `[N]`-marked claim, does citation [N]'s excerpt actually support it? Penalises unsupported claims and hallucinated markers.                                     | Citations (search_knowledge_base)                                  |
| **Groundedness** | Beyond inline markers, are the substantive claims in the answer backed by _any_ of the cited excerpts (or clearly common knowledge)? Penalises free-floating assertions. | RAG retrieval being available, but tolerates no-citation responses |
| **Relevance**    | Does the answer address what the user asked? 0 = off-topic, 0.5 = partial, 1 = direct on-topic.                                                                          | Nothing — pure Q/A pair                                            |

Faithfulness can return `null` when the answer carries no inline `[N]`
markers (no citations to verify). Groundedness and relevance always
return a number.

## Data model

### `AiEvaluationLog`

Four nullable columns added by migration `evaluation_metrics`:

| Column              | Type     | Purpose                                                                                  |
| ------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `faithfulnessScore` | `Float?` | 0..1, null until scored or when no inline markers                                        |
| `groundednessScore` | `Float?` | 0..1, null until scored                                                                  |
| `relevanceScore`    | `Float?` | 0..1, null until scored                                                                  |
| `judgeReasoning`    | `Json?`  | `{ faithfulness: { reasoning }, groundedness: { reasoning }, relevance: { reasoning } }` |

Real columns (not JSON paths) so SQL aggregation across logs is cheap.
Reasoning stays in JSON because it's display-only.

Citations are snapshotted onto `AiEvaluationLog.metadata.citations` at
log-write time (see `streaming-handler.ts.writeEvaluationLog`) — frozen
with the turn so the judge sees what the answerer actually had access
to, not whatever the source document looks like later.

### `AiEvaluationSession`

One column added: `metricSummary Json?` carrying the aggregate produced
at completion / refreshed on rescore:

```ts
interface EvaluationMetricSummary {
  avgFaithfulness: number | null; // null if no log produced a faithfulness score
  avgGroundedness: number | null;
  avgRelevance: number | null;
  scoredLogCount: number;
  judgeProvider: string;
  judgeModel: string;
  scoredAt: string; // ISO timestamp; refreshed on rescore
  totalScoringCostUsd: number; // cumulative across rescores
}
```

Powers the list-page Quality column and the per-agent trend chart
without per-list joins to the log table.

## Scoring lifecycle

### At completion

`completeEvaluationSession` runs the existing summary call first, then
calls `scoreEvaluationLogs` over every `ai_response` log (capped at
`MAX_LOGS_IN_PROMPT = 50`, same as the summary).

For each `ai_response` log:

1. Find the immediately-preceding `user_input` log to reconstruct the question.
2. Read citations from `log.metadata.citations` (snapshotted at log-write time).
3. Call `scoreResponse({ userQuestion, aiResponse, citations, judgeProvider, judgeModel })` — one judge LLM call returning all three scores in a single structured-JSON response.
4. Persist scores back to `AiEvaluationLog` via `update`.

After the loop, aggregate averages are computed (mean of non-null scores)
and persisted on `AiEvaluationSession.metricSummary`.

### On rescore

`rescoreEvaluationSession` is gated on `status === 'completed'`. It
overwrites scores in place, refreshes `metricSummary.scoredAt`, and
**accumulates** `totalScoringCostUsd` across runs (rescore appends to
the running total, doesn't replace it).

No score history is retained. If versioned scoring becomes important
later, an `AiEvaluationScoreSnapshot` table can be added without
schema upheaval.

## Judge prompt

System prompt encodes the rubric for each metric. User content carries
the question, answer, and a JSON-formatted list of citations capped at
12 entries with excerpts truncated to 600 chars.

Output contract — the judge MUST respond with:

```json
{
  "faithfulness": { "score": 0.0, "reasoning": "..." },
  "groundedness": { "score": 0.0, "reasoning": "..." },
  "relevance": { "score": 0.0, "reasoning": "..." }
}
```

`faithfulness.score` may be `null` (only when there are no inline
`[N]` markers — explicit reasoning of "no inline citations to evaluate"
is expected). `groundedness` and `relevance` must be numbers in `[0, 1]`.

Malformed responses retry once with a stricter prompt at temperature 0.
Both attempts going through `runStructuredCompletion`
(`lib/orchestration/evaluations/parse-structured.ts`) — the same
machinery the summary call uses. The retry never includes the
malformed prior response in the prompt.

## Cost accounting

Two `AiCostLog` rows per completion (one per phase):

- **Summary phase**: `operation: 'evaluation'`, `metadata: { phase: 'summary' }`, model = the agent's own.
- **Scoring phase**: `operation: 'evaluation'`, `metadata: { phase: 'scoring', logsScored: N }`, model = `JUDGE_MODEL`.

Analytics can split summary spend from scoring spend by filtering on
`metadata->>'phase'` without needing a new `CostOperation` enum value.

## Configuration

Two env vars, both optional, both falling through to the existing
`EVALUATION_DEFAULT_*` defaults:

```bash
EVALUATION_JUDGE_PROVIDER=anthropic       # defaults to EVALUATION_DEFAULT_PROVIDER
EVALUATION_JUDGE_MODEL=claude-sonnet-4-6  # defaults to EVALUATION_DEFAULT_MODEL
```

Standard practice is **judge ≥ subject** — give a Haiku-powered agent a
Sonnet judge, give a Sonnet-powered agent an Opus judge. Same-model
judging works but biases the result (the model that hallucinated is
unlikely to flag its own hallucinations).

## Failure modes

| Failure                                  | Behaviour                                                                      | Where it surfaces                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Per-log judge call throws                | Swallowed at warn level; loop continues                                        | `scoredLogCount` < total ai_response count |
| Judge returns malformed JSON twice       | Per-log call throws → swallowed                                                | Same as above                              |
| Judge provider unavailable wholesale     | Outer try/catch logs error; session still completes with `metricSummary: null` | Re-score button available later            |
| Judge claims a real claim is unsupported | Reasoning text in the chip popover lets the admin spot it                      | Per-message chip with reasoning            |

## Ownership enforcement on log writes

`writeEvaluationLog` (`lib/orchestration/chat/streaming-handler.ts`) verifies
that the evaluation session referenced by `request.contextId` belongs to
`request.userId` before any rows are inserted. The check uses the same
`findFirst({ where: { id, userId } })` idiom as the rest of the evaluation
surface — null result means "not yours" (whether missing or cross-user).
On a denial we log a warn and mark the per-handler cache `denied` so every
subsequent event for the same session is a silent no-op for the rest of
the turn.

This closes a finding from the post-merge security review: without the
check, an admin could submit a chat with `contextType: 'evaluation'` and
another admin's session id, mirroring crafted Q/A turns into that
session's logs. When the legitimate owner later ran `/complete` or
`/rescore`, the judge would score the attacker's turns alongside theirs
and distort the metric averages. All admin users on the same instance
are nominally trusted, but the check is cheap (one cached query per
turn) and prevents accidental cross-pollination as well as deliberate
abuse.

## Tradeoffs and known limits

- **Per-message scores are noisy.** Averages across ≥20 messages are
  meaningful; individual scores are directional. The runner UI surfaces
  this caveat below 20 messages, and the trend chart caption repeats it.
- **Re-score overwrites in place.** No score history is retained.
  Versioned scoring is an additive future change.
- **Judge can be wrong.** A judge LLM hallucinating low scores is itself a
  failure mode. Reasoning text is always shown alongside the number so
  admins can spot judge errors. Standard mitigation; not solved here.
- **No live (per-turn) scoring.** Scoring is lazy at completion to keep
  the chat path fast and to allow batched cost accounting. Live scoring
  is a follow-up if anyone asks.
- **Citations gate faithfulness.** If a turn produced no citations
  (no `search_knowledge_base` call), faithfulness defaults to `null` and
  the chip renders "n/a". Groundedness still scores.

## Critical files

| Concern                                     | Path                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Judge scorer                                | `lib/orchestration/evaluations/score-response.ts`                                                                                          |
| Shared structured-completion + parse helper | `lib/orchestration/evaluations/parse-structured.ts`                                                                                        |
| Completion + rescore handlers               | `lib/orchestration/evaluations/complete-session.ts`                                                                                        |
| Eval log mirroring (citations snapshot)     | `lib/orchestration/chat/streaming-handler.ts` (`writeEvaluationLog`)                                                                       |
| Schema migration                            | `prisma/migrations/20260503160012_evaluation_metrics/migration.sql`                                                                        |
| Type contracts                              | `lib/orchestration/evaluations/types.ts`                                                                                                   |
| API routes                                  | `app/api/v1/admin/orchestration/evaluations/[id]/rescore/route.ts`, `app/api/v1/admin/orchestration/agents/[id]/evaluation-trend/route.ts` |
| UI chips                                    | `components/admin/orchestration/evaluation-metric-chips.tsx`                                                                               |
| UI trend chart                              | `components/admin/orchestration/evaluation-trend-chart.tsx`                                                                                |
| Runner integration                          | `components/admin/orchestration/evaluation-runner.tsx`                                                                                     |
| List-page Quality column                    | `components/admin/orchestration/evaluations-table.tsx`                                                                                     |
