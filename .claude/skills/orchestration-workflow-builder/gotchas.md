# Workflow Builder — Gotchas

## FE/BE Validation Asymmetry

The backend validator does **not** check for empty config on these step types:

- `llm_call` — `prompt` can be empty
- `rag_retrieve` — `query` can be empty
- `plan` — `objective` can be empty
- `reflect` — `critiquePrompt` can be empty

These are only checked by the FE `runExtraChecks()`. Workflows created via the API without the visual builder can pass structural validation with empty config fields and **will fail at runtime**.

**Fix:** Always populate these fields when creating workflows via API. Don't rely on the backend to catch empty config.

## Route Condition Matching

A `route` step's `routes` object keys must match `nextSteps[].condition` values **exactly**. If the route classifier outputs `"question"` but the edge condition says `"Question"`, the routing fails silently.

```json
// Correct — keys and conditions match
"config": {
  "routes": { "question": "...", "action": "..." }
},
"nextSteps": [
  { "targetStepId": "step-2", "condition": "question" },
  { "targetStepId": "step-3", "condition": "action" }
]
```

## Parallel Branch Format

`parallel` step `branches` are arrays of **step IDs**, not inline step definitions:

```json
// Correct
"config": { "branches": [["step-a", "step-b"], ["step-c"]] }

// Wrong — inline step objects
"config": { "branches": [{ "id": "step-a", ... }] }
```

Each branch is an array of step IDs that run sequentially within that branch. Multiple branches run concurrently.

## Template Variable Resolution Timing

Template variables (`{{stepId.output}}`) read from a **frozen snapshot** of `ExecutionContext`. Only steps that have **completed** before the current step are addressable. If step A and step B run in parallel, neither can reference the other's output — both must reference an upstream step.

## entryStepId Copy-Paste Error

`entryStepId` must reference an existing step `id`. When copying workflow JSON, it's common to forget to update `entryStepId` after renaming steps. The validator catches this (`MISSING_ENTRY`), but the error message doesn't show what valid IDs exist.

## Cycle Detection Error Messages

The validator catches cycles (`CYCLE_DETECTED`) but does **not** identify which steps form the cycle. The error includes a `path` array with the DFS traversal, but debugging requires manually tracing the edges.

## human_approval Pauses the Entire Workflow

When a `human_approval` step is reached, the execution status changes to `paused_for_approval`. The **entire workflow** pauses — no other steps execute until the approval is resolved. Plan accordingly for time-sensitive workflows.

## orchestrator Step Agent References

The `orchestrator` step's `availableAgentSlugs` must reference **existing, active agents**. The semantic validator checks this, but only on save — if an agent is deactivated after the workflow is saved, the orchestrator step will fail at runtime.

## route Step Minimum Branches

The backend validator requires `route` steps to have at least 2 branches (`INSUFFICIENT_ROUTE_BRANCHES`). A route with only one branch should just be a direct edge.

## tool_call Uses capabilitySlug

The `tool_call` step config field is `capabilitySlug` (not `capability` or `toolSlug`). Some older documentation may reference different field names — always use `capabilitySlug`.

## Budget Enforcement Is Per-Execution

The `budgetLimitUsd` on the workflow applies per execution, not globally. Each new execution starts with a fresh cost counter. For global cost control, use agent-level `monthlyBudgetUsd`.

## PATCH Writes To Draft, Not Live

Workflows are immutable-versioned. `PATCH /workflows/:id` writes to `draftDefinition` — the published version (and any executions, schedules, or `run_workflow` calls pinned to it) is **untouched**. Nothing goes live until `POST /workflows/:id/publish` snapshots the draft as a new `AiWorkflowVersion` and repoints `publishedVersionId`. A common confusion: "I saved my changes but the workflow still runs the old steps." That's correct — publish to roll it forward.

## Rollback Creates A New Version

`POST /rollback` does **not** delete newer versions or overwrite the current pin in-place. It copies the target version into a new monotonic version (vN+1) and pins to it. The chain is append-only — the previously-current version remains in `GET /versions` history. This means rollback is itself an auditable forward step, not a destructive operation.

## `external_call` Body Modes Are Mutually Exclusive

`bodyTemplate` (string) and `multipart` (structured file/field shape) cannot both be set on the same `external_call` step — Zod refine rejects it. HMAC auth paired with `multipart` is rejected at execute time as `multipart_hmac_unsupported` (the boundary varies, so signatures aren't deterministic). Pick HMAC + `bodyTemplate`, or non-HMAC + `multipart`.

## `agent_call` Multi-Turn Mode Falls Back On Re-Drive

Multi-turn checkpointing covers `reflect` and `orchestrator` cleanly. `agent_call` in multi-turn mode is **explicitly not supported** for full resume — it falls back to a fresh start on re-drive. The dispatch cache prevents inner-side-effect duplication (capabilities the agent called won't fire twice), so the cost of re-drive is LLM tokens only, not the side effect itself. Document the limitation if a long agent_call session is load-bearing.

## Inbound Trigger Replay Protection Is Channel-Scoped

`AiWorkflowExecution.dedupKey` is computed per-channel: `<channel>:<externalId>` for shared-secret channels (slack, postmark), `hmac:<workflowId>:<externalId>` for per-trigger HMAC. The Slack/Postmark scope is **channel-global** — replaying a Slack `event_id` to a different workflow URL collides on the same dedup key (Slack signs `v0:{ts}:{body}` without binding the URL, so cross-workflow replay would otherwise sail through). Generic-HMAC channels don't share secrets across workflows, so per-workflow scope is correct there.

## `guard` Steps in `mode: 'llm'` Cannot Validate Against An Implicit Closed Set

An LLM-mode guard can only check what is **explicitly in its prompt**. A rule like _"reject changes where `field` is not a recognised X field"_ fails open or fails closed unpredictably — the model has no access to the real list, so it guesses. Observed failure: the `validate_proposals` guard in `tpl-provider-model-audit` rejected the legitimate field `bestRole` (a real free-text column on `AiProviderModel`) as "not a recognised field", because the rules described the constraint without enumerating which names counted as recognised. Subtler effect: enum-heavy lists bias the model — a lone free-text member like `bestRole` reads as anomalous and gets flagged.

**Fix shape:** When a closed set defines validity, paste the set into the prompt and source it from the same constant the apply step uses, so it cannot drift:

```ts
import { AUDITABLE_FIELDS } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';

const LIST = AUDITABLE_FIELDS.map((f) => `\`${f}\``).join(', ');

// In the guard rules:
`The \`field\` value MUST be one of: ${LIST}. Treat these as literal strings.`;
```

**Stronger fix:** Use `mode: 'regex'` or a deterministic check for structural rules (field-name-in-set, enum-value-in-set, shape patterns). Reserve `mode: 'llm'` for fuzzy quality judgments (on-topic, appropriate tone, plausible content) where the LLM is actually doing the work that no regex could do.

**Drift signal to watch for:** if a guard's prompt enumerates allowed values **and** the apply-side capability also enumerates them in its Zod schema, those two lists must come from one source. Two hand-maintained lists become inconsistent in two commits.

Also: backtick-wrap literal field names inside guard prompts. Without quoting, `bestRole` reads as the noun phrase "best role" and the model evaluates the _concept_, not the _identifier_.

**Even with the list pasted in, the LLM still mis-reads it.** Observed second failure on the same guard: with all six valid `tierRole` values enumerated as comma-separated prose in the rules, the model still rejected `infrastructure` and listed only the other five values in its rejection text (2026-05-16). The LLM is dropping items from a list it can see. This is not a prompt-engineering problem any more — it is the limit of LLM-mode guards on closed-set checks.

If you can't yet move to a deterministic capability, mitigate with:

1. **JSON spec block, not comma prose.** Embed a `{"tierRole": ["a", "b", ...]}` JSON object in the prompt. LLMs parse JSON arrays more reliably than they re-read prose. Source the arrays from a typed constant so they cannot drift.
2. **Explicit anti-omission instruction.** Add "RE-READ THIS BLOCK BEFORE JUDGING EACH PROPOSAL. Do not abridge, paraphrase, or omit any array entry." right above the spec.
3. **Require the model to quote back the array entry it failed to match.** _"For each rejection, quote the exact array entry the proposal failed to match"_ forces the model to do another lookup pass, catching omissions before they go out.
4. **Add a worked example that calls out the most-recent failure case.** E.g. _"`tierRole`: `infrastructure` → PASS (it is at index 2 of the array)"_. Repeating the actually-dropped value in an example block lowers the recurrence rate, though it doesn't eliminate it.

But the real fix is still option above: deterministic validation. After two hallucinations on the same guard, retire the LLM-mode validation and replace it with a `tool_call` to a structural-validation capability that runs the payload through the same Zod schemas the apply step uses.

## Capability `isIdempotent` Default Is `false`

The dispatch cache is **on by default** for `tool_call`. Capabilities can opt out by setting `isIdempotent: true` when they handle re-run dedup naturally (e.g. an idempotent upstream API). Misconfiguring `isIdempotent: true` on a destructive capability is documented as the "you marked it idempotent" admin trade-off. When designing workflows with risky tool calls, leave the default alone unless you've explicitly verified the capability is rerun-safe.
