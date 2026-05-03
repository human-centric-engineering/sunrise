# Orchestration Improvement Priorities

Prioritised improvements to the orchestration layer, scoped to the deployment profile Sunrise actually targets: **single-tenant, one instance per project, small engineering teams, small projects.**

**Last updated:** 2026-05-03

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

| #   | Improvement                                                      | Value     | Effort       | Status                            |
| --- | ---------------------------------------------------------------- | --------- | ------------ | --------------------------------- |
| 1   | Hybrid search (BM25-flavoured + vector re-ranking)               | Very high | Moderate     | ✅ Done (PR #139)                 |
| 2   | Citation / source attribution surfaced in agent responses        | Very high | Low–Moderate | ✅ Done (this PR)                 |
| 3   | Sharpened HTTP fetcher + dependency-free recipes cookbook        | Very high | Moderate     | ✅ Done (this PR)                 |
| 4   | More workflow templates aligned to business-application patterns | High      | Low          | ✅ Done (this PR, narrowed scope) |
| 5   | Document-ingestion robustness for real-world inputs              | High      | Moderate     | ✅ Done (this PR)                 |

### 1. Hybrid search (BM25-flavoured + vector re-ranking) — ✅ Done

**Why it mattered.** Nearly every worked example in `business-applications.md` is RAG-grounded (planning policy, lender criteria, council spending, Shelter guidance, RHS gardening, physiotherapy protocols, council tariffs). Vector-only similarity reliably misses keyword-anchored content — acronyms, statute names, supplier IDs, model numbers, tariff codes. Hybrid search closes that recall gap.

**What shipped (PR #139).** A generated `searchVector` tsvector column with a GIN index on `ai_knowledge_chunk`, an opt-in `searchConfig.hybridEnabled` flag, blended ranking via `vectorWeight × vector_score + bm25Weight × keyword_score`, three-segment score breakdown surfaced through the API, admin-tunable weights, smoke test against real Postgres. `ts_rank_cd` is documented honestly as a BM25 proxy. Vector-only legacy mode preserved as the default.

**Critical files (for reference):** `lib/orchestration/knowledge/search.ts`, `prisma/migrations/20260501172919_add_knowledge_chunk_search_vector/`, `.context/orchestration/knowledge.md`.

### 2. Citation / source attribution in responses — ✅ Done

**Why it mattered.** Domain-expert applications (legal, financial, health, planning, tenant rights, mortgage broker, regenerative agriculture) are unsellable without verifiable sourcing. The chunks already carried source metadata; the gap was consistent surfacing through the chat handler and a rendering contract for the admin and embed surfaces.

**What shipped.** A new `Citation` type and `citations` SSE event surface citation-producing tool results to the client. `search_knowledge_base` is registered as the first citation producer — the streaming handler post-processes its results, assigns monotonic `[N]` markers across all tool calls in a turn, augments the result the LLM consumes so the model emits inline citations, and persists the envelope on the assistant message metadata. A reusable `MessageWithCitations` React component renders markers as superscript references and a collapsible sources panel; a vanilla-JS port handles the embed widget. An opt-in `citationGuardMode` (per-agent + global) flags under-citation and hallucinated markers via the existing log_only / warn_and_continue / block precedence pattern.

**Critical files (for reference):** `lib/orchestration/chat/citations.ts`, `lib/orchestration/chat/streaming-handler.ts`, `lib/orchestration/chat/output-guard.ts`, `lib/orchestration/capabilities/built-in/search-knowledge.ts`, `components/admin/orchestration/chat/message-with-citations.tsx`, `app/api/v1/embed/widget.js/route.ts`, `.context/orchestration/chat.md` (Citations section), `.context/orchestration/output-guard.md` (Citation Guard section).

### 3. Sharpened HTTP fetcher + dependency-free recipes cookbook — ✅ Done

**Why it mattered.** Maturity-analysis framed the gap as "7 built-in capabilities vs. LangChain's 1000+ tool integrations." The original plan was to ship per-vendor capability classes (`StripeCapability`, `PostmarkCapability`, `GoogleCalendarCapability`, etc.). On review, that approach has two problems for a starter template Sunrise's downstream forks copy: each vendor SDK adds a transitive dependency tree, security surface, and version-pin burden; and naming a capability after a vendor ships a product opinion that different forks may not share (Postmark vs SendGrid; Stripe vs Adyen).

**What shipped.** A single sharpened generic HTTP-fetcher capability + a comprehensive recipes cookbook. The HTTP foundation moved out of the workflow `external_call` executor into a shared `lib/orchestration/http/` module so the new capability and the workflow step share one implementation. The shared module gained three additions the recipes need: HMAC request signing, Idempotency-Key header support, and Basic auth — on top of the existing `none` / `bearer` / `api-key` / `query-param` modes. The new `call_external_api` capability gives an agent outbound HTTP power within the deployment allowlist; auth credentials, URL-prefix restrictions, and idempotency policy live in `AiAgentCapability.customConfig` so the LLM never sees secret env-var names and can't escape an admin-defined URL prefix. Five comprehensive recipes (transactional email, payment charge, chat notification, calendar event, document render) document how to wire common integrations without bundling any vendor SDK.

**Critical files (for reference):** `lib/orchestration/http/` (the new shared module — allowlist, auth, idempotency, response, fetch), `lib/orchestration/capabilities/built-in/call-external-api.ts`, `lib/orchestration/engine/executors/external-call.ts` (now a thin shim), `lib/validations/orchestration.ts` (`externalCallConfigSchema` extended), `prisma/seeds/011-call-external-api.ts`, `.context/orchestration/recipes/` (six markdown files), `.context/orchestration/capabilities.md` (new section), `.context/orchestration/external-calls.md` (new auth modes documented).

**Versus LangChain's 1000+ stance.** Sunrise's edge is curation: ten built-in capabilities you can trust + one extensible primitive + worked recipes for the integrations developers actually wire up. Anything not covered by a recipe is a documented `/orchestration-capability-builder` skill invocation away from being a proper capability class.

### 4. More workflow templates aligned to business-application patterns — ✅ Done (narrowed scope)

**Why it mattered.** The 30 worked examples cluster around a handful of repeated shapes: conversational intake → triage → human-reviewed summary; knowledge consultation with citation; approval-gated action (refund, letter, document); scheduled monitoring → alert; multi-step assessment with evidence capture; conversational learning; multi-agent orchestration. Codifying these as templates shortens the time from "we have a partner" to "we have a working pilot."

**What changed in scoping.** A gap audit against the existing nine built-in templates showed the catalogue was already substantial — `customer-support`, `content-pipeline`, `saas-backend`, `research-agent`, `conversational-learning`, `data-pipeline`, `outreach-safety`, `code-review`, `autonomous-research` (plus `provider-model-audit` seeded separately as a working installed workflow via `010-model-auditor.ts`). Of the seven recurring shapes, only two were genuinely under-served: **knowledge consultation with citation** (6 of 30 worked examples, 0 dedicated templates) and **scheduled monitoring → alert** (4 of 30 worked examples, 0 dedicated templates). All other shapes were adequately or over-served. Templates also turn out to be primarily _bootstrap / educational_ rather than production-ready: real partner deployments are narrow enough that the AI builder skills (`/orchestration-solution-builder`, `/orchestration-workflow-builder`) carry the long tail better than catalogue growth ever will.

**What shipped (this PR).** Two new templates filling the genuine gaps:

- `tpl-cited-knowledge-advisor` — RAG via the citation-emitting `search_knowledge_base` capability → answer with mandatory inline `[N]` markers → fail-closed citation guard → optional human review. Targets advisor-style agents in legal, financial, medical, and regulatory domains.
- `tpl-scheduled-source-monitor` — `external_call` → LLM-classified diff vs. previous snapshot → route on change tier → notify on material change. Targets lender-criteria, regulatory, supply-chain, and council-commitment monitoring.

Both restrict `tool_call` use to `search_knowledge_base` (already in the unit-test capability allowlist) and pass the full `validateWorkflow()` + `runExtraChecks()` suite (112 assertions, 11 templates × 10–12 invariants).

**Critical files (for reference):** `prisma/seeds/data/templates/cited-knowledge-advisor.ts`, `prisma/seeds/data/templates/scheduled-source-monitor.ts`, `prisma/seeds/data/templates/index.ts`, `prisma/seeds/004-builtin-templates.ts`, `tests/unit/lib/orchestration/workflows/templates/index.test.ts`.

**Why the catalogue should not grow further.** Each additional template adds maintenance load (seed `hashInputs` drift, test churn, possibility-space confusion in the picker) for diminishing returns. The 11-template catalogue now covers all seven recurring shapes; future custom workflows belong to the AI builder skills, not the seed catalogue.

### 5. Document-ingestion robustness for real-world inputs — ✅ Done

**Why it mattered.** PDF / DOCX / EPUB parsing existed, but the realistic input distribution in `business-applications.md` (council planning PDFs, NHS guidance, RHS books, lender criteria sheets, Hansard transcripts, council spending CSVs) includes scanned PDFs, table-heavy layouts, and CSV exports. A fragile parser silently degrades RAG quality. Council-spending CSV at `business-applications.md:777` was the most concrete missing wedge — there was no CSV path at all.

**What changed in scoping.** The original framing proposed three pieces: OCR fallback (Tesseract or hosted), PDF table extraction, CSV ingestion. The user constraint here was no new third-party runtime dependencies — bundled Tesseract.js (~30 MB WASM + language packs) and hosted OCR (vendor SDKs) are both out of scope at this stage. The remaining two are achievable with what we already ship: `pdf-parse` v2 already exposes per-page `getText().pages[]`, `getTable()`, and `getImage()` — the parser was only using `getText()` and `getInfo()`. CSV is in-house RFC 4180 (~150 lines of TypeScript).

**What shipped (this PR).**

- **CSV parser** (`lib/orchestration/knowledge/parsers/csv-parser.ts`) — pure-TS RFC 4180 reader with delimiter sniffing (`,` / `\t` / `;`), header-row detection, RFC quoting (escaped quotes, embedded commas, embedded newlines), unbalanced-quote recovery. Each data row becomes its own `ParsedSection` rendered as `Header1: Val1 | Header2: Val2 | ...`.
- **Row-level chunking** (`chunkCsvDocument` in `chunker.ts`) — emits one `csv_row` chunk per row so retrieval surfaces the matching row directly rather than a diluted multi-row window. Above 5,000 rows, batches 10 rows per chunk to cap embedding cost. CSV uploads bypass `chunkMarkdownDocument` and run through a dedicated `uploadCsvFromParsed` lifecycle.
- **Per-page scanned-PDF diagnostic** — refactored `pdf-parser.ts` to consume `textResult.pages[]` instead of splitting the joined text on form-feed. Consecutive pages with `< 50` chars of extractable text group into a single warning per range (`Pages 4–7 of 22 produced no extractable text — likely scanned`). Per-page char counts are persisted on the preview metadata as a forward path for a page-picker UI; the existing amber-warning rendering picks up the new strings without UI changes. Falls back to form-feed split when `pages[]` is missing.
- **Opt-in PDF table extraction** — checkbox in the upload zone (default off, only shown for PDF). When enabled, `getTable()` runs per page and detected vector-grid tables are rendered as markdown pipe tables fenced by `<!-- table-start -->` / `<!-- table-end -->` HTML comments. Default-off keeps existing PDF behaviour intact; admin sees the rendered tables in the preview textarea and can delete fenced blocks before confirming. Fence comments are a forward path for the chunker to keep table blocks atomic.
- **No OCR.** Documented external workflow (macOS Preview / Adobe Acrobat / `ocrmypdf`) for scanned PDFs. Hosted OCR remains an explicit future opt-in via `call_external_api` — the recipes-cookbook pattern from item #3.

**Six `ALLOWED_EXTENSIONS` touchpoints** were updated for `.csv` in one diff (route, bulk route, url-fetcher, upload-zone allowlist + accept attr + footer text). Centralising into one source of truth is a follow-up.

**Robustness fixes layered on after the core features.** Three iterative trace passes through the upload → preview → confirm → rechunk lifecycle surfaced edge cases not obvious from the feature spec — fixed in the same PR so the next person inherits a hardened pipeline:

- **`rechunkDocument` CSV dispatch.** Re-chunking a CSV document used to run the rebuilt `Header: Value | …`-per-line content through the markdown chunker, mashing every row into one heading-less chunk and destroying row-level retrieval. Now detects `metadata.format === 'csv'` and routes through `chunkCsvDocument`. The first iteration of this fix split the stored `rawContent` on `\n` to rebuild rows — but a code review caught that this would shred any RFC-4180 quoted cell containing an embedded newline (a documented-supported input). Final shape: per-row sections are persisted verbatim at upload time on `metadata.csvSections` and read back on rechunk, with a clear-error fallback for CSV docs missing the field.
- **`previewDocument` re-upload dedup.** Used to create a new `pending_review` row on every PDF upload. Now refreshes an existing `pending_review` row in place when the same admin re-uploads the same file (matched by SHA-256), keeping the queue clean for the common abandon-then-retry case (e.g. retrying with `extractTables` ticked). Scoped to the uploading user so two admins triaging the same source can't clobber each other.
- **`confirmPreview` metadata drift.** Was persisting `format` as `.pdf` (with a leading dot) where the parser writes `pdf`, and dropped the per-page diagnostic on confirm. Both fixed; per-page data now survives into the confirmed-document metadata as a forward path for a page-picker UI.
- **CSV BOM + line-ending normalisation.** Excel-saved CSVs left a U+FEFF byte-order mark inside the first header cell, polluting every chunk. Classic-Mac CR-only line endings parsed the entire file as one giant row. Both normalised at the parser boundary.
- **CSV overflow-row warning.** Rows with more cells than the header used to silently truncate; the parser now surfaces a warning naming the first offending row so admins notice a wrong delimiter or unquoted commas.
- **`chunkCsvDocument` defensive chunk IDs.** Used `section.order` (an optional hint) for chunk IDs; switched to the array index so a future caller can't accidentally produce duplicate keys that the `chunkKey` UNIQUE constraint would reject mid-insert.
- **PDF table-cell sanitisation invariant documented.** `renderMarkdownTable` only escapes `|` and replaces `\n` — safe today because chunk content renders through `react-markdown` with no plugins. Three signposts added (parser comment, renderer-import comment, doc section) so a future PR enabling `rehype-raw` is forced to harden the parser first. Surfaced by the security review.
- **FieldHelp rewritten in plain language.** Original PDF table-extraction help used "vector-grid", "markdown pipe tables", "false-positive tables", "chunked cleanly". Rewritten with concrete what-it-does / when-it-works / when-it-misfires sections. Top-level upload help now covers CSV row-level chunking and the PDF preview/confirm flow, not just markdown chunking.

**Critical files (for reference):** `lib/orchestration/knowledge/parsers/csv-parser.ts`, `lib/orchestration/knowledge/parsers/pdf-parser.ts`, `lib/orchestration/knowledge/chunker.ts` (`chunkCsvDocument`), `lib/orchestration/knowledge/document-manager.ts`, `components/admin/orchestration/knowledge/document-upload-zone.tsx`, `.context/orchestration/document-ingestion.md`.

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
| 16  | `upload_to_storage` capability (S3 / Vercel Blob)              | ⚪ Not started |
| 17  | Multipart/form-data construction in `lib/orchestration/http/`  | ⚪ Not started |
| 18  | Env-var resolution for binding `customConfig` at admin save    | ⚪ Not started |

Brief rationale for each:

- **11 — Consumer-side approval flows.** Some business applications (utility billing, e-commerce complaints, planning pre-screening) want the _end user_ to confirm an action, not an admin. Today's approval queue is admin-only. External HMAC tokens partially cover this but the UX expectation is a confirm step in the chat itself. Reuse external-approval token machinery, expose through chat SSE event types.
- **12 — Workflow versioning.** DB-stored history exists; for small teams the gap is ergonomic — no easy diff, rollback, or branch. A "publish/draft/rollback" model with named versions covers most of the value without requiring git-native YAML files.
- **13 — OTEL plug-in.** Lower-priority than its maturity-analysis P0 ranking suggests for this profile, but useful if a single customer wants to ship traces to Langfuse / Datadog. Treat as plug-in, not core requirement; prefer a Haystack-style pluggable tracer interface so it remains optional.
- **14 — Inbound triggers.** Webhook subscriptions handle outbound; inbound from "things that happen elsewhere" is gappy. Several business-application examples (subscription-box churn outreach, mutual-aid coordination, complaints) benefit from email-in or Slack-in. Generic Postmark inbound parse covers most cases cheaply.
- **15 — Full checkpoint recovery.** For single-tenant low-load deployments, crashes during long workflows are uncommon, and human-approval checkpointing already covers the highest-stakes pause case. Worth doing to make background execution (item 8) robust to deploys, but not urgent.
- **16 — `upload_to_storage` capability.** The HTTP module wraps binary responses (PDFs from renderers, images from generators) as `{ encoding: 'base64', contentType, data }` — but there's nowhere useful for the agent to put base64 bytes inside a conversation. A complementary capability that takes the wrapper, uploads to S3 / Vercel Blob, and returns a public/signed URL closes the loop. Without it the document-render recipe leans on hosted-URL renderer modes (DocRaptor `async`, PDFShift `?response_type=url`); with it, any renderer that returns bytes inline becomes usable. Surfaced while writing `recipes/document-render.md`.
- **17 — Multipart/form-data construction.** Some hosted endpoints (Gotenberg for HTML→PDF being the canonical example) require `multipart/form-data` with named file parts and field parts, not JSON. The HTTP module doesn't construct multipart bodies today, so recipes targeting these endpoints recommend a small JSON-to-multipart adapter on your own host. A first-class implementation would need a real design decision (how does the LLM emit file parts vs fields? streaming or in-memory? how big a body do we accept?). Surfaced while writing `recipes/document-render.md`.
- **18 — Env-var resolution at admin-save.** Several recipes want to keep secrets in env vars only — never in DB columns next to per-call config. Today, fields like the chat-notification recipe's `forcedUrl` (which IS the credential) are stored inline in `customConfig`. A `${env:VAR}` substitution path that resolves at admin-binding-save time would let those values stay in env vars exclusively. Modest scope; opinionated about whether substitution happens at write time (resolved value stored) or read time (template stored, resolved per-request). Surfaced while writing `recipes/chat-notification.md` and `recipes/transactional-email.md`.

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

| Sprint | Theme                   | Items                                                                |
| ------ | ----------------------- | -------------------------------------------------------------------- |
| 1      | RAG quality + trust     | ~~1 (hybrid search)~~ ✅, ~~2 (citations)~~ ✅, ~~5 (ingestion)~~ ✅ |
| 2      | Velocity to first pilot | ~~4 (templates)~~ ✅ (narrowed), ~~3 (HTTP fetcher + recipes)~~ ✅   |
| 3      | Validation + polish     | 6 (named eval metrics), 7 (widget customisation)                     |
| 4+     | Depth                   | ~~8 (background execution)~~ ✅, 9 (tokenisation), 10 (trace UI)     |

Tier 3 items can be picked up opportunistically when a specific pilot needs them.

---

## Cross-references

- `functional-specification.md` — current implemented capabilities
- `business-applications.md` — venture-studio worked examples that drive prioritisation
- `commercial-proposition.md` — buyer-facing positioning
- `maturity-analysis.md` — generic-posture priority tiering and competitive comparison
