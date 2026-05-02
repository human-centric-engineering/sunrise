# Orchestration Maturity Analysis

Competitive assessment of Sunrise's agent orchestration against production-ready platforms. Covers functional capabilities, architectural gaps, and prioritised improvements.

**Last updated:** 2026-05-02

## TL;DR

Sunrise is a **full-stack agent orchestration platform** embedded in a production-grade Next.js/TypeScript application — not a standalone library or managed service. Against 11 evaluated platforms, it **leads** on cost/budget enforcement, provider resilience (circuit breakers + fallback chains), chat handler completeness, MCP server implementation with audit logging, and inline citation grounding (envelope through API + chat + embed widget + opt-in citation guard). It is **competitive** on DAG execution (15 step types), capability dispatch, security (input/output guards, SSRF protection), scheduling/webhooks, embeddable chat, and knowledge-base RAG (hybrid BM25-flavoured + vector search shipped May 2026). It **trails** on observability (no OTEL), multi-agent coordination patterns, horizontal scaling (3 in-memory stores), and evaluation tooling.

The key differentiator is integration depth: teams using LangGraph, CrewAI, or similar frameworks still need to build auth, admin UI, API layer, consumer chat, deployment, and database management around the orchestration engine. Sunrise ships all of this as a single typed codebase with shared validation, making the path from "we need an AI feature" to a deployed, budget-enforced agent with admin controls significantly shorter.

3 P0 improvements would block production under load (OTEL tracing, distributed circuit breaker/budget state). The approval queue UI (previously P0 #4) shipped April 2026; hybrid search (previously P1 #8) and citation/source attribution (previously P1 #2 in `improvement-priorities.md`) shipped May 2026.

---

## Platform Landscape

Eleven platforms evaluated across the agent orchestration space, grouped by type:

| Type                          | Platforms                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| **Code-first frameworks**     | LangGraph, CrewAI, AutoGen, Semantic Kernel, Haystack, OpenAI Agents SDK, Google ADK |
| **Visual/low-code platforms** | Dify, Flowise, n8n                                                                   |
| **Managed cloud services**    | AWS Bedrock Agents, Azure AI Foundry Agent Service                                   |

Sunrise occupies a distinct position: a **code-first, self-hosted orchestration platform** embedded in a Next.js application — not a standalone framework or managed cloud service. This means it competes on engine design and integrated features rather than ecosystem breadth or managed infrastructure.

---

## Capability Comparison Matrix

Rating scale: **Strong** (best-in-class or competitive), **Adequate** (functional, gaps exist), **Weak** (minimal or missing), **None** (not implemented).

### Core Engine

| Capability                                  | Sunrise | LangGraph | CrewAI   | AutoGen  | Haystack | OpenAI SDK | Google ADK |
| ------------------------------------------- | ------- | --------- | -------- | -------- | -------- | ---------- | ---------- |
| DAG execution engine                        | Strong  | Strong    | Adequate | Adequate | Strong   | None       | Adequate   |
| Step type variety (15 types)                | Strong  | Adequate  | Weak     | Weak     | Adequate | Weak       | Adequate   |
| Error strategies (retry/fallback/skip/fail) | Strong  | Adequate  | Weak     | Weak     | Adequate | Weak       | Adequate   |
| Parallel step execution                     | Strong  | Strong    | Weak     | Adequate | Strong   | None       | Strong     |
| Frozen context snapshots                    | Strong  | Strong    | None     | None     | None     | None       | None       |
| Checkpoint/resume after crash               | Weak    | Strong    | Weak     | Weak     | None     | Adequate   | None       |
| Template interpolation in prompts           | Strong  | Adequate  | None     | None     | None     | None       | None       |
| Cancellation (client + DB)                  | Strong  | Strong    | None     | None     | None     | Adequate   | None       |

**Sunrise advantages:** 15 step types (vs. LangGraph's node-based approach which is more flexible but less structured), per-step error strategies, and dual cancellation paths. **Key gap:** Checkpoint recovery is limited to `human_approval` pauses — LangGraph's full state checkpoint on every super-step is the gold standard.

### LLM Provider Management

| Capability                     | Sunrise | LangGraph | CrewAI   | Haystack | Semantic Kernel | Bedrock  | Azure Foundry |
| ------------------------------ | ------- | --------- | -------- | -------- | --------------- | -------- | ------------- |
| Multi-provider abstraction     | Strong  | Strong    | Adequate | Strong   | Strong          | Adequate | Adequate      |
| Provider count (8+)            | Strong  | Strong    | Weak     | Strong   | Strong          | Adequate | Adequate      |
| Circuit breaker                | Strong  | None      | None     | None     | None            | N/A      | N/A           |
| Fallback chains (per-agent)    | Strong  | None      | None     | None     | None            | N/A      | N/A           |
| Model registry with tiers      | Strong  | None      | None     | None     | None            | Adequate | Adequate      |
| Provider selector (task-based) | Strong  | None      | None     | None     | None            | None     | None          |
| Provider health monitoring     | Strong  | None      | None     | None     | None            | N/A      | N/A           |

**Sunrise advantages:** Circuit breaker, explicit fallback chains, and task-based model recommendation are ahead of every evaluated framework. No major framework ships provider-level resilience as a first-class feature. **Key gap:** Circuit breaker state is in-memory — breaks under horizontal scaling.

### Cost & Budget Management

| Capability                           | Sunrise  | LangGraph | CrewAI | AutoGen | Haystack | Bedrock | Azure Foundry |
| ------------------------------------ | -------- | --------- | ------ | ------- | -------- | ------- | ------------- |
| Per-operation cost logging           | Strong   | Weak      | None   | None    | Weak     | Weak    | Weak          |
| Per-agent monthly budgets            | Strong   | None      | None   | None    | None     | None    | None          |
| Global monthly budget cap            | Strong   | None      | None   | None    | None     | None    | None          |
| 80% threshold warnings               | Strong   | None      | None   | None    | None     | None    | None          |
| Budget enforcement in execution loop | Strong   | None      | None   | None    | None     | None    | None          |
| Concurrent request mutex             | Adequate | None      | None   | None    | None     | N/A     | N/A           |
| Cost breakdown API                   | Strong   | Weak      | None   | None    | None     | Weak    | Weak          |

**Sunrise advantage: This is the strongest differentiator.** No evaluated platform enforces budgets inside the execution loop. All others delegate to external billing dashboards. **Key gap:** Budget mutex is in-memory — concurrent requests across instances can overspend.

### Tool / Capability System

| Capability                                           | Sunrise | LangGraph | CrewAI   | Haystack | OpenAI SDK | Dify     | Google ADK |
| ---------------------------------------------------- | ------- | --------- | -------- | -------- | ---------- | -------- | ---------- |
| Capability registry (DB-backed)                      | Strong  | None      | None     | None     | None       | Adequate | None       |
| Dispatch pipeline (7-stage)                          | Strong  | Adequate  | Weak     | Adequate | Adequate   | Adequate | Adequate   |
| Rate limiting per capability                         | Strong  | None      | None     | None     | None       | None     | None       |
| Approval gating                                      | Strong  | Strong    | None     | None     | Adequate   | None     | Adequate   |
| Zod validation on args                               | Strong  | Adequate  | Weak     | Adequate | Strong     | None     | Adequate   |
| Default-allow dispatch / default-deny LLM visibility | Strong  | None      | None     | None     | None       | None     | None       |
| Built-in capability library + recipe cookbook        | Strong  | Strong    | Adequate | Strong   | Strong     | Strong   | Strong     |
| MCP integration                                      | Strong  | Adequate  | Adequate | None     | Strong     | Adequate | Strong     |
| Third-party tool integrations                        | Weak    | Strong    | Adequate | Strong   | Adequate   | Strong   | Adequate   |

**Sunrise advantages:** The 7-stage dispatch pipeline (registry → binding → rate limit → approval → validation → timeout → cost log) and the default-allow/default-deny split are architecturally clean. The approval queue provides a full admin UI plus token-authenticated external channel endpoints — admins can approve from the browser, while Slack/email/SMS integrations use pre-signed HMAC tokens via webhook consumers. The 10 curated built-in capabilities + the `call_external_api` outbound-HTTP primitive + a comprehensive recipes cookbook (transactional email, payments, chat notifications, calendar events, document rendering — see `.context/orchestration/recipes/`) cover the integrations Sunrise's deployment profile actually needs without bundling vendor SDKs. The deliberate trade vs. LangChain's "1000+ tool integrations" is curation: every capability and recipe is verified end-to-end and dependency-free; LangChain's count includes community-contributed integrations of variable maintenance status.

### Multi-Agent Coordination

| Capability                    | Sunrise  | LangGraph | AutoGen  | Google ADK | CrewAI   | Semantic Kernel |
| ----------------------------- | -------- | --------- | -------- | ---------- | -------- | --------------- |
| Planner LLM delegation        | Strong   | Strong    | Adequate | Strong     | Adequate | Adequate        |
| Explicit handoff primitives   | None     | Strong    | Strong   | Strong     | Adequate | Adequate        |
| Supervisor/worker topology    | Adequate | Strong    | Strong   | Strong     | Strong   | Adequate        |
| Swarm coordination            | None     | Strong    | Strong   | None       | None     | None            |
| Agent-to-agent protocol (A2A) | None     | None      | None     | Strong     | None     | None            |
| Recursion depth guard         | Strong   | Adequate  | Adequate | Adequate   | None     | None            |
| Named coordination patterns   | Weak     | Strong    | Strong   | Strong     | Adequate | Adequate        |
| Sub-agent context isolation   | Adequate | Strong    | Strong   | Strong     | Adequate | Adequate        |

**Sunrise position:** Multi-agent exists via the `orchestrator` step and `agent_call`, but coordination semantics are informal — the planner LLM decides routing rather than explicit typed patterns (handoff, swarm, round-robin, selector). LangGraph and AutoGen have 4–5 named, tested coordination topologies. Google ADK's A2A inter-agent protocol is an emerging standard worth tracking.

### Chat & Streaming

| Capability                                 | Sunrise | LangGraph | OpenAI SDK | Dify     | CrewAI   |
| ------------------------------------------ | ------- | --------- | ---------- | -------- | -------- |
| SSE streaming with tool loop               | Strong  | Strong    | Strong     | Strong   | Adequate |
| Rolling conversation summary               | Strong  | Adequate  | None       | None     | None     |
| Input guard (injection detection)          | Strong  | None      | Adequate   | Adequate | None     |
| Output guard (content filtering)           | Strong  | None      | Adequate   | Adequate | None     |
| Citation guard (under-cite / hallucinated) | Strong  | None      | None       | None     | None     |
| Inline citation envelope on responses      | Strong  | None      | None       | None     | None     |
| Provider fallback mid-stream               | Strong  | None      | None       | None     | None     |
| User memory system                         | Strong  | Adequate  | Adequate   | Adequate | Adequate |
| Message caps (per-user, per-conversation)  | Strong  | None      | None       | Adequate | None     |
| SSE keepalive / auto-reconnect             | Strong  | Adequate  | N/A        | Adequate | None     |
| Budget check mid-loop                      | Strong  | None      | None       | None     | None     |

**Sunrise advantages:** The chat handler is comprehensive — mid-stream provider failover, input/output guards, rolling summaries, budget checks inside the tool loop, and a structured citation envelope (markers in the LLM-bound tool result, `[N]` rendered inline by chat / trace / embed surfaces, opt-in citation guard for under-cited or hallucinated markers) are all ahead of the field. This is the most production-hardened component.

### Human-in-the-Loop

| Capability                        | Sunrise | LangGraph | Azure Foundry | AutoGen  | Google ADK |
| --------------------------------- | ------- | --------- | ------------- | -------- | ---------- |
| Pause/resume on approval          | Strong  | Strong    | Strong        | Adequate | Adequate   |
| State serialisation at pause      | Strong  | Strong    | Strong        | Adequate | Adequate   |
| Approval queue UI                 | Strong  | N/A       | Adequate      | None     | None       |
| External approval channels        | Strong  | Adequate  | None          | None     | None       |
| Approver delegation (scoping)     | Strong  | None      | None          | None     | None       |
| Multi-interrupt parallel branches | None    | Strong    | None          | None     | None       |
| Mid-run human edit of state       | None    | Strong    | None          | Adequate | None       |
| Resume after process restart      | Weak    | Strong    | Strong        | Weak     | None       |

**Sunrise advantage:** The approval system is the most complete of any evaluated platform. The admin UI (expandable rows, approve/reject actions, sidebar badge) handles browser-based approvals. Token-authenticated public endpoints (`/api/v1/orchestration/approvals/:id/{approve,reject}`) enable external channel approvals (Slack, email, WhatsApp, SMS) via stateless HMAC-signed tokens — no session cookies required. A notification dispatcher emits `workflow.paused_for_approval` hook and `approval_required` webhook events with pre-signed approve/reject URLs, so external consumers can build approval flows without generating tokens themselves. Approver scoping via `approverUserIds` enables delegation to non-owner admins. **Key gap:** LangGraph's `interrupt()` model is the gold standard — serialises full graph state, supports multiple concurrent interrupts, allows human edits before resume, and survives process restarts. Sunrise's `human_approval` step covers the core use case with a production-ready admin + external channel workflow but lacks LangGraph's depth on multi-interrupt and state-editing.

### Observability & Evaluation

| Capability                   | Sunrise  | Haystack | LangGraph | Semantic Kernel | Dify     | Bedrock  |
| ---------------------------- | -------- | -------- | --------- | --------------- | -------- | -------- |
| OTEL span emission           | None     | Strong   | None      | Strong          | None     | None     |
| Langfuse integration         | None     | Strong   | None      | None            | None     | None     |
| MLflow integration           | None     | Strong   | None      | None            | None     | None     |
| Datadog / external APM       | None     | Strong   | None      | Adequate        | None     | Adequate |
| Built-in trace UI            | Adequate | Adequate | Strong    | None            | Strong   | Adequate |
| Per-step latency attribution | Weak     | Strong   | Strong    | None            | Strong   | Adequate |
| Named evaluation metrics     | Weak     | Strong   | Strong    | None            | Adequate | None     |
| Regression testing           | None     | Strong   | Strong    | None            | None     | None     |
| Cost attribution per step    | Strong   | Adequate | Weak      | None            | Adequate | Weak     |
| Audit log (config changes)   | Strong   | None     | None      | None            | Adequate | None     |

**This is Sunrise's weakest area.** No OTEL instrumentation, no integration with any external tracing platform, no named evaluation metrics beyond the LLM-driven completion handler. Haystack is the benchmark here — 5+ backend integrations, 8 named evaluators, and pluggable tracer interface. LangSmith (LangGraph's companion) is richer but proprietary.

### Knowledge Base

| Capability                              | Sunrise | Dify     | Haystack | LangGraph | Bedrock  |
| --------------------------------------- | ------- | -------- | -------- | --------- | -------- |
| Multi-format ingestion                  | Strong  | Strong   | Strong   | None      | Strong   |
| Semantic chunking                       | Strong  | Strong   | Strong   | None      | Adequate |
| Vector search (pgvector)                | Strong  | Strong   | Strong   | None      | Strong   |
| Hybrid search (BM25-flavoured + vector) | Strong  | Adequate | Strong   | None      | Adequate |
| Inline citation envelope to UI / API    | Strong  | None     | None     | None      | Adequate |
| Document lifecycle management           | Strong  | Strong   | Adequate | None      | Adequate |
| PDF preview/confirm flow                | Strong  | None     | None     | None      | None     |
| Namespace/team isolation                | None    | Adequate | Adequate | None      | Adequate |
| Incremental document updates            | None    | Adequate | Adequate | None      | Adequate |

**Sunrise advantages:** PDF preview/confirm workflow is unique. Document lifecycle (pending → processing → ready) is well-designed. Hybrid search (PR #139, May 2026) and the citation envelope (this PR, May 2026) close two prior gaps and pull RAG quality and trustworthiness ahead of all evaluated peers. **Key gaps:** No per-team scoping, no incremental document updates.

### Production Deployment & Scaling

| Capability                       | Sunrise  | LangGraph | Bedrock | Azure Foundry | Dify     |
| -------------------------------- | -------- | --------- | ------- | ------------- | -------- |
| Self-hosted deployment           | Strong   | Strong    | N/A     | N/A           | Strong   |
| Managed hosting option           | None     | Strong    | Strong  | Strong        | Strong   |
| Horizontal scaling safety        | Weak     | Strong    | Strong  | Strong        | Adequate |
| Distributed task queue           | None     | Strong    | N/A     | N/A           | None     |
| Background execution model       | Weak     | Strong    | Strong  | Strong        | Adequate |
| Workflow versioning (git-native) | None     | Strong    | None    | Adequate      | None     |
| RBAC (admin/operator/consumer)   | Adequate | N/A       | Strong  | Strong        | Strong   |

**Key gaps:** Three in-memory stores (circuit breaker, budget mutex, maintenance tick) break under multiple instances. No distributed task queue for workflow execution. No background execution model for long-running workflows triggered by cron/webhooks.

---

## Competitive Position Summary

### Where Sunrise Leads

1. **Cost & budget enforcement** — the only platform with per-agent budgets, global caps, 80% warnings, and enforcement inside the execution loop. Every other system delegates to billing dashboards.

2. **Provider resilience** — circuit breaker + fallback chains + provider health monitoring is more sophisticated than any evaluated framework.

3. **Chat handler completeness** — mid-stream provider failover, input/output guards, rolling summaries, budget-aware tool loops, and SSE auto-reconnect in a single integrated handler.

4. **Capability dispatch architecture** — the 7-stage pipeline with the default-allow/default-deny split is more structured than any framework's tool model.

5. **Audit trails** — immutable config change logging, instruction version history, workflow definition versions. Most frameworks have no equivalent.

6. **Inline citation grounding** — structured `Citation` envelope flows from `search_knowledge_base` through the LLM-bound tool result (with `marker` field), into a dedicated SSE `citations` event, and onto the persisted assistant message metadata. Admin chat, conversation trace viewer, and the public Shadow-DOM embed widget all render `[N]` markers and a sources panel from the same envelope. An opt-in citation guard flags under-citation and hallucinated markers. No evaluated platform ships an end-to-end pipeline of this depth.

### Where Sunrise Is Competitive

6. **DAG execution engine** — 15 step types with per-step error strategies is on par with or ahead of most frameworks, trailing only LangGraph on checkpoint recovery.

7. **Knowledge base** — solid foundation with multi-format ingestion, semantic chunking, and PDF preview flow.

8. **Platform-agnostic core** — no Next.js imports in `lib/orchestration/` enables testing without server runtime. Clean architectural boundary.

### Where Sunrise Trails

9. **Observability** — no OTEL spans, no external tracing integration, no named evaluation metrics. 3–4 generations behind Haystack.

10. **Multi-agent semantics** — informal planner-driven coordination vs. explicit typed patterns (handoffs, swarm, round-robin). Behind LangGraph, AutoGen, Google ADK.

11. **Horizontal scaling** — in-memory circuit breaker, budget mutex, and maintenance tick state. Structural issue, not a feature gap.

12. **Human-in-the-loop depth** — `human_approval` with admin UI, token-authenticated external channel endpoints, notification dispatcher, and approver scoping covers the production use case well. Lacks LangGraph's multi-interrupt, state-edit, and crash-recovery capabilities.

13. **Evaluation tooling** — LLM-driven completion handler vs. Haystack's 8 named evaluators or LangSmith's regression testing.

14. **Third-party integration breadth (raw count).** LangChain ships 1000+ community-contributed tool integrations; Sunrise curates 10 trusted built-ins plus the `call_external_api` outbound-HTTP primitive plus 5 recipe-driven patterns covering the most common shapes (email, payments, chat, calendar, document render). The trade is deliberate — curation + extensibility over count — but if a buyer's evaluation rubric is purely raw integration count, Sunrise will look thin. Mitigation is the recipe + `/orchestration-capability-builder` skill path: any new integration is a documented short walk away.

---

## Prioritised Improvements

### P0 — Production Blockers

Issues that would prevent recommending Sunrise orchestration for production workloads under load.

| #   | Improvement                           | Current State                                                    | Target State                                                 | Benchmark              |
| --- | ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| 1   | **OTEL tracing instrumentation**      | No span emission from engine or chat                             | Per-step spans with token/cost attributes, pluggable backend | Haystack (5+ backends) |
| 2   | **Distributed circuit breaker state** | In-memory per instance                                           | Redis or Postgres-backed shared state                        | Standard practice      |
| 3   | **Distributed budget mutex**          | In-memory per instance; concurrent instances can overspend by N× | Redis-based distributed lock or Postgres `SELECT FOR UPDATE` | Standard practice      |

> **Resolved:** Approval queue (previously P0 #4) — shipped April 2026. Admin UI with expandable rows, approve/reject actions, sidebar badge. External approval channels via HMAC-signed token endpoints, notification dispatcher with hook/webhook events, and approver scoping for delegated decisions.
>
> **Resolved:** Hybrid search (previously P1 #8) — shipped May 2026 (PR #139). Generated `searchVector` tsvector column with GIN index, opt-in `searchConfig.hybridEnabled`, blended ranking via `vectorWeight × vector_score + bm25Weight × keyword_score`, three-segment score breakdown, smoke test against real Postgres. `ts_rank_cd` documented honestly as a BM25 proxy.
>
> **Resolved:** Background execution model (previously P1 #6) — shipped May 2026 (PR #140). Non-blocking maintenance tick, lightweight execution status endpoint, live-poll status from the admin UI, `workflow.execution.failed` hook with engine-crash repair, sanitised hook payloads, liveness watchdog and token ownership on the maintenance tick.
>
> **Resolved:** Inline citation grounding (Tier 1 #2 in `improvement-priorities.md`) — shipped May 2026. New `Citation` type and `citations` SSE event, `[N]` marker substitution in admin React + vanilla-JS embed widget, opt-in `citationGuardMode` with under-citation and hallucinated-marker detection, persisted on assistant message metadata and rehydrated by the trace viewer.
>
> **Resolved:** Sharpened HTTP fetcher + dependency-free recipes cookbook (Tier 1 #3 in `improvement-priorities.md`) — shipped May 2026. Extracted shared `lib/orchestration/http/` module from the workflow `external_call` executor; added HMAC request signing, Idempotency-Key header support, and Basic auth on top of existing auth modes. New `call_external_api` capability lets agents make outbound HTTP calls within the deployment allowlist; auth credentials, URL-prefix restrictions, and idempotency policy live in `AiAgentCapability.customConfig` so the LLM never sees secret env-var names. Five comprehensive recipes (transactional email, payment charge, chat notification, calendar event, document render) document common integration shapes without bundling vendor SDKs. Deliberately trades raw integration count for curation + extensibility.

### P1 — Meaningful Quality Gaps

Issues that limit capability or reliability in real-world use.

| #   | Improvement                           | Current State                                                     | Target State                                                                   | Benchmark              |
| --- | ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| 4   | **Exact tokenisation**                | Heuristic (1 token ≈ 3.5 chars), 20–30% error on code/non-English | Per-provider tokeniser (tiktoken for OpenAI, Anthropic counter)                | LangChain, OpenAI SDK  |
| 5   | **Full checkpoint recovery**          | Resume only from `human_approval` pauses                          | Persist execution state at every step; resume from any step after crash/deploy | LangGraph checkpointer |
| 7   | **Maintenance tick distributed lock** | In-memory flag; multiple instances run duplicate maintenance      | Postgres advisory lock or Redis-based leader election                          | Standard practice      |

### P2 — Competitive Parity

Improvements that bring Sunrise to feature parity with leading platforms.

| #   | Improvement                        | Current State                        | Target State                                                                           | Benchmark               |
| --- | ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------- |
| 9   | **Named multi-agent patterns**     | Informal planner-driven coordination | Explicit typed patterns: handoff, supervisor, round-robin, selector                    | LangGraph, AutoGen      |
| 10  | **Langfuse/MLflow integration**    | No external observability backend    | First-class integration with at least one open-source tracing platform                 | Haystack                |
| 11  | **Named evaluation metrics**       | LLM completion handler only          | Faithfulness, relevance, groundedness evaluators with baseline comparison              | Haystack (8 evaluators) |
| 12  | **Operator RBAC tier**             | Binary admin/consumer split          | Admin (full CRUD) / Operator (execute, monitor, read-only config) / Consumer (chat)    | Azure Foundry, Bedrock  |
| 13  | **Workflow definition versioning** | DB-stored with history array         | Git-native format (JSON/YAML files), tagged versions (v1, v2), rollback to any version | Azure Foundry           |
| 14  | **Knowledge namespace isolation**  | Global knowledge base                | Per-team or per-agent knowledge scoping                                                | Dify, Bedrock           |

### P3 — Strategic Positioning

Forward-looking improvements that would establish competitive advantages.

| #   | Improvement                         | Current State                                   | Target State                                                               | Benchmark          |
| --- | ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------ |
| 15  | **A2A protocol support**            | No inter-agent communication standard           | Implement Google's Agent-to-Agent protocol for cross-system agent calls    | Google ADK         |
| 16  | **First-success parallel strategy** | `wait-all` only                                 | `first-success` and `first-N` strategies for parallel step execution       | LangGraph Send API |
| 17  | **Multi-interrupt HITL**            | Single `human_approval` interrupt per execution | Multiple concurrent interrupts across parallel branches with state editing | LangGraph          |
| 18  | **Managed hosting option**          | Self-hosted only                                | Docker Compose → Kubernetes → managed option progression                   | LangGraph Platform |
| 19  | **Evaluation regression testing**   | No baseline comparison                          | Eval runs compared against historical baselines with drift alerts          | LangSmith          |

---

## Architecture Observations

### Structural Strengths

**Platform-agnostic core.** The hard rule — no `next/*` imports in `lib/orchestration/` — is a genuine architectural advantage. It means the engine can be extracted, tested independently, or ported to a different host framework. Most visual platforms (Dify, Flowise) embed their logic in the UI layer.

**Integrated cost tracking.** Rather than treating cost as an afterthought (external dashboard, billing API), Sunrise builds cost awareness into the execution loop itself. This is the right long-term architecture — cost is a first-class constraint alongside correctness and latency.

**Audit-first config management.** Instruction versioning, definition history, and the immutable audit log create a change trail that most frameworks entirely lack. This matters for compliance-heavy deployments.

### Structural Weaknesses

**In-memory distributed state.** The three in-memory stores (circuit breaker, budget mutex, maintenance tick) are the single biggest architectural risk. They work for single-instance deployments but silently degrade under horizontal scaling. This is not a feature gap — it's a correctness issue.

**Token estimation heuristic.** The 3.5 chars/token heuristic is a known source of context window violations. Models have different tokenisers, and code-heavy or non-English content can diverge 20–30% from the estimate. This affects history truncation decisions — the wrong call here causes either wasted context (truncating too early) or API errors (truncating too late).

**No streaming for background workflows.** Chat has full SSE streaming. Interactive workflow execution has SSE. But cron/webhook-triggered workflows run synchronously — the caller blocks until completion or timeout. For workflows exceeding 60 seconds, this is a reliability problem. The fix is a background execution model with async result polling.

### Design Decisions Worth Preserving

1. **Default-allow dispatch / default-deny LLM visibility** — clean separation between "what can be called" and "what the LLM knows about." Prevents tool confusion while maintaining flexibility.

2. **Fire-and-forget cost logging** — never blocks the user-facing response. Correct trade-off: cost data is eventually consistent, UX is real-time.

3. **Frozen context snapshots** — executors receive `Readonly<ExecutionContext>` and cannot mutate shared state. Results merge back explicitly. Prevents the silent mutation bugs that plague less disciplined execution models.

4. **Ownership scoping with 404 (not 403)** — cross-user lookups return 404 to prevent information leakage about resource existence. Correct security posture.

---

## Security & Safety

### Sunrise Security Implementation

Sunrise ships a multi-layered security model built into the orchestration core:

- **Input guard** (`lib/orchestration/chat/input-guard.ts`): Detects 3 injection pattern types (system_override, role_confusion, delimiter_injection). Per-agent + global modes: `log_only` (default), `warn_and_continue`, `block`.
- **Output guard** (`lib/orchestration/chat/output-guard.ts`): Content filtering with configurable topic boundaries, PII detection, and brand voice enforcement. Same 3 modes as input guard.
- **SSRF protection** (`lib/orchestration/engine/executors/external-call.ts`): Host allowlist for outbound calls, DNS rebinding acknowledged as a gap (resolved IP pinning not exposed through SDK fetch).
- **Credential management**: Provider API keys stored in `AiProviderConfig` DB table. Keys never exposed to LLM context or client responses. Redacted in audit logs.
- **Ownership scoping**: All user data (conversations, evaluations) scoped by `userId`. Cross-user lookups return 404 (not 403) to prevent existence leakage.
- **Rate limiting**: IP-level (`apiLimiter` 30/min), per-user chat (`chatLimiter` 20/min), per-agent override, per-capability sliding window.
- **No code execution sandboxing**: No built-in sandbox for user-submitted code execution.

### Security Comparison Matrix

| Capability                     | Sunrise  | OpenAI SDK | Bedrock | Azure Foundry | LangGraph | Dify     | CrewAI   |
| ------------------------------ | -------- | ---------- | ------- | ------------- | --------- | -------- | -------- |
| Input injection detection      | Strong   | Adequate   | Strong  | Strong        | Adequate  | Adequate | Weak     |
| Output content filtering       | Strong   | Adequate   | Strong  | Strong        | Adequate  | Adequate | Weak     |
| SSRF protection                | Adequate | N/A        | N/A     | N/A           | None      | Adequate | None     |
| Credential management          | Strong   | N/A        | Strong  | Strong        | None      | Strong   | Weak     |
| Code execution sandbox         | None     | Strong     | Strong  | Strong        | None      | Adequate | Adequate |
| Multi-tenancy / data isolation | Strong   | N/A        | Strong  | Strong        | None      | Adequate | Weak     |
| OWASP Agentic Top 10 coverage  | Adequate | Adequate   | Strong  | Strong        | Weak      | Adequate | Weak     |

**Context:** OWASP published the Top 10 for Agentic Applications in December 2025 — the first formal risk taxonomy for autonomous AI agents. The EU AI Act's high-risk obligations take effect August 2026. Microsoft's open-source Agent Governance Toolkit (April 2026) covers all 10 OWASP categories and works with any framework.

**Sunrise position:** Strong on input/output guards and data isolation. Missing code execution sandboxing (relevant for tool-use agents that generate code). The OWASP Agentic Top 10 should be used as a gap analysis checklist — Sunrise covers approximately 6/10 categories natively (injection, data leakage, insecure output, excessive permissions, rate limiting, logging/monitoring), with gaps in resource overconsumption isolation, supply chain validation, and sandbox enforcement.

---

## MCP (Model Context Protocol)

### Sunrise MCP Implementation

Sunrise ships a **full MCP server** (`lib/orchestration/mcp/`, `app/api/v1/mcp/route.ts`) — not just client-side MCP tool calls:

- **Transport**: Streamable HTTP (JSON-RPC 2.0 over POST, SSE notification stream via GET, session termination via DELETE)
- **Authentication**: Bearer token (MCP API keys), not session cookies. IP-level + per-key rate limiting.
- **Session management**: In-memory session manager with `maxSessionsPerKey` limit. Sessions track initialization state.
- **Tools**: Dynamic tool exposure from registered capabilities. Tools are scoped to agent configuration.
- **Resources**: Resource listing and reading (agent details, capabilities, system info).
- **Audit logging**: Every MCP request logged with method, response code, duration, client IP, user agent. Dedicated admin UI for audit review.
- **Admin UI**: Settings, tools browser, resources browser, sessions, audit log, API key management — 7 admin pages total.
- **Batch support**: Up to 20 JSON-RPC requests per batch. `initialize` must be sole request in batch.
- **Size limits**: 1MB max request body.

### MCP Comparison Matrix

| Capability                | Sunrise | OpenAI SDK | LangGraph | CrewAI | Haystack | Google ADK | Azure Foundry | Dify   |
| ------------------------- | ------- | ---------- | --------- | ------ | -------- | ---------- | ------------- | ------ |
| MCP server implementation | Strong  | None       | None      | None   | Strong   | None       | Adequate      | None   |
| MCP client (tool calling) | None    | Strong     | Adequate  | Strong | Strong   | Strong     | Strong        | Strong |
| MCP tools exposure        | Strong  | N/A        | N/A       | N/A    | Strong   | N/A        | Adequate      | N/A    |
| MCP resources             | Strong  | N/A        | N/A       | N/A    | None     | N/A        | None          | N/A    |
| MCP audit logging         | Strong  | None       | None      | None   | None     | None       | None          | None   |
| MCP API key auth          | Strong  | N/A        | N/A       | N/A    | N/A      | N/A        | Adequate      | N/A    |
| Session management        | Strong  | N/A        | N/A       | N/A    | None     | N/A        | None          | N/A    |

**Sunrise position:** Most platforms support MCP as a **client** (calling MCP tools). Sunrise is one of very few that implements an MCP **server** — exposing its capabilities to external MCP clients. Haystack's Hayhooks also acts as an MCP server (exposing pipelines as tools). Azure Foundry added MCP server support in preview (mid-2025). The audit logging and API key auth on MCP are unique to Sunrise.

**MCP protocol status (2026):** Donated to the Agentic AI Foundation (Linux Foundation) in December 2025. Adopted by OpenAI (March 2025), Azure (mid-2025), and all major frameworks. MCP is rapidly becoming the "USB-C for AI" — platforms without MCP support will face increasing integration friction.

---

## Scheduling, Webhooks & Event Hooks

### Sunrise Implementation

Sunrise has three event/notification systems:

**1. Cron Scheduling** (`lib/orchestration/scheduling/`):

- DB-backed schedule definitions with cron expressions
- Scheduler tick processes due schedules
- Unified maintenance tick endpoint (`/maintenance/tick`) handles schedules, retries, and backfill

**2. Webhook Subscriptions** (`lib/orchestration/webhooks/`):

- CRUD for webhook subscriptions with event type filtering
- HMAC-SHA256 signature verification on outbound payloads
- Delivery tracking with `AiWebhookDelivery` records (pending → delivered / failed → exhausted)
- 3 retry attempts with exponential backoff (10s, 60s, 300s)
- Admin endpoints: subscription CRUD, delivery history, manual retry
- Empty-secret protection (refuses to sign, marks exhausted)

**3. Event Hooks** (`lib/orchestration/hooks/`):

- DB-backed hook definitions with event type + filter criteria matching
- Fire-and-forget dispatch via `emitHookEvent()`
- Custom headers per hook, HMAC signing when secret configured
- Separate delivery tracking (`AiEventHookDelivery`) from webhook subscriptions
- Same retry strategy as webhooks (3 attempts, exponential backoff)
- Hook registry with 60s cache TTL + cache invalidation on CRUD
- Admin endpoints: hook CRUD, delivery history, manual retry

### Scheduling & Events Comparison Matrix

| Capability                  | Sunrise | Dify     | n8n      | LangGraph Platform | Flowise | CrewAI Enterprise | Bedrock  |
| --------------------------- | ------- | -------- | -------- | ------------------ | ------- | ----------------- | -------- |
| Cron scheduling             | Strong  | Strong   | Strong   | Strong             | None    | Adequate          | Adequate |
| Webhook triggers (inbound)  | Strong  | Strong   | Strong   | None               | None    | Adequate          | None     |
| Event hooks (outbound)      | Strong  | Adequate | Strong   | None               | None    | None              | None     |
| Delivery tracking + retry   | Strong  | None     | Adequate | None               | None    | None              | None     |
| HMAC signature verification | Strong  | None     | None     | None               | None    | None              | None     |
| Plugin/integration triggers | None    | Strong   | Strong   | None               | None    | Strong            | Adequate |
| Manual retry (admin)        | Strong  | None     | Adequate | None               | None    | None              | None     |

**Sunrise advantages:** The dual webhook + event hook system with HMAC signing, delivery tracking, and admin retry is more complete than any evaluated platform. Dify's trigger system (cron, webhook, plugin) is broader on inbound triggers but has no delivery tracking or retry. n8n has the richest general automation triggers but treats AI agents as nodes in a general workflow engine.

**Key gap:** No plugin/integration triggers (email, Slack, Salesforce). Dify and CrewAI Enterprise offer these natively. Sunrise requires external webhook integrations for third-party event sources.

---

## Embeddable Chat / Consumer API

### Sunrise Implementation

Sunrise has a consumer-facing deployment path:

- **Consumer chat API** (`app/api/v1/chat/`): Stream endpoint, agent listing, conversation management — separate from admin API
- **Embed widget** (`app/api/v1/embed/widget.js/`): JavaScript loader served as an API route. Shadow DOM isolation prevents style conflicts with host page.
- **Embed chat endpoint** (`app/api/v1/embed/chat/`): SSE streaming chat for embedded contexts
- **Token auth**: Invite tokens for agent access control (public / invite_only / internal visibility modes)
- **CORS**: Configured per-agent or global for embed widget origins
- **Agent visibility**: 3 modes controlling who can access agents (internal = admin only, public = anyone, invite_only = token holders)

### Embed Comparison Matrix

| Capability                  | Sunrise  | Dify     | Flowise  | n8n  | LangGraph | CrewAI | Haystack |
| --------------------------- | -------- | -------- | -------- | ---- | --------- | ------ | -------- |
| Embeddable chat widget      | Strong   | Strong   | Strong   | None | None      | None   | None     |
| Shadow DOM isolation        | Strong   | None     | None     | N/A  | N/A       | N/A    | N/A      |
| Iframe embed                | None     | Strong   | Adequate | None | None      | None   | None     |
| Token-based auth            | Strong   | Adequate | Adequate | N/A  | N/A       | N/A    | N/A      |
| Embed proxy (hide API host) | None     | None     | Strong   | N/A  | N/A       | N/A    | N/A      |
| Widget customisation        | Adequate | Strong   | Strong   | N/A  | N/A       | N/A    | N/A      |
| Agent visibility modes      | Strong   | Adequate | Weak     | N/A  | N/A       | N/A    | N/A      |

**Sunrise position:** The embed widget with Shadow DOM isolation is architecturally clean — prevents CSS/JS conflicts that iframe-based embeds avoid but at the cost of cross-origin complexity. The 3 visibility modes (internal/public/invite_only) with invite tokens is more granular than Dify's or Flowise's approach. Code-first frameworks (LangGraph, CrewAI, Haystack, AutoGen) don't ship embed widgets — they are libraries, not platforms.

**Key gap:** No iframe embed option (Dify offers both). No embed proxy server (Flowise's proxy hides the API host and chatflow ID from client exposure).

---

## Pricing & Licensing Landscape

Sunrise is a self-hosted starter template with no licensing cost. This positions it differently from commercial platforms and managed services.

| Platform            | License                        | Free Tier                   | Paid Tier                                                   | Key Commercial Lock-in                     |
| ------------------- | ------------------------------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| **Sunrise**         | Proprietary (starter template) | Full self-hosted            | None                                                        | None                                       |
| **LangGraph**       | MIT (library)                  | OSS unlimited               | Platform: LangSmith $39/seat/mo, Agent Server custom        | LangSmith for production observability     |
| **CrewAI**          | MIT (library)                  | 50 workflow executions      | $25–$120K/yr (Ultra)                                        | Enterprise tier for SOC2, SSO, PII masking |
| **AutoGen/AG2**     | Apache 2.0                     | Full OSS                    | None                                                        | None — community-driven                    |
| **Semantic Kernel** | MIT                            | Full OSS                    | Azure services priced separately                            | Azure ecosystem bias                       |
| **Haystack**        | Apache 2.0                     | Full OSS                    | Enterprise Starter (support), Enterprise Platform (managed) | None — no vendor lock-in                   |
| **Dify**            | Apache 2.0 + conditions        | Self-hosted unlimited       | Dify Cloud, AWS Marketplace Premium                         | License terms differ from plain Apache 2.0 |
| **Flowise**         | Apache 2.0                     | Self-hosted unlimited       | Enterprise (SSO, features)                                  | Acquired by Workday (Aug 2025)             |
| **OpenAI SDK**      | MIT                            | OSS unlimited               | OpenAI API usage costs                                      | Model lock-in (OpenAI-first design)        |
| **Google ADK**      | Apache 2.0                     | Full OSS                    | Vertex AI Agent Engine usage-based                          | Google Cloud bias                          |
| **Bedrock Agents**  | Proprietary (managed)          | None                        | Usage-based + Lambda costs                                  | AWS-only                                   |
| **Azure Foundry**   | Proprietary (managed)          | Azure free account services | Usage-based + hosting                                       | Azure-only                                 |

**Key insight:** The commercial lock-in risk in this space is not the framework license — it's the observability/deployment platform. LangGraph is MIT but production use practically requires LangSmith ($39/seat/mo + per-trace). CrewAI is MIT but Enterprise features (SOC2, SSO) start at custom pricing. Sunrise avoids this pattern by building observability and deployment into the platform itself — though the current observability gap (no OTEL) means teams might still reach for LangSmith or Langfuse as an external dependency.

---

## Application Development & Production Readiness

Most agent orchestration systems are **libraries** or **managed services** — they solve the AI orchestration problem but leave everything else to the developer. Sunrise solves the orchestration problem inside a production-grade application platform that already handles authentication, database access, API design, server rendering, deployment, and UI components. This distinction matters more than any individual feature comparison.

### The Integration Tax

When a team adopts LangGraph, CrewAI, or the OpenAI Agents SDK, they get an orchestration engine. They still need to build or assemble:

- A web application framework (Next.js, Django, Rails, etc.)
- Authentication and session management
- A database layer with migrations
- API endpoints with validation, error handling, and rate limiting
- An admin dashboard for managing agents, providers, and configuration
- A consumer-facing chat interface
- An embeddable widget for third-party sites
- Cost tracking and budget management
- Audit logging for compliance
- Security middleware (CORS, CSP, input sanitisation)
- Deployment infrastructure

Each of these is a standalone engineering effort. The integration work — wiring a Python orchestration library into a TypeScript web application, bridging auth systems, handling SSE streaming across the stack — often exceeds the effort of implementing the orchestration itself.

Dify and Flowise reduce this tax by offering visual platforms with built-in UI, but they trade away code-level control. Complex business logic, custom integrations, and non-standard workflows hit the visual builder ceiling quickly, requiring escape hatches into code nodes that feel bolted on rather than native.

### What Sunrise Provides Out of the Box

Sunrise ships orchestration as one layer within a complete, typed application stack:

| Layer                    | Sunrise                                                                    | LangGraph + custom app              | Dify                            |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| **Frontend framework**   | Next.js 16 / React 19                                                      | Build your own                      | Visual builder (limited)        |
| **Type safety**          | End-to-end TypeScript, Zod validation at boundaries                        | Python ↔ TypeScript bridge required | YAML/JSON definitions           |
| **Authentication**       | better-auth with session management, admin roles                           | Build your own                      | Built-in (less configurable)    |
| **Database**             | Prisma 7 + PostgreSQL with migrations                                      | Build your own                      | PostgreSQL (managed internally) |
| **Admin dashboard**      | 20+ pages for agents, providers, capabilities, workflows, costs, analytics | Build your own                      | Built-in (visual-first)         |
| **API layer**            | 100 typed endpoints with auth guards, rate limiting, Zod validation        | Build your own                      | REST API (auto-generated)       |
| **Consumer chat**        | SSE streaming + embed widget with Shadow DOM                               | Build your own                      | iframe/JS embed                 |
| **Orchestration engine** | 15-step DAG with budget enforcement                                        | Graph-based DAG (strongest)         | Visual DAG (adequate)           |
| **Deployment**           | Docker Compose, single-repo                                                | Multi-service (Python + web app)    | Docker Compose                  |

The practical consequence: a team using Sunrise can go from "we need an AI-powered feature" to a deployed, authenticated, budget-enforced agent with admin controls in days rather than months. The same team using LangGraph would spend those months building the application layer around the orchestration engine.

### Web and Mobile Development

Because Sunrise is a Next.js application, every orchestration capability is automatically available as:

- **Server-rendered pages** with SEO metadata, error boundaries, and loading states
- **REST API endpoints** consumable by any client — React Native, Flutter, iOS/Android native, third-party integrations
- **SSE streams** for real-time chat in any client that supports EventSource
- **Embeddable widgets** for third-party websites via Shadow DOM

This is not achievable with Python-based frameworks (LangGraph, CrewAI, AutoGen, Haystack) without building a separate web layer. Teams building mobile or web products typically need both a Python backend for AI and a TypeScript frontend for the application — two codebases, two deployment pipelines, two sets of type definitions that must be kept in sync.

Sunrise eliminates this split. The orchestration engine, API layer, admin UI, and consumer-facing components all live in one TypeScript codebase with shared types, shared validation schemas, and a single deployment artifact. A change to the agent configuration schema propagates from the Prisma model through the API validation to the admin form without manual synchronisation.

### Production Readiness Comparison

"Production-ready" means different things at different layers. Most frameworks solve the orchestration layer but leave production concerns to the adopting team.

| Concern                 | Sunrise                                                     | Code-first frameworks | Visual platforms        | Managed services        |
| ----------------------- | ----------------------------------------------------------- | --------------------- | ----------------------- | ----------------------- |
| **Rate limiting**       | Built-in at IP, user, agent, capability levels              | None — build your own | Basic (platform-level)  | Managed                 |
| **Auth + RBAC**         | Admin/consumer roles, session management                    | None                  | Basic (workspace-level) | IAM-based               |
| **Audit trails**        | Config changes, instruction history, MCP audit              | None                  | Basic                   | CloudTrail/equivalent   |
| **Budget enforcement**  | Per-agent, global, mid-execution checks                     | None                  | Usage dashboards only   | Billing dashboards only |
| **Error handling**      | Typed error taxonomy, sanitised responses, retry strategies | Framework-specific    | Platform-handled        | Managed                 |
| **Security headers**    | CSP, CORS, rate limiting, input/output guards               | None                  | Partial                 | Managed                 |
| **Database migrations** | Prisma, version-controlled schema                           | N/A (no DB layer)     | Internal (opaque)       | Managed                 |
| **Structured logging**  | `logger` with request context, log levels                   | None                  | Basic                   | CloudWatch/equivalent   |

The managed services (Bedrock, Azure Foundry) handle these concerns through cloud infrastructure, but at the cost of vendor lock-in and pricing opacity. The visual platforms (Dify, Flowise) handle some of these but with less configurability. The code-first frameworks handle none of them — that is explicitly left to the developer.

### Where This Argument Doesn't Apply

This advantage is strongest for teams building **products** — applications where AI orchestration is one feature among many (customer support, internal tools, SaaS products with AI capabilities). For teams building **pure AI research systems**, **data pipelines**, or **standalone agent experiments**, the full-stack approach adds unnecessary weight. A Python notebook with LangGraph or CrewAI is the right tool for exploration and prototyping.

Similarly, enterprises already invested in AWS or Azure infrastructure will find Bedrock Agents or Azure Foundry more natural than adopting a new application framework. The integration tax argument reverses when the surrounding infrastructure already exists.

The honest comparison is: Sunrise trades **ecosystem breadth and community size** (LangGraph has 400+ production deployments at companies like LinkedIn and Uber; CrewAI processes 450M+ monthly workflows) for **integration depth and time-to-production** for teams that need a complete application, not just an orchestration engine.

---

## Framework-Specific Notes

### LangGraph — Primary Competitor

The closest architectural peer. Both use typed DAG execution with explicit state management. LangGraph's advantages are its checkpoint model (Postgres-backed, survives crashes), multi-agent primitives (`Command`, subgraphs, swarm), and LangSmith integration. Its disadvantages are framework lock-in, rapid API churn, and the LangSmith commercial dependency for production observability.

**What to learn from:** Checkpoint-per-step, `interrupt()` model, `Send` API for dynamic fan-out.

**What Sunrise does better:** Cost enforcement, provider resilience, capability dispatch pipeline.

### Haystack — Observability Benchmark

Not a competitor on orchestration complexity, but the gold standard for observability integration (5+ backends) and evaluation (8 named metrics). Sunrise should target Haystack's pluggable tracer pattern rather than LangSmith's commercial model.

**What to learn from:** OTEL auto-instrumentation, `LangfuseConnector` pattern, named evaluators.

### Google ADK — Emerging Standard

Newest entrant, but the A2A inter-agent protocol is potentially industry-defining. If A2A gains adoption, systems without it become isolated. Worth tracking and implementing early if multi-system agent coordination is on the roadmap.

**What to learn from:** A2A protocol, explicit coordination patterns (Sequential/Parallel/Loop agents).

### Managed Services (Bedrock, Azure Foundry) — Different Category

These compete on infrastructure, not engine design. Sunrise will never match their scaling or compliance posture, but they will never match Sunrise's customisation depth or cost enforcement. They serve different buyer profiles: managed services for enterprises wanting turnkey AI; Sunrise for teams wanting control over the orchestration layer.
