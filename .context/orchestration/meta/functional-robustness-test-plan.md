# Orchestration — Functional Completeness & Robustness Test Plan

A walk-through inventory for manually validating the orchestration layer end-to-end. Each phase is one capability area; each checkbox is a single scenario you tick once you have personally satisfied yourself that behaviour matches the spec.

**Last updated:** 2026-05-06 (added Phase 4.11 / 4.12 plus six new Appendix A subsections covering frontend lifecycle, telemetry-failure cascade, state evolution under in-flight ops, external-party contract evolution, determinism, and boundary-on-the-boundary discipline; added per-scenario method columns `C[ ] L[ ] M[ ] A[ ]` and Claude prompts in the introductory area)

---

## Purpose

Two questions, asked of every area:

1. **Functional completeness** — does the system actually do what `functional-specification.md` claims it does, from a real running instance, with realistic inputs?
2. **Robustness** — does it degrade gracefully under bad input, partial failure, racing actors, malformed data, leaked tokens, exhausted budgets, and the rest of the things that happen in production?

Source-of-truth references for each phase point at the relevant `.context/orchestration/*.md` files. If a scenario reveals drift between docs and code, fix the code or update the doc — don't just tick the box.

---

## How to use this document

- Walk one phase at a time, not the whole doc in one sitting. Tier 1 phases are the densest and earn the most attention.
- The three sub-sections per phase (Use / Abuse / Edge) are deliberately separate. Run them in that order — golden path first, then deliberate stress, then weird-but-legitimate corners.
- Each scenario carries four method ticks: `C[ ] L[ ] M[ ] A[ ]`. See "Verification methods" below. Tick a method by editing its bracket from `[ ]` to `[x]`.
- A scenario is "done" when at least one method has PASSED and any FAIL across methods has been reconciled. Multiple ticks are a feature, not duplication — different methods catch different failure modes.
- If a scenario is genuinely not applicable to your deployment (e.g. you don't run the embed widget), strike it through rather than ticking — preserves the audit trail.

**Status legend (for ad-hoc annotations next to a scenario):**

- ✅ passed
- ⚠️ partial — works but exposes a smell or minor issue
- ❌ failed — bug filed
- ⚪ blocked — couldn't test (missing dependency, environment limitation)

---

## Verification methods

| Tick  | Method                   | What it means                                                                                                                                              |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C** | Claude — code-path trace | Claude reads the source, follows the execution path, confirms code matches spec. No runtime. Fast and broad — start here.                                  |
| **L** | Claude — live exec       | Claude exercises the running dev instance via tools / MCP / curl. Catches runtime and integration bugs that pure tracing misses.                           |
| **M** | Manual                   | A human drives the UI or a real client. Required for scenarios involving real networks, corporate proxies, browser power-management, mobile handover, etc. |
| **A** | Automated                | An existing unit / integration / smoke test asserts this scenario. Link the test in a footnote or commit message when ticking.                             |

> GitHub renders only the first `[ ]` on a line as an interactive checkbox. Tick the rest by editing the source — `C[x]`, `L[x]`, `M[x]`, `A[x]`. The pattern is grep-friendly for progress reporting: `grep -c 'C\[x\]' <file>` counts code-trace progress.

The four methods are complementary, not redundant. **Run code-trace first** — it is broad, cheap, and produces the worklist that live-exec consumes. **Live-exec then targets** the scenarios code-trace flagged `LIVE` plus any you want corroborated; this typically cuts live-exec scope by 50–70%. **Manual handles** what neither can — real proxies, real networks, real OS-level conditions. **Automated** is the regression guard that keeps everything ticked.

For Tier 1 phases (1.1–1.8), prefer running each Claude pass **per sub-section** (Use / Abuse / Edge) rather than per whole phase — context budget will not stretch across forty-plus dense scenarios at the depth required.

### Claude prompt — code-path trace (run first)

Adapt by setting `{N.N}` to the phase and the scope to one of `Use` / `Abuse` / `Edge` / `all`:

```text
Verify Phase {N.N}, sub-section {Use|Abuse|Edge|all} of
.context/orchestration/meta/functional-robustness-test-plan.md by code-path
tracing only. No runtime, no servers, no DB. Read source and follow logic.

Read first:
- The phase's "Reference docs" listed in its header.
- The implementation files those reference docs point at.

For each scenario:
1. Locate the code that handles it (route handler, service, capability,
   guard, etc.). Cite file:line.
2. Trace from entry to outcome. Confirm whether the documented behaviour
   matches the actual code path.
3. Verdict — exactly one of:
   - PASS  — code matches spec
   - FAIL  — code contradicts spec (note exactly where)
   - GAP   — spec describes behaviour, code path is missing
   - DRIFT — spec and code disagree, neither clearly wrong; flag for
             human decision
   - LIVE  — cannot be assessed statically, needs live execution
   - N/A   — scenario does not apply to this deployment

Output three sections:
1. A markdown table — one row per scenario:
   | # | scenario short name | verdict | file:line evidence | one-line note |
2. "Drift summary" — every FAIL / GAP / DRIFT with enough context that a
   human can decide whether to fix code or update the doc.
3. "Needs live exec" — every LIVE verdict, formatted as a worklist that
   the live-exec prompt below can consume directly.

Do not modify any files. Do not tick checkboxes in the plan — I will tick
the C[ ] column once I have reviewed your verdicts.
```

### Claude prompt — live execution (run after code-trace)

Adapt by setting `{N.N}` to the phase and pasting the worklist (or naming a sub-section):

```text
Exercise Phase {N.N} of
.context/orchestration/meta/functional-robustness-test-plan.md against the
running dev instance.

Scope — pick one:
- A "Needs live exec" worklist from a prior code-trace run. Paste it here
  or point at where it is saved. This is the common case and keeps scope
  tight.
- A specific sub-section (Use / Abuse / Edge) if no code-trace was done
  first.
- A small targeted set of scenario numbers.
Do not run a whole phase end-to-end without scoping — context will not
stretch.

Setup:
- Dev server on http://localhost:3000 (start with `npm run dev` if down).
- Call mcp__next-devtools__init first.
- Use the dev DB. DO NOT reset, drop, seed-from-scratch, or run any
  destructive command. Reads and additive writes only. Prefix any scratch
  entities (agents, conversations, capabilities, knowledge bases) with
  "test-{phase}-{scenario}-" so they are easy to find and clean up.
- For HTTP, prefer curl or fetch via the next-devtools eval over driving
  the UI, unless the scenario is explicitly UI-driven (Phase 3.x is
  largely UI).
- Do not modify production singletons: settings singleton, system agents
  (isSystem: true), provider credentials.

For each scenario:
1. State the experiment in one line: input → expected outcome.
2. Execute. Capture: response body, relevant log lines, DB rows created.
3. Verdict — exactly one of:
   - PASS    — observed behaviour matches spec
   - FAIL    — observed contradicts spec (for abuse scenarios, also fail
               on 500s, leaked stack traces, or orphaned rows)
   - BLOCKED — cannot run (missing dependency / env limitation) — say why
   - SKIPPED — genuinely not exercisable here. Belongs in M[ ] (manual),
               not L[ ]. Examples: real corporate buffering proxies,
               mobile network handover, browser OS power-management,
               HTTP/1.1 vs HTTP/2 transport behaviour, scenarios needing
               production data or real external services.

Output: one section per scenario with the experiment, evidence (trimmed
log + response), and verdict. End with a "needs follow-up" list of FAIL
and BLOCKED items.

Do not run any /test-* commands. Do not tick checkboxes — I will tick
the L[ ] column once I have reviewed.
```

---

## Table of contents

### Tier 1 — Hot path, daily driver, security-critical

- [Phase 1.1 — Streaming Chat](#phase-11--streaming-chat)
- [Phase 1.2 — Agent Management](#phase-12--agent-management)
- [Phase 1.3 — LLM Provider Resilience](#phase-13--llm-provider-resilience)
- [Phase 1.4 — Cost & Budget Enforcement](#phase-14--cost--budget-enforcement)
- [Phase 1.5 — Capability Dispatch Pipeline](#phase-15--capability-dispatch-pipeline)
- [Phase 1.6 — Knowledge Base: Ingestion](#phase-16--knowledge-base-ingestion)
- [Phase 1.7 — Knowledge Base: Hybrid Search & Citations](#phase-17--knowledge-base-hybrid-search--citations)
- [Phase 1.8 — Authentication & Authorisation](#phase-18--authentication--authorisation)

### Tier 2 — Core engine, important but less hot

- [Phase 2.1 — Workflow Engine: DAG Execution](#phase-21--workflow-engine-dag-execution)
- [Phase 2.2 — Workflow Engine: Approvals](#phase-22--workflow-engine-approvals)
- [Phase 2.3 — Embeddable Chat Widget](#phase-23--embeddable-chat-widget)
- [Phase 2.4 — Consumer Chat API](#phase-24--consumer-chat-api)
- [Phase 2.5 — MCP Server](#phase-25--mcp-server)
- [Phase 2.6 — Input / Output / Citation Guards](#phase-26--input--output--citation-guards)
- [Phase 2.7 — Scheduling & Maintenance Tick](#phase-27--scheduling--maintenance-tick)
- [Phase 2.8 — Webhooks & Event Hooks](#phase-28--webhooks--event-hooks)

### Tier 3 — Lifecycle, operations, admin surface

- [Phase 3.1 — Admin Dashboard CRUD Surfaces](#phase-31--admin-dashboard-crud-surfaces)
- [Phase 3.2 — Workflow Builder UI](#phase-32--workflow-builder-ui)
- [Phase 3.3 — Trace Viewer & Observability](#phase-33--trace-viewer--observability)
- [Phase 3.4 — Evaluations & Named-Metric Scoring](#phase-34--evaluations--named-metric-scoring)
- [Phase 3.5 — Experiments / A/B Testing](#phase-35--experiments--ab-testing)
- [Phase 3.6 — Audit Logging](#phase-36--audit-logging)
- [Phase 3.7 — Backup & Restore](#phase-37--backup--restore)
- [Phase 3.8 — Setup Wizard](#phase-38--setup-wizard)
- [Phase 3.9 — Self-Service API Keys](#phase-39--self-service-api-keys)
- [Phase 3.10 — Conversations Admin: Review, Tagging, Export](#phase-310--conversations-admin-review-tagging-export)

### Tier 4 — Niche, future-facing, cross-cutting

- [Phase 4.1 — Document Ingestion: Format-Specific Edges](#phase-41--document-ingestion-format-specific-edges)
- [Phase 4.2 — User Memory](#phase-42--user-memory)
- [Phase 4.3 — Outbound HTTP & Recipes Cookbook](#phase-43--outbound-http--recipes-cookbook)
- [Phase 4.4 — Analytics: Topics, Unanswered, Coverage Gaps](#phase-44--analytics-topics-unanswered-coverage-gaps)
- [Phase 4.5 — Provider Audit Workflow](#phase-45--provider-audit-workflow)
- [Phase 4.6 — Versioning, Cloning, Bulk Operations](#phase-46--versioning-cloning-bulk-operations)
- [Phase 4.7 — Settings Singleton & Global Tunables](#phase-47--settings-singleton--global-tunables)
- [Phase 4.8 — Learning UI](#phase-48--learning-ui)
- [Phase 4.9 — Workflow Template Catalogue](#phase-49--workflow-template-catalogue)
- [Phase 4.10 — CORS, Security Headers & Operational Observability](#phase-410--cors-security-headers--operational-observability)
- [Phase 4.11 — User Lifecycle & Data Sovereignty](#phase-411--user-lifecycle--data-sovereignty)
- [Phase 4.12 — First-Run & Empty-State Surfaces](#phase-412--first-run--empty-state-surfaces)

### Appendices — Cross-cutting walkthroughs

- [Appendix A — Cross-Cutting Concerns Walkthrough](#appendix-a--cross-cutting-concerns-walkthrough)
- [Appendix B — OWASP Agentic Top 10 Spot-Checks](#appendix-b--owasp-agentic-top-10-spot-checks)

---

# Tier 1 — Hot path, daily driver, security-critical

A regression in any Tier 1 area breaks every deployment of the platform. These are the highest priority and warrant the most thorough walk-through.

---

## Phase 1.1 — Streaming Chat

**What this covers:** The SSE chat handler is the hottest code path in the system — every consumer-facing conversation runs through it. It must handle multi-turn dialog, the iterative tool loop, mid-stream provider failover, in-loop budget checks, citation envelopes, and rolling summarisation under arbitrary user input.

**Reference docs:** `.context/orchestration/chat.md`, `.context/api/consumer-chat.md`, `.context/api/sse.md`, `.context/orchestration/output-guard.md` (Citation Guard section).

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Single-turn message → response with no tool calls; verify SSE event order (`start`, `content`\*, `done`).
- C[ ] L[ ] M[ ] A[ ] — First message on a brand-new conversation creates an `AiConversation` row with the calling user as owner and the agent linked.
- C[ ] L[ ] M[ ] A[ ] — Assistant message persisted to `AiMessage` on `done` with all metadata (citations envelope, pendingApproval, contextType, costTotalUsd).
- C[ ] L[ ] M[ ] A[ ] — After `done`, no further events arrive on the same stream; the connection closes cleanly.
- C[ ] L[ ] M[ ] A[ ] — Multi-turn conversation (10+ turns) → verify history is included on each turn and rolling summary kicks in when context-window pressure builds.
- C[ ] L[ ] M[ ] A[ ] — Tool-using turn → verify `capability_result` event arrives between content chunks and the LLM continues with the tool output in context.
- C[ ] L[ ] M[ ] A[ ] — RAG-grounded turn (`search_knowledge_base`) → verify a `citations` event arrives before `done` and contains monotonically numbered `[N]` markers.
- C[ ] L[ ] M[ ] A[ ] — Multi-tool turn (two tool calls in one round) → verify `[N]` markers are monotonic across all tool calls, not reset per tool.
- C[ ] L[ ] M[ ] A[ ] — Long-running tool (>10s execution) → verify status events keep arriving so the client doesn't time out the connection.
- C[ ] L[ ] M[ ] A[ ] — Per-conversation message cap reached → verify the next message is rejected with a clear error.
- C[ ] L[ ] M[ ] A[ ] — Reload mid-conversation → verify `metadata.pendingApproval` (if any) is restored from message history.
- C[ ] L[ ] M[ ] A[ ] — User memory present → verify it appears in the system context and the LLM uses it.
- C[ ] L[ ] M[ ] A[ ] — `warning` event surface — fire a non-fatal event (e.g. budget approaching threshold) → verify the client receives a `warning` distinct from `error`.
- C[ ] L[ ] M[ ] A[ ] — `content_reset` event semantics — citation guard or output guard trips mid-stream → verify the client receives `content_reset` and discards any partial content already shown.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Send empty / whitespace-only message — verify rejection (matches the recent empty-content blocker fix from `a19292b7`).
- C[ ] L[ ] M[ ] A[ ] — Send a 100KB single message — verify size cap rejection without crashing the handler.
- C[ ] L[ ] M[ ] A[ ] — Send 25 messages in 60s under one user → verify per-user rate-limit (20/min) returns a clean 429.
- C[ ] L[ ] M[ ] A[ ] — Send a known prompt-injection pattern (system_override, role_confusion, delimiter_injection) under each of the three input-guard modes (`log_only` / `warn_and_continue` / `block`); verify behaviour matches mode.
- C[ ] L[ ] M[ ] A[ ] — Cancel mid-stream (close TCP connection) → verify the server detects disconnect, stops the tool loop, and writes no orphaned cost log past the cancellation point.
- C[ ] L[ ] M[ ] A[ ] — Submit a message while at 99% of the agent budget → verify hard-stop fires inside the tool loop at 100%, the user sees a friendly message, and a partial cost log is recorded.
- C[ ] L[ ] M[ ] A[ ] — Request via an agent whose configured model has been deactivated — verify graceful failover or clear error.
- C[ ] L[ ] M[ ] A[ ] — Inject a unicode RTL-override sequence into the user message — verify it does not corrupt SSE framing.
- C[ ] L[ ] M[ ] A[ ] — Send a message containing a fake `data:` SSE line → verify it is treated as content, not as a server-emitted event.
- C[ ] L[ ] M[ ] A[ ] — Two browser tabs share one conversation and submit messages in the same second → verify ordering / no lost messages.
- C[ ] L[ ] M[ ] A[ ] — HTTP/1.1 vs HTTP/2 — exercise both transports against the streaming endpoint and verify SSE flush semantics on each; some hosts force one or the other.
- C[ ] L[ ] M[ ] A[ ] — SSE behind a buffering proxy (corporate proxy / nginx without `X-Accel-Buffering: no` / a CDN that holds the response) → verify the server emits early flush bytes (or comments) so the client sees keepalive within a few seconds, not at end-of-stream.
- C[ ] L[ ] M[ ] A[ ] — Mobile network handover mid-stream (wifi → cellular, IP changes, TCP RST from carrier) → verify clean disconnect detection and that the conversation row is left consistent.
- C[ ] L[ ] M[ ] A[ ] — Browser tab suspended by OS power management mid-stream → resume → verify the client either reconnects or shows an honest "disconnected" state, not a phantom "still streaming" UI.
- C[ ] L[ ] M[ ] A[ ] — LLM emits a 100KB tool-call argument → verify dispatch enforces the documented input cap and the cost / token accounting reflects the input.
- C[ ] L[ ] M[ ] A[ ] — Tool returns a value containing `BigInt`, `Date`, circular reference, or `undefined` → verify JSON serialisation handles them deterministically (or rejects with a clear error), never silently coerces to `null`.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Provider returns malformed SSE bytes mid-stream → verify mid-stream failover to next fallback provider, single coherent client experience.
- C[ ] L[ ] M[ ] A[ ] — Every provider in the fallback chain fails → verify a single, coherent `error` event reaches the client (not a stream of partial errors).
- C[ ] L[ ] M[ ] A[ ] — Tool loop exits at `maxIterations` without a final assistant response → verify graceful termination with an explanatory message.
- C[ ] L[ ] M[ ] A[ ] — Citation guard set to `block` and the LLM produces an uncited claim — verify `content_reset` fires and the user sees the corrective response.
- C[ ] L[ ] M[ ] A[ ] — Citation guard set to `block` and the LLM emits a `[3]` when only `[1]` and `[2]` were produced (hallucinated marker) — verify guard catches it.
- C[ ] L[ ] M[ ] A[ ] — Conversation triggers rolling summary while a tool call is in flight — verify summary applies to the next turn, not retroactively.
- C[ ] L[ ] M[ ] A[ ] — Agent has zero capabilities bound — verify a normal chat works with no tool definitions exposed to the LLM.
- C[ ] L[ ] M[ ] A[ ] — Embedding insert fails (provider down) → verify chat continues; embedding is fire-and-forget.
- C[ ] L[ ] M[ ] A[ ] — Conversation context type set to `evaluation` — verify `AiEvaluationLog` rows are mirrored alongside `AiMessage` rows (per Tier 2 #6 in `improvement-priorities.md`).
- C[ ] L[ ] M[ ] A[ ] — Resumability — client disconnects at token 47 of 200 and reconnects with `Last-Event-ID` (or equivalent) → verify whether the server resumes, restarts, or requires the user to re-issue, and that the documented behaviour matches.
- C[ ] L[ ] M[ ] A[ ] — Agent's `knowledgeCategories` modified between turn 5 and turn 6 of the same conversation → verify whether turn 6 honours the old or new scope, and that the rolling summary built from old-scope chunks doesn't leak old-scope content into the new scope.

---

## Phase 1.2 — Agent Management

**What this covers:** Agents are the primary deployment unit. The CRUD surface, version history, visibility model, system-agent protections, and clone/export/import roundtrip define how every other capability is configured.

**Reference docs:** `.context/admin/orchestration-agents.md`, `.context/admin/agent-form.md`, `.context/orchestration/agent-visibility.md`, `functional-specification.md` §1.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Create a new agent via the 6-tab form, save, verify it appears in the list and can be chatted with.
- C[ ] L[ ] M[ ] A[ ] — Edit `systemInstructions` on an existing agent → verify a new `AiAgentVersion` row is written and a diff is visible.
- C[ ] L[ ] M[ ] A[ ] — Switch an agent's primary model and provider → verify next chat turn uses the new model.
- C[ ] L[ ] M[ ] A[ ] — Attach 5 capabilities to an agent → verify the LLM sees only the explicitly visible subset (default-deny LLM visibility, default-allow dispatch).
- C[ ] L[ ] M[ ] A[ ] — Set `monthlyBudgetUsd` to $50 → verify the budget renders in the cost panel and the agent can be chatted with up to that cap.
- C[ ] L[ ] M[ ] A[ ] — Set `fallbackProviders` to an ordered list of 3 providers → verify the fallback chain is honoured under failure (cross-ref Phase 1.3).
- C[ ] L[ ] M[ ] A[ ] — Set `knowledgeCategories` to scope an agent to one category → verify other categories' chunks are filtered out of search results.
- C[ ] L[ ] M[ ] A[ ] — Clone an agent → verify all configuration (instructions, capabilities, knowledge scope, fallback chain) is duplicated.
- C[ ] L[ ] M[ ] A[ ] — Export a single agent as JSON → verify all configuration is in the bundle (credentials excluded).
- C[ ] L[ ] M[ ] A[ ] — Export multiple agents (bulk) → verify the bundle is well-formed.
- C[ ] L[ ] M[ ] A[ ] — Compare two agents side-by-side via the comparison view.
- C[ ] L[ ] M[ ] A[ ] — Set agent visibility to `internal` → verify only admins can chat with it.
- C[ ] L[ ] M[ ] A[ ] — Set agent visibility to `invite_only` and generate an `AiAgentInviteToken` → verify only token holders can chat.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to delete a system agent (`isSystem: true`) → verify rejection with clear error.
- C[ ] L[ ] M[ ] A[ ] — Try to deactivate a system agent → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Set `temperature` to -1 or 5 → verify Zod validation rejects.
- C[ ] L[ ] M[ ] A[ ] — Set `maxTokens` to 0 or to a value larger than the model's context window → verify validation or graceful capping.
- C[ ] L[ ] M[ ] A[ ] — Set `monthlyBudgetUsd` to a negative value → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Submit a 100KB `systemInstructions` field — verify length cap (or sane handling at length).
- C[ ] L[ ] M[ ] A[ ] — Attach a deactivated capability to an agent → verify rejection or warning at save time.
- C[ ] L[ ] M[ ] A[ ] — Configure `fallbackProviders` to include the primary provider, creating a cycle (A → B → A) → verify protection.
- C[ ] L[ ] M[ ] A[ ] — Configure `fallbackProviders` referencing a deleted provider → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Two admins simultaneously edit the same agent in two browser tabs → verify last-write-wins or optimistic-locking behaviour, not silent loss.
- C[ ] L[ ] M[ ] A[ ] — Change agent visibility from `public` to `internal` while users are actively chatting → verify in-flight conversations complete and new ones are blocked.
- C[ ] L[ ] M[ ] A[ ] — Generate an `AiAgentInviteToken` with `usageLimit: 0` → verify behaviour at boundary.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Import an export file referencing a provider that doesn't exist on the target system → verify `ImportResult` reports the failure cleanly.
- C[ ] L[ ] M[ ] A[ ] — Import an export file with a duplicate slug → verify conflict resolution (merge vs overwrite mode).
- C[ ] L[ ] M[ ] A[ ] — Restore an agent that references a model later marked `isActive: false` — verify chat surfaces a helpful error.
- C[ ] L[ ] M[ ] A[ ] — Agent with 30+ capabilities — verify form rendering, save performance, LLM tool-definition payload size.
- C[ ] L[ ] M[ ] A[ ] — Agent version history with 100+ entries — verify list pagination and diff performance.
- C[ ] L[ ] M[ ] A[ ] — Invite token expires mid-conversation — verify the in-flight stream completes; subsequent messages are rejected.
- C[ ] L[ ] M[ ] A[ ] — Embed token deleted while a partner widget is connected — verify the widget's next request is rejected.

---

## Phase 1.3 — LLM Provider Resilience

**What this covers:** The provider layer's resilience features — circuit breaker, ordered fallback chains, mid-stream failover — are Sunrise's strongest competitive differentiator per `maturity-analysis.md`. They must hold under partial-failure, slow, and totally-down conditions.

**Reference docs:** `.context/orchestration/llm-providers.md`, `.context/admin/orchestration-providers.md`, `functional-specification.md` §2.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Configure a new provider via the admin UI → verify "Test connection" returns success.
- C[ ] L[ ] M[ ] A[ ] — Add a new model to a provider via the matrix view → verify it appears in agent model selectors.
- C[ ] L[ ] M[ ] A[ ] — Use the task-based provider selector (`routing` / `chat` / `reasoning` / `embeddings`) → verify recommended models map to correct tiers.
- C[ ] L[ ] M[ ] A[ ] — Health monitoring panel shows all providers green when reachable.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Configure a provider with an invalid API key → verify connection test fails with a clear message; no key is leaked to the client response.
- C[ ] L[ ] M[ ] A[ ] — Configure a provider with an unreachable base URL → verify timeout enforcement and clean failure.
- C[ ] L[ ] M[ ] A[ ] — Force 5 consecutive provider failures within 60s (use a chaos toggle or a dead provider) → verify circuit breaker trips and skips the provider for 30s.
- C[ ] L[ ] M[ ] A[ ] — After breaker cooldown elapses, verify the provider is retried on the next request and recovers cleanly.
- C[ ] L[ ] M[ ] A[ ] — Inspect any API response or chat event for the raw API key — verify it never appears in client-visible payloads.
- C[ ] L[ ] M[ ] A[ ] — Inspect the LLM context (via debug logs or trace viewer) — verify API keys never leak into the prompt.
- C[ ] L[ ] M[ ] A[ ] — Configure a provider whose `customConfig` references an env var that doesn't exist → verify start-up or first-call error is clear.
- C[ ] L[ ] M[ ] A[ ] — Upstream provider deprecates a model and starts returning 404 on first call → verify the fallback chain triggers (or surfaces a clear error if no fallback is configured), not a permanently-broken agent that needs admin intervention to recover.
- C[ ] L[ ] M[ ] A[ ] — Provider returns a `Retry-After` header alongside a 429 → verify Sunrise honours the header rather than re-issuing immediately and tripping the breaker faster than necessary.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Trigger mid-stream failover: kill the primary provider's connection partway through a streaming response. Verify the chat handler falls back to the next provider in the chain and the client sees a coherent assembled response.
- C[ ] L[ ] M[ ] A[ ] — All providers in the fallback chain are unhealthy → verify a single coherent error reaches the client and a cost log is not written for the failed attempts.
- C[ ] L[ ] M[ ] A[ ] — Slow provider (responds at 30+ seconds per token) → verify timeout enforcement at the configured threshold.
- C[ ] L[ ] M[ ] A[ ] — Provider returns a 429 (rate limited) → verify circuit-breaker accounting and fallover (a 429 is a failure for breaker purposes).
- C[ ] L[ ] M[ ] A[ ] — Provider returns a 200 with a malformed JSON body → verify graceful failover, not a crash.
- C[ ] L[ ] M[ ] A[ ] — In-memory circuit breaker state — restart the process → verify breaker state resets cleanly (this is a documented horizontal-scale gap; verify it's at least correct for single-instance).
- C[ ] L[ ] M[ ] A[ ] — Provider config edited (key rotated) while a chat is in flight — verify the in-flight call uses the old key and the next call uses the new key.
- C[ ] L[ ] M[ ] A[ ] — Embedding provider swap to a different vector dimension while old chunks exist → verify dimension-compatibility guard (rejects the swap, requires re-embed of every existing chunk, or walls off old-dim chunks from search) — never silently mixes dimensions and produces nonsense rankings.
- C[ ] L[ ] M[ ] A[ ] — Provider returns corrected token counts after the fact (some providers reconcile mid-bill) → verify the cost log either reconciles in place or stays frozen with documented immutable-on-write behaviour.

---

## Phase 1.4 — Cost & Budget Enforcement

**What this covers:** Per-agent monthly budgets, global monthly cap, 80% warning, 100% hard block — and uniquely, the in-execution-loop check that stops a multi-turn conversation mid-flight when the budget is exceeded. This is Sunrise's flagship differentiator per `maturity-analysis.md`.

**Reference docs:** `.context/admin/orchestration-costs.md`, `functional-specification.md` §3.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Set a per-agent budget of $1, send a few cheap messages → verify cost log accrues per turn.
- C[ ] L[ ] M[ ] A[ ] — Set a per-agent budget low enough that 80% triggers from a few turns → verify warning surface (UI banner, threshold flag).
- C[ ] L[ ] M[ ] A[ ] — Set a per-agent budget low enough that 100% triggers — verify next chat call is blocked with a clear user-facing message.
- C[ ] L[ ] M[ ] A[ ] — Set a global monthly cap → verify it caps the sum across all agents.
- C[ ] L[ ] M[ ] A[ ] — Cost breakdown endpoint returns per-agent / per-model / per-day attribution.
- C[ ] L[ ] M[ ] A[ ] — Cost summary endpoint shows monthly totals, trends, and savings from fallback routing.
- C[ ] L[ ] M[ ] A[ ] — Set a budget threshold notification recipient → verify the alert fires at 80%.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to set a per-agent budget below current month-to-date spend → verify the form behaviour (refuse / warn / accept-but-block-immediately).
- C[ ] L[ ] M[ ] A[ ] — Try to set a negative or non-numeric budget → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Try to manipulate `metadata` on a cost log via an API call → verify the cost log table is write-only by the engine.
- C[ ] L[ ] M[ ] A[ ] — Stress test: fire 50 chats in parallel against an agent at 99% budget → verify only the calls that fit complete, not double-spending past the cap.
- C[ ] L[ ] M[ ] A[ ] — Cost log writer transiently down on a budget-bound call → verify the call fails closed (denies if it can't account) OR fails open with a flagged warning, never silently over-spends because the source-of-truth writer was unavailable.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Mid-conversation budget exhaustion: start a multi-turn tool-using chat that crosses the budget mid-loop → verify the tool loop exits cleanly, the user sees a friendly message, and the partial cost is logged.
- C[ ] L[ ] M[ ] A[ ] — Zero-token response (provider returns 0 output tokens) → verify cost log handles it without divide-by-zero.
- C[ ] L[ ] M[ ] A[ ] — Very large completion (50K output tokens) → verify cost is calculated correctly with the model's pricing.
- C[ ] L[ ] M[ ] A[ ] — Cost calculation for a model whose pricing changed mid-month → verify the historical pricing is honoured for old logs.
- C[ ] L[ ] M[ ] A[ ] — Fallback routing saved cost → verify the savings field on the summary endpoint reflects actual fallback usage.
- C[ ] L[ ] M[ ] A[ ] — Budget mutex under concurrent calls (in-memory; documented horizontal-scale gap) — verify single-instance correctness.
- C[ ] L[ ] M[ ] A[ ] — Cost log write fails (DB hiccup) → verify chat completes (fire-and-forget) and the failure is logged at warn level.
- C[ ] L[ ] M[ ] A[ ] — A single cost log spans the DST boundary (turn started 01:55 standard time, completed 03:05 daylight) → verify `createdAt` / `completedAt` are stored in UTC unambiguously and the daily / monthly bucketing is correct on both sides of the transition.
- C[ ] L[ ] M[ ] A[ ] — Cost-log retroactive correction: provider returns updated token counts in a follow-up reconciliation (some providers do this) → verify whether the log reconciles in place or is contractually immutable; the contract should be one of these, not "depends".

---

## Phase 1.5 — Capability Dispatch Pipeline

**What this covers:** The 7-stage dispatch pipeline (registry → binding → rate limit → approval gate → arg validation → timed execution → cost log) is the structured entry point for every tool call. Default-allow dispatch / default-deny LLM visibility is a deliberate architectural choice.

**Reference docs:** `.context/orchestration/capabilities.md`, `.context/admin/orchestration-capabilities.md`, `.context/admin/capability-form.md`, `functional-specification.md` §4.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Invoke each built-in capability at least once: `search_knowledge_base`, `estimate_workflow_cost`, `get_pattern_detail`, `read_user_memory`, `write_user_memory`, `escalate_to_human`, `apply_audit_changes`, `add_provider_models`, `deactivate_provider_models`, `call_external_api`, `run_workflow`.
- C[ ] L[ ] M[ ] A[ ] — Bind a capability to an agent and verify it appears in the LLM's tool definitions only when explicitly visible.
- C[ ] L[ ] M[ ] A[ ] — Configure a capability with `requires_approval: true` → verify the dispatcher pauses for approval before execution.
- C[ ] L[ ] M[ ] A[ ] — Configure a capability with a custom rate limit → verify enforcement.
- C[ ] L[ ] M[ ] A[ ] — Use the visual builder to create a new capability with a Zod schema → verify it dispatches correctly.
- C[ ] L[ ] M[ ] A[ ] — Use the JSON editor to edit a capability and switch back to visual builder → verify roundtrip.
- C[ ] L[ ] M[ ] A[ ] — Capability category filter on the list page works.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Have the LLM emit a tool call for a capability that's registered but NOT bound to the agent → verify rejection at stage 2 (binding check).
- C[ ] L[ ] M[ ] A[ ] — Have the LLM emit a tool call for a capability that does not exist → verify rejection at stage 1 (registry lookup).
- C[ ] L[ ] M[ ] A[ ] — Exceed a per-capability rate limit (sliding window) → verify clean 429 / friendly tool failure.
- C[ ] L[ ] M[ ] A[ ] — Submit malformed arguments that fail Zod validation → verify clean error, no execution.
- C[ ] L[ ] M[ ] A[ ] — Try to delete a system capability (`isSystem: true`) → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Try to deactivate a system capability → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Have a capability handler raise an uncaught exception → verify the dispatcher catches it and surfaces a tool error to the LLM.
- C[ ] L[ ] M[ ] A[ ] — Have a capability handler hang past the configured timeout → verify timeout enforcement.
- C[ ] L[ ] M[ ] A[ ] — Have a capability return a 5MB JSON blob → verify response size handling.
- C[ ] L[ ] M[ ] A[ ] — Capability `customConfig` includes an env-var reference that doesn't resolve → verify clear startup or first-call error.
- C[ ] L[ ] M[ ] A[ ] — LLM emits a 100KB tool-call argument → verify dispatch enforces the documented input cap and returns a clean tool error rather than passing through and exploding downstream.
- C[ ] L[ ] M[ ] A[ ] — Tool handler returns a value containing `BigInt`, `Date`, circular reference, or `undefined` → verify serialisation is deterministic or rejects with a clear error (not a silent `null` that leaves the LLM confused).
- C[ ] L[ ] M[ ] A[ ] — Tool returns a result whose shape fails the capability's output validator (where defined) → verify the LLM sees a typed validation error, not a free-form pass-through.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Capability invoked synchronously inside `run_workflow` → verify nested capability dispatch works (cost log attribution by stepId).
- C[ ] L[ ] M[ ] A[ ] — Capability invoked twice in the same chat turn → verify both are dispatched and `[N]` citation markers are monotonic across them.
- C[ ] L[ ] M[ ] A[ ] — Capability with a Zod schema using `.refine()` cross-field validation → verify the refinement runs.
- C[ ] L[ ] M[ ] A[ ] — Capability that returns a binary response (base64) → verify wrapping per the recipes pattern.
- C[ ] L[ ] M[ ] A[ ] — Capability deactivated while an MCP client is mid-call → verify graceful handling.
- C[ ] L[ ] M[ ] A[ ] — Two agents with different per-agent `customConfig` for the same capability → verify they are isolated (a leak here is a major bug).
- C[ ] L[ ] M[ ] A[ ] — Capability `customConfig` updated while a workflow that captured the old value is mid-execution → verify the in-flight execution sees the frozen config (parallel to step-config snapshot semantics), not the new one.
- C[ ] L[ ] M[ ] A[ ] — Capability deactivated mid-tool-loop within a single chat turn → verify the in-flight tool call either completes against the captured definition or fails with a clear "deactivated" error, not a partial / inconsistent state.

---

## Phase 1.6 — Knowledge Base: Ingestion

**What this covers:** Multi-format document ingestion (md, txt, csv, epub, docx, pdf), the lifecycle (`pending` → `processing` → `ready`/`failed`, plus PDF's `pending_review`), the 50MB cap, the SHA-256 dedup on PDF re-uploads, and the chunking + embedding pipeline.

**Reference docs:** `.context/orchestration/knowledge.md`, `.context/orchestration/document-ingestion.md`, `.context/admin/orchestration-knowledge-ui.md`, `functional-specification.md` §7.1–§7.2.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Upload a markdown document → verify lifecycle transitions to `ready` and chunks are visible.
- C[ ] L[ ] M[ ] A[ ] — Upload a plain `.txt` document → verify ingestion completes.
- C[ ] L[ ] M[ ] A[ ] — Upload a `.csv` document with a header row → verify one chunk per data row (row-atomic) appears.
- C[ ] L[ ] M[ ] A[ ] — Upload a `.csv` with 6,000 rows → verify the chunker batches 10 rows per chunk above the 5,000 threshold (cost cap).
- C[ ] L[ ] M[ ] A[ ] — Upload an EPUB book → verify chapters become semantically coherent chunks.
- C[ ] L[ ] M[ ] A[ ] — Upload a DOCX with headings → verify chunking respects heading boundaries.
- C[ ] L[ ] M[ ] A[ ] — Upload a PDF → verify the lifecycle pauses at `pending_review`, the preview is visible, and confirmation transitions to `ready`.
- C[ ] L[ ] M[ ] A[ ] — Tag a document with a category → verify only agents scoped to that category retrieve its chunks.
- C[ ] L[ ] M[ ] A[ ] — Re-chunk an existing document → verify chunks are regenerated and embeddings are reissued.
- C[ ] L[ ] M[ ] A[ ] — Retry a failed document → verify it re-enters the pipeline.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Upload a 51MB file → verify size-cap rejection with a clear message.
- C[ ] L[ ] M[ ] A[ ] — Upload a binary file with a `.txt` extension → verify graceful failure or sanitisation.
- C[ ] L[ ] M[ ] A[ ] — Upload a malformed PDF (truncated, corrupt header) → verify failure path doesn't crash the worker.
- C[ ] L[ ] M[ ] A[ ] — Upload a password-protected PDF → verify clear failure message.
- C[ ] L[ ] M[ ] A[ ] — Upload a CSV with a stray BOM at the start → verify normalisation (per the robustness fixes layered into item #5).
- C[ ] L[ ] M[ ] A[ ] — Upload a CSV with classic-Mac CR-only line endings → verify normalisation.
- C[ ] L[ ] M[ ] A[ ] — Upload a CSV with an unbalanced quote in row 47 → verify recovery and a warning naming the offending row.
- C[ ] L[ ] M[ ] A[ ] — Upload a CSV where row 12 has more cells than the header → verify the overflow-row warning surfaces.
- C[ ] L[ ] M[ ] A[ ] — Upload a markdown file containing what looks like a prompt injection in a code block → verify it's stored verbatim, not interpreted by anything during ingestion.
- C[ ] L[ ] M[ ] A[ ] — Upload the same PDF twice as the same admin → verify SHA-256 dedup refreshes the existing `pending_review` row in place (does not create a duplicate).
- C[ ] L[ ] M[ ] A[ ] — Two admins upload the same PDF → verify dedup is scoped to the uploader, not global.
- C[ ] L[ ] M[ ] A[ ] — Embedding regeneration storm — trigger re-chunk on 100 documents simultaneously → verify queueing, throttling, or outbound rate-limit interaction prevents thrashing the embedding provider and exhausting the budget in seconds.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Upload a CSV, confirm it ingests, then re-chunk → verify it re-routes through `chunkCsvDocument` (not the markdown chunker), preserving row-atomic shape (per the fix in item #5).
- C[ ] L[ ] M[ ] A[ ] — Upload a PDF where pages 4–7 are scanned (no extractable text) → verify a single grouped warning ("Pages 4–7 of 22 produced no extractable text") rather than one warning per page.
- C[ ] L[ ] M[ ] A[ ] — Upload a PDF with the "extract tables" checkbox enabled → verify detected vector-grid tables are rendered as fenced markdown pipe tables in the preview.
- C[ ] L[ ] M[ ] A[ ] — Upload a PDF, abandon the preview, retry with a different option toggled → verify the preview row is refreshed in place.
- C[ ] L[ ] M[ ] A[ ] — Embedding provider unavailable during ingestion → verify the document lands in `failed` with a clear reason, not silently `ready`.
- C[ ] L[ ] M[ ] A[ ] — Document with a single 200KB chunk (no natural break points) → verify chunker handles oversized chunks.
- C[ ] L[ ] M[ ] A[ ] — Document deleted while embeddings are being generated → verify graceful cleanup.
- C[ ] L[ ] M[ ] A[ ] — Switch the configured embedding model to a different vector dimension while existing chunks are still embedded under the old dim → verify the system either rejects the swap, requires re-embed of every existing chunk, or walls off old-dim chunks from search; never silently mixes dimensions.
- C[ ] L[ ] M[ ] A[ ] — Re-uploaded document supersedes an in-flight ingestion of the prior version → verify only one `ready` row results, no orphan chunks from the abandoned run.

---

## Phase 1.7 — Knowledge Base: Hybrid Search & Citations

**What this covers:** The hybrid retrieval (BM25-flavoured `ts_rank_cd` blended with pgvector cosine via tunable weights), agent scoping by `knowledgeCategories`, and the citation envelope that flows from the `search_knowledge_base` tool through the chat handler to the persisted message metadata and rendered admin/embed surfaces.

**Reference docs:** `.context/orchestration/knowledge.md`, `.context/orchestration/chat.md` (Citations section), `.context/orchestration/output-guard.md` (Citation Guard), `functional-specification.md` §7.3.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Run the Search Test page with a query → verify hybrid mode returns results with the three-segment score breakdown (vector / BM25 / blended).
- C[ ] L[ ] M[ ] A[ ] — Toggle hybrid off (vector-only legacy mode) → verify search still works and returns vector-only scores.
- C[ ] L[ ] M[ ] A[ ] — Tune `vectorWeight` and `bm25Weight` in settings → verify rankings shift accordingly.
- C[ ] L[ ] M[ ] A[ ] — Search for an acronym or model number that vector similarity misses but keyword recall captures → verify hybrid retrieves it.
- C[ ] L[ ] M[ ] A[ ] — Issue a chat turn that triggers `search_knowledge_base` → verify a `citations` event arrives before `done` and the persisted assistant message has `metadata.citations`.
- C[ ] L[ ] M[ ] A[ ] — Render the conversation in the admin chat view → verify `[N]` markers appear as superscript references and the sources panel shows source documents.
- C[ ] L[ ] M[ ] A[ ] — Render the same conversation in the embed widget → verify the vanilla-JS citation rendering matches.
- C[ ] L[ ] M[ ] A[ ] — Two tool calls in one turn each emit citations → verify markers are monotonic across the combined envelope.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Run a search query containing a SQL-like payload → verify Postgres parameterisation prevents injection.
- C[ ] L[ ] M[ ] A[ ] — Run a search query of 10,000 characters → verify clean rejection or truncation.
- C[ ] L[ ] M[ ] A[ ] — Configure an agent with `knowledgeCategories: []` → verify NO chunks are returned (correct restrictive behaviour, not a misinterpretation of "no filter").
- C[ ] L[ ] M[ ] A[ ] — Configure two agents with overlapping but distinct categories → verify each retrieves only its own scope (no cross-leak).
- C[ ] L[ ] M[ ] A[ ] — Set the Citation Guard to `block` and have the LLM emit a `[N]` for a marker that no citation produced → verify guard catches the hallucinated marker.
- C[ ] L[ ] M[ ] A[ ] — Set the Citation Guard to `block` and have the LLM produce a citationable claim with NO marker → verify the under-citation case is caught.
- C[ ] L[ ] M[ ] A[ ] — Set the Citation Guard to `log_only` → verify violations are logged but the response is delivered unchanged.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Turn produces no tool calls → verify Citation Guard vacuously passes (does not flag responses that never had citations to cite).
- C[ ] L[ ] M[ ] A[ ] — Search returns 0 results → verify the LLM's tool-result envelope reflects empty results without crashing the citation machinery.
- C[ ] L[ ] M[ ] A[ ] — Hybrid search with both weights set to 0 → verify either rejection or sane defaulting.
- C[ ] L[ ] M[ ] A[ ] — pgvector index missing or corrupt → verify failure path is loud, not silent zero-results.
- C[ ] L[ ] M[ ] A[ ] — Citation envelope with 50+ unique markers in one turn → verify the message metadata size is reasonable.
- C[ ] L[ ] M[ ] A[ ] — CSV chunk surfaced as a citation → verify it renders the row content readably (not as raw JSON).
- C[ ] L[ ] M[ ] A[ ] — Search determinism — issue the same query twice with identical settings → verify identical hybrid rankings and ties resolved deterministically (drift here makes evaluation re-scores artifactual).
- C[ ] L[ ] M[ ] A[ ] — Agent `knowledgeCategories` modified between turn 5 and turn 6 of an ongoing conversation → verify subsequent searches honour the new scope, and that the rolling summary doesn't leak old-scope content forward.
- C[ ] L[ ] M[ ] A[ ] — Citation persistence vs source mutation: a chunk cited in a persisted message is later edited or its parent document deleted → verify the citation envelope on the historical message remains coherent (snapshot of source content, or a "source removed" flag), not silently broken.

---

## Phase 1.8 — Authentication & Authorisation

**What this covers:** All the auth surfaces — admin sessions (better-auth), embed tokens with CORS, invite tokens with expiry/usage limits, MCP API keys with scopes, and HMAC-SHA256 approval tokens. Plus the cross-cutting authorisation rules: ownership scoping returns 404 not 403; approver delegation via `approverUserIds`.

**Reference docs:** `.context/auth/`, `.context/orchestration/agent-visibility.md`, `.context/orchestration/api-keys.md`, `.context/orchestration/mcp.md`, `.context/admin/orchestration-approvals.md`, `functional-specification.md` §17.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Admin login via better-auth → access an admin orchestration page successfully.
- C[ ] L[ ] M[ ] A[ ] — Consumer login → access a `public` agent's chat successfully.
- C[ ] L[ ] M[ ] A[ ] — Generate an embed token with an origin allowlist → load the widget on an allowed origin.
- C[ ] L[ ] M[ ] A[ ] — Generate an invite token with a usage limit and expiry → use it within the limit.
- C[ ] L[ ] M[ ] A[ ] — Generate an MCP API key with a specific scope → call only the scoped tools.
- C[ ] L[ ] M[ ] A[ ] — Approve a workflow via the admin queue (session-authenticated).
- C[ ] L[ ] M[ ] A[ ] — Approve a workflow via the external HMAC token URL (token-authenticated, no session).
- C[ ] L[ ] M[ ] A[ ] — Approve a workflow via the in-chat card sub-route (`/approvals/:id/approve/chat`).
- C[ ] L[ ] M[ ] A[ ] — Approve a workflow via the embed sub-route (`/approvals/:id/approve/embed`).
- C[ ] L[ ] M[ ] A[ ] — Approve as a delegated approver (user ID in `approverUserIds`) — verify success even though you don't own the execution.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Replay a leaked HMAC approval token after it's been used → verify it's rejected.
- C[ ] L[ ] M[ ] A[ ] — Tamper with an HMAC approval token (flip a byte) → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Use an embed token from a non-allowlisted origin → verify CORS rejection.
- C[ ] L[ ] M[ ] A[ ] — Use an invite token after expiry → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Use an invite token past its usage limit → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Use an MCP API key with insufficient scope to call a privileged tool → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Try to access another user's conversation by ID → verify 404 (NOT 403 — no info leak).
- C[ ] L[ ] M[ ] A[ ] — Try to access another user's workflow execution by ID → verify 404.
- C[ ] L[ ] M[ ] A[ ] — Try to approve an execution you don't own and aren't delegated for → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Cross-user lookup on every entity type that has user scoping (memory, conversations, executions, evaluation sessions) → spot-check 404 not 403.
- C[ ] L[ ] M[ ] A[ ] — Submit a CSRF-style request to an admin mutating endpoint → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Include an admin session cookie alongside an MCP bearer token on the same request → verify the more restrictive auth wins.
- C[ ] L[ ] M[ ] A[ ] — Admin user logs out → verify any active SSE streams under that session are terminated, and pending approvals attributed to them surface a sensible "session expired" path.
- C[ ] L[ ] M[ ] A[ ] — Force-revoke all sessions for a user (admin "kill switch") → verify all active streams across all tabs and devices terminate within the documented window.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Invite token expires while a user is mid-conversation → verify in-flight stream completes; new turns are rejected.
- C[ ] L[ ] M[ ] A[ ] — Approval HMAC token expires between when the email lands and when the user clicks approve → verify clean rejection with the actual expiry reason.
- C[ ] L[ ] M[ ] A[ ] — Two admins simultaneously approve the same execution → verify optimistic locking prevents double-execution.
- C[ ] L[ ] M[ ] A[ ] — Approver list contains a deleted user — verify others can still approve.
- C[ ] L[ ] M[ ] A[ ] — MCP key revoked while a session is active → verify the next request is rejected, the active session is terminated.
- C[ ] L[ ] M[ ] A[ ] — Embed token deleted while a widget is mid-stream → verify graceful close.
- C[ ] L[ ] M[ ] A[ ] — System role marker on a token vs. on a user — verify they're not conflated.
- C[ ] L[ ] M[ ] A[ ] — User email or display name change after audit rows are written → verify audit immutability holds (old rows show old identity), and that current views reconcile via foreign key — not a denormalised name copied at write time.

---

# Tier 2 — Core engine, important but less hot

Frequent enough that any regression matters. Walk these after Tier 1 is clean.

---

## Phase 2.1 — Workflow Engine: DAG Execution

**What this covers:** The `OrchestrationEngine` runtime, the 15 step types, parallel branch execution with frozen context snapshots, the four error strategies (retry / fallback / skip / fail), template interpolation, dual-path cancellation, and event streaming.

**Reference docs:** `.context/orchestration/engine.md`, `.context/orchestration/workflows.md`, `.context/admin/workflow-builder.md`, `functional-specification.md` §5.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Build a 5-step linear workflow via the visual builder → save → run → verify result.
- C[ ] L[ ] M[ ] A[ ] — Build a parallel workflow (3 branches) → run → verify all branches execute concurrently.
- C[ ] L[ ] M[ ] A[ ] — Build a workflow with a `condition` step that branches on prior output.
- C[ ] L[ ] M[ ] A[ ] — Build a workflow with a `loop` step with an exit condition.
- C[ ] L[ ] M[ ] A[ ] — Build a workflow using each of the 15 step types at least once across multiple workflows: `llm_call`, `tool_call`, `condition`, `parallel`, `loop`, `transform`, `human_approval`, `agent_call`, `orchestrator`, `external_call`, `knowledge_search`, `code_eval`, `wait`, `notify`, `aggregate`.
- C[ ] L[ ] M[ ] A[ ] — Run a workflow's dry-run mode with mocked LLM calls.
- C[ ] L[ ] M[ ] A[ ] — Use template interpolation to pass data from step A's output to step B's prompt.
- C[ ] L[ ] M[ ] A[ ] — Cancel an in-flight execution from the admin UI → verify both cancellation paths (client signal + DB flag) cause the engine to stop.
- C[ ] L[ ] M[ ] A[ ] — Retry an individual failed step from the trace viewer.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a workflow definition containing a cycle → verify rejection at save (DAG validator).
- C[ ] L[ ] M[ ] A[ ] — Submit a workflow referencing a nonexistent capability → verify save-time validation.
- C[ ] L[ ] M[ ] A[ ] — Submit a workflow with a step config that fails Zod validation → verify save-time validation.
- C[ ] L[ ] M[ ] A[ ] — Submit a workflow with a `loop` step missing an exit condition → verify validation rejects.
- C[ ] L[ ] M[ ] A[ ] — Submit a template with a malformed `{{ variable }}` placeholder → verify clean error at interpolation, not silent passthrough.
- C[ ] L[ ] M[ ] A[ ] — Run a workflow that hits its budget limit mid-execution → verify mid-run halt with a clear reason.
- C[ ] L[ ] M[ ] A[ ] — Run a workflow whose `external_call` step references a non-allowlisted host → verify rejection at execution.
- C[ ] L[ ] M[ ] A[ ] — Run a workflow that exceeds the documented step count limit (if any) → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Engine crash during execution (kill the process mid-run) → verify the execution status reflects the crash on restart (per item #15 in `improvement-priorities.md`, full checkpoint recovery is partial — verify what IS recovered).
- C[ ] L[ ] M[ ] A[ ] — `wait` step configured for 30 days → restart the process, deploy a new version, and run a database migration over the wait window → verify the wait survives and resumes correctly, OR that the durability ceiling is documented and the user is warned at save time.
- C[ ] L[ ] M[ ] A[ ] — Workflow run while the engine is mid-deploy (process restart between step 4 and step 5) → verify the execution status is honest about what's recoverable vs lost, not silently "completed".

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Parallel branch where branch A succeeds and branch B fails with `error.strategy: fail` → verify the entire workflow halts.
- C[ ] L[ ] M[ ] A[ ] — Parallel branch where branch B fails with `error.strategy: skip` → verify branch B is marked skipped and downstream `aggregate` step receives partial results.
- C[ ] L[ ] M[ ] A[ ] — Step with `error.strategy: retry` and `maxAttempts: 3` → fail twice, succeed on third → verify telemetry only reflects the successful attempt.
- C[ ] L[ ] M[ ] A[ ] — Step with `error.strategy: fallback` → primary fails → verify fallback step executes with prior context.
- C[ ] L[ ] M[ ] A[ ] — Workflow modified (saved a new version) while a previous-version execution is running → verify the in-flight execution uses its frozen definition, not the new one.
- C[ ] L[ ] M[ ] A[ ] — Two scheduled fires of the same workflow overlap (cron interval shorter than execution time) → verify expected behaviour (queue, skip, run-in-parallel).
- C[ ] L[ ] M[ ] A[ ] — `agent_call` step where the called agent has zero capabilities — verify clean execution.
- C[ ] L[ ] M[ ] A[ ] — `orchestrator` step's planner LLM produces an unparseable plan → verify retry/failure path.
- C[ ] L[ ] M[ ] A[ ] — `code_eval` step with an expression that throws → verify isolation (no engine crash).
- C[ ] L[ ] M[ ] A[ ] — `code_eval` step that tries to read the filesystem, env vars, or process info → verify sandbox denies access.
- C[ ] L[ ] M[ ] A[ ] — `wait` step with a 0-second wait → verify it doesn't spin.
- C[ ] L[ ] M[ ] A[ ] — `wait` step in a parallel branch → verify other branches continue while it sleeps (doesn't block the engine thread).
- C[ ] L[ ] M[ ] A[ ] — `aggregate` step combines results from a `parallel` step → verify all branch outputs are accessible in the aggregate's context.
- C[ ] L[ ] M[ ] A[ ] — `transform` step with a reshape expression (e.g. mapping array to object) → verify downstream steps see the transformed shape.
- C[ ] L[ ] M[ ] A[ ] — `notify` step with a missing or unreachable webhook target → verify the failure surfaces as a step error, not a silent drop.
- C[ ] L[ ] M[ ] A[ ] — `orchestrator` step's planner LLM produces a plan referencing a step type that doesn't exist → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Nested `agent_call` chain (A → B → C) → verify per-call cost log attribution and trace entries land on the right step IDs.
- C[ ] L[ ] M[ ] A[ ] — Telemetry entries (model, provider, inputTokens, outputTokens, llmDurationMs) populate correctly on each LLM-bearing step.
- C[ ] L[ ] M[ ] A[ ] — Step type schema migration: a workflow saved under `step.config` v1 is loaded after a v2 schema is shipped that adds a required field → verify either back-compat default or a clear rejection at load time, never a silent skip that runs the step with missing config.
- C[ ] L[ ] M[ ] A[ ] — Capability `customConfig` updated mid-execution of a workflow whose `tool_call` step captured the old value → verify the frozen-snapshot semantics extend to capability config, not just step config.
- C[ ] L[ ] M[ ] A[ ] — Workflow loaded by an executor running a newer code revision than the one that saved it (during a rolling deploy) → verify either compatibility or a clean rejection.

---

## Phase 2.2 — Workflow Engine: Approvals

**What this covers:** The full approval surface — admin queue UI, session-authenticated admin endpoints, token-authenticated external endpoints (HMAC-SHA256), in-chat card via the recently shipped `run_workflow` capability + `approval_required` SSE event + four channel-specific sub-routes.

**Reference docs:** `.context/admin/orchestration-approvals.md`, `.context/orchestration/chat.md` (In-chat approvals section), `.context/orchestration/recipes/in-chat-approval.md`, `functional-specification.md` §5.5.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Run a workflow with a `human_approval` step → verify it pauses, the queue shows it with prompt + cost summary + previous-step output, sidebar badge increments.
- C[ ] L[ ] M[ ] A[ ] — Approve from the queue with optional notes → verify execution resumes from the next step.
- C[ ] L[ ] M[ ] A[ ] — Reject from the queue with required reason → verify execution is marked rejected and downstream steps don't run.
- C[ ] L[ ] M[ ] A[ ] — Approve via an emailed HMAC URL (no session) → verify success and audit row.
- C[ ] L[ ] M[ ] A[ ] — Trigger an in-chat approval via `run_workflow` capability → verify the chat client sees an `approval_required` event and renders the Approve / Reject card.
- C[ ] L[ ] M[ ] A[ ] — Click Approve in the chat card → verify polling on `/status` until completion → verify a synthesised follow-up user message reaches the LLM.
- C[ ] L[ ] M[ ] A[ ] — Click Approve in the embed widget approval card → verify the widget polls, completes, and sends a follow-up.
- C[ ] L[ ] M[ ] A[ ] — Approver delegation: log in as a user listed in `approverUserIds` who is NOT the execution owner → verify approval succeeds.
- C[ ] L[ ] M[ ] A[ ] — Verify the audit trail records `actor: token:chat` for chat-rendered approvals, `token:embed` for embed, `token:external` for emailed.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Tamper with the HMAC token in a URL → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Replay an approve token after the execution has been resolved → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Click Approve and Reject in rapid succession → verify only the first lands; the second sees an "already resolved" error.
- C[ ] L[ ] M[ ] A[ ] — Approve as a non-owner / non-delegated admin → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Send an embed approval request from a non-allowlisted origin → verify CORS rejection (per `embedAllowedOrigins`).
- C[ ] L[ ] M[ ] A[ ] — Attempt to call the chat sub-route from a different page origin → verify same-origin enforcement.
- C[ ] L[ ] M[ ] A[ ] — Submit a 100KB approval-notes payload → verify size cap.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Approval token expires between email send and click → verify the expiry message is specific.
- C[ ] L[ ] M[ ] A[ ] — Hard-reload the embed widget mid-approval → verify behaviour matches the documented gap (no message-history endpoint for embed; card not restored — confirm graceful state, not crash).
- C[ ] L[ ] M[ ] A[ ] — Approval queue is empty → verify the page renders cleanly.
- C[ ] L[ ] M[ ] A[ ] — Approval queue with 100+ pending → verify pagination / scrolling.
- C[ ] L[ ] M[ ] A[ ] — Embed widget approval card where the workflow output is binary or huge → verify the synthesised follow-up message handles it.
- C[ ] L[ ] M[ ] A[ ] — In-chat approval where the workflow fails after approval → verify the chat surfaces the failure as a tool error, not a sad-path success.
- C[ ] L[ ] M[ ] A[ ] — Pending approval after 30, 60, 90 days → verify the execution row, the HMAC token, and the queue UI all behave sensibly at long horizons (no unannounced expiry, no orphan rows, no surprises after a re-deploy in between).
- C[ ] L[ ] M[ ] A[ ] — Approval reminder cadence — admin sets a "remind at 24h / 72h" policy (if the surface exists) → verify reminders fire and are de-duplicated; if the surface doesn't exist, document the gap.
- C[ ] L[ ] M[ ] A[ ] — Approval rejected because policy changed between proposal and click → verify the rejection reason captures the policy-change context (which rule, which actor, when) rather than a generic "rejected".

---

## Phase 2.3 — Embeddable Chat Widget

**What this covers:** The Shadow-DOM widget served via `/api/v1/embed/widget.js`, per-agent theming via `widgetConfig` and CSS custom properties, conversation starters, XSS-safe text rendering, and the in-chat approval card from Tier 3 #11.

**Reference docs:** `.context/orchestration/embed.md`, `.context/admin/agent-form.md` (Embed tab), `functional-specification.md` §14.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Drop the widget script tag onto a static HTML page on an allowlisted origin → verify mount, boot, theme application.
- C[ ] L[ ] M[ ] A[ ] — Configure per-agent colours, font, header, subtitle, footer, send button label, input placeholder, and up to 4 conversation starter chips → verify all apply on next widget reload.
- C[ ] L[ ] M[ ] A[ ] — Click a conversation starter chip → verify it populates the input and sends the same path.
- C[ ] L[ ] M[ ] A[ ] — After first message, conversation starters auto-hide → verify behaviour.
- C[ ] L[ ] M[ ] A[ ] — Save appearance from the Embed tab → verify it writes immediately via PATCH and a `agent.widget_config.update` audit row with from/to deltas.
- C[ ] L[ ] M[ ] A[ ] — Reset to defaults from the appearance section → verify revert.
- C[ ] L[ ] M[ ] A[ ] — Verify widget config roundtrips through per-agent export bundle, clone route, and full system backup.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a `widgetConfig` colour value that's not 6-digit hex → verify Zod rejection.
- C[ ] L[ ] M[ ] A[ ] — Submit a `fontFamily` containing `{` or `;` or `(` → verify rejection (CSS escape prevention).
- C[ ] L[ ] M[ ] A[ ] — Submit a header / subtitle / footer with embedded `<script>` → verify it's rendered as `textContent` (escaped, not executed).
- C[ ] L[ ] M[ ] A[ ] — Submit a header longer than 60 chars → verify length cap.
- C[ ] L[ ] M[ ] A[ ] — Submit 5 conversation starters → verify the 4-cap.
- C[ ] L[ ] M[ ] A[ ] — Forge an embed token → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Load the widget from a non-allowlisted origin → verify CORS rejection on the first request.
- C[ ] L[ ] M[ ] A[ ] — Manually corrupt the stored `widgetConfig` JSON in the database → verify the loader falls back to defaults rather than crashing.
- C[ ] L[ ] M[ ] A[ ] — Partner site declares a strict CSP (`default-src 'self'`, no `frame-ancestors` for Sunrise) → verify the documented integration steps surface the CSP requirements clearly, and the widget either works or fails with a developer-readable error in the console.
- C[ ] L[ ] M[ ] A[ ] — Partner site has a service worker that intercepts cross-origin fetches → verify the widget's SSE stream is not buffered or rewritten by the SW (or that the documented bypass header is honoured).
- C[ ] L[ ] M[ ] A[ ] — Partner site caches an older `widget.js` loader from a prior deploy → verify the cache-busting strategy (versioned URL, immutable content hash, or `Cache-Control` headers) so partners aren't pinned to stale UI.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Boot the widget with no `widgetConfig` set → verify defaults apply cleanly.
- C[ ] L[ ] M[ ] A[ ] — Boot the widget with subtitle and footer empty strings → verify rows hide themselves.
- C[ ] L[ ] M[ ] A[ ] — Boot the widget on a partner site with a CSS reset that affects `:host` → verify Shadow-DOM isolation holds.
- C[ ] L[ ] M[ ] A[ ] — Boot the widget on a page with conflicting global JS variables → verify no leakage in/out of the widget.
- C[ ] L[ ] M[ ] A[ ] — Two partner sites sharing one agent → verify identical appearance (per the documented per-agent-only design).
- C[ ] L[ ] M[ ] A[ ] — iOS Safari colour picker behaviour → verify acceptable v1 fallback.

---

## Phase 2.4 — Consumer Chat API

**What this covers:** The 8-route consumer-facing API: stream endpoint (SSE), agent listing (visibility-aware), conversation CRUD, message history, user memory operations. Per-user rate limiting (20/min) and per-user scoping run cross-route.

**Reference docs:** `.context/api/consumer-chat.md`, `.context/orchestration/agent-visibility.md`, `functional-specification.md` §15.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — List visible agents for a logged-in consumer → verify only `public` and `invite_only` (with valid token) agents appear; `internal` agents are excluded.
- C[ ] L[ ] M[ ] A[ ] — Create a new conversation → verify ownership is set to the calling user.
- C[ ] L[ ] M[ ] A[ ] — List conversations → verify only the calling user's conversations are returned.
- C[ ] L[ ] M[ ] A[ ] — Read a conversation by ID → verify only the owner can read.
- C[ ] L[ ] M[ ] A[ ] — Delete a conversation → verify cascading delete of messages.
- C[ ] L[ ] M[ ] A[ ] — Get message history for a conversation → verify ordering.
- C[ ] L[ ] M[ ] A[ ] — Read user memory → verify per-user scoping.
- C[ ] L[ ] M[ ] A[ ] — Write user memory → verify upsert behaviour.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to read another user's conversation by ID → verify 404 (not 403).
- C[ ] L[ ] M[ ] A[ ] — Try to list another user's conversations by passing their userId → verify ignored / 404.
- C[ ] L[ ] M[ ] A[ ] — Try to read an `internal` agent → verify 404.
- C[ ] L[ ] M[ ] A[ ] — Try to read an `invite_only` agent without a token → verify 404.
- C[ ] L[ ] M[ ] A[ ] — Send 25 messages in 60s → verify per-user 20/min rate limit kicks in.
- C[ ] L[ ] M[ ] A[ ] — Submit a conversation create with a 10KB title → verify length cap.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Conversation belonging to a deleted agent → verify clean handling (404 or salvage).
- C[ ] L[ ] M[ ] A[ ] — Visibility flipped from `public` to `internal` while a conversation is active → verify in-flight messages complete; new ones rejected.
- C[ ] L[ ] M[ ] A[ ] — Empty conversation history (just-created conversation) → verify clean SSE on first turn.
- C[ ] L[ ] M[ ] A[ ] — User memory key collisions / case sensitivity → verify documented behaviour.

---

## Phase 2.5 — MCP Server

**What this covers:** Sunrise's full Model Context Protocol server — JSON-RPC 2.0 over Streamable HTTP, batch requests (up to 20), 1MB body limit, dynamic tool exposure scoped to agent config, in-memory sessions with audit logging on every request.

**Reference docs:** `.context/orchestration/mcp.md`, `.context/api/orchestration-endpoints.md`, `functional-specification.md` §8.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — List tools via JSON-RPC `tools/list` → verify the response matches the bound capabilities for the calling key's scope.
- C[ ] L[ ] M[ ] A[ ] — Call a tool via `tools/call` → verify execution and result.
- C[ ] L[ ] M[ ] A[ ] — List resources via `resources/list` → verify agent / capability / system resources appear.
- C[ ] L[ ] M[ ] A[ ] — Read a resource via `resources/read`.
- C[ ] L[ ] M[ ] A[ ] — Open an SSE notification stream via GET → verify it stays open and receives notifications.
- C[ ] L[ ] M[ ] A[ ] — Terminate a session via DELETE → verify cleanup.
- C[ ] L[ ] M[ ] A[ ] — Submit a batch of 5 JSON-RPC requests in one POST → verify all 5 responses come back correctly.
- C[ ] L[ ] M[ ] A[ ] — Audit log shows every request: method, response code, duration, IP, user agent.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a batch of 21 requests → verify rejection (above the documented cap).
- C[ ] L[ ] M[ ] A[ ] — Submit a 1.5MB request body → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Submit malformed JSON-RPC → verify clean error with the right code.
- C[ ] L[ ] M[ ] A[ ] — Use an unauthenticated request → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Use an API key whose scope excludes the requested tool → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Open more sessions than `maxSessionsPerKey` → verify enforcement.
- C[ ] L[ ] M[ ] A[ ] — Hit the IP-level rate limit → verify clean 429.
- C[ ] L[ ] M[ ] A[ ] — Hit the per-key rate limit → verify clean 429.
- C[ ] L[ ] M[ ] A[ ] — Spam the SSE notification stream with rapid notifications → verify backpressure / no memory leak.
- C[ ] L[ ] M[ ] A[ ] — MCP client speaks an older protocol revision (e.g. before a method was added) → verify the server returns a graceful capability-negotiation response, not a 500.
- C[ ] L[ ] M[ ] A[ ] — MCP client speaks a newer revision the server doesn't yet recognise → verify clean error with a documented protocol-version mismatch code, not silent acceptance.
- C[ ] L[ ] M[ ] A[ ] — JSON-RPC notification (no `id`, no response expected) → verify the server processes it correctly without sending back a response envelope.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — API key revoked while a session is active → verify the next request is rejected and the session is terminated.
- C[ ] L[ ] M[ ] A[ ] — Capability deactivated while an MCP client is mid-call → verify graceful failure on the next call.
- C[ ] L[ ] M[ ] A[ ] — Process restart → verify in-memory sessions are cleanly discarded and clients can re-establish.
- C[ ] L[ ] M[ ] A[ ] — MCP request that triggers a budget-blocked tool call → verify the budget error surfaces correctly.
- C[ ] L[ ] M[ ] A[ ] — MCP `tools/call` invokes `run_workflow` → verify the pause-for-approval response path makes sense from the MCP client's perspective.
- C[ ] L[ ] M[ ] A[ ] — `tools/list` issued twice in the same session with a capability deactivation between them → verify the second list reflects the new state.
- C[ ] L[ ] M[ ] A[ ] — `tools/call` issued for a capability that was deactivated since the last `tools/list` → verify a clear "tool not available" error rather than a confused dispatch attempt.
- C[ ] L[ ] M[ ] A[ ] — Two MCP sessions on the same key see independent state (no cross-session leakage of in-memory caches, prepared statements, or session-scoped progress events).

---

## Phase 2.6 — Input / Output / Citation Guards

**What this covers:** The three guard layers — input (prompt-injection detection across 3 pattern types), output (topic boundaries, PII detection, brand voice), and citation (under-citation, hallucinated marker). Each has three modes (`log_only`, `warn_and_continue`, `block`) with a per-agent override that takes precedence over global.

**Reference docs:** `.context/orchestration/output-guard.md`, `.context/orchestration/chat.md`, `functional-specification.md` §6.3–§6.4.1.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Set input guard to `log_only` globally → submit a `system_override` payload → verify it's logged but the message is processed normally.
- C[ ] L[ ] M[ ] A[ ] — Set input guard to `warn_and_continue` → verify the response metadata includes a warning marker.
- C[ ] L[ ] M[ ] A[ ] — Set input guard to `block` → verify the message is rejected with a clear reason.
- C[ ] L[ ] M[ ] A[ ] — Trigger each of the three input guard pattern types separately: `system_override`, `role_confusion`, `delimiter_injection`.
- C[ ] L[ ] M[ ] A[ ] — Set output guard to flag PII in responses → trigger a response containing an email address → verify flagging.
- C[ ] L[ ] M[ ] A[ ] — Configure topic boundaries → trigger an off-topic response → verify enforcement.
- C[ ] L[ ] M[ ] A[ ] — Set Citation Guard to `block` → trigger an under-citation case → verify content reset.
- C[ ] L[ ] M[ ] A[ ] — Set Citation Guard to `block` → trigger a hallucinated marker case → verify content reset.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Bury a prompt injection inside a long benign message → verify detection.
- C[ ] L[ ] M[ ] A[ ] — Submit a borderline injection that's pattern-adjacent → verify reasonable behaviour (false-positive vs false-negative tradeoff).
- C[ ] L[ ] M[ ] A[ ] — Repeatedly submit the same injection pattern from the same user → verify rate-limit interaction.
- C[ ] L[ ] M[ ] A[ ] — Output guard set to `block` while a stream is mid-flight → verify the stream is reset cleanly.
- C[ ] L[ ] M[ ] A[ ] — PII detection mode set to `block` and the user's own name appears in the response → verify the documented tradeoff (likely flagged as PII).

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Per-agent override conflicts with global guard mode → verify per-agent precedence.
- C[ ] L[ ] M[ ] A[ ] — All three guards enabled with `block` mode simultaneously → verify a single coherent error if multiple trip in one turn.
- C[ ] L[ ] M[ ] A[ ] — Guard fires on a tool result rather than the LLM's final content → verify behaviour is consistent.
- C[ ] L[ ] M[ ] A[ ] — Citation Guard with no citations produced → verify vacuous pass (does NOT flag).
- C[ ] L[ ] M[ ] A[ ] — Output guard with a regex that's expensive to evaluate → verify timeout/safety on guard execution.

---

## Phase 2.7 — Scheduling & Maintenance Tick

**What this covers:** Cron-based workflow scheduling via `AiWorkflowSchedule`, the unified maintenance tick endpoint that processes due schedules, and the lock semantics that prevent duplicate execution (single-instance correctness; horizontal-scale gap is documented).

**Reference docs:** `.context/orchestration/scheduling.md`, `functional-specification.md` §9.1.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Attach a cron schedule (`*/5 * * * *`) to a workflow → verify the maintenance tick fires it.
- C[ ] L[ ] M[ ] A[ ] — List schedules in the admin UI → verify next-fire times are correct.
- C[ ] L[ ] M[ ] A[ ] — Pause a schedule → verify it doesn't fire on the next tick.
- C[ ] L[ ] M[ ] A[ ] — Manually invoke the maintenance tick endpoint → verify due schedules are processed.
- C[ ] L[ ] M[ ] A[ ] — Cron expression timezone semantics — confirm whether `0 9 * * *` evaluates in UTC, the org's timezone, or the user's timezone, and that the admin UI's "next fire" preview matches the actual fire time when the maintenance tick fires.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a malformed cron expression → verify rejection at save.
- C[ ] L[ ] M[ ] A[ ] — Submit a cron expression that fires every second → verify protection / minimum interval.
- C[ ] L[ ] M[ ] A[ ] — Schedule a workflow that has been deleted → verify the tick handles the missing target cleanly.
- C[ ] L[ ] M[ ] A[ ] — Schedule a workflow that fails on every fire → verify failure handling and notification.
- C[ ] L[ ] M[ ] A[ ] — Hit the maintenance tick endpoint as an unauthenticated caller → verify auth is required (or that public access is intentional and bounded).
- C[ ] L[ ] M[ ] A[ ] — Spam the maintenance tick endpoint → verify token-ownership / liveness watchdog (per item #8 in `improvement-priorities.md`).

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Cron interval shorter than typical execution time → verify documented behaviour (queue, skip, parallel).
- C[ ] L[ ] M[ ] A[ ] — Maintenance tick fires while a previous tick is still running → verify the liveness watchdog prevents overlap.
- C[ ] L[ ] M[ ] A[ ] — Clock skew between application and database → verify schedules still fire approximately on time.
- C[ ] L[ ] M[ ] A[ ] — Tick processes 0 due schedules → verify clean no-op response.
- C[ ] L[ ] M[ ] A[ ] — Tick processes 50 due schedules in one batch → verify reasonable performance.
- C[ ] L[ ] M[ ] A[ ] — Maintenance tick interval longer than a schedule's interval (tick every 5 min, schedule `* * * * *` every 1 min) → verify the tick fires the schedule the correct number of times for the elapsed window (multi-fire-per-tick handling), not just once with the rest silently dropped.
- C[ ] L[ ] M[ ] A[ ] — Schedule that should fire at exactly the DST transition instant → verify "skip" or "double-fire" matches the documented contract for the cron implementation in use.
- C[ ] L[ ] M[ ] A[ ] — Schedule defined under one cron timezone, evaluated after an admin changes the org TZ → verify next-fire-time recomputes consistently and the UI preview matches the runtime.

---

## Phase 2.8 — Webhooks & Event Hooks

**What this covers:** Outbound webhook subscriptions and in-process event hooks. Both share the retry strategy (3 attempts: 10s, 60s, 300s), HMAC-SHA256 signing, and delivery-tracking models. Hook registry has a 60s TTL with CRUD invalidation.

**Reference docs:** `.context/orchestration/hooks.md`, `functional-specification.md` §9.2–§9.3.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Create a webhook subscription for `workflow.execution.completed` → trigger a workflow → verify delivery.
- C[ ] L[ ] M[ ] A[ ] — Verify the HMAC-SHA256 signature on the receiver matches the documented algorithm.
- C[ ] L[ ] M[ ] A[ ] — Create an event hook with custom headers → verify they appear on the dispatched request.
- C[ ] L[ ] M[ ] A[ ] — List webhook deliveries with status filter → verify pending / delivered / failed / exhausted states.
- C[ ] L[ ] M[ ] A[ ] — Manually retry a failed delivery → verify retry attempt.
- C[ ] L[ ] M[ ] A[ ] — Verify `workflow.paused_for_approval` event payload includes pre-signed approve/reject URLs.
- C[ ] L[ ] M[ ] A[ ] — Webhook receiver "challenge" handshake at subscription time (Slack-style URL verification): verify whether Sunrise supports this for new subscriptions, or always trusts the configured URL (and document either choice).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Subscribe a webhook to `localhost:8080` → verify SSRF protection rejects (or that the host allowlist is enforced).
- C[ ] L[ ] M[ ] A[ ] — Subscribe a webhook to a 10MB-payload-accepting endpoint → verify outbound payload size cap.
- C[ ] L[ ] M[ ] A[ ] — Subscribe a webhook URL that returns 500 always → verify 3 retries then `exhausted`.
- C[ ] L[ ] M[ ] A[ ] — Subscribe a webhook URL that hangs (never responds) → verify timeout enforcement.
- C[ ] L[ ] M[ ] A[ ] — Subscribe a webhook URL that returns 200 but with no body → verify clean success handling.
- C[ ] L[ ] M[ ] A[ ] — Tamper with the HMAC header on the receiver → verify the receiver's signature check fails.
- C[ ] L[ ] M[ ] A[ ] — Spam-fire a hook event 1000 times → verify queueing, no engine memory issues.
- C[ ] L[ ] M[ ] A[ ] — Five events fire within 10ms for the same subscription → verify ordering guarantees match the documented contract (FIFO, parallel, or undefined) — receivers depend on this for replay correctness.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Hook handler raises mid-delivery → verify status transitions correctly.
- C[ ] L[ ] M[ ] A[ ] — Subscription created, then immediately deleted → verify in-flight deliveries complete or abort cleanly.
- C[ ] L[ ] M[ ] A[ ] — Custom header name with reserved characters → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Hook registry cache TTL: edit a hook, fire an event within 60s → verify the new hook config applies (cache invalidation on CRUD).
- C[ ] L[ ] M[ ] A[ ] — Two subscriptions for the same event type → verify both fire.
- C[ ] L[ ] M[ ] A[ ] — `workflow.execution.failed` hook fires on engine crash repair (per item #8 in `improvement-priorities.md`) → verify sanitised payload.
- C[ ] L[ ] M[ ] A[ ] — Webhook payload schema evolution — add a field to `workflow.execution.completed` (e.g. a new metadata key) → verify strict-schema receivers don't reject the new field and that a documented `version` / content-type strategy supports rollouts without breaking existing integrations.
- C[ ] L[ ] M[ ] A[ ] — Receiver responds with 2xx but processed asynchronously (the platform doesn't know if the receiver actually succeeded) → verify the documented at-least-once vs at-most-once contract holds and the retry policy doesn't double-deliver after a successful 2xx.

---

# Tier 3 — Lifecycle, operations, admin surface

These run periodically rather than per-request. Lower frequency, lower urgency, but worth a deliberate pass.

---

## Phase 3.1 — Admin Dashboard CRUD Surfaces

**What this covers:** All the admin pages that aren't covered by their own dedicated phase — agents list, capabilities list, providers list, provider models matrix, knowledge document list, conversations list, costs pages. Most of these are List + Form patterns; the goal is to spot-check one of each is healthy.

**Reference docs:** `.context/admin/orchestration.md`, all `.context/admin/orchestration-*.md` files. For the canonical inventory of what each surface should expose, cross-check against `functional-specification.md` (this directory).

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Agents list page renders, filter / search work, bulk export works.
- C[ ] L[ ] M[ ] A[ ] — Capabilities list with category filter → verify counts and filter behaviour.
- C[ ] L[ ] M[ ] A[ ] — Providers card grid renders with status dots reflecting health.
- C[ ] L[ ] M[ ] A[ ] — Provider Models matrix view renders models × providers cleanly.
- C[ ] L[ ] M[ ] A[ ] — Knowledge document list shows lifecycle states with colour coding.
- C[ ] L[ ] M[ ] A[ ] — Conversations list paginates and supports tagging / export.
- C[ ] L[ ] M[ ] A[ ] — Costs Summary page shows monthly totals.
- C[ ] L[ ] M[ ] A[ ] — Costs Trends page shows time-series chart.
- C[ ] L[ ] M[ ] A[ ] — Costs Settings page lets you configure budgets.
- C[ ] L[ ] M[ ] A[ ] — Each form has `<FieldHelp>` ⓘ popovers on non-trivial fields (per the contextual-help directive).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Empty states render gracefully (no agents, no capabilities, no documents, no conversations).
- C[ ] L[ ] M[ ] A[ ] — Lists with 1000+ entries paginate / virtualise correctly.
- C[ ] L[ ] M[ ] A[ ] — Forms submitted with maximum-length values everywhere → verify validation, no UI overflow.
- C[ ] L[ ] M[ ] A[ ] — Concurrent edits on the same entity from two browser tabs → verify the documented behaviour (last-write-wins or warning).
- C[ ] L[ ] M[ ] A[ ] — Network drop mid-save → verify form preserves dirty state and a retry path is obvious.
- C[ ] L[ ] M[ ] A[ ] — Slow API response (5+ seconds) → verify loading states render, not blank pages.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — List page with a filter that yields zero results → verify the empty-state messaging.
- C[ ] L[ ] M[ ] A[ ] — CRUD operation that triggers a cascading change (e.g. deleting a provider used by 5 agents) → verify confirmation prompt and aftermath.
- C[ ] L[ ] M[ ] A[ ] — Page accessed by a consumer (non-admin) user via direct URL → verify auth gate redirects.

---

## Phase 3.2 — Workflow Builder UI

**What this covers:** The React Flow-based visual DAG editor — palette of step types, drag-and-drop canvas, save-time validation feedback, dry-run, definition history.

**Reference docs:** `.context/admin/workflow-builder.md`.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Drag each of the 15 step types from the palette onto the canvas → verify defaults render.
- C[ ] L[ ] M[ ] A[ ] — Connect two steps with an edge → verify port semantics.
- C[ ] L[ ] M[ ] A[ ] — Configure a step's params via the side panel → save → reload → verify persistence.
- C[ ] L[ ] M[ ] A[ ] — Save a valid workflow → verify success.
- C[ ] L[ ] M[ ] A[ ] — Save an invalid workflow (cycle, dangling reference) → verify inline validation errors.
- C[ ] L[ ] M[ ] A[ ] — Trigger dry-run from the builder → verify mock LLM calls, results visible inline.
- C[ ] L[ ] M[ ] A[ ] — Open definition history → revert to a prior version → verify revert.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Build a workflow with 50+ steps → verify canvas performance.
- C[ ] L[ ] M[ ] A[ ] — Build a workflow with overlapping nodes → verify layout / re-routing.
- C[ ] L[ ] M[ ] A[ ] — Save with an unsaved-changes prompt → navigate away → verify the prompt fires.
- C[ ] L[ ] M[ ] A[ ] — Concurrent edit from two tabs → verify behaviour.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Loading a historical workflow definition that uses a step type since renamed → verify backward compatibility or clear error.
- C[ ] L[ ] M[ ] A[ ] — Workflow with a `parallel` step where one branch has 0 children → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Template interpolation references a variable that doesn't exist in upstream output → verify save-time validation if possible.

---

## Phase 3.3 — Trace Viewer & Observability

**What this covers:** The execution detail page and observability dashboard — timeline strip, aggregates card, per-step input/output panels, per-call cost sub-table, six client-side filter chips, observability metrics.

**Reference docs:** `.context/admin/orchestration-observability.md`, `.context/orchestration/engine.md` (trace fields), `improvement-priorities.md` item #10.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Open an execution detail → verify the timeline strip renders one bar per step.
- C[ ] L[ ] M[ ] A[ ] — Click a timeline bar → verify it scrolls and ring-highlights the matching trace row.
- C[ ] L[ ] M[ ] A[ ] — Verify the aggregates card shows step time sum, p50/p95, slowest step, LLM share, per-step-type breakdown.
- C[ ] L[ ] M[ ] A[ ] — Expand a step row → verify input + output side-by-side and per-call cost sub-table.
- C[ ] L[ ] M[ ] A[ ] — Verify the provider · model chip and latency breakdown ("LLM xxx ms · other yyy ms") appear in the row header.
- C[ ] L[ ] M[ ] A[ ] — Apply each filter chip: All / Failed / Slow / LLM only / Tool only / With approvals → verify counts and disabled states.
- C[ ] L[ ] M[ ] A[ ] — Open the observability dashboard → verify active agent count, request volume, latency, error rates, cost trends, recent execution status.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Open a trace with 1000+ entries → verify rendering performance.
- C[ ] L[ ] M[ ] A[ ] — Open a trace where an `agent_call` step issued 20 LLM calls → verify the per-call cost sub-table groups them correctly by stepId.
- C[ ] L[ ] M[ ] A[ ] — Open a trace from a historical execution that predates the new optional fields → verify back-compat (no UI crash, just missing chips).
- C[ ] L[ ] M[ ] A[ ] — Trace with all `failed` steps → verify the Failed filter chip works and the layout doesn't break.
- C[ ] L[ ] M[ ] A[ ] — Try to access a trace for an execution belonging to another user → verify 404 short-circuits before any cost-log query.
- C[ ] L[ ] M[ ] A[ ] — Trace writer transiently down → verify chat and workflow execution continue with a logged warning, and the trace UI surfaces "missing trace, this happened" instead of silently rendering an empty page that looks like a healthy run.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Single-step trace → verify aggregates card and timeline strip are hidden (per the documented threshold).
- C[ ] L[ ] M[ ] A[ ] — Trace with parallel branches → verify the timeline strip's bar layout is honest about overlap (and note: step time sum will exceed wall-clock duration).
- C[ ] L[ ] M[ ] A[ ] — Step with `awaiting_approval` status → verify amber-striped bar in the timeline.
- C[ ] L[ ] M[ ] A[ ] — Slow-outlier highlighting only kicks in at ≥5 entries → verify thresholding.
- C[ ] L[ ] M[ ] A[ ] — Multi-turn step with model swap mid-execution → verify the rolled-up model/provider reflects the LAST turn (documented tradeoff).

---

## Phase 3.4 — Evaluations & Named-Metric Scoring

**What this covers:** Evaluation sessions, the chat handler's eval-log mirroring (per item #6 in `improvement-priorities.md`), the three named metrics (faithfulness, groundedness, relevance), the independent judge model, the re-score endpoint, the per-agent trend chart.

**Reference docs:** `.context/admin/orchestration-evaluations.md`, `.context/orchestration/evaluation-metrics.md`, `improvement-priorities.md` item #6.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Create an evaluation session → run a multi-turn chat in evaluation context → verify `AiEvaluationLog` rows are mirrored alongside `AiMessage` rows (`user_input`, `ai_response`, `capability_call`, `capability_result`).
- C[ ] L[ ] M[ ] A[ ] — Verify citations are snapshotted onto the `ai_response` log's `metadata.citations`.
- C[ ] L[ ] M[ ] A[ ] — Complete the session → verify the AI summary + improvement suggestions are produced.
- C[ ] L[ ] M[ ] A[ ] — Verify the three F/G/R scores per `ai_response` log appear with judge reasoning popovers.
- C[ ] L[ ] M[ ] A[ ] — Verify the Quality column on the evaluations list shows `F · G · R` per session.
- C[ ] L[ ] M[ ] A[ ] — Re-score a completed session → verify scores update in place and `metricSummary.totalScoringCostUsd` accumulates.
- C[ ] L[ ] M[ ] A[ ] — Open the per-agent evaluation-trend chart on the agent detail page → verify F/G/R averages over time render.
- C[ ] L[ ] M[ ] A[ ] — Annotate logs with human review notes.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to complete a session with 0 logs → verify the validation error per the original wiring gap (now superseded by the eval-log mirroring fix; verify mirroring actually fires).
- C[ ] L[ ] M[ ] A[ ] — Judge LLM unavailable → verify clean failure with a logged warning (not a chat-blocking error).
- C[ ] L[ ] M[ ] A[ ] — Re-score a session that's still in `running` state → verify rejection (only `completed` allowed).
- C[ ] L[ ] M[ ] A[ ] — Submit annotations of 100KB → verify length cap.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Faithfulness should be `null` for an `ai_response` log with no inline `[N]` markers → verify behaviour.
- C[ ] L[ ] M[ ] A[ ] — Per-agent trend chart with fewer than 2 completed sessions → verify it's hidden.
- C[ ] L[ ] M[ ] A[ ] — Judge LLM produces unparseable JSON → verify the retry policy (temp drops to 0, malformed prior excluded) and final tokens-summed cost accuracy.
- C[ ] L[ ] M[ ] A[ ] — Session with 50 ai_response logs → verify scoring runs cleanly and reasonable cost.
- C[ ] L[ ] M[ ] A[ ] — Session whose KB or prompt changes after scoring → verify re-score gives different numbers.
- C[ ] L[ ] M[ ] A[ ] — Determinism check: re-run scoring on a completed session with identical settings → verify F/G/R scores match within a documented tolerance (some judge LLMs are non-deterministic; the tolerance should be named, not assumed).
- C[ ] L[ ] M[ ] A[ ] — Re-score after a settings change (different judge model, different weights) → verify whether re-score uses historical settings (frozen) or current (drift), and that the contract is documented and consistent across re-scores.

---

## Phase 3.5 — Experiments / A/B Testing

**What this covers:** `AiExperiment` and `AiExperimentVariant`, the `draft → running → completed` lifecycle, traffic splitting, run/compare endpoints.

**Reference docs:** `functional-specification.md` §11.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Create an experiment with 2 variants (e.g. different temperatures).
- C[ ] L[ ] M[ ] A[ ] — Move from `draft` to `running` → verify lifecycle transition validates.
- C[ ] L[ ] M[ ] A[ ] — Run the experiment with traffic split → verify both variants receive traffic.
- C[ ] L[ ] M[ ] A[ ] — Compare results across variants → verify the comparison view renders.
- C[ ] L[ ] M[ ] A[ ] — Move to `completed` → verify subsequent traffic doesn't go to variants.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a traffic split that doesn't sum to 100% → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Add a variant referencing a deactivated model → verify rejection at run time.
- C[ ] L[ ] M[ ] A[ ] — Try to delete a `running` experiment → verify behaviour (block / cascade).
- C[ ] L[ ] M[ ] A[ ] — Run with 0 traffic → verify clean completion (no division-by-zero on metrics).

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Variant deleted while the experiment is running → verify behaviour.
- C[ ] L[ ] M[ ] A[ ] — Two experiments competing for the same agent's traffic → verify documented behaviour or rejection.
- C[ ] L[ ] M[ ] A[ ] — Experiment lifecycle transition raced from two admins simultaneously.
- C[ ] L[ ] M[ ] A[ ] — Sticky bucketing — same user issues two messages → verify they land in the same variant (or that re-rolling per request is the documented contract, not an accident).
- C[ ] L[ ] M[ ] A[ ] — Variant traffic weights changed mid-experiment → verify already-bucketed users either stay sticky or are re-rolled per documented behaviour; verify the change is captured in the audit log.
- C[ ] L[ ] M[ ] A[ ] — Variant references a model that has been deactivated mid-run → verify graceful failover or rejection, not silent variant-skew.

---

## Phase 3.6 — Audit Logging

**What this covers:** `AiAdminAuditLog` — immutable config change log, with entity type, action, before/after JSON diff, actor, timestamp, filterable by date/entity/action.

**Reference docs:** `.context/admin/orchestration-audit-log.md`, `functional-specification.md` §10.4.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Edit an agent → verify an audit row appears with from/to delta.
- C[ ] L[ ] M[ ] A[ ] — Edit a capability → verify audit row.
- C[ ] L[ ] M[ ] A[ ] — Edit a provider → verify audit row.
- C[ ] L[ ] M[ ] A[ ] — Edit `widgetConfig` → verify `agent.widget_config.update` audit row with per-field deltas.
- C[ ] L[ ] M[ ] A[ ] — Approve / reject an execution → verify audit row with the channel-pinned `actor` value (`admin` / `token:external` / `token:chat` / `token:embed`).
- C[ ] L[ ] M[ ] A[ ] — Filter the audit list by entity type → verify filter works.
- C[ ] L[ ] M[ ] A[ ] — Filter by date range → verify filter works.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to delete an audit row via direct API call → verify rejection (immutability is the contract).
- C[ ] L[ ] M[ ] A[ ] — Try to PATCH an audit row → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Try to forge an audit row by writing directly → verify only the audit machinery can write.
- C[ ] L[ ] M[ ] A[ ] — Edit triggering a 500KB JSON diff → verify storage handles it; no truncation that obscures the truth.
- C[ ] L[ ] M[ ] A[ ] — Rejected mutation (validation fail, auth fail, rate-limit fail) on a sensitive entity → verify whether an audit row is written; if not, document the security-forensics gap so it's an intentional decision rather than an oversight.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Audit row for a since-deleted entity → verify the audit row remains queryable and renders cleanly.
- C[ ] L[ ] M[ ] A[ ] — Audit row for an action with no diff (e.g. read-only operation) → verify representation.
- C[ ] L[ ] M[ ] A[ ] — Pagination on a 10,000-row audit log → verify performance.
- C[ ] L[ ] M[ ] A[ ] — Audit row written when actor is the system (not a user) → verify `actor` value is sensible.
- C[ ] L[ ] M[ ] A[ ] — Read of sensitive data (full export bundle, conversation export, cross-user trace via admin) → verify whether read-audit is in scope, and that the contract is consistent across surfaces (export is audited but trace-view isn't, etc.).
- C[ ] L[ ] M[ ] A[ ] — System-actor actions (cron tick fires a workflow, scheduler skips a fire because of overlap, hook auto-retry, embedding regeneration) → verify the `actor` value is queryable and distinguishable (`system:cron`, `system:scheduler`, `system:hook-retry` etc.).
- C[ ] L[ ] M[ ] A[ ] — Audit log diff stable across re-renders — verify deterministic JSON key ordering so a no-op re-save doesn't generate noise diffs.

---

## Phase 3.7 — Backup & Restore

**What this covers:** Full configuration export as JSON (agents, workflows, provider configs sans credentials, knowledge metadata sans content), import with conflict resolution, schema versioning, `ImportResult` per-entity success/failure.

**Reference docs:** `.context/orchestration/backup.md`, `functional-specification.md` §13.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Export the full configuration → verify the JSON contains all expected sections.
- C[ ] L[ ] M[ ] A[ ] — Import the same JSON to a fresh database → verify all entities restore.
- C[ ] L[ ] M[ ] A[ ] — Import to a database with conflicting slugs in `merge` mode → verify merge behaviour.
- C[ ] L[ ] M[ ] A[ ] — Import with `overwrite` mode → verify overwrite.
- C[ ] L[ ] M[ ] A[ ] — Verify exported JSON does NOT contain provider credentials.
- C[ ] L[ ] M[ ] A[ ] — Verify exported JSON does NOT contain knowledge document content (only metadata).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Import a JSON with a higher schema version than the current code supports → verify clean rejection with a version-mismatch message.
- C[ ] L[ ] M[ ] A[ ] — Import a JSON with a lower schema version → verify forward-compatibility behaviour.
- C[ ] L[ ] M[ ] A[ ] — Import malformed JSON → verify clean error.
- C[ ] L[ ] M[ ] A[ ] — Import a JSON missing required fields → verify per-entity failure in `ImportResult`, not a global crash.
- C[ ] L[ ] M[ ] A[ ] — Import a 50MB JSON → verify size handling.
- C[ ] L[ ] M[ ] A[ ] — Import a JSON referencing a provider that doesn't exist on the target → verify per-entity failure.
- C[ ] L[ ] M[ ] A[ ] — Partial-import atomicity — import a bundle where entity #50 of 100 fails Zod validation → verify whether the first 49 are committed, all-or-nothing rolled back, or staged for review; whichever the contract is, verify it is honoured and that `ImportResult` reflects the truth, not an aspirational summary.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Partial import success: some entities succeed, others fail → verify `ImportResult` reflects the truth.
- C[ ] L[ ] M[ ] A[ ] — Import a workflow that references a capability that imports later in the same bundle → verify ordering / two-pass handling.
- C[ ] L[ ] M[ ] A[ ] — Round-trip: export → import → re-export → diff the two exports → verify they match (modulo timestamps).
- C[ ] L[ ] M[ ] A[ ] — Per-agent export → import on another instance → verify the per-agent `widgetConfig` (per item #7) roundtrips.

---

## Phase 3.8 — Setup Wizard

**What this covers:** The 5-step guided initial configuration flow with resume behaviour.

**Reference docs:** `.context/admin/setup-wizard.md`.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Walk all 5 steps in order on a fresh instance → verify completion and the dashboard becomes accessible.
- C[ ] L[ ] M[ ] A[ ] — Abandon mid-wizard, return later → verify resume from the same step.
- C[ ] L[ ] M[ ] A[ ] — Verify each step's data persists between visits.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Skip a step via direct URL manipulation → verify rejection / redirect.
- C[ ] L[ ] M[ ] A[ ] — Submit invalid data at each step → verify validation messages.
- C[ ] L[ ] M[ ] A[ ] — Two admins start the wizard simultaneously → verify behaviour.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Wizard restarted after partial completion → verify state is consistent.
- C[ ] L[ ] M[ ] A[ ] — Wizard accessed when setup is already complete → verify redirect to dashboard.
- C[ ] L[ ] M[ ] A[ ] — Process restart mid-wizard → verify the resume state is durable across restart, or that the wizard honestly resets with a clear message rather than silently re-prompting for completed steps.
- C[ ] L[ ] M[ ] A[ ] — Fresh install on a hosting target with restricted egress (no internet for the LLM provider) → verify the connection-test step in the wizard surfaces the block clearly rather than hanging or producing a generic 500.

---

## Phase 3.9 — Self-Service API Keys

**What this covers:** `AiApiKey` with scoped permissions, generation/revocation, per-key rate limiting, key resolution at request time.

**Reference docs:** `.context/orchestration/api-keys.md`, `functional-specification.md` §16.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Generate an API key with no scope → verify it has access to documented defaults only.
- C[ ] L[ ] M[ ] A[ ] — Generate an API key scoped to a specific agent → verify it only authorises that agent's endpoints.
- C[ ] L[ ] M[ ] A[ ] — Generate an API key scoped to specific capabilities → verify only those capabilities are callable.
- C[ ] L[ ] M[ ] A[ ] — Revoke an API key → verify the next request is rejected.
- C[ ] L[ ] M[ ] A[ ] — List API keys (without showing the secret) → verify metadata is visible.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Reuse a revoked key → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Use a key with insufficient scope → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Submit a key in a query string instead of a header → verify rejection (or warn).
- C[ ] L[ ] M[ ] A[ ] — Brute-force key prefixes → verify rate-limit blocks rapid retries.
- C[ ] L[ ] M[ ] A[ ] — Use a key that's been rotated mid-request → verify the in-flight request behaviour.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Key resolution under high concurrency → verify cache hits behave consistently.
- C[ ] L[ ] M[ ] A[ ] — Scope updated while a key is in active use → verify the next request reflects the new scope.
- C[ ] L[ ] M[ ] A[ ] — Key with an empty scope set → verify behaviour (deny-all vs default).

---

## Phase 3.10 — Conversations Admin: Review, Tagging, Export

**What this covers:** The admin conversations surface — list view, per-conversation trace viewer (messages with capability calls / citations / costs inline), tagging, bulk operations, export. Admins use this to investigate user reports, build evaluation seeds from real conversations, and curate analytics.

**Reference docs:** `.context/admin/orchestration-conversations.md`, `functional-specification.md` §18 (Admin Dashboard table).

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Conversations list page renders with pagination, agent filter, date filter, tag filter.
- C[ ] L[ ] M[ ] A[ ] — Open a single conversation → verify the trace viewer shows each message with its capability calls, citation envelope, per-turn cost, and tool results.
- C[ ] L[ ] M[ ] A[ ] — Tag a conversation with a custom label → verify it persists and appears in the list filter.
- C[ ] L[ ] M[ ] A[ ] — Bulk-tag multiple conversations from the list page.
- C[ ] L[ ] M[ ] A[ ] — Search conversations by content (full-text and / or vector) → verify result ordering.
- C[ ] L[ ] M[ ] A[ ] — Export selected conversations as JSON → verify the bundle is well-formed and includes message metadata.
- C[ ] L[ ] M[ ] A[ ] — Export as CSV → verify formatting (one row per message or per conversation per the contract).
- C[ ] L[ ] M[ ] A[ ] — Delete a conversation from the admin surface → verify cascading cleanup of `AiMessage`, `AiMessageEmbedding`, eval logs.
- C[ ] L[ ] M[ ] A[ ] — Promote a conversation to an evaluation seed → verify a new evaluation session can use it as input.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to delete every conversation in a single bulk action → verify confirmation prompt and chunked deletion (no DB lock-up).
- C[ ] L[ ] M[ ] A[ ] — Submit a tag with 1000+ characters → verify length cap.
- C[ ] L[ ] M[ ] A[ ] — Submit an export request with a malformed filter → verify clean rejection.
- C[ ] L[ ] M[ ] A[ ] — Search query of 10K characters → verify rejection or truncation.
- C[ ] L[ ] M[ ] A[ ] — Try to access a conversation from a different deployment's exported ID → verify 404.
- C[ ] L[ ] M[ ] A[ ] — Bulk export 10K conversations in one request → verify streaming / chunked delivery, not a 30-minute synchronous response.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Conversation owned by a deleted user → verify it remains visible to admins (or is hard-deleted per the policy) and renders without crashing.
- C[ ] L[ ] M[ ] A[ ] — Conversation with 1000+ messages → verify trace viewer paginates and renders within reasonable time.
- C[ ] L[ ] M[ ] A[ ] — Conversation that crossed a model deactivation mid-stream → verify the trace honestly shows the historical model on each turn, not the current default.
- C[ ] L[ ] M[ ] A[ ] — Conversation in evaluation context → verify the eval log mirror appears in the trace alongside `AiMessage`.
- C[ ] L[ ] M[ ] A[ ] — Conversation with a pending approval card frozen mid-state → verify the trace shows the pause state clearly.
- C[ ] L[ ] M[ ] A[ ] — Conversation where the agent has since been deleted → verify graceful "agent removed" rendering rather than 404.

---

# Tier 4 — Niche, future-facing, cross-cutting

Lower frequency but worth a deliberate pass. Many of these are areas the platform deliberately under-invests in (per `improvement-priorities.md` Tier 3/4) — verify the cores work even if the surface is thin.

---

## Phase 4.1 — Document Ingestion: Format-Specific Edges

**What this covers:** Format-specific corners that don't fit cleanly into Phase 1.6's lifecycle test — the PDF preview/confirm flow's robustness fixes, the per-page scanned-PDF diagnostic, opt-in PDF table extraction, the CSV BOM/CRLF/CR handling.

**Reference docs:** `.context/orchestration/document-ingestion.md`, `improvement-priorities.md` item #5.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — PDF preview shows per-page char counts (forward path for a future page-picker UI).
- C[ ] L[ ] M[ ] A[ ] — PDF "extract tables" toggle → verify tables are rendered as `<!-- table-start -->` ... `<!-- table-end -->` fenced markdown pipe tables.
- C[ ] L[ ] M[ ] A[ ] — EPUB upload → verify chapter boundaries become chunks.
- C[ ] L[ ] M[ ] A[ ] — DOCX upload with headings, lists, tables → verify reasonable chunking.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — PDF with a `\|` cell character in a table → verify escaping in the pipe-table renderer.
- C[ ] L[ ] M[ ] A[ ] — PDF with embedded JavaScript → verify it's ignored, not executed.
- C[ ] L[ ] M[ ] A[ ] — Excel-saved CSV with U+FEFF BOM → verify normalisation.
- C[ ] L[ ] M[ ] A[ ] — CSV with mixed line endings within the same file → verify recovery.
- C[ ] L[ ] M[ ] A[ ] — DOCX with embedded macros → verify they're ignored.
- C[ ] L[ ] M[ ] A[ ] — EPUB with broken manifest → verify clean failure.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Re-chunk a CSV document that's missing `metadata.csvSections` → verify the clear-error fallback fires (not a silent shred to one chunk).
- C[ ] L[ ] M[ ] A[ ] — PDF where `pages[]` is missing from the parser output → verify fallback to form-feed split.
- C[ ] L[ ] M[ ] A[ ] — PDF table extraction false-positive (a layout that looks tabular but isn't) → verify acceptable degradation.
- C[ ] L[ ] M[ ] A[ ] — Re-uploading a PDF with `extractTables` ticked vs unticked on subsequent attempts → verify the dedup-in-place behaviour holds.

---

## Phase 4.2 — User Memory

**What this covers:** Per-user persistent memory (`AiUserMemory`) accessed via the `read_user_memory` and `write_user_memory` capabilities. Memory is included in chat context.

**Reference docs:** `functional-specification.md` §4.4 (built-in capabilities), `.context/orchestration/chat.md` (Context Building section).

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Have an agent write a fact via `write_user_memory` → verify it's stored under the calling user.
- C[ ] L[ ] M[ ] A[ ] — Have an agent read it back via `read_user_memory` → verify retrieval.
- C[ ] L[ ] M[ ] A[ ] — Verify the memory is included in the next chat turn's system context (the LLM can act on it without explicit retrieval).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Try to write a 100KB memory entry → verify size cap.
- C[ ] L[ ] M[ ] A[ ] — Try to read another user's memory by passing their userId → verify rejection (per-user scoping is the contract).
- C[ ] L[ ] M[ ] A[ ] — Inject a prompt-injection payload into a memory write → verify it's stored verbatim and the input guard catches it on the next read.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Memory key collisions / case sensitivity → verify documented behaviour.
- C[ ] L[ ] M[ ] A[ ] — Memory key with reserved characters → verify validation.
- C[ ] L[ ] M[ ] A[ ] — User memory persists across sessions / new conversations → verify retention.
- C[ ] L[ ] M[ ] A[ ] — Memory accessed when the user has been deleted → verify cascade behaviour.

---

## Phase 4.3 — Outbound HTTP & Recipes Cookbook

**What this covers:** The shared `lib/orchestration/http/` module that backs both the `call_external_api` capability and the `external_call` workflow step — host allowlist, SSRF guard, response caps, idempotency-key support, HMAC signing, Basic auth, plus the 5 worked recipes (transactional email, payment charge, chat notification, calendar event, document render).

**Reference docs:** `.context/orchestration/external-calls.md`, `.context/orchestration/recipes/`, `improvement-priorities.md` item #3.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Walk each of the 5 recipes end-to-end against a real or mock target: transactional email, payment charge, chat notification, calendar event, document render.
- C[ ] L[ ] M[ ] A[ ] — Verify per-agent `customConfig` carries auth credentials (env-var resolved, NOT in the LLM's view).
- C[ ] L[ ] M[ ] A[ ] — Verify per-agent `customConfig` URL prefix restrictions are enforced.
- C[ ] L[ ] M[ ] A[ ] — Use each auth mode: `none`, `bearer`, `api-key`, `query-param`, `basic`, HMAC signing.
- C[ ] L[ ] M[ ] A[ ] — Send a request with an Idempotency-Key header → verify it appears on the wire.
- C[ ] L[ ] M[ ] A[ ] — Receive a binary response (PDF) → verify it's wrapped as `{ encoding: 'base64', contentType, data }`.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a URL outside the allowlist → verify rejection.
- C[ ] L[ ] M[ ] A[ ] — Submit a URL outside the per-agent prefix → verify rejection (LLM cannot escape admin-defined prefix).
- C[ ] L[ ] M[ ] A[ ] — Submit a URL pointing to localhost / 169.254.169.254 / link-local → verify SSRF protection.
- C[ ] L[ ] M[ ] A[ ] — Receive a 100MB response → verify the response size cap kicks in.
- C[ ] L[ ] M[ ] A[ ] — Endpoint that hangs forever → verify timeout.
- C[ ] L[ ] M[ ] A[ ] — Endpoint returns a 30x redirect to a non-allowlisted host → verify the redirect doesn't bypass the allowlist.
- C[ ] L[ ] M[ ] A[ ] — LLM tries to construct a URL with credential interpolation tricks → verify rejection.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Response with a malformed `Content-Type` → verify reasonable handling.
- C[ ] L[ ] M[ ] A[ ] — HMAC signing with a key that's been rotated → verify the new key is picked up on next call.
- C[ ] L[ ] M[ ] A[ ] — Idempotency-Key reused for a second call → verify behaviour matches the receiver's contract (no client-side enforcement).
- C[ ] L[ ] M[ ] A[ ] — Multipart/form-data construction (documented gap per item #17) → verify the recipe's documented workaround works.
- C[ ] L[ ] M[ ] A[ ] — `${env:VAR}` substitution in `customConfig` (documented gap per item #18) → verify whether write-time or read-time resolution applies if implemented.

---

## Phase 4.4 — Analytics: Topics, Unanswered, Coverage Gaps

**What this covers:** Client analytics — popular topics frequency analysis, unanswered questions detection, engagement metrics, coverage gap identification.

**Reference docs:** `.context/orchestration/analytics.md`, `.context/admin/orchestration-analytics.md`, `functional-specification.md` §10.1.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Open the popular topics view → verify topic frequency analysis ranks recent conversations.
- C[ ] L[ ] M[ ] A[ ] — Open the unanswered questions view → verify messages flagged by the agent as unable-to-answer surface.
- C[ ] L[ ] M[ ] A[ ] — Open the engagement metrics view → verify conversation length, return rate, satisfaction signals render.
- C[ ] L[ ] M[ ] A[ ] — Open the coverage gaps view → verify topics where the KB lacks relevant content are surfaced.
- C[ ] L[ ] M[ ] A[ ] — Filter analytics by agent / by date range.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Generate a single conversation with 1000 messages → verify topic clustering doesn't crash.
- C[ ] L[ ] M[ ] A[ ] — Submit a conversation with non-English / mixed-script content → verify topic analysis handles it (or degrades gracefully).
- C[ ] L[ ] M[ ] A[ ] — Date range covering 0 conversations → verify clean empty states.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Coverage gaps for an agent with `knowledgeCategories: []` → verify expected behaviour.
- C[ ] L[ ] M[ ] A[ ] — Topics analysis on a fresh instance with no historical data.
- C[ ] L[ ] M[ ] A[ ] — Engagement metrics where one user dominates traffic → verify the reporting isn't skewed in misleading ways.

---

## Phase 4.5 — Provider Audit Workflow

**What this covers:** The seeded `provider-model-audit` workflow plus the three audit capabilities (`apply_audit_changes`, `add_provider_models`, `deactivate_provider_models`) — the worked example of an autonomous workflow that proposes config changes via human approval.

**Reference docs:** `.context/admin/orchestration-provider-audit-guide.md`, `.context/admin/orchestration-provider-models.md`.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Run the built-in `provider-model-audit` workflow → verify it reaches the `human_approval` step with a summary of proposed changes.
- C[ ] L[ ] M[ ] A[ ] — Approve via the admin queue → verify the audit-changes capabilities apply the changes to `AiProviderModel`.
- C[ ] L[ ] M[ ] A[ ] — Reject → verify no changes are applied.
- C[ ] L[ ] M[ ] A[ ] — Verify the audit log captures every change with from/to deltas.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Tamper test from the audit guide: modify the proposed-changes JSON between proposal and approval → verify the integrity check rejects the tampered payload.
- C[ ] L[ ] M[ ] A[ ] — Audit workflow proposes deactivating a model that's currently in active use by an agent → verify the warning surfaces.
- C[ ] L[ ] M[ ] A[ ] — Audit proposes adding a model that already exists with conflicting fields → verify conflict resolution.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Audit workflow run when no changes are needed → verify clean no-op approval.
- C[ ] L[ ] M[ ] A[ ] — Audit run while the provider it's auditing is unhealthy → verify graceful degradation.

---

## Phase 4.6 — Versioning, Cloning, Bulk Operations

**What this covers:** The cross-cutting lifecycle features — agent version history with diffs, agent cloning, bulk export and comparison.

**Reference docs:** `functional-specification.md` §1.2.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Edit an agent's `systemInstructions` 5 times → verify 5 `AiAgentVersion` rows.
- C[ ] L[ ] M[ ] A[ ] — Open the version history → verify the diff between any two versions is readable.
- C[ ] L[ ] M[ ] A[ ] — Clone an agent → verify all configuration including capabilities, knowledge scope, fallback chain, widgetConfig.
- C[ ] L[ ] M[ ] A[ ] — Bulk-export 5 agents → verify the bundle.
- C[ ] L[ ] M[ ] A[ ] — Compare two agents side-by-side → verify the comparison view.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Spam-edit instructions to create 1000 versions → verify pagination and storage health.
- C[ ] L[ ] M[ ] A[ ] — Compare an agent to itself → verify clean handling.
- C[ ] L[ ] M[ ] A[ ] — Bulk-export with one agent referencing a deleted provider → verify the bundle still completes with a flag on the affected entity.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Revert to a version where a referenced capability has since been deleted → verify clean error.
- C[ ] L[ ] M[ ] A[ ] — Diff between two versions where one had `widgetConfig` and the other didn't → verify representation.
- C[ ] L[ ] M[ ] A[ ] — Clone an agent whose `widgetConfig` is null → verify the clone has null too.

---

## Phase 4.7 — Settings Singleton & Global Tunables

**What this covers:** `AiOrchestrationSettings` singleton — global guard modes, search weights, judge model, embed allowed origins, default selection profiles, etc.

**Reference docs:** `functional-specification.md` (cross-references throughout), `.context/orchestration/embed.md` (`embedAllowedOrigins`).

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Open the global settings page → verify all tunables render with `<FieldHelp>` popovers.
- C[ ] L[ ] M[ ] A[ ] — Change `vectorWeight` and `bm25Weight` → verify hybrid search rankings shift.
- C[ ] L[ ] M[ ] A[ ] — Change global input/output/citation guard mode → verify the per-agent override precedence still wins.
- C[ ] L[ ] M[ ] A[ ] — Set `embedAllowedOrigins` → verify the embed approval routes honour the allowlist.
- C[ ] L[ ] M[ ] A[ ] — Configure `EVALUATION_JUDGE_PROVIDER` / `EVALUATION_JUDGE_MODEL` env vars → verify scoring uses the independent judge.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit `embedAllowedOrigins` containing an http (non-https) URL or a bare hostname → verify the read-time filter strips invalid entries (corrupt setting can't crash approval routes).
- C[ ] L[ ] M[ ] A[ ] — Submit a `vectorWeight` of -1 or 100 → verify validation.
- C[ ] L[ ] M[ ] A[ ] — Submit a malformed JSON for any settings field → verify Zod rejection.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Settings singleton row missing on a fresh instance → verify lazy creation with defaults.
- C[ ] L[ ] M[ ] A[ ] — Two admins edit settings simultaneously → verify last-write-wins or optimistic-locking.
- C[ ] L[ ] M[ ] A[ ] — Settings change applied while a chat is in flight → verify the in-flight call uses the old setting and the next call uses the new.
- C[ ] L[ ] M[ ] A[ ] — Settings change that affects a downstream cached derivative (search weights, breaker thresholds, judge model, embed-allowed-origins) → verify the corresponding in-memory caches are invalidated so the next call uses the new value, not a stale derived value pinned to the old setting.

---

## Phase 4.8 — Learning UI

**What this covers:** The pattern explorer (21 patterns), the advisor chatbot for pattern recommendations, the quizzes for team education.

**Reference docs:** `.context/admin/orchestration-learn.md`, `.context/orchestration/patterns-and-steps.md`.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Open the pattern explorer → verify all 21 patterns are listed and detail pages render.
- C[ ] L[ ] M[ ] A[ ] — Use the `get_pattern_detail` capability via the advisor chatbot → verify pattern info comes back.
- C[ ] L[ ] M[ ] A[ ] — Take the quiz → verify questions render and scoring works.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Submit a free-text query to the advisor chatbot that's offensive or off-topic → verify behaviour matches the advisor's configured guard mode.
- C[ ] L[ ] M[ ] A[ ] — Quiz with no answers selected → verify validation.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Pattern detail page for a pattern with no inbound step references → verify clean rendering.
- C[ ] L[ ] M[ ] A[ ] — Advisor chatbot when the underlying agent is offline / mis-configured → verify clean error.

---

## Phase 4.9 — Workflow Template Catalogue

**What this covers:** The 11 built-in workflow templates seeded at first-run plus the separately seeded `provider-model-audit` working installed workflow. Each template needs a smoke pass: ingests cleanly at seed, renders in the visual builder, validates, and dry-runs successfully.

**Reference docs:** `.context/orchestration/workflows.md`, `improvement-priorities.md` item #4 (template catalogue scoping).

### Use scenarios — one per template

- C[ ] L[ ] M[ ] A[ ] — `customer-support` — seed → render in builder → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `content-pipeline` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `saas-backend` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `research-agent` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `conversational-learning` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `data-pipeline` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `outreach-safety` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `code-review` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `autonomous-research` — seed → render → dry-run.
- C[ ] L[ ] M[ ] A[ ] — `tpl-cited-knowledge-advisor` — verify mandatory inline `[N]` citation behaviour and fail-closed citation guard interaction.
- C[ ] L[ ] M[ ] A[ ] — `tpl-scheduled-source-monitor` — verify `external_call` → diff → notify shape and behaviour against a real or mocked source.
- C[ ] L[ ] M[ ] A[ ] — `provider-model-audit` (separately seeded as a working installed workflow via `010-model-auditor.ts`) — full run end-to-end (cross-ref Phase 4.5).
- C[ ] L[ ] M[ ] A[ ] — All templates pass the `validateWorkflow()` + `runExtraChecks()` suite (currently 112 assertions across 11 × 10–12 invariants per `improvement-priorities.md` #4).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Modify a template's seed file, re-seed → verify `hashInputs` change is detected and the template is updated rather than silently skipped.
- C[ ] L[ ] M[ ] A[ ] — Delete a template's installed copy from the DB → verify re-seed restores it cleanly.
- C[ ] L[ ] M[ ] A[ ] — Clone a template into a new workflow, edit aggressively, re-seed the catalogue → verify the user's clone is NOT overwritten.
- C[ ] L[ ] M[ ] A[ ] — Template references a capability not in the unit-test allowlist → verify validation rejects.
- C[ ] L[ ] M[ ] A[ ] — Two parallel re-seed runs → verify idempotency / locking.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Template seed runs on a fresh DB with no providers configured → verify graceful skip or clear error per the seed contract.
- C[ ] L[ ] M[ ] A[ ] — Template that uses `external_call` runs in an environment where the host allowlist is empty → verify dry-run still passes (no real call) but real-run is blocked.
- C[ ] L[ ] M[ ] A[ ] — Template list growth: confirm 11 templates is the catalogue today and the picker is not cluttered (per the documented "no further growth" decision in `improvement-priorities.md` #4).

---

## Phase 4.10 — CORS, Security Headers & Operational Observability

**What this covers:** Cross-cutting security baseline that doesn't belong to any one feature — CORS on each public surface, security headers (CSP, HSTS, X-Frame-Options), client-IP resolution under proxies, log redaction of credentials, the `/maintenance/tick` health surface, and the logging audit on the observability dashboard.

**Reference docs:** `.context/security/`, `.context/logging/`, `.context/api/`, `.context/orchestration/scheduling.md` (maintenance tick), `hosting-requirements.md`.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Inspect CSP headers on admin pages → verify no `unsafe-inline` / `unsafe-eval` (or that exceptions are documented).
- C[ ] L[ ] M[ ] A[ ] — Inspect CORS headers on consumer chat API → verify allowed origins and preflight (`OPTIONS`) handling.
- C[ ] L[ ] M[ ] A[ ] — Inspect CORS headers on embed routes → verify per-origin allowlist drives the response (not `*`).
- C[ ] L[ ] M[ ] A[ ] — Inspect CORS headers on MCP routes.
- C[ ] L[ ] M[ ] A[ ] — Inspect HSTS header in production mode (`max-age` ≥ 6 months).
- C[ ] L[ ] M[ ] A[ ] — Inspect `X-Frame-Options` / `frame-ancestors` on admin pages → verify clickjacking prevention.
- C[ ] L[ ] M[ ] A[ ] — Verify `Strict-Transport-Security`, `Referrer-Policy`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` are present on all surfaces that need them.
- C[ ] L[ ] M[ ] A[ ] — Health endpoint (e.g. `/api/v1/health` or equivalent) returns OK when DB + provider + auth are healthy.
- C[ ] L[ ] M[ ] A[ ] — Logging audit panel on the observability dashboard surfaces recent error and warn rows.
- C[ ] L[ ] M[ ] A[ ] — `/maintenance/tick` endpoint authenticates correctly per `improvement-priorities.md` #8 (token ownership + liveness watchdog).

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — CORS preflight from a malicious origin → verify rejection (not silently echoed back).
- C[ ] L[ ] M[ ] A[ ] — Try to load an admin page inside an `<iframe>` → verify `X-Frame-Options: DENY` (or equivalent CSP) blocks it.
- C[ ] L[ ] M[ ] A[ ] — Trigger a deliberate CSP violation → verify it's logged via `report-uri` / `report-to` if configured.
- C[ ] L[ ] M[ ] A[ ] — Spoof `X-Forwarded-For` to bypass per-IP rate limits → verify the trusted-proxy list is enforced and arbitrary headers don't move the source IP.
- C[ ] L[ ] M[ ] A[ ] — Submit a payload containing API keys, passwords, or HMAC secrets to a logged endpoint → verify the structured logger redacts them (per the CLAUDE.md `logger` not `console` rule).
- C[ ] L[ ] M[ ] A[ ] — Submit a payload with newlines / control characters → verify they don't break log line framing (log injection).
- C[ ] L[ ] M[ ] A[ ] — Health endpoint when DB is down → verify it returns a non-2xx with a clean reason, not a hung connection.
- C[ ] L[ ] M[ ] A[ ] — Spam `/maintenance/tick` with rapid requests → verify the liveness watchdog or token check throttles it.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — CORS request with no `Origin` header (server-to-server) → verify defensive default behaviour.
- C[ ] L[ ] M[ ] A[ ] — Embed widget loaded over `http://` (development) → verify HSTS doesn't break local dev.
- C[ ] L[ ] M[ ] A[ ] — Different deployment targets (per `hosting-requirements.md`) — verify headers behave consistently across Vercel / Docker / bare metal.
- C[ ] L[ ] M[ ] A[ ] — CSP `nonce`-based inline scripts work under Next.js 16 streaming.
- C[ ] L[ ] M[ ] A[ ] — Reverse-proxy strips a header the application expects → verify failure mode is loud, not silent.
- C[ ] L[ ] M[ ] A[ ] — Log rotation / size limits behave correctly under sustained traffic.

---

## Phase 4.11 — User Lifecycle & Data Sovereignty

**What this covers:** End-to-end behaviour when users are created, modified, and deleted, plus the user-data-export and session-revocation surfaces that GDPR-style policies require. These cut across every entity that has user scoping — conversations, memory, eval sessions, API keys, invite tokens, approval delegations, audit attribution.

**Reference docs:** `.context/auth/`, `.context/orchestration/agent-visibility.md` (per-user scoping), `functional-specification.md` §17.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Create a new user → verify the default-deny baseline (no agents visible until granted) and that no orphan rows pre-exist.
- C[ ] L[ ] M[ ] A[ ] — Update a user's email or display name → verify the next admin view reflects the change and that no audit row is rewritten retroactively.
- C[ ] L[ ] M[ ] A[ ] — Issue a "data export" for a user (GDPR-style) → verify the bundle includes their conversations, memory, evaluation logs, API key metadata, invite-token usage history, and cost logs attributed to them — and excludes any data not theirs.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Hard delete a user with active conversations → verify cascade behaviour for `AiConversation`, `AiMessage`, `AiUserMemory`, `AiApiKey`, invite tokens, approval delegations referencing the user.
- C[ ] L[ ] M[ ] A[ ] — Soft delete vs hard delete: confirm which path the system supports and that audit rows survive either way with an identity tombstone (no orphaned `actor` references).
- C[ ] L[ ] M[ ] A[ ] — Logout while an SSE stream is mid-flight in another tab → verify the stream is terminated cleanly and a follow-up request is rejected with a session-expired error, not allowed under a since-revoked session.
- C[ ] L[ ] M[ ] A[ ] — Force-revoke all sessions for a user (admin "kill switch") → verify all active streams across all tabs and devices terminate within the documented window.
- C[ ] L[ ] M[ ] A[ ] — User deleted while a workflow they own is mid-execution → verify the execution either runs to completion under a system actor or is cancelled cleanly per the documented contract.
- C[ ] L[ ] M[ ] A[ ] — User deleted while an approval is delegated to them via `approverUserIds` → verify the delegation list is filtered, not blocking; remaining approvers can still resolve the execution.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Audit row references a since-deleted user → verify the row remains queryable and renders a tombstone identity ("deleted user #1234") rather than blank or 500.
- C[ ] L[ ] M[ ] A[ ] — Per-user rate-limit counters survive across a name/email change (keyed by user ID, not name).
- C[ ] L[ ] M[ ] A[ ] — Per-user memory accessed via `read_user_memory` after the owner has been deleted → verify graceful handling (capability errors clearly, doesn't expose the now-orphaned content to another caller).
- C[ ] L[ ] M[ ] A[ ] — Conversation owned by a since-deleted user but referenced by an evaluation seed → verify the eval still renders honestly with a tombstone owner rather than crashing the evaluation surface.
- C[ ] L[ ] M[ ] A[ ] — Cost log attribution after a user delete → verify per-agent and global totals still reflect the historical spend; the user-attribution column either tombstones or nullifies per documented contract.

---

## Phase 4.12 — First-Run & Empty-State Surfaces

**What this covers:** The brand-new install: no providers, no agents, no API keys, no knowledge documents, no conversations. This is the first impression every consumer of the starter template gets exactly once. It's also the surface most likely to silently break on a refactor because it's rarely revisited after initial development.

**Reference docs:** `.context/admin/setup-wizard.md`, `.context/admin/orchestration.md` (the Quick Start walkthrough), `hosting-requirements.md`, and `functional-specification.md` for the post-onboarding capability surface.

### Use scenarios

- C[ ] L[ ] M[ ] A[ ] — Boot a fresh database (`db:reset`) and load the admin landing page → verify it renders without 500s, even though every list is empty.
- C[ ] L[ ] M[ ] A[ ] — Walk every admin nav item on a fresh install — agents, capabilities, providers, knowledge, conversations, costs, audit, observability, evaluations, experiments, workflows, schedules, learn, approvals → verify each renders an honest empty state rather than crashing.
- C[ ] L[ ] M[ ] A[ ] — Setup wizard: walk all 5 steps end-to-end (cross-ref Phase 3.8) → verify the dashboard becomes accessible after completion.
- C[ ] L[ ] M[ ] A[ ] — First chat ever on a brand-new instance — verify cold-start dependencies (rate-limit stores, hook registry cache, breaker state) initialise without race or first-call latency spike.
- C[ ] L[ ] M[ ] A[ ] — First webhook delivery on a brand-new instance — verify the in-memory delivery queue and retry state initialise correctly without an N+1 burst on first event.

### Abuse / robustness scenarios

- C[ ] L[ ] M[ ] A[ ] — Visit an admin page that requires data (e.g. `/admin/orchestration/conversations/[id]`) on a fresh install via a guessed URL → verify a clean 404, not a 500 from a missing-row dereference.
- C[ ] L[ ] M[ ] A[ ] — Setup wizard interrupted by a process restart → verify resume state is durable and the wizard doesn't re-prompt for steps already completed.
- C[ ] L[ ] M[ ] A[ ] — Setup wizard run by two admins simultaneously on a fresh install → verify the documented behaviour (sequential lock, last-write-wins, or warning) — not silent corruption.
- C[ ] L[ ] M[ ] A[ ] — Skip the setup wizard via direct URL → verify the dashboard either redirects back to the wizard or renders with a "setup required" banner; never a silently broken state that hides the gap.
- C[ ] L[ ] M[ ] A[ ] — Fresh install with no providers configured but an admin tries to create an agent → verify the agent form blocks save with a clear "no providers configured — add one first" message and a deep link.

### Edge cases

- C[ ] L[ ] M[ ] A[ ] — Re-run setup wizard after completion via direct URL → verify the documented behaviour (read-only summary, redirect, or re-entry); not an idempotent re-creation of seed data.
- C[ ] L[ ] M[ ] A[ ] — Migration from an even-fresher state: schema migrated but no seed data run → verify the gap is detected and the seed script is recommended in the UI rather than presented as healthy-but-empty.
- C[ ] L[ ] M[ ] A[ ] — First-run workflow template seed (`010-model-auditor.ts` and the 11 templates) on a database that already has admin-created workflows with overlapping slugs → verify the seed honours the documented merge-vs-skip contract.
- C[ ] L[ ] M[ ] A[ ] — First-run on a hosting target with restricted egress (no internet for the LLM provider) → verify the wizard's connection-test surfaces the block clearly and the install can complete to the point of "providers not yet reachable" without brick-walling the admin out.

---

# Appendix A — Cross-Cutting Concerns Walkthrough

These are concerns that don't belong to any single feature but cut across all of them. Walk this appendix **after** all Tier 1–4 phases are clean — failures here often surface as inconsistencies between phases (e.g. one phase handles concurrency correctly, another doesn't).

### Frontend lifecycle

- C[ ] L[ ] M[ ] A[ ] — Browser back / forward mid-stream → verify the SSE is cancelled, not leaked as a zombie. (Cross-ref Phase 1.1.)
- C[ ] L[ ] M[ ] A[ ] — Hard reload mid-stream in admin chat → verify history fetch reconciles with the partial assistant message that was being streamed (cross-ref Phase 2.3 for embed).
- C[ ] L[ ] M[ ] A[ ] — Service worker caches the embed widget loader; partner site deploys a new version of Sunrise → verify the SW eviction strategy (versioned URL, cache-busting query, stale-while-revalidate) is honoured.
- C[ ] L[ ] M[ ] A[ ] — Browser tab suspended by OS power management mid-stream → on resume, verify the client either reconnects or shows an honest "disconnected" state.
- C[ ] L[ ] M[ ] A[ ] — Two browser tabs sharing one conversation send messages within the same second → verify backend ordering and front-end optimistic-UI reconciliation.
- C[ ] L[ ] M[ ] A[ ] — Embed widget loaded into a partner site with a strict CSP (`default-src 'self'`) — verify the loader, the widget, and the SSE stream all work via the documented domain allowlist (cross-ref Phase 2.3).
- C[ ] L[ ] M[ ] A[ ] — Partner-site service worker intercepts the widget's outbound requests → verify the documented bypass header / strategy is honoured (cross-ref Phase 2.3).

### Telemetry, audit, and cost-log failure cascade

The pattern: when the telemetry of a feature fails, does the feature itself still work, and is the failure visible?

- C[ ] L[ ] M[ ] A[ ] — Trace writer transiently down → chat / workflow continue and the trace surface reports "missing" rather than silently empty (cross-ref Phase 3.3).
- C[ ] L[ ] M[ ] A[ ] — Audit log writer transiently down on a mutating admin action → verify whether the action fails closed (denies) or fails open (allows with logged warning); whichever it is, verify it's documented (cross-ref Phase 3.6).
- C[ ] L[ ] M[ ] A[ ] — Cost log writer transiently down on a budget-bound chat call → verify the call doesn't silently over-spend (cross-ref Phase 1.4).
- C[ ] L[ ] M[ ] A[ ] — Hook dispatcher transiently down → verify the source event is either buffered for replay or fails loudly; never silently dropped (cross-ref Phase 2.8).
- C[ ] L[ ] M[ ] A[ ] — Knowledge re-index in progress → verify search returns documented behaviour (stale, partial, or empty with a flag), never an undocumented mix of old and new chunks (cross-ref Phase 1.7).
- C[ ] L[ ] M[ ] A[ ] — Embedding provider down during ingestion → verify documents land in `failed` with a clear reason, not silently `ready` (cross-ref Phase 1.6).
- C[ ] L[ ] M[ ] A[ ] — Logging subsystem itself failing — e.g. log aggregator unreachable → verify the local fallback (stdout / file) keeps working and the application doesn't block on log writes.

### State evolution under in-flight operations

The pattern: configuration / state mutates while a request is mid-flight. Verify the in-flight operation uses a snapshot, not the new value, and that the next operation picks up the change.

- C[ ] L[ ] M[ ] A[ ] — Agent visibility flipped from `public` to `internal` mid-conversation (cross-ref Phase 1.2).
- C[ ] L[ ] M[ ] A[ ] — Provider key rotated mid-stream (cross-ref Phase 1.3).
- C[ ] L[ ] M[ ] A[ ] — Capability `customConfig` updated mid-workflow execution (cross-ref Phase 1.5 / 2.1).
- C[ ] L[ ] M[ ] A[ ] — Agent `knowledgeCategories` modified between turns (cross-ref Phase 1.7).
- C[ ] L[ ] M[ ] A[ ] — Settings singleton change mid-chat (cross-ref Phase 4.7).
- C[ ] L[ ] M[ ] A[ ] — Embedding model swap to a different vector dimension while old chunks exist (cross-ref Phase 1.6 / 1.3).
- C[ ] L[ ] M[ ] A[ ] — Workflow definition version bumped while a previous-version execution is in flight (cross-ref Phase 2.1).
- C[ ] L[ ] M[ ] A[ ] — Step type schema migration applied while saved workflows reference the old shape (cross-ref Phase 2.1).
- C[ ] L[ ] M[ ] A[ ] — Capability deactivated while an MCP / chat / workflow caller has it cached in `tools/list` (cross-ref Phase 1.5 / 2.5).
- C[ ] L[ ] M[ ] A[ ] — User logout / session revocation mid-stream (cross-ref Phase 1.8 / 4.11).
- C[ ] L[ ] M[ ] A[ ] — Knowledge document deleted while an in-flight chat turn is rendering its citation envelope (cross-ref Phase 1.7).

### External-party contract evolution

The pattern: webhook receivers, MCP clients, and embed-widget partners evolve on their own schedule. Sunrise must not break them on a no-op deploy.

- C[ ] L[ ] M[ ] A[ ] — Webhook payload schema evolution: add a field; verify strict-schema receivers and a documented `version` / content-type strategy (cross-ref Phase 2.8).
- C[ ] L[ ] M[ ] A[ ] — Webhook delivery ordering when N events fire within milliseconds — FIFO, parallel, or undefined per documented contract (cross-ref Phase 2.8).
- C[ ] L[ ] M[ ] A[ ] — Webhook receiver "challenge" handshake at subscription time (cross-ref Phase 2.8).
- C[ ] L[ ] M[ ] A[ ] — Webhook at-least-once vs at-most-once contract: receiver returns 2xx but processed asynchronously — verify retry behaviour matches the documented contract (cross-ref Phase 2.8).
- C[ ] L[ ] M[ ] A[ ] — MCP version negotiation: older client, newer client (cross-ref Phase 2.5).
- C[ ] L[ ] M[ ] A[ ] — MCP `tools/list` consistency mid-session as capabilities are deactivated (cross-ref Phase 2.5).
- C[ ] L[ ] M[ ] A[ ] — Embed widget loader served to a partner that has cached an older version (cache-busting / versioned-URL strategy) (cross-ref Phase 2.3).
- C[ ] L[ ] M[ ] A[ ] — Self-service API key holder relies on a tool that's been deprecated → verify graceful deprecation path (warning header? sunset date in response?) rather than a silent removal.

### Determinism and reproducibility

The pattern: features that are tested by re-running them against the same input (evals, experiments, regression tests) must produce stable output, or document precisely where they don't.

- C[ ] L[ ] M[ ] A[ ] — Same hybrid-search query issued twice → identical rankings; ties resolved deterministically (cross-ref Phase 1.7).
- C[ ] L[ ] M[ ] A[ ] — LLM response with `temperature: 0` → verify documented determinism per provider (some providers don't honour temp=0 strictly).
- C[ ] L[ ] M[ ] A[ ] — Re-score an evaluation session → scores reproduce within tolerance, given identical settings (cross-ref Phase 3.4).
- C[ ] L[ ] M[ ] A[ ] — Sticky bucketing in experiments: same user, two messages → same variant (cross-ref Phase 3.5).
- C[ ] L[ ] M[ ] A[ ] — Audit-log diff stable across re-renders → deterministic key ordering, no JSON object property reorder noise (cross-ref Phase 3.6).
- C[ ] L[ ] M[ ] A[ ] — Round-trip export → import → re-export → diff the two exports; identical modulo timestamps (cross-ref Phase 3.7).
- C[ ] L[ ] M[ ] A[ ] — Conversation replay from history (admin "re-run this conversation against the new agent prompt") — same input, same model, same settings → reproducible enough to be useful for regression-checking, even if not bit-identical.

### Boundary-on-the-boundary (exact-limit discipline)

The pattern: tests of "above the limit" routinely catch their target; tests of "exactly at the limit" frequently expose off-by-one bugs in the validator. For every documented numeric cap, exercise three values: one below, one at, and one above.

- C[ ] L[ ] M[ ] A[ ] — Conversation starters: 3 / 4 / 5 (cap 4) — Phase 2.3.
- C[ ] L[ ] M[ ] A[ ] — Per-user chat rate: 19 / 20 / 21 messages in 60s (cap 20/min) — Phase 1.1 / 2.4.
- C[ ] L[ ] M[ ] A[ ] — Single chat message size: just under / equal / just over the documented byte cap — Phase 1.1.
- C[ ] L[ ] M[ ] A[ ] — Document upload size: 49.99 MB / 50 MB / 50.01 MB (cap 50 MB) — Phase 1.6.
- C[ ] L[ ] M[ ] A[ ] — CSV row batching threshold: 4,999 / 5,000 / 5,001 rows — Phase 1.6.
- C[ ] L[ ] M[ ] A[ ] — MCP batch size: 19 / 20 / 21 requests (cap 20) — Phase 2.5.
- C[ ] L[ ] M[ ] A[ ] — MCP request body: just under / equal / just over 1 MB — Phase 2.5.
- C[ ] L[ ] M[ ] A[ ] — Tool loop iterations: `maxIterations - 1` / `maxIterations` / `maxIterations + 1` — Phase 1.1 / 1.5.
- C[ ] L[ ] M[ ] A[ ] — Approval queue pagination boundary at the documented page size — Phase 2.2.
- C[ ] L[ ] M[ ] A[ ] — Per-capability rate-limit window edges (sliding-window first / mid / last second) — Phase 1.5.
- C[ ] L[ ] M[ ] A[ ] — Per-agent budget: 99% / 100% / 101% of cap — Phase 1.4.
- C[ ] L[ ] M[ ] A[ ] — System monthly budget: same triple — Phase 1.4.
- C[ ] L[ ] M[ ] A[ ] — Webhook payload size cap: just under / equal / just over the documented outbound size — Phase 2.8.
- C[ ] L[ ] M[ ] A[ ] — Citation envelope size: just under / equal / just over documented marker count — Phase 1.7.

### Performance & load (single-instance baseline)

- C[ ] L[ ] M[ ] A[ ] — Run 10 concurrent chat conversations against one agent → verify throughput (tokens / sec / stream) doesn't degrade catastrophically.
- C[ ] L[ ] M[ ] A[ ] — Run a workflow with a 50-branch `parallel` step → verify branches genuinely run concurrently (wall-clock < sum of branch times).
- C[ ] L[ ] M[ ] A[ ] — Knowledge search at p95 < 500ms with 10K chunks under hybrid mode.
- C[ ] L[ ] M[ ] A[ ] — Trace viewer renders a 100-step trace within 2s (cross-ref Phase 3.3).
- C[ ] L[ ] M[ ] A[ ] — Admin agents list with 200 agents paginates and renders within 1s.
- C[ ] L[ ] M[ ] A[ ] — Embed widget cold-boot (loader fetch + widget-config fetch + first SSE) within 1s on a typical broadband connection.
- C[ ] L[ ] M[ ] A[ ] — MCP `tools/call` round-trip latency under 200ms for a no-op capability.

### Concurrency & race conditions

- C[ ] L[ ] M[ ] A[ ] — Two admins approve the same execution within milliseconds (cross-ref Phase 1.8 and Phase 2.2 — verify optimistic locking holds across both surfaces).
- C[ ] L[ ] M[ ] A[ ] — Two browser tabs send messages on the same conversation simultaneously → verify ordering preserved or last-write-wins per the documented contract.
- C[ ] L[ ] M[ ] A[ ] — Two API keys mutate the same agent at the same instant → verify no silent loss.
- C[ ] L[ ] M[ ] A[ ] — Capability handler enters reentrancy via nested `agent_call` → verify each call sees its own frozen context snapshot.
- C[ ] L[ ] M[ ] A[ ] — Cron tick fires while a previous tick is still running → verify liveness watchdog or token semantics prevent overlap (cross-ref Phase 2.7).
- C[ ] L[ ] M[ ] A[ ] — Budget mutex under concurrent calls (in-memory; documented horizontal-scale gap) — verify single-instance correctness (cross-ref Phase 1.4).
- C[ ] L[ ] M[ ] A[ ] — Circuit breaker state under concurrent failures from two streams → verify trip threshold honoured exactly once.
- C[ ] L[ ] M[ ] A[ ] — Two re-uploads of the same PDF by the same admin within seconds → verify dedup-in-place wins (cross-ref Phase 1.6).

### Unicode, RTL, and i18n surfaces

- C[ ] L[ ] M[ ] A[ ] — Submit chat messages with mixed RTL/LTR scripts → verify SSE framing isn't corrupted.
- C[ ] L[ ] M[ ] A[ ] — Submit messages with ZWJ / emoji ZWJ sequences → verify length counting isn't fooled.
- C[ ] L[ ] M[ ] A[ ] — Knowledge documents in CJK languages → verify hybrid search still ranks meaningfully (BM25 tokenisation may degrade — verify it doesn't crash).
- C[ ] L[ ] M[ ] A[ ] — Citation rendering with non-Latin source titles → verify the sources panel displays them correctly.
- C[ ] L[ ] M[ ] A[ ] — Embed widget displays admin-typed Spanish / Arabic / Japanese copy correctly (per the Phase 2.3 / item #7 design — UI localisation is admin-typed copy).
- C[ ] L[ ] M[ ] A[ ] — Workflow template interpolation with non-ASCII variable values → verify no encoding issues.
- C[ ] L[ ] M[ ] A[ ] — CSV with non-ASCII column headers → verify chunking and search.
- C[ ] L[ ] M[ ] A[ ] — Audit log with non-ASCII before/after values → verify diff renders.

### Time, clock skew, timezones

- C[ ] L[ ] M[ ] A[ ] — Cron schedule fires correctly across a DST transition (hour skip / repeat).
- C[ ] L[ ] M[ ] A[ ] — Approval token expiry calculated in UTC; receiver clock skewed by ±2 minutes → verify ±tolerance window if any.
- C[ ] L[ ] M[ ] A[ ] — Cost log timestamps stored in UTC; admin views localise correctly per browser TZ.
- C[ ] L[ ] M[ ] A[ ] — Audit log filtered by user-local-time → verify TZ conversion at query / display time.
- C[ ] L[ ] M[ ] A[ ] — Schedule next-fire-time displayed in admin UI matches actual fire time.
- C[ ] L[ ] M[ ] A[ ] — Evaluation trend chart x-axis spans a DST transition → verify no double-counted or missing buckets.

### Logging behaviour & redaction

- C[ ] L[ ] M[ ] A[ ] — All Tier 1 mutating actions produce a structured `logger.info` or `logger.warn` entry with request context.
- C[ ] L[ ] M[ ] A[ ] — All Tier 1 errors produce a structured `logger.error` entry with stack trace.
- C[ ] L[ ] M[ ] A[ ] — No `console.log` calls in production code paths (per CLAUDE.md `logger` rule — grep audit).
- C[ ] L[ ] M[ ] A[ ] — Sensitive fields (API keys, passwords, HMAC secrets, OAuth tokens, session cookies) never appear in any log line.
- C[ ] L[ ] M[ ] A[ ] — Stack traces don't leak DB connection strings, file paths under `/Users/`, or env-var values.

### Database integrity

- C[ ] L[ ] M[ ] A[ ] — Foreign key constraints prevent orphan rows on entity deletion (e.g. delete agent → no orphan `AiMessage` rows).
- C[ ] L[ ] M[ ] A[ ] — Cascade deletes match what the Prisma schema declares (no surprises).
- C[ ] L[ ] M[ ] A[ ] — Optimistic locking prevents lost updates on entities that use it (audit, executions, etc.).
- C[ ] L[ ] M[ ] A[ ] — Migration apply on a non-empty DB → verify no data loss for any of the recent migrations.
- C[ ] L[ ] M[ ] A[ ] — `pgvector` index intact after a migration that adds columns to `AiKnowledgeChunk`.
- C[ ] L[ ] M[ ] A[ ] — Generated `searchVector` tsvector column repopulated correctly after a chunk update.

### Recovery, restart, and self-healing

- C[ ] L[ ] M[ ] A[ ] — Process restart mid-chat → verify SSE clients see a clean disconnect; reconnection re-establishes a fresh stream.
- C[ ] L[ ] M[ ] A[ ] — Process restart mid-workflow → verify in-flight executions transition to a sensible state on next tick (per the documented partial-recovery scope; full checkpoint recovery is item #15 in `improvement-priorities.md`).
- C[ ] L[ ] M[ ] A[ ] — DB restart while application is running → verify connection pool re-establishes.
- C[ ] L[ ] M[ ] A[ ] — Provider API down for 30 minutes → verify circuit breaker behaviour over the full window (trips, cools down, retries, eventually succeeds).
- C[ ] L[ ] M[ ] A[ ] — In-memory caches (hook registry, circuit breaker state) reset cleanly on restart.

---

# Appendix B — OWASP Agentic Top 10 Spot-Checks

`functional-specification.md` §17.2 claims native coverage of approximately 6/10 OWASP Agentic categories. This appendix asks you to confirm each, citing back to the per-phase scenario that exercises the protection.

- C[ ] L[ ] M[ ] A[ ] — **LLM01 Prompt Injection** — input guard catches `system_override`, `role_confusion`, `delimiter_injection` at all 3 modes (cross-ref Phase 2.6).
- C[ ] L[ ] M[ ] A[ ] — **LLM02 Insecure Output Handling** — output guard catches PII in responses; topic boundaries enforced (cross-ref Phase 2.6).
- C[ ] L[ ] M[ ] A[ ] — **LLM03 Training Data Poisoning** — N/A for inference-only deployment; document any RAG-poisoning analogue (e.g. malicious knowledge document upload) and verify behaviour under Phase 1.6.
- C[ ] L[ ] M[ ] A[ ] — **LLM04 Model Denial of Service** — multi-layer rate limits (IP, per-user, per-capability) plus budget caps catch the practical attack (cross-ref Phase 1.4 + Phase 2.4 + Phase 1.5).
- C[ ] L[ ] M[ ] A[ ] — **LLM05 Supply Chain Vulnerabilities** — provider credentials env-var resolved, never in DB, never in LLM context, never in client responses (cross-ref Phase 1.3).
- C[ ] L[ ] M[ ] A[ ] — **LLM06 Sensitive Information Disclosure** — output guard PII detection + auth scoping (404 not 403) + credential redaction (cross-ref Phase 1.8 + Phase 2.6 + Appendix A logging section).
- C[ ] L[ ] M[ ] A[ ] — **LLM07 Insecure Plugin Design** — 7-stage capability dispatch pipeline + Zod arg validation + per-capability rate limits + approval gates (cross-ref Phase 1.5).
- C[ ] L[ ] M[ ] A[ ] — **LLM08 Excessive Agency** — capability binding (default-deny LLM visibility) + approval gates + URL-prefix restrictions on `call_external_api` (cross-ref Phase 1.5 + Phase 2.2 + Phase 4.3).
- C[ ] L[ ] M[ ] A[ ] — **LLM09 Overreliance** — citation envelope surfaces sources for verification; evaluation metrics (faithfulness/groundedness/relevance) flag drift (cross-ref Phase 1.7 + Phase 3.4).
- C[ ] L[ ] M[ ] A[ ] — **LLM10 Model Theft** — out of scope for self-hosted deployments; document any analogue (e.g. system instruction extraction via prompt) and verify input guard mitigates.

For each ticked box, note which Phase ID(s) you relied on. If a category is unchecked at the end of the walk, decide whether it's a known gap (document in `improvement-priorities.md`) or a missed test (return to the relevant phase).

---

# Closing notes

This document deliberately omits:

- **Test setup and fixture data** — improvise per area; the spec docs contain enough detail to build minimal cases.
- **Pass/fail criteria** beyond "behaviour matches the spec" — if you find ambiguity, treat the divergence as a bug to file or a doc to fix.
- **An automated test harness** — this is a manual checklist; the project already has separate `/test-*` workflows for automated coverage.
- **Bug tracking** — failures get logged to your tracker, not into this file. This file is the inventory; the tracker is the work queue.

When all phases are ✅ across both Use and Abuse / Edge sections, the orchestration layer has been validated end-to-end at a depth that matches what `functional-specification.md` claims it does.
