# Orchestration Improvement Priorities

Prioritised improvements to the orchestration layer, scoped to the deployment profile Sunrise actually targets: **single-tenant, one instance per project, small engineering teams, small projects.**

**Last updated:** 2026-05-02

---

## How to read this list

The companion `maturity-analysis.md` document tiers improvements (P0–P3) against a generic "production at scale" posture that includes horizontal scaling and multi-tenant SaaS. That posture does not match how Sunrise is deployed in practice — the venture-studio worked examples in `business-applications.md` are universally narrow-audience, single-instance, partner-driven pilots that grow into focused products. Treating maturity-analysis as the roadmap leads to investment in distributed-systems plumbing that no real Sunrise deployment exercises.

This document re-prioritises against the actual profile. Each item is graded on:

- **Value** — how often it is load-bearing in the business-applications worked examples and how big the quality / time-to-pilot delta is when it is missing.
- **Effort** — rough implementation cost. Low ≈ days; Moderate ≈ a sprint; High ≈ multi-sprint architectural change.

Items in `maturity-analysis.md` that depend on horizontal-scale assumptions are de-prioritised (Tier 4 below) — they remain on the long-term roadmap but should not block any small-team work.

---

## Status legend

- ✅ **Done** — merged to main.
- 🟢 **In progress** — branch open / next up.
- ⚪ **Not started**.

---

## Tier 1 — High value, low-to-moderate effort

The items that disproportionately unlock the worked examples in `business-applications.md` without large architectural change.

| #   | Improvement                                                      | Value     | Effort               | Status            |
| --- | ---------------------------------------------------------------- | --------- | -------------------- | ----------------- |
| 1   | Hybrid search (BM25-flavoured + vector re-ranking)               | Very high | Moderate             | ✅ Done (PR #139) |
| 2   | Citation / source attribution surfaced in agent responses        | Very high | Low–Moderate         | 🟢 Next up        |
| 3   | Expanded built-in capability library                             | Very high | Low (per capability) | ⚪ Not started    |
| 4   | More workflow templates aligned to business-application patterns | High      | Low                  | ⚪ Not started    |
| 5   | Document-ingestion robustness for real-world inputs              | High      | Moderate             | ⚪ Not started    |

### 1. Hybrid search (BM25-flavoured + vector re-ranking) — ✅ Done

**Why it mattered.** Nearly every worked example in `business-applications.md` is RAG-grounded (planning policy, lender criteria, council spending, Shelter guidance, RHS gardening, physiotherapy protocols, council tariffs). Vector-only similarity reliably misses keyword-anchored content — acronyms, statute names, supplier IDs, model numbers, tariff codes. Hybrid search closes that recall gap.

**What shipped (PR #139).** A generated `searchVector` tsvector column with a GIN index on `ai_knowledge_chunk`, an opt-in `searchConfig.hybridEnabled` flag, blended ranking via `vectorWeight × vector_score + bm25Weight × keyword_score`, three-segment score breakdown surfaced through the API, admin-tunable weights, smoke test against real Postgres. `ts_rank_cd` is documented honestly as a BM25 proxy. Vector-only legacy mode preserved as the default.

**Critical files (for reference):** `lib/orchestration/knowledge/search.ts`, `prisma/migrations/20260501172919_add_knowledge_chunk_search_vector/`, `.context/orchestration/knowledge.md`.

### 2. Citation / source attribution in responses — 🟢 Next up

**Why.** Domain-expert applications (legal, financial, health, planning, tenant rights, mortgage broker, regenerative agriculture) are unsellable without verifiable sourcing. The chunks already carry source metadata; the gap is consistent surfacing through the chat handler and a rendering contract for the embed widget. This is what converts "AI says…" into "your knowledge base says, on page 47…" — the difference between a demo and a tool a partner will sign for.

**Approach.** Add a structured citation field to the SSE event stream and tool-result envelope; render in chat UI / embed widget; let the output guard enforce "every grounded claim must cite" as an opt-in policy.

**Critical files:** `lib/orchestration/chat/` (handler, context builder, output guard), embed widget renderer, `app/admin/orchestration/conversations/` (trace viewer).

### 3. Expanded built-in capability library

**Why.** Maturity-analysis flags "7 built-in capabilities vs. LangChain's 1000+" as a gap. For small teams, the cost of writing each capability is high and the same handful keep recurring across business-applications: send email, send SMS, post to Slack, take a Stripe payment / issue refund within threshold, create calendar event, generate PDF, fetch from a generic REST endpoint with auth. Without these, every wedge project starts with 1–2 weeks of capability plumbing before the agent does anything useful.

**Approach.** Each new capability follows the existing `BaseCapability` shape. Repeatable per-capability cost. Prioritise: generic authenticated HTTP fetcher, Stripe (charge / refund / customer lookup), email send (Postmark/SendGrid), Slack / Discord notify, Google Calendar create-event, simple PDF/HTML document generator.

**Critical files:** `lib/orchestration/capabilities/built-in/`, `prisma/schema.prisma` (`AiCapability` seeds), the `orchestration-capability-builder` skill.

### 4. More workflow templates aligned to business-application patterns

**Why.** The 30 worked examples cluster around a handful of repeated shapes: conversational intake → triage → human-reviewed summary; knowledge consultation with citation; approval-gated action (refund, letter, document); scheduled monitoring → alert; multi-step assessment with evidence capture. Codifying these as templates is mostly content work and meaningfully shortens the time from "we have a partner" to "we have a working pilot."

**Approach.** JSON DAG definitions only; no engine changes. Five existing templates expand to ~10–12.

**Critical files:** `lib/orchestration/workflows/templates/`, admin workflow builder seed.

### 5. Document-ingestion robustness for real-world inputs

**Why.** PDF / DOCX / EPUB parsing exists, but the realistic input distribution in the business-applications (council planning PDFs, NHS guidance, RHS books, lender criteria sheets, Hansard transcripts, council spending CSVs) includes scanned PDFs, table-heavy layouts, and OCR-required content. A fragile parser silently degrades RAG quality.

**Approach.** Add OCR fallback (Tesseract or hosted), table-extraction in PDF parser, CSV ingestion path with column-aware chunking.

**Critical files:** `lib/orchestration/knowledge/parsers/`.

---

## Tier 2 — Strong value, moderate effort

| #   | Improvement                                                      | Value         | Effort       | Status            |
| --- | ---------------------------------------------------------------- | ------------- | ------------ | ----------------- |
| 6   | Named evaluation metrics (faithfulness, groundedness, relevance) | High          | Moderate     | ⚪ Not started    |
| 7   | Embed-widget customisation and theming                           | High          | Moderate     | ⚪ Not started    |
| 8   | Background / async execution model for long workflows            | Moderate–High | Moderate     | ✅ Done (PR #140) |
| 9   | Exact per-provider tokenisation                                  | Moderate–High | Low–Moderate | ⚪ Not started    |
| 10  | Built-in trace viewer / latency attribution improvements         | Moderate      | Moderate     | ⚪ Not started    |

### 6. Named evaluation metrics (faithfulness, groundedness, relevance)

**Why.** Every venture-studio play in `business-applications.md` requires a domain expert to validate output before launch. Today's LLM-completion handler is a single opaque score. Haystack-style named metrics — faithfulness (does the answer follow from cited chunks), groundedness (are claims supported), relevance (does the answer address the question) — give domain experts a rubric and produce repeatable regression checks across knowledge-base updates.

**Approach.** Wraps existing evaluation session machinery; mostly prompt and scoring engineering.

**Critical files:** `lib/orchestration/evaluations/`, `app/admin/orchestration/evaluations/`.

### 7. Embed-widget customisation and theming

**Why.** The trojan-horse model in business-applications repeatedly relies on dropping the agent into a partner's existing site (housing association, B&B, council planning page, broker website, charity microsite). Maturity-analysis rates widget customisation "Adequate" — Dify and Flowise are stronger here. Themeable widget (colour, font, header copy, conversation starters, suggested questions, branded footer, locale) directly affects partner sign-off.

**Approach.** Frontend-heavy. Embed loader + Shadow-DOM CSS variables, admin form for widget config per agent.

**Critical files:** `app/api/v1/embed/widget.js/`, embed widget React tree, `prisma/schema.prisma` (per-agent widget config).

### 8. Background / async execution model for long workflows — ✅ Done

**Why it mattered.** Cron- and webhook-triggered workflows ran synchronously, fine for sub-60-second flows but problematic for patterns in business-applications: weekly council-spending ingestion, daily proactive churn outreach, scheduled regulatory-change monitoring, overnight research summarisation.

**What shipped (PR #140).** Non-blocking maintenance tick, lightweight execution status endpoint, live-poll status from the admin UI, `workflow.execution.failed` hook with engine-crash repair, sanitised hook payloads, liveness watchdog and token ownership on the maintenance tick.

**Critical files (for reference):** `lib/orchestration/engine/`, `lib/orchestration/scheduling/`, `app/api/v1/orchestration/maintenance/tick/`, `.context/orchestration/scheduling.md`.

### 9. Exact per-provider tokenisation

**Why.** The 3.5-chars-per-token heuristic is a real source of context-window violations and budget surprises, particularly for code-heavy / non-English content (which several business-applications need: SEND advocacy, immigration support, crypto/regulatory).

**Approach.** `tiktoken` for OpenAI, Anthropic's counter API, Gemini SDK for Google. Central tokeniser abstraction already exists in `lib/orchestration/llm/`.

**Critical files:** `lib/orchestration/llm/` (tokeniser layer, cost calculator).

### 10. Built-in trace viewer / latency attribution improvements

**Why.** For single-tenant small projects, OTEL-to-Datadog integration matters less than the in-product trace viewer. Maturity rates per-step latency attribution as "Weak." A better in-app trace UI (per-step duration, tokens, cost, prompt diff, tool I/O) gives developers and domain experts the diagnostics they need without external observability infrastructure.

**Approach.** Most data is already captured in `AiWorkflowExecution` / `AiCostLog`; needs UI polish in execution detail page.

**Critical files:** `app/admin/orchestration/executions/[id]/`, execution event stream serialisation.

---

## Tier 3 — Useful but lower priority for this profile

| #   | Improvement                                                    | Status         |
| --- | -------------------------------------------------------------- | -------------- |
| 11  | Consumer-side (non-admin) approval flows in chat               | ⚪ Not started |
| 12  | Workflow definition versioning (publish/draft/rollback)        | ⚪ Not started |
| 13  | OTEL instrumentation as opt-in plug-in                         | ⚪ Not started |
| 14  | Inbound triggers from third-party systems (email-in, Slack-in) | ⚪ Not started |
| 15  | Better full checkpoint recovery beyond approval pauses         | ⚪ Not started |

Brief rationale for each:

- **11 — Consumer-side approval flows.** Some business applications (utility billing, e-commerce complaints, planning pre-screening) want the _end user_ to confirm an action, not an admin. Today's approval queue is admin-only. External HMAC tokens partially cover this but the UX expectation is a confirm step in the chat itself. Reuse external-approval token machinery, expose through chat SSE event types.
- **12 — Workflow versioning.** DB-stored history exists; for small teams the gap is ergonomic — no easy diff, rollback, or branch. A "publish/draft/rollback" model with named versions covers most of the value without requiring git-native YAML files.
- **13 — OTEL plug-in.** Lower-priority than its maturity-analysis P0 ranking suggests for this profile, but useful if a single customer wants to ship traces to Langfuse / Datadog. Treat as plug-in, not core requirement; prefer a Haystack-style pluggable tracer interface so it remains optional.
- **14 — Inbound triggers.** Webhook subscriptions handle outbound; inbound from "things that happen elsewhere" is gappy. Several business-application examples (subscription-box churn outreach, mutual-aid coordination, complaints) benefit from email-in or Slack-in. Generic Postmark inbound parse covers most cases cheaply.
- **15 — Full checkpoint recovery.** For single-tenant low-load deployments, crashes during long workflows are uncommon, and human-approval checkpointing already covers the highest-stakes pause case. Worth doing to make background execution (item 8) robust to deploys, but not urgent.

---

## Tier 4 — De-prioritised for this profile

These were P0–P2 in `maturity-analysis.md` but lose value or relevance under single-tenancy. They should remain on the long-term roadmap but should not block any small-team work.

| Item                                          | Maturity tier | Why de-prioritise here                                                                                              |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Distributed circuit breaker                   | P0            | Single instance per project — in-memory state is correct.                                                           |
| Distributed budget mutex                      | P0            | Low concurrency in small-project deployments. Race window is negligible.                                            |
| Maintenance tick distributed lock             | P1            | Single instance — no duplication risk.                                                                              |
| Knowledge namespace isolation (per-team)      | P2            | Single tenant — global knowledge base is the correct grain.                                                         |
| Operator RBAC tier                            | P2            | Small teams — admin/consumer split usually sufficient. Approver delegation already covers the multi-admin case.     |
| Managed hosting / Kubernetes progression      | P3            | Not applicable — each project deploys itself.                                                                       |
| Distributed task queue                        | P1/P3         | Postgres-backed job table is sufficient at this scale.                                                              |
| A2A protocol support                          | P3            | Speculative; no inter-system agent coordination in any current business-application example.                        |
| Multi-interrupt HITL across parallel branches | P3            | Single approval per execution covers every business-application pattern listed.                                     |
| Named multi-agent coordination patterns       | P2            | Most small-project use cases are single-agent or simple delegation; existing `orchestrator` step is already enough. |

---

## Suggested sequencing

A pragmatic order for the next sprints, optimised for "shortest path to a sellable wedge."

| Sprint | Theme                   | Items                                                            |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| 1      | RAG quality + trust     | ~~1 (hybrid search)~~ ✅, **2 (citations)**, 5 (ingestion)       |
| 2      | Velocity to first pilot | 4 (templates), 3 (capability library)                            |
| 3      | Validation + polish     | 6 (named eval metrics), 7 (widget customisation)                 |
| 4+     | Depth                   | ~~8 (background execution)~~ ✅, 9 (tokenisation), 10 (trace UI) |

Tier 3 items can be picked up opportunistically when a specific pilot needs them.

---

## Cross-references

- `functional-specification.md` — current implemented capabilities
- `business-applications.md` — venture-studio worked examples that drive prioritisation
- `commercial-proposition.md` — buyer-facing positioning
- `maturity-analysis.md` — generic-posture priority tiering and competitive comparison
