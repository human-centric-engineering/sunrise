/**
 * App evaluation-grader registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: the grader registry calls this once before its first lookup —
 * which covers the batch worker, the run-creation validator and the metric
 * picker, all of which run in the route realm. Registering from `initApp()`
 * would fill a map none of them read (#462).
 *
 * ## Why a deterministic grader rather than a judge agent
 *
 * `judge_agent` is the right answer for a *model* grader — adding a metric is
 * creating an agent, no code. It is the wrong tool for a deterministic
 * classifier: an LLM judging set equality adds its own variance to the number
 * you are reading a regression out of, and costs money per case for arithmetic.
 * Register those here.
 *
 * @example
 * ```ts
 * import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
 * import { triageAccuracyGrader } from '@/lib/app/evaluations/triage-accuracy';
 *
 * export function initAppGraders(): void {
 *   registerGrader(triageAccuracyGrader);
 * }
 * ```
 *
 * Import `registerGrader` from `.../graders/registry`, not from the barrel: the
 * barrel's whole job is to side-effect-import every core grader, and pulling
 * that in from here makes the import cycle longer than it needs to be
 * (`lib/app/capabilities.ts` pairs with its registry the same way).
 *
 * Your slug then appears in the run-creation metric picker and dispatches in
 * the batch worker. Re-registering a slug replaces the previous entry, so an
 * app grader CAN replace a built-in — that is deliberate, but it is logged at
 * warn, because a silently swapped `exact_match` changes every score an admin
 * reads without changing anything they can see.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/evaluations.md
 */
export function initAppGraders(): void {
  // No app graders by default.
}

/**
 * App eval case hooks: set up each case of a dataset eval before the agent's
 * turn, and read back what its tools changed after it, so a grader can check
 * the outcome and not only the reply (#879).
 *
 * Auto-wired like `initAppGraders()`: the hook registry runs this once, lazily,
 * before the batch worker's first lookup.
 *
 * @example
 * ```ts
 * import { registerEvalCaseHooks } from '@/lib/orchestration/evaluations/case-hooks';
 *
 * export function initAppEvalCaseHooks(): void {
 *   registerEvalCaseHooks('score-assistant', {
 *     // Fresh before every case: reset this user's workspace, seed the
 *     // starting document the case names, and point the turn at it.
 *     setup: async ({ userId, caseRow }) => {
 *       const doc = await seedScore(userId, caseRow.metadata);
 *       return { contextType: 'score', contextId: doc.id };
 *     },
 *     // After the turn: what graders receive as `observed`.
 *     observe: ({ userId }) => readScore(userId),
 *   });
 * }
 * ```
 *
 * A hook that throws fails that case only; a throw from this function itself
 * rolls back every registration it made, as `initAppGraders()` does.
 *
 * Full guide: .context/orchestration/evaluations.md
 */
export function initAppEvalCaseHooks(): void {
  // No app eval case hooks by default.
}
