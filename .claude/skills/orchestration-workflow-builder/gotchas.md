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

## `human_approval` `prompt` Interpolates Templates And Renders As Markdown

Earlier engine versions passed `step.config.prompt` to the approval payload verbatim, so `{{stepId.output}}` references appeared as raw mustache syntax to the admin. Fixed 2026-05-16 — the prompt is now run through `interpolatePrompt(prompt, ctx)` just like `llm_call`, so it can reference accumulated outputs from earlier steps. Missing references expand to empty string (same as the template engine elsewhere), so a typo won't block the pause.

The prompt is also **rendered as markdown** in the approvals queue and the execution detail view's amber card — headings, bulleted instructions, fenced code, GFM tables all work. Raw HTML in the prompt source renders as inert text (no `rehype-raw`); no XSS surface added by markdown rendering.

Practical implication: write `human_approval` prompts as if they're admin-facing documentation. Markdown structure + interpolated upstream outputs gives reviewers a much more useful card than a plain paragraph.

## `expectedSkip: true` Tones Down Routine Optional Skips

When a step uses `errorStrategy: 'skip'` and you _expect_ the skip to fire under normal operation (missing env var, vendor offline, optional enrichment), set `expectedSkip: true` in the step config. The trace entry then renders as `Optional step skipped: <reason>` in muted text rather than the standard skip styling, and the expanded view uses a slate "Skip reason" pane instead of the red "Error" pane. The reason is preserved either way; the flag only suppresses alarmist styling. Default `false`.

Use it for optional-by-design steps (e.g. the Brave Search enrichment in the audit workflow that's skipped when `BRAVE_SEARCH_API_KEY` is absent). Don't use it to silence skips that actually represent broken integrations — a "permission denied" skip from a misconfigured API key is the kind of thing you want to look red.

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

## `external_call` `authType` Must Match The Vendor's Actual Header Contract

`authType: 'bearer'` sends `Authorization: Bearer <key>`. Most vendors accept that, but several use a custom header instead, and they reject bearer with a 401/403/422. Observed failure (2026-05-16): the Brave Search call in `tpl-provider-model-audit` was configured with `authType: 'bearer'` and returned

```
HTTP 422 — Field required at ["header","x-subscription-token"]
```

because Brave reads the API key from `X-Subscription-Token`, not from `Authorization`.

**Fix shape:** Use `authType: 'api-key'` with `apiKeyHeaderName` set to the vendor's header name. Some known patterns:

| Vendor             | `authType`               | `apiKeyHeaderName`              |
| ------------------ | ------------------------ | ------------------------------- |
| Brave Search       | `api-key`                | `X-Subscription-Token`          |
| Postmark           | `api-key`                | `X-Postmark-Server-Token`       |
| Anthropic / OpenAI | `bearer`                 | _(unused — uses Authorization)_ |
| SendGrid           | `bearer`                 | _(unused)_                      |
| AWS SigV4 services | `hmac` or pre-signed URL | _(custom)_                      |

**Diagnostic.** A 401/403/422 with a body that names a specific missing header (`Field required: x-subscription-token`, `Missing X-Postmark-Server-Token`) is the unambiguous signal — the gateway tells you exactly which header it expected. Read the body before blaming the env var or scope.

**When in doubt** consult the vendor's "authentication" docs page; almost every API ships one and it lists the canonical header name on the first paragraph.

## `external_call` URL Query Strings Respect Vendor Length Limits — Don't Interpolate Big Outputs

`{{stepId.output}}` interpolation works inside `url` as well as `bodyTemplate`, which is convenient but lets you accidentally pipe a JSON dump of a prior step's output into a URL query parameter. Vendors typically cap individual query parameters at a few hundred characters; interpolating a registry-sized payload sails past the cap.

Observed failure (2026-05-16): the audit workflow's Brave Search call had `?q=AI+model+releases+{{load_models.output}}&count=5`. With `load_models.output` being the parsed model registry (well over 1 KB), the request returned

```
HTTP 422 — Search query must be at most 400 characters (you entered N)
```

**Rule of thumb:** treat `url` as a place for small literal values (search terms, IDs, a step's output IF you know it's a short string like a classifier label). For anything that might be > ~200 chars, either:

- Use a `POST` with `bodyTemplate` and put the payload in the body, OR
- Pre-summarise the upstream output in an `llm_call` that produces a short query string, then interpolate _that_ step's output.

Known per-param ceilings: Brave Search `q` ≤ 400, most APIs ≤ 2,048 (HTTP URL practical limit), some CDNs / gateways enforce stricter limits.

## HTTP Error Bodies On `external_call` Are Truncated At 2 KB With A Visible Marker

When a non-2xx response comes back from `external_call`, the engine attaches the response body to the step's error message so operators can diagnose without re-running. The body is capped at 2,000 characters; when truncation actually fires the message gains a `… [truncated, N more chars]` suffix.

If a step-timeline error message ends in that suffix, the diagnostic was cut and the actual reason might be further in. Re-run with verbose logging, or inspect the raw provider response if you can — don't trust that what's in the trace is the full body.

History: the cap was 256 characters before 2026-05-16. Anyone reading older trace entries should know that pre-fix errors were silently truncated with no marker at all.

## `agent_call` Resolves Agent-Profile Inheritance

When `agent_call` invokes an agent, the executor loads the agent **with its optional `profile`** and runs `resolveEffectivePrompt(agent, profile)` before sending. That means the agent's persona / voice / guardrails picked up from a shared profile are honoured inside the workflow execution exactly the way they are in chat. Two implications:

- Editing a shared profile (`AiAgentProfile`) silently changes the behaviour of every agent — and therefore every `agent_call` step — that points at it. Treat profile edits with the same care as agent-systemInstructions edits; both feed into the same resolved prompt.
- A workflow that hard-codes an `agent_call.message` assuming a specific persona will break if the agent later inherits a profile that contradicts the hard-coded framing. Prefer letting the profile carry the persona, and use `message` for the actual task input.

## `reasoningEffort` Precedence on `agent_call`

The step's `config.reasoningEffort` **overrides** the agent's own `AiAgent.reasoningEffort`, not adds to it. Resolution: step config (if set) → agent's own value (if set) → no `reasoning_effort` parameter sent. If you copy-paste a step from a workflow that targeted a non-reasoning model and later swap in a reasoning-capable agent, you may suddenly start paying for reasoning tokens without seeing the per-step setting; check the trace's captured `requestParams` to confirm what actually went over the wire.

On `orchestrator`, the planner uses the step's `reasoningEffort` but delegated agent calls keep using each delegated agent's own value — the planner-vs-delegate split is by design.

## `agent_call` Multi-Turn Mode Falls Back On Re-Drive

Multi-turn checkpointing covers `reflect` and `orchestrator` cleanly. `agent_call` in multi-turn mode is **explicitly not supported** for full resume — it falls back to a fresh start on re-drive. The dispatch cache prevents inner-side-effect duplication (capabilities the agent called won't fire twice), so the cost of re-drive is LLM tokens only, not the side effect itself. Document the limitation if a long agent_call session is load-bearing.

## Inbound Trigger Replay Protection Is Channel-Scoped

`AiWorkflowExecution.dedupKey` is computed per-channel: `<channel>:<externalId>` for shared-secret channels (slack, postmark), `hmac:<workflowId>:<externalId>` for per-trigger HMAC. The Slack/Postmark scope is **channel-global** — replaying a Slack `event_id` to a different workflow URL collides on the same dedup key (Slack signs `v0:{ts}:{body}` without binding the URL, so cross-workflow replay would otherwise sail through). Generic-HMAC channels don't share secrets across workflows, so per-workflow scope is correct there.

## `guard` Steps in `mode: 'llm'` Cannot Validate Against An Implicit Closed Set

An LLM-mode guard can only check what is **explicitly in its prompt**. A rule like _"reject changes where `field` is not a recognised X field"_ fails open or fails closed unpredictably — the model has no access to the real list, so it guesses.

**Worse: even with the spec pasted into the prompt, the LLM still hallucinates.** Three observed failures on the same `validate_proposals` guard in `tpl-provider-model-audit`:

1. The guard rejected the legitimate field `bestRole` (a free-text column on `AiProviderModel`) as "not a recognised field" because the rules described the constraint without enumerating which names counted (2026-05-15).
2. With all six valid `tierRole` values enumerated as comma-separated prose, the model still rejected `infrastructure` and listed only the other five values in its rejection text (2026-05-16).
3. With the six-element `capabilities` array enumerated AS A JSON BLOCK with explicit anti-omission instructions AND a worked example for `["chat", "vision"]`, the model rejected `["chat","vision","documents"]` claiming `"vision"` was not in the array (2026-05-19). The retry budget caught it but the full audit fan-out re-ran.

This is not a prompt-engineering problem. It is the limit of LLM-mode guards on closed-set checks.

**Fix: use `mode: 'schema'`.** Schema-mode guards run a registered Zod schema via `safeParse` on the named step's output. Zero LLM cost, deterministic, no hallucination surface. See `references/step-config-schemas.md` → `guard` for the config shape and a worked registration example.

```jsonc
// instead of LLM mode enumerating the spec in prose:
{
  "mode": "schema",
  "schemaName": "audit-proposals",
  "inputStepId": "analyse_chat",
  "failAction": "block",
}
```

The schema is authored in TypeScript next to the apply-side Zod schemas it mirrors, so the validator and the apply layer cannot drift:

```ts
// lib/orchestration/audit/schemas.ts
import { z } from 'zod';
import { registerSchema } from '@/lib/orchestration/schemas/registry';
import { CAPABILITIES, TIER_ROLES } from '@/lib/orchestration/model-audit/enums';

registerSchema(
  'audit-proposals',
  z.object({
    models: z.array(
      z.object({
        changes: z.array(
          z.object({
            field: z.string(),
            // The single source of truth — same constant the apply
            // capability validates against. No prompt drift possible.
            proposedValue: z.union([z.string(), z.array(z.enum(CAPABILITIES))]),
            sources: z.array(z.unknown()).min(1),
          })
        ),
      })
    ),
  })
);
```

**When to keep LLM mode:** genuinely fuzzy quality judgments — tone, on-topic, plausibility, "is this draft good enough". Anything where there is no enum to check against and an LLM is actually doing work a regex couldn't.

**When to use regex mode:** simple substring / pattern matches against the workflow input (PII detection, banned-word lists). Faster than LLM, no schema authoring required.

**Drift signal to watch for:** if a guard's prompt enumerates allowed values **and** the apply-side capability also enumerates them, those two lists must come from one source. Schema mode forces this discipline — the schema's enum imports from the constant. Two hand-maintained lists in prose become inconsistent in two commits.

**Historical mitigations (kept here only because old workflows still use them):** Backtick-wrap literal field names. Embed JSON spec blocks rather than prose. Require the model to quote back the array entry it failed to match. Add worked examples for the most-recent failure case. Each lowers the recurrence rate but does not eliminate it. After the third failure on the same guard, retire LLM mode and adopt schema mode.

## Capability `isIdempotent` Default Is `false`

The dispatch cache is **on by default** for `tool_call`. Capabilities can opt out by setting `isIdempotent: true` when they handle re-run dedup naturally (e.g. an idempotent upstream API). Misconfiguring `isIdempotent: true` on a destructive capability is documented as the "you marked it idempotent" admin trade-off. When designing workflows with risky tool calls, leave the default alone unless you've explicitly verified the capability is rerun-safe.

## Place the supervisor near the end, not the start

The supervisor reads `ctx.stepOutputs` — the map of every completed step's output **so far**. Placing it as the FIRST step in a workflow means there is nothing to audit; the LLM is asked to evaluate an empty trace and will (correctly) return `concerns` or `inconclusive`, billing a judge-model call for no value.

The natural position is the workflow's terminal step (immediately before `send_notification` or `report`). The provider-model-audit template demonstrates the pattern.

The executor does NOT short-circuit on empty `stepOutputs` because some legitimate uses exist (a workflow whose body is one big `parallel` that converges into the supervisor — the supervisor still sees outputs through the branches). It's the author's responsibility to place the supervisor sensibly.

## Don't put a `supervisor` inside a `parallel` branch

The supervisor reads the **entire** `ctx.stepOutputs` map and is meant to audit the workflow as a whole. Inside a `parallel` branch it only sees the steps that have completed at that point, so it will judge a still-incomplete workflow and report misleadingly that steps in other branches were never run. Place the supervisor **after** the parallel converges (downstream of the join), not inside one of the branches.

If you have a legitimate need to audit a single branch's output, use `evaluate` instead — it's scoped to a single step.

## Supervisor placement: before or after irreversible steps?

The supervisor is **advisory by default** (`failOnVerdict: 'never'`) — it doesn't block the workflow. That means placement is a real choice:

- **Before** an irreversible step (capability dispatch that mutates the database, sends an email, charges a card): set `failOnVerdict: 'fail'` so a `fail` verdict throws `ExecutorError` and the engine's `errorStrategy` decides. Useful when the workflow can't be undone.
- **After** the irreversible step: the supervisor audits the actual outcome (did the capability return success or zero-changes?) and surfaces a verdict for the operator. Most workflows want this.

Provider-model-audit places the supervisor _after_ its capability dispatches (`apply_changes`, `add_new_models`, `deactivate_models`) for exactly this reason — the verdict can audit whether changes actually applied, not just whether proposals looked good.

## In-workflow `report` step omits the supervisor block at the top

The `report` step executor synthesises a `RenderExecutionInfo` from `ctx`. It does **not** read the persisted `AiWorkflowExecution.supervisorReport` column (the executor has no DB access, and the column may not be written yet by the time the step runs — the supervisor's `contextPatch` only lands on the next checkpoint). So the in-workflow rendered Markdown has no "Neutral supervisor assessment" block at the top — even when the workflow has a supervisor step upstream.

The supervisor's verdict still appears as a step output entry in the timeline (it's in `ctx.stepOutputs`), but the headed verdict block is download-endpoint-only.

If you want the verdict visible at the top of a notification email, interpolate `{{supervisor_review.output}}` (or its sub-fields) directly into the `bodyTemplate` of your `send_notification` step alongside `{{report_render.output.markdown}}`. The provider-model-audit template demonstrates the pattern.

The on-demand download endpoint `GET /executions/:id/report.md` reads the persisted row and **does** render the supervisor block, so end-users hitting the download button see the full picture.

## Report step renders the trace up to its own entry

The `report` step reads `ctx.stepOutputs`, which only contains steps that completed **before** the report step starts. So the report cannot describe itself, and it cannot describe any downstream step.

Practical consequence: if you want the report to include the supervisor's verdict block, order the steps `... → supervisor → report → notify_complete`, not the reverse. The on-demand download endpoint (`GET /executions/:id/report.md`) reads the persisted trace _after_ finalize and so includes every step including the report step itself.

## `failOnVerdict: 'fail'` + `errorStrategy: 'skip'` silently swallows the verdict

The supervisor's `failOnVerdict: 'fail'` makes a `'fail'` verdict throw `ExecutorError`. The engine then consults the step's `errorStrategy`:

- `'fail'` (default): workflow terminates → operator sees the verdict in the error.
- `'retry'`: engine re-runs the step (the supervisor's own retry budget eats the cost; rarely useful).
- `'fallback'`: engine routes to the fallback step → operator sees the verdict on the fallback path.
- **`'skip'`: engine catches the throw and continues as if nothing happened → verdict is silently absorbed.**

The provider-model-audit template uses `errorStrategy: 'skip'` on its supervisor step **deliberately** — but only because `failOnVerdict` is `'never'` (the supervisor is advisory there; a flaky judge model must not flip a successful audit to FAILED).

**Rule**: if you set `failOnVerdict: 'fail'`, do not pair it with `errorStrategy: 'skip'`. Use `'fail'` (terminate the workflow on a fail verdict) or `'fallback'` (route to a rollback / notification step instead).

## Run-time toggles vs design-time enablement

Both `supervisor` and `report` have two layers of opt-in:

1. **Design-time**: the step is in the DAG or it isn't. If it isn't, no checkbox appears in the run dialog and no verdict / report is produced unless the operator hits the retroactive endpoint.
2. **Run-time**: when the DAG contains the step, `defaultEnabled` decides the checkbox's initial state. Operators uncheck → `inputData.__runSupervisor` / `__generateReport` is set to `false` → the executor short-circuits with `expectedSkip: true`.

If you set `defaultEnabled: false`, document why — operators reading the workflow definition will wonder why the step ships disabled. A common case: a workflow used in dev/test environments where the judge-model cost isn't justified for every run.
