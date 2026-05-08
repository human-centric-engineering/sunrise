# Recipe: Long-running workflow that survives a deploy

A workflow whose total runtime exceeds a single process's lifetime — typically 30 seconds to several minutes of LLM work, external HTTP calls, and notifications. The combination of crash-survival mechanisms in the engine means a deploy mid-execution doesn't lose progress and doesn't double-fire side effects.

This recipe is shaped differently from the integration recipes (transactional-email, payment-charge, etc.). It's a **workflow assembly** recipe — how to compose existing step types so the runtime guarantees apply correctly. No new code, no new capability, just understanding which step types crash-survive how.

## Worked example

A scheduled workflow that runs nightly to summarise the day's support tickets, asks an agent to categorise them, and emails the operations team with the breakdown.

```text
schedule (cron) → external_call → agent_call → send_notification
                  (fetch tickets)  (categorise)  (email summary)
```

| Step          | Type                       | Why it's safe across a re-drive                                                                                                                                                                                                                     |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch tickets | `external_call`            | Dispatch cache: `${executionId}:${stepId}` — a re-drive returns the cached HTTP response without re-firing. The auto-derived `Idempotency-Key` header is also sent to the upstream API as a cooperative second-line dedup.                          |
| Categorise    | `agent_call` (single-turn) | Per-tool-iteration `AgentCallTurn` checkpoints. A crash during turn 4 of 6 resumes at turn 5 — the conversation is rebuilt from the prior 4 entries, and any tool calls inside completed turns return their cached results from the dispatch cache. |
| Email summary | `send_notification`        | Dispatch cache holds the `{ sent: true, channel: 'email', status: ... }` `StepResult`. A re-drive returns it without re-sending the email — important because the generic webhook path has no provider-side dedup.                                  |

## What happens on a deploy mid-execution

Suppose the host running this execution gets killed during the `agent_call` step's third tool iteration:

1. **Lease expiry** — the host's heartbeat stops. Within `LEASE_DURATION_MS = 3 min` the row's `leaseExpiresAt` lapses.
2. **Orphan sweep** — the next maintenance tick picks up `WHERE status='running' AND leaseExpiresAt < now()` and re-drives the row through `drainEngine(resumeFromExecutionId=...)`.
3. **State restoration** — `initRun` reads the row's `executionTrace` (rehydrating completed steps) AND `currentStepTurns` (rehydrating the in-flight `agent_call`'s prior tool iterations). `ctx.resumeTurns` is populated with the three completed turns.
4. **Replay without re-firing** — the `agent_call` executor walks its prior turns, rebuilds the LLM conversation array (including the assistant + tool result messages from the three completed iterations), and resumes the inner loop at iteration 3. Tool dispatches inside iterations 0–2 are NOT re-fired because the dispatch cache returns their cached results.
5. **Forward progress** — iteration 3 fires fresh LLM call → tool dispatch (cache miss → fires for the first time) → response. The step completes; the workflow continues to `send_notification`.
6. **Side-effect dedup at every boundary** — if the orphan sweep had triggered AFTER the email was sent but BEFORE the trace write landed, the re-drive's `send_notification` would hit the dispatch cache and return without re-sending.

Detection latency from host death to recovery is bounded by `LEASE_DURATION_MS + tick cadence` — typically under 4 minutes.

## Failure paths

| Scenario                                                      | Behaviour                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy mid-LLM-call                                           | The LLM call's tokens are billed via `AiCostLog` regardless. On re-drive, the iteration the crash hit re-fires (LLM call repeats, paying tokens again); prior iterations skip.                                                                                                                        |
| Deploy after LLM but before tool dispatch                     | LLM tokens billed twice (one per attempt); tool dispatch fires once on the resumed run.                                                                                                                                                                                                               |
| Deploy after tool dispatch but before turn checkpoint         | Tool dispatch runs once (P2002 on the second attempt's `recordDispatch`); but the resumed run sees a cache miss for the iteration's `recordTurn`, so it re-fires the LLM call to get the response again. The DOUBLE-LLM-call cost is the trade-off of writing the dispatch row before the turn entry. |
| Deploy after `recordTurn` but before next iteration           | Clean resume — turn N's checkpoint is durable, iteration N+1 starts cleanly on re-drive.                                                                                                                                                                                                              |
| Deterministic failure (e.g. permanent 500 on `external_call`) | `recoveryAttempts` bumps each orphan-resume; after `MAX_RECOVERY_ATTEMPTS = 3` the orphan sweep marks the row `failed` with `errorMessage = "Recovery exhausted"`.                                                                                                                                    |

## Authoring guidance

**Default to multi-turn-eligible step types for long-running work.** `agent_call` (single-turn mode), `orchestrator`, and `reflect` are the three step types that record per-turn checkpoints. If your work fits one of those shapes, you get crash-survival for free.

**Single-shot side effects need careful step boundaries.** `external_call` and `send_notification` are crash-safe, but only because the cache is keyed on `${executionId}:${stepId}`. If you're tempted to combine "fetch + transform + send" into one giant step, the cache key still works but a partial failure inside the step will re-fire from the start. Splitting into discrete steps lets each step have its own cache row.

**Avoid `agent_call` multi-turn mode for long runs.** Multi-turn mode currently falls back to a full step restart on re-drive (the dispatch cache still dedups inner tool calls, so no double side effects, but the LLM tokens for outer turns 0..N are paid again). Single-turn mode with a high `maxToolIterations` budget gives equivalent functionality with full per-iteration replay.

**Mark idempotent capabilities explicitly.** A capability that's a pure read or an upsert keyed on stable input should set `isIdempotent: true` on its `AiCapability` row. The `tool_call` executor will skip the dispatch cache for it, avoiding a DB write per call.

**Don't try to encode "did this already happen?" logic in the workflow.** The dispatch cache handles it at the engine layer. A workflow author writing `route` branches on "is this the first run?" is fighting the engine — let the cache miss/hit handle the distinction.

## What's actually new vs. PR 1

PR 1 (lease + orphan sweep) shipped the recovery mechanism — the engine survives crashes and re-drives orphaned rows. PR 2 (this recipe's subject) shipped the **per-step crash-safety** that makes the re-drive cheap and correct: the dispatch cache ensures side effects don't fire twice, and per-turn checkpointing means long-running multi-turn steps don't restart from turn 0.

Migrations:

- `20260508162706_add_workflow_step_dispatch` — `AiWorkflowStepDispatch` table and `AiCapability.isIdempotent` flag.
- `20260508165225_add_multi_turn_checkpoint` — `AiWorkflowExecution.currentStepTurns` column.

## Anti-patterns

**Don't use a step's own random ID as the idempotency key.** The cache key derivation (`buildIdempotencyKey`) is deterministic per `(executionId, stepId)` precisely so re-drives hit the cache. A random key would mean every re-drive re-fires.

**Don't rely on the cache for cross-execution dedup.** The key includes `executionId`, so two separate runs of the same workflow get separate cache rows even if their `stepId` matches. Cross-execution dedup is a different problem (use a domain-level unique constraint or a deterministic external key instead).

**Don't manually clear `currentStepTurns` from admin tooling.** The engine clears it on step transition (`markCurrentStep`) and on workflow finalize. Manual clears mid-step would corrupt resume state. The column is engine-private state.

**Don't widen `isIdempotent: true` to capabilities that have side effects.** The flag is an opt-OUT of the cache; flipping it for a capability that mutates state (sends an email, charges a card, writes a record) means a re-drive WILL re-execute the side effect.

## Test plan

To verify a workflow survives crashes end-to-end in development:

1. Start `npm run dev` and trigger the workflow via the admin UI (Workflows → [your workflow] → Test).
2. Once execution is running, kill the dev process (Ctrl-C). The maintenance tick scheduler will still run when the next request hits the server.
3. Restart `npm run dev`. Within ~4 minutes the orphan sweep picks up the row and re-drives it.
4. Inspect the execution's trace in the admin UI: completed steps from before the kill should be unchanged; the in-flight step (and any subsequent steps) should show as completed by the resumed run.
5. Verify side effects fired exactly once — check the upstream API's request log, the email provider's send log, etc.

For an automated check, the `recoveryAttempts` column on `AiWorkflowExecution` increments on each orphan-resume — query the row to confirm.

## Related

- [`engine.md` — Recovery model](../engine.md#recovery-model) — Lease semantics, orphan sweep, multi-turn checkpoint state, retry-clear contract.
- [`workflows.md` — Idempotency and crash safety](../workflows.md#idempotency-and-crash-safety) — Per-step-type behaviour, key shape, `isIdempotent` capability flag, the lookup → fire → record contract.
- [`scheduling.md`](../scheduling.md) — Cron triggers and the maintenance tick that runs the orphan sweep.
- [`hooks.md`](../hooks.md) — `workflow.execution.failed` hook for recovery-exhausted runs.
- `lib/orchestration/engine/dispatch-cache.ts` — Implementation: `buildIdempotencyKey`, `lookupDispatch`, `recordDispatch`.
